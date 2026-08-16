import { beforeEach, describe, expect, it, vi } from 'vitest'
// @ts-expect-error plain JS module without types
import { bitmapFor, loadBitmapFor, onBitmapReady, resetBitmaps } from '../static/device/widgets/bitmaps.mjs'

const deps = (over = {}) => ({
  fetchBlob: vi.fn(async () => ({ blob: 'B1' })),
  decode: vi.fn(async (b: unknown) => ({ drawable: b })),
  revoke: vi.fn(),
  now: () => 0,
  ...over,
})

beforeEach(() => resetBitmaps())

it('decodes once and exposes the drawable', async () => {
  const d = deps()
  await loadBitmapFor('f', 1, d)
  expect(bitmapFor('f')).toEqual({ drawable: { blob: 'B1' } })
  expect(d.fetchBlob).toHaveBeenCalledTimes(1)
})

it('does not re-fetch the same feed:rev', async () => {
  const d = deps()
  await loadBitmapFor('f', 1, d)
  await loadBitmapFor('f', 1, d)
  expect(d.fetchBlob).toHaveBeenCalledTimes(1)
})

it('revokes the previous bitmap when a new rev arrives', async () => {
  const d = deps()
  await loadBitmapFor('f', 1, d)
  await loadBitmapFor('f', 2, d)
  expect(d.revoke).toHaveBeenCalledTimes(1)
})

it('a failed fetch KEEPS the last good bitmap', async () => {
  const d = deps()
  await loadBitmapFor('f', 1, d)
  const failing = deps({ fetchBlob: vi.fn(async () => { throw new Error('offline') }) })
  await loadBitmapFor('f', 2, failing)
  expect(bitmapFor('f')).toEqual({ drawable: { blob: 'B1' } })
})

it('backs off 30s per feed after a failure, then retries', async () => {
  let t = 0
  const fetchBlob = vi.fn(async () => { throw new Error('offline') })
  const d = deps({ fetchBlob, now: () => t })
  await loadBitmapFor('f', 1, d)
  expect(fetchBlob).toHaveBeenCalledTimes(1)
  t = 29_000
  await loadBitmapFor('f', 1, d)
  expect(fetchBlob).toHaveBeenCalledTimes(1)   // still within retry backoff
  t = 31_000
  await loadBitmapFor('f', 1, d)
  expect(fetchBlob).toHaveBeenCalledTimes(2)
})

it('a NEW rev retries immediately, ignoring the backoff window', async () => {
  let t = 0
  const fetchBlob = vi.fn(async () => { throw new Error('offline') })
  const d = deps({ fetchBlob, now: () => t })
  await loadBitmapFor('f', 1, d)
  t = 1_000
  await loadBitmapFor('f', 2, d)
  expect(fetchBlob).toHaveBeenCalledTimes(2)
})

it('never fetches for rev 0 — never-pushed is not a failure', async () => {
  const d = deps()
  await loadBitmapFor('f', 0, d)
  expect(d.fetchBlob).not.toHaveBeenCalled()
  expect(bitmapFor('f')).toBeNull()
})

it('announces a finished decode, or the cell sits on "loading" forever', async () => {
  // draw is synchronous and the decode is not. Without this the bitmap lands in the cache and
  // nothing ever repaints the cell to show it.
  const seen: string[] = []
  onBitmapReady((feedId: string) => seen.push(feedId))
  await loadBitmapFor('f', 1, deps())
  expect(seen).toEqual(['f'])
})

it('does not announce a failed fetch', async () => {
  const seen: string[] = []
  onBitmapReady((feedId: string) => seen.push(feedId))
  await loadBitmapFor('f', 1, deps({ fetchBlob: vi.fn(async () => { throw new Error('offline') }) }))
  expect(seen).toEqual([])
})

