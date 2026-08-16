import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
// @ts-expect-error plain JS module without types
import { WIDGET_DEFINITIONS } from '../../../static/device/widgets/definitions.mjs'
import WidgetGallery from './WidgetGallery'

type RecordingContext = CanvasRenderingContext2D & { fillText: ReturnType<typeof vi.fn> }
const contexts = new WeakMap<HTMLCanvasElement, RecordingContext>()

function recordingContext(): RecordingContext {
  return {
    arc: vi.fn(), beginPath: vi.fn(), clearRect: vi.fn(), closePath: vi.fn(), drawImage: vi.fn(),
    fill: vi.fn(), fillRect: vi.fn(), fillText: vi.fn(), lineTo: vi.fn(),
    measureText: vi.fn((text: string) => ({ width: Array.from(String(text)).length * 6 })),
    moveTo: vi.fn(), rect: vi.fn(), restore: vi.fn(), rotate: vi.fn(), save: vi.fn(), scale: vi.fn(),
    setTransform: vi.fn(), stroke: vi.fn(), translate: vi.fn(),
  } as unknown as RecordingContext
}

function paintedText(label: string): unknown[] {
  const canvas = screen.getByLabelText(label) as HTMLCanvasElement
  return contexts.get(canvas)?.fillText.mock.calls.map(([text]) => text) ?? []
}

beforeEach(() => {
  Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 2 })
  const getContext = function (this: HTMLCanvasElement) {
    const context = recordingContext()
    contexts.set(this, context)
    return context
  }
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
    getContext as unknown as typeof HTMLCanvasElement.prototype.getContext,
  )
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('WidgetGallery catalogue', () => {
  it('renders every widget definition exactly once with its user-facing label', () => {
    render(<WidgetGallery onSelect={() => {}} />)

    const options = screen.getAllByRole('option')
    expect(options).toHaveLength(WIDGET_DEFINITIONS.length)
    expect(options.map((option) => option.dataset.widget).sort()).toEqual(
      WIDGET_DEFINITIONS.map((definition: { id: string }) => definition.id).sort(),
    )
    for (const definition of WIDGET_DEFINITIONS as { id: string; label: string }[]) {
      expect(screen.getByRole('option', { name: new RegExp(definition.label, 'i') })).toBeDefined()
      expect(options.filter((option) => option.dataset.widget === definition.id)).toHaveLength(1)
    }
  })

  it('groups common widgets before Advanced without turning clock designs into widget cards', () => {
    render(<WidgetGallery onSelect={() => {}} />)

    const groups = screen.getAllByRole('group')
    expect(groups.map((group) => group.getAttribute('aria-label'))).toEqual(['Common', 'Advanced'])
    const commonIds = within(groups[0]).getAllByRole('option').map((option) => option.dataset.widget)
    const advancedIds = within(groups[1]).getAllByRole('option').map((option) => option.dataset.widget)
    expect(commonIds).toEqual(WIDGET_DEFINITIONS
      .filter((definition: { advanced: boolean }) => !definition.advanced)
      .map((definition: { id: string }) => definition.id))
    expect(advancedIds).toEqual(WIDGET_DEFINITIONS
      .filter((definition: { advanced: boolean }) => definition.advanced)
      .map((definition: { id: string }) => definition.id))
    expect(commonIds.filter((id) => id === 'clock')).toHaveLength(1)
    expect(screen.queryByRole('option', { name: /^Digital$/i })).toBeNull()
    expect(screen.queryByRole('option', { name: /^Analog$/i })).toBeNull()
  })

  it('uses the actual Clock, Weather, and News canvas designs with catalogue sample data', () => {
    vi.setSystemTime(new Date('2026-08-05T12:34:00Z'))
    render(<WidgetGallery onSelect={() => {}} />)

    expect(paintedText('Clock preview').length).toBeGreaterThan(0)
    expect(paintedText('Five-day forecast preview')).toContain('H 24°')
    expect(paintedText('Five-day forecast preview')).toContain('L 14°C')
    expect(paintedText('News list preview')).toContain('A newer sample headline')
  })

  /*
   * The lightweight-preview branch is gone now that every widget has a canvas design.
   *
   * Every widget has a canvas design, so the lightweight fallback has no reachable input and
   * the component and its CSS are gone (WidgetPreview.tsx).
   *
   * The coverage is not gone, it INVERTED: the test below asserts the positive fact that replaced
   * it — every definition in the gallery renders a real canvas — and covers every definition.
   */
  it('renders a real canvas for every widget in the gallery, with no lightweight fallback left', () => {
    render(<WidgetGallery onSelect={() => {}} />)

    const options = screen.getAllByRole('option')
    expect(options).toHaveLength(WIDGET_DEFINITIONS.length)
    for (const option of options) {
      expect(option.querySelector('canvas'), option.dataset.widget).not.toBeNull()
      expect(option.textContent, option.dataset.widget).not.toContain('Lightweight preview')
    }
  })

  it('draws the alert feed through its canvas design, sample alerts and all (screen state)', () => {
    render(<WidgetGallery onSelect={() => {}} />)

    const alerts = screen.getByRole('option', { name: /Alerts/i })
    expect(alerts.textContent).not.toContain('Lightweight preview')
    // The sample's own newest-first card, painted — not the "no active alerts" empty state the
    // preview showed while `ctx.alerts` was hardcoded to [].
    expect(paintedText('Alerts preview')).toContain('Disk almost full')
  })

  it('draws the chart through its canvas design, with a plotted line rather than a summary', () => {
    render(<WidgetGallery onSelect={() => {}} />)

    const chart = screen.getByRole('option', { name: /Chart/i })
    expect(chart.querySelector('canvas')).not.toBeNull()
    // The definition's sample config labels its one series "Value", and the legend paints it. The
    // loud "Feed missing" notice would be here instead if `ctx.series` were absent or reported the
    // sample series as missing — the same class of regression as `alert_feed`'s empty `ctx.alerts`.
    expect(paintedText('Chart preview')).toContain('Value')
    expect(paintedText('Chart preview')).not.toContain('Feed missing')
    expect(paintedText('Chart preview')).not.toContain('no data')
  })

  it('contains full-size Weather and canvas previews in standard and narrow gallery tracks', () => {
    const gallery = (shellWidth: number) => (
      <div data-testid="gallery-shell" style={{ width: `${shellWidth}px` }}>
        <WidgetGallery onSelect={() => {}} />
      </div>
    )
    const assertResponsiveFrames = () => {
      const weather = screen.getByRole('option', { name: /Five-day forecast/i })
      const weatherFrame = weather.querySelector('.widget-preview-frame') as HTMLElement
      expect(weatherFrame.style.width).toBe('100%')
      expect(weatherFrame.style.maxWidth).toBe('300px')
      expect(weatherFrame.style.aspectRatio).toBe('300 / 169')
      expect((weatherFrame.querySelector('canvas') as HTMLCanvasElement).width).toBe(600)

      // `value_tile`, the gallery's smallest frame — it was a "legacy" preview when this assertion
      // has always been a canvas design; the frame arithmetic it pins is the
      // same either way.
      const value = screen.getByRole('option', { name: /^Value$/i })
      const smallFrame = value.querySelector('.widget-preview-frame') as HTMLElement
      expect(smallFrame.style.width).toBe('100%')
      expect(smallFrame.style.maxWidth).toBe('105px')
      expect(smallFrame.style.aspectRatio).toBe('105 / 70')
    }
    const { rerender } = render(gallery(1200))
    assertResponsiveFrames()

    rerender(gallery(220))
    expect(screen.getByTestId('gallery-shell').style.width).toBe('220px')
    assertResponsiveFrames()
  })
})

