import { useEffect, useRef, useState } from 'react'

export interface MultiSelectOption {
  value: string
  label: string
  /** Shown in mono: an id whose record is gone, kept visible so it can still be unticked. */
  missing?: boolean
}

interface MultiSelectProps {
  /** Accessible name of the trigger button, e.g. "Allowed senders". */
  label: string
  options: MultiSelectOption[]
  selected: string[]
  onChange: (next: string[]) => void
  /** What the button says when nothing is ticked, e.g. "Any sender". */
  emptyText: string
  /** Accessible name of each option's checkbox, e.g. (o) => `Allow sender ${o.label}`. */
  optionLabel?: (option: MultiSelectOption) => string
  /** Shown inside the open list when there are no options at all. */
  noOptionsText?: string
}

/** Past this many options the list grows a filter box; below it the box is just noise. */
const FILTER_FROM = 8

/**
 * A button that opens a short, scrollable list of checkboxes.
 *
 * It replaced a row of inline checkboxes on the feed form, which with fourteen senders wrapped
 * into an unreadable line of names. Closed, it says what is ticked in a few words; open, it is a
 * plain list of real checkboxes, so keyboard and screen-reader behaviour come from the browser.
 * Every control is type="button" because it lives inside forms.
 */
export default function MultiSelect({
  label, options, selected, onChange, emptyText, optionLabel = (o) => o.label, noOptionsText,
}: MultiSelectProps) {
  const [open, setOpen] = useState(false)
  const [filter, setFilter] = useState('')
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    const onPointer = (e: MouseEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      // Escape closes the list, not whatever dialog or edit row the picker sits in.
      e.stopPropagation()
      setOpen(false)
      trigger.current?.focus()
    }
    document.addEventListener('mousedown', onPointer)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('mousedown', onPointer)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [open])

  useEffect(() => { if (!open) setFilter('') }, [open])

  const names = options.filter((o) => selected.includes(o.value)).map((o) => o.label)
  const summary = names.length === 0
    ? emptyText
    : names.length <= 2 ? names.join(', ') : `${names.slice(0, 2).join(', ')} +${names.length - 2}`

  const needle = filter.trim().toLowerCase()
  const shown = needle === '' ? options : options.filter((o) => o.label.toLowerCase().includes(needle))

  const toggle = (value: string, on: boolean) => onChange(
    on ? [...selected, value] : selected.filter((v) => v !== value),
  )

  return (
    <div className="multi-select" ref={root}>
      <button
        ref={trigger}
        type="button"
        className="multi-select-trigger"
        aria-label={label}
        aria-expanded={open}
        title={names.length > 2 ? names.join(', ') : undefined}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="multi-select-summary">{summary}</span>
        <span aria-hidden className="multi-select-caret">▾</span>
      </button>
      {open && (
        <div className="multi-select-panel" role="group" aria-label={label}>
          {options.length > FILTER_FROM && (
            <input
              type="text"
              className="multi-select-filter"
              aria-label={`Filter ${label.toLowerCase()}`}
              placeholder="Filter"
              value={filter}
              autoFocus
              onChange={(e) => setFilter(e.target.value)}
              // Enter here would submit the surrounding form.
              onKeyDown={(e) => { if (e.key === 'Enter') e.preventDefault() }}
            />
          )}
          <div className="multi-select-options">
            {shown.map((o) => (
              <label key={o.value} className="multi-select-option">
                <input
                  type="checkbox"
                  aria-label={optionLabel(o)}
                  checked={selected.includes(o.value)}
                  onChange={(e) => toggle(o.value, e.target.checked)}
                />
                {o.missing ? <code>{o.label}</code> : <span>{o.label}</span>}
              </label>
            ))}
            {options.length === 0 && noOptionsText && <p className="hint multi-select-empty">{noOptionsText}</p>}
            {options.length > 0 && shown.length === 0 && <p className="hint multi-select-empty">No match</p>}
          </div>
          <div className="multi-select-foot">
            <button type="button" disabled={selected.length === 0} onClick={() => onChange([])}>Clear</button>
            <button type="button" onClick={() => { setOpen(false); trigger.current?.focus() }}>Done</button>
          </div>
        </div>
      )}
    </div>
  )
}
