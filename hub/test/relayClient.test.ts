import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RelayEvent } from '../src/relay/client.js'
import { RelayClient } from '../src/relay/client.js'

/**
 * Stands in for a socket so reconnect timing is deterministic.
 *
 * onClose takes an optional numeric close code because the relay (relay/src/protocol.ts)
 * distinguishes reasons via the real WebSocket close code, not a message frame — e.g.
 * CLOSE_BAD_SECRET (4401) and CLOSE_SUPERSEDED (4409) are both raw `socket.close(code, reason)`
 * calls with no accompanying ERROR frame (see relay/src/socket.ts). A client that can't see the
 * code can't tell "this uid belongs to someone else" from "I just got Replaced by my own
 * reconnect" — the exact distinction this test file exists to enforce.
 */
class FakeSocket {
  sent: string[] = []
  pings = 0
  onOpen?: () => void
  onMessage?: (raw: string) => void
  onClose?: (code?: number) => void
  onPong?: () => void
  closed = false
  send(d: string) { this.sent.push(d) }
  close() { this.closed = true; this.onClose?.() }
  ping() { this.pings++ }
  parsed() { return this.sent.map((s) => JSON.parse(s)) }
}

let sockets: FakeSocket[]
let delays: number[]
let pending: (() => void)[]
// The heartbeat's own schedule seam, kept separate from `delays`/`pending` above so a ping tick
// (which reaching 'ready' always schedules) never interleaves into the backoff tests' exact
// recorded-delay assertions.
let pingDelays: number[]
let pingPending: (() => void)[]
const identity = { hubUid: 'hub_test', hubSecret: 's3cret' }

const make = (onDeliver = vi.fn(), random: () => number = () => 1) => {
  sockets = []; delays = []; pending = []; pingDelays = []; pingPending = []
  const client = new RelayClient({
    url: 'wss://relay.example/ws',
    identity,
    onDeliver,
    random,                                            // pin jitter
    schedule: (ms, fn) => { delays.push(ms); pending.push(fn) },
    schedulePing: (ms, fn) => { pingDelays.push(ms); pingPending.push(fn) },
    connect: () => { const s = new FakeSocket(); sockets.push(s); return s },
  })
  return { client, onDeliver }
}
const runScheduled = () => pending.shift()?.()
const runPing = () => pingPending.shift()?.()

beforeEach(() => { sockets = []; delays = []; pending = []; pingDelays = []; pingPending = [] })

