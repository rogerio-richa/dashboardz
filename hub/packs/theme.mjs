/**
 * Checks for a theme pack's `pack.json` and its theme: the same limits the admin theme API applies
 * (from rules.generated.mjs) and the legibility floors the built-in themes are held to
 * (hub/test/builtinThemes.test.ts calls `checkContrast` too). Plain ESM, no dependencies.
 */
import { THEME_LIMITS, SOUND_EVENTS } from './rules.generated.mjs'
import { error, warning } from './findings.mjs'
import { derivedChrome, BACKDROP_NAMES } from '../static/device/theme.mjs'

const COLOR = new RegExp(THEME_LIMITS.colorPattern)
const PALETTE = ['accent', 'bg', 'critical', 'dim', 'info', 'ink', 'scrim', 'series', 'surface', 'warn']
const PACK_ID = /^[a-z][a-z0-9-]*$/
const SEMVER = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

/** WCAG relative luminance, properly linearised. */
function relLuminance(hex) {
  let h = hex.slice(1)
  if (h.length === 3) h = [...h].map((c) => c + c).join('')
  const [r, g, b] = [0, 2, 4]
    .map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
    .map((s) => (s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** WCAG contrast ratio between two `#rgb`/`#rrggbb` colours (alpha ignored), 1 to 21. */
export function contrastRatio(a, b) {
  const [hi, lo] = [relLuminance(a), relLuminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

/**
 * The legibility floors: WCAG AA, 4.5:1 for body text (`ink`) and 3:1 for labels, strokes and fills
 * (dim, accent, severity colours, the chart series, and the chrome derived from the palette).
 * Expects a full, well-formed palette (checkTheme reports shape problems first).
 */
export function checkContrast(board, where = 'pack.json theme.board') {
  const out = []
  const chrome = derivedChrome(board, {})
  const at = (rule, label, fg, bg, floor) => {
    const ratio = contrastRatio(fg, bg)
    if (ratio < floor) {
      out.push(error(where, rule, `${label}: ${fg} on ${bg} has contrast ${ratio.toFixed(2)}:1, below the ${floor}:1 needed to read it. Make one of them lighter or darker.`))
    }
  }
  at('theme.contrast.ink', 'Text (ink) on the background (bg)', board.ink, board.bg, 4.5)
  at('theme.contrast.ink', 'Text (ink) on cards (surface)', board.ink, board.surface, 4.5)
  at('theme.contrast.dim', 'Secondary text (dim) on the background', board.dim, board.bg, 3)
  at('theme.contrast.dim', 'Secondary text (dim) on cards', board.dim, board.surface, 3)
  at('theme.contrast.accent', 'Accent on the background', board.accent, board.bg, 3)
  for (const key of ['info', 'warn', 'critical']) at('theme.contrast.severity', `Alert colour ${key} on cards`, board[key], board.surface, 3)
  board.series.forEach((s, i) => at('theme.contrast.series', `Chart colour series[${i}] on the background`, s, board.bg, 3))
  // The chrome is derived from the palette, so while a base colour fails, every derived colour
  // would just repeat that one problem. Check them once the base colours pass.
  if (out.length > 0) return out
  at('theme.contrast.chrome', 'Derived muted text on cards', chrome.muted, board.surface, 3)
  at('theme.contrast.chrome', 'Derived chip text on cards', chrome.chip, board.surface, 3)
  at('theme.contrast.chrome', 'Critical-alert details on the critical overlay', chrome.takeover_meta, chrome.takeover_bg, 3)
  at('theme.contrast.chrome', 'Critical-alert text on the critical overlay', chrome.takeover_body, chrome.takeover_bg, 3)
  at('theme.contrast.chrome', 'Text on the critical colour', chrome.on_critical, board.critical, 3)
  if (chrome.takeover_meta === chrome.takeover_body) {
    out.push(error(where, 'theme.contrast.takeover', 'The critical overlay\'s heading and body come out the same colour, because ink and critical are too alike. Make ink and critical clearly different.'))
  }
  return out
}

/** The theme document: palette, backdrop, design choices, sounds, optional chrome. */
export function checkTheme(theme, where = 'pack.json theme') {
  if (!isObject(theme)) return [error(where, 'manifest.theme', 'The pack needs a "theme" object (palette, backdrop, designs, sounds). See docs/theme-packs.md.')]
  const out = []
  for (const key of Object.keys(theme)) {
    if (!THEME_LIMITS.themeKeys.includes(key)) out.push(error(`${where}.${key}`, 'theme.unknown-key', `"${key}" is not a theme setting (a typo?). Allowed: ${THEME_LIMITS.themeKeys.join(', ')}.`))
  }
  const board = theme.board
  if (!isObject(board)) {
    out.push(error(`${where}.board`, 'theme.palette-missing', 'The theme needs a "board" palette: bg, surface, ink, dim, accent, info, warn, critical, scrim and series.'))
  } else {
    const missing = PALETTE.filter((k) => board[k] === undefined)
    if (missing.length) out.push(error(`${where}.board`, 'theme.palette-missing', `The palette is missing ${missing.join(', ')}. A pack theme sets every palette colour, so it looks the same on every hub.`))
    for (const [k, v] of Object.entries(board)) {
      const limit = THEME_LIMITS.board[k]
      if (!limit) { out.push(error(`${where}.board.${k}`, 'theme.unknown-key', `"${k}" is not a palette setting. Allowed: ${Object.keys(THEME_LIMITS.board).join(', ')}.`)); continue }
      if (k === 'series') {
        if (!Array.isArray(v) || v.length !== 4) out.push(error(`${where}.board.series`, 'theme.series', 'series must be a list of exactly 4 colours (the chart line colours).'))
        else v.forEach((c, i) => { if (typeof c !== 'string' || !COLOR.test(c)) out.push(error(`${where}.board.series`, 'theme.color', `series[${i}] is ${JSON.stringify(c)}, not a colour like "#1a2b3c".`)) })
      } else if (limit.type === 'number') {
        if (typeof v !== 'number' || (limit.minimum !== undefined && v < limit.minimum) || (limit.maximum !== undefined && v > limit.maximum)) {
          out.push(error(`${where}.board.${k}`, 'theme.range', `${k} must be a number from ${limit.minimum} to ${limit.maximum}.`))
        }
      } else if (typeof v !== 'string' || !COLOR.test(v)) {
        out.push(error(`${where}.board.${k}`, 'theme.color', `${k} is ${JSON.stringify(v)}, not a colour like "#1a2b3c".`))
      }
    }
    const shapeOk = !out.some((f) => f.rule.startsWith('theme.'))
    if (shapeOk) out.push(...checkContrast(board, `${where}.board`))
  }
  if (theme.backdrop !== undefined && !BACKDROP_NAMES.includes(theme.backdrop)) {
    out.push(error(`${where}.backdrop`, 'theme.backdrop', `Backdrop "${theme.backdrop}" doesn't exist. Use one of: ${BACKDROP_NAMES.join(', ')}.`))
  }
  if (theme.sounds !== undefined) {
    if (!isObject(theme.sounds)) out.push(error(`${where}.sounds`, 'theme.sounds', 'sounds must be an object like { "critical": "bells" }.'))
    else for (const [event, family] of Object.entries(theme.sounds)) {
      if (!SOUND_EVENTS.includes(event)) out.push(error(`${where}.sounds.${event}`, 'theme.sounds', `"${event}" is not a sound event. Use: ${SOUND_EVENTS.join(', ')}.`))
      else if (typeof family !== 'string' || !new RegExp(THEME_LIMITS.soundValuePattern).test(family)) out.push(error(`${where}.sounds.${event}`, 'theme.sounds', `The sound for ${event} must be a sound family name like "bells" (lowercase letters, digits, underscores).`))
    }
  }
  if (theme.chrome !== undefined && isObject(theme.chrome)) {
    for (const [k, v] of Object.entries(theme.chrome)) {
      if (!THEME_LIMITS.chromeKeys.includes(k)) out.push(error(`${where}.chrome.${k}`, 'theme.unknown-key', `"${k}" is not a chrome colour. Allowed: ${THEME_LIMITS.chromeKeys.join(', ')}.`))
      else if (typeof v !== 'string' || !COLOR.test(v)) out.push(error(`${where}.chrome.${k}`, 'theme.color', `chrome ${k} is ${JSON.stringify(v)}, not a colour like "#1a2b3c".`))
    }
  }
  if (theme.bg_color !== undefined && theme.bg_color !== null && (typeof theme.bg_color !== 'string' || !COLOR.test(theme.bg_color))) {
    out.push(error(`${where}.bg_color`, 'theme.color', `bg_color is ${JSON.stringify(theme.bg_color)}, not a colour like "#1a2b3c".`))
  }
  const idOk = (id) => typeof id === 'string' && id.length >= 1 && id.length <= THEME_LIMITS.designIdMaxLength
  if (isObject(theme.widgets)) {
    for (const [w, id] of Object.entries(theme.widgets)) if (!idOk(id)) out.push(error(`${where}.widgets.${w}`, 'theme.range', `The ${w} design must be a design id of 1 to ${THEME_LIMITS.designIdMaxLength} characters.`))
  }
  if (isObject(theme.recommended)) {
    const entries = Object.entries(theme.recommended)
    if (entries.length > THEME_LIMITS.recommended.maxWidgets) out.push(error(`${where}.recommended`, 'theme.range', `Suggestions can cover at most ${THEME_LIMITS.recommended.maxWidgets} widget types.`))
    for (const [w, ids] of entries) {
      if (!Array.isArray(ids)) continue
      if (ids.length > THEME_LIMITS.recommended.maxIds) out.push(error(`${where}.recommended.${w}`, 'theme.range', `At most ${THEME_LIMITS.recommended.maxIds} suggested designs per widget.`))
      if (!ids.every(idOk)) out.push(error(`${where}.recommended.${w}`, 'theme.range', `Each suggested design must be an id of 1 to ${THEME_LIMITS.designIdMaxLength} characters.`))
    }
  }
  for (const key of ['widgets', 'recommended']) {
    if (theme[key] !== undefined && !isObject(theme[key])) out.push(error(`${where}.${key}`, 'theme.shape', `${key} must be an object keyed by widget type.`))
  }
  return out
}

/**
 * `pack.json`: identity, then the theme, then how the theme's design choices line up with the
 * pack's own designs and the hub's built-in catalogue.
 *
 * @param {object} manifest parsed pack.json
 * @param {{ widget: string, id: string }[]} packDesigns the pack's designs
 * @param {Record<string, string[]>} catalogue built-in design ids per widget type
 */
export function checkManifest(manifest, packDesigns, catalogue) {
  const where = 'pack.json'
  if (!isObject(manifest)) return [error(where, 'manifest.shape', 'pack.json must be a JSON object with id, name, version and theme.')]
  const out = []
  const id = manifest.id
  if (typeof id !== 'string' || id.length < 2 || id.length > 32 || !PACK_ID.test(id)) {
    out.push(error(`${where} id`, 'manifest.id', `The pack id must be 2 to 32 characters: lowercase letters, digits and dashes, starting with a letter (for example "vintage"). Got ${JSON.stringify(id)}.`))
  }
  if (typeof manifest.name !== 'string' || manifest.name.length < 1 || manifest.name.length > THEME_LIMITS.nameMaxLength) {
    out.push(error(`${where} name`, 'manifest.name', `The pack needs a "name" (the theme's display name), 1 to ${THEME_LIMITS.nameMaxLength} characters.`))
  }
  if (typeof manifest.version !== 'string' || !SEMVER.test(manifest.version)) {
    out.push(error(`${where} version`, 'manifest.version', 'The pack needs a "version" like "1.0.0".'))
  }
  out.push(...checkTheme(manifest.theme))

  const seen = new Set()
  const builtIn = new Set(Object.values(catalogue).flat())
  for (const d of packDesigns) {
    if (typeof id === 'string' && !d.id.startsWith(`${id}-`)) {
      out.push(error(`design ${d.id}`, 'manifest.design-prefix', `Design id "${d.id}" must start with "${id}-" (the pack id), for example "${id}-${d.id}". That keeps it from clashing with built-in designs and other packs.`))
    }
    if (builtIn.has(d.id)) out.push(error(`design ${d.id}`, 'manifest.collision', `"${d.id}" is already a built-in design. Give yours a different id.`))
    if (seen.has(d.id)) out.push(error(`design ${d.id}`, 'manifest.duplicate', `Two designs in this pack are called "${d.id}". Each design needs its own id.`))
    seen.add(d.id)
  }

  const theme = isObject(manifest.theme) ? manifest.theme : {}
  const known = (widget) => new Set([...(Object.hasOwn(catalogue, widget) ? catalogue[widget] : []), ...packDesigns.filter((d) => d.widget === widget).map((d) => d.id)])
  const checkIds = (widget, ids, field) => {
    if (!Object.hasOwn(catalogue, widget)) {
      out.push(error(`${where} theme.${field}.${widget}`, 'manifest.unknown-widget', `"${widget}" is not a widget type. Use one of: ${Object.keys(catalogue).join(', ')}.`))
      return
    }
    for (const d of ids) {
      if (!known(widget).has(d)) out.push(error(`${where} theme.${field}.${widget}`, 'manifest.unknown-design', `No ${widget} design is called "${d}", in this pack or built in. Built-in ${widget} designs: ${(catalogue[widget] ?? []).join(', ') || 'none'}.`))
    }
  }
  if (isObject(theme.widgets)) for (const [w, d] of Object.entries(theme.widgets)) checkIds(w, [d], 'widgets')
  if (isObject(theme.recommended)) {
    for (const [w, ids] of Object.entries(theme.recommended)) {
      if (!Array.isArray(ids)) { out.push(error(`${where} theme.recommended.${w}`, 'theme.shape', `recommended.${w} must be a list of design ids.`)); continue }
      checkIds(w, ids, 'recommended')
      if (isObject(theme.widgets) && ids.includes(theme.widgets[w])) {
        out.push(warning(`${where} theme.recommended.${w}`, 'manifest.recommended-default', `"${theme.widgets[w]}" is already this theme's ${w} default, so suggesting it too changes nothing. Remove it from recommended.`))
      }
    }
  }
  return out
}
