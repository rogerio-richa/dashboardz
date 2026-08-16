#!/usr/bin/env node
/**
 * Fill a hub with plausible live data, so a board can actually be looked at.
 *
 * The problem this exists for: judging whether a theme
 * looks good on a board of empty boxes is impossible, and a hub with three stale feeds and one
 * screen covering four of the nine widgets cannot show you a regression either. Rendering defects
 * such as clipped tiles, elliptical gauges, dropped labels, and raw chart-axis floats need real
 * values in real widgets to be visible; fixtures that plot only whole numbers cannot expose them.
 *
 * It drives the REAL ingestion path: an admin session to set things up, then a sender token
 * pushing to `POST /api/feeds/:id` exactly as any other sender would. No fixtures, no fake mode,
 * no writing to the database behind the hub's back — if this script can fill a board, so can a
 * user's script, and anything it cannot do is a real gap in the API.
 *
 * Everything is idempotent and keyed BY NAME: run it as often as you like. It creates what is
 * missing and leaves everything else alone — in particular it never edits a screen that already
 * exists, because that is where your layout work lives.
 *
 *   node hub/scripts/demo-data.mjs                 # set up, then push every 5s until interrupted
 *   node hub/scripts/demo-data.mjs --once          # set up and push a single round
 *   node hub/scripts/demo-data.mjs --setup         # set up only, push nothing
 *   node hub/scripts/demo-data.mjs --loop 30       # a slower cadence
 *   node hub/scripts/demo-data.mjs --sound         # let demo alerts ring (see --no-alerts)
 *   node hub/scripts/demo-data.mjs --no-alerts     # feeds only, raise nothing
 *   node hub/scripts/demo-data.mjs --reset-screen  # DISCARD the demo screen and rebuild it
 *
 * HUB_URL (default http://127.0.0.1:8484) and ADMIN_PASSWORD come from the environment, falling
 * back to the repo-root .env the hub itself is configured from.
 *
 * Supersedes .scratch/push-mac-metrics.sh, which hardcoded two feed ids and read a token from a
 * /tmp file that no longer exists.
 */
import { deflateSync } from 'node:zlib'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..', '..')
// `data/` is gitignored, and this file holds a live sender token — it must never be committable.
const CACHE = join(HERE, '..', 'data', 'demo-data.json')

// ── configuration ────────────────────────────────────────────────────────────────────────────

/** The hub's own .env, so this script is configured from the same place the hub is. */
function dotenv() {
  try {
    const out = {}
    for (const line of readFileSync(join(REPO, '.env'), 'utf8').split('\n')) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line)
      if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
    }
    return out
  } catch { return {} }
}

const env = dotenv()
const HUB = (process.env.HUB_URL ?? env.HUB_URL ?? 'http://127.0.0.1:8484').replace(/\/$/, '')
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? env.ADMIN_PASSWORD

const argv = process.argv.slice(2)
const has = (flag) => argv.includes(flag)
const numAfter = (flag, fallback) => {
  const i = argv.indexOf(flag)
  const n = i >= 0 ? Number(argv[i + 1]) : NaN
  return Number.isFinite(n) && n > 0 ? n : fallback
}
const OPTS = {
  setupOnly: has('--setup'),
  once: has('--once'),
  everyS: numAfter('--loop', 5),
  sound: has('--sound'),
  alerts: !has('--no-alerts'),
  criticals: !has('--no-critical'),
  resetScreen: has('--reset-screen'),
}

const log = (...args) => console.log(...args)
const die = (msg) => { console.error(`\n${msg}\n`); process.exit(1) }

// ── HTTP ─────────────────────────────────────────────────────────────────────────────────────

let cookie = ''

