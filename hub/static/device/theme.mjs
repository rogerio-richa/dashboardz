// Device-side theme layer (theming: client cache). Plain ESM, no build step — this file is
// loaded directly by the browser, so it cannot import hub/src/themeDefaults.ts (TypeScript) even
// though the two describe the same board block. `fetch` and `now` are injected via a `deps`
// argument rather than read from the global scope, so the test suite needs no network and no
// timers (same shape device.js itself does not need, because device.js IS the browser entrypoint
// — this module exists to be unit-testable independent of it).
//
// Contract, shared with widgets/bitmaps.mjs (its cache/failedAt maps keep every rule below):
//  - cache by the compound `id:rev` key — an unchanged key never refetches, a changed key always does;
//  - render built-in defaults before the first successful fetch resolves — never a blank board;
//  - a failed fetch keeps the last good theme — the board never regresses on a network blip;
//  - flat 30s retry backoff, not the socket's doubling ladder — theme fetch failures are steady-state
//    on a kiosk that runs for weeks (a deleted theme, a revoked token), not a converging outage.

// This is the SAME board block as hub/src/themeDefaults.ts's BUILTIN_BOARD, duplicated because
// hub/static/ has no build step and cannot import TypeScript across that boundary. The two are
// pinned together by a `toEqual` test in hub/test/deviceTheme.test.ts — edit both or
// neither — the same rule that kept layout-core.mjs and its (now retired) Kotlin twin in step.
const INFO = '#4a90d9'
const WARN = '#f0a020'
const CRITICAL = '#e0323c'
const DIM = '#8a90a0'

export const BUILTIN_BOARD = Object.freeze({
  bg: '#0b0d12',
  surface: '#12141c',
  ink: '#e6e9f0',
  dim: DIM,
  accent: INFO,
  scrim: 0.5,
  info: INFO,
  warn: WARN,
  critical: CRITICAL,
  series: [INFO, WARN, CRITICAL, DIM],
})

// The SAME chrome map as hub/src/themeDefaults.ts's BUILTIN_CHROME, duplicated for the same
// no-build-step reason as BUILTIN_BOARD above, and pinned together by the same kind of `toEqual`
// test in hub/test/deviceTheme.test.ts. The tab bar has eleven :root custom properties; index.html
// tokenised that the board block does not drive.
export const BUILTIN_CHROME = Object.freeze({
  hairline: '#ffffff14',
  muted: '#a8adbd',
  chip: '#c0c5d0',
  border: '#2a2e38',
  surface_warn: '#141826',
  surface_critical: '#1a1216',
  takeover_bg: '#2a080c',
  takeover_meta: '#ff8a90',
  takeover_body: '#ffb4b8',
  takeover_hint_bg: '#1c202a',
  on_critical: '#fff',
})

// Board block -> CSS custom property mapping (theming: applying the board block), declared here
// and nowhere else — device.js calls applyBoardToCss with a generic setter rather than duplicating
// this table. Deliberately named differently on each side: the board block names colours for what
// they MEAN (`ink` = the text colour), the CSS properties for what they were called FIRST
// (`--text`, coined before the board block existed). `accent`, `scrim` and `series` have no entry
// here — they're consumed by canvas designs, the scrim layer and charts respectively, none of
// which read a CSS custom property today.
const BOARD_TO_CSS = {
  bg: '--bg',
  surface: '--card',
  ink: '--text',
  dim: '--dim',
  info: '--info',
  warn: '--warn',
  critical: '--critical',
}

// Chrome block -> CSS custom property mapping (tab-bar chrome), the same shape as BOARD_TO_CSS above.
// Snake_case chrome keys map onto the hyphenated CSS names tab-bar behavior already coined in index.html.
const CHROME_TO_CSS = {
  hairline: '--hairline',
  muted: '--muted',
  chip: '--chip',
  border: '--border',
  surface_warn: '--surface-warn',
  surface_critical: '--surface-critical',
  takeover_bg: '--takeover-bg',
  takeover_meta: '--takeover-meta',
  takeover_body: '--takeover-body',
  takeover_hint_bg: '--takeover-hint-bg',
  on_critical: '--on-critical',
}

