import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
// @ts-expect-error plain JS module without types
import { CATALOGUE } from '../../../static/device/widgets/catalogue.mjs'
// @ts-expect-error plain JS module without types
import { paintWidgets, stopAllWidgets } from '../../../static/device/widgets/index.mjs'
// @ts-expect-error plain JS module without types
import { lookup } from '../../../static/device/widgets/registry.mjs'
// @ts-expect-error plain JS module without types
import { WIDGET_DEFINITIONS } from '../../../static/device/widgets/definitions.mjs'
// @ts-expect-error plain JS module without types
import { feedModesFor } from '../../../static/device/widgets/bindings.mjs'
// @ts-expect-error plain JS module without types
import { BUILTIN_BOARD } from '../../../static/device/theme.mjs'
import WidgetPreview from './WidgetPreview'

type RecordingContext = CanvasRenderingContext2D & {
  fillText: ReturnType<typeof vi.fn>
  setTransform: ReturnType<typeof vi.fn>
  clearRect: ReturnType<typeof vi.fn>
}

const contexts = new WeakMap<HTMLCanvasElement, RecordingContext>()

/**
 * One shipped design, typed well enough that `vi.spyOn(design, 'draw')` infers its own signature.
 *
 * The three call sites below each cast `draw` to `unknown` and then spied through `as never`, which
 * `vitest run` never notices (it does not typecheck) but `npm run build`'s `tsc -b` does — it was
 * failing on both of the existing two before this file grew a third. Declaring the callable shape
 * once removes the casts and the failure together.
 */
/** A widget's own declared sample, the same one the gallery renders it with. */
const sampleDataFor = (widget: string): unknown => (
  (WIDGET_DEFINITIONS as { id: string; sample_data?: unknown }[]).find((d) => d.id === widget)?.sample_data ?? null
)

const designNamed = (widget: string) => {
  const design = (CATALOGUE as {
    meta: { widget: string }
    draw: (g: unknown, ctx: Record<string, unknown>, elapsed: number) => void
  }[]).find((candidate) => candidate.meta.widget === widget)
  if (!design) throw new Error(`no design registered for ${widget}`)
  return design
}

interface FakeImage {
  onload: (() => void) | null
  onerror: (() => void) | null
  src: string
}

function fakeImages(): FakeImage[] {
  const made: FakeImage[] = []
  class ImageDouble {
    onload: (() => void) | null = null
    onerror: (() => void) | null = null
    private value = ''

    set src(value: string) {
      this.value = value
      made.push(this)
    }

    get src() { return this.value }
  }
  vi.stubGlobal('Image', ImageDouble)
  return made
}

function recordingContext(): RecordingContext {
  return {
    arc: vi.fn(),
    beginPath: vi.fn(),
    clearRect: vi.fn(),
    closePath: vi.fn(),
    drawImage: vi.fn(),
    fill: vi.fn(),
    fillRect: vi.fn(),
    fillText: vi.fn(),
    lineTo: vi.fn(),
    measureText: vi.fn((text: string) => ({ width: Array.from(String(text)).length * 6 })),
    moveTo: vi.fn(),
    rect: vi.fn(),
    restore: vi.fn(),
    rotate: vi.fn(),
    save: vi.fn(),
    scale: vi.fn(),
    setTransform: vi.fn(),
    stroke: vi.fn(),
    translate: vi.fn(),
  } as unknown as RecordingContext
}

function contextFor(canvas: HTMLCanvasElement): RecordingContext {
  const context = contexts.get(canvas)
  if (!context) throw new Error('canvas was not prepared')
  return context
}

function setDpr(value: number) {
  Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value })
}

