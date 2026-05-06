// S3 bucket browser modal.
//
// Lists every object under a destination's path_prefix with a
// "linked / orphan" annotation.  Operators can:
//
//   * See what's actually in the bucket (vs. what the dashboard
//     thinks should be there) — drift surfaces orphans from
//     previous installs, manual uploads, or bucket-side
//     lifecycle moves.
//   * Delete individual objects (sudo-gated).  When the key
//     matches a backups row, the row's s3_uploaded flag flips
//     to 0 (consistent with per-row 'remove S3 copy'); when
//     it's an orphan, only the bucket changes.

import { useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import { useToast } from '@/hooks/use-toast';
import {
  AlertTriangle, Cloud, ExternalLink, Loader2, RefreshCw, Trash2,
} from 'lucide-react';

function fmtBytes(n) {
  if (typeof n !== 'number' || Number.isNaN(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

export default function BucketBrowser({ open, onOpenChange, destination }) {
  const { toast } = useToast();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [deleting, setDeleting] = useState(null); // key being confirmed
  const [busyKey, setBusyKey] = useState(null);

  const refresh = async () => {
    if (!destination) return;
    setLoading(true);
    try {
      const r = await api.backupsListStorageObjects(destination.id);
      setData(r);
    } catch (err) {
      toast({
        title: 'Could not list bucket',
        description: err instanceof ApiError ? err.message : (err?.message || 'unknown error'),
        variant: 'destructive',
      });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!open) {
      setData(null);
      setDeleting(null);
      return;
    }
    refresh();
    /* eslint-disable-next-line */
  }, [open, destination?.id]);

  const confirmDelete = async () => {
    if (!deleting) return;
    setBusyKey(deleting);
    try {
      const r = await api.backupsDeleteStorageObject(destination.id, deleting);
      toast({
        title: 'Object deleted',
        description: r.matched_backup_id
          ? `Backup row ${r.matched_backup_id.slice(0, 8)}… s3_uploaded flag cleared.`
          : 'Orphan object — no DB row needed updating.',
      });
      setDeleting(null);
      await refresh();
    } catch (err) {
      toast({
        title: 'Delete failed',
        description: err instanceof ApiError ? err.message : (err?.message || 'unknown error'),
        variant: 'destructive',
      });
    } finally {
      setBusyKey(null);
    }
  };

  const objects = data?.objects || [];
  const orphans = objects.filter((o) => !o.linked).length;

  return (
    <Dialog open={open} onOpenChange={(o) => !busyKey && onOpenChange(o)}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Cloud className="h-5 w-5" /> Browse {destination?.name}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3 text-sm">
          <div className="text-xs text-muted-foreground">
            <code className="font-mono text-foreground">{destination?.bucket}</code>
            {destination?.path_prefix ? <code className="font-mono text-foreground">/{destination.path_prefix}</code> : null}
            {' · '}
            {data
              ? `${objects.length} object${objects.length === 1 ? '' : 's'}${orphans > 0 ? ` · ${orphans} orphan${orphans === 1 ? '' : 's'}` : ''}`
              : (loading ? 'loading…' : '')}
            <Button
              variant="outline" size="sm"
              className="ml-3"
              onClick={refresh} disabled={loading}
            >
              <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${loading ? 'animate-spin' : ''}`} />
              Refresh
            </Button>
          </div>

          {data && objects.length === 0 && (
            <p className="text-xs text-muted-foreground italic px-3 py-6 text-center">
              No objects found under this prefix.
            </p>
          )}

          {objects.length > 0 && (
            <div className="border rounded max-h-[60vh] overflow-y-auto">
              <table className="w-full text-xs">
                <thead className="bg-muted/40 text-[11px] uppercase tracking-wide sticky top-0">
                  <tr>
                    <th className="text-left font-medium px-3 py-2">Key</th>
                    <th className="text-left font-medium px-3 py-2">Size</th>
                    <th className="text-left font-medium px-3 py-2">Modified</th>
                    <th className="text-left font-medium px-3 py-2">Status</th>
                    <th className="text-right font-medium px-3 py-2">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {objects.map((o) => (
                    <tr key={o.key} className="border-t">
                      <td className="px-3 py-2 align-top font-mono break-all max-w-[20rem]">
                        {o.key}
                      </td>
                      <td className="px-3 py-2 align-top font-mono whitespace-nowrap">
                        {fmtBytes(o.size)}
                      </td>
                      <td className="px-3 py-2 align-top whitespace-nowrap" title={o.last_modified}>
                        {o.last_modified ? new Date(o.last_modified).toLocaleString() : '—'}
                      </td>
                      <td className="px-3 py-2 align-top">
                        {o.linked ? (
                          <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
                            <ExternalLink className="h-3 w-3" />
                            <span title={`Backup ${o.backup_id}`}>linked · {o.backup_id?.slice(0, 8)}…</span>
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-amber-600 dark:text-amber-400">
                            <AlertTriangle className="h-3 w-3" /> orphan
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2 align-top">
                        <div className="flex justify-end">
                          <Button
                            variant="destructive"
                            size="sm"
                            onClick={() => setDeleting(o.key)}
                            disabled={busyKey === o.key}
                            className="h-7 text-[11px]"
                          >
                            {busyKey === o.key ? (
                              <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                            ) : (
                              <Trash2 className="h-3 w-3 mr-1" />
                            )}
                            Delete
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={!!busyKey}>Close</Button>
        </DialogFooter>

        {deleting && (
          <Dialog open={!!deleting} onOpenChange={(o) => !busyKey && !o && setDeleting(null)}>
            <DialogContent>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <AlertTriangle className="h-5 w-5 text-amber-500" /> Delete object
                </DialogTitle>
              </DialogHeader>
              <div className="space-y-2 text-sm text-muted-foreground">
                <p>Permanently delete this S3 object?</p>
                <p className="font-mono text-xs text-foreground break-all bg-muted/40 rounded px-2 py-1">{deleting}</p>
                <p className="text-xs">
                  Cannot be undone.  When the key matches a tracked backup, the row's
                  S3 flag is cleared but the row stays (the local copy may still exist).
                </p>
              </div>
              <DialogFooter>
                <Button variant="ghost" onClick={() => setDeleting(null)} disabled={!!busyKey}>Cancel</Button>
                <Button variant="destructive" onClick={confirmDelete} disabled={!!busyKey}>
                  {busyKey ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <Trash2 className="h-4 w-4 mr-1.5" />}
                  Delete
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        )}
      </DialogContent>
    </Dialog>
  );
}
