// @ts-expect-error plain JS module without types
import { WIDGET_MIN_PX } from '../../../static/device/layout-core.mjs'
// @ts-expect-error plain JS module without types
import { CATALOGUE } from '../../../static/device/widgets/catalogue.mjs'
// @ts-expect-error plain JS module without types
import { WIDGET_DEFINITIONS } from '../../../static/device/widgets/definitions.mjs'
// @ts-expect-error plain JS module without types
import { WIDGET_BINDINGS, bindsPhrase } from '../../../static/device/widgets/bindings.mjs'
import WidgetPreview from './WidgetPreview'

/**
 * The widget catalogue.
 *
 * This was a column of nine unlabelled buttons wedged beside the canvas in the screen editor — the
 * only place the set of widgets was ever written down, and the worst possible place to read it.
 * You cannot choose between things you cannot see, and the editor is where you go once you have
 * already chosen.
 *
 * EVERY card draws a REAL preview now: a design is `{ meta, draw }` over the portable subset, pure
 * and importable, so the admin hands it a canvas and gets the actual artwork. Every widget type now
 * has a canvas design, so WidgetPreview.tsx can draw the actual design for every widget.
 */

interface Design { meta: { id: string; widget: string; label: string } }

interface WidgetDefinition {
  id: string
  label: string
  description: string
  suggested_ratio: number
  minimum_px: { w: number; h: number }
  sample_config: Record<string, unknown>
  sample_data: unknown
}

function previewSize(definition: WidgetDefinition): { width: number; height: number } {
  const width = Math.max(definition.minimum_px.w, Math.round(definition.minimum_px.h * definition.suggested_ratio))
  return { width, height: Math.max(definition.minimum_px.h, Math.round(width / definition.suggested_ratio)) }
}

/**
 * `binds` is NOT written down here any more. It was, in these exact rows, and it was wrong:
 * value_tile and gauge said "a value feed" while the editor's filter and the hub's feedCheck had
 * both accepted stream feeds since the day they shipped. This page is where somebody goes to learn
 * what a widget takes, so the one copy written for humans was the one that lied. It now comes from
 * `WIDGET_BINDINGS` (bindings.mjs) — the same declaration the editor filters on and the hub
 * validates against — along with the payload line under each card.
 */
export default function Widgets() {
  const designs = CATALOGUE as Design[]
  const widgets = WIDGET_DEFINITIONS as WidgetDefinition[]
  return (
    <section>
      <h2>Widgets</h2>
      <p>
        {widgets.length} widget types. A screen is a grid of them, and each card names one — the sizes below are
        the minimum a card can be before the widget stops being legible, which the editor enforces
        against whatever device you are designing for.
      </p>
      {widgets.map((w) => {
        const min = (WIDGET_MIN_PX as Record<string, { w: number; h: number }>)[w.id]
        const mine = designs.filter((d) => d.meta.widget === w.id)
        const size = previewSize(w)
        const binding = (WIDGET_BINDINGS as Record<string, { payload: string }>)[w.id]
        return (
          <div className="edit-card" key={w.id} data-widget={w.id}>
            <div className="edit-card-head">
              {/* The human name leads; the slug is the wire word an agent or a sender needs, worn
                  as a small mono chip rather than pretending to be the title. */}
              <h3>
                {w.label}{' '}
                <code style={{ textTransform: 'none', letterSpacing: 0, fontWeight: 400 }}>{w.id}</code>
              </h3>
              <span style={{ fontSize: 12, color: 'var(--muted)' }}>
                min {min ? `${min.w}×${min.h}` : '—'} px · {binding ? `binds ${bindsPhrase(w.id)}` : 'uses compatible data'}
                {mine.length > 0 && ` · ${mine.length} design${mine.length > 1 ? 's' : ''}`}
              </span>
            </div>
            <p style={{ margin: 0 }}>{w.description}</p>
            {/* The payload expectation, from the same declaration — what to push, in one line.
                Labelled, because "nothing — the clock reads the device's own time." floating bare
                read as a riddle rather than an answer. */}
            {binding && <p style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--muted)' }}>Data: {binding.payload}</p>}
            {mine.length > 0 && (
              <div className="design-row">
                {mine.map((d) => (
                  <figure className="design-preview" key={d.meta.id}>
                    <WidgetPreview
                      widget={w.id}
                      design={d.meta.id}
                      config={w.sample_config}
                      data={w.sample_data}
                      width={size.width}
                      height={size.height}
                    />
                    <figcaption>{d.meta.label}<code>{d.meta.id}</code></figcaption>
                  </figure>
                ))}
              </div>
            )}
            {mine.length === 0 && (
              <div className="design-row">
                <WidgetPreview
                  widget={w.id}
                  config={w.sample_config}
                  data={w.sample_data}
                  width={size.width}
                  height={size.height}
                />
              </div>
            )}
          </div>
        )
      })}
    </section>
  )
}
