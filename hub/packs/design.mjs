/**
 * Checks for one widget design: its `meta`, the drawing boundary, its settings against what the
 * hub accepts, that every colour it declares is painted, and that `draw` survives real-world data.
 * Pack designs (opts.pack set) also must be one self-contained file at designs/<widget>/<id>.mjs.
 * Built-in designs are checked with the shared rules only (hub/test/packs-design.test.ts).
 */
import { WIDGET_DEFINITIONS } from '../static/device/widgets/definitions.mjs'
import { validateOptions, REQUIRED_META } from '../static/device/widgets/registry.mjs'
import { WIDGET_SETTINGS, THEME_LIMITS, DESIGN_OPTIONS } from './rules.generated.mjs'
import { scanSource } from './scan.mjs'
export { scanSource } from './scan.mjs'
import { error, warning } from './findings.mjs'

const NOW = Date.UTC(2026, 7, 3, 12, 0, 0)

/** A `g` that does nothing but remember which colours were painted. */
function recorder(seen) {
  return new Proxy({}, {
    get: (_t, k) => (k === 'measureText' ? () => ({ width: 10, actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2 }) : () => {}),
    set: (_t, k, v) => { if (seen && (k === 'fillStyle' || k === 'strokeStyle')) seen.push(String(v)); return true },
  })
}

// The contexts the token check has always used (portable-subset.test.ts); changing them changes
// which branches a design takes, so they stay exactly as they were.
const baseCtx = (tokens, over) => ({
  tokens, config: {}, data: null, alerts: [], rows: null, box: { w: 400, h: 200, t: 1 },
  now: NOW, state: {}, motion: 'full', stale: false, age_ms: null, ...over,
})

// For the crash checks: every field the hub's renderer hands a design (widgets/index.mjs), so a
// design that reads, say, ctx.ramp[0] (documented as never empty) isn't reported as crashing.
const fullCtx = (tokens, over) => ({
  tokens, config: {}, data: null, alerts: [], rows: null, series: [], box: { w: 400, h: 200, t: 1 },
  now: NOW, state: {}, motion: 'full', stale: false, age_ms: null,
  ramp: ['#4a90d9', '#d98c4a', '#5fa35f', '#b05fd9'],
  feed: { missing: false, mode: 'value', pushed_at: NOW - 1_000, image_rev: null },
  assets: {}, bitmap: null, ...over,
})

/** The widget's sample contexts: empty, its declared sample, threshold variants, one per alert severity. */
function sampleContexts(widget) {
  const definition = WIDGET_DEFINITIONS.find((d) => d.id === widget)
  const sampleConfig = definition?.sample_config ?? {}
  const sampleData = definition?.sample_data ?? null
  const contexts = [{ config: {}, data: null }, { config: sampleConfig, data: sampleData }]
  const { min, max } = sampleConfig
  if (typeof min === 'number' && typeof max === 'number') {
    const span = max - min
    contexts.push({ config: { ...sampleConfig, thresholds: { warn: min, crit: max + span } }, data: sampleData })
    contexts.push({ config: { ...sampleConfig, thresholds: { warn: min, crit: min } }, data: sampleData })
  }
  const alerts = Array.isArray(sampleData) ? sampleData : []
  const severities = [...new Set(alerts.map((a) => a?.severity).filter((s) => typeof s === 'string'))]
  const runs = severities.length ? severities.map((s) => alerts.filter((a) => a?.severity === s)) : [alerts]
  return { contexts, runs, sampleConfig, sampleData }
}