beforeEach(() => {
  setDpr(1)
  const getContext = function (this: HTMLCanvasElement) {
    const context = recordingContext()
    contexts.set(this, context)
    return context
  }
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
    getContext as unknown as typeof HTMLCanvasElement.prototype.getContext,
  )
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('WidgetPreview canvas rendering', () => {
  it('sizes phone and e-paper surfaces from the explicit CSS box and current DPR', () => {
    setDpr(1.875)
    const { rerender } = render(
      <WidgetPreview widget="clock" config={{}} data={null} width={384} height={853} />,
    )

    const canvas = screen.getByLabelText('Clock preview') as HTMLCanvasElement
    const frame = canvas.parentElement as HTMLElement
    expect(frame.className).toBe('widget-preview-frame')
    expect(frame.style.width).toBe('100%')
    expect(frame.style.maxWidth).toBe('384px')
    expect(frame.style.aspectRatio).toBe('384 / 853')
    expect(canvas.style.width).toBe('100%')
    expect(canvas.style.height).toBe('100%')
    expect(canvas.width).toBe(720)
    expect(canvas.height).toBe(1599)
    expect(contextFor(canvas).setTransform).toHaveBeenLastCalledWith(1.875, 0, 0, 1.875, 0, 0)
    expect(contextFor(canvas).clearRect).toHaveBeenLastCalledWith(0, 0, 384, 853)

    setDpr(1)
    act(() => window.dispatchEvent(new Event('resize')))
    rerender(<WidgetPreview widget="clock" config={{}} data={null} width={800} height={480} />)

    expect(frame.style.width).toBe('100%')
    expect(frame.style.maxWidth).toBe('800px')
    expect(frame.style.aspectRatio).toBe('800 / 480')
    expect(canvas.style.width).toBe('100%')
    expect(canvas.style.height).toBe('100%')
    expect(canvas.width).toBe(800)
    expect(canvas.height).toBe(480)
    expect(contextFor(canvas).setTransform).toHaveBeenLastCalledWith(1, 0, 0, 1, 0, 0)
  })

  it('repaints an unchanged surface for DPR-only resize and resolution changes, then cleans up', () => {
    const resolutionListeners: EventListener[] = []
    const removedResolutionListeners: EventListener[] = []
    vi.stubGlobal('matchMedia', vi.fn((query: string) => ({
      matches: true,
      media: query,
      onchange: null,
      addEventListener: (type: string, listener: EventListener) => {
        if (type === 'change') resolutionListeners.push(listener)
      },
      removeEventListener: (type: string, listener: EventListener) => {
        if (type === 'change') removedResolutionListeners.push(listener)
      },
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })))
    const addWindowListener = vi.spyOn(window, 'addEventListener')
    const removeWindowListener = vi.spyOn(window, 'removeEventListener')
    const config = {}
    const { unmount } = render(
      <WidgetPreview widget="clock" config={config} data={null} width={200} height={100} />,
    )
    const canvas = screen.getByLabelText('Clock preview') as HTMLCanvasElement
    expect(canvas.width).toBe(200)
    expect(resolutionListeners).toHaveLength(1)

    setDpr(2)
    act(() => resolutionListeners[0](new Event('change')))
    expect(canvas.width).toBe(400)
    expect(canvas.height).toBe(200)
    expect(contextFor(canvas).setTransform).toHaveBeenLastCalledWith(2, 0, 0, 2, 0, 0)

    setDpr(1.5)
    act(() => window.dispatchEvent(new Event('resize')))
    expect(canvas.width).toBe(300)
    expect(canvas.height).toBe(150)
    expect(contextFor(canvas).setTransform).toHaveBeenLastCalledWith(1.5, 0, 0, 1.5, 0, 0)

    const resizeListeners = addWindowListener.mock.calls
      .filter(([type]) => type === 'resize')
      .map(([, listener]) => listener)
    unmount()

    expect(resizeListeners.length).toBeGreaterThan(0)
    for (const listener of resizeListeners) {
      expect(removeWindowListener).toHaveBeenCalledWith('resize', listener)
    }
    expect(removedResolutionListeners).toEqual(expect.arrayContaining(resolutionListeners))
  })

  it('draws the requested registered design with the caller\'s exact config and data', () => {
    const data = [
      { id: 'second', title: 'Second result', published_at: 20 },
      { id: 'first', title: 'First result', published_at: 10 },
    ]
    render(
      <WidgetPreview
        widget="news_list"
        design="list"
        config={{ items: 1, show_summary: false, show_source: false, show_time: false }}
        data={data}
        width={180}
        height={240}
      />,
    )

    const canvas = screen.getByLabelText('News list preview') as HTMLCanvasElement
    const painted = contextFor(canvas).fillText.mock.calls.map(([text]) => text)
    expect(painted).toContain('Second result')
    expect(painted).not.toContain('First result')
  })

  it('previews a stream-bound design with rows drawn from array-shaped data, not the missing-feed notice', () => {
    // `stream_list` reads `ctx.rows` (widget contract stream data channel), so the preview passes
    // the same array of row payloads that `WidgetGallery`/`Widgets` read from `sample_data`.
    render(
      <WidgetPreview
        widget="stream_list"
        design="list"
        config={{ title_path: 'title' }}
        data={[{ title: 'First item' }, { title: 'Second item' }]}
        width={210}
        height={140}
      />,
    )

    const canvas = screen.getByLabelText('Stream list preview') as HTMLCanvasElement
    const painted = contextFor(canvas).fillText.mock.calls.map(([text]) => text)
    expect(painted).toContain('First item')
    expect(painted).not.toContain('Feed missing')
  })

  it('renders the real unavailable state when explicit semantic data is unavailable', () => {
    render(
      <WidgetPreview
        widget="weather_forecast"
        config={{ days: 5 }}
        data={undefined}
        width={300}
        height={169}
      />,
    )

    const canvas = screen.getByLabelText('Five-day forecast preview') as HTMLCanvasElement
    const painted = contextFor(canvas).fillText.mock.calls.map(([text]) => text)
    expect(painted).toContain('Forecast unavailable')
    expect(painted).not.toContain('São Paulo')
  })
})

describe('WidgetPreview declared assets', () => {
  it('requests a declared bare asset from the admin-safe device URL', () => {
    const made = fakeImages()
    render(<WidgetPreview widget="clock" design="nixie" config={{}} data={null} width={240} height={120} />)

    expect(made).toHaveLength(1)
    expect(made[0].src).toBe('/device/widgets/clock/assets/nixie-glyphs.png')
  })

  it('redraws the actual design with the decoded image', async () => {
    const made = fakeImages()
    render(<WidgetPreview widget="clock" design="nixie" config={{}} data={null} width={240} height={120} />)
    const canvas = screen.getByLabelText('Clock preview') as HTMLCanvasElement
    expect(contextFor(canvas).drawImage).not.toHaveBeenCalled()
    expect(made).toHaveLength(1)

    await act(async () => made[0].onload?.())

    expect(contextFor(canvas).drawImage).toHaveBeenCalled()
  })

  it('does not hand a late asset to a different design', async () => {
    const made = fakeImages()
    const { rerender } = render(
      <WidgetPreview widget="clock" design="nixie" config={{}} data={null} width={240} height={120} />,
    )
    rerender(<WidgetPreview widget="clock" design="digital" config={{}} data={null} width={240} height={120} />)
    const canvas = screen.getByLabelText('Clock preview') as HTMLCanvasElement
    expect(made).toHaveLength(1)

    await act(async () => made[0].onload?.())

    expect(contextFor(canvas).drawImage).not.toHaveBeenCalled()
  })

  it('ignores late asset callbacks after unmount', async () => {
    const made = fakeImages()
    const { unmount } = render(
      <WidgetPreview widget="clock" design="nixie" config={{}} data={null} width={240} height={120} />,
    )
    const canvas = screen.getByLabelText('Clock preview') as HTMLCanvasElement
    const drawImage = contextFor(canvas).drawImage
    unmount()
    expect(made).toHaveLength(1)

    await expect(act(async () => made[0].onload?.())).resolves.toBeUndefined()
    expect(drawImage).not.toHaveBeenCalled()
  })
})

describe('WidgetPreview failures', () => {
  it('shows a visible accessible unavailable state when the canvas context is unavailable', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => null)

    render(<WidgetPreview widget="clock" config={{}} data={null} width={240} height={120} />)

    const unavailable = screen.getByRole('status', { name: 'Clock preview unavailable' })
    expect(unavailable.textContent).toBe('Preview unavailable')
    expect(screen.getByLabelText('Clock preview').getAttribute('aria-hidden')).toBe('true')
  })

  it('recovers from an isolated draw failure on the next successful redraw', () => {
    const digital = (CATALOGUE as { meta: { widget: string; id: string }; draw: () => void }[])
      .find((candidate) => candidate.meta.widget === 'clock' && candidate.meta.id === 'digital')!
    vi.spyOn(digital, 'draw').mockImplementationOnce(() => { throw new Error('broken preview') })
    const config = {}
    const { rerender } = render(
      <WidgetPreview widget="clock" design="digital" config={config} data={null} width={240} height={120} />,
    )
    expect(screen.getByRole('status', { name: 'Clock preview unavailable' })).toBeDefined()

    rerender(<WidgetPreview widget="clock" design="digital" config={config} data={null} width={241} height={120} />)

    expect(screen.queryByRole('status', { name: 'Clock preview unavailable' })).toBeNull()
    expect(screen.getByLabelText('Clock preview').getAttribute('aria-hidden')).toBeNull()
  })
})

