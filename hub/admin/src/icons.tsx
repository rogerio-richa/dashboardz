/**
 * The console's icons: line art, `currentColor`, no fill.
 *
 * Not emoji. Colour emoji are by construction the most saturated thing on a monochrome bench, and
 * this console reserves colour for themes and severity (see styles.css). They also cannot invert:
 * the active tab is solid ink, and an emoji sitting on it stays whatever colour the font decided.
 * `currentColor` follows the text, so one icon works on paper and on ink.
 *
 * Drawn rather than picked from a font, for the reason the orientation glyph proved twice over:
 * font coverage is not something to bet a UI on. U+25AD had a glyph in the system stack and U+25AF
 * did not, so one of a matched pair rendered as tofu.
 *
 * 16x16, 1.5px stroke, round joins — one geometry for the set, so they read as a family.
 */
const base = {
  width: 14,
  height: 14,
  viewBox: '0 0 16 16',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
  focusable: false,
}

/** A handset: the thing on the wall. */
export const IconDevices = () => (
  <svg {...base}><rect x="5" y="1.5" width="6" height="13" rx="1.5" /><path d="M7 12.4h2" /></svg>
)

/** A layout — one big region and two small, which is what a screen actually is. */
export const IconScreens = () => (
  <svg {...base}>
    <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
    <path d="M9 2.5v11M9 8h5.5" />
  </svg>
)

/** The parts a layout is made of. */
export const IconWidgets = () => (
  <svg {...base}>
    <rect x="2" y="2" width="5" height="5" rx="1" />
    <rect x="9" y="2" width="5" height="5" rx="1" />
    <rect x="2" y="9" width="5" height="5" rx="1" />
    <rect x="9" y="9" width="5" height="5" rx="1" />
  </svg>
)

/** Data arriving — the broadcast arcs everyone already reads as a feed. */
export const IconFeeds = () => (
  <svg {...base}>
    <circle cx="3.5" cy="12.5" r="1.1" fill="currentColor" stroke="none" />
    <path d="M2.5 8.5a5.5 5.5 0 0 1 5 5" />
    <path d="M2.5 4.5a9.5 9.5 0 0 1 9 9" />
  </svg>
)

/** Half light, half dark: the appearance control, and the only icon that IS its own subject. */
export const IconThemes = () => (
  <svg {...base}>
    <circle cx="8" cy="8" r="6" />
    <path d="M8 2a6 6 0 0 0 0 12z" fill="currentColor" stroke="none" />
  </svg>
)

/** Something being sent. */
export const IconSenders = () => (
  <svg {...base}><path d="M14.5 1.5 9.5 14.5 7 9 1.5 6.5z" /><path d="M14.5 1.5 7 9" /></svg>
)

/** A key: what an agent token is — found by silhouette like every other tab icon. */
export const IconAgents = () => (
  <svg {...base}><circle cx="5" cy="8" r="2.5" /><path d="M7.5 8h6M11 8v2.5M13.5 8v2" /></svg>
)

/** A trace — what happened, over time. */
export const IconActivity = () => (
  <svg {...base}><path d="M1.5 8.5h3l2-5 3 9.5 2-4.5h3" /></svg>
)

/**
 * A bell, clapper and all. The one thing in this console that is still making noise somewhere in
 * the house, so it is drawn as the object that makes it rather than as a warning triangle — the
 * triangle is severity's shape, and severity here is a word with a colour, not an icon.
 */
export const IconAlerts = () => (
  <svg {...base}>
    <path d="M4 7a4 4 0 0 1 8 0c0 2.8 1 4 1 4H3s1-1.2 1-4" />
    <path d="M6.6 13a1.5 1.5 0 0 0 2.8 0" />
  </svg>
)

/**
 * Orientation, as the shape itself rather than a device that happens to be that shape.
 *
 * The same rectangle turned ninety degrees — pinned by a test asserting the width and height swap,
 * because this took three attempts: a monitor and a phone said "desktop vs mobile" (the wrong
 * axis), and the geometric rectangles were at the mercy of font coverage.
 */
