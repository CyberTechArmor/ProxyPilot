import { useEffect, useState } from 'react';
import { Copy } from 'lucide-react';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

// Per-agent Infisical projects (backend: lib/setup-engine/infisical-agents.js).
// Free edition: an agent that uses the Agent Proxy must be Admin of a project,
// so each agent gets its OWN project holding only its credentials. The proxy
// puts the real value into requests to the sites you name; the agent sends a
// placeholder. A compromised agent could read its own values, never another's.
function CopyButton({ value, label }) {
  const [done, setDone] = useState(false);
  return <Button type="button" variant="outline" className="min-h-11 w-full sm:w-auto" onClick={async () => { try { await navigator.clipboard.writeText(value); setDone(true); setTimeout(() => setDone(false), 1500); } catch { /* the value is shown */ } }}><Copy className="h-4 w-4 mr-2" aria-hidden="true" />{done ? 'Copied' : label}</Button>;
}

function Issued({ issued, state, onClose }) {
  const { agent, clientId, clientSecret } = issued, first = agent.credentials[0];
  const placeholder = first?.placeholder || `pp-placeholder-${agent.name}-api_key`, site = (first?.hostPattern || 'api.example.com').split(',')[0].trim();
  const snippet = `# 1. Sign in (token lasts 5 minutes)\nTOKEN=$(curl -s -X POST ${state.origin}/api/v1/auth/universal-auth/login \\\n  -H 'Content-Type: application/json' \\\n  -d '{"clientId":"'"$INFISICAL_CLIENT_ID"'","clientSecret":"'"$INFISICAL_CLIENT_SECRET"'"}' | jq -r .accessToken)\n# 2. Call the site through the Agent Proxy with the placeholder; the proxy puts in the real value\ncurl -x ${state.proxyOrigin} --proxy-user "${agent.projectId}:${state.environment}/:$TOKEN" \\\n  -H "Authorization: Bearer ${placeholder}" http://${site}/`;
  return <section aria-label="Agent credentials" className="rounded-lg border-2 border-primary p-4 space-y-3 text-sm min-w-0">
    <h4 className="font-semibold break-all">Credentials for {agent.name}: shown once</h4>
    <p>Give these to the agent as <code>INFISICAL_CLIENT_ID</code> and <code>INFISICAL_CLIENT_SECRET</code>. ProxyPilot does not keep the client secret; if it is lost, issue a new one.</p>
    <p className="break-all"><span className="font-medium">Client ID:</span> <code>{clientId}</code></p>
    <p className="break-all"><span className="font-medium">Client secret:</span> <code>{clientSecret}</code></p>
    <p className="break-all"><span className="font-medium">Project ID:</span> <code>{agent.projectId}</code></p>
    <div className="flex flex-col sm:flex-row gap-2"><CopyButton value={clientId} label="Copy client ID" /><CopyButton value={clientSecret} label="Copy client secret" /><CopyButton value={snippet} label="Copy usage example" /></div>
    <pre className="text-xs whitespace-pre-wrap break-all rounded bg-muted p-3">{snippet}</pre>
    <Button type="button" className="min-h-11 w-full sm:w-auto" onClick={onClose}>I have stored them</Button>
  </section>;
}

