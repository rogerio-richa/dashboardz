/**
 * v5 -> v6. `template` + row-major cells become per-cell rects.
 * The four templates map EXACTLY onto the anchors sizeT was calibrated against, so a migrated
 * board renders byte-identically — see the design's sizeT table. A pure function so the mapping
 * is unit-testable; the runner below only walks rows.
 */
type OldCell = { widget?: string; config?: Record<string, unknown> }
type OldGrid = { template?: string; cells?: OldCell[] }
export type Rect = { x: number; y: number; w: number; h: number }
export type NewGrid = { cells: { rect: Rect; widget?: string; config?: Record<string, unknown> }[] }

const LAYOUTS: Record<string, Rect[]> = {
  '1x1': [{ x: 0, y: 0, w: 1, h: 1 }],
  '2x1': [{ x: 0, y: 0, w: 0.5, h: 1 }, { x: 0.5, y: 0, w: 0.5, h: 1 }],
  '1x2': [{ x: 0, y: 0, w: 1, h: 0.5 }, { x: 0, y: 0.5, w: 1, h: 0.5 }],
  '2x2': [
    { x: 0, y: 0, w: 0.5, h: 0.5 }, { x: 0.5, y: 0, w: 0.5, h: 0.5 },
    { x: 0, y: 0.5, w: 0.5, h: 0.5 }, { x: 0.5, y: 0.5, w: 0.5, h: 0.5 },
  ],
}

export function gridToRects(grid: OldGrid): NewGrid {
  const rects = LAYOUTS[grid.template ?? ''] ?? LAYOUTS['1x1']
  const cells = Array.isArray(grid.cells) ? grid.cells : []
  return {
    // A row whose cell count disagrees with its template is already broken; giving the extras a
    // full-bleed rect keeps them visible and deletable rather than silently dropping them.
    cells: cells.map((c, i) => ({ rect: rects[i] ?? { x: 0, y: 0, w: 1, h: 1 }, ...c })),
  }
}
