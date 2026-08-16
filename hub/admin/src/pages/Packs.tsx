import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { useConfirm } from '../confirm'
import { IconPlus, IconTrash } from '../icons'
import { DOCS_URL } from '../docs'
// @ts-expect-error plain JS module without types
import { WIDGET_DEFINITIONS } from '../../../static/device/widgets/definitions.mjs'

interface Finding { level: 'error' | 'warning'; where: string; rule: string; message: string }
interface Upload { manifest: { id?: string; name?: string; version?: string; theme?: { board?: Record<string, unknown> } }; designs: { path: string; source: string }[] }
interface Installed { id: string; name: string; version: string; designs: { widget: string; id: string }[]; install_rev: number }

/** Reads a picked pack folder: pack.json and every designs/<widget>/<id>.mjs, paths relative to the pack. */
async function readFolder(files: FileList | File[]): Promise<Upload | string> {
  const list = Array.from(files)
  const rel = (f: File) => (f.webkitRelativePath || f.name).split('/').slice(1).join('/')
  const manifestFile = list.find((f) => rel(f) === 'pack.json')
  if (!manifestFile) return 'This folder has no pack.json. Pick the pack folder itself (the one that contains pack.json).'
  let manifest
  try { manifest = JSON.parse(await manifestFile.text()) } catch (e) {
    return `pack.json is not valid JSON (${e instanceof Error ? e.message : e}). Check for a missing comma, quote or bracket.`
  }
  const designs = []
  for (const f of list) {
    const path = rel(f)
    if (path.startsWith('designs/') && path.endsWith('.mjs')) designs.push({ path, source: await f.text() })
  }
  return { manifest, designs }
}

/** Draws one design into a canvas with the pack's palette and the widget's sample data. Best effort. */
async function drawPreview(canvas: HTMLCanvasElement, source: string, board: Record<string, unknown>): Promise<void> {
  const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }))
  try {
    const design = (await import(/* @vite-ignore */ url)).default
    const def = (WIDGET_DEFINITIONS as { id: string; sample_config?: object; sample_data?: unknown }[]).find((d) => d.id === design.meta.widget)
    const w = 240
    const h = Math.round(w / (Number(design.meta.suggested_ratio) > 0 ? Number(design.meta.suggested_ratio) : 1))
    canvas.width = w * 2; canvas.height = h * 2
    canvas.style.width = `${w}px`; canvas.style.height = `${h}px`
    const g = canvas.getContext('2d')!
    g.scale(2, 2)
    g.fillStyle = String(board.surface ?? '#ffffff'); g.fillRect(0, 0, w, h)
    const resolve = (spec: unknown) => {
      const v = spec && typeof spec === 'object' ? (spec as { default?: unknown }).default : spec
      return typeof v === 'string' && v.startsWith('@') ? String(board[v.slice(1)] ?? '#888888') : String(v ?? '#888888')
    }
    const tokens = Object.fromEntries(Object.entries(design.meta.tokens ?? {}).map(([k, s]) => [k, resolve(s)]))
    const data = def?.sample_data ?? null
    design.draw(g, { tokens, config: def?.sample_config ?? {}, data, alerts: Array.isArray(data) ? data : [], rows: null, series: [], box: { w, h, t: 1 }, now: Date.now(), state: {}, motion: 'reduced', stale: false, age_ms: null }, 0)
  } finally {
    URL.revokeObjectURL(url)
  }
}

function Preview({ source, board, label }: { source: string; board: Record<string, unknown>; label: string }) {
  const ref = useRef<HTMLCanvasElement>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    if (!ref.current) return
    drawPreview(ref.current, source, board).catch(() => setFailed(true))
  }, [source, board])
  return (
    <figure style={{ margin: 0 }}>
      <canvas ref={ref} aria-label={`Preview of ${label}`} />
      <figcaption className="hint-inline">{failed ? `${label} (no preview)` : label}</figcaption>
    </figure>
  )
}

/**
 * Installing theme packs, on the Themes tab. Owner only (the routes require the signed-in admin),
 * and hidden on hubs that turn packs off. The hub re-checks everything on install; this screen just
 * shows the same findings first.
 */
/**
 * `reloadPage`: the admin learns installed designs once, at startup (main.tsx), so after an install
 * or removal it reloads to know the new set. Injectable for tests.
 */
