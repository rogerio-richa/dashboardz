import { parseIcalEvents } from './icalEvents.js'
import { SourceError, fetchProvider, readCappedText } from '../errors.js'
import {
  asRecord, defineProvider, setupHttpUrl, setupInt, validateProducedOutputs,
  type ProviderDefinition, type ProviderRunInput,
} from '../provider.js'

const MAX_TEXT_BYTES = 2 * 1024 * 1024

function checkedSetup(input: ProviderRunInput) {
  const checked = icalProvider.validateSetup(input.config, input.secrets)
  if (!checked.ok) throw new SourceError('invalid_response', checked.error)
  return checked
}

async function runIcal(input: ProviderRunInput, ctx: Parameters<ProviderDefinition['run']>[1]) {
  const checked = checkedSetup(input)
  const response = await fetchProvider(checked.secrets.url, ctx)
  const text = await readCappedText(response, MAX_TEXT_BYTES)
  let events
  try {
    events = parseIcalEvents(text, {
      now: ctx.now,
      lookahead_days: checked.config.lookahead_days,
      max_events: checked.config.max_events,
    })
  } catch {
    throw new SourceError('invalid_response', 'The provider did not return a readable iCalendar')
  }
  return validateProducedOutputs([{
    contract_id: 'dashboardz.calendar.events/v1',
    result: { mode: 'value', payload: { events } },
  }])
}

export const icalProvider: ProviderDefinition = defineProvider({
  id: 'dashboardz.ical',
  package_id: 'dashboardz.builtin',
  package_version: '1.0.0',
  strategy: 'scheduled',
  label: 'iCalendar',
  category: 'calendar',
  recommended: false,
  default_interval_s: 300,
  min_interval_s: 60,
  /*
   * What a published ICS can always give: a title, a start/end pair and an all-day flag — the
   * contract validator refuses anything without them. `location` is not declared, because it is
   * a per-event field most events in a real calendar leave empty; a run that happens to contain
   * one reports it from the payload, which is how a chooser learns this source can supply them
   * without this descriptor promising something a quiet week cannot deliver.
   */
  potential_outputs: [{
    contract_id: 'dashboardz.calendar.events/v1',
    capabilities: ['calendar.event.all_day', 'calendar.event.times', 'calendar.event.title'],
  }],
  setup: [
    { name: 'url', label: 'Calendar URL', type: 'url', required: true, secret: true },
    { name: 'lookahead_days', label: 'Look-ahead days', type: 'number', required: true, secret: false, min: 1, max: 60 },
    { name: 'max_events', label: 'Maximum events', type: 'number', required: true, secret: false, min: 1, max: 50 },
  ],
  validateSetup(config, secrets) {
    const rawConfig = asRecord(config)
    const rawSecrets = asRecord(secrets)
    if (rawConfig === null || rawSecrets === null) return { ok: false, error: 'iCalendar setup must be an object' }
    const url = setupHttpUrl(rawSecrets.url)
    if (url === null) return { ok: false, error: 'iCalendar needs an http(s) URL' }
    return {
      ok: true,
      config: {
        lookahead_days: setupInt(rawConfig.lookahead_days, 7, 1, 60),
        max_events: setupInt(rawConfig.max_events, 10, 1, 50),
      },
      secrets: { url },
    }
  },
  run: runIcal,
})
