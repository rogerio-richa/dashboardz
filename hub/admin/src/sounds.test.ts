import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchSoundManifest, playPreview } from './sounds'

describe('playPreview', () => {
  // jsdom (this project's own vitest environment) has no window.AudioContext, the same as any
  // environment without audio hardware. The WAV branch already guards with `.catch(() => {})`;
  // the classic branch must be equally never-throws, since 'classic' is the default fallback
  // family whenever a caller's suggestion is null/unset (SoundMixer).
  it('does not throw for the classic family when AudioContext is unavailable', () => {
    expect(() => playPreview('classic', 'critical', 1)).not.toThrow()
  })
})

describe('fetchSoundManifest', () => {
  afterEach(() => vi.unstubAllGlobals())

  const fallback = { rev: 0, families: { classic: { name: 'Classic beeps' } } }

  it('returns the parsed manifest on a well-shaped response', async () => {
    const manifest = { rev: 3, families: { classic: { name: 'Classic beeps' }, bells: { name: 'Bells' } } }
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(manifest), { status: 200 })))
    expect(await fetchSoundManifest()).toEqual(manifest)
  })

  it('degrades to the classic-only fallback on a non-OK response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })))
    expect(await fetchSoundManifest()).toEqual(fallback)
  })

  it('degrades to the classic-only fallback on a network error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
    expect(await fetchSoundManifest()).toEqual(fallback)
  })

  // The shape guard this test protects: a response that parses as JSON
  // but isn't `{ families: object }` — e.g. an unrelated test's catch-all `[]` stub answering
  // every unmatched URL — otherwise callers would receive an unvalidated value and crash
  // SoundMixer's `Object.entries(manifest.families)`. The guard lives in fetchSoundManifest itself so every
  // caller (Screens.tsx, Themes.tsx) gets it for free.
  it('degrades to the classic-only fallback when the body is the wrong shape', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify([]), { status: 200 })))
    expect(await fetchSoundManifest()).toEqual(fallback)
  })

  it('degrades to the classic-only fallback when families is missing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ rev: 1 }), { status: 200 })))
    expect(await fetchSoundManifest()).toEqual(fallback)
  })
})
