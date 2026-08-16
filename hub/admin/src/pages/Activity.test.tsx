import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import Activity from './Activity'

describe('Activity page', () => {
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  /** Every tab sits on the same white card (a <section>); Activity was a bare table on the bench. */
  it('renders its table inside a section, like every other tab', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify([
      { id: 1, ts: 0, actor_type: 'system', actor_id: null, event: 'auth_rejected', details: '{}' },
    ]), { status: 200 })))
    render(<Activity />)
    const cell = await screen.findByText('auth_rejected')
    expect(cell.closest('table')!.parentElement!.tagName).toBe('SECTION')
  })
})
