import { afterEach, describe, it, expect, vi } from 'vitest'
import { cleanup, render, screen, fireEvent } from '@testing-library/react'
import LayoutCanvas from './LayoutCanvas'
import type { EditorCell } from '../layout-edit'

const items: EditorCell[] = [
  { id: 'a', cell: { rect: { x: 0, y: 0, w: 0.5, h: 1 }, widget: 'clock', config: {} } },
  { id: 'b', cell: { rect: { x: 0.5, y: 0, w: 0.5, h: 1 }, widget: 'chart', config: {} } },
]
const base = {
  items, aspect: { w: 16, h: 10 }, selectedId: null,
  onSelect: () => {}, onRectChange: () => {},
  labelFor: (c: any) => c.widget, overlappingIds: new Set<string>(),
}

// Every other test file in this directory (Screens/Feeds/Devices.test.tsx) unmounts explicitly
// for the same reason: vitest here has no `globals: true` / setup file, so @testing-library/react's
// automatic afterEach(cleanup) never registers and renders from prior tests stay in the DOM,
// breaking getByTestId with "multiple elements found" in later tests. Declared at file scope
// (not inside a single describe) so it covers every describe block below, including siblings.
afterEach(() => cleanup())

describe('LayoutCanvas', () => {
  it('marks an owned connection draft without changing the card label', () => {
    render(<LayoutCanvas {...base} pendingIds={new Set(['b'])} />)
    expect(screen.getByTestId('card-a').textContent).toBe('clock')
    expect(screen.getByTestId('card-b').textContent).toContain('chart')
    expect(screen.getByTestId('card-b').textContent).toContain('Not saved yet')
  })

  it('renders one positioned card per item, at its rect', () => {
    render(<LayoutCanvas {...base} />)
    const a = screen.getByTestId('card-a')
    expect(a.style.left).toBe('0%')
    expect(a.style.width).toBe('50%')
    expect(screen.getByTestId('card-b').style.left).toBe('50%')
  })

  it('draws the board at the target aspect ratio', () => {
    const { rerender } = render(<LayoutCanvas {...base} />)
    expect(screen.getByTestId('canvas-board').style.aspectRatio).toBe('16 / 10')
    rerender(<LayoutCanvas {...base} aspect={{ w: 9, h: 20 }} />)
    expect(screen.getByTestId('canvas-board').style.aspectRatio).toBe('9 / 20')
  })

  it('reports selection when a card is clicked', () => {
    const onSelect = vi.fn()
    render(<LayoutCanvas {...base} onSelect={onSelect} />)
    fireEvent.pointerDown(screen.getByTestId('card-b'))
    expect(onSelect).toHaveBeenCalledWith('b')
  })

  it('clears selection when the empty board is clicked', () => {
    const onSelect = vi.fn()
    render(<LayoutCanvas {...base} selectedId="a" onSelect={onSelect} />)
    fireEvent.pointerDown(screen.getByTestId('canvas-board'))
    expect(onSelect).toHaveBeenCalledWith(null)
  })

  it('marks overlapping cards so the operator can see which pair is wrong', () => {
    render(<LayoutCanvas {...base} overlappingIds={new Set(['a', 'b'])} />)
    expect(screen.getByTestId('card-a').dataset.overlap).toBe('true')
    expect(screen.getByTestId('card-b').dataset.overlap).toBe('true')
  })

  it('renders a corrupt rect instead of crashing', () => {
    const bad: EditorCell[] = [{ id: 'z', cell: { rect: null as any, widget: 'clock', config: {} } }]
    render(<LayoutCanvas {...base} items={bad} />)
    expect(screen.getByTestId('card-z')).toBeDefined()
  })
})

// jsdom has no layout engine: getBoundingClientRect returns zeros and setPointerCapture does not
// exist. Stub both so the component's ONE measurement is deterministic; the geometry itself is
// covered by layout-edit.test.ts, so these tests check wiring only.
const stubGeometry = (el: HTMLElement, w = 400, h = 250) => {
  el.setPointerCapture = () => {}
  el.releasePointerCapture = () => {}
  vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({
    x: 0, y: 0, left: 0, top: 0, right: w, bottom: h, width: w, height: h, toJSON: () => ({}),
  } as DOMRect)
}

