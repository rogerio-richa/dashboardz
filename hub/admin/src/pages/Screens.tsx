import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { useConfirm } from '../confirm'
import CellConfig from './CellConfig'
import { OrientationIcon, IconPlus, IconSave, IconEdit, IconTrash, PresetIcon } from '../icons'
import LayoutCanvas from './LayoutCanvas'
import SourceSetupDialog from './SourceSetupDialog'
import WidgetGallery from './WidgetGallery'
import { SOUND_EVENTS, fetchSoundManifest, type SoundFamilies } from '../sounds'
import { SoundMixer } from '../SoundMixer'
import type { SourceSetupResult } from '../source-types'
// Shared 12-name icon enum — the default chart config's first series picks
// CHART_ICONS[0], the same "first icon" ChartSeriesEditor.nextIcon falls back to. Rect predicates
// layout model come from the SAME module — layout-core.mjs is the single
// source of truth for rectValid/rectsOverlap/RECT_MIN/quantize; admin.ts keeps a hand-duplicated
// copy the hub can validate against (it cannot import browser ESM), pinned by an agreement test.
// @ts-expect-error plain JS module without types
import { CHART_ICONS, rectValid, rectsOverlap, RECT_MIN, quantize, safeRect, belowMinimum, WIDGET_MIN_PX } from '../../../static/device/layout-core.mjs'
// @ts-expect-error plain JS module without types
import { designMinimum } from '../../../static/device/widgets/catalogue.mjs'
import type { Aspect, Cell, EditorCell, Rect, Widget } from '../layout-edit'
import { TARGET_SHAPES } from '../layout-edit'
import { ratioToRect, suggestedRatio } from '../layout-edit'
// @ts-expect-error plain JS data module without types
import { WIDGET_DEFINITIONS } from '../../../static/device/widgets/definitions.mjs'
export type { Cell, Rect, Widget } from '../layout-edit'

type Orientation = 'landscape' | 'portrait'
/** Mirrors the hub's ScreenGrid: tab_bar is the edge this screen reserves for the device tab bar. */
type TabBarPosition = 'bottom' | 'top' | 'left' | 'right' | 'hidden'
interface Grid { cells: Cell[]; tab_bar?: TabBarPosition }
/** `sounds` is the screen's sparse event->family override (screen editor behavior) — unset events fall back to
 * the assigned theme, then 'classic'. Read defensively (`?? {}`) rather than trusted non-optional:
 * a corrupt row loaded via `editRow` must not crash the Sounds section any more than it crashes
 * the grid editor. */
interface ScreenRow { id: string; name: string; orientation: Orientation; grid: Grid; created_at: number; assigned_count: number; theme_id: string | null; rev: number; sounds?: Record<string, string> }
interface ThemeRow { id: string; name: string; widgets?: Record<string, string>; sounds?: Record<string, string> }
/**
 * A screen is authored FOR a device, and a device has a size. `viewport_w/h` are CSS pixels
 * the device reported on its last HELLO, or null for one that has never connected since that
 * landed — unknown, never zero.
 */
interface DeviceRow {
  id: string; name: string; screen_id: string | null; online: boolean
  viewport_w: number | null; viewport_h: number | null; viewport_dpr: number | null
  /** Every tab this device shows, in order (v25+). `tabs` may be absent on older fixtures/mocks —
   * read with `?? []`, the same tolerance the rest of this file gives every server shape. */
  tabs?: { screen_id: string; name?: string; label?: string | null }[]
}
interface WidgetDefinition { id: Widget; label: string }
interface CellConnection {
  name: string
  provider: string
  preview: unknown
  missingOptional: string[]
  draftId?: string
}
interface SetupTarget {
  widget: 'weather_forecast' | 'news_list' | 'calendar_events'
  cellId?: string
  point?: { x: number; y: number }
}
export type FeedMode = 'value' | 'stream' | 'image'
export interface FeedRow { id: string; name: string; mode: FeedMode }
export interface FeedDetail extends FeedRow { payload: unknown; rows: { payload: unknown; pushed_at: number }[] }

const FULL: Rect = { x: 0, y: 0, w: 1, h: 1 }
const START: Cell = { rect: FULL, widget: 'clock', config: {} }
const WIDGETS: Widget[] = [
  'clock', 'alert_feed', 'calendar_events', 'value_tile', 'gauge', 'stream_list', 'table',
  'text_block', 'chart', 'image', 'weather_forecast', 'news_list',
]
const SEMANTIC_WIDGETS = new Set<Widget>(['weather_forecast', 'news_list', 'calendar_events'])
const WIDGET_LABELS = new Map(
  (WIDGET_DEFINITIONS as WidgetDefinition[]).map((definition) => [definition.id, definition.label]),
)
const friendlyWidget = (widget: Widget) => WIDGET_LABELS.get(widget) ?? widget

let idSeq = 0
const newId = () => `c${++idSeq}`
const wrap = (cells: Cell[]): EditorCell[] => cells.map((cell) => ({ id: newId(), cell }))

/**
 * Preset shapes (editor behavior). Thirds are 0.333/0.333/0.334, NOT 0.333 x 3: three exact thirds
 * are unrepresentable at 3dp and 0.999 would leave a 1px background sliver at the far edge on
 * every screen, so the remainder goes to the LAST card in the run.
 */
const PRESETS: { label: string; rect: Rect }[] = [
  { label: 'full', rect: { x: 0, y: 0, w: 1, h: 1 } },
  { label: 'top strip', rect: { x: 0, y: 0, w: 1, h: 0.2 } },
  { label: 'bottom strip', rect: { x: 0, y: 0.8, w: 1, h: 0.2 } },
  { label: 'half L', rect: { x: 0, y: 0, w: 0.5, h: 1 } },
  { label: 'half R', rect: { x: 0.5, y: 0, w: 0.5, h: 1 } },
  { label: 'half T', rect: { x: 0, y: 0, w: 1, h: 0.5 } },
  { label: 'half B', rect: { x: 0, y: 0.5, w: 1, h: 0.5 } },
  { label: 'third 1', rect: { x: 0, y: 0, w: 0.333, h: 1 } },
  { label: 'third 2', rect: { x: 0.333, y: 0, w: 0.333, h: 1 } },
  { label: 'third 3', rect: { x: 0.666, y: 0, w: 0.334, h: 1 } },
  { label: 'quad TL', rect: { x: 0, y: 0, w: 0.5, h: 0.5 } },
  { label: 'quad TR', rect: { x: 0.5, y: 0, w: 0.5, h: 0.5 } },
  { label: 'quad BL', rect: { x: 0, y: 0.5, w: 0.5, h: 0.5 } },
  { label: 'quad BR', rect: { x: 0.5, y: 0.5, w: 0.5, h: 0.5 } },
]

/**
 * Minimal valid config per widget (editor behavior). Deliberately the smallest object that shape-
 * matches the AJV oneOf in hub/src/routes/admin.ts — operators fill in the rest via the per-cell
 * UI, the server's feedCheck is the final enforcer.
 */
