import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SenderClient, type AnswerEvent } from '../src/client.js'
import { open, seal } from '../src/envelope.js'

/**
 * Stands in for a socket so the wire conversation is deterministic — the same injected-`connect`
 * pattern as hub/test/relayClient.test.ts. The relay speaks to a sender only in message frames
 * (READY / REPLY / ERROR — see relay/src/socket.ts); the 4xxx close codes are hub-registration
 * concerns, so a sender needs no special close-code handling beyond "the connection died".
 */
class FakeSocket {
  sent: string[] = []
  closed = false
  onOpen?: () => void
  onMessage?: (raw: string) => void
  onClose?: (code?: number) => void
  send(d: string) { this.sent.push(d) }
  close() { this.closed = true; this.onClose?.() }
  parsed() { return this.sent.map((s) => JSON.parse(s) as Record<string, unknown>) }
}

const TOKEN = 'dbz_s_client_test_token'
let sockets: FakeSocket[]
let timers: { ms: number; fn: () => void; cancelled: boolean }[]

const make = () => {
  sockets = []; timers = []
  return new SenderClient({
    relayUrl: 'wss://relay.example/ws',
    hubUid: 'hub_test',
    senderToken: TOKEN,
    connect: () => { const s = new FakeSocket(); sockets.push(s); return s },
    schedule: (ms, fn) => {
      const t = { ms, fn, cancelled: false }
      timers.push(t)
      return () => { t.cancelled = true }
    },
  })
}

/** Dial and complete the HELLO_SENDER/READY handshake. */
const ready = async (client: SenderClient) => {
  const p = client.connect()
  const s = sockets[0]
  s.onOpen?.()
  s.onMessage?.(JSON.stringify({ type: 'READY', conn_id: 'c_1' }))
  await p
  return s
}

/** What the hub does: seal a reply with the key derived from the sender's token. */
const hubReply = (s: FakeSocket, obj: object) =>
  s.onMessage?.(JSON.stringify({ type: 'REPLY', payload: seal(TOKEN, obj) }))

const flushMicrotasks = () => new Promise<void>((r) => { setTimeout(r, 0) })

beforeEach(() => { sockets = []; timers = [] })

