// Editor-only geometry. Deliberately NOT in layout-core.mjs: that module is twin-pinned to
// apps/android/.../core/Layout.kt by shared vectors, so anything added there implies a Kotlin
// twin. Nothing here runs on a device — it exists purely to turn pointer gestures into rects.
// The SHARED rules (quantize, RECT_MIN, rectValid, rectsOverlap, safeRect) still come from
// layout-core, so the editor snaps and validates exactly as both renderers do.
// @ts-expect-error plain JS module without types
import { RECT_MIN, quantize } from '../../static/device/layout-core.mjs'
// @ts-expect-error plain JS module without types
import { WIDGET_DEFINITIONS } from '../../static/device/widgets/definitions.mjs'

export interface Rect { x: number; y: number; w: number; h: number }
/**
 * TypeScript cannot infer a literal union through the plain-MJS boundary. Keep the narrow tuple
 * needed for editor type safety and pin it exactly against WIDGET_DEFINITIONS in the hub test.
 */
export const EDITOR_WIDGET_IDS = [
  'clock', 'alert_feed', 'calendar_events', 'value_tile', 'gauge', 'stream_list', 'table',
  'text_block', 'chart', 'image', 'weather_forecast', 'news_list',
] as const
export type Widget = typeof EDITOR_WIDGET_IDS[number]
export interface Cell { rect: Rect; widget: Widget; config: Record<string, unknown> }

/** Editor-local pairing of a cell with a stable identity. `id` NEVER reaches the server —
 *  cellSchema in hub/src/routes/admin.ts sets additionalProperties: false. */
export interface EditorCell { id: string; cell: Cell }

/** A screen shape, as a ratio only — magnitudes are irrelevant. */
export interface Aspect { w: number; h: number }

export const TARGET_SHAPES: { label: string; aspect: Aspect }[] = [
  { label: '16:10 (default landscape)', aspect: { w: 16, h: 10 } },
  { label: '10:16 (default portrait)', aspect: { w: 10, h: 16 } },
  { label: '16:9', aspect: { w: 16, h: 9 } },
  { label: '9:16', aspect: { w: 9, h: 16 } },
  // Both ways round. A tall phone has the most extreme aspect of anything we target, and having
  // only the portrait entry meant a LANDSCAPE A05 had no shape in this list that matched it —
  // so a board for one got designed against 16:10 and every cell came out 28% shorter in pixels
  // than the preview showed. Enough to push a tile past its height budget (see shrinkToFit).
  { label: '9:20 (Galaxy A05 portrait)', aspect: { w: 9, h: 20 } },
  { label: '20:9 (Galaxy A05 landscape)', aspect: { w: 20, h: 9 } },
  { label: '4:3', aspect: { w: 4, h: 3 } },
]

/** Suggested PIXEL ratio (W:H) per widget, from what each one actually draws. */
const RATIOS = Object.fromEntries(WIDGET_DEFINITIONS.map((definition: { id: Widget; suggested_ratio: number }) => (
  [definition.id, definition.suggested_ratio]
))) as Record<Widget, number>

/**
 * `_config` is intentionally unused (kept underscore-prefixed per this project's
 * `noUnusedParameters` convention). A widget's ratio comes from `WIDGET_DEFINITIONS`, so both
 * canvas gauge designs use their declared ratio and never depend on per-cell configuration.
 */
export function suggestedRatio(widget: Widget, _config: Record<string, unknown>): number {
  return RATIOS[widget]
}

/** The ratio the DEVICE will draw, which is what the operator actually cares about. */
export function renderedRatio(rect: Rect, aspect: Aspect): number {
  return (rect.w * aspect.w) / (rect.h * aspect.h)
}

