// Schedules panel — list + CRUD on backup_schedules.
//
// Lives inside the Backups tab, beneath the past-backups table.
// Compact card list because most installs have 1-3 schedules.
// Each row shows: name, cron (with a humanized hint), tier,
// destination, retention, last run + next run, run-now button,
// edit + delete.
//
// CRUD goes through a single dialog component; both create + edit
// share it.  passphrase is write-only (matches the Storage tab's
// secret-key handling — the dialog starts blank on edit and a
// blank submission means 'keep what's stored').

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
  AlertTriangle, Clock, Loader2, Pencil, Play, Plus, RefreshCw, Timer, Trash2,
} from 'lucide-react';
import {
  SCHEDULE_MODES, DAYS_OF_WEEK, buildCron, parseCron, describeCron,
} from './cron-builder';

function pad2(n) {
  return String(Number(n) || 0).padStart(2, '0');
}

function fmtAge(iso) {
  if (!iso) return '—';
  const dt = new Date(iso);
  const ms = Date.now() - dt.getTime();
  const past = ms >= 0;
  const abs = Math.abs(ms);
  let v, u;
  if (abs < 60_000) { v = Math.round(abs / 1000); u = 's'; }
  else if (abs < 3_600_000) { v = Math.round(abs / 60_000); u = 'm'; }
  else if (abs < 86_400_000) { v = Math.round(abs / 3_600_000); u = 'h'; }
  else { v = Math.round(abs / 86_400_000); u = 'd'; }
  return past ? `${v}${u} ago` : `in ${v}${u}`;
}

const EMPTY_FORM = {
  name: '',
  destination_id: '',
  // Schedule expressed as either (mode + hour/minute/dow/dom) for
  // the picker UI, OR a raw cron expression in custom mode.
  // formToBody() resolves the two into a single cron_expr field on
  // submit; parseCron() walks the other direction on Edit.
  schedule_mode: 'daily',
  schedule_hour: 3,
  schedule_minute: 0,
  schedule_dow: 0,
  schedule_dom: 1,
  cron_expr: '0 3 * * *', // only used when schedule_mode === 'custom'
  tier: 'config',
  scope: '',
  retention_keep: 30,
  retention_days: '',
  passphrase: '',
  passphrase_hint: '',
  enabled: true,
};

function formToBody(form, { isEdit }) {
  // schedule_mode = 'custom' uses the raw cron expression the
  // operator typed; everything else is resolved through buildCron.
  const cron_expr = form.schedule_mode === 'custom'
    ? form.cron_expr.trim()
    : buildCron({
        mode: form.schedule_mode,
        hour: Number(form.schedule_hour),
        minute: Number(form.schedule_minute),
        dow: Number(form.schedule_dow),
        dom: Number(form.schedule_dom),
      });
  const body = {
    name: form.name.trim(),
    destination_id: form.destination_id,
    cron_expr,
    tier: form.tier,
    scope: form.scope.trim() || null,
    retention_keep: Number(form.retention_keep) || 0,
    retention_days: form.retention_days === '' ? null : Number(form.retention_days),
    passphrase_hint: form.passphrase_hint.trim() || null,
    enabled: !!form.enabled,
  };
  const pass = (form.passphrase || '').trim();
  if (!isEdit) {
    body.passphrase = pass;
  } else if (pass.length > 0) {
    body.passphrase = pass;
  }
  return body;
}

