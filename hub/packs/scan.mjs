/**
 * Static scans of a design's source: which drawing calls it makes, which browser APIs it reaches
 * for, and what it imports. Shared by the theme-pack checker and the hub's own guard tests
 * (portable-subset.test.ts), so a pack is held to the same boundary the built-in designs are.
 */

/**
 * Drawing calls a design may make on `g` (the portable drawing subset, docs/architecture/widgets.md).
 * Gradients, filters, blend modes, clip() and shadowBlur do not lower cheaply and stay out.
 */
export const ALLOWED_G_OPS = new Set([
  'arc', 'beginPath', 'closePath', 'clearRect', 'drawImage', 'fill', 'fillStyle', 'fillText',
  'font', 'globalAlpha', 'lineCap', 'lineTo', 'lineWidth', 'measureText', 'moveTo', 'rect',
  'restore', 'rotate', 'save', 'scale', 'setTransform', 'stroke', 'strokeStyle', 'textAlign',
  'textBaseline', 'translate',
])

/**
 * What a design must never touch: ambient globals, network and asset loading (the host's job),
 * self-scheduling (isAnimating + ctx.now is the whole mechanism), and clock reads (ctx.now is the
 * only clock). Run on source with comments removed and strings blanked.
 */
export const BROWSER_API = new RegExp([
  String.raw`\b(document|window|navigator|localStorage|sessionStorage|indexedDB|caches)\b`,
  String.raw`\b(XMLHttpRequest|WebSocket|EventSource|Worker)\b`,
  String.raw`\bfetch\s*\(`,
  String.raw`\bnew\s+(Image|URL|Worker)\b`,
  String.raw`\bURL\.`,
  String.raw`\bcreateImageBitmap\s*\(`,
  String.raw`\b(setTimeout|setInterval|requestAnimationFrame|queueMicrotask)\s*\(`,
  String.raw`\bDate\.now\s*\(`,
  String.raw`\bnew\s+Date\s*\(\s*\)`,
].join('|'))

/**
 * Source with comments removed and, with `strings: 'blank'`, string contents blanked, so a regex
 * over it sees code only. Newlines survive so line-based reasoning still lines up.
 * @param {string} src
 * @param {'keep' | 'blank'} strings
 */
export function scannableSource(src, strings = 'keep') {
  let out = ''
  let i = 0
  let state = 'code'
  const emit = (ch) => { if (state === 'code' || strings === 'keep') out += ch }
  while (i < src.length) {
    const two = src.slice(i, i + 2)
    const ch = src[i]
    if (state === 'code') {
      if (two === '//') { state = 'line'; i += 2; continue }
      if (two === '/*') { state = 'block'; i += 2; continue }
      if (ch === "'") state = 'single'
      else if (ch === '"') state = 'double'
      else if (ch === '`') state = 'template'
      out += state === 'code' || strings === 'keep' ? ch : ' '
      i += 1
      continue
    }
    if (state === 'line') {
      if (ch === '\n') { state = 'code'; out += ch }
      i += 1
      continue
    }
    if (state === 'block') {
      if (two === '*/') { state = 'code'; i += 2; continue }
      if (ch === '\n') out += ch
      i += 1
      continue
    }
    if (ch === '\\') {
      if (strings === 'keep') out += src.slice(i, i + 2)
      else out += '  '
      i += 2
      continue
    }
    const closes = (state === 'single' && ch === "'") || (state === 'double' && ch === '"')
      || (state === 'template' && ch === '`')
    if (closes) {
      state = 'code'
      out += strings === 'keep' ? ch : ' '
      i += 1
      continue
    }
    emit(ch)
    if (strings === 'blank') out += ch === '\n' ? '\n' : ' '
    i += 1
  }
  return out
}

/**
 * @param {string} source a design module's source
 * @returns {{ gOps: string[], disallowedOps: string[], browserApis: string[], imports: string[] }}
 */
export function scanSource(source) {
  const code = scannableSource(source, 'keep')
  const gOps = [...new Set([...code.matchAll(/\bg\.([a-zA-Z]+)/g)].map((m) => m[1]))]
  const blank = scannableSource(source, 'blank')
  const browserApis = [...new Set([...blank.matchAll(new RegExp(BROWSER_API.source, 'g'))].map((m) => m[0].trim()))]
  const imports = [
    // import x from 'y', import{a}from'y', import*as m from 'y' (spaces optional)
    ...[...code.matchAll(/^\s*import\s*(?:[\w$*{][^'"]*?)from\s*['"]([^'"]+)['"]/gm)].map((m) => m[1]),
    ...[...code.matchAll(/^\s*import\s*['"]([^'"]+)['"]/gm)].map((m) => m[1]),
    // Any import(...) at all: a computed or template specifier is still an import.
    ...[...code.matchAll(/\bimport\s*\(\s*([^)]*)\)/g)].map((m) => m[1].trim().replace(/^['"`]|['"`]$/g, '') || '(dynamic)'),
    ...[...code.matchAll(/^\s*export\s[^'"]*?from\s*['"]([^'"]+)['"]/gm)].map((m) => m[1]),
  ]
  return { gOps, disallowedOps: gOps.filter((op) => !ALLOWED_G_OPS.has(op)), browserApis, imports }
}
