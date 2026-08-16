import { describe, expect, it } from 'vitest'
import { buildServer } from '../src/server.js'
import { openDb } from '../src/db/index.js'

const config = { port: 0, dataDir: '/tmp', adminPassword: 'pw', publicUrl: 'http://x', relayUrl: null, masterKey: null, retentionAlertsDays: 90, retentionAuditDays: 180 }

describe('server', () => {
  it('answers /api/health', async () => {
    const app = await buildServer({ config, db: openDb(':memory:') })
    const res = await app.inject({ method: 'GET', url: '/api/health' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true, name: 'Dashboardz' })
    await app.close()
  })

  it('/device serves an absolute script src that itself resolves', async () => {
    const app = await buildServer({ config, db: openDb(':memory:') })
    const res = await app.inject({ method: 'GET', url: '/device' })
    expect(res.statusCode).toBe(200)

    const match = res.body.match(/<script[^>]*\ssrc="([^"]+)"/)
    expect(match).not.toBeNull()
    const src = match![1]
    // Must be root-relative — a bare "./device.js" resolves against the no-trailing-slash
    // /device URL and 404s (it would resolve to /device.js, not /device/device.js).
    expect(src.startsWith('/')).toBe(true)

    const scriptRes = await app.inject({ method: 'GET', url: src })
    expect(scriptRes.statusCode).toBe(200)
    expect(scriptRes.headers['content-type']).toContain('javascript')
    await app.close()
  })

  it('/admin uses a fresh favicon URL that resolves to the green Dashboardz mark', async () => {
    const app = await buildServer({ config, db: openDb(':memory:') })
    const page = await app.inject({ method: 'GET', url: '/admin' })
    expect(page.statusCode).toBe(200)

    const match = page.body.match(/<link[^>]*rel="icon"[^>]*href="([^"]+)"/)
    expect(match).not.toBeNull()
    const href = match![1]
    // Browsers keep favicons in a separate, unusually sticky cache. Reusing the old URL can keep
    // the retired purple/blue mark visible even after the response body and cache headers change.
    expect(href).not.toBe('/admin/favicon.svg')

    const icon = await app.inject({ method: 'GET', url: href })
    expect(icon.statusCode).toBe(200)
    expect(icon.headers['content-type']).toContain('image/svg+xml')
    expect(icon.body).toContain('#00ff88')
    expect(icon.body).toContain('#00a85a')
    await app.close()
  })
})

/**
 * Module scripts must be `no-store`, not `no-cache`.
 *
 * `no-cache` means "revalidate", and it is what the device static root shipped with — chosen
 * deliberately so an unchanged board costs one 304 rather than a full refetch. On a real Galaxy
 * A05 the Android WebView does not honour it for ES MODULES: after `location.reload()` the page
 * re-executed a cached `widgets/index.mjs` and kept a stale design catalogue, while a `fetch()` of
 * the very same URL in the very same page returned the new file. Proven over CDP — a normal reload
 * registered four clock designs, `Page.reload({ignoreCache: true})` registered five.
 *
 * That breaks the contract completely: a board that notices it cannot draw a design reloads itself, and
 * the reload was guaranteed to bring back the same stale modules. The feature could never have
 * worked on the one device class it exists for.
 *
 * Scoped to scripts. The 370KB nixie sheet and every other asset keep `no-cache`, because
 * revalidation demonstrably does work for them and refetching artwork on every board load is a
 * real cost on a panel that reloads to pick up a design.
 */
describe('device static caching', () => {
  const cacheHeaderFor = async (url: string) => {
    const app = await buildServer({ config, db: openDb(':memory:') })
    const res = await app.inject({ method: 'GET', url })
    const header = res.headers['cache-control']
    await app.close()
    return { status: res.statusCode, header }
  }

  it('never lets a WebView reuse a module script', async () => {
    for (const url of ['/device/device.js', '/device/widgets/index.mjs', '/device/widgets/catalogue.mjs']) {
      const { status, header } = await cacheHeaderFor(url)
      expect(status, url).toBe(200)
      expect(header, url).toBe('no-store')
    }
  })

  it('still lets artwork be revalidated rather than refetched', async () => {
    const { status, header } = await cacheHeaderFor('/device/widgets/clock/assets/nixie-glyphs.png')
    expect(status).toBe(200)
    expect(header).toBe('no-cache')
  })

  it('leaves the document revalidating, which browsers do honour', async () => {
    const { status, header } = await cacheHeaderFor('/device/index.html')
    expect(status).toBe(200)
    expect(header).toBe('no-cache')
  })
})