/** Declared colour tokens that no sample context ever paints. */
export function unpaintedTokens(design) {
  const declared = Object.keys(design.meta.tokens ?? {})
  const tokens = Object.fromEntries(declared.map((s, i) => [s, `#${String(i).padStart(6, '0')}`]))
  const seen = []
  const { contexts, runs } = sampleContexts(design.meta.widget)
  const g = recorder(seen)
  // Each context runs twice: as the guard always built it, and with every field the renderer
  // supplies (ramp, feed, assets, series). The result is the union of what was painted, so this only
  // ever adds coverage for a design that needs those fields, never takes any away.
  const attempt = (ctx) => {
    try { design.draw(g, ctx, 0) } catch { /* drawFailures reports throws */ }
    try { design.draw(g, fullCtx(ctx.tokens, ctx), 0) } catch { /* same */ }
  }
  for (const { config, data } of contexts) {
    for (const alerts of runs) attempt(baseCtx(tokens, { config, data, alerts: data === null ? [] : alerts }))
  }
  const { sampleConfig, sampleData } = sampleContexts(design.meta.widget)
  if (Array.isArray(sampleData) && sampleData.length > 0) {
    // Stream designs read rows, and an interactive one only paints some branches after a gesture.
    const probeConfig = { ...sampleConfig, feed: 'slot-probe' }
    const feed = { missing: false, mode: 'stream', pushed_at: 1_000, image_rev: null }
    const rows = (newestAt, count) => Array.from({ length: count }, (_, i) => ({ payload: sampleData[i % sampleData.length], pushed_at: newestAt - i }))
    attempt(baseCtx(tokens, { config: probeConfig, rows: rows(1_000, 10), feed }))
    if (design.pointer) {
      try { design.pointer.move?.({ config: probeConfig }, -200) } catch { /* reported elsewhere */ }
      attempt(baseCtx(tokens, { config: probeConfig, rows: rows(1_002, 10), feed }))
    }
    // Charts read series: several points per bucket, every other bucket walked backwards, so
    // candles rise and fall and grow wicks.
    const seriesRows = []
    for (let bucket = 0; bucket < 6; bucket++) {
      const values = bucket % 2 === 0 ? sampleData : [...sampleData].reverse()
      for (let k = 0; k < values.length; k++) seriesRows.push({ payload: values[k], pushed_at: (bucket * 60 + k * 15 + 1) * 1_000 })
    }
    attempt(baseCtx(tokens, {
      config: { ...sampleConfig, window_s: 3_600 }, rows: [],
      series: [{ feed: 'sample', rows: [...seriesRows].reverse(), missing: false }], ramp: ['#4a90d9'],
      box: { w: 480, h: 240, t: 1 }, now: 13 * 60_000,
    }))
  }
  return declared.filter((s) => !seen.includes(tokens[s]))
}

/** Each way of drawing that throws, as a plain description of the case. */
export function drawFailures(design) {
  const tokens = Object.fromEntries(Object.keys(design.meta.tokens ?? {}).map((s) => [s, '#808080']))
  const { sampleConfig, sampleData } = sampleContexts(design.meta.widget)
  const min = design.meta.minimum_px
  const small = { w: Number(min?.w) || 80, h: Number(min?.h) || 60, t: 1 }
  const cases = [
    ['the sample data at its smallest size', { config: sampleConfig, data: sampleData, box: small }],
    ['the sample data on a large 1920x1080 card', { config: sampleConfig, data: sampleData, box: { w: 1920, h: 1080, t: 1 } }],
    ['no settings at all (a new card)', { config: {}, data: sampleData }],
    ['no settings and no data', { config: {}, data: null }],
    ['no data yet', { config: sampleConfig, data: null }],
    ['an empty text value as data', { config: sampleConfig, data: '' }],
    ['a text value as data', { config: sampleConfig, data: 'hello' }],
    ['an object with no expected fields as data', { config: sampleConfig, data: { unexpected: true } }],
    ['the number 0 as data', { config: sampleConfig, data: 0 }],
    ['stale data (the feed stopped updating)', { config: sampleConfig, data: sampleData, stale: true, age_ms: 3_600_000 }],
  ]
  for (const [name, spec] of Object.entries(design.meta.options ?? {})) {
    const path = typeof spec?.path === 'string' ? spec.path : name
    if (!path.startsWith('design_options.')) continue
    const key = path.slice('design_options.'.length)
    const wrong = typeof spec.default === 'string' || spec.type === 'select' || spec.type === 'text' ? 42 : 'not-a-valid-value'
    cases.push([`${path} not set`, { config: { ...sampleConfig, design_options: {} }, data: sampleData }])
    cases.push([`${path} set to a wrong value (${JSON.stringify(wrong)})`, { config: { ...sampleConfig, design_options: { [key]: wrong } }, data: sampleData }])
  }
  const failures = []
  for (const [label, over] of cases) {
    try { design.draw(recorder(null), fullCtx(tokens, over), 0) } catch (e) { failures.push(`${label} (${e instanceof Error ? e.message : String(e)})`) }
  }
  return failures
}

/** Settings that are the cell itself (its data binding, its design), not something a design sets. */
const RESERVED = new Set(['feed', 'path', 'design', 'design_options', 'card', 'source_draft_id', 'output_contract'])
const LIST_BINDING_KEYS = new Set(['feed', 'source_draft_id', 'output_contract'])
const OPTION_TYPES = { text: ['string'], number: ['number', 'integer'], boolean: ['boolean'] }

/**
 * Every setting a design declares must save: an existing setting of its widget with a compatible
 * type, choices and size, or a value under design_options the hub can store. The same answers the
 * hub's save gives (the rules come from its cell schema via rules.generated.mjs).
 */
