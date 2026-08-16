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

// The implementation lives in hub/packs/scan.mjs, shared with the theme-pack checker.
// @ts-expect-error plain JS module without types
import { scannableSource as shared } from '../packs/scan.mjs'

export function scannableSource(src: string, strings: StringMode = 'keep'): string {
  return shared(src, strings)
}
