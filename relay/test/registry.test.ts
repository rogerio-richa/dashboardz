import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Registry, type Sink } from '../src/registry.js'

const sink = (): Sink => ({ send: vi.fn() })

let r: Registry
beforeEach(() => { r = new Registry() })

describe('TOFU hub registration', () => {
  it('first registration wins and fixes the secret', () => {
    expect(r.registerHub('hub_a', 's3cret', sink())).toEqual({ ok: true })
    expect(r.isHubOnline('hub_a')).toBe(true)
  })

  it('reconnecting with the same secret is allowed', () => {
    const first = sink()
    r.registerHub('hub_a', 's3cret', first)
    r.detachHub('hub_a', first)
    expect(r.registerHub('hub_a', 's3cret', sink())).toEqual({ ok: true })
  })

  it('a wrong secret is refused and does not disturb the incumbent', () => {
    const incumbent = sink()
    r.registerHub('hub_a', 's3cret', incumbent)
    expect(r.registerHub('hub_a', 'guess', sink())).toEqual({ ok: false, reason: 'bad_secret' })
    // the impostor must not have taken over the routing slot
    expect(r.hubSink('hub_a')).toBe(incumbent)
    expect(r.isHubOnline('hub_a')).toBe(true)
  })

  it('the secret survives the hub going offline', () => {
    const first = sink()
    r.registerHub('hub_a', 's3cret', first)
    r.detachHub('hub_a', first)
    expect(r.isHubOnline('hub_a')).toBe(false)
    expect(r.registerHub('hub_a', 'guess', sink())).toEqual({ ok: false, reason: 'bad_secret' })
  })
})

describe('sender connections', () => {
  it('issues distinct conn ids and resolves them back', () => {
    const a = sink(); const b = sink()
    const ca = r.attachSender('hub_a', a)
    const cb = r.attachSender('hub_a', b)
    expect(ca).not.toBe(cb)
    expect(r.senderSink(ca)).toBe(a)
    expect(r.senderSink(cb)).toBe(b)
  })

  it('detached senders resolve to undefined', () => {
    const c = r.attachSender('hub_a', sink())
    r.detachSender(c)
    expect(r.senderSink(c)).toBeUndefined()
  })

  it('an unknown conn id is undefined, not a throw', () => {
    expect(r.senderSink('conn_nope')).toBeUndefined()
  })
})

describe('detach is identity-scoped', () => {
  it('a stale socket detaching does not evict the current one', () => {
    const oldSock = sink()
    r.registerHub('hub_a', 's3cret', oldSock)
    const newSock = sink()
    r.registerHub('hub_a', 's3cret', newSock)   // reconnect replaces
    r.detachHub('hub_a', oldSock)               // late close from the old socket
    // the live socket must survive — otherwise a slow disconnect kills a healthy reconnect
    expect(r.hubSink('hub_a')).toBe(newSock)
    expect(r.isHubOnline('hub_a')).toBe(true)
  })
})
