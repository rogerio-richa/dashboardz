import { describe, expect, it, vi } from 'vitest'
import { boot } from '../src/boot.js'
import type { Config } from '../src/config.js'
import { openDb } from '../src/db/index.js'
import { createFeed, getFeed } from '../src/db/feeds.js'
import { createOutput, createSource, getSource } from '../src/db/sources.js'
import { createSecretBox } from '../src/secrets/box.js'
import { runSourceOnce } from '../src/sources/run.js'
import { BUILTIN_PROVIDERS } from '../src/sources/registry.js'
import type { ProviderDefinition } from '../src/sources/provider.js'
import { WIDGET_REQUIREMENTS, compatibleOutput } from '../src/widgets/requirements.js'

/**
 * The shape of the data platform, asserted rather than described.
 *
 * Each of these was true by inspection at the moment the v18 connector runtime was deleted, and
 * each is the kind of thing that quietly stops being true: a second scheduler creeping back in, a
 * widget shipping with nothing able to feed it, a source falling back to a runtime that no longer
 * exists. The per-module tests cover behaviour inside each seam; this file covers the seams
 * agreeing with each other.
 */

const config: Config = {
  port: 0, dataDir: '/tmp', adminPassword: 'pw', publicUrl: 'http://x', relayUrl: null, masterKey: null,
  retentionAlertsDays: 90, retentionAuditDays: 180,
}
const secretBox = createSecretBox(new Uint8Array(32).fill(19))

/**
 * There is ONE collection runtime.
 *
 * The v18 collection runtime is gone and v20 dropped the table it read, so a second scheduler can
 * no longer be revived by accident. What this pins is the consequence: exactly one thing writes
 * feeds. A second writer would poll the same publishers twice, overwrite the same feeds from two
 * places, and give an operator two disagreeing answers about the health of one connection.
 *
 * Proven by leaving an unowned feed in the database through a full boot, several real source
 * passes and a shutdown, and leave it untouched — which no amount of "we deleted the import"
 * can show.
 */