/**
 * Turn a pixel ratio into a fractional rect for a given screen shape.
 * w_px/h_px = (w/h) * (screenW/screenH), so w/h = R / A. Sizes so the LARGER axis is 0.4,
 * then clamps. Ordinary ratios come through untouched — a 2:1 clock is w 0.4 / h 0.32 on 16:10
 * and w 0.4 / h 0.09 on 9:20, exact in both. Only extremes clamp: 40:1 on 16:10 wants h = 0.016,
 * RECT_MIN lifts it to 0.05, and the ratio is deliberately lost. Accepted — placement is a
 * starting point, not a guarantee, and isOffRatio will show the truth.
 */
export function ratioToRect(ratio: number, aspect: Aspect): Rect {
  const wOverH = ratio / (aspect.w / aspect.h)
  let w: number, h: number
  if (wOverH >= 1) { w = 0.4; h = 0.4 / wOverH } else { h = 0.4; w = 0.4 * wOverH }
  w = quantize(Math.min(1, Math.max(RECT_MIN, w)))
  h = quantize(Math.min(1, Math.max(RECT_MIN, h)))
  return { x: 0, y: 0, w, h }
}

export const OFF_RATIO_TOL = 0.1

/** True when the card will render more than OFF_RATIO_TOL away from its widget's shape. */
export function isOffRatio(
  rect: Rect, widget: Widget, config: Record<string, unknown>, aspect: Aspect,
  tol: number = OFF_RATIO_TOL,
): boolean {
  const want = suggestedRatio(widget, config)
  const got = renderedRatio(rect, aspect)
  return Math.abs(got - want) / want > tol
}

export type Handle = 'nw' | 'ne' | 'sw' | 'se' | 'n' | 's' | 'e' | 'w'

const clamp01 = (v: number) => Math.min(1, Math.max(0, v))

/** Translate without resizing. The card stops at the board edge rather than being squashed. */
export function moveRect(rect: Rect, dx: number, dy: number): Rect {
  return {
    x: quantize(Math.min(1 - rect.w, clamp01(rect.x + dx))),
    y: quantize(Math.min(1 - rect.h, clamp01(rect.y + dy))),
    w: rect.w,
    h: rect.h,
  }
}

/**
 * Resize from one handle. `lockRatio` is w/h in FRACTION space (already resolved for the target
 * shape by the caller); null means free. Edges opposite the handle stay pinned, so a resize never
 * silently translates the card.
 */
export function resizeRect(rect: Rect, handle: Handle, dx: number, dy: number, lockRatio: number | null): Rect {
  const west = handle.includes('w'), east = handle.includes('e')
  const north = handle.startsWith('n'), south = handle.startsWith('s')
  // A ratio must be a positive, finite w/h. Anything else (0, negative, NaN, Infinity) would
  // divide into a NaN rect below, so treat it the same as "no lock" rather than propagating NaN.
  const lock = lockRatio !== null && Number.isFinite(lockRatio) && lockRatio > 0 ? lockRatio : null

  let { x, y, w, h } = rect
  const right = x + w, bottom = y + h

  if (east) w = w + dx
  if (west) { x = x + dx; w = right - x }
  if (south) h = h + dy
  if (north) { y = y + dy; h = bottom - y }

  // On a corner with a lock, the dominant axis wins so the card follows the pointer naturally.
  if (lock !== null && (east || west) && (north || south)) {
    if (Math.abs(dx) >= Math.abs(dy)) h = w / lock
    else w = h * lock
  }

  w = Math.max(RECT_MIN, w)
  h = Math.max(RECT_MIN, h)
  if (west) x = right - w
  if (north) y = bottom - h

  x = clamp01(x); y = clamp01(y)
  // Re-derive against the PINNED edge, not the board edge. clamp01 above can move x/y after the
  // pin was set, and `1 - x` would then let the opposite edge drift outward — the exact thing a
  // resize must never do. `right - x <= 1 - x` always holds (right <= 1), so pinning also
  // satisfies the board bound for free.
  if (west) w = right - x; else w = Math.min(w, 1 - x)
  if (north) h = bottom - y; else h = Math.min(h, 1 - y)
  // Belt-and-braces, not load-bearing under the logic above: x/y are already clamped into
  // [0, 1] and w/h are derived from a pinned-or-bounded edge, so this floor should never be the
  // thing that fires. Kept as a guard against a future change re-introducing an unfloored path.
  w = Math.max(RECT_MIN, w); h = Math.max(RECT_MIN, h)

  return { x: quantize(x), y: quantize(y), w: quantize(w), h: quantize(h) }
}