describe('RelayClient', () => {
  it('sends HELLO_HUB on open and becomes ready on READY', () => {
    const { client } = make()
    client.start()
    const s = sockets[0]
    s.onOpen?.()
    expect(s.parsed()[0]).toEqual({ type: 'HELLO_HUB', hub_uid: 'hub_test', secret: 's3cret' })
    expect(client.state).toBe('connecting')
    s.onMessage?.(JSON.stringify({ type: 'READY' }))
    expect(client.state).toBe('ready')
  })

  it('hands DELIVER frames to onDeliver with the conn id', () => {
    const { client, onDeliver } = make()
    client.start(); sockets[0].onOpen?.()
    sockets[0].onMessage?.(JSON.stringify({ type: 'READY' }))
    sockets[0].onMessage?.(JSON.stringify({ type: 'DELIVER', conn_id: 'conn_1', payload: 'Y2lwaGVy' }))
    expect(onDeliver).toHaveBeenCalledWith('conn_1', 'Y2lwaGVy')
  })

  it('reconnects with growing backoff, and a READY resets it', () => {
    const { client } = make()
    client.start()
    sockets[0].onClose?.()
    expect(delays).toEqual([1000])
    runScheduled()
    sockets[1].onClose?.()
    expect(delays).toEqual([1000, 2000])
    runScheduled()
    sockets[2].onOpen?.(); sockets[2].onMessage?.(JSON.stringify({ type: 'READY' }))
    sockets[2].onClose?.()
    expect(delays).toEqual([1000, 2000, 1000])   // reset only after a real READY
  })

  // This is the curve, not just "a reconnect eventually happens": a fixed 1s retry would fail
  // at the second entry (2000 expected), and a missing cap would fail at the seventh (60000
  // expected, not 64000). random is pinned to 1 so the delay equals the raw ceiling exactly.
  it('backoff doubles each attempt and caps at 60s', () => {
    const { client } = make()
    client.start()
    for (let i = 0; i < 7; i++) { sockets.at(-1)!.onClose?.(); runScheduled() }
    sockets.at(-1)!.onClose?.()
    expect(delays).toEqual([1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000])
  })

  // Proves random() is actually multiplied into the delay, not merely called. At random()=0
  // (the low end of the 50-100% band) the delay must be exactly half the un-jittered ceiling;
  // an implementation that ignores jitter (or hard-codes the multiplier to 1) would emit 1000
  // here instead of 500.
  it('applies the 50%-100% jitter band to the backoff ceiling', () => {
    const { client } = make(vi.fn(), () => 0)
    client.start()
    sockets[0].onClose?.()
    expect(delays).toEqual([500])
  })

  it('stops retrying after a 4401 bad-secret close — retrying cannot help', () => {
    const { client } = make()
    client.start()
    sockets[0].onClose?.(4401)
    expect(delays).toEqual([])
    expect(client.state).toBe('offline')
  })

  // The terminal stop must be LOUD (relay/README.md promises it): the real-world trigger is two
  // hubs booted from one cloned DB image — the loser stops relay delivery forever, and with no
  // log line there is nothing an operator could ever notice. Ordinary closes stay silent (the
  // backoff handles them); the message names the hub (routing metadata) but NEVER the secret.
  it('logs one console.error on the 4401 terminal stop — naming the hub, never the secret', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const { client } = make()
      client.start()
      sockets[0].onClose?.()          // ordinary close: silent, retry is the answer
      expect(spy).not.toHaveBeenCalled()
      runScheduled()
      sockets[1].onClose?.(4401)      // terminal: must be loud
      expect(spy).toHaveBeenCalledTimes(1)
      const line = String(spy.mock.calls[0][0])
      expect(line).toContain('hub_test')
      expect(line).toMatch(/stopped permanently/)
      expect(line).not.toContain('s3cret')
    } finally {
      spy.mockRestore()
    }
  })

  // The relay sends this when a newer connection for the same hub_uid supersedes a zombie
  // socket — explicitly NOT an auth failure (relay/src/protocol.ts, CLOSE_SUPERSEDED). A client
  // that treated it like 4401 would permanently disconnect a hub that merely reconnected. This
  // test fails if 4409 and 4401 are handled the same way.
  it('reconnects normally after a 4409 superseded close — not an auth failure', () => {
    const { client } = make()
    client.start()
    sockets[0].onClose?.(4409)
    expect(delays).toEqual([1000])
    expect(client.state).toBe('offline')
    runScheduled()
    expect(sockets.length).toBe(2)
    sockets[1].onOpen?.()
    sockets[1].onMessage?.(JSON.stringify({ type: 'READY' }))
    expect(client.state).toBe('ready')
  })

  // 4429 (rate limited) must back off and retry, same as any other non-fatal close — it must
  // not be mistaken for the terminal 4401 case either.
  it('reconnects normally after a 4429 rate-limited close', () => {
    const { client } = make()
    client.start()
    sockets[0].onClose?.(4429)
    expect(delays).toEqual([1000])
    expect(client.state).toBe('offline')
  })

  it('stop() cancels a pending reconnect', () => {
    const { client } = make()
    client.start()
    sockets[0].onClose?.()
    client.stop()
    const before = sockets.length
    runScheduled()
    expect(sockets.length).toBe(before)
  })

  it('stop() is safe to call twice and after a clean start', () => {
    const { client } = make()
    client.start()
    sockets[0].onOpen?.()
    sockets[0].onMessage?.(JSON.stringify({ type: 'READY' }))
    expect(() => { client.stop(); client.stop() }).not.toThrow()
    expect(client.state).toBe('offline')
  })

  it('sendReply is a no-op when not ready rather than throwing', () => {
    const { client } = make()
    client.start()
    expect(() => client.sendReply('conn_1', 'eA==')).not.toThrow()
    expect(sockets[0].parsed().some((m) => m.type === 'REPLY')).toBe(false)
  })

  it('sendReply emits a REPLY once ready', () => {
    const { client } = make()
    client.start(); sockets[0].onOpen?.()
    sockets[0].onMessage?.(JSON.stringify({ type: 'READY' }))
    client.sendReply('conn_1', 'YW5zd2Vy')
    expect(sockets[0].parsed().at(-1))
      .toEqual({ type: 'REPLY', conn_id: 'conn_1', payload: 'YW5zd2Vy' })
  })

  it('garbage frames never throw', () => {
    const { client } = make()
    client.start()
    expect(() => {
      sockets[0].onMessage?.('not json')
      sockets[0].onMessage?.(JSON.stringify(null))
      sockets[0].onMessage?.(JSON.stringify({ type: 'WAT' }))
    }).not.toThrow()
  })

  describe('heartbeat (half-open detection)', () => {
    // Discriminates the pong-reset itself, not just "the connection survived a couple of
    // ticks" — 4 tick/pong cycles is well past the 3-miss grace window below. If the reset were
    // missing or broken, the miss counter would keep climbing across ticks instead of returning
    // to 0 each time, the connection would be force-closed on the 3rd tick, and this loop would
    // stop pinging partway through (2 pings, not 4) instead of running to completion.
    it('pings on an interval once ready, and each pong resets the miss counter so a healthy link never times out', () => {
      const { client } = make()
      client.start(); sockets[0].onOpen?.()
      sockets[0].onMessage?.(JSON.stringify({ type: 'READY' }))
      expect(pingPending.length).toBe(1)   // scheduled the first tick on READY

      for (let i = 0; i < 4; i++) {
        runPing()
        sockets[0].onPong?.()              // relay answered — reset the miss count every time
      }
      expect(sockets[0].pings).toBe(4)
      expect(client.state).toBe('ready')    // never closed: every pong arrived in time
      expect(delays).toEqual([])            // and backoff never engaged
    })

    // The discriminating test: an idle NAT/load-balancer can drop the TCP connection without a
    // FIN, so nothing ever calls onClose on its own. Without this check the client would sit at
    // 'ready' forever, silently dropping every DELIVER — this is the failure mode the heartbeat
    // exists to catch, and it's far more common in production than a clean relay-initiated close.
    it('closes the connection after 3 consecutive missed pongs, and backoff takes over', () => {
      const { client } = make()
      client.start(); sockets[0].onOpen?.()
      sockets[0].onMessage?.(JSON.stringify({ type: 'READY' }))

      runPing()   // miss 1 (<=2) — still considered alive, matches deviceSocket.ts's grace window
      runPing()   // miss 2 (<=2) — still alive
      expect(client.state).toBe('ready')
      expect(delays).toEqual([])

      runPing()   // miss 3 (>2) — gives up on this socket
      expect(client.state).toBe('offline')
      expect(delays).toEqual([1000])   // the existing reconnect-backoff path picked it up
    })
  })

  // edge case: `ws` throws SYNCHRONOUSLY out of its WebSocket constructor for some invalid URLs (e.g. a
  // fragment). isRelayUrl is meant to catch that before a URL is ever stored, but a hand-edited
  // settings row must degrade to offline-with-backoff, not crash boot — nothing may escape
  // start()/dial().
  it('a connect that throws synchronously goes offline, records last_error, and schedules a reconnect', () => {
    const onDeliver = vi.fn()
    delays = []; pending = []; pingDelays = []; pingPending = []
    const client = new RelayClient({
      url: 'wss://relay.example/ws#frag',
      identity,
      onDeliver,
      random: () => 1,
      schedule: (ms, fn) => { delays.push(ms); pending.push(fn) },
      schedulePing: (ms, fn) => { pingDelays.push(ms); pingPending.push(fn) },
      connect: () => { throw new Error('ws: invalid url') },
    })
    expect(() => client.start()).not.toThrow()
    expect(client.state).toBe('offline')
    expect(client.lastError).toEqual({ code: 'closed', message: 'connection to the relay closed', at: expect.any(Number) })
    expect(delays).toEqual([1000])   // a reconnect was scheduled, same jittered backoff as onClose
  })

  // Regression test for a stop()/start() race: a reconnect timer scheduled by an old dial cycle
  // must not fire into dial() after a later start() has already produced a new, live socket —
  // doing so would silently orphan the live connection by overwriting it with a third one.
  it('a reconnect scheduled before stop() cannot double-dial after a later start()', () => {
    const { client } = make()
    client.start()
    sockets[0].onClose?.()          // schedules a stale reconnect timer (delays=[1000])
    client.stop()
    client.start()                  // dials fresh immediately -> sockets[1], now the live socket
    expect(sockets.length).toBe(2)
    expect(client.state).toBe('connecting')

    runScheduled()                  // fires the STALE timer from before stop()/start()
    expect(sockets.length).toBe(2)  // must not have created a third socket
    expect(client.state).toBe('connecting')   // sockets[1] is still the one in play, untouched
  })
})

