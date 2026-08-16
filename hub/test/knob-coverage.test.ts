import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, it, expect } from 'vitest'
import { analyseConfigReads, type ConfigReadAnalysis, type KnobReport } from './reachable-config-reads.js'

/**
 * The dead-knob guard ensures that every property accepted by the schema is consumed by browser
 * renderer code that something can actually REACH. This catches configuration such as `scale` on
 * stream_list/table and clock when no reachable renderer reads it.
 *
 * The guard covers the web renderer; the retired Compose board is outside this boundary, so it has
 * no second renderer to compare.
 *
 * A name appearing in source is not enough to establish that a knob is used:
 *   - a name in PROSE counted even when no renderer consumed it. Comments are stripped before matching.
 *   - a name in DEAD CODE counted when a helper had no caller. This uses `./reachable-config-reads.ts` — a real parse, the
 *     enclosing function of every read, and reachability from the entry points the outside world
 *     can actually invoke. That module's docstring lists every approximation it makes and why they
 *     all lean toward calling something reachable.
 *
 * `source-scan.ts` is therefore no longer used here — an AST has no comments in it to strip. It
 * stays because `portable-subset.test.ts`'s browser-API guard is still a text scan and still needs
 * it.
 */
// Paths are relative to the hub/ package root (vitest's cwd).
// The widgets/** canvas library is the browser renderer for the widgets it supports
// (web-renderer boundary) just as much as device.js/layout-core.mjs are for everything else — index.mjs
// is where designFor resolves cell.config?.design.
/*
 * The widget library is WALKED, not listed. A hardcoded path list goes stale when a design is
 * added: the canvas renderer moved `stream_list`, `table` and
 * `alert_feed` off device.js, and none of the three was in it. That was invisible until
 * `alert_feed`'s DOM branch — the last `cfg.counter` read in a listed file — was deleted, and
 * `counter` reported as a dead knob while three separate designs were reading it.
 *
 * A stale list here fails in the DANGEROUS direction for a guard whose whole job is to notice
 * deletions: it under-reports what the renderer reads, so it cries wolf on live knobs, and the
 * habit of adding a name to the list to quiet it is exactly how a genuinely dead knob gets waved
 * through. Walking the tree is what `portable-subset.test.ts` already does for the same directory
 * and the same reason. Walking it also means the whole library is in ONE analysis, which is what
 * lets a read in `gauge/shared.mjs` count as reached from `gauge/ring.mjs`'s `draw`.
 */
function mjsUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((e) => {
    const p = join(dir, e)
    return statSync(p).isDirectory() ? mjsUnder(p) : p.endsWith('.mjs') ? [p] : []
  })
}

const BROWSER_FILES = [
  'static/device/device.js', 'static/device/layout-core.mjs',
  ...mjsUnder('static/device/widgets'),
].map((p) => resolve(p))

const browser = analyseConfigReads(BROWSER_FILES)

const short = (path: string) => path.replace(`${process.cwd()}/`, '')

/** Name the knob AND why it failed — "unread" and "read only from dead code" want different fixes. */
function explain(knob: string, report: KnobReport): string {
  if (report.status === 'unread') {
    return `${knob} is never read as config in any browser renderer file`
  }
  const where = report.sites.map((s) => `${short(s.file)}:${s.line} (in ${s.owner})`).join(', ')
  return `${knob} is read ONLY from code nothing can call: ${where}. `
    + 'Either wire its reader back up to an entry point, or drop the knob from the save schema.'
}

/** Properties deliberately not read by a renderer, each with the reason it is exempt. */
const EXEMPT: Record<string, string> = {
  widget: 'dispatch key, not a config knob',
  config: 'the container itself',
  rect: 'consumed as a whole by rectToPx, never by name',
  x: 'rect member', y: 'rect member', w: 'rect member', h: 'rect member',
}

// Every config property name the schema accepts, gathered from the widget oneOf branches.
const KNOBS = [
  'scale', 'feed', 'path', 'min_severity', 'clamp', 'title_lines', 'body_lines', 'overflow',
  'counter', 'label', 'unit', 'format', 'decimals', 'min', 'max', 'style', 'thresholds', 'warn',
  'crit', 'title_path', 'body_path', 'columns', 'header', 'align', 'headers', 'series', 'y_path',
  'icon', 'window_s', 'y_min', 'y_max', 'text', 'fit', 'design', 'days', 'show_humidity',
  'show_precipitation', 'show_wind', 'show_pollen',
  'items', 'show_summary', 'show_source', 'show_time',
  'ticker', 'speed', 'family', 'text_px', 'separator', 'direction',
  'led', 'lines', 'color', 'colors', 'effect', 'off_dots', 'glow', 'border', 'border_color',
  'candles', 'bucket_s', 'wick', 'mode', 'rolling',
]

