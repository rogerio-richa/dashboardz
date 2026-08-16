/**
 * `text_block` — one line of text, typed in or read off a feed, as big as the cell allows.
 *
 * The first design ever migrated off the hand-written DOM branch (device.js), proving the whole
 * widget contract end to end (portable drawing subset). Structurally it follows calendar/agenda.mjs and news/list.mjs:
 * a pure `normalizeText(data, config)` doing every read-path decision, and a `draw` that only
 * paints what normalize decided. `align` is declared through `meta.options` — tab state's contract —
 * so the admin generates its form field instead of a hand-coded control ever being added for it.
 *
 * `available: false` replaces the old DOM branch's silent em-dash placeholder. A cell configured
 * with neither text nor a resolvable value has nothing to say, and saying so (matching the
 * "unavailable" wording every other migrated design already uses) is more honest than a blank box
 * a person has to guess about.
 *
 * `ctx.stale`/`ctx.age_ms` (widget contract): `paintWidgets` hands every design the same staleness the DOM
 * renderer already computed with `isStale`/`hubNow` for its own `.stale` class and age chip. The
 * age caption renders once a bound feed has actually been PUSHED to (`age_ms !== null`), fresh or
 * stale alike — a bound-but-never-pushed feed stays quiet, same as the DOM branch's own
 * "never-pushed is quiet, not stale" rule (device.js:282-284) — while `stale` alone drives the
 * dimmed treatment; the two are independent signals, not one gating the other. This is the first
 * design to consume them — value_tile and gauge read the same two fields, under the same
 * rule, once they migrate.
 */
import { centredNotice, fitted, formatAge, paintText } from '../text-fit.mjs'

// 'left', matching the DOM branch's own default (layout-core.mjs's textConfig has always defaulted
// here) — the documented default 'center' would have shifted every saved
// text_block that omits `align`, which is not a visual no-op a migration is allowed to cause.
const ALIGN_DEFAULT = 'left'
const ALIGN_CHOICES = new Set(['left', 'center', 'right'])
const DISPLAY_CODE_POINT_LIMIT = 512
// Same floor the DOM branch used for text_block (FLOOR_VALUE) — a single prominent line, not a
// dense list row, so it does not shrink as far as agenda/list's secondary text (floor 10).
const TEXT_FLOOR = 16

const meta = {
  id: 'block',
  widget: 'text_block',
  label: 'Text',
  suggested_ratio: 3 / 2,
  tokens: {
    ink: { type: 'color', default: '@ink' },
    dim: { type: 'color', default: '@dim' },
  },
  options: {
    align: { type: 'select', label: 'Alignment', default: ALIGN_DEFAULT, choices: ['left', 'center', 'right'] },
  },
  animations: { transition: [], persistent: [] },
}

function isArray(value) {
  try {
    return Array.isArray(value)
  } catch {
    return false
  }
}

const record = (value) =>
  value !== null && typeof value === 'object' && !isArray(value) ? value : null

/**
 * A own-data-property read. Board payloads are attacker-adjacent by construction — they come from
 * whatever a provider returned — so a getter that runs during rendering is not something this file
 * offers. Same rule and same shape as `calendar/agenda.mjs` and `news/list.mjs`.
 */
function ownData(value, key) {
  const target = value !== null && typeof value === 'object' ? value : null
  if (!target) return undefined
  try {
    const descriptor = Object.getOwnPropertyDescriptor(target, key)
    return descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value')
      ? descriptor.value : undefined
  } catch {
    return undefined
  }
}

const finite = (value) => typeof value === 'number' && Number.isFinite(value)

/** Own-data-property path walk into bound data — same discipline as `ownData` above, segment by segment. */
function resolvePath(value, path) {
  if (typeof path !== 'string' || path === '') return value
  let cur = value
  for (const seg of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined
    cur = ownData(cur, seg)
    if (cur === undefined) return undefined
  }
  return cur
}

/**
 * A design's `data` is `dataForCell`'s output: a value feed's payload unwrapped, or (on a stream
 * feed) every row's payload as an array — right for a table or chart, wrong for a widget that
 * shows exactly one line. The newest row is what value_tile/gauge already read from a stream feed
 * (`feedScalarSource`); this is that same rule restated against the new shape. A value feed's
 * payload is used as-is even when it happens to be an array itself — there is no feed mode left in
 * `data` to tell the two apart, and treating every array as "stream rows" would misread that case.
 */
function scalarSource(data) {
  return isArray(data) ? ownData(data, '0') : data
}

/** Bound provider-owned text before trimming, copying or measuring its complete value. */
function boundText(value) {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed === '') return null
    const points = Array.from(trimmed)
    return points.length > DISPLAY_CODE_POINT_LIMIT
      ? `${points.slice(0, DISPLAY_CODE_POINT_LIMIT).join('')}...` : trimmed
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (finite(value)) return String(value)
  if (value !== null && typeof value === 'object') {
    try {
      return JSON.stringify(value)
    } catch {
      return null
    }
  }
  return null
}