async function call(path, { method = 'GET', body, token, raw, contentType } = {}) {
  const headers = {}
  if (cookie && !token) headers.cookie = cookie
  if (token) headers.authorization = `Bearer ${token}`
  if (body !== undefined) headers['content-type'] = contentType ?? 'application/json'
  const res = await fetch(`${HUB}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
  })
  const setCookie = res.headers.get('set-cookie')
  if (setCookie) cookie = setCookie.split(';')[0]
  if (res.status === 204) return null
  const text = await res.text()
  let parsed = null
  try { parsed = text ? JSON.parse(text) : null } catch { /* not JSON; `text` is the message */ }
  if (!res.ok) {
    const detail = parsed?.error ?? parsed?.message ?? text.slice(0, 200)
    throw new Error(`${method} ${path} -> ${res.status} ${detail}`)
  }
  return parsed
}

// ── a PNG, without a dependency ──────────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()

const crc32 = (buf) => {
  let c = 0xffffffff
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

const chunk = (type, data) => {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

/**
 * A truecolour PNG with a diagonal split, so a glance tells you the image widget is showing THIS
 * push and not a cached earlier one — a solid colour cannot. Real bytes on purpose: the image path
 * is sniffed, size-checked and revision-bumped by the hub, and a fake would exercise none of it.
 */
function png(width, height, rgbA, rgbB) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // colour type: truecolour
  const raw = Buffer.alloc(height * (1 + width * 3))
  let p = 0
  for (let y = 0; y < height; y++) {
    raw[p++] = 0 // filter: none
    for (let x = 0; x < width; x++) {
      const c = x / width + y / height > 1 ? rgbB : rgbA
      raw[p++] = c[0]; raw[p++] = c[1]; raw[p++] = c[2]
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// ── what gets created ────────────────────────────────────────────────────────────────────────

const FEEDS = [
  { name: 'demo-system', mode: 'value', stale_after_s: 60 },
  { name: 'demo-history', mode: 'stream', cap: 60 },
  { name: 'demo-fleet', mode: 'value', stale_after_s: 60 },
  { name: 'demo-image', mode: 'image' },
]

const SENDER_NAME = 'demo-data'
const SCREEN_NAME = 'Kitchen Sink'
const FORECAST_SCREEN_NAME = 'Forecast Demo'
const NEWS_SCREEN_NAME = 'News Demo'
const FORECAST_CONTRACT = 'dashboardz.weather.daily-forecast/v1'
const NEWS_CONTRACT = 'dashboardz.news.items/v1'

/**
 * The demo uses the real built-in provider seam. It does not push a hand-shaped value feed and
 * call that "weather": the draft test fetches Open-Meteo, validates the semantic contract, and
 * promotion creates the same reusable source/output a person creates through the editor.
 */
export const FORECAST_DEMO_SETUP = Object.freeze({
  provider_id: 'dashboardz.open-meteo',
  name: 'Demo weather - Sao Paulo',
  config: Object.freeze({ city: 'Sao Paulo', lat: -23.55, lon: -46.63, units: 'metric' }),
  secrets: Object.freeze({}),
})

const cell = (x, y, w, h, widget, config) => ({ rect: { x, y, w, h }, widget, config })

export const forecastDemoScreen = (feedId) => ({ cells: [
  cell(0, 0, 1, 1, 'weather_forecast', {
    feed: feedId,
    days: 7,
    show_humidity: true,
    show_precipitation: true,
    show_wind: true,
    // Open-Meteo does not provide pollen. Leaving the requested knob on demonstrates the widget's
    // honest optional-data behavior: the row disappears instead of becoming zero or fake copy.
    show_pollen: true,
    scale: 1,
    design: 'forecast',
  }),
] })

/** A public RSS URL is safe fixture data: it carries no account, credential or private feed key. */
export const NEWS_DEMO_SETUP = Object.freeze({
  provider_id: 'dashboardz.rss',
  name: 'Demo news - BBC World',
  config: Object.freeze({ max_items: 20 }),
  secrets: Object.freeze({ url: 'https://feeds.bbci.co.uk/news/world/rss.xml' }),
})

export const newsDemoScreen = (feedId) => ({ cells: [
  cell(0, 0, 1, 1, 'news_list', {
    feed: feedId,
    items: 5,
    show_summary: true,
    show_source: true,
    show_time: true,
    scale: 1,
    design: 'list',
  }),
] })

/**
 * Every widget type at once, which is the surface a theme actually has to survive.
 *
 * Widths are fractions of the BOARD, and the board is not the viewport: on a Galaxy A05 in
 * landscape the window is 853 CSS px wide but `#grid` measures 821, because the page carries 16px
 * of padding a side. Designing against 853 put stream_list and alert_feed at 162px — over their
 * 160px minimum on paper, under it on the panel — and the board said so in as many words, in two
 * cells that rendered "stream_list needs 160x110" instead of content. So every width below is
 * checked against 821, with the resulting pixels in the comment:
 *
 *   row 1   clock 148   gauge 123   gauge 123   chart 213   image 98    text 115
 *   row 2   value 115   gauge 131   table 197   stream 189  alert 189
 *
 * against WIDGET_MIN_PX of clock 120, gauge 120, chart 160, image 60, text_block 80,
 * value_tile 100, table 180, stream_list 160, alert_feed 160. Rows are h=0.5, which is 132px on
 * the probe board and 176 on a real A05 — clear of the tallest minimum (110) either way.
 *
 * Each row sums to exactly 1.000. The hub rejects overlaps and sub-0.05 rects outright.
 */
const kitchenSink = (feedIds) => ({ cells: [
  // row 1
  cell(0, 0, 0.18, 0.5, 'clock', {}),
  cell(0.18, 0, 0.15, 0.5, 'gauge', {
    feed: feedIds['demo-system'], path: 'cpu.load', min: 0, max: 100, design: 'ring',
    label: 'cpu', unit: '%', decimals: 0, thresholds: { warn: 60, crit: 85 },
  }),
  cell(0.33, 0, 0.15, 0.5, 'gauge', {
    feed: feedIds['demo-system'], path: 'mem.used_pct', min: 0, max: 100, design: 'ring',
    label: 'memory', unit: '%', decimals: 0, thresholds: { warn: 70, crit: 90 },
  }),
  cell(0.48, 0, 0.26, 0.5, 'chart', {
    style: 'line',
    series: [
      // `icon` is required by the admin schema even though chartConfig defaults it — the editor
      // always assigns one, so a series without it is a caller that skipped the editor.
      { feed: feedIds['demo-history'], y_path: 'cpu', label: 'cpu', icon: 'circle' },
      { feed: feedIds['demo-history'], y_path: 'mem', label: 'mem', icon: 'square' },
    ],
  }),
  cell(0.74, 0, 0.12, 0.5, 'image', { feed: feedIds['demo-image'], fit: 'cover' }),
  cell(0.86, 0, 0.14, 0.5, 'text_block', { text: 'demo board', align: 'center' }),
  // row 2
  cell(0, 0.5, 0.14, 0.5, 'value_tile', {
    feed: feedIds['demo-system'], path: 'temp_c', label: 'cpu temp', unit: '\u00b0C', decimals: 1,
  }),
  cell(0.14, 0.5, 0.16, 0.5, 'gauge', {
    feed: feedIds['demo-system'], path: 'disk.free_gb', min: 0, max: 500, design: 'bar',
    label: 'disk free', unit: 'GB', decimals: 0,
  }),
  cell(0.30, 0.5, 0.24, 0.5, 'table', {
    feed: feedIds['demo-fleet'], path: 'servers', headers: true, overflow: { counter: true },
    columns: [
      { header: 'host', path: 'host', align: 'left' },
      { header: 'cpu', path: 'cpu', align: 'right' },
      { header: 'state', path: 'status', align: 'right' },
    ],
  }),
  cell(0.54, 0.5, 0.23, 0.5, 'stream_list', {
    feed: feedIds['demo-history'], title_path: 'label', body_path: 'detail',
  }),
  cell(0.77, 0.5, 0.23, 0.5, 'alert_feed', {
    min_severity: 'info', clamp: { title_lines: 1, body_lines: 2 }, overflow: { counter: true },
  }),
] })

// ── setup ────────────────────────────────────────────────────────────────────────────────────

async function ensureFeeds() {
  const existing = await call('/admin/api/feeds')
  const byName = new Map(existing.map((f) => [f.name, f]))
  const ids = {}
  for (const want of FEEDS) {
    const found = byName.get(want.name)
    if (found) {
      if (found.mode !== want.mode) {
        // mode is immutable, so a name collision with the wrong mode is unrecoverable here.
        die(`feed "${want.name}" already exists with mode "${found.mode}", expected "${want.mode}".\n` +
            `Rename or delete it in the admin, then run this again.`)
      }
      ids[want.name] = found.id
      continue
    }
    const created = await call('/admin/api/feeds', { method: 'POST', body: want })
    ids[want.name] = created.id
    log(`  + feed ${want.name} (${want.mode})`)
  }
  return ids
}

/**
 * One sender, reused across runs. Its token is shown exactly once at creation, so it is cached —
 * and the cache is validated against the hub, because a database that was reset out from under us
 * leaves a cached token that authenticates nothing and fails later, at push time, as a 401 that
 * looks like a bug in the push path.
 */
async function ensureSender() {
  let cached = null
  try { cached = JSON.parse(readFileSync(CACHE, 'utf8')) } catch { /* first run, or unreadable */ }

  const senders = await call('/admin/api/senders')
  if (cached?.token && senders.some((s) => s.id === cached.sender_id)) return cached.token

  if (senders.some((s) => s.name === SENDER_NAME)) {
    die(`A sender named "${SENDER_NAME}" exists but its token is not cached at\n  ${CACHE}\n` +
        `A sender token is shown only at creation and cannot be recovered. Delete that sender in\n` +
        `the admin and run this again to mint a fresh one.`)
  }

  const created = await call('/admin/api/senders', { method: 'POST', body: { name: SENDER_NAME } })
  mkdirSync(dirname(CACHE), { recursive: true })
  writeFileSync(CACHE, JSON.stringify({ sender_id: created.sender.id, token: created.token }, null, 2))
  log(`  + sender ${SENDER_NAME}, token cached in ${CACHE}`)
  return created.token
}

async function ensureForecastSource() {
  const sources = await call('/admin/api/sources')
  const found = sources.find((source) => source.name === FORECAST_DEMO_SETUP.name)
  if (found) {
    if (found.provider?.id !== FORECAST_DEMO_SETUP.provider_id) {
      die(`connection "${FORECAST_DEMO_SETUP.name}" exists with provider "${found.provider?.id}", ` +
          `expected "${FORECAST_DEMO_SETUP.provider_id}".`)
    }
    const output = found.outputs?.find((candidate) => candidate.contract_id === FORECAST_CONTRACT)
    if (!output?.feed_id) die(`connection "${FORECAST_DEMO_SETUP.name}" has no daily forecast output.`)
    return output.feed_id
  }

  const draft = await call('/admin/api/source-drafts', { method: 'POST', body: FORECAST_DEMO_SETUP })
  const promoted = await call(`/admin/api/source-drafts/${draft.id}/promote`, { method: 'POST' })
  const output = promoted.outputs?.find((candidate) => candidate.contract_id === FORECAST_CONTRACT)
  if (!output?.feed_id) die('Open-Meteo demo connection produced no daily forecast output.')
  log(`  + connection ${FORECAST_DEMO_SETUP.name} (Open-Meteo)`)
  return output.feed_id
}

async function ensureNewsSource() {
  const sources = await call('/admin/api/sources')
  const found = sources.find((source) => source.name === NEWS_DEMO_SETUP.name)
  if (found) {
    if (found.provider?.id !== NEWS_DEMO_SETUP.provider_id) {
      die(`connection "${NEWS_DEMO_SETUP.name}" exists with provider "${found.provider?.id}", ` +
          `expected "${NEWS_DEMO_SETUP.provider_id}".`)
    }
    const output = found.outputs?.find((candidate) => candidate.contract_id === NEWS_CONTRACT)
    if (!output?.feed_id) die(`connection "${NEWS_DEMO_SETUP.name}" has no news items output.`)
    return output.feed_id
  }

  const draft = await call('/admin/api/source-drafts', { method: 'POST', body: NEWS_DEMO_SETUP })
  const promoted = await call(`/admin/api/source-drafts/${draft.id}/promote`, { method: 'POST' })
  const output = promoted.outputs?.find((candidate) => candidate.contract_id === NEWS_CONTRACT)
  if (!output?.feed_id) die('RSS demo connection produced no news items output.')
  log(`  + connection ${NEWS_DEMO_SETUP.name} (RSS)`)
  return output.feed_id
}

/**
 * Never edits a screen that already exists — that is where layout work lives, and a script that
 * silently rewrote it would be the same class of bug as the lost update v14 fixed. `--reset-screen`
 * is the explicit way to take the newer layout: it DELETES and recreates, so anything you changed
 * on the demo board goes with it. Deleting also unassigns any device, which the hub audits.
 */
async function ensureScreen(feedIds) {
  const screens = await call('/admin/api/screens')
  const found = screens.find((s) => s.name === SCREEN_NAME)
  if (found && OPTS.resetScreen) {
    await call(`/admin/api/screens/${found.id}`, { method: 'DELETE' })
    log(`  - screen "${SCREEN_NAME}" deleted (--reset-screen)`)
  } else if (found) {
    return found
  }
  const created = await call('/admin/api/screens', {
    method: 'POST',
    body: { name: SCREEN_NAME, orientation: 'landscape', grid: kitchenSink(feedIds) },
  })
  log(`  + screen "${SCREEN_NAME}" with all ${created.grid.cells.length} widget types`)
  return created
}

async function ensureForecastScreen(feedId) {
  const screens = await call('/admin/api/screens')
  const found = screens.find((screen) => screen.name === FORECAST_SCREEN_NAME)
  if (found && OPTS.resetScreen) {
    await call(`/admin/api/screens/${found.id}`, { method: 'DELETE' })
    log(`  - screen "${FORECAST_SCREEN_NAME}" deleted (--reset-screen)`)
  } else if (found) {
    return found
  }
  const created = await call('/admin/api/screens', {
    method: 'POST',
    body: { name: FORECAST_SCREEN_NAME, orientation: 'landscape', grid: forecastDemoScreen(feedId) },
  })
  log(`  + screen "${FORECAST_SCREEN_NAME}" with live seven-day weather`)
  return created
}

async function ensureNewsScreen(feedId) {
  const screens = await call('/admin/api/screens')
  const found = screens.find((screen) => screen.name === NEWS_SCREEN_NAME)
  if (found && OPTS.resetScreen) {
    await call(`/admin/api/screens/${found.id}`, { method: 'DELETE' })
    log(`  - screen "${NEWS_SCREEN_NAME}" deleted (--reset-screen)`)
  } else if (found) {
    return found
  }
  const created = await call('/admin/api/screens', {
    method: 'POST',
    body: { name: NEWS_SCREEN_NAME, orientation: 'portrait', grid: newsDemoScreen(feedId) },
  })
  log(`  + screen "${NEWS_SCREEN_NAME}" with live RSS headlines`)
  return created
}

// ── the data ─────────────────────────────────────────────────────────────────────────────────

/**
 * A slow sine per metric, plus noise, phase-shifted so the two gauges do not move in lockstep.
 * Amplitude is chosen to cross both the warn and the critical threshold on every cycle: a demo
 * that never goes red exercises neither the severity colours nor the takeover.
 */
const wave = (tick, period, low, high, phase = 0) => {
  const mid = (low + high) / 2
  const amp = (high - low) / 2
  return mid + Math.sin((tick / period) * 2 * Math.PI + phase) * amp + (Math.random() - 0.5) * 2
}

const HOSTS = ['web-01', 'web-02', 'db-01', 'cache-01', 'edge-01', 'worker-01', 'worker-02']
const JOBS = ['nightly backup', 'index rebuild', 'image resize', 'log rollup', 'cache warm', 'sync users']

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))

