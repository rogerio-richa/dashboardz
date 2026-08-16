import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import CellConfig from './CellConfig'
import type { Cell, FeedRow } from './Screens'
// @ts-expect-error plain JS module without types
import { streamListConfig } from '../../../static/device/layout-core.mjs'

afterEach(cleanup)

/**
 * `stream_list`'s knobs, against its REAL design (`static/device/widgets/stream/list.mjs`) — not a
 * mocked `../design-registry`, for the same reason `CellConfig.gauge.test.tsx` gives: the point is
 * what the shipped declaration does to the editor.
 *
 * Three of them (`clamp.title_lines`, `clamp.body_lines`, `overflow.counter`) had NO admin control
 * at all until nested options were available — not a hand-built one, not a generated one. They nest, and a generated
 * field could only write a flat top-level key, so the schema accepted them, the renderer read them,
 * and nothing anywhere could set them. `path` closed that, and this file is what keeps them
 * reachable.
 *
 * Every assertion here defends one of two things:
 *
 *  1. **The written shape is the shape the save schema accepts.** `hub/src/routes/admin.ts`'s
 *     `stream_list` branch is `additionalProperties: false` with `clamp` and `overflow` as objects
 *     of their own. A control that wrote `title_lines` at the top level would look right in the
 *     editor and 400 the whole grid PATCH — losing every unsaved edit on the screen, not just this
 *     cell's.
 *  2. **A nested write keeps its siblings.** `setCellConfig` shallow-merges, so writing
 *     `clamp.body_lines` has to send the whole `clamp` object with `title_lines` still in it.
 *     `clamp` is the one parent on this contract with two knobs under it, which makes this the
 *     place that failure actually shows up.
 */
const FEEDS: FeedRow[] = [{ id: 'feed_s', name: 'a stream feed', mode: 'stream' }] as unknown as FeedRow[]

const renderStream = (config: Record<string, unknown> = { feed: 'feed_s' }) => {
  const setCellConfig = vi.fn()
  render(
    <CellConfig
      i={0} cell={{ rect: { x: 0, y: 0, w: 1, h: 1 }, widget: 'stream_list', config } as unknown as Cell}
      feeds={FEEDS} previews={{}} ensurePreview={() => {}}
      setCellConfig={setCellConfig} replaceCellConfig={() => {}} onFeedsChanged={() => {}}
    />,
  )
  return { setCellConfig }
}

describe('stream_list config: one control per knob, and a control at all', () => {
  it('renders exactly one control for each of the five declared options', () => {
    renderStream()
    for (const label of ['Title path', 'Body path', 'Title lines', 'Body lines', 'Overflow counter']) {
      expect(screen.getAllByLabelText(`Cell 1 ${label}`), label).toHaveLength(1)
    }
  })
})

describe('stream_list config: an unset knob renders as what the renderer will draw', () => {
  // Asserted against `streamListConfig` rather than hardcoded numbers, so a flipped renderer
  // default fails here instead of the editor quietly telling an operator the wrong thing.
  it('shows streamListConfig\'s own defaults when nothing is stored', () => {
    const drawn = streamListConfig({ feed: 'feed_s' })
    expect(drawn.titleLines).toBe(1)
    expect(drawn.bodyLines).toBe(2)
    expect(drawn.counter).toBe(true)
    renderStream()
    expect((screen.getByLabelText('Cell 1 Title lines') as HTMLInputElement).value).toBe(String(drawn.titleLines))
    expect((screen.getByLabelText('Cell 1 Body lines') as HTMLInputElement).value).toBe(String(drawn.bodyLines))
    expect((screen.getByLabelText('Cell 1 Overflow counter') as HTMLInputElement).checked).toBe(drawn.counter)
  })

  it('shows stored nested values, so a save cannot silently drop them', () => {
    renderStream({ feed: 'feed_s', clamp: { title_lines: 3, body_lines: 4 }, overflow: { counter: false } })
    expect((screen.getByLabelText('Cell 1 Title lines') as HTMLInputElement).value).toBe('3')
    expect((screen.getByLabelText('Cell 1 Body lines') as HTMLInputElement).value).toBe('4')
    expect((screen.getByLabelText('Cell 1 Overflow counter') as HTMLInputElement).checked).toBe(false)
  })

  // The bounds the generated field offers are the ones the save schema accepts (integer 1..10);
  // `hub/test/option-bounds.test.ts` pins the design against the route, this pins the route's
  // numbers actually reaching the DOM control an operator types into.
  it('bounds the line inputs at the schema\'s 1..10', () => {
    renderStream()
    const title = screen.getByLabelText('Cell 1 Title lines') as HTMLInputElement
    expect(title.min).toBe('1')
    expect(title.max).toBe('10')
  })
})

