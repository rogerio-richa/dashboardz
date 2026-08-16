import {
  type BigIntStats,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readSync,
  writeFileSync,
} from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'

const KEY_BYTES = 32
const KEY_MODE = 0o600

export function loadMasterKey(
  dataDir: string,
  configured: string | null,
  opts: { allowCreate: boolean },
): Uint8Array {
  if (configured !== null) return decodeConfiguredKey(configured)

  const path = join(dataDir, 'master.key')
  if (!opts.allowCreate) return readExistingKey(path)

  const key = randomBytes(KEY_BYTES)
  let fd: number
  try {
    fd = openSync(path, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | noFollowFlag(), KEY_MODE)
  } catch (error) {
    if (isErrno(error, 'EEXIST')) return readExistingKey(path)
    throw error
  }

  try {
    writeFileSync(fd, key)
    fsyncSync(fd)
    secureMode(fd)
    return readStableKey(fd, path, key)
  } finally {
    closeSync(fd)
  }
}

function decodeConfiguredKey(configured: string): Uint8Array {
  const decoded = Buffer.from(configured, 'base64')
  if (decoded.toString('base64') !== configured) {
    throw new Error('DASHBOARDZ_MASTER_KEY must be valid base64 in canonical form')
  }
  if (decoded.byteLength !== KEY_BYTES) {
    throw new Error('DASHBOARDZ_MASTER_KEY must decode to exactly 32 bytes')
  }
  return Uint8Array.from(decoded)
}

function readExistingKey(path: string): Uint8Array {
  let pathStat: BigIntStats
  try {
    pathStat = lstatSync(path, { bigint: true })
  } catch (error) {
    if (isErrno(error, 'ENOENT')) throw missingKeyError()
    throw error
  }
  if (pathStat.isSymbolicLink() || !pathStat.isFile()) throw invalidKeyTypeError()

  let fd: number
  try {
    fd = openSync(path, constants.O_RDONLY | noFollowFlag())
  } catch (error) {
    if (isErrno(error, 'ELOOP')) throw invalidKeyTypeError()
    throw error
  }

  try {
    const openedStat = fstatSync(fd, { bigint: true })
    if (!openedStat.isFile()) throw invalidKeyTypeError()
    if (!sameIdentity(pathStat, openedStat)) throw changedKeyError()
    secureMode(fd)
    return readStableKey(fd, path)
  } finally {
    closeSync(fd)
  }
}

function readStableKey(fd: number, path: string, expected?: Uint8Array): Uint8Array {
  const before = fstatSync(fd, { bigint: true })
  if (!before.isFile()) throw invalidKeyTypeError()
  if (before.size !== BigInt(KEY_BYTES)) {
    throw new Error('master.key must contain exactly 32 bytes; refusing to replace it')
  }
  const pathBefore = stablePathStat(path)
  if (!sameStableFile(before, pathBefore)) throw changedKeyError()

  const first = readKeyAtStart(fd)
  const between = fstatSync(fd, { bigint: true })
  const second = readKeyAtStart(fd)
  const after = fstatSync(fd, { bigint: true })
  const pathAfter = stablePathStat(path)

  if (
    !sameStableFile(before, between)
    || !sameStableFile(between, after)
    || !sameStableFile(after, pathAfter)
    || !first.equals(second)
    || (expected !== undefined && !first.equals(expected))
  ) {
    throw changedKeyError()
  }
  return Uint8Array.from(first)
}

function readKeyAtStart(fd: number): Buffer {
  const key = Buffer.alloc(KEY_BYTES)
  let offset = 0
  while (offset < key.byteLength) {
    const read = readSync(fd, key, offset, key.byteLength - offset, offset)
    if (read === 0) throw changedKeyError()
    offset += read
  }
  return key
}

function stablePathStat(path: string): BigIntStats {
  let stat: BigIntStats
  try {
    stat = lstatSync(path, { bigint: true })
  } catch {
    throw changedKeyError()
  }
  if (stat.isSymbolicLink() || !stat.isFile()) throw changedKeyError()
  return stat
}

function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

function sameStableFile(left: BigIntStats, right: BigIntStats): boolean {
  return sameIdentity(left, right)
    && left.size === right.size
    && left.mode === right.mode
    && left.nlink === right.nlink
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs
}

function secureMode(fd: number): void {
  fchmodSync(fd, KEY_MODE)
  if ((fstatSync(fd).mode & 0o777) !== KEY_MODE) {
    throw new Error('master.key permissions could not be secured to 0600')
  }
}

function noFollowFlag(): number {
  if (typeof constants.O_NOFOLLOW !== 'number') {
    throw new Error('This platform cannot safely open master.key without following symlinks')
  }
  return constants.O_NOFOLLOW
}

function missingKeyError(): Error {
  return new Error(
    'Master key is missing. Restore the existing master.key or set DASHBOARDZ_MASTER_KEY; refusing to create a replacement key.',
  )
}

function invalidKeyTypeError(): Error {
  return new Error('master.key must be a regular, non-symlink file')
}

function changedKeyError(): Error {
  return new Error('master.key changed while being read; refusing to use it')
}

function isErrno(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code
}
