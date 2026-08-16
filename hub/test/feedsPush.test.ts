import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildServer } from '../src/server.js'
import { openDb } from '../src/db/index.js'
import { createSender } from '../src/db/senders.js'
import { createFeed, getFeed, recentRows, type FeedRow } from '../src/db/feeds.js'
import { createPairingCode, redeemPairingCode } from '../src/db/devices.js'
import { imagePath } from '../src/feedImage.js'
import { inject } from './support/inject.js'

let dataDir: string
let app: FastifyInstance, token: string
let valueFeed: FeedRow, streamFeed: FeedRow, restricted: FeedRow

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'dbz-feedimg-'))
  const config = { port: 0, dataDir, adminPassword: 'pw', publicUrl: 'http://x', relayUrl: null, masterKey: null, retentionAlertsDays: 90, retentionAuditDays: 180 }
  const db = openDb(':memory:')
  const s = createSender(db, 'test', [])
  token = s.token
  app = await buildServer({ config, db })
  valueFeed = createFeed(db, { name: 'cpu', mode: 'value' }, 1000)
  streamFeed = createFeed(db, { name: 'log', mode: 'stream', cap: 3 }, 1000)
  restricted = createFeed(db, { name: 'locked', mode: 'value', allowed_senders: ['snd_someone_else'] }, 1000)
})

afterEach(async () => {
  await app.close()
  rmSync(dataDir, { recursive: true, force: true })
})

const post = (url: string, payload: unknown) =>
  inject(app, { method: 'POST', url, headers: { authorization: `Bearer ${token}` }, payload })

describe('POST /api/feeds/:id', () => {
  it('401 without a valid sender token', async () => {
    const res = await app.inject({ method: 'POST', url: `/api/feeds/${valueFeed.id}`, payload: { a: 1 } })
    expect(res.statusCode).toBe(401)
  })

  it('404 for an unknown feed id — nothing auto-creates', async () => {
    const res = await post('/api/feeds/feed_nope', { a: 1 })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: 'unknown feed' })
  })

  it('403 when the sender is not in the allowlist', async () => {
    const res = await post(`/api/feeds/${restricted.id}`, { a: 1 })
    expect(res.statusCode).toBe(403)
    expect(res.json()).toEqual({ error: 'sender not allowed' })
  })

  it('value push stores payload and returns pushed_at', async () => {
    const res = await post(`/api/feeds/${valueFeed.id}`, { cpu: 37.2 })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.ok).toBe(true)
    expect(typeof body.pushed_at).toBe('number')
    expect(JSON.parse(getFeed(app.db, valueFeed.id)!.payload!)).toEqual({ cpu: 37.2 })
  })

  it('accepts non-object JSON payloads (number, array)', async () => {
    expect((await post(`/api/feeds/${valueFeed.id}`, 42)).statusCode).toBe(200)
    expect((await post(`/api/feeds/${valueFeed.id}`, [1, 2])).statusCode).toBe(200)
  })

  it('stream push appends and trims to cap', async () => {
    for (let i = 0; i < 5; i++) await post(`/api/feeds/${streamFeed.id}`, { n: i })
    expect(recentRows(app.db, streamFeed.id, 10)).toHaveLength(3)
  })

  it('415 for a non-JSON content type', async () => {
    const res = await app.inject({
      method: 'POST', url: `/api/feeds/${valueFeed.id}`,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'text/plain' }, payload: 'hi',
    })
    expect(res.statusCode).toBe(415)
  })

  it('413 above the 16 KB cap', async () => {
    const res = await post(`/api/feeds/${valueFeed.id}`, { blob: 'x'.repeat(17_000) })
    expect(res.statusCode).toBe(413)
  })

  it('400 JSON push to an image-mode feed', async () => {
    // Created directly via the db layer — this test targets the push route, not the admin
    // create API (which image-feed behavior now also allows for mode: 'image'; see feedsApi.test.ts).
    const img = createFeed(app.db, { name: 'pic', mode: 'image' }, 1000)
    const res = await post(`/api/feeds/${img.id}`, { a: 1 })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'image feeds take an image push' })
  })
})

/**
 * Fixtures mirror feedImage.test.ts's hand-built hex buffers for image-feed behavior, built here
 * via small formula helpers instead of duplicating literal arrays
 * per test — the byte offsets are the same ones sniffImage documents.
 */
