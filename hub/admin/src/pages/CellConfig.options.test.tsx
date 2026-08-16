import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

/**
 * This test checks the generated block independently of the real catalogue. `design-registry`'s
 * `designFor` is mocked to hand back a synthetic design with one option of each type,
 * standing in for a design the way the real catalogue provides one now. `clock` is picked as the
 * host widget because it already has real designs in `catalogue.mjs` (so
 * `designIdsFor('clock').length > 0` and the block's `designs.length === 0` guard doesn't
 * short-circuit it) and because it takes the non-DATA_WIDGETS return path — this doubles as
 * coverage that the block reaches a widget outside `DATA_WIDGETS`, not only the data widgets.
 *
 * `text_block` and `value_tile` (screen state) now have real `meta.options` declarations, exercised
 * against the actual catalogue in `CellConfig.valueTile.test.tsx` (and, for `text_block`'s
 * `align`, `widget-text.test.ts`/`bindings.test.tsx`'s feed-mode coverage) — this file's synthetic
 * design stays useful for the generic MECHANISM (every field type, the disclosure placement, a
 * non-DATA_WIDGETS host) independent of which real design happens to exist.
 */
vi.mock('../design-registry', () => ({
  designFor: () => ({
    meta: {
      id: 'fake', widget: 'clock', label: 'Fake',
      options: {
        show_seconds: { type: 'boolean', label: 'Show seconds', default: true },
        brightness: { type: 'number', label: 'Brightness', default: 50, min: 0, max: 100 },
        face: { type: 'select', label: 'Face style', default: 'round', choices: ['round', 'square'] },
        greeting: { type: 'text', label: 'Greeting', default: 'hi' },
        // An option that names a NESTED location. Three levels deep on purpose — no
        // shipped design goes past two, so the generic mechanism would otherwise only ever be
        // exercised at the depth the real ones happen to use.
        chime_volume: { type: 'number', label: 'Chime volume', default: 5, path: 'sound.chime.volume' },
        // A REPEATING GROUP. Synthetic on purpose, for the parts no shipped list reaches —
        // a `min` of 0 (both shipped ones floor at 1, so nothing else exercises "the last row can
        // go"), and boolean and number item fields, which neither `columns` nor `series` has.
        chimes: {
          type: 'list', label: 'entry', min: 0, max: 2,
          item: {
            title: { type: 'text', label: 'Title', required: true },
            count: { type: 'number', label: 'Count', default: 3, required: true },
            pinned: { type: 'boolean', label: 'Pinned' },
            tone: { type: 'select', label: 'Tone', default: 'soft', choices: ['soft', 'loud'] },
          },
        },
      },
    },
  }),
}))

import CellConfig from './CellConfig'
import type { Cell } from './Screens'

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.resetModules() })

const renderClock = (config: Record<string, unknown> = {}) => {
  const setCellConfig = vi.fn()
  const cell = { rect: { x: 0, y: 0, w: 1, h: 1 }, widget: 'clock', config } as unknown as Cell
  render(
    <CellConfig
      i={0} cell={cell} feeds={[]} previews={{}} ensurePreview={() => {}}
      setCellConfig={setCellConfig} replaceCellConfig={() => {}} onFeedsChanged={() => {}}
    />,
  )
  return { setCellConfig }
}

