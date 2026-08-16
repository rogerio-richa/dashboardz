import { useEffect, useState } from 'react'
import { api } from '../api'
import { useConfirm } from '../confirm'
import { DOCS_URL } from '../docs'
import { IconPlus, IconTrash } from '../icons'

export { DOCS_URL } from '../docs'

interface AgentToken { id: string; name: string; created_at: number; last_used_at: number | null; revoked_at: number | null }
interface AuditRow { ts: number; actor_type: string; actor_id: string | null; event: string; details: string }

// Agents and clients/mcp/SKILL.md use the same structural MCP setup. Agents.test.tsx parses both
// JSON blocks, normalizes only the hub URL and token values, and compares the remaining structure,
// including the literal command and checkout-path placeholder. Export this helper so the test can
// pin that invariant directly.
export const mcpConfig = (publicUrl: string, token: string) => JSON.stringify({
  mcpServers: { dashboardz: {
    command: 'node', args: ['<absolute-path-to-dashboardz>/clients/mcp/dist/cli.js'],
    env: { DASHBOARDZ_HUB_URL: publicUrl, DASHBOARDZ_TOKEN: token },
  } },
}, null, 2)

export default function Agents({ publicUrl }: { publicUrl: string }) {
  const [tokens, setTokens] = useState<AgentToken[]>([])
  const [activity, setActivity] = useState<AuditRow[]>([])
  const [name, setName] = useState('')
  const [newToken, setNewToken] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [ask, confirmDialog] = useConfirm()

  const refresh = () => {
    api<AgentToken[]>('/admin/api/agent-tokens').then(setTokens).catch(() => {})
    // Audit is the whole hub's trace; an agent only needs its own slice of it — the server filters now.
    api<AuditRow[]>('/admin/api/audit?limit=100&actor_type=agent')
      .then(setActivity)
      .catch(() => {})
  }
  useEffect(() => { refresh() }, [])

  return (
    <section>
      <p>
        An agent token grants <strong>everything the admin password grants</strong>. Anything that
        reads it — including a prompt-injected assistant — can change every screen, device and feed
        on this hub. Revoking stops it immediately; the activity list below shows what it did.
      </p>
      <form className="add-form" onSubmit={async (e) => {
        e.preventDefault()
        try {
          const res = await api<{ token: string }>('/admin/api/agent-tokens', { method: 'POST', body: JSON.stringify({ name }) })
          setNewToken(res.token); setName(''); refresh()
        } catch (err) {
          setError((err as Error).message)
        }
      }}>
        <input placeholder="New agent name" value={name} onChange={(e) => setName(e.target.value)} required />
        <button type="submit"><IconPlus />Create token</button>
      </form>
      {newToken && (
        <p style={{ border: '1px solid #ccc', padding: 12 }}>
          Token (shown once): <code>{newToken}</code> <button onClick={() => setNewToken(null)}>Done</button>
        </p>
      )}
      <h3>Connect an assistant</h3>
      <p>
        Paste into your assistant's MCP config, replacing{' '}
        <code>&lt;absolute-path-to-dashboardz&gt;</code> with the absolute path to this checkout.
        Run <code>./scripts/setup-dev.sh</code> first; it builds the repo-local MCP CLI at{' '}
        <code>clients/mcp/dist/cli.js</code>. The token appears in the block below only while the
        panel above is showing it. See{' '}
        <a href={DOCS_URL + 'architecture/security/#agent-tokens'}>how agent tokens work</a>.
      </p>
      <pre>{mcpConfig(publicUrl, newToken ?? '<paste your token>')}</pre>
      <table cellPadding={6}>
        <thead><tr><th>Name</th><th>Last used</th><th>Status</th><th></th></tr></thead>
        <tbody>
          {tokens.map((t) => (
            <tr key={t.id}>
              <td>{t.name}</td>
              <td>{t.last_used_at ? new Date(t.last_used_at).toLocaleString() : 'never'}</td>
              <td>{t.revoked_at ? 'revoked' : 'active'}</td>
              <td>{!t.revoked_at && <button onClick={() => ask(
                { title: `Revoke ${t.name}?`, body: 'The token stops working immediately. Its past activity stays attributed below.', confirmLabel: 'Revoke' },
                async () => {
                  try { await api(`/admin/api/agent-tokens/${t.id}`, { method: 'DELETE' }); refresh() }
                  catch (err) { setError((err as Error).message) }
                },
              )}><IconTrash />Revoke</button>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <h3>Recent agent activity</h3>
      {activity.length === 0 ? <p>No agent activity yet.</p> : (
        <ul>
          {activity.map((r, i) => {
            const who = tokens.find((t) => t.id === r.actor_id)?.name ?? r.actor_id
            return <li key={i}>{new Date(r.ts).toLocaleString()} — <strong>{who}</strong>: {r.event}</li>
          })}
        </ul>
      )}
      {error && <p role="alert">{error}</p>}
      {confirmDialog}
    </section>
  )
}
