import { spawn, type ChildProcess } from 'node:child_process'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { extname, join, normalize } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import WebSocket from 'ws'

/**
 * A real layout engine for tests (fit model).
 *
 * jsdom cannot do this: it has no layout, so clientHeight/offsetHeight/scrollWidth all report 0 and
 * every overflow assertion passes vacuously. The whole class of bug this guards against — a tile
 * clipped, a ring drawn as an ellipse, a label silently dropped — is invisible without real
 * measurement.
 *
 * Chrome over CDP rather than Playwright/puppeteer: `ws` is already a dependency and a browser is
 * already installed, so this adds a file instead of 150MB and a download step to CI. The trade is
 * that it needs A Chrome on PATH — `hasBrowser()` lets a suite skip cleanly where there is none,
 * because a guard that fails on someone's laptop for want of a browser gets deleted.
 */

const CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean) as string[]

export function browserPath(): string | null {
  return CANDIDATES.find((p) => existsSync(p)) ?? null
}
export const hasBrowser = () => browserPath() !== null

const MIME: Record<string, string> = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.png': 'image/png',
}

/**
 * Serves the device renderer exactly as the hub does, so the page under test is the real one.
 *
 * `routes` is for the handful of API endpoints the PAGE itself calls — today only
 * `/api/feeds/:id/image`, which the image widget's real wiring fetches with a Bearer header. They
 * are matched on pathname before the file lookup and are given the raw request, so a test can
 * assert what the page sent (the auth header) as well as answer it. Everything else stays a bare
 * static file server: this harness is not a hub, and a route added here should be one the page
 * cannot be exercised without.
 */
export function serveStatic(
  root: string,
  routes: Record<string, (req: IncomingMessage, res: ServerResponse) => void> = {},
): Promise<{ url: string; close: () => void; server: Server }> {
  const server = createServer((req, res) => {
    // normalize + prefix check: a test harness is still a server, and `..` must not escape root.
    const rel = normalize(decodeURIComponent((req.url ?? '/').split('?')[0]))
    const route = routes[rel]
    if (route) { route(req, res); return }
    let file = join(root, rel)
    if (!file.startsWith(root)) { res.writeHead(403).end(); return }
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html')
    if (!existsSync(file)) { res.writeHead(404).end(); return }
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' })
    res.end(readFileSync(file))
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port
      resolve({ url: `http://127.0.0.1:${port}`, close: () => server.close(), server })
    })
  })
}

export interface Page {
  /** Evaluate in the page and return the JSON-serialisable result. */
  evaluate: <T>(expression: string) => Promise<T>
  close: () => Promise<void>
}

/**
 * Headless Chrome at a fixed viewport, with one page open at `url`.
 *
 * `--window-size` rather than CDP's device metrics override: the fit model reads `100vh` and
 * `clientHeight`, which follow the real window, and an emulated metric would test a viewport the
 * CSS never sees.
 */
export async function openPage(
  url: string,
  width: number,
  height: number,
  /**
   * Runs BEFORE any page script, on every document. This is the only way to install
   * `__dashboardzHost`: device.js reads it at module scope to decide whether it owns a socket, so
   * setting it after load is too late and the page would try to dial out.
   */
  initScript?: string,
): Promise<Page> {
  const bin = browserPath()
  if (!bin) throw new Error('no browser')
  const profile = mkdtempSync(join(tmpdir(), 'dbz-chrome-'))
  const child: ChildProcess = spawn(bin, [
    '--headless=new',
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    `--window-size=${width},${height}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu',
    '--hide-scrollbars', '--force-device-scale-factor=1',
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] })

  // Chrome prints the DevTools endpoint to stderr once it is listening. Waiting for that line is
  // the only reliable readiness signal — polling a guessed port races startup.
  const wsUrl = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('browser did not start')), 20_000)
    let buf = ''
    child.stderr?.on('data', (d) => {
      buf += d.toString()
      const m = buf.match(/ws:\/\/[^\s]+/)
      if (m) { clearTimeout(timer); resolve(m[0]) }
    })
    child.on('exit', () => { clearTimeout(timer); reject(new Error('browser exited')) })
  })

  const browserWs = new WebSocket(wsUrl)
  await new Promise((r, j) => { browserWs.once('open', r); browserWs.once('error', j) })

  let id = 0
  const pending = new Map<number, (v: unknown) => void>()
  const send = (method: string, params: object = {}, sessionId?: string) =>
    new Promise<any>((resolve) => {
      const msgId = ++id
      pending.set(msgId, resolve)
      browserWs.send(JSON.stringify({ id: msgId, method, params, sessionId }))
    })
  browserWs.on('message', (d) => {
    const m = JSON.parse(d.toString())
    if (m.id && pending.has(m.id)) { pending.get(m.id)!(m); pending.delete(m.id) }
  })

  // Attach to the page target rather than the browser target, so evaluations run in the page.
  const { result: targets } = await send('Target.getTargets')
  const page = targets.targetInfos.find((t: { type: string }) => t.type === 'page')
  const { result: attached } = await send('Target.attachToTarget', { targetId: page.targetId, flatten: true })
  const sessionId = attached.sessionId
  await send('Runtime.enable', {}, sessionId)
  await send('Page.enable', {}, sessionId)
  if (initScript) await send('Page.addScriptToEvaluateOnNewDocument', { source: initScript }, sessionId)

  // Navigate only now: started at about:blank so the init script is installed first.
  await send('Page.navigate', { url }, sessionId)
  await new Promise<void>((resolve) => {
    const onMsg = (d: unknown) => {
      const m = JSON.parse(String(d))
      if (m.method === 'Page.loadEventFired') { browserWs.off('message', onMsg as never); resolve() }
    }
    browserWs.on('message', onMsg as never)
  })

  const evaluate = async <T>(expression: string): Promise<T> => {
    const res = await send('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true,
    }, sessionId)
    const r = res.result
    if (r?.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description ?? ''))
    return r?.result?.value as T
  }

  return {
    evaluate,
    close: async () => {
      browserWs.close()
      child.kill()
      try { rmSync(profile, { recursive: true, force: true }) } catch { /* best effort */ }
    },
  }
}
