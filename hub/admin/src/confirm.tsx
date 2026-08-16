import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'

/**
 * Destructive confirmation, in the app rather than in the browser chrome.
 *
 * `confirm()` was doing this job. It blocks the whole renderer, it cannot be styled, it cannot say
 * which of two things you are about to lose in anything but one run-on line, and on a wall-mounted
 * kiosk the browser draws it wherever it likes. It is also the one dialog a user has been trained
 * to dismiss without reading.
 *
 * NOT a native `<dialog>`: jsdom 29 does not implement `showModal`, so every test touching a
 * deletion would have to stub it or skip. This is the same contract built by hand — a backdrop, a
 * focus trap, Escape to cancel, focus restored to whatever opened it — which is a fair trade for
 * deletions staying testable.
 *
 * Returns `[ask, dialog]`. Render `dialog` anywhere in the page; call `ask` with what is about to
 * be destroyed and what to do if the operator means it.
 */
export interface ConfirmRequest {
  /** What is about to happen, phrased as the action — "Delete Kitchen Sink?" */
  title: string
  /** The consequence, in a sentence. Say what is lost, not "this cannot be undone". */
  body?: string
  /** The verb on the destructive button. Matches the title's verb, always. */
  confirmLabel?: string
}

type Pending = ConfirmRequest & { onConfirm: () => void | Promise<void> }

export function useConfirm(): [(req: ConfirmRequest, onConfirm: () => void | Promise<void>) => void, ReactElement | null] {
  const [pending, setPending] = useState<Pending | null>(null)
  const [busy, setBusy] = useState(false)
  const confirmRef = useRef<HTMLButtonElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  // Whatever had focus when this opened, so Escape or Cancel puts it back rather than dumping
  // focus at the top of the document.
  const opener = useRef<Element | null>(null)

  const ask = useCallback((req: ConfirmRequest, onConfirm: () => void | Promise<void>) => {
    opener.current = document.activeElement
    setPending({ ...req, onConfirm })
  }, [])

  const close = useCallback(() => {
    setPending(null)
    setBusy(false)
    const back = opener.current
    if (back instanceof HTMLElement) back.focus()
  }, [])

  useEffect(() => {
    if (!pending) return
    // The destructive button is NOT focused first — that is how a reflexive Enter deletes
    // something. Focus the panel; the operator has to travel to the verb deliberately.
    panelRef.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); close(); return }
      if (e.key !== 'Tab') return
      // Focus trap: a modal the keyboard can walk out of is a modal in name only.
      const focusable = panelRef.current?.querySelectorAll<HTMLElement>('button')
      if (!focusable || focusable.length === 0) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [pending, close])

  const run = async () => {
    if (!pending || busy) return
    setBusy(true)
    try {
      await pending.onConfirm()
    } finally {
      close()
    }
  }

  const dialog = pending ? (
    <div
      className="modal-backdrop"
      // A click on the backdrop is a cancel; a click inside must not be.
      onMouseDown={(e) => { if (e.target === e.currentTarget) close() }}
    >
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        tabIndex={-1}
        ref={panelRef}
      >
        <h2 id="confirm-title">{pending.title}</h2>
        {pending.body && <p>{pending.body}</p>}
        <div className="modal-actions">
          <button type="button" onClick={close} disabled={busy}>Cancel</button>
          <button type="button" className="danger" ref={confirmRef} onClick={run} disabled={busy}>
            {pending.confirmLabel ?? 'Delete'}
          </button>
        </div>
      </div>
    </div>
  ) : null

  return [ask, dialog]
}
