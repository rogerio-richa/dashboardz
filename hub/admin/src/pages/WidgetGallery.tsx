import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
// @ts-expect-error plain JS module without types
import { WIDGET_DEFINITIONS } from '../../../static/device/widgets/definitions.mjs'
import WidgetPreview from './WidgetPreview'

interface WidgetDefinition {
  id: string
  label: string
  description: string
  advanced: boolean
  suggested_ratio: number
  minimum_px: { w: number; h: number }
  sample_config: Record<string, unknown>
  sample_data: unknown
}

export interface WidgetGalleryProps {
  selectedWidget?: string | null
  onSelect: (widget: string) => void
}

const definitions = WIDGET_DEFINITIONS as WidgetDefinition[]
const groups = [
  { label: 'Common', definitions: definitions.filter((definition) => !definition.advanced) },
  { label: 'Advanced', definitions: definitions.filter((definition) => definition.advanced) },
]
const orderedDefinitions = groups.flatMap((group) => group.definitions)

function previewSize(definition: WidgetDefinition): { width: number; height: number } {
  const width = Math.max(
    definition.minimum_px.w,
    Math.round(definition.minimum_px.h * definition.suggested_ratio),
  )
  return {
    width,
    height: Math.max(definition.minimum_px.h, Math.round(width / definition.suggested_ratio)),
  }
}

export default function WidgetGallery({ selectedWidget = null, onSelect }: WidgetGalleryProps) {
  const initial = definitions.some((definition) => definition.id === selectedWidget)
    ? selectedWidget as string
    : definitions[0]?.id ?? ''
  const [activeWidget, setActiveWidget] = useState(initial)
  const optionRefs = useRef(new Map<string, HTMLButtonElement>())

  useEffect(() => {
    if (selectedWidget && definitions.some((definition) => definition.id === selectedWidget)) {
      setActiveWidget(selectedWidget)
    }
  }, [selectedWidget])

  const moveFocus = (widget: string, key: string) => {
    const current = orderedDefinitions.findIndex((definition) => definition.id === widget)
    if (current < 0) return
    let next = current
    if (key === 'ArrowDown' || key === 'ArrowRight') next = (current + 1) % orderedDefinitions.length
    else if (key === 'ArrowUp' || key === 'ArrowLeft') next = (current - 1 + orderedDefinitions.length) % orderedDefinitions.length
    else if (key === 'Home') next = 0
    else if (key === 'End') next = orderedDefinitions.length - 1
    else return
    const nextWidget = orderedDefinitions[next].id
    setActiveWidget(nextWidget)
    optionRefs.current.get(nextWidget)?.focus()
  }

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, widget: string) => {
    if (['ArrowDown', 'ArrowRight', 'ArrowUp', 'ArrowLeft', 'Home', 'End'].includes(event.key)) {
      event.preventDefault()
      moveFocus(widget, event.key)
      return
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      onSelect(widget)
    }
  }

  return (
    <div className="widget-gallery" role="listbox" aria-label="Widgets">
      {groups.map((group) => (
        <div className="widget-gallery-group" role="group" aria-label={group.label} key={group.label}>
          <h3>{group.label}</h3>
          <div className="widget-gallery-grid">
            {group.definitions.map((definition) => {
              const size = previewSize(definition)
              const titleId = `widget-gallery-${definition.id}-title`
              const descriptionId = `widget-gallery-${definition.id}-description`
              return (
                <button
                  type="button"
                  role="option"
                  className="widget-gallery-card"
                  data-widget={definition.id}
                  aria-selected={selectedWidget === definition.id}
                  aria-labelledby={titleId}
                  aria-describedby={descriptionId}
                  tabIndex={activeWidget === definition.id ? 0 : -1}
                  key={definition.id}
                  ref={(node) => {
                    if (node) optionRefs.current.set(definition.id, node)
                    else optionRefs.current.delete(definition.id)
                  }}
                  onFocus={() => setActiveWidget(definition.id)}
                  onClick={() => { setActiveWidget(definition.id); onSelect(definition.id) }}
                  onKeyDown={(event) => onKeyDown(event, definition.id)}
                >
                  <WidgetPreview
                    widget={definition.id}
                    config={definition.sample_config}
                    data={definition.sample_data}
                    width={size.width}
                    height={size.height}
                  />
                  <strong id={titleId}>{definition.label}</strong>
                  <span id={descriptionId}>{definition.description}</span>
                </button>
              )
            })}
          </div>
        </div>
      ))}
    </div>
  )
}