/**
 * THE CHANNEL-PARITY GUARD — the answer to a bug that has now shipped three times.
 *
 * `WidgetPreview` builds its own drawCtx by hand instead of calling `paintWidgets` (it has no
 * board, no feeds and no cells), so every channel the device adds has to be copied here too. Three
 * times it was not, and each time the omission did not degrade — it rendered the widget's ERROR
 * state to every operator browsing the gallery, because a design cannot tell "absent because this
 * is a preview" from "absent because there is nothing":
 *   1. `ctx.rows`  (stream data) — `stream_list` previewed as "Feed missing".
 *   2. `ctx.alerts` (screen state) — `alert_feed` previewed as "no active alerts".
 *   3. `ctx.bitmap`/`ctx.image_feed` (image screen state) — `image` previewed as "Feed missing".
 *      (`ctx.image_feed` has since been retired into the general `ctx.feed`; the lesson did not
 *      move, and the stand-in this file asserts on below is now every single-feed widget's, not
 *      just `image`'s.)
 * `ctx.series`/`ctx.ramp` are supplied here for chart previews.
 *
 * Every one of those was caught by a human reading a diff, and the fix each time was a comment
 * asking the next person to remember. This asserts it instead: the device's own drawCtx literal is
 * PARSED OUT OF `widgets/index.mjs` — read, never restated, the same discipline
 * `option-bounds.test.ts` applies to the admin schema — and compared with the ctx a design actually
 * receives here. A channel added on the device now fails this test rather than an operator.
 *
 * THIS BLOCK COMPARES KEY NAMES ONLY, and that is deliberately still the case: it is the cheap
 * canary, needing no DOM and no device runtime, and it reads the device's SOURCE rather than
 * running it. `rows: undefined` and `rows: {}` both pass it, which is the same operator-visible bug
 * wearing a different hat — so the block below ("channel SHAPE parity with the device") drives the
 * real `paintWidgets` and compares the VALUES too. Neither replaces the other.
 */
