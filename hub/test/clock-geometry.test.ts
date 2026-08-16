import { describe, expect, it } from 'vitest'
// @ts-expect-error plain JS module without types
import { SEGMENTS, segmentsFor, handAngles } from '../static/device/widgets/clock-geometry.mjs'

describe('seven-segment map', () => {
  it('has an entry per digit, each seven segments long', () => {
    expect(SEGMENTS).toHaveLength(10)
    for (const d of SEGMENTS) expect(d).toHaveLength(7)
  })

  it('lights the documented segments for each digit', () => {
    // order: a(top) b(top-right) c(bottom-right) d(bottom) e(bottom-left) f(top-left) g(middle)
    expect(segmentsFor(0)).toEqual([1, 1, 1, 1, 1, 1, 0])
    expect(segmentsFor(1)).toEqual([0, 1, 1, 0, 0, 0, 0])
    expect(segmentsFor(2)).toEqual([1, 1, 0, 1, 1, 0, 1])
    expect(segmentsFor(3)).toEqual([1, 1, 1, 1, 0, 0, 1])
    expect(segmentsFor(4)).toEqual([0, 1, 1, 0, 0, 1, 1])
    expect(segmentsFor(5)).toEqual([1, 0, 1, 1, 0, 1, 1])
    expect(segmentsFor(6)).toEqual([1, 0, 1, 1, 1, 1, 1])
    expect(segmentsFor(7)).toEqual([1, 1, 1, 0, 0, 0, 0])
    expect(segmentsFor(8)).toEqual([1, 1, 1, 1, 1, 1, 1])
    expect(segmentsFor(9)).toEqual([1, 1, 1, 1, 0, 1, 1])
  })

  it('blanks a non-digit rather than throwing', () => {
    expect(segmentsFor(-1)).toEqual([0, 0, 0, 0, 0, 0, 0])
    expect(segmentsFor(10)).toEqual([0, 0, 0, 0, 0, 0, 0])
  })

  it('6 and 9 differ, and 8 lights everything', () => {
    expect(segmentsFor(6)).not.toEqual(segmentsFor(9))
    expect(segmentsFor(8).every((s: number) => s === 1)).toBe(true)
  })
})

describe('analog hand angles', () => {
  it('places both hands at 12 for midnight', () => {
    expect(handAngles(0, 0)).toEqual({ hour: 0, minute: 0 })
  })

  it('places the hour hand at 90 degrees for 3 o clock', () => {
    expect(handAngles(3, 0)).toEqual({ hour: 90, minute: 0 })
  })

  it('advances the hour hand proportionally through the hour', () => {
    expect(handAngles(3, 30)).toEqual({ hour: 105, minute: 180 })
  })

  it('handles a quarter to the hour', () => {
    expect(handAngles(9, 45)).toEqual({ hour: 292.5, minute: 270 })
  })

  it('wraps the 24-hour clock onto the 12-hour dial', () => {
    expect(handAngles(15, 30)).toEqual(handAngles(3, 30))
  })
})
