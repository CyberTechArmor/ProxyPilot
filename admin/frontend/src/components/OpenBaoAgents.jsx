import { useEffect, useState } from 'react';
import { Copy } from 'lucide-react';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

// Connect an agent (backend: lib/setup-engine/openbao-agents.js). Each agent or
// machine signs in to OpenBao with its own AppRole and can only READ the
// credentials assigned to it (<kv>/agents/<name>/…). It is never an
// administrator. The secret ID is shown once, right after it is issued.
function CopyButton({ value, label }) {
  const [done, setDone] = useState(false);
  return <Button type="button" variant="outline" className="min-h-11 w-full sm:w-auto" onClick={async () => { try { await navigator.clipboard.writeText(value); setDone(true); setTimeout(() => setDone(false), 1500); } catch { /* the value is shown */ } }}><Copy className="h-4 w-4 mr-2" aria-hidden="true" />{done ? 'Copied' : label}</Button>;
}

function Issued({ issued, state, onClose }) {
  const { agent, roleId, secretId } = issued, login = `${state.origin}/v1/auth/${state.approle}/login`;
  const first = agent.credentials[0]?.key || 'API_KEY';
  const snippet = `# 1. Sign in (token lasts ${state.tokenMinutes} minutes)\nTOKEN=$(curl -s -X POST ${login} \\\n  -d '{"role_id":"'"$OPENBAO_ROLE_ID"'","secret_id":"'"$OPENBAO_SECRET_ID"'"}' | jq -r .auth.client_token)\n# 2. Read an assigned credential\ncurl -s -H "X-Vault-Token: $TOKEN" ${state.origin}/v1/${state.kv}/data/agents/${agent.name}/${first} | jq -r .data.data.value`;
  return <section aria-label="Agent credentials" className="rounded-lg border-2 border-primary p-4 space-y-3 text-sm min-w-0">
    <h4 className="font-semibold break-all">Credentials for {agent.name}: shown once</h4>
    <p>Give these to the agent as <code>OPENBAO_ROLE_ID</code> and <code>OPENBAO_SECRET_ID</code> (for example in its environment file). ProxyPilot does not keep the secret ID; if it is lost, issue a new one.</p>
    <p className="break-all"><span className="font-medium">Role ID:</span> <code>{roleId}</code></p>
    <p className="break-all"><span className="font-medium">Secret ID:</span> <code>{secretId}</code></p>
    <div className="flex flex-col sm:flex-row gap-2"><CopyButton value={roleId} label="Copy role ID" /><CopyButton value={secretId} label="Copy secret ID" /><CopyButton value={snippet} label="Copy usage example" /></div>
    <pre className="text-xs whitespace-pre-wrap break-all rounded bg-muted p-3">{snippet}</pre>
    <Button type="button" className="min-h-11 w-full sm:w-auto" onClick={onClose}>I have stored them</Button>
  </section>;
}