describe('WidgetPreview channel parity with the device', () => {
  /**
   * The top-level keys of `paintWidgets`' `const drawCtx = { ... }`, read out of the device module.
   *
   * Brace-depth rather than a regex over the whole literal: several channels are nested objects
   * (`box`, `state`) whose own keys would otherwise be counted as channels. Shorthand properties
   * count too — the device writes `tokens,` and `alerts,` — which is why each depth-0 segment is
   * split on commas and its leading identifier taken, rather than matching `key:`.
   */
  function deviceChannels(): string[] {
    // Relative to vitest's cwd (hub/admin), the same way the hub suite's own source-reading guards
    // resolve their inputs. `import.meta.url` is not a file URL under the jsdom environment.
    const src = readFileSync(resolve('../static/device/widgets/index.mjs'), 'utf8')
    const open = src.indexOf('{', src.indexOf('const drawCtx = {'))
    expect(open).toBeGreaterThan(-1)

    let depth = 0
    let close = -1
    for (let i = open; i < src.length && close < 0; i++) {
      if (src[i] === '{') depth++
      else if (src[i] === '}' && --depth === 0) close = i
    }
    expect(close).toBeGreaterThan(open)

    // Comments first: a `//` line inside the literal can carry commas and braces of its own.
    const body = src.slice(open + 1, close).split('\n').map((line) => line.replace(/\/\/.*$/, '')).join('\n')
    const segments: string[] = []
    let current = ''
    depth = 0
    for (const ch of body) {
      if ('{(['.includes(ch)) depth++
      else if ('})]'.includes(ch)) depth--
      if (ch === ',' && depth === 0) { segments.push(current); current = '' } else current += ch
    }
    segments.push(current)
    return segments.map((segment) => /^\s*(\w+)/.exec(segment)?.[1]).filter((name): name is string => !!name)
  }

  it('hands a design exactly the channels paintWidgets does', () => {
    const expected = deviceChannels()
    // Sanity: the parser found a real context, not an empty slice that would pass vacuously.
    expect(expected).toContain('tokens')
    expect(expected).toContain('bitmap')
    expect(expected.length).toBeGreaterThan(10)

    const image = designNamed('image')
    let seen: Record<string, unknown> | null = null
    vi.spyOn(image, 'draw').mockImplementation((_g, ctx) => { seen = ctx })

    render(<WidgetPreview widget="image" config={{ fit: 'contain' }} data={null} width={160} height={120} />)

    expect(seen, 'the design was never drawn — the preview fell into its catch').not.toBeNull()
    expect(Object.keys(seen!).sort()).toEqual([...expected].sort())
  })

  /*
   * weather_forecast, news_list and calendar_events are absent from WIDGET_BINDINGS entirely — they
   * bind by CONTRACT, not by mode — so feedModesFor returns [] and the preview must provide a real
   * feed object because their schema makes `feed` REQUIRED. No semantic design reads ctx.feed today,
   * so the channel-parity guard cannot detect this mismatch.
   *
   * The channel-parity guard cannot catch this one: `null` is a legal value on this channel, so
   * both the old and new values pass it. That is correct of a domain guard and is exactly why this
   * assertion is written by hand.
   */
  it.each([
    ['weather_forecast', 'value'],
    ['calendar_events', 'value'],
    ['news_list', 'stream'],
  ])('gives %s a real ctx.feed, not the "binds no feed" null the device never sends it', (widget, mode) => {
    const design = designNamed(widget)
    let seen: Record<string, unknown> | null = null
    vi.spyOn(design, 'draw').mockImplementation((_g, ctx) => { seen = ctx })

    render(<WidgetPreview widget={widget} config={{}} data={sampleDataFor(widget)} width={160} height={120} />)

    expect(seen, 'the design was never drawn — the preview fell into its catch').not.toBeNull()
    expect(seen!.feed).toEqual({ missing: false, mode, pushed_at: null, image_rev: null })
  })

  it('still says null for a widget that genuinely binds no single feed', () => {
    // clock binds nothing; chart binds PER SERIES. `null` is the truth for both, and the device
    // says the same — so this is the assertion that stops the fix above over-reaching.
    for (const widget of ['clock', 'chart']) {
      const design = designNamed(widget)
      let seen: Record<string, unknown> | null = null
      vi.spyOn(design, 'draw').mockImplementation((_g, ctx) => { seen = ctx })
      render(<WidgetPreview widget={widget} config={{}} data={sampleDataFor(widget)} width={160} height={120} />)
      expect(seen, `${widget} was never drawn`).not.toBeNull()
      expect(seen!.feed, `${widget} binds no single feed`).toBeNull()
    }
  })

  it('previews an image as the QUIET never-pushed state, not the loud authoring error', () => {
    // An absent feed channel must make normalizeImage read
    // `undefined` ⇒ state 'missing' ⇒ "Feed missing / Bind this cell to an image feed" in the
    // gallery. A preview has no feed to be missing; a never-pushed feed is the honest stand-in.
    const image = designNamed('image')
    let seen: Record<string, unknown> | null = null
    vi.spyOn(image, 'draw').mockImplementation((_g, ctx) => { seen = ctx })

    render(<WidgetPreview widget="image" config={{ fit: 'contain' }} data={null} width={160} height={120} />)

    expect(seen!.feed).toEqual({ missing: false, mode: 'image', pushed_at: null, image_rev: null })
    expect(seen!.bitmap).toBeNull()
  })

  /**
   * `ctx.feed` carries the feed state for every widget that binds one, so the preview's stand-in has
   * to be the never-pushed feed — never the loud `missing: true`, since a preview has no feed map
   * for anything to be missing from.
   *
   * And never `mode: null` either, which the contract defines as "a mode this build cannot name". A
   * preview knows perfectly well what kind of feed the widget takes, `table`/`value_tile` now read
   * the mode to decide quiet-vs-loud, and one sentinel carrying two meanings is what the encoding
   * this branch landed exists to stop.
   */
  it('previews every single-feed widget as a feed that exists, of a kind that widget can read', () => {
    const expected: Record<string, string> = {
      image: 'image', table: 'value', value_tile: 'value', stream_list: 'stream',
    }
    for (const [widget, mode] of Object.entries(expected)) {
      const design = designNamed(widget)
      let seen: Record<string, unknown> | null = null
      vi.spyOn(design, 'draw').mockImplementation((_g, ctx) => { seen = ctx })
      render(<WidgetPreview widget={widget} config={{}} data={null} width={160} height={120} />)
      expect(seen, `${widget} was never drawn`).not.toBeNull()
      expect(seen!.feed, `${widget} previewed with no feed at all`)
        .toEqual({ missing: false, mode, pushed_at: null, image_rev: null })
      // `cleanup()` only — NOT `vi.restoreAllMocks()`, which would also drop the `getContext` stub
      // this file installs in `beforeEach` and send every later iteration into the preview's catch.
      // Each spy here is on a different design object, so nothing needs restoring between rounds.
      cleanup()
    }
  })

  /**
   * A widget that binds no single feed gets `null` — which is what the DEVICE hands it, and which
   * on this channel means "not applicable" rather than "your feed is gone". Passing a made-up feed
   * object to a chart would be a fact about a binding that does not exist.
   */
  it('previews a widget that binds no single feed with null, exactly as the device does', () => {
    for (const widget of ['chart', 'clock', 'alert_feed']) {
      const design = designNamed(widget)
      let seen: Record<string, unknown> | null = null
      vi.spyOn(design, 'draw').mockImplementation((_g, ctx) => { seen = ctx })
      render(<WidgetPreview widget={widget} config={{}} data={null} width={160} height={120} />)
      expect(seen, `${widget} was never drawn`).not.toBeNull()
      expect(seen!.feed, `${widget} previewed with an invented feed`).toBeNull()
      cleanup()
    }
  })

  it('draws the quiet never-pushed line, not "Feed missing", for a table with no sample data', () => {
    render(<WidgetPreview widget="table" config={{ columns: [{ header: 'N', path: 'n' }] }} data={null} width={200} height={140} />)
    const canvas = screen.getByLabelText('Table preview') as HTMLCanvasElement
    const painted = contextFor(canvas).fillText.mock.calls.map(([text]) => text)
    expect(painted).toContain('— no rows yet')
    expect(painted).not.toContain('Feed missing')
  })
})

