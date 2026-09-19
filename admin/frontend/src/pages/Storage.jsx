// Storage — host drives and ZFS: pools, datasets, snapshots, backup policy
// (sanoid), replication (syncoid) and the ops ledger. Everything comes from
// GET /api/storage/overview (routes/storage.js); every mutation is a
// plan/confirm pair through <PlanDialog> (POST /plan → POST /apply). The
// page must stay usable when ZFS is not installed: pools/datasets are just
// empty and the toolchain strip says what is missing.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '@/context/AuthContext';
import { api, ApiError } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { useToast } from '@/hooks/use-toast';
import { Archive, Camera, Database, HardDrive, History, Layers, Loader2, RefreshCw } from 'lucide-react';
import PlanDialog from '@/components/storage/PlanDialog';
import DevicesTab from '@/components/storage/DevicesTab';
import PoolsTab from '@/components/storage/PoolsTab';
import DatasetsTab from '@/components/storage/DatasetsTab';
import SnapshotsTab from '@/components/storage/SnapshotsTab';
import BackupTab from '@/components/storage/BackupTab';
import HistoryTab from '@/components/storage/HistoryTab';
import PreflightPanel, { PreflightBanner, usePreflight } from '@/components/storage/PreflightPanel';
import { BTN, CapacityBar, Chip, HealthChip, KV, Notice, fmtBytes, fmtDate } from '@/components/storage/shared';

/**
 * Active alerts, the same conditions lib/storage/freshness.js storageAlerts
 * raises (pool health / errors / scrub overdue / capacity, SMART, stale
 * snapshots, replication), computed from the overview so the page does not
 * trigger a second SMART scan through GET /alerts on every refresh.
 */
function computeAlerts(data) {
  const out = [];
  const f = data?.freshness || {};
  for (const p of f.pools || []) {
    if (!p.healthy) out.push({ key: `pool-health:${p.name}`, level: 'error', title: `Pool ${p.name} is ${p.health}`, body: p.status_text });
    if (p.scrub?.errors > 0 || p.data_errors || p.device_errors > 0) out.push({ key: `pool-errors:${p.name}`, level: 'error', title: `Pool ${p.name} reports errors`, body: `${p.scrub?.errors > 0 ? `scrub found ${p.scrub.errors} error(s). ` : ''}${p.device_errors > 0 ? `${p.device_errors} device error(s). ` : ''}${p.data_errors || ''}`.trim() });
    if (p.scrub?.status === 'overdue') out.push({ key: `scrub:${p.name}`, level: 'warning', title: `Pool ${p.name} not scrubbed for ${p.scrub.age}`, body: 'Enable the monthly scrub timer on the Pools tab.' });
    if (p.capacity_pct != null && p.capacity_pct >= 90) out.push({ key: `capacity:${p.name}`, level: 'warning', title: `Pool ${p.name} is ${p.capacity_pct}% full`, body: 'Prune snapshots or add capacity.' });
  }
  for (const d of data?.devices || []) {
    const v = d.smart_verdict;
    if (v?.level === 'fail') out.push({ key: `smart:${d.path}`, level: 'error', title: `SMART failure on ${d.path}`, body: `${v.reason}${d.in_pool ? ` — member of ${d.in_pool}` : ''}` });
    else if (v?.level === 'warn') out.push({ key: `smart:${d.path}`, level: 'warning', title: `SMART warning on ${d.path}`, body: v.reason });
  }
  for (const g of f.guests || []) {
    if (g.on_managed_pool && (g.snapshot_status === 'stale' || g.snapshot_status === 'none')) out.push({ key: `snap:${g.dataset}`, level: 'warning', title: `No recent snapshot of guest ${g.name}`, body: `last ${g.snapshot_age === 'never' ? 'never' : `${g.snapshot_age} ago`}` });
  }
  for (const d of f.datasets || []) {
    if (d.guest) continue;
    if (d.status === 'stale' || d.status === 'none') out.push({ key: `snap:${d.name}`, level: 'warning', title: `No recent snapshot of ${d.name}`, body: `last ${d.age === 'never' ? 'never' : `${d.age} ago`} (class ${d.class})` });
  }
  for (const r of f.replication || []) {
    if (r.status === 'failed') out.push({ key: `repl:${r.name}`, level: 'error', title: `Replication ${r.name} failed`, body: r.last_error || 'syncoid reported an error' });
    else if (r.status === 'stale' || r.status === 'never') out.push({ key: `repl:${r.name}`, level: 'warning', title: `Replication ${r.name} is ${r.status === 'never' ? 'yet to succeed' : `${r.age} old`}`, body: `target ${r.target}` });
  }
  return out;
}

function ToolBadge({ name, ok, title }) {
  return <Chip level={ok == null ? 'muted' : ok ? 'ok' : 'fail'} title={title}>{name} {ok == null ? '?' : ok ? 'installed' : 'missing'}</Chip>;
}