export default function InfisicalAgents() {
  const [state, setState] = useState(null), [busy, setBusy] = useState(false), [error, setError] = useState(''), [issued, setIssued] = useState(null), [message, setMessage] = useState(''), [password, setPassword] = useState('');
  useEffect(() => { let on = true; api.getInfisicalAgents().then(v => on && setState(v)).catch(e => on && setError(e.message)); return () => { on = false; }; }, []);
  const authority = () => (password ? { password } : {});
  async function run(fn, done) { setBusy(true); setError(''); setMessage(''); try { const out = await fn(); if (out?.state) setState(out.state); if (out?.clientSecret) setIssued(out); if (done) setMessage(done); } catch (e) { setError(e.message); } finally { setBusy(false); } }
  if (!state) return error ? <p role="alert" className="text-destructive text-sm">{error}</p> : <p role="status" className="text-sm">Loading agents…</p>;
  if (!state.ready) return <p className="text-sm">{state.reason}</p>;
  return <div className="space-y-4 min-w-0">
    <p className="text-sm">Each agent gets its own Infisical project that holds only its credentials. The agent sends a <b>placeholder</b> through the Agent Proxy and the proxy puts in the real value, only for the sites you name. On the free edition the agent is Admin of its own project, so a compromised agent could read its own values, never another agent’s. For agents that should only read their own values directly, use OpenBao above.</p>
    <p className="text-sm text-muted-foreground">The agent must reach {state.origin} (to sign in) and the Agent Proxy at {state.proxyOrigin} (on this host’s private network).</p>
    {!state.passwordInOpenBao && <div className="space-y-1 rounded-lg border p-3"><Label htmlFor="ia-admin-pw">Infisical administrator password for {state.administrator}</Label><Input id="ia-admin-pw" type="password" className="min-h-11" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} /><p className="text-xs text-muted-foreground">Changes here are made as the Infisical administrator. The password is sent with each change and not stored; keep it in OpenBao to skip this.</p></div>}
    {error && <p role="alert" className="text-destructive text-sm break-words">{error}</p>}
    {message && <p role="status" className="text-sm rounded-lg border p-3">{message}</p>}
    {issued && <Issued issued={issued} state={state} onClose={() => setIssued(null)} />}
    <form className="rounded-lg border p-4 space-y-3" onSubmit={e => { e.preventDefault(); const f = new FormData(e.currentTarget), form = e.currentTarget; run(async () => { const out = await api.createInfisicalAgent({ name: f.get('name'), description: f.get('description') || '', ...authority(), reviewed: true }); form.reset(); return out; }); }}>
      <h4 className="font-semibold">Register an agent</h4>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="space-y-1"><Label htmlFor="ia-name">Name</Label><Input id="ia-name" name="name" className="min-h-11" required pattern="[a-z][a-z0-9\-]{1,29}" placeholder="crawler" /></div>
        <div className="space-y-1"><Label htmlFor="ia-desc">Description (optional)</Label><Input id="ia-desc" name="description" className="min-h-11" maxLength={200} /></div>
      </div>
      <Button type="submit" className="min-h-11 w-full sm:w-auto" disabled={busy}>Create its project and show its credentials</Button>
    </form>
    {state.agents.length === 0 && <p className="text-sm text-muted-foreground">No agents registered yet.</p>}
    <ul className="space-y-3">{state.agents.map(a => <li key={a.name} className="rounded-lg border p-4 space-y-3 text-sm min-w-0">
      <div><p className="font-semibold break-all">{a.name}</p>{a.description && <p className="text-muted-foreground break-words">{a.description}</p>}<p className="text-muted-foreground break-all">Project <code>{a.projectId}</code></p></div>
      <div className="space-y-2"><p className="font-medium">Assigned credentials</p>
        {a.credentials.length === 0 && <p className="text-muted-foreground">None yet.</p>}
        <ul className="space-y-2">{a.credentials.map(c => <li key={c.key} className="flex flex-col sm:flex-row sm:items-center gap-2 min-w-0"><span className="flex-1 min-w-0 break-all"><code>{c.key}</code> → {c.hostPattern} · placeholder <code>{c.placeholder}</code></span><Button type="button" variant="outline" className="min-h-11 w-full sm:w-auto" disabled={busy} onClick={() => { if (window.confirm(`Remove ${c.key} from ${a.name}? The secret and its proxied site are deleted.`)) run(() => api.removeInfisicalAgentCredential(a.name, c.key, authority()), `${c.key} removed.`); }}>Remove</Button></li>)}</ul>
      </div>
      <form className="space-y-2" onSubmit={e => { e.preventDefault(); const f = new FormData(e.currentTarget), form = e.currentTarget, key = String(f.get('key')); const body = { value: f.get('value'), hostPattern: f.get('hostPattern'), ...authority(), reviewed: true }; form.elements.value.value = ''; run(async () => { const out = await api.setInfisicalAgentCredential(a.name, key, body); form.reset(); return out; }, `${key} assigned to ${a.name}.`); }}>
        <p className="font-medium">Assign a credential</p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <div className="space-y-1"><Label htmlFor={`ia-key-${a.name}`}>Name</Label><Input id={`ia-key-${a.name}`} name="key" className="min-h-11" required pattern="[A-Z][A-Z0-9_]{0,63}" placeholder="OPENAI_API_KEY" /></div>
          <div className="space-y-1"><Label htmlFor={`ia-host-${a.name}`}>Sites it may be used for</Label><Input id={`ia-host-${a.name}`} name="hostPattern" className="min-h-11" required placeholder="api.openai.com" /></div>
        </div>
        <div className="space-y-1"><Label htmlFor={`ia-val-${a.name}`}>Value</Label><Input id={`ia-val-${a.name}`} name="value" type="password" className="min-h-11" required autoComplete="off" /></div>
        <Button type="submit" className="min-h-11 w-full sm:w-auto" disabled={busy}>Assign</Button>
      </form>
      <div className="flex flex-col sm:flex-row gap-2">
        <Button type="button" variant="outline" className="min-h-11 w-full sm:w-auto" disabled={busy} onClick={() => { if (window.confirm(`Issue a new client secret for ${a.name}? The current one stops working.`)) run(() => api.rotateInfisicalAgent(a.name, authority())); }}>Issue a new client secret</Button>
        <Button type="button" variant="destructive" className="min-h-11 w-full sm:w-auto" disabled={busy} onClick={() => { if (window.confirm(`Remove ${a.name}? Its project, credentials and sign-in are deleted.`)) run(() => api.removeInfisicalAgent(a.name, authority()), `${a.name} removed.`); }}>Remove agent</Button>
      </div>
    </li>)}</ul>
  </div>;
}
