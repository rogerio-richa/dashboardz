import { describe, expect, it, vi } from 'vitest'
import { buildServer } from '../src/server.js'
import { openDb } from '../src/db/index.js'

/** The schemas must compile cleanly: a start-up that prints validator warnings buries real ones. */
describe('hub schemas', () => {
  it('compile without AJV strict-mode warnings', async () => {
    const warnings: string[] = []
    const spy = vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => { warnings.push(a.map(String).join(' ')) })
    try {
      const app = await buildServer({ config: { port: 0, dataDir: '/tmp', adminPassword: 'pw', publicUrl: 'http://x', relayUrl: null } as any, db: openDb(':memory:') })
      await app.ready()
      await app.close()
    } finally {
      spy.mockRestore()
    }
    expect(warnings.filter((w) => w.includes('strict mode'))).toEqual([])
  })
})
