/**
 * Source-text scanning for the guards that read code as text.
 *
 * Two guards in this suite grep source: `knob-coverage.test.ts` (is every config knob read by a
 * renderer?) and `portable-subset.test.ts` (does any design reach for a browser API?). Both had the
 * same bug, six weeks apart — prose satisfied them. A knob named only in a comment read as
 * "covered", which is how the retired `style` knob went on looking read after its consumer was
 * deleted; and a design's docstring explaining that "the HOST does the fetch, the design just draws"
 * would trip a naive ban on `fetch`.
 *
 * So both need the same thing: look at executable code, not at what the file says about itself.
 * Both guards share this scanner, using the same executable-code boundary as `text-fit.mjs`'s
 * drawing helpers.
 *
 * Hand-rolled rather than a regex: `//` inside a string literal, and the `*` + `/` pair that appears
 * in these files' own prose, both defeat the naive version. One pass, tracking whether it is inside
 * a line comment, block comment, quoted string or template literal.
 *
 * `strings` is the axis the two guards genuinely disagree on, which is why it is an option rather
 * than a default:
 *   - `'keep'` — a name inside a string is a real read. `config['min_severity']` is how a knob gets
 *     used, so knob-coverage must see it.
 *   - `'blank'` — a name inside a string is a label, not a call. `label: 'Image'` in a design must
 *     not read as `new Image()`, so the browser-API guard blanks them.
 */
export type StringMode = 'keep' | 'blank'

export function scannableSource(src: string, strings: StringMode = 'keep'): string {
  let out = ''
  let i = 0
  let state: 'code' | 'line' | 'block' | 'single' | 'double' | 'template' = 'code'

  const emit = (ch: string) => { if (state === 'code' || strings === 'keep') out += ch }

  while (i < src.length) {
    const two = src.slice(i, i + 2)
    const ch = src[i]

    if (state === 'code') {
      if (two === '//') { state = 'line'; i += 2; continue }
      if (two === '/*') { state = 'block'; i += 2; continue }
      if (ch === "'") state = 'single'
      else if (ch === '"') state = 'double'
      else if (ch === '`') state = 'template'
      // The opening quote itself is punctuation, not content: emit it in either mode so the
      // surrounding expression stays syntactically recognisable to a later regex.
      out += state === 'code' || strings === 'keep' ? ch : ' '
      i += 1
      continue
    }

    if (state === 'line') {
      if (ch === '\n') { state = 'code'; out += ch }
      i += 1
      continue
    }

    if (state === 'block') {
      if (two === '*/') { state = 'code'; i += 2; continue }
      // Newlines survive so line-based reasoning about the stripped text still lines up.
      if (ch === '\n') out += ch
      i += 1
      continue
    }

    // Inside a string or template. Backslash escapes are consumed as a pair so an escaped quote
    // cannot end the literal early.
    if (ch === '\\') {
      if (strings === 'keep') out += src.slice(i, i + 2)
      else out += '  '
      i += 2
      continue
    }
    const closes = (state === 'single' && ch === "'") || (state === 'double' && ch === '"')
      || (state === 'template' && ch === '`')
    if (closes) {
      state = 'code'
      out += strings === 'keep' ? ch : ' '
      i += 1
      continue
    }
    emit(ch)
    if (strings === 'blank') out += ch === '\n' ? '\n' : ' '
    i += 1
  }
  return out
}
