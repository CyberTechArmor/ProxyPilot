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
import { formatBytes, isCleanupFinished } from './app-storage-model.mjs';
import { TEXT } from './app-storage-text.js';
import { Figure, errorText, usePolling } from './parts.jsx';

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
  const events = cleanup?.job?.events || [];
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
          <div className="flex items-center gap-2 text-sm" role="status"><Loader2 className="h-4 w-4 animate-spin" />{cleanup.status === 'queued' ? TEXT.queued : TEXT.cleaningUpShort}</div>
        )}
        {finished && (
          <>
            {cleanup.status === 'refused' && cleanup.result?.reason && <Notice level="warn"><p>{cleanup.result.reason}</p></Notice>}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Figure label={TEXT.reclaimed} value={r.reclaimed?.guestBytes != null ? formatBytes(r.reclaimed.guestBytes) : '—'} hint={r.estimateBytes != null ? `${TEXT.estimated}: ${formatBytes(r.estimateBytes)}` : null} />
              <Figure label={TEXT.remaining} value={remaining ? TEXT.usedOfAvailable(formatBytes(remaining.usedBytes), formatBytes(remaining.availableBytes)) : '—'} />
            </div>
            {r.reclaimed?.settling && <Notice level="info"><p>{TEXT.settling}</p></Notice>}
            <div className={`rounded-lg border p-3 flex items-start gap-2 text-sm ${r.health === 'failed' ? 'border-red-500/40 bg-red-500/10' : ''}`} data-testid="health">
              <HealthIcon className={`h-4 w-4 mt-0.5 shrink-0 ${r.health === 'passed' ? 'text-emerald-500' : r.health === 'failed' ? 'text-red-500' : 'text-muted-foreground'}`} aria-hidden="true" />
              <div className="min-w-0"><p className="font-medium">{TEXT.health}</p><p className="break-words">{TEXT.healthText[r.health] || TEXT.healthText['not-checked']}</p></div>
            </div>
            {!r.removed?.length && <p className="text-sm text-muted-foreground">{TEXT.noneRemoved}</p>}
            <List title={TEXT.removed} items={r.removed} render={(x) => <p className="break-words">{x.label} <span className="text-xs text-muted-foreground">{formatBytes(x.bytes)}</span></p>} />
            <List title={TEXT.skipped} tone="text-amber-600 dark:text-amber-400" items={r.skipped} render={(x) => <><p className="break-words">{x.label}</p><p className="text-xs text-muted-foreground break-words">{x.reason}</p></>} />
            <List title={TEXT.failed} tone="text-red-500" items={r.failed} render={(x) => <><p className="break-words">{x.label}</p><p className="text-xs text-red-500 break-words">{x.error}</p></>} />
          </>
        )}
        {events.length > 0 && (
          <details className="rounded-lg border p-3 text-xs">
            <summary className="min-h-11 flex items-center cursor-pointer text-sm font-medium">{TEXT.recentEvents}</summary>
            <ul className="space-y-1 pt-1">{events.slice(-20).map((e, i) => <li key={e.id ?? i} className="break-words">{e.message || e.kind}</li>)}</ul>
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