describe('WidgetGallery selection', () => {
  it('emits one widget ID on click and exposes selected state', async () => {
    const onSelect = vi.fn()
    render(<WidgetGallery selectedWidget="news_list" onSelect={onSelect} />)

    const news = screen.getByRole('option', { name: /News list/i })
    const weather = screen.getByRole('option', { name: /Five-day forecast/i })
    expect(news.getAttribute('aria-selected')).toBe('true')
    expect(news.tabIndex).toBe(0)
    expect(weather.getAttribute('aria-selected')).toBe('false')

    await userEvent.click(weather)
    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(onSelect).toHaveBeenCalledWith('weather_forecast')
  })

  it('moves roving focus with arrow keys and selects the focused option with Enter or Space', () => {
    const onSelect = vi.fn()
    render(<WidgetGallery selectedWidget="clock" onSelect={onSelect} />)

    // Roving order follows the catalogue, so the neighbour is whatever is defined next — asserted
    // by identity rather than by name so adding a widget moves this test rather than breaking it
    // silently.
    const clock = screen.getByRole('option', { name: /Clock/i })
    const alerts = screen.getByRole('option', { name: /Alerts/i })
    const calendar = screen.getByRole('option', { name: /Calendar/i })
    clock.focus()
    fireEvent.keyDown(clock, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(alerts)

    fireEvent.keyDown(alerts, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(calendar)

    fireEvent.keyDown(calendar, { key: 'Enter' })
    expect(onSelect).toHaveBeenLastCalledWith('calendar_events')
    fireEvent.keyDown(calendar, { key: ' ' })
    expect(onSelect).toHaveBeenLastCalledWith('calendar_events')
    expect(onSelect).toHaveBeenCalledTimes(2)
  })
})