function checkSettings(meta, where) {
  const out = []
  const settings = WIDGET_SETTINGS[meta.widget]
  if (!settings) return out
  const keyPattern = new RegExp(DESIGN_OPTIONS.keyPattern)
  for (const [name, spec] of Object.entries(meta.options ?? {})) {
    if (!spec || typeof spec !== 'object') continue
    const path = typeof spec.path === 'string' ? spec.path : name
    const fail = (rule, message) => out.push(error(where, rule, `Setting "${name}": ${message}`))
    if (RESERVED.has(path)) {
      fail('design.reserved-setting', `"${path}" is part of the card itself (its data or its design), not a setting a design can declare. Remove it.`)
      continue
    }
    if (path.startsWith('design_options.')) {
      const key = path.slice('design_options.'.length)
      if (!keyPattern.test(key)) fail('design.option-key', `the name after design_options. must be lowercase letters, digits and underscores, starting with a letter, up to 32 characters (got "${key}").`)
      if (spec.type === 'list') fail('design.option-type', 'a list of rows can\'t be stored in design_options; use a text, number, true/false or select setting.')
      if (typeof spec.default === 'string' && spec.default.length > DESIGN_OPTIONS.maxString) fail('design.option-type', `its default is longer than the ${DESIGN_OPTIONS.maxString} characters design_options can store.`)
      for (const c of spec.choices ?? []) {
        const v = c && typeof c === 'object' ? c.value : c
        if (typeof v === 'string' && v.length > DESIGN_OPTIONS.maxString) fail('design.option-type', `a choice is longer than the ${DESIGN_OPTIONS.maxString} characters design_options can store.`)
      }
      continue
    }
    const leaf = settings.leaves[path]
    const list = settings.lists[path]
    if (!leaf && !list) {
      const suggestion = /^[a-z][a-z0-9_]{0,31}$/.test(name) ? name : name.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^[^a-z]+/, '') || 'my_setting'
      fail('design.unknown-setting', `it saves to "${path}", which a ${meta.widget} doesn't have, so saving a screen with this design would fail. Put a design's own settings under design_options: use path "design_options.${suggestion}".`)
      continue
    }
    if (list) {
      if (spec.type !== 'list') { fail('design.option-type', `"${path}" holds a list of rows on a ${meta.widget}, so this setting must be a list.`); continue }
      const keys = Object.keys(spec.item ?? {})
      const allowed = list.itemKeys.filter((k) => !LIST_BINDING_KEYS.has(k))
      const extra = keys.filter((k) => !list.itemKeys.includes(k))
      const missing = list.required.filter((k) => !keys.includes(k))
      if (extra.length) fail('design.option-list', `rows may only have ${allowed.join(', ')}; remove ${extra.join(', ')}.`)
      if (missing.length) fail('design.option-list', `rows must include ${missing.join(', ')}.`)
      if ((list.minItems !== undefined && typeof spec.min === 'number' && spec.min < list.minItems) || (list.maxItems !== undefined && typeof spec.max === 'number' && spec.max > list.maxItems)) {
        fail('design.option-list', `allows ${spec.min} to ${spec.max} rows, but the hub keeps ${list.minItems ?? 0} to ${list.maxItems} for ${path}.`)
      }
      continue
    }
    if (spec.type === 'list') { fail('design.option-type', `"${path}" holds a single value on a ${meta.widget}, not a list.`); continue }
    if (spec.type === 'select') {
      const choices = (spec.choices ?? []).map((c) => (c && typeof c === 'object' ? c.value : c))
      if (Array.isArray(leaf.enum)) {
        const bad = choices.filter((c) => !leaf.enum.includes(c))
        if (bad.length) fail('design.option-choices', `the hub only accepts ${leaf.enum.join(', ')} for ${path}; remove ${bad.join(', ')}.`)
      } else if (leaf.type && !choices.every((c) => (leaf.type === 'string' ? typeof c === 'string' : typeof c === 'number'))) {
        fail('design.option-type', `its choices don't match what ${path} holds (${leaf.type}).`)
      }
    } else if (OPTION_TYPES[spec.type] && leaf.type !== undefined) {
      const ok = OPTION_TYPES[spec.type].includes(leaf.type) || (Array.isArray(leaf.type) && leaf.type.some((t) => OPTION_TYPES[spec.type].includes(t)))
      if (!ok) fail('design.option-type', `it is a ${spec.type} setting, but ${path} on a ${meta.widget} holds a ${leaf.type}.`)
    } else if (OPTION_TYPES[spec.type] && Array.isArray(leaf.enum) && spec.type !== 'text') {
      fail('design.option-type', `${path} on a ${meta.widget} is one of ${leaf.enum.join(', ')}; use a select setting.`)
    }
    if (spec.type === 'number' && (
      (leaf.minimum !== undefined && typeof spec.min === 'number' && spec.min < leaf.minimum)
      || (leaf.maximum !== undefined && typeof spec.max === 'number' && spec.max > leaf.maximum))) {
      fail('design.option-bounds', `it allows ${spec.min ?? 'any'} to ${spec.max ?? 'any'}, but the hub only accepts ${leaf.minimum ?? 'any'} to ${leaf.maximum ?? 'any'} for ${path}. Narrow min/max.`)
    }
  }
  return out
}