describe('RelayClient state memory', () => {
  const makeInstrumented = () => {
    sockets = []; delays = []; pending = []; pingDelays = []; pingPending = []
    const events: RelayEvent[] = []
    let t = 1000
    const client = new RelayClient({
      url: 'wss://relay.example/ws', identity, onDeliver: vi.fn(), random: () => 1,
      schedule: (ms, fn) => { delays.push(ms); pending.push(fn) },
      schedulePing: (ms, fn) => { pingDelays.push(ms); pingPending.push(fn) },
      connect: () => { const s = new FakeSocket(); sockets.push(s); return s },
      now: () => t,
      onEvent: (ev) => events.push(ev),
    })
    return { client, events, setNow: (v: number) => { t = v } }
  }

  it('records connected_since on READY, clears it on close, and fires ready once per connection', () => {
    const { client, events, setNow } = makeInstrumented()
    client.start()
    setNow(2000)
    sockets[0].onOpen?.()
    sockets[0].onMessage?.(JSON.stringify({ type: 'READY' }))
    expect(client.connectedSince).toBe(2000)
    expect(events).toEqual([{ type: 'ready' }])
    // a duplicate READY frame on the same connection must not re-fire the event
    sockets[0].onMessage?.(JSON.stringify({ type: 'READY' }))
    expect(events).toEqual([{ type: 'ready' }])
    sockets[0].onClose?.()
    expect(client.connectedSince).toBeNull()
  })

  it('records bad_secret as a terminal last_error and fires the terminal event', () => {
    const { client, events, setNow } = makeInstrumented()
    client.start()
    setNow(3000)
    sockets[0].onClose?.(4401)
    expect(client.terminal).toBe(true)
    expect(client.state).toBe('offline')
    expect(client.lastError).toMatchObject({ code: 'bad_secret', at: 3000 })
    expect(client.lastError!.message).toContain('4401')
    expect(events).toEqual([{ type: 'terminal', code: 'bad_secret', message: client.lastError!.message }])
    expect(delays).toEqual([])   // terminal means terminal: no reconnect was scheduled
  })

  it('an ordinary drop records a closed last_error, is not terminal, and audits nothing', () => {
    const { client, events, setNow } = makeInstrumented()
    client.start()
    setNow(4000)
    sockets[0].onClose?.()
    expect(client.terminal).toBe(false)
    expect(client.lastError).toMatchObject({ code: 'closed', at: 4000 })
    expect(events).toEqual([])          // churn must stay silent
    expect(delays).toEqual([1000])      // and the existing backoff path still runs
  })

  it('stop() is voluntary: no error recorded, not terminal', () => {
    const { client, events } = makeInstrumented()
    client.start()
    sockets[0].onOpen?.()
    sockets[0].onMessage?.(JSON.stringify({ type: 'READY' }))
    client.stop()
    expect(client.connectedSince).toBeNull()
    expect(client.lastError).toBeNull()
    expect(client.terminal).toBe(false)
    expect(events).toEqual([{ type: 'ready' }])
  })

  it('a throwing onEvent observer never breaks the transport', () => {
    sockets = []; delays = []; pending = []; pingDelays = []; pingPending = []
    const client = new RelayClient({
      url: 'wss://relay.example/ws', identity, onDeliver: vi.fn(), random: () => 1,
      schedule: (ms, fn) => { delays.push(ms); pending.push(fn) },
      schedulePing: (ms, fn) => { pingDelays.push(ms); pingPending.push(fn) },
      connect: () => { const s = new FakeSocket(); sockets.push(s); return s },
      onEvent: () => { throw new Error('observer bug') },
    })
    client.start()
    sockets[0].onOpen?.()
    sockets[0].onMessage?.(JSON.stringify({ type: 'READY' }))
    expect(client.state).toBe('ready')   // the throw was swallowed, READY still landed
  })

  it('exposes hubUid and url for the status route, never the secret', () => {
    const { client } = makeInstrumented()
    expect(client.hubUid).toBe('hub_test')
    expect(client.url).toBe('wss://relay.example/ws')
    expect('hubSecret' in client).toBe(false)
  })
})
