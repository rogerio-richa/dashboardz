// Generates hub/static/sounds/<family>/<event>.wav. Node 22, no deps. Deterministic: re-running
// produces identical bytes, so a diff means the recipe changed and manifest.json rev must bump.
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const RATE = 22050
const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'static', 'sounds')

function wav(samples) {
  const data = Buffer.alloc(samples.length * 2)
  samples.forEach((s, i) => data.writeInt16LE(Math.max(-1, Math.min(1, s)) * 32767 | 0, i * 2))
  const h = Buffer.alloc(44)
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVEfmt ', 8)
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22)
  h.writeUInt32LE(RATE, 24); h.writeUInt32LE(RATE * 2, 28); h.writeUInt16LE(2, 32)
  h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(data.length, 40)
  return Buffer.concat([h, data])
}
const sine = (f, t) => Math.sin(2 * Math.PI * f * t)
const square = (f, t) => (Math.sin(2 * Math.PI * f * t) >= 0 ? 1 : -1)
/** notes: [{freq, ms, at, gain, shape, decay}] rendered into one buffer of totalMs. */
function render(totalMs, notes) {
  const out = new Array(Math.floor(RATE * totalMs / 1000)).fill(0)
  for (const n of notes) {
    const start = Math.floor(RATE * (n.at ?? 0) / 1000), len = Math.floor(RATE * n.ms / 1000)
    const osc = n.shape === 'square' ? square : sine
    for (let i = 0; i < len && start + i < out.length; i++) {
      const t = i / RATE
      const env = Math.min(1, i / (RATE * 0.005)) * Math.exp(-(n.decay ?? 0) * t)  // 5ms attack, exp decay
      out[start + i] += osc(n.freq, t) * (n.gain ?? 0.6) * env
    }
  }
  return out
}
const FAMILIES = {
  bells: {  // struck-bell: fundamental + inharmonic partial, long decay
    critical: render(700, [{ freq: 660, ms: 700, gain: 0.55, decay: 4 }, { freq: 1568, ms: 500, gain: 0.25, decay: 7 },
                           { freq: 880, ms: 500, at: 180, gain: 0.5, decay: 4 }]),
    warn:     render(600, [{ freq: 784, ms: 600, gain: 0.5, decay: 5 }, { freq: 1976, ms: 350, gain: 0.2, decay: 9 }]),
    info:     render(450, [{ freq: 1047, ms: 450, gain: 0.4, decay: 7 }]),
    offline:  render(500, [{ freq: 523, ms: 250, gain: 0.45, decay: 6 }, { freq: 392, ms: 250, at: 220, gain: 0.45, decay: 6 }]),
    // activity: the ambient tick — deliberately the quietest sound in each family.
    activity: render(220, [{ freq: 1568, ms: 220, gain: 0.22, decay: 14 }]),
  },
  '8bit': {  // square-wave blips
    critical: render(600, [{ freq: 988, ms: 120, shape: 'square', gain: 0.4 }, { freq: 1319, ms: 120, at: 150, shape: 'square', gain: 0.4 },
                           { freq: 988, ms: 120, at: 300, shape: 'square', gain: 0.4 }, { freq: 1319, ms: 180, at: 450, shape: 'square', gain: 0.4 }]),
    warn:     render(300, [{ freq: 880, ms: 90, shape: 'square', gain: 0.4 }, { freq: 1109, ms: 140, at: 120, shape: 'square', gain: 0.4 }]),
    info:     render(160, [{ freq: 1319, ms: 120, shape: 'square', gain: 0.3, decay: 8 }]),
    offline:  render(300, [{ freq: 440, ms: 100, shape: 'square', gain: 0.4 }, { freq: 330, ms: 150, at: 130, shape: 'square', gain: 0.4 }]),
    // activity: the ambient tick — deliberately the quietest sound in each family.
    activity: render(90, [{ freq: 1047, ms: 70, shape: 'square', gain: 0.18, decay: 10 }]),
  },
}
for (const [family, events] of Object.entries(FAMILIES)) {
  mkdirSync(join(OUT, family), { recursive: true })
  for (const [event, samples] of Object.entries(events)) {
    writeFileSync(join(OUT, family, `${event}.wav`), wav(samples))
    console.log(`${family}/${event}.wav`)
  }
}
