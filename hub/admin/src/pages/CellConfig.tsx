import { useEffect } from 'react'
// Reuse the shipped resolver — do not reimplement it. This is the SAME module the
// device renderer imports; what the operator sees while typing a path must equal what the device
// draws, or the whole point of a live preview is defeated.
// @ts-expect-error plain JS module without types
import { resolvePath, displayValue, feedScalarSource } from '../../../static/device/layout-core.mjs'
// @ts-expect-error plain JS module without types
import { designIdsFor } from '../../../static/device/widgets/catalogue.mjs'
import type { Cell, FeedDetail, FeedRow, Widget } from './Screens'
import DataSourcePicker from './DataSourcePicker'
import WidgetPreview from './WidgetPreview'
import { newListRow, optionFields, seedItemValue, type ItemField, type OptionField } from '../widget-options'
import { designFor } from '../design-registry'

export interface CellConnectionView {
  name: string
  provider: string
  preview: unknown
  missingOptional: string[]
  draftId?: string
}

export interface CellConfigProps {
  i: number
  cell: Cell
  feeds: FeedRow[]
  /** GET /admin/api/feeds/:id responses, cached by feed id — fetched once per feed selection. */
  previews: Record<string, FeedDetail>
  ensurePreview: (feedId: string) => void
  /** Shallow-merges patch into this cell's config (same semantics as the old setFeedConfig). */
  setCellConfig: (patch: Record<string, unknown>) => void
  /** Fully replaces this cell's config — needed when text_block's shape flips text <-> feed+path,
   * since a merge would leave stale keys AJV's additionalProperties:false would then reject. */
  replaceCellConfig: (config: Record<string, unknown>) => void
  /**
   * Re-read the feed list. The picker can now CREATE a data source, so the parent's list is stale
   * the moment it does — without this the cell is correctly bound to a feed the editor can only
   * show as a raw id.
   */
  onFeedsChanged: () => void
  connection?: CellConnectionView
  onChangeConnection?: () => void
  /** This screen's theme's per-widget design choice (theme resolution tier 2), keyed by widget
   * type — bare design ids, same shape `index.mjs`'s `designFor` reads at render time. Absent
   * when the screen has no theme assigned (or hasn't been saved yet), same as the device side. */
  themeWidgets?: Record<string, string>
}

const DATA_WIDGETS: Widget[] = ['value_tile', 'gauge', 'stream_list', 'table', 'text_block', 'chart', 'image']
// Asked of the renderer's registry, never mirrored. A hand-written copy of the catalogue lived
// here and in Themes.tsx until adding the nixie design left both stale, so a design shipped that
// nothing could select. An unknown design id still degrades safely at render time — that is the
// reason the schema does not enumerate ids — but "degrades safely" was never the same thing as
// "reachable".

// Widgets whose config carries a plain top-level `feed` that this component resolves a live
// preview for. chart binds per-series (config.series[].feed) instead, and image has no path to
// preview (it renders the feed's bytes directly) — both fall outside this set so their `feed`
// value (image's) or absence (chart's) never triggers an unneeded GET /admin/api/feeds/:id.
const PREVIEW_WIDGETS: Widget[] = ['value_tile', 'gauge', 'stream_list', 'table', 'text_block']

/** Widgets whose config carries a single `path`, i.e. the ones a suggested path can be filled into. */
const PATH_WIDGETS: Widget[] = ['value_tile', 'gauge', 'table', 'text_block']

type Cfg = Record<string, any>

