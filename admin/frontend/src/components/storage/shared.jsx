// Storage page — small shared pieces (chips, formatting, dialog sizing,
// touch-sized checkbox) used by every tab. Field names follow
// admin/backend/src/lib/storage/{parse,freshness,policy,planner}.js.

import { useState } from 'react';
import { Check, Copy, AlertTriangle, Info } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/* ------------------------------ formatting ------------------------------ */

export function fmtBytes(n) {
  if (n == null || !Number.isFinite(Number(n))) return '—';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
  let i = 0; let v = Number(n);
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

export function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? String(iso) : d.toLocaleString();
}

/** "5 min", "3 h", "2 d" (same buckets as freshness.humanAge) or "never". */
export function fmtAge(iso, now = Date.now()) {
  if (!iso) return 'never';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return String(iso);
  const m = Math.max(0, Math.round((now - t) / 60000));
  if (m < 60) return `${m} min`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h`;
  return `${Math.round(h / 24)} d`;
}

export function fmtMs(ms) {
  if (ms == null) return '—';
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

/** Minimal shell quoting so ledger plans (argv only) can be shown as commands. */
export function shellQuote(argv) {
  return (argv || []).map((a) => (/^[A-Za-z0-9_@%+=:,./{}-]+$/.test(a) ? a : `'${String(a).replace(/'/g, "'\\''")}'`)).join(' ');
}

export const OP_LABELS = {
  create_zpool: 'Create pool', set_managed_pool: 'Set managed pool', create_dataset: 'Create dataset',
  set_dataset_props: 'Set dataset properties', destroy_dataset: 'Destroy dataset', zfs_snapshot: 'Snapshot',
  zfs_rollback: 'Roll back', destroy_zfs_snapshot: 'Destroy snapshot', replace_disk: 'Replace disk', zpool_scrub: 'Scrub',
  import_pool: 'Import pool', export_pool: 'Export pool', set_incus_storage_pool: 'Set Incus storage pool',
  move_guest_storage: 'Move guests', restore_guest_from_snapshot: 'Restore as new guest', rollback_guest_dataset: 'Roll back guest',
  set_backup_policy: 'Backup policy', set_replication_target: 'Replication job', run_replication: 'Run replication',
};
export const opLabel = (op) => OP_LABELS[op] || op;

/* --------------------------------- chips -------------------------------- */

const LEVEL_CLASS = {
  ok: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/40',
  warn: 'bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/40',
  fail: 'bg-red-500/15 text-red-600 dark:text-red-400 border-red-500/40',
  info: 'bg-cyan-500/15 text-cyan-600 dark:text-cyan-400 border-cyan-500/40',
  accent: 'bg-purple-500/15 text-purple-600 dark:text-purple-400 border-purple-500/40',
  muted: 'bg-muted text-muted-foreground border-border',
};

export function Chip({ level = 'muted', children, title, className, mono = false }) {
  return (
    <span
      title={title}
      className={cn('inline-flex items-center gap-1 text-[11px] leading-none px-1.5 py-1 rounded border whitespace-nowrap max-w-full overflow-hidden text-ellipsis', mono && 'font-mono', LEVEL_CLASS[level] || LEVEL_CLASS.muted, className)}
    >
      {children}
    </span>
  );
}

const POOL_HEALTH_LEVEL = { ONLINE: 'ok', DEGRADED: 'warn', FAULTED: 'fail', UNAVAIL: 'fail', REMOVED: 'fail', SUSPENDED: 'fail', OFFLINE: 'warn' };
export function HealthChip({ health, title }) {
  const h = String(health || 'UNKNOWN').toUpperCase();
  return <Chip level={POOL_HEALTH_LEVEL[h] || 'muted'} title={title}>{h}</Chip>;
}

const STATUS_LEVEL = { ok: 'ok', running: 'info', stale: 'warn', overdue: 'warn', never: 'warn', none: 'warn', failed: 'fail', disabled: 'muted', unmanaged: 'muted', not_configured: 'muted' };
const STATUS_LABEL = { not_configured: 'no policy' };
export function StatusChip({ status, title }) {
  return <Chip level={STATUS_LEVEL[status] || 'muted'} title={title || (status === 'not_configured' ? 'no backup policy has been applied yet — nothing is expected' : undefined)}>{STATUS_LABEL[status] || status || '—'}</Chip>;
}

const SMART_LEVEL = { ok: 'ok', warn: 'warn', fail: 'fail', unknown: 'muted' };
export function SmartChip({ verdict }) {
  const level = verdict?.level || 'unknown';
  return <Chip level={SMART_LEVEL[level]} title={verdict?.reason || 'no SMART data'}>SMART {level}</Chip>;
}

export function OutcomeChip({ outcome }) {
  return <Chip level={outcome === 'ok' ? 'ok' : outcome === 'refused' ? 'warn' : 'fail'}>{outcome}</Chip>;
}

const KIND_LEVEL = { sanoid: 'info', syncoid: 'accent', incus: 'ok', proxypilot: 'warn', manual: 'muted' };
export function KindChip({ kind }) {
  return <Chip level={KIND_LEVEL[kind] || 'muted'}>{kind}</Chip>;
}

