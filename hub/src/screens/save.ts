import { CONTRACTS, type ContractId } from '../data/contracts.js'
import { capabilitiesForFeed, capabilitiesForResult } from '../data/feedCapabilities.js'
import { audit, type AdminActor } from '../db/audit.js'
import { getFeed, type FeedMode } from '../db/feeds.js'
import type { DB } from '../db/index.js'
import { getScreen, createScreen, updateScreen, type Orientation, type ScreenRow } from '../db/screens.js'
import { getDraft, type SourceDraft } from '../db/sourceDrafts.js'
import { listOutputs } from '../db/sources.js'
import { getTheme } from '../db/themes.js'
import { materializeSourceDraft, type PromotedDraft } from '../sources/drafts.js'
import { compatibleGeneric, compatibleOutput, widgetRequirement } from '../widgets/requirements.js'
import { RECT_QUANTUM } from './cellSchema.js'

export const WIDGET_FEED_MODES: Readonly<Record<string, readonly FeedMode[]>> = Object.freeze({
  clock: [],
  alert_feed: [],
  value_tile: ['value', 'stream'],
  gauge: ['value', 'stream'],
  stream_list: ['stream'],
  table: ['value', 'stream'],
  text_block: ['value', 'stream'],
  chart: ['stream'],
  image: ['image'],
})

export interface ScreenRect {
  x: number
  y: number
  w: number
  h: number
}

export interface ScreenGridCell {
  widget: string
  config: Record<string, unknown>
  rect: ScreenRect
}

/**
 * Where this screen expects the device's tab bar, when the screen is shown as one tab of many
 * (tabs). A layout concern, so it lives in the layout document: the editor reserves the
 * declared edge while the operator designs, and the renderer places the bar there. 'hidden'
 * means "this screen uses every pixel" — legal on its own, but such a screen cannot join a
 * multi-tab list (switching is touch-only; a bar-less tab would strand the viewer). Absent =
 * 'bottom', which is exactly the pre-declaration behavior.
 */
export type TabBarPosition = 'bottom' | 'top' | 'left' | 'right' | 'hidden'

export interface ScreenGrid {
  cells: ScreenGridCell[]
  tab_bar?: TabBarPosition
}

export interface SaveScreenInput {
  id?: string
  name: string
  orientation: Orientation
  grid: ScreenGrid
  theme_id?: string | null
  /**
   * Sparse event->family OVERRIDE map (screen state, alert-sound contract). Threaded straight through to
   * `createScreen`/`updateScreen` exactly like `theme_id` above — undefined leaves it alone
   * (unset on create defaults to `{}`, i.e. "follow the theme"), `{}` clears an existing override.
   * The admin PATCH handler validates families against the live sound manifest before this ever
   * runs; this service layer does no sounds validation of its own, same division of labour as
   * `theme_id` (existence checked one line above `createScreen`'s call, not in here).
   */
  sounds?: Record<string, string>
  expected_rev?: number
  audit_fields?: string[]
  /** Who is saving, for audit attribution; absent means a pre-agents caller — a human admin. */
  actor?: AdminActor
}

export interface SaveScreenResult {
  screen: ScreenRow
  promoted_source_ids: string[]
  promoted_feed_ids: string[]
  changed_feed_ids: string[]
  /** Advisory only — see `collectWarnings`. A save with warnings has still been written. */
  warnings: string[]
}

type SaveErrorCode =
  | 'invalid'
  | 'not_found'
  | 'expired'
  | 'conflict'
  | 'name_conflict'
  | 'failed'

/** Expected save failures cross the transaction boundary without leaking their cause. */
export class ScreenSaveError extends Error {
  constructor(
    public readonly code: SaveErrorCode,
    message: string,
    public readonly statusCode: 400 | 404 | 409 | 410 | 500,
    public readonly rev?: number,
  ) {
    super(message)
    this.name = 'ScreenSaveError'
  }
}

function invalid(message: string): never {
  throw new ScreenSaveError('invalid', message, 400)
}
const has = (value: Record<string, unknown>, key: string): boolean => Object.hasOwn(value, key)
const k = (value: number): number => Math.round(value * 1000)

