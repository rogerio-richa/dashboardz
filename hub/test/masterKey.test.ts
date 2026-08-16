import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { afterEach, describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.js'
import { loadMasterKey } from '../src/secrets/masterKey.js'

const fixedKey = (fill: number) => Buffer.alloc(32, fill)
const tempDirs: string[] = []

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dashboardz-master-key-'))
  tempDirs.push(dir)
  return dir
}

const raceWorkerSource = String.raw`
  const fs = require('node:fs')
  const { workerData } = require('node:worker_threads')
  const state = new Int32Array(workerData.shared)
  const first = Buffer.from(workerData.first, 'base64')
  const second = Buffer.from(workerData.second, 'base64')
  let useSecond = true
  let tempCounter = 0

  Atomics.store(state, 0, 1)
  Atomics.notify(state, 0)
  while (Atomics.load(state, 1) === 0) {
    const bytes = useSecond ? second : first
    if (workerData.mode === 'rename') {
      const temp = workerData.path + '.replacement-' + tempCounter++
      fs.writeFileSync(temp, bytes, { mode: 0o600 })
      fs.renameSync(temp, workerData.path)
    } else {
      const fd = fs.openSync(workerData.path, 'r+')
      try {
        fs.writeSync(fd, bytes, 0, bytes.length, 0)
        fs.fsyncSync(fd)
      } finally {
        fs.closeSync(fd)
      }
    }
    useSecond = !useSecond
    Atomics.add(state, 2, 1)
  }
`

async function expectConcurrentMutationRejected(mode: 'rename' | 'rewrite'): Promise<void> {
  const dataDir = makeTempDir()
  const path = join(dataDir, 'master.key')
  const first = fixedKey(19)
  const second = fixedKey(23)
  writeFileSync(path, first, { mode: 0o600 })

  const shared = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 3)
  const state = new Int32Array(shared)
  const worker = new Worker(raceWorkerSource, {
    eval: true,
    workerData: {
      mode,
      path,
      shared,
      first: first.toString('base64'),
      second: second.toString('base64'),
    },
  })

  const ready = Atomics.wait(state, 0, 0, 5_000)
  expect(ready).not.toBe('timed-out')

  let raceRejections = 0
  const unexpectedErrors: string[] = []
  let calls = 0
  const requiredMutations = mode === 'rename' ? 2_000 : 100
  try {
    while (calls < 20_000 && (Atomics.load(state, 2) < requiredMutations || raceRejections === 0)) {
      calls++
      try {
        loadMasterKey(dataDir, null, { allowCreate: false })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (/master\.key changed while being read/i.test(message)) raceRejections++
        else unexpectedErrors.push(message)
      }
    }
  } finally {
    Atomics.store(state, 1, 1)
    await worker.terminate()
  }

  expect(Atomics.load(state, 2)).toBeGreaterThanOrEqual(requiredMutations)
  expect(unexpectedErrors).toEqual([])
  expect(raceRejections).toBeGreaterThan(0)
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('master key configuration', () => {
  it('loads DASHBOARDZ_MASTER_KEY as configuration without decoding it early', () => {
    const encoded = fixedKey(3).toString('base64')

    expect(loadConfig({ ADMIN_PASSWORD: 'pw', DASHBOARDZ_MASTER_KEY: encoded }).masterKey).toBe(encoded)
    expect(loadConfig({ ADMIN_PASSWORD: 'pw' }).masterKey).toBeNull()
  })

  it('decodes an environment-supplied base64 key without touching the key file', () => {
    const dataDir = join(makeTempDir(), 'missing-data-dir')
    const expected = fixedKey(5)

    const loaded = loadMasterKey(dataDir, expected.toString('base64'), { allowCreate: false })

    expect(Buffer.from(loaded)).toEqual(expected)
    expect(existsSync(join(dataDir, 'master.key'))).toBe(false)
  })

  it.each([31, 33])('rejects an environment key that decodes to %i bytes', (length) => {
    expect(() => loadMasterKey(makeTempDir(), Buffer.alloc(length).toString('base64'), { allowCreate: true }))
      .toThrow(/exactly 32 bytes/i)
  })

  it('rejects malformed base64 instead of silently normalizing it', () => {
    const malformed = `${fixedKey(7).toString('base64').slice(0, -1)}!`

    expect(() => loadMasterKey(makeTempDir(), malformed, { allowCreate: true })).toThrow(/valid base64/i)
  })

  it('rejects valid-alphabet base64 with noncanonical pad bits', () => {
    const canonical = fixedKey(0).toString('base64')
    const noncanonical = `${canonical.slice(0, -2)}B=`
    expect(Buffer.from(noncanonical, 'base64')).toEqual(Buffer.from(canonical, 'base64'))

    expect(() => loadMasterKey(makeTempDir(), noncanonical, { allowCreate: true }))
      .toThrow(/canonical/i)
  })

  it('does not fall back to a file when a configured key is invalid', () => {
    const dataDir = makeTempDir()
    writeFileSync(join(dataDir, 'master.key'), fixedKey(9), { mode: 0o600 })

    expect(() => loadMasterKey(dataDir, Buffer.alloc(31).toString('base64'), { allowCreate: true }))
      .toThrow(/exactly 32 bytes/i)
  })
})