describe('stream_list config: nested writes keep their siblings', () => {
  it('writes title_lines nested under clamp, not as a flat key', () => {
    const { setCellConfig } = renderStream()
    fireEvent.change(screen.getByLabelText('Cell 1 Title lines'), { target: { value: '3' } })
    expect(setCellConfig).toHaveBeenCalledWith({ clamp: { title_lines: 3 } })
  })

  it('writes overflow.counter nested under overflow, not as a flat key', () => {
    const { setCellConfig } = renderStream()
    fireEvent.click(screen.getByLabelText('Cell 1 Overflow counter'))
    expect(setCellConfig).toHaveBeenCalledWith({ overflow: { counter: false } })
  })

  it('setting body_lines preserves a title_lines already stored beside it', () => {
    const { setCellConfig } = renderStream({ feed: 'feed_s', clamp: { title_lines: 3 } })
    fireEvent.change(screen.getByLabelText('Cell 1 Body lines'), { target: { value: '4' } })
    expect(setCellConfig).toHaveBeenCalledWith({ clamp: { title_lines: 3, body_lines: 4 } })
  })

  it('setting title_lines preserves a body_lines already stored beside it', () => {
    const { setCellConfig } = renderStream({ feed: 'feed_s', clamp: { body_lines: 4 } })
    fireEvent.change(screen.getByLabelText('Cell 1 Title lines'), { target: { value: '3' } })
    expect(setCellConfig).toHaveBeenCalledWith({ clamp: { body_lines: 4, title_lines: 3 } })
  })

  /**
   * Both knobs under one parent, set in sequence against the config each write produces — the case
   * a builder that merges only its own leaf still passes the single-write tests for.
   */
  it('lets both clamp knobs be set one after the other without clobbering', () => {
    const first = renderStream({ feed: 'feed_s' })
    fireEvent.change(screen.getByLabelText('Cell 1 Title lines'), { target: { value: '3' } })
    const afterTitle = first.setCellConfig.mock.calls[0][0] as Record<string, unknown>
    expect(afterTitle).toEqual({ clamp: { title_lines: 3 } })

    cleanup()
    const second = renderStream({ feed: 'feed_s', ...afterTitle })
    fireEvent.change(screen.getByLabelText('Cell 1 Body lines'), { target: { value: '4' } })
    expect(second.setCellConfig).toHaveBeenCalledWith({ clamp: { title_lines: 3, body_lines: 4 } })
  })

  // Two DIFFERENT parents, so a builder that merged everything into one object would fail here.
  it('a clamp write never touches overflow, and the reverse', () => {
    const { setCellConfig } = renderStream({
      feed: 'feed_s', clamp: { title_lines: 3 }, overflow: { counter: false },
    })
    fireEvent.change(screen.getByLabelText('Cell 1 Body lines'), { target: { value: '4' } })
    expect(setCellConfig).toHaveBeenCalledWith({ clamp: { title_lines: 3, body_lines: 4 } })
    expect(Object.keys(setCellConfig.mock.calls[0][0])).toEqual(['clamp'])
  })

  // The flat options in the same design must be untouched by the nested ones sharing the form.
  it('still writes a pathless option as a flat top-level key', () => {
    const { setCellConfig } = renderStream({ feed: 'feed_s', clamp: { title_lines: 3 } })
    fireEvent.change(screen.getByLabelText('Cell 1 Title path'), { target: { value: 'subject' } })
    expect(setCellConfig).toHaveBeenCalledWith({ title_path: 'subject' })
  })
})