describe('LayoutCanvas dragging', () => {
  it('translates a card by the pointer delta as a fraction of the board', () => {
    const onRectChange = vi.fn()
    render(<LayoutCanvas {...base} selectedId="a" onRectChange={onRectChange} />)
    stubGeometry(screen.getByTestId('canvas-board'))
    const card = screen.getByTestId('card-a')
    fireEvent.pointerDown(card, { clientX: 100, clientY: 100, pointerId: 1 })
    fireEvent.pointerMove(window, { clientX: 140, clientY: 100, pointerId: 1 })
    fireEvent.pointerUp(window, { pointerId: 1 })
    // 40px of a 400px board is 0.1.
    expect(onRectChange).toHaveBeenCalledWith('a', expect.objectContaining({ x: 0.1, w: 0.5 }))
  })

  it('does nothing when the board measures zero (hidden tab)', () => {
    const onRectChange = vi.fn()
    render(<LayoutCanvas {...base} selectedId="a" onRectChange={onRectChange} />)
    const board = screen.getByTestId('canvas-board')
    board.setPointerCapture = () => {}
    vi.spyOn(board, 'getBoundingClientRect').mockReturnValue({ width: 0, height: 0, left: 0, top: 0 } as DOMRect)
    const card = screen.getByTestId('card-a')
    fireEvent.pointerDown(card, { clientX: 10, clientY: 10, pointerId: 1 })
    fireEvent.pointerMove(window, { clientX: 60, clientY: 10, pointerId: 1 })
    expect(onRectChange).not.toHaveBeenCalled()
  })

  it('ends the gesture cleanly when pointer capture is lost', () => {
    const onRectChange = vi.fn()
    render(<LayoutCanvas {...base} selectedId="a" onRectChange={onRectChange} />)
    stubGeometry(screen.getByTestId('canvas-board'))
    const card = screen.getByTestId('card-a')
    fireEvent.pointerDown(card, { clientX: 100, clientY: 100, pointerId: 1 })
    fireEvent.pointerCancel(window, { pointerId: 1 })
    onRectChange.mockClear()
    fireEvent.pointerMove(window, { clientX: 300, clientY: 100, pointerId: 1 })
    expect(onRectChange).not.toHaveBeenCalled()

    // lostpointercapture is the OTHER named terminator (a real capture loss — e.g. an OS-level
    // interruption — fires it without either pointerup or pointercancel), and until now this test
    // never fired it, so it had zero coverage despite the test being named for exactly this case.
    fireEvent.pointerDown(card, { clientX: 100, clientY: 100, pointerId: 1 })
    fireEvent.lostPointerCapture(window, { pointerId: 1 })
    onRectChange.mockClear()
    fireEvent.pointerMove(window, { clientX: 300, clientY: 100, pointerId: 1 })
    expect(onRectChange).not.toHaveBeenCalled()
  })

  it('nudges the selected card with the arrow keys', () => {
    const onRectChange = vi.fn()
    // Selecting 'b' (items[1]), not 'a' (items[0]): a bug that nudges items[0] unconditionally,
    // ignoring selectedId, would go unnoticed if the selected card were also the first one. b sits
    // flush against the right edge (x 0.5, w 0.5), so ArrowLeft is used — ArrowRight would clamp to
    // a no-op there and fail to distinguish a correct move from a wrong one.
    render(<LayoutCanvas {...base} selectedId="b" onRectChange={onRectChange} />)
    fireEvent.keyDown(screen.getByTestId('canvas-board'), { key: 'ArrowLeft' })
    expect(onRectChange).toHaveBeenCalledWith('b', expect.objectContaining({ x: 0.499, w: 0.5 }))
    onRectChange.mockClear()
    fireEvent.keyDown(screen.getByTestId('canvas-board'), { key: 'ArrowLeft', shiftKey: true })
    expect(onRectChange).toHaveBeenCalledWith('b', expect.objectContaining({ x: 0.49, w: 0.5 }))
  })

  it('ignores pointer events from a different pointer than the one that started the gesture', () => {
    const onRectChange = vi.fn()
    render(<LayoutCanvas {...base} selectedId="a" onRectChange={onRectChange} />)
    stubGeometry(screen.getByTestId('canvas-board'))
    const card = screen.getByTestId('card-a')
    fireEvent.pointerDown(card, { clientX: 100, clientY: 100, pointerId: 1 })
    // A second touch (or a stray pointer over another element) must not steer a drag it did not
    // start — a large delta on a foreign pointerId must produce no call at all.
    fireEvent.pointerMove(window, { clientX: 300, clientY: 100, pointerId: 2 })
    expect(onRectChange).not.toHaveBeenCalled()
    // The original pointer must still work, proving the handler isn't simply dead.
    fireEvent.pointerMove(window, { clientX: 140, clientY: 100, pointerId: 1 })
    expect(onRectChange).toHaveBeenCalledWith('a', expect.objectContaining({ x: 0.1 }))
  })
})

