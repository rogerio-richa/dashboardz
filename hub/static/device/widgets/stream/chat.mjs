/**
 * `stream_list`/`chat` — the message-board reading of a stream feed: a clock-time column, a bold
 * `@sender:` line, the message text under it, and a translucent rule between rows. Built for the
 * Meshtastic messages feed (rows `{from, short, text, ...}` — integrations/meshtastic/monitor.py)
 * but generic over the same knobs as `scroll.mjs`: `title_path` is the SENDER here, `body_path`
 * the message text. The options block is byte-identical to scroll's — same widget, same schema
 * branch, same defaults (a different default would make the admin's generated field lie about
 * what an unset key renders); a Meshtastic cell sets `title_path: "from"`, `body_path: "text"`
 * explicitly. No `counter` knob, for scroll's own documented reason: scrolling IS this design's
 * answer to overflow, and "and N more" under a scrollable column would claim a limitation the
 * design does not have.
 *
 * SCROLLS exactly as `scroll.mjs` does — same drag/wheel/arrow-rail/follow-lock/unseen-badge
 * contract, same `scroll-core.mjs` arithmetic, and the pointer group itself comes from scroll's
 * exported `pointerFor` factory (over this design's OWN state Map: positions must not be shared
 * across designs drawing the same feed, since a design switch would inherit an offset computed
 * under another card height). See scroll.mjs's docstring for the full interaction contract and
 * why state is keyed by feed id.
 *
 * Reuses `normalizeStream` from `./list.mjs` — the same cross-design import `./scroll.mjs`
 * already established for `paintCard` — so the loud/quiet/ready state rules and every read-path
 * decision stay defined once. The painting differs enough (time column, sender prefix, hairline)
 * that `paintCard` itself is not reused.
 *
 * The time column shows wall-clock HH:MM (the mock's reading) derived as `now - ageMs` —
 * `normalizeStream` already turns each row's `pushed_at` into an age against the injected `now`,
 * and re-deriving the instant keeps this design off `Date.now()` (repaint determinism, same
 * reason every design reads `ctx.now`). Local time via the Date getters, same as clock designs.
 *
 * The hairline is `dim` at 0.25 alpha — a canvas design cannot read `chrome.hairline` (CSS vars
 * do not exist here; see gauge/ring.mjs's retired `--gauge-hole` story), so the rule uses the
 * design's own dim token at reduced alpha, which visually approximates a hairline and tracks the
 * theme's palette through dim. It is deliberately NOT the chrome derivation formula (that one is
 * alpha(ink, 0.08) in theme.mjs's CHROME_FROM_BOARD) and needs no sync with it.
 */
import {
  applyScale, rampValues,
  STREAM_RAMP, STREAM_CARD_TITLE, STREAM_CARD_BODY, FLOOR_LABEL,
} from '../../layout-core.mjs'
import { centredNotice, paintText, quietLine, wrapClamped } from '../text-fit.mjs'
import { normalizeStream } from './list.mjs'
import { paintArrow, pointerFor } from './scroll.mjs'
import { RAIL_W, arrowLayout, reconcile } from './scroll-core.mjs'

const meta = {
  id: 'chat',
  widget: 'stream_list',
  label: 'Chat',
  suggested_ratio: 3 / 4,
  tokens: {
    ink: { type: 'color', default: '@ink' },
    dim: { type: 'color', default: '@dim' },
    // Same slot, same register as scroll.mjs's: the ▲ badge when unseen rows are waiting.
    badge: { type: 'color', default: '@warn' },
  },
  // Byte-identical to scroll.mjs's options — see this file's docstring.
  options: {
    title_path: { type: 'text', label: 'Title path', default: 'title' },
    body_path: { type: 'text', label: 'Body path', default: '' },
    title_lines: { type: 'number', label: 'Title lines', default: 1, min: 1, max: 10, path: 'clamp.title_lines' },
    body_lines: { type: 'number', label: 'Body lines', default: 2, min: 1, max: 10, path: 'clamp.body_lines' },
  },
  animations: { transition: [], persistent: [] },
}

/** feed id → scroll state, this design's own Map (see docstring). */
const states = new Map()

/** Test seam, mirroring scroll.mjs's `_resetScrollState`. */
export function _resetChatScrollState() {
  states.clear()
}

