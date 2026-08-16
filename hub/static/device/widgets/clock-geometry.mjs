/**
 * Segment order is [a, b, c, d, e, f, g]:
 *   a top · b top-right · c bottom-right · d bottom · e bottom-left · f top-left · g middle
 * This is the conventional labelling; the order is pinned by clock-geometry.test.ts so a
 * reordering cannot pass silently — every digit would render as a different digit.
 */
export const SEGMENTS = Object.freeze([
  [1, 1, 1, 1, 1, 1, 0], // 0
  [0, 1, 1, 0, 0, 0, 0], // 1
  [1, 1, 0, 1, 1, 0, 1], // 2
  [1, 1, 1, 1, 0, 0, 1], // 3
  [0, 1, 1, 0, 0, 1, 1], // 4
  [1, 0, 1, 1, 0, 1, 1], // 5
  [1, 0, 1, 1, 1, 1, 1], // 6
  [1, 1, 1, 0, 0, 0, 0], // 7
  [1, 1, 1, 1, 1, 1, 1], // 8
  [1, 1, 1, 1, 0, 1, 1], // 9
].map((d) => Object.freeze(d)))

const BLANK = Object.freeze([0, 0, 0, 0, 0, 0, 0])

/** Wire tolerance in miniature: a non-digit blanks rather than throwing (repo rule). */
export function segmentsFor(digit) {
  return Number.isInteger(digit) && digit >= 0 && digit <= 9 ? SEGMENTS[digit] : BLANK
}

/**
 * Degrees clockwise from 12. Canvas's 0 radians is 3 o'clock, so a caller converts with
 * `deg * Math.PI / 180 - Math.PI / 2` — done at the draw site, not here, so this stays a pure
 * number function with no rendering assumptions baked in.
 */
export function handAngles(hours, minutes) {
  const h = ((hours % 12) + 12) % 12
  return {
    hour: (h + minutes / 60) / 12 * 360,
    minute: minutes / 60 * 360,
  }
}
