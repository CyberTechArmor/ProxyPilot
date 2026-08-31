// Delegated editing — the admin's side of it, on one container's dialog.
//
// The job this screen does: hand somebody outside ProxyPilot the ability to
// edit one website's files with their own AI, and be able to take it back. So
// it is organised around the three questions an admin actually asks:
//
//   Is it on, and for which directory?   → the activation card
//   Who has a key?                       → the key list, with its live status
//   How do I stop this right now?        → Revoke, per key; the toggle, for all
//
// The scoping is enforced on the server (routes/mcp-editor.js); nothing here is
// a security control. What this screen owes the admin is an accurate picture of
// what is currently true, which is why every action refetches rather than
// patching local state — a key list that disagrees with the server about who
// still has access is worse than a slow one.
//
// Mobile-first per MOBILE_FIRST.md: rows stack at <sm, the key row's actions
// wrap, and the one-time key is shown in a full-screen dialog on a phone
// because copying a 71-character secret on a 360px screen is the whole point of
// that moment.

import { useState, useEffect, useCallback } from 'react';
import { api } from '@/lib/api';
import { useToast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  KeyRound, Copy, Check, Loader2, AlertCircle, Trash2, ShieldAlert, FolderTree,
} from 'lucide-react';

const STATUS_STYLES = {
  active: 'bg-green-500/10 text-green-600 dark:text-green-400 border-green-500/30',
  revoked: 'bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/30',
  suspended: 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/30',
  orphaned: 'bg-muted text-muted-foreground border-border',
};

const STATUS_HELP = {
  active: 'Working now',
  revoked: 'Permanently revoked',
  suspended: 'Delegated editing is switched off for this container',
  orphaned: 'The container no longer exists',
};