/**
 * The SAME colour-literal shape widgets/tokens.mjs validates a token against, duplicated here for
 * the third time this file duplicates something across a boundary it cannot import over —
 * tokens.mjs does not export it, and it must not grow an export just for this (that file is the
 * canvas designs' resolution core and is off limits to this change). Pinned to tokens.mjs's copy
 * by a source-text `toBe` test in hub/test/themeApply.test.ts, the same way BUILTIN_BOARD is
 * pinned to its hub twin: edit both or neither. Deliberately NOT a second, laxer convention —
 * the two substitution points (this file's CSS properties, tokens.mjs's canvas slots) must agree
 * on what "a colour" is, or the same stored theme degrades differently depending on which widget
 * reads it.
 */
const COLOR_RE = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i
const isColor = (v) => typeof v === 'string' && COLOR_RE.test(v)

// ── Chrome derivation ─────────────────────────────────────────────────────────────────────────
//
// BUILTIN_CHROME is a hardcoded DARK map, so a theme that authors just its palette would render as
// a light board wearing dark-theme furniture: `hairline`
// white at 8% (invisible on cream), `border` dark slate. Every theme therefore had to hand-author
// colours it should never have needed to, and any user who edited only the palette got a broken
// board. That is the single biggest obstacle to "a few good themes, then let people customise".
//
// So chrome is DERIVED from the palette, and an explicit chrome map stays as an escape hatch
// nobody should need. Hex in, hex out — COLOR_RE above is the only literal shape both substitution
// points accept, so a derived value has to be one too.

const hex2 = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0')

/** #rgb / #rrggbb / #rrggbbaa -> [r,g,b], or null for anything that is not a colour. */
function rgbOf(c) {
  if (!isColor(c)) return null
  let h = c.slice(1)
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2]
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
}

/** `a` moved `t` of the way toward `b`. Plain sRGB: these are UI tints, not gradients. */
function mix(a, b, t) {
  const x = rgbOf(a), y = rgbOf(b)
  if (!x || !y) return null
  return '#' + x.map((v, i) => hex2(v + (y[i] - v) * t)).join('')
}

/** `c` at the given alpha, as the 8-digit hex both substitution points already accept. */
function alpha(c, a) {
  const x = rgbOf(c)
  if (!x) return null
  return '#' + x.map(hex2).join('') + hex2(a * 255)
}

