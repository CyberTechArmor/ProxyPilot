// Storage → Backup & replication: the sanoid retention classes and overrides
// (policy.js), per-guest freshness (freshness.guests) and syncoid replication
// jobs (service.replicationStatus + freshness.replication). Edits go through
// set_backup_policy / set_replication_target / run_replication plans.

import { useEffect, useMemo, useState } from 'react';
import { Archive, Pencil, Play, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { BTN, Checkbox, Chip, DIALOG_BODY, DIALOG_LG, EmptyState, KV, Notice, SectionHeader, StatusChip, fmtAge, fmtDate } from './shared';

const RETENTION_KEYS = ['frequent', 'hourly', 'daily', 'monthly'];
const CLASS_HINT = { guests: 'Incus guest datasets under <pool>/incus', backups: '<pool>/backups', exports: '<pool>/exports' };
// policy.js SCHEDULES — the stored form is the calendar expression.
const SCHEDULES = { hourly: 'hourly', daily: '*-*-* 02:30:00', weekly: 'Sun *-*-* 03:00:00' };
const scheduleKey = (s) => Object.entries(SCHEDULES).find(([, v]) => v === s)?.[0] || (s ? 'custom' : 'hourly');
const isRemote = (t) => /^([A-Za-z0-9._-]+@)?(\[[0-9a-fA-F:.]+\]|[A-Za-z0-9._-]+):/.test(String(t || ''));

function RetentionFields({ value, onChange, allowBlank = false }) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-4 gap-2">
      {RETENTION_KEYS.map((k) => (
        <div key={k} className="space-y-1">
          <Label htmlFor={`ret-${k}`} className="text-xs capitalize">{k}{k === 'frequent' ? ' (15 min)' : ''}</Label>
          <Input id={`ret-${k}`} inputMode="numeric" value={value[k] ?? ''} placeholder={allowBlank ? 'inherit' : '0'} onChange={(e) => onChange({ ...value, [k]: e.target.value })} />
        </div>
      ))}
    </div>
  );
}
function cleanRetention(v, { allowBlank = false } = {}) {
  const out = {}; let any = false;
  for (const k of RETENTION_KEYS) {
    const raw = v[k];
    if (raw === '' || raw == null) { if (allowBlank) continue; return { error: `${k} is required` }; }
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0 || n > 10000) return { error: `${k}: integer 0–10000` };
    out[k] = n; any = true;
  }
  return { retention: any ? out : null };
}

function ClassCard({ cls, retention, disabled, onPlan }) {
  const [v, setV] = useState(() => Object.fromEntries(RETENTION_KEYS.map((k) => [k, String(retention?.[k] ?? 0)])));
  useEffect(() => { setV(Object.fromEntries(RETENTION_KEYS.map((k) => [k, String(retention?.[k] ?? 0)]))); }, [retention]);
  const c = cleanRetention(v);
  const dirty = RETENTION_KEYS.some((k) => String(retention?.[k] ?? 0) !== String(v[k]));
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base capitalize">{cls}</CardTitle>
        <CardDescription className="text-xs">{CLASS_HINT[cls]} — how many snapshots of each period sanoid keeps (0 disables the period).</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <RetentionFields value={v} onChange={setV} />
        {c.error && <p className="text-xs text-red-500">{c.error}</p>}
        <Button size="sm" className={BTN} disabled={disabled || !dirty || !!c.error} onClick={() => onPlan({ op: 'set_backup_policy', params: { class: cls, retention: c.retention }, title: `Retention for class ${cls}` })}>Save class</Button>
      </CardContent>
    </Card>
  );
}