/**
 * @param {{ path?: string, source: string, module: any }} file module is null when it could not be imported
 * @param {{ pack?: { id: string } }} opts
 */
export function checkDesign(file, opts = {}) {
  const where = file.path ?? 'design'
  const out = []
  const scan = scanSource(file.source ?? '')
  if (opts.pack && scan.imports.length) {
    out.push(error(where, 'design.import', `A pack design must be one file with no imports, so it can be checked and installed on its own. Remove: ${scan.imports.join(', ')} (copy any small helper into this file).`))
  }
  if (scan.disallowedOps.length) out.push(error(where, 'design.portable-subset', `Uses drawing calls outside what every screen supports: ${scan.disallowedOps.map((o) => `g.${o}`).join(', ')}. See "The portable drawing subset" in docs/architecture/widgets.md.`))
  if (scan.browserApis.length) out.push(error(where, 'design.browser-api', `Reaches for ${scan.browserApis.join(', ')}. A design only draws with g and reads ctx; use ctx.now for the time, never timers, the network or the page.`))

  const design = file.module?.default
  if (!design) {
    if (!out.some((f) => f.rule === 'design.import')) out.push(error(where, 'design.load', file.loadError ? `Could not load this design: ${file.loadError}` : 'A design file must `export default { meta, draw }`.'))
    return out
  }
  const meta = design.meta
  if (!meta || typeof meta !== 'object') return [...out, error(where, 'design.meta', 'The default export needs a "meta" object (id, widget, label, suggested_ratio, tokens, animations).')]
  const missing = REQUIRED_META.filter((k) => meta[k] === undefined)
  if (missing.length) out.push(error(where, 'design.meta', `meta is missing ${missing.join(', ')}.`))
  if (typeof design.draw !== 'function') out.push(error(where, 'design.draw', 'The default export needs a draw(g, ctx) function.'))
  if (typeof meta.id !== 'string' || meta.id.length < 1 || meta.id.length > THEME_LIMITS.designIdMaxLength) out.push(error(where, 'design.id', `meta.id must be text, 1 to ${THEME_LIMITS.designIdMaxLength} characters.`))
  if (!WIDGET_DEFINITIONS.some((d) => d.id === meta.widget)) {
    out.push(error(where, 'design.unknown-widget', `meta.widget "${meta.widget}" is not a widget type. Use one of: ${WIDGET_DEFINITIONS.map((d) => d.id).join(', ')}.`))
    return out
  }
  if (opts.pack) {
    const expected = `designs/${meta.widget}/${meta.id}.mjs`
    if (file.path && !file.path.replace(/\\/g, '/').endsWith(expected)) out.push(error(where, 'design.path', `This file should be at ${expected} (its folder is the widget type, its name the design id).`))
  }
  const optionsError = validateOptions(meta)
  if (optionsError) {
    // Malformed options: report it and stop before anything walks them.
    out.push(error(where, 'design.options', `meta.${optionsError}.`))
    return out
  }
  out.push(...checkSettings(meta, where))
  if (typeof design.draw !== 'function' || missing.length) return out

  for (const token of unpaintedTokens(design)) {
    out.push(error(where, 'design.token-unpainted', `Colour "${token}" is declared in meta.tokens but never painted, in any sample. Paint with it (g.fillStyle or g.strokeStyle = ctx.tokens.${token}) or remove it.`))
  }
  const failures = drawFailures(design)
  if (failures.length) out.push(error(where, 'design.draw-throws', `draw crashes with ${failures.slice(0, 3).join('; ')}. A design must draw something sensible for any data and any setting value.`))
  if (!Object.keys(meta.tokens ?? {}).length) out.push(warning(where, 'design.no-tokens', 'This design declares no colour tokens, so themes cannot recolour it.'))
  return out
}