function ScheduleDialog({ open, onOpenChange, initial, destinations, onSubmit, busy }) {
  const isEdit = !!initial;
  const [form, setForm] = useState(EMPTY_FORM);

  useEffect(() => {
    if (!open) return;
    if (initial) {
      const parsed = parseCron(initial.cron_expr || '');
      setForm({
        name: initial.name || '',
        destination_id: initial.destination_id || '',
        schedule_mode: parsed.mode,
        schedule_hour: parsed.hour ?? 3,
        schedule_minute: parsed.minute ?? 0,
        schedule_dow: parsed.dow ?? 0,
        schedule_dom: parsed.dom ?? 1,
        cron_expr: initial.cron_expr || '0 3 * * *',
        tier: initial.tier || 'config',
        scope: initial.scope || '',
        retention_keep: initial.retention_keep ?? 30,
        retention_days: initial.retention_days ?? '',
        passphrase: '',
        passphrase_hint: initial.passphrase_hint || '',
        enabled: !!initial.enabled,
      });
    } else {
      const def = destinations.find((d) => d.is_default) || destinations[0];
      setForm({ ...EMPTY_FORM, destination_id: def?.id || '' });
    }
  }, [open, initial, destinations]);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e?.target ? e.target.value : e }));
  const setBool = (k) => (val) => setForm((f) => ({ ...f, [k]: !!val }));

  const passphraseOk = isEdit ? true : (form.passphrase || '').length >= 8;
  const formOk = !!form.name.trim() && !!form.destination_id && !!form.cron_expr.trim()
    && passphraseOk && !!form.tier;

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{isEdit ? 'Edit schedule' : 'Schedule a backup'}</DialogTitle>
        </DialogHeader>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
          <div className="sm:col-span-2 space-y-1">
            <Label htmlFor="sch-name">Name</Label>
            <Input id="sch-name" value={form.name} onChange={set('name')}
              placeholder="e.g. Nightly config" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="sch-dest">Destination</Label>
            <select id="sch-dest"
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              value={form.destination_id} onChange={set('destination_id')}
            >
              <option value="" disabled>Select…</option>
              {destinations.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}{d.is_default ? ' (default)' : ''}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="sch-tier">Tier</Label>
            <select id="sch-tier"
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              value={form.tier} onChange={set('tier')}
            >
              <option value="config">config (~50 KB)</option>
              <option value="config_plus_data">config_plus_data (~10-100 MB)</option>
              <option value="full">full (multi-GB)</option>
            </select>
          </div>
          <div className="sm:col-span-2 space-y-1">
            <Label>Schedule</Label>
            <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto_auto] gap-2">
              <select
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                value={form.schedule_mode}
                onChange={set('schedule_mode')}
                aria-label="Schedule cadence"
              >
                {Object.entries(SCHEDULE_MODES).map(([k, label]) => (
                  <option key={k} value={k}>{label}</option>
                ))}
              </select>
              {form.schedule_mode === 'weekly' && (
                <select
                  className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                  value={form.schedule_dow}
                  onChange={set('schedule_dow')}
                  aria-label="Day of week"
                >
                  {DAYS_OF_WEEK.map((d) => (
                    <option key={d.value} value={d.value}>{d.label}</option>
                  ))}
                </select>
              )}
              {form.schedule_mode === 'monthly' && (
                <Input
                  type="number" min="1" max="31"
                  value={form.schedule_dom}
                  onChange={set('schedule_dom')}
                  aria-label="Day of month"
                  className="w-24"
                />
              )}
              {form.schedule_mode !== 'custom' && form.schedule_mode !== 'hourly' && (
                <Input
                  type="time"
                  value={`${pad2(form.schedule_hour)}:${pad2(form.schedule_minute)}`}
                  onChange={(e) => {
                    const [h, m] = (e.target.value || '03:00').split(':');
                    setForm((f) => ({
                      ...f,
                      schedule_hour: Number(h) || 0,
                      schedule_minute: Number(m) || 0,
                    }));
                  }}
                  className="w-32"
                  aria-label="Time of day"
                />
              )}
              {form.schedule_mode === 'hourly' && (
                <div className="flex items-center gap-1.5 text-xs">
                  <Label htmlFor="sch-hourly-min">at minute</Label>
                  <Input
                    id="sch-hourly-min"
                    type="number" min="0" max="59"
                    value={form.schedule_minute}
                    onChange={set('schedule_minute')}
                    className="w-20"
                  />
                </div>
              )}
            </div>
            {form.schedule_mode === 'custom' ? (
              <>
                <Input
                  className="mt-2"
                  value={form.cron_expr}
                  onChange={set('cron_expr')}
                  placeholder="0 3 * * *"
                  autoComplete="off"
                />
                <p className="text-[11px] text-muted-foreground">
                  Custom 5-field cron (<code>min hour dom mon dow</code>). Example:
                  <code> 0 3 * * *</code> = nightly 3am, <code>*/15 * * * *</code> = every 15 min.
                </p>
              </>
            ) : (
              <p className="text-[11px] text-muted-foreground">
                {describeCron({
                  mode: form.schedule_mode,
                  hour: Number(form.schedule_hour),
                  minute: Number(form.schedule_minute),
                  dow: Number(form.schedule_dow),
                  dom: Number(form.schedule_dom),
                })}
                {' '}— resolves to <code>{buildCron({
                  mode: form.schedule_mode,
                  hour: Number(form.schedule_hour),
                  minute: Number(form.schedule_minute),
                  dow: Number(form.schedule_dow),
                  dom: Number(form.schedule_dom),
                })}</code>
              </p>
            )}
          </div>
          <div className="space-y-1">
            <Label htmlFor="sch-keep">Retention: keep newest N</Label>
            <Input id="sch-keep" type="number" min="0" max="10000"
              value={form.retention_keep} onChange={set('retention_keep')} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="sch-days">… AND delete older than (days)</Label>
            <Input id="sch-days" type="number" min="1" max="36500"
              value={form.retention_days} onChange={set('retention_days')}
              placeholder="(no time limit)" />
          </div>
          <div className="sm:col-span-2 space-y-1">
            <Label htmlFor="sch-scope">Scope <span className="text-muted-foreground">(optional)</span></Label>
            <Input id="sch-scope" value={form.scope} onChange={set('scope')}
              placeholder="all" autoComplete="off" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="sch-pass">
              Passphrase
              {isEdit && <span className="ml-1 text-xs text-muted-foreground">(blank = keep stored)</span>}
            </Label>
            <Input id="sch-pass" type="password" autoComplete="new-password"
              value={form.passphrase} onChange={set('passphrase')} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="sch-hint">Passphrase hint <span className="text-muted-foreground">(optional)</span></Label>
            <Input id="sch-hint" value={form.passphrase_hint} onChange={set('passphrase_hint')}
              placeholder="e.g. team password manager entry name" />
          </div>
          <div className="sm:col-span-2 flex items-center gap-3">
            <Switch id="sch-enabled" checked={form.enabled} onCheckedChange={setBool('enabled')} />
            <Label htmlFor="sch-enabled" className="cursor-pointer">Enabled</Label>
          </div>
          <div className="sm:col-span-2 text-xs text-amber-700 dark:text-amber-400 border border-amber-500/30 bg-amber-500/10 rounded px-3 py-2 flex gap-2">
            <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
            <span>
              The passphrase is stored encrypted at rest (same envelope as TOTP secrets) so the
              cron worker can decrypt + run unattended.  Lose the encryption key in
              <code className="font-mono"> .env </code> and the schedule's stored passphrase becomes
              unrecoverable along with everything else encrypted by it.
            </span>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
          <Button onClick={() => onSubmit(formToBody(form, { isEdit }))} disabled={busy || !formOk}>
            {busy ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : null}
            {isEdit ? 'Save changes' : 'Create schedule'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ScheduleRow({ row, busyId, destinations, onEdit, onDelete, onRunNow }) {
  const dest = destinations.find((d) => d.id === row.destination_id);
  const busy = busyId === row.id;
  return (
    <div className="border rounded p-3 space-y-2">
      <div className="flex items-baseline gap-2 flex-wrap">
        <Timer className="h-4 w-4 text-muted-foreground" />
        <span className="font-medium">{row.name}</span>
        {!row.enabled && (
          <span className="text-[11px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">disabled</span>
        )}
        <span className="ml-auto font-mono text-xs">{row.cron_expr}</span>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-1 text-xs">
        <div className="flex justify-between">
          <span className="text-muted-foreground">Tier</span>
          <span className="font-mono">{row.tier}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">Destination</span>
          <span className="font-mono truncate" title={dest?.bucket}>{dest?.name || '?'}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">Keep</span>
          <span className="font-mono">{row.retention_keep}{row.retention_days ? ` / ${row.retention_days}d` : ''}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">Next</span>
          <span className="font-mono" title={row.next_run_at}>{fmtAge(row.next_run_at)}</span>
        </div>
      </div>
      {(row.last_run_at || row.last_run_status) && (
        <div className="text-[11px] flex items-center gap-1.5">
          <Clock className="h-3 w-3 text-muted-foreground" />
          <span>Last run: {fmtAge(row.last_run_at)}</span>
          {row.last_run_status && (
            <span className={`font-mono ${row.last_run_status === 'ok' ? 'text-emerald-600' : 'text-red-600'}`}>
              · {row.last_run_status}
            </span>
          )}
          {row.last_run_error && (
            <span className="text-red-500 truncate max-w-[20rem]" title={row.last_run_error}>
              · {row.last_run_error}
            </span>
          )}
        </div>
      )}
      <div className="flex gap-1.5 flex-wrap">
        <Button variant="outline" size="sm" onClick={() => onRunNow(row)} disabled={busy}>
          {busy ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <Play className="h-3.5 w-3.5 mr-1.5" />}
          Run now
        </Button>
        <Button variant="outline" size="sm" onClick={() => onEdit(row)} disabled={busy}>
          <Pencil className="h-3.5 w-3.5 mr-1.5" /> Edit
        </Button>
        <Button variant="destructive" size="sm" onClick={() => onDelete(row)} disabled={busy}>
          <Trash2 className="h-3.5 w-3.5 mr-1.5" /> Delete
        </Button>
      </div>
    </div>
  );
}

export default function SchedulesPanel({ destinations, onChange }) {
  const { toast } = useToast();
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [busyId, setBusyId] = useState(null);
  const [deleting, setDeleting] = useState(null);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const refresh = async () => {
    setLoading(true);
    try {
      const r = await api.backupsListSchedules();
      setItems(r.schedules || []);
    } catch (err) {
      toast({
        title: 'Could not load schedules',
        description: err instanceof ApiError ? err.message : (err?.message || 'unknown error'),
        variant: 'destructive',
      });
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { refresh(); /* eslint-disable-next-line */ }, []);

  const onCreate = () => { setEditing(null); setEditorOpen(true); };
  const onEdit = (row) => { setEditing(row); setEditorOpen(true); };

  const onSubmit = async (body) => {
    setBusy(true);
    try {
      if (editing) await api.backupsUpdateSchedule(editing.id, body);
      else await api.backupsCreateSchedule(body);
      toast({ title: editing ? 'Schedule saved' : 'Schedule created' });
      setEditorOpen(false);
      await refresh();
      onChange?.();
    } catch (err) {
      toast({
        title: editing ? 'Could not save' : 'Could not create',
        description: err instanceof ApiError ? err.message : (err?.message || 'unknown error'),
        variant: 'destructive',
      });
    } finally {
      setBusy(false);
    }
  };

  const onRunNow = async (row) => {
    setBusyId(row.id);
    try {
      const r = await api.backupsRunScheduleNow(row.id);
      toast({
        title: r.queued ? 'Schedule queued' : 'Already queued',
        description: r.queued ? 'Backup will run on the next worker tick.' : 'A run is already pending — second tick dropped to avoid duplicate work.',
      });
      onChange?.();
    } catch (err) {
      toast({
        title: 'Run-now failed',
        description: err instanceof ApiError ? err.message : (err?.message || 'unknown error'),
        variant: 'destructive',
      });
    } finally {
      setBusyId(null);
    }
  };

  const onDelete = (row) => { setDeleting(row); setDeleteOpen(true); };
  const confirmDelete = async () => {
    if (!deleting) return;
    setBusyId(deleting.id);
    try {
      await api.backupsDeleteSchedule(deleting.id);
      toast({ title: 'Schedule deleted' });
      setDeleteOpen(false); setDeleting(null);
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

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start gap-3">
          <Timer className="h-5 w-5 mt-0.5 text-muted-foreground" />
          <div className="space-y-1 flex-1">
            <CardTitle className="text-base">Schedules</CardTitle>
            <CardDescription className="text-xs">
              Cron-driven recurring backups. Passphrases stored encrypted at rest so the worker
              can run unattended. Retention prunes anything that's older than `keep` AND older
              than `days` days.
            </CardDescription>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={refresh} disabled={loading}>
              <RefreshCw className={`h-4 w-4 mr-1.5 ${loading ? 'animate-spin' : ''}`} />
              Refresh
            </Button>
            <Button size="sm" onClick={onCreate} disabled={destinations.length === 0}>
              <Plus className="h-4 w-4 mr-1.5" /> Schedule
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {items.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No schedules configured. Add one to start nightly / weekly backups.
          </p>
        ) : (
          <div className="space-y-2">
            {items.map((r) => (
              <ScheduleRow key={r.id} row={r} busyId={busyId} destinations={destinations}
                onEdit={onEdit} onDelete={onDelete} onRunNow={onRunNow} />
            ))}
          </div>
        )}
      </CardContent>

      <ScheduleDialog
        open={editorOpen}
        onOpenChange={setEditorOpen}
        initial={editing}
        destinations={destinations}
        onSubmit={onSubmit}
        busy={busy}
      />

      <Dialog open={deleteOpen} onOpenChange={(o) => { if (!o) setDeleting(null); setDeleteOpen(o); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-amber-500" /> Delete schedule
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-2 text-sm text-muted-foreground">
            <p>
              Delete <code className="font-mono text-xs text-foreground">{deleting?.name}</code>?
              The schedule's past backup artifacts in S3 are unaffected; only the recurring
              definition goes away.
            </p>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDeleteOpen(false)} disabled={busyId === deleting?.id}>Cancel</Button>
            <Button variant="destructive" onClick={confirmDelete} disabled={busyId === deleting?.id}>
              {busyId === deleting?.id ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : null}
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