/**
 * The patch that writes `value` at a dotted `path` through a SHALLOW-merging `setCellConfig`.
 *
 * A flat path is the old `{ [name]: value }` verbatim. A nested one has to send the whole
 * top-level object, because the merge replaces that key outright: writing `thresholds.warn` as
 * `{ thresholds: { warn: 70 } }` would drop a `crit` the operator set a moment earlier, silently,
 * on every edit — the cell would still save, and the knob would just be gone. So every level is
 * rebuilt from what is already there and only the leaf changes.
 *
 * The base at each level is an existing plain object or `{}`: an array or a scalar sitting where a
 * path expects an object is a config this widget's own save schema would reject anyway, and
 * spreading it would produce a stranger shape than starting clean does.
 *
 * Reading is `resolvePath` from `layout-core.mjs` (imported above, already used for the path
 * preview) — the shipped resolver, not a second one written here to drift from it.
 */
function patchAtPath(cfg: Cfg, path: string, value: unknown): Record<string, unknown> {
  const [head, ...rest] = path.split('.')
  if (rest.length === 0) return { [head]: value }
  const existing = cfg?.[head]
  const base: Cfg = existing !== null && typeof existing === 'object' && !Array.isArray(existing) ? existing : {}
  return { [head]: { ...base, ...patchAtPath(base, rest.join('.'), value) } }
}

/**
 * The CONTROL for one declared option — the input/select/checkbox itself, and nothing around it.
 *
 * Deliberately just the control: a top-level option wraps it in a `<label>` that prints its name,
 * a row inside a `list` puts it bare in a line of siblings with the label as its placeholder. Those
 * two wrappers are the only difference between the two places a field is drawn, so this is the one
 * copy of "what does a `number` option look like" — a second copy for list rows is exactly how the
 * generated and hand-built halves of this file drifted apart three times before.
 *
 * `undefined` on an empty NUMBER input means UNSET, the convention `renderScaleInput` and the
 * generated fields have always used: an absent optional number is not zero. An empty TEXT input
 * writes `''` and is left to the caller to read as empty-or-unset — a top-level text option has
 * always written `''` there (`value_tile`'s `label`, cleared, is an empty label), and only a
 * repeating row has a key it could delete instead.
 */
type ControlSpec = { type: string; label: string; default?: unknown; min?: number; max?: number; choices?: string[] }

function optionControl(spec: ControlSpec, value: unknown, write: (next: unknown) => void, aria: string, placeholder?: string) {
  if (spec.type === 'boolean') {
    return (
      <input type="checkbox" aria-label={aria}
        checked={typeof value === 'boolean' ? value : Boolean(spec.default)}
        onChange={(e) => write(e.target.checked)} />
    )
  }
  if (spec.type === 'number') {
    // `spec.default` may be `undefined` (a design that declares no default
    // at all, e.g. value_tile's `decimals`). Falling back to `''` rather than `undefined` keeps the
    // input a CONTROLLED one on every render — an `undefined` `value` prop would make it
    // uncontrolled until the first real number arrived, which React warns about when it switches.
    const numberFallback = typeof spec.default === 'number' ? spec.default : ''
    return (
      <input type="number" aria-label={aria} placeholder={placeholder} min={spec.min} max={spec.max}
        value={typeof value === 'number' ? value : numberFallback}
        onChange={(e) => write(e.target.value === '' ? undefined : Number(e.target.value))} />
    )
  }
  if (spec.type === 'select') {
    // Same `''` fallback reasoning as the number branch above, for a select whose design omits a
    // default — `table`'s `align` declares one (`left`), `chart`'s `icon` does not.
    const selectFallback = typeof spec.default === 'string' ? spec.default : ''
    return (
      <select aria-label={aria} value={typeof value === 'string' ? value : selectFallback}
        onChange={(e) => write(e.target.value)}>
        {(spec.choices ?? []).map((choice) => <option key={choice} value={choice}>{choice}</option>)}
      </select>
    )
  }
  const textFallback = typeof spec.default === 'string' ? spec.default : ''
  return (
    <input type="text" aria-label={aria} placeholder={placeholder}
      value={typeof value === 'string' ? value : textFallback}
      onChange={(e) => write(e.target.value)} />
  )
}