/* -------------------------------- layout -------------------------------- */

// MOBILE_FIRST.md §3: bigger-than-two-field dialogs are full-screen under sm.
export const DIALOG_LG = 'max-w-full h-full rounded-none sm:max-w-3xl sm:h-auto sm:max-h-[90vh] sm:rounded-lg flex flex-col';
export const DIALOG_SM = 'max-w-full h-full rounded-none sm:max-w-md sm:h-auto sm:max-h-[90vh] sm:rounded-lg flex flex-col';
// Scrollable body inside a flex-col dialog.
export const DIALOG_BODY = 'flex-1 min-h-0 overflow-y-auto space-y-4 pr-1';
// Primary/secondary buttons hit 44px on phones, 36px on desktop (§5).
export const BTN = 'h-11 sm:h-9';

export function KV({ label, children, mono = true, className }) {
  return (
    <div className={cn('flex items-baseline justify-between gap-3 text-sm min-w-0', className)}>
      <span className="text-muted-foreground shrink-0">{label}</span>
      <span className={cn('text-right truncate', mono && 'font-mono text-xs')}>{children ?? '—'}</span>
    </div>
  );
}

export function CapacityBar({ pct, className }) {
  const p = pct == null ? null : Math.max(0, Math.min(100, Number(pct)));
  const tone = p == null ? 'bg-muted-foreground/40' : p >= 90 ? 'bg-red-500' : p >= 80 ? 'bg-amber-500' : 'bg-emerald-500';
  return (
    <div className={cn('flex items-center gap-2', className)} title={p == null ? 'capacity unknown' : `${p}% used`}>
      <div className="h-2 flex-1 rounded bg-muted overflow-hidden">
        <div className={cn('h-full rounded', tone)} style={{ width: `${p ?? 0}%` }} />
      </div>
      <span className="text-xs font-mono w-10 text-right">{p == null ? '—' : `${p}%`}</span>
    </div>
  );
}

export function Notice({ level = 'info', children, className }) {
  const cls = level === 'error' ? 'text-red-500 border-red-500/30 bg-red-500/10'
    : level === 'warn' ? 'text-amber-500 border-amber-500/30 bg-amber-500/10'
      : 'text-muted-foreground border-border bg-muted/40';
  const Icon = level === 'info' ? Info : AlertTriangle;
  return (
    <div className={cn('text-sm border rounded px-3 py-2 flex gap-2 items-start break-words', cls, className)}>
      <Icon className="h-4 w-4 mt-0.5 shrink-0" />
      <div className="min-w-0 flex-1 space-y-1">{children}</div>
    </div>
  );
}

export function EmptyState({ icon: Icon, title, hint, action }) {
  return (
    <div className="border border-dashed rounded-lg p-6 sm:p-8 text-center space-y-2">
      {Icon && <Icon className="h-6 w-6 mx-auto text-muted-foreground" />}
      <p className="text-sm font-medium">{title}</p>
      {hint && <p className="text-xs text-muted-foreground max-w-md mx-auto">{hint}</p>}
      {action && <div className="pt-2 flex justify-center">{action}</div>}
    </div>
  );
}

/** Native checkbox wrapped in a 44px-tall label so it is tappable on phones. */
export function Checkbox({ checked, onChange, label, hint, disabled, className, title }) {
  return (
    <label title={title} className={cn('flex items-start gap-3 min-h-[44px] py-2 cursor-pointer select-none', disabled && 'opacity-60 cursor-not-allowed', className)}>
      <input
        type="checkbox"
        className="mt-0.5 h-5 w-5 shrink-0 accent-primary"
        checked={!!checked}
        disabled={disabled}
        onChange={(e) => onChange?.(e.target.checked)}
      />
      <span className="min-w-0 text-sm leading-tight">
        <span className="block break-words">{label}</span>
        {hint && <span className="block text-xs text-muted-foreground mt-0.5 break-words">{hint}</span>}
      </span>
    </label>
  );
}

export function CopyButton({ text, label = 'Copy', className, size = 'sm' }) {
  const [done, setDone] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(text); setDone(true); setTimeout(() => setDone(false), 1500); } catch { /* clipboard unavailable */ }
  };
  return (
    <Button type="button" variant="ghost" size={size} className={cn('h-9', className)} onClick={copy} title={label}>
      {done ? <Check className="h-4 w-4 text-emerald-500" /> : <Copy className="h-4 w-4" />}
      <span className="ml-1.5 hidden sm:inline">{done ? 'Copied' : label}</span>
    </Button>
  );
}

/** Section header used inside tabs: title left, actions right, stacking on phones. */
export function SectionHeader({ title, description, children }) {
  return (
    <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
      <div className="min-w-0">
        <h2 className="text-base font-semibold">{title}</h2>
        {description && <p className="text-xs text-muted-foreground max-w-2xl">{description}</p>}
      </div>
      {children && <div className="flex gap-2 flex-wrap">{children}</div>}
    </div>
  );
}

/** Dataset ↔ guest mapping from overview.incus.instances (dataset set for guests on a ZFS-backed Incus pool). */
export function guestForDataset(instances, dataset) {
  return (instances || []).find((i) => i.dataset && i.dataset === dataset) || null;
}