/**
 * THE SAME GUARD, ONE LEVEL DEEPER: not "which channels exist" but "what is actually on them".
 *
 * The name-level guard above states its own limit and it is a real one — it compares KEY NAMES, so
 * `rows: undefined` passes it, and so does `rows: {}`. That is the identical operator-visible bug in
 * a new disguise: a design cannot tell "this channel is a shape I don't understand" from "there is
 * nothing here", so it draws its error state in the gallery exactly as it did the five times a
 * channel was missing outright.
 *
 * The obvious fix — a table of expected types per channel — is the thing this whole guard exists to
 * avoid. A hand-maintained list is what `ctx.rows`, `ctx.alerts`, `ctx.bitmap` and `ctx.feed` each
 * fell out of. So nothing here is authored: the device's OWN `paintWidgets` is driven — a synthetic
 * cell, a synthetic feed map, a real canvas and the real design, the shape `widget-paint.test.ts`
 * uses in the hub suite — and the preview is compared against the contexts it produces.
 *
 * HOW LEGAL AND ILLEGAL ARE DECIDED — the judgement the next person will need:
 *
 *   A preview value is LEGAL on a channel exactly when the DEVICE ITSELF produces a value of that
 *   shape on that channel, in some state a real board can be in.
 *
 * Nobody writes the domain down; it is COLLECTED. Every widget definition is painted on the device
 * twice or more — once with nothing wired (the feed map empty) and once per feed mode the widget
 * declares, with a wire carrying that definition's own `sample_data` — and every value those
 * contexts carry is recorded per channel path. `age_ms` therefore ends up `{number, null}`,
 * `ctx.feed.mode` `{string, null}`, `ctx.rows` `{array, null}`, and so on, because the device really
 * does produce each of those. `undefined` is on NO channel's domain, because `paintWidgets` never
 * writes one — which is precisely why the preview must never write one either.
 *
 * Two consequences worth stating, because they are the parts that could be argued the other way:
 *
 *   - The domain is per CHANNEL, not per widget. A preview may legitimately give `stream_list` a
 *     `rows` array while the device gives that same widget `null` (the preview has sample data and
 *     no wire, the device has a wire and no rows), and both are true things to say on that channel.
 *     Narrowing the domain to one widget would fail on differences that are not defects. WHICH of a
 *     channel's legal values each widget should get is a separate question, and it is the one the
 *     value-level tests above answer widget by widget (`feed` is `null` for a chart, a never-pushed
 *     object for an image, and so on). This test answers the shape question only.
 *   - Nested objects are checked by KEY SET against the device, per widget, and a preview object has
 *     to match the device's key set in at least one of its states — not the union of them. A `feed`
 *     missing `image_rev`, or a `series` entry missing `missing`, is caught; a bound cell's config
 *     legitimately carrying one more key than an unbound one's is not an issue.
 */