/**
 * TWO REVS OF ONE FEED IN FLIGHT AT ONCE — the case `pending` deliberately allows (it is keyed
 * `feedId:rev` precisely so a new revision never waits behind an old one) and that nothing here
 * covered until the cache commit path exposed the leak it hides.
 *
 * The trap is that `loadBitmapFor` reads the cache BEFORE its two awaits. Both continuations then
 * commit against the same stale read: both `cache.set`, only one raw is ever revoked, and the other
 * is pinned for the life of the page — an object URL keeps the whole Blob alive behind it. A feed
 * pushed faster than fetch+decode completes (a camera snapshot on slow Wi-Fi) leaks one full image
 * per overlapping push, on a panel that runs for weeks.
 *
 * These drive the real module with deps whose decode can be released by hand, so both orderings —
 * the newer one committing first, and the older one committing first — are exercised, and count
 * every raw that was minted against every raw that was released.
 */
describe('two revisions of one feed in flight at once', () => {
  /** Deps that mint a distinguishable raw per fetch and hold each decode until released. */
  function racing() {
    const minted: string[] = []
    const revoked: string[] = []
    const gates: Record<string, () => void> = {}
    let nth = 0
    const deps = {
      fetchBlob: async (feedId: string) => {
        const raw = `blob:${feedId}:${++nth}`
        minted.push(raw)
        return raw
      },
      decode: (raw: string) => new Promise((resolve) => { gates[raw] = () => resolve({ drawable: raw }) }),
      revoke: (raw: string) => { revoked.push(raw) },
      now: () => 0,
    }
    /** Everything minted that was never handed to `revoke` and is not the entry on screen. */
    const leaked = () => minted.filter((raw) => !revoked.includes(raw) && bitmapFor('f')?.drawable !== raw)
    return { deps, minted, revoked, gates, leaked }
  }

  const settle = () => new Promise((r) => setTimeout(r, 0))

  it('leaks nothing when the OLDER decode finishes first', async () => {
    const r = racing()
    const first = loadBitmapFor('f', 1, r.deps)
    const second = loadBitmapFor('f', 2, r.deps)
    await settle()
    expect(r.minted).toHaveLength(2) // both really are in flight; rev 2 was not blocked by rev 1

    r.gates[r.minted[0]]!(); await first
    r.gates[r.minted[1]]!(); await second

    expect(bitmapFor('f')).toEqual({ drawable: r.minted[1] }) // newest wins
    expect(r.leaked()).toEqual([])
    expect(r.revoked).toEqual([r.minted[0]]) // and the one it displaced was released exactly once
  })

  it('leaks nothing when the NEWER decode finishes first, and the older one does not overwrite it', async () => {
    const r = racing()
    const first = loadBitmapFor('f', 1, r.deps)
    const second = loadBitmapFor('f', 2, r.deps)
    await settle()

    r.gates[r.minted[1]]!(); await second
    r.gates[r.minted[0]]!(); await first

    // The stale winner would be a visible bug as well as a leak: the panel would end up showing
    // the OLDER picture and stay there until the next push.
    expect(bitmapFor('f')).toEqual({ drawable: r.minted[1] })
    expect(r.leaked()).toEqual([])
    expect(r.revoked).toEqual([r.minted[0]]) // the loser released its OWN raw
  })

  it('leaks nothing across three overlapping revisions', async () => {
    const r = racing()
    const runs = [1, 2, 3].map((rev) => loadBitmapFor('f', rev, r.deps))
    await settle()
    expect(r.minted).toHaveLength(3)

    // Released middle-first, so the commit order is neither ascending nor descending.
    r.gates[r.minted[1]]!(); await runs[1]
    r.gates[r.minted[2]]!(); await runs[2]
    r.gates[r.minted[0]]!(); await runs[0]

    expect(bitmapFor('f')).toEqual({ drawable: r.minted[2] })
    expect(r.leaked()).toEqual([])
    expect(r.revoked.sort()).toEqual([r.minted[0], r.minted[1]].sort())
  })

  it('announces only the revision that actually reached the screen', async () => {
    const r = racing()
    const seen: string[] = []
    onBitmapReady((feedId: string) => seen.push(feedId))
    const first = loadBitmapFor('f', 1, r.deps)
    const second = loadBitmapFor('f', 2, r.deps)
    await settle()

    r.gates[r.minted[1]]!(); await second
    r.gates[r.minted[0]]!(); await first

    // One repaint, for the one commit. The loser changed nothing, so announcing would ask the host
    // to redraw a board that cannot have changed.
    expect(seen).toEqual(['f'])
  })
})
