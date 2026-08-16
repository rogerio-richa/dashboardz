#!/usr/bin/env node
/**
 * Checks a theme pack folder and, with --previews, draws each design to a PNG.
 *
 *   node hub/scripts/check-pack.mjs <pack-folder> [--previews <out-folder>]
 *
 * Exit 0: no errors (warnings allowed). Exit 1: errors. Exit 2: bad usage. Needs Node 22+, nothing
 * else; previews also need Chrome or Chromium (set CHROME_PATH to point at a specific one).
 * The rules are the hub's own, from hub/packs/. See docs/theme-packs.md.
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { checkPack, scanSource } from '../packs/index.mjs'
import { findChrome, previewsSupported, renderPreviews } from '../packs/preview.mjs'
import { WIDGET_DEFINITIONS } from '../static/device/widgets/definitions.mjs'

const USAGE = 'Usage: node hub/scripts/check-pack.mjs <pack-folder> [--previews <out-folder>]'

function parseArgs(argv) {
  const args = { folder: null, previews: null }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--previews') args.previews = argv[++i] ?? null
    else if (argv[i] === '--help' || argv[i] === '-h') return null
    else if (!args.folder) args.folder = argv[i]
  }
  return args.folder && (args.previews !== null || !argv.includes('--previews')) ? args : null
}

/** Every file under designs/, as paths relative to the pack folder with forward slashes. */
function designFiles(root) {
  const base = join(root, 'designs')
  if (!existsSync(base)) return { files: [], broken: [] }
  const out = []
  const broken = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      const rel = relative(root, full).split(sep).join('/')
      let stat
      try { stat = statSync(full) } catch {
        // A link pointing nowhere: report it, don't crash.
        if (lstatSync(full).isSymbolicLink()) broken.push(rel)
        continue
      }
      if (stat.isDirectory()) walk(full)
      else out.push(rel)
    }
  }
  walk(base)
  return { files: out.sort(), broken }
}

async function loadPack(root) {
  const findings = []
  let manifest
  const manifestPath = join(root, 'pack.json')
  if (!existsSync(manifestPath)) {
    findings.push({ level: 'error', where: 'pack.json', rule: 'manifest.missing', message: 'This folder has no pack.json. A pack is a folder with pack.json and an optional designs/ folder.' })
  } else {
    try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) } catch (e) {
      findings.push({ level: 'error', where: 'pack.json', rule: 'manifest.json', message: `pack.json is not valid JSON (${e instanceof Error ? e.message : e}). Check for a missing comma, quote or bracket.` })
    }
  }
  const designs = []
  let n = 0
  const { files, broken } = designFiles(root)
  for (const rel of broken) findings.push({ level: 'warning', where: rel, rule: 'pack.broken-link', message: 'This is a link to a file that does not exist, so it is ignored.' })
  for (const rel of files) {
    if (!rel.endsWith('.mjs')) {
      findings.push({ level: 'warning', where: rel, rule: 'pack.stray-file', message: 'This is not a design file (designs are .mjs files), so it is ignored.' })
      continue
    }
    const full = join(root, rel)
    const source = readFileSync(full, 'utf8')
    const design = { path: rel, source, module: null }
    // Scanned before importing: a design with imports is reported, never loaded.
    if (scanSource(source).imports.length === 0) {
      try { design.module = await import(`${pathToFileURL(full).href}?check=${Date.now()}-${n++}`) } catch (e) {
        design.loadError = e instanceof Error ? e.message.split('\n')[0] : String(e)
      }
    }
    designs.push(design)
  }
  return { manifest, designs, findings }
}

function print(findings) {
  const groups = new Map()
  for (const f of findings) {
    const file = f.where.split(' ')[0]
    if (!groups.has(file)) groups.set(file, [])
    groups.get(file).push(f)
  }
  for (const [file, list] of groups) {
    console.log(`\n${file}`)
    for (const f of list) {
      const detail = f.where !== file ? ` (${f.where.slice(file.length).trim()})` : ''
      console.log(`  ${f.level === 'error' ? 'error  ' : 'warning'}  ${f.message}${detail}`)
    }
  }
  const errors = findings.filter((f) => f.level === 'error').length
  const warnings = findings.length - errors
  console.log(findings.length === 0 ? 'No problems found.' : `\n${errors} error${errors === 1 ? '' : 's'}, ${warnings} warning${warnings === 1 ? '' : 's'}`)
  return errors
}