describe('the active collection runtime', () => {
  it('runs source instances and nothing else, with no second writer touching a feed', async () => {
    const db = openDb(':memory:')
    const source = createSource(db, {
      provider_id: 'test.architecture', package_id: 'dashboardz.builtin', package_version: '1.0.0',
      name: 'Scheduled source', config: {}, interval_s: 1,
    }, 0)
    const sourceFeed = createFeed(db, { name: 'Scheduled source feed', mode: 'value' }, 0)
    createOutput(db, {
      source_id: source.id, contract_id: 'dashboardz.legacy.value/v1', feed_id: sourceFeed.id,
    }, 0)

    // A feed no source owns. Only the source runtime writes feeds, so this staying untouched
    // across several scheduler passes is what a second writer would break.
    const unowned = createFeed(db, { name: 'Nobody writes this', mode: 'value' }, 0)

    let runs = 0
    const definition: ProviderDefinition = {
      id: 'test.architecture', package_id: 'dashboardz.builtin', package_version: '1.0.0',
      strategy: 'scheduled', label: 'Architecture test', category: 'test', recommended: false,
      default_interval_s: 1, min_interval_s: 1,
      potential_outputs: [{ contract_id: 'dashboardz.legacy.value/v1', capabilities: [] }],
      setup: [],
      validateSetup: (safeConfig, secrets) => ({
        ok: true,
        config: safeConfig as Record<string, unknown>,
        secrets: secrets as Readonly<Record<string, string>>,
      }),
      async run() {
        runs++
        return [{ contract_id: 'dashboardz.legacy.value/v1', result: { mode: 'value', payload: { runs } } }]
      },
    }

    const app = await boot(config, db, secretBox, {
      sourceProviderFor: (id) => (id === definition.id ? definition : undefined),
      sourceIntervalMs: 10,
    })
    try {
      // Several scheduler ticks, not one: a second runtime on a longer interval would be invisible
      // to a single-pass assertion.
      await vi.waitFor(() => expect(runs).toBeGreaterThanOrEqual(2), { timeout: 2_000, interval: 5 })
      expect(JSON.parse(getFeed(db, sourceFeed.id)!.payload!)).toMatchObject({ runs: expect.any(Number) })
      // Held open past several more scheduler intervals: a second runtime on a slower tick would
      // be invisible to an assertion made the moment the first one finished.
      await new Promise((resolve) => setTimeout(resolve, 120))
    } finally {
      await app.close()
    }

    expect(getFeed(db, unowned.id)!.payload).toBeNull()
    expect(getFeed(db, unowned.id)!.pushed_at).toBeNull()
    // And the retired runtime's table cannot come back to life, because v20 removed it.
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='connectors'").get())
      .toBeUndefined()
  })

  /**
   * A source whose provider this build does not have is a stopped connection with an explanation —
   * not an exception into the scheduler, and emphatically not a fallback into some other set of
   * fetchers. An unknown provider is a first-class outcome rather than an implicit fallback.
   */
  it('degrades a source with no provider instead of falling back to another runtime', async () => {
    const db = openDb(':memory:')
    const source = createSource(db, {
      provider_id: 'legacy.telepathy', package_id: 'dashboardz.builtin', package_version: '1.0.0',
      name: 'Orphaned', config: {}, interval_s: 60,
    }, 0)
    const feed = createFeed(db, { name: 'Orphaned feed', mode: 'value' }, 0)
    createOutput(db, {
      source_id: source.id, contract_id: 'dashboardz.legacy.value/v1', feed_id: feed.id,
    }, 0)

    const fetchImpl = vi.fn(async () => new Response('{}')) as unknown as typeof fetch
    await runSourceOnce(db, source.id, {
      fetch: fetchImpl, secretBox, onFeedPush: () => {},
    }, 1_000)

    const after = getSource(db, source.id)!
    expect(after.state).not.toBe('healthy')
    expect(after.last_status).toMatch(/provider/i)
    // Nothing was fetched on its behalf, and nothing was written to its feed.
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(getFeed(db, feed.id)!.payload).toBeNull()
    // Still scheduled: an unavailable provider can become available again with the next build.
    expect(after.next_run_at).not.toBeNull()
  })
})

/**
 * Capability matching, end to end.
 *
 * A widget declares what data it needs; a provider declares what its outputs carry; the matcher
 * decides. Every part of that is unit-tested — what nothing else asserts is that the three sets
 * SHIPPED TOGETHER actually intersect. A widget in the gallery that no built-in provider can feed
 * is a dead end a person only discovers after choosing it.
 */
describe('what the hub ships can feed what the hub offers', () => {
  it('gives every semantic widget at least one built-in provider output it accepts', () => {
    for (const widget of Object.keys(WIDGET_REQUIREMENTS)) {
      const satisfying = BUILTIN_PROVIDERS.flatMap((provider) =>
        provider.potential_outputs
          .filter((output) => compatibleOutput(widget, output.contract_id, output.capabilities).ok)
          .map((output) => `${provider.id} → ${output.contract_id}`))
      expect(satisfying, `no built-in provider can feed "${widget}"`).not.toEqual([])
    }
  })

  /**
   * The optional half of the same contract. An optional capability nothing declares is not a bug —
   * pollen is real and Open-Meteo's free tier does not carry it — but a required one that no
   * shipped provider offers means the matcher can never say yes, which the test above would catch
   * and this one explains.
   */
  it('names which provider satisfies each widget, so a regression says what broke', () => {
    const offered = new Set(BUILTIN_PROVIDERS.flatMap((provider) =>
      provider.potential_outputs.flatMap((output) => [...output.capabilities])))
    for (const [widget, requirement] of Object.entries(WIDGET_REQUIREMENTS)) {
      for (const capability of requirement.required_capabilities) {
        expect(offered, `"${widget}" requires ${capability}, which no built-in provider offers`)
          .toContain(capability)
      }
    }
  })
})
