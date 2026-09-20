import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { useToast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  Download, Loader2, Trash2, Package, AlertTriangle, Check, Clock, RotateCcw,
} from 'lucide-react';

// Prepared downloads for one container.
//
// The old Export button streamed `incus export` straight into the response:
// the work lived and died with the request, every click paid the full build
// again, and with no Content-Length the browser could show no progress and
// could not resume. Here the tarball is built ONCE into a file on the host,
// in the background, with byte progress read from the file as it grows —
// then downloading it is an ordinary static file fetch, as many times as
// anyone likes, from any device, resumable.
//
// Backed by /api/lxc/exports (routes/lxc.js) over lib/lxc-exports.js.

const POLL_MS = 2000;

function bytes(n) {
  if (n == null) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = Number(n);
  let i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i += 1; }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${u[i]}`;
}

function when(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export default function PreparedDownloads({ container, snapshots = [], canWrite = true }) {
  const { toast } = useToast();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [preparing, setPreparing] = useState(false);
  const [source, setSource] = useState('live');
  const [deleting, setDeleting] = useState(null);
  const [confirmId, setConfirmId] = useState(null);
  // { row, name, busy, result } — the restore dialog, scoped to one artifact.
  const [restore, setRestore] = useState(null);
  const timer = useRef(null);

  const refresh = useCallback(async () => {
    try {
      const r = await api.listLxcPreparedExports(container);
      setRows(r.exports || []);
    } catch {
      // A failed poll is not worth a toast; the next one usually works.
    } finally {
      setLoading(false);
    }
  }, [container]);

  useEffect(() => { setLoading(true); refresh(); }, [refresh]);

  // Poll only while something is actually building.
  const building = rows.some((r) => r.state === 'preparing');
  useEffect(() => {
    if (!building) return undefined;
    timer.current = setInterval(refresh, POLL_MS);
    return () => clearInterval(timer.current);
  }, [building, refresh]);

  const prepare = async () => {
    setPreparing(true);
    try {
      const r = await api.prepareLxcExport({
        container,
        snapshot: source === 'live' ? null : source,
      });
      toast({
        title: 'Building the download',
        description: `${r.export.filename} — ${r.compression?.compression || 'zstd'}${
          r.compression?.fell_back_from ? ' (this host has no zstd binary)' : ''}. You can leave this page.`,
      });
      refresh();
    } catch (e) {
      toast({ title: 'Could not start', description: e.message, variant: 'destructive' });
    } finally {
      setPreparing(false);
    }
  };

  const doRestore = async () => {
    if (!restore?.name?.trim()) return;
    setRestore((r) => ({ ...r, busy: true, error: null }));
    try {
      const out = await api.restoreLxcPreparedExport(restore.row.id, { name: restore.name.trim() });
      setRestore((r) => ({ ...r, busy: false, result: out }));
      toast({
        title: `Restored as ${out.container}`,
        description: out.notes?.length ? out.notes[0] : `${out.source_container} was not touched.`,
      });
    } catch (e) {
      setRestore((r) => ({ ...r, busy: false, error: e.message }));
    }
  };

  const remove = async (id) => {
    setDeleting(id);
    try {
      await api.deleteLxcPreparedExport(id);
      setConfirmId(null);
      refresh();
    } catch (e) {
      toast({ title: 'Could not delete', description: e.message, variant: 'destructive' });
    } finally {
      setDeleting(null);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h4 className="text-sm font-medium">Prepared downloads</h4>
          <p className="text-xs text-muted-foreground">
            Built once on the host, then downloadable as often as you like. Kept for 14 days.
          </p>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          {snapshots.length > 0 && (
            <Select value={source} onValueChange={setSource}>
              <SelectTrigger className="h-11 w-full sm:w-52" aria-label="What to export">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="live">Live container</SelectItem>
                {snapshots.map((s) => (
                  <SelectItem key={s.name || s} value={s.name || s}>{`Snapshot: ${s.name || s}`}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <Button
            onClick={prepare}
            disabled={!canWrite || preparing}
            className="h-11 w-full sm:w-auto"
          >
            {preparing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Package className="mr-2 h-4 w-4" />}
            Prepare download
          </Button>
        </div>
      </div>

      {loading && rows.length === 0 && (
        <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </div>
      )}

      {!loading && rows.length === 0 && (
        <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
          Nothing prepared yet. Preparing takes as long as one export — about a minute per gigabyte —
          and runs in the background, so you can close this dialog.
        </p>
      )}

      <ul className="space-y-2">
        {rows.map((r) => (
          <li key={r.id} className="rounded-md border p-3">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0 flex-1">
                <p className="truncate font-mono text-xs sm:text-sm" title={r.filename}>{r.filename}</p>
                <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                  {r.state === 'ready' && <span className="inline-flex items-center gap-1 text-green-600 dark:text-green-500"><Check className="h-3 w-3" />Ready</span>}
                  {r.state === 'preparing' && (
                    <span className="inline-flex items-center gap-1">
                      <Loader2 className="h-3 w-3 animate-spin" />
                      {r.percent != null ? `Building ${r.percent}%` : 'Building'}
                    </span>
                  )}
                  {r.state === 'failed' && <span className="inline-flex items-center gap-1 text-destructive"><AlertTriangle className="h-3 w-3" />Failed</span>}
                  <span>·</span>
                  <span>{r.state === 'preparing' && r.bytes_total ? `${bytes(r.bytes)} / ~${bytes(r.bytes_total)}` : bytes(r.bytes || r.bytes_total)}</span>
                  <span>·</span>
                  <span>{r.compression}</span>
                  {r.snapshot && (<><span>·</span><span>snapshot {r.snapshot}</span></>)}
                  {r.downloads > 0 && (<><span>·</span><span>{r.downloads} download{r.downloads === 1 ? '' : 's'}</span></>)}
                  {r.expires_at && r.state === 'ready' && (
                    <><span>·</span><span className="inline-flex items-center gap-1"><Clock className="h-3 w-3" />kept to {when(r.expires_at)}</span></>
                  )}
                </p>
                {r.state === 'preparing' && (
                  <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full rounded-full bg-primary transition-all"
                      style={{ width: `${r.percent ?? 3}%` }}
                    />
                  </div>
                )}
                {r.stalled && (
                  <p className="mt-1 text-xs text-amber-600 dark:text-amber-500">
                    No new bytes for ten minutes — on dir storage the copy phase is silent; it is probably still working.
                  </p>
                )}
                {r.error && <p className="mt-1 break-words text-xs text-destructive">{r.error}</p>}
              </div>

              <div className="flex shrink-0 items-center gap-2">
                {r.state === 'ready' && (
                  <>
                    <Button asChild variant="outline" size="sm" className="h-11 flex-1 sm:flex-none">
                      <a href={api.lxcPreparedExportUrl(r.id)} download={r.filename}>
                        <Download className="mr-2 h-4 w-4" />Download
                      </a>
                    </Button>
                    {canWrite && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-11 flex-1 sm:flex-none"
                        onClick={() => setRestore({ row: r, name: `${r.container}-restored`, busy: false, error: null, result: null })}
                      >
                        <RotateCcw className="mr-2 h-4 w-4" />Restore
                      </Button>
                    )}
                  </>
                )}
                {r.state !== 'preparing' && canWrite && (
                  confirmId === r.id ? (
                    <div className="flex items-center gap-2">
                      <Button
                        variant="destructive"
                        size="sm"
                        className="h-11"
                        disabled={deleting === r.id}
                        onClick={() => remove(r.id)}
                      >
                        {deleting === r.id ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Delete'}
                      </Button>
                      <Button variant="ghost" size="sm" className="h-11" onClick={() => setConfirmId(null)}>Cancel</Button>
                    </div>
                  ) : (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-11 w-11"
                      aria-label={`Delete ${r.filename}`}
                      onClick={() => setConfirmId(r.id)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  )
                )}
              </div>
            </div>
          </li>
        ))}
      </ul>

      {/* Restore — straight from the host, so no download-and-re-upload.
          Always a NEW container: a backup restored over a running guest is
          the one move with no undo. */}
      <Dialog open={!!restore} onOpenChange={(o) => { if (!o) { setRestore(null); refresh(); } }}>
        <DialogContent className="max-h-[100dvh] w-full max-w-lg overflow-y-auto sm:max-h-[90vh]">
          <DialogHeader>
            <DialogTitle>Restore into a new container</DialogTitle>
            <DialogDescription>
              The tarball is already on the host, so this imports it directly — nothing is
              downloaded or uploaded. <span className="font-medium">{restore?.row?.container}</span> is
              not touched.
            </DialogDescription>
          </DialogHeader>

          {!restore?.result ? (
            <div className="space-y-4">
              <p className="break-all font-mono text-xs text-muted-foreground">{restore?.row?.filename}</p>
              <div className="space-y-2">
                <Label htmlFor="restore-name">New container name</Label>
                <Input
                  id="restore-name"
                  className="h-11"
                  value={restore?.name || ''}
                  onChange={(e) => setRestore((r) => ({ ...r, name: e.target.value }))}
                  placeholder="searxng-restored"
                  disabled={restore?.busy}
                  autoComplete="off"
                />
                <p className="text-xs text-muted-foreground">
                  Letters, digits and hyphens. It starts stopped, with no routes — check it,
                  then use Transfer routes to move traffic across.
                </p>
              </div>
              {restore?.error && (
                <p className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
                  {restore.error}
                </p>
              )}
            </div>
          ) : (
            <div className="space-y-3">
              <p className="flex items-start gap-2 text-sm">
                <Check className="mt-0.5 h-4 w-4 shrink-0 text-green-600 dark:text-green-500" />
                <span>
                  Imported as <span className="font-medium">{restore.result.container}</span>, stopped.
                </span>
              </p>
              {(restore.result.notes || []).map((n, i) => (
                <p key={i} className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-400">
                  {n}
                </p>
              ))}
              <p className="text-xs text-muted-foreground">{restore.result.next}</p>
            </div>
          )}

          <DialogFooter className="flex-col gap-2 sm:flex-row">
            {!restore?.result ? (
              <>
                <Button variant="ghost" className="h-11 w-full sm:w-auto" onClick={() => setRestore(null)} disabled={restore?.busy}>
                  Cancel
                </Button>
                <Button className="h-11 w-full sm:w-auto" onClick={doRestore} disabled={restore?.busy || !restore?.name?.trim()}>
                  {restore?.busy ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Restoring…</> : <><RotateCcw className="mr-2 h-4 w-4" />Restore</>}
                </Button>
              </>
            ) : (
              <Button className="h-11 w-full sm:w-auto" onClick={() => { setRestore(null); refresh(); }}>Done</Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
