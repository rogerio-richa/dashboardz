/**
 * Config reads, over a real parse, attributed to the function that performs them — and to whether
 * anything can ever CALL that function.
 *
 * This answers "can the renderer reach this knob?" through the same runtime paths the device uses,
 * with real config shapes and the actual design catalogue. Two holes remain important:
 *   1. a name in PROSE counted. Closed by `source-scan.ts`, which blanks comments before matching.
 *      That is how the retired `style` knob went on looking read after its consumer was deleted.
 *   2. a name in DEAD CODE counted. Delete a helper's only caller, leave the helper in place, and
 *      every text scan still sees the read. This module closes that one, and it is why the guard
 *      no longer needs `source-scan.ts`: an AST has no comments in it to begin with.
 *
 * `typescript` (a direct devDependency) is the parser. TypeScript 7 has no in-process
 * `ts.createSourceFile` — parsing lives in the native compiler — so the AST comes from
 * `typescript/unstable/sync`, which spawns the compiler and hands back real `SourceFile` nodes.
 * All traversal is done eagerly and the session closed before results are returned, so callers get
 * plain data and no live handle. Cost is ~50ms for the whole renderer tree.
 *
 * ── WHAT COUNTS AS A READ ─────────────────────────────────────────────────────────────────────
 * The same two shapes the old regex matched, deliberately neither widened nor narrowed:
 *   - `X.knob` / `X?.knob` where X's trailing name is one of `c`, `cfg`, `config`, `conf`, `clamp`,
 *     `col`, `s`, `thresholds`. Those last four are the destructured/mapped locals that hold a
 *     slice of config under another name: `const clamp = c.clamp`, `cfg.columns.map(col => …)`,
 *     `c.series.map(s => …)`, `const thresholds = record(c.thresholds) ?? {}`.
 *   - a string literal whose whole text is the knob name — `config['min_severity']` is a genuine
 *     read, and the regex counted a bare quoted name anywhere, so this does too.
 * "Trailing name" rather than "is an identifier" is what keeps `this.cfg.scale` matching, exactly
 * as `\bcfg\.scale` did.
 *
 * ── WHAT COUNTS AS REACHABLE ──────────────────────────────────────────────────────────────────
 * Roots are what the outside world can actually invoke: module top level, and every exported
 * binding. A design is only ever entered through its `export default { meta, draw, isAnimating }`,
 * and that falls out for free — the export statement is top-level code, so the identifiers in it
 * are top-level references, which reach the functions they name.
 *
 * From there, a function F that is reachable makes reachable:
 *   - every function named by an identifier appearing anywhere in F's own body (a call `f()`, but
 *     equally a bare mention `onDone(f)` — passing a function is assumed to lead to calling it);
 *   - every function created in F's body that nothing could name anyway (see below).
 *
 * ── APPROXIMATIONS, ALL OF THEM TOWARD "REACHABLE" ────────────────────────────────────────────
 * Static reachability over dynamic JS is undecidable, so every approximation here is chosen to
 * risk a FALSE NEGATIVE (a dead knob reported live) over a false positive (a live knob reported
 * dead). A guard that cries wolf gets a name added to a list to quiet it, which is how a genuinely
 * dead knob gets waved through.
 *   1. Name resolution is global and scope-blind: a reference to `f` reaches EVERY function named
 *      `f` in the analysed set, in any file. No import graph, no shadowing, no block scope.
 *   2. Member names are names: `o.draw()` reaches every function named `draw`. This is how design
 *      registries, `ctx.draw`-style dispatch and any dynamic lookup stay covered.
 *   3. Only two shapes are treated as needing a caller at all: a `function f() {}` declaration, and
 *      a function/arrow bound straight to a variable (`const f = () => …`). Every other function
 *      value — object-literal properties, class methods, callbacks passed inline, IIFEs — is
 *      reachable as soon as the code that CREATES it is reachable. That is the shape the historical
 *      bug took (a top-level helper whose caller was deleted), and everything else stays live.
 *   4. Conditions are not evaluated. `if (false) draw()` reaches `draw`.
 *   5. A function referenced only from dead code is dead, transitively — that is the point — but a
 *      function referenced from ANY reachable function is live even if that reference is itself
 *      unreachable at runtime (see 4).
 *
 * The net effect: this can still miss a dead knob. It should not invent one.
 */
import { API } from 'typescript/unstable/sync'
import {
  isArrowFunction, isBindingElement, isClassDeclaration, isConstructorDeclaration,
  isFunctionDeclaration, isFunctionExpression, isGetAccessorDeclaration, isIdentifier,
  isImportClause, isImportSpecifier, isMethodDeclaration, isNamespaceImport,
  isNoSubstitutionTemplateLiteral, isParameterDeclaration, isPropertyAccessExpression,
  isPropertyAssignment, isPropertyDeclaration, isSetAccessorDeclaration, isStringLiteral,
  isVariableDeclaration, isExportAssignment,
  SyntaxKind,
  type Node, type SourceFile,
} from 'typescript/unstable/ast'

