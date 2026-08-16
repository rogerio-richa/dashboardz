import { describe, expect, it, vi } from 'vitest'
// @ts-expect-error plain JS module without types
import list, { formatNewsTime, normalizeNews } from '../static/device/widgets/news/list.mjs'
// @ts-expect-error plain JS module without types
import { designIdsFor } from '../static/device/widgets/catalogue.mjs'
// @ts-expect-error executable demo script exposes pure fixture builders for contract checks
import { NEWS_DEMO_SETUP, newsDemoScreen } from '../scripts/demo-data.mjs'

const NOW = Date.parse('2026-08-05T12:00:00Z')

const stories = (count = 5) => Array.from({ length: count }, (_, index) => ({
  id: `story-${String(index).padStart(2, '0')}`,
  title: `Headline ${index}`,
  summary: `Summary ${index}`,
  source: `Desk ${index}`,
  published_at: NOW - index * 60_000,
  url: `https://news.example.test/${index}`,
}))

type Call = {
  op: string
  args: unknown[]
  font: string
  fillStyle: string
  textAlign: string
  textBaseline: string
}

function recorder() {
  const calls: Call[] = []
  let measurements = 0
  const g = {
    font: '', fillStyle: '', textAlign: '', textBaseline: '',
    fillText: (...args: unknown[]) => calls.push(call('fillText', args)),
    measureText: (value: string) => {
      measurements++
      const px = Number(g.font.match(/([\d.]+)px/)?.[1] ?? 10)
      return { width: Array.from(value).length * px * 0.56 }
    },
  }
  function call(op: string, args: unknown[] = []): Call {
    return {
      op, args, font: g.font, fillStyle: g.fillStyle,
      textAlign: g.textAlign, textBaseline: g.textBaseline,
    }
  }
  return {
    g,
    calls,
    texts: () => calls.map((entry) => String(entry.args[0])),
    textCalls: () => calls.filter((entry) => entry.op === 'fillText'),
    measurementCount: () => measurements,
  }
}

type Bounds = { left: number; top: number; right: number; bottom: number }

const fontPx = (entry: Call) => Number(entry.font.match(/([\d.]+)px/)?.[1] ?? 0)

function textBounds(entry: Call): Bounds {
  const value = String(entry.args[0])
  const x = Number(entry.args[1])
  const y = Number(entry.args[2])
  const height = fontPx(entry)
  const width = Array.from(value).length * height * 0.56
  const left = entry.textAlign === 'right' ? x - width : entry.textAlign === 'center' ? x - width / 2 : x
  const top = entry.textBaseline === 'bottom' ? y - height : entry.textBaseline === 'middle' ? y - height / 2 : y
  return { left, top, right: left + width, bottom: top + height }
}

function expectInside(bounds: Bounds, box: { w: number; h: number }) {
  expect(bounds.left).toBeGreaterThanOrEqual(-0.001)
  expect(bounds.top).toBeGreaterThanOrEqual(-0.001)
  expect(bounds.right).toBeLessThanOrEqual(box.w + 0.001)
  expect(bounds.bottom).toBeLessThanOrEqual(box.h + 0.001)
}

function expectWellFormedUtf16(value: string) {
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index)
    if (unit >= 0xD800 && unit <= 0xDBFF) {
      expect(value.charCodeAt(index + 1)).toBeGreaterThanOrEqual(0xDC00)
      expect(value.charCodeAt(index + 1)).toBeLessThanOrEqual(0xDFFF)
      index++
    } else {
      expect(unit < 0xDC00 || unit > 0xDFFF).toBe(true)
    }
  }
}

const ctx = (overrides: Record<string, unknown> = {}) => ({
  tokens: { ink: '#111111', dim: '#666666' },
  config: { items: 5, show_summary: true, show_source: true, show_time: true, scale: 1, design: 'list' },
  data: stories(),
  box: { w: 720, h: 400, t: 1 },
  now: NOW,
  state: {},
  motion: 'full',
  ...overrides,
})

