import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
// @ts-expect-error plain JS module without types
import { findCodeDocProblems } from '../../scripts/check-code-docs.mjs'

/**
 * `docs/code/` is the code-reading guide: one page per code section, linking the files it
 * describes. Pages that name moved or deleted files are confident, wrong answers, the failure
 * `screens-doc.test.ts` describes for the screen guide. The check itself lives in
 * `scripts/check-code-docs.mjs` so `scripts/check-all.sh` can run it without the hub's
 * dependencies; this runs the same function so CI's hub job fails on drift as well.
 */
describe('docs/code stays in sync with the tree', () => {
  it('has no broken code links, no uncovered sections and no unlisted pages', () => {
    const root = fileURLToPath(new URL('../../', import.meta.url))
    expect(findCodeDocProblems(root)).toEqual([])
  })
})