function OverrideDialog({ initial, guests, datasets, onClose, onPlan }) {
  const [type, setType] = useState(initial?.type || 'guest');
  const [target, setTarget] = useState(initial?.name || '');
  const [enabled, setEnabled] = useState(initial?.enabled !== false);
  const [cls, setCls] = useState(initial?.class || 'inherit');
  const [ret, setRet] = useState(() => Object.fromEntries(RETENTION_KEYS.map((k) => [k, initial?.retention?.[k] != null ? String(initial.retention[k]) : ''])));
  const c = cleanRetention(ret, { allowBlank: true });
  const ok = target && !c.error;
  const submit = () => {
    const params = type === 'guest'
      ? { guest: target, enabled, retention: c.retention }
      : { dataset: target, class: cls === 'inherit' ? null : cls, enabled, retention: c.retention };
    onPlan({ op: 'set_backup_policy', params, title: `Policy override for ${target}` });
    onClose();
  };
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className={DIALOG_LG}>
        <DialogHeader><DialogTitle>{initial ? 'Edit' : 'Add'} policy override</DialogTitle><DialogDescription className="text-left">Per-guest or per-dataset exceptions to the class retention. Blank retention fields inherit the class.</DialogDescription></DialogHeader>
        <div className={DIALOG_BODY}>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label>Applies to</Label>
              <Select value={type} onValueChange={(v) => { setType(v); setTarget(''); }} disabled={!!initial}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="guest">Guest</SelectItem><SelectItem value="dataset">Dataset</SelectItem></SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>{type === 'guest' ? 'Guest' : 'Dataset'}</Label>
              <Select value={target} onValueChange={setTarget} disabled={!!initial}>
                <SelectTrigger><SelectValue placeholder={type === 'guest' ? 'guest on a ZFS pool' : 'dataset'} /></SelectTrigger>
                <SelectContent>
                  {(type === 'guest' ? guests.map((g) => g.name) : datasets.map((d) => d.name)).map((n) => <SelectItem key={n} value={n}>{n}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            {type === 'dataset' && (
              <div className="space-y-1">
                <Label>Class</Label>
                <Select value={cls} onValueChange={setCls}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent><SelectItem value="inherit">inherit from location</SelectItem><SelectItem value="guests">guests</SelectItem><SelectItem value="backups">backups</SelectItem><SelectItem value="exports">exports</SelectItem></SelectContent>
                </Select>
              </div>
            )}
          </div>
          <Checkbox checked={enabled} onChange={setEnabled} label="Snapshots enabled" hint="Off = sanoid neither takes nor prunes snapshots here." />
          <div className="space-y-1"><Label>Retention override</Label><RetentionFields value={ret} onChange={setRet} allowBlank /></div>
          {c.error && <p className="text-xs text-red-500">{c.error}</p>}
        </div>
        <DialogFooter className="gap-2 pt-2 border-t">
          <Button type="button" variant="ghost" className={BTN} onClick={onClose}>Cancel</Button>
          <Button type="button" className={BTN} disabled={!ok} onClick={submit}>Review plan</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function JobDialog({ initial, datasets, onClose, onPlan }) {
  const [name, setName] = useState(initial?.name || '');
  const [sources, setSources] = useState(() => new Set(initial?.sources || []));
  const [filter, setFilter] = useState('');
  const [target, setTarget] = useState(initial?.target || '');
  const [sshKey, setSshKey] = useState('');
  const [sshPort, setSshPort] = useState(initial?.ssh_port ? String(initial.ssh_port) : '');
  const [schedule, setSchedule] = useState(() => scheduleKey(initial?.schedule));
  const [custom, setCustom] = useState(() => (scheduleKey(initial?.schedule) === 'custom' ? initial.schedule : ''));
  const [recursive, setRecursive] = useState(initial?.recursive !== false);
  const [enabled, setEnabled] = useState(initial?.enabled !== false);
  const remote = isRemote(target);
  const problems = [];
  if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(name)) problems.push('Name: lowercase letters, digits, hyphens.');
  if (!sources.size) problems.push('Pick at least one source dataset.');
  if (!target) problems.push('Target: pool/dataset (local) or [user@]host:pool/dataset (SSH).');
  if (remote && !/^\/\S+$/.test(sshKey)) problems.push('SSH key: absolute path on the host.');
  if (sshPort && !(Number.isInteger(Number(sshPort)) && Number(sshPort) > 0 && Number(sshPort) < 65536)) problems.push('SSH port: 1–65535.');
  if (schedule === 'custom' && !/^[A-Za-z0-9 *:,./-]{1,80}$/.test(custom)) problems.push('Custom schedule: a systemd OnCalendar expression.');
  const toggle = (n) => setSources((s) => { const x = new Set(s); if (x.has(n)) x.delete(n); else x.add(n); return x; });
  const submit = () => {
    const params = { name, sources: [...sources], target, schedule: schedule === 'custom' ? custom : schedule, recursive, enabled };
    if (remote) { params.ssh_key_path = sshKey; if (sshPort) params.ssh_port = Number(sshPort); }
    onPlan({ op: 'set_replication_target', params, title: `${initial ? 'Update' : 'Create'} replication job ${name}` });
    onClose();
  };
  const shown = datasets.filter((d) => !filter || d.name.toLowerCase().includes(filter.toLowerCase()));
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className={DIALOG_LG}>
        <DialogHeader><DialogTitle>{initial ? `Edit job ${initial.name}` : 'Add replication job'}</DialogTitle><DialogDescription className="text-left">syncoid on a systemd timer: sources → target, incremental after the first run.</DialogDescription></DialogHeader>
        <div className={DIALOG_BODY}>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label htmlFor="rj-name">Name</Label>
              <Input id="rj-name" value={name} onChange={(e) => setName(e.target.value.trim().toLowerCase())} disabled={!!initial} className="font-mono" autoComplete="off" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="rj-target">Target</Label>
              <Input id="rj-target" value={target} onChange={(e) => setTarget(e.target.value.trim())} className="font-mono" placeholder="backup/from-host or root@nas:tank/replica" autoComplete="off" />
            </div>
            {remote && (
              <>
                <div className="space-y-1">
                  <Label htmlFor="rj-key">SSH private key path (on the host)</Label>
                  <Input id="rj-key" value={sshKey} onChange={(e) => setSshKey(e.target.value.trim())} className="font-mono" placeholder="/root/.ssh/replication_ed25519" />
                  <p className="text-xs text-muted-foreground">Never read or stored by ProxyPilot{initial ? ' — re-enter it when editing' : ''}.</p>
                </div>
                <div className="space-y-1">
                  <Label htmlFor="rj-port">SSH port</Label>
                  <Input id="rj-port" inputMode="numeric" value={sshPort} onChange={(e) => setSshPort(e.target.value.trim())} placeholder="22" />
                </div>
              </>
            )}
            <div className="space-y-1">
              <Label>Schedule</Label>
              <Select value={schedule} onValueChange={setSchedule}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="hourly">hourly</SelectItem><SelectItem value="daily">daily (02:30)</SelectItem><SelectItem value="weekly">weekly (Sun 03:00)</SelectItem><SelectItem value="custom">custom OnCalendar</SelectItem></SelectContent>
              </Select>
            </div>
            {schedule === 'custom' && (
              <div className="space-y-1">
                <Label htmlFor="rj-cal">OnCalendar</Label>
                <Input id="rj-cal" value={custom} onChange={(e) => setCustom(e.target.value)} className="font-mono" placeholder="*-*-* 04:00:00" />
              </div>
            )}
          </div>
          <div className="space-y-1">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
              <Label>Sources ({sources.size} selected)</Label>
              <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter datasets" className="w-full sm:w-56 h-9" />
            </div>
            <div className="border rounded max-h-56 overflow-y-auto divide-y">
              {shown.map((d) => <Checkbox key={d.name} className="px-3 min-h-[40px] py-1" checked={sources.has(d.name)} onChange={() => toggle(d.name)} label={<span className="font-mono text-xs break-all">{d.name}</span>} />)}
              {!shown.length && <p className="p-3 text-xs text-muted-foreground">No dataset matches.</p>}
            </div>
          </div>
          <Checkbox checked={recursive} onChange={setRecursive} label="Recursive (children of each source too)" />
          <Checkbox checked={enabled} onChange={setEnabled} label="Enabled (timer active)" />
          {problems.length > 0 && <Notice level="warn">{problems.map((p, i) => <p key={i}>{p}</p>)}</Notice>}
        </div>
        <DialogFooter className="gap-2 pt-2 border-t">
          <Button type="button" variant="ghost" className={BTN} onClick={onClose}>Cancel</Button>
          <Button type="button" className={BTN} disabled={problems.length > 0} onClick={submit}>Review plan</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function JobCard({ job, onPlan, onEdit }) {
  const [showLog, setShowLog] = useState(false);
  return (
    <Card>
      <CardContent className="p-4 space-y-2">
        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono font-medium">{job.name}</span>
              <StatusChip status={job.status} />
              <Chip>{job.kind}</Chip>
              {job.running && <Chip level="info">running</Chip>}
              {job.timer?.present === false && <Chip level="warn" title="proxypilot-syncoid@.timer unit missing on the host">timer missing</Chip>}
            </div>
            <p className="text-xs font-mono break-all">{(job.sources || []).join(', ')} → {job.target}</p>
          </div>
          <div className="flex gap-1 flex-wrap">
            <Button variant="outline" size="sm" className={BTN} onClick={() => onPlan({ op: 'run_replication', params: { name: job.name, wait: false }, title: `Run replication ${job.name}` })} disabled={job.running}><Play className="h-4 w-4 mr-1.5" />Run now</Button>
            <Button variant="ghost" size="sm" className={BTN} onClick={() => onEdit(job)}><Pencil className="h-4 w-4 mr-1.5" />Edit</Button>
            <Button variant="ghost" size="sm" className={`${BTN} text-red-500 hover:text-red-600`} onClick={() => onPlan({ op: 'set_replication_target', params: { name: job.name, remove: true }, title: `Remove replication job ${job.name}` })}><Trash2 className="h-4 w-4 mr-1.5" />Remove</Button>
          </div>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-0.5">
          <KV label="Schedule">{job.schedule}</KV>
          <KV label="Timer">{job.timer?.active || '—'}{job.timer?.enabled ? ` / ${job.timer.enabled}` : ''}</KV>
          <KV label="Next run">{job.timer?.next_run || '—'}</KV>
          <KV label="Last success" mono={false}>{job.last_success_at ? `${fmtAge(job.last_success_at)} ago` : 'never'}</KV>
          <KV label="Last run" mono={false}>{job.last_run_at ? fmtDate(job.last_run_at) : '—'}</KV>
          <KV label="Exit code">{job.last_exit_code ?? '—'}</KV>
        </div>
        {job.last_error && <Notice level="error"><p className="break-words">{job.last_error}</p></Notice>}
        {job.log_tail && (
          <div>
            <button type="button" className="text-xs underline text-muted-foreground min-h-[32px]" onClick={() => setShowLog((s) => !s)}>{showLog ? 'Hide' : 'Show'} log tail</button>
            {showLog && <pre className="mt-1 text-xs font-mono bg-muted rounded p-2 overflow-x-auto whitespace-pre-wrap break-all max-h-64">{job.log_tail}</pre>}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default function BackupTab({ data, onPlan }) {
  const policy = data?.policy?.policy || { classes: {}, datasets: {}, guests: {} };
  const managed = data?.managed || null;
  const guestsFresh = data?.freshness?.guests || [];
  const jobs = data?.replication || data?.freshness?.replication || [];
  const datasets = useMemo(() => (data?.datasets || []).filter((d) => d.type !== 'snapshot'), [data]);
  const guestsOnZfs = useMemo(() => (data?.incus?.instances || []).filter((i) => i.dataset), [data]);
  const sanoidTimer = data?.toolchain?.sanoid_timer;
  const [override, setOverride] = useState(null); // { initial } | null
  const [job, setJob] = useState(null); // { initial } | null
  const overrides = [
    ...Object.entries(policy.guests || {}).map(([name, v]) => ({ type: 'guest', name, ...v })),
    ...Object.entries(policy.datasets || {}).map(([name, v]) => ({ type: 'dataset', name, ...v })),
  ];
  const retStr = (r) => (r ? RETENTION_KEYS.filter((k) => r[k] != null).map((k) => `${k[0]}=${r[k]}`).join(' ') : 'inherit');

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <SectionHeader title="Backup policy (sanoid)" description="Retention per class; written to /etc/sanoid/sanoid.conf and sanoid.timer is enabled on save.">
          <div className="flex items-center gap-2 text-xs">
            <span className="text-muted-foreground">sanoid.timer</span>
            <Chip level={sanoidTimer?.ActiveState === 'active' ? 'ok' : sanoidTimer?.present ? 'warn' : 'muted'}>{sanoidTimer?.ActiveState || (sanoidTimer?.present === false ? 'not installed' : 'unknown')}</Chip>
          </div>
        </SectionHeader>
        {!managed && <Notice level="warn"><p>No managed pool yet — the policy can be edited once a pool is managed (Devices → Create pool, or Pools → Set as managed pool).</p></Notice>}
        {data?.toolchain?.sanoid === false && <Notice level="warn"><p>sanoid is not installed on the host — run scripts/install-storage.sh.</p></Notice>}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {['guests', 'backups', 'exports'].map((cls) => <ClassCard key={cls} cls={cls} retention={policy.classes?.[cls]} disabled={!managed} onPlan={onPlan} />)}
        </div>
      </section>

      <section className="space-y-3">
        <SectionHeader title="Overrides" description="Per-guest and per-dataset exceptions.">
          <Button variant="outline" size="sm" className={BTN} disabled={!managed} onClick={() => setOverride({ initial: null })}><Plus className="h-4 w-4 mr-1.5" />Add override</Button>
        </SectionHeader>
        {!overrides.length ? <p className="text-xs text-muted-foreground">No overrides — every dataset follows its class.</p> : (
          <div className="space-y-2">
            {overrides.map((o) => (
              <div key={`${o.type}:${o.name}`} className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 p-3 border rounded-lg">
                <div className="min-w-0 flex-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                  <Chip>{o.type}</Chip>
                  <span className="font-mono break-all">{o.name}</span>
                  {o.class && <Chip level="info">{o.class}</Chip>}
                  <Chip level={o.enabled === false ? 'warn' : 'ok'}>{o.enabled === false ? 'disabled' : 'enabled'}</Chip>
                  <span className="text-xs font-mono text-muted-foreground">{retStr(o.retention)}</span>
                </div>
                <Button variant="ghost" size="sm" className={BTN} onClick={() => setOverride({ initial: o })}><Pencil className="h-4 w-4 mr-1.5" />Edit</Button>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="space-y-3">
        <SectionHeader title="Guest freshness" description="Last snapshot and last replication per Incus guest." />
        {!guestsFresh.length ? <EmptyState icon={Archive} title="No Incus guests" /> : (
          <>
            <div className="hidden md:block border rounded-lg overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-xs text-muted-foreground">
                  <tr><th className="text-left font-medium p-2">Guest</th><th className="text-left font-medium p-2">State</th><th className="text-left font-medium p-2">Pool</th><th className="text-left font-medium p-2">Last snapshot</th><th className="text-left font-medium p-2">Last replication</th></tr>
                </thead>
                <tbody className="divide-y">
                  {guestsFresh.map((g) => (
                    <tr key={g.name}>
                      <td className="p-2 font-mono text-xs">{g.name}<div className="text-muted-foreground">{g.type}</div></td>
                      <td className="p-2 text-xs">{g.status || '—'}</td>
                      <td className="p-2 text-xs font-mono">{g.pool || '—'}{!g.on_managed_pool && <div><Chip level="muted">not on ZFS</Chip></div>}</td>
                      <td className="p-2 text-xs"><span className="inline-flex items-center gap-2"><StatusChip status={g.snapshot_status} />{g.last_snapshot_at ? `${g.snapshot_age} ago` : 'never'}</span></td>
                      <td className="p-2 text-xs"><span className="inline-flex items-center gap-2 flex-wrap"><StatusChip status={g.replication_status} />{g.last_replication_at ? `${g.replication_age} ago` : g.replication_status === 'none' ? 'no job' : 'never'}{g.replicated_by?.length > 0 && <span className="font-mono text-muted-foreground">{g.replicated_by.join(', ')}</span>}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="md:hidden space-y-2">
              {guestsFresh.map((g) => (
                <div key={g.name} className="p-3 border rounded-lg space-y-1">
                  <div className="flex flex-wrap items-center gap-2"><span className="font-mono text-sm">{g.name}</span><Chip>{g.status || '—'}</Chip>{!g.on_managed_pool && <Chip>not on ZFS</Chip>}</div>
                  <div className="flex flex-wrap items-center gap-2 text-xs"><span className="text-muted-foreground">snapshot</span><StatusChip status={g.snapshot_status} />{g.last_snapshot_at ? `${g.snapshot_age} ago` : 'never'}</div>
                  <div className="flex flex-wrap items-center gap-2 text-xs"><span className="text-muted-foreground">replication</span><StatusChip status={g.replication_status} />{g.last_replication_at ? `${g.replication_age} ago` : g.replication_status === 'none' ? 'no job' : 'never'}</div>
                </div>
              ))}
            </div>
          </>
        )}
      </section>

      <section className="space-y-3">
        <SectionHeader title="Replication (syncoid)" description="Each job is a proxypilot-syncoid@<name>.timer with its own schedule.">
          <Button variant="outline" size="sm" className={BTN} disabled={!datasets.length} onClick={() => setJob({ initial: null })}><Plus className="h-4 w-4 mr-1.5" />Add job</Button>
        </SectionHeader>
        {data?.toolchain?.syncoid === false && <Notice level="warn"><p>syncoid is not installed on the host — run scripts/install-storage.sh.</p></Notice>}
        {!jobs.length ? <p className="text-xs text-muted-foreground">No replication jobs yet.</p> : (
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">{jobs.map((j) => <JobCard key={j.name} job={j} onPlan={onPlan} onEdit={(x) => setJob({ initial: x })} />)}</div>
        )}
      </section>

      {data?.policy?.rendered && (
        <details className="text-xs">
          <summary className="cursor-pointer text-muted-foreground min-h-[32px] flex items-center">Rendered {data.policy.sanoid_conf || 'sanoid.conf'}</summary>
          <pre className="mt-2 font-mono bg-muted rounded p-2 overflow-x-auto whitespace-pre-wrap break-all max-h-96">{data.policy.rendered}</pre>
        </details>
      )}

      {override && <OverrideDialog initial={override.initial} guests={guestsOnZfs} datasets={datasets} onClose={() => setOverride(null)} onPlan={onPlan} />}
      {job && <JobDialog initial={job.initial} datasets={datasets} onClose={() => setJob(null)} onPlan={onPlan} />}
    </div>
  );
}