const defaultConfig = (w: Widget): Record<string, unknown> => {
  if (w === 'clock') return {}
  if (w === 'alert_feed') return { min_severity: 'info', clamp: { title_lines: 1, body_lines: 2 }, overflow: { counter: true } }
  if (w === 'value_tile') return { feed: '', path: '' }
  if (w === 'gauge') return { feed: '', path: '', min: 0, max: 100 }
  if (w === 'stream_list') return { feed: '' }
  if (w === 'table') return { feed: '', columns: [{ header: '', path: '' }] }
  if (w === 'text_block') return { text: '' }
  if (w === 'chart') return { series: [{ feed: '', y_path: '', icon: CHART_ICONS[0] }], style: 'line' }
  if (w === 'weather_forecast') return { days: 5, show_precipitation: true }
  if (w === 'news_list') return { items: 5, show_summary: true, show_source: true, show_time: true }
  if (w === 'calendar_events') return { events: 5, show_location: true }
  return { feed: '', fit: 'contain' } // image
}

const cellLabel = (c: Cell, feeds: FeedRow[], connection?: CellConnection) => {
  const widget = friendlyWidget(c.widget)
  if (connection) return `${widget} · ${connection.name}`
  if (c.widget === 'clock') return widget
  const cfg = c.config as any
  if (c.widget === 'alert_feed') {
    return widget
  }
  // Chart binds per-series (config.series[].feed), not a single config.feed — give it its own
  // label rather than falling into the generic "no feed" case below.
  if (c.widget === 'chart') {
    const series = Array.isArray(cfg.series) ? cfg.series : []
    return `${widget} · ${series.length} series`
  }
  // Connection names stay readable while the feed list refreshes; internal ids and paths belong
  // in the Advanced inspector, never on the canvas.
  if (typeof cfg.feed === 'string' && cfg.feed) {
    const feedName = feeds.find((f) => f.id === cfg.feed)?.name ?? 'Connection'
    return `${widget} · ${feedName}`
  }
  if (c.widget === 'text_block') return `${widget} · "${typeof cfg.text === 'string' ? cfg.text.slice(0, 20) : ''}"`
  return widget
}