function ToolchainStrip({ toolchain, agent }) {
  if (!toolchain) return null;
  const sanoidTimer = toolchain.sanoid_timer;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <ToolBadge name="zfs" ok={toolchain.zfs} title={toolchain.zfs_version || (toolchain.zfs === false ? 'zfs utilities not found' : undefined)} />
      {toolchain.zfs && <Chip level={toolchain.zfs_module_loaded ? 'ok' : 'warn'} title="kernel module">module {toolchain.zfs_module_loaded ? 'loaded' : 'not loaded'}</Chip>}
      <ToolBadge name="smartctl" ok={toolchain.smartctl} />
      <ToolBadge name="sanoid" ok={toolchain.sanoid} title={sanoidTimer?.ActiveState ? `sanoid.timer ${sanoidTimer.ActiveState}` : undefined} />
      <ToolBadge name="syncoid" ok={toolchain.syncoid} title={toolchain.syncoid_unit_installed ? 'proxypilot-syncoid@ unit installed' : 'proxypilot-syncoid@ unit not installed'} />
      <ToolBadge name="incus" ok={toolchain.incus} />
      <Chip level={agent ? 'info' : 'muted'} title="ProxyPilot host agent">{agent ? 'agent' : 'nsenter'}</Chip>
    </div>
  );
}

function AlertsStrip({ alerts }) {
  if (!alerts.length) return null;
  return (
    <div className="flex flex-wrap gap-1.5">
      {alerts.map((a) => (
        <Chip key={a.key} level={a.level === 'error' ? 'fail' : 'warn'} title={a.body || undefined} className="whitespace-normal text-left">{a.title}</Chip>
      ))}
    </div>
  );
}

function ManagedSummary({ data, onGoDevices }) {
  const m = data?.managed;
  if (!m) {
    return (
      <Card>
        <CardContent className="p-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm font-medium">No managed pool yet</p>
            <p className="text-xs text-muted-foreground">Pick eligible disks under Devices and create a pool, or mark an existing pool as managed under Pools. The managed pool carries the guests, backups and exports datasets that the backup policy applies to.</p>
          </div>
          <Button className={BTN} onClick={onGoDevices} disabled={data?.toolchain?.zfs === false}><HardDrive className="h-4 w-4 mr-1.5" />Go to Devices</Button>
        </CardContent>
      </Card>
    );
  }
  const pool = (data.pools || []).find((p) => p.name === m.pool);
  const fresh = (data.freshness?.pools || []).find((p) => p.name === m.pool);
  const guests = (data.freshness?.guests || []).filter((g) => g.on_managed_pool).length;
  return (
    <Card className="border-primary/40">
      <CardContent className="p-4 space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <Layers className="h-5 w-5 text-primary" />
          <span className="font-mono text-lg font-semibold">{m.pool}</span>
          <Chip level="info">managed</Chip>
          {pool ? <HealthChip health={pool.status?.state || pool.health} /> : <Chip level="fail" title="the pool is not imported">not imported</Chip>}
          {m.incus_pool ? <Chip level="accent" title="Incus storage pool bound to this pool">incus:{m.incus_pool}</Chip> : <Chip level="warn">no Incus pool bound</Chip>}
          {fresh?.scrub && <Chip level={fresh.scrub.status === 'ok' ? 'ok' : fresh.scrub.status === 'running' ? 'info' : 'warn'}>scrub {fresh.scrub.status}{fresh.scrub.in_progress ? ` ${fresh.scrub.percent ?? '?'}%` : ''}</Chip>}
        </div>
        {pool && <CapacityBar pct={pool.capacity_pct} />}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-x-6 gap-y-1">
          <KV label="Size / free">{pool ? `${fmtBytes(pool.size_bytes)} / ${fmtBytes(pool.free_bytes)}` : '—'}</KV>
          <KV label="Guests on pool" mono={false}>{guests}</KV>
          <KV label="Guests dataset">{m.datasets?.incus}</KV>
          <KV label="Backups dataset">{m.datasets?.backups}</KV>
        </div>
      </CardContent>
    </Card>
  );
}

