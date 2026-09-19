// Migrations — the small shared pieces. The chips, dialog sizing and
// formatting come from the Storage page's shared module rather than being
// re-invented here: the two pages sit next to each other in the sidebar and
// must not look like different products.

import { Chip, fmtBytes } from '@/components/storage/shared';

export { Chip, KV, Notice, EmptyState, CopyButton, SectionHeader, Checkbox, DIALOG_LG, DIALOG_SM, DIALOG_BODY, BTN, fmtBytes, fmtDate, fmtAge } from '@/components/storage/shared';

const STATUS_LEVEL = {
  created: 'info', running: 'info', awaiting_review: 'warn', ready: 'accent',
  completed: 'ok', failed: 'fail', cancelled: 'muted',
};
const STATUS_LABEL = { awaiting_review: 'review the inventory', ready: 'cutover' };

export function MigrationStatus({ status, title }) {
  return <Chip level={STATUS_LEVEL[status] || 'muted'} title={title}>{STATUS_LABEL[status] || status}</Chip>;
}

export function fmtRate(bps) {
  if (!bps) return '—';
  return `${fmtBytes(bps)}/s`;
}

export function fmtEta(seconds) {
  if (seconds == null) return '—';
  if (seconds < 90) return `${Math.round(seconds)} s`;
  const m = Math.round(seconds / 60);
  if (m < 90) return `${m} min`;
  const h = Math.floor(m / 60);
  return `${h} h ${m % 60} min`;
}

/**
 * The five phases as a rail. On a phone it wraps rather than scrolling
 * sideways — a progress indicator you have to scroll to read is not one.
 */
export function PhaseRail({ phases = [] }) {
  const tone = { done: 'ok', active: 'info', waiting: 'warn', failed: 'fail', pending: 'muted' };
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {phases.map((p, i) => (
        <span key={p.id} className="flex items-center gap-1.5">
          {i > 0 && <span className="text-muted-foreground text-xs" aria-hidden="true">›</span>}
          <Chip level={tone[p.state] || 'muted'} title={p.detail}>{p.title}</Chip>
        </span>
      ))}
    </div>
  );
}

/** A progress bar with the numbers spelled out, because a bar alone hides a stall. */
export function TransferBar({ progress }) {
  if (!progress || (!progress.bytes && progress.percent == null)) return null;
  const pct = progress.percent;
  return (
    <div className="space-y-1">
      <div className="h-2 rounded bg-muted overflow-hidden">
        <div
          className={progress.stalled ? 'h-full bg-amber-500' : 'h-full bg-emerald-500'}
          style={{ width: `${pct == null ? 100 : Math.max(2, Math.min(100, pct))}%`, opacity: pct == null ? 0.35 : 1 }}
        />
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground font-mono">
        <span>{fmtBytes(progress.bytes)}{progress.total_bytes ? ` / ${fmtBytes(progress.total_bytes)}` : ''}</span>
        {pct != null && <span>{pct}%</span>}
        <span>{fmtRate(progress.rate_bps)}</span>
        {progress.eta_seconds != null && <span>ETA {fmtEta(progress.eta_seconds)}</span>}
        {progress.stalled && <span className="text-amber-500">no new bytes for two minutes</span>}
      </div>
    </div>
  );
}
