import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import CellConfig from './CellConfig'
import type { Cell } from './Screens'
// @ts-expect-error plain JS module without types
import { feedConfig } from '../../../static/device/layout-core.mjs'

afterEach(cleanup)

/**
 * `alert_feed`'s knobs, against its REAL design (`static/device/widgets/alert/feed.mjs`).
 *
 * This widget takes CellConfig's non-`DATA_WIDGETS` path — it binds no feed at all (alerts arrive
 * on `ctx.alerts`, not through `config.feed`), so the generated block is the ONLY config UI it
 * gets, which makes "the knob has a control at all" a real question here rather than a formality.
 * `clamp.title_lines`, `clamp.body_lines` and `overflow.counter` had none until nested options gave
 * `meta.options` a dotted `path`.
 *
 * `min_severity` is the one that was drawn TWICE: `alert/feed.mjs` has declared it since tab state,
 * and `Screens.tsx` also hand-built a `min severity` select right above this component — the same
 * generated-plus-hand-built pair that shipped `image`'s `fit` twice. The hand-built one is deleted;
 * the count assertion below is what keeps it deleted.
 *
 * `sound_info` is the deliberate opposite and must stay hand-built in `Screens.tsx`: the Android
 * app (`Chime.kt`) reads it, no design ever does, and declaring it would let the generated form
 * write a key whose meaning lives outside the renderer entirely.
 */
const renderFeed = (config: Record<string, unknown> = { min_severity: 'info' }) => {
  const setCellConfig = vi.fn()
  render(
    <CellConfig
      i={0} cell={{ rect: { x: 0, y: 0, w: 1, h: 1 }, widget: 'alert_feed', config } as unknown as Cell}
      feeds={[]} previews={{}} ensurePreview={() => {}}
      setCellConfig={setCellConfig} replaceCellConfig={() => {}} onFeedsChanged={() => {}}
    />,
  )
  return { setCellConfig }
}

describe('alert_feed config: one control per knob, and a control at all', () => {
  it('renders exactly one control for each of the four declared options', () => {
    renderFeed()
    for (const label of ['Minimum severity', 'Title lines', 'Body lines', 'Overflow counter']) {
      expect(screen.getAllByLabelText(`Cell 1 ${label}`), label).toHaveLength(1)
    }
  })

  it('never generates a control for sound_info — the Android app reads it, no design does', () => {
    renderFeed()
    expect(screen.queryByLabelText(/sound.?info/i)).toBeNull()
  })
})

describe('alert_feed config: an unset knob renders as what the renderer will draw', () => {
  it('shows feedConfig\'s own defaults when nothing is stored', () => {
    const drawn = feedConfig({})
    expect(drawn.titleLines).toBe(1)
    expect(drawn.bodyLines).toBe(2)
    expect(drawn.counter).toBe(true)
    renderFeed({})
    expect((screen.getByLabelText('Cell 1 Title lines') as HTMLInputElement).value).toBe(String(drawn.titleLines))
    expect((screen.getByLabelText('Cell 1 Body lines') as HTMLInputElement).value).toBe(String(drawn.bodyLines))
    expect((screen.getByLabelText('Cell 1 Overflow counter') as HTMLInputElement).checked).toBe(drawn.counter)
  })

  it('shows stored nested values, so a save cannot silently drop them', () => {
    renderFeed({ min_severity: 'warn', clamp: { title_lines: 2, body_lines: 5 }, overflow: { counter: false } })
    expect((screen.getByLabelText('Cell 1 Title lines') as HTMLInputElement).value).toBe('2')
    expect((screen.getByLabelText('Cell 1 Body lines') as HTMLInputElement).value).toBe('5')
    expect((screen.getByLabelText('Cell 1 Overflow counter') as HTMLInputElement).checked).toBe(false)
  })
})

describe('alert_feed config: nested writes keep their siblings', () => {
  it('writes the clamp knobs nested under clamp, in the shape the save schema accepts', () => {
    const { setCellConfig } = renderFeed()
    fireEvent.change(screen.getByLabelText('Cell 1 Title lines'), { target: { value: '2' } })
    expect(setCellConfig).toHaveBeenCalledWith({ clamp: { title_lines: 2 } })
  })

  it('setting body_lines preserves a title_lines already stored beside it', () => {
    const { setCellConfig } = renderFeed({ min_severity: 'info', clamp: { title_lines: 2 } })
    fireEvent.change(screen.getByLabelText('Cell 1 Body lines'), { target: { value: '5' } })
    expect(setCellConfig).toHaveBeenCalledWith({ clamp: { title_lines: 2, body_lines: 5 } })
  })

  it('writes overflow.counter nested under overflow, leaving clamp alone', () => {
    const { setCellConfig } = renderFeed({ min_severity: 'info', clamp: { title_lines: 2, body_lines: 5 } })
    fireEvent.click(screen.getByLabelText('Cell 1 Overflow counter'))
    expect(setCellConfig).toHaveBeenCalledWith({ overflow: { counter: false } })
    expect(Object.keys(setCellConfig.mock.calls[0][0])).toEqual(['overflow'])
  })

  // The pathless option in the same design keeps writing a flat top-level key — exactly what it
  // wrote before `path` existed, which is what "absent path ⇒ today's behaviour" has to mean.
  it('still writes min_severity as a flat top-level key', () => {
    const { setCellConfig } = renderFeed({ min_severity: 'info', clamp: { title_lines: 2 } })
    fireEvent.change(screen.getByLabelText('Cell 1 Minimum severity'), { target: { value: 'critical' } })
    expect(setCellConfig).toHaveBeenCalledWith({ min_severity: 'critical' })
  })
})
