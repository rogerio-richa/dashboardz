/**
 * Canvas can't be painted from an HTML string, so a cell emits a placeholder and is painted in a
 * post-insert pass once it is in the DOM and has real dimensions — the two-step shape the DOM
 * chart renderer used first (device.js renderGrid → paintCharts) and every design uses now.
 *
 * setTransform (not scale) because prepare runs on every repaint: scale() would compound the
 * ratio each frame, so the first animated cell would shrink toward nothing.
 */
export function canvasHtml(idx) {
  return `<canvas class="widget-canvas" data-cell="${idx}"></canvas>`
}

export function prepare(canvas, cssW, cssH, dpr) {
  const ratio = dpr || 1
  const w = Math.round(cssW * ratio)
  const h = Math.round(cssH * ratio)
  // Assigned only on a real change. Per the HTML spec ANY assignment to width/height resets the
  // bitmap — including an assignment of the value already there — so doing it unconditionally is
  // a full reallocate-and-clear of the backing store on every frame of every animating cell.
  // A cell's size only changes when the board is laid out again.
  if (canvas.width !== w) canvas.width = w
  if (canvas.height !== h) canvas.height = h
  canvas.style.width = `${cssW}px`
  canvas.style.height = `${cssH}px`
  const g = canvas.getContext('2d')
  // Both are unconditional: a resize resets the transform and clears the bitmap, while a same-size
  // frame needs the explicit calls to remove the previous frame and transform.
  g.setTransform(ratio, 0, 0, ratio, 0, 0)
  g.clearRect(0, 0, cssW, cssH)
  return g
}
