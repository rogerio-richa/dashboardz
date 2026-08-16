import { beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { migrate } from '../src/db/migrate.js'
import { createDraft, deleteDraft, expireDraft, getDraft } from '../src/db/sourceDrafts.js'

describe('db/sourceDrafts', () => {
  let db: Database.Database

  beforeEach(() => { db = new Database(':memory:'); migrate(db) })

  it('creates an atomic draft with ciphertext secrets and validated output previews', () => {
    const draft = createDraft(db, {
      provider_id: 'dashboardz.rss', package_id: 'dashboardz.builtin', package_version: '1.0.0',
      name: 'Morning news', config: { max_items: 20 }, interval_s: 600, expires_at: 10_000,
      secrets: [{ name: 'url', ciphertext: 'opaque-ciphertext' }],
      outputs: [{
        contract_id: 'dashboardz.news.items/v1', mode: 'stream',
        result: { mode: 'stream', rows: [{ id: 'one', title: 'First' }], dedupe_by: 'id' },
        capabilities: ['news.item.id', 'news.item.title'], content_hash: 'content-hash',
      }],
    }, 1_000)

    expect(getDraft(db, draft.id)).toEqual(expect.objectContaining({
      id: draft.id, config: { max_items: 20 },
      secrets: [expect.objectContaining({ name: 'url', ciphertext: 'opaque-ciphertext' })],
      outputs: [expect.objectContaining({ contract_id: 'dashboardz.news.items/v1', capabilities: ['news.item.id', 'news.item.title'] })],
    }))
  })

  it('expires drafts and cascades all private children', () => {
    const expired = createDraft(db, {
      provider_id: 'dashboardz.rss', package_id: 'dashboardz.builtin', package_version: '1.0.0',
      name: 'Expired', config: {}, interval_s: 600, expires_at: 1_000,
      secrets: [{ name: 'url', ciphertext: 'opaque' }], outputs: [],
    }, 0)
    const fresh = createDraft(db, {
      provider_id: 'dashboardz.rss', package_id: 'dashboardz.builtin', package_version: '1.0.0',
      name: 'Fresh', config: {}, interval_s: 600, expires_at: 2_000, secrets: [], outputs: [],
    }, 0)

    expect(expireDraft(db, 1_000)).toEqual([expired.id])
    expect(getDraft(db, expired.id)).toBeUndefined()
    expect(getDraft(db, fresh.id)).toBeDefined()
    expect(db.prepare('SELECT COUNT(*) AS count FROM source_draft_secrets WHERE draft_id = ?').get(expired.id)).toEqual({ count: 0 })
  })

  it('returns an explicit invalid preview for malformed or mode-mismatched draft result JSON', () => {
    const draft = createDraft(db, {
      provider_id: 'dashboardz.rss', package_id: 'dashboardz.builtin', package_version: '1.0.0',
      name: 'Broken', config: { max_items: 20 }, interval_s: 600, expires_at: 10_000, secrets: [],
      outputs: [{
        contract_id: 'dashboardz.news.items/v1', mode: 'stream',
        result: { mode: 'stream', rows: [], dedupe_by: 'id' }, capabilities: [], content_hash: 'hash',
      }],
    }, 1_000)
    db.prepare('UPDATE source_drafts SET config = ? WHERE id = ?').run('[]', draft.id)
    db.prepare('UPDATE source_draft_outputs SET result = ?, capabilities = ? WHERE draft_id = ?')
      .run(JSON.stringify({ mode: 'value', payload: {} }), '{bad', draft.id)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      expect(getDraft(db, draft.id)).toMatchObject({
        config: {}, outputs: [expect.objectContaining({ result: { mode: 'invalid', reason: 'malformed_preview' }, capabilities: [] })],
      })
      expect(warn).toHaveBeenCalledTimes(3)
    } finally {
      warn.mockRestore()
    }
  })

  it('returns an invalid preview when a stored stream result has non-object rows', () => {
    const draft = createDraft(db, {
      provider_id: 'dashboardz.rss', package_id: 'dashboardz.builtin', package_version: '1.0.0',
      name: 'Invalid stream', config: {}, interval_s: 600, expires_at: 10_000, secrets: [],
      outputs: [{
        contract_id: 'dashboardz.news.items/v1', mode: 'stream',
        result: { mode: 'stream', rows: [], dedupe_by: 'id' }, capabilities: [], content_hash: 'hash',
      }],
    }, 1_000)
    db.prepare('UPDATE source_draft_outputs SET result = ? WHERE draft_id = ?')
      .run(JSON.stringify({ mode: 'stream', rows: [null, 'not an object'], dedupe_by: 'id' }), draft.id)

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      expect(getDraft(db, draft.id)?.outputs[0]?.result).toEqual({ mode: 'invalid', reason: 'malformed_preview' })
      expect(warn).toHaveBeenCalledTimes(1)
    } finally {
      warn.mockRestore()
    }
  })

  it('returns an invalid preview for corrupt stored result JSON', () => {
    const draft = createDraft(db, {
      provider_id: 'dashboardz.rss', package_id: 'dashboardz.builtin', package_version: '1.0.0',
      name: 'Corrupt preview', config: {}, interval_s: 600, expires_at: 10_000, secrets: [],
      outputs: [{
        contract_id: 'dashboardz.news.items/v1', mode: 'stream',
        result: { mode: 'stream', rows: [], dedupe_by: 'id' }, capabilities: [], content_hash: 'hash',
      }],
    }, 1_000)
    db.prepare('UPDATE source_draft_outputs SET result = ? WHERE draft_id = ?').run('{bad', draft.id)

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      expect(getDraft(db, draft.id)?.outputs[0]?.result).toEqual({ mode: 'invalid', reason: 'malformed_preview' })
      expect(warn).toHaveBeenCalledTimes(1)
    } finally {
      warn.mockRestore()
    }
  })

  it('rolls back the draft and all children when a later child violates a uniqueness constraint', () => {
    expect(() => createDraft(db, {
      provider_id: 'dashboardz.rss', package_id: 'dashboardz.builtin', package_version: '1.0.0',
      name: 'Atomic failure', config: {}, interval_s: 600, expires_at: 10_000,
      secrets: [{ name: 'url', ciphertext: 'opaque' }],
      outputs: [
        { contract_id: 'dashboardz.news.items/v1', mode: 'stream', result: { mode: 'stream', rows: [], dedupe_by: 'id' }, capabilities: [], content_hash: 'one' },
        { contract_id: 'dashboardz.news.items/v1', mode: 'stream', result: { mode: 'stream', rows: [], dedupe_by: 'id' }, capabilities: [], content_hash: 'two' },
      ],
    }, 1_000)).toThrow(/UNIQUE/)
    expect(db.prepare('SELECT COUNT(*) AS count FROM source_drafts').get()).toEqual({ count: 0 })
    expect(db.prepare('SELECT COUNT(*) AS count FROM source_draft_secrets').get()).toEqual({ count: 0 })
    expect(db.prepare('SELECT COUNT(*) AS count FROM source_draft_outputs').get()).toEqual({ count: 0 })
  })

  it('deletes an existing draft and reports absent ids distinctly', () => {
    const draft = createDraft(db, {
      provider_id: 'dashboardz.rss', package_id: 'dashboardz.builtin', package_version: '1.0.0',
      name: 'Temporary', config: {}, interval_s: 600, expires_at: 10_000, secrets: [], outputs: [],
    }, 1_000)
    expect(deleteDraft(db, draft.id)).toBe(true)
    expect(deleteDraft(db, draft.id)).toBe(false)
  })
})
