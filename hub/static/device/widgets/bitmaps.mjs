/**
 * The decoded-bitmap channel for an `image` WIDGET's feed payload (`ctx.bitmap`) — the counterpart
 * to `assets.mjs`'s `ctx.assets`, for a bitmap that arrives over the wire (a feed push) instead of
 * shipping inside a design's own folder.
 *
 * Modelled on `assets.mjs` on purpose, not reinvented (see that module's own docstring): LOADING
 * IS ASYNCHRONOUS AND `draw` IS NOT, so the same shape applies here — a feed's drawable is present
 * once decoded and simply ABSENT until then, or until the next successful decode if this one
 * failed. A finished decode ANNOUNCES itself (`onBitmapReady`) so the host can repaint the cell the
 * moment it lands; without that the decode would finish behind `draw`'s back — `draw` never awaits
 * anything — and the cell would sit on "loading image…" forever.
 *
 * Unlike `assets.mjs`, this module cannot fetch for itself. A design-shipped sprite is a public
 * static file; an image feed's bitmap lives behind `/api/feeds/:id/image`, gated by the device's
 * Bearer token — a credential only the host page holds. So every browser API this module would
 * otherwise reach for (`fetch`, an image decode, `URL.revokeObjectURL`, `Date.now`) is taken as
 * an injected `deps` argument instead of being baked in here. That is what lets this whole state
 * machine — including the failure/backoff/revocation rules below — be driven synchronously by a
 * Node test with no DOM at all (hub/test/widget-bitmaps.test.ts): the real wiring belongs at the
 * call site (device.js / widgets/index.mjs), never in this file.
 *
 * The five behaviours the DOM `<img>` branch this replaces (device.js's now-retired module-level
 * caches and `ensureImageLoaded`, ~lines 35-57 and ~291) guaranteed all survive here:
 *
 *   1. At most one live decoded bitmap per feed, keyed internally by `feedId:image_rev`.
 *   2. A new rev's successful decode REVOKES the previous one (`deps.revoke`) — a kiosk running
 *      for weeks must not leak every bitmap it ever showed. Two revs of one feed can be in flight
 *      at once (see the backoff rule below), so this is decided at COMMIT time against a fresh cache read: the
 *      loser of such a race revokes its own raw rather than displacing the winner.
 *   3. A failed fetch/decode KEEPS the last good bitmap cached, untouched.
 *   4. Failures back off a flat 30s, keyed by FEED rather than by `feedId:rev`: keying by feed
 *      means a NEW rev is retried immediately — a real recovery must not wait out a timer — while
 *      a hub restart or Wi-Fi blip does not turn every image cell into one failing request per
 *      render tick forever. `deps.now()` is an injected clock precisely so this window can be
 *      driven by hand in tests instead of real wall-clock waits.
 *   5. `image_rev === 0` means never pushed — that is not a failure, so it never fetches and never
 *      occupies the failure/backoff bookkeeping.
 */

/** feedId -> { key: "feedId:rev" of the cached bitmap, rev, raw, bitmap } — the current decoded
 * entry for a feed, if any. Only ever one entry per feed (the one-entry rule above). `rev` is carried alongside the
 * compound key because the commit path has to compare revisions NUMERICALLY (is what just decoded
 * older than what is already displayed?), and parsing that back out of the key would be a second
 * encoding of the same fact. */
const cache = new Map()

/** "feedId:rev" keys with a fetch/decode currently in flight, so a repeated call while one is
 * already running does not kick off a second one. */
const pending = new Set()

/** feedId -> { key, at } — the last key that failed for this feed and when (`deps.now()` at the
 * time), so a retry of the SAME key holds off for RETRY_MS while a different key (a new rev) goes
 * ahead immediately. See this module's backoff rule above. */
const failedAt = new Map()

const RETRY_MS = 30_000

/**
 * Called once whenever a bitmap finishes decoding. Single slot, like `assets.mjs`'s `onReady`:
 * there is one board, and a listener list would invite the leak of a screen that swapped out
 * without unsubscribing.
 */
let onReady = () => {}

/** Register what to do when a bitmap lands. Pass nothing to go back to doing nothing. */
export function onBitmapReady(fn) {
  onReady = typeof fn === 'function' ? fn : () => {}
}

function announce(feedId) {
  try {
    onReady(feedId)
  } catch (err) {
    // A failing repaint must not poison the cache entry that just succeeded.
    console.error('bitmap repaint failed', err)
  }
}