async function pushRound(tick, feedIds, token, deviceIds) {
  const cpu = clamp(wave(tick, 14, 20, 95), 0, 100)
  const mem = clamp(wave(tick, 23, 35, 96, 1.1), 0, 100)

  await call(`/api/feeds/${feedIds['demo-system']}`, {
    method: 'POST', token,
    body: {
      cpu: { load: round(cpu, 1) },
      mem: { used_pct: round(mem, 1) },
      disk: { free_gb: round(clamp(wave(tick, 51, 40, 420, 2.2), 0, 500), 0) },
      temp_c: round(38 + cpu * 0.28, 1),
    },
  })

  await call(`/api/feeds/${feedIds['demo-history']}`, {
    method: 'POST', token,
    body: {
      cpu: round(cpu, 1),
      mem: round(mem, 1),
      label: `${JOBS[tick % JOBS.length]} #${1200 + tick}`,
      detail: `finished in ${round(0.6 + Math.random() * 4, 1)}s`,
    },
  })

  await call(`/api/feeds/${feedIds['demo-fleet']}`, {
    method: 'POST', token,
    body: {
      servers: HOSTS.map((host, i) => {
        const load = clamp(wave(tick + i * 3, 17, 8, 97, i), 0, 100)
        return {
          host,
          cpu: round(load, 0),
          mem: round(clamp(wave(tick + i * 5, 29, 20, 90, i * 0.7), 0, 100), 0),
          status: load > 85 ? 'crit' : load > 65 ? 'warn' : 'ok',
        }
      }),
    },
  })

  // Hue rotates with the tick, so a stale image is obvious rather than merely possible.
  const hue = (tick * 37) % 360
  await call(`/api/feeds/${feedIds['demo-image']}`, {
    method: 'POST', token, raw: true, contentType: 'image/png',
    body: png(240, 160, hsvToRgb(hue, 0.55, 0.85), hsvToRgb((hue + 40) % 360, 0.65, 0.45)),
  })

  if (OPTS.alerts) await maybeAlert(tick, token, deviceIds)
}

