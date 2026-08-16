import { describe, expect, it } from 'vitest'
import { RateLimiter } from '../src/rateLimit.js'

describe('RateLimiter', () => {
  it('allows up to the limit then refuses', () => {
    let t = 0
    const rl = new RateLimiter({ perMinute: 3, now: () => t })
    expect([rl.allow('k'), rl.allow('k'), rl.allow('k')]).toEqual([true, true, true])
    expect(rl.allow('k')).toBe(false)
  })

  it('refills after the window', () => {
    let t = 0
    const rl = new RateLimiter({ perMinute: 2, now: () => t })
    rl.allow('k'); rl.allow('k')
    expect(rl.allow('k')).toBe(false)
    t += 60_001
    expect(rl.allow('k')).toBe(true)
  })

  it('keys are independent — one noisy hub cannot starve another', () => {
    let t = 0
    const rl = new RateLimiter({ perMinute: 1, now: () => t })
    expect(rl.allow('hub_a')).toBe(true)
    expect(rl.allow('hub_a')).toBe(false)
    expect(rl.allow('hub_b')).toBe(true)
  })
})
