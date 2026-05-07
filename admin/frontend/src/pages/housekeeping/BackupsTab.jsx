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
import { Switch } from '@/components/ui/switch';
import { useToast } from '@/hooks/use-toast';
import {
  AlertTriangle, CheckCircle2, Clock, Cloud, Download, FileArchive,
  Loader2, Plus, RefreshCw, RotateCcw, Save, Trash2, XCircle,
} from 'lucide-react';

import UsageCard from './UsageCard';
import SchedulesPanel from './SchedulesPanel';
import RestoreDialog from './RestoreDialog';
import RestoresPanel from './RestoresPanel';
import ScopePicker from './ScopePicker';

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

// Absolute timestamp — used as the secondary line under fmtAge so
// 'just now' / '5m ago' rows still show the actual wall-clock
// time the operator ran the backup.  Reads better than just the
// relative form when reviewing a long list.
function fmtAbs(iso) {
  if (!iso) return '';
  const dt = new Date(iso);
  if (Number.isNaN(dt.getTime())) return '';
  const sameDay = dt.toDateString() === new Date().toDateString();
  return sameDay
    ? dt.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    : dt.toLocaleString(undefined, {
        month: 'short', day: 'numeric',
        hour: 'numeric', minute: '2-digit',
      });
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
  // scope: null/'' for 'all', or a JSON-stringified
  // { service_ids: [...] } when the operator picked a subset.
  // Only meaningful for tier=config_plus_data + tier=full;
  // hidden for the config tier (which captures dashboard state,
  // not per-service).
  const [scope, setScope] = useState(null);
  // Multi-destination fan-out (post-PR-3 polish).  Empty array
  // means local-only.  Default-selects the is_default=1 row when
  // one exists, matching legacy single-target behaviour.
  const [destinationIds, setDestinationIds] = useState([]);
  const [passphrase, setPassphrase] = useState('');
  const [confirmPassphrase, setConfirmPassphrase] = useState('');

  useEffect(() => {
    if (!open) return;
    setTier('config');
    setScope(null);
    const def = destinations?.find((d) => d.is_default) || destinations?.[0];
    setDestinationIds(def ? [def.id] : []);
    setPassphrase('');
    setConfirmPassphrase('');
  }, [open, destinations]);

  const passphraseOk = passphrase.length >= 8 && passphrase === confirmPassphrase;
  // Backups now allow zero destinations (local-only).  Submit is
  // gated only by passphrase + tier validity.
  const canSubmit = !busy && passphraseOk
    && (tier === 'config' || tier === 'config_plus_data' || tier === 'full');

  const toggleDestination = (id) => {
    setDestinationIds((prev) => prev.includes(id)
      ? prev.filter((x) => x !== id)
      : [...prev, id]);
  };

  const submit = () => {
    if (!canSubmit) return;
    onSubmit({
      tier,
      // scope is already JSON-stringified by ScopePicker; the
      // config tier ignores it and the backend tolerates null.
      scope: tier === 'config' ? null : (scope || null),
      destination_ids: destinationIds,
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
          <div className="space-y-1">
            <Label>Destinations</Label>
            <p className="text-[11px] text-muted-foreground">
              Pack once locally, then push to <strong>each</strong> selected destination
              in turn. Pick none for a local-only backup, one for legacy single-target,
              or several to fan out across an on-site mirror plus an off-site archive.
            </p>
            {(destinations || []).length === 0 ? (
              <p className="text-xs text-muted-foreground italic border rounded px-3 py-2">
                No storage destinations configured — backup will be local-only.
                Add destinations under the Storage tab to enable S3 fan-out.
              </p>
            ) : (
              <div className="border rounded p-2 max-h-40 overflow-y-auto text-xs space-y-1">
                {(destinations || []).map((d) => (
                  <label
                    key={d.id}
                    className="flex items-center gap-2 py-0.5 cursor-pointer hover:bg-muted/40 rounded px-1"
                  >
                    <input
                      type="checkbox"
                      checked={destinationIds.includes(d.id)}
                      onChange={() => toggleDestination(d.id)}
                    />
                    <span className="font-medium truncate flex-1">
                      {d.name}{d.is_default ? ' (default)' : ''}
                    </span>
                    <span className="text-muted-foreground font-mono text-[10px] truncate">
                      {d.bucket}
                    </span>
                  </label>
                ))}
              </div>
            )}
            <p className="text-[11px] text-muted-foreground">
              {destinationIds.length === 0
                ? 'Local-only — no S3 push.'
                : `Will push to ${destinationIds.length} destination${destinationIds.length === 1 ? '' : 's'}.`}
            </p>
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
          {tier !== 'config' && (
            <ScopePicker value={scope} onChange={setScope} disabled={busy} />
          )}
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

// DeleteDialog — operator picks which copies to remove.  Local-
// first architecture means a backup may exist in two places
// (local disk + S3); the dialog surfaces both as toggleable
// switches so the operator can keep the S3 archive while
// reclaiming local disk space, or vice versa.
function DeleteDialog({ open, onOpenChange, item, onConfirm, busy }) {
  const [deleteLocal, setDeleteLocal] = useState(true);
  const [deleteS3, setDeleteS3] = useState(true);

  useEffect(() => {
    if (!open || !item) return;
    // Default the toggles to 'remove what's actually present' so
    // the operator doesn't see a switch flipped for a copy that
    // doesn't exist.
    setDeleteLocal(!!item.has_local);
    setDeleteS3(!!item.s3_uploaded);
  }, [open, item]);

  if (!item) return null;
  // Orphan = the row exists in the dashboard but neither a local
  // file nor an S3 copy is reachable (retention pruned local +
  // bucket-side lifecycle dropped the object, or both copies
  // failed at create-time).  We still want operators to be able
  // to clean these up from the table, so the dialog flips into
  // a 'drop dashboard row only' mode where the toggles are
  // hidden and the destructive button is enabled.
  const isOrphan = !item.has_local && !item.s3_uploaded;
  const noCopiesSelected = !deleteLocal && !deleteS3;
  const canSubmit = !busy && (isOrphan || !noCopiesSelected);

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-amber-500" />
            {isOrphan ? 'Drop orphan row' : 'Delete backup'}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3 text-sm">
          <p className="text-muted-foreground">
            {isOrphan ? (
              <>
                Backup <code className="font-mono text-xs text-foreground">{item.id}</code> has
                no local copy <strong>and</strong> nothing reachable in S3 — likely retention
                pruned local while the bucket was already empty.  Drop the dashboard row?
                Cannot be undone.
              </>
            ) : (
              <>
                Delete <code className="font-mono text-xs text-foreground">{item.id}</code>?
                Cannot be undone.
              </>
            )}
          </p>
          {!isOrphan && (
            <div className="space-y-2 border rounded p-3">
              <div className="flex items-center gap-3">
                <Switch
                  id="del-local"
                  checked={deleteLocal}
                  onCheckedChange={setDeleteLocal}
                  disabled={!item.has_local}
                />
                <Label htmlFor="del-local" className={item.has_local ? 'cursor-pointer' : 'text-muted-foreground'}>
                  Remove the local copy on this host
                  {!item.has_local && <span className="ml-1 text-[11px]">(none on disk)</span>}
                </Label>
              </div>
              <div className="flex items-center gap-3">
                <Switch
                  id="del-s3"
                  checked={deleteS3}
                  onCheckedChange={setDeleteS3}
                  disabled={!item.s3_uploaded}
                />
                <Label htmlFor="del-s3" className={item.s3_uploaded ? 'cursor-pointer' : 'text-muted-foreground'}>
                  Remove the copy in S3 ({(item.destination_name || 'destination').replace(/^null$/, 'unknown')})
                  {!item.s3_uploaded && <span className="ml-1 text-[11px]">(not uploaded)</span>}
                </Label>
              </div>
            </div>
          )}
          {!isOrphan && (
            <p className="text-[11px] text-muted-foreground">
              When both copies are removed, the row disappears from the dashboard.
              When only one is removed, the row stays so the remaining copy is still tracked.
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
          <Button
            variant="destructive"
            onClick={() => onConfirm({
              delete_local: isOrphan ? true : deleteLocal,
              delete_s3: isOrphan ? true : deleteS3,
            })}
            disabled={!canSubmit}
          >
            {busy ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : null}
            {isOrphan ? 'Drop row' : 'Delete'}
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
  const confirmDelete = async (choice) => {
    if (!deleting) return;
    setBusyId(deleting.id);
    try {
      const out = await api.backupsDelete(deleting.id, choice);
      const summary = [];
      if (out.local_removed) summary.push('local');
      if (out.s3_removed) summary.push('S3');
      toast({
        title: out.row_dropped ? 'Backup deleted' : 'Copies removed',
        description: out.s3_error
          ? `S3 reported: ${out.s3_error}`
          : (summary.length ? `Removed: ${summary.join(', ')}.` : undefined),
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

  const onPullLocal = async (b) => {
    setBusyId(b.id);
    try {
      const out = await api.backupsPullLocal(b.id);
      toast({
        title: out.already_local ? 'Already local' : 'Local copy restored',
        description: out.already_local
          ? 'Backup already has a local copy on disk.'
          : `Streamed ${out.size_bytes ? `${out.size_bytes} bytes` : 'artifact'} from S3 to local.`,
      });
      await refresh();
    } catch (err) {
      toast({
        title: 'Pull from S3 failed',
        description: err instanceof ApiError ? err.message : (err?.message || 'unknown error'),
        variant: 'destructive',
      });
    } finally {
      setBusyId(null);
    }
  };
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
          <Button size="sm" onClick={() => setCreateOpen(true)}>
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
                <CardTitle className="text-base">No S3 destinations configured</CardTitle>
                <CardDescription className="text-xs">
                  Backups will be <strong>local-only</strong> until you add at least one
                  S3-compatible destination (MinIO, Cloudflare R2, Backblaze B2, AWS S3,
                  Wasabi, …) under the Storage tab. Off-host durability requires at
                  least one destination.
                </CardDescription>
              </div>
            </div>
          </CardHeader>
        </Card>
      )}

      <UsageCard usage={usage} loading={loading} />

      {!loading && items.length === 0 && (
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
                    <th className="text-left font-medium px-3 py-2">Destination</th>
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
                          <div className="text-[11px] text-muted-foreground">
                            {fmtAbs(b.created_at)}
                          </div>
                          <div className="text-[11px] text-muted-foreground font-mono">
                            {b.id.slice(0, 8)}…
                          </div>
                        </td>
                        <td className="px-3 py-2 align-top font-mono text-xs">
                          {b.tier}
                        </td>
                        <td className="px-3 py-2 align-top text-xs text-muted-foreground">
                          {dest ? (
                            <>
                              <span className="font-mono">{dest.name}</span>
                              <div className="text-[11px] truncate max-w-[14rem]" title={dest.bucket}>
                                {dest.bucket}
                              </div>
                            </>
                          ) : (
                            <span className="italic">unknown</span>
                          )}
                        </td>
                        <td className="px-3 py-2 align-top font-mono">
                          {fmtBytes(b.size_bytes)}
                        </td>
                        <td className="px-3 py-2 align-top">
                          <StatusBadge status={b.status} />
                          <div className="mt-1 flex flex-wrap gap-1">
                            {b.has_local && (
                              <span
                                className="inline-flex items-center text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/30"
                                title="Local copy on this host's disk; download + restore read from here"
                              >
                                local
                              </span>
                            )}
                            {b.s3_uploaded && (
                              <span
                                className="inline-flex items-center text-[10px] px-1.5 py-0.5 rounded bg-sky-500/10 text-sky-600 dark:text-sky-400 border border-sky-500/30"
                                title="Uploaded to the configured S3 destination"
                              >
                                S3
                              </span>
                            )}
                            {!b.has_local && !b.s3_uploaded && (
                              <span className="text-[10px] text-amber-600">no copy</span>
                            )}
                          </div>
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
                                {b.s3_uploaded && !b.has_local && (
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    disabled={busyId === b.id}
                                    onClick={() => onPullLocal(b)}
                                    title="Stream the artifact down from S3 to local disk for instant download / restore."
                                  >
                                    {busyId === b.id ? (
                                      <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                                    ) : (
                                      <Cloud className="h-3.5 w-3.5 mr-1.5" />
                                    )}
                                    Pull local
                                  </Button>
                                )}
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