function pngBuffer(width: number, height: number): Buffer {
  const buf = Buffer.alloc(24)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0)
  buf.writeUInt32BE(13, 8)
  buf.write('IHDR', 12, 'ascii')
  buf.writeUInt32BE(width, 16)
  buf.writeUInt32BE(height, 20)
  return buf
}

function jpegBuffer(width: number, height: number): Buffer {
  const buf = Buffer.alloc(11)
  buf[0] = 0xff; buf[1] = 0xd8 // SOI
  buf[2] = 0xff; buf[3] = 0xc0 // SOF0
  buf.writeUInt16BE(11, 4) // segment length (unvalidated by the sniffer)
  buf[6] = 0x08 // precision
  buf.writeUInt16BE(height, 7)
  buf.writeUInt16BE(width, 9)
  return buf
}

function webpBuffer(width: number, height: number, animated = false): Buffer {
  const buf = Buffer.alloc(30)
  buf.write('RIFF', 0, 'ascii')
  buf.writeUInt32LE(22, 4)
  buf.write('WEBP', 8, 'ascii')
  buf.write('VP8X', 12, 'ascii')
  buf.writeUInt32LE(10, 16)
  buf[20] = animated ? 0x02 : 0x00
  const w = width - 1, h = height - 1
  buf[24] = w & 0xff; buf[25] = (w >> 8) & 0xff; buf[26] = (w >> 16) & 0xff
  buf[27] = h & 0xff; buf[28] = (h >> 8) & 0xff; buf[29] = (h >> 16) & 0xff
  return buf
}

const postImage = (url: string, body: Buffer, contentType: string) =>
  app.inject({ method: 'POST', url, headers: { authorization: `Bearer ${token}`, 'content-type': contentType }, payload: body })

describe('POST /api/feeds/:id (image push)', () => {
  let imageFeed: FeedRow

  beforeEach(() => {
    imageFeed = createFeed(app.db, { name: 'pic', mode: 'image' }, 1000)
  })

  it('happy path: 200, image_rev increments per push, file written at imagePath', async () => {
    const png = pngBuffer(4, 4)
    const res1 = await postImage(`/api/feeds/${imageFeed.id}`, png, 'image/png')
    expect(res1.statusCode).toBe(200)
    expect(res1.json()).toMatchObject({ ok: true, image_rev: 1 })
    expect(typeof res1.json().pushed_at).toBe('number')
    expect(existsSync(imagePath(dataDir, imageFeed.id))).toBe(true)
    expect(readFileSync(imagePath(dataDir, imageFeed.id))).toEqual(png)
    expect(getFeed(app.db, imageFeed.id)!.image_rev).toBe(1)

    const res2 = await postImage(`/api/feeds/${imageFeed.id}`, png, 'image/png')
    expect(res2.json().image_rev).toBe(2)
  })

  it('415 for a lying content-type (JPEG bytes declared as image/png)', async () => {
    const res = await postImage(`/api/feeds/${imageFeed.id}`, jpegBuffer(4, 4), 'image/png')
    expect(res.statusCode).toBe(415)
    expect(res.json()).toEqual({ error: 'PNG, JPEG or static WebP only' })
  })

  it('415 for an animated WebP', async () => {
    const res = await postImage(`/api/feeds/${imageFeed.id}`, webpBuffer(4, 4, true), 'image/webp')
    expect(res.statusCode).toBe(415)
  })

  it('400 when parsed dims exceed the 2048x2048 cap', async () => {
    const res = await postImage(`/api/feeds/${imageFeed.id}`, pngBuffer(4096, 100), 'image/png')
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'image exceeds 2048x2048' })
  })

  it('415 (not 400) for a zero-width/zero-height PNG — malformed, not "oversize"', async () => {
    const res = await postImage(`/api/feeds/${imageFeed.id}`, pngBuffer(0, 50), 'image/png')
    expect(res.statusCode).toBe(415)
    expect(res.json()).toEqual({ error: 'PNG, JPEG or static WebP only' })
  })

  it('413 above the 512 KB byte cap', async () => {
    const oversizedPng = Buffer.concat([pngBuffer(4, 4), Buffer.alloc(600_000)])
    const res = await postImage(`/api/feeds/${imageFeed.id}`, oversizedPng, 'image/png')
    expect(res.statusCode).toBe(413)
  })

  it('415 for a binary push to a value feed', async () => {
    const res = await postImage(`/api/feeds/${valueFeed.id}`, pngBuffer(4, 4), 'image/png')
    expect(res.statusCode).toBe(415)
  })

  it('403 when the sender is not in the allowlist (checked before the format)', async () => {
    const lockedImage = createFeed(app.db, { name: 'lockedpic', mode: 'image', allowed_senders: ['snd_someone_else'] }, 1000)
    const res = await postImage(`/api/feeds/${lockedImage.id}`, pngBuffer(4, 4), 'image/png')
    expect(res.statusCode).toBe(403)
  })
})

