import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { validateContractOutput } from '../src/data/contracts.js'
import { icalProvider } from '../src/sources/providers/ical.js'

const ICS = readFileSync(new URL('./fixtures/calendar-recurring.ics', import.meta.url), 'utf8')
const NOW = Date.parse('2026-08-05T12:00:00Z')
const context = (body: string, status = 200) => ({
  fetch: (async () => new Response(body, { status })) as typeof fetch,
  now: NOW,
  signal: new AbortController().signal,
})
const input = {
  config: { lookahead_days: 7, max_events: 10 },
  secrets: { url: 'https://calendar.example.test/private.ics' },
}

describe('iCalendar provider', () => {
  it('keeps the published calendar URL in the secret setup field', () => {
    expect(icalProvider.validateSetup(input.config, input.secrets)).toEqual({ ok: true, ...input })
    expect(icalProvider.validateSetup(input.config, {})).toMatchObject({ ok: false })
  })

  it('preserves timed recurrence and all-day calendar output behavior', async () => {
    const [output] = await icalProvider.run(input, context(ICS))

    expect(output.contract_id).toBe('dashboardz.calendar.events/v1')
    expect((output.result as any).payload.events).toEqual([
      { title: 'Standup', start: '2026-08-05T17:00:00.000Z', end: '2026-08-05T17:30:00.000Z', all_day: false, location: 'Kitchen' },
      { title: 'Standup', start: '2026-08-06T17:00:00.000Z', end: '2026-08-06T17:30:00.000Z', all_day: false, location: 'Kitchen' },
      { title: 'Holiday', start: '2026-08-07', end: '2026-08-08', all_day: true, location: null },
      { title: 'Standup', start: '2026-08-07T17:00:00.000Z', end: '2026-08-07T17:30:00.000Z', all_day: false, location: 'Kitchen' },
    ])
    expect(validateContractOutput(output.contract_id, output.result)).toMatchObject({ ok: true })
  })

  it('maps forbidden calendars to authentication_required without leaking the secret URL', async () => {
    const error = await icalProvider.run(input, context('private body', 403)).catch((caught) => caught)
    expect(error).toMatchObject({ code: 'authentication_required' })
    expect(error.message).not.toContain(input.secrets.url)
    expect(error.message).not.toContain('private body')
  })

  it('rejects oversized and malformed calendar responses', async () => {
    for (const body of ['x'.repeat(2 * 1024 * 1024 + 1), '<html>not a calendar</html>']) {
      await expect(icalProvider.run(input, context(body))).rejects.toMatchObject({ code: 'invalid_response' })
    }
  })
})