/**
 * One row of a `list`, with `key` set or DELETED — never left as `undefined`.
 *
 * Both repeating save schemas are `additionalProperties: false` with required item keys, so the row
 * that goes over the wire must carry exactly the keys the schema names. Emptying an OPTIONAL field
 * therefore deletes its key (`chart`'s `label`, cleared, is a series with no label — what
 * `ChartSeriesEditor` wrote by hand); emptying a REQUIRED one cannot delete anything, so it falls
 * back to what a fresh row would have started it as (`table`'s `header`, cleared, is `''` — what
 * `renderTableFields` wrote by hand).
 */
function rowWith(row: Record<string, unknown>, item: ItemField, next: unknown, rows: Record<string, unknown>[]): Record<string, unknown> {
  // A text/feed control says "empty" with `''`, a number control with `undefined`; a select and a
  // checkbox never say it at all.
  const emptied = next === undefined || (next === '' && (item.type === 'text' || item.type === 'feed'))
  const value = emptied ? (item.required ? seedItemValue(item, rows) : undefined) : next
  const merged = { ...row }
  if (value === undefined) delete merged[item.name]
  else merged[item.name] = value
  return merged
}

/**
 * Tiny local adapter: GET /admin/api/feeds/:id returns admin-only extras
 * (name, cap, references, ...) beyond the DATA wire shape feedScalarSource reads. Project down to
 * exactly {mode, payload, rows} rather than bending either the admin API or the device resolver.
 */
const toWire = (d: FeedDetail): { mode: FeedDetail['mode']; payload: unknown; rows: { payload: unknown }[] } => ({
  mode: d.mode,
  payload: d.payload,
  rows: d.rows,
})

