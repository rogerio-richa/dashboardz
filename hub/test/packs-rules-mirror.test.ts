import { describe, expect, it } from 'vitest'
import { buildPackRules } from '../scripts/gen-pack-rules.js'
// @ts-expect-error plain JS module without types
import * as committed from '../packs/rules.generated.mjs'

/**
 * `hub/packs/` is plain ESM so the pack checker runs with bare `node`; the rules that live in the
 * hub's TypeScript (the cell schema, theme limits, sound events) reach it as GENERATED data. This
 * fails when the committed copy no longer matches the TypeScript it came from: run
 * `npx tsx scripts/gen-pack-rules.ts` in hub/ to regenerate.
 */
describe('pack rules mirror the hub', () => {
  it('rules.generated.mjs equals a fresh generation from the TypeScript sources', () => {
    const fresh = buildPackRules()
    expect(committed.WIDGET_SETTINGS).toEqual(fresh.WIDGET_SETTINGS)
    expect(committed.THEME_LIMITS).toEqual(fresh.THEME_LIMITS)
    expect(committed.SOUND_EVENTS).toEqual(fresh.SOUND_EVENTS)
    expect(committed.DESIGN_OPTIONS).toEqual(fresh.DESIGN_OPTIONS)
  })

  it('knows a nested setting, a list, and design_options for a gauge', () => {
    const gauge = committed.WIDGET_SETTINGS.gauge
    expect(gauge.leaves['thresholds.warn']).toMatchObject({ type: 'number' })
    expect(gauge.leaves.decimals).toMatchObject({ minimum: 0, maximum: 3 })
    expect(gauge.designOptions).toBe(true)
    expect(committed.WIDGET_SETTINGS.table.lists.columns).toMatchObject({ minItems: 1, maxItems: 4, required: ['header', 'path'] })
  })
})