/** Wall-clock HH:MM for a row pushed `ageMs` before `now`. */
function timeLabel(now, ageMs) {
  const d = new Date(now - ageMs)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function draw(g, ctx) {
  const { box, tokens, config, now } = ctx
  if (!(box?.w > 0) || !(box?.h > 0)) return
  const n = normalizeStream(ctx.rows, ctx.feed ?? null, config, now)
  const pad = Math.max(4, Math.min(16, Math.min(box.w, box.h) * 0.04))

  if (n.state === 'missing') {
    centredNotice(g, 'Feed missing', 'Bind this cell to a stream feed', box, tokens, pad, n.scale)
    return
  }
  if (n.state === 'empty') {
    quietLine(g, '— no rows yet', box, tokens, pad, n.scale)
    return
  }

  // Scroll state, exactly scroll.mjs's sequence: reconcile against the wire, lay out the rail,
  // store geometry with the state so the pointer path shares one answer.
  const feedId = typeof config?.feed === 'string' && config.feed ? config.feed : null
  const cardHeight = n.bodyPath ? STREAM_CARD_BODY : STREAM_CARD_TITLE
  const pushedAts = ctx.rows.map((row) => (row !== null && typeof row === 'object' ? row.pushed_at : null))
  const state = reconcile(feedId ? states.get(feedId) : null, pushedAts, cardHeight, box.h, now)
  const layout = arrowLayout(box.w, box.h, state.max > 0, state.unseen)
  if (feedId) {
    states.set(feedId, { ...state, layout, rowCount: ctx.rows.length, cardH: cardHeight, viewH: box.h })
  }

  const ramp = rampValues(STREAM_RAMP, box.t ?? 1)
  const titlePx = applyScale(ramp.title, n.scale, FLOOR_LABEL)
  const bodyPx = applyScale(ramp.body, n.scale, FLOOR_LABEL)
  const railShown = layout.up !== null || layout.down !== null
  const usableWidth = Math.max(0, box.w - pad * 2 - (railShown ? RAIL_W : 0))
  const stale = ctx.stale === true
  const lineHeight = (px) => Math.round(px * 1.2)

  // Time column width off the widest possible stamp, at body size.
  g.font = `400 ${bodyPx}px system-ui`
  const timeWidth = g.measureText('88:88').width
  const timeGap = Math.max(4, Math.round(bodyPx * 0.5))
  const textX = pad + timeWidth + timeGap
  const textWidth = Math.max(0, usableWidth - timeWidth - timeGap)

  // Paint only rows that intersect the viewport (scroll.mjs's windowing — the canvas edge does
  // the fine clipping; `clip()` is outside the portable subset).
  const first = Math.max(0, Math.floor(state.offset / cardHeight))
  const last = Math.min(n.rows.length - 1, Math.ceil((state.offset + box.h) / cardHeight))
  g.globalAlpha = stale ? 0.5 : 1
  for (let i = first; i <= last; i++) {
    const row = n.rows[i]
    const y = i * cardHeight - state.offset
    let cursor = y + 4
    if (row.ageMs !== null) {
      paintText(g, timeLabel(now, row.ageMs), pad, cursor, {
        px: bodyPx, floor: FLOOR_LABEL, maxWidth: timeWidth + 2,
        color: tokens.dim, align: 'left', baseline: 'top', weight: 400,
      })
    }
    for (const line of wrapClamped(g, `@${row.title}:`, titlePx, 700, textWidth, n.titleLines)) {
      paintText(g, line, textX, cursor, {
        px: titlePx, floor: FLOOR_LABEL, maxWidth: textWidth,
        color: tokens.ink, align: 'left', baseline: 'top', weight: 700,
      })
      cursor += lineHeight(titlePx)
    }
    if (n.bodyPath && row.body !== null) {
      cursor += 2
      for (const line of wrapClamped(g, row.body, bodyPx, 400, textWidth, n.bodyLines)) {
        paintText(g, line, textX, cursor, {
          px: bodyPx, floor: FLOOR_LABEL, maxWidth: textWidth,
          color: tokens.ink, align: 'left', baseline: 'top', weight: 400,
        })
        cursor += lineHeight(bodyPx)
      }
    }
    // The row rule — dim at low alpha; see this file's docstring.
    const priorAlpha = g.globalAlpha
    g.beginPath()
    g.globalAlpha = priorAlpha * 0.25
    g.strokeStyle = tokens.dim
    g.lineWidth = 1
    g.moveTo(pad, y + cardHeight - 1)
    g.lineTo(pad + usableWidth, y + cardHeight - 1)
    g.stroke()
    g.globalAlpha = priorAlpha
  }
  g.globalAlpha = 1

  if (layout.up) paintArrow(g, layout.up, 'up', tokens, state)
  if (layout.down) paintArrow(g, layout.down, 'down', tokens, state)
}

export default { meta, draw, pointer: pointerFor(states) }
