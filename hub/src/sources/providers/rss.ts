import { parseRssItems } from './rssItems.js'
import { SourceError, fetchProvider, readCappedText } from '../errors.js'
import {
  asRecord, defineProvider, setupHttpUrl, setupInt, validateProducedOutputs,
  type ProviderDefinition, type ProviderRunInput,
} from '../provider.js'

const MAX_TEXT_BYTES = 2 * 1024 * 1024

function checkedSetup(input: ProviderRunInput) {
  const checked = rssProvider.validateSetup(input.config, input.secrets)
  if (!checked.ok) throw new SourceError('invalid_response', checked.error)
  return checked
}

async function runRss(input: ProviderRunInput, ctx: Parameters<ProviderDefinition['run']>[1]) {
  const checked = checkedSetup(input)
  const response = await fetchProvider(checked.secrets.url, ctx)
  const text = await readCappedText(response, MAX_TEXT_BYTES)
  let parsed: Record<string, unknown>[]
  try {
    parsed = parseRssItems(text)
  } catch {
    throw new SourceError('invalid_response', 'The provider did not return a readable RSS or Atom feed')
  }

  const seen = new Set<string>()
  const newestFirst: Record<string, unknown>[] = []
  for (const row of parsed) {
    const id = typeof row.link === 'string' && row.link.trim() !== '' ? row.link : null
    if (id === null || seen.has(id)) continue
    seen.add(id)
    const canonical: Record<string, unknown> = {
      id,
      title: typeof row.title === 'string' && row.title.trim() !== '' ? row.title : '(untitled)',
      url: id,
      link: id,
    }
    if (typeof row.summary === 'string' && row.summary !== '') canonical.summary = row.summary
    if (typeof row.published_at === 'number' && Number.isFinite(row.published_at)) {
      canonical.published_at = row.published_at
    }
    newestFirst.push(canonical)
  }
  const rows = newestFirst.slice(0, Number(checked.config.max_items)).reverse()
  return validateProducedOutputs([{
    contract_id: 'dashboardz.news.items/v1',
    result: { mode: 'stream', rows, dedupe_by: 'id' },
  }])
}

export const rssProvider: ProviderDefinition = defineProvider({
  id: 'dashboardz.rss',
  package_id: 'dashboardz.builtin',
  package_version: '1.0.0',
  strategy: 'scheduled',
  label: 'RSS / Atom',
  category: 'news',
  recommended: true,
  default_interval_s: 900,
  min_interval_s: 300,
  potential_outputs: [{
    contract_id: 'dashboardz.news.items/v1',
    capabilities: [
      'news.item.id', 'news.item.published_at', 'news.item.summary', 'news.item.title', 'news.item.url',
    ],
  }],
  setup: [
    { name: 'url', label: 'Feed URL', type: 'url', required: true, secret: true },
    { name: 'max_items', label: 'Maximum items', type: 'number', required: true, secret: false, min: 1, max: 100 },
  ],
  validateSetup(config, secrets) {
    const rawConfig = asRecord(config)
    const rawSecrets = asRecord(secrets)
    if (rawConfig === null || rawSecrets === null) return { ok: false, error: 'RSS setup must be an object' }
    const url = setupHttpUrl(rawSecrets.url)
    if (url === null) return { ok: false, error: 'RSS needs an http(s) feed URL' }
    return {
      ok: true,
      config: { max_items: setupInt(rawConfig.max_items, 20, 1, 100) },
      secrets: { url },
    }
  },
  run: runRss,
})
