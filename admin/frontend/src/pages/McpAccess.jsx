// MCP Access — connect a Claude subscription (or any MCP client) to ProxyPilot.
//
// ProxyPilot exposes a remote MCP server (routes/mcp.js): static-site & LXC
// zip deploys with the same ask-before-replace flow as the UI, and Projects
// (list, create, clone, file editing, reference upload). No tool on that
// surface queues a build, so a connected chat never spends the project's
// configured API budget — the harness lane stays in the UI. This page mints and
// revokes the access tokens. The raw token — and the ready-to-paste claude.ai
// connector URL — is shown exactly once at mint time; only a hash is stored.
//
// Originally shipped as a card on /security, which has redirected to /cves
// since the CVE inbox superseded it — i.e. the card was unreachable (operator
// report). It now has its own page and sidebar entry.
//
// MOBILE_FIRST: single column, 44px targets, copy rows truncate not overflow.

import { useEffect, useState, useCallback } from 'react';
import { Navigate } from 'react-router-dom';
import { api, ApiError } from '@/lib/api';
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
  const [busy, setBusy] = useState(false);
  const [minted, setMinted] = useState(null); // { token, connector_url, endpoint } — shown once

  const load = useCallback(async () => {
    try {
      const r = await api.mcpListTokens();
      setTokens(r.tokens || []);
    } catch (err) {
      if (!(err instanceof ApiError)) console.error('load mcp tokens failed:', err);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  if (!isAdmin) return <Navigate to="/" replace />;

  const mint = async () => {
    setBusy(true);
    try {
      const r = await api.mcpCreateToken(name.trim() || 'MCP client');
      setMinted(r);
      setName('');
      load();
    } catch (err) {
      toast({ variant: 'destructive', title: 'Could not create token', description: err.message });
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

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Plug className="h-5 w-5 text-primary" />
        <h1 className="text-lg font-semibold">MCP Access</h1>
      </div>
      <p className="text-xs text-muted-foreground max-w-2xl">
        Connect a Claude subscription (or any MCP client) to ProxyPilot. The tools cover
        static-site &amp; LXC zip deploys — with the same ask-before-replace confirmation the UI
        uses — and Projects: create, clone, status, file editing and reference uploads. Connected
        chats cannot queue builds, so they never spend a project&apos;s API budget.
      </p>

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
                  <Button variant="outline" size="sm" className="h-9 shrink-0" onClick={() => copyText(minted.connector_url, 'Connector URL')}>
                    <Copy className="h-3.5 w-3.5" />
                  </Button>
                </div>
                <div className="flex items-center gap-2 min-w-0">
                  <span className="shrink-0 text-muted-foreground w-28">Bearer token</span>
                  <code className="min-w-0 flex-1 truncate">{minted.token}</code>
                  <Button variant="outline" size="sm" className="h-9 shrink-0" onClick={() => copyText(minted.token, 'Token')}>
                    <Copy className="h-3.5 w-3.5" />
                  </Button>
                </div>
                <p className="text-muted-foreground">Endpoint for header-auth clients: <code>{minted.endpoint}</code></p>
                <p className="text-muted-foreground">
                  The connector URL contains the token — treat the whole URL as a secret.
                </p>
              </div>
              <Button variant="outline" size="sm" className="h-9" onClick={() => setMinted(null)}>Done — I stored it</Button>
            </div>
          ) : null}

          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Token name (e.g. Claude on my phone)"
              aria-label="Token name"
              className="h-11 sm:h-10 flex-1"
            />
            <Button onClick={mint} disabled={busy} className="h-11 sm:h-10 shrink-0">
              {busy ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
              Create token
            </Button>
          </div>

          {active.length === 0 ? (
            <p className="text-xs text-muted-foreground">No active tokens. The MCP endpoint refuses every request until one exists.</p>
          ) : (
            <div className="divide-y rounded-lg border">
              {active.map((t) => (
                <div key={t.id} className="flex items-center justify-between gap-2 p-3">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium">{t.name}</div>
                    <div className="text-xs text-muted-foreground">
                      Created {t.created_at ? new Date(t.created_at).toLocaleDateString() : '—'}
                      {t.last_used_at ? ` · last used ${new Date(t.last_used_at).toLocaleString()}` : ' · never used'}
                    </div>
                  </div>
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
            and only applies after you approve — replaced files are kept as <code>.old</code>. Full
            reference: <code>docs/features/mcp.md</code> in the repo.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
