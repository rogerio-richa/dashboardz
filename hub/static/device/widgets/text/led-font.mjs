/**
 * A 5×7 dot-matrix font, as data.
 *
 * `text/led.mjs` draws a sign the way a real LED panel does — a grid of dots, some lit — and that
 * needs to know which dots make an `A`. There is no way to ask the canvas: reading back rendered
 * text would need `getImageData`, which is outside the portable drawing subset (portable drawing subset), and a design
 * cannot ship a font file either (`assets` carries rasters for `drawImage`, nothing else). So the
 * shapes live here, in the same spirit as `clock/segment.mjs` drawing seven-segment digits as
 * geometry rather than as type.
 *
 * A glyph is seven strings of five characters, `X` lit and `.` unlit, written out so the shape is
 * legible in the source — a hex-packed table would be a third the size and unreviewable. This is
 * DATA: a typo here is a character that renders as garbage on a wall with nothing to catch it,
 * which is why `widget-led.test.ts` pins every glyph's shape and the whole documented set's
 * presence rather than trusting a read-through.
 *
 * COVERAGE is uppercase A–Z, 0–9, space and the punctuation below. Lowercase folds onto uppercase
 * (`glyphFor('a') === glyphFor('A')`): real signs are caps, and a 5×7 cell has no room for
 * descenders — proper lowercase needs a 5×8 or 6×8 matrix, which is a widening this table can take
 * later without any caller changing. Anything not covered draws as `LED_FALLBACK`, a hollow box:
 * a sign that cannot render a character should SAY so, not silently swallow it.
 */

export const GLYPH_W = 5
export const GLYPH_H = 7

/** Unknown character: the hollow box every dot-matrix sign has shown since the seventies. */
export const LED_FALLBACK = Object.freeze([
  'XXXXX',
  'X...X',
  'X...X',
  'X...X',
  'X...X',
  'X...X',
  'XXXXX',
])

