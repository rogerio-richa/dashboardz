import { describe, expect, it, vi } from 'vitest'
import { openDb } from '../src/db/index.js'
import { getSetting, setSetting } from '../src/db/settings.js'
import { RelayClient, type RelaySocket } from '../src/relay/client.js'
import { getOrCreateIdentity } from '../src/relay/identity.js'
import { RELAY_TOKEN_SETTING, RELAY_URL_SETTING, RelayManager, testRelayUrl } from '../src/relay/manager.js'

class FakeSocket {
  sent: string[] = []
  closed = false
  onOpen?: () => void
  onMessage?: (raw: string) => void
  onClose?: (code?: number) => void
  onPong?: () => void
  send(d: string) { this.sent.push(d) }
  close() { this.closed = true; this.onClose?.() }
}

/** Manager wired the way bootstrap wires it, with recordable sockets and swallowed reconnects. */
const make = (db = openDb(':memory:'), envUrl: string | null = null) => {
  const sockets: FakeSocket[] = []
  const connect = vi.fn((_url: string) => { const s = new FakeSocket(); sockets.push(s); return s })
  const makeClient = vi.fn((url: string) => new RelayClient({
    url, identity: getOrCreateIdentity(db), onDeliver: vi.fn(),
    connect, schedule: () => {}, schedulePing: () => {},
  }))
  const manager = new RelayManager({ db, envUrl, makeClient, now: () => 1000 })
  return { db, manager, sockets, connect, makeClient }
}

describe('RelayManager initial URL precedence', () => {
  it('does nothing when neither DB setting nor env is set — and never touches relay_identity', () => {
    const { db, manager, connect } = make()
    expect(manager.status()).toBeNull()
    expect(connect).not.toHaveBeenCalled()
    expect(db.prepare('SELECT * FROM relay_identity').all()).toEqual([])
    expect(getSetting(db, RELAY_URL_SETTING)).toBeNull()
  })

  it('imports RELAY_URL into settings once, then connects', () => {
    const { db, manager, connect } = make(openDb(':memory:'), 'wss://relay.example/ws')
    expect(getSetting(db, RELAY_URL_SETTING)).toBe('wss://relay.example/ws')
    expect(connect).toHaveBeenCalledWith('wss://relay.example/ws')
    expect(manager.status()?.url).toBe('wss://relay.example/ws')
  })

  // A token row can only exist here if it was minted against a relay that had
  // a URL row which is since gone (a manual DB edit, or some other row-clearing path) — it was
  // never issued for whatever RELAY_URL now gets imported. Leaving it in place would send a
  // stale credential to a relay it doesn't belong to on the very first HELLO_HUB.
  it('importing RELAY_URL clears any token row already present — it was minted for a different relay', () => {
    const db = openDb(':memory:')
    setSetting(db, RELAY_TOKEN_SETTING, 'dzr_stale_token', 1)
    const { manager } = make(db, 'wss://relay.example/ws')
    expect(getSetting(db, RELAY_TOKEN_SETTING)).toBeNull()
    expect(manager.status()?.token_set).toBe(false)
  })

  it('a stored setting wins over the env var, which is ignored with a warning', () => {
    const db = openDb(':memory:')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    db.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('relay_url', 'wss://db.example/ws', 1)").run()
    const { manager, connect } = make(db, 'wss://env.example/ws')
    expect(connect).toHaveBeenCalledWith('wss://db.example/ws')
    expect(getSetting(db, RELAY_URL_SETTING)).toBe('wss://db.example/ws')
    expect(manager.status()?.url).toBe('wss://db.example/ws')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('RELAY_URL'))
    warn.mockRestore()
  })
})

