// @ts-expect-error plain JS module without types
import { register, lookup, defaultDesignFor } from '../../static/device/widgets/registry.mjs'
// @ts-expect-error plain JS module without types
import { CATALOGUE } from '../../static/device/widgets/catalogue.mjs'

/**
 * Register every shipped design exactly once — the same bootstrap loop `index.mjs` runs for the
 * device renderer. `register` is a plain `Map.set` keyed by (widget, id), so a design registered
 * twice by two separate importers of this module just overwrites its own entry with itself; safe
 * even under a test runner that re-evaluates this file per test file.
 *
 * `index.mjs` itself cannot be imported from the admin: it pulls in `surface.mjs`/`assets.mjs`,
 * whose `new URL(..., import.meta.url)` sprite-sheet globbing the bundler refuses to resolve
 * outside the device project (same constraint `CellConfig.tsx` already documents for
 * `catalogue.mjs`). `registry.mjs` has no such import — it is pure bookkeeping over the designs
 * it's handed — so it can be imported directly instead of hand-rolling its resolution logic.
 */
for (const design of CATALOGUE) register(design)

export type DesignEntry = {
  meta: {
    id: string
    widget: string
    label: string
    default?: boolean
    options?: Record<string, unknown>
    [key: string]: unknown
  }
}

/**
 * The design a cell will actually render with — same three-tier precedence as `index.mjs`'s
 * `designFor`/`requestedDesign` (theme resolution): `cell.config.design` wins outright when
 * the cell names one at all, even if this build cannot resolve it (an unresolvable explicit name
 * falls straight to the registry default, never through to the theme's choice. The theme's
 * per-widget choice is consulted only when the cell names nothing, and the registry's own default
 * applies only when neither names one. `||`, not `??`: an empty-string `cellDesignId` (a cleared-but-not-
 * deleted form field) is not a real choice and must not suppress the theme's.
 *
 * This is `index.mjs`'s `designFor(cell, themeWidgets)` re-expressed over `lookup`/
 * `defaultDesignFor` (imported, not re-derived) because `index.mjs` itself cannot be imported
 * here — see the module comment above.
 */
export function designFor(
  widget: string, cellDesignId: string, themeWidgets?: Record<string, string>,
): DesignEntry | null {
  if (!defaultDesignFor(widget)) return null
  const requested = cellDesignId || themeWidgets?.[widget] || null
  return lookup(widget, requested)
}
