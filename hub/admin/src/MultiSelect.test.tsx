import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import MultiSelect, { type MultiSelectOption } from './MultiSelect'

afterEach(cleanup)

const NAMES = ['cron', 'pi', 'netdata-io', 'netdata-sc', 'openclaw', 'claude-code', 'finance-sim', 'demo-data', 'mac-metrics']

function Harness({ options, initial = [] }: { options: MultiSelectOption[]; initial?: string[] }) {
  const [selected, setSelected] = useState<string[]>(initial)
  return (
    <form onSubmit={(e) => { e.preventDefault(); throw new Error('form submitted') }}>
      <MultiSelect label="Allowed senders" emptyText="Any sender" options={options}
        selected={selected} onChange={setSelected} optionLabel={(o) => `Allow sender ${o.label}`} />
      <output data-testid="value">{selected.join(',')}</output>
      <button type="button">outside</button>
    </form>
  )
}

const opts = (names: string[]) => names.map((n) => ({ value: `snd_${n}`, label: n }))
const trigger = () => screen.getByRole('button', { name: 'Allowed senders' })
const value = () => screen.getByTestId('value').textContent

describe('MultiSelect', () => {
  it('is closed until clicked, and says what is ticked in a few words', () => {
    render(<Harness options={opts(NAMES)} />)
    expect(trigger().textContent).toContain('Any sender')
    expect(screen.queryByLabelText('Allow sender pi')).toBeNull()

    fireEvent.click(trigger())
    fireEvent.click(screen.getByLabelText('Allow sender cron'))
    fireEvent.click(screen.getByLabelText('Allow sender pi'))
    expect(trigger().textContent).toContain('cron, pi')
    fireEvent.click(screen.getByLabelText('Allow sender openclaw'))
    expect(trigger().textContent).toContain('cron, pi +1')
    expect(value()).toBe('snd_cron,snd_pi,snd_openclaw')
  })

  it('unticking removes the value, and Clear empties it', () => {
    render(<Harness options={opts(NAMES)} initial={['snd_cron', 'snd_pi']} />)
    fireEvent.click(trigger())
    fireEvent.click(screen.getByLabelText('Allow sender cron'))
    expect(value()).toBe('snd_pi')
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }))
    expect(value()).toBe('')
    expect(trigger().textContent).toContain('Any sender')
  })

  it('filters a long list, and Enter in the filter does not submit the form', () => {
    render(<Harness options={opts(NAMES)} />)
    fireEvent.click(trigger())
    const filter = screen.getByLabelText('Filter allowed senders')
    fireEvent.change(filter, { target: { value: 'netdata' } })
    expect(screen.getByLabelText('Allow sender netdata-io')).toBeDefined()
    expect(screen.queryByLabelText('Allow sender cron')).toBeNull()
    fireEvent.keyDown(filter, { key: 'Enter' })
    fireEvent.change(filter, { target: { value: 'zzz' } })
    expect(screen.getByText('No match')).toBeDefined()
  })

  it('has no filter box for a short list', () => {
    render(<Harness options={opts(['cron', 'pi'])} />)
    fireEvent.click(trigger())
    expect(screen.queryByLabelText('Filter allowed senders')).toBeNull()
  })

  it('closes on a click outside, on Escape, and on Done', () => {
    render(<Harness options={opts(['cron', 'pi'])} />)
    fireEvent.click(trigger())
    fireEvent.mouseDown(screen.getByRole('button', { name: 'outside' }))
    expect(screen.queryByLabelText('Allow sender pi')).toBeNull()

    fireEvent.click(trigger())
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByLabelText('Allow sender pi')).toBeNull()

    fireEvent.click(trigger())
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    expect(screen.queryByLabelText('Allow sender pi')).toBeNull()
    expect(trigger().getAttribute('aria-expanded')).toBe('false')
  })

  it('keeps a missing id visible so it can still be unticked', () => {
    render(<Harness options={[...opts(['cron']), { value: 'snd_gone', label: 'snd_gone', missing: true }]} initial={['snd_gone']} />)
    expect(trigger().textContent).toContain('snd_gone')
    fireEvent.click(trigger())
    fireEvent.click(screen.getByLabelText('Allow sender snd_gone'))
    expect(value()).toBe('')
  })
})
