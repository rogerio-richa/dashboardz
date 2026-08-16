/**
 * Alert-sounds module: the manifest fetch + in-browser audition that SoundMixer and its
 * theme/screen editors build on.
 *
 * `SOUND_EVENTS`/`EVENT_LABELS` are the canonical event list + copy — every consumer imports these
 * rather than re-listing the event names, so a new event only needs to change here. `activity`
 * (stream/table "chime on new entries") is the admin's own copy of the hub's fifth event — mirrors
 * the server-side list rather than importing it, same as the original four.
 */

export const SOUND_EVENTS = ['critical', 'warn', 'info', 'offline', 'activity'] as const

export const EVENT_LABELS: Record<string, string> = {
  critical: 'Critical alarm',
  warn: 'Warn chime',
  info: 'Info chime',
  offline: 'Offline beep',
  activity: 'Stream activity',
}

export interface SoundFamilies {
  [id: string]: { name: string }
}

/**
 * `/sounds/manifest.json` is a static file (not the `/admin/api` surface `api()` wraps), so this
 * fetches it directly. It degrades to a classic-only, rev-0 manifest on any failure (network error,
 * non-OK status, unparsable body, or a body that parses but isn't the expected shape) — never
 * throws, so a missing/broken manifest can't take the sound picker down with it; 'classic' always
 * works because it is the programmatic WebAudio family, not a file.
 *
 * The shape check lives here, not in each caller: a wrong-shaped response (e.g. a test's catch-all
 * `[]` stub for an unrelated endpoint, or a future manifest.json regression) would otherwise leave
 * `manifest.families` as `[].families` (undefined) and crash SoundMixer's `Object.entries(families)`
 * the moment a Sounds section renders — every consumer needs this guard, so it belongs on the one
 * function they all call rather than repeated (or, as Themes.tsx did, forgotten) at each call site.
 */
export async function fetchSoundManifest(): Promise<{ rev: number; families: SoundFamilies }> {
  const fallback = { rev: 0, families: { classic: { name: 'Classic beeps' } } }
  try {
    const res = await fetch('/sounds/manifest.json')
    if (!res.ok) return fallback
    const m = await res.json()
    if (m && typeof m === 'object' && m.families && typeof m.families === 'object' && !Array.isArray(m.families)) {
      return m
    }
    return fallback
  } catch {
    return fallback
  }
}

/**
 * Auditions one (family, event) pair in the browser. 'classic' carries no file — it replicates
 * device.js's `beep()` exactly (single oscillator tone, 880Hz, 0.4 gain, 0.25s) so auditioning
 * classic previews the real alarm sound rather than a stand-in. Every other family plays the actual
 * WAV the device would play, cache-busted by `rev` the same way device.js's `soundUrl` is.
 *
 * Never throws, in either branch: the WAV branch already swallows a rejected `.play()` (autoplay
 * policy, no audio device); the classic branch gets the same discipline wrapped in try/catch,
 * because environments with no `AudioContext` at all are real — jsdom (this project's own vitest
 * environment) is one, and 'classic' is the family every un-overridden event falls back to
 * whenever a caller's `suggestion` is null/unset, so it is the most likely branch under test.
 */
export function playPreview(family: string, event: string, rev: number): void {
  if (family === 'classic') {
    try {
      const AC = window.AudioContext || (window as any).webkitAudioContext
      if (!AC) return
      const ctx = new AC()
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.connect(gain)
      gain.connect(ctx.destination)
      osc.frequency.value = 880
      gain.gain.value = 0.4
      osc.start(ctx.currentTime)
      osc.stop(ctx.currentTime + 0.25)
    } catch {
      // No AudioContext, or it refused to construct/run (autoplay policy, no audio device) —
      // auditioning silently no-ops rather than throwing out of a click handler.
    }
    return
  }
  new Audio(`/sounds/${family}/${event}.wav?rev=${rev}`).play().catch(() => {})
}
