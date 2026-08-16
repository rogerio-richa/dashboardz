/**
 * Preview PNGs of pack designs, drawn by a real browser canvas: headless Chrome over the DevTools
 * protocol, using Node's built-in WebSocket (Node 22+), so the checker needs no npm install. Node
 * only; the check module itself never imports this.
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
]

const isProgram = (p) => { try { return statSync(p).isFile() } catch { return false } }

/**
 * CHROME_PATH, when set, is the only browser tried; otherwise the usual install locations. Only a
 * file counts: on a Mac, CHROME_PATH pointing at "Google Chrome.app" (a folder) is "not found".
 */
export function findChrome(env = process.env) {
  if (env.CHROME_PATH) return isProgram(env.CHROME_PATH) ? env.CHROME_PATH : null
  return CANDIDATES.find((p) => isProgram(p)) ?? null
}

/** Previews talk to Chrome with the WebSocket built into Node 22+. */
export const previewsSupported = () => typeof globalThis.WebSocket === 'function'

/** Starts headless Chrome and returns a tiny CDP session on one blank page. */
async function openBrowser(bin) {
  const profile = mkdtempSync(join(tmpdir(), 'dbz-pack-preview-'))
  const child = spawn(bin, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] })
  // Whatever goes wrong while starting, Chrome is stopped and its temp profile removed.
  const abandon = () => { try { child.kill() } catch { /* not running */ } try { rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }) } catch { /* harmless */ } }
  try {
    return await connect(child, profile)
  } catch (e) {
    abandon()
    throw e
  }
}

async function connect(child, profile) {
  const endpoint = await new Promise((resolve, reject) => {
    child.on('error', (e) => reject(new Error(`could not start Chrome (${e.message})`)))
    let buf = ''
    const timer = setTimeout(() => reject(new Error('Chrome did not start within 15 seconds')), 15_000)
    child.stderr.on('data', (d) => {
      buf += d
      const m = buf.match(/DevTools listening on (ws:\/\/\S+)/)
      if (m) { clearTimeout(timer); resolve(m[1]) }
    })
    child.on('exit', () => reject(new Error('Chrome exited before it was ready')))
  })
  const ws = new WebSocket(endpoint)
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error('could not connect to Chrome')) })
  let id = 0
  const pending = new Map()
  ws.onmessage = (e) => {
    const msg = JSON.parse(String(e.data))
    if (msg.id && pending.has(msg.id)) { const { resolve, reject } = pending.get(msg.id); pending.delete(msg.id); msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result) }
  }
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const msgId = ++id
    pending.set(msgId, { resolve, reject })
    ws.send(JSON.stringify({ id: msgId, method, params, ...(sessionId ? { sessionId } : {}) }))
  })
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId)
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
    return r.result.value
  }
  // Wait for Chrome to exit before removing its profile (it writes on shutdown), and never let
  // cleanup fail a run: a leftover temp folder is harmless.
  const close = async () => {
    try { ws.close() } catch { /* already closed */ }
    const exited = new Promise((resolve) => { child.once('exit', resolve); setTimeout(resolve, 3_000) })
    child.kill()
    await exited
    try { rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }) } catch { /* harmless */ }
  }
  return { evaluate, close }
}

/** Runs in the page: imports the design from a data: URL and draws it on a card. */
const PAGE_DRAW = String.raw`async ({ source, board, w, h, config, data, rows }) => {
  const mod = await import('data:text/javascript;base64,' + btoa(unescape(encodeURIComponent(source))))
  const design = mod.default
  const resolve = (spec) => {
    const v = spec && typeof spec === 'object' ? spec.default : spec
    return typeof v === 'string' && v.startsWith('@') ? (board[v.slice(1)] ?? '#888888') : (v ?? '#888888')
  }
  const tokens = Object.fromEntries(Object.entries(design.meta.tokens ?? {}).map(([k, spec]) => [k, resolve(spec)]))
  const dpr = 2, pad = 16
  const canvas = document.createElement('canvas')
  canvas.width = (w + pad * 2) * dpr; canvas.height = (h + pad * 2) * dpr
  const g = canvas.getContext('2d')
  g.scale(dpr, dpr)
  g.fillStyle = board.bg; g.fillRect(0, 0, w + pad * 2, h + pad * 2)
  g.fillStyle = board.surface; g.fillRect(pad / 2, pad / 2, w + pad, h + pad)
  g.translate(pad, pad)
  design.draw(g, { tokens, config, data, alerts: Array.isArray(data) ? data : [], rows, box: { w, h, t: 1 },
    now: Date.UTC(2026, 7, 3, 12, 0, 0), state: {}, motion: 'reduced', stale: false, age_ms: null }, 0)
  return canvas.toDataURL('image/png').split(',')[1]
}`

/**
 * @param {string} bin Chrome executable
 * @param {{ name: string, source: string, w: number, h: number, config: object, data: unknown, rows: unknown }[]} jobs
 * @param {object} board the pack's palette
 * @returns {Promise<{ name: string, png?: Buffer, error?: string }[]>}
 */
export async function renderPreviews(bin, jobs, board) {
  const browser = await openBrowser(bin)
  try {
    const out = []
    for (const job of jobs) {
      try {
        const b64 = await browser.evaluate(`(${PAGE_DRAW})(${JSON.stringify({ ...job, board })})`)
        out.push({ name: job.name, png: Buffer.from(b64, 'base64') })
      } catch (e) {
        out.push({ name: job.name, error: e instanceof Error ? e.message : String(e) })
      }
    }
    return out
  } finally {
    await browser.close()
  }
}
