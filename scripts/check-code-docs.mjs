/**
 * Fails when the code-reading guide in docs/code/ drifts from the tree it describes.
 *
 * Three cheap checks, no dependencies:
 *   1. Every link in docs/code/*.md resolves. Code is linked through its GitHub URL
 *      (`<REPO>blob/main/<file>` or `<REPO>tree/main/<dir>`, the form docs/gallery already uses),
 *      so the links work on GitHub and on the published site alike. This maps each one back to the
 *      checkout and requires the file (blob) or directory (tree) to exist. Relative links must be
 *      doc pages inside docs/. A rename or a deleted file breaks a link, so the page that names it
 *      has to change in the same diff.
 *   2. Every code section has a page that links into it. Sections are read from the filesystem, so
 *      a new component (a new integrations/<name>/, a new hub/src/<dir>/, a new file at the root
 *      of hub/src/) fails here until a page covers it.
 *   3. Every page is reachable: listed in docs/code/index.md and in the mkdocs.yml nav.
 *
 * Run from anywhere: `node scripts/check-code-docs.mjs`. hub/test/code-docs.test.ts runs the same
 * function inside the hub suite, so CI catches drift too.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The repository URL docs/code links code through. Keep in sync with docs/gallery's links. */
export const REPO = 'https://github.com/rogerio-richa/dashboardz/'

const IGNORED_DIRS = new Set(['node_modules', 'dist', 'build', '__pycache__'])

const listDirs = (dir) => existsSync(dir)
  ? readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !IGNORED_DIRS.has(e.name))
    .map((e) => join(dir, e.name))
  : []

const listFiles = (dir, pattern) => existsSync(dir)
  ? readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && pattern.test(e.name))
    .map((e) => join(dir, e.name))
  : []

/**
 * The paths a docs/code page must link into. A directory counts as covered when any link lands on
 * it or anywhere inside it. The files at the root of hub/src are listed one by one because that
 * directory is the hub's grab bag of entry points and small helpers.
 */
export function codeSections(root) {
  const fixed = [
    'hub/admin', 'hub/static/device', 'hub/static/device/widgets', 'hub/static/sounds',
    'hub/test', 'hub/scripts', 'relay', 'scripts',
  ]
  return [
    ...fixed.map((p) => join(root, p)),
    ...listDirs(join(root, 'hub', 'src')),
    ...listFiles(join(root, 'hub', 'src'), /\.ts$/),
    ...listDirs(join(root, 'apps')),
    ...listDirs(join(root, 'clients')),
    ...listDirs(join(root, 'integrations')),
  ]
}

/**
 * Link targets in one markdown file that this check can verify: repository code links (`kind`
 * blob or tree, `path` relative to the repository root) and relative doc links (`kind` doc).
 * Fenced code blocks and inline code are removed first; other external URLs and bare anchors are
 * skipped.
 */
export function checkableLinks(markdown) {
  const prose = markdown.replace(/^(```|~~~)[\s\S]*?^\1/gm, '').replace(/`[^`\n]*`/g, '')
  const links = []
  for (const match of prose.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    const raw = match[1]
    const target = raw.split('#')[0]
    if (target === '') continue
    if (target.startsWith(REPO)) {
      const code = /^(blob|tree)\/main\/(.+?)\/?$/.exec(target.slice(REPO.length))
      links.push(code ? { kind: code[1], path: decodeURIComponent(code[2]), raw } : { kind: 'bad', raw })
      continue
    }
    if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue
    links.push({ kind: 'doc', path: decodeURIComponent(target), raw })
  }
  return links
}

export function findCodeDocProblems(root) {
  const docsRoot = join(root, 'docs')
  const docsDir = join(docsRoot, 'code')
  if (!existsSync(docsDir)) return ['docs/code/ is missing']
  const pages = listFiles(docsDir, /\.md$/)
  const problems = []
  const targets = []

  for (const page of pages) {
    const where = relative(root, page)
    for (const link of checkableLinks(readFileSync(page, 'utf8'))) {
      if (link.kind === 'bad') {
        problems.push(`${where}: ${link.raw} must be ${REPO}blob/main/<file> or ${REPO}tree/main/<dir>`)
        continue
      }
      if (link.kind === 'doc') {
        const target = resolve(dirname(page), link.path)
        if (!target.startsWith(docsRoot + sep)) problems.push(`${where}: ${link.raw} leaves docs/; link code through ${REPO}`)
        else if (!existsSync(target)) problems.push(`${where}: broken link to ${link.raw}`)
        continue
      }
      const target = resolve(root, link.path)
      const exists = existsSync(target)
      const isDir = exists && statSync(target).isDirectory()
      if (!exists) problems.push(`${where}: ${link.path} does not exist`)
      else if (link.kind === 'blob' && isDir) problems.push(`${where}: ${link.path} is a directory; link it with tree/main/`)
      else if (link.kind === 'tree' && !isDir) problems.push(`${where}: ${link.path} is a file; link it with blob/main/`)
      else targets.push(target)
    }
  }

  for (const section of codeSections(root)) {
    if (!existsSync(section)) {
      problems.push(`expected code section ${relative(root, section)} is missing; update codeSections() in scripts/check-code-docs.mjs`)
      continue
    }
    const covered = targets.some((t) => t === section || t.startsWith(section + sep))
    if (!covered) {
      const kind = statSync(section).isDirectory() ? 'directory' : 'file'
      problems.push(`no docs/code page links to the ${kind} ${relative(root, section)}`)
    }
  }

  const index = join(docsDir, 'index.md')
  const indexLinks = existsSync(index)
    ? new Set(checkableLinks(readFileSync(index, 'utf8')).filter((l) => l.kind === 'doc').map((l) => l.path))
    : new Set()
  const nav = existsSync(join(root, 'mkdocs.yml')) ? readFileSync(join(root, 'mkdocs.yml'), 'utf8') : ''
  for (const page of pages) {
    const name = relative(docsDir, page)
    if (name !== 'index.md' && !indexLinks.has(name)) problems.push(`docs/code/index.md does not list ${name}`)
    if (!nav.includes(`code/${name}`)) problems.push(`mkdocs.yml nav does not include code/${name}`)
  }

  return problems
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const problems = findCodeDocProblems(root)
  if (problems.length > 0) {
    console.error(`docs/code is out of sync with the code (${problems.length} problem(s)):`)
    for (const p of problems) console.error(`  ${p}`)
    console.error('Update the matching docs/code page in the same change (see CONTRIBUTING.md).')
    process.exit(1)
  }
  console.log('docs/code: every link resolves and every code section has a page.')
}
