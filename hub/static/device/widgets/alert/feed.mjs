/**
 * `alert_feed` — the active alerts for this board, worst-and-newest first, as severity-striped cards.
 *
 * The ninth design migrated off the hand-written DOM branch (device.js) and the only one that reads
 * `ctx.alerts` (an addition to the widget contract). Every other data widget binds a
 * feed; this one binds nothing at all — its data is the device's module-level `alerts` array,
 * pushed over the socket by STATE/ALERT messages — so `ctx.data` and `ctx.rows` are permanently
 * `null` here and a design that waited for either would draw an empty cell forever.
 *
 * Structurally this follows `stream/list.mjs`: a pure `normalizeAlertFeed(alerts, config, now)`
 * making every filter/order/format decision, and a `draw` that only paints what normalize decided.
 * `feedConfig`/`feedAlerts`/`feedCardHeight`/`feedTextSizes`/`cardPlan` come from
 * `../../layout-core.mjs` rather than being restated — the same rule `value/tile.mjs` gives for
 * `resolvePath`: they are already pure browser ESM with no DOM dependency.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * `sound_info` IS NOT A RENDERING KNOB. Do not consume it, drop it, or move it.
 *
 * It rides on this widget's config, but it is read by ANDROID — `screenChimesInfo` in
 * `core/Chime.kt`, off the screen definition — to decide whether an `info` alert is audible at all.
 * The renderer has never read it and must never start: `feedConfig` does not surface it, this
 * design does not mention it outside this comment, and `meta.options` deliberately omits it so the
 * generated-field mechanism cannot start writing the key the app depends on. Its admin control
 * lives in `Screens.tsx` (not `CellConfig.tsx`, which has no `alert_feed` branch at all) and stays
 * there. Breaking this breaks the alarm path silently — nothing on the panel would look wrong.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 *
 * The card's relative time is device.js's own `ago()` — `45s` / `3m` / `2h`, Math.ROUND, no
 * suffix — and NOT `formatAge`/`ageChip`'s `now` / `3m ago` / Math.FLOOR vocabulary that
 * `stream_list` and `news_list` reuse. Those two reuse it because THEIR DOM branches called
 * `ageChip`; this one's called `ago`. Importing the shared helper here would read like
 * consolidation and would quietly change what the wall has always shown (contract), so
 * `formatAgo` below states `ago`'s arithmetic instead. It is the one age wording on the board that
 * is deliberately not `formatAge`.
 *
 * Two colour decisions, both forced by the contract's ban on CSS variables:
 *   - The severity stripe (`.card`'s `border-left: 4px solid var(--info)`, overridden to
 *     `var(--warn)`/`var(--critical)`) becomes the declared `info`/`warn`/`critical` tokens,
 *     defaulting to the board palette's own `@info`/`@warn`/`@critical` — the same trio
 *     `gauge/ring.mjs` and `gauge/bar.mjs` already declare for their own thresholds.
 *   - The per-severity card TINT (`--surface-warn`/`--surface-critical`) is not carried over. The
 *     board palette has no per-severity surface key to default such a token to, and `stream_list`
 *     set the precedent that a migrated card design paints its text and its signal, not the cell
 *     chrome drawn by the stylesheet. The stripe is the severity signal; the tint
 *     was reinforcement.
 *
 * `scale` moves TEXT ONLY for the sizes, but NOT for the plan: `feedCardHeight` scales the card
 * height that goes INTO `cardPlan`, exactly as the DOM branch did (`FEED_CARD` stays the base
 * constant — see layout-core.mjs's own rule above `FEED_TITLE`). Do not "finish the job" by
 * scaling `FEED_CARD` itself.
 */
import {
  feedConfig, feedAlerts, feedCardHeight, feedTextSizes, FEED_COUNTER, FLOOR_LABEL,
} from '../../layout-core.mjs'
import { fitted, paintText, quietLine, wrapClamped } from '../text-fit.mjs'

