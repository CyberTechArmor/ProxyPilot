import { useState, useEffect, useRef } from 'react';
import { useSnapshotExports } from '@/context/SnapshotExportContext';
import { api } from '@/lib/api';
import { useToast } from '@/hooks/use-toast';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter,
  DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Loader2, X } from 'lucide-react';

function formatPct(uploaded, total) {
  if (!total || total <= 0) return null;
  return Math.min(99, Math.round((uploaded / total) * 100));
}

function formatSize(bytes) {
  if (!bytes && bytes !== 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function formatDuration(ms) {
  if (!ms || ms < 0) return '0s';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return `${m}m ${rs}s`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return `${h}h ${rm}m`;
}

// Sticky banner that appears whenever a snapshot S3 export is
// running OR queued.  Mounted once in Layout so it's visible from
// every admin page.  Shows the currently-running job's progress
// + queue depth + a cancel button (with proper modal confirm).
export default function SnapshotExportBanner() {
  const { status, refresh } = useSnapshotExports();
  const { toast } = useToast();
  const [cancelling, setCancelling] = useState(false);
  const [confirmCancelOpen, setConfirmCancelOpen] = useState(false);

  // All hooks must run on every render — extracting the
  // running-job fields up front (defaulting to safe values when
  // the queue is empty) lets the early-return below sit AFTER
  // the hooks instead of before.  Calling hooks conditionally
  // crashed the whole tree the moment a job appeared (the
  // operator-visible "frontend doesn't show while preparing/
  // pushing" symptom): React saw N hooks one render and N+M
  // the next, threw "Rendered more hooks than during the
  // previous render", and unmounted everything.
  const running = status.running[0] || null;
  const phase = running?.phase || 'preparing';
  const serverPhaseElapsedMs = running?.phase_elapsed_ms || 0;
  const runningKey = running ? running.snapshot_name : null;

  // Local seconds counter so the elapsed reading ticks every
  // second regardless of the 2.5s poll cadence.  Re-baselines on
  // every poll: when a new server snapshot lands we capture
  // (its phase_elapsed_ms, the wall clock at receipt) and the
  // displayed elapsed = server_value + (now - receivedAt).
  // Resets whenever the phase changes so a preparing→uploading
  // flip restarts the visible timer.
  const baselineRef = useRef({
    phase, serverMs: serverPhaseElapsedMs, receivedAt: Date.now(),
  });
  useEffect(() => {
    baselineRef.current = {
      phase,
      serverMs: serverPhaseElapsedMs,
      receivedAt: Date.now(),
    };
  }, [phase, serverPhaseElapsedMs]);
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!runningKey) return undefined;
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [runningKey]);

  if (status.running.length === 0 && status.queue_depth === 0) {
    return null;
  }

  const pct = running ? formatPct(running.bytes_uploaded, running.bytes_total) : null;
  const queuedExtra = status.queue_depth;
  const phaseElapsedMs = running
    ? baselineRef.current.serverMs + (Date.now() - baselineRef.current.receivedAt)
    : 0;

  const prepEstimateMs = running?.prep_estimate_ms || null;
  const prepPctEstimate = prepEstimateMs
    ? Math.min(95, Math.round((phaseElapsedMs / prepEstimateMs) * 100))
    : null;

  // Color palette per phase.  Amber while preparing matches the
  // existing tone for "warming up"; sky/blue once uploading
  // signals "actively pushing bytes" — the operator's mental
  // model from the snapshot panel uses the same blue accent.
  const palette = phase === 'uploading'
    ? {
      bg: 'bg-sky-500/15 supports-[backdrop-filter]:bg-sky-500/10',
      border: 'border-sky-500/30',
      icon: 'text-sky-600 dark:text-sky-400',
      chip: 'bg-sky-500/20',
      btn: 'border-sky-500/40 hover:bg-sky-500/20',
      barTrack: 'bg-sky-500/20',
      barFill: 'bg-sky-500',
    }
    : {
      bg: 'bg-amber-500/15 supports-[backdrop-filter]:bg-amber-500/10',
      border: 'border-amber-500/30',
      icon: 'text-amber-600 dark:text-amber-400',
      chip: 'bg-amber-500/20',
      btn: 'border-amber-500/40 hover:bg-amber-500/20',
      barTrack: 'bg-amber-500/20',
      barFill: 'bg-amber-500',
    };

  const handleCancelConfirm = async () => {
    if (!running) return;
    setCancelling(true);
    try {
      // Cancel every pending destination row for this snapshot.
      // The backend's cancel handler is idempotent, so firing
      // them all in parallel is safe.
      for (const dest of running.destinations || []) {
        if (dest.cancel_requested) continue;
        try {
          await api.cancelLxcSnapshotS3Export(
            running.container_name, running.snapshot_name, dest.export_id,
          );
        } catch { /* tolerated; banner will reflect via next poll */ }
      }
      toast({
        title: 'Cancel requested',
        description: `Aborting ${running.snapshot_name}; the worker will surface 'canceled' once the abort completes.`,
      });
      setConfirmCancelOpen(false);
      await refresh();
    } finally {
      setCancelling(false);
    }
  };

  return (
    <>
      <div
        role="status"
        className={`sticky top-0 z-30 ${palette.bg} border-b ${palette.border} backdrop-blur px-4 py-2 text-sm transition-colors`}
      >
        <div className="flex items-center gap-3 max-w-screen-2xl mx-auto">
          <Loader2 className={`h-4 w-4 animate-spin ${palette.icon} shrink-0`} />
          <div className="flex-1 min-w-0">
            {running ? (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="font-medium truncate">
                  Pushing snapshot{' '}
                  <code className={`font-mono text-xs ${palette.chip} px-1.5 py-0.5 rounded`}>
                    {running.container_name}/{running.snapshot_name}
                  </code>{' '}
                  to S3
                </span>
                <span className="text-xs text-muted-foreground">
                  {phase === 'uploading' && pct !== null
                    ? `${pct}% · ${formatSize(running.bytes_uploaded)} / ${formatSize(running.bytes_total)}`
                    : phase === 'preparing' && prepEstimateMs
                      ? `preparing tarball · ${formatDuration(phaseElapsedMs)} elapsed / ~${formatDuration(prepEstimateMs)} expected`
                      : phase === 'preparing'
                        ? `preparing tarball · ${formatDuration(phaseElapsedMs)} elapsed`
                        : 'preparing tarball…'}
                </span>
                {queuedExtra > 0 && (
                  <span className="text-xs text-muted-foreground">
                    · {queuedExtra} more queued
                  </span>
                )}
              </div>
            ) : (
              <span className="font-medium">
                {queuedExtra} snapshot export{queuedExtra === 1 ? '' : 's'} queued
              </span>
            )}
            {/* Progress bar.  Two sources:
                * uploading → byte percentage (precise).
                * preparing + estimate available → time-based
                  estimate (approximate; capped at 95% so the bar
                  doesn't look 'done' before incus actually
                  finishes the copy / export). */}
            {((phase === 'uploading' && pct !== null) || (phase === 'preparing' && prepPctEstimate !== null)) && (
              <div className={`mt-1 h-1 w-full overflow-hidden rounded ${palette.barTrack}`}>
                <div
                  className={`h-full ${palette.barFill} transition-[width] duration-700`}
                  style={{
                    width: `${Math.max(2, phase === 'uploading' ? pct : prepPctEstimate)}%`,
                  }}
                />
              </div>
            )}
          </div>
          {running && (
            <button
              type="button"
              onClick={() => setConfirmCancelOpen(true)}
              disabled={cancelling}
              className={`text-xs px-2 py-1 rounded border ${palette.btn} disabled:opacity-50 flex items-center gap-1 shrink-0`}
              title="Cancel the currently-running export"
            >
              <X className="h-3 w-3" />
              {cancelling ? 'Cancelling…' : 'Cancel'}
            </button>
          )}
        </div>
      </div>

      <Dialog
        open={confirmCancelOpen}
        onOpenChange={(o) => { if (!o && !cancelling) setConfirmCancelOpen(false); }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Cancel snapshot push</DialogTitle>
            <DialogDescription>
              Stop the in-flight upload of{' '}
              <code className="font-mono text-xs text-foreground">
                {running ? `${running.container_name}/${running.snapshot_name}` : ''}
              </code>?
              {' '}Any destinations that already finished stay uploaded; the
              ones still in progress will be aborted and marked
              'canceled by operator'.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setConfirmCancelOpen(false)}
              disabled={cancelling}
            >
              Keep running
            </Button>
            <Button
              variant="destructive"
              onClick={handleCancelConfirm}
              disabled={cancelling}
            >
              {cancelling ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : null}
              Cancel push
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
