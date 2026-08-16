import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import Alerts from './Alerts'

/**
 * The page that answers "why is that tab red, and how do I make it stop".
 * Every assertion here is about that one question: what is ringing, where, since when, and the
 * lever to end it.
 */
const ALERT = (over: object = {}) => ({
  id: 'alr_It9KWuLL',
  title: 'No ACK from floripa 2',
  body: 'last heard 17:31',
  severity: 'critical',
  sender: { id: 'snd_mesh', name: 'meshtastic-monitor' },
  created_at: Date.now() - 3 * 60 * 60 * 1000,
  updated_at: Date.now() - 3 * 60 * 60 * 1000,
  update_count: 0,
  expires_at: null,
  dedup_key: 'mesh:floripa2',
  devices: [
    { id: 'dev_a', name: 'Painel', delivered: true, silenced: true, dismissed: false },
    { id: 'dev_b', name: 'Bedside', delivered: false, silenced: false, dismissed: false },
  ],
  screens: [{ id: 'scn_casa', name: 'Casa' }],
  ...over,
})

describe('Alerts page', () => {
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  /** Returns the ids passed to dismiss, so a test can assert the lever was actually pulled. */
  const stub = (rows: object[]): string[] => {
    const dismissed: string[] = []
    let list = rows
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST' && url.endsWith('/dismiss')) {
        dismissed.push(url)
        list = []
        return new Response(JSON.stringify({ dismissed: true }), { status: 200 })
      }
      return new Response(JSON.stringify(list), { status: 200 })
    }))
    return dismissed
  }

  it('names what is ringing, who raised it, and how long it has been standing', async () => {
    stub([ALERT()])
    render(<Alerts />)

    const row = (await screen.findByText('No ACK from floripa 2')).closest('tr')!
    expect(row.textContent).toContain('meshtastic-monitor')
    expect(row.textContent).toContain('3h')
    // Severity is the word itself, coloured — this console invents no badges.
    expect(within(row).getByText('critical').getAttribute('data-status')).toBe('critical')
  })

  /**
   * The tab dot's own explanation. A red dot with no name attached is the thing that sent the
   * operator hunting in the first place.
   */
  it('names the screens the alert is lighting', async () => {
    stub([ALERT()])
    render(<Alerts />)

    const row = (await screen.findByText('No ACK from floripa 2')).closest('tr')!
    expect(row.textContent).toContain('Casa')
  })

  /** Silenced-but-not-dismissed is the exact trap. The page has to say it in those words. */
  it('says which device silenced it and which never saw it', async () => {
    stub([ALERT()])
    render(<Alerts />)

    const row = (await screen.findByText('No ACK from floripa 2')).closest('tr')!
    expect(row.textContent).toContain('Painel silenced')
    expect(row.textContent).toContain('Bedside not delivered')
  })

  /**
   * A stranded alert — every target device deleted — can never be concluded from a panel, so the
   * console is the only place it can end. It must not look like an ordinary untouched alert.
   */
  it('flags an alert no device can ever conclude', async () => {
    stub([ALERT({ devices: [] })])
    render(<Alerts />)

    const row = (await screen.findByText('No ACK from floripa 2')).closest('tr')!
    expect(row.textContent).toContain('no target device left')
  })

  it('dismisses one after confirming, and the row goes', async () => {
    const dismissed = stub([ALERT()])
    render(<Alerts />)
    await screen.findByText('No ACK from floripa 2')

    fireEvent.click(screen.getByRole('button', { name: /Dismiss/ }))
    const dialog = await screen.findByRole('dialog')
    expect(dialog.textContent).toContain('No ACK from floripa 2')
    expect(dismissed).toHaveLength(0) // nothing happens until the operator means it

    fireEvent.click(within(dialog).getByRole('button', { name: 'Dismiss' }))

    await waitFor(() => expect(dismissed).toEqual(['/admin/api/alerts/alr_It9KWuLL/dismiss']))
    await waitFor(() => expect(screen.queryByText('No ACK from floripa 2')).toBeNull())
  })

  /** A positive all-clear, the same reading `computeTabStatus` gives a quiet monitored screen. */
  it('says the house is quiet when nothing is active', async () => {
    stub([])
    render(<Alerts />)

    await screen.findByText(/No active alerts/)
  })
})