export default function Packs({ reloadPage = () => window.location.reload(), reloadDelayMs = 1500 }: { reloadPage?: () => void; reloadDelayMs?: number } = {}) {
  const [enabled, setEnabled] = useState<boolean | null>(null)
  const [installed, setInstalled] = useState<Installed[]>([])
  const [upload, setUpload] = useState<Upload | null>(null)
  const [findings, setFindings] = useState<Finding[] | null>(null)
  const [problem, setProblem] = useState('')
  const [done, setDone] = useState('')
  const [busy, setBusy] = useState(false)
  const [ask, confirmDialog] = useConfirm()
  const input = useRef<HTMLInputElement>(null)

  const refresh = () => api<Installed[]>('/admin/api/packs').then(setInstalled).catch(() => {})
  useEffect(() => {
    api<{ packs_enabled?: boolean }>('/admin/api/config')
      .then((c) => { setEnabled(c.packs_enabled !== false); if (c.packs_enabled !== false) refresh() })
      .catch(() => setEnabled(false))
  }, [])
  // React has no prop for folder picking; set the attribute directly.
  useEffect(() => { input.current?.setAttribute('webkitdirectory', '') }, [enabled])

  if (!enabled) return null

  const choose = async (files: FileList | null) => {
    setProblem(''); setDone(''); setFindings(null); setUpload(null)
    if (!files || files.length === 0) return
    const read = await readFolder(files)
    if (typeof read === 'string') { setProblem(read); return }
    setUpload(read)
    try {
      const res = await api<{ findings: Finding[] }>('/admin/api/packs/check', { method: 'POST', body: JSON.stringify(read) })
      setFindings(res.findings)
    } catch (e) { setProblem((e as Error).message) }
  }

  const name = upload?.manifest.name ?? upload?.manifest.id ?? 'this pack'
  const errors = findings?.filter((f) => f.level === 'error') ?? []
  const board = (upload?.manifest.theme?.board ?? {}) as Record<string, unknown>

  return (
    <section>
      <h3 style={{ marginTop: 0 }}>Install a theme pack</h3>
      <p className="hint-inline" style={{ marginBottom: 10 }}>
        A theme pack is a theme plus designs of its own, in one folder.{' '}
        <a href={DOCS_URL + 'theme-packs/'} target="_blank" rel="noreferrer">How to make one</a>
      </p>
      <label className="button-like">
        <IconPlus /> Choose a pack folder
        <input ref={input} type="file" multiple aria-label="Choose a theme pack folder" style={{ display: 'none' }}
          onChange={(e) => { void choose(e.target.files); e.target.value = '' }} />
      </label>

      {problem && <p role="alert" className="source-error">{problem}</p>}
      {done && <p role="status">{done}</p>}

      {findings && upload && (
        <div className="edit-card" style={{ marginTop: 12 }}>
          <h4 style={{ marginTop: 0 }}>{name} {upload.manifest.version ? `(${upload.manifest.version})` : ''}</h4>
          {findings.length > 0 && (
            <ul>
              {findings.map((f, i) => (
                <li key={i} className={f.level === 'error' ? 'feed-rejected' : 'hint-inline'}>
                  {f.level === 'error' ? 'Problem' : 'Note'} in {f.where}: {f.message}
                </li>
              ))}
            </ul>
          )}
          {errors.length > 0
            ? <p className="hint-inline">Fix these in the pack and choose the folder again. Nothing was installed.</p>
            : (
              <>
                <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', margin: '8px 0' }}>
                  {upload.designs.map((d) => <Preview key={d.path} source={d.source} board={board} label={d.path.split('/').pop()!.replace(/\.mjs$/, '')} />)}
                </div>
                <p className="hint-inline">
                  Installing runs this pack's designs on every screen and replaces the settings of its theme if it is
                  already installed (duplicate the theme first to keep your own variation). Only install packs you wrote or trust.
                </p>
                <button type="button" disabled={busy} onClick={async () => {
                  setBusy(true); setProblem('')
                  try {
                    const res = await fetch('/admin/api/packs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(upload), credentials: 'same-origin' })
                    if (!res.ok) {
                      // The hub re-checks on install; show its reasons in the same list.
                      const body = await res.json().catch(() => ({})) as { error?: string; findings?: Finding[] }
                      if (body.findings?.length) setFindings(body.findings)
                      setProblem(body.error ?? `Install failed (${res.status}).`)
                      return
                    }
                    setDone(`Installed ${name}. Screens are reloading to pick it up, and so is this page.`)
                    setUpload(null); setFindings(null)
                    setTimeout(reloadPage, reloadDelayMs)
                  } catch (e) { setProblem((e as Error).message) } finally { setBusy(false) }
                }}>Install {name}</button>
              </>
              )}
        </div>
      )}

      {installed.length > 0 && (
        <table cellPadding={6} style={{ marginTop: 16 }}>
          <thead><tr><th>Installed pack</th><th>Version</th><th>Designs</th><th></th></tr></thead>
          <tbody>
            {installed.map((p) => (
              <tr key={p.id}>
                <td>{p.name}</td>
                <td>{p.version}</td>
                <td>{p.designs.map((d) => d.id).join(', ') || 'none'}</td>
                <td>
                  <button type="button" onClick={() => ask(
                    { title: `Remove ${p.name}?`, body: 'Cards using its designs go back to their widget\'s default design. Its theme stays.', confirmLabel: 'Remove' },
                    async () => {
                      try { await api(`/admin/api/packs/${p.id}`, { method: 'DELETE' }); setDone(`Removed ${p.name}. Reloading.`); setTimeout(reloadPage, reloadDelayMs) }
                      catch (e) { setProblem((e as Error).message) }
                    },
                  )}><IconTrash />Remove</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {confirmDialog}
    </section>
  )
}