describe('GET /api/feeds/:id/image', () => {
  let imageFeed: FeedRow, deviceToken: string, unpushedImageFeed: FeedRow

  beforeEach(async () => {
    imageFeed = createFeed(app.db, { name: 'pic', mode: 'image' }, 1000)
    unpushedImageFeed = createFeed(app.db, { name: 'pic2', mode: 'image' }, 1000)
    const paired = redeemPairingCode(app.db, createPairingCode(app.db, 'dev', 0).code, 1)!
    deviceToken = paired.token
    await postImage(`/api/feeds/${imageFeed.id}`, pngBuffer(4, 4), 'image/png')
  })

  const get = (url: string, headers: Record<string, string> = {}) =>
    app.inject({ method: 'GET', url, headers })

  it('200 with etag and bytes for a paired device token', async () => {
    const res = await get(`/api/feeds/${imageFeed.id}/image`, { authorization: `Bearer ${deviceToken}` })
    expect(res.statusCode).toBe(200)
    expect(res.headers.etag).toBe('1')
    expect(res.headers['content-type']).toBe('image/png')
    expect(res.rawPayload).toEqual(pngBuffer(4, 4))
  })

  it('304 when if-none-match matches the current image_rev', async () => {
    const res = await get(`/api/feeds/${imageFeed.id}/image`, { authorization: `Bearer ${deviceToken}`, 'if-none-match': '1' })
    expect(res.statusCode).toBe(304)
  })

  it('200 again (not 304) after a re-push bumps image_rev past the stale if-none-match', async () => {
    await postImage(`/api/feeds/${imageFeed.id}`, pngBuffer(8, 8), 'image/png')
    const res = await get(`/api/feeds/${imageFeed.id}/image`, { authorization: `Bearer ${deviceToken}`, 'if-none-match': '1' })
    expect(res.statusCode).toBe(200)
    expect(res.headers.etag).toBe('2')
  })

  it('401 without a token, and audits the rejection (this is the first device-token HTTP endpoint)', async () => {
    const res = await get(`/api/feeds/${imageFeed.id}/image`)
    expect(res.statusCode).toBe(401)
    const row = app.db.prepare(
      "SELECT * FROM audit_log WHERE event = 'auth_rejected' AND details LIKE '%/api/feeds/:id/image%'",
    ).get()
    expect(row).toBeDefined()
  })

  it('401 with an invalid token, and audits the rejection', async () => {
    const res = await get(`/api/feeds/${imageFeed.id}/image`, { authorization: 'Bearer nope' })
    expect(res.statusCode).toBe(401)
    const row = app.db.prepare(
      "SELECT * FROM audit_log WHERE event = 'auth_rejected' AND details LIKE '%/api/feeds/:id/image%'",
    ).get()
    expect(row).toBeDefined()
  })

  it('404 for a non-image feed', async () => {
    const res = await get(`/api/feeds/${valueFeed.id}/image`, { authorization: `Bearer ${deviceToken}` })
    expect(res.statusCode).toBe(404)
  })

  it('404 for an unknown feed', async () => {
    const res = await get('/api/feeds/feed_nope/image', { authorization: `Bearer ${deviceToken}` })
    expect(res.statusCode).toBe(404)
  })

  it('404 for an image feed that has never been pushed to (image_rev === 0)', async () => {
    const res = await get(`/api/feeds/${unpushedImageFeed.id}/image`, { authorization: `Bearer ${deviceToken}` })
    expect(res.statusCode).toBe(404)
  })
})
