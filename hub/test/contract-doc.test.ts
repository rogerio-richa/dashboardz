import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
// @ts-expect-error plain JS module without types
import { CATALOGUE } from '../static/device/widgets/catalogue.mjs'
// @ts-expect-error plain JS module without types
import { WIDGET_DEFINITIONS } from '../static/device/widgets/definitions.mjs'
// @ts-expect-error plain JS module without types
import { WIDGET_BINDINGS } from '../static/device/widgets/bindings.mjs'
import { NEED_SCOPES, NEED_TYPES, needCapability } from '../src/data/needs.js'

/**
 * `docs/architecture/widgets.md` is the PUBLISHED contract — the page an outside author is meant
 * to produce a correct design from, without reading device.js. Two of its claims are the kind that
 * rot silently, so they are pinned here rather than re-diffed by hand.
 *
 * The worked example is pinned to the implementation so the published page cannot quietly drift
 * from the code. A doc that has drifted from the code is worse than no doc: it is a confident,
 * wrong answer, and it is published.
 */
const DOC = readFileSync('../docs/architecture/widgets.md', 'utf8')

describe('the published widget contract stays true', () => {
  it('quotes text/block.mjs byte-for-byte as its worked example', () => {
    const blocks = [...DOC.matchAll(/```js\n([\s\S]*?)```/g)].map((m) => m[1])
    expect(blocks.length).toBeGreaterThan(0)
    const quoted = blocks[blocks.length - 1].replace(/\n+$/, '')
    const real = readFileSync('static/device/widgets/text/block.mjs', 'utf8').replace(/\n+$/, '')
    expect(quoted).toBe(real)
  })

  /*
   * The coverage sentence names every migrated widget type and both stragglers. It is the first
   * thing a reader calibrates against, and it is pure prose — nothing else would catch it going
   * stale on the next migration. Asserting on the catalogue rather than a hardcoded list means
   * moving `chart` or `image` cannot silently invalidate the published contract without this failing.
   */
  it('states a coverage count matching the catalogue, and names the widgets still on DOM', () => {
    const designed = new Set(CATALOGUE.map((d: { meta: { widget: string } }) => d.meta.widget))
    const all = WIDGET_DEFINITIONS.map((d: { id: string }) => d.id)
    const undesigned = all.filter((id: string) => !designed.has(id))

    expect(DOC).toContain(`${designed.size} of the ${all.length} widget types are on this contract`)
    for (const widget of designed) expect(DOC).toContain(`\`${widget}\``)
    for (const widget of undesigned) expect(DOC).toContain(`\`${widget}\``)
  })

  /**
   * `ctx.feed`'s absence vocabulary, pinned as PROSE because prose is what an outside author acts
   * on.
   *
   * The doc previously said "`ctx.feed === null` — the feed is not there … this is the loud state",
   * and a design written from that sentence would paint "Feed missing" over every correctly
   * configured chart on every board: a chart binds per series, so `null` is what it gets when
   * nothing whatsoever is wrong. The channel now spells the loud state `missing: true`, matching
   * `ctx.series[i].missing`, and `null` means "not applicable" exactly as it does on `ctx.rows` and
   * `ctx.series`. If a future edit re-attaches the loud reading to `null`, the code and the
   * published contract have parted company again and this is where it shows up.
   */
  it('does not tell an author that ctx.feed === null is the loud "feed is missing" state', () => {
    const loudNull = /`ctx\.feed === null`[^\n]*\n?[^\n]*\b(the feed is not there|is the \*\*loud\*\*|loud state)/i
    expect(loudNull.test(DOC)).toBe(false)
  })

  it('names ctx.feed.missing as the loud state and ctx.feed === null as not applicable', () => {
    expect(DOC).toContain('`ctx.feed.missing === true` — **the feed is not there.**')
    expect(DOC).toContain('`ctx.feed === null` — **not applicable.**')

    // The channel's field list is the part a freeze makes expensive, so the doc must advertise
    // exactly the keys it ships — and must not re-advertise `stale_after_s`, which was dropped for
    // having no reader. Scoped to the `ctx.feed` bullet: the worked example quoted further down is
    // `text/block.mjs`, which legitimately mentions the wire's own staleness config in a comment.
    const section = DOC.slice(DOC.indexOf('- `ctx.feed`'), DOC.indexOf('### Staleness for a per-series binding'))
    expect(section).toContain('`{ missing, mode, pushed_at, image_rev }`')
    expect(section).not.toContain('stale_after_s')
  })

  /**
   * The repeating group, from both directions.
   *
   * The page now documents that `meta.options` expresses an array of
   * objects, and named `table`'s columns and `chart`'s series as the knobs that paid for it. Both
   * are declared `type: 'list'` now. A doc still carrying the old sentence would send an outside
   * author — the reader this page exists for — to write a hand-built editor for a control the
   * mechanism generates, which is the most expensive kind of wrong a published contract can be.
   *
   * Asserted against the DESIGNS, not a hardcoded pair: a third widget that grows a list needs no
   * edit here, and a list quietly removed from either of these fails.
   */
  it('documents `list` as a type, rather than the limitation it replaced', () => {
    expect(DOC).toContain('`list`')
    const stale = /`meta\.options` cannot express a repeating structure/
    expect(stale.test(DOC), 'the page still states the limitation `list` removed').toBe(false)
  })

  it('names every design that declares a list, so a repeating knob cannot ship undocumented', () => {
    const lists = (CATALOGUE as { meta: { id: string; widget: string; options?: Record<string, { type?: string }> } }[])
      .flatMap((d) => Object.entries(d.meta.options ?? {})
        .filter(([, spec]) => spec?.type === 'list')
        .map(([name]) => ({ design: `${d.meta.widget}/${d.meta.id}`, name })))
    // Guard the guard: an empty discovery would make the loop vacuous.
    expect(lists.length).toBeGreaterThan(0)
    for (const { design, name } of lists) {
      // Inside a backtick span, as a whole word — the same match `screens-doc.test.ts` uses, so a
      // list documented at the location it writes (`config.columns`) counts, which is the spelling
      // an author actually needs.
      const mentioned = new RegExp(`\`[^\`\\n]*\\b${name}\\b[^\`\\n]*\``).test(DOC)
      expect(mentioned, `the contract never mentions ${design}'s list \`${name}\``).toBe(true)
    }
  })

  it('does not describe sound_info as a design-readable option', () => {
    // The doc names it only as the counter-example it is. If a future edit ever presents it as a
    // knob a design consumes, the Android alarm path has been misdocumented into a bug.
    const claims = /`sound_info`[^.]*\b(option|knob a design|design reads|ctx\.config)\b/i
    expect(claims.test(DOC)).toBe(false)
  })
})

