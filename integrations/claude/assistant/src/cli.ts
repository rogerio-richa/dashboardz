#!/usr/bin/env node
import { realpathSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { loadConfig } from './config.js'
import { runDaemon } from './daemon.js'
import { askWithEscalation } from './escalate.js'
import { Hub } from './hub.js'
import { loadRuntime } from './runtime.js'
import { runSession } from './session.js'
import { ReminderStore } from './store.js'

export const DAY_NAMES: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 }
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/

export interface ParsedReminder {
  title: string; at: string; days?: number[]; devices?: string[]
  snoozeMin: number; escalateAfterMin?: number
}

function takeFlags(argv: string[]): { positionals: string[]; flags: Map<string, string[]> } {
  const positionals: string[] = []
  const flags = new Map<string, string[]>()
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a.startsWith('--')) {
      const key = a.slice(2)
      const val = argv[++i]
      if (val === undefined) throw new Error(`--${key} needs a value`)
      flags.set(key, [...(flags.get(key) ?? []), val])
    } else positionals.push(a)
  }
  return { positionals, flags }
}
const one = (flags: Map<string, string[]>, k: string) => flags.get(k)?.at(-1)

function num(flags: Map<string, string[]>, key: string): number | undefined {
  const raw = one(flags, key)
  if (raw === undefined) return undefined
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) throw new Error(`--${key} must be a positive number, got: ${raw}`)
  return n
}

export function parseReminderArgs(argv: string[]): ParsedReminder {
  const { positionals, flags } = takeFlags(argv)
  const title = positionals[0]
  const at = one(flags, 'at')
  if (!title || !at || !(HHMM.test(at) || !Number.isNaN(new Date(at).getTime())))
    throw new Error('usage: remind add <title> --at HH:MM|ISO [--days mon,wed] [--device dev_x] [--snooze 10] [--escalate 15]')
  const days = one(flags, 'days')?.split(',').map((d) => {
    const n = DAY_NAMES[d.trim().toLowerCase()]
    if (n === undefined) throw new Error(`unknown day: ${d}`)
    return n
  })
  const escalate = num(flags, 'escalate')
  return {
    title, at,
    ...(days ? { days } : {}),
    ...(flags.has('device') ? { devices: flags.get('device') } : {}),
    snoozeMin: num(flags, 'snooze') ?? 10,
    ...(escalate !== undefined ? { escalateAfterMin: escalate } : {}),
  }
}

export function parseAskArgs(argv: string[]) {
  const { positionals, flags } = takeFlags(argv)
  const title = positionals[0]
  const raw = flags.get('option') ?? []
  if (!title || raw.length === 0) throw new Error('usage: ask <title> --option id=Label [--option ...] [--body t] [--ttl 3600] [--escalate 10] [--device dev_x]')
  if (raw.length > 4) throw new Error('at most 4 options')
  const options = raw.map((o) => {
    const eq = o.indexOf('=')
    if (eq < 1) throw new Error(`bad --option ${o}; want id=Label`)
    return { id: o.slice(0, eq), label: o.slice(eq + 1) }
  })
  const escalate = num(flags, 'escalate')
  return {
    title, options,
    ...(one(flags, 'body') ? { body: one(flags, 'body') } : {}),
    ttlS: num(flags, 'ttl') ?? 3600,
    ...(escalate !== undefined ? { escalateAfterMin: escalate } : {}),
    ...(flags.has('device') ? { devices: flags.get('device') } : {}),
  }
}

async function main(): Promise<number> {
  const [cmd, sub, ...rest] = process.argv.slice(2)
  const cfg = loadConfig()
  const store = new ReminderStore(join(cfg.dataDir, 'reminders.json'))
  const hub = new Hub(cfg.hubUrl, cfg.senderToken)

  if (cmd === 'remind' && sub === 'add') {
    const p = parseReminderArgs(rest)
    const id = `r${Date.now().toString(36)}`
    store.add({ id, ...p })
    console.log(id)
    return 0
  }
  if (cmd === 'remind' && sub === 'list') {
    for (const r of store.list()) console.log(`${r.id}\t${r.at}\t${r.days?.join(',') ?? '*'}\t${r.done ? 'done' : ''}\t${r.title}`)
    return 0
  }
  if (cmd === 'remind' && sub === 'rm') {
    const id = rest[0]
    if (!id) { console.error('usage: remind rm <id>'); return 2 }
    return store.remove(id) ? 0 : 1
  }
  if (cmd === 'ask') {
    const a = parseAskArgs([sub!, ...rest].filter((x) => x !== undefined))
    const res = await askWithEscalation(hub, { ...a, devices: a.devices ?? (cfg.devices.length ? cfg.devices : undefined) })
    console.log(JSON.stringify(res))
    return res.state === 'answered' ? 0 : res.state === 'expired' ? 3 : 1
  }
  if (cmd === 'run') {
    const prompt = [sub, ...rest].filter(Boolean).join(' ')
    if (!prompt) throw new Error('usage: run <prompt>')
    console.log(await runSession(cfg, loadRuntime(cfg.dataDir), prompt))
    return 0
  }
  if (cmd === 'daemon') {
    await runDaemon(cfg, store, hub)
    return 0
  }
  console.error('usage: dbz-assistant <remind add|list|rm | ask | run | daemon> ...')
  return 2
}

// Only run when executed as a bin, not when imported by tests. Resolved via
// realpath so a symlinked bin (e.g. npm's node_modules/.bin shim) still matches.
const isMain = (() => {
  try {
    return process.argv[1] !== undefined && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
  } catch {
    return false
  }
})()
if (isMain) {
  main().then((code) => process.exit(code), (err) => { console.error(String(err?.message ?? err)); process.exit(1) })
}