describe('RelayManager runtime changes', () => {
  it('setUrl stops the old client, persists, and dials the new URL', () => {
    const { db, manager, sockets, connect } = make(openDb(':memory:'), 'wss://old.example/ws')
    manager.setUrl('wss://new.example/ws')
    expect(sockets[0].closed).toBe(true)
    expect(getSetting(db, RELAY_URL_SETTING)).toBe('wss://new.example/ws')
    expect(connect).toHaveBeenLastCalledWith('wss://new.example/ws')
    expect(manager.status()?.url).toBe('wss://new.example/ws')
  })

  it('setUrl with the SAME url still reconnects — the operator\'s "try again" after bad_secret', () => {
    const { manager, sockets } = make(openDb(':memory:'), 'wss://relay.example/ws')
    sockets[0].onClose?.(4401)   // terminal: client stops retrying
    expect(manager.status()?.terminal).toBe(true)
    manager.setUrl('wss://relay.example/ws')
    expect(sockets).toHaveLength(2)   // a fresh dial happened
    expect(manager.status()?.terminal).toBe(false)
  })

  it('clear stops the client and deletes the setting; status goes null', () => {
    const { db, manager, sockets } = make(openDb(':memory:'), 'wss://relay.example/ws')
    manager.clear()
    expect(sockets[0].closed).toBe(true)
    expect(getSetting(db, RELAY_URL_SETTING)).toBeNull()
    expect(manager.status()).toBeNull()
  })

  it('sendReply forwards to a ready client and no-ops with none', () => {
    const { manager, sockets } = make(openDb(':memory:'), 'wss://relay.example/ws')
    sockets[0].onOpen?.()
    sockets[0].onMessage?.(JSON.stringify({ type: 'READY' }))
    manager.sendReply('conn_1', 'payload')
    expect(sockets[0].sent.some((f) => JSON.parse(f).type === 'REPLY')).toBe(true)
    manager.clear()
    expect(() => manager.sendReply('conn_1', 'payload')).not.toThrow()
  })
})

describe('testRelayUrl', () => {
  const identity = { hubUid: 'hub_test', hubSecret: 's3cret' }
  const drive = () => {
    const sockets: FakeSocket[] = []
    const timers: (() => void)[] = []
    const p = testRelayUrl({
      url: 'wss://relay.example/ws', identity,
      connect: () => { const s = new FakeSocket(); sockets.push(s); return s },
      schedule: (_ms, fn) => { timers.push(fn) },
    })
    return { p, sockets, timers }
  }

  it('READY resolves ok and hangs up', async () => {
    const { p, sockets } = drive()
    sockets[0].onOpen?.()
    expect(JSON.parse(sockets[0].sent[0])).toMatchObject({ type: 'HELLO_HUB', hub_uid: 'hub_test' })
    sockets[0].onMessage?.(JSON.stringify({ type: 'READY' }))
    expect(await p).toEqual({ ok: true })
    expect(sockets[0].closed).toBe(true)
  })

  it('close 4401 is bad_secret', async () => {
    const { p, sockets } = drive()
    sockets[0].onClose?.(4401)
    expect(await p).toEqual({ ok: false, code: 'bad_secret' })
  })

  it('any other close is unreachable', async () => {
    const { p, sockets } = drive()
    sockets[0].onClose?.(1006)
    expect(await p).toEqual({ ok: false, code: 'unreachable' })
  })

  it('the timer fires timeout and tears the socket down', async () => {
    const { p, sockets, timers } = drive()
    timers[0]()
    expect(await p).toEqual({ ok: false, code: 'timeout' })
    expect(sockets[0].closed).toBe(true)
  })

  // edge case: `ws` throws SYNCHRONOUSLY out of its WebSocket constructor for some invalid URLs (e.g. a
  // fragment). test() must NEVER throw to the route — this contract means it resolves like
  // any other unreachable relay, not reject.
  it('a connect that throws synchronously resolves unreachable, never throws', async () => {
    const p = testRelayUrl({
      url: 'wss://relay.example/ws#frag', identity,
      connect: () => { throw new Error('ws: invalid url') },
      schedule: (_ms, fn) => { fn() },
    })
    await expect(p).resolves.toEqual({ ok: false, code: 'unreachable' })
  })

  it('settles exactly once — a close after READY does not change the result', async () => {
    const { p, sockets, timers } = drive()
    sockets[0].onOpen?.()
    sockets[0].onMessage?.(JSON.stringify({ type: 'READY' }))
    sockets[0].onClose?.(4401)
    timers[0]()
    expect(await p).toEqual({ ok: true })
  })
})