/**
 * The data contract's vocabulary, published in `docs/architecture/widgets.md`.
 *
 * A `needs` declaration is machine-readable, which makes a doc table describing it uniquely
 * dangerous: it looks authoritative and nothing forces it to be true. So the table is PARSED and
 * compared against `WIDGET_BINDINGS` itself, both directions — a widget whose needs change without
 * the page changing fails here, and so does a row the page invented.
 *
 * This is the same argument the rest of this file makes, one contract over: the reader cannot tell
 * a wrong page from a right one, and this project has twice shipped documentation that was wrong
 * because it was written from memory.
 */
describe('docs/architecture/widgets.md publishes the real data contract', () => {
  const section = (heading: string): string => {
    const from = DOC.indexOf(heading)
    expect(from, `widgets.md must have a "${heading}" section`).toBeGreaterThan(-1)
    const rest = DOC.slice(from + heading.length)
    // Any heading ends the slice, not just `## `. These sections are `###`, so stopping only at
    // the next `##` swallowed the following two tables and compared the wrong rows.
    const to = /\n#{1,6} /.exec(rest)
    return to === null ? rest : rest.slice(0, to.index)
  }

  /** `| a | b | c |` rows of a markdown table, minus the header and its `|---|` rule. */
  const rows = (source: string): string[][] =>
    source.split('\n')
      .filter((line) => line.startsWith('|') && !/^\|[\s:-]+\|/.test(line))
      .map((line) => line.slice(1, -1).split('|').map((cell) => cell.trim()))
      .slice(1)

  const unquote = (cell: string): string => cell.replace(/`/g, '')

  it('documents exactly the four types, and no fifth', () => {
    const documented = rows(section('### The four types')).map((row) => unquote(row[0]!))
    expect(documented.sort()).toEqual([...NEED_TYPES].sort())
  })

  it('documents exactly the three scopes', () => {
    const documented = rows(section('### The three scopes')).map((row) => unquote(row[0]!))
    expect(documented.sort()).toEqual([...NEED_SCOPES].sort())
  })

  it('documents every widget need, and invents none', () => {
    const documented = rows(section('### What each widget needs')).map(([widget, key, scope, type, modes]) => {
      const collection = /^collection of (.+)$/.exec(unquote(scope!))
      return {
        widget: unquote(widget!),
        need: {
          ...(unquote(key!) === '—' ? {} : { path_from: unquote(key!) }),
          scope: collection ? 'collection' : unquote(scope!),
          type: unquote(type!),
          ...(collection ? { collection_from: collection[1] } : {}),
          ...(unquote(modes!) === 'any' ? {} : { modes: [unquote(modes!)] }),
        },
      }
    })

    const declared = Object.entries(WIDGET_BINDINGS as Record<string, { needs?: object[] }>)
      .flatMap(([widget, binding]) => (binding.needs ?? []).map((need) => ({ widget, need })))

    expect(documented).toEqual(declared)
  })

  it('spells a capability the way the code does, so a reader can match one they were shown', () => {
    expect(DOC).toContain(needCapability('number', 'cpu.percent'))
    expect(DOC).toContain(needCapability('array<object>', 'items'))
  })

  /**
   * The three-way outcome is the part of this contract an operator actually experiences, and the
   * asymmetry between the middle and last rows is a deliberate decision rather than an accident.
   * A page that flattened it to "mismatches are rejected" would be wrong about every legacy board.
   */
  it('states all three mismatch outcomes', () => {
    const outcomes = rows(section('### What a mismatch does'))
    expect(outcomes).toHaveLength(3)
    expect(outcomes.map((row) => row[1])).toEqual([
      expect.stringContaining('Nothing'),
      expect.stringContaining('succeeds'),
      expect.stringContaining('rejected'),
    ])
  })
})
