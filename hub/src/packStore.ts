/**
 * Installed theme packs on disk: <DATA_DIR>/packs/<pack id>/pack.json and designs/<widget>/<id>.mjs,
 * next to the database so backups and the Docker volume carry them.
 *
 * Checking an upload IMPORTS its designs into this process and runs them (the shared checker in
 * hub/packs drives `draw`). That is the owner-only trust model the docs describe: install only packs
 * you wrote or trust. Hosted hubs turn installs off (PACKS_ENABLED=false).
 */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomBytes } from 'node:crypto'

export const MAX_DESIGNS = 64
export const MAX_DESIGN_BYTES = 256 * 1024
export const PACK_ID_RE = /^[a-z][a-z0-9-]{1,31}$/
const DESIGN_PATH_RE = /^designs\/([a-z_]+)\/([A-Za-z0-9_-]+)\.mjs$/
const WIDGET_RE = /^[a-z_]+$/
const FILE_RE = /^[A-Za-z0-9_-]+\.mjs$/

export interface UploadedPack { manifest: unknown; designs: { path: string; source: string }[] }
export interface Finding { level: 'error' | 'warning'; where: string; rule: string; message: string }

/**
 * The shared checker, loaded at runtime: hub/packs is plain ESM outside src/ (rootDir), and this
 * path resolves to it from src/ under tsx and from dist/ in the Docker image alike.
 */
const CHECKER_URL = new URL('../packs/index.mjs', import.meta.url).href
async function loadChecker(): Promise<{ checkPack: (p: unknown) => Finding[]; catalogueIds: () => Record<string, string[]>; scanSource: (s: string) => { imports: string[] } }> {
  return import(CHECKER_URL)
}

export const packsRoot = (dataDir: string) => join(dataDir, 'packs')

/** Shape problems the checker can't see: sizes, counts, file paths. Plain findings, never thrown. */
export function uploadProblems(body: UploadedPack): Finding[] {
  const out: Finding[] = []
  const err = (where: string, rule: string, message: string) => out.push({ level: 'error', where, rule, message })
  if (!body || typeof body !== 'object' || !Array.isArray(body.designs)) {
    err('pack', 'upload.shape', 'The upload must contain pack.json and a list of design files.')
    return out
  }
  if (body.designs.length > MAX_DESIGNS) err('pack', 'upload.too-many', `A pack can have at most ${MAX_DESIGNS} designs.`)
  for (const d of body.designs) {
    if (!d || typeof d.path !== 'string' || typeof d.source !== 'string') { err('pack', 'upload.shape', 'Each design needs a path and its source.'); continue }
    if (!DESIGN_PATH_RE.test(d.path)) err(d.path, 'upload.path', 'Design files belong at designs/<widget>/<design id>.mjs.')
    if (Buffer.byteLength(d.source) > MAX_DESIGN_BYTES) err(d.path, 'upload.too-large', `This design is larger than ${MAX_DESIGN_BYTES / 1024} KB.`)
  }
  return out
}

/** Where a check unpacks an upload: the system temp folder (PACKS_TMP_DIR overrides it). */
const checkTempBase = () => process.env.PACKS_TMP_DIR || tmpdir()

/** Writes an upload's files into `dir` (created) and returns it. */
function writeFiles(dir: string, body: UploadedPack): string {
  mkdirSync(join(dir, 'designs'), { recursive: true })
  writeFileSync(join(dir, 'pack.json'), JSON.stringify(body.manifest, null, 2))
  for (const d of body.designs) {
    const file = join(dir, d.path)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, d.source)
  }
  return dir
}

/** Runs the shared checker on an upload: writes it to a temp folder, imports, checks, cleans up. */
export async function checkUpload(dataDir: string, body: UploadedPack): Promise<Finding[]> {
  const shape = uploadProblems(body)
  if (shape.some((f) => f.level === 'error')) return shape
  const { checkPack, scanSource } = await loadChecker()
  let dir = ''
  try {
    // In the temp folder, deleted in `finally` whatever happens.
    dir = writeFiles(mkdtempSync(join(checkTempBase(), 'dbz-pack-check-')), body)
    const designs = []
    for (const d of body.designs) {
      const design: { path: string; source: string; module: unknown; loadError?: string } = { path: d.path, source: d.source, module: null }
      try {
        // The checker's own scan decides: a design with imports is reported, never loaded. (Not a
        // security boundary: import-free code runs too; the owner-only trust model is the boundary.)
        if (scanSource(d.source).imports.length === 0) {
          design.module = await import(`${pathToFileURL(join(dir, d.path)).href}?check=${randomBytes(4).toString('hex')}`)
        }
      } catch (e) {
        design.loadError = e instanceof Error ? e.message.split('\n')[0] : String(e)
      }
      designs.push(design)
    }
    return [...shape, ...checkPack({ manifest: body.manifest, designs })]
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * Replaces <packs>/<id> with the upload in one rename, so a reader never sees half a pack. The
 * staging copy sits next to the live one (a rename can't cross disks, and in Docker the temp folder
 * and the data volume are different disks). It is removed if anything fails, the replaced copy is
 * removed after the swap, and `sweepPackTemps` clears anything a crash left behind at startup.
 */
export function writePack(dataDir: string, id: string, body: UploadedPack): void {
  const root = packsRoot(dataDir)
  mkdirSync(root, { recursive: true })
  const fresh = join(root, `.new-${id}-${randomBytes(6).toString('hex')}`)
  const live = join(root, id)
  const old = existsSync(live) ? join(root, `.old-${id}-${randomBytes(6).toString('hex')}`) : null
  try {
    writeFiles(fresh, body)
    if (old) renameSync(live, old)
    try {
      renameSync(fresh, live)
    } catch (e) {
      if (old) renameSync(old, live)
      throw e
    }
  } finally {
    rmSync(fresh, { recursive: true, force: true })
    if (old) rmSync(old, { recursive: true, force: true })
  }
}

/** Removes temporary folders (.new-*, .old-*, .check-*) a crash may have left under packs/. */
export function sweepPackTemps(dataDir: string): void {
  let entries: string[]
  try { entries = readdirSync(packsRoot(dataDir)) } catch { return }
  for (const e of entries) {
    if (/^\.(new|old|check)-/.test(e)) rmSync(join(packsRoot(dataDir), e), { recursive: true, force: true })
  }
}

export const removePack = (dataDir: string, id: string): void => rmSync(join(packsRoot(dataDir), id), { recursive: true, force: true })

/** The bytes of one installed design, or null for anything that isn't exactly that. */
export function readPackDesign(dataDir: string, pack: string, widget: string, file: string): Buffer | null {
  if (!PACK_ID_RE.test(pack) || !WIDGET_RE.test(widget) || !FILE_RE.test(file)) return null
  try { return readFileSync(join(packsRoot(dataDir), pack, 'designs', widget, file)) } catch { return null }
}
