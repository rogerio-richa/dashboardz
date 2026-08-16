import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import DataSourcePicker from './DataSourcePicker'
import type { FeedRow } from './Screens'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const FEEDS: FeedRow[] = [
  { id: 'feed_v', name: 'a value feed', mode: 'value' },
  { id: 'feed_s', name: 'a stream feed', mode: 'stream' },
] as unknown as FeedRow[]

const stubApi = (unfit: { id: string; why: string }[] = []) => {
  const writes: { url: string; method: string; body: unknown }[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    writes.push({ url, method, body: init?.body ? JSON.parse(init.body as string) : null })
    if (url.startsWith('/admin/api/feed-fit')) return new Response(JSON.stringify({ unfit }))
    if (url === '/admin/api/senders' && method === 'GET') {
      return new Response(JSON.stringify([{ id: 'snd_existing', name: 'my cron' }]))
    }
    if (url === '/admin/api/senders' && method === 'POST') {
      return new Response(JSON.stringify({ sender: { id: 'snd_new', name: 'kitchen' }, token: 'sndtok_REAL' }))
    }
    if (url === '/admin/api/feeds' && method === 'POST') {
      return new Response(JSON.stringify({ id: 'feed_manual', name: 'kitchen', mode: 'value' }))
    }
    return new Response(null, { status: 204 })
  }))
  return writes
}

const setup = (props: Partial<Parameters<typeof DataSourcePicker>[0]> = {}) => {
  const onChange = vi.fn()
  const onFeedCreated = vi.fn()
  render(
    <DataSourcePicker
      label="Cell 1" widget="value_tile" value="" feeds={FEEDS}
      onChange={onChange} onFeedCreated={onFeedCreated}
      {...props}
    />,
  )
  return { onChange, onFeedCreated, user: userEvent.setup() }
}

