import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import WebSocket from 'ws'
import { buildRelay } from '../src/server.js'
import { loadConfig } from '../src/config.js'
import { Registry, type Sink } from '../src/registry.js'
import { RegistryStore } from '../src/store.js'

const sink = (): Sink => ({ send: vi.fn() })
const dir = () => mkdtempSync(join(tmpdir(), 'relay-state-'))

const DAY = 24 * 60 * 60 * 1000

describe('registry persistence across restarts', () => {
  it('a relay restart no longer forgets who owns a hub_uid', () => {
    const file = join(dir(), 'state.json')
    const r1 = new Registry(new RegistryStore(file))
    expect(r1.registerHub('hub_a', 's3cret', sink())).toEqual({ ok: true })

    // The restart: a brand-new process loading the same state file. This is exactly the
    // window the documented TOFU race lived in.
    const r2 = new Registry(new RegistryStore(file))
    expect(r2.registerHub('hub_a', 'impostor', sink())).toEqual({ ok: false, reason: 'bad_secret' })
    expect(r2.registerHub('hub_a', 's3cret', sink())).toEqual({ ok: true })
  })

  it('a corrupt state file degrades to empty instead of refusing to boot', () => {
    const file = join(dir(), 'state.json')
    writeFileSync(file, '{not json')
    const r = new Registry(new RegistryStore(file))
    expect(r.registerHub('hub_a', 's3cret', sink())).toEqual({ ok: true })
  })

  it('bindings idle past the prune window are forgotten, so claim-flood junk cannot pile up forever', () => {
    const file = join(dir(), 'state.json')
    let t = 0
    const r1 = new Registry(new RegistryStore(file, () => t))
    r1.registerHub('hub_a', 's3cret', sink())

    t = 91 * DAY
    const r2 = new Registry(new RegistryStore(file, () => t))
    // 91 idle days: the binding is gone — the uid is claimable again, like any fresh uid.
    expect(r2.registerHub('hub_a', 'different', sink())).toEqual({ ok: true })
  })

  it('reconnecting refreshes the binding, so a living hub never ages out', () => {
    const file = join(dir(), 'state.json')
    let t = 0
    const r1 = new Registry(new RegistryStore(file, () => t))
    const first = sink()
    r1.registerHub('hub_a', 's3cret', first)

    t = 60 * DAY
    r1.detachHub('hub_a', first)
    r1.registerHub('hub_a', 's3cret', sink())

    t = 120 * DAY // 60 days after the refresh — inside the window again
    const r2 = new Registry(new RegistryStore(file, () => t))
    expect(r2.registerHub('hub_a', 'impostor', sink())).toEqual({ ok: false, reason: 'bad_secret' })
  })

  it('a storeless registry keeps today\'s in-memory behavior', () => {
    const r = new Registry()
    expect(r.registerHub('hub_a', 's3cret', sink())).toEqual({ ok: true })
    expect(r.registerHub('hub_a', 'guess', sink())).toEqual({ ok: false, reason: 'bad_secret' })
  })
})

describe('STATE_PATH config', () => {
  it('unset means in-memory, exactly as before', () => {
    expect(loadConfig({}).statePath).toBeNull()
  })
  it('a set path is passed through', () => {
    expect(loadConfig({ STATE_PATH: '/data/relay-state.json' }).statePath).toBe('/data/relay-state.json')
  })
  it('set-but-empty is a loud misconfiguration, matching PORT and TRUST_PROXY', () => {
    expect(() => loadConfig({ STATE_PATH: '' })).toThrow(/STATE_PATH/)
  })
})

describe('server wiring', () => {
  it('a rebuilt relay on the same STATE_PATH refuses the impostor over the wire', async () => {
    const statePath = join(dir(), 'state.json')
    const boot = async (): Promise<{ app: FastifyInstance; url: string }> => {
      const app = await buildRelay({ config: loadConfig({ PORT: '0', STATE_PATH: statePath }) })
      await app.listen({ port: 0, host: '127.0.0.1' })
      const addr = app.server.address()
      if (typeof addr === 'string' || addr === null) throw new Error('no port')
      return { app, url: `ws://127.0.0.1:${addr.port}/ws` }
    }
    // Resolves with the first frame's type, or with `close:<code>` — a bad secret is answered
    // by a terminal 4401 close (protocol.ts CLOSE_BAD_SECRET), not an ERROR frame.
    const hello = (url: string, secret: string): Promise<string> => new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timed out waiting for a frame or close')), 3000)
      const ws = new WebSocket(url)
      ws.once('open', () => ws.send(JSON.stringify({ type: 'HELLO_HUB', hub_uid: 'hub_wired', secret })))
      ws.once('message', (d) => { clearTimeout(t); ws.close(); resolve(JSON.parse(d.toString()).type) })
      ws.once('close', (code) => { clearTimeout(t); resolve(`close:${code}`) })
      ws.once('error', (e) => { clearTimeout(t); reject(e) })
    })

    const first = await boot()
    try {
      expect(await hello(first.url, 's3cret')).toBe('READY')
    } finally { await first.app.close() }

    const second = await boot() // the restart
    try {
      expect(await hello(second.url, 'impostor')).toBe('close:4401')
      expect(await hello(second.url, 's3cret')).toBe('READY')
    } finally { await second.app.close() }
  })
})
