import { useState } from 'react'
import { IconEdit } from './icons'
import { EVENT_LABELS, SOUND_EVENTS, playPreview, type SoundFamilies } from './sounds'

/**
 * Mixer-rows sound picker: one row per alert event, each showing the family that would actually
 * play (with WHERE that choice came from — an explicit override on this screen/theme, or the
 * fallback the caller resolved), a ▶ chip to audition it in-browser, and an expandable strip of
 * every family to pick from (each with its own ▶, so you can compare before committing).
 *
 * Two callers, two flavours: a screen's sound editor passes the theme's resolved
 * choice as `suggestion` (`suggestionLabel="from theme"`); a theme's own editor has no further
 * fallback beyond 'classic', so it passes `suggestion={null}` (`suggestionLabel="default"`) and
 * this component treats a null suggestion as "everything falls back to classic".
 *
 * `value` is the sparse override map being edited — only events explicitly chosen live in it.
 * Every mutation here (pick, reset, apply-whole-set) computes the NEXT sparse map and hands it to
 * `onChange` whole; this component holds no override state of its own, only which row is expanded.
 */

const row = { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 } as const
const label = { width: 130, fontSize: 13 } as const

export function SoundMixer({ families, rev, value, suggestion, suggestionLabel, onChange }: {
  families: SoundFamilies
  rev: number
  value: Record<string, string>
  suggestion: Record<string, string> | null
  suggestionLabel: string
  onChange: (next: Record<string, string>) => void
}) {
  const [expanded, setExpanded] = useState<string | null>(null)

  const effectiveFamily = (event: string): string => value[event] ?? suggestion?.[event] ?? 'classic'
  const familyName = (id: string): string => families[id]?.name ?? id

  const selectFamily = (event: string, familyId: string) => {
    onChange({ ...value, [event]: familyId })
    setExpanded(null)
  }

  const resetEvent = (event: string) => {
    const next = { ...value }
    delete next[event]
    onChange(next)
  }

  const applyWholeSet = (familyId: string) => {
    if (!familyId) return
    onChange(Object.fromEntries(SOUND_EVENTS.map((event) => [event, familyId])))
  }

  return (
    <div>
      <div style={row}>
        <span style={label}>Apply whole set</span>
        <select aria-label="Apply whole set" value="" onChange={(e) => applyWholeSet(e.target.value)}>
          <option value="">Choose a family…</option>
          {Object.entries(families).map(([id, fam]) => <option key={id} value={id}>{fam.name}</option>)}
        </select>
      </div>

      {SOUND_EVENTS.map((event) => {
        const effective = effectiveFamily(event)
        const overridden = Object.prototype.hasOwnProperty.call(value, event)
        const provenance = overridden ? 'overridden' : suggestionLabel
        const isExpanded = expanded === event

        return (
          <div key={event}>
            <div style={row}>
              <span style={label}>{EVENT_LABELS[event]}</span>
              <button
                type="button"
                aria-label={`Play ${EVENT_LABELS[event]} sound`}
                onClick={() => playPreview(effective, event, rev)}
              >
                ▶
              </button>
              <span aria-label={`${EVENT_LABELS[event]} sound: ${familyName(effective)} (${provenance})`}>
                {familyName(effective)} <small style={{ color: 'var(--muted)' }}>({provenance})</small>
              </span>
              {/* A pencil, not a disclosure arrow: the strip this opens is where the choice is
                  MADE, and "edit this row's sound" is what the button means. */}
              <button
                type="button"
                className="icon-button"
                aria-label={`Choose ${EVENT_LABELS[event]} sound`}
                aria-expanded={isExpanded}
                onClick={() => setExpanded(isExpanded ? null : event)}
              >
                <IconEdit />
              </button>
              {overridden && (
                <button type="button" aria-label={`Reset ${EVENT_LABELS[event]} sound`} onClick={() => resetEvent(event)}>
                  ↺
                </button>
              )}
            </div>

            {isExpanded && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, margin: '0 0 10px 130px' }}>
                {Object.entries(families).map(([id, fam]) => (
                  <div key={id} style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                    <button
                      type="button"
                      className="sound-chip"
                      aria-selected={id === effective}
                      aria-label={`Use ${fam.name} for ${EVENT_LABELS[event]}`}
                      onClick={() => selectFamily(event, id)}
                    >
                      {fam.name}
                    </button>
                    <button
                      type="button"
                      aria-label={`Play ${fam.name} for ${EVENT_LABELS[event]}`}
                      onClick={() => playPreview(id, event, rev)}
                    >
                      ▶
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