export default function Screens() {
  const [rows, setRows] = useState<ScreenRow[]>([])
  const [name, setName] = useState('')
  const [orientation, setOrientation] = useState<Orientation>('landscape')
  // Where this screen expects the device tab bar (per-screen declaration). The canvas
  // and the undersized warnings measure against the box that remains AFTER the bar takes its edge,
  // so "fits in the editor" means "fits on the wall with the bar showing".
  const [tabBar, setTabBar] = useState<TabBarPosition>('bottom')
  // Fallback preview shape, used ONLY when no assigned device has reported its viewport.
  // has landed, so a screen assigned to a real device is designed against that device's actual
  // pixels rather than against a shape somebody picked from a list.
  const [shapeLabel, setShapeLabel] = useState(TARGET_SHAPES[0].label)
  const fallbackAspect: Aspect = TARGET_SHAPES.find((s) => s.label === shapeLabel)?.aspect
    ?? TARGET_SHAPES[0].aspect
  // Whether the operator has explicitly picked a shape via the selector below, as opposed to
  // shapeLabel merely holding whatever orientation last defaulted it to. This MUST be a separate
  // flag, not inferred by comparing shapeLabel's text against the two default labels: TWO entries
  // are themselves named "default landscape"/"default portrait", so an explicit pick of one of
  // them (e.g. choosing 16:10 while in portrait) is textually indistinguishable from "untouched"
  // — a label-comparison guard would silently clobber that pick on the next orientation switch.
  const [shapeTouched, setShapeTouched] = useState(false)
  // Orientation still steers a sensible starting shape (portrait orientation shouldn't leave the
  // canvas drawing 16:10) — but only while the operator hasn't picked a shape of their own via the
  // selector below. Once shapeTouched is true, it sticks regardless of orientation.
  const syncShapeToOrientation = (o: Orientation) => {
    if (shapeTouched) return
    setShapeLabel(o === 'portrait' ? TARGET_SHAPES[1].label : TARGET_SHAPES[0].label)
  }
  // Loading a different row (editRow) or discarding the current edit (cancelEdit) is a fresh
  // context, not a continuation of the previous one — reset the operator's shape pick along with
  // it rather than carrying it over, then land on the sensible default for the row's/form's own
  // orientation. Unconditional (does not go through syncShapeToOrientation's shapeTouched guard):
  // setShapeTouched(false) here would not be visible to a syncShapeToOrientation call in the same
  // handler anyway, since it reads shapeTouched from the current render's closure.
  const resetShapeForOrientation = (o: Orientation) => {
    setShapeTouched(false)
    setShapeLabel(o === 'portrait' ? TARGET_SHAPES[1].label : TARGET_SHAPES[0].label)
  }
  const [items, setItems] = useState<EditorCell[]>(() => wrap([START]))
  const cells = items.map((it) => it.cell)   // derived; used by placementError and submit
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [error, setError] = useState('')
  /**
   * The list and the editor are two VIEWS, not one scrolling page. Everything below the table used
   * to be permanently mounted: a create form, a loose "Add card" button and a canvas, all visible
   * while you were only trying to read the list. Editing is a mode, so it gets a screen.
   */
  const [view, setView] = useState<'list' | 'editor'>('list')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingRev, setEditingRev] = useState<number | null>(null)
  const [ask, confirmDialog] = useConfirm()
  const [galleryOpen, setGalleryOpen] = useState(false)
  const [setupTarget, setSetupTarget] = useState<SetupTarget | null>(null)
  const [cellConnections, setCellConnections] = useState<Record<string, CellConnection>>({})
  const ownedDrafts = useRef(new Set<string>())
  const deletingDrafts = useRef(new Map<string, Promise<void>>())
  const [feeds, setFeeds] = useState<FeedRow[]>([])
  // GET /admin/api/feeds/:id responses, cached by feed id — fetched once per feed selection so
  // the live preview never re-fetches on every keystroke of the path input.
  const [previews, setPreviews] = useState<Record<string, FeedDetail>>({})

  const discardOwnedDraft = (id: string): Promise<void> => {
    if (!ownedDrafts.current.has(id)) return Promise.resolve()
    const active = deletingDrafts.current.get(id)
    if (active) return active
    const request = api<void>(`/admin/api/source-drafts/${encodeURIComponent(id)}`, { method: 'DELETE' })
      .then(() => { ownedDrafts.current.delete(id) })
      .catch((cause) => {
        if (cause instanceof Error && cause.message === 'not_found') {
          ownedDrafts.current.delete(id)
          return
        }
        throw cause
      })
      .finally(() => { deletingDrafts.current.delete(id) })
    deletingDrafts.current.set(id, request)
    return request
  }

  useEffect(() => () => {
    for (const id of ownedDrafts.current) {
      if (deletingDrafts.current.has(id)) continue
      void fetch(`/admin/api/source-drafts/${encodeURIComponent(id)}`, {
        method: 'DELETE', credentials: 'include', keepalive: true,
      }).catch(() => undefined)
    }
  }, [])

  const [themes, setThemes] = useState<ThemeRow[]>([])
  const [devices, setDevices] = useState<DeviceRow[]>([])
  /**
   * The device the operator is designing FOR, chosen explicitly. Null means "infer it" — the
   * device this screen is assigned to. A brand-new screen has no assignment yet, and falling back
   * to a shape picked from a list is exactly the guessing this viewport report eliminates, so the picker below
   * lets the target be named before the screen exists.
   */
  const [targetDeviceId, setTargetDeviceId] = useState<string | null>(null)
  // Which device the test-on-device row auditions against — a separate pick from targetDeviceId
  // above (that one is about DESIGNING the layout; this one is about HEARING the mix), so a device
  // chosen to preview the canvas at is not silently reused as the one that gets played at.
  const [testDeviceId, setTestDeviceId] = useState<string | null>(null)
  const [manifest, setManifest] = useState<{ rev: number; families: SoundFamilies }>({ rev: 0, families: {} })
  /**
   * Which device a play-this-mix sequence is currently running against, or null between
   * sequences. Doubles as the re-entrancy guard (a click while this is non-null is a no-op) and
   * the "playing…" UI state. `playToken` is the companion CANCELLATION mechanism: `playMixOnDevice`
   * captures the token it was started with and checks it between every awaited step, so bumping
   * the ref (cancelEdit / resetAfterCancel / newLayout / unmount) makes every future check in an
   * already-running loop fail and return — no POST after the operator has left the section.
   * State alone can't do this: the loop's closure captures `playingMixOn` once, at the call that
   * started it, and never sees later re-renders.
   */
  const [playingMixOn, setPlayingMixOn] = useState<string | null>(null)
  const playToken = useRef(0)
  /** Invalidates any in-flight play-this-mix sequence without waiting for it to notice on its own. */
  const cancelPlayback = () => { playToken.current += 1; setPlayingMixOn(null) }
  useEffect(() => () => { playToken.current += 1 }, [])

  /**
   * THE DEVICE THIS SCREEN IS BEING BUILT FOR.
   *
   * A screen is authored for a device, and a device has a size — so the canvas is drawn at the
   * device's real aspect and every card is measured in the device's real pixels. Only devices that
   * have actually reported a viewport count: a device that has never connected tells us nothing,
   * so the target-shape dropdown is shown when no measured device is available.
   *
   * Several devices can share a screen. When their viewports disagree the smallest box wins, since
   * a layout that fits the tightest target fits the rest — and `targetPeers` names the others so
   * the choice is visible rather than silent.
   */
  /** Only devices that have actually told us their size can be designed against. */
  const measuredDevices = devices.filter((d) => d.viewport_w && d.viewport_h)
  const assignedDevices = measuredDevices.filter((d) => editingId != null && d.screen_id === editingId)
  // Explicit pick wins. Otherwise the device this screen is assigned to; when several share it the
  // SMALLEST box wins, since a layout that fits the tightest target fits the rest. Failing both —
  // a new screen, nothing assigned — any measured device beats a shape from a dropdown.
  const inferredDevice = (assignedDevices.length > 0 ? assignedDevices : measuredDevices)
    .reduce<DeviceRow | null>((a, b) =>
      (a && a.viewport_w! * a.viewport_h! <= b.viewport_w! * b.viewport_h!) ? a : b, null)
  const targetDevice = measuredDevices.find((d) => d.id === targetDeviceId) ?? inferredDevice
  const targetPeers = assignedDevices.filter((d) => d.id !== targetDevice?.id)

  /** The device's real box, or null when nothing authoritative is known. */
  const rawTargetPx = targetDevice ? { w: targetDevice.viewport_w!, h: targetDevice.viewport_h! } : null
  // What the board's tab bar costs, in CSS px, matching the device stylesheet: 48px touch height
  // + 8px margin for top/bottom, 96px column + 8px margin for left/right. The grid gets what's
  // left, so the editor must measure cards in the REMAINING box or its warnings lie exactly when
  // a bar appears. 'hidden' reserves nothing — that screen can never sit under a bar (the hub
  // refuses to put it in a multi-tab list).
  const BAR_MAIN_PX = 56
  const BAR_SIDE_PX = 104
  const targetPx = rawTargetPx === null ? null : {
    w: rawTargetPx.w - (tabBar === 'left' || tabBar === 'right' ? BAR_SIDE_PX : 0),
    h: rawTargetPx.h - (tabBar === 'top' || tabBar === 'bottom' ? BAR_MAIN_PX : 0),
  }
  const aspect: Aspect = targetPx ? { w: targetPx.w, h: targetPx.h } : fallbackAspect

  /** A card's size in the target device's own pixels. Null when we have no device to measure in. */
  const cellPx = (rect: Rect) => {
    if (!targetPx) return null
    const r = safeRect(rect)
    return { w: Math.round(r.w * targetPx.w), h: Math.round(r.h * targetPx.h) }
  }

  /**
   * Cards too small for their widget ON THIS DEVICE (WIDGET_MIN_PX). Empty when no viewport is
   * known — an unenforceable rule must not paint warnings it cannot justify.
   */
  const undersized = (() => {
    const out = new Map<string, { widget: Widget; px: { w: number; h: number }; min: { w: number; h: number } }>()
    if (!targetPx) return out
    for (const it of items) {
      const px = cellPx(it.cell.rect)!
      // The DESIGN's own floor when it declares one (stream/ticker's band), else the widget table.
      // The editor and the renderer read the same rule on purpose: an admin that refuses a cell the
      // panel happily draws teaches operators to distrust the warning.
      const designMin = designMinimum(it.cell.widget, (it.cell.config as { design?: string })?.design)
      if (belowMinimum(it.cell.widget, px.w, px.h, designMin)) {
        out.set(it.id, { widget: it.cell.widget, px, min: designMin ?? WIDGET_MIN_PX[it.cell.widget] })
      }
    }
    return out
  })()

  const refresh = () => api<ScreenRow[]>('/admin/api/screens').then(setRows).catch(() => {})

  /**
   * Assigning a theme is a one-action job, so it lives in the list row rather than behind Edit.
   * NULL is a first-class state meaning the built-in default — not an error, not "unset".
   */
  const assignTheme = async (screenId: string, themeId: string) => {
    await api(`/admin/api/screens/${screenId}`, {
      method: 'PATCH', body: JSON.stringify({ theme_id: themeId === '' ? null : themeId }),
    })
    refresh()
  }
  useEffect(() => { refresh() }, [])
  // Named, not inlined: the cell editor's data source picker can CREATE a feed now, so this has to
  // be callable again from down there or a newly made source stays a raw id in the UI.
  const refreshFeeds = () => { api<FeedRow[]>('/admin/api/feeds').then(setFeeds).catch(() => {}) }
  useEffect(() => { refreshFeeds() }, [])
  useEffect(() => { api<ThemeRow[]>('/admin/api/themes').then(setThemes).catch(() => {}) }, [])
  useEffect(() => { api<DeviceRow[]>('/admin/api/devices').then(setDevices).catch(() => {}) }, [])
  // fetchSoundManifest() validates the response shape itself (degrading to classic-only on a
  // wrong-shaped body, same as a network failure), so it's safe to adopt directly here.
  useEffect(() => { fetchSoundManifest().then(setManifest) }, [])


  const ensurePreview = (feedId: string) => {
    if (!feedId || previews[feedId]) return
    api<FeedDetail>(`/admin/api/feeds/${feedId}`).then((d) => setPreviews((prev) => ({ ...prev, [feedId]: d }))).catch(() => {})
  }

  /** First position where a rect of this size does not overlap anything, scanning the 0.05 grid. */
  const freeSpot = (size: Rect): Rect => {
    // safeRect: a corrupt cell (rect: null, loaded from an editRow'd bad row) must not crash
    // placing a NEW card — same guarantee as the canvas render, same reason.
    const taken = items.map((it) => safeRect(it.cell.rect))
    for (let y = 0; y + size.h <= 1.0001; y += 0.05) {
      for (let x = 0; x + size.w <= 1.0001; x += 0.05) {
        const candidate = { ...size, x: quantize(x), y: quantize(y) }
        if (!taken.some((t) => rectsOverlap(candidate, t))) return candidate
      }
    }
    // Nothing fits. Place it at the origin anyway and let the existing overlap highlighting and
    // blocked save explain why — refusing silently leaves the operator with no feedback.
    return { ...size, x: 0, y: 0 }
  }

  /**
   * A new card arrives as the widget the operator picked, at that widget's suggested shape, in the
   * first free slot — not as a default clock they then have to convert, because converting is what
   * the fixed widget type just removed.
   */
  const addCard = (
    widget: Widget,
    binding?: SourceSetupResult,
    point?: { x: number; y: number },
  ) => {
    const config = { ...defaultConfig(widget), ...(binding?.binding ?? {}) }
    const size = ratioToRect(suggestedRatio(widget, config), aspect)
    const rect = point ? {
      ...size,
      x: quantize(Math.min(1 - size.w, Math.max(0, point.x - size.w / 2))),
      y: quantize(Math.min(1 - size.h, Math.max(0, point.y - size.h / 2))),
    } : freeSpot(size)
    const id = newId()
    setItems((prev) => [...prev, { id, cell: { rect, widget, config } }])
    setSelectedId(id)
    if (binding) {
      const draftId = 'source_draft_id' in binding.binding ? binding.binding.source_draft_id : undefined
      if (draftId) ownedDrafts.current.add(draftId)
      setCellConnections((current) => ({
        ...current,
        [id]: {
          ...binding.connection, preview: binding.preview,
          missingOptional: binding.missing_optional, draftId,
        },
      }))
    }
  }

  const chooseWidget = (widgetValue: string) => {
    setGalleryOpen(false)
    if (!WIDGETS.includes(widgetValue as Widget) || items.length >= 12) return
    const widget = widgetValue as Widget
    if (SEMANTIC_WIDGETS.has(widget)) {
      setSetupTarget({ widget: widget as SetupTarget['widget'] })
      return
    }
    addCard(widget)
  }

  const useSource = (result: SourceSetupResult) => {
    const target = setupTarget
    if (!target) return
    setSetupTarget(null)
    const draftId = 'source_draft_id' in result.binding ? result.binding.source_draft_id : undefined
    if (draftId) ownedDrafts.current.add(draftId)
    if (!target.cellId) {
      if (items.length >= 12) {
        if (draftId) void discardOwnedDraft(draftId).catch(() => undefined)
        return
      }
      addCard(target.widget, result, target.point)
      return
    }
    const previous = items.find((item) => item.id === target.cellId)
    const previousDraft = previous && typeof previous.cell.config.source_draft_id === 'string'
      ? previous.cell.config.source_draft_id : undefined
    if (previousDraft && previousDraft !== draftId) {
      void discardOwnedDraft(previousDraft).catch(() => {
        setError('Couldn’t discard the unfinished connection. Cancel screen editing to try again.')
      })
    }
    setItems((current) => current.map((item) => {
      if (item.id !== target.cellId) return item
      const config = { ...item.cell.config }
      delete config.feed
      delete config.source_draft_id
      delete config.output_contract
      return { ...item, cell: { ...item.cell, config: { ...config, ...result.binding } } }
    }))
    setCellConnections((current) => ({
      ...current,
      [target.cellId!]: {
        ...result.connection, preview: result.preview,
        missingOptional: result.missing_optional, draftId,
      },
    }))
  }

  const setCellConfig = (id: string, patch: Record<string, unknown>) =>
    setItems((prev) => prev.map((it) => (it.id === id ? { ...it, cell: { ...it.cell, config: { ...it.cell.config, ...patch } } } : it)))
  const replaceCellConfig = (id: string, config: Record<string, unknown>) =>
    setItems((prev) => prev.map((it) => (it.id === id ? { ...it, cell: { ...it.cell, config } } : it)))

  /** Mirrors the server's overlapCheck message exactly so the operator sees one wording. */
  const placementError = (() => {
    for (const [i, c] of cells.entries()) {
      if (!rectValid(c.rect)) return `card ${i + 1} has an invalid rect`
    }
    for (let i = 0; i < cells.length; i++) {
      for (let j = i + 1; j < cells.length; j++) {
        if (rectsOverlap(cells[i].rect, cells[j].rect)) return `cards ${i + 1} and ${j + 1} overlap`
      }
    }
    return ''
  })()

  const newLayout = () => {
    setEditingId(null)
    setEditingRev(null)
    setName('')
    setOrientation('landscape')
    setTabBar('bottom')
    resetShapeForOrientation('landscape')
    const wrapped = wrap([START])
    setItems(wrapped)
    setSelectedId(wrapped[0].id)
    setCellConnections({})
    setGalleryOpen(false)
    setSetupTarget(null)
    setTestDeviceId(null)
    cancelPlayback()
    setError('')
    setView('editor')
  }

  const dropWidget = (w: Widget, xFrac: number, yFrac: number) => {
    // The payload crossed a MIME-type boundary (dataTransfer), so it is untrusted: any page can
    // set text/dbz-widget to anything. An unrecognized value would make suggestedRatio return
    // undefined, ratioToRect(undefined, …) return NaN, and a NaN rect enter `cells` — exactly
    // what the zero-box guard elsewhere exists to prevent. The 12-card cap mirrors the palette
    // button's `disabled`, which is UI-only: without this, a 13th card dropped in becomes a
    // server-side AJV rejection (cellSchema's maxItems: 12) instead of a UI no-op.
    if (!WIDGETS.includes(w) || items.length >= 12) return
    if (SEMANTIC_WIDGETS.has(w)) {
      setSetupTarget({ widget: w as SetupTarget['widget'], point: { x: xFrac, y: yFrac } })
      return
    }
    addCard(w, undefined, { x: xFrac, y: yFrac })
  }

  const removeCardState = (id: string) => {
    const idx = items.findIndex((it) => it.id === id)
    const next = items.filter((it) => it.id !== id)
    // Draft cleanup is asynchronous. Remove from the latest editor state so a widget placed while
    // that DELETE was in flight is not erased when the response arrives.
    setItems((current) => current.filter((it) => it.id !== id))
    setCellConnections((current) => {
      const nextConnections = { ...current }
      delete nextConnections[id]
      return nextConnections
    })
    // Never leave the inspector pointing at a card that no longer exists: move the selection to
    // whichever card now occupies the removed card's slot (or the new last card, if it was last).
    if (id === selectedId) setSelectedId(next.length ? next[Math.min(idx, next.length - 1)].id : null)
  }
  const removeCard = (id: string) => {
    const item = items.find((candidate) => candidate.id === id)
    const draftId = item && typeof item.cell.config.source_draft_id === 'string'
      ? item.cell.config.source_draft_id : undefined
    if (!draftId) {
      removeCardState(id)
      return
    }
    void discardOwnedDraft(draftId)
      .then(() => removeCardState(id))
      .catch(() => setError('Couldn’t discard the unfinished connection. Try removing the card again.'))
  }
  const setRect = (id: string, patch: Partial<Rect>) =>
    setItems((prev) => prev.map((it) => (it.id === id ? { ...it, cell: { ...it.cell, rect: { ...it.cell.rect, ...patch } } } : it)))

  const editRow = (s: ScreenRow) => {
    setView('editor')
    setEditingId(s.id)
    // The version this edit is built FROM. A save carries it back so the hub can refuse a write
    // that would silently discard somebody else's — the editor replaces the whole grid, so
    // "last writer wins" means "last writer erases" (v14).
    setEditingRev(s.rev)
    setName(s.name)
    setOrientation(s.orientation)
    setTabBar(s.grid?.tab_bar ?? 'bottom')
    resetShapeForOrientation(s.orientation)
    // A row whose grid parses but is not a grid must still be openable — the operator's only
    // route to fixing it is the editor. Same starting card a fresh layout gets (see cancelEdit).
    // `??` alone isn't enough: a non-null, non-array `cells` (e.g. `grid: { cells: 5 }`) would
    // sail through and crash placementError's `.entries()` / the render's `.map()` below, taking
    // the whole admin root down with it. An empty array must also fall back, or the form loads
    // with zero cards, an enabled submit button (placementError is '' for an empty list), and a
    // POST the server's AJV rejects on minItems: 1.
    const rowCells = s.grid?.cells
    const wrapped = wrap(Array.isArray(rowCells) && rowCells.length ? rowCells : [START])
    setItems(wrapped)
    setSelectedId(wrapped[0].id)
    setCellConnections({})
    setGalleryOpen(false)
    setSetupTarget(null)
    setTestDeviceId(null)
    cancelPlayback()
    setError('')
  }
  const resetAfterCancel = () => {
    setView('list')
    setEditingId(null)
    setEditingRev(null)
    setName('')
    setOrientation('landscape')
    setTabBar('bottom')
    resetShapeForOrientation('landscape')
    const wrapped = wrap([START])
    setItems(wrapped)
    setSelectedId(wrapped[0].id)
    setCellConnections({})
    setGalleryOpen(false)
    setSetupTarget(null)
    setTestDeviceId(null)
    cancelPlayback()
    setError('')
  }
  const cancelEdit = () => {
    const drafts = [...ownedDrafts.current]
    if (drafts.length === 0) {
      resetAfterCancel()
      return
    }
    void Promise.all(drafts.map(discardOwnedDraft))
      .then(resetAfterCancel)
      .catch(() => setError('Couldn’t discard every unfinished connection. Try cancelling again.'))
  }

  // Ids in any overlapping pair — the canvas tints these; placementError still owns the wording.
  // Reads through safeRect, same as what the canvas actually draws: a corrupt rect (null,
  // missing, non-numeric) must not throw here mid-render — rectsOverlap reads `.x` etc. straight
  // off its args, and `rectsOverlap(null, good)` throws before this ever reaches the canvas.
  // placementError (rectValid-based) already reports the underlying invalid rect in words.
  const overlappingIds = (() => {
    const out = new Set<string>()
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        if (rectsOverlap(safeRect(items[i].cell.rect), safeRect(items[j].cell.rect))) { out.add(items[i].id); out.add(items[j].id) }
      }
    }
    return out
  })()

  /**
   * SOUND OVERRIDES + TEST-ON-DEVICE (screen editor behavior).
   *
   * `editingRow`/`editingThemeId` were previously computed inline inside the per-card inspector's
   * IIFE (for `themeWidgets`) — hoisted here because the Sounds section below needs the same
   * lookup and there is no reason for two copies of "which row and theme is being edited".
   */
  const editingRow = rows.find((r) => r.id === editingId)
  const editingThemeId = editingRow?.theme_id ?? null
  // The screen's own sparse override — read defensively: a corrupt row (see editRow's comment
  // above) may carry no `sounds` key at all.
  const soundsOverride = editingRow?.sounds ?? {}
  /** Mirrors hub's resolveSounds with an empty screen override: theme ⊕ 'classic', always all four
   * events — the mixer's "suggestion" badge (`suggestionLabel="from theme"`) shows what a screen
   * with NO override would actually play. */
  const resolveThemeSounds = (themeId: string | null): Record<string, string> => {
    const themeSounds = themeId ? themes.find((t) => t.id === themeId)?.sounds : undefined
    const out: Record<string, string> = {}
    for (const event of SOUND_EVENTS) out[event] = themeSounds?.[event] ?? 'classic'
    return out
  }
  const soundsSuggestion = resolveThemeSounds(editingThemeId)
  const effectiveSound = (event: string): string => soundsOverride[event] ?? soundsSuggestion[event] ?? 'classic'

  /** Field-level PATCH — unlike the grid save, this needs no `rev` (house rule, alert-sound contract). */
  const setScreenSounds = async (screenId: string, sounds: Record<string, string>) => {
    try {
      await api(`/admin/api/screens/${screenId}`, { method: 'PATCH', body: JSON.stringify({ sounds }) })
      refresh()
    } catch (err) {
      alert((err as Error).message)
    }
  }

  // Devices that actually show this screen win; falling back to every online device (rather than
  // refusing to offer a test at all) is what makes auditioning possible for a screen nothing is
  // assigned to yet.
  const assignedTestDevices = devices.filter((d) => d.online && (d.tabs ?? []).some((t) => t.screen_id === editingId))
  const onlineDevices = devices.filter((d) => d.online)
  const testDevices = assignedTestDevices.length > 0 ? assignedTestDevices : onlineDevices
  const selectedTestDevice = testDevices.find((d) => d.id === testDeviceId) ?? testDevices[0] ?? null

  const playingDeviceName = playingMixOn ? (devices.find((d) => d.id === playingMixOn)?.name ?? playingMixOn) : null

  /**
   * Plays the CURRENT effective mix, one event at a time, ~1.2s apart so four events don't pile up
   * on the panel's one speaker. Best-effort per event: a device going offline mid-sequence (or any
   * other single-event failure) must not abort the rest of the mix.
   *
   * Re-entrancy: a click while `playingMixOn` is already set is a no-op — without this, a
   * double-click starts two independent loops, each posting every ~1.2s, producing overlapping
   * play-sound POSTs to the same device (exactly the pile-up the gap above exists to prevent).
   *
   * Cancellation: `token` is this call's own stamp of `playToken`. `cancelPlayback` (cancelEdit,
   * resetAfterCancel, newLayout, unmount) bumps the ref, so every check below sees a mismatch and
   * returns — a sequence started before the operator left the section stops posting rather than
   * continuing on its own schedule after nobody is watching it.
   */
  const playMixOnDevice = async (deviceId: string) => {
    if (playingMixOn) return
    const token = (playToken.current += 1)
    setPlayingMixOn(deviceId)
    try {
      for (const event of SOUND_EVENTS) {
        if (playToken.current !== token) return
        try {
          await api(`/admin/api/devices/${deviceId}/play-sound`, {
            method: 'POST', body: JSON.stringify({ family: effectiveSound(event), event }),
          })
        } catch {
          // best-effort — see comment above
        }
        if (playToken.current !== token) return
        await new Promise((resolve) => setTimeout(resolve, 1200))
      }
    } finally {
      // Only clear it if THIS call is still the one in charge — a cancellation already cleared it
      // (and possibly let a newer sequence start), and this stale call must not clobber that.
      if (playToken.current === token) setPlayingMixOn(null)
    }
  }

  return (
    <section>
      {/* In the editor the heading doubles as the way back: "Screens › Kitchen", with the list
          one click away. cancelEdit already owns the tidy-up (drafts, playback, form state). */}
      <h2>
        {view === 'editor'
          ? (
            <>
              <button type="button" className="crumb" onClick={cancelEdit}>Screens</button>
              <span className="crumb-sep" aria-hidden>›</span>
              {name.trim() === '' ? 'New layout' : name}
            </>
            )
          : 'Screens'}
      </h2>
      {view === 'list' && (<>
      <table cellPadding={6}>
        <thead><tr><th>Name</th><th className="center">Orientation</th><th className="center">Cards</th><th className="center">Devices</th><th>Theme</th><th></th></tr></thead>
        <tbody>
          {rows.map((s) => (
            <tr key={s.id}>
              <td>{s.name}</td><td className="center"><OrientationIcon orientation={s.orientation} /></td><td className="center">{s.grid?.cells?.length ?? 0}</td><td className="center">{s.assigned_count}</td>
              <td>
                <select
                  aria-label={`${s.name} theme`}
                  value={s.theme_id ?? ''}
                  onChange={(e) => assignTheme(s.id, e.target.value)}
                >
                  <option value="">built-in default</option>
                  {themes.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
              </td>
              <td>
                <button onClick={() => editRow(s)}><IconEdit />Edit</button>
                <button onClick={() => ask(
                  {
                    title: `Delete ${s.name}?`,
                    body: s.assigned_count
                      ? `${s.assigned_count} device(s) showing it fall back to the default layout.`
                      : 'No device is showing it.',
                  },
                  async () => { await api(`/admin/api/screens/${s.id}`, { method: 'DELETE' }); refresh() },
                )}><IconTrash />Delete</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <button type="button" onClick={newLayout}>New layout</button>
      </>)}
      {view === 'editor' && (<>

      <div className="editor">
        <form onSubmit={async (e) => {
          e.preventDefault(); setError('')
          try {
            let saved: ScreenRow
            if (editingId) {
              saved = await api<ScreenRow>(`/admin/api/screens/${editingId}`, { method: 'PATCH', body: JSON.stringify({ name, orientation, grid: { cells, tab_bar: tabBar }, rev: editingRev }) })
            } else {
              saved = await api<ScreenRow>('/admin/api/screens', { method: 'POST', body: JSON.stringify({ name, orientation, grid: { cells, tab_bar: tabBar } }) })
            }
            const promotedDrafts = new Set(cells.flatMap((cell) => (
              typeof cell.config.source_draft_id === 'string' ? [cell.config.source_draft_id] : []
            )))
            for (const id of promotedDrafts) ownedDrafts.current.delete(id)
            setEditingId(saved.id)
            setEditingRev(saved.rev)
            setName(saved.name)
            setOrientation(saved.orientation)
            setItems((current) => saved.grid.cells.map((cell, index) => ({
              id: current[index]?.id ?? newId(), cell,
            })))
            setCellConnections((current) => Object.fromEntries(
              Object.entries(current).map(([id, connection]) => (
                connection.draftId && promotedDrafts.has(connection.draftId)
                  ? [id, { ...connection, draftId: undefined }]
                  : [id, connection]
              )),
            ))
            refresh()
            refreshFeeds()
          } catch (err) {
            // Deliberately NOT cancelEdit() — a refused save must leave every unsaved card and the
            // typed name exactly where they are. Throwing the operator's work away on a conflict
            // would just be a second way to lose it.
            setError((err as Error).message)
          }
        }}>
          <input placeholder="Layout name" value={name} onChange={(e) => setName(e.target.value)} required />
          <div>
            {(['landscape', 'portrait'] as Orientation[]).map((o) => (
              <label key={o} style={{ marginRight: 12 }}>
                <input type="radio" name="orientation" checked={orientation === o} onChange={() => { setOrientation(o); syncShapeToOrientation(o) }} /> {o}
              </label>
            ))}
            <label style={{ marginLeft: 12 }}>
              tab bar:{' '}
              <select value={tabBar} onChange={(e) => setTabBar(e.target.value as TabBarPosition)}>
                {(['bottom', 'top', 'left', 'right', 'hidden'] as TabBarPosition[]).map((p) => (
                  <option key={p} value={p}>{p}</option>
                ))}
              </select>
            </label>
            {tabBar !== 'hidden' && (
              <span className="dim" style={{ marginLeft: 8, fontSize: 12 }}>
                canvas reserves the {tabBar} edge for the bar
              </span>
            )}
          </div>
          {(() => {
            // Selection-driven inspector: with a canvas and a selection, only the
            // selected card's config shows — stacking every card's config at once stopped being
            // legible once the canvas made 12 cards a real scenario.
            const idx = items.findIndex((it) => it.id === selectedId)
            if (idx < 0) return <p style={{ color: '#666' }}>Select a card on the canvas to edit it.</p>
            const it = items[idx], c = it.cell, i = idx
            // Theme resolution tier 2: the generated options block in
            // CellConfig needs to resolve the SAME design the device will draw, and the device
            // consults the screen's theme when the cell itself names none. `rows` already carries
            // each screen's `theme_id` (list-view theme assignment) and `themes` already carries
            // each theme's `widgets` map (per-widget design choice, fetched for the Themes page's
            // own picker) — both fetched already, so this is a lookup, not a new request.
            // `editingThemeId` itself is hoisted above (the Sounds section needs the same lookup).
            const themeWidgets = editingThemeId
              ? themes.find((t) => t.id === editingThemeId)?.widgets
              : undefined
            return (
            <div key={it.id}>
              <div className="edit-card">
                <div className="edit-card-head">
                  <h3>Card {i + 1}</h3>
                  {items.length > 1 && (
                    <button type="button" className="danger" onClick={() => removeCard(it.id)}>Remove card</button>
                  )}
                </div>
                {/*
                  The widget type is FIXED for the life of a card. Swapping it in place threw away
                  a config built against a different shape — a gauge's feed, path, range and
                  thresholds all silently discarded to become a clock. Wrong pick is a remove and
                  an add, which costs one click and destroys nothing by surprise.
                */}
                <span className="card-widget">{friendlyWidget(c.widget)}</span>
                {c.widget === 'alert_feed' && (
                  <>
                    {/*
                      `min severity` is generated from `alert/feed.mjs`'s `meta.options`, so this
                      page must not render a second control for `config.min_severity`. `sound_info` is
                      the opposite case and stays — no design may declare it (the Android app,
                      not a renderer, reads it), so hand-built here is its only home.
                    */}
                    {/*
                      The one place info alerts can be made audible. A sender cannot ask for it —
                      whether a room wants a noise for routine traffic is the room's decision, and
                      the answer is no unless somebody standing in it says otherwise.
                    */}
                    <label style={{ marginLeft: 12 }}>
                      <input
                        type="checkbox"
                        aria-label="Chime on info alerts"
                        checked={(c.config as any).sound_info === true}
                        onChange={(e) => setCellConfig(it.id, { sound_info: e.target.checked })}
                      /> chime on info
                    </label>
                  </>
                )}
                {(c.widget === 'stream_list' || c.widget === 'table') && (
                  <>
                    {/*
                      `sound_info`'s stream/table counterpart. Same reasoning: no design declares
                      it (the Android app, not a renderer, reads it), so hand-built here is its
                      only home. A sender cannot ask for a noise on routine stream entries either —
                      whether a room wants one is the room's decision, off unless it says otherwise.
                    */}
                    <label style={{ marginLeft: 12 }}>
                      <input
                        type="checkbox"
                        aria-label={`Card ${i + 1} chime on new entries`}
                        checked={(c.config as any).chime_activity === true}
                        onChange={(e) => setCellConfig(it.id, { chime_activity: e.target.checked })}
                      /> chime on new entries
                    </label>
                  </>
                )}
                <CellConfig i={i} cell={c} feeds={feeds} previews={previews} ensurePreview={ensurePreview}
                  setCellConfig={(patch) => setCellConfig(it.id, patch)} replaceCellConfig={(config) => replaceCellConfig(it.id, config)}
                  onFeedsChanged={refreshFeeds}
                  connection={cellConnections[it.id]}
                  themeWidgets={themeWidgets}
                  onChangeConnection={SEMANTIC_WIDGETS.has(c.widget)
                    ? () => setSetupTarget({ widget: c.widget as SetupTarget['widget'], cellId: it.id })
                    : undefined} />
              </div>

              {/*
                ALIGNMENT — where the card sits, and how big. The presets were a bare row of
                unlabelled buttons floating above four unlabelled numbers, which said nothing about
                what either did or that they were the same control at two levels of precision.
              */}
              <div className="edit-card">
                <div className="edit-card-head"><h3>Alignment</h3></div>
                <div className="preset-grid">
                  {PRESETS.map((p) => (
                    <button key={p.label} type="button" className="preset"
                      aria-label={`Card ${i + 1} preset ${p.label}`} title={p.label}
                      onClick={() => setRect(it.id, p.rect)}>
                      <PresetIcon rect={p.rect} />
                      <span>{p.label}</span>
                    </button>
                  ))}
                </div>
                {/* Position on one line, size on the next — they answer different questions. */}
                {([['x', 'y'], ['w', 'h']] as (keyof Rect)[][]).map((row) => (
                <div className="rect-fields" key={row.join()}>
                {row.map((k) => (
                  <label key={k}>{k}{' '}
                    <input type="number" step={0.001} min={k === 'w' || k === 'h' ? RECT_MIN : 0} max={1}
                      // c.rect can be null/missing (corrupt row) — `?.` avoids the pre-existing
                      // crash that reads `.x` etc. off it directly. Deliberately NOT routed
                      // through safeRect: for the {x:'a'}-shaped case the raw bad value must stay
                      // visible so the operator can see and fix it, not get silently coerced away.
                      aria-label={`Card ${i + 1} ${k}`} value={c.rect?.[k] ?? ''} style={{ width: 70 }}
                      // Quantized on blur, not on every keystroke — quantizing on change fed the
                      // rounded value straight back into this controlled input, so typing a 4th
                      // decimal (e.g. 0.3333) got snapped back to 0.333 immediately, eating the
                      // keystroke and blocking any precision finer than the grid. Cost: rectValid's
                      // isFrac needs an exact 0.001 multiple, so w/h can now sit off-grid while
                      // mid-edit — "card N has an invalid rect" can appear and disable submit
                      // between keystrokes, until blur quantizes it back on-grid. No unquantized
                      // value reaches the server either way: the disabled submit button gates it,
                      // and admin.ts's rectCheck re-validates server-side regardless.
                      // An EMPTY field is not zero. `Number('')` is 0, so selecting the contents
                      // and typing snapped the card to the origin before the first digit landed —
                      // and under a comma locale the browser reports '' for a half-typed "0,"
                      // too, so the same jump happened mid-entry. An unparseable field leaves the
                      // rect where it was; blur is what commits.
                      onChange={(e) => {
                        const v = Number(e.target.value)
                        if (e.target.value !== '' && Number.isFinite(v)) setRect(it.id, { [k]: v } as Partial<Rect>)
                      }}
                      onBlur={(e) => setRect(it.id, { [k]: quantize(Number(e.target.value)) } as Partial<Rect>)} />
                  </label>
                ))}
                </div>
                ))}
              {(() => {
                // Only the WARNING survives here. The size and the device it is measured against
                // are already stated above the canvas, and repeating them under every card said
                // the same thing twice while burying the one line that is not always true.
                const bad = undersized.get(it.id)
                if (!bad) return null
                return (
                  <p className="card-warn">
                    too small for {bad.widget} — needs {bad.min.w}&times;{bad.min.h}
                  </p>
                )
              })()}
              </div>
            </div>
            )
          })()}
          {placementError && <p style={{ color: '#c00' }}>{placementError}</p>}
          {/* A warning, deliberately not a save blocker: the same screen may be assigned to a
              larger device tomorrow, and refusing to store a layout because ONE target is small
              would make the editor lie about what the data model allows. */}
          {undersized.size > 0 && (
            <p aria-label="undersized warning" style={{ color: '#a60', fontSize: 12 }}>
              {undersized.size} card{undersized.size > 1 ? 's' : ''} too small on {targetDevice!.name}:{' '}
              {[...undersized.values()].map((u) => `${u.widget} is ${u.px.w}\u00d7${u.px.h}, needs ${u.min.w}\u00d7${u.min.h}`).join('; ')}
            </p>
          )}
          {/*
            Sounds — a SCREEN-level concern, not a per-card one (unlike "chime on info alerts"
            above, which belongs to a specific alert_feed cell). It sits between the per-card
            sections and the submit row: screen-wide settings read as the last thing before
            saving. Only offered once a screen exists to PATCH: an unsaved new layout has no id,
            and `setScreenSounds` needs one. Every control inside is type="button" — nothing
            here may submit the form.
          */}
          {editingId && (
            <div className="edit-card">
              <div className="edit-card-head"><h3>Sounds</h3></div>
              <SoundMixer
                families={manifest.families}
                rev={manifest.rev}
                value={soundsOverride}
                suggestion={soundsSuggestion}
                suggestionLabel="from theme"
                onChange={(sounds) => setScreenSounds(editingId, sounds)}
              />
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
                <span style={{ width: 130, fontSize: 13 }}>Test on device</span>
                {testDevices.length > 0 ? (
                  <>
                    <select
                      aria-label="Test sounds on device"
                      value={selectedTestDevice?.id ?? ''}
                      onChange={(e) => setTestDeviceId(e.target.value)}
                    >
                      {testDevices.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                    </select>
                    {selectedTestDevice && (
                      <button
                        type="button"
                        aria-label={playingMixOn
                          ? `Playing on ${playingDeviceName}…`
                          : `Play this mix on ${selectedTestDevice.name}`}
                        disabled={playingMixOn !== null}
                        onClick={() => { void playMixOnDevice(selectedTestDevice.id) }}
                      >
                        {playingMixOn ? `▶ Playing on ${playingDeviceName}…` : '▶ Play this mix'}
                      </button>
                    )}
                  </>
                ) : (
                  <span className="hint">No online device to test sounds on.</span>
                )}
              </div>
              {assignedTestDevices.length === 0 && testDevices.length > 0 && (
                <p className="hint">No device is showing this screen — picking from any online device instead.</p>
              )}
            </div>
          )}
          <button type="submit" disabled={!!placementError}>
            <IconSave />{cells.some((cell) => (
              typeof cell.config.source_draft_id === 'string' && ownedDrafts.current.has(cell.config.source_draft_id)
            )) ? 'Save screen & connections' : editingId ? 'Save layout' : 'Create layout'}
          </button>
          <button type="button" aria-label="Cancel screen editing" onClick={cancelEdit} style={{ marginLeft: 8 }}>Cancel</button>
          {error && <p style={{ color: '#c00' }}>{error}</p>}
        </form>

        <div>
          <LayoutCanvas
            items={items}
            aspect={aspect}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onRectChange={(id, rect) => setRect(id, rect)}
            labelFor={(c, id) => cellLabel(c, feeds, cellConnections[id])}
            overlappingIds={overlappingIds}
            pendingIds={new Set(items.filter((item) => (
              typeof item.cell.config.source_draft_id === 'string' && ownedDrafts.current.has(item.cell.config.source_draft_id)
            )).map((item) => item.id))}
            undersizedIds={new Set(undersized.keys())}
            onDropWidget={dropWidget}
          />
          {/*
            The board is the thing being worked on, so the controls sit UNDER it — where you look
            after judging a change, not above it where they push the board down the page. Choosing
            a target device and adding a card both act on what is directly above them.
          */}
          <div className="board-controls">
          {targetDevice && targetPx ? (
            <div className="board-bar">
              <label>Designing for{' '}
                <select
                  aria-label="Target device"
                  value={targetDevice.id}
                  onChange={(e) => setTargetDeviceId(e.target.value)}
                >
                  {measuredDevices.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name} — {d.viewport_w}&times;{d.viewport_h}
                      {d.screen_id === editingId ? ' (assigned)' : ''}
                    </option>
                  ))}
                </select>
              </label>{' '}
              <span style={{ color: '#666' }}>
                {targetPx.w}&times;{targetPx.h} CSS px
                {targetDevice.viewport_dpr ? ` @${targetDevice.viewport_dpr}x` : ''}
              </span>
              {targetPeers.length > 0 && (
                <span style={{ color: '#a60' }}>
                  {' '}· also on {targetPeers.map((d) => d.name).join(', ')}
                </span>
              )}
            </div>
          ) : (
            <label>Target shape{' '}
              <select aria-label="Target shape" value={shapeLabel} onChange={(e) => { setShapeTouched(true); setShapeLabel(e.target.value) }}>
                {TARGET_SHAPES.map((s) => <option key={s.label} value={s.label}>{s.label}</option>)}
              </select>
              <span style={{ color: '#666', fontSize: 11 }}>
                {' '}— no assigned device has reported its size yet, so this is a guess
              </span>
            </label>
          )}
            {/* Finish-setup prompt for the screen pairing seeds (one full-bleed clock): the two
                widgets the starter deliberately couldn't pre-bind — weather wants a location and
                a calendar an ICS URL — offered through the same widget-first flow as any cell.
                Pure shape derivation, no persisted flag: adding anything makes it disappear. */}
            {cells.length === 1 && cells[0].widget === 'clock'
              && cells[0].rect.x === 0 && cells[0].rect.y === 0
              && cells[0].rect.w === 1 && cells[0].rect.h === 1 && (
              <p style={{ color: 'var(--ink-soft)' }}>
                Just a clock so far —{' '}
                <button type="button" onClick={() => chooseWidget('weather_forecast')}>Add weather</button>{' '}
                <button type="button" onClick={() => chooseWidget('calendar_events')}>Add a calendar</button>
              </p>
            )}
            {cells.length < 12 && (
              <div className="add-row">
                <button type="button" onClick={() => setGalleryOpen(true)}><IconPlus />Add widget</button>
              </div>
            )}
            {galleryOpen && (
              <div className="edit-card" aria-label="Choose a widget">
                <div className="edit-card-head">
                  <h3>Add widget</h3>
                  <button type="button" onClick={() => setGalleryOpen(false)}>Close widget gallery</button>
                </div>
                <WidgetGallery onSelect={chooseWidget} />
              </div>
            )}
          </div>
          {/* Target info bar (SenseCraft lesson): pinned under the schematic; e-ink profiles add
              resolution/color-depth/dither info here later. */}
          {/*
            The count belongs to the BOARD, not to the button row — it sat between Add card and
            Save layout saying "4/12 cards", which read as a third action. Here it answers the
            question it exists for: how much room is left on this layout.
          */}
          <p style={{ fontSize: 12, color: 'var(--muted)' }}>
            {orientation} · Android &amp; browser · color · {items.length} of 12 cards
          </p>
        </div>
      </div>
      </>)}
      {setupTarget && (
        <SourceSetupDialog
          widget={setupTarget.widget}
          config={setupTarget.cellId
            ? items.find((item) => item.id === setupTarget.cellId)?.cell.config ?? defaultConfig(setupTarget.widget)
            : defaultConfig(setupTarget.widget)}
          onUse={useSource}
          onCancel={() => setSetupTarget(null)}
        />
      )}
      {confirmDialog}
    </section>
  )
}
