import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.js'

describe('loadConfig', () => {
  it('throws without ADMIN_PASSWORD', () => {
    expect(() => loadConfig({})).toThrow('ADMIN_PASSWORD is required')
  })
  it('applies defaults', () => {
    const c = loadConfig({ ADMIN_PASSWORD: 'pw' })
    expect(c).toEqual({
      port: 8484, dataDir: './data', adminPassword: 'pw', publicUrl: 'http://localhost:8484',
      relayUrl: null, masterKey: null, retentionAlertsDays: 90, retentionAuditDays: 180,
      retentionAlertsDaysSource: 'default', retentionAuditDaysSource: 'default',
    })
  })
  it('reads overrides', () => {
    const c = loadConfig({
      ADMIN_PASSWORD: 'pw', PORT: '9000', DATA_DIR: '/x', PUBLIC_URL: 'http://pi:9000',
      RELAY_URL: 'wss://relay.example/ws', DASHBOARDZ_MASTER_KEY: 'configured-key',
      RETENTION_ALERTS_DAYS: '30', RETENTION_AUDIT_DAYS: '60',
    })
    expect(c).toEqual({
      port: 9000, dataDir: '/x', adminPassword: 'pw', publicUrl: 'http://pi:9000',
      relayUrl: 'wss://relay.example/ws', masterKey: 'configured-key',
      retentionAlertsDays: 30, retentionAuditDays: 60,
      retentionAlertsDaysSource: 'env', retentionAuditDaysSource: 'env',
    })
  })
  it('reports source "default" when RETENTION_ALERTS_DAYS is invalid, even though a value was set', () => {
    expect(loadConfig({ ADMIN_PASSWORD: 'pw', RETENTION_ALERTS_DAYS: 'abc' }).retentionAlertsDaysSource).toBe('default')
  })
  it('reports source "env" when RETENTION_ALERTS_DAYS is explicitly 0 (keep forever)', () => {
    const c = loadConfig({ ADMIN_PASSWORD: 'pw', RETENTION_ALERTS_DAYS: '0' })
    expect(c.retentionAlertsDays).toBe(0)
    expect(c.retentionAlertsDaysSource).toBe('env')
  })
  it('RETENTION_ALERTS_DAYS of 0 means keep forever, not the default', () => {
    expect(loadConfig({ ADMIN_PASSWORD: 'pw', RETENTION_ALERTS_DAYS: '0' }).retentionAlertsDays).toBe(0)
  })
  it('RETENTION_AUDIT_DAYS of 0 means keep forever, not the default', () => {
    expect(loadConfig({ ADMIN_PASSWORD: 'pw', RETENTION_AUDIT_DAYS: '0' }).retentionAuditDays).toBe(0)
  })
  it('falls back to the default retention when RETENTION_ALERTS_DAYS is not a number', () => {
    expect(loadConfig({ ADMIN_PASSWORD: 'pw', RETENTION_ALERTS_DAYS: 'abc' }).retentionAlertsDays).toBe(90)
  })
  it('falls back to the default retention when RETENTION_AUDIT_DAYS is negative', () => {
    expect(loadConfig({ ADMIN_PASSWORD: 'pw', RETENTION_AUDIT_DAYS: '-5' }).retentionAuditDays).toBe(180)
  })
  it('falls back to the default retention when RETENTION_ALERTS_DAYS is not an integer', () => {
    expect(loadConfig({ ADMIN_PASSWORD: 'pw', RETENTION_ALERTS_DAYS: '1.5' }).retentionAlertsDays).toBe(90)
  })
  it('throws on non-numeric PORT', () => {
    expect(() => loadConfig({ ADMIN_PASSWORD: 'pw', PORT: 'abc' })).toThrow('PORT must be an integer between 1 and 65535')
  })
  it('throws on empty PORT', () => {
    expect(() => loadConfig({ ADMIN_PASSWORD: 'pw', PORT: '' })).toThrow('PORT must be an integer between 1 and 65535')
  })
  it('throws on PORT out of range', () => {
    expect(() => loadConfig({ ADMIN_PASSWORD: 'pw', PORT: '70000' })).toThrow('PORT must be an integer between 1 and 65535')
  })
  it('throws on PORT below minimum', () => {
    expect(() => loadConfig({ ADMIN_PASSWORD: 'pw', PORT: '0' })).toThrow('PORT must be an integer between 1 and 65535')
  })
  it('relayUrl defaults to null when RELAY_URL is unset', () => {
    expect(loadConfig({ ADMIN_PASSWORD: 'pw' }).relayUrl).toBeNull()
  })
  it('accepts a valid wss:// RELAY_URL', () => {
    const c = loadConfig({ ADMIN_PASSWORD: 'pw', RELAY_URL: 'wss://relay.example/ws' })
    expect(c.relayUrl).toBe('wss://relay.example/ws')
  })
  it('accepts a valid ws:// RELAY_URL', () => {
    const c = loadConfig({ ADMIN_PASSWORD: 'pw', RELAY_URL: 'ws://localhost:9090/ws' })
    expect(c.relayUrl).toBe('ws://localhost:9090/ws')
  })
  it('throws on a RELAY_URL that is not a URL at all', () => {
    expect(() => loadConfig({ ADMIN_PASSWORD: 'pw', RELAY_URL: 'not a url' }))
      .toThrow('RELAY_URL must be a valid ws:// or wss:// URL')
  })
  it('throws on a RELAY_URL with the wrong protocol', () => {
    expect(() => loadConfig({ ADMIN_PASSWORD: 'pw', RELAY_URL: 'https://relay.example/ws' }))
      .toThrow('RELAY_URL must be a valid ws:// or wss:// URL')
  })
  it('throws on an empty RELAY_URL', () => {
    expect(() => loadConfig({ ADMIN_PASSWORD: 'pw', RELAY_URL: '' }))
      .toThrow('RELAY_URL must be a valid ws:// or wss:// URL')
  })
  // ws's WebSocket constructor throws synchronously on a fragment URL, so isRelayUrl must
  // reject it up front rather than let it reach the dial path (config.ts isRelayUrl).
  it('throws on a RELAY_URL with a fragment', () => {
    expect(() => loadConfig({ ADMIN_PASSWORD: 'pw', RELAY_URL: 'wss://relay.example/ws#frag' }))
      .toThrow('RELAY_URL must be a valid ws:// or wss:// URL')
  })
  // PUBLIC_URL feeds the pairing QR and the admin-session cookie's `Secure` flag, so malformed
  // values are rejected before either consumer receives one.
  it('throws on a PUBLIC_URL that is not a URL at all', () => {
    expect(() => loadConfig({ ADMIN_PASSWORD: 'pw', PUBLIC_URL: '192.168.1.10:8484' }))
      .toThrow('PUBLIC_URL must be a valid http:// or https:// URL')
  })
  it('throws on a PUBLIC_URL with the wrong protocol', () => {
    expect(() => loadConfig({ ADMIN_PASSWORD: 'pw', PUBLIC_URL: 'ws://pi:8484' }))
      .toThrow('PUBLIC_URL must be a valid http:// or https:// URL')
  })
  it('throws on an empty PUBLIC_URL', () => {
    expect(() => loadConfig({ ADMIN_PASSWORD: 'pw', PUBLIC_URL: '' }))
      .toThrow('PUBLIC_URL must be a valid http:// or https:// URL')
  })
})