const meta = {
  id: 'feed',
  widget: 'alert_feed',
  label: 'Alert feed',
  suggested_ratio: 3 / 4,
  tokens: {
    ink: { type: 'color', default: '@ink' },
    dim: { type: 'color', default: '@dim' },
    // The severity stripe. Same trio, same palette defaults, as gauge/ring.mjs's thresholds.
    info: { type: 'color', default: '@info' },
    warn: { type: 'color', default: '@warn' },
    critical: { type: 'color', default: '@critical' },
  },
  options: {
    // `choices` is a flat string array, matching text/block.mjs's `align` — the generated-field
    // mechanism's own select shape, and it must equal feedConfig's accepted set exactly.
    min_severity: { type: 'select', label: 'Minimum severity', default: 'info', choices: ['info', 'warn', 'critical'] },
    // Nested knobs, declarable through `meta.options`'s `path` — `sound_info` is
    // still omitted deliberately and permanently, because the Android app reads it and no design
    // ever does; see this file's docstring. Defaults restate `feedConfig`'s own (title 1, body 2,
    // counter on) and `min`/`max` restate the save schema's `integer, 1..10`
    // (`hub/src/routes/admin.ts`'s `alert_feed` branch), so a generated field can only offer a
    // value that saves.
    title_lines: { type: 'number', label: 'Title lines', default: 1, min: 1, max: 10, path: 'clamp.title_lines' },
    body_lines: { type: 'number', label: 'Body lines', default: 2, min: 1, max: 10, path: 'clamp.body_lines' },
    // Body text only — `scale` moves every size together, but on a wall read from across the room
    // the body (a path, a message) is usually the one line that needs the help while the title is
    // already a headline. Min 1: this knob only ever grows the body.
    body_scale: { type: 'number', label: 'Body text scale', default: 1, min: 1, max: 3 },
    counter: { type: 'boolean', label: 'Overflow counter', default: true, path: 'overflow.counter' },
  },
  animations: { transition: [], persistent: [] },
}

const finite = (value) => typeof value === 'number' && Number.isFinite(value)

function isArray(value) {
  try {
    return Array.isArray(value)
  } catch {
    return false
  }
}

/**
 * device.js's `ago()`, restated on an age in ms rather than a timestamp — see this file's docstring
 * for why this is NOT `formatAge`. Math.round and the bare `s`/`m`/`h` suffixes are the wording the
 * wall has shown since the widget existed.
 */
