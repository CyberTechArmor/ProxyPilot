// Storage tab — CRUD on S3-compatible backup destinations.
//
// One row per registered destination (MinIO, R2, B2, AWS S3,
// Wasabi, …). Operators can:
//   * Add a destination (form + Test Connection in the dialog).
//   * Edit fields. secret_key is write-only — the dialog stays
//     blank on edit and an empty string is treated as "keep what's
//     stored".
//   * Test the live HEAD-bucket round-trip.  Verdict + latency_ms
//     written into test_status / test_at server-side; surfaced as
//     a small badge on the row.
//   * Mark a destination as default. Exactly one row may be
//     default at any time (server enforces this in a transaction).
//   * Remove a destination. Sudo-gated. PR 2 will block the delete
//     if a backup_schedule references the row; for now the table
//     doesn't exist yet so delete is unconditional.
//
// All mutating calls are sudo-gated server-side; the api client's
// retry-after-sudo flow handles the modal automatically.

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
  Activity, AlertTriangle, Check, Cloud, Loader2, Pencil, Plus, RefreshCw, Star, Trash2, X,
} from 'lucide-react';

// Empty-string optional fields ↦ null on the wire so the server
// doesn't store ' ' or '' as a meaningful value.
function emptyToNull(s) {
  if (s == null) return null;
  const t = String(s).trim();
  return t === '' ? null : t;
}

const EMPTY_FORM = {
  name: '',
  endpoint_url: '',
  bucket: '',
  region: '',
  path_prefix: '',
  access_key_id: '',
  secret_key: '',
  use_ssl: true,
  path_style: false,
  storage_class: '',
  is_default: false,
};

// Build the POST/PUT body from form state. On edit, an empty
// secret_key is omitted entirely so the server keeps the existing
// ciphertext rather than overwriting it with a deliberately-empty
// value (which would fail server-side validation anyway).
function formToBody(form, { isEdit }) {
  const body = {
    name: form.name.trim(),
    endpoint_url: form.endpoint_url.trim(),
    bucket: form.bucket.trim(),
    region: emptyToNull(form.region),
    path_prefix: emptyToNull(form.path_prefix),
    access_key_id: form.access_key_id.trim(),
    use_ssl: !!form.use_ssl,
    path_style: !!form.path_style,
    storage_class: emptyToNull(form.storage_class),
    is_default: !!form.is_default,
  };
  const secret = (form.secret_key || '').trim();
  if (!isEdit) {
    body.secret_key = secret;
  } else if (secret.length > 0) {
    body.secret_key = secret;
  }
  return body;
}

function TestStatusBadge({ status, ts }) {
  if (!status) {
    return (
      <span className="text-xs text-muted-foreground italic">never tested</span>
    );
  }
  if (status === 'ok') {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400">
        <Check className="h-3.5 w-3.5" /> ok
        {ts && (
          <span className="text-muted-foreground" title={new Date(ts).toLocaleString()}>
            · {new Date(ts).toLocaleTimeString()}
          </span>
        )}
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-center gap-1 text-xs text-red-600 dark:text-red-400 max-w-[26rem] truncate"
      title={status}
    >
      <X className="h-3.5 w-3.5 shrink-0" /> {status}
    </span>
  );
}