describe('file-backed master key', () => {
  it('creates a first-run raw key with exactly 32 bytes and mode 0600', () => {
    const dataDir = makeTempDir()

    const loaded = loadMasterKey(dataDir, null, { allowCreate: true })
    const path = join(dataDir, 'master.key')

    expect(Buffer.from(loaded)).toHaveLength(32)
    expect(readFileSync(path)).toEqual(Buffer.from(loaded))
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  it('fails with recovery instructions and writes nothing when creation is forbidden', () => {
    const dataDir = makeTempDir()
    const path = join(dataDir, 'master.key')

    expect(() => loadMasterKey(dataDir, null, { allowCreate: false }))
      .toThrow(/restore.*master\.key.*DASHBOARDZ_MASTER_KEY/i)
    expect(existsSync(path)).toBe(false)
  })

  it('corrects an existing broadly-readable key to mode 0600 before returning it', () => {
    const dataDir = makeTempDir()
    const expected = fixedKey(11)
    const path = join(dataDir, 'master.key')
    writeFileSync(path, expected, { mode: 0o644 })
    chmodSync(path, 0o644)

    expect(Buffer.from(loadMasterKey(dataDir, null, { allowCreate: false }))).toEqual(expected)
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  it('rejects a symlink without changing or reading its target', () => {
    const dataDir = makeTempDir()
    const target = join(dataDir, 'elsewhere.key')
    writeFileSync(target, fixedKey(13), { mode: 0o644 })
    chmodSync(target, 0o644)
    symlinkSync(target, join(dataDir, 'master.key'))

    expect(() => loadMasterKey(dataDir, null, { allowCreate: false })).toThrow(/regular, non-symlink/i)
    expect(statSync(target).mode & 0o777).toBe(0o644)
  })

  it('rejects a non-regular key path', () => {
    const dataDir = makeTempDir()
    mkdirSync(join(dataDir, 'master.key'))

    expect(() => loadMasterKey(dataDir, null, { allowCreate: false })).toThrow(/regular, non-symlink/i)
  })

  it('rejects a regular key file with the wrong length without replacing it', () => {
    const dataDir = makeTempDir()
    const path = join(dataDir, 'master.key')
    writeFileSync(path, Buffer.alloc(31), { mode: 0o600 })

    expect(() => loadMasterKey(dataDir, null, { allowCreate: true })).toThrow(/exactly 32 bytes/i)
    expect(lstatSync(path).size).toBe(31)
  })

  it('returns the same persisted key on a later reload', () => {
    const dataDir = makeTempDir()
    const first = loadMasterKey(dataDir, null, { allowCreate: true })

    expect(Buffer.from(loadMasterKey(dataDir, null, { allowCreate: false }))).toEqual(Buffer.from(first))
  })

  it('re-reads the winning file after an exclusive create loses with EEXIST', () => {
    const dataDir = makeTempDir()
    const winner = fixedKey(17)
    const path = join(dataDir, 'master.key')
    writeFileSync(path, winner, { mode: 0o600 })

    expect(Buffer.from(loadMasterKey(dataDir, null, { allowCreate: true }))).toEqual(winner)
    expect(readFileSync(path)).toEqual(winner)
  })

  it('fails closed when atomic rename replacements race an existing-key read', async () => {
    await expectConcurrentMutationRejected('rename')
  }, 30_000)

  it('fails closed when same-inode rewrites race an existing-key read', async () => {
    await expectConcurrentMutationRejected('rewrite')
  }, 30_000)
})
