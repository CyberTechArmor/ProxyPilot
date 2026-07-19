// ConnectVsCode — quick connect a local editor to the project repository.
//
// Mints a per-user connect token (shown ONCE), then offers a one-click
// "Open in VS Code" deep link (vscode://vscode.git/clone with the credentials
// embedded) plus the plain clone URL + username/token for any git client.
// Pushes land in the project's bare repo over smart HTTP; the backend records
// each push as a change record + chat message, syncs the container working
// tree, and redeploys — so external edits go live and stay on the record.
//
// MOBILE_FIRST: stacked rows, 44px targets, no fixed widths; dialog is
// full-screen below sm.

import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { useToast } from '@/hooks/use-toast';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Loader2, Plug, Copy, ExternalLink, Trash2 } from 'lucide-react';

function CopyRow({ label, value, mono = true }) {
  const { toast } = useToast();
  return (
    <div className="space-y-1">
      <p className="text-xs font-medium">{label}</p>
      <div className="flex items-center gap-1.5">
        <code className={`min-w-0 flex-1 truncate rounded border bg-muted/40 px-2 py-2 text-xs ${mono ? 'font-mono' : ''}`}>{value}</code>
        <Button
          variant="ghost" size="icon" className="h-9 w-9 shrink-0" aria-label={`Copy ${label}`}
          onClick={async () => {
            try { await navigator.clipboard.writeText(value); toast({ title: 'Copied' }); }
            catch { toast({ variant: 'destructive', title: 'Copy failed — select and copy manually' }); }
          }}
        >
          <Copy className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}

export default function ConnectVsCode({ projectId, canEdit }) {
  const { toast } = useToast();
  const [info, setInfo] = useState(null); // { clone_url, can_push, tokens }
  const [minting, setMinting] = useState(false);
  const [minted, setMinted] = useState(null); // one-time token payload
  const [open, setOpen] = useState(false);
  const [revoking, setRevoking] = useState(0);

  const load = useCallback(async () => {
    try { setInfo(await api.mock2GetConnect(projectId)); }
    catch (err) { if (!(err instanceof ApiError)) console.error('load connect failed:', err); }
  }, [projectId]);
  useEffect(() => { load(); }, [load]);

  const mint = async () => {
    setMinting(true);
    try {
      const r = await api.mock2CreateConnectToken(projectId, 'vscode');
      setMinted(r);
      setOpen(true);
      await load();
    } catch (err) {
      toast({ variant: 'destructive', title: 'Could not create a connect token', description: err.message });
    } finally { setMinting(false); }
  };

  const revoke = async (tokenId) => {
    setRevoking(tokenId);
    try { await api.mock2RevokeConnectToken(projectId, tokenId); await load(); }
    catch (err) { toast({ variant: 'destructive', title: 'Could not revoke', description: err.message }); }
    finally { setRevoking(0); }
  };

  const activeTokens = (info?.tokens || []).filter((t) => !t.revoked);

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2"><Plug className="h-4 w-4" /> Connect VS Code</CardTitle>
        <CardDescription>
          Clone this project&apos;s repository into VS Code (or any git client) with a personal connect token.
          {info?.can_push
            ? ' Pushes are recorded in the change history, synced into the running container, and deployed.'
            : ' Your role allows cloning; pushing needs the editor role.'}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <Button className="min-h-[44px]" disabled={minting} onClick={mint}>
            {minting ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Plug className="h-4 w-4 mr-1" />}
            Quick connect
          </Button>
          {info?.clone_url ? (
            <span className="min-w-0 truncate text-xs font-mono text-muted-foreground">{info.clone_url}</span>
          ) : null}
        </div>

        {activeTokens.length ? (
          <div className="space-y-1.5">
            <p className="text-xs font-medium text-muted-foreground">Active connect tokens</p>
            {activeTokens.map((t) => (
              <div key={t.id} className="flex items-center justify-between gap-2 rounded-md border p-2">
                <span className="min-w-0 truncate text-xs">
                  {t.label || 'token'} · created {String(t.created_at).slice(0, 10)}
                  {t.expires_at ? ` · expires ${String(t.expires_at).slice(0, 10)}` : ''}
                  {t.last_used_at ? ` · last used ${String(t.last_used_at).slice(0, 10)}` : ' · never used'}
                </span>
                <Button
                  variant="ghost" size="icon" className="h-9 w-9 shrink-0 text-red-500" aria-label="Revoke token"
                  disabled={revoking === t.id}
                  onClick={() => revoke(t.id)}
                >
                  {revoking === t.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                </Button>
              </div>
            ))}
          </div>
        ) : null}
        {!canEdit && !activeTokens.length ? null : null}
      </CardContent>

      {/* One-time token reveal + connect options. */}
      <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) setMinted(null); }}>
        <DialogContent className="max-w-full h-full rounded-none overflow-y-auto sm:max-w-lg sm:h-auto sm:rounded-lg">
          <DialogHeader>
            <DialogTitle>Connect VS Code</DialogTitle>
            <DialogDescription>
              This token is shown once — VS Code stores it as the git credential. It expires in 30 days and can
              be revoked here anytime.
            </DialogDescription>
          </DialogHeader>
          {minted ? (
            <div className="space-y-3">
              <Button asChild className="min-h-[44px] w-full">
                <a href={minted.vscode_url}>
                  <ExternalLink className="h-4 w-4 mr-1" /> Open in VS Code (clone)
                </a>
              </Button>
              <p className="text-xs text-muted-foreground">
                Or connect manually with any git client:
              </p>
              <CopyRow label="Clone URL" value={minted.clone_url} />
              <CopyRow label="Username" value={minted.username} />
              <CopyRow label="Token (password)" value={minted.token} />
              <CopyRow label="One-line clone" value={`git clone ${minted.clone_url_with_creds}`} />
              <p className="text-xs text-muted-foreground">
                Work normally and <span className="font-medium">git push</span> when ready — the push is recorded
                in the project&apos;s change history, synced into the container, and deployed automatically. If a
                build is running, your commits wait safely in the repository.
              </p>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </Card>
  );
}
