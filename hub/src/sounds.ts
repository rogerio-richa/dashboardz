import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// stream-activity contract: 'activity' appended last — a soft per-family tick for stream cells opted into
// chime_activity. Sound only, no alert card; degrades/resolves exactly like the other events.
export const SOUND_EVENTS = ['critical', 'warn', 'info', 'offline', 'activity'] as const
export type SoundEvent = (typeof SOUND_EVENTS)[number]
export interface SoundManifest { rev: number; families: Record<string, { name: string }> }

const FALLBACK: SoundManifest = { rev: 0, families: { classic: { name: 'Classic beeps' } } }
let cached: SoundManifest | null = null

/** Same static-root derivation as server.ts (`<dist>/../static`). Degrades to classic-only, never throws. */
export function getSoundManifest(): SoundManifest {
  if (cached) return cached
  try {
    const path = join(dirname(fileURLToPath(import.meta.url)), '..', 'static', 'sounds', 'manifest.json')
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    const ok = parsed && typeof parsed === 'object' && typeof parsed.rev === 'number'
      && parsed.families && typeof parsed.families === 'object' && !Array.isArray(parsed.families)
    cached = ok ? { rev: parsed.rev, families: { ...FALLBACK.families, ...parsed.families } } : FALLBACK
  } catch { cached = FALLBACK }
  return cached
}

export function parseSounds(json: string | null | undefined): Record<string, string> {
  if (!json) return {}
  try {
    const parsed = JSON.parse(json)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(parsed)) if (typeof v === 'string' && v) out[k] = v
    return out
  } catch { return {} }
}

/** theme ⊕ screen ⊕ classic; unknown family degrades to classic (house rule: never emitted broken). */
export function resolveSounds(
  theme: Record<string, string>, screen: Record<string, string>, manifest: SoundManifest,
): Record<SoundEvent, string> {
  const out = {} as Record<SoundEvent, string>
  for (const event of SOUND_EVENTS) {
    const pick = screen[event] ?? theme[event] ?? 'classic'
    out[event] = manifest.families[pick] ? pick : 'classic'
  }
  return out
}
