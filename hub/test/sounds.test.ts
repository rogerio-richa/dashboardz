import { describe, expect, it } from 'vitest'
import { SOUND_EVENTS, getSoundManifest, parseSounds, resolveSounds } from '../src/sounds.js'

const M = { rev: 3, families: { classic: { name: 'Classic beeps' }, bells: { name: 'Soft bells' }, '8bit': { name: '8-bit' } } }

describe('parseSounds', () => {
  it('parses a sparse map', () => expect(parseSounds('{"critical":"bells"}')).toEqual({ critical: 'bells' }))
  it('degrades junk to {}', () => {
    for (const bad of [null, undefined, '', 'null', '[1]', '{"critical":7}', 'not json']) {
      expect(parseSounds(bad as never)).toEqual({})
    }
  })
})

describe('resolveSounds', () => {
  it('fills classic when nothing is set', () =>
    expect(resolveSounds({}, {}, M)).toEqual({ critical: 'classic', warn: 'classic', info: 'classic', offline: 'classic', activity: 'classic' }))
  it('screen overrides theme per event', () =>
    expect(resolveSounds({ critical: '8bit', warn: '8bit' }, { critical: 'bells' }, M))
      .toEqual({ critical: 'bells', warn: '8bit', info: 'classic', offline: 'classic', activity: 'classic' }))
  it('unknown family degrades to classic, never emitted broken', () =>
    expect(resolveSounds({ critical: 'gone' }, { warn: 'also_gone' }, M))
      .toEqual({ critical: 'classic', warn: 'classic', info: 'classic', offline: 'classic', activity: 'classic' }))
  it('ignores keys that are not events', () =>
    expect(resolveSounds({ bogus: 'bells' } as never, {}, M).critical).toBe('classic'))
  it('resolves activity like any other event: screen overrides theme, degrades unknown to classic', () => {
    expect(resolveSounds({ activity: '8bit' }, {}, M).activity).toBe('8bit')
    expect(resolveSounds({}, { activity: 'bells' }, M).activity).toBe('bells')
    expect(resolveSounds({ activity: '8bit' }, { activity: 'bells' }, M).activity).toBe('bells')
    expect(resolveSounds({ activity: 'gone' }, {}, M).activity).toBe('classic')
  })
})

describe('getSoundManifest', () => {
  it('loads the shipped manifest with classic + shipped families', () => {
    const m = getSoundManifest()
    expect(m.rev).toBeGreaterThanOrEqual(1)
    for (const fam of ['classic', 'bells', '8bit']) expect(m.families[fam]).toBeDefined()
  })
  it('events are frozen', () => expect([...SOUND_EVENTS]).toEqual(['critical', 'warn', 'info', 'offline', 'activity']))
})