/**
 * An occasional warn and a rare critical, so the alert feed has something in it and the critical
 * takeover path is exercised on a real board rather than only in tests.
 *
 * Targeted at the devices showing the DEMO SCREEN, and nothing else. A demo that pages every panel
 * in the building because it wanted to fill one alert widget is a bad neighbour — and with no
 * device assigned to the Kitchen Sink, it raises nothing at all, which is the right default for a
 * script somebody runs against a live hub to see what a theme looks like.
 *
 * Silent and short-lived on top of that: critical is the one thing allowed to be louder
 * than the phone was asked to be, so `--sound` has to be asked for. `ttl_s` means a run tidies up
 * after itself instead of leaving a wall of dead alerts behind.
 */
async function maybeAlert(tick, token, deviceIds) {
  if (!deviceIds.length) return
  const critical = OPTS.criticals && tick > 0 && tick % 24 === 0
  const warn = !critical && tick > 0 && tick % 7 === 0
  if (!critical && !warn) return

  const body = critical
    ? { title: 'db-01 unreachable', body: 'no response for 90s from 192.168.15.31', severity: 'critical' }
    : { title: 'disk almost full', body: `/var at ${88 + (tick % 9)}% on web-02`, severity: 'warn' }

  await call('/api/notify', {
    method: 'POST', token,
    body: { ...body, devices: deviceIds, sound: OPTS.sound, ttl_s: critical ? 90 : 240 },
  })
  log(`  ! ${body.severity}: ${body.title}`)
}