/** Rec.709 relative luminance, for the one contrast decision (`on_critical`). */
function luminance(c) {
  const x = rgbOf(c)
  if (!x) return 0
  const [r, g, b] = x.map((v) => v / 255)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/**
 * Every chrome key as a function of the palette. Each returns null when its inputs are not
 * colours, and the caller then falls back to BUILTIN_CHROME — so a corrupt board degrades to
 * today's dark furniture rather than to nothing.
 */
const CHROME_FROM_BOARD = Object.freeze({
  hairline: (b) => alpha(b.ink, 0.08),
  muted: (b) => mix(b.ink, b.bg, 0.30),
  chip: (b) => mix(b.ink, b.bg, 0.18),
  border: (b) => mix(b.surface, b.ink, 0.12),
  surface_warn: (b) => mix(b.surface, b.warn, 0.10),
  surface_critical: (b) => mix(b.surface, b.critical, 0.10),
  takeover_bg: (b) => mix(b.bg, b.critical, 0.28),
  takeover_meta: (b) => mix(b.critical, b.ink, 0.55),
  takeover_body: (b) => mix(b.critical, b.ink, 0.72),
  takeover_hint_bg: (b) => mix(b.surface, b.ink, 0.06),
  // The one decision that is not a blend: text ON the critical colour has to survive both a dark
  // red and a bright amber.
  on_critical: (b) => (luminance(b.critical) > 0.5 ? '#000000' : '#ffffff'),
})

/**
 * PROCEDURAL BACKDROPS.
 *
 * A backdrop is a NAME, and the renderer turns it into CSS derived from the theme's own palette.
 * Declarative rather than drawing code, deliberately: the portable renderer emits gradients from
 * the palette,
 * so a canvas backdrop would either violate it or be forced into banded fillRect loops. It does
 * not need to be drawing code — the board is a web page on every platform (web-renderer boundary), so the web
 * renderer emits CSS and a firmware port renders the same NAME its own way. Nothing enters `g`.
 *
 * Built-in themes ship no image files at all: change a palette colour and the backdrop follows,
 * with nothing to license, decode, or serve. A user-uploaded image still paints OVER this
 * (bg_kind/bg_color), which is why the two are separate fields.
 *
 * Unknown names fall back to `flat` — a client older than a backdrop must render a plain board,
 * never a blank one. Same degradation rule as an unknown design id.
 */
const BACKDROPS = Object.freeze({
  flat: (b) => b.bg,
  // A soft diagonal lift toward the card colour: light themes read as paper, dark as depth.
  wash: (b) => `linear-gradient(160deg, ${b.bg} 0%, ${mix(b.bg, b.surface, 0.6) ?? b.bg} 100%)`,
  // Accent bloom from the lower left plus an edge vignette. 6% keeps it atmosphere, not decoration.
  glow: (b) => [
    `radial-gradient(120% 90% at 18% 88%, ${alpha(b.accent, 0.16) ?? 'transparent'} 0%, transparent 62%)`,
    `radial-gradient(140% 120% at 50% 45%, transparent 55%, ${alpha(b.ink, 0.05) ?? 'transparent'} 100%)`,
    b.bg,
  ].join(', '),
  // Plain bg like `flat` — the kind exists for its side effect: the device page mirrors the
  // active backdrop name onto `body[data-backdrop]`, and a CSS rule keyed on `cards` gives every
  // cell a `surface` background and a `border` outline (the paper-dashboard look). Card styling
  // rides the backdrop name rather than a new chrome key because backdrop is already the one
  // free-string, degrade-to-flat channel a theme has: a client older than this name paints a
  // plain flat board with transparent cells, exactly the pre-cards look.
  cards: (b) => b.bg,
  // A hairline lattice. 40px is small enough to read as texture and large enough not to moire on
  // a low-density panel.
  grid: (b) => [
    `repeating-linear-gradient(0deg, ${alpha(b.ink, 0.045) ?? 'transparent'} 0 1px, transparent 1px 40px)`,
    `repeating-linear-gradient(90deg, ${alpha(b.ink, 0.045) ?? 'transparent'} 0 1px, transparent 1px 40px)`,
    b.bg,
  ].join(', '),
})

/** The `background` value for a board, or the plain bg colour when anything is unusable. */
export function backdropCss(board, backdrop) {
  const bg = isColor(board?.bg) ? board.bg : BUILTIN_BOARD.bg
  const make = BACKDROPS[backdrop] ?? BACKDROPS.flat
  try {
    const css = make({ ...board, bg })
    return typeof css === 'string' && css.length > 0 ? css : bg
  } catch {
    // A backdrop is decoration; it must never be the reason a board fails to paint.
    return bg
  }
}

/** Names a client can render, for the admin to offer. */
export const BACKDROP_NAMES = Object.freeze(Object.keys(BACKDROPS))

/**
 * The chrome a board implies, for callers that want it without touching CSS (the hub seeds themes
 * with it; tests assert it). Explicit overrides win, then derivation, then the built-in.
 */
export function derivedChrome(board, overrides) {
  const out = {}
  for (const key of Object.keys(BUILTIN_CHROME)) {
    const override = overrides?.[key]
    if (isColor(override)) { out[key] = override; continue }
    const derived = board ? CHROME_FROM_BOARD[key](board) : null
    out[key] = isColor(derived) ? derived : BUILTIN_CHROME[key]
  }
  return out
}

/**
 * Drives the board block onto the page's CSS custom properties — the substitution point for the
 * eight widgets that are still DOM (index.html's :root block). Takes a setter rather than
 * touching `document` itself so it is unit-testable without a DOM, the same reason `noteThemeRef`
 * takes an injected `fetchFn`/`now` rather than reading globals. device.js supplies
 * `(k, v) => document.documentElement.style.setProperty(k, v)`.
 *
 * Falls back to `BUILTIN_BOARD[blockKey]` when the fetched board omits a key or when it
 * holds something that is not a colour literal.
 * Nothing upstream guarantees either: `isValidDocument` only requires `board` to be an object,
 * and the admin API's own board schema typed these as bare strings without the `pattern`, so a hub
 * that predates that validation can still be holding `ink: "not-a-colour"`.
 * Writing that straight through sets e.g. `--text: not-a-colour`, which is invalid at
 * computed-value time and drops the WHOLE property to its initial value (transparent/black) —
 * strictly worse than never theming at all, and on a kiosk running unattended for weeks it is a
 * stored, persistent break rather than a transient one. `undefined` behaves identically, hence
 * one guard covering both. Every neighbouring layer already defends against exactly this shape
 * of bad value (tokens.mjs's `valid`/`LAST_RESORT`, the hub's own `themeDocument` degrading to
 * `BUILTIN_BOARD`) — this closes the one spot that didn't.
 */
export function applyBoardToCss(board, setProp) {
  for (const [blockKey, cssProp] of Object.entries(BOARD_TO_CSS)) {
    const value = board?.[blockKey]
    setProp(cssProp, isColor(value) ? value : BUILTIN_BOARD[blockKey])
  }
}

/**
 * Drives the optional chrome map onto the same CSS custom properties (tab-bar chrome) — the eleven
 * :root variables index.html tokenised that the board block does not reach. Every theme's chrome
 * is optional and may set any subset of the eleven keys, so this applies the SAME per-key
 * fallback-and-validate rule applyBoardToCss applies to the board, for the identical reason: an
 * absent or non-colour value written onto a CSS custom property is invalid at computed-value
 * time and drops that property to its initial value, strictly worse than never theming it. A
 * theme with no chrome at all (an empty map, or a document from before chrome existed) therefore
 * reproduces exactly today's CSS values — chrome is additive, never a regression.
 *
 * `board` is consulted for every key: CHROME_FROM_BOARD derives each one from the palette, and an
 * explicit chrome override wins over that derivation — see derivedChrome.
 */
export function applyChromeToCss(chrome, board, setProp) {
  // Derivation replaces the old per-key fallback to a hardcoded DARK map — see CHROME_FROM_BOARD.
  // An explicit override still wins, so a theme that wants a specific hairline still gets it.
  const resolved = derivedChrome(board, chrome)
  for (const [chromeKey, cssProp] of Object.entries(CHROME_TO_CSS)) {
    setProp(cssProp, resolved[chromeKey])
  }
}

const RETRY_MS = 30_000

// Last good theme, memory-only (mirrors `feeds` in device.js — never cleared just because a
// fetch failed, so a reconnect/reload never flashes blank). `null` board/widgets means
// "nothing fetched yet or fetch never succeeded" and currentBoard()/currentWidgets() fall back
// to the built-ins in that case — the board itself is never left blank.
let board = null
let widgets = null
// The most recently fetched theme's chrome override map (tab-bar chrome), or `null` for "nothing
// fetched yet" — same null-means-unfetched shape as `board`/`widgets`. Unlike `board` (which a
// fetched document must always supply in full), a fetched chrome may be a partial or empty
// object; that raw value is what currentChrome() returns, and per-key fallback to BUILTIN_CHROME
// happens downstream in applyChromeToCss — mirroring how `widgets` is never merged with a
// built-in here either.
let chrome = null
// The fetched theme's procedural backdrop name (v10), or null for "nothing fetched yet".
let backdrop = null
// The fetched theme's background-image descriptor: { kind, color, rev }, or null before any fetch.
let bgRef = null
// The `id:rev` key the CURRENT board/widgets came from, so an unchanged ref is a no-op.
let currentKey = null
// Keys currently in flight, so a second call for a key already being fetched does not fire a
// duplicate request. A Set (not a single scalar), same as device.js's imagePending — a scalar
// would get clobbered if two different keys were ever in flight at once (e.g. a fast double rev
// bump before the first fetch settles), silently breaking the dedup guard for the older one.
const pendingKeys = new Set()
// Last failed key + when, so a failing fetch is retried at most once per RETRY_MS rather than on
// every call — same shape as bitmaps.mjs's own failedAt map, same reasoning: a hub restart or Wi-Fi
// blip must not turn into a hot retry loop on a kiosk that stays up for weeks.
let failedKey = null
let failedAt = -Infinity
// The key the MOST RECENT call to noteThemeRef asked for (or `null` for "no theme"), updated
// synchronously at the top of every call regardless of what that call does next. This is what a
// fetch started by an EARLIER call checks against once it resolves: a
// STATE message that supersedes an in-flight fetch — with a different theme, or none at all —
// must win immediately and synchronously, not get overwritten later when the stale fetch finally
// settles. Without this, an unassigned/changed theme keeps painting the old one until the next
// STATE happens to arrive.
let desiredKey = null

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

// Validate a fetched document's shape before adopting it: an object with an object `board`.
// Anything else (network 200 with a garbage body, a truncated response, etc.) is ignored and
// the previous board stands — the same "bad data must never corrupt a read path" rule the hub
// side applies in themeDocument().
function isValidDocument(doc) {
  return isPlainObject(doc) && isPlainObject(doc.board)
}

/**
 * The current board block with every COLOUR key guaranteed present and renderable: the fetched
 * theme's value wherever that value can actually render, the built-in wherever it cannot (fix
 * the fallback.
 *
 * This is what makes the two substitution points degrade the SAME way, which is the actual bug.
 * applyBoardToCss has always fallen back per key, but the OTHER consumer — paintWidgets handing
 * this object straight to resolveTokens as the `@palette` source — has no such rule available to
 * it: tokens.mjs resolves an `@ink` default against this object and, when nothing usable,
 * lands on its `LAST_RESORT` of `#000000`. So the same stored theme rendered differently
 * depending on which half of the renderer read it:
 *   - a partial board `{bg, ink}` painted a digital clock's date slot BLACK ON A BLACK BOARD,
 *     while CSS correctly showed the built-in `--dim`;
 *   - a board holding `ink: "not-a-colour"` did the mirror-image thing.
 * Both are "a value this key cannot be rendered from"; they differ only in whether the key is
 * absent or present-and-garbage, which is an accident of how it got stored, not a distinction any
 * renderer should act on. Hence one rule for both: a colour key survives only if it IS a colour.
 *
 * COLOUR keys only, and that restriction is load-bearing. Seeding the merge with
 * the WHOLE built-in board — the obvious way to write this — regressed charts: `series` is an
 * OPTIONAL ramp whose absence means "fall back to this board's own info/warn/critical/dim", but a
 * blanket merge filled it with BUILTIN_BOARD's literal ramp, so `themeSeriesRamp` never saw
 * "absent" in production and that fallback became unreachable.
 * A theme that recoloured info/warn/critical/dim but declared no `series` then painted its charts
 * in the BUILT-IN colours — on a light theme, `#8a90a0` on `#fafafa`, the same kind of washed-out
 * failure a merged chrome default would cause. An absent key only means "use the built-in" for keys that are
 * mandatory; `series` and `scrim` are optional, their absence is meaningful, and their consumers
 * (`themeSeriesRamp`/`builtinRamp` in widgets/tokens.mjs, which together build `ctx.ramp`; the
 * scrim layer, not built yet) are the ones that own that meaning. Do not "simplify" this to a plain
 * spread of BUILTIN_BOARD.
 *
 * Doing it here rather than in each caller fixes every present and future canvas consumer at once
 * and needs no change to tokens.mjs, whose LAST_RESORT stays exactly what it was for — a design
 * whose OWN literal default is malformed. applyBoardToCss keeps its own per-key fallback as
 * defence for the direct callers (and the tests) that never go through this function.
 *
 * NOT mirrored in currentChrome(): see that function's comment — chrome is a genuinely partial
 * override map whose only consumer already falls back per key, and merging it there would defeat
 * derivation by making every chrome key always present.
 */
export function currentBoard() {
  if (!board) return BUILTIN_BOARD
  // Floor: the built-in COLOUR keys only. Non-colour keys (`series`, `scrim`) are never
  // defaulted in — see the paragraph above; they appear below only if the theme itself sets them.
  const merged = Object.fromEntries(Object.entries(BUILTIN_BOARD).filter(([, v]) => typeof v === 'string'))
  for (const [key, value] of Object.entries(board)) {
    // Only keys whose BUILT-IN is a colour string are colour-checked; everything else (scrim,
    // series, and any key a future hub adds that this device predates) passes through.
    if (typeof BUILTIN_BOARD[key] === 'string' && !isColor(value)) continue
    merged[key] = value
  }
  return merged
}

/**
 * The theme's per-widget-type DESIGN choice: `{ clock: 'segment' }` (v11). A theme names geometry;
 * colour comes from the palette, because every design's slots already default to a board colour.
 */
export function currentWidgets() {
  return widgets ?? {}
}

/**
 * The current theme's raw chrome override map — possibly partial, possibly `{}`, never merged
 * with BUILTIN_CHROME here (see the `chrome` slot's comment above; applyChromeToCss does that
 * merge per key). Falls back to the FULL BUILTIN_CHROME only in the "nothing fetched yet" case.
 *
 * Deliberately NOT given currentBoard()'s merge. The merge exists there
 * because the board has a second consumer — the canvas designs' `@palette` lookup — that cannot
 * fall back per key; chrome has exactly one consumer, applyChromeToCss, which already does.
 * Merging here would additionally break derivation: every chrome key would always be present, so
 * a theme that recolours its board and sets no chrome would never reach CHROME_FROM_BOARD and
 * would keep wearing whatever furniture got merged in instead. "Raw override map, defaults
 * applied at the point of use" is the contract here, and it is load-bearing.
 */
/**
 * The backdrop the current theme asks for, or 'flat' before anything has been fetched — a board
 * with no theme paints its plain background, exactly as it does today.
 */
export function currentBackdrop() {
  return typeof backdrop === 'string' ? backdrop : 'flat'
}

/**
 * The theme's background IMAGE descriptor — `{ kind, color, rev }` — or null when no theme is
 * loaded. `kind === 'image'` means bytes exist at /api/themes/<id>/bg; `rev` is the cache key, so
 * a re-upload changes it and the device refetches.
 *
 * Separate from the procedural backdrop on purpose: an image paints OVER it, so a theme can have
 * both and a theme with no image still gets its glow.
 */
export function currentBg() {
  return bgRef
}

/** The id of the theme currently loaded, so a caller can build its bg URL. */
export function currentThemeId() {
  return typeof currentKey === 'string' ? currentKey.split(':')[0] : null
}

export function currentChrome() {
  return chrome ?? BUILTIN_CHROME
}

/**
 * Called with the theme ref off the current STATE message (`{id, rev} | null`) plus
 * injected `{ fetchFn, now }`. Fetches `/api/themes/:id` at most once per distinct `id:rev` key,
 * and at most once per RETRY_MS while that key keeps failing. Resolves once the fetch (or the
 * decision to skip it) settles, so tests can `await` it instead of needing fake timers.
 */
export async function noteThemeRef(ref, deps) {
  const { fetchFn, now } = deps
  // Recorded before anything else, synchronously, so a call that runs to completion entirely
  // synchronously (the `!ref` branch below, or any of the early returns) still leaves the right
  // "what's currently wanted" marker for an OLDER in-flight fetch to check against later.
  const key = ref ? `${ref.id}:${ref.rev}` : null
  desiredKey = key

  if (!ref) {
    // No theme assigned (or the reference is otherwise absent) — fall back to built-in defaults.
    // This does not touch failedKey/failedAt: a later reappearance of the SAME failing key should
    // still honour its own backoff window rather than getting a free immediate retry.
    board = null
    widgets = null
    chrome = null
    backdrop = null
    bgRef = null
    currentKey = null
    return
  }

  if (key === currentKey) return // already showing this exact theme
  if (pendingKeys.has(key)) return // a fetch for this key is already in flight

  if (key === failedKey && now() - failedAt < RETRY_MS) return // recent failure, still backing off

  pendingKeys.add(key)
  try {
    const res = await fetchFn(`/api/themes/${ref.id}`)
    if (!res.ok) throw new Error(`theme fetch ${res.status}`)
    const doc = await res.json()
    if (!isValidDocument(doc)) throw new Error('malformed theme document')

    // Stale-fetch guard: a later call already changed what should be
    // showing — either a different theme or none — while this fetch was in flight. Applying this
    // result now would resurrect a theme that was deliberately superseded. `pendingKeys` still
    // gets cleaned up in `finally` below; only the board/widgets/currentKey write is skipped.
    if (key !== desiredKey) return

    board = doc.board
    widgets = isPlainObject(doc.widgets) ? doc.widgets : {}
    chrome = isPlainObject(doc.chrome) ? doc.chrome : {}
    backdrop = typeof doc.backdrop === 'string' ? doc.backdrop : 'flat'
    bgRef = isPlainObject(doc.bg) ? doc.bg : null
    currentKey = key
    failedKey = null
    failedAt = -Infinity
  } catch {
    // Last good theme (if any) stays on screen (contract) and this key is parked for RETRY_MS.
    // Recorded even if `key` is no longer desired: the failure is real regardless of what's
    // currently showing, and remembering it avoids a hot retry loop if this key becomes desired
    // again inside the backoff window.
    failedKey = key
    failedAt = now()
  } finally {
    pendingKeys.delete(key)
  }
}

// Test-only reset (mirrors the `_reset` shape other device.js-adjacent modules export) — clears
// every module-level cache slot back to "nothing fetched yet" between test cases.
export function _reset() {
  board = null
  widgets = null
  chrome = null
  backdrop = null
  bgRef = null
  currentKey = null
  pendingKeys.clear()
  failedKey = null
  failedAt = -Infinity
  desiredKey = null
}
