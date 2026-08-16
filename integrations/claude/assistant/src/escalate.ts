import type { AskOption, Answer, Hub } from './hub.js'
import { HubError } from './hub.js'

export interface AskSpec {
  title: string; body?: string; devices?: string[]
  options: AskOption[]
  ttlS: number
  escalateAfterMin?: number
  dedupKey?: string
}
export interface AskResult { state: 'answered' | 'dismissed' | 'expired'; optionId?: string }
export interface EscalateDeps { pollMs?: number; sleep?: (ms: number) => Promise<void> }

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

function terminal(a: Answer): AskResult | null {
  if (a.state === 'answered') return { state: 'answered', optionId: a.option_id }
  if (a.state === 'dismissed' || a.state === 'expired') return { state: a.state }
  return null
}

export async function askWithEscalation(hub: Hub, ask: AskSpec, deps: EscalateDeps = {}): Promise<AskResult> {
  const pollMs = deps.pollMs ?? 15_000
  const sleep = deps.sleep ?? defaultSleep
  const key = ask.dedupKey ?? `ask-${Date.now()}`

  const base = await hub.notify({
    title: ask.title, body: ask.body, severity: 'warn', devices: ask.devices,
    ttl_s: ask.ttlS, dedup_key: key, options: ask.options,
  })

  const ids = [base.id]
  const escalateAtMs = ask.escalateAfterMin !== undefined ? ask.escalateAfterMin * 60_000 : null
  let deadline = ask.ttlS * 1000
  let escalated = false

  const cleanup = async () => {
    for (const k of [key, `${key}-esc`]) {
      try { await hub.resolve(k) } catch (e) { if (!(e instanceof HubError)) throw e }
    }
  }

  for (let elapsed = 0; ; elapsed += pollMs) {
    let expiredCount = 0
    for (const id of ids) {
      let a: Answer
      try {
        a = await hub.answer(id)
      } catch (e) {
        if (e instanceof HubError) {
          console.error(`askWithEscalation: answer(${id}) failed, treating as pending: ${e.message}`)
          continue
        }
        throw e
      }
      const t = terminal(a)
      if (t?.state === 'answered' || t?.state === 'dismissed') { await cleanup(); return t }
      if (t?.state === 'expired') expiredCount++
    }
    if (expiredCount === ids.length) { await cleanup(); return { state: 'expired' } }
    if (!escalated && escalateAtMs !== null && elapsed >= escalateAtMs) {
      escalated = true
      // NEW alert on purpose: chimes are once-per-alert-id, so an update
      // to the original could never make a second sound.
      const esc = await hub.notify({
        title: `Still waiting: ${ask.title}`, body: ask.body, severity: 'warn',
        devices: ask.devices, sound: true, ttl_s: ask.ttlS, dedup_key: `${key}-esc`,
        options: ask.options,
      })
      ids.push(esc.id)
      // Extend deadline to cover the escalated alert's full lifetime
      deadline = escalateAtMs + ask.ttlS * 1000
    }
    if (elapsed >= deadline) { await cleanup(); return { state: 'expired' } }
    await sleep(pollMs)
  }
}