function validateRectangles(grid: ScreenGrid): void {
  if (!grid || !Array.isArray(grid.cells) || grid.cells.length < 1 || grid.cells.length > 12) {
    invalid('screen grid is invalid')
  }
  for (const [index, cell] of grid.cells.entries()) {
    const rect = cell?.rect
    if (!rect || typeof rect !== 'object') invalid(`card ${index + 1} rectangle is invalid`)
    for (const [name, value] of Object.entries(rect)) {
      if (typeof value !== 'number' || !Number.isFinite(value)) invalid(`card ${index + 1} ${name} is invalid`)
      if (Math.abs(value / RECT_QUANTUM - Math.round(value / RECT_QUANTUM)) > 1e-6) {
        invalid(`card ${index + 1} ${name} must be a multiple of ${RECT_QUANTUM}`)
      }
    }
    if (k(rect.x) + k(rect.w) > 1000) invalid(`card ${index + 1} extends past the right edge`)
    if (k(rect.y) + k(rect.h) > 1000) invalid(`card ${index + 1} extends past the bottom edge`)
  }
  for (let left = 0; left < grid.cells.length; left++) {
    for (let right = left + 1; right < grid.cells.length; right++) {
      const a = grid.cells[left]!.rect
      const b = grid.cells[right]!.rect
      if (k(a.x) < k(b.x) + k(b.w) && k(b.x) < k(a.x) + k(a.w) &&
        k(a.y) < k(b.y) + k(b.h) && k(b.y) < k(a.y) + k(a.h)) {
        invalid(`cards ${left + 1} and ${right + 1} overlap`)
      }
    }
  }
}

function modeRejection(widget: string, mode: FeedMode): string {
  if (widget === 'image') return 'image widget needs an image feed'
  if (mode === 'image') return 'image feeds are not bindable'
  return `${widget} needs a stream feed`
}

/**
 * The semantic output (contract id + capabilities) a feed was produced by, if any — a feed with no
 * source owner (a manually-pushed one) has none. Exported for feed-fit, which must apply the same
 * rule the save path does when it decides whether a feed can satisfy a semantic widget.
 */
export function outputForFeed(db: DB, feedId: string) {
  const owner = db.prepare('SELECT source_id FROM source_outputs WHERE feed_id = ?')
    .get(feedId) as { source_id: string | null } | undefined
  if (!owner) return undefined
  return listOutputs(db, owner.source_id).find((output) => output.feed_id === feedId)
}

function validatePersistentBinding(db: DB, cell: ScreenGridCell): void {
  const feedId = cell.config.feed
  if (typeof feedId !== 'string') invalid(`${cell.widget} needs a feed binding`)
  const feed = getFeed(db, feedId)
  if (!feed) invalid(`unknown feed "${feedId}"`)
  const requirement = widgetRequirement(cell.widget)
  if (requirement) {
    const output = outputForFeed(db, feedId)
    if (!output) invalid(`${cell.widget} requires a semantic source output`)
    const compatibility = compatibleOutput(cell.widget, output.contract_id, output.capabilities, cell.config)
    if (!compatibility.ok) invalid(compatibility.error)
    return
  }

  const modes = WIDGET_FEED_MODES[cell.widget] ?? []
  if (!modes.includes(feed.mode)) invalid(modeRejection(cell.widget, feed.mode))
  if (cell.widget === 'table' && feed.mode !== 'stream' && !cell.config.path) {
    invalid('table on a value feed needs a path to an array')
  }
  if (cell.widget === 'gauge') {
    // Each side resolved through the SAME fallback `normalizeGauge` (static/device/widgets/gauge/
    // shared.mjs) applies — `min` 0, `max` 100 — because the grid schema no longer requires either.
    // A gauge that omits both is the documented default range and saves; a HALF-specified one is
    // still checked against the range it will actually render with, so `{ min: 200 }` with no `max`
    // is refused here rather than drawing a permanently-empty track on a wall.
    const min = typeof cell.config.min === 'number' ? cell.config.min : 0
    const max = typeof cell.config.max === 'number' ? cell.config.max : 100
    if (!(min < max)) invalid('gauge min must be < max')
  }
}

interface PendingBinding {
  cellIndex: number
  /** Present only for chart, whose binding is per series rather than per cell. */
  seriesIndex?: number
  draftId: string
  contractId: ContractId
}

interface ValidatedGrid {
  pending: PendingBinding[]
  drafts: Map<string, SourceDraft>
}

/** Resolves a draft once per save and holds it to the shape promotion will demand of it later. */
function draftFor(db: DB, drafts: Map<string, SourceDraft>, draftId: string, now: number): SourceDraft {
  const cached = drafts.get(draftId)
  if (cached) return cached
  const draft = getDraft(db, draftId)
  if (!draft) throw new ScreenSaveError('not_found', 'source draft was not found', 404)
  if (draft.expires_at <= now) throw new ScreenSaveError('expired', 'source draft expired', 410)
  validateDraftShape(draft)
  drafts.set(draftId, draft)
  return draft
}