describe('every config knob reaches the renderer', () => {
  for (const knob of KNOBS) {
    if (EXEMPT[knob]) continue
    it(`${knob} is read by the browser renderer`, () => {
      const report = browser.report(knob)
      expect(report.status, explain(knob, report)).toBe('read')
    })
  }
})

it('the guard can actually fail', () => {
  // A knob no renderer reads must be reported missing. Without this, a matcher typo would silently
  // turn every assertion above green — the exact failure mode this test was tightened to avoid.
  expect(browser.report('definitely_not_a_real_knob').status).toBe('unread')
})

/**
 * Write sources to a scratch directory and analyse them ALONE. Alone matters: the analysis resolves
 * calls by name across every file it is given, so a pristine copy sitting beside a mutated one
 * would reach into it and rescue the very function the mutation orphaned.
 */
function analyseSources(sources: Record<string, string>): ConfigReadAnalysis {
  const dir = mkdtempSync(join(tmpdir(), 'knob-reachability-'))
  return analyseConfigReads(Object.entries(sources).map(([name, src]) => {
    const path = join(dir, name)
    writeFileSync(path, src)
    return path
  }))
}

describe('the guard only counts executable code', () => {
  /*
   * The guard's own behaviour, on the two ways a knob name can survive its reader's death.
   */
  it('a knob mentioned only in a comment does NOT count as read', () => {
    const analysis = analyseSources({
      'commented.mjs': 'export function draw(cfg) {\n// the cfg.retired_knob we deleted\n/* cfg.retired_knob */\nreturn cfg\n}\n',
    })
    expect(analysis.report('retired_knob').status).toBe('unread')
  })

  it('the same knob in real code DOES count as read', () => {
    const analysis = analyseSources({ 'live.mjs': 'export function draw(cfg) { return cfg.retired_knob }\n' })
    expect(analysis.report('retired_knob').status).toBe('read')
  })

  it("a knob named in a STRING still counts — config['min_severity'] is a real read", () => {
    const analysis = analyseSources({ 'live.mjs': "export function draw(config) { return config['min_severity'] }\n" })
    expect(analysis.report('min_severity').status).toBe('read')
  })
})

describe('the guard only counts REACHABLE code', () => {
  /*
   * The acceptance test for the reachability half, run against a real renderer file rather than a
   * toy: `news/list.mjs`, its real `items` knob, and its real `requestedItems` reader, whose ONE
   * caller is deleted while the reader itself stays exactly where it was. The shipped file is never
   * touched — it is read, mutated in memory, and written to a scratch copy — so the "before"
   * variant is by construction the file as it ships today and cannot drift from it.
   *
   * A name can remain in a live-looking function after its only caller is removed, so following
   * the call graph is required.
   */
  const NEWS_LIST = resolve('static/device/widgets/news/list.mjs')
  const shipped = readFileSync(NEWS_LIST, 'utf8')
  const ONLY_CALLER = 'requestedItems(safeConfig)'
  const THE_READ = "ownData(config, 'items')"

  it('the fixture premise holds: one caller, one read', () => {
    expect(shipped.split(ONLY_CALLER).length - 1, `${ONLY_CALLER} is no longer the sole call`).toBe(1)
    expect(shipped.split(THE_READ).length - 1, `${THE_READ} is no longer the sole read`).toBe(1)
  })

  it('the untouched file reads `items`', () => {
    expect(analyseSources({ 'list.mjs': shipped }).report('items').status).toBe('read')
  })

  it('deleting the READER\'S ONLY CALLER makes `items` dead, though the read is still there', () => {
    const orphaned = shipped.replace(ONLY_CALLER, 'DEFAULT_ITEMS')
    expect(orphaned, 'the mutation did nothing').not.toBe(shipped)
    expect(orphaned).toContain(THE_READ)

    const analysis = analyseSources({ 'list.mjs': orphaned })
    const report = analysis.report('items')
    expect(report.status).toBe('dead-code-only')
    expect(report.sites.map((s) => s.owner)).toContain('requestedItems')
    expect(analysis.deadFunctions.join('\n')).toContain('requestedItems')
    expect(explain('items', report)).toContain('read ONLY from code nothing can call')
  })

  it('deleting the READ itself still fails, and says so differently', () => {
    const analysis = analyseSources({ 'list.mjs': shipped.replace(THE_READ, "ownData(config, 'count')") })
    const report = analysis.report('items')
    expect(report.status).toBe('unread')
    expect(explain('items', report)).toContain('never read as config')
  })
})
