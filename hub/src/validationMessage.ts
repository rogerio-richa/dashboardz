/**
 * Turns AJV's raw validation output into one line an operator can act on.
 *
 * Why this exists: the widget registry validates each grid cell with a `oneOf` arm per widget,
 * so ONE bad config key produces a wall — the real error, plus a "must be equal to constant"
 * for every arm that didn't match, plus a trailing "must match exactly one schema in oneOf".
 * Saving a clock cell with an unknown key returned ten clauses and never named the cell or the
 * widget. That is unusable in the editor's error strip.
 *
 * The rule: drop the arm-selection noise (`const` failures on the discriminator, and the `oneOf`
 * summary), keep the first substantive error, and say WHERE it is in the operator's vocabulary
 * ("cell 3 (gauge)") rather than JSON-pointer vocabulary ("/grid/cells/2/config").
 *
 * Returns null for anything that is not a grid-cell error, so every other route keeps AJV's own
 * message unchanged — /api/notify's "must NOT have additional properties" is already clear.
 *
 * House rule: this runs inside an error handler, so it must never throw. Anything unexpected
 * returns null and the caller falls back to AJV's own message.
 */

interface AjvError {
  instancePath?: string
  keyword?: string
  message?: string
  params?: Record<string, unknown>
}

const CELL_RE = /^\/grid\/cells\/(\d+)/

/** `/grid/cells/2/config/min` → `cell 3 (gauge): min ...` when the body tells us the widget. */
function locate(instancePath: string, body: unknown): { where: string; rest: string } | null {
  const m = CELL_RE.exec(instancePath)
  if (!m) return null
  const idx = Number(m[1])
  const cells = (body as { grid?: { cells?: { widget?: unknown }[] } })?.grid?.cells
  const widget = Array.isArray(cells) && typeof cells[idx]?.widget === 'string' ? cells[idx].widget : null
  const rest = instancePath.slice(m[0].length).replace(/^\/config\/?/, '').replace(/\//g, '.')
  return { where: widget ? `cell ${idx + 1} (${widget})` : `cell ${idx + 1}`, rest }
}

export function readableValidationError(validation: unknown, body: unknown): string | null {
  try {
    if (!Array.isArray(validation) || validation.length === 0) return null
    const errs = validation as AjvError[]
    // Arm-selection noise: the discriminator `const` misses and the `oneOf` summary say nothing
    // about what the operator typed wrong.
    const substantive = errs.filter(
      (e) => e.keyword !== 'oneOf' && !(e.keyword === 'const' && (e.instancePath ?? '').endsWith('/widget')),
    )
    const e = substantive[0] ?? errs[0]
    if (!e) return null
    const path = e.instancePath ?? ''
    const loc = locate(path, body)
    // Scoped deliberately: the wall this exists to fix is the widget registry's per-widget oneOf.
    // Every other route keeps AJV's own wording, which is already specific enough there.
    if (!loc) return null

    let what: string
    if (e.keyword === 'additionalProperties') {
      const key = e.params?.additionalProperty
      what = `unknown config key "${String(key)}"`
    } else if (e.keyword === 'enum') {
      const allowed = e.params?.allowedValues
      what = `${loc?.rest || path || 'value'} must be one of ${Array.isArray(allowed) ? allowed.join(', ') : 'the allowed values'}`
    } else {
      const field = loc?.rest || path.replace(/^\//, '').replace(/\//g, '.')
      what = `${field ? `${field} ` : ''}${e.message ?? 'is invalid'}`
    }

    const msg = `${loc.where}: ${what}`
    // Never hand back something unbounded; the editor renders this inline.
    return msg.length > 180 ? `${msg.slice(0, 177)}...` : msg
  } catch {
    return null
  }
}
