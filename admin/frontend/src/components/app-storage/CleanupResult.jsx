// Application storage → a cleanup's progress and result (DESIGN §3.2 step 8,
// §7). Polls GET /api/app-storage/cleanups/:id until the cleanup has
// finished, then shows what was removed, what was skipped and why, what
// failed, the health check, the storage now, the space reclaimed as
// measured, the settling note and "Run a new check". Rendered inside the
// review dialog (it brings its own title).

import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, Loader2, Search, XCircle, AlertTriangle } from 'lucide-react';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { BTN, DIALOG_BODY, Notice } from '@/components/storage/shared';
import { cleanupEvents, formatBytes, isCleanupFinished, reclaimedParts } from './app-storage-model.mjs';
import { TEXT } from './app-storage-text.js';
import { Figure, errorText, usePolling } from './parts.jsx';

// Paths an item was set aside under (.pp-cleanup-hold-*), never removed.
function Parked({ paths }) {
  if (!Array.isArray(paths) || !paths.length) return null;
  return (
    <div className="text-xs text-muted-foreground">
      <p>{TEXT.parkedAs}</p>
      <ul className="font-mono break-all space-y-0.5">{paths.map((p) => <li key={p}>{p}</li>)}</ul>
    </div>
  );
}

function Reclaimed({ parts }) {
  if (!parts.length || parts.every((p) => p.bytes === 0)) return TEXT.noChangeMeasured;
  if (parts.length === 1) return formatBytes(parts[0].bytes);
  return (
    <span className="block space-y-0.5 text-sm font-normal">
      {parts.map((p) => <span key={p.key} className="flex justify-between gap-3"><span className="text-muted-foreground">{TEXT.reclaimedKinds[p.key]}</span><span className="font-semibold">{formatBytes(p.bytes)}</span></span>)}
    </span>
  );
}

function List({ title, items, render, tone }) {
  if (!items?.length) return null;
  return (
    <section aria-label={title} className="border rounded-lg">
      <h3 className={`px-3 pt-3 text-sm font-medium ${tone || ''}`}>{title} ({items.length})</h3>
      <ul className="divide-y">{items.map((x, i) => <li key={x.id || i} className="p-3 text-sm space-y-0.5">{render(x)}</li>)}</ul>
    </section>
  );
}

const HEALTH_ICON = { passed: CheckCircle2, failed: XCircle };