export default function Storage() {
  const { user } = useAuth();
  const { toast } = useToast();
  const isAdmin = user?.role === 'admin' || JSON.parse(localStorage.getItem('user') || '{}').role === 'admin';
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [tab, setTab] = useState('devices');
  const [planReq, setPlanReq] = useState(null);
  const dataRef = useRef(null);

  const load = useCallback(async ({ smart = true, quiet = false } = {}) => {
    if (!quiet) setLoading(true);
    setError(null);
    try {
      const next = await api.storage.overview({ smart });
      // A quick (smart=0) refresh reports SMART as "not collected"; keep the
      // last collected verdict per device instead of downgrading the badges.
      const prev = dataRef.current;
      if (!smart && prev?.devices) {
        next.devices = (next.devices || []).map((d) => {
          const old = prev.devices.find((x) => x.path === d.path || (d.serial && x.serial === d.serial));
          return old?.smart?.available && !d.smart?.available ? { ...d, smart: old.smart, smart_verdict: old.smart_verdict } : d;
        });
      }
      dataRef.current = next;
      setData(next);
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : (err?.message || 'failed to load');
      setError(msg);
      if (!quiet) toast({ title: 'Could not load storage inventory', description: msg, variant: 'destructive' });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => { if (isAdmin) load(); }, [isAdmin, load]);

  // Preflight & install: one fetch feeds both the header banner and the
  // panel at the top of the Devices tab.
  const preflight = usePreflight({ enabled: isAdmin });
  const alerts = useMemo(() => computeAlerts(data), [data]);
  const onPlan = useCallback((req) => setPlanReq({ ...req, _t: Date.now() }), []);
  const onDone = useCallback(() => { load({ smart: false, quiet: true }); }, [load]);

  if (!isAdmin) return <Navigate to="/" replace />;

  const tabs = [
    { value: 'devices', label: 'Devices', icon: HardDrive },
    { value: 'pools', label: 'Pools', icon: Layers },
    { value: 'datasets', label: 'Datasets', icon: Database },
    { value: 'snapshots', label: 'Snapshots', icon: Camera },
    { value: 'backup', label: 'Backup & replication', icon: Archive },
    { value: 'history', label: 'History', icon: History },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div className="flex items-center gap-2 flex-wrap min-w-0">
          <Database className="h-5 w-5 text-primary" />
          <h1 className="text-lg font-semibold">Storage</h1>
          {data?.collected_at && <span className="text-xs text-muted-foreground" title={fmtDate(data.collected_at)}>inventory {fmtDate(data.collected_at)}</span>}
        </div>
        <Button variant="outline" className={BTN} onClick={() => load()} disabled={loading}>
          <RefreshCw className={`h-4 w-4 mr-1.5 ${loading ? 'animate-spin' : ''}`} />Refresh
        </Button>
      </div>

      <ToolchainStrip toolchain={data?.toolchain} agent={data?.agent} />
      <PreflightBanner state={preflight} onGoDevices={() => setTab('devices')} />
      {data?.toolchain?.zfs === false && !preflight.pf?.can_install && (
        <Notice level="warn"><p>ZFS is not installed on the host. Run <code className="font-mono">scripts/install-storage.sh</code> on the host to install zfs, smartmontools, sanoid and syncoid. Disks are still listed below.</p></Notice>
      )}
      {error && <Notice level="error"><p>{error}</p></Notice>}
      {data?.warnings?.length > 0 && (
        <Notice level="warn">{data.warnings.map((w, i) => <p key={i} className="break-words">{w}</p>)}</Notice>
      )}

      {loading && !data ? (
        <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground py-12"><Loader2 className="h-4 w-4 animate-spin" />Collecting the host inventory…</div>
      ) : data ? (
        <>
          <ManagedSummary data={data} onGoDevices={() => setTab('devices')} />
          <AlertsStrip alerts={alerts} />

          <Tabs value={tab} onValueChange={setTab} className="w-full">
            {/* MOBILE_FIRST.md §7: six triggers scroll horizontally inside the bar on phones. */}
            <TabsList className="flex h-auto w-full max-w-full justify-start overflow-x-auto">
              {tabs.map((t) => (
                <TabsTrigger key={t.value} value={t.value} className="shrink-0 h-10">
                  <t.icon className="h-4 w-4 mr-1.5" />{t.label}
                </TabsTrigger>
              ))}
            </TabsList>
            <TabsContent value="devices" className="space-y-4">
              <PreflightPanel state={preflight} onInstalled={() => load()} />
              <DevicesTab data={data} onPlan={onPlan} />
            </TabsContent>
            <TabsContent value="pools"><PoolsTab data={data} onPlan={onPlan} /></TabsContent>
            <TabsContent value="datasets"><DatasetsTab data={data} onPlan={onPlan} /></TabsContent>
            <TabsContent value="snapshots"><SnapshotsTab data={data} onPlan={onPlan} /></TabsContent>
            <TabsContent value="backup"><BackupTab data={data} onPlan={onPlan} /></TabsContent>
            <TabsContent value="history"><HistoryTab data={data} /></TabsContent>
          </Tabs>
        </>
      ) : (
        <>
          {/* The inventory failed, so the tabs are gone. The install panel is
              exactly what an operator needs here, so keep it reachable. */}
          <PreflightPanel state={preflight} onInstalled={() => load()} />
          <Card><CardContent className="p-6 text-center text-sm text-muted-foreground">Inventory unavailable. <Button variant="link" className="px-1" onClick={() => load()}>Try again</Button></CardContent></Card>
        </>
      )}

      <PlanDialog request={planReq} onClose={() => setPlanReq(null)} onDone={onDone} />
    </div>
  );
}
