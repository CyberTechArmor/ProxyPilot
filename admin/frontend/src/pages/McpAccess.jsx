// MCP connection administration: full tool access by default, explicit custom scopes.
// Token secrets are shown once; existing connections retain their token on update.

import { useEffect, useState, useCallback } from 'react';
import { Navigate } from 'react-router-dom';
import { api } from '@/lib/api';
import { useAuth } from '@/context/AuthContext';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { useToast } from '@/hooks/use-toast';
import { Loader2, Plug, Copy, Trash2 } from 'lucide-react';

export default function McpAccess() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin'
    || JSON.parse(localStorage.getItem('user') || '{}').role === 'admin';
  const { toast } = useToast();
  const [tokens, setTokens] = useState([]);
  const [name, setName] = useState('');
  // Explicit lifetime; 0 is the administrator's non-expiring choice.
  const [expiresDays, setExpiresDays] = useState('30');
  const [scopeText, setScopeText] = useState('{"tools":[]}');
  const [fullAccess, setFullAccess] = useState(true);
  const [tools, setTools] = useState([]);
  const [toolSearch, setToolSearch] = useState('');
  const [loadError, setLoadError] = useState('');
  const [reviewId,setReviewId]=useState(null);
  const [busy, setBusy] = useState(false);
  const [minted, setMinted] = useState(null); // { token, connector_url, endpoint } — shown once

  const load = useCallback(async () => {
    try {
      const [r, catalog] = await Promise.all([api.mcpListTokens(), api.mcpListTools()]);
      setTokens(r.tokens || []);
      setTools(catalog.tools || []);
      setLoadError('');
    } catch (err) {
      setLoadError(err.message || 'Could not load MCP access');
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  if (!isAdmin) return <Navigate to="/" replace />;

  const mint = async () => {
    setBusy(true);
    try {
      // All tools is the actual policy, not an acknowledgment beside a
      // still-restricted JSON value. Includes self-edit; feature gates remain.
      const scope = fullAccess ? { self_edit: true } : JSON.parse(scopeText);
      if(expiresDays==='') throw new Error('Choose an expiry in days');
      const r = reviewId ? await api.mcpReviewToken(reviewId,Number(expiresDays),scope,fullAccess) : await api.mcpCreateToken(name.trim() || 'MCP client',Number(expiresDays),scope,fullAccess);
      setMinted(reviewId ? null : r);
      if (reviewId) toast({ title: 'Connection updated', description: 'Your existing token and connector URL still work. Refresh the tools in your MCP client.' });
      setReviewId(null);
      setName('');
      setFullAccess(true);
      setScopeText('{"tools":[]}');
      await load();
    } catch (err) {
      toast({ variant: 'destructive', title: reviewId ? 'Could not update connection' : 'Could not create token', description: err.message });
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (id) => {
    try {
      await api.mcpRevokeToken(id);
      load();
    } catch (err) {
      toast({ variant: 'destructive', title: 'Could not revoke token', description: err.message });
    }
  };

  const copyText = async (text, label) => {
    try {
      await navigator.clipboard.writeText(text);
      toast({ title: `${label} copied` });
    } catch {
      toast({ variant: 'destructive', title: 'Copy failed', description: 'Select and copy it manually.' });
    }
  };

  const active = tokens.filter((t) => !t.revoked_at);
  const visibleTools = tools.filter(t => `${t.name} ${t.description}`.toLowerCase().includes(toolSearch.toLowerCase()));
  const editToken = (token) => {
    setReviewId(token.id);
    setName(token.name);
    setScopeText(token.scope_json || 'null');
    const scope = token.scope;
    setFullAccess(!scope?.invalid && scope?.tools == null && scope?.lxc_containers == null && scope?.project_ids == null && (scope?.self_edit === true || token.scope_json == null));
    setExpiresDays(token.expires_at ? String(Math.max(1, Math.ceil((Date.parse(token.expires_at) - Date.now()) / 86400000))) : '0');
  };
  const cancelEdit = () => { setReviewId(null); setName(''); setFullAccess(true); setScopeText('{"tools":[]}'); setExpiresDays('30'); };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Plug className="h-5 w-5 text-primary" />
        <h1 className="text-lg font-semibold">MCP Access</h1>
      </div>
      <p className="text-xs text-muted-foreground max-w-2xl">
        Connect your MCP client to manage services, guests, projects, builds, storage and the
        platform. New connections allow all tools by default. Custom scopes are optional;
        feature switches and each operation's confirmation checks still apply.
      </p>

      {loadError && <p role="alert" className="text-sm text-destructive">{loadError}</p>}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Access tokens</CardTitle>
          <CardDescription>
            Mint a token, then either paste the <strong>connector URL</strong> on claude.ai
            (Settings → Connectors → Add custom connector — works on web and mobile), or use the
            endpoint with <code>Authorization: Bearer &lt;token&gt;</code> in Claude Desktop /
            Claude Code. Each token is shown once; revoking it cuts that client off instantly.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {minted ? (
            <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 space-y-2 text-sm">
              <p className="font-medium">Token created — shown only once. Store it now.</p>
              <div className="space-y-1.5 text-xs">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="shrink-0 text-muted-foreground w-28">Connector URL</span>
                  <code className="min-w-0 flex-1 truncate">{minted.connector_url}</code>
                  <Button variant="outline" size="sm" aria-label="Copy connector URL" className="h-11 w-11 sm:h-9 sm:w-auto shrink-0" onClick={() => copyText(minted.connector_url, 'Connector URL')}>
                    <Copy className="h-3.5 w-3.5" />
                  </Button>
                </div>
                <div className="flex items-center gap-2 min-w-0">
                  <span className="shrink-0 text-muted-foreground w-28">Bearer token</span>
                  <code className="min-w-0 flex-1 truncate">{minted.token}</code>
                  <Button variant="outline" size="sm" aria-label="Copy bearer token" className="h-11 w-11 sm:h-9 sm:w-auto shrink-0" onClick={() => copyText(minted.token, 'Token')}>
                    <Copy className="h-3.5 w-3.5" />
                  </Button>
                </div>
                <p className="text-muted-foreground break-all">Endpoint for header-auth clients: <code>{minted.endpoint}</code></p>
                <p className="text-muted-foreground">
                  The connector URL contains the token — treat the whole URL as a secret.
                </p>
              </div>
              <Button variant="outline" size="sm" className="h-11 sm:h-9" onClick={() => setMinted(null)}>Done — I stored it</Button>
            </div>
          ) : null}

          {reviewId && <p role="status" className="text-sm font-medium">Editing {name}. Saving updates this connection without replacing its token or URL.</p>}
          <div className="space-y-2">
            <label className="flex min-h-11 cursor-pointer items-center gap-3 rounded-md border p-3 text-sm font-medium">
              <input type="checkbox" className="h-5 w-5 shrink-0" checked={fullAccess} onChange={e => setFullAccess(e.target.checked)} />
              Allow all tools
            </label>
            <p className="text-xs text-muted-foreground">All tools includes administration and ProxyPilot self-editing across all resources. Saving requires your local administrator verification.</p>
            {!fullAccess && <div className="space-y-2">
              <label htmlFor="mcp-scope" className="text-sm font-medium">Custom tools and resources (JSON)</label>
              <textarea id="mcp-scope" className="w-full min-h-28 rounded-md border bg-background p-3 font-mono text-xs"
                value={scopeText} onChange={e => setScopeText(e.target.value)} />
              <p className="text-xs text-muted-foreground">Fields: tools, lxc_containers, project_ids, self_edit. Empty arrays allow none. Omitted lists allow all in that dimension; use Allow all tools for unrestricted access.</p>
            </div>}
            <details open className="rounded-md border p-3">
              <summary className="min-h-11 cursor-pointer text-sm font-medium">Available tools ({tools.length})</summary>
              <label htmlFor="mcp-tool-search" className="sr-only">Search available tools</label>
              <Input id="mcp-tool-search" placeholder="Search tools" value={toolSearch} onChange={e => setToolSearch(e.target.value)} className="mb-2" />
              <ul aria-label="Available MCP tools" className="max-h-64 overflow-y-auto space-y-1">
                {visibleTools.map(tool => <li key={tool.name} className="rounded border p-2 text-xs">
                  <span className="font-mono font-medium break-all">{tool.name}</span>
                  <p className="text-muted-foreground break-words">{tool.description}</p>
                </li>)}
              </ul>
              {!visibleTools.length && <p className="text-xs text-muted-foreground">{tools.length ? 'No matching tools.' : 'Loading tool catalog…'}</p>}
              <p className="mt-2 text-xs text-muted-foreground">This shows the full catalog. A custom-scoped connection only receives its permitted tools.</p>
            </details>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
            <Input
              value={name}
              disabled={!!reviewId}
              onChange={(e) => setName(e.target.value)}
              placeholder="Token name (e.g. Claude on my phone)"
              aria-label="Token name"
              className="h-11 sm:h-10 min-w-0 flex-1 sm:basis-48"
            />
            <Input
              type="number" inputMode="numeric" min="0" max="3650"
              value={expiresDays}
              onChange={(e) => setExpiresDays(e.target.value)}
              placeholder="Expires in days (30)"
              aria-label="Expires in days; 0 means never"
              title="Choose 1–3650 days, or 0 for an explicitly non-expiring token."
              className="h-11 sm:h-10 sm:w-48"
            />
            <Button onClick={mint} disabled={busy} className="h-11 sm:h-10 shrink-0">
              {busy ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
              {reviewId ? 'Save connection' : 'Create token'}
            </Button>
            {reviewId && <Button variant="outline" className="h-11 sm:h-10" onClick={cancelEdit} disabled={busy}>Cancel edit</Button>}
          </div>
          <p className="text-xs text-muted-foreground">
            Choose an expiry, then save. If a connection is awaiting review, edit it and save to restore access using the same URL. Child keys remain limited by their parents; revoking a parent disables descendants. 0 explicitly means no expiry.
          </p>

          {active.length === 0 ? (
            <p className="text-xs text-muted-foreground">No connections yet. Create a token to connect your MCP client.</p>
          ) : (
            <div className="divide-y rounded-lg border">
              {active.map((t) => (
                <div key={t.id} className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 p-3">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium">{t.name}</div>
                    <p className="text-xs break-all">Scope: {t.scope_json || 'All standard tools'}</p>
                    <p className="text-xs break-words">{t.authority_status}{t.parent_id ? ` · parent #${t.parent_id}` : ' · root key'}</p>
                    <div className="text-xs text-muted-foreground">
                      Created {t.created_at ? new Date(t.created_at).toLocaleDateString() : '—'}
                      {t.last_used_at ? ` · last used ${new Date(t.last_used_at).toLocaleString()}` : ' · never used'}
                      {t.expires_at ? ` · expires ${new Date(t.expires_at).toLocaleDateString()}` : ' · never expires'}
                      {t.owner_status && t.owner_status !== 'active' ? ` · owner ${t.owner_status}` : ''}
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2 shrink-0">
                  <Button variant="outline" className="h-11 sm:h-9" onClick={() => editToken(t)}>{t.review_required ? 'Restore connection' : 'Edit access'}</Button>
                  <Button
                    variant="outline" size="sm"
                    className="h-11 w-11 sm:h-9 sm:w-auto sm:px-3 shrink-0 text-destructive"
                    onClick={() => revoke(t.id)}
                    aria-label={`Revoke ${t.name}`}
                  >
                    <Trash2 className="h-3.5 w-3.5 sm:mr-1.5" />
                    <span className="hidden sm:inline">Revoke</span>
                  </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Connecting Claude</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-muted-foreground">
          <p><strong className="text-foreground">claude.ai / mobile:</strong> Settings → Connectors → Add custom connector → paste the connector URL. Enable it in a chat's tools menu if needed.</p>
          <p><strong className="text-foreground">Claude Code:</strong> <code className="break-all">claude mcp add --transport http proxypilot &lt;endpoint&gt; --header "Authorization: Bearer &lt;token&gt;"</code></p>
          <p>
            Zip deploys are two-phase: Claude inspects and shows you which files would be replaced,
            and uses a machine confirmation before applying — replaced files are kept as <code>.old</code>. These checks prevent mistakes; they are not independent human approval. Token scope controls authority. Full
            reference: <code>docs/features/mcp.md</code> in the repo.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
