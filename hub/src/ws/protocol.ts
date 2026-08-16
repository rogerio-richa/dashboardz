import type { Severity, WireAlert } from '../db/alerts.js'

/**
 * A tab dot's wire value: an active-alert severity, or 'ok' — "this screen's feeds have senders
 * that could alert here, and none are". A screen with nothing alert-capable gets no entry at all
 * (green would be a claim nothing backs). Clients that predate 'ok' render the unknown dot class
 * invisibly, which degrades to the pre-'ok' look.
 */
export type TabDot = Severity | 'ok'
import type { Orientation } from '../db/screens.js'
import type { NavBars } from '../db/devices.js'
import type { FeedMode } from '../db/feeds.js'

export interface HelloMsg {
  type: 'HELLO'
  token: string
  // `viewport` is the box the board is drawn into, in CSS px. Optional: an older client
  // simply does not send it, and the stored value stays whatever it last reported.
  caps?: { kind?: string; app_version?: string; viewport?: { w?: number; h?: number; dpr?: number } }
}
export interface AckMsg { type: 'ACK'; id: string; stage: 'delivered' | 'displayed' }
/**
 * Layout-application receipt (STATE acknowledgment). Absent screen_id ⇔ null ⇔ default
 * layout — kept for old clients. `screen_ids` (screen state) is the set-based form a tab-aware client
 * sends instead: the full set of screen ids it is now rendering across its tabs. Optional so a
 * shipped Android build that only ever knew `screen_id` keeps acking exactly as it always has.
 */
export interface StateAckMsg { type: 'STATE_ACK'; rev: number; screen_id?: string | null; screen_ids?: string[] }
/** Client-local tab switch receipt (screen state) — devices report which tab is now on screen. */
export interface TabMsg { type: 'TAB'; screen_id: string }
export interface TapMsg { type: 'TAP'; id: string; action: 'silence' | 'dismiss' | 'answer'; option_id?: string }
export interface HealthMsg {
  type: 'HEALTH'
  battery?: number
  charging?: boolean
  /**
   * The board's box, when it has CHANGED since HELLO — a rotation, a window resize, system
   * bars appearing. Carried here rather than on a new message type because HEALTH already exists,
   * is already periodic, and is already the channel for "facts about this device right now".
   */
  viewport?: { w?: number; h?: number; dpr?: number }
}
export type ClientMsg = HelloMsg | AckMsg | StateAckMsg | TabMsg | TapMsg | HealthMsg

/**
 * `theme` is optional — a device that predates theming must ignore it under `ignoreUnknownKeys`
 * and render exactly as it does today. This is not style: a required field with no default is
 * the crash class that made a v6 hub drop an old APK's entire STATE (WireGrid.template's
 * MissingFieldException, swallowed by decodeServer into a dropped message — alerts, device name,
 * orientation, everything). NULL/absent `theme_id` means the built-in default, a first-class
 * state, not an error — so `theme` is simply omitted rather than sent as `null`.
 */
export interface WireScreen {
  id: string; name: string; orientation: Orientation; grid: unknown
  theme?: { id: string; rev: number }
  /**
   * theme ⊕ screen ⊕ classic (hub/src/sounds.ts resolveSounds), always all four events when
   * present. Optional for the same reason `theme` is: an app that predates alert sounds must
   * ignore this key under ignoreUnknownKeys and keep behaving exactly as it does today.
   */
  sounds?: Record<string, string>
  /** Manifest rev — a cache-buster for the family sound files, not tied to `theme.rev`. */
  sounds_rev?: number
}

/** A screen as it sits in a device's tab list (tab state). `label` is the operator-set tab name. */
export interface WireTabScreen extends WireScreen { label?: string }

export interface StateMsg {
  type: 'STATE'
  device: { id: string; name: string; orientation: Orientation; nav_bars: NavBars }
  rev: number
  screen?: WireScreen
  /**
   * Ordered tab list (tab state) — present iff the device has at least one renderable tab. Tolerance
   * discipline: an old client that predates tabs simply does not know this key and, under
   * ignoreUnknownKeys, keeps rendering `screen` forever. `screen` itself is still always populated
   * exactly as before (tab 0's wire) so that compat path never breaks — this is purely additive.
   */
  screens?: WireTabScreen[]
  /**
   * Per-screen worst active-alert severity (the screen's "dots") — present iff the device has at
   * least one renderable tab, same gate as `screens`. A value of 'ok' means monitored-and-quiet
   * (the screen's feeds have alert-capable senders, none alerting); an absent key means the
   * screen has nothing that could alert at all. Purely additive: a client that predates tab
   * status ignores the key, and one that predates 'ok' renders the unknown dot class invisibly.
   */
  tab_status?: Record<string, TabDot>
  server_time: number
  alerts: WireAlert[]
}
export interface AlertAddMsg { type: 'ALERT_ADD'; alert: WireAlert }
export interface AlertRemoveMsg {
  type: 'ALERT_REMOVE'; id: string
  reason: 'dismissed' | 'expired' | 'revoked' | 'sender_deleted' | 'resolved'
}
/** Broadcast re-derivation of the per-screen dots — sent to online multi-tab devices. */
export interface TabStatusMsg { type: 'TAB_STATUS'; tab_status: Record<string, TabDot> }

/** Transient audition push (alert-sound contract): play one sound once, quietly. No state, no ack, no dedup. */
export interface PlaySoundMsg { type: 'PLAY_SOUND'; family: string; event: string }

/**
 * Remote page reload: the device PAGE calls location.reload() on receipt.
 * Exists because a board page can hold stale JS for weeks — its own catalogue-staleness ladder
 * caps at 4 attempts per design id and then never retries, and the only other fix is a hand on
 * the physical glass. No payload, no ack: a page too old to know the type ignores it (the same
 * degradation every frame follows), and the Android shell forwards raw frames verbatim while its
 * own decoder null-skips unknown types.
 */
export interface ReloadMsg { type: 'RELOAD' }

/** Data widgets' wire form (data widgets design). No rev, never ACKed — see dataPush.ts. */
export interface WireFeedRow { payload: unknown; pushed_at: number }
export interface WireFeed {
  mode: FeedMode
  payload?: unknown
  rows?: WireFeedRow[]
  image_rev?: number
  pushed_at: number | null
  stale_after_s: number | null
}
export interface DataMsg {
  type: 'DATA'
  server_time: number
  /**
   * Present (true) only on a full reference-set snapshot; absent on a single-feed onFeedPush.
   * Deleting a feed while a device is connected must show "feed missing", not stale data
   * forever — but the reference set is grid-derived and untouched by a feed delete, and the
   * renderer's merge semantics can only add/update keys, never remove one. This marker tells the
   * renderer "replace your whole feed map with this" instead of "merge these keys in", which is
   * the only way a deletion can ever actually reach the screen.
   */
  snapshot?: true
  feeds: Record<string, WireFeed>
}

export type ServerMsg = StateMsg | AlertAddMsg | AlertRemoveMsg | DataMsg | TabStatusMsg | PlaySoundMsg | ReloadMsg