function formatAgo(ageMs) {
  const s = Math.max(0, Math.round((finite(ageMs) ? ageMs : 0) / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.round(s / 60)}m`
  return `${Math.round(s / 3600)}h`
}

/** Garbage in → defaults out, never a throw — layout-core.mjs's own house style for normalizers. */
const asText = (value) => (typeof value === 'string' ? value : '')

/**
 * The alert's answer options, or null. Order and count are the hub's ("render what arrives" —
 * device.js's cardHtml rule); entries missing either string are dropped, an empty result is the
 * same as no options at all, so a plain card and a malformed question lay out identically.
 */
function asOptions(value) {
  if (!isArray(value)) return null
  const opts = value
    .filter((o) => o !== null && typeof o === 'object')
    .filter((o) => typeof o.id === 'string' && o.id !== '' && typeof o.label === 'string' && o.label !== '')
    .map((o) => ({ id: o.id, label: o.label }))
  return opts.length > 0 ? opts : null
}

/**
 * draw→tap geometry, keyed off the cell's config object — `ctx.config` IS `cell.config` by
 * reference (widgets/index.mjs builds drawCtx from the raw cell), which is this design's version
 * of stream/scroll.mjs keying off `cell.config.feed`. Painter writes, hit test reads, the two
 * cannot disagree; a WeakMap so a screen swap cannot leak dead cells' rects.
 */
const hitState = new WeakMap()

/**
 * Every filter/order/format decision, none of the painting.
 *
 * `alerts` is `ctx.alerts` verbatim: the device's live alert array, never a
 * feed. A cell painted before the first STATE has arrived sees `undefined`, which is the empty
 * state and not an error.
 *
 * "Nothing to show" is ONE state whether the list was empty to begin with or `min_severity`
 * filtered it down to nothing — the DOM branch drew `no active alerts` for both, from a single
 * `feed.length === 0` check made AFTER filtering.
 */
export function normalizeAlertFeed(alerts, config, now) {
  const cfg = feedConfig(config)
  const at = finite(now) ? now : 0
  const rawBodyScale = config && typeof config === 'object' ? config.body_scale : null
  const base = {
    scale: cfg.scale,
    titleLines: cfg.titleLines,
    bodyLines: cfg.bodyLines,
    counter: cfg.counter,
    minSeverity: cfg.minSeverity,
    bodyScale: typeof rawBodyScale === 'number' && Number.isFinite(rawBodyScale)
      ? Math.min(3, Math.max(1, rawBodyScale))
      : 1,
  }

  const list = isArray(alerts) ? alerts.filter((a) => a !== null && typeof a === 'object') : []
  // The sender allowlist (`config.senders`, hand-authored — an array is not a shape meta.options
  // can generate). A screen that exists FOR one integration's cards names its senders and stops
  // inheriting every other card aimed at the same device; alerts still chime and dot the tabs,
  // because audibility is the device's business (Chime.kt) and this filter is only a rendering
  // decision. Empty or malformed degrades to "everyone" — a typo must not blank the wall.
  const allowRaw = config && typeof config === 'object' ? config.senders : null
  const allow = isArray(allowRaw)
    ? allowRaw.filter((s) => typeof s === 'string' && s !== '').map((s) => s.toLowerCase())
    : []
  const scoped = allow.length > 0
    ? list.filter((a) => allow.includes(String(a.sender?.name ?? '').toLowerCase()))
    : list
  // feedAlerts does the rank filter and the newest-first sort in one pass; restating either here
  // would be a second copy of the ordering contract the Kotlin twin was once kept honest against.
  const shown = feedAlerts(scoped, cfg.minSeverity)
  if (shown.length === 0) return { ...base, state: 'empty', cards: [] }

  const cards = shown.map((a) => {
    const body = asText(a.body)
    return {
      // The id rides along for exactly one consumer: the tap handler answering an option, which
      // has to name the alert it is answering. It is never painted.
      id: asText(a.id),
      severity: a.severity === 'warn' || a.severity === 'critical' ? a.severity : 'info',
      sender: asText(a.sender?.name),
      title: asText(a.title),
      // The DOM branch tested `a.body ?` — an absent OR empty body drew no element at all, which
      // is a different thing from an empty line (contract).
      body: body === '' ? null : body,
      age: formatAgo(at - (finite(a.updated_at) ? a.updated_at : at)),
      options: asOptions(a.options),
    }
  })
  return { ...base, state: 'ready', cards }
}

function draw(g, ctx) {
  const { box, tokens, config, now } = ctx
  if (!(box?.w > 0) || !(box?.h > 0)) return
  const n = normalizeAlertFeed(ctx.alerts, config, now)

  if (n.state === 'empty') {
    // Verbatim the old DOM branch's wording and its quiet `.clock-date` treatment — no active
    // alerts is the good state, not a failure. `8` (not a locally computed `pad`, which this
    // design has never needed elsewhere) reproduces the original `box.w - 16` maxWidth exactly.
    quietLine(g, 'no active alerts', box, tokens, 8, n.scale)
    return
  }

  const cardHeight = feedCardHeight(n.scale)
  const sizes = feedTextSizes(n.scale)
  const lineHeightOf = (px) => Math.round(px * 1.2)
  // The answer row's geometry, needed by the plan BEFORE painting: a question card is exactly one
  // button row taller than a plain card, so heights are per-card and the uniform-height cardPlan
  // no longer fits. planCards below reproduces cardPlan's exact semantics (greedy fit, counter
  // reservation, never-negative) over a height list; with no question on the board every height
  // equals cardHeight and the two plans agree card for card.
  const BTN_H = lineHeightOf(sizes.body) + 12
  const optRow = BTN_H + 10
  // `body_scale` sizes ONLY the body run — buttons and chrome stay on the base sizes — and each
  // card grows by exactly the extra line height it buys, so a big body never collides with the
  // Dismiss row pinned to the card's bottom.
  const bodyPx = Math.round(sizes.body * n.bodyScale)
  const bodyExtra = (lineHeightOf(bodyPx) - lineHeightOf(sizes.body)) * n.bodyLines
  const heights = n.cards.map((card) => cardHeight + bodyExtra + (card.options ? optRow : 0))

  // A scrolling list paints like one: every card from `-offset`, partials clipping at the cell's
  // edges. The card poking up from the bottom IS the scroll affordance — the pre-scroll layout
  // hid it behind the counter and left the rest of the cell empty, which read as a broken screen
  // the moment the feed could scroll (the operator's words: "we went backwards"). `offset` is px
  // dragged down the queue, surviving between draws on the same config object and clamped every
  // draw so answered/expired cards can never strand the view.
  const totalHeight = heights.reduce((sum, h) => sum + h, 0)
  const maxOffset = Math.max(0, totalHeight - box.h)
  const offset = Math.min(Math.max(0, hitState.get(ctx.config)?.offset ?? 0), maxOffset)
  const visible = n.cards
  // `.card`'s own 10px/12px padding and 4px left border (index.html) — the text column starts
  // inside both, and the card's planned height carries `.feed-card`'s 8px bottom margin.
  const STRIPE = 4
  const PAD_X = 12
  const PAD_Y = 10
  const textLeft = STRIPE + PAD_X
  const textRight = Math.max(textLeft, box.w - PAD_X)
  const usableWidth = Math.max(0, textRight - textLeft)
  const lineHeight = lineHeightOf

  const buttons = []
  let y = -offset
  for (const [i, card] of visible.entries()) {
    // Fully outside the canvas: nothing to paint, nothing to tap. Partial cards paint and clip.
    if (y + heights[i] <= 0 || y >= box.h) {
      y += heights[i]
      continue
    }
    const inner = heights[i] - 8
    // The severity stripe — `.card`'s border-left, through a declared token rather than a CSS var.
    // `rect` + `fill`, not `fillRect`: the portable drawing subset portable subset does not carry `fillRect`, and a
    // design that leaves the subset cannot be drawn by a non-browser renderer.
    g.fillStyle = tokens[card.severity] ?? tokens.info
    g.beginPath()
    g.rect(0, y, STRIPE, inner)
    g.fill()

    let cursor = y + PAD_Y
    // `.card .meta` is a flex row, justify-content: space-between — sender·severity hard left,
    // age hard right, both on one line. The DOM branch got this for free from flex: the two lived in
    // separate spans, so a long sender simply wrapped. On canvas the age is painted first and its
    // width is reserved, so the sender's budget cannot reach or overlap the right-aligned age.
    const ageFit = paintText(g, card.age, textRight, cursor, {
      px: sizes.meta, floor: FLOOR_LABEL, maxWidth: usableWidth,
      color: tokens.dim, align: 'right', baseline: 'top', weight: 400,
    })
    const ageWidth = g.measureText(ageFit.text).width
    const META_GAP = 6 // Breathing room between the sender/severity text and the age, not a hairline touch.
    const metaMaxWidth = Math.max(0, usableWidth - ageWidth - META_GAP)
    paintText(g, `${card.sender.toUpperCase()} · ${card.severity.toUpperCase()}`, textLeft, cursor, {
      px: sizes.meta, floor: FLOOR_LABEL, maxWidth: metaMaxWidth,
      color: tokens.dim, align: 'left', baseline: 'top', weight: 400,
    })
    cursor += lineHeight(sizes.meta) + 4 // `.card .title`'s own margin-top

    for (const line of wrapClamped(g, card.title, sizes.title, 600, usableWidth, n.titleLines)) {
      paintText(g, line, textLeft, cursor, {
        px: sizes.title, floor: FLOOR_LABEL, maxWidth: usableWidth,
        color: tokens.ink, align: 'left', baseline: 'top', weight: 600,
      })
      cursor += lineHeight(sizes.title)
    }

    if (card.body !== null) {
      cursor += 3 // `.card .body`'s own margin-top
      for (const line of wrapClamped(g, card.body, bodyPx, 400, usableWidth, n.bodyLines)) {
        paintText(g, line, textLeft, cursor, {
          px: bodyPx, floor: FLOOR_LABEL, maxWidth: usableWidth,
          color: tokens.dim, align: 'left', baseline: 'top', weight: 400,
        })
        cursor += lineHeight(bodyPx)
      }
    }

    // Dismiss, bottom-right of every card — the affordance the idle view always had and the
    // widget never grew, which left wall cards unconcludable outside their TTL. Painted first so
    // the answer row below knows how much right edge it must not reach into.
    // Same chrome as the answer buttons below — bare dim text read as a caption, not an action
    // (the wall's own operator missed it on day one), and an affordance nobody recognises is the
    // unanswerable-card bug wearing a costume.
    g.font = `600 ${sizes.meta}px system-ui`
    const dismissTextW = Math.round(g.measureText('Dismiss').width)
    const dismissW = dismissTextW + 24
    const dismissH = lineHeight(sizes.meta) + 12
    const dismissX = textRight - dismissW
    const dismissY = y + inner - dismissH - 6
    g.globalAlpha = 0.18
    g.fillStyle = tokens.ink
    g.beginPath()
    g.rect(dismissX, dismissY, dismissW, dismissH)
    g.fill()
    g.globalAlpha = 1
    paintText(g, 'Dismiss', textRight - 12, dismissY + 6, {
      px: sizes.meta, floor: FLOOR_LABEL, maxWidth: dismissTextW,
      color: tokens.ink, align: 'right', baseline: 'top', weight: 600,
    })
    buttons.push({
      x: dismissX - 6, y: dismissY - 6, w: dismissW + 12, h: dismissH + 12,
      alertId: card.id, dismiss: true,
    })

    if (card.options) {
      // The answer row sits in the card's extension (the optRow the plan added), pinned to the
      // card's bottom rather than the text cursor so a clamped title/body cannot push buttons
      // out of their own hit rects. Buttons that would overrun the right edge (or reach into the
      // Dismiss control sharing the card bottom) are not painted — and therefore not tappable:
      // a button the finger cannot see must not be a button.
      const BTN_PAD_X = 12
      const BTN_GAP = 8
      const optRight = textRight - dismissW - 24
      const btnY = y + cardHeight - 8 + 4
      let btnX = textLeft
      for (const option of card.options) {
        g.font = `600 ${sizes.body}px system-ui`
        const w = Math.round(g.measureText(option.label).width) + BTN_PAD_X * 2
        if (btnX + w > optRight) break
        g.globalAlpha = 0.18
        g.fillStyle = tokens.ink
        g.beginPath()
        g.rect(btnX, btnY, w, BTN_H)
        g.fill()
        g.globalAlpha = 1
        paintText(g, option.label, btnX + BTN_PAD_X, btnY + 6, {
          px: sizes.body, floor: FLOOR_LABEL, maxWidth: w - BTN_PAD_X * 2,
          color: tokens.ink, align: 'left', baseline: 'top', weight: 600,
        })
        buttons.push({ x: btnX, y: btnY, w, h: BTN_H, alertId: card.id, optionId: option.id })
        btnX += w + BTN_GAP
      }
    }
    y += heights[i]
  }
  hitState.set(ctx.config, { buttons, offset, maxOffset })

  // "and N more" counts cards ENTIRELY below the bottom edge — a partial card speaks for itself.
  // Pinned inside the bottom edge over whatever is there: dim, small, and gone the moment the
  // scroll brings the last card's top above the fold.
  if (n.counter) {
    let top = -offset
    let hiddenBelow = 0
    for (const h of heights) {
      if (top >= box.h) hiddenBelow += 1
      top += h
    }
    if (hiddenBelow > 0) {
      // Fixed 14px, unscaled — same reasoning stream_list gives for its own counter.
      const counterFit = fitted(g, `and ${hiddenBelow} more`, 14, FLOOR_LABEL, usableWidth, 400)
      paintText(g, counterFit.text, textLeft, box.h - lineHeight(counterFit.px) - 4, {
        px: counterFit.px, floor: FLOOR_LABEL, maxWidth: usableWidth,
        color: tokens.dim, align: 'left', baseline: 'top', weight: 400,
      })
    }
  }
}

/**
 * A tap inside a painted answer button answers that alert through the host's actions channel
 * (device.js sends the same `TAP action:'answer'` the idle card buttons send). Everything else —
 * misses, a gesture racing the first draw, a host too old to pass `actions` — returns false and
 * touches nothing.
 */
const pointer = {
  tap(cell, x, y, actions) {
    const state = hitState.get(cell?.config)
    if (!state) return false
    const hit = state.buttons.find((b) => x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h)
    if (!hit) return false
    if (hit.dismiss) {
      if (typeof actions?.dismiss !== 'function') return false
      actions.dismiss(hit.alertId)
      return true
    }
    if (typeof actions?.answer !== 'function') return false
    actions.answer(hit.alertId, hit.optionId)
    return true
  },
  // Content follows the finger, stream/scroll's own grammar: dragging UP (dy < 0) reveals the
  // older cards below. The offset mutates in place on the stored state and the next draw clamps
  // and repaints from it; `false` for a feed that fits, so a repaint is never spent on nothing.
  move(cell, dy) {
    const state = hitState.get(cell?.config)
    if (!state || !(state.maxOffset > 0)) return false
    const next = Math.min(Math.max(0, state.offset - dy), state.maxOffset)
    if (next === state.offset) return false
    state.offset = next
    return true
  },
  wheel(cell, deltaY) {
    return pointer.move(cell, -deltaY)
  },
}

export default { meta, draw, pointer }
