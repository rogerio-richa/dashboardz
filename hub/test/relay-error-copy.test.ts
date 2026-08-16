import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { RELAY_ERROR_CODES } from '../src/relay/client.js'
import { RELAY_TEST_FAILURES } from '../src/relay/manager.js'

/**
 * The admin's ERROR_COPY map is a hand-written duplicate of RELAY_ERROR_CODES — the admin
 * bundle cannot import server TypeScript (separate tsconfig roots), so the two are pinned
 * lexically instead, the same way bindings.mjs pins its server copy.
 */
describe('relay error copy', () => {
  it('RelayBadge has plain-words copy for every relay error code', () => {
    const src = readFileSync(
      fileURLToPath(new URL('../admin/src/RelayBadge.tsx', import.meta.url)), 'utf8')
    for (const code of RELAY_ERROR_CODES) {
      // Anchored to the start of a (possibly indented) line: unanchored `${code}:` would let
      // e.g. code 'closed' match inside a key like 'unclosed:', silently passing on a typo.
      expect(src, `ERROR_COPY is missing '${code}'`).toMatch(new RegExp('^\\s*' + code + ':', 'm'))
    }
  })

  it('RelayBadge has plain-words copy for every relay test-failure code', () => {
    const src = readFileSync(
      fileURLToPath(new URL('../admin/src/RelayBadge.tsx', import.meta.url)), 'utf8')
    for (const code of RELAY_TEST_FAILURES) {
      // Anchored to the start of a (possibly indented) line: unanchored `${code}:` would let
      // e.g. code 'closed' match inside a key like 'unclosed:', silently passing on a typo.
      expect(src, `TEST_ERROR_COPY is missing '${code}'`).toMatch(new RegExp('^\\s*' + code + ':', 'm'))
    }
  })
})
