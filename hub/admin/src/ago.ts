/**
 * Short-form relative time — the "did my cron die?" / "how long has that been ringing?" glance.
 *
 * Lived in Feeds.tsx with a note that no shared helper existed yet. The alerts view is the second
 * page to want it, and the two must agree: "3h" on one page and "3 hours ago" on the other, for the
 * same instant, is the kind of small disagreement that makes an operator distrust both.
 */
export const ago = (ts: number | null): string => {
  if (ts === null) return 'never'
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000))
  if (s < 60) return 'just now'
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  const d = Math.floor(h / 24)
  return `${d}d`
}