describe('news data normalization', () => {
  it('sorts newest first independently of append order with deterministic timestamp ties', () => {
    const rows = [
      { id: 'undated-b', title: 'Undated B' },
      { id: 'older', title: 'Older', published_at: 100 },
      { id: 'tie-b', title: 'Tie B', published_at: 200 },
      { id: 'newest', title: 'Newest', published_at: 300 },
      { id: 'tie-a', title: 'Tie A', published_at: 200 },
      { id: 'undated-a', title: 'Undated A' },
    ]
    const expected = ['newest', 'tie-a', 'tie-b', 'older', 'undated-a']
    expect(normalizeNews(rows, {}).items.map((item: { id: string }) => item.id)).toEqual(expected)
    expect(normalizeNews([...rows].reverse(), {}).items.map((item: { id: string }) => item.id)).toEqual(expected)
  })

  it('rejects equal-time duplicate IDs before sorting or applying the requested item cap', () => {
    const rows = [
      { id: 'duplicate', title: 'First append order', published_at: NOW },
      { id: 'duplicate', title: 'Second append order', published_at: NOW },
    ]
    const unavailable = { available: false, items: [], scale: 1 }
    expect(normalizeNews(rows, { items: 1 })).toEqual(unavailable)
    expect(normalizeNews([...rows].reverse(), { items: 1 })).toEqual(unavailable)
  })

  it('treats prototype-shaped IDs as data while rejecting a real duplicate', () => {
    const distinct = [
      { id: 'toString', title: 'T', published_at: NOW },
      { id: '__proto__', title: 'P', published_at: NOW },
      { id: 'constructor', title: 'C', published_at: NOW },
    ]
    expect(normalizeNews(distinct, {}).items.map((item: { id: string }) => item.id))
      .toEqual(['__proto__', 'constructor', 'toString'])
    expect(normalizeNews([...distinct, { id: '__proto__', title: 'Duplicate', published_at: NOW }], {}))
      .toEqual({ available: false, items: [], scale: 1 })
  })

  it('rejects collections beyond the 100-row contract bound', () => {
    expect(normalizeNews(stories(101), { items: 1 }))
      .toEqual({ available: false, items: [], scale: 1 })
  })

  it('defaults to five items and honors only integer caps from one through ten', () => {
    const rows = stories(12).reverse()
    expect(normalizeNews(rows, {}).items).toHaveLength(5)
    expect(normalizeNews(rows, { items: 1 }).items).toHaveLength(1)
    expect(normalizeNews(rows, { items: 10 }).items).toHaveLength(10)
    for (const items of [0, 11, 2.5, '10']) expect(normalizeNews(rows, { items }).items).toHaveLength(5)
  })

  it('includes optional values only when requested and owned by that item', () => {
    const rows = [{
      id: 'one', title: 'One', summary: 'A summary', source: 'News desk', published_at: NOW,
      attribution: { label: 'Attributed wire', url: 'https://attribution.example.test/' },
    }, {
      id: 'two', title: 'Two', attribution: { label: 'Wire service', url: null },
    }]
    expect(normalizeNews(rows, {}).items).toEqual([
      { id: 'one', title: 'One' }, { id: 'two', title: 'Two' },
    ])
    expect(normalizeNews(rows, { show_summary: true, show_source: true, show_time: true }).items).toEqual([
      { id: 'one', title: 'One', summary: 'A summary', source: 'News desk', publishedAt: NOW },
      { id: 'two', title: 'Two', source: 'Wire service' },
    ])
  })

  it('degrades missing or empty required data to unavailable rather than painting a partial list', () => {
    for (const data of [
      null, undefined, 7, {}, [], [null],
      [{ title: 'Missing id' }], [{ id: 'missing-title' }], [{ id: 'empty', title: '   ' }],
      [stories(2)[0], { id: 'bad', title: '' }],
    ]) {
      const normalized = normalizeNews(data, { items: 10 })
      expect(normalized.available).toBe(false)
      expect(normalized.items).toEqual([])
    }
  })

  it('drops malformed optional values without placeholder copy', () => {
    const [row] = stories(1)
    const normalized = normalizeNews([{
      ...row, summary: 7, source: '', published_at: Infinity,
      attribution: { label: '', url: 9 },
    }], { show_summary: true, show_source: true, show_time: true })
    expect(normalized).toMatchObject({ available: true, items: [{ id: row.id, title: row.title }] })
    expect(JSON.stringify(normalized)).not.toMatch(/N\/A|undefined|null/)
  })

  it.each([
    { input: `ASCII${'x'.repeat(95)}`, expected: `ASCII${'x'.repeat(95)}` },
    { input: `Astral ${'😀'.repeat(993)}`, expected: `Astral ${'😀'.repeat(505)}...` },
    { input: `Mix ${'a😀'.repeat(4_998)}`, expected: `Mix ${'a😀'.repeat(254)}...` },
    { input: `Trailing${' '.repeat(49_992)}`, expected: 'Trailing...' },
  ])('bounds provider text before whole-input trim/copy and preserves Unicode', ({ input, expected }) => {
    const iteratorRuns: Array<{ codeUnits: number; traversed: number }> = []
    const trimInputs: number[] = []
    const originalIterator = String.prototype[Symbol.iterator]
    const originalTrim = String.prototype.trim
    const iteratorSpy = vi.spyOn(String.prototype, Symbol.iterator).mockImplementation(function (this: string) {
      const iterator = originalIterator.call(this)
      const run = { codeUnits: this.length, traversed: 0 }
      iteratorRuns.push(run)
      return {
        next() {
          const result = iterator.next()
          if (!result.done) run.traversed++
          return result
        },
        [Symbol.iterator]() { return this },
        // A real StringIterator is disposable; the stub only needs to say so — for-of never
        // calls it, and the traversal counters above are what this test reads.
        [Symbol.dispose]() {},
      }
    })
    const trimSpy = vi.spyOn(String.prototype, 'trim').mockImplementation(function (this: string) {
      trimInputs.push(this.length)
      return originalTrim.call(this)
    })
    let title = ''
    try {
      title = normalizeNews([{ id: 'bounded', title: input }], {}).items[0]?.title ?? ''
    } finally {
      trimSpy.mockRestore()
      iteratorSpy.mockRestore()
    }

    expect(title).toBe(expected)
    expectWellFormedUtf16(title)
    const rawIteration = iteratorRuns.find((run) => run.codeUnits === input.length)
    expect(rawIteration).toBeDefined()
    expect(rawIteration!.traversed).toBeLessThanOrEqual(513)
    expect(Math.max(...trimInputs)).toBeLessThanOrEqual(1_024)
  })

  it('reads only own data properties and never invokes own or inherited accessors', () => {
    let invoked = 0
    const ownTitle = Object.defineProperties({}, {
      id: { value: 'own' },
      title: { get() { invoked++; throw new Error('own getter ran') } },
    })
    const inherited = Object.create(Object.defineProperties({}, {
      id: { value: 'inherited-id' },
      title: { get() { invoked++; throw new Error('inherited getter ran') } },
    }))
    const inheritedRows = Object.create(stories())
    const inheritedConfig = Object.create({ items: 10, show_summary: true, scale: 2 })

    for (const [data, config] of [
      [[ownTitle], {}], [[inherited], {}], [inheritedRows, {}], [stories(), inheritedConfig],
    ]) {
      expect(() => normalizeNews(data, config)).not.toThrow()
      expect(() => list.draw(recorder().g, ctx({ data, config }), 0)).not.toThrow()
    }
    expect(invoked).toBe(0)
    expect(normalizeNews(stories(12), inheritedConfig).items).toHaveLength(5)
    expect(normalizeNews(stories(), inheritedConfig).scale).toBe(1)
  })

  it('degrades hostile proxies and reflection failures without throwing', () => {
    const hostile = () => new Proxy({}, {
      getOwnPropertyDescriptor() { throw new Error('reflection blocked') },
      get() { throw new Error('property read') },
    })
    const hostileRows = new Proxy(stories(), {
      getOwnPropertyDescriptor() { throw new Error('array reflection blocked') },
      get() { throw new Error('array property read') },
    })
    const revoked = Proxy.revocable({}, {})
    revoked.revoke()
    for (const candidate of [
      hostile(), revoked.proxy, hostileRows, [hostile()],
      [{ ...stories(1)[0], attribution: hostile() }],
    ]) {
      expect(() => normalizeNews(candidate, hostile())).not.toThrow()
      expect(() => list.draw(recorder().g, ctx({ data: candidate, config: hostile() }), 0)).not.toThrow()
    }
  })

  it('formats publication time deterministically without locale APIs', () => {
    expect(formatNewsTime(NOW - 15_000, NOW)).toBe('Now')
    expect(formatNewsTime(NOW - 12 * 60_000, NOW)).toBe('12m ago')
    expect(formatNewsTime(NOW - 5 * 3_600_000, NOW)).toBe('5h ago')
    expect(formatNewsTime(NOW - 3 * 86_400_000, NOW)).toBe('3d ago')
    expect(formatNewsTime(NOW + 60_000, NOW)).toBe('Now')
    expect(formatNewsTime(Infinity, NOW)).toBeNull()
  })
})