export default function CleanupResult({ cleanupId, client = api, onRunCheck, onClose }) {
  const [cleanup, setCleanup] = useState(null);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    try {
      const c = await client.appStorage.cleanup(cleanupId);
      setCleanup(c); setError('');
      return isCleanupFinished(c?.status);
    } catch (err) {
      setError(errorText(err, TEXT.loadFailed));
      return false;
    }
  }, [client, cleanupId]);
  useEffect(() => { setCleanup(null); load(); }, [load]);
  const finished = isCleanupFinished(cleanup?.status);
  usePolling(Boolean(cleanup) && !finished, load);

  const r = cleanup?.result || {};
  const events = cleanupEvents(cleanup?.job);
  const snapshotsDeleted = (cleanup?.selection || []).some((s) => s.kind === 'snapshot' && (r.removed || []).some((x) => x.id === s.id));
  const parts = reclaimedParts(r.reclaimed, { snapshotsDeleted });
  // The settling sentence may also come in result.notes; show it once.
  const notes = (Array.isArray(r.notes) ? r.notes : []).filter((n) => !(r.reclaimed?.settling && n === TEXT.settling));
  const HealthIcon = HEALTH_ICON[r.health] || AlertTriangle;
  const remaining = r.remaining?.guest;

  return (
    <>
      <DialogHeader className="pr-8">
        <DialogTitle>{finished ? TEXT.resultTitle : TEXT.progressTitle}</DialogTitle>
        <DialogDescription>{finished ? (TEXT.resultStatus[cleanup.status] || cleanup.status) : cleanup?.status === 'queued' ? TEXT.queued : TEXT.running}</DialogDescription>
      </DialogHeader>
      <div className={DIALOG_BODY} aria-live="polite">
        {error && <Notice level="error"><p>{error}</p></Notice>}
        {!cleanup && !error && <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />{TEXT.loading}</p>}
        {cleanup && !finished && (
          <div className="space-y-1" role="status">
            <p className="flex items-center gap-2 text-sm"><Loader2 className="h-4 w-4 animate-spin shrink-0" />{cleanup.status === 'queued' ? TEXT.queued : TEXT.cleaningUpShort}</p>
            {cleanup.status !== 'queued' && events.length > 0 && <p className="text-xs text-muted-foreground break-words pl-6">{events.at(-1).message}</p>}
          </div>
        )}
        {finished && (
          <>
            {cleanup.status === 'refused' && cleanup.result?.reason && <Notice level="warn"><p>{cleanup.result.reason}</p></Notice>}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div data-testid="reclaimed"><Figure label={TEXT.reclaimed} value={<Reclaimed parts={parts} />} hint={r.estimateBytes != null ? `${TEXT.estimated}: ${formatBytes(r.estimateBytes)}` : null} /></div>
              <Figure label={TEXT.remaining} value={remaining ? TEXT.usedOfAvailable(formatBytes(remaining.usedBytes), formatBytes(remaining.availableBytes)) : '—'} />
            </div>
            {r.reclaimed?.settling && <Notice level="info"><p>{TEXT.settling}</p></Notice>}
            {notes.length > 0 && <ul className="list-disc pl-4 text-xs text-muted-foreground space-y-0.5">{notes.map((n, i) => <li key={i} className="break-words">{n}</li>)}</ul>}
            <div className={`rounded-lg border p-3 flex items-start gap-2 text-sm ${r.health === 'failed' ? 'border-red-500/40 bg-red-500/10' : ''}`} data-testid="health">
              <HealthIcon className={`h-4 w-4 mt-0.5 shrink-0 ${r.health === 'passed' ? 'text-emerald-500' : r.health === 'failed' ? 'text-red-500' : 'text-muted-foreground'}`} aria-hidden="true" />
              <div className="min-w-0"><p className="font-medium">{TEXT.health}</p><p className="break-words">{TEXT.healthText[r.health] || TEXT.healthText['not-checked']}</p></div>
            </div>
            {!r.removed?.length && <p className="text-sm text-muted-foreground">{TEXT.noneRemoved}</p>}
            <List title={TEXT.removed} items={r.removed} render={(x) => <p className="break-words"><span>{x.label}</span> <span className="text-xs text-muted-foreground">{formatBytes(x.bytes)}</span></p>} />
            <List title={TEXT.skipped} tone="text-amber-600 dark:text-amber-400" items={r.skipped} render={(x) => <><p className="break-words">{x.label}</p><p className="text-xs text-muted-foreground break-words">{x.reason}</p><Parked paths={x.parked} /></>} />
            <List title={TEXT.failed} tone="text-red-500" items={r.failed} render={(x) => <><p className="break-words">{x.label}</p><p className="text-xs text-red-500 break-words">{x.error}</p><Parked paths={x.parked} /></>} />
          </>
        )}
        {events.length > 0 && (
          <details className="rounded-lg border p-3 text-xs">
            <summary className="min-h-11 flex items-center cursor-pointer text-sm font-medium">{TEXT.recentEvents}</summary>
            <ul className="space-y-1 pt-1">{events.map((e, i) => <li key={e.id ?? `${e.at}-${i}`} className="break-words">{e.message}</li>)}</ul>
          </details>
        )}
      </div>
      <DialogFooter className="gap-2 sm:gap-0">
        <Button type="button" variant="outline" className={BTN} onClick={onClose}>{TEXT.close}</Button>
        {finished && <Button type="button" className={BTN} onClick={onRunCheck}><Search className="h-4 w-4 mr-1.5" />{TEXT.runNewCheck}</Button>}
      </DialogFooter>
    </>
  );
}