/** Edge-snap threshold, in fraction space — 1.5% of the board's extent on that axis. */
export const SNAP = 0.015

const xEdges = (others: Rect[]) => [0, 1, ...others.flatMap((o) => [o.x, o.x + o.w])]
const yEdges = (others: Rect[]) => [0, 1, ...others.flatMap((o) => [o.y, o.y + o.h])]

/** Nearest candidate within `snap`, or null. */
function nearest(value: number, candidates: number[], snap: number): number | null {
  let best: number | null = null, bestD = snap
  for (const c of candidates) {
    const d = Math.abs(c - value)
    if (d <= bestD) { bestD = d; best = c }
  }
  return best
}

/**
 * Snap a MOVED rect. Size is preserved absolutely — a move must never resize. Each axis is
 * considered independently, and both the leading and trailing edge compete; the closer wins.
 */
export function snapMove(rect: Rect, others: Rect[], snap: number = SNAP): Rect {
  const xs = xEdges(others), ys = yEdges(others)
  let x = rect.x, y = rect.y

  const leftHit = nearest(rect.x, xs, snap)
  const rightHit = nearest(rect.x + rect.w, xs, snap)
  if (leftHit !== null && (rightHit === null || Math.abs(leftHit - rect.x) <= Math.abs(rightHit - (rect.x + rect.w)))) x = leftHit
  else if (rightHit !== null) x = rightHit - rect.w

  const topHit = nearest(rect.y, ys, snap)
  const botHit = nearest(rect.y + rect.h, ys, snap)
  if (topHit !== null && (botHit === null || Math.abs(topHit - rect.y) <= Math.abs(botHit - (rect.y + rect.h)))) y = topHit
  else if (botHit !== null) y = botHit - rect.h

  return { x: quantize(x), y: quantize(y), w: rect.w, h: rect.h }
}

/** Snap a RESIZED rect — only edges the handle actually controls may move. */
export function snapResize(rect: Rect, others: Rect[], handle: Handle, snap: number = SNAP): Rect {
  const xs = xEdges(others), ys = yEdges(others)
  let { x, y, w, h } = rect
  const right = x + w, bottom = y + h

  if (handle.includes('w')) { const hit = nearest(x, xs, snap); if (hit !== null) { x = hit; w = right - x } }
  if (handle.includes('e')) { const hit = nearest(right, xs, snap); if (hit !== null) w = hit - x }
  if (handle.startsWith('n')) { const hit = nearest(y, ys, snap); if (hit !== null) { y = hit; h = bottom - y } }
  if (handle.startsWith('s')) { const hit = nearest(bottom, ys, snap); if (hit !== null) h = hit - y }

  // Floor to RECT_MIN, then re-pin against the edge the HANDLE never touched, not the snapped
  // one. Flooring w/h in place and leaving x/y at the raw snap hit would drag the opposite edge
  // along with it — e.g. a 'w' drag whose snap carves w below RECT_MIN would otherwise shift the
  // east edge, violating "only edges the handle controls may move" (same bug class as
  // resizeRect's origin-clamp pin: the floor must re-derive from the ANCHOR, not the moved edge).
  w = Math.max(RECT_MIN, w)
  h = Math.max(RECT_MIN, h)
  if (handle.includes('w')) x = right - w
  if (handle.startsWith('n')) y = bottom - h

  return { x: quantize(x), y: quantize(y), w: quantize(w), h: quantize(h) }
}
