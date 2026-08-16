import { useEffect, useRef, useState } from 'react'
import type { Aspect, Cell, EditorCell, Rect, Widget } from '../layout-edit'
import { isOffRatio, moveRect, renderedRatio, resizeRect, snapMove, snapResize, suggestedRatio, type Handle } from '../layout-edit'
// safeRect is the SHARED coercion both renderers use. A corrupt rect must still be visible and
// draggable — it is the operator's only route to fixing the row — while rectValid keeps save
// blocked. Degrade at render, never crash the page.
// @ts-expect-error plain JS module without types
import { safeRect } from '../../../static/device/layout-core.mjs'

export interface LayoutCanvasProps {
  items: EditorCell[]
  aspect: Aspect
  selectedId: string | null
  onSelect(id: string | null): void
  onRectChange(id: string, rect: Rect): void
  labelFor(cell: Cell, id: string): string
  overlappingIds: Set<string>
  pendingIds?: Set<string>
  /**
   * Cards whose box on the ACTUAL target device is smaller than the widget's declared minimum
   * (WIDGET_MIN_PX). Empty when no device has reported a viewport — an unenforceable rule must not
   * paint warnings it cannot justify.
   */
  undersizedIds?: Set<string>
  // Optional: LayoutCanvas.test.tsx's shared `base` props object does not supply it, and a
  // required prop would break every one of those tests on a type error rather than a real failure.
  onDropWidget?(widget: Widget, xFrac: number, yFrac: number): void
}

// `handle` is null for a move and set for a resize. Declared now, used by tab-bar behavior — declaring it
// here avoids reshaping the gesture state mid-lane. `pointerId` pins the gesture to the exact
// pointer that started it — a second touch, or a stray pointer over another element, must not be
// able to steer a drag it did not start.
interface Gesture { id: string; handle: Handle | null; pointerId: number; startRect: Rect; startX: number; startY: number; boardW: number; boardH: number }