function StatusPill({ status }) {
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${STATUS_STYLES[status] || STATUS_STYLES.orphaned}`}>
      {status}
    </span>
  );
}

function formatWhen(iso) {
  if (!iso) return 'never';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '-' : d.toLocaleString();
}

export default function DelegatedEditing({ containerName }) {
  const { toast } = useToast();
  const [state, setState] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  // The docroot input is local while the admin types and is only sent on save,
  // so a half-typed path is never briefly the live scope.
  const [docrootDraft, setDocrootDraft] = useState('');
  const [label, setLabel] = useState('');
  const [minted, setMinted] = useState(null);      // the one-and-only view of a new key
  const [copied, setCopied] = useState(false);
  const [confirmRevoke, setConfirmRevoke] = useState(null);

  const load = useCallback(async () => {
    try {
      const data = await api.lxcEditorGet(containerName);
      setState(data);
      setDocrootDraft(data.activation?.docroot || data.default_docroot);
    } catch (err) {
      toast({ title: 'Could not load delegated editing', description: err.message, variant: 'destructive' });
    } finally {
      setLoading(false);
    }
  }, [containerName, toast]);

  useEffect(() => { load(); }, [load]);

  const active = !!state?.activation?.active;

  async function saveActivation(nextActive, nextDocroot) {
    setBusy(true);
    try {
      await api.lxcEditorSetActivation(containerName, { active: nextActive, docroot: nextDocroot });
      await load();
      toast({
        title: nextActive ? 'Delegated editing is on' : 'Delegated editing is off',
        description: nextActive
          ? `Keys for this container can edit files under ${nextDocroot}.`
          : 'Every key for this container is suspended until you turn it back on.',
      });
    } catch (err) {
      toast({ title: 'Could not save', description: err.message, variant: 'destructive' });
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function createKey() {
    if (!label.trim()) return;
    setBusy(true);
    try {
      const res = await api.lxcEditorCreateKey(containerName, label.trim());
      setMinted(res);
      setCopied(false);
      setLabel('');
      await load();
    } catch (err) {
      toast({ title: 'Could not create the key', description: err.message, variant: 'destructive' });
    } finally {
      setBusy(false);
    }
  }

  async function revoke(key) {
    setBusy(true);
    try {
      await api.lxcEditorRevokeKey(containerName, key.id);
      await load();
      toast({ title: 'Key revoked', description: `"${key.label}" stops working immediately.` });
    } catch (err) {
      toast({ title: 'Could not revoke', description: err.message, variant: 'destructive' });
    } finally {
      setBusy(false);
      setConfirmRevoke(null);
    }
  }

  async function copyToken() {
    try {
      await navigator.clipboard.writeText(minted.token);
      setCopied(true);
    } catch {
      toast({ title: 'Copy failed', description: 'Select the key and copy it manually.', variant: 'destructive' });
    }
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading…
      </div>
    );
  }

  const keys = state?.keys || [];
  const liveKeys = keys.filter((k) => !k.revoked_at);

  return (
    <div className="space-y-4 p-1">
      {/* What this is, before the controls — an admin reaching this tab for the
          first time is deciding whether to hand access to a person, and the
          scope of what they are handing over is the decision. */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <KeyRound className="h-4 w-4" />
            Delegated editing
          </CardTitle>
          <CardDescription>
            Give someone outside ProxyPilot a key that lets their AI edit files in one
            directory of <span className="font-mono">{containerName}</span> — and nothing else.
            No shell, no other container, no path above the directory you set.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 p-3 border rounded-lg">
            <div className="min-w-0 flex-1">
              <div className="font-medium text-sm">{active ? 'On' : 'Off'}</div>
              <div className="text-xs text-muted-foreground">
                {active
                  ? `${liveKeys.length} key${liveKeys.length === 1 ? '' : 's'} can edit this container`
                  : 'Turning this off suspends every key for this container at once. Revoking a key is the permanent version.'}
              </div>
            </div>
            <Switch
              checked={active}
              disabled={busy || state?.container_exists === false}
              onCheckedChange={(next) => saveActivation(next, docrootDraft)}
              aria-label="Delegated editing"
            />
          </div>

          {/* The docroot is the whole scope, so it is always visible and always
              editable — not buried behind the activation flow that set it. */}
          <div className="space-y-2">
            <Label htmlFor="pp-docroot" className="flex items-center gap-1.5">
              <FolderTree className="h-3.5 w-3.5" />
              Editable directory
            </Label>
            <div className="flex flex-col sm:flex-row gap-2">
              <Input
                id="pp-docroot"
                value={docrootDraft}
                onChange={(e) => setDocrootDraft(e.target.value)}
                placeholder={state?.default_docroot}
                className="font-mono text-sm w-full"
                spellCheck={false}
              />
              <Button
                variant="outline"
                className="w-full sm:w-auto shrink-0"
                disabled={busy || !docrootDraft.trim() || docrootDraft === state?.activation?.docroot}
                onClick={() => saveActivation(active, docrootDraft.trim())}
              >
                Save
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Key holders see this directory as <span className="font-mono">/</span> and cannot reach
              anything above it. Changing it applies to every key for this container on their next request.
            </p>
          </div>

          {state?.container_exists === false && (
            <div className="flex items-start gap-2 p-3 rounded-lg border border-amber-500/30 bg-amber-500/10 text-xs">
              <AlertCircle className="h-4 w-4 shrink-0 mt-0.5 text-amber-600 dark:text-amber-400" />
              <span>
                This container no longer exists on the host. Every key below is orphaned and already
                refuses requests; revoke them if the container is not coming back.
              </span>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Keys */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Keys</CardTitle>
          <CardDescription>
            One key per person. Each is shown once, at creation, and can be revoked at any time.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-col sm:flex-row gap-2">
            <Input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') createKey(); }}
              placeholder="Who is this for? e.g. Sarah — unlimited.lighting"
              className="w-full"
              maxLength={120}
            />
            <Button
              className="w-full sm:w-auto shrink-0"
              disabled={busy || !label.trim() || !state?.activation}
              onClick={createKey}
            >
              {busy ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <KeyRound className="h-4 w-4 mr-1.5" />}
              Create key
            </Button>
          </div>
          {!state?.activation && (
            <p className="text-xs text-muted-foreground">
              Turn delegated editing on first — a key has to be scoped to a directory.
            </p>
          )}

          {keys.length === 0 ? (
            <p className="text-sm text-muted-foreground py-2">No keys yet.</p>
          ) : (
            <div className="space-y-2">
              {keys.map((k) => (
                <div
                  key={k.id}
                  className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 p-3 border rounded-lg"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="font-medium text-sm truncate">{k.label}</span>
                      <StatusPill status={k.status} />
                    </div>
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground mt-1">
                      <span className="font-mono">{k.token_prefix}…</span>
                      <span>created {formatWhen(k.created_at)}</span>
                      <span>last used {formatWhen(k.last_used_at)}</span>
                    </div>
                    <div className="text-xs text-muted-foreground mt-0.5">{STATUS_HELP[k.status]}</div>
                  </div>
                  <div className="flex gap-1 flex-wrap">
                    {!k.revoked_at && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-11 sm:h-9 text-destructive hover:text-destructive"
                        disabled={busy}
                        onClick={() => setConfirmRevoke(k)}
                      >
                        <Trash2 className="h-4 w-4 mr-1.5" />
                        Revoke
                      </Button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* The one-time key. Full-screen on a phone: this is the single moment
          the secret exists outside the server, and it has to be copyable. */}
      <Dialog open={!!minted} onOpenChange={(o) => { if (!o) setMinted(null); }}>
        <DialogContent className="max-w-full h-full rounded-none sm:max-w-2xl sm:h-auto sm:rounded-lg flex flex-col">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ShieldAlert className="h-5 w-5 text-amber-500" />
              Copy this key now
            </DialogTitle>
            <DialogDescription>
              It is shown once and cannot be recovered. If it is lost, revoke it and create another.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 flex-1 overflow-y-auto min-h-0">
            <div>
              <Label className="text-xs">Key</Label>
              <div className="flex flex-col sm:flex-row gap-2 mt-1">
                <code className="flex-1 min-w-0 break-all rounded-md border bg-muted px-3 py-2 text-xs font-mono">
                  {minted?.token}
                </code>
                <Button variant="outline" className="w-full sm:w-auto shrink-0" onClick={copyToken}>
                  {copied ? <Check className="h-4 w-4 mr-1.5" /> : <Copy className="h-4 w-4 mr-1.5" />}
                  {copied ? 'Copied' : 'Copy'}
                </Button>
              </div>
            </div>
            <div>
              <Label className="text-xs">Connector URL (paste into Claude)</Label>
              <code className="mt-1 block break-all rounded-md border bg-muted px-3 py-2 text-xs font-mono">
                {minted?.connector_url}
              </code>
              <p className="text-xs text-muted-foreground mt-1.5">
                This URL contains the key. Send it the way you would send a password — and note that
                it grants editing of <span className="font-mono">{minted?.docroot}</span> in{' '}
                <span className="font-mono">{containerName}</span>, nothing else.
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button onClick={() => setMinted(null)} className="w-full sm:w-auto">Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Revocation is permanent, so it asks. */}
      <Dialog open={!!confirmRevoke} onOpenChange={(o) => { if (!o) setConfirmRevoke(null); }}>
        <DialogContent className="max-w-full h-full rounded-none sm:max-w-md sm:h-auto sm:rounded-lg">
          <DialogHeader>
            <DialogTitle>Revoke this key?</DialogTitle>
            <DialogDescription>
              &quot;{confirmRevoke?.label}&quot; stops working on its very next request. This cannot be
              undone — issue a new key if they need access again. The row stays in the list as a record.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="flex-col sm:flex-row gap-2">
            <Button variant="outline" className="w-full sm:w-auto" onClick={() => setConfirmRevoke(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              className="w-full sm:w-auto"
              disabled={busy}
              onClick={() => revoke(confirmRevoke)}
            >
              Revoke
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