describe('CellConfig — generated option fields', () => {
  it('renders one control per declared option, labelled with meta.options label text — not the property name', () => {
    renderClock()
    expect(screen.getByLabelText('Cell 1 Show seconds')).toBeDefined()
    expect(screen.getByLabelText('Cell 1 Brightness')).toBeDefined()
    expect(screen.getByLabelText('Cell 1 Face style')).toBeDefined()
    expect(screen.getByLabelText('Cell 1 Greeting')).toBeDefined()
  })

  it('offers the select field\'s declared choices', () => {
    renderClock()
    const select = screen.getByLabelText('Cell 1 Face style') as HTMLSelectElement
    expect([...select.options].map((o) => o.value)).toEqual(['round', 'square'])
  })

  it('writes a boolean field through setCellConfig, the same setter every other field in this file uses', () => {
    const { setCellConfig } = renderClock({ show_seconds: true })
    fireEvent.click(screen.getByLabelText('Cell 1 Show seconds'))
    expect(setCellConfig).toHaveBeenCalledWith({ show_seconds: false })
  })

  it('writes a text field through setCellConfig', () => {
    const { setCellConfig } = renderClock({ greeting: 'hi' })
    fireEvent.change(screen.getByLabelText('Cell 1 Greeting'), { target: { value: 'hello' } })
    expect(setCellConfig).toHaveBeenCalledWith({ greeting: 'hello' })
  })

  it('writes a select field through setCellConfig', () => {
    const { setCellConfig } = renderClock({ face: 'round' })
    fireEvent.change(screen.getByLabelText('Cell 1 Face style'), { target: { value: 'square' } })
    expect(setCellConfig).toHaveBeenCalledWith({ face: 'square' })
  })

  it('writes a typed number field through setCellConfig', () => {
    const { setCellConfig } = renderClock({ brightness: 50 })
    fireEvent.change(screen.getByLabelText('Cell 1 Brightness'), { target: { value: '80' } })
    expect(setCellConfig).toHaveBeenCalledWith({ brightness: 80 })
  })

  /**
   * The generated number field writes `undefined` on an empty input, matching
   * `renderDecimals`/`renderScaleInput` and preserving the "unset" convention.
   */
  it('clearing a number field writes undefined, not 0', () => {
    const { setCellConfig } = renderClock({ brightness: 75 })
    fireEvent.change(screen.getByLabelText('Cell 1 Brightness'), { target: { value: '' } })
    expect(setCellConfig).toHaveBeenCalledWith({ brightness: undefined })
  })
})

/**
 * `path` as a MECHANISM, independent of which real design happens to declare one.
 * `CellConfig.gauge`/`.streamList`/`.alertFeed`/`.table` cover the shipped declarations; these
 * cover the parts no shipped design reaches: three levels of nesting, a parent that has to be
 * created from nothing, and a parent holding something the form knows nothing about.
 */