function DestinationCard({ dest, busyId, onTest, onEdit, onDelete, onSetDefault }) {
  const busy = busyId === dest.id;
  return (
    <Card className={dest.is_default ? 'ring-1 ring-amber-500/40' : undefined}>
      <CardHeader>
        <div className="flex items-start gap-3">
          <Cloud className="h-5 w-5 mt-0.5 text-muted-foreground" />
          <div className="space-y-1 flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <CardTitle className="text-base truncate">{dest.name}</CardTitle>
              {dest.is_default && (
                <span className="inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/30">
                  <Star className="h-3 w-3" /> default
                </span>
              )}
            </div>
            <CardDescription className="text-xs font-mono break-all">
              {dest.bucket}{dest.path_prefix ? `/${dest.path_prefix}` : ''} @ {dest.endpoint_url}
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
          <div className="flex justify-between">
            <span className="text-muted-foreground">Region</span>
            <span className="font-mono truncate">{dest.region || '—'}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Class</span>
            <span className="font-mono truncate">{dest.storage_class || 'STANDARD'}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">SSL</span>
            <span className="font-mono">{dest.use_ssl ? 'on' : 'off'}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Path style</span>
            <span className="font-mono">{dest.path_style ? 'on' : 'off'}</span>
          </div>
        </div>
        <div className="pt-1 border-t flex items-center gap-2 flex-wrap">
          <TestStatusBadge status={dest.test_status} ts={dest.test_at} />
          <div className="ml-auto flex gap-1.5 flex-wrap">
            <Button variant="outline" size="sm" onClick={() => onTest(dest)} disabled={busy}>
              {busy ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5 mr-1.5" />}
              Test
            </Button>
            {!dest.is_default && (
              <Button variant="outline" size="sm" onClick={() => onSetDefault(dest)} disabled={busy}>
                <Star className="h-3.5 w-3.5 mr-1.5" /> Make default
              </Button>
            )}
            <Button variant="outline" size="sm" onClick={() => onEdit(dest)} disabled={busy}>
              <Pencil className="h-3.5 w-3.5 mr-1.5" /> Edit
            </Button>
            <Button variant="destructive" size="sm" onClick={() => onDelete(dest)} disabled={busy}>
              <Trash2 className="h-3.5 w-3.5 mr-1.5" /> Remove
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function DestinationDialog({ open, onOpenChange, initial, onSubmit, onSubmitting, onSubmitAndTest }) {
  const isEdit = !!initial;
  const [form, setForm] = useState(EMPTY_FORM);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    if (initial) {
      setForm({
        name: initial.name || '',
        endpoint_url: initial.endpoint_url || '',
        bucket: initial.bucket || '',
        region: initial.region || '',
        path_prefix: initial.path_prefix || '',
        access_key_id: initial.access_key_id || '',
        secret_key: '', // never echoed back
        use_ssl: !!initial.use_ssl,
        path_style: !!initial.path_style,
        storage_class: initial.storage_class || '',
        is_default: !!initial.is_default,
      });
    } else {
      setForm(EMPTY_FORM);
    }
  }, [open, initial]);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e?.target ? e.target.value : e }));
  const setBool = (k) => (val) => setForm((f) => ({ ...f, [k]: !!val }));

  const submit = async () => {
    setBusy(true);
    try {
      await onSubmit(formToBody(form, { isEdit }));
      onOpenChange(false);
    } finally {
      setBusy(false);
    }
  };

  const submitAndTest = async () => {
    setBusy(true);
    try {
      await onSubmitAndTest(formToBody(form, { isEdit }));
      onOpenChange(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{isEdit ? 'Edit destination' : 'Add destination'}</DialogTitle>
        </DialogHeader>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
          <div className="sm:col-span-2 space-y-1">
            <Label htmlFor="dest-name">Name</Label>
            <Input id="dest-name" value={form.name} onChange={set('name')} placeholder="e.g. prod-r2" />
          </div>
          <div className="sm:col-span-2 space-y-1">
            <Label htmlFor="dest-endpoint">Endpoint URL</Label>
            <Input id="dest-endpoint" value={form.endpoint_url} onChange={set('endpoint_url')}
              placeholder="https://s3.us-east-1.amazonaws.com" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="dest-bucket">Bucket</Label>
            <Input id="dest-bucket" value={form.bucket} onChange={set('bucket')} placeholder="proxypilot-backups" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="dest-region">Region</Label>
            <Input id="dest-region" value={form.region} onChange={set('region')} placeholder="us-east-1" />
          </div>
          <div className="sm:col-span-2 space-y-1">
            <Label htmlFor="dest-prefix">Path prefix <span className="text-muted-foreground">(optional)</span></Label>
            <Input id="dest-prefix" value={form.path_prefix} onChange={set('path_prefix')} placeholder="prod/proxypilot" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="dest-akid">Access Key ID</Label>
            <Input id="dest-akid" value={form.access_key_id} onChange={set('access_key_id')} autoComplete="off" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="dest-secret">
              Secret Access Key
              {isEdit && (
                <span className="ml-1 text-xs text-muted-foreground">(blank = keep stored)</span>
              )}
            </Label>
            <Input id="dest-secret" type="password" value={form.secret_key}
              onChange={set('secret_key')} autoComplete="new-password" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="dest-class">Storage class <span className="text-muted-foreground">(optional)</span></Label>
            <Input id="dest-class" value={form.storage_class} onChange={set('storage_class')} placeholder="STANDARD" />
          </div>
          <div className="flex items-center gap-3 pt-6">
            <Switch id="dest-ssl" checked={form.use_ssl} onCheckedChange={setBool('use_ssl')} />
            <Label htmlFor="dest-ssl" className="cursor-pointer">SSL</Label>
            <span className="ml-3" />
            <Switch id="dest-pathstyle" checked={form.path_style} onCheckedChange={setBool('path_style')} />
            <Label htmlFor="dest-pathstyle" className="cursor-pointer" title="MinIO needs this; AWS doesn't">
              Path style
            </Label>
          </div>
          <div className="sm:col-span-2 flex items-center gap-3">
            <Switch id="dest-default" checked={form.is_default} onCheckedChange={setBool('is_default')} />
            <Label htmlFor="dest-default" className="cursor-pointer">
              Mark as default destination
            </Label>
          </div>
        </div>
        <DialogFooter className="gap-2 flex-wrap sm:gap-0">
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy || onSubmitting}>
            Cancel
          </Button>
          <Button variant="outline" onClick={submitAndTest} disabled={busy || onSubmitting}>
            {(busy || onSubmitting)
              ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
              : <RefreshCw className="h-4 w-4 mr-1.5" />}
            {isEdit ? 'Save & test' : 'Add & test'}
          </Button>
          <Button onClick={submit} disabled={busy || onSubmitting}>
            {(busy || onSubmitting) ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : null}
            {isEdit ? 'Save changes' : 'Add destination'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DeleteConfirmDialog({ open, onOpenChange, dest, onConfirm, busy }) {
  if (!dest) return null;
  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-amber-500" /> Remove destination
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-2 text-sm text-muted-foreground">
          <p>
            Remove <code className="font-mono text-xs text-foreground">{dest.name}</code>?
          </p>
          <p className="text-xs">
            This deletes the configuration row only. Existing objects in the bucket are
            untouched. Schedules referencing this destination will need to be updated
            (PR 2 will block this delete automatically when schedules exist).
          </p>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
          <Button variant="destructive" onClick={onConfirm} disabled={busy}>
            {busy ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : null}
            Remove
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function StorageTab() {
  const { toast } = useToast();
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [healthchecking, setHealthchecking] = useState(false);

  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState(null); // dest row, or null = create
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(null);

  const refresh = async () => {
    setLoading(true); setError(null);
    try {
      const out = await api.backupsListStorage();
      setItems(out.destinations || []);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : (err?.message || 'failed to load'));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { refresh(); /* eslint-disable-next-line */ }, []);

  const onTest = async (dest) => {
    setBusyId(dest.id);
    try {
      const out = await api.backupsTestStorage(dest.id);
      toast({
        title: out.ok ? 'Connection ok' : 'Connection failed',
        description: out.ok
          ? `HEAD bucket round-tripped in ${out.latency_ms} ms.`
          : (out.error || 'unknown error'),
        variant: out.ok ? undefined : 'destructive',
      });
      await refresh();
    } catch (err) {
      toast({
        title: 'Test failed',
        description: err instanceof ApiError ? err.message : (err?.message || 'unknown error'),
        variant: 'destructive',
      });
    } finally {
      setBusyId(null);
    }
  };

  const onSetDefault = async (dest) => {
    setBusyId(dest.id);
    try {
      await api.backupsSetDefaultStorage(dest.id);
      await refresh();
    } catch (err) {
      toast({
        title: 'Could not mark default',
        description: err instanceof ApiError ? err.message : (err?.message || 'unknown error'),
        variant: 'destructive',
      });
    } finally {
      setBusyId(null);
    }
  };

  const onEdit = (dest) => { setEditing(dest); setEditorOpen(true); };
  const onCreate = () => { setEditing(null); setEditorOpen(true); };

  const onRunHealthcheck = async () => {
    setHealthchecking(true);
    try {
      const r = await api.backupsRunS3Healthcheck();
      const failures = (r.results || []).filter((x) => !x.ok);
      if (failures.length === 0) {
        toast({
          title: 'All destinations reachable',
          description: `Probed ${r.results.length} destination${r.results.length === 1 ? '' : 's'}. All ok.`,
        });
      } else {
        toast({
          title: `${failures.length} destination${failures.length === 1 ? '' : 's'} unreachable`,
          description: failures.map((f) => `${f.name}: ${f.error || 'unknown'}`).join('; '),
          variant: 'destructive',
        });
      }
      await refresh();
    } catch (err) {
      toast({
        title: 'Health check failed',
        description: err instanceof ApiError ? err.message : (err?.message || 'unknown error'),
        variant: 'destructive',
      });
    } finally {
      setHealthchecking(false);
    }
  };

  // saveDestination — shared persistence path used by both 'Save'
  // and 'Save & test'.  Returns the resulting row's id so the
  // 'Save & test' caller can immediately fire the test endpoint
  // against it (the just-edited row may have flipped its
  // test_status from 'ok' to NULL when fields changed; the
  // operator would otherwise need a second click to re-test).
  const saveDestination = async (body) => {
    setSubmitting(true);
    try {
      if (editing) {
        await api.backupsUpdateStorage(editing.id, body);
        toast({ title: 'Destination saved' });
        return editing.id;
      }
      const r = await api.backupsCreateStorage(body);
      toast({ title: 'Destination added' });
      return r.destination?.id;
    } catch (err) {
      toast({
        title: editing ? 'Could not save' : 'Could not add',
        description: err instanceof ApiError ? err.message : (err?.message || 'unknown error'),
        variant: 'destructive',
      });
      throw err; // keep dialog open on failure
    } finally {
      setSubmitting(false);
    }
  };

  const onSubmit = async (body) => {
    try {
      await saveDestination(body);
      await refresh();
    } catch { /* toast already fired */ throw new Error('save failed'); }
  };

  const onSubmitAndTest = async (body) => {
    try {
      const id = await saveDestination(body);
      // Fire the test in the background — the dialog has
      // already closed.  Surface ok/fail via toast so the
      // operator gets immediate feedback without paying for
      // a Refresh + glance at the test_status pill.
      if (id) {
        try {
          const verdict = await api.backupsTestStorage(id);
          toast({
            title: verdict.ok ? 'Connection ok' : 'Connection failed',
            description: verdict.ok
              ? `HEAD bucket round-tripped in ${verdict.latency_ms} ms.`
              : (verdict.error || 'unknown error'),
            variant: verdict.ok ? undefined : 'destructive',
          });
        } catch (err) {
          toast({
            title: 'Test failed',
            description: err instanceof ApiError ? err.message : (err?.message || 'unknown error'),
            variant: 'destructive',
          });
        }
      }
      await refresh();
    } catch { /* save toast already fired */ throw new Error('save failed'); }
  };

  const onDelete = (dest) => { setDeleting(dest); setDeleteOpen(true); };
  const confirmDelete = async () => {
    if (!deleting) return;
    setBusyId(deleting.id);
    try {
      await api.backupsDeleteStorage(deleting.id);
      toast({ title: 'Destination removed' });
      setDeleteOpen(false);
      setDeleting(null);
      await refresh();
    } catch (err) {
      toast({
        title: 'Remove failed',
        description: err instanceof ApiError ? err.message : (err?.message || 'unknown error'),
        variant: 'destructive',
      });
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-3 flex-wrap">
        <p className="text-xs text-muted-foreground max-w-2xl leading-relaxed flex-1 min-w-[260px]">
          Configure one or more S3-compatible destinations. The default destination is
          where new on-demand backups land. Secret access keys are encrypted at rest
          using the same envelope as TOTP secrets — they're never returned to the UI
          after they're saved.
        </p>
        <div className="flex gap-2 flex-wrap">
          <Button variant="outline" size="sm" onClick={refresh} disabled={loading}>
            <RefreshCw className={`h-4 w-4 mr-1.5 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={onRunHealthcheck}
            disabled={loading || healthchecking || items.length === 0}
            title="Run the daily S3 probe against every destination now. The same probe runs automatically at 02:30 daily; failures post a notification."
          >
            {healthchecking
              ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
              : <Activity className="h-4 w-4 mr-1.5" />}
            Run health check
          </Button>
          <Button size="sm" onClick={onCreate}>
            <Plus className="h-4 w-4 mr-1.5" /> Add destination
          </Button>
        </div>
      </div>

      {error && (
        <div className="text-sm text-red-500 border border-red-500/30 bg-red-500/10 rounded px-3 py-2">
          {error}
        </div>
      )}

      {!loading && items.length === 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">No destinations yet</CardTitle>
            <CardDescription className="text-xs">
              Add an S3-compatible destination (MinIO, Cloudflare R2, Backblaze B2, AWS S3,
              Wasabi, …) to start using the Backups tab. ProxyPilot will encrypt the secret
              access key at rest and never echo it back to the dashboard.
            </CardDescription>
          </CardHeader>
        </Card>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {items.map((d) => (
          <DestinationCard
            key={d.id}
            dest={d}
            busyId={busyId}
            onTest={onTest}
            onEdit={onEdit}
            onDelete={onDelete}
            onSetDefault={onSetDefault}
          />
        ))}
      </div>

      <DestinationDialog
        open={editorOpen}
        onOpenChange={setEditorOpen}
        initial={editing}
        onSubmit={onSubmit}
        onSubmitAndTest={onSubmitAndTest}
        onSubmitting={submitting}
      />
      <DeleteConfirmDialog
        open={deleteOpen}
        onOpenChange={(o) => { if (!o) { setDeleting(null); } setDeleteOpen(o); }}
        dest={deleting}
        onConfirm={confirmDelete}
        busy={busyId === deleting?.id}
      />
    </div>
  );
}