export default function OpenBaoAgents() {
  const [state, setState] = useState(null), [busy, setBusy] = useState(false), [error, setError] = useState(''), [issued, setIssued] = useState(null), [message, setMessage] = useState('');
  useEffect(() => { let on = true; api.getOpenBaoAgents().then(v => on && setState(v)).catch(e => on && setError(e.message)); return () => { on = false; }; }, []);
  async function run(fn, done) { setBusy(true); setError(''); setMessage(''); try { const out = await fn(); if (out?.state) setState(out.state); if (out?.secretId) setIssued(out); if (done) setMessage(done); } catch (e) { setError(e.message); } finally { setBusy(false); } }
  if (!state) return error ? <p role="alert" className="text-destructive text-sm">{error}</p> : <p role="status" className="text-sm">Loading agents…</p>;
  if (!state.ready) return <p className="text-sm">{state.reason}</p>;
  return <div className="space-y-4 min-w-0">
    <p className="text-sm">Register an agent or machine, then assign it credentials. It signs in to OpenBao with its own role ID and secret ID and can only <b>read</b> the credentials assigned to it. It cannot see other agents’ credentials, your team area or any setting. Tokens last {state.tokenMinutes} minutes.</p>
    <p className="text-sm text-muted-foreground">The agent must reach {state.origin} from one of your restricted networks (for example over the VPN). Binding the role to the agent’s address (IP ranges) is recommended.</p>
    {error && <p role="alert" className="text-destructive text-sm break-words">{error}</p>}
    {message && <p role="status" className="text-sm rounded-lg border p-3">{message}</p>}
    {issued && <Issued issued={issued} state={state} onClose={() => setIssued(null)} />}
    <form className="rounded-lg border p-4 space-y-3" onSubmit={e => { e.preventDefault(); const f = new FormData(e.currentTarget), form = e.currentTarget; const cidrs = String(f.get('cidrs') || '').split(/[\s,]+/).filter(Boolean); run(async () => { const out = await api.createOpenBaoAgent({ name: f.get('name'), description: f.get('description') || '', cidrs, reviewed: true }); form.reset(); return out; }); }}>
      <h4 className="font-semibold">Register an agent</h4>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="space-y-1"><Label htmlFor="oa-name">Name</Label><Input id="oa-name" name="name" className="min-h-11" required pattern="[a-z][a-z0-9\-]{1,39}" placeholder="n8n-builder" /></div>
        <div className="space-y-1"><Label htmlFor="oa-desc">Description (optional)</Label><Input id="oa-desc" name="description" className="min-h-11" maxLength={200} /></div>
      </div>
      <div className="space-y-1"><Label htmlFor="oa-cidrs">Only from these addresses (optional, IPv4 ranges, comma separated)</Label><Input id="oa-cidrs" name="cidrs" className="min-h-11" placeholder="10.100.0.7/32" /></div>
      <Button type="submit" className="min-h-11 w-full sm:w-auto" disabled={busy}>Register and show its credentials</Button>
    </form>
    {state.agents.length === 0 && <p className="text-sm text-muted-foreground">No agents registered yet.</p>}
    <ul className="space-y-3">{state.agents.map(a => <li key={a.name} className="rounded-lg border p-4 space-y-3 text-sm min-w-0">
      <div><p className="font-semibold break-all">{a.name}</p>{a.description && <p className="text-muted-foreground break-words">{a.description}</p>}<p className="text-muted-foreground break-all">{a.cidrs.length ? `Only from ${a.cidrs.join(', ')}` : 'From any restricted network'}</p></div>
      <div className="space-y-2"><p className="font-medium">Assigned credentials</p>
        {a.credentials.length === 0 && <p className="text-muted-foreground">None yet.</p>}
        <ul className="space-y-2">{a.credentials.map(c => <li key={c.key} className="flex flex-col sm:flex-row sm:items-center gap-2 min-w-0"><span className="flex-1 min-w-0 break-all"><code>{state.kv}/agents/{a.name}/{c.key}</code>{c.description && ` · ${c.description}`}</span><Button type="button" variant="outline" className="min-h-11 w-full sm:w-auto" disabled={busy} onClick={() => { if (window.confirm(`Remove ${c.key} from ${a.name}? All its versions are deleted.`)) run(() => api.removeOpenBaoAgentCredential(a.name, c.key), `${c.key} removed.`); }}>Remove</Button></li>)}</ul>
      </div>
      <form className="space-y-2" onSubmit={e => { e.preventDefault(); const f = new FormData(e.currentTarget), form = e.currentTarget, key = String(f.get('key')); const body = { value: f.get('value'), description: f.get('description') || '', reviewed: true }; form.elements.value.value = ''; run(async () => { const out = await api.setOpenBaoAgentCredential(a.name, key, body); form.reset(); return out; }, `${key} assigned to ${a.name}. Updating it later writes a new version.`); }}>
        <p className="font-medium">Assign a credential</p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <div className="space-y-1"><Label htmlFor={`oa-key-${a.name}`}>Name</Label><Input id={`oa-key-${a.name}`} name="key" className="min-h-11" required pattern="[A-Za-z][A-Za-z0-9_.\-]{0,63}" placeholder="OPENAI_API_KEY" /></div>
          <div className="space-y-1"><Label htmlFor={`oa-cdesc-${a.name}`}>Description (optional)</Label><Input id={`oa-cdesc-${a.name}`} name="description" className="min-h-11" maxLength={200} /></div>
        </div>
        <div className="space-y-1"><Label htmlFor={`oa-val-${a.name}`}>Value</Label><Input id={`oa-val-${a.name}`} name="value" type="password" className="min-h-11" required autoComplete="off" /></div>
        <Button type="submit" className="min-h-11 w-full sm:w-auto" disabled={busy}>Assign</Button>
      </form>
      <div className="flex flex-col sm:flex-row gap-2">
        <Button type="button" variant="outline" className="min-h-11 w-full sm:w-auto" disabled={busy} onClick={() => { if (window.confirm(`Issue a new secret ID for ${a.name}? The current one stops working.`)) run(() => api.rotateOpenBaoAgent(a.name)); }}>Issue a new secret ID</Button>
        <Button type="button" variant="destructive" className="min-h-11 w-full sm:w-auto" disabled={busy} onClick={() => { if (window.confirm(`Remove ${a.name}? Its sign-in and every credential assigned to it are deleted.`)) run(() => api.removeOpenBaoAgent(a.name), `${a.name} removed.`); }}>Remove agent</Button>
      </div>
    </li>)}</ul>
  </div>;
}
