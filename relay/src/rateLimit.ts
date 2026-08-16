/** Fixed-window counter. Coarse on purpose — this is abuse control, not traffic shaping. */
export class RateLimiter {
  private buckets = new Map<string, { windowStart: number; count: number }>()
  private readonly perMinute: number
  private readonly now: () => number

  constructor(opts: { perMinute: number; now?: () => number }) {
    this.perMinute = opts.perMinute
    this.now = opts.now ?? Date.now
  }

  allow(key: string): boolean {
    const t = this.now()
    const b = this.buckets.get(key)
    if (!b || t - b.windowStart >= 60_000) {
      this.buckets.set(key, { windowStart: t, count: 1 })
      return true
    }
    if (b.count >= this.perMinute) return false
    b.count++
    return true
  }
}