/** Locals that hold a slice of config under another name. See the docstring. */
const CONTAINERS = new Set(['c', 'cfg', 'config', 'conf', 'clamp', 'col', 's', 'thresholds', 'ticker', 'led', 'candles'])

export type ReadKind = 'member' | 'string'

export interface ReadSite {
  /** Path as it was handed to `analyseConfigReads`. */
  file: string
  /** 1-based, for a failure message someone can act on. */
  line: number
  /** The enclosing function, named for humans: `draw`, `<top level>`, `<anonymous>` … */
  owner: string
  reachable: boolean
  kind: ReadKind
}

/**
 * `unread`         — no renderer mentions this knob as config at all.
 * `dead-code-only` — every read of it sits in a function nothing can call.
 * `read`           — at least one read is reachable.
 */
export type KnobStatus = 'read' | 'dead-code-only' | 'unread'

export interface KnobReport {
  status: KnobStatus
  sites: ReadSite[]
}

export interface ConfigReadAnalysis {
  report(knob: string): KnobReport
  /** Every function the analysis decided nothing can call, for diagnostics. */
  deadFunctions: string[]
}

interface Fn {
  id: number
  file: string
  line: number
  label: string
  names: string[]
  /** false ⇒ reachable as soon as its creating scope is (callbacks, methods, IIFEs, module top). */
  requiresCaller: boolean
  creator: number
  root: boolean
  triggers: Set<string>
  children: number[]
}

const isFunctionLike = (node: Node): boolean =>
  isFunctionDeclaration(node) || isFunctionExpression(node) || isArrowFunction(node)
  || isMethodDeclaration(node) || isConstructorDeclaration(node)
  || isGetAccessorDeclaration(node) || isSetAccessorDeclaration(node)

const hasExportModifier = (node: Node): boolean => {
  const mods = (node as { modifiers?: readonly Node[] }).modifiers
  if (!mods) return false
  for (const m of mods) if (m.kind === SyntaxKind.ExportKeyword) return true
  return false
}

/** Identity is not stable across property reads on these lazy nodes, so positions are the key. */
const spanKey = (node: Node): string => `${node.pos}:${node.end}`

export function analyseConfigReads(files: readonly string[]): ConfigReadAnalysis {
  const api = new API({ cwd: process.cwd() })
  try {
    const snapshot = api.updateSnapshot({ openFiles: files as string[] })
    const projects = snapshot.getProjects()
    const sourceOf = (file: string): SourceFile => {
      const preferred = snapshot.getDefaultProjectForFile(file)
      for (const project of preferred ? [preferred, ...projects] : projects) {
        const sf = project.program.getSourceFile(file)
        if (sf) return sf
      }
      throw new Error(`no parse available for ${file} — the guard cannot vouch for any knob`)
    }
    return collect(files.map((file) => ({ file, source: sourceOf(file) })))
  } finally {
    api.close()
  }
}

