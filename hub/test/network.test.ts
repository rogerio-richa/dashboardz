import { describe, expect, it } from 'vitest'
import type { NetworkInterfaceInfo } from 'node:os'
import { inContainer, lanAddresses, lanHubUrls } from '../src/network.js'

const v4 = (address: string, internal = false) =>
  ({ address, family: 'IPv4', internal, netmask: '255.255.255.0', mac: '', cidr: null }) as NetworkInterfaceInfo
const v6 = (address: string) =>
  ({ address, family: 'IPv6', internal: false, netmask: '', mac: '', cidr: null, scopeid: 0 }) as NetworkInterfaceInfo

describe('lanAddresses', () => {
  it('keeps private IPv4 on real adapters, home ranges first', () => {
    expect(lanAddresses({
      lo0: [v4('127.0.0.1', true)],
      en0: [v6('fe80::1'), v4('192.168.1.20')],
      en5: [v4('10.0.0.7')],
      eth1: [v4('172.20.1.4')],
    })).toEqual(['192.168.1.20', '10.0.0.7', '172.20.1.4'])
  })

  it('skips Docker, VPN and VM adapters and public addresses', () => {
    expect(lanAddresses({
      docker0: [v4('172.17.0.1')],
      'br-1a2b': [v4('172.18.0.1')],
      utun3: [v4('10.8.0.2')],
      tailscale0: [v4('100.101.1.2')],
      vmnet8: [v4('192.168.110.1')],
      en0: [v4('203.0.113.9')],
    })).toEqual([])
  })
})

describe('lanHubUrls', () => {
  it('adds the port to each address', () => {
    expect(lanHubUrls(8484, false, ['192.168.1.20'])).toEqual(['http://192.168.1.20:8484'])
  })

  it('reports nothing from inside a container, where the addresses are the bridge network', () => {
    expect(lanHubUrls(8484, true, ['172.18.0.2'])).toEqual([])
  })
})

describe('inContainer', () => {
  it('recognises Docker and Podman marker files', () => {
    expect(inContainer((p) => p === '/.dockerenv')).toBe(true)
    expect(inContainer((p) => p === '/run/.containerenv')).toBe(true)
    expect(inContainer(() => false)).toBe(false)
  })
})
