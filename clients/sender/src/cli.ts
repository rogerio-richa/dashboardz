#!/usr/bin/env node
import { realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { SenderClient, type NotifyOpts, type Severity } from './client.js'

const SEVERITIES: readonly Severity[] = ['info', 'warn', 'critical']

const HELP = `dbz-send — send one notification to a dashboardz hub through the relay

The message is sealed end-to-end to the hub with a key derived from the sender
token; the relay only ever sees ciphertext and routing metadata.

Usage:
  dbz-send --relay wss://relay.example/ws --hub hub_x --token dbz_s_... \\
           --title "Disk 97%" --severity warn [options]

Required:
  --relay URL        relay websocket URL
  --hub UID          target hub uid (hub_...)
  --token TOKEN      sender token (dbz_s_...) issued by that hub
  --title TEXT       alert title (hub cap: 200 chars)
  --severity LEVEL   info | warn | critical
                     --title/--severity are not required with --resolve
                     (below) — it needs --dedup-key instead.

Options:
  --body TEXT        alert body (hub cap: 1500 chars)
  --device ID        target device id, repeatable; defaults to the sender's
                     default devices, resolved hub-side
  --option ID=LABEL  answer option, repeatable up to 4; id [a-z0-9_-] max 32,
                     label max 24 chars
  --sound            ask the devices to play a sound
  --ttl SECONDS      auto-expire the alert after this many seconds
  --dedup-key KEY    coalesce with an open alert carrying the same key
  --wait SECONDS     after the ack, stay connected up to this long for the
                     human's answer (or the alert's timeout) and print it
  --help             show this text

Resolving instead of creating:
  dbz-send --resolve --dedup-key KEY \\
           --relay wss://relay.example/ws --hub hub_x --token dbz_s_...

  --resolve           retract this sender's own active alert for --dedup-key
                      instead of creating one. --title/--severity are not
                      needed; --dedup-key is required. --wait is invalid
                      with --resolve — there is no alert to wait an answer
                      on. Resolving a --dedup-key the hub isn't holding
                      active is not an error: it still exits 0.

Exit codes: 0 ok (acked; with --wait, an answer or alert-timeout arrived),
1 send failed, 2 bad usage, 3 --wait elapsed with no answer.

v0 limitation: pending request ids exist only in this process's memory. A
restarted dbz-send cannot claim an earlier request's answer, so for long waits
keep the process running. Answers are stored on the hub either way.

Data feed push:
  dbz-send data <feed-id> --relay URL --hub UID --token TOKEN --json '<payload>'

  --json JSON        the payload to push, any JSON value, sealed the same way
                     as a notify. Value feeds overwrite; stream feeds append.
  --help             show this text

  Image feeds cannot be pushed this way — sealed-JSON envelopes are the wrong
  vehicle for binary data; the hub rejects it with "image push not supported
  over relay". Push images over the LAN HTTP route instead.

  Exit codes: 0 ok (pushed), 1 send failed, 2 bad usage. 3 never applies —
  a data push takes no --wait, there is no human answer to wait for.
`

export interface Flags {
  relay?: string; hub?: string; token?: string
  title?: string; severity?: string; body?: string
  devices: string[]; options: { id: string; label: string }[]
  sound: boolean; ttl?: number; dedupKey?: string; wait?: number
  resolve: boolean
}

const fail = (msg: string): never => {
  process.stderr.write(`dbz-send: ${msg} (see --help)\n`)
  process.exit(2)
}

export function parseArgs(argv: string[]): Flags {
  const flags: Flags = { devices: [], options: [], sound: false, resolve: false }
  const next = (flag: string, i: number): string => {
    const v = argv[i + 1]
    if (v === undefined) fail(`${flag} needs a value`)
    return v as string
  }
  const int = (flag: string, v: string): number => {
    const n = Number(v)
    if (!Number.isInteger(n) || n < 1) fail(`${flag} must be a positive integer`)
    return n
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    switch (a) {
      case '--help': case '-h': process.stdout.write(HELP); process.exit(0); break
      case '--relay': flags.relay = next(a, i); i++; break
      case '--hub': flags.hub = next(a, i); i++; break
      case '--token': flags.token = next(a, i); i++; break
      case '--title': flags.title = next(a, i); i++; break
      case '--severity': flags.severity = next(a, i); i++; break
      case '--body': flags.body = next(a, i); i++; break
      case '--device': flags.devices.push(next(a, i)); i++; break
      case '--option': {
        const v = next(a, i); i++
        const eq = v.indexOf('=')
        if (eq < 1) fail(`--option must look like id=Label, got "${v}"`)
        flags.options.push({ id: v.slice(0, eq), label: v.slice(eq + 1) })
        break
      }
      case '--sound': flags.sound = true; break
      case '--ttl': flags.ttl = int(a, next(a, i)); i++; break
      case '--dedup-key': flags.dedupKey = next(a, i); i++; break
      case '--wait': flags.wait = int(a, next(a, i)); i++; break
      case '--resolve': flags.resolve = true; break
      default: fail(`unknown argument "${a}"`)
    }
  }
  return flags
}

interface DataFlags {
  feedId: string; relay: string; hub: string; token: string; payload: unknown
}

/** Parses `dbz-send data <feed-id> --relay URL --hub UID --token TOKEN --json '<payload>'`. */
function parseDataArgs(argv: string[]): DataFlags {
  if (argv[0] === '--help' || argv[0] === '-h') { process.stdout.write(HELP); process.exit(0) }
  const feedId = argv[0]
  if (!feedId || feedId.startsWith('-')) fail("a feed id is required — usage: dbz-send data <feed-id> --json '<payload>'")

  const flags: { relay?: string; hub?: string; token?: string; json?: string } = {}
  const next = (flag: string, i: number): string => {
    const v = argv[i + 1]
    if (v === undefined) fail(`${flag} needs a value`)
    return v as string
  }
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]
    switch (a) {
      case '--help': case '-h': process.stdout.write(HELP); process.exit(0); break
      case '--relay': flags.relay = next(a, i); i++; break
      case '--hub': flags.hub = next(a, i); i++; break
      case '--token': flags.token = next(a, i); i++; break
      case '--json': flags.json = next(a, i); i++; break
      default: fail(`unknown argument "${a}"`)
    }
  }
  for (const [flag, v] of [['--relay', flags.relay], ['--hub', flags.hub], ['--token', flags.token], ['--json', flags.json]] as const) {
    if (v === undefined) fail(`${flag} is required`)
  }
  let payload: unknown
  try {
    payload = JSON.parse(flags.json!)
  } catch {
    fail('--json must be valid JSON')
  }
  return { feedId: feedId as string, relay: flags.relay!, hub: flags.hub!, token: flags.token!, payload }
}

