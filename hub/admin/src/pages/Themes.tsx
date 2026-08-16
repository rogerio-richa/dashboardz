import { useEffect, useState } from 'react'
import { api } from '../api'
import { useConfirm } from '../confirm'
import { IconEdit, IconTrash, IconCopy } from '../icons'
// @ts-expect-error plain JS module without types
import { designIdsFor, widgetsWithDesigns } from '../../../static/device/widgets/catalogue.mjs'
import { fetchSoundManifest, type SoundFamilies } from '../sounds'
import { SoundMixer } from '../SoundMixer'

/**
 * Theme authoring. This page edits the theme API and presents its current state.
 *
 * THIS PAGE SELECTS; IT DOES NOT AUTHOR COLOURS.
 *
 * A theme owns its background and its board block, and then *picks* — per widget type — a design
 * and a colorset. It does not contain colour values for a design, which is why the schema stores
 * `colorset_id` and not colours. An earlier version of this page let you type slot colours here
 * and wrote them through to whichever colorset the theme referenced; that silently rewrote a
 * shared, named object from a screen that gave no hint it was shared. Colour sets are authored on
 * the Colorsets page, where their usage is visible before you touch them.
 *
 * TWO RULES THAT ARE EASY TO BREAK AND EXPENSIVE TO NOTICE:
 *
 * 1. PATCH replaces `board`/`chrome`/`widgets` WHOLESALE. Sending a partial object silently drops
 *    every sibling key. So the editor always holds a complete working copy and always sends all of
 *    it. Themes.test.tsx pins this — it is the data-loss shape in this API.
 * 2. Only `thm_default` is read-only. It reproduces today's palette exactly and is the reference
 *    point the v7 migration's no-op property rests on. Every other seeded preset (`cypherpunk`) is
 *    a starting point, not a fixture, and must stay editable — otherwise a bad seeded palette can
 *    only be escaped by duplicating it and leaving the original behind.
 */

const READ_ONLY_THEME = 'thm_default'

/**
 * Which designs exist per widget. Mirrors the renderer's catalogue; a stale entry degrades safely
 * because an unknown design falls back to the widget's default at render time. Same convenience-
 * not-a-contract stance CellConfig takes, and the same reason the schema does not enumerate ids.
 */
// Asked of the renderer's registry, never mirrored — see the note in CellConfig.tsx. This list
// was hand-written until the nixie design made it stale.


/** Names the device renderer can actually draw (theme.mjs BACKDROPS). */
const BACKDROPS = ['flat', 'wash', 'glow', 'grid', 'cards'] as const

interface ThemeRow {
  id: string; name: string
  backdrop: string
  board: Record<string, unknown>
  chrome: Record<string, string>
  /** Design id per widget type (v11). A theme names geometry; the palette names colour. */
  widgets: Record<string, string>
  /** Sparse event->family override map. Unset events fall back to 'classic' (SoundMixer). */
  sounds: Record<string, string>
  bg_kind: string; bg_color: string | null; bg_rev: number
  rev: number; builtin: boolean; created_at: number
}

/** Board keys in the order an author thinks about them, not alphabetical. */
const BOARD_COLOURS = ['bg', 'surface', 'ink', 'dim', 'accent', 'info', 'warn', 'critical'] as const
const CHROME_KEYS = [
  'hairline', 'muted', 'chip', 'border', 'surface_warn', 'surface_critical',
  'takeover_bg', 'takeover_meta', 'takeover_body', 'takeover_hint_bg', 'on_critical',
] as const

const row = { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 } as const
const label = { width: 130, fontSize: 13 } as const

function ColourField({ name, value, onChange }: {
  name: string; value: string; onChange: (v: string) => void
}) {
  return (
    <div style={row}>
      <span style={label}>{name}</span>
      <span aria-hidden style={{
        width: 18, height: 18, borderRadius: 3, border: '1px solid #888',
        background: value || 'transparent',
      }} />
      <input
        aria-label={name}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={{ width: 110, fontFamily: 'monospace' }}
      />
    </div>
  )
}