describe('LayoutCanvas resizing', () => {
  it('resizes from the SE handle without moving the origin', () => {
    const onRectChange = vi.fn()
    render(<LayoutCanvas {...base} selectedId="a" onRectChange={onRectChange} />)
    stubGeometry(screen.getByTestId('canvas-board'))
    fireEvent.pointerDown(screen.getByTestId('handle-a-se'), { clientX: 200, clientY: 250, pointerId: 1 })
    fireEvent.pointerMove(window, { clientX: 240, clientY: 250, pointerId: 1 })
    // x/y alone can't distinguish a correct lock conversion from a broken one — the SE handle
    // never touches the origin regardless of which ratio is used. w/h close that gap: dx = 40/400
    // = 0.1, so w = 0.5 + 0.1 = 0.6. Locked to clock's suggested ratio (2) adjusted for a 16:10
    // board: lock = 2 / (16/10) = 1.25, so h = w / lock = 0.6 / 1.25 = 0.48. A multiply instead of
    // a divide would give lock = 3.2 and h = 0.6 / 3.2 = 0.187 — clearly distinct, so this
    // assertion fails under that mutation instead of passing vacuously.
    expect(onRectChange).toHaveBeenCalledWith('a', expect.objectContaining({ x: 0, y: 0, w: 0.6, h: 0.48 }))
  })

  it('shows handles only on the selected card', () => {
    const { rerender } = render(<LayoutCanvas {...base} selectedId="a" />)
    expect(screen.getByTestId('handle-a-se')).toBeDefined()
    expect(screen.queryByTestId('handle-b-se')).toBeNull()
    rerender(<LayoutCanvas {...base} selectedId={null} />)
    expect(screen.queryByTestId('handle-a-se')).toBeNull()
  })

  it('marks a card whose rendered shape has drifted from its widget', () => {
    const squeezed: EditorCell[] = [
      { id: 'a', cell: { rect: { x: 0, y: 0, w: 0.1, h: 0.9 }, widget: 'clock', config: {} } },
    ]
    render(<LayoutCanvas {...base} items={squeezed} aspect={{ w: 9, h: 20 }} />)
    expect(screen.getByTestId('card-a').dataset.offRatio).toBe('true')
  })

  it('does not mark a card that matches its widget', () => {
    // h 0.32, not 0.2: a clock's suggested PIXEL ratio is 2, but on a 16:10 board the matching
    // FRACTION rect is w/h = 2 / (16/10) = 1.25, i.e. w 0.4 / h 0.32 — the exact figure documented
    // on ratioToRect in layout-edit.ts ("a 2:1 clock is w 0.4 / h 0.32 on 16:10, exact in both").
    // w 0.4 / h 0.2 (w/h = 2, the RAW pixel ratio, un-adjusted for the board) renders at ratio 3.2
    // — a 60% miss — and isOffRatio correctly flags it, which contradicts what this test claims to
    // check. Verified directly against isOffRatio before changing this fixture.
    const good: EditorCell[] = [
      { id: 'a', cell: { rect: { x: 0, y: 0, w: 0.4, h: 0.32 }, widget: 'clock', config: {} } },
    ]
    render(<LayoutCanvas {...base} items={good} aspect={{ w: 16, h: 10 }} />)
    expect(screen.getByTestId('card-a').dataset.offRatio).toBe('false')
  })
})

// jsdom has no real DataTransfer (no drag image, no OS-level drag session), so a genuine
// drag-and-drop gesture cannot be fired end to end here — only the dragover/drop event handlers'
// own logic, driven by a plain object standing in for dataTransfer. That gap is real and is not
// papered over with a fake full-gesture test.
describe('LayoutCanvas drop handling', () => {
  it('does not call onDropWidget when the drop carries no text/dbz-widget payload', () => {
    const onDropWidget = vi.fn()
    render(<LayoutCanvas {...base} onDropWidget={onDropWidget} />)
    fireEvent.drop(screen.getByTestId('canvas-board'), { dataTransfer: { getData: () => '', types: [] } })
    expect(onDropWidget).not.toHaveBeenCalled()
  })

  it('swallows a payload-less drop instead of letting the browser navigate on it', () => {
    // fireEvent's return value is dispatchEvent's: false iff a handler called preventDefault() on
    // a cancelable event. A drop that isn't ours must still be cancelled, or the browser performs
    // its default action for whatever was actually dropped (e.g. navigating to a dropped file/URL).
    render(<LayoutCanvas {...base} onDropWidget={vi.fn()} />)
    const notCancelled = fireEvent.drop(screen.getByTestId('canvas-board'), { dataTransfer: { getData: () => '', types: [] } })
    expect(notCancelled).toBe(false)
  })

  it('does not advertise itself as a drop target for a foreign drag (e.g. a dropped file)', () => {
    render(<LayoutCanvas {...base} onDropWidget={vi.fn()} />)
    const notCancelled = fireEvent.dragOver(screen.getByTestId('canvas-board'), { dataTransfer: { types: ['Files'] } })
    expect(notCancelled).toBe(true)
  })

  it('advertises itself as a drop target for our own widget drag', () => {
    render(<LayoutCanvas {...base} onDropWidget={vi.fn()} />)
    const notCancelled = fireEvent.dragOver(screen.getByTestId('canvas-board'), { dataTransfer: { types: ['text/dbz-widget'] } })
    expect(notCancelled).toBe(false)
  })
})
