import { useState } from 'react';
import { useSnapshotExports } from '@/context/SnapshotExportContext';
import { api } from '@/lib/api';
import { useToast } from '@/hooks/use-toast';
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

// Sticky banner that appears whenever a snapshot S3 export is
// running OR queued.  Mounted once in Layout so it's visible from
// every admin page.  Shows the currently-running job's progress
// + queue depth + a cancel button for the running job.
export default function SnapshotExportBanner() {
  const { status, refresh } = useSnapshotExports();
  const { toast } = useToast();
  const [cancelling, setCancelling] = useState(false);

  if (status.running.length === 0 && status.queue_depth === 0) {
    return null;
  }

  const running = status.running[0];
  const pct = running ? formatPct(running.bytes_uploaded, running.bytes_total) : null;
  const queuedExtra = status.queue_depth;

  const handleCancel = async () => {
    if (!running) return;
    if (!window.confirm(
      `Cancel the in-flight upload of "${running.snapshot_name}" (${running.container_name})?  Any destinations already finished stay uploaded.`
    )) return;
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
      await refresh();
    } finally {
      setCancelling(false);
    }
  };

  return (
    <div
      role="status"
      className="sticky top-0 z-30 bg-amber-500/15 border-b border-amber-500/30 backdrop-blur supports-[backdrop-filter]:bg-amber-500/10 px-4 py-2 text-sm"
    >
      <div className="flex items-center gap-3 max-w-screen-2xl mx-auto">
        <Loader2 className="h-4 w-4 animate-spin text-amber-600 dark:text-amber-400 shrink-0" />
        <div className="flex-1 min-w-0">
          {running ? (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="font-medium truncate">
                Pushing snapshot{' '}
                <code className="font-mono text-xs bg-amber-500/20 px-1.5 py-0.5 rounded">
                  {running.container_name}/{running.snapshot_name}
                </code>{' '}
                to S3
              </span>
              <span className="text-xs text-muted-foreground">
                {pct !== null
                  ? `${pct}% · ${formatSize(running.bytes_uploaded)} / ${formatSize(running.bytes_total)}`
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
          {pct !== null && (
            <div className="mt-1 h-1 w-full overflow-hidden rounded bg-amber-500/20">
              <div
                className="h-full bg-amber-500 transition-[width] duration-700"
                style={{ width: `${Math.max(2, pct)}%` }}
              />
            </div>
          )}
        </div>
        {running && (
          <button
            type="button"
            onClick={handleCancel}
            disabled={cancelling}
            className="text-xs px-2 py-1 rounded border border-amber-500/40 hover:bg-amber-500/20 disabled:opacity-50 flex items-center gap-1 shrink-0"
            title="Cancel the currently-running export"
          >
            <X className="h-3 w-3" />
            {cancelling ? 'Cancelling…' : 'Cancel'}
          </button>
        )}
      </div>
    </div>
  );
}
