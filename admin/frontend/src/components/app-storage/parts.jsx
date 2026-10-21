// Application storage — small shared pieces (status chips, figure tiles, a
// polling hook). Words come from app-storage-text.js; layout helpers (Chip,
// BTN, DIALOG_*) are the Storage page's own (components/storage/shared.jsx).

import { useEffect, useRef } from 'react';
import { Chip } from '@/components/storage/shared';
import { cn } from '@/lib/utils';
import { CATEGORY_STATUS_LABELS, RULE_STATE_LABELS, STATUS_LABELS } from './app-storage-text.js';

const ITEM_LEVEL = { protected: 'ok', eligible: 'info', investigate: 'warn' };
const CATEGORY_LEVEL = { protected: 'ok', eligible: 'info', mixed: 'info', investigate: 'warn', empty: 'muted' };
const RULE_LEVEL = { on: 'ok', proposed: 'warn', off: 'muted' };

export function ItemStatusChip({ status }) {
  return <Chip level={ITEM_LEVEL[status] || 'muted'}>{STATUS_LABELS[status] || status}</Chip>;
}

export function CategoryStatusChip({ status }) {
  return <Chip level={CATEGORY_LEVEL[status] || 'muted'}>{CATEGORY_STATUS_LABELS[status] || status}</Chip>;
}

export function RuleStateChip({ state }) {
  return <Chip level={RULE_LEVEL[state] || 'muted'}>{RULE_STATE_LABELS[state] || state}</Chip>;
}

/** A label/value tile for the header figures. */
export function Figure({ label, value, hint, className }) {
  // Phones: one compact "label … value" line; sm and up: a tile.
  return (
    <div className={cn('min-w-0 rounded-lg border px-3 py-2 sm:p-3', className)}>
      <div className="flex items-baseline justify-between gap-3 sm:block">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="sm:mt-1 text-sm sm:text-base font-semibold break-words text-right sm:text-left">{value}</p>
      </div>
      {hint && <div className="mt-1 text-xs text-muted-foreground break-words">{hint}</div>}
    </div>
  );
}

/**
 * Call `tick` every `intervalMs` while `active`; `tick` returns true when the
 * polling is done. The latest `tick` is always used (no stale closures).
 */
export function usePolling(active, tick, intervalMs = 2000) {
  const ref = useRef(tick);
  ref.current = tick;
  useEffect(() => {
    if (!active) return undefined;
    let stopped = false;
    let timer = null;
    const run = async () => {
      if (stopped) return;
      let done = false;
      try { done = await ref.current(); } catch { /* keep polling; the next tick retries */ }
      if (!stopped && !done) timer = setTimeout(run, intervalMs);
    };
    timer = setTimeout(run, intervalMs);
    return () => { stopped = true; clearTimeout(timer); };
  }, [active, intervalMs]);
}

export const errorText = (err, fallback) => (err && err.message) || fallback;