export default function Themes() {
  const [themes, setThemes] = useState<ThemeRow[]>([])
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState<ThemeRow | null>(null)
  const [showChrome, setShowChrome] = useState(false)
  const [error, setError] = useState('')
  const [ask, confirmDialog] = useConfirm()
  const [manifest, setManifest] = useState<{ rev: number; families: SoundFamilies }>({ rev: 0, families: {} })

  const refresh = () => api<ThemeRow[]>('/admin/api/themes').then(setThemes).catch(() => {})
  useEffect(() => { refresh() }, [])
  useEffect(() => { fetchSoundManifest().then(setManifest) }, [])

  /** A theme's entry for a widget type is the design id; clearing it removes the entry entirely. */
  const chooseDesign = (widget: string, design: string) => {
    setDraft((d) => (d ? {
      ...d,
      widgets: design === ''
        ? Object.fromEntries(Object.entries(d.widgets).filter(([k]) => k !== widget))
        : { ...d.widgets, [widget]: design },
    } : d))
  }

  const edit = (t: ThemeRow) => {
    // A deep-ish copy so edits never mutate the list, and so the draft always carries EVERY key —
    // see rule above.
    setDraft({
      ...t, board: { ...t.board }, chrome: { ...t.chrome }, widgets: { ...t.widgets },
      sounds: { ...t.sounds },
    })
    setEditingId(t.id)
    setShowChrome(false)
    setError('')
  }

  const setBoard = (k: string, v: string | number) =>
    setDraft((d) => (d ? { ...d, board: { ...d.board, [k]: v } } : d))
  const setChrome = (k: string, v: string) =>
    setDraft((d) => (d ? { ...d, chrome: { ...d.chrome, [k]: v } } : d))

  const save = async () => {
    if (!draft) return
    try {
      // Complete sub-objects, always. A partial board/chrome drops sibling keys server-side.
      await api(`/admin/api/themes/${draft.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          name: draft.name, board: draft.board, chrome: draft.chrome, widgets: draft.widgets,
          sounds: draft.sounds, backdrop: draft.backdrop ?? 'flat',
        }),
      })
      setEditingId(null)
      setDraft(null)
      refresh()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  /**
   * Immediate, not draft-gated (see the JSX comment on the row). `api()`'s default JSON
   * content-type is overridden with the file's own — the route sniffs the bytes and 400s on a
   * mismatch, so sending the real type is load-bearing, not cosmetic. The input is cleared even
   * on failure so re-picking the same file fires onChange again.
   */
  const uploadBg = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file || !draft) return
    try {
      const res = await api<{ ok: boolean; bg_rev: number }>(`/admin/api/themes/${draft.id}/bg`, {
        method: 'PUT', headers: { 'content-type': file.type }, body: file,
      })
      setDraft((d) => (d ? { ...d, bg_kind: 'image', bg_rev: res.bg_rev } : d))
      refresh()
    } catch (err) {
      setError((err as Error).message)
    }
  }

  /** Field-level PATCH — bg_kind 'none' turns the image off; the bytes on disk are inert. */
  const removeBg = async () => {
    if (!draft) return
    try {
      await api(`/admin/api/themes/${draft.id}`, {
        method: 'PATCH', body: JSON.stringify({ bg_kind: 'none' }),
      })
      setDraft((d) => (d ? { ...d, bg_kind: 'none' } : d))
      refresh()
    } catch (err) {
      setError((err as Error).message)
    }
  }

  const duplicate = async (t: ThemeRow) => {
    try {
      await api('/admin/api/themes', {
        method: 'POST',
        body: JSON.stringify({
          name: `${t.name} copy`, board: t.board, chrome: t.chrome, widgets: t.widgets,
          sounds: t.sounds, backdrop: t.backdrop ?? 'flat',
        }),
      })
      refresh()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  return (
    <section>
      {error && <p style={{ color: '#c00' }}>{error}</p>}
      <table style={{ borderCollapse: 'collapse', marginBottom: 16 }}>
        <tbody>
          {themes.map((t) => (
            <tr key={t.id}>
              <td style={{ padding: '4px 12px 4px 0' }}>{t.name}</td>
              <td style={{ padding: '4px 8px', color: '#666', fontSize: 12 }}>rev {t.rev}</td>
              <td style={{ padding: '4px 0' }}>
                {t.id === READ_ONLY_THEME
                  ? <button onClick={() => duplicate(t)}><IconCopy />Duplicate {t.name}</button>
                  : <button onClick={() => edit(t)}><IconEdit />Edit {t.name}</button>}
                {/*
                  A built-in cannot be deleted — the API refuses it, so offering the button would
                  be offering a 400. Copy it and delete the copy; that is what Duplicate is for.
                */}
                {!t.builtin && (
                  <button onClick={() => ask(
                    {
                      title: `Delete ${t.name}?`,
                      body: 'Any screen using it falls back to the built-in default. The screens themselves are untouched.',
                    },
                    async () => {
                      try { await api(`/admin/api/themes/${t.id}`, { method: 'DELETE' }); refresh() }
                      catch (err) { setError((err as Error).message) }
                    },
                  )}><IconTrash />Delete</button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {draft && editingId && (
        <div>
          <h3 style={{ marginBottom: 8 }}>{draft.name}</h3>

          {/*
            The procedural backdrop: a NAME, derived from the palette below rather than an asset.
            Change a colour and the backdrop follows, which is what makes shipping themes cheap
            and why built-ins need no image files.
          */}
          <div style={row}>
            <span style={label}>backdrop</span>
            <select
              aria-label="backdrop"
              value={draft.backdrop ?? 'flat'}
              onChange={(e) => setDraft((d) => (d ? { ...d, backdrop: e.target.value } : d))}
            >
              {BACKDROPS.map((b) => <option key={b} value={b}>{b}</option>)}
            </select>
          </div>

          {/*
            Background IMAGE — unlike everything else in this editor it is NOT draft-until-Save:
            the bytes go straight to their own route (PUT /admin/api/themes/:id/bg, which bumps
            bg_rev + the theme's rev and fans out to devices), and Remove is a field-level PATCH.
            Draft state only mirrors what the server confirmed, so Save theme never carries bg_kind
            and cannot fight this row. The image paints OVER the procedural backdrop (db/themes.ts).
          */}
          <div style={row}>
            <span style={label}>background image</span>
            {draft.bg_kind === 'image' && (
              <>
                <span style={{ fontSize: 12 }}>set · rev {draft.bg_rev}</span>
                <button type="button" aria-label="Remove background image" onClick={() => void removeBg()}>
                  Remove
                </button>
              </>
            )}
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp"
              aria-label="Upload background image"
              onChange={(e) => void uploadBg(e)}
            />
          </div>

          {BOARD_COLOURS.map((k) => (
            <ColourField
              key={k}
              name={`board ${k}`}
              value={String(draft.board[k] ?? '')}
              onChange={(v) => setBoard(k, v)}
            />
          ))}

          <div style={row}>
            <span style={label}>board scrim</span>
            <input
              aria-label="board scrim" type="number" step="0.05" min="0" max="1"
              value={String(draft.board.scrim ?? '')}
              onChange={(e) => setBoard('scrim', Number(e.target.value))}
              style={{ width: 110 }}
            />
          </div>

          {/* Card gap (px): only consumed under the `cards` backdrop — the pipeline insets each
              cell's card by this much, so flush cells read as separate cards. Unset = renderer
              default (2). */}
          <div style={row}>
            <span style={label}>card gap</span>
            <input
              aria-label="card gap" type="number" step="1" min="0" max="16"
              value={String(draft.board.card_gap ?? '')}
              onChange={(e) => setBoard('card_gap', Number(e.target.value))}
              style={{ width: 110 }}
            />
          </div>

          {/* Interior padding between a card's border and its widget's content — same consumer
              (the cards pipeline) as card gap. Unset = renderer default (8). */}
          <div style={row}>
            <span style={label}>card padding</span>
            <input
              aria-label="card padding" type="number" step="1" min="0" max="24"
              value={String(draft.board.card_padding ?? '')}
              onChange={(e) => setBoard('card_padding', Number(e.target.value))}
              style={{ width: 110 }}
            />
          </div>

          <button onClick={() => setShowChrome((s) => !s)} style={{ margin: '8px 0' }}>
            Chrome colours
          </button>
          {showChrome && CHROME_KEYS.map((k) => (
            <ColourField
              key={k}
              name={`chrome ${k}`}
              value={draft.chrome[k] ?? ''}
              onChange={(v) => setChrome(k, v)}
            />
          ))}

          {/*
            Per-widget SELECTION — two dropdowns, no colour fields. The theme says "clocks in this
            theme are segment clocks wearing colors_2054"; what colors_2054 actually contains is
            the Colorsets page's business. A widget with no design chosen follows the board block,
            and a design with no colorset falls back to board colours slot by slot.
          */}
          <h4 style={{ margin: '16px 0 4px' }}>Per-widget style</h4>
          {(widgetsWithDesigns() as string[]).map((widget) => {

            const chosen = draft.widgets[widget] ?? ''
            return (
              <div key={widget} style={{ marginBottom: 12 }}>
                <div style={row}>
                  <span style={label}>{widget} design</span>
                  <select
                    aria-label={`${widget} design`}
                    value={chosen}
                    onChange={(e) => chooseDesign(widget, e.target.value)}
                  >
                    <option value="">follow the board</option>
                    {(designIdsFor(widget) as string[]).map((d) => <option key={d} value={d}>{d}</option>)}
                  </select>
                </div>

              </div>
            )
          })}

          {/*
            A theme has no fallback beyond 'classic' (no theme-of-a-theme), so suggestion is null
            and every un-overridden event shows the "default" badge. The screen editor instead
            passes the theme's resolved choice as its suggestion.
          */}
          <h4 style={{ margin: '16px 0 4px' }}>Sounds</h4>
          <SoundMixer
            families={manifest.families}
            rev={manifest.rev}
            value={draft.sounds}
            suggestion={null}
            suggestionLabel="default"
            onChange={(sounds) => setDraft((d) => (d ? { ...d, sounds } : d))}
          />

          <div style={{ marginTop: 12 }}>
            <button onClick={save}>Save theme</button>{' '}
            <button onClick={() => { setEditingId(null); setDraft(null) }}>Cancel</button>
          </div>
        </div>
      )}
      {confirmDialog}
    </section>
  )
}