/**
 * Ensure `feedId`'s bitmap is decoded for `rev`, fetching/decoding through `deps` if needed.
 * Fire-and-forget from the caller's point of view — `draw` is synchronous, so nothing awaits this
 * directly; `bitmapFor` is how the result is read back, and `onBitmapReady` is how a caller learns
 * a decode it kicked off earlier has landed.
 *
 * `deps`: `{ fetchBlob(feedId), decode(raw), revoke(raw), now() }`. The device wires the real ones
 * in `bitmapDeps` (widgets/index.mjs); tests wire fakes so the state machine above runs with no
 * DOM (see this module's own docstring).
 *
 * NOTE WHAT `revoke` IS HANDED: `current.raw`, i.e. whatever `fetchBlob` RETURNED — never the
 * decoded drawable. The real pair is therefore an object URL in and `URL.revokeObjectURL` out. An
 * earlier draft of this comment named `createImageBitmap` as the real `decode`, which cannot be
 * squared with this line: that flow mints no object URL for `revoke` to release, and the
 * `ImageBitmap` that does hold the pixels only frees on `.close()` and never reaches `revoke` at
 * all — one leaked bitmap per revision on a panel that runs for weeks. See `bitmapDeps`.
 */
export async function loadBitmapFor(feedId, rev, deps) {
  if (!rev) return // image_rev 0 ⇒ never pushed, not a failure — never fetch

  const key = `${feedId}:${rev}`
  if (pending.has(key)) return

  const current = cache.get(feedId)
  if (current && current.key === key) return // already decoded and current — do not re-fetch

  const failed = failedAt.get(feedId)
  if (failed && failed.key === key && deps.now() - failed.at < RETRY_MS) return // within retry backoff

  pending.add(key)
  try {
    const raw = await deps.fetchBlob(feedId)
    const bitmap = await deps.decode(raw)

    /*
     * COMMIT AGAINST A FRESH READ OF THE CACHE, NOT `current`.
     *
     * `current` was read before the two awaits above and is a stale fact by the time they resolve.
     * `pending` is keyed `feedId:rev`, deliberately: a new rev must never wait behind an
     * old one), so two revs of the SAME feed can be in flight at once — and both continuations
     * would see the same pre-flight `current`. Committing against it means both `cache.set`, while
     * only one raw is ever revoked: the other is pinned for the life of the page, and an object URL
     * pins the whole Blob behind it. A feed pushed faster than fetch+decode completes (a camera
     * snapshot over slow Wi-Fi) leaks one full image per overlapping push.
     *
     * The DOM code this module replaced did NOT have this bug — `ensureImageLoaded` resolved
     * `imageKeyForFeed.get(feedId)` INSIDE its `.then`, i.e. at commit time — and device.js's
     * background-image loader still states the same rule explicitly (`if (bgPending !== key)
     * return // a newer revision won while this was in flight`). The explicit block keeps the
     * commit-time comparison visible rather than hiding it in a one-liner.
     */
    const displaced = cache.get(feedId)
    if (displaced && displaced.rev >= rev) {
      // A newer revision (or an identical one) committed while this was in flight, so what just
      // decoded is already obsolete. Release OUR raw — nothing else ever will, since it never
      // reaches the cache — and leave the winner's entry, its backoff state and its announcement
      // exactly as they are.
      deps.revoke(raw)
      return
    }
    // Revoke the displaced entry only once the new one has actually decoded — a failed decode
    // must leave the last good bitmap exactly as it was.
    if (displaced) deps.revoke(displaced.raw)
    cache.set(feedId, { key, rev, raw, bitmap })
    failedAt.delete(feedId) // recovered: the next failure starts a fresh backoff window
    announce(feedId)
  } catch {
    // Broken fetch/decode: the cache (if any) is untouched, and this key waits for RETRY_MS
    // instead of being retried on the very next call.
    failedAt.set(feedId, { key, at: deps.now() })
  } finally {
    pending.delete(key)
  }
}

/** The decoded drawable for `feedId` RIGHT NOW, or `null` if nothing has decoded yet (or ever). */
export function bitmapFor(feedId) {
  const entry = cache.get(feedId)
  return entry ? entry.bitmap : null
}

/**
 * Test-only: the cache/pending/backoff state is module-global, so suites must be able to start
 * clean. Not called from production code — nothing else needs to reset a live device's bitmap
 * cache mid-flight.
 */
export function resetBitmaps() {
  cache.clear()
  pending.clear()
  failedAt.clear()
  onReady = () => {}
}
