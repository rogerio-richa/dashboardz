export type Severity = 'info' | 'warn' | 'critical'
export interface AskOption { id: string; label: string }
export interface NotifyBody {
  title: string; body?: string; severity: Severity; devices?: string[]
  sound?: boolean; ttl_s?: number; dedup_key?: string; options?: AskOption[]
}
export type Answer =
  | { state: 'pending' }
  | { state: 'answered'; option_id: string; option_label?: string }
  | { state: 'dismissed' }
  | { state: 'expired' }

export class HubError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}

export class Hub {
  constructor(
    private readonly baseUrl: string,
    private readonly senderToken: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  private async post(path: string, body: unknown): Promise<unknown> {
    const res = await this.fetchFn(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.senderToken}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) throw new HubError(res.status, `${path} -> ${res.status}: ${await res.text()}`)
    return res.json()
  }

  async notify(body: NotifyBody): Promise<{ id: string }> {
    return (await this.post('/api/notify', body)) as { id: string }
  }

  async resolve(dedupKey: string): Promise<boolean> {
    const r = (await this.post('/api/notify', { resolve: true, dedup_key: dedupKey })) as { resolved: boolean }
    return r.resolved
  }

  async answer(alertId: string): Promise<Answer> {
    const res = await this.fetchFn(`${this.baseUrl}/api/alerts/${alertId}/answer`, {
      headers: { Authorization: `Bearer ${this.senderToken}` },
    })
    if (!res.ok) throw new HubError(res.status, `answer(${alertId}) -> ${res.status}`)
    return (await res.json()) as Answer
  }

  async pushFeed(feedId: string, payload: unknown): Promise<void> {
    await this.post(`/api/feeds/${feedId}`, payload)
  }
}