const GLYPHS = Object.freeze({
  ' ': ['.....', '.....', '.....', '.....', '.....', '.....', '.....'],

  A: ['.XXX.', 'X...X', 'X...X', 'XXXXX', 'X...X', 'X...X', 'X...X'],
  B: ['XXXX.', 'X...X', 'X...X', 'XXXX.', 'X...X', 'X...X', 'XXXX.'],
  C: ['.XXX.', 'X...X', 'X....', 'X....', 'X....', 'X...X', '.XXX.'],
  D: ['XXXX.', 'X...X', 'X...X', 'X...X', 'X...X', 'X...X', 'XXXX.'],
  E: ['XXXXX', 'X....', 'X....', 'XXXX.', 'X....', 'X....', 'XXXXX'],
  F: ['XXXXX', 'X....', 'X....', 'XXXX.', 'X....', 'X....', 'X....'],
  G: ['.XXX.', 'X...X', 'X....', 'X.XXX', 'X...X', 'X...X', '.XXX.'],
  H: ['X...X', 'X...X', 'X...X', 'XXXXX', 'X...X', 'X...X', 'X...X'],
  I: ['XXXXX', '..X..', '..X..', '..X..', '..X..', '..X..', 'XXXXX'],
  J: ['..XXX', '...X.', '...X.', '...X.', '...X.', 'X..X.', '.XX..'],
  K: ['X...X', 'X..X.', 'X.X..', 'XX...', 'X.X..', 'X..X.', 'X...X'],
  L: ['X....', 'X....', 'X....', 'X....', 'X....', 'X....', 'XXXXX'],
  M: ['X...X', 'XX.XX', 'X.X.X', 'X...X', 'X...X', 'X...X', 'X...X'],
  N: ['X...X', 'XX..X', 'X.X.X', 'X..XX', 'X...X', 'X...X', 'X...X'],
  O: ['.XXX.', 'X...X', 'X...X', 'X...X', 'X...X', 'X...X', '.XXX.'],
  P: ['XXXX.', 'X...X', 'X...X', 'XXXX.', 'X....', 'X....', 'X....'],
  Q: ['.XXX.', 'X...X', 'X...X', 'X...X', 'X.X.X', 'X..X.', '.XX.X'],
  R: ['XXXX.', 'X...X', 'X...X', 'XXXX.', 'X.X..', 'X..X.', 'X...X'],
  S: ['.XXXX', 'X....', 'X....', '.XXX.', '....X', '....X', 'XXXX.'],
  T: ['XXXXX', '..X..', '..X..', '..X..', '..X..', '..X..', '..X..'],
  U: ['X...X', 'X...X', 'X...X', 'X...X', 'X...X', 'X...X', '.XXX.'],
  V: ['X...X', 'X...X', 'X...X', 'X...X', 'X...X', '.X.X.', '..X..'],
  W: ['X...X', 'X...X', 'X...X', 'X.X.X', 'X.X.X', 'XX.XX', 'X...X'],
  X: ['X...X', 'X...X', '.X.X.', '..X..', '.X.X.', 'X...X', 'X...X'],
  Y: ['X...X', 'X...X', '.X.X.', '..X..', '..X..', '..X..', '..X..'],
  Z: ['XXXXX', '....X', '...X.', '..X..', '.X...', 'X....', 'XXXXX'],

  0: ['.XXX.', 'X...X', 'X..XX', 'X.X.X', 'XX..X', 'X...X', '.XXX.'],
  1: ['..X..', '.XX..', '..X..', '..X..', '..X..', '..X..', '.XXX.'],
  2: ['.XXX.', 'X...X', '....X', '...X.', '..X..', '.X...', 'XXXXX'],
  3: ['XXXXX', '...X.', '..X..', '...X.', '....X', 'X...X', '.XXX.'],
  4: ['...X.', '..XX.', '.X.X.', 'X..X.', 'XXXXX', '...X.', '...X.'],
  5: ['XXXXX', 'X....', 'XXXX.', '....X', '....X', 'X...X', '.XXX.'],
  6: ['..XX.', '.X...', 'X....', 'XXXX.', 'X...X', 'X...X', '.XXX.'],
  7: ['XXXXX', '....X', '...X.', '..X..', '.X...', '.X...', '.X...'],
  8: ['.XXX.', 'X...X', 'X...X', '.XXX.', 'X...X', 'X...X', '.XXX.'],
  9: ['.XXX.', 'X...X', 'X...X', '.XXXX', '....X', '...X.', '.XX..'],

  '.': ['.....', '.....', '.....', '.....', '.....', '.XX..', '.XX..'],
  ',': ['.....', '.....', '.....', '.....', '.XX..', '.XX..', '.X...'],
  ':': ['.....', '.XX..', '.XX..', '.....', '.XX..', '.XX..', '.....'],
  ';': ['.....', '.XX..', '.XX..', '.....', '.XX..', '.XX..', '.X...'],
  '!': ['..X..', '..X..', '..X..', '..X..', '..X..', '.....', '..X..'],
  '?': ['.XXX.', 'X...X', '....X', '...X.', '..X..', '.....', '..X..'],
  "'": ['..X..', '..X..', '.....', '.....', '.....', '.....', '.....'],
  '"': ['.X.X.', '.X.X.', '.....', '.....', '.....', '.....', '.....'],
  '-': ['.....', '.....', '.....', 'XXXXX', '.....', '.....', '.....'],
  '+': ['.....', '..X..', '..X..', 'XXXXX', '..X..', '..X..', '.....'],
  '=': ['.....', '.....', 'XXXXX', '.....', 'XXXXX', '.....', '.....'],
  '/': ['....X', '....X', '...X.', '..X..', '.X...', 'X....', 'X....'],
  '(': ['..X..', '.X...', 'X....', 'X....', 'X....', '.X...', '..X..'],
  ')': ['..X..', '...X.', '....X', '....X', '....X', '...X.', '..X..'],
  '[': ['.XXX.', '.X...', '.X...', '.X...', '.X...', '.X...', '.XXX.'],
  ']': ['.XXX.', '...X.', '...X.', '...X.', '...X.', '...X.', '.XXX.'],
  '<': ['...X.', '..X..', '.X...', 'X....', '.X...', '..X..', '...X.'],
  '>': ['.X...', '..X..', '...X.', '....X', '...X.', '..X..', '.X...'],
  '%': ['XX..X', 'XX..X', '...X.', '..X..', '.X...', 'X..XX', 'X..XX'],
  $: ['..X..', '.XXXX', 'X.X..', '.XXX.', '..X.X', 'XXXX.', '..X..'],
  '#': ['.X.X.', '.X.X.', 'XXXXX', '.X.X.', 'XXXXX', '.X.X.', '.X.X.'],
  '&': ['.XX..', 'X..X.', 'X.X..', '.X...', 'X.X.X', 'X..X.', '.XX.X'],
  '@': ['.XXX.', 'X...X', 'X.XXX', 'X.X.X', 'X.XXX', 'X....', '.XXX.'],
  '*': ['.....', 'X.X.X', '.XXX.', 'XXXXX', '.XXX.', 'X.X.X', '.....'],
  _: ['.....', '.....', '.....', '.....', '.....', '.....', 'XXXXX'],
  '°': ['.XX..', 'X..X.', '.XX..', '.....', '.....', '.....', '.....'],
  '·': ['.....', '.....', '.....', '..X..', '.....', '.....', '.....'],
})

/** Every character this table draws for real, in table order. */
export function ledCoverage() {
  return Object.keys(GLYPHS)
}

/**
 * The dot rows for one character. Lowercase folds onto uppercase; anything uncovered — including
 * an empty or non-string argument — comes back as the fallback box, never `undefined`.
 */
export function glyphFor(ch) {
  if (typeof ch !== 'string' || ch.length === 0) return LED_FALLBACK
  return GLYPHS[ch] ?? GLYPHS[ch.toUpperCase()] ?? LED_FALLBACK
}