const round = (v, d) => Number(v.toFixed(d))

function hsvToRgb(h, s, v) {
  const c = v * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = v - c
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x]
    : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x]
  return [r + m, g + m, b + m].map((n) => Math.round(n * 255))
}

// ── main ─────────────────────────────────────────────────────────────────────────────────────

async function main() {
  if (!ADMIN_PASSWORD) {
    die('ADMIN_PASSWORD is not set, and no .env at the repo root supplies it.\n' +
        'Set it in the environment or in .env, the same place the hub reads it from.')
  }

  log(`hub ${HUB}`)
  try {
    await call('/admin/api/login', { method: 'POST', body: { password: ADMIN_PASSWORD } })
  } catch (err) {
    die(`Could not log in: ${err.message}\nIs the hub running, and is ADMIN_PASSWORD right?`)
  }

  log('setup (idempotent, by name)')
  const feedIds = await ensureFeeds()
  const token = await ensureSender()
  const screen = await ensureScreen(feedIds)
  const forecastFeedId = await ensureForecastSource()
  const forecastScreen = await ensureForecastScreen(forecastFeedId)
  const newsFeedId = await ensureNewsSource()
  const newsScreen = await ensureNewsScreen(newsFeedId)

  const devices = await call('/admin/api/devices')
  const assigned = devices.filter((d) => d.screen_id === screen.id)
  const forecastAssigned = devices.filter((d) => d.screen_id === forecastScreen.id)
  const newsAssigned = devices.filter((d) => d.screen_id === newsScreen.id)
  log(`  = screen "${SCREEN_NAME}" is ${screen.id}, assigned to ${assigned.length} device(s)`)
  if (!assigned.length) {
    log(`    (assign a device to it in the admin to see this on a panel)`)
  }
  log(`  = screen "${FORECAST_SCREEN_NAME}" is ${forecastScreen.id}, assigned to ${forecastAssigned.length} device(s)`)
  if (!forecastAssigned.length) {
    log(`    (assign a device to it in the admin to see the live forecast)`)
  }
  log(`  = screen "${NEWS_SCREEN_NAME}" is ${newsScreen.id}, assigned to ${newsAssigned.length} device(s)`)
  if (!newsAssigned.length) {
    log(`    (assign a device to it in the admin to see live headlines)`)
  }

  if (OPTS.setupOnly) { log('\nsetup only; pushed nothing'); return }

  // Explicitly named, and named narrowly: only the devices actually showing the demo screen. The
  // sender's own defaults are not consulted, so a demo alert can never reach a panel that has
  // nothing to do with this.
  const deviceIds = assigned.map((d) => d.id)
  if (OPTS.alerts && !deviceIds.length) log('    (no device assigned, so no demo alerts will be raised)')

  let tick = 0
  const round1 = async () => {
    await pushRound(tick, feedIds, token, deviceIds)
    log(`  push #${tick + 1}`)
    tick++
  }

  await round1()
  if (OPTS.once) { log('\none round pushed'); return }

  log(`\npushing every ${OPTS.everyS}s — ctrl-c to stop`)
  for (;;) {
    await new Promise((r) => setTimeout(r, OPTS.everyS * 1000))
    try {
      await round1()
    } catch (err) {
      // A hub restart mid-loop must not end the run: the next tick reconnects. Anything that is
      // still broken will simply say so again.
      console.error(`  push failed: ${err.message}`)
    }
  }
}

// Importing the pure fixture builders in tests must not log in, fetch, or terminate the process.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => die(err.stack ?? String(err)))
}
