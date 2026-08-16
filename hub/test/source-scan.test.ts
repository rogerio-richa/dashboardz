import { describe, expect, it } from 'vitest'
import { scannableSource } from './source-scan.js'

/**
 * The shared source scanner both text-reading guards depend on. If this is wrong, both guards are
 * wrong in the same direction and neither says so — which is precisely how a knob named in a
 * comment read as "covered" for weeks.
 */
describe('scannableSource: comments never survive', () => {
  it('drops line and block comments', () => {
    expect(scannableSource('const a = 1 // cfg.ghost\n')).not.toContain('ghost')
    expect(scannableSource('/* cfg.ghost */ const a = 1')).not.toContain('ghost')
  })

  it('is not fooled by comment markers inside strings', () => {
    expect(scannableSource(`const u = 'http://x' ; cfg.headers`)).toContain('cfg.headers')
    expect(scannableSource(`const s = "/* not a comment */" ; cfg.align`)).toContain('cfg.align')
  })

  it('survives an unterminated block comment without eating the file', () => {
    expect(scannableSource('cfg.headers\n/* dangling')).toContain('cfg.headers')
  })

  it('keeps newlines so line numbers still line up', () => {
    expect(scannableSource('a\n// x\nb\n').split('\n')).toHaveLength(4)
  })
})

describe("scannableSource: the 'strings' axis the two guards disagree on", () => {
  it("'keep' preserves a name inside a string — config['min_severity'] is a real read", () => {
    expect(scannableSource(`const k = 'min_severity'`, 'keep')).toContain('min_severity')
  })

  it("'blank' removes it — label: 'Image' must not read as new Image()", () => {
    expect(scannableSource(`label: 'Image'`, 'blank')).not.toContain('Image')
  })

  it("'blank' leaves the surrounding code intact", () => {
    const out = scannableSource(`const x = 'Image'; new Image()`, 'blank')
    expect(out).toContain('new Image()')
    expect(out.indexOf('Image')).toBe(out.indexOf('new Image()') + 4)
  })

  it("'blank' handles an escaped quote without ending the literal early", () => {
    expect(scannableSource(`const s = 'it\\'s Image'; fetch(`, 'blank')).toContain('fetch(')
  })

  it('defaults to keep, so the existing caller is unchanged', () => {
    expect(scannableSource(`'min_severity'`)).toContain('min_severity')
  })
})
