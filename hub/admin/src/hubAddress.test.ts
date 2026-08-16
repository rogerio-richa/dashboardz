import { describe, expect, it } from 'vitest'
import { displayAddress, isLoopbackHost, portOf, resolveHubAddress } from './hubAddress'

describe('resolveHubAddress', () => {
  it('uses PUBLIC_URL when it names a network address', () => {
    expect(resolveHubAddress('http://192.168.1.20:8484/', 'http://localhost:8484', ['http://10.0.0.2:8484']))
      .toEqual({ url: 'http://192.168.1.20:8484', others: [], source: 'public_url' })
  })

  it('falls back to the address the admin was opened at when PUBLIC_URL is localhost', () => {
    expect(resolveHubAddress('http://localhost:8484', 'http://192.168.1.20:8484', []))
      .toEqual({ url: 'http://192.168.1.20:8484', others: [], source: 'browser' })
  })

  it('then to the computer\'s own LAN addresses', () => {
    expect(resolveHubAddress('http://localhost:8484', 'http://127.0.0.1:8484', ['http://192.168.1.20:8484', 'http://10.0.0.5:8484']))
      .toEqual({ url: 'http://192.168.1.20:8484', others: ['http://10.0.0.5:8484'], source: 'lan' })
  })

  it('admits it does not know when everything is localhost (a Docker hub opened at localhost)', () => {
    expect(resolveHubAddress('http://localhost:8484', 'http://localhost:8484', []))
      .toEqual({ url: null, others: [], source: null })
  })
})

describe('address helpers', () => {
  it('recognises loopback hosts', () => {
    for (const h of ['localhost', 'LOCALHOST', 'hub.localhost', '127.0.0.1', '127.1.2.3', '[::1]', '::1', '0.0.0.0']) {
      expect(isLoopbackHost(h)).toBe(true)
    }
    for (const h of ['192.168.1.20', 'pi.local', 'hub.example.com']) expect(isLoopbackHost(h)).toBe(false)
  })

  it('shows addresses without http:// but keeps https://', () => {
    expect(displayAddress('http://192.168.1.20:8484/')).toBe('192.168.1.20:8484')
    expect(displayAddress('https://hub.example.com')).toBe('https://hub.example.com')
  })

  it('names the port a firewall must allow', () => {
    expect(portOf('http://192.168.1.20:8484')).toBe('8484')
    expect(portOf('https://hub.example.com')).toBe('443')
    expect(portOf(null)).toBe('8484')
  })
})