describe('WidgetPreview channel SHAPE parity with the device', () => {
  type Ctx = Record<string, unknown>
  type Definition = { id: string; sample_config: Ctx; sample_data: unknown }
  type Design = { meta: { id: string; widget: string }; draw: (g: unknown, ctx: Ctx, elapsed: number) => void }

  const paint = paintWidgets as (
    cells: unknown[], boxes: unknown[], board: unknown, hubNow: () => number,
    themeWidgets: unknown, feeds: unknown, only?: unknown, alerts?: unknown[],
  ) => void
  const stopAll = stopAllWidgets as () => void
  const definitions = WIDGET_DEFINITIONS as Definition[]

  // One cell, 240x160, the same box the preview below is rendered at, so `ctx.box` is comparable
  // without either side having to know the other's numbers.
  const WIDTH = 240
  const HEIGHT = 160
  const DEVICE_BOX = { rect: { x: 0, y: 0, w: 1, h: 1 }, px: { left: 0, top: 0, width: WIDTH, height: HEIGHT }, t: 1 }
  const DEVICE_NOW = 1_775_000_000_000
  const BOUND_FEED = 'sample'

  /** The design BOTH sides resolve to — `lookup(widget, undefined)`, exactly as the preview does. */
  const defaultDesign = (widget: string): Design => {
    const design = lookup(widget, undefined) as Design | null
    if (!design) throw new Error(`no design registered for ${widget}`)
    return design
  }

  /**
   * A wire feed of `mode` carrying this definition's own `sample_data`, so the device's `ctx.data`
   * is the same payload the preview is handed. Shaped the way `hub/test/widget-paint.test.ts`
   * shapes its own fixtures: a stream keeps rows, a value keeps a payload, an image keeps a rev.
   */
  const wireFor = (mode: string, sampleData: unknown) => {
    if (mode === 'stream') {
      const payloads = Array.isArray(sampleData) ? sampleData : [sampleData]
      return {
        mode,
        rows: payloads.map((payload, index) => ({ payload, pushed_at: DEVICE_NOW - index })),
        pushed_at: DEVICE_NOW,
        stale_after_s: 2_700,
      }
    }
    if (mode === 'image') return { mode, image_rev: 3, pushed_at: DEVICE_NOW, stale_after_s: 2_700 }
    return { mode, payload: sampleData, pushed_at: DEVICE_NOW, stale_after_s: 2_700 }
  }

  /**
   * Drives the REAL `paintWidgets` for one cell and returns the ctx the design was handed.
   *
   * `paintWidgets`' only DOM dependency is `document.querySelectorAll('canvas.widget-canvas
   * [data-cell]')`, so a real jsdom canvas carrying those attributes is all the wiring it needs —
   * `getContext` is already stubbed for this whole file. The design's `draw` is spied rather than a
   * stand-in registered, so both sides resolve the SAME design object and therefore the same
   * `meta.tokens`: any token difference would then be a real difference, not a fixture artefact.
   */
  function deviceContext(widget: string, config: Ctx, feeds: Ctx, alerts: unknown[]): Ctx {
    const design = defaultDesign(widget)
    let seen: Ctx | null = null
    const spy = vi.spyOn(design, 'draw').mockImplementation((_g, ctx) => { seen = ctx })
    const canvas = document.createElement('canvas')
    canvas.className = 'widget-canvas'
    canvas.setAttribute('data-cell', '0')
    document.body.appendChild(canvas)
    const failures: unknown[] = []
    const realError = console.error
    console.error = (...args: unknown[]) => { failures.push(args) }
    try {
      paint([{ widget, config }], [DEVICE_BOX], BUILTIN_BOARD, () => DEVICE_NOW, {}, feeds, undefined, alerts)
    } finally {
      console.error = realError
      stopAll()
      canvas.remove()
      spy.mockRestore()
    }
    // paintWidgets swallows a cell's paint failure and logs it. Nothing should be failing here, and
    // a silently caught throw would leave a half-built ctx standing in for the device's real one.
    expect(failures, `paintWidgets logged a failure for ${widget}`).toEqual([])
    expect(seen, `${widget} was never painted on the device`).not.toBeNull()
    return seen as unknown as Ctx
  }

  /**
   * The board states this definition can actually be in, as draw contexts: nothing wired, plus one
   * per feed mode it declares. Semantic widgets (`weather_forecast`, `news_list`,
   * `calendar_events`) declare no modes in `WIDGET_BINDINGS` — their compatibility is contract-based
   * — so the mode is taken from the sample payload's own shape, which is the same rule
   * `rowsForPreview` uses: an array-shaped sample is a stream's rows, anything else is a value.
   */
  function deviceContexts(definition: Definition): Ctx[] {
    const sampleConfig = definition.sample_config ?? {}
    const declared = feedModesFor(definition.id) as string[]
    const modes = declared.length > 0 ? declared : [Array.isArray(definition.sample_data) ? 'stream' : 'value']
    const namesFeed = 'feed' in sampleConfig || Array.isArray((sampleConfig as { series?: unknown[] }).series)
    // A widget that binds nothing (clock, alert_feed) never gets a feed id invented for it: its
    // "bound" sample is its unbound one, which is the only state its cells have.
    const boundConfig = namesFeed || declared.length === 0
      ? sampleConfig
      : { ...sampleConfig, feed: BOUND_FEED }
    const feedId = (boundConfig as { feed?: string }).feed
      ?? (sampleConfig as { series?: { feed?: string }[] }).series?.[0]?.feed
      ?? BOUND_FEED
    /*
     * The device hands the SAME live alert list to every cell, so any list is a legal argument here.
     * `alert_feed` is the one definition whose `sample_data` is alert-shaped rather than feed-shaped
     * (its own comment in definitions.mjs says so), and it is the only widget that reads the
     * channel — so its sample is what gives `ctx.alerts`' element shapes a device-side domain at
     * all. Handing another widget's rows to this argument would populate that domain with objects
     * no board ever puts there.
     */
    const alerts = definition.id === 'alert_feed' && Array.isArray(definition.sample_data)
      ? definition.sample_data
      : []
    return [
      deviceContext(definition.id, sampleConfig, {}, alerts),
      ...modes.map((mode) => deviceContext(
        definition.id, boundConfig, { [feedId]: wireFor(mode, definition.sample_data) }, alerts,
      )),
    ]
  }

  /** The ctx the preview hands the same design, for the same definition the gallery renders. */
  function previewContext(definition: Definition): Ctx {
    const design = defaultDesign(definition.id)
    let seen: Ctx | null = null
    vi.spyOn(design, 'draw').mockImplementation((_g, ctx) => { seen = ctx })
    render(
      <WidgetPreview
        widget={definition.id}
        config={definition.sample_config}
        data={definition.sample_data}
        width={WIDTH}
        height={HEIGHT}
      />,
    )
    // `cleanup()` only, never `vi.restoreAllMocks()` — that would also drop this file's `getContext`
    // stub and send every later render into the preview's catch (the loop above learned this too).
    cleanup()
    expect(seen, `${definition.id} was never drawn — the preview fell into its catch`).not.toBeNull()
    return seen as unknown as Ctx
  }

  const classify = (value: unknown): string => (
    value === null ? 'null'
      : value === undefined ? 'undefined'
        : Array.isArray(value) ? 'array'
          : typeof value
  )
  const isPlainObject = (value: unknown): value is Ctx =>
    typeof value === 'object' && value !== null && !Array.isArray(value)

  /*
   * Four levels is enough to reach `series.[].rows.[]`, the deepest structure any channel carries.
   * `.[]` stands for "any element", so an array's entries all share one path.
   *
   * A FEED PAYLOAD IS OPAQUE, and that boundary is the whole point of the walk rather than an
   * accident of depth. `ctx.data` and each row's `payload` are whatever an operator pushed; both
   * sides pass them through untouched, and their internal shape is the DEFINITION's contract (what
   * `sample_data` promises, what `path`/`y_path` reach), not the draw contract's. Descending into
   * them would report `alert_feed`'s preview — which passes its alert-shaped sample as `data`,
   * where a board leaves `data` null because alerts do not travel through a feed — as carrying a
   * `severity` field "the device never produces", which is a fact about that definition's sample
   * and not a defect in any channel. The channels themselves are still checked: `data` and
   * `rows.[].payload` are classified like everything else, they are simply not opened.
   */
  const MAX_DEPTH = 4
  const isOpaquePayload = (path: string) => path === 'data' || path.endsWith('.payload')
  function walk(value: unknown, path: string, depth: number, visit: (path: string, value: unknown) => void) {
    visit(path, value)
    if (depth >= MAX_DEPTH || isOpaquePayload(path)) return
    if (Array.isArray(value)) {
      for (const entry of value) walk(entry, `${path}.[]`, depth + 1, visit)
    } else if (isPlainObject(value)) {
      for (const [key, entry] of Object.entries(value)) walk(entry, `${path}.${key}`, depth + 1, visit)
    }
  }

  /** Every classification the device puts on each channel path — the domain, collected not authored. */
  function collectDomain(contexts: Ctx[]): Map<string, Set<string>> {
    const domain = new Map<string, Set<string>>()
    for (const ctx of contexts) {
      for (const [key, value] of Object.entries(ctx)) {
        walk(value, key, 1, (path, entry) => {
          if (!domain.has(path)) domain.set(path, new Set())
          domain.get(path)!.add(classify(entry))
        })
      }
    }
    return domain
  }

  /** Every key set the device shows at each object path, one signature per board state. */
  function collectKeySets(contexts: Ctx[]): Map<string, Set<string>> {
    const sets = new Map<string, Set<string>>()
    for (const ctx of contexts) {
      const record = (path: string, value: unknown) => {
        if (!isPlainObject(value)) return
        if (!sets.has(path)) sets.set(path, new Set())
        sets.get(path)!.add(Object.keys(value).sort().join(','))
      }
      record('', ctx)
      for (const [key, value] of Object.entries(ctx)) walk(value, key, 1, record)
    }
    return sets
  }

  /**
   * What the preview says that the device never would. Empty means parity.
   *
   * Split out as a plain function over a captured ctx so the guard can be tested on a KNOWN-broken
   * preview context, which is the only way to show it would actually catch the bug it is for.
   */
  function shapeMismatches(
    widget: string,
    preview: Ctx,
    domain: Map<string, Set<string>>,
    keySets: Map<string, Set<string>>,
  ): string[] {
    const found: string[] = []
    const checkKeys = (path: string, value: unknown) => {
      if (!isPlainObject(value)) return
      const legal = keySets.get(path)
      if (!legal) return
      const signature = Object.keys(value).sort().join(',')
      if (!legal.has(signature)) {
        found.push(`${widget}: ctx.${path || '(root)'} has keys [${signature}], device shows [${[...legal].join('] or [')}]`)
      }
    }
    checkKeys('', preview)
    for (const [key, value] of Object.entries(preview)) {
      walk(value, key, 1, (path, entry) => {
        const legal = domain.get(path)
        const shape = classify(entry)
        if (!legal) found.push(`${widget}: ctx.${path} exists in the preview and nowhere on the device`)
        else if (!legal.has(shape)) {
          found.push(`${widget}: ctx.${path} is ${shape}, device only ever produces ${[...legal].sort().join('/')}`)
        }
        checkKeys(path, entry)
      })
    }
    // One complaint per defect, not one per array element that shares the defective path.
    return [...new Set(found)]
  }

  // Collected once: the domain is a property of the CHANNEL, so every definition's device states
  // contribute to it (see the header above for why it is not narrowed per widget).
  const deviceByWidget = new Map<string, Ctx[]>()
  const domain = new Map<string, Set<string>>()
  const captureDevice = () => {
    if (deviceByWidget.size > 0) return
    for (const definition of definitions) deviceByWidget.set(definition.id, deviceContexts(definition))
    const all = [...deviceByWidget.values()].flat()
    for (const [path, shapes] of collectDomain(all)) domain.set(path, shapes)
  }

  it('collects a device domain from real paints, not from a hand-written table', () => {
    captureDevice()
    // Sanity, so a domain that silently collected nothing cannot make every check below vacuous.
    expect(deviceByWidget.size).toBe(definitions.length)
    expect(domain.get('rows')).toEqual(new Set(['null', 'array']))
    expect(domain.get('age_ms')).toEqual(new Set(['null', 'number']))
    expect(domain.get('feed')).toEqual(new Set(['null', 'object']))
    expect(domain.get('feed.mode')).toEqual(new Set(['null', 'string']))
    // The load-bearing negative: the device writes `undefined` on nothing, which is what makes a
    // preview channel that is merely PRESENT-but-undefined an illegal value rather than a shrug.
    for (const shapes of domain.values()) expect(shapes.has('undefined')).toBe(false)
  })

  it('hands every design values of a shape the device itself produces on that channel', () => {
    captureDevice()
    const complaints: string[] = []
    for (const definition of definitions) {
      const device = deviceByWidget.get(definition.id)!
      complaints.push(...shapeMismatches(
        definition.id, previewContext(definition), domain, collectKeySets(device),
      ))
    }
    expect(complaints).toEqual([])
  })

  /**
   * THE GUARD'S OWN TEST — because a guard nobody has ever seen fail is a guard nobody knows works.
   *
   * Both defects are injected into the ctx the REAL component actually produced, so the only thing
   * simulated is the bug; everything that built the value around it is production code. Each one is
   * also shown to sail straight through the name-level check above, which is the entire reason this
   * block exists.
   */
  it('fails on a channel that keeps its name but loses its value, and on one of the wrong type', () => {
    captureDevice()
    const definition = definitions.find((candidate) => candidate.id === 'stream_list')!
    const device = deviceByWidget.get('stream_list')!
    const keySets = collectKeySets(device)
    const honest = previewContext(definition)
    expect(shapeMismatches('stream_list', honest, domain, keySets)).toEqual([])
    expect(honest.rows, 'the fixture must carry a real array for the mutations to be mutations')
      .toBeInstanceOf(Array)

    const absent = { ...honest, rows: undefined }
    const wrongType = { ...honest, rows: {} }

    // Both still carry every channel NAME, which is all the guard above can see.
    for (const mutated of [absent, wrongType]) {
      expect(Object.keys(mutated).sort()).toEqual(Object.keys(honest).sort())
    }

    expect(shapeMismatches('stream_list', absent, domain, keySets))
      .toContain('stream_list: ctx.rows is undefined, device only ever produces array/null')
    expect(shapeMismatches('stream_list', wrongType, domain, keySets))
      .toContain('stream_list: ctx.rows is object, device only ever produces array/null')
  })

  /** The same, one level in: a channel of the right type whose contents lost a field. */
  it('fails on a nested channel object that lost a key the device always carries', () => {
    captureDevice()
    const definition = definitions.find((candidate) => candidate.id === 'image')!
    const keySets = collectKeySets(deviceByWidget.get('image')!)
    const honest = previewContext(definition)
    expect(shapeMismatches('image', honest, domain, keySets)).toEqual([])

    const { image_rev: _dropped, ...withoutRev } = honest.feed as Ctx
    expect(shapeMismatches('image', { ...honest, feed: withoutRev }, domain, keySets))
      .toEqual([expect.stringContaining('ctx.feed has keys [missing,mode,pushed_at]')])
  })
})