describe('CellConfig — a generated field that declares a nested path', () => {
  it('reads its value out of the nested location, not a flat key of the same name', () => {
    renderClock({ sound: { chime: { volume: 9 } }, chime_volume: 1 })
    expect((screen.getByLabelText('Cell 1 Chime volume') as HTMLInputElement).value).toBe('9')
  })

  it('falls back to the declared default when nothing sits at the path', () => {
    renderClock({ sound: { chime: {} } })
    expect((screen.getByLabelText('Cell 1 Chime volume') as HTMLInputElement).value).toBe('5')
  })

  it('does not mistake a partially-built parent for a value', () => {
    renderClock({ sound: {} })
    expect((screen.getByLabelText('Cell 1 Chime volume') as HTMLInputElement).value).toBe('5')
  })

  it('builds every missing level of the parent chain on the first write', () => {
    const { setCellConfig } = renderClock({})
    fireEvent.change(screen.getByLabelText('Cell 1 Chime volume'), { target: { value: '7' } })
    expect(setCellConfig).toHaveBeenCalledWith({ sound: { chime: { volume: 7 } } })
  })

  /**
   * The failure the whole design of this patch is aimed at. `setCellConfig` shallow-merges only
   * the TOP level, so every level below it has to be rebuilt from what is already stored — a
   * builder that sent `{ sound: { chime: { volume: 7 } } }` would drop `sound.enabled` and
   * `sound.chime.tone`, silently, on every single edit.
   */
  it('preserves siblings at every level of the path, not just the leaf\'s', () => {
    const { setCellConfig } = renderClock({
      sound: { enabled: true, chime: { tone: 'bell', volume: 3 } },
    })
    fireEvent.change(screen.getByLabelText('Cell 1 Chime volume'), { target: { value: '7' } })
    expect(setCellConfig).toHaveBeenCalledWith({
      sound: { enabled: true, chime: { tone: 'bell', volume: 7 } },
    })
  })

  it('patches only the path\'s own top-level key, never the whole config', () => {
    const { setCellConfig } = renderClock({ greeting: 'hi', sound: { chime: { volume: 3 } } })
    fireEvent.change(screen.getByLabelText('Cell 1 Chime volume'), { target: { value: '7' } })
    expect(Object.keys(setCellConfig.mock.calls[0][0])).toEqual(['sound'])
  })

  // Clearing follows the same "empty means unset, not zero" convention the flat number field uses,
  // and must still carry the siblings.
  it('clearing a nested number unsets it and leaves its siblings in place', () => {
    const { setCellConfig } = renderClock({ sound: { enabled: true, chime: { tone: 'bell', volume: 3 } } })
    fireEvent.change(screen.getByLabelText('Cell 1 Chime volume'), { target: { value: '' } })
    expect(setCellConfig).toHaveBeenCalledWith({
      sound: { enabled: true, chime: { tone: 'bell', volume: undefined } },
    })
  })

  // A pathless option in the SAME form is the "absent ⇒ exactly today's behaviour" half of the
  // contract, asserted next to the nested one rather than in a separate world.
  it('leaves the pathless options writing flat top-level keys', () => {
    const { setCellConfig } = renderClock({ sound: { chime: { volume: 3 } }, greeting: 'hi' })
    fireEvent.change(screen.getByLabelText('Cell 1 Greeting'), { target: { value: 'hello' } })
    expect(setCellConfig).toHaveBeenCalledWith({ greeting: 'hello' })
  })

  /**
   * A scalar or an array where the path expects an object is a config the widget's own save schema
   * would reject anyway. Starting clean beats spreading it: `{ ...'nonsense' }` would produce
   * `{ 0: 'n', 1: 'o', … }`, a stranger shape than the one being replaced.
   */
  it('starts a fresh parent when the stored one is not a plain object', () => {
    const { setCellConfig } = renderClock({ sound: 'loud' })
    fireEvent.change(screen.getByLabelText('Cell 1 Chime volume'), { target: { value: '7' } })
    expect(setCellConfig).toHaveBeenCalledWith({ sound: { chime: { volume: 7 } } })
  })
})

/**
 * Mounting the generated block in the always-visible `pickers` fragment
 * broke this file's disclosure convention (every other per-widget config block sits behind a
 * collapsed `<details>`). It now renders inside its own `<details><summary>Design options</summary>`,
 * same shape as the "Widget options"/"Advanced" blocks elsewhere in this file.
 */
describe('CellConfig — generated block placement', () => {
  it('sits behind a details/summary disclosure like every other config block in this file', () => {
    renderClock()
    const summary = screen.getByText('Design options')
    expect(summary.closest('details')).not.toBeNull()
    expect(summary.closest('details')?.contains(screen.getByLabelText('Cell 1 Show seconds'))).toBe(true)
  })
})

/**
 * `list` as a MECHANISM, independent of which real design happens to declare one.
 * `CellConfig.table`/`.chart` cover the two shipped declarations against the real catalogue; these
 * cover what neither of them reaches: a `min` of 0 (both shipped lists floor at 1, so nothing else
 * exercises removing the last row), and boolean and number item fields.
 */
