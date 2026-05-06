// Backups tab — on-demand encrypted backups + browse / download /
// delete past artifacts.
//
// PR 1 ships only the config tier (SQLite dump as JSON, .env, the
// cve-inbox YAMLs).  PR 2 adds the larger tiers, scheduling, and
// the restore dry-run.  The form below already shows a tier select
// so the operator's mental model includes the choice; the
// non-config options carry a "coming in PR 2" hint and are disabled.
//
// The passphrase typed into the create dialog is forwarded once on
// the wire and immediately used by the server to derive the AES-GCM
// key.  It is never written to the audit log, the backup row, the
// manifest header, or anywhere else durable.  Operators are warned
// that losing the passphrase makes the artifact unrecoverable.

import { useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useToast } from '@/hooks/use-toast';
import {
  AlertTriangle, CheckCircle2, Clock, Cloud, Download, FileArchive,
  Loader2, Plus, RefreshCw, RotateCcw, Save, Trash2, XCircle,
} from 'lucide-react';

import UsageCard from './UsageCard';
import SchedulesPanel from './SchedulesPanel';
import RestoreDialog from './RestoreDialog';
import RestoresPanel from './RestoresPanel';

function fmtBytes(n) {
  if (typeof n !== 'number' || Number.isNaN(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

function fmtAge(iso) {
  if (!iso) return '—';
  const dt = new Date(iso);
  const ms = Date.now() - dt.getTime();
  if (ms < 60_000) return 'just now';
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`;
  return `${Math.round(ms / 86_400_000)}d ago`;
}

function StatusBadge({ status }) {
  if (status === 'ok') {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400">
        <CheckCircle2 className="h-3.5 w-3.5" /> ok
      </span>
    );
  }
  if (status === 'in_progress') {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400">
        <Loader2 className="h-3.5 w-3.5 animate-spin" /> in progress
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-xs text-red-600 dark:text-red-400">
      <XCircle className="h-3.5 w-3.5" /> {status || 'failed'}
    </span>
  );
}

function CreateDialog({ open, onOpenChange, destinations, onSubmit, busy }) {
  const [tier, setTier] = useState('config');
  const [scope, setScope] = useState('');
  const [destinationId, setDestinationId] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [confirmPassphrase, setConfirmPassphrase] = useState('');

  useEffect(() => {
    if (!open) return;
    setTier('config');
    setScope('');
    // Default-select the row marked default; falls back to first.
    const def = destinations?.find((d) => d.is_default) || destinations?.[0];
    setDestinationId(def?.id || '');
    setPassphrase('');
    setConfirmPassphrase('');
  }, [open, destinations]);

  const noDestinations = !destinations?.length;
  const passphraseOk = passphrase.length >= 8 && passphrase === confirmPassphrase;
  const canSubmit = !busy && !noDestinations && passphraseOk
    && (tier === 'config' || tier === 'config_plus_data' || tier === 'full');

  const submit = () => {
    if (!canSubmit) return;
    onSubmit({
      tier,
      scope: scope.trim() || null,
      destination_id: destinationId || null,
      passphrase,
    });
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Create backup</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 text-sm">
          {noDestinations && (
            <div className="text-xs text-amber-700 dark:text-amber-400 border border-amber-500/30 bg-amber-500/10 rounded px-3 py-2">
              No storage destinations configured. Add one under the Storage tab first.
            </div>
          )}
          <div className="space-y-1">
            <Label htmlFor="bk-destination">Destination</Label>
            <select
              id="bk-destination"
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              value={destinationId}
              onChange={(e) => setDestinationId(e.target.value)}
              disabled={noDestinations}
            >
              <option value="" disabled>Select a destination</option>
              {(destinations || []).map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}{d.is_default ? ' (default)' : ''} — {d.bucket}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="bk-tier">Tier</Label>
            <select
              id="bk-tier"
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              value={tier}
              onChange={(e) => setTier(e.target.value)}
            >
              <option value="config">Config — SQLite + .env + cve-inbox (~50 KB, encrypted)</option>
              <option value="config_plus_data">Config + data — adds /etc/caddy + /etc/wireguard + ACME certs + service file roots (~10-100 MB)</option>
              <option value="full">Full — config_plus_data + every docker volume + every Incus instance (multi-GB)</option>
            </select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="bk-scope">Scope <span className="text-muted-foreground">(optional)</span></Label>
            <Input id="bk-scope" value={scope} onChange={(e) => setScope(e.target.value)}
              placeholder="all" autoComplete="off" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="bk-pass">
              Passphrase <span className="text-muted-foreground">(min 8 chars)</span>
            </Label>
            <Input id="bk-pass" type="password" autoComplete="new-password"
              value={passphrase} onChange={(e) => setPassphrase(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="bk-pass2">Confirm passphrase</Label>
            <Input id="bk-pass2" type="password" autoComplete="new-password"
              value={confirmPassphrase} onChange={(e) => setConfirmPassphrase(e.target.value)} />
            {confirmPassphrase.length > 0 && passphrase !== confirmPassphrase && (
              <p className="text-xs text-red-500">Passphrases don't match.</p>
            )}
          </div>
          <div className="text-xs text-muted-foreground border border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400 rounded px-3 py-2 flex gap-2">
            <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
            <span>
              The passphrase is used once to derive an AES-256-GCM key and is never
              persisted. <strong>Lose it and the backup is unrecoverable.</strong>
            </span>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
          <Button onClick={submit} disabled={!canSubmit}>
            {busy ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <Save className="h-4 w-4 mr-1.5" />}
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DeleteDialog({ open, onOpenChange, item, onConfirm, busy }) {
  if (!item) return null;
  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-amber-500" /> Delete backup
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-2 text-sm text-muted-foreground">
          <p>
            Delete <code className="font-mono text-xs text-foreground">{item.id}</code>?
            This removes the artifact from S3 and the row from the dashboard. Cannot be undone.
          </p>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
          <Button variant="destructive" onClick={onConfirm} disabled={busy}>
            {busy ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : null}
            Delete
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function BackupsTab() {
  const { toast } = useToast();
  const [items, setItems] = useState([]);
  const [destinations, setDestinations] = useState([]);
  const [usage, setUsage] = useState(null);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [busyId, setBusyId] = useState(null);

  const [createOpen, setCreateOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(null);

  const [restoreOpen, setRestoreOpen] = useState(false);
  const [restoreBackup, setRestoreBackup] = useState(null);
  const [focusRunId, setFocusRunId] = useState(null);

  const refresh = async () => {
    setLoading(true);
    try {
      const [list, dests, usageOut] = await Promise.all([
        api.backupsList(),
        api.backupsListStorage(),
        api.backupsUsage().catch(() => null),
      ]);
      setItems(list.backups || []);
      setDestinations(dests.destinations || []);
      setUsage(usageOut);
    } catch (err) {
      toast({
        title: 'Could not load backups',
        description: err instanceof ApiError ? err.message : (err?.message || 'unknown error'),
        variant: 'destructive',
      });
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { refresh(); /* eslint-disable-next-line */ }, []);

  const onCreate = async (body) => {
    setCreating(true);
    try {
      await api.backupsCreate(body);
      toast({ title: 'Backup created', description: 'Uploaded to S3.' });
      setCreateOpen(false);
      await refresh();
    } catch (err) {
      toast({
        title: 'Backup failed',
        description: err instanceof ApiError ? err.message : (err?.message || 'unknown error'),
        variant: 'destructive',
      });
    } finally {
      setCreating(false);
    }
  };

  const onDelete = (item) => { setDeleting(item); setDeleteOpen(true); };
  const confirmDelete = async () => {
    if (!deleting) return;
    setBusyId(deleting.id);
    try {
      const out = await api.backupsDelete(deleting.id);
      toast({
        title: 'Backup deleted',
        description: out.s3_error ? `S3 reported: ${out.s3_error}` : undefined,
        variant: out.s3_error ? 'destructive' : undefined,
      });
      setDeleteOpen(false);
      setDeleting(null);
      await refresh();
    } catch (err) {
      toast({
        title: 'Delete failed',
        description: err instanceof ApiError ? err.message : (err?.message || 'unknown error'),
        variant: 'destructive',
      });
    } finally {
      setBusyId(null);
    }
  };

  const noDestinations = !destinations?.length;

  const onRestore = (b) => { setRestoreBackup(b); setRestoreOpen(true); };
  const onRestoreStarted = (runId) => {
    setFocusRunId(runId);
    toast({ title: 'Dry-run started', description: 'See the Restores panel for live progress.' });
  };

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-3 flex-wrap">
        <p className="text-xs text-muted-foreground max-w-2xl leading-relaxed flex-1 min-w-[260px]">
          On-demand + scheduled encrypted backups across three tiers (config / config_plus_data /
          full) with restore dry-run.  Default destination is where new backups land; mark a
          different one default in the Storage tab to switch.
        </p>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={refresh} disabled={loading}>
            <RefreshCw className={`h-4 w-4 mr-1.5 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
          <Button size="sm" onClick={() => setCreateOpen(true)} disabled={noDestinations}>
            <Plus className="h-4 w-4 mr-1.5" />
            Create backup
          </Button>
        </div>
      </div>

      {noDestinations && !loading && (
        <Card>
          <CardHeader>
            <div className="flex items-start gap-3">
              <Cloud className="h-5 w-5 mt-0.5 text-muted-foreground" />
              <div className="space-y-1">
                <CardTitle className="text-base">No storage configured</CardTitle>
                <CardDescription className="text-xs">
                  Configure an S3-compatible destination under the Storage tab before
                  creating backups. ProxyPilot supports MinIO, Cloudflare R2, Backblaze
                  B2, AWS S3, and Wasabi out of the box.
                </CardDescription>
              </div>
            </div>
          </CardHeader>
        </Card>
      )}

      <UsageCard usage={usage} loading={loading} />

      {!loading && items.length === 0 && !noDestinations && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">No backups yet</CardTitle>
            <CardDescription className="text-xs">
              Click <strong>Create backup</strong> to take your first on-demand snapshot.
            </CardDescription>
          </CardHeader>
        </Card>
      )}

      {items.length > 0 && (
        <Card>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted/40 text-xs uppercase tracking-wide">
                  <tr>
                    <th className="text-left font-medium px-3 py-2">When</th>
                    <th className="text-left font-medium px-3 py-2">Tier</th>
                    <th className="text-left font-medium px-3 py-2">Scope</th>
                    <th className="text-left font-medium px-3 py-2">Size</th>
                    <th className="text-left font-medium px-3 py-2">Status</th>
                    <th className="text-right font-medium px-3 py-2">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((b) => {
                    const dest = destinations.find((d) => d.id === b.destination_id);
                    return (
                      <tr key={b.id} className="border-t">
                        <td className="px-3 py-2 align-top">
                          <div className="flex items-center gap-1.5">
                            <Clock className="h-3.5 w-3.5 text-muted-foreground" />
                            <span title={new Date(b.created_at).toLocaleString()}>
                              {fmtAge(b.created_at)}
                            </span>
                          </div>
                          <div className="text-[11px] text-muted-foreground font-mono">
                            {b.id.slice(0, 8)}…
                          </div>
                        </td>
                        <td className="px-3 py-2 align-top font-mono text-xs">
                          {b.tier}
                        </td>
                        <td className="px-3 py-2 align-top text-xs text-muted-foreground">
                          {b.scope || 'all'}
                          {dest && (
                            <div className="text-[11px]">→ {dest.name}</div>
                          )}
                        </td>
                        <td className="px-3 py-2 align-top font-mono">
                          {fmtBytes(b.size_bytes)}
                        </td>
                        <td className="px-3 py-2 align-top">
                          <StatusBadge status={b.status} />
                          {b.error && (
                            <div className="text-[11px] text-red-500 max-w-[14rem] truncate" title={b.error}>
                              {b.error}
                            </div>
                          )}
                        </td>
                        <td className="px-3 py-2 align-top">
                          <div className="flex justify-end gap-1.5">
                            {b.status === 'ok' && (
                              <>
                                <Button variant="outline" size="sm" onClick={() => onRestore(b)}>
                                  <RotateCcw className="h-3.5 w-3.5 mr-1.5" />
                                  Restore
                                </Button>
                                <Button asChild variant="outline" size="sm">
                                  <a href={api.backupsDownloadHref(b.id)} download>
                                    <Download className="h-3.5 w-3.5 mr-1.5" />
                                    Download
                                  </a>
                                </Button>
                              </>
                            )}
                            <Button
                              variant="destructive"
                              size="sm"
                              disabled={busyId === b.id}
                              onClick={() => onDelete(b)}
                            >
                              {busyId === b.id ? (
                                <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                              ) : (
                                <Trash2 className="h-3.5 w-3.5 mr-1.5" />
                              )}
                              Delete
                            </Button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      <SchedulesPanel destinations={destinations} onChange={refresh} />

      <RestoresPanel focusRunId={focusRunId} onUnfocus={() => setFocusRunId(null)} />

      <CreateDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        destinations={destinations}
        onSubmit={onCreate}
        busy={creating}
      />
      <DeleteDialog
        open={deleteOpen}
        onOpenChange={(o) => { if (!o) setDeleting(null); setDeleteOpen(o); }}
        item={deleting}
        onConfirm={confirmDelete}
        busy={busyId === deleting?.id}
      />
      <RestoreDialog
        open={restoreOpen}
        onOpenChange={(o) => { if (!o) setRestoreBackup(null); setRestoreOpen(o); }}
        backup={restoreBackup}
        onStarted={onRestoreStarted}
      />
    </div>
  );
}