/**
 * THE LIGHTWEIGHT-PREVIEW TESTS ARE DELETED, not repointed a fifth time — which is exactly what
 * both of them, and `WidgetGallery.test.tsx`, instructed this code that migrated `chart` to do.
 *
 * They needed "a widget type with no canvas design" and had already been moved off `gauge`, `table`,
 * `alert_feed` and `image`, each time as the renderer gained a canvas implementation. Every widget now
 * has a canvas design, so the branch they covered has no reachable
 * input: `LegacyPreview`, `legacySummary` and their two CSS classes are gone from the component.
 *
 * What replaced them, so the coverage is moved rather than dropped:
 *   - the gallery's positive claim, that EVERY definition now renders a real canvas and none says
 *     "Lightweight preview" (`WidgetGallery.test.tsx`);
 *   - the `!selected` branch that survives — an unknown widget id — asserted below on the honest
 *     "Preview unavailable" status that replaced the summary card;
 *   - `chart`'s own preview, asserted here through the real design rather than through a summary
 *     string, which is what these two tests were standing in for all along.
 */
describe('WidgetPreview for a widget this build does not know', () => {
  it('shows the same honest unavailable status a failed draw gets, never a summary card', () => {
    render(<WidgetPreview widget="__no_such_widget__" config={{}} data={null} width={160} height={120} />)

    const unavailable = screen.getByRole('status', { name: '__no_such_widget__ preview unavailable' })
    expect(unavailable.textContent).toBe('Preview unavailable')
    expect(screen.queryByText('Lightweight preview')).toBeNull()
    const frame = unavailable.parentElement as HTMLElement
    expect(frame.className).toBe('widget-preview-frame')
    expect(frame.style.maxWidth).toBe('160px')
    expect(frame.style.aspectRatio).toBe('160 / 120')
  })
})