/** A file name that stays inside the previews folder whatever a design id or choice contains. */
const safeName = (name) => String(name).replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'preview'

async function previews(root, outDir, manifest, designs, findings) {
  if (!previewsSupported()) {
    console.log(`\nPreviews skipped: they need Node 22 or newer (this is ${process.version}). The checks above ran normally.`)
    return
  }
  const bin = findChrome()
  if (!bin) {
    console.log('\nPreviews skipped: Chrome was not found. Install Google Chrome or Chromium, or set CHROME_PATH to the browser\'s executable.')
    return
  }
  const board = manifest?.theme?.board ?? {}
  const broken = new Set(findings.filter((f) => f.level === 'error').map((f) => f.where.split(' ')[0]))
  const jobs = []
  for (const d of designs) {
    const meta = d.module?.default?.meta
    if (!meta || broken.has(d.path)) continue
    const def = WIDGET_DEFINITIONS.find((x) => x.id === meta.widget)
    const w = 480
    const h = Math.round(w / (Number(meta.suggested_ratio) > 0 ? Number(meta.suggested_ratio) : 1))
    const config = { ...(def?.sample_config ?? {}) }
    const data = def?.sample_data ?? null
    const rows = Array.isArray(data) ? data.map((payload, i) => ({ payload, pushed_at: 1_000 - i })) : null
    jobs.push({ name: safeName(meta.id), source: d.source, w, h, config, data, rows })
    // One more preview per choice of each of the design's own select settings.
    for (const [name, spec] of Object.entries(meta.options ?? {})) {
      const path = typeof spec?.path === 'string' ? spec.path : name
      if (!path.startsWith('design_options.') || spec.type !== 'select') continue
      const key = path.slice('design_options.'.length)
      for (const choice of spec.choices ?? []) {
        const value = typeof choice === 'object' ? choice.value : choice
        if (value === spec.default) continue
        jobs.push({ name: safeName(`${meta.id}-${key}-${value}`), source: d.source, w, h, config: { ...config, design_options: { [key]: value } }, data, rows })
      }
    }
  }
  if (jobs.length === 0) { console.log('\nNo previews: no design without errors to draw.'); return }
  mkdirSync(outDir, { recursive: true })
  const results = await renderPreviews(bin, jobs, board)
  console.log(`\nPreviews in ${outDir}:`)
  for (const r of results) {
    if (r.png) { writeFileSync(join(outDir, `${r.name}.png`), r.png); console.log(`  ${r.name}.png`) }
    else console.log(`  ${r.name}: could not draw (${r.error})`)
  }
}

const args = parseArgs(process.argv.slice(2))
if (!args) { console.log(USAGE); process.exit(2) }
const root = resolve(args.folder)
if (!existsSync(root) || !statSync(root).isDirectory()) { console.log(`${args.folder} is not a folder.\n${USAGE}`); process.exit(2) }

const { manifest, designs, findings } = await loadPack(root)
let all = findings
if (manifest !== undefined) {
  try { all = [...findings, ...checkPack({ manifest, designs })] } catch (e) {
    all = [...findings, { level: 'error', where: 'pack', rule: 'checker.internal', message: `The checker hit a problem it could not report cleanly (${e instanceof Error ? e.message : e}). Please report this, with the pack, as a Dashboardz bug.` }]
  }
}
const errors = print(all)
if (args.previews) {
  try { await previews(root, resolve(args.previews), manifest, designs, all) } catch (e) {
    console.log(`\nPreviews failed: ${e instanceof Error ? e.message : e}`)
  }
}
process.exit(errors > 0 ? 1 : 0)