describe('news list canvas design', () => {
  it('registers exactly one portable list design and declares only tokens it paints', () => {
    expect(list.meta).toMatchObject({ id: 'list', widget: 'news_list' })
    expect(designIdsFor('news_list')).toEqual(['list'])
    expect(Object.keys(list.meta.tokens).sort()).toEqual(['dim', 'ink'])
    expect(list.meta.assets).toBeUndefined()
    expect(list.meta.interactions).toBeUndefined()
  })

  it('draws newest rows first and never turns URLs into text or interactions', () => {
    const rows = stories(5).reverse()
    const r = recorder()
    list.draw(r.g, ctx({ data: rows }), 0)
    const titles = r.texts().filter((value) => value.startsWith('Headline '))
    expect(titles).toEqual(['Headline 0', 'Headline 1', 'Headline 2', 'Headline 3', 'Headline 4'])
    expect(r.texts().join(' ')).not.toContain('https://')
  })

  it('paints the same calm unavailable state for equal-time duplicates in either append order', () => {
    const rows = [
      { id: 'duplicate', title: 'First append order', published_at: NOW },
      { id: 'duplicate', title: 'Second append order', published_at: NOW },
    ]
    const forward = recorder()
    const reverse = recorder()
    list.draw(forward.g, ctx({ data: rows, config: { items: 1 } }), 0)
    list.draw(reverse.g, ctx({ data: [...rows].reverse(), config: { items: 1 } }), 0)

    expect(forward.texts()).toEqual(['News unavailable', 'Headlines will appear here'])
    expect(reverse.texts()).toEqual(['News unavailable', 'Headlines will appear here'])
    expect(forward.calls).toEqual(reverse.calls)
  })

  it('drops summary, then source, then time as row height tightens before title clipping', () => {
    const render = (count: number) => {
      const r = recorder()
      list.draw(r.g, ctx({ box: { w: 180, h: 120, t: 0.3 }, data: stories(count), config: {
        items: count, show_summary: true, show_source: true, show_time: true, scale: 2, design: 'list',
      } }), 0)
      return r.texts()
    }
    const three = render(3).join('|')
    expect(three).not.toContain('Summary')
    expect(three).toContain('Desk 0')
    expect(three).toContain('Now')

    const four = render(4).join('|')
    expect(four).not.toContain('Summary')
    expect(four).not.toContain('Desk')
    expect(four).toContain('Now')

    const ten = render(10).join('|')
    expect(ten).not.toContain('Summary')
    expect(ten).not.toContain('Desk')
    expect(ten).not.toMatch(/ago|Now/)
    expect(ten.split('|')).toEqual(stories(10).map((row) => row.title))
  })

  it.each([0.5, 1, 2])('keeps ten title rows separated and bounded at 180x120 with scale %s', (scale) => {
    const box = { w: 180, h: 120, t: 0.3 }
    const data = stories(10).map((row) => ({ ...row, title: `${row.title} ${'😀 very long'.repeat(40)}` }))
    const r = recorder()
    list.draw(r.g, ctx({ box, data, config: {
      items: 10, show_summary: true, show_source: true, show_time: true, scale, design: 'list',
    } }), 0)

    expect(r.textCalls()).toHaveLength(10)
    expect(r.texts().every((value) => value.endsWith('...'))).toBe(true)
    for (const entry of r.textCalls()) expectInside(textBounds(entry), box)
    const bounds = r.textCalls().map(textBounds).sort((left, right) => left.top - right.top)
    for (let index = 1; index < bounds.length; index++) {
      expect(bounds[index - 1].bottom).toBeLessThanOrEqual(bounds[index].top + 0.001)
    }
    expect(Math.min(...r.textCalls().map(fontPx))).toBeGreaterThanOrEqual(10)
  })

  it('pre-fits every requested full row without crossing the next row or box', () => {
    const box = { w: 720, h: 400, t: 1 }
    const r = recorder()
    list.draw(r.g, ctx({ box, config: {
      items: 5, show_summary: true, show_source: true, show_time: true, scale: 2, design: 'list',
    } }), 0)

    expect(r.textCalls()).toHaveLength(20)
    const rows = Array.from({ length: 5 }, (_, index) => r.textCalls().slice(index * 4, index * 4 + 4))
    for (const row of rows) {
      const bounds = row.map(textBounds)
      for (const bound of bounds) expectInside(bound, box)
      for (let index = 1; index < bounds.length; index++) {
        expect(bounds[index - 1].bottom).toBeLessThanOrEqual(bounds[index].top + 0.001)
      }
    }
    for (let index = 1; index < rows.length; index++) {
      expect(Math.max(...rows[index - 1].map((entry) => textBounds(entry).bottom)))
        .toBeLessThanOrEqual(Math.min(...rows[index].map((entry) => textBounds(entry).top)) + 0.001)
    }
  })

  it('bounds logarithmic fitting work and truncates at Unicode code-point boundaries', () => {
    const box = { w: 180, h: 120, t: 0.3 }
    const render = (title: string) => {
      const r = recorder()
      list.draw(r.g, ctx({ box, data: [{ id: 'one', title }], config: { items: 1, scale: 1 } }), 0)
      return r
    }
    const baseline = render('Long headline')
    const long = `Long headline ${'😀'.repeat(50_000)} end`
    const first = render(long)
    const second = render(long)
    const displayed = first.texts()[0]

    expect(displayed).toBe(second.texts()[0])
    expect(displayed).toMatch(/^Long headline .+\.\.\.$/u)
    expectWellFormedUtf16(displayed)
    expectInside(textBounds(first.textCalls()[0]), box)
    expect(first.measurementCount() - baseline.measurementCount()).toBeLessThanOrEqual(32)
    expect(second.measurementCount() - baseline.measurementCount()).toBeLessThanOrEqual(32)
  })

  it('honors responsive scale as a preference bounded by fit and readable floors', () => {
    const render = (box: { w: number; h: number; t: number }, scale: number) => {
      const r = recorder()
      list.draw(r.g, ctx({ box, config: { items: 5, scale } }), 0)
      return fontPx(r.textCalls().find((entry) => entry.args[0] === 'Headline 0')!)
    }
    expect(render({ w: 900, h: 500, t: 1 }, 1)).toBeGreaterThan(render({ w: 500, h: 280, t: 0.7 }, 1))
    expect(render({ w: 900, h: 500, t: 1 }, 1.5)).toBeGreaterThan(render({ w: 900, h: 500, t: 1 }, 1))
    expect(render({ w: 180, h: 120, t: 0.3 }, 2)).toBeGreaterThanOrEqual(10)
  })

  it('uses only portable measured text calls and paints both declared token colors', () => {
    const r = recorder()
    list.draw(r.g, ctx({ tokens: { ink: '#123456', dim: '#abcdef' } }), 0)
    expect([...new Set(r.calls.map((entry) => entry.op))]).toEqual(['fillText'])
    expect(new Set(r.textCalls().map((entry) => entry.fillStyle))).toEqual(new Set(['#123456', '#abcdef']))
  })

  it('draws one calm unavailable state for empty or malformed required data', () => {
    for (const data of [null, [], [{ id: 'bad', title: '' }]]) {
      const r = recorder()
      expect(() => list.draw(r.g, ctx({ data }), 0)).not.toThrow()
      expect(r.texts()).toEqual(['News unavailable', 'Headlines will appear here'])
      for (const entry of r.textCalls()) expectInside(textBounds(entry), ctx().box)
    }
  })

  it('is deterministic and does not draw collapsed boxes', () => {
    const a = recorder()
    const b = recorder()
    list.draw(a.g, ctx(), 123)
    list.draw(b.g, ctx(), 9_999)
    expect(a.calls).toEqual(b.calls)
    for (const box of [{ w: 0, h: 100, t: 0 }, { w: 100, h: 0, t: 0 }, { w: -1, h: 20, t: 0 }]) {
      const r = recorder()
      expect(() => list.draw(r.g, ctx({ box }), 0)).not.toThrow()
      expect(r.calls).toHaveLength(0)
    }
  })
})

describe('news demo fixture', () => {
  it('uses a public credential-free RSS source and binds the semantic list design', () => {
    expect(NEWS_DEMO_SETUP).toEqual({
      provider_id: 'dashboardz.rss',
      name: 'Demo news - BBC World',
      config: { max_items: 20 },
      secrets: { url: 'https://feeds.bbci.co.uk/news/world/rss.xml' },
    })
    expect(JSON.stringify(NEWS_DEMO_SETUP)).not.toMatch(/api[_-]?key|password|token|bearer/i)
    expect(newsDemoScreen('feed_news')).toEqual({ cells: [{
      rect: { x: 0, y: 0, w: 1, h: 1 },
      widget: 'news_list',
      config: {
        feed: 'feed_news', items: 5, show_summary: true, show_source: true,
        show_time: true, scale: 1, design: 'list',
      },
    }] })
  })
})
