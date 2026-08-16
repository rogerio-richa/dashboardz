import { existsSync } from 'node:fs'
import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os'

/**
 * Which address a phone on the same network should type to reach this hub. The admin shows it
 * next to the pairing code, because "which IP is my computer?" is the question that stops most
 * first pairings.
 *
 * Only meaningful when the hub runs directly on the computer. Inside a container (the default
 * Docker install) the interfaces are the container's own bridge addresses, which no phone can
 * reach, so the list is empty there and the admin falls back to PUBLIC_URL or the address the
 * browser used.
 */

/** Virtual adapters whose private addresses are never what a phone on the Wi-Fi can reach. */
const VIRTUAL = /^(docker|br-|veth|virbr|vmnet|vboxnet|bridge|utun|tun|tap|wg|tailscale|zt|lo)/i

function privateRank(ip: string): number | null {
  if (ip.startsWith('192.168.')) return 0
  if (ip.startsWith('10.')) return 1
  const m = /^172\.(\d+)\./.exec(ip)
  if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return 2
  return null
}

/** Private IPv4 addresses of real network adapters, most home-network-like first. */
export function lanAddresses(
  ifaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces(),
): string[] {
  const found: { ip: string; rank: number }[] = []
  for (const [name, infos] of Object.entries(ifaces)) {
    if (VIRTUAL.test(name)) continue
    for (const info of infos ?? []) {
      if (info.family !== 'IPv4' || info.internal) continue
      const rank = privateRank(info.address)
      if (rank !== null && !found.some((f) => f.ip === info.address)) found.push({ ip: info.address, rank })
    }
  }
  return found.sort((a, b) => a.rank - b.rank).map((f) => f.ip)
}

export function inContainer(exists: (p: string) => boolean = existsSync): boolean {
  return exists('/.dockerenv') || exists('/run/.containerenv')
}

/** `http://<ip>:<port>` for each LAN address, or none when running in a container. */
export function lanHubUrls(port: number, container = inContainer(), ips = lanAddresses()): string[] {
  return container ? [] : ips.map((ip) => `http://${ip}:${port}`)
}