function collect(parsed: readonly { file: string, source: SourceFile }[]): ConfigReadAnalysis {
  const fns: Fn[] = []
  const byName = new Map<string, number[]>()
  const reads = new Map<string, { fn: number, file: string, line: number, kind: ReadKind }[]>()

  const addFn = (init: Omit<Fn, 'id' | 'triggers' | 'children'>): Fn => {
    const fn: Fn = { ...init, id: fns.length, triggers: new Set(), children: [] }
    fns.push(fn)
    if (init.creator >= 0) fns[init.creator].children.push(fn.id)
    for (const name of fn.names) {
      const bucket = byName.get(name)
      if (bucket) bucket.push(fn.id)
      else byName.set(name, [fn.id])
    }
    return fn
  }

  for (const { file, source } of parsed) {
    const lineOf = (node: Node) => source.getLineAndCharacterOfPosition(node.end).line + 1
    const declNames = new Set<string>()
    const top = addFn({
      file, line: 1, label: '<top level>', names: [], requiresCaller: false, creator: -1, root: true,
    })

    const recordRead = (knob: string, kind: ReadKind, owner: number, node: Node) => {
      const bucket = reads.get(knob) ?? []
      bucket.push({ fn: owner, file, line: lineOf(node), kind })
      reads.set(knob, bucket)
    }

    const markDeclName = (node: Node) => {
      const named = node as { name?: Node, propertyName?: Node }
      for (const part of [named.name, named.propertyName]) {
        if (part && isIdentifier(part)) declNames.add(spanKey(part))
      }
    }

    const visit = (node: Node, owner: number) => {
      // Declaration NAMES are not references. Registering them before recursing is what keeps
      // `const fitted = () => …` from counting as a call to `fitted`, which would make every
      // arrow-bound helper unconditionally reachable and re-open the hole this module closes.
      if (
        isVariableDeclaration(node) || isFunctionDeclaration(node) || isClassDeclaration(node)
        || isParameterDeclaration(node) || isPropertyDeclaration(node) || isMethodDeclaration(node)
        || isGetAccessorDeclaration(node) || isSetAccessorDeclaration(node)
        || isPropertyAssignment(node) || isBindingElement(node) || isImportSpecifier(node)
        || isImportClause(node) || isNamespaceImport(node) || isFunctionExpression(node)
      ) markDeclName(node)

      if (isFunctionLike(node)) {
        const fn = addFn({ ...describeFunction(node, file, lineOf(node)), creator: owner, root: false })
        node.forEachChild((child) => visit(child, fn.id))
        return
      }

      if (isIdentifier(node) && !declNames.has(spanKey(node))) fns[owner].triggers.add(node.text)

      if (isPropertyAccessExpression(node)) {
        const base = node.expression
        const baseName = isIdentifier(base) ? base.text
          : isPropertyAccessExpression(base) && isIdentifier(base.name) ? base.name.text
            : null
        if (baseName && CONTAINERS.has(baseName) && isIdentifier(node.name)) {
          recordRead(node.name.text, 'member', owner, node)
        }
      }
      if (isStringLiteral(node) || isNoSubstitutionTemplateLiteral(node)) {
        recordRead(node.text, 'string', owner, node)
      }
      node.forEachChild((child) => visit(child, owner))
    }

    source.forEachChild((statement) => {
      // `export function f`, `export const f = () => …`, `export default function`. Every other
      // export is a top-level identifier reference and needs no special case.
      if (hasExportModifier(statement) || isExportAssignment(statement)) {
        const before = fns.length
        visit(statement, top.id)
        for (let i = before; i < fns.length; i++) if (fns[i].creator === top.id) fns[i].root = true
        return
      }
      visit(statement, top.id)
    })
  }

  const reachable = new Set<number>()
  const queue: number[] = []
  const mark = (id: number) => { if (!reachable.has(id)) { reachable.add(id); queue.push(id) } }
  for (const fn of fns) if (fn.root) mark(fn.id)
  while (queue.length) {
    const fn = fns[queue.pop() as number]
    for (const name of fn.triggers) for (const id of byName.get(name) ?? []) mark(id)
    for (const id of fn.children) if (!fns[id].requiresCaller) mark(id)
  }

  const report = (knob: string): KnobReport => {
    const sites = (reads.get(knob) ?? []).map((site) => ({
      file: site.file,
      line: site.line,
      owner: fns[site.fn].label,
      reachable: reachable.has(site.fn),
      kind: site.kind,
    }))
    const status: KnobStatus = sites.some((s) => s.reachable) ? 'read'
      : sites.length ? 'dead-code-only'
        : 'unread'
    return { status, sites }
  }

  const deadFunctions = fns
    .filter((fn) => !reachable.has(fn.id) && fn.names.length > 0)
    .map((fn) => `${fn.file}:${fn.line} ${fn.label}`)

  return { report, deadFunctions }
}

/**
 * Which functions can only be entered by name. A `function f(){}` and a `const f = () => …` are the
 * two shapes a caller-less helper actually takes in this codebase; everything else is a value
 * handed to something that will run it, and is treated as live with its creating scope.
 */
function describeFunction(
  node: Node, file: string, line: number,
): Omit<Fn, 'id' | 'triggers' | 'children' | 'creator' | 'root'> {
  const named = (names: string[], requiresCaller: boolean) => ({
    file, line, names, requiresCaller, label: names[0] ?? '<anonymous>',
  })

  if (isFunctionDeclaration(node)) {
    return node.name && isIdentifier(node.name)
      ? named([node.name.text], true)
      : named([], false) // `export default function () {}` — a value, entered from outside.
  }
  if (isFunctionExpression(node) || isArrowFunction(node)) {
    const parent = node.parent
    if (parent && isVariableDeclaration(parent) && isIdentifier(parent.name)) {
      return named([parent.name.text], true)
    }
    if (parent && isPropertyAssignment(parent) && isIdentifier(parent.name)) {
      return named([parent.name.text], false)
    }
    if (isFunctionExpression(node) && node.name && isIdentifier(node.name)) {
      return named([node.name.text], false)
    }
    return named([], false)
  }
  const member = (node as { name?: Node }).name
  return member && isIdentifier(member) ? named([member.text], false) : named([], false)
}
