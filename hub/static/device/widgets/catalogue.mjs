/**
 * Every design that ships, as data — the one list a new design is added to.
 *
 * Split out of `index.mjs` because the ADMIN needs to offer the catalogue in two dropdowns (a
 * cell's design override, and a theme's per-widget choice) and could not get at it. It carried a
 * hand-written copy instead, in two separate files, and adding the nixie design left both stale:
 * the design shipped, rendered correctly, and was unreachable from the UI. A comment excused the
 * copy as "a convenience, not a contract", which held right up until it silently cost a feature.
 *
 * The admin cannot import `index.mjs` itself: that pulls in `assets.mjs`, whose
 * `new URL(..., import.meta.url)` makes the bundler glob the sprite sheets and refuse a path
 * outside the admin project. This module imports nothing but the designs, so it crosses that
 * boundary cleanly — and the designs themselves import only pure geometry helpers.
 *
 * Registration order is preserved: `defaultDesignFor` falls back to the FIRST registered design
 * for a widget when none is marked default, so this array's order is load-bearing.
 */
import digital from './clock/digital.mjs'
import segment from './clock/segment.mjs'
import analog from './clock/analog.mjs'
import flip from './clock/flip.mjs'
import nixie from './clock/nixie.mjs'
import forecast from './weather/forecast.mjs'
import newsList from './news/list.mjs'
import agenda from './calendar/agenda.mjs'
import textBlock from './text/block.mjs'
import valueTile from './value/tile.mjs'
import valueStatusbar from './value/statusbar.mjs'
import gaugeBar from './gauge/bar.mjs'
import gaugeRing from './gauge/ring.mjs'
import gaugeBattery from './gauge/battery.mjs'
import streamList from './stream/list.mjs'
import streamScroll from './stream/scroll.mjs'
import streamChat from './stream/chat.mjs'
import streamTicker from './stream/ticker.mjs'
import textLed from './text/led.mjs'
import chartCandles from './chart/candles.mjs'
import tableGrid from './table/grid.mjs'
import alertFeed from './alert/feed.mjs'
import imageFrame from './image/frame.mjs'
import chartPlot from './chart/plot.mjs'
import { WIDGET_DEFINITIONS } from './definitions.mjs'

// `gaugeBar` before `gaugeRing`: `defaultDesignFor` falls back to the FIRST registered design for
// a widget when none is chosen (registration order, this file's own docstring above). `bar` is
// gauge's real default — `layout-core.mjs`'s `gaugeConfig` reads
// `style: c.style === 'ring' ? 'ring' : 'bar'`, i.e. bar unless a cell explicitly opted into
// ring — so it has to sort first here to match every existing saved gauge cell's current
// appearance.
// `streamTicker` sorts LAST among stream_list's designs for the same reason the two below sort as
// they do: `list` is the default, and a new design must not become the
// default for every existing saved cell by being registered.
// `streamList` before `streamScroll`: `list` is stream_list's default,
// and registration order is what keeps every existing saved cell drawing exactly as it did —
// the same reason `gaugeBar` sorts before `gaugeRing` above.
export const CATALOGUE = Object.freeze([digital, segment, analog, flip, nixie, forecast, newsList, agenda, textBlock, valueTile, gaugeBar, gaugeRing, streamList, streamScroll, tableGrid, alertFeed, imageFrame, chartPlot, gaugeBattery, valueStatusbar, streamChat, streamTicker, textLed, chartCandles])

/**
 * The minimum cell size a DESIGN declares for itself, or null when it declares none.
 *
 * Read by every caller of `belowMinimum` — the device renderer, the paint path and the admin's
 * grid editor — because all three have to agree: an admin that refuses a band the panel draws
 * (or the reverse) is worse than either rule on its own.
 */
export function designMinimum(widget, designId) {
  if (typeof designId !== 'string' || designId === '') return null
  const design = CATALOGUE.find((d) => d.meta.widget === widget && d.meta.id === designId)
  return design?.meta?.minimum_px ?? null
}

/** Design ids for one widget type, in catalogue order. */
export function designIdsFor(widget) {
  return CATALOGUE.filter((d) => d.meta.widget === widget).map((d) => d.meta.id)
}

/** Every widget type that has at least one design, for a caller offering the whole catalogue. */
export function widgetsWithDesigns() {
  const designed = new Set(CATALOGUE.map((d) => d.meta.widget))
  return WIDGET_DEFINITIONS.filter((definition) => designed.has(definition.id)).map((definition) => definition.id)
}
