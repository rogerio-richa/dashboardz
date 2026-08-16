import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SoundMixer } from './SoundMixer'

const FAMS = { classic: { name: 'Classic beeps' }, bells: { name: 'Soft bells' }, '8bit': { name: '8-bit' } }
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('SoundMixer', () => {
  it('shows override and suggestion sources for each event', () => {
    render(<SoundMixer families={FAMS} rev={1} value={{ critical: 'bells' }} suggestion={{ critical: '8bit', warn: '8bit', info: 'classic', offline: 'classic' }} suggestionLabel="from theme" onChange={() => {}} />)
    expect(screen.getByText('Critical alarm')).toBeDefined()
    expect(screen.getByLabelText('Critical alarm sound: Soft bells (overridden)')).toBeDefined()
    expect(screen.getByLabelText('Warn chime sound: 8-bit (from theme)')).toBeDefined()
  })
  it('expanding a row and picking a family calls onChange with the sparse map', () => {
    const onChange = vi.fn()
    render(<SoundMixer families={FAMS} rev={1} value={{}} suggestion={null} suggestionLabel="default" onChange={onChange} />)
    fireEvent.click(screen.getByLabelText('Choose Warn chime sound'))
    fireEvent.click(screen.getByLabelText('Use Soft bells for Warn chime'))
    expect(onChange).toHaveBeenCalledWith({ warn: 'bells' })
  })
  it('reset returns the row to the suggestion (key removed, not set)', () => {
    const onChange = vi.fn()
    render(<SoundMixer families={FAMS} rev={1} value={{ warn: 'bells' }} suggestion={{ critical: 'classic', warn: '8bit', info: 'classic', offline: 'classic' }} suggestionLabel="from theme" onChange={onChange} />)
    fireEvent.click(screen.getByLabelText('Reset Warn chime sound'))
    expect(onChange).toHaveBeenCalledWith({})
  })
  it('Apply whole set writes all five events', () => {
    const onChange = vi.fn()
    render(<SoundMixer families={FAMS} rev={1} value={{}} suggestion={null} suggestionLabel="default" onChange={onChange} />)
    fireEvent.change(screen.getByLabelText('Apply whole set'), { target: { value: 'bells' } })
    expect(onChange).toHaveBeenCalledWith({ critical: 'bells', warn: 'bells', info: 'bells', offline: 'bells', activity: 'bells' })
  })
  it('renders a Stream activity row alongside the other four', () => {
    render(<SoundMixer families={FAMS} rev={1} value={{}} suggestion={null} suggestionLabel="default" onChange={() => {}} />)
    expect(screen.getByText('Stream activity')).toBeDefined()
    expect(screen.getByLabelText('Choose Stream activity sound')).toBeDefined()
    expect(screen.getByLabelText('Play Stream activity sound')).toBeDefined()
  })
})
