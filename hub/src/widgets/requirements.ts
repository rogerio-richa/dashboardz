import type { ContractId } from '../data/contracts.js'
import {
  acceptableCapabilities, needAppliesTo, widgetNeeds, type NeedMode, type WidgetNeed,
} from '../data/needs.js'

export interface WidgetRequirement {
  contract_id: ContractId
  required_capabilities: readonly string[]
  optional_capabilities: readonly string[]
}

export type Compatibility =
  | { ok: true; missing_optional: string[] }
  | { ok: false; error: string }

const freeze = <T>(value: T): Readonly<T> => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) freeze(child)
    Object.freeze(value)
  }
  return value
}

/** Only semantic widgets belong here; generic widgets keep their existing feed-mode bindings. */
export const WIDGET_REQUIREMENTS = freeze({
  weather_forecast: {
    contract_id: 'dashboardz.weather.daily-forecast/v1',
    required_capabilities: [
      'weather.daily.condition',
      'weather.daily.date',
      'weather.daily.entries.5',
      'weather.daily.temperature.high',
      'weather.daily.temperature.low',
    ],
    optional_capabilities: [
      'attribution',
      'weather.current',
      'weather.daily.humidity',
      'weather.daily.pollen',
      'weather.daily.precipitation_probability',
      'weather.daily.wind',
    ],
  },
  news_list: {
    contract_id: 'dashboardz.news.items/v1',
    required_capabilities: ['news.item.id', 'news.item.title'],
    optional_capabilities: [
      'attribution',
      'news.item.published_at',
      'news.item.source',
      'news.item.summary',
      'news.item.url',
    ],
  },
  /**
   * A calendar asks for very little, on purpose: a title and a time. There is no minimum number of
   * events, because an empty week is a legitimate answer that the widget renders as "Nothing on" —
   * requiring entries would make a quiet calendar look like a broken source.
   */
  calendar_events: {
    contract_id: 'dashboardz.calendar.events/v1',
    required_capabilities: ['calendar.event.times', 'calendar.event.title'],
    optional_capabilities: ['calendar.event.all_day', 'calendar.event.location'],
  },
} satisfies Record<string, WidgetRequirement>)

export function widgetRequirement(widget: string): WidgetRequirement | undefined {
  return Object.hasOwn(WIDGET_REQUIREMENTS, widget)
    ? WIDGET_REQUIREMENTS[widget as keyof typeof WIDGET_REQUIREMENTS]
    : undefined
}

const incompatible = (error: string): Compatibility => ({ ok: false, error })

export function compatibleOutput(
  widget: string,
  contractId: string,
  capabilities: readonly string[],
  config?: Record<string, unknown>,
): Compatibility {
  try {
    const requirement = widgetRequirement(widget)
    if (!requirement) return incompatible(`unknown semantic widget ${widget}`)
    if (contractId !== requirement.contract_id) return incompatible(`${widget} requires ${requirement.contract_id}`)
    const available = new Set(capabilities)
    const required = [...requirement.required_capabilities]
    if (widget === 'weather_forecast' && config && Object.hasOwn(config, 'days')) {
      const days = config.days
      if (typeof days !== 'number' || !Number.isInteger(days) || days < 5 || days > 7) {
        return incompatible('weather_forecast.config.days must be an integer between 5 and 7')
      }
      required.push(`weather.daily.entries.${days}`)
    }
    const missing = [...new Set(required)].sort().find((capability) => !available.has(capability))
    if (missing) return incompatible(`${widget} is missing ${missing}`)
    return {
      ok: true,
      missing_optional: requirement.optional_capabilities.filter((capability) => !available.has(capability)),
    }
  } catch {
    return incompatible(`unknown semantic widget ${widget}`)
  }
}

/**
 * A config key naming a path, in the two forms `path_from` takes: a plain key read off the config
 * (`'path'`), or `'<list>[].<key>'` meaning that key on every element of that list. The list form
 * is why this returns an ARRAY — a table has one path per column and a chart one per series, and
 * checking only the first is the bug the "every column"/"every series" tests exist to catch.
 *
 * A key that is absent or not a string yields nothing rather than an error: `title_path` and
 * `body_path` are genuinely optional on stream_list, and an unconfigured path is not a mismatch.
 */
function pathsFromConfig(config: Record<string, unknown>, pathFrom: string): string[] {
  const list = pathFrom.match(/^(\w+)\[\]\.(\w+)$/)
  if (!list) {
    const value = config[pathFrom]
    return typeof value === 'string' && value !== '' ? [value] : []
  }
  const items = config[list[1]!]
  if (!Array.isArray(items)) return []
  return items.flatMap((item) => {
    const value = (item as Record<string, unknown> | null)?.[list[2]!]
    return typeof value === 'string' && value !== '' ? [value] : []
  })
}

/** Every concrete capability this need demands of a feed, given the paths this cell configured. */
function requiredForNeed(need: WidgetNeed, config: Record<string, unknown>): string[][] {
  if (need.path_from === undefined) return []
  const paths = pathsFromConfig(config, need.path_from)
  if (need.scope !== 'collection') return paths.map((path) => acceptableCapabilities(need.type, path))
  // A collection path means nothing without the array it is relative to: `columns[].path` of `a`
  // is `rows[].a` only because `config.path` is `rows`. With no array path configured there is no
  // capability to name, so there is nothing to check rather than something to reject.
  const [prefix] = pathsFromConfig(config, need.collection_from ?? '')
  if (prefix === undefined) return []
  return paths.map((path) => acceptableCapabilities(need.type, `${prefix}[].${path}`))
}

/**
 * Does this feed carry the right TYPE at the paths this cell configured?
 *
 * A sibling of `compatibleOutput`, not a branch inside it. That one answers "does this source's
 * contract match the widget's contract" — contract id plus capability names, `config` almost
 * irrelevant. This one answers a different question with different inputs: `config` is the whole
 * subject (it holds the paths), and `contract_id` does not appear. A shared body would be two
 * functions wearing one name.
 *
 * AN EMPTY CAPABILITY LIST IS INCONCLUSIVE, AND RETURNS OK. A hand-pushed sender declares nothing
 * — that is the one-line curl path, and it stays one line — so capabilities for a generic feed are
 * INFERRED from data it already carries. A feed that has never been pushed has nothing to infer
 * from, and treating that silence as incompatibility would warn on every legacy board on every
 * save. Absence of evidence is not evidence of absence.
 *
 * `mode` is the mode of the feed actually being bound, and it selects which needs apply. Only
 * `table` conditions on it, but it has to be a parameter rather than a lookup because the same
 * widget takes both a value and a stream feed and reads them differently.
 */
export function compatibleGeneric(
  widget: string,
  config: Record<string, unknown>,
  capabilities: readonly string[],
  mode: NeedMode,
): Compatibility {
  if (capabilities.length === 0) return { ok: true, missing_optional: [] }
  const available = new Set(capabilities)
  for (const need of widgetNeeds(widget).filter((candidate) => needAppliesTo(candidate, mode))) {
    for (const alternatives of requiredForNeed(need, config)) {
      if (alternatives.some((capability) => available.has(capability))) continue
      return incompatible(`${widget} needs ${alternatives[0]}`)
    }
  }
  return { ok: true, missing_optional: [] }
}