async function runData(argv: string[]): Promise<void> {
  const f = parseDataArgs(argv)
  const client = new SenderClient({ relayUrl: f.relay, hubUid: f.hub, senderToken: f.token })
  const done = (code: number): never => { client.close(); process.exit(code) }
  try {
    await client.connect()
    const ack = await client.data({ feedId: f.feedId, payload: f.payload })
    process.stdout.write(`${JSON.stringify({ ok: true, pushed_at: ack.pushed_at })}\n`)
    done(0)
  } catch (err) {
    process.stderr.write(`dbz-send: ${err instanceof Error ? err.message : String(err)}\n`)
    done(1)
  }
}

/**
 * Cross-flag validation for the notify (non-`data`) form. Which flags are required forks on
 * `--resolve`: a create needs `--title`/`--severity`; a resolve needs neither of those (the hub
 * doesn't either — see hub/src/relay/handler.ts's resolve branch) but does need `--dedup-key`,
 * and `--wait` makes no sense for it — a resolve retracts an alert, so there is no human answer
 * left to wait for.
 */
export function validateNotifyFlags(f: Flags): void {
  for (const [flag, v] of [['--relay', f.relay], ['--hub', f.hub], ['--token', f.token]] as const) {
    if (v === undefined) fail(`${flag} is required`)
  }
  if (f.resolve) {
    if (f.dedupKey === undefined) fail('--dedup-key is required with --resolve')
    if (f.wait !== undefined) fail('--wait is invalid with --resolve — there is no alert to wait an answer on')
    warnIgnoredWithResolve(f)
    return
  }
  if (f.title === undefined) fail('--title is required')
  if (f.severity === undefined) fail('--severity is required')
  if (!SEVERITIES.includes(f.severity as Severity)) fail('--severity must be info, warn or critical')
}