export function OrientationIcon({ orientation }: { orientation: 'landscape' | 'portrait' }) {
  const landscape = orientation === 'landscape'
  const w = landscape ? 17 : 11
  const h = landscape ? 11 : 17
  return (
    <svg width="18" height="18" viewBox="0 0 20 20" role="img" aria-label={orientation}
      style={{ display: 'block', margin: '0 auto', color: 'var(--ink-soft)' }}>
      <rect x={(20 - w) / 2} y={(20 - h) / 2} width={w} height={h} rx="2"
        fill="none" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  )
}

/** Add. */
export const IconPlus = () => (
  <svg {...base}><path d="M8 3v10M3 8h10" /></svg>
)

/** Save — the floppy everyone still reads as "write this down", whatever they last saw one in. */
export const IconSave = () => (
  <svg {...base}>
    <path d="M2.5 3.5a1 1 0 0 1 1-1h7.6l2.4 2.4v7.6a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1z" />
    <path d="M5 2.5v4h6v-4M5 13.5v-4h6v4" />
  </svg>
)

/**
 * A placement preset, drawn as what it means: the board, with the region the preset fills.
 *
 * Generated from the preset's own rect rather than hand-drawn, so the picture cannot disagree with
 * the value — add a preset to the list and its icon exists. Fourteen text buttons said "quad TL"
 * and left you to picture it; this shows it.
 */
export function PresetIcon({ rect }: { rect: { x: number; y: number; w: number; h: number } }) {
  const W = 26, H = 17, pad = 0.75
  const iw = W - pad * 2, ih = H - pad * 2
  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} aria-hidden focusable="false">
      <rect x={pad} y={pad} width={iw} height={ih} rx="1.5"
        fill="none" stroke="currentColor" strokeWidth="1" opacity="0.35" />
      <rect x={pad + rect.x * iw} y={pad + rect.y * ih} width={rect.w * iw} height={rect.h * ih}
        rx="1" fill="currentColor" />
    </svg>
  )
}

/** Reload — the near-full circular arrow every browser toolbar taught. */
export const IconReload = () => (
  <svg {...base}>
    <path d="M13.5 8a5.5 5.5 0 1 1-1.61-3.89" />
    <path d="M13.5 1.6v2.9h-2.9" />
  </svg>
)

/** Pause — two bars, the tape-deck vocabulary. */
export const IconPause = () => (
  <svg {...base}><path d="M5.5 3v10M10.5 3v10" /></svg>
)

/** Resume — the matching play triangle. */
export const IconPlay = () => (
  <svg {...base}><path d="M5 3l7.5 5L5 13z" /></svg>
)

/** Edit. */
export const IconEdit = () => (
  <svg {...base}><path d="M11.5 2.5 13.5 4.5 5.5 12.5 2.5 13.5 3.5 10.5z" /></svg>
)

/** Delete. */
export const IconTrash = () => (
  <svg {...base}>
    <path d="M2.5 4.5h11M6 4.5V2.8a.8.8 0 0 1 .8-.8h2.4a.8.8 0 0 1 .8.8v1.7" />
    <path d="M4 4.5l.6 8.2a.9.9 0 0 0 .9.8h5a.9.9 0 0 0 .9-.8L12 4.5" />
  </svg>
)

/** A stacked disk — the shape everyone already reads as "storage", drawn as three plates so it reads as a pool rather than a single flat file. */
export const IconStorage = () => (
  <svg {...base}>
    <ellipse cx="8" cy="3.6" rx="5.5" ry="2" />
    <path d="M2.5 3.6v8.8c0 1.1 2.46 2 5.5 2s5.5-.9 5.5-2V3.6" />
    <path d="M2.5 8c0 1.1 2.46 2 5.5 2s5.5-.9 5.5-2" />
  </svg>
)

/** Inspect — an eye: look at what this feed is actually holding. */
export const IconInspect = () => (
  <svg {...base}>
    <path d="M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8s-2.5 4.5-6.5 4.5S1.5 8 1.5 8z" />
    <circle cx="8" cy="8" r="2" />
  </svg>
)

/** Duplicate — a copy laid over its original. */
export const IconCopy = () => (
  <svg {...base}>
    <rect x="5.5" y="5.5" width="8" height="8" rx="1.2" />
    <path d="M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2" />
  </svg>
)