/**
 * A promise the operator is making right now, checked the way the equivalent stored binding is.
 *
 * The warn-not-block rule covers a LIVE feed whose capabilities we merely inferred after the
 * fact — boards that already work must keep saving. It does not cover this: nothing has been built
 * yet, the operator is choosing the source in this request, and a pending binding the draft cannot
 * satisfy would promote a source and then render nothing.
 */
function checkPendingBinding(
  db: DB, drafts: Map<string, SourceDraft>, now: number,
  widget: string, config: Record<string, unknown>, binding: Record<string, unknown>,
): ContractId {
  if (typeof binding.source_draft_id !== 'string' || typeof binding.output_contract !== 'string' ||
    !Object.hasOwn(CONTRACTS, binding.output_contract)) {
    invalid(`${widget} needs exactly one source binding`)
  }
  const contractId = binding.output_contract as ContractId
  const draft = draftFor(db, drafts, binding.source_draft_id, now)
  const output = draft.outputs.find((candidate) => candidate.contract_id === contractId)
  if (!output) invalid('source draft does not provide the requested output')

  // No mode gate here on purpose. A pending cell is rewritten to its promoted feed id and run
  // through `validateGrid` a second time before the transaction commits, and THAT pass applies
  // `WIDGET_FEED_MODES` to the real feed — so a stream_list promised a value-mode contract is
  // already refused, and the whole promotion rolls back with it. Re-checking the contract's mode
  // here would be a second copy of a rule that has one home, and a mutation proved no test could
  // tell the two apart.
  const mode = CONTRACTS[contractId].mode
  const requirement = widgetRequirement(widget)
  const compatibility = requirement
    ? compatibleOutput(widget, output.contract_id, output.capabilities, config)
    : compatibleGeneric(widget, config, capabilitiesForResult(output.result), mode)
  if (!compatibility.ok) invalid(compatibility.error)
  return contractId
}

/**
 * Chart validates per series, because that is where a chart binds. A series is either a stored
 * feed or a pending promise, and the two may be mixed in one cell.
 */
function validateChart(
  db: DB, cell: ScreenGridCell, cellIndex: number,
  drafts: Map<string, SourceDraft>, pending: PendingBinding[], now: number, allowPending: boolean,
): void {
  const series = Array.isArray(cell.config.series) ? cell.config.series : []
  const icons = new Set<string>()
  for (const [seriesIndex, candidate] of series.entries()) {
    const item = candidate as Record<string, unknown> | null
    if (item && typeof item.icon === 'string') {
      if (icons.has(item.icon)) invalid('chart series icons must be unique')
      icons.add(item.icon)
    }
    if (!item) continue
    if (typeof item.feed === 'string') {
      const feed = getFeed(db, item.feed)
      if (!feed) invalid(`unknown feed "${item.feed}"`)
      if (feed.mode !== 'stream') invalid('chart needs stream feeds')
      continue
    }
    if (!has(item, 'source_draft_id')) continue
    if (!allowPending) invalid('chart needs stream feeds')
    // The series' own y_path is what this draft has to satisfy, so the matcher sees a config
    // holding just this series rather than all four — otherwise one draft would be asked for
    // every other series' paths too, and a chart mixing a new source with existing feeds could
    // never save.
    const contractId = checkPendingBinding(db, drafts, now, 'chart', { series: [item] }, item)
    pending.push({ cellIndex, seriesIndex, draftId: item.source_draft_id as string, contractId })
  }
}

function validateDraftShape(draft: SourceDraft): void {
  if (draft.outputs.length === 0 || draft.outputs.some((output) =>
    output.result.mode === 'invalid' || !Object.hasOwn(CONTRACTS, output.contract_id) ||
    CONTRACTS[output.contract_id as ContractId].mode !== output.mode)) {
    throw new ScreenSaveError('conflict', 'source draft is invalid', 409)
  }
}