export default function CellConfig({
  i, cell, feeds, previews, ensurePreview, setCellConfig, replaceCellConfig, onFeedsChanged,
  connection, onChangeConnection, themeWidgets,
}: CellConfigProps) {
  const cfg = cell.config as Cfg
  const feedId = typeof cfg.feed === 'string' ? cfg.feed : ''

  useEffect(() => {
    // Only the preview-capable widgets ever resolve a path against this feed's payload (chart
    // binds per-series instead of config.feed, and image has no path to preview) — gating here
    // keeps picking an image feed from firing a GET /admin/api/feeds/:id nothing will render.
    if (feedId && PREVIEW_WIDGETS.includes(cell.widget)) ensurePreview(feedId)
  }, [feedId, cell.widget, ensurePreview])

  const designs = designIdsFor(cell.widget) as string[]
  const designPicker = designs.length === 0 ? null : (
    <label style={{ marginLeft: 12 }}>design{' '}
      <select aria-label={`Cell ${i + 1} design`}
        value={typeof cfg.design === 'string' ? cfg.design : ''}
        onChange={(e) => {
          // Clearing must DELETE the key: `additionalProperties: false` accepts `design` as a
          // string, and a merge that left `design: ''` behind would fail the schema's minLength.
          if (e.target.value) { replaceCellConfig({ ...cfg, design: e.target.value }); return }
          const rest = { ...cfg }
          delete rest.design
          replaceCellConfig(rest)
        }}>
        <option value="">theme default</option>
        {designs.map((d) => <option key={d} value={d}>{d}</option>)}
      </select>
    </label>
  )

  // The design this cell will actually render with — three-tier precedence (cell -> theme ->
  // registry default), delegated to design-registry.ts's designFor rather than reimplemented here.
  // That module imports registry.mjs's `lookup`/`defaultDesignFor`
  // directly, so this file never re-derives the registry's own tie-breaking or forgets the
  // theme's tier the way an inline copy did.
  const resolvedDesign = designs.length === 0
    ? null
    : designFor(cell.widget, typeof cfg.design === 'string' ? cfg.design : '', themeWidgets)

  // Generated from the resolved design's `meta.options`. Rendered
  // ALONGSIDE whatever hand-built per-widget branch still exists below; a field a design generates
  // here is deleted from the hand-built branch as each widget migrates (for
  // `value_tile`'s `label`/`unit`), so the two never draw the SAME knob twice.
  //
  // An option may declare a dotted `path`, so a NESTED knob is generable too — the
  // reason `gauge`'s `thresholds.warn`/`.crit`, `alert_feed`/`stream_list`'s `clamp.*` and
  // `alert_feed`/`stream_list`/`table`'s `overflow.counter` were hand-built here (or, for the
  // clamps, had no control at all) has been removed, and every one of them is a declared option
  // now.
  //
  // An option may declare `type: 'list'`, a REPEATING GROUP, which is the last thing that
  // kept a knob hand-built here. `table`'s `columns` and `chart`'s `series` are declared options on
  // `table/grid.mjs` and `chart/plot.mjs` now, so `renderTableFields`'s column editor and the whole
  // of `ChartSeriesEditor.tsx` are DELETED — not left beside the generated block, which is this
  // file's own rule above and the bug `image.fit`, `alert_feed.min_severity` and the
  // `calendar_events` save failure each were. What is left hand-built below is a knob deliberately
  // kept out of the renderer's vocabulary: `chart`'s data window (`window_s`/`y_min`/`y_max`), the
  // shared `feed`/`path`/`scale` every data widget has, and `alert_feed`'s `sound_info` — read by
  // the Android app, never by a design.
  const generatedFields = optionFields(resolvedDesign ?? {})

  /**
   * A `list`'s rows: each one drawing its item fields, plus add and remove.
   *
   * `min`/`max` are the schema's `minItems`/`maxItems`, and the buttons are the only thing standing
   * between an operator and a 400 they cannot read — the grid is PATCHed whole, so a fifth column
   * loses every unsaved edit on the screen with a message about an array length. Remove disappears
   * at `min`; Add disappears at `max`.
   */
  const renderList = (field: OptionField, rows: Cfg[], writeRows: (next: Cfg[]) => void) => {
    const items = field.item ?? []
    // Both are required by `validateList`, so the fallbacks are unreachable — they exist so a
    // hypothetically-unbounded list refuses to grow rather than growing without limit.
    const min = field.min ?? 0
    const max = field.max ?? rows.length
    const writeCell = (ri: number, item: ItemField, next: unknown) =>
      writeRows(rows.map((row, j) => (j === ri ? rowWith(row, item, next, rows) : row)))
    return (
      <div key={field.name} style={{ marginTop: 4 }}>
        {rows.map((row, ri) => (
          <div key={ri} style={{ marginLeft: 12, marginTop: 2 }}>
            {items.map((item, ii) => {
              const aria = `Cell ${i + 1} ${field.label} ${ri + 1} ${item.label}`
              // A feed binding, not free text. The SAME picker every other data widget gets,
              // filtered by the host widget's own declared modes (`bindings.mjs`'s
              // `feedModesFor`) — so a chart series still offers stream feeds and nothing else,
              // and "add an RSS feed" still does not mean leaving the editor. Its aria label is
              // the picker's own convention, `<prefix> feed`, unchanged from the hand-built
              // editor this replaces.
              if (item.type === 'feed') {
                return (
                  <DataSourcePicker key={item.name} label={`Cell ${i + 1} ${field.label} ${ri + 1}`}
                    widget={cell.widget} feeds={feeds}
                    // THIS row's own binding, not the whole cell's — a chart series is judged on
                    // its own y_path, exactly as the save judges it. Asking with all four series
                    // would hide every feed that does not happen to satisfy the other three.
                    config={{ [field.name]: [row] }}
                    value={typeof row[item.name] === 'string' ? (row[item.name] as string) : ''}
                    onChange={(id) => writeCell(ri, item, id)}
                    onFeedCreated={onFeedsChanged} />
                )
              }
              return (
                <span key={item.name} style={{ marginLeft: ii === 0 ? 0 : 4 }}>
                  {optionControl(item, row[item.name], (next) => writeCell(ri, item, next), aria, item.label)}
                </span>
              )
            })}
            {rows.length > min && (
              <button type="button" style={{ marginLeft: 4 }}
                onClick={() => writeRows(rows.filter((_, j) => j !== ri))}>Remove {field.label}</button>
            )}
          </div>
        ))}
        {rows.length < max && (
          <button type="button" style={{ marginLeft: 12, marginTop: 2 }}
            onClick={() => writeRows([...rows, newListRow(field, rows)])}>Add {field.label}</button>
        )}
      </div>
    )
  }

  const generatedOptionsBlock = generatedFields.length === 0 ? null : (
    <details style={{ marginTop: 8 }}>
      <summary>Design options</summary>
      {generatedFields.map((field) => {
        // `field.path` is the option's own name unless the design declared a dotted one, so the
        // flat case reads and writes exactly what `cfg[field.name]`/`{ [field.name]: v }` did.
        // A `list` never declares one, so its path IS its name and this writes the whole array
        // back at the top level — the same `setCellConfig({ columns: … })` the hand-built editor
        // made.
        const value = resolvePath(cfg, field.path)
        const write = (next: unknown) => setCellConfig(patchAtPath(cfg, field.path, next))
        if (field.type === 'list') {
          return renderList(field, (Array.isArray(value) ? value : []) as Cfg[], write)
        }
        const aria = `Cell ${i + 1} ${field.label}`
        const control = optionControl(field, value, write, aria)
        // A checkbox reads label-after-control; everything else reads label-before.
        return field.type === 'boolean'
          ? <label key={field.name} style={{ marginLeft: 12 }}>{control} {field.label}</label>
          : <label key={field.name} style={{ marginLeft: 12 }}>{field.label}{' '}{control}</label>
      })}
    </details>
  )

  const pickers = <>{designPicker}</>

  if (cell.widget === 'weather_forecast' || cell.widget === 'news_list' || cell.widget === 'calendar_events') {
    const savedName = feeds.find((feed) => feed.id === feedId)?.name
    const connectionName = connection?.name ?? savedName ?? 'Saved connection'
    const pending = typeof cfg.source_draft_id === 'string'
    /**
     * The hand-built knobs, per widget — and ONLY ever that widget's own.
     *
     * This was a BINARY (`cell.widget === 'weather_forecast' ? days+flags : items+flags`), which
     * meant the else arm was not "news_list" but "any semantic widget that is not weather". When
     * `calendar_events` joined the branch it silently inherited the news arm and was handed
     * `items`, `show_summary`, `show_source` and `show_time` — four keys its own schema
     * (`semanticConfig`, `additionalProperties: false`) rejects. Touching any one of them wrote a
     * key that 400s the WHOLE grid PATCH (`cell N (calendar_events): unknown config key "items"`),
     * losing every unsaved edit on the screen, while `events`/`show_location` — the two knobs
     * `calendar/agenda.mjs` actually reads — had no control at all.
     *
     * Every arm is now keyed on its own widget name with a `null` fallback, so a widget can only
     * ever be handed controls written for it: a new semantic widget gets NO hand-built block until
     * someone writes one, rather than quietly inheriting the last arm in the chain.
     * `calendar_events` is that case today — its knobs are declared `meta.options` on
     * `calendar/agenda.mjs` and drawn by `generatedOptionsBlock` below, which is why it needs no
     * arm here.
     */
    const handBuiltOptions = cell.widget === 'weather_forecast' ? (
      <>
        <label style={{ marginLeft: 12 }}>days{' '}
          <input aria-label={`Cell ${i + 1} days`} type="number" min={5} max={7}
            value={typeof cfg.days === 'number' ? cfg.days : 5}
            onChange={(event) => setCellConfig({ days: Number(event.target.value) })} />
        </label>
        {[
          ['show_humidity', 'humidity'], ['show_precipitation', 'precipitation'],
          ['show_wind', 'wind'], ['show_pollen', 'pollen'],
        ].map(([key, label]) => (
          <label key={key} style={{ marginLeft: 12 }}>
            <input type="checkbox" checked={cfg[key] === true}
              onChange={(event) => setCellConfig({ [key]: event.target.checked })} /> {label}
          </label>
        ))}
      </>
    ) : cell.widget === 'news_list' ? (
      <>
        <label style={{ marginLeft: 12 }}>items{' '}
          <input aria-label={`Cell ${i + 1} items`} type="number" min={1} max={10}
            value={typeof cfg.items === 'number' ? cfg.items : 5}
            onChange={(event) => setCellConfig({ items: Number(event.target.value) })} />
        </label>
        {[
          ['show_summary', 'summaries'], ['show_source', 'sources'], ['show_time', 'times'],
        ].map(([key, label]) => (
          <label key={key} style={{ marginLeft: 12 }}>
            <input type="checkbox" checked={cfg[key] === true}
              onChange={(event) => setCellConfig({ [key]: event.target.checked })} /> {label}
          </label>
        ))}
      </>
    ) : null
    return (
      <div style={{ marginTop: 4 }}>
        {pickers}
        <div style={{ marginTop: 8 }}>
          <strong>{connectionName}</strong>
          {connection?.provider && <span> · {connection.provider}</span>}
          {pending && <strong style={{ display: 'block' }}>Not saved yet</strong>}
          {onChangeConnection && (
            <button type="button" style={{ marginLeft: 12 }} onClick={onChangeConnection}>Change connection</button>
          )}
        </div>
        {connection && (
          <WidgetPreview
            widget={cell.widget}
            config={cfg}
            data={connection.preview}
            width={cell.widget === 'weather_forecast' ? 600 : 360}
            height={cell.widget === 'weather_forecast' ? 280 : 480}
          />
        )}
        {handBuiltOptions && (
          <details style={{ marginTop: 8 }}>
            <summary>Widget options</summary>
            {handBuiltOptions}
          </details>
        )}
        {generatedOptionsBlock}
      </div>
    )
  }

  // Every widget accepts `design` (screen editor behavior), which is why the picker is computed above this
  // early return rather than after it — a clock is a non-data widget with no other config UI,
  // so without this it would get no config UI at all. `generatedOptionsBlock` must reach this
  // path too: a future clock design could declare options, and this
  // block is the only config UI a non-data widget ever gets.
  if (!DATA_WIDGETS.includes(cell.widget)) return <>{pickers}{generatedOptionsBlock}</>

  /**
   * The data source question, asked from the widget's side (schema wording). This was a bare `<select>` of
   * feeds that took a hand-passed `'any' | 'stream' | 'image'` filter at each call site — a third
   * hand-maintained copy of a rule the hub also enforces, which had already drifted from it. The
   * filter is WIDGET_BINDINGS now, and the control offers creating a source as well as choosing
   * one; see DataSourcePicker.
   */
  const renderFeedSelect = () => (
    <DataSourcePicker
      label={`Cell ${i + 1}`}
      widget={cell.widget}
      value={feedId}
      feeds={feeds}
      config={cell.config}
      onChange={(id) => setCellConfig({ feed: id })}
      onFeedCreated={onFeedsChanged}
      // Offered only where there is a `path` field for it to fill — stream_list reads
      // title_path/body_path instead, and image has no path at all.
      onSuggestPath={PATH_WIDGETS.includes(cell.widget) ? (path) => setCellConfig({ path }) : undefined}
    />
  )

  // path + live preview: shared by value_tile, gauge, table (array location), text_block feed
  // mode. Empty path resolves to the whole payload (same as the renderers' normalizers — path
  // defaults to '', never null, so the preview matches device.js exactly.
  const renderPathPreview = () => {
    const detail = feedId ? previews[feedId] : undefined
    const source = detail ? feedScalarSource(toWire(detail)) : undefined
    const pathVal = typeof cfg.path === 'string' ? cfg.path : ''
    const previewText = displayValue(resolvePath(source, pathVal), 'raw', null)
    return (
      <label style={{ marginLeft: 12 }}>
        path{' '}
        <input aria-label={`Cell ${i + 1} path`} placeholder="dot.separated.path" value={pathVal}
          onChange={(e) => setCellConfig({ path: e.target.value })} />
        {' → '}
        <span aria-label={`Cell ${i + 1} preview`} style={{ fontFamily: 'monospace' }}>{previewText}</span>
      </label>
    )
  }

  const renderScaleInput = () => (
    <label style={{ marginLeft: 12 }}>
      scale{' '}
      <input aria-label={`Cell ${i + 1} scale`} type="number" min={0.5} max={2} step={0.1} style={{ width: 60 }}
        value={typeof cfg.scale === 'number' ? cfg.scale : ''}
        onChange={(e) => setCellConfig({ scale: e.target.value === '' ? undefined : Number(e.target.value) })} />
      {/* Shared `card` knob (cellSchema cardProp): unchecked writes card:false (opt out of the
          `cards` backdrop's chrome for this one cell); checked writes nothing — "card when the
          theme says cards" is the unset default, and a stored `true` would just restate it. */}
      <label style={{ marginLeft: 12 }}>
        <input aria-label={`Cell ${i + 1} card`} type="checkbox"
          checked={cfg.card !== false}
          onChange={(e) => setCellConfig({ card: e.target.checked ? undefined : false })} /> card
      </label>
    </label>
  )

  const renderTextFields = () => {
    // No merge here: text_block's config is a strict XOR (text OR feed+path, never both — save-
    // time schema is additionalProperties:false on each branch) so switching modes must replace
    // the whole config, not patch it, or a stale key from the old shape would 400 on save.
    const mode: 'text' | 'feed' = Object.prototype.hasOwnProperty.call(cfg, 'feed') ? 'feed' : 'text'
    const scaleCarry = typeof cfg.scale === 'number' ? { scale: cfg.scale } : {}
    const radioName = `cell-${i}-text-mode`
    return (
      <>
        <span style={{ marginLeft: 12 }}>
          <label>
            <input type="radio" name={radioName} checked={mode === 'text'}
              onChange={() => replaceCellConfig({ text: '', ...scaleCarry })} /> text
          </label>
          <label style={{ marginLeft: 8 }}>
            <input type="radio" name={radioName} checked={mode === 'feed'}
              onChange={() => replaceCellConfig({ feed: '', path: '', ...scaleCarry })} /> feed binding
          </label>
        </span>
        {mode === 'text'
          ? (
            <div style={{ marginTop: 4 }}>
              <textarea aria-label={`Cell ${i + 1} text`} rows={2} style={{ width: '90%' }}
                value={typeof cfg.text === 'string' ? cfg.text : ''}
                onChange={(e) => setCellConfig({ text: e.target.value })} />
            </div>
            )
          : <>{renderFeedSelect()}{renderPathPreview()}</>}
      </>
    )
  }

  // `style` is NOT here: `chart/plot.mjs` declares it in `meta.options`, so the
  // generated block below renders it — labelled `Style`, the design's own wording — and a hand-built
  // copy would draw the same knob twice, the thing this file has removed once per migration
  // (`value_tile`'s label/unit, `stream_list`'s title/body paths).
  //
  // `series[]` is NOT here either: `plot.mjs` declares it as a `list`, so the
  // generated block draws the rows and `ChartSeriesEditor.tsx` — the picker, the y_path input, the
  // icon select, the unique-icon rule for an added row — is deleted rather than left beside its
  // generated replacement.
  //
  // `window_s`/`y_min`/`y_max` stay hand-built: they are flat and scalar and a `list` changes
  // nothing about them, but they are the chart's DATA WINDOW rather than a choice about how the
  // design looks — the same line `alert_feed`'s `sound_info` sits on the other side of.
  const renderChartFields = () => {
    return (
      <>
        <label style={{ marginLeft: 12 }}>window (s){' '}
          <input aria-label={`Cell ${i + 1} window_s`} type="number" min={5} style={{ width: 70 }}
            value={typeof cfg.window_s === 'number' ? cfg.window_s : ''}
            onChange={(e) => setCellConfig({ window_s: e.target.value === '' ? undefined : Number(e.target.value) })} />
        </label>
        <label style={{ marginLeft: 12 }}>y min{' '}
          <input aria-label={`Cell ${i + 1} y_min`} type="number" style={{ width: 70 }}
            value={typeof cfg.y_min === 'number' ? cfg.y_min : ''}
            onChange={(e) => setCellConfig({ y_min: e.target.value === '' ? undefined : Number(e.target.value) })} />
        </label>
        <label style={{ marginLeft: 12 }}>y max{' '}
          <input aria-label={`Cell ${i + 1} y_max`} type="number" style={{ width: 70 }}
            value={typeof cfg.y_max === 'number' ? cfg.y_max : ''}
            onChange={(e) => setCellConfig({ y_max: e.target.value === '' ? undefined : Number(e.target.value) })} />
        </label>
      </>
    )
  }

  // Image: the ONE widget whose feed select is filtered TO image mode rather
  // than away from it. No path/preview (it renders the feed's bytes, never queries a payload) and
  // no scale (its save schema at hub/src/routes/admin.ts has no scale property — see the
  // additionalProperties:false skip of renderScaleInput below).
  // `fit` is NOT here any more: `image/frame.mjs` declares it in `meta.options` (widget contract
  // screen state), so the generated `meta.options` block below already draws it
  // for chart's `style` and gauge's `label`/`unit`/`min`/`max`/`decimals`. A hand-built copy left
  // behind here would draw the SAME knob twice under two different labels ("Cell N fit" and
  // "Cell N Fit"), both writing `cfg.fit`, which is exactly the rule at this file's own docstring
  // above (line ~124) forbids.
  const renderImageFields = () => renderFeedSelect()

  const renderWidgetFields = () => {
    switch (cell.widget) {
      // value_tile's `label`/`unit`/`decimals` and gauge's `label`/`unit`/`min`/`max`/`decimals`
      // are both covered by the generated `meta.options` block below now, and gauge's
      // `thresholds.warn`/`.crit` are too — `renderGaugeThresholds`, the
      // hand-built pair that existed only because a generated field could not write a nested key,
      // is deleted. Nothing gauge-specific is left to draw by hand.
      case 'value_tile': return <>{renderFeedSelect()}{renderPathPreview()}</>
      case 'gauge': return <>{renderFeedSelect()}{renderPathPreview()}</>
      // `title_path`/`body_path` are covered by the generated `meta.options` block below (widget
      // contract stream data channel — `stream_list` is a canvas design, widgets/stream/list.mjs), and
      // nested options now cover `clamp.title_lines`/`clamp.body_lines`/`overflow.counter`, which had no
      // admin control at ALL before (there was never a hand-built one to remove for this widget).
      case 'stream_list': return <>{renderFeedSelect()}</>
      // `columns` was the last hand-built table knob and is a declared `list` now, so
      // what is left here is the shared feed/path pair every data widget has.
      case 'table': return <>{renderFeedSelect()}{renderPathPreview()}</>
      case 'text_block': return renderTextFields()
      case 'chart': return renderChartFields()
      case 'image': return renderImageFields()
      default: return null
    }
  }

  return (
    <div style={{ marginTop: 4 }}>
      {pickers}
      <details>
        <summary>Advanced</summary>
        {renderWidgetFields()}
        {/* image's save schema has no `scale` property (additionalProperties:false would 400 it) —
            every other data widget's does. */}
        {cell.widget !== 'image' && renderScaleInput()}
      </details>
      {generatedOptionsBlock}
    </div>
  )
}
