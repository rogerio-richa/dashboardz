/**
 * Browser-side widget metadata shared by the device and admin.
 *
 * Definitions describe widget TYPES. `catalogue.mjs` separately lists visual DESIGNS, because one
 * widget type may have several designs. This file stays data-only so the admin bundle can import
 * it without crossing the renderer's asset boundary.
 */

const freeze = (value) => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  return value
}

export const WIDGET_DEFINITIONS = freeze([
  {
    id: 'clock',
    label: 'Clock',
    description: 'The time, drawn in the design you choose.',
    category: 'Essentials',
    advanced: false,
    suggested_ratio: 2,
    minimum_px: { w: 120, h: 60 },
    sample_config: {},
    sample_data: null,
    emits: [],
  },
  {
    id: 'alert_feed',
    label: 'Alerts',
    description: 'Active alerts, newest first, filtered by severity.',
    category: 'Essentials',
    advanced: false,
    suggested_ratio: 3 / 4,
    minimum_px: { w: 160, h: 110 },
    sample_config: { min_severity: 'info', clamp: { title_lines: 1, body_lines: 2 }, overflow: { counter: true } },
    /*
     * Alert-shaped, not feed-shaped: this widget binds no feed, so its sample IS the alert list
     * (`ctx.alerts`) rather than a payload. `sender`/`updated_at` are here because the card's meta
     * line draws both, and one entry per severity because `alert/feed.mjs` declares a colour token
     * per severity — a sample missing `critical` would leave that branch undrawn everywhere the
     * sample drives the widget (the gallery preview, and portable-subset's declared-slot guard).
     */
    sample_data: [
      { title: 'Disk almost full', body: 'root is at 94%', severity: 'critical', sender: { name: 'monitor' }, updated_at: 0 },
      { title: 'Front door open', body: 'Open for 5 minutes', severity: 'warn', sender: { name: 'door' }, updated_at: 0 },
      { title: 'Everything else is healthy', severity: 'info', sender: { name: 'monitor' }, updated_at: 0 },
    ],
    emits: [],
  },
  {
    id: 'calendar_events',
    label: 'Calendar',
    description: 'What is coming up, in time order.',
    category: 'Essentials',
    advanced: false,
    suggested_ratio: 3 / 4,
    minimum_px: { w: 180, h: 130 },
    sample_config: { feed: 'sample', events: 4, show_location: true },
    sample_data: {
      events: [
        { title: 'Dentist', start: '2026-08-06T09:00:00.000Z', end: '2026-08-06T09:45:00.000Z', all_day: false, location: 'Rua Augusta 12' },
        { title: 'Standup', start: '2026-08-06T14:30:00.000Z', end: '2026-08-06T14:45:00.000Z', all_day: false, location: null },
        { title: 'Holiday', start: '2026-08-07', end: '2026-08-08', all_day: true, location: null },
        { title: 'Rehearsal', start: '2026-08-07T19:00:00.000Z', end: '2026-08-07T21:00:00.000Z', all_day: false, location: 'The hall' },
      ],
    },
    consumes: {
      contract_id: 'dashboardz.calendar.events/v1',
      required_capabilities: ['calendar.event.times', 'calendar.event.title'],
      optional_capabilities: ['calendar.event.all_day', 'calendar.event.location'],
    },
    emits: [],
  },
  {
    id: 'value_tile',
    label: 'Value',
    description: 'One number or short value, as large as the card allows.',
    category: 'Data',
    advanced: true,
    suggested_ratio: 3 / 2,
    minimum_px: { w: 100, h: 70 },
    sample_config: { feed: 'sample', path: 'value', label: 'Temperature', unit: '°C' },
    sample_data: { value: 23.4 },
    emits: [],
  },
  {
    id: 'gauge',
    label: 'Gauge',
    description: 'A ring or bar against a range, coloured by threshold.',
    category: 'Data',
    advanced: true,
    suggested_ratio: 2,
    minimum_px: { w: 120, h: 110 },
    sample_config: { feed: 'sample', path: 'value', min: 0, max: 100, label: 'Progress', unit: '%' },
    sample_data: { value: 72 },
    emits: [],
  },
  {
    id: 'stream_list',
    label: 'Stream list',
    description: 'Recent rows shown as titled cards.',
    category: 'Data',
    advanced: true,
    suggested_ratio: 3 / 4,
    minimum_px: { w: 160, h: 110 },
    sample_config: { feed: 'sample', title_path: 'title', body_path: 'body' },
    sample_data: [
      { title: 'First item', body: 'A short summary' },
      { title: 'Second item', body: 'Another short summary' },
      // Signed bodies, and not decoration: `stream/ticker.mjs` tints a row by whether its body
      // reads as a gain or a loss, and portable-subset.test.ts proves a declared token is really
      // painted by DRAWING with these rows. Without a signed sample here, the ticker's `up`/`down`
      // slots report as declared-but-never-painted — which is the same guard telling the truth.
      { title: 'AAPL', body: '+1.2%' },
      { title: 'MSFT', body: '-0.8%' },
    ],
    emits: [],
  },
  {
    id: 'table',
    label: 'Table',
    description: 'Rows organised into named columns.',
    category: 'Data',
    advanced: true,
    suggested_ratio: 3 / 2,
    minimum_px: { w: 180, h: 110 },
    sample_config: { feed: 'sample', columns: [{ header: 'Name', path: 'name' }, { header: 'Value', path: 'value', align: 'right' }] },
    sample_data: [{ name: 'Alpha', value: 12 }, { name: 'Beta', value: 8 }],
    emits: [],
  },
  {
    id: 'text_block',
    label: 'Text',
    description: 'Fixed text, or one value from a feed.',
    category: 'Essentials',
    advanced: true,
    suggested_ratio: 3 / 2,
    minimum_px: { w: 80, h: 40 },
    sample_config: { text: 'Welcome home' },
    sample_data: 'Welcome home',
    emits: [],
  },
  {
    id: 'chart',
    label: 'Chart',
    description: 'Up to four data series plotted over time.',
    category: 'Data',
    advanced: true,
    suggested_ratio: 16 / 9,
    minimum_px: { w: 160, h: 100 },
    sample_config: { series: [{ feed: 'sample', y_path: 'value', icon: 'circle', label: 'Value' }], style: 'line' },
    sample_data: [{ value: 4 }, { value: 7 }, { value: 6 }],
    emits: [],
  },
  {
    id: 'image',
    label: 'Image',
    description: 'The latest bitmap pushed to an image feed.',
    category: 'Media',
    advanced: true,
    suggested_ratio: 4 / 3,
    minimum_px: { w: 60, h: 60 },
    sample_config: { feed: 'sample', fit: 'contain' },
    sample_data: null,
    emits: [],
  },
  {
    id: 'weather_forecast',
    label: 'Five-day forecast',
    description: 'Daily conditions and temperatures for the next five to seven days.',
    category: 'Weather',
    advanced: false,
    suggested_ratio: 16 / 9,
    minimum_px: { w: 300, h: 140 },
    sample_config: { feed: 'sample', days: 5, show_precipitation: true },
    sample_data: {
      location: { name: 'São Paulo', timezone: 'America/Sao_Paulo' },
      units: { temperature: 'C', wind_speed: 'km/h' },
      days: [
        { date: '2026-08-05', high: 24, low: 14, condition: { code: 'clear', label: 'Clear' }, precipitation_probability_pct: 5 },
        { date: '2026-08-06', high: 23, low: 15, condition: { code: 'partly_cloudy', label: 'Partly cloudy' }, precipitation_probability_pct: 15 },
        { date: '2026-08-07', high: 21, low: 14, condition: { code: 'rain', label: 'Rain' }, precipitation_probability_pct: 70 },
        { date: '2026-08-08', high: 20, low: 13, condition: { code: 'cloudy', label: 'Cloudy' }, precipitation_probability_pct: 25 },
        { date: '2026-08-09', high: 22, low: 14, condition: { code: 'mostly_clear', label: 'Mostly clear' }, precipitation_probability_pct: 10 },
      ],
      attribution: { label: 'Open-Meteo', url: 'https://open-meteo.com/' },
    },
    consumes: {
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
    emits: [],
  },
  {
    id: 'news_list',
    label: 'News list',
    description: 'Recent headlines with optional summaries, sources and times.',
    category: 'News',
    advanced: false,
    suggested_ratio: 3 / 4,
    minimum_px: { w: 180, h: 120 },
    sample_config: { feed: 'sample', items: 5, show_summary: true, show_source: true, show_time: true },
    sample_data: [
      { id: 'sample-2', title: 'A newer sample headline', summary: 'A short, safe preview summary.', published_at: 1_775_342_400_000, source: 'Dashboardz News' },
      { id: 'sample-1', title: 'A sample headline', summary: 'Another short preview summary.', published_at: 1_775_338_800_000, source: 'Dashboardz News' },
    ],
    consumes: {
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
    emits: [],
  },
])