/**
 * The one line to draw, or word that there isn't one. A literal `text` always wins when present —
 * matching the old DOM branch's `cfg.text != null` check — and only an all-whitespace literal
 * counts as nothing to say; a bound value falls through the same "nothing to say" rule as any
 * other unresolvable path.
 */
export function normalizeText(data, config) {
  // `c`, not `settings`: layout-core.mjs's own *Config normalizers use the same short name for a
  // sanitized config record, and `hub/test/knob-coverage.test.ts` greps for exactly that
  // convention (`c.<knob>`) when it looks for where a schema-accepted property is actually read.
  const c = record(config) ?? {}
  const align = ALIGN_CHOICES.has(c.align) ? c.align : ALIGN_DEFAULT
  const scale = finite(c.scale) ? Math.min(2, Math.max(0.5, c.scale)) : 1

  if (typeof c.text === 'string') {
    return c.text.trim() === ''
      ? { available: false, text: '', align, scale }
      : { available: true, text: c.text, align, scale }
  }

  const path = typeof c.path === 'string' ? c.path : null
  const bound = boundText(resolvePath(scalarSource(data), path))
  if (bound === null) return { available: false, text: '', align, scale }
  return { available: true, text: bound, align, scale }
}

function draw(g, ctx) {
  const { box, tokens, data, config } = ctx
  if (!(box?.w > 0) || !(box?.h > 0)) return
  const normalized = normalizeText(data, config)
  const pad = Math.max(4, Math.min(16, Math.min(box.w, box.h) * 0.04))

  if (!normalized.available) {
    centredNotice(g, 'No text', 'Type text or bind a feed', box, tokens, pad, normalized.scale)
    return
  }

  // `ctx.stale`/`ctx.age_ms` (widget contract): a cell with no
  // feed bound always gets `stale: false, age_ms: null` from `paintWidgets`, so this branch is
  // silent for typed-in text — there is nothing to be stale about. `age_ms !== null` is NOT "a feed
  // is bound" — `paintWidgets` also yields `age_ms: null` for a bound feed whose wire has no numeric
  // `pushed_at`, i.e. one that has never actually been pushed to. The true gate is "this feed has
  // been pushed to at least once": the caption then shows fresh OR stale, matching the old DOM
  // branch's `ageChipHtml`, whose own comment (device.js:282-284) states the same invariant:
  // "never-pushed is quiet, not stale" — a feed nobody has written to yet gets neither the chip nor
  // the stale styling, same as one with no feed bound at all.
  //
  // `stale` alone still drives the dimmed TREATMENT: the two concerns are independent.
  // A fresh, already-pushed feed's age is a normal at-a-glance signal, not a
  // warning, so it must not wait for the feed to actually go stale to appear — that would make a
  // silently-stopped feed indistinguishable from a live one until it crosses `stale_after_s`).
  const stale = ctx.stale === true
  const ageMs = typeof ctx.age_ms === 'number' ? ctx.age_ms : null
  const showAge = ageMs !== null

  const usableWidth = Math.max(0, box.w - pad * 2)
  const usableHeight = Math.max(0, box.h - pad * 2)
  // Sized off the smaller of the two axes, scaled by `t` through `box`'s caller — a tall narrow
  // cell must not blow past its own width, nor a short wide one past its own height.
  const preferredPx = Math.max(TEXT_FLOOR, Math.round(Math.min(usableHeight * 0.7, box.w * 0.16) * normalized.scale))
  const x = normalized.align === 'left' ? pad : normalized.align === 'right' ? box.w - pad : box.w / 2
  const color = stale ? tokens.dim : tokens.ink

  if (!showAge) {
    paintText(g, normalized.text, x, box.h / 2, {
      px: preferredPx, floor: TEXT_FLOOR, maxWidth: usableWidth,
      color, align: normalized.align, baseline: 'middle', weight: 600,
    })
    return
  }

  // A bound feed adds a second, smaller line — its age, always in `tokens.dim` regardless of
  // staleness, the same way the old `.age-chip` CSS class was always dim — so the pair is centred
  // as a group the same way `centredNotice`'s headline+detail are, rather than the main line
  // staying dead centre and the caption crowding whichever edge it lands nearest.
  const captionPx = Math.max(10, Math.round(preferredPx * 0.42))
  const gap = Math.max(2, Math.round(preferredPx * 0.12))
  const mainFit = fitted(g, normalized.text, preferredPx, TEXT_FLOOR, usableWidth, 600)
  const top = box.h / 2 - (mainFit.px + gap + captionPx) / 2
  paintText(g, normalized.text, x, top, {
    px: preferredPx, floor: TEXT_FLOOR, maxWidth: usableWidth,
    color, align: normalized.align, baseline: 'top', weight: 600,
  })
  paintText(g, formatAge(ageMs), x, top + mainFit.px + gap, {
    px: captionPx, floor: 10, maxWidth: usableWidth,
    color: tokens.dim, align: normalized.align, baseline: 'top', weight: 400,
  })
}

export default { meta, draw }