describe('CellConfig — a generated field that declares a repeating group', () => {
  const rows = (config: Record<string, unknown>[]) => ({ chimes: config })

  it('draws every item field of every row, labelled by the list entry and its position', () => {
    renderClock(rows([{ title: 'Wake', count: 1 }, { title: 'Sleep', count: 2 }]))
    for (const row of [1, 2]) {
      for (const item of ['Title', 'Count', 'Pinned', 'Tone']) {
        expect(screen.getAllByLabelText(`Cell 1 entry ${row} ${item}`), `${row} ${item}`).toHaveLength(1)
      }
    }
    expect(screen.queryByLabelText('Cell 1 entry 3 Title')).toBeNull()
  })

  it('draws no rows and only an Add for a list nothing is stored for', () => {
    renderClock()
    expect(screen.queryByLabelText('Cell 1 entry 1 Title')).toBeNull()
    expect(screen.getByRole('button', { name: 'Add entry' })).toBeDefined()
  })

  it('seeds an added row with the required keys only, defaults included', () => {
    const { setCellConfig } = renderClock()
    fireEvent.click(screen.getByRole('button', { name: 'Add entry' }))
    // `pinned` and `tone` are optional: an absent optional key is what the renderer's own fallback
    // means, and a placebo would be indistinguishable from an operator choosing it.
    expect(setCellConfig).toHaveBeenCalledWith({ chimes: [{ title: '', count: 3 }] })
  })

  it('honours a min of 0 — the last row CAN be removed, unlike a list that floors at 1', () => {
    const { setCellConfig } = renderClock(rows([{ title: 'Wake', count: 1 }]))
    fireEvent.click(screen.getByRole('button', { name: 'Remove entry' }))
    expect(setCellConfig).toHaveBeenCalledWith({ chimes: [] })
  })

  it('offers no Add at max', () => {
    renderClock(rows([{ title: 'a', count: 1 }, { title: 'b', count: 2 }]))
    expect(screen.queryByRole('button', { name: 'Add entry' })).toBeNull()
  })

  it('writes a boolean item field into its own row', () => {
    const { setCellConfig } = renderClock(rows([{ title: 'Wake', count: 1 }]))
    fireEvent.click(screen.getByLabelText('Cell 1 entry 1 Pinned'))
    expect(setCellConfig).toHaveBeenCalledWith({ chimes: [{ title: 'Wake', count: 1, pinned: true }] })
  })

  it('writes a number item field as a number, not a string', () => {
    const { setCellConfig } = renderClock(rows([{ title: 'Wake', count: 1 }]))
    fireEvent.change(screen.getByLabelText('Cell 1 entry 1 Count'), { target: { value: '9' } })
    expect(setCellConfig).toHaveBeenCalledWith({ chimes: [{ title: 'Wake', count: 9 }] })
  })

  /**
   * The two halves of "an emptied field", which differ by whether the save schema requires the key.
   * A required one cannot be deleted at all, so it falls back to what a fresh row would have started
   * it as; an optional one is deleted, because that is the only way to say "unset" to an
   * `additionalProperties: false` object.
   */
  it('clearing a REQUIRED number falls back to its seed rather than deleting the key', () => {
    const { setCellConfig } = renderClock(rows([{ title: 'Wake', count: 1 }]))
    fireEvent.change(screen.getByLabelText('Cell 1 entry 1 Count'), { target: { value: '' } })
    expect(setCellConfig).toHaveBeenCalledWith({ chimes: [{ title: 'Wake', count: 3 }] })
  })

  it('an unset optional select shows its declared default without writing it', () => {
    const { setCellConfig } = renderClock(rows([{ title: 'Wake', count: 1 }]))
    expect((screen.getByLabelText('Cell 1 entry 1 Tone') as HTMLSelectElement).value).toBe('soft')
    expect(setCellConfig).not.toHaveBeenCalled()
  })

  it('edits the row it was given and leaves every other row identical', () => {
    const { setCellConfig } = renderClock(rows([{ title: 'a', count: 1 }, { title: 'b', count: 2, pinned: true }]))
    fireEvent.change(screen.getByLabelText('Cell 1 entry 1 Title'), { target: { value: 'c' } })
    expect(setCellConfig).toHaveBeenCalledWith({
      chimes: [{ title: 'c', count: 1 }, { title: 'b', count: 2, pinned: true }],
    })
  })

  it('patches only the list\'s own key, never the scalar options beside it', () => {
    const { setCellConfig } = renderClock({ greeting: 'hi', ...rows([{ title: 'a', count: 1 }]) })
    fireEvent.change(screen.getByLabelText('Cell 1 entry 1 Title'), { target: { value: 'b' } })
    expect(Object.keys(setCellConfig.mock.calls[0][0])).toEqual(['chimes'])
  })

  it('ignores a stored value that is not an array rather than crashing the form', () => {
    renderClock({ chimes: 'not an array' })
    expect(screen.queryByLabelText('Cell 1 entry 1 Title')).toBeNull()
    expect(screen.getByRole('button', { name: 'Add entry' })).toBeDefined()
  })
})