/**
 * `ctx.series` for a chart preview.
 *
 * The channel was already the right SHAPE here — one positional entry per configured series — but
 * every entry replayed the SAME rows at the SAME instant, and for a chart that is not a preview of
 * anything: identical points at one timestamp collapse the x axis to a single column, and identical
 * series paint N coincident lines so the operator sees one, in the last ramp colour. Both are fixed
 * in `seriesForPreview`, and both are asserted here rather than left to a comment.
 */
describe('WidgetPreview chart sample', () => {
  const chartConfig = {
    style: 'line',
    series: [
      { feed: 'sample', y_path: 'value', icon: 'circle', label: 'First' },
      { feed: 'sample', y_path: 'value', icon: 'square', label: 'Second' },
    ],
  }
  const chartData = [{ value: 4 }, { value: 7 }, { value: 6 }]

  const seenSeries = () => {
    const chart = designNamed('chart')
    let seen: Record<string, unknown> | null = null
    vi.spyOn(chart, 'draw').mockImplementation((_g, ctx) => { seen = ctx })
    render(<WidgetPreview widget="chart" config={chartConfig} data={chartData} width={240} height={140} />)
    expect(seen, 'the design was never drawn — the preview fell into its catch').not.toBeNull()
    return seen! as unknown as {
      series: { feed: string; rows: { payload: unknown; pushed_at: number }[]; missing: boolean }[]
    }
  }

  it('spreads the sample over real time, so the chart has an x span to plot against', () => {
    const rows = seenSeries().series[0].rows
    expect(rows).toHaveLength(chartData.length)
    const times = rows.map((row) => row.pushed_at)
    expect(new Set(times).size).toBe(times.length)
    // Newest first, one minute apart — the wire order a real stream feed arrives in.
    expect(times[0] - times[1]).toBe(60_000)
    expect(times[1] - times[2]).toBe(60_000)
  })

  it('phase-shifts each series so two of them do not draw the same line twice', () => {
    const series = seenSeries().series
    expect(series).toHaveLength(2)
    expect(series[0].rows.map((r) => r.payload)).not.toEqual(series[1].rows.map((r) => r.payload))
    // Every point is still a real `sample_data` payload — the shift invents no values.
    for (const entry of series)
      for (const row of entry.rows) expect(chartData).toContain(row.payload)
  })

  it('reports no series missing, so a preview never paints the loud authoring notice', () => {
    expect(seenSeries().series.every((entry) => entry.missing === false)).toBe(true)
  })

  it('draws the chart itself — legend labels on canvas, not a summary string', () => {
    render(<WidgetPreview widget="chart" config={chartConfig} data={chartData} width={240} height={140} />)
    const canvas = screen.getByLabelText('Chart preview') as HTMLCanvasElement
    const painted = contextFor(canvas).fillText.mock.calls.map(([text]) => text)
    expect(painted).toContain('First')
    expect(painted).toContain('Second')
    expect(painted).not.toContain('Feed missing')
    expect(painted).not.toContain('no data')
  })

  it('previews a chart with no series configured as the loud notice, which is what a board shows', () => {
    render(<WidgetPreview widget="chart" config={{ style: 'line', series: [] }} data={null} width={160} height={120} />)
    const canvas = screen.getByLabelText('Chart preview') as HTMLCanvasElement
    expect(contextFor(canvas).fillText.mock.calls.map(([text]) => text)).toContain('Feed missing')
  })
})
