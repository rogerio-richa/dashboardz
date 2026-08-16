export type ContractId =
  | 'dashboardz.weather.current/v1'
  | 'dashboardz.weather.daily-forecast/v1'
  | 'dashboardz.news.items/v1'
  | 'dashboardz.calendar.events/v1'
  | 'dashboardz.legacy.value/v1'
  | 'dashboardz.legacy.stream/v1'
  | 'dashboardz.legacy.image/v1'

export interface SetupFieldView {
  name: string
  label: string
  type: 'text' | 'number' | 'url' | 'select'
  required: boolean
  secret: boolean
  min?: number
  max?: number
  options?: { value: string; label: string }[]
}

export interface ProviderOutputView {
  contract_id: ContractId
  capabilities: string[]
}

export interface CompatibleProviderOutputView extends ProviderOutputView {
  missing_optional: string[]
}

export interface ProviderChoiceView {
  id: string
  label: string
  recommended: boolean
  default_interval_s: number
  min_interval_s: number
  setup: SetupFieldView[]
  outputs: ProviderOutputView[]
  compatible_outputs: CompatibleProviderOutputView[]
  recommendation: string
  account: string
  attribution: string
}

export interface ExistingSourceChoiceView {
  source_id: string
  source_name: string
  provider_id: string
  provider: string
  output_id: string
  feed_id: string
  contract_id: ContractId
  capabilities: string[]
  missing_optional: string[]
  last_success_at: number | null
}

export interface SourceChoicesView {
  widget: string
  title: string
  description: string
  existing: ExistingSourceChoiceView[]
  providers: ProviderChoiceView[]
}

export type WirePreview =
  | { mode: 'value'; payload: unknown; pushed_at: number | null; stale_after_s: number | null }
  | {
    mode: 'stream'
    rows: { payload: unknown; pushed_at: number }[]
    pushed_at: number | null
    stale_after_s: number | null
  }

export interface DraftOutputView {
  contract_id: ContractId
  capabilities: string[]
  missing_optional: string[]
  preview: WirePreview
}

export interface SourceDraftView {
  id: string
  provider_id: string
  provider: string
  name: string
  expires_at: number
  outputs: DraftOutputView[]
}

export interface FeedDetailView {
  id: string
  name: string
  mode: 'value' | 'stream' | 'image'
  payload: unknown
  rows: { payload: unknown; pushed_at: number }[]
}

export interface GeocodePlaceView {
  name: string
  region: string
  country: string
  lat: number
  lon: number
}

export type ExistingSourceBinding = { feed: string }
export type DraftSourceBinding = { source_draft_id: string; output_contract: ContractId }
export type SourceSetupBinding = ExistingSourceBinding | DraftSourceBinding

/** The screen editor stores the binding and safe preview separately until its own save boundary. */
export interface SourceSetupResult {
  binding: SourceSetupBinding
  preview: unknown
  connection: { name: string; provider: string }
  missing_optional: string[]
}