describe('SenderClient', () => {
  it('sends HELLO_SENDER then a sealed SEND, and resolves the ack', async () => {
    const client = make()
    const s = await ready(client)
    expect(s.parsed()[0]).toEqual({ type: 'HELLO_SENDER', hub_uid: 'hub_test' })

    const p = client.notify({ title: 'plaintext-must-never-cross-the-relay', severity: 'warn' })
    let settled = false
    p.then(() => { settled = true }, () => { settled = true })

    const frame = s.parsed()[1] as { type: string; payload: string }
    expect(frame.type).toBe('SEND')
    // The relay sees only ciphertext: the payload must not contain the title...
    expect(frame.payload).not.toContain('plaintext-must-never-cross-the-relay')
    // ...but the hub, holding the derived key, reads exactly the envelope authentication plaintext — no sender_token.
    const plain = open<Record<string, unknown>>(TOKEN, frame.payload)
    expect(plain).toMatchObject({ op: 'notify', title: 'plaintext-must-never-cross-the-relay', severity: 'warn' })
    expect(plain).not.toHaveProperty('sender_token')
    const reqId = plain!.req_id as string
    expect(reqId).toMatch(/^r_[0-9a-f]+$/)
    expect(reqId.length).toBeLessThanOrEqual(128) // the hub silently drops oversized req_ids

    // The ack promise must wait for the hub's REPLY, not resolve on send.
    await flushMicrotasks()
    expect(settled).toBe(false)

    hubReply(s, { req_id: reqId, ok: true, alert_id: 'a_1' })
    await expect(p).resolves.toEqual({ req_id: reqId, alert_id: 'a_1' })
  })

  it('routes an answer event to onAnswer', async () => {
    const client = make()
    const s = await ready(client)
    const seen: AnswerEvent[] = []
    client.onAnswer((evt) => seen.push(evt))

    const p = client.notify({ title: 'Disk 97%', severity: 'critical', options: [{ id: 'taken', label: 'Taken' }] })
    const reqId = (open<{ req_id: string }>(TOKEN, (s.parsed()[1] as { payload: string }).payload))!.req_id
    hubReply(s, { req_id: reqId, ok: true, alert_id: 'a_1' })
    await p

    // Long after the ack: a human tapped an option (hub/src/ws/deviceSocket.ts's outcome shape).
    hubReply(s, { req_id: reqId, event: 'answer', option_id: 'taken', device_id: 'device_1', at: 1753795000000 })
    expect(seen).toEqual([{ req_id: reqId, event: 'answer', option_id: 'taken', device_id: 'device_1', at: 1753795000000 }])
  })

  it('rejects the notify promise when the relay reports hub_offline', async () => {
    const client = make()
    const s = await ready(client)
    const p = client.notify({ title: 'Disk 97%', severity: 'warn' })
    // ERROR frames carry no req_id (relay/src/socket.ts) — the client must still fail the send.
    s.onMessage?.(JSON.stringify({ type: 'ERROR', code: 'hub_offline', message: 'the target hub is not connected' }))
    await expect(p).rejects.toThrow(/hub_offline/)
  })

  it('surfaces a timeout event distinctly from an error', async () => {
    const client = make()
    const s = await ready(client)
    const seen: AnswerEvent[] = []
    client.onAnswer((evt) => seen.push(evt))

    const p = client.notify({ title: 'Disk 97%', severity: 'warn', ttl_s: 60 })
    const reqId = (open<{ req_id: string }>(TOKEN, (s.parsed()[1] as { payload: string }).payload))!.req_id
    hubReply(s, { req_id: reqId, ok: true, alert_id: 'a_1' })
    await expect(p).resolves.toMatchObject({ alert_id: 'a_1' }) // the ack already resolved fine

    // The alert expired unanswered (hub/src/ttl.ts). That is an outcome, not a failure: it must
    // arrive through onAnswer with its own kind, and must not reject anything or throw.
    expect(() => hubReply(s, { req_id: reqId, event: 'timeout', at: 1753795000000 })).not.toThrow()
    expect(seen).toEqual([{ req_id: reqId, event: 'timeout', at: 1753795000000 }])
  })

  it('rejects the notify promise when the hub acks ok:false', async () => {
    const client = make()
    const s = await ready(client)
    const p = client.notify({ title: 'Disk 97%', severity: 'warn' })
    const reqId = (open<{ req_id: string }>(TOKEN, (s.parsed()[1] as { payload: string }).payload))!.req_id
    hubReply(s, { req_id: reqId, ok: false, error: 'unknown devices: d_9' })
    await expect(p).rejects.toThrow('unknown devices: d_9')
  })

  it('rejects a notify that never gets a REPLY once the ack timer fires', async () => {
    const client = make()
    await ready(client)
    const p = client.notify({ title: 'Disk 97%', severity: 'warn' })
    expect(timers.length).toBe(1)
    timers[0].fn()
    await expect(p).rejects.toThrow(/no ack/)
  })

  it('cancels the ack timer once the REPLY lands', async () => {
    const client = make()
    const s = await ready(client)
    const p = client.notify({ title: 'Disk 97%', severity: 'warn' })
    const reqId = (open<{ req_id: string }>(TOKEN, (s.parsed()[1] as { payload: string }).payload))!.req_id
    hubReply(s, { req_id: reqId, ok: true, alert_id: 'a_1' })
    await p
    expect(timers[0].cancelled).toBe(true)
    expect(() => timers[0].fn()).not.toThrow() // a stale fire must be a no-op either way
  })

  it('ignores garbage, unknown frames and undecryptable REPLYs — never fatal, never answered', async () => {
    const client = make()
    const s = await ready(client)
    const cb = vi.fn()
    client.onAnswer(cb)
    const p = client.notify({ title: 'Disk 97%', severity: 'warn' })
    const before = s.sent.length
    const reqId = (open<{ req_id: string }>(TOKEN, (s.parsed()[1] as { payload: string }).payload))!.req_id

    expect(() => {
      s.onMessage?.('not json')
      s.onMessage?.(JSON.stringify(null))
      s.onMessage?.(JSON.stringify({ type: 'WAT' }))
      s.onMessage?.(JSON.stringify({ type: 'REPLY' }))                          // no payload
      s.onMessage?.(JSON.stringify({ type: 'REPLY', payload: 'not base64!!' })) // undecryptable
      s.onMessage?.(JSON.stringify({ type: 'REPLY', payload: seal('dbz_s_other', { req_id: reqId, ok: true, alert_id: 'a_x' }) }))
      hubReply(s, { req_id: reqId, ok: 'yes' })                                 // wrong ok type
    }).not.toThrow()

    expect(s.sent.length).toBe(before) // never answered anything back
    expect(cb).not.toHaveBeenCalled()
    // The real ack still lands afterwards: none of the junk consumed the pending request.
    hubReply(s, { req_id: reqId, ok: true, alert_id: 'a_1' })
    await expect(p).resolves.toEqual({ req_id: reqId, alert_id: 'a_1' })
  })

  it('rejects notify before the handshake completes instead of sending in the clear-blue', async () => {
    const client = make()
    await expect(client.notify({ title: 'Disk 97%', severity: 'warn' })).rejects.toThrow(/not connected/)
    expect(sockets.length).toBe(0)
  })

  it('rejects pending notifies when the connection closes, and connect() rejects if closed before READY', async () => {
    const client = make()
    const s = await ready(client)
    const p = client.notify({ title: 'Disk 97%', severity: 'warn' })
    s.onClose?.(1006)
    await expect(p).rejects.toThrow(/closed/)

    const client2 = make()
    const c = client2.connect()
    sockets[0].onOpen?.()
    sockets[0].onClose?.(1006)
    await expect(c).rejects.toThrow(/closed/)
  })

  it('generates a fresh req_id per notify', async () => {
    const client = make()
    const s = await ready(client)
    void client.notify({ title: 'a', severity: 'info' }).catch(() => {})
    void client.notify({ title: 'b', severity: 'info' }).catch(() => {})
    const ids = [1, 2].map((i) => (open<{ req_id: string }>(TOKEN, (s.parsed()[i] as { payload: string }).payload))!.req_id)
    expect(ids[0]).not.toBe(ids[1])
  })

  it('close() is idempotent and rejects what is still pending', async () => {
    const client = make()
    await ready(client)
    const p = client.notify({ title: 'Disk 97%', severity: 'warn' })
    expect(() => { client.close(); client.close() }).not.toThrow()
    await expect(p).rejects.toThrow(/closed/)
  })

  it('data() seals op data with feed_id and payload and resolves on ok reply', async () => {
    const client = make()
    const s = await ready(client)
    const p = client.data({ feedId: 'feed_1', payload: { cpu: 42 } })

    const frame = s.parsed()[1] as { type: string; payload: string }
    expect(frame.type).toBe('SEND')
    // Ciphertext only — the relay must never see the feed id or the payload in the clear.
    expect(frame.payload).not.toContain('feed_1')
    const plain = open<Record<string, unknown>>(TOKEN, frame.payload)
    expect(plain).toMatchObject({ op: 'data', feed_id: 'feed_1', payload: { cpu: 42 } })
    const reqId = plain!.req_id as string
    expect(reqId).toMatch(/^r_[0-9a-f]+$/)

    hubReply(s, { req_id: reqId, ok: true, pushed_at: 1753795000000 })
    await expect(p).resolves.toEqual({ req_id: reqId, pushed_at: 1753795000000 })
  })

  it('rejects the data promise when the hub acks ok:false', async () => {
    const client = make()
    const s = await ready(client)
    const p = client.data({ feedId: 'feed_1', payload: { cpu: 42 } })
    const reqId = (open<{ req_id: string }>(TOKEN, (s.parsed()[1] as { payload: string }).payload))!.req_id
    hubReply(s, { req_id: reqId, ok: false, error: 'unknown feed' })
    await expect(p).rejects.toThrow('unknown feed')
  })

  it('rejects a data push that never gets a REPLY once the ack timer fires', async () => {
    const client = make()
    await ready(client)
    const p = client.data({ feedId: 'feed_1', payload: { cpu: 42 } })
    expect(timers.length).toBe(1)
    timers[0].fn()
    await expect(p).rejects.toThrow(/no ack/)
  })

  it('rejects data() before the handshake completes instead of sending in the clear-blue', async () => {
    const client = make()
    await expect(client.data({ feedId: 'feed_1', payload: 1 })).rejects.toThrow(/not connected/)
    expect(sockets.length).toBe(0)
  })

  describe('notify({ resolve: true })', () => {
    it('seals resolve/dedup_key without title/severity, and resolves on resolved:true', async () => {
      const client = make()
      const s = await ready(client)
      const p = client.notify({ resolve: true, dedup_key: 'raid-nas01' })

      const frame = s.parsed()[1] as { type: string; payload: string }
      const plain = open<Record<string, unknown>>(TOKEN, frame.payload)
      expect(plain).toMatchObject({ op: 'notify', resolve: true, dedup_key: 'raid-nas01' })
      expect(plain).not.toHaveProperty('title')
      expect(plain).not.toHaveProperty('severity')
      const reqId = plain!.req_id as string

      hubReply(s, { req_id: reqId, ok: true, resolved: true, alert_id: 'a_1' })
      await expect(p).resolves.toEqual({ req_id: reqId, alert_id: 'a_1', resolved: true })
    })

    it('resolves the ack (does not reject) when the hub reports resolved:false with no alert_id', async () => {
      const client = make()
      const s = await ready(client)
      const p = client.notify({ resolve: true, dedup_key: 'never-seen' })
      const reqId = (open<{ req_id: string }>(TOKEN, (s.parsed()[1] as { payload: string }).payload))!.req_id

      hubReply(s, { req_id: reqId, ok: true, resolved: false })
      await expect(p).resolves.toEqual({ req_id: reqId, resolved: false })
    })
  })
})
