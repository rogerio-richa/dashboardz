/**
 * Generates `hub/packs/rules.generated.mjs`: the parts of the hub's rules that live in TypeScript
 * (the cell schema, the theme document schema, the sound events), flattened into plain data the
 * theme-pack checker can import with bare `node`. `hub/test/packs-rules-mirror.test.ts` fails when
 * the committed file differs from a fresh generation, so the copy cannot drift.
 *
 * Run from hub/: `npx tsx scripts/gen-pack-rules.ts`
 */
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { cellSchema, DESIGN_OPTIONS_MAX_BYTES } from '../src/screens/cellSchema.js'
import { themeBodySchema } from '../src/routes/admin/themes.js'
import { SOUND_EVENTS } from '../src/sounds.js'

type Json = Record<string, unknown>
/** A setting that holds one value: what the hub accepts at that path. */
export interface Leaf { type?: unknown; enum?: unknown[]; minimum?: number; maximum?: number; maxLength?: number }
/** A setting that holds a list of rows (e.g. a table's columns). */
export interface ListShape { minItems?: number; maxItems?: number; itemKeys: string[]; required: string[] }
export interface WidgetSettings { leaves: Record<string, Leaf>; lists: Record<string, ListShape>; designOptions: boolean }

const pick = (node: Json, keys: (keyof Leaf)[]): Leaf => {
  const out: Leaf = {}
  for (const k of keys) if (node[k] !== undefined) (out as Json)[k] = node[k]
  return out
}

/** Every `properties` map reachable through oneOf/anyOf/allOf branches, merged. */
function mergedProperties(node: Json): Record<string, Json> {
  const merged: Record<string, Json> = { ...((node.properties as Record<string, Json>) ?? {}) }
  for (const key of ['oneOf', 'anyOf', 'allOf'] as const) {
    for (const branch of (node[key] as Json[] | undefined) ?? []) Object.assign(merged, mergedProperties(branch))
  }
  return merged
}

function walk(props: Record<string, Json>, prefix: string, out: WidgetSettings): void {
  for (const [name, node] of Object.entries(props)) {
    const path = prefix ? `${prefix}.${name}` : name
    if (path === 'design_options') { out.designOptions = true; continue }
    const items = node.items as Json | undefined
    const rowProps = items ? mergedProperties(items) : {}
    if (node.type === 'array' && items && Object.keys(rowProps).length > 0) {
      // A list of rows. Rows may be alternative shapes (oneOf, e.g. bound vs pending binding):
      // the fields are the union, the required ones those every shape requires.
      const branches = [items, ...(((items.oneOf ?? items.anyOf) as Json[] | undefined) ?? [])]
      const required = items.required
        ? [...(items.required as string[])]
        : branches.slice(1).reduce<string[] | null>((acc, b) => {
          const r = (b.required as string[]) ?? []
          return acc === null ? [...r] : acc.filter((k) => r.includes(k))
        }, null) ?? []
      out.lists[path] = {
        ...(node.minItems !== undefined ? { minItems: node.minItems as number } : {}),
        ...(node.maxItems !== undefined ? { maxItems: node.maxItems as number } : {}),
        itemKeys: Object.keys(rowProps).sort(),
        required: required.sort(),
      }
      continue
    }
    const nested = mergedProperties(node)
    if (node.type === 'object' && Object.keys(nested).length > 0) { walk(nested, path, out); continue }
    out.leaves[path] = pick(node, ['type', 'enum', 'minimum', 'maximum', 'maxLength'])
  }
}

export function buildPackRules(): { WIDGET_SETTINGS: Record<string, WidgetSettings>; THEME_LIMITS: Json; SOUND_EVENTS: string[]; DESIGN_OPTIONS: Json } {
  const WIDGET_SETTINGS: Record<string, WidgetSettings> = {}
  for (const branch of cellSchema.oneOf as Json[]) {
    const props = branch.properties as Json
    const widget = (props.widget as Json).const as string
    const out: WidgetSettings = { leaves: {}, lists: {}, designOptions: false }
    walk(mergedProperties(props.config as Json), '', out)
    WIDGET_SETTINGS[widget] = out
  }
  const body = themeBodySchema([]) as Json
  const p = body.properties as Record<string, Json>
  const board = p.board.properties as Record<string, Json>
  const THEME_LIMITS = {
    nameMaxLength: (p.name as Json).maxLength,
    colorPattern: ((board.ink as Json).pattern as string),
    board: Object.fromEntries(Object.entries(board).map(([k, v]) => [k, pick(v, ['type', 'minimum', 'maximum'])])),
    chromeKeys: Object.keys((p.chrome as Json).properties as Json).sort(),
    designIdMaxLength: ((p.widgets as Json).additionalProperties as Json).maxLength,
    recommended: {
      maxWidgets: (p.recommended as Json).maxProperties,
      maxIds: ((p.recommended as Json).additionalProperties as Json).maxItems,
    },
    backdropMaxLength: (p.backdrop as Json).maxLength,
    soundValuePattern: (((p.sounds as Json).properties as Record<string, Json>).critical as Json).pattern,
  }
  // design_options limits, read off the clock branch (the prop is shared by every widget).
  const clockConfig = mergedProperties(((cellSchema.oneOf as Json[])[0].properties as Json).config as Json)
  const dopt = clockConfig.design_options as Json
  const value = dopt.additionalProperties as Json
  const DESIGN_OPTIONS = {
    keyPattern: (dopt.propertyNames as Json).pattern,
    maxKeys: dopt.maxProperties,
    maxString: value.maxLength,
    maxItems: value.maxItems,
    valueTypes: value.type,
    itemTypes: (value.items as Json).type,
    maxBytes: DESIGN_OPTIONS_MAX_BYTES,
  }
  return { WIDGET_SETTINGS, THEME_LIMITS: { ...THEME_LIMITS, themeKeys: Object.keys(p).sort() }, SOUND_EVENTS: [...SOUND_EVENTS], DESIGN_OPTIONS }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const rules = buildPackRules()
  const target = fileURLToPath(new URL('../packs/rules.generated.mjs', import.meta.url))
  writeFileSync(target, [
    '// GENERATED by hub/scripts/gen-pack-rules.ts from the hub\'s TypeScript. Do not edit by hand:',
    '// run `npx tsx scripts/gen-pack-rules.ts` in hub/ (packs-rules-mirror.test.ts checks it).',
    `export const WIDGET_SETTINGS = ${JSON.stringify(rules.WIDGET_SETTINGS, null, 2)}`,
    `export const THEME_LIMITS = ${JSON.stringify(rules.THEME_LIMITS, null, 2)}`,
    `export const SOUND_EVENTS = ${JSON.stringify(rules.SOUND_EVENTS)}`,
    `export const DESIGN_OPTIONS = ${JSON.stringify(rules.DESIGN_OPTIONS, null, 2)}`,
    '',
  ].join('\n'))
  console.log(`wrote ${target}`)
}
