import type { WebSocket } from 'ws'

export class DeviceRegistry {
  private sockets = new Map<string, WebSocket>()

  attach(deviceId: string, socket: WebSocket): void {
    this.sockets.get(deviceId)?.close(4000, 'replaced')
    this.sockets.set(deviceId, socket)
  }

  detach(deviceId: string, socket: WebSocket): void {
    if (this.sockets.get(deviceId) === socket) this.sockets.delete(deviceId)
  }

  isOnline(deviceId: string): boolean {
    return this.sockets.has(deviceId)
  }

  send(deviceId: string, msg: object): void {
    const s = this.sockets.get(deviceId)
    if (s && s.readyState === s.OPEN) s.send(JSON.stringify(msg))
  }

  sendMany(deviceIds: string[], msg: object): void {
    for (const id of deviceIds) this.send(id, msg)
  }

  close(deviceId: string, code: number, reason: string): void {
    this.sockets.get(deviceId)?.close(code, reason)
  }

  all(): Map<string, WebSocket> {
    return this.sockets
  }
}
