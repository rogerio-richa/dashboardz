import { afterEach, describe, expect, it } from 'vitest'
// @ts-expect-error plain JS module without types
import { assetsFor, onAssetReady, _reset, _setImageFactory } from '../static/device/widgets/assets.mjs'

/**
 * A stand-in for the browser's Image: records the src it was given and exposes the load/error
 * callbacks so a test can decide, synchronously, what the network did.
 */
function fakeImages() {
  const made: { src: string; onload: () => void; onerror: () => void }[] = []
  _setImageFactory(() => {
    const img = {
      _src: '',
      onload: () => {}, onerror: () => {},
      set src(v: string) { this._src = v; made.push(this as never) },
      get src() { return this._src },
    }
    return img
  })
  return made
}

afterEach(() => { _reset(); _setImageFactory(null) })

const META = { widget: 'clock', assets: { glyphs: 'nixie-glyphs.png' } }

describe('design assets (asset ownership rule raster channel)', () => {
  it('returns nothing for a design that declares no assets', () => {
    const made = fakeImages()
    expect(assetsFor({ widget: 'clock' })).toEqual({})
    expect(made).toHaveLength(0)   // and fetches nothing
  })

  /**
   * The first frame ALWAYS lands before the image does — loading is async and draw is not — so an
   * unloaded asset must be absent rather than present-and-broken. Every design has to render
   * without its artwork; this is the property that makes that testable.
   */
  it('omits an asset that has not finished loading', () => {
    fakeImages()
    expect(assetsFor(META)).toEqual({})
  })

  it('resolves the bare filename under the design\'s own widget directory', () => {
    const made = fakeImages()
    assetsFor(META)
    expect(made).toHaveLength(1)
    expect(made[0].src).toMatch(/\/widgets\/clock\/assets\/nixie-glyphs\.png$/)
  })

  it('hands the design its image once decoded, under the declared name', () => {
    const made = fakeImages()
    assetsFor(META)
    made[0].onload()
    const out = assetsFor(META) as Record<string, unknown>
    expect(Object.keys(out)).toEqual(['glyphs'])
    expect(out.glyphs).toBe(made[0])
  })

  /** One request per URL, not one per frame — paintWidgets calls this on every single render. */
  it('fetches each asset once however many times it is asked for', () => {
    const made = fakeImages()
    for (let i = 0; i < 50; i++) assetsFor(META)
    expect(made).toHaveLength(1)
  })

  /**
   * Without remembering the failure, a 404 would re-request on every frame of an animating cell —
   * a broken asset would turn one missing file into a request storm.
   */
  it('remembers a failure instead of retrying forever', () => {
    const made = fakeImages()
    assetsFor(META)
    made[0].onerror()
    for (let i = 0; i < 20; i++) expect(assetsFor(META)).toEqual({})
    expect(made).toHaveLength(1)
  })

  it('is lazy — a design that is not painted fetches nothing', () => {
    const made = fakeImages()
    assetsFor({ widget: 'clock', assets: { a: 'one.png' } })
    expect(made.map((m) => m.src.split('/').pop())).toEqual(['one.png'])
  })

  it('ignores a malformed declaration rather than throwing mid-render', () => {
    fakeImages()
    expect(assetsFor({ widget: 'clock', assets: null })).toEqual({})
    expect(assetsFor({ widget: 'clock', assets: { a: '', b: 42 } })).toEqual({})
    expect(assetsFor(undefined)).toEqual({})
  })

  /**
   * A recording surface (ESP32) and the hub's own Node suite both lack an Image constructor. That
   * must degrade to "no assets", never to an exception thrown out of paintWidgets — which renders
   * the whole board, including the critical-alert takeover that runs after it.
   */
  it('degrades to no assets where no image constructor exists', () => {
    _setImageFactory(() => { throw new Error('no DOM here') })
    expect(() => assetsFor(META)).not.toThrow()
    expect(assetsFor(META)).toEqual({})
  })
})

/**
 * A decode finishing is the one asset event the board has to react to, and it happens on the
 * network's schedule rather than anyone else's. The decode callback, rather than a periodic render
 * tick, announces artwork so the board can slow or stop rendering static screens without delaying
 * asset visibility.
 */
describe('announcing a decoded asset', () => {
  it('tells the board exactly once per image, after the asset is usable', () => {
    const made = fakeImages()
    const seen: number[] = []
    onAssetReady(() => seen.push(Object.keys(assetsFor(META)).length))

    assetsFor(META)
    expect(seen).toEqual([])

    made[0].onload()
    // Announced after the entry is complete: the repaint this triggers must be able to see it.
    expect(seen).toEqual([1])
  })

  it('says nothing when an image fails, because nothing new can be drawn', () => {
    const made = fakeImages()
    let calls = 0
    onAssetReady(() => { calls++ })

    assetsFor(META)
    made[0].onerror()
    expect(calls).toBe(0)
  })

  /** A repaint that throws must not poison the cache entry that had just succeeded. */
  it('keeps the decoded asset even if the repaint it triggers throws', () => {
    const made = fakeImages()
    onAssetReady(() => { throw new Error('render blew up') })

    assetsFor(META)
    expect(() => made[0].onload()).not.toThrow()
    expect(Object.keys(assetsFor(META))).toEqual(['glyphs'])
  })
})