describe('the advanced generic data picker', () => {
  it('keeps compatible existing feed selection working', async () => {
    stubApi()
    const { onChange, user } = setup()

    await user.selectOptions(screen.getByLabelText('Cell 1 feed'), 'feed_v')

    expect(onChange).toHaveBeenCalledWith('feed_v')
  })

  it('filters existing feeds by the shared legacy widget modes', () => {
    stubApi()
    setup({ widget: 'stream_list' })

    const options = [...(screen.getByLabelText('Cell 1 feed') as HTMLSelectElement).options]
      .map((option) => option.value)
    expect(options).toEqual(['', 'feed_s'])
  })

  /**
   * The picker offers feeds that FIT the cell, and the rule that decides is the hub's — the same
   * `compatibleGeneric` the save runs, reached over `/admin/api/feed-fit` rather than restated
   * here. A second copy in the admin is exactly the drift this codebase keeps collapsing, and it
   * would be worse than the mode table's: that one has a test comparing both copies, and two
   * copies of a matcher's body could not have one.
   */
  describe('offers the feeds that fit the cell', () => {
    it('drops a feed the hub says cannot satisfy this cell', async () => {
      stubApi([{ id: 'feed_v', why: 'gauge needs data.number@cpu' }])
      setup({ widget: 'gauge', config: { path: 'cpu' } })

      // `feed_s` stays: a gauge binds value AND stream feeds, and the hub named only `feed_v`.
      await waitFor(() => {
        const options = [...(screen.getByLabelText('Cell 1 feed') as HTMLSelectElement).options]
          .map((option) => option.value)
        expect(options).toEqual(['', 'feed_s'])
      })
    })

    it('asks about THIS cell — the widget and the paths it has configured', async () => {
      const writes = stubApi()
      setup({ widget: 'gauge', config: { path: 'cpu.percent' } })

      await waitFor(() => expect(writes.some(({ url }) => url.startsWith('/admin/api/feed-fit'))).toBe(true))
      const asked = writes.find(({ url }) => url.startsWith('/admin/api/feed-fit'))!.url
      expect(asked).toContain('widget=gauge')
      expect(decodeURIComponent(asked)).toContain('"path":"cpu.percent"')
    })

    it('keeps offering a feed the hub said nothing about — inconclusive is not incompatible', async () => {
      stubApi([{ id: 'feed_s', why: 'irrelevant' }])
      setup({ widget: 'value_tile', config: { path: 'x' } })

      await waitFor(() => {
        const options = [...(screen.getByLabelText('Cell 1 feed') as HTMLSelectElement).options]
          .map((option) => option.value)
        expect(options).toEqual(['', 'feed_v'])
      })
    })

    /**
     * Failing open, deliberately. A picker that hides every feed because a check did not complete
     * is worse than one that never checked: the operator sees an empty list and no reason for it.
     */
    it('offers every feed when the fit check cannot be reached', async () => {
      // The failure is rejected on OUR schedule and then flushed, rather than asserted through
      // `waitFor`. The expected list here is the unfiltered one, so a `waitFor` would pass on its
      // first attempt — before the request had even failed — and could not tell failing open from
      // failing closed. A mutation that hid every feed on error went undetected exactly that way.
      let fail: (error: Error) => void = () => {}
      const pending = new Promise<Response>((_, reject) => { fail = reject })
      vi.stubGlobal('fetch', vi.fn(() => pending))
      setup({ widget: 'value_tile', config: { path: 'x' } })

      await act(async () => {
        fail(new Error('offline'))
        await pending.catch(() => {})
      })

      const options = [...(screen.getByLabelText('Cell 1 feed') as HTMLSelectElement).options]
        .map((option) => option.value)
      expect(options).toEqual(['', 'feed_v', 'feed_s'])
    })

    it('never drops the feed already bound, so an existing board still shows its own selection', async () => {
      // BOTH feeds come back unfit, so the expected list differs from the unfiltered one and
      // `waitFor` cannot pass before the answer lands. With only `feed_v` unfit the assertion
      // would match the initial render, and a mutation deleting this rule went undetected.
      stubApi([
        { id: 'feed_v', why: 'gauge needs data.number@cpu' },
        { id: 'feed_s', why: 'gauge needs data.number@cpu' },
      ])
      setup({ widget: 'gauge', value: 'feed_v', config: { path: 'cpu' } })

      await waitFor(() => {
        const options = [...(screen.getByLabelText('Cell 1 feed') as HTMLSelectElement).options]
          .map((option) => option.value)
        expect(options).toEqual(['', 'feed_v'])
      })
    })
  })

  it('removes connector creation forms and never calls the retired connector APIs', async () => {
    const writes = stubApi()
    const { user } = setup()

    expect(screen.queryByRole('button', { name: /get it from/i })).toBeNull()
    expect(screen.queryByLabelText(/connector type/i)).toBeNull()
    await user.click(screen.getByLabelText('Cell 1 push it yourself'))

    expect(writes.some(({ url }) => url.includes('connector'))).toBe(false)
    expect(screen.queryByLabelText('Cell 1 city')).toBeNull()
    expect(screen.queryByLabelText('Cell 1 url')).toBeNull()
  })

  it('preserves the developer push flow for legacy widgets', async () => {
    const writes = stubApi()
    const { onChange, onFeedCreated, user } = setup()

    await user.click(screen.getByLabelText('Cell 1 push it yourself'))
    await user.type(await screen.findByLabelText('Cell 1 new feed name'), 'kitchen')
    await user.click(screen.getByLabelText('Cell 1 create feed'))

    await waitFor(() => expect(onChange).toHaveBeenCalledWith('feed_manual'))
    expect(onFeedCreated).toHaveBeenCalledWith(expect.objectContaining({ id: 'feed_manual' }))
    expect(writes.find(({ url, method }) => url === '/admin/api/feeds' && method === 'POST')?.body)
      .toEqual({ name: 'kitchen', mode: 'value' })
    const curl = screen.getByLabelText('Cell 1 curl').textContent
    expect(curl).toBe([
      `curl -X POST ${window.location.origin}/api/feeds/feed_manual \\`,
      '  -H "Authorization: Bearer sndtok_REAL" \\',
      '  -H "content-type: application/json" \\',
      '  -d \'{"value":1}\'',
    ].join('\n'))
    expect(curl?.split('\n').some((line) => line.startsWith('+'))).toBe(false)
  })

  it('uses the honest placeholder token when an existing sender is selected', async () => {
    const writes = stubApi()
    const { user } = setup()

    await user.click(screen.getByLabelText('Cell 1 push it yourself'))
    await user.type(await screen.findByLabelText('Cell 1 new feed name'), 'kitchen')
    await user.selectOptions(await screen.findByLabelText('Cell 1 sender'), 'snd_existing')
    await user.click(screen.getByLabelText('Cell 1 create feed'))

    const curl = await screen.findByLabelText('Cell 1 curl')
    expect(curl.textContent).toBe([
      `curl -X POST ${window.location.origin}/api/feeds/feed_manual \\`,
      '  -H "Authorization: Bearer YOUR_SENDER_TOKEN" \\',
      '  -H "content-type: application/json" \\',
      '  -d \'{"value":1}\'',
    ].join('\n'))
    expect(writes.some(({ url, method }) => url === '/admin/api/senders' && method === 'POST')).toBe(false)
  })

  it('asks for a shape only when a legacy widget accepts more than one', async () => {
    stubApi()
    const { user } = setup({ widget: 'stream_list' })
    await user.click(screen.getByLabelText('Cell 1 push it yourself'))
    expect(screen.queryByLabelText('Cell 1 feed mode')).toBeNull()

    cleanup()
    const second = setup({ widget: 'value_tile' })
    await second.user.click(screen.getByLabelText('Cell 1 push it yourself'))
    expect([...(screen.getByLabelText('Cell 1 feed mode') as HTMLSelectElement).options]
      .map((option) => option.value)).toEqual(['value', 'stream'])
  })
})