/**
 * `buildNotifyOpts` sends exactly `{resolve, dedup_key}` on the resolve branch — every create-only
 * flag below is silently meaningless combined with `--resolve`, same as the hub drops `title`/
 * `severity`/etc. for its own resolve mode. Warning rather than failing: a caller that always
 * passes, say, `--ttl 300` and conditionally adds `--resolve` for a CLEAR shouldn't have to strip
 * it back out first — but a warning tells them the value went nowhere, so it isn't silent.
 */
function warnIgnoredWithResolve(f: Flags): void {
  const ignored: string[] = []
  if (f.title !== undefined) ignored.push('--title')
  if (f.body !== undefined) ignored.push('--body')
  if (f.devices.length > 0) ignored.push('--device')
  if (f.options.length > 0) ignored.push('--option')
  if (f.sound) ignored.push('--sound')
  if (f.ttl !== undefined) ignored.push('--ttl')
  if (ignored.length > 0) {
    process.stderr.write(`dbz-send: ${ignored.join(', ')} ignored with --resolve\n`)
  }
}

/** Translates parsed flags into the wire payload — a resolve carries only `resolve`/`dedup_key`. */
export function buildNotifyOpts(f: Flags): NotifyOpts {
  if (f.resolve) return { resolve: true, dedup_key: f.dedupKey }
  return {
    title: f.title, severity: f.severity as Severity,
    body: f.body,
    devices: f.devices.length > 0 ? f.devices : undefined,
    options: f.options.length > 0 ? f.options : undefined,
    sound: f.sound ? true : undefined,
    ttl_s: f.ttl, dedup_key: f.dedupKey,
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  if (argv[0] === 'data') return runData(argv.slice(1))

  const f = parseArgs(argv)
  validateNotifyFlags(f)

  const client = new SenderClient({ relayUrl: f.relay!, hubUid: f.hub!, senderToken: f.token! })
  const notify = buildNotifyOpts(f)

  const done = (code: number): never => { client.close(); process.exit(code) }
  try {
    let sawAnswer = false
    if (f.wait !== undefined) {
      // Register before the SEND: an answer can never race ahead of the ack on one socket, but
      // there is no reason to leave the gap. Content printed here is the sender's own — the
      // "never log plaintext" rule protects the relay path, not the tool the human is driving.
      client.onAnswer((evt) => {
        sawAnswer = true
        process.stdout.write(`${JSON.stringify(evt)}\n`)
        done(0)
      })
    }
    await client.connect()
    const ack = await client.notify(notify)
    process.stdout.write(`${JSON.stringify({ acked: true, ...ack })}\n`)
    if (f.wait === undefined) done(0)
    setTimeout(() => {
      if (!sawAnswer) {
        process.stderr.write(`dbz-send: no answer within ${f.wait}s — the hub keeps it if one arrives later\n`)
        done(3)
      }
    }, f.wait! * 1000)
  } catch (err) {
    process.stderr.write(`dbz-send: ${err instanceof Error ? err.message : String(err)}\n`)
    done(1)
  }
}

// Only run when executed as the entry script — not when imported (e.g. by cli.test.ts, which
// exercises parseArgs/validateNotifyFlags/buildNotifyOpts directly and must not also trigger a
// real CLI run, argv and all, as a side effect of the import.
// realpathSync so a symlinked install (`~/.local/bin/dbz-send -> .../dist/cli.js`, the shape the
// integrations docs suggest) still counts as "executed as the entry script": argv[1] is the symlink
// path, import.meta.url is the target's, and without resolving they never match. Resolving the
// real path ensures a symlinked installation invokes the CLI instead of exiting silently.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  void main()
}