function validateGrid(db: DB, grid: ScreenGrid, now: number, allowPending: boolean): ValidatedGrid {
  validateRectangles(grid)
  const pending: PendingBinding[] = []
  const drafts = new Map<string, SourceDraft>()
  for (const [cellIndex, cell] of grid.cells.entries()) {
    if (!cell || typeof cell !== 'object' || typeof cell.widget !== 'string' ||
      !cell.config || typeof cell.config !== 'object' || Array.isArray(cell.config)) {
      invalid(`card ${cellIndex + 1} is invalid`)
    }
    if (cell.widget === 'chart') {
      validateChart(db, cell, cellIndex, drafts, pending, now, allowPending)
      continue
    }

    const hasDraftId = has(cell.config, 'source_draft_id')
    const hasContract = has(cell.config, 'output_contract')
    const hasFeed = has(cell.config, 'feed')
    if (hasFeed && !hasDraftId && !hasContract) {
      validatePersistentBinding(db, cell)
      continue
    }
    if (!hasDraftId && !hasContract) {
      // No binding of either kind. A semantic widget has no other way to get data and is a
      // mistake; a generic one may legitimately bind nothing (a clock, a literal text_block).
      if (widgetRequirement(cell.widget)) invalid(`${cell.widget} needs exactly one source binding`)
      continue
    }
    if (!allowPending || hasFeed || !hasDraftId || !hasContract) {
      invalid(`${cell.widget} needs exactly one source binding`)
    }
    const contractId = checkPendingBinding(db, drafts, now, cell.widget, cell.config, cell.config)
    pending.push({ cellIndex, draftId: cell.config.source_draft_id as string, contractId })
  }
  return { pending, drafts }
}

/** The feed a promoted draft produced for this binding's contract, or the save is inconsistent. */
function promotedFeedId(binding: PendingBinding, promoted: ReadonlyMap<string, PromotedDraft>): string {
  const output = promoted.get(binding.draftId)?.outputs
    .find((candidate) => candidate.contract_id === binding.contractId)
  if (!output) throw new ScreenSaveError('conflict', 'source draft is invalid', 409)
  return output.feed_id
}

/** Replaces a promise with the feed it became, leaving no trace of the draft in stored config. */
function boundConfig(config: Record<string, unknown>, feedId: string): Record<string, unknown> {
  const bound: Record<string, unknown> = { ...config, feed: feedId }
  delete bound.source_draft_id
  delete bound.output_contract
  return bound
}

function rewriteGrid(grid: ScreenGrid, pending: readonly PendingBinding[], promoted: ReadonlyMap<string, PromotedDraft>): ScreenGrid {
  const byCell = new Map<number, PendingBinding>()
  const bySeries = new Map<number, Map<number, PendingBinding>>()
  for (const binding of pending) {
    if (binding.seriesIndex === undefined) {
      byCell.set(binding.cellIndex, binding)
      continue
    }
    const forCell = bySeries.get(binding.cellIndex) ?? new Map<number, PendingBinding>()
    forCell.set(binding.seriesIndex, binding)
    bySeries.set(binding.cellIndex, forCell)
  }
  return {
    ...grid,
    cells: grid.cells.map((cell, index) => {
      const series = bySeries.get(index)
      if (series) {
        const items = (cell.config.series as Record<string, unknown>[]).map((item, seriesIndex) => {
          const binding = series.get(seriesIndex)
          return binding ? boundConfig(item, promotedFeedId(binding, promoted)) : item
        })
        return { ...cell, config: { ...cell.config, series: items } }
      }
      const binding = byCell.get(index)
      if (!binding) return cell
      return { ...cell, config: boundConfig(cell.config, promotedFeedId(binding, promoted)) }
    }),
  }
}

/**
 * Advisory checks over the STORED grid — every binding here is to a feed that exists, because
 * pending cells have already been rewritten to their promoted feed ids.
 *
 * This collects warnings; it never throws. Nothing has ever been declared for generic widgets,
 * so a board built before this contract existed was built without one, and hard-rejecting would
 * make an already-saved mismatch unfixable — the operator could not save the screen to correct it.
 * The line against a pending binding, which IS rejected, is evidence: there the operator promises
 * a source in this request; here the system has merely inferred something after the fact and may
 * be looking at a feed whose shape changes with the next push.
 */
function collectWarnings(db: DB, grid: ScreenGrid): string[] {
  const warnings: string[] = []
  const check = (cellIndex: number, widget: string, config: Record<string, unknown>, feedId: unknown): void => {
    if (typeof feedId !== 'string') return
    const feed = getFeed(db, feedId)
    if (!feed) return
    const compatibility = compatibleGeneric(widget, config, capabilitiesForFeed(db, feed), feed.mode)
    if (!compatibility.ok) warnings.push(`card ${cellIndex + 1}: ${compatibility.error}`)
  }
  for (const [cellIndex, cell] of grid.cells.entries()) {
    if (widgetRequirement(cell.widget)) continue
    if (cell.widget !== 'chart') {
      check(cellIndex, cell.widget, cell.config, cell.config.feed)
      continue
    }
    // One warning per CELL, not per series: a chart with four badly-bound series is one mistake an
    // operator makes once, and four lines saying so would bury the other cards' warnings.
    for (const candidate of Array.isArray(cell.config.series) ? cell.config.series : []) {
      const item = candidate as Record<string, unknown> | null
      if (!item) continue
      const before = warnings.length
      check(cellIndex, 'chart', { series: [item] }, item.feed)
      if (warnings.length > before) break
    }
  }
  return warnings
}

