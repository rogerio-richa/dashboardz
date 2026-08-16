/**
 * Asks the compiler which files it will actually check, and fails if any test file is missing.
 *
 * A typecheck config is trivially satisfiable by checking nothing: `hub/tsconfig.json` reported
 * success on `test/` for years while excluding it, and `admin/tsconfig.json` reported success on
 * everything while `files: []` gave it zero inputs — a broken admin build shipped past a full
 * review on the strength of that green tick. Both were configuration facts no test could see.
 *
 * `--listFilesOnly` is the compiler's own answer to "what is in this program", so this compares it
 * against what is on disk rather than re-reading the `include` globs and trusting them. It runs
 * BEFORE `tsc`, because a clean run over the wrong file set is the failure being guarded against,
 * not a success.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

/*
 * Run from a package root: `node <repo>/scripts/check-typecheck-scope.mjs`. The package is the
 * CWD, so one implementation serves hub, relay and clients/sender rather than three copies of a
 * guard whose whole subject is configuration drift.
 */
const pkg = process.cwd()
const config = process.argv[2] ?? 'tsconfig.check.json'
const testDir = process.argv[3] ?? 'test'
const tsc = join(pkg, 'node_modules', '.bin', 'tsc')

if (!existsSync(join(pkg, testDir))) {
  console.error(`${config}: no ${testDir}/ directory under ${pkg} — run this from a package root.`)
  process.exit(1)
}

const onDisk = readdirSync(join(pkg, testDir), { recursive: true, encoding: 'utf8' })
  .filter((name) => name.endsWith('.ts'))
  .map((name) => resolve(pkg, testDir, name))

if (onDisk.length === 0) {
  console.error(`${config}: no .ts files found under ${testDir}/ — the guard cannot vouch for anything.`)
  process.exit(1)
}

const listed = new Set(
  execFileSync(tsc, ['-p', config, '--listFilesOnly'], { cwd: pkg, encoding: 'utf8' })
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((file) => resolve(pkg, file)),
)

const missing = onDisk.filter((file) => !listed.has(file))
if (missing.length > 0) {
  console.error(
    `${config} does not typecheck ${missing.length} of ${onDisk.length} files under ${testDir}/.\n`
    + 'A green typecheck would mean nothing for them. Fix the `include`, do not delete this check.\n'
    + missing.map((file) => `  ${file.slice(pkg.length + 1)}`).join('\n'),
  )
  process.exit(1)
}

console.log(`typecheck scope: ${onDisk.length} files under ${testDir}/, all in the program.`)
