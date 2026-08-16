#!/usr/bin/env node
// Accounts and their relay tokens. Writes the same file relay/src/tokens.ts reads: tokens are
// stored hashed, so the plaintext printed by `token add` is the only copy that will ever exist —
// hand it over immediately. The operator path stays deliberately small and remains the direct
// way to perform these operations.
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

// Flags (--file, --max, --note) may appear anywhere on the line — before, between, or after the
// positional group/cmd/name args — so `--file X account add demo` and `account add demo --file X`
// both work. Positional args are whatever's left after pulling flag/value pairs out.
const rawArgs = process.argv.slice(2)
const FLAG_NAMES = new Set(['--file', '--max', '--note'])
const args = []
const flags = {}
for (let i = 0; i < rawArgs.length; i++) {
  if (FLAG_NAMES.has(rawArgs[i])) { flags[rawArgs[i]] = rawArgs[i + 1]; i++ }
  else args.push(rawArgs[i])
}
const [group, cmd] = args
const flag = (name) => flags[name]
const file = flag('--file') ?? process.env.TOKENS_PATH ?? './data/tokens.json'
const hash = (t) => createHash('sha256').update(t).digest('hex')
const load = () => existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { version: 1, accounts: {}, tokens: {} }

// tmp+rename so a crash mid-write cannot truncate the live token file out from under the relay.
// The tmp name is unique per invocation (pid + random suffix), not a fixed `${file}.tmp` — two
// concurrent runs of this CLI (or this CLI racing the portal's own writer, which writes the same
// file) sharing one tmp name is corruption, not just a lost update: run B's writeFileSync can
// truncate the tmp file run A is about to rename into place, so A renames a truncated/foreign file
// into the live path. The relay then parses that as empty (every token invalid), and nothing can
// self-heal because load() throws on it. If the write itself fails, the tmp file is removed before
// rethrowing so a failed run never leaves debris or risks a later collision.
const save = (state) => {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  try {
    writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n')
    renameSync(tmp, file)
  } catch (err) {
    try { unlinkSync(tmp) } catch { /* best effort; nothing to clean up if the write itself failed */ }
    throw err
  }
}
const die = (msg, code = 64) => { console.error(msg); process.exit(code) }
const findAccount = (state, label) => Object.entries(state.accounts).find(([, a]) => a.label === label)

// The entire enforcement mechanism (src/tokens.ts's parseMaxClients) hinges on maxClients being
// either null or a genuine non-negative safe integer. Validate BEFORE any load()/save() so a bad
// --max dies without touching the file at all — not "abc" silently becoming Number('abc') = NaN
// and JSON.stringify-ing to null (an accidental unlimited grant), and not a negative number being
// written verbatim, which the relay's loader would then drop the whole account for (fail closed,
// correct) while this CLI's own `account list`/`token list` kept showing it as present — a
// split-brain between the file on disk and what the CLI just told the operator happened.
function parseMaxClientsArg(raw) {
  if (raw === undefined) return null
  // Number(raw) is too permissive for a flag value: Number('0x10') is 16 (hex), and — worse —
  // Number('') and Number('   ') are both 0, so `--max "$UNSET_VAR"` would silently cap an
  // account at zero clients instead of erroring. Require a plain decimal integer string first;
  // Number.isSafeInteger below is then just the overflow/negative check, not the format check.
  if (!/^\d+$/.test(raw.trim())) {
    die(`invalid --max "${raw}": must be a non-negative integer, or omitted for unlimited`, 64)
  }
  const n = Number(raw)
  if (!Number.isSafeInteger(n) || n < 0) {
    die(`invalid --max "${raw}": must be a non-negative integer, or omitted for unlimited`, 64)
  }
  return n
}

if (group === 'account' && cmd === 'add') {
  const label = args[2]
  if (!label) die('usage: token.mjs account add <label> [--max N]')
  const maxClients = parseMaxClientsArg(flag('--max'))
  const state = load()
  if (findAccount(state, label)) die(`account "${label}" already exists`, 65)
  const id = `acc_${randomBytes(8).toString('base64url')}`
  state.accounts[id] = { label, maxClients, createdAt: Date.now() }
  save(state)
  console.log(id)
} else if (group === 'account' && cmd === 'list') {
  const state = load()
  for (const [id, a] of Object.entries(state.accounts).sort((x, y) => x[1].label.localeCompare(y[1].label))) {
    const live = Object.values(state.tokens).filter((t) => t.accountId === id && !t.revokedAt).length
    console.log(`${a.label}\t${id}\tmaxClients=${a.maxClients ?? '∞'}\ttokens=${live}`)
  }
} else if (group === 'token' && cmd === 'add') {
  const label = args[2]
  if (!label) die('usage: token.mjs token add <accountLabel> [--note "..."]')
  const state = load()
  const found = findAccount(state, label)
  if (!found) die(`no account "${label}" — create it first`, 65)
  const token = `dzr_${randomBytes(24).toString('base64url')}`
  const id = `tk_${randomBytes(4).toString('base64url')}`
  const note = flag('--note')
  state.tokens[hash(token)] = { id, accountId: found[0], createdAt: Date.now(), ...(note ? { note } : {}) }
  save(state)
  console.log(token)
  console.log(`(token id ${id} — shown once; the file holds only its hash)`)
} else if (group === 'token' && cmd === 'revoke') {
  const id = args[2]
  const state = load()
  // Looked up once, regardless of revoked state, so "doesn't exist" and "already revoked" get
  // distinct messages instead of collapsing into one "no active token" that leaves an operator
  // unable to tell a typo'd id from a token they (or someone else) already revoked.
  const entry = Object.values(state.tokens).find((t) => t.id === id)
  if (!entry) die(`no token with id "${id}"`, 65)
  if (entry.revokedAt) die(`token "${id}" is already revoked`, 65)
  entry.revokedAt = Date.now()
  save(state)
  console.log(`revoked ${id}`)
} else if (group === 'token' && cmd === 'list') {
  const state = load()
  for (const t of Object.values(state.tokens)) {
    const label = state.accounts[t.accountId]?.label ?? '(orphaned)'
    console.log(`${t.id}\t${label}\t${t.revokedAt ? 'revoked' : 'active'}\t${t.note ?? ''}`)
  }
} else {
  die('usage: token.mjs account add|list ... | token add|revoke|list ...')
}