function normalizeFailure(error: unknown): ScreenSaveError {
  if (error instanceof ScreenSaveError) return error
  const message = error instanceof Error ? error.message : ''
  if (message === 'Source draft is unavailable') {
    return new ScreenSaveError('not_found', 'source draft was not found', 404)
  }
  if (message === 'Source draft preview is invalid') {
    return new ScreenSaveError('conflict', 'source draft is invalid', 409)
  }
  if (message.includes('UNIQUE constraint failed: screens.name')) {
    return new ScreenSaveError('name_conflict', 'name already exists', 400)
  }
  return new ScreenSaveError('failed', 'screen save failed', 500)
}

/** Validates the whole candidate before materializing, then commits promotion + screen as one unit. */
export function saveScreenWithSources(db: DB, input: SaveScreenInput, now: number): SaveScreenResult {
  if (typeof input.theme_id === 'string' && !getTheme(db, input.theme_id)) invalid(`unknown theme "${input.theme_id}"`)
  const validated = validateGrid(db, input.grid, now, true)
  const actor = input.actor ?? { type: 'admin' as const, id: null }

  try {
    return db.transaction(() => {
      const existing = input.id === undefined ? undefined : getScreen(db, input.id)
      if (input.id !== undefined && !existing) throw new ScreenSaveError('not_found', 'not found', 404)
      if (input.id !== undefined && input.expected_rev === undefined) {
        invalid('rev is required when saving a grid')
      }
      if (existing && input.expected_rev !== existing.rev) {
        throw new ScreenSaveError('conflict', 'screen changed elsewhere', 409, existing.rev)
      }

      const promoted = new Map<string, PromotedDraft>()
      for (const draftId of validated.drafts.keys()) {
        promoted.set(draftId, materializeSourceDraft(db, draftId, now, actor))
      }
      const storedGrid = rewriteGrid(input.grid, validated.pending, promoted)
      validateGrid(db, storedGrid, now, false)

      let screen: ScreenRow
      if (!existing) {
        screen = createScreen(db, {
          name: input.name, orientation: input.orientation, grid: storedGrid, theme_id: input.theme_id,
          sounds: input.sounds,
        }, now)
        audit(db, actor.type, actor.id, 'screen_created', {
          screen_id: screen.id, name: screen.name, orientation: screen.orientation,
        })
        if (screen.theme_id !== null) {
          audit(db, actor.type, actor.id, 'screen_theme_assigned', {
            screen_id: screen.id, theme_id: screen.theme_id, reason: 'screen_created',
          })
        }
      } else {
        const result = updateScreen(db, existing.id, {
          name: input.name, orientation: input.orientation, grid: storedGrid,
          theme_id: input.theme_id, sounds: input.sounds,
        }, input.expected_rev)
        if (result.status === 'missing') throw new ScreenSaveError('not_found', 'not found', 404)
        if (result.status === 'conflict') {
          throw new ScreenSaveError('conflict', 'screen changed elsewhere', 409, result.rev)
        }
        screen = getScreen(db, existing.id)!
        audit(db, actor.type, actor.id, 'screen_updated', {
          screen_id: screen.id, fields: input.audit_fields ?? ['grid', 'rev'],
        })
        if (input.theme_id !== undefined && input.theme_id !== existing.theme_id) {
          audit(db, actor.type, actor.id, 'screen_theme_assigned', {
            screen_id: screen.id, theme_id: input.theme_id, reason: 'screen_edited',
          })
        }
      }

      const values = [...promoted.values()]
      return {
        screen,
        promoted_source_ids: values.map((value) => value.source.id),
        promoted_feed_ids: values.flatMap((value) => value.outputs.map((output) => output.feed_id)),
        changed_feed_ids: values.flatMap((value) => value.changed_feed_ids),
        // Computed inside the transaction so a promoted feed is visible to the inference, and
        // discarded with everything else if the save rolls back.
        warnings: collectWarnings(db, storedGrid),
      }
    })()
  } catch (error) {
    throw normalizeFailure(error)
  }
}

export function screenSaveErrorBody(error: ScreenSaveError): { error: string; rev?: number } {
  return error.rev === undefined ? { error: error.message } : { error: error.message, rev: error.rev }
}
