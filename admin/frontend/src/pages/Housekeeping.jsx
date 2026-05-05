// Housekeeping — operator-facing disk-usage view + per-category
// prune actions for stale docker artifacts and ProxyPilot's own
// pre-update DB backups.
//
// Design notes:
//
//  - Each category is a card showing total / size / reclaimable
//    plus a Prune button. The dangerous prunes (all-unused images,
//    unused volumes) get destructive button styling and a confirm
//    dialog so the operator can't trip them by accident.
//  - The "Prune now" button on the dangling-images card is the
//    one the post-update cleanup also runs automatically — making
//    it visible here is mostly for "I want to free space without
//    waiting for the next update."

import { useEffect, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '@/context/AuthContext';
import { api, ApiError } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import { useToast } from '@/hooks/use-toast';
import {
  AlertTriangle, Archive, Boxes, Database, HardDrive, Layers, Loader2, RefreshCw, Trash2,
} from 'lucide-react';

function fmtBytes(n) {
  if (typeof n !== 'number' || Number.isNaN(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

function StatLine({ label, value }) {
  return (
    <div className="flex items-baseline justify-between text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-mono">{value}</span>
    </div>
  );
}

// One docker df row OR the backups synthetic row, plus its prune
// button. Destructive prunes go through a confirm dialog.
function CategoryCard({ icon: Icon, title, description, stats, action }) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-start gap-3">
          <Icon className="h-5 w-5 mt-0.5 text-muted-foreground" />
          <div className="space-y-1 flex-1">
            <CardTitle className="text-base">{title}</CardTitle>
            <CardDescription className="text-xs">{description}</CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="space-y-1">
          {stats.map((s, i) => <StatLine key={i} {...s} />)}
        </div>
        <div className="pt-1 border-t">
          {action}
        </div>
      </CardContent>
    </Card>
  );
}

// Generic confirm-then-prune button. Builds the prune body from
// `pruneBody` (an object keyed by the categories the schema accepts),
// pops a confirm dialog if `destructive` is true.
function PruneButton({ label, pruneBody, onDone, variant = 'outline', destructive = false, disabled, hint }) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const fire = async () => {
    setBusy(true);
    try {
      const out = await api.housekeepingPrune(pruneBody);
      const freed = fmtBytes(out.freed_bytes || 0);
      toast({
        title: out.errors?.length
          ? `Pruned with ${out.errors.length} error(s)`
          : 'Pruned',
        description: `Freed ${freed}.`,
        variant: out.errors?.length ? 'destructive' : undefined,
      });
      onDone?.();
    } catch (err) {
      toast({
        title: 'Prune failed',
        description: err instanceof ApiError ? err.message : (err?.message || 'unknown error'),
        variant: 'destructive',
      });
    } finally {
      setBusy(false);
      setOpen(false);
    }
  };

  const trigger = (
    <Button
      variant={variant} size="sm"
      onClick={() => destructive ? setOpen(true) : fire()}
      disabled={disabled || busy}
      title={hint}
    >
      {busy ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <Trash2 className="h-4 w-4 mr-1.5" />}
      {label}
    </Button>
  );

  if (!destructive) return trigger;

  return (
    <>
      {trigger}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-amber-500" /> Confirm prune
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-2 text-sm text-muted-foreground">
            <p>
              You're about to run: <code className="font-mono text-xs text-foreground">{label}</code>.
            </p>
            {hint && <p>{hint}</p>}
            <p className="text-xs">
              This affects the host's docker daemon, not just ProxyPilot. If other containers / images
              live on this host, they may be impacted.
            </p>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
            <Button variant="destructive" onClick={fire} disabled={busy}>
              {busy ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : null}
              Prune
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export default function Housekeeping() {
  const { user } = useAuth();
  const { toast } = useToast();
  const isAdmin = user?.role === 'admin'
    || JSON.parse(localStorage.getItem('user') || '{}').role === 'admin';

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const refresh = async () => {
    setLoading(true); setError(null);
    try {
      setData(await api.housekeepingUsage());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : (err?.message || 'failed to load'));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { refresh(); /* eslint-disable-next-line */ }, []);

  if (!isAdmin) return <Navigate to="/" replace />;

  // Pull docker categories out of the df rows, with fallbacks for
  // missing entries so the card always renders something sensible.
  const dockerRows = data?.docker || [];
  const findRow = (type) => dockerRows.find(r => r.type === type) || null;
  const images = findRow('Images');
  const containers = findRow('Containers');
  const volumes = findRow('Local Volumes');
  const buildCache = findRow('Build Cache');
  const backups = data?.backups;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 flex-wrap">
        <HardDrive className="h-5 w-5 text-orange-500" />
        <h1 className="text-lg font-semibold">Housekeeping</h1>
        <div className="ml-auto">
          <Button variant="outline" size="sm" onClick={refresh} disabled={loading}>
            <RefreshCw className={`h-4 w-4 mr-1.5 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
        </div>
      </div>
      <p className="text-xs text-muted-foreground max-w-2xl leading-relaxed">
        Disk usage from the host's docker daemon plus ProxyPilot's pre-update DB backup
        directory. Pruning is sudo-gated and per-category — nothing fires implicitly.
        The dashboard's own update flow already prunes dangling images + caps the
        build cache after every successful update; this page is for everything else.
      </p>

      {error && (
        <div className="text-sm text-red-500 border border-red-500/30 bg-red-500/10 rounded px-3 py-2">
          {error}
        </div>
      )}
      {data?.docker_error && (
        <div className="text-xs text-amber-400 border border-amber-500/30 bg-amber-500/10 rounded px-3 py-2">
          docker df failed: {data.docker_error}
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <CategoryCard
          icon={Layers}
          title="Docker images"
          description="Layers from previous builds. Dangling = untagged (replaced by a newer build)."
          stats={[
            { label: 'Total', value: images ? `${images.total} (active: ${images.active})` : '—' },
            { label: 'Size', value: images?.size ?? '—' },
            { label: 'Reclaimable', value: images?.reclaimable ?? '—' },
          ]}
          action={
            <div className="flex gap-2 flex-wrap">
              <PruneButton
                label="Prune dangling"
                pruneBody={{ dangling_images: true }}
                onDone={refresh}
                hint="Safe — removes only untagged images. Equivalent to `docker image prune -f`."
              />
              <PruneButton
                label="Prune all unused"
                pruneBody={{ all_unused_images: true }}
                onDone={refresh}
                destructive
                variant="destructive"
                hint="Removes EVERY image with no running container. May affect other apps on this docker daemon. Equivalent to `docker image prune -af`."
              />
            </div>
          }
        />

        <CategoryCard
          icon={Boxes}
          title="Stopped containers"
          description="Containers that exited and weren't auto-removed."
          stats={[
            { label: 'Total', value: containers ? `${containers.total} (active: ${containers.active})` : '—' },
            { label: 'Size', value: containers?.size ?? '—' },
            { label: 'Reclaimable', value: containers?.reclaimable ?? '—' },
          ]}
          action={
            <PruneButton
              label="Prune stopped"
              pruneBody={{ stopped_containers: true }}
              onDone={refresh}
              hint="Removes containers in `Exited` / `Created` state. Running containers are untouched."
            />
          }
        />

        <CategoryCard
          icon={Database}
          title="Local volumes"
          description="Volumes with no container reference. May hold persistent data."
          stats={[
            { label: 'Total', value: volumes ? `${volumes.total} (active: ${volumes.active})` : '—' },
            { label: 'Size', value: volumes?.size ?? '—' },
            { label: 'Reclaimable', value: volumes?.reclaimable ?? '—' },
          ]}
          action={
            <PruneButton
              label="Prune unused volumes"
              pruneBody={{ unused_volumes: true }}
              onDone={refresh}
              destructive
              variant="destructive"
              hint="Permanently deletes volume contents. Confirm only if you're sure no application owns the data."
            />
          }
        />

        <CategoryCard
          icon={Archive}
          title="Build cache"
          description="docker buildx layer cache from past image builds."
          stats={[
            { label: 'Total', value: buildCache ? `${buildCache.total} layer(s)` : '—' },
            { label: 'Size', value: buildCache?.size ?? '—' },
            { label: 'Reclaimable', value: buildCache?.reclaimable ?? '—' },
          ]}
          action={
            <PruneButton
              label="Trim to 1 GiB"
              pruneBody={{ build_cache: true }}
              onDone={refresh}
              hint="Caps the cache at 1 GiB by removing the oldest layers. Future builds may be slower until the cache repopulates."
            />
          }
        />

        <CategoryCard
          icon={Database}
          title="Pre-update DB backups"
          description="ProxyPilot snapshots the SQLite DB before each update. They accumulate over time."
          stats={[
            { label: 'Count', value: backups?.count ?? '—' },
            { label: 'Total size', value: backups ? fmtBytes(backups.bytes) : '—' },
            { label: 'Oldest', value: backups?.oldest ? new Date(backups.oldest).toLocaleString() : '—' },
            { label: 'Newest', value: backups?.newest ? new Date(backups.newest).toLocaleString() : '—' },
          ]}
          action={
            <div className="flex gap-2 flex-wrap">
              <PruneButton
                label="Delete > 30 days"
                pruneBody={{ backups: true, backups_older_than_days: 30 }}
                onDone={refresh}
                hint="Removes backup files older than 30 days. The newest is always kept regardless of age."
              />
              <PruneButton
                label="Delete > 7 days"
                pruneBody={{ backups: true, backups_older_than_days: 7 }}
                onDone={refresh}
                hint="Aggressive — keeps only the last week of backups."
              />
            </div>
          }
        />
      </div>
    </div>
  );
}