export default function LayoutCanvas({ items, aspect, selectedId, onSelect, onRectChange, labelFor, overlappingIds, pendingIds, undersizedIds, onDropWidget }: LayoutCanvasProps) {
  const boardRef = useRef<HTMLDivElement>(null)
  const [gesture, setGesture] = useState<Gesture | null>(null)

  // Named `begin`, not `beginMove`: tab-bar behavior reuses this exact function for resize by passing a
  // handle. Do not rename it there.
  const begin = (e: React.PointerEvent, id: string, rect: Rect, handle: Handle | null = null) => {
    // A pointerDown on another card (or a second touch) while a gesture is already in progress
    // must not silently steal it — the in-progress gesture would be abandoned with no matching
    // end(), leaving its listeners attached to a gesture nothing can ever close out cleanly.
    if (gesture) return
    const board = boardRef.current
    if (!board) return
    const box = board.getBoundingClientRect()
    // A zero-sized board (hidden tab, pre-layout) would divide by zero and put NaN into a rect,
    // which then fails validation with a message nobody can act on. Refuse the gesture instead.
    if (!box.width || !box.height) return
    board.setPointerCapture?.(e.pointerId)
    setGesture({ id, handle, pointerId: e.pointerId, startRect: rect, startX: e.clientX, startY: e.clientY, boardW: box.width, boardH: box.height })
  }

  useEffect(() => {
    if (!gesture) return
    // safeRect here too: every other rect this component touches goes through it (see the card
    // render loop below), and a neighbour with a corrupt rect must not throw inside the
    // pointermove listener just because a HEALTHY card is the one being dragged next to it.
    const others = items.filter((it) => it.id !== gesture.id).map((it) => safeRect(it.cell.rect))
    // A stray second pointer must not steer a drag it did not start — only events carrying the
    // exact pointerId that began this gesture are honored, for the move itself and every terminator.
    const onMove = (e: PointerEvent) => {
      if (e.pointerId !== gesture.pointerId) return
      const dx = (e.clientX - gesture.startX) / gesture.boardW
      const dy = (e.clientY - gesture.startY) / gesture.boardH
      if (gesture.handle) {
        // lockRatio is w/h in FRACTION space: the widget's pixel ratio divided by the board's.
        const cell = items.find((it) => it.id === gesture.id)!.cell
        const lock = e.shiftKey ? null : suggestedRatio(cell.widget, cell.config) / (aspect.w / aspect.h)
        const sized = resizeRect(gesture.startRect, gesture.handle, dx, dy, lock)
        onRectChange(gesture.id, e.altKey ? sized : snapResize(sized, others, gesture.handle))
      } else {
        const moved = moveRect(gesture.startRect, dx, dy)
        onRectChange(gesture.id, e.altKey ? moved : snapMove(moved, others))
      }
    }
    const end = (e: PointerEvent) => { if (e.pointerId === gesture.pointerId) setGesture(null) }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', end)
    window.addEventListener('pointercancel', end)
    window.addEventListener('lostpointercapture', end)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', end)
      window.removeEventListener('pointercancel', end)
      window.removeEventListener('lostpointercapture', end)
    }
  }, [gesture, items, onRectChange, aspect])

  return (
    <div
      data-testid="canvas-board"
      ref={boardRef}
      tabIndex={0}
      onPointerDown={() => onSelect(null)}
      // Only advertise the board as a drop target for our OWN drags — an unconditional
      // preventDefault() here would make it a valid drop target for anything (files, URLs,
      // text), which the browser then expects `drop` to handle.
      onDragOver={(e) => { if (onDropWidget && e.dataTransfer.types.includes('text/dbz-widget')) e.preventDefault() }}
      onDrop={(e) => {
        // Unconditional and FIRST: a drop the rest of this handler bails out of (no widget
        // handler wired up, no payload, board unmeasured) must still be swallowed here, or the
        // browser performs its default action for whatever was actually dropped — for a file or
        // link, that is navigating away from the admin with every unsaved edit lost.
        e.preventDefault()
        if (!onDropWidget) return
        const widget = e.dataTransfer.getData('text/dbz-widget') as Widget
        if (!widget) return
        const board = boardRef.current
        if (!board) return
        // Same measured box the pointer gestures use (see `begin` above) — the drop point is
        // converted through it so a dropped card lands under the cursor, not somewhere else.
        const box = board.getBoundingClientRect()
        if (!box.width || !box.height) return
        const xFrac = (e.clientX - box.left) / box.width
        const yFrac = (e.clientY - box.top) / box.height
        onDropWidget(widget, xFrac, yFrac)
      }}
      onKeyDown={(e) => {
        if (!selectedId) return
        const step = e.shiftKey ? 0.01 : 0.001
        const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key]
        if (!d) return
        e.preventDefault()
        const sel = items.find((it) => it.id === selectedId)
        if (sel) onRectChange(selectedId, moveRect(safeRect(sel.cell.rect), d[0], d[1]))
      }}
      style={{
        // 420 was sized for a canvas sharing a row with a full-width inspector and a widget
        // palette. Both are gone, so the board takes the room it was always the point of — capped
        // only so a very wide window does not blow a 16:10 board up past anything you would check
        // a layout at.
        width: '100%', maxWidth: 720, aspectRatio: `${aspect.w} / ${aspect.h}`,
        border: '1px solid var(--line-strong)', position: 'relative', boxSizing: 'border-box',
      }}
    >
      {items.map(({ id, cell }) => {
        const r: Rect = safeRect(cell.rect)
        const selected = id === selectedId
        const offRatio = isOffRatio(r, cell.widget, cell.config, aspect)
        const undersized = undersizedIds?.has(id) ?? false
        return (
          <div
            key={id}
            data-testid={`card-${id}`}
            data-overlap={overlappingIds.has(id) ? 'true' : 'false'}
            data-off-ratio={offRatio ? 'true' : 'false'}
            data-undersized={undersized ? 'true' : 'false'}
            title={offRatio
              ? `suggested ratio ${suggestedRatio(cell.widget, cell.config).toFixed(2)}, rendered ${renderedRatio(r, aspect).toFixed(2)}`
              : undefined}
            onPointerDown={(e) => { e.stopPropagation(); onSelect(id); begin(e, id, r) }}
            style={{
              position: 'absolute',
              left: `${r.x * 100}%`, top: `${r.y * 100}%`,
              width: `${r.w * 100}%`, height: `${r.h * 100}%`,
              // Undersized outranks off-ratio: a card too small to render its widget at all is a
              // harder problem than one rendered at an unflattering aspect.
              border: selected ? '2px solid var(--ink)'
                : undersized ? '2px solid var(--critical)'
                  : offRatio ? '1px dotted var(--warn)' : '1px dashed var(--line-strong)',
              background: overlappingIds.has(id) ? 'rgba(204,0,0,0.12)'
                : undersized ? 'rgba(204,102,0,0.14)' : 'transparent',
              boxSizing: 'border-box', display: 'flex', flexDirection: 'column', alignItems: 'center',
              justifyContent: 'center', fontSize: 11, textAlign: 'center', padding: 4,
              cursor: 'grab', userSelect: 'none', touchAction: 'none',
            }}
          >
            <span>{labelFor(cell, id)}</span>
            {pendingIds?.has(id) && (
              <span style={{ display: 'block', fontWeight: 700 }}>Not saved yet</span>
            )}
            {selected && (['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as Handle[]).map((hd) => (
              <span
                key={hd}
                data-testid={`handle-${id}-${hd}`}
                onPointerDown={(e) => { e.stopPropagation(); begin(e, id, r, hd) }}
                style={{
                  position: 'absolute', width: 10, height: 10, background: 'var(--ink)',
                  left: hd.includes('w') ? -5 : hd.includes('e') ? undefined : 'calc(50% - 5px)',
                  right: hd.includes('e') ? -5 : undefined,
                  top: hd.startsWith('n') ? -5 : hd.startsWith('s') ? undefined : 'calc(50% - 5px)',
                  bottom: hd.startsWith('s') ? -5 : undefined,
                  cursor: `${hd}-resize`, touchAction: 'none',
                }}
              />
            ))}
          </div>
        )
      })}
    </div>
  )
}
