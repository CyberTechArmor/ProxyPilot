// Storage → Pools: health, capacity, scrub state and the vdev tree per
// imported pool (parse.js parseZpoolList/parseZpoolStatus + freshness.pools),
// plus the managed pool's Incus binding and the guest-move action.

import { useState } from 'react';
import { ArrowRightLeft, Boxes, Clock, Download, Layers, Pause, Play, Square, Star, Upload, Wrench } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { BTN, CapacityBar, Checkbox, Chip, DIALOG_BODY, DIALOG_LG, DIALOG_SM, EmptyState, HealthChip, KV, Notice, SectionHeader, StatusChip, fmtBytes, fmtDate } from './shared';

function VdevTree({ status }) {
  const groups = status?.vdevs || [];
  if (!groups.length) return <p className="text-xs text-muted-foreground">No vdev information (zpool status unavailable).</p>;
  const Leaf = ({ d }) => (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs py-1 min-w-0">
      <span className="font-mono break-all min-w-0">{d.path || d.name}</span>
      <HealthChip health={d.state} />
      <span className="font-mono text-muted-foreground" title="read / write / checksum errors">R {d.read_errors ?? 0} · W {d.write_errors ?? 0} · CKSUM {d.cksum_errors ?? 0}</span>
      {d.note && <span className="text-muted-foreground break-words">{d.note}</span>}
    </li>
  );
  return (
    <div className="space-y-2">
      {groups.map((g, gi) => (
        <div key={`${g.name}-${gi}`}>
          {g.type !== 'single' && (
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="font-mono font-medium">{g.name}</span>
              <Chip>{g.type}</Chip>
              {g.class && g.class !== 'data' && <Chip level="accent">{g.class}</Chip>}
              <HealthChip health={g.state} />
            </div>
          )}
          <ul className={g.type !== 'single' ? 'ml-2 border-l pl-3' : ''}>
            {g.devices.map((d, di) => <Leaf key={`${d.name}-${di}`} d={d} />)}
          </ul>
        </div>
      ))}
    </div>
  );
}

function IncusPoolDialog({ pool, incusPools, onClose, onPlan }) {
  const bound = incusPools.find((p) => p.driver === 'zfs' && p.source && p.source.split('/')[0] === pool);
  const [name, setName] = useState(bound?.name || 'zfs');
  const [dataset, setDataset] = useState(bound?.source || `${pool}/incus`);
  const [setDefault, setSetDefault] = useState(true);
  const ok = /^[a-zA-Z0-9][a-zA-Z0-9-]{0,62}$/.test(name) && dataset.startsWith(`${pool}/`);
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className={DIALOG_SM}>
        <DialogHeader>
          <DialogTitle>Incus storage pool on {pool}</DialogTitle>
          <DialogDescription className="text-left">Creates (or keeps) an Incus zfs storage pool backed by a dataset and points the default profile's root disk at it.</DialogDescription>
        </DialogHeader>
        <div className={DIALOG_BODY}>
          <div className="space-y-1">
            <Label htmlFor="ip-name">Incus pool name</Label>
            <Input id="ip-name" value={name} onChange={(e) => setName(e.target.value.trim())} className="font-mono" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="ip-ds">Dataset</Label>
            <Input id="ip-ds" value={dataset} onChange={(e) => setDataset(e.target.value.trim())} className="font-mono" />
            <p className="text-xs text-muted-foreground">Must exist and be empty (create_dataset first if needed). Convention: {pool}/incus.</p>
          </div>
          <Checkbox checked={setDefault} onChange={setSetDefault} label="Make it the default profile's root pool" />
        </div>
        <DialogFooter className="gap-2 pt-2 border-t">
          <Button type="button" variant="ghost" className={BTN} onClick={onClose}>Cancel</Button>
          <Button type="button" className={BTN} disabled={!ok} onClick={() => { onPlan({ op: 'set_incus_storage_pool', params: { name, dataset, set_default: setDefault }, title: `Incus storage pool ${name}` }); onClose(); }}>Review plan</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function MoveGuestsDialog({ managed, instances, onClose, onPlan }) {
  const target = managed.incus_pool;
  const candidates = instances.filter((i) => i.pool !== target);
  const [picked, setPicked] = useState(() => new Set());
  const [stop, setStop] = useState(false);
  const [startAfter, setStartAfter] = useState(false);
  const toggle = (n) => setPicked((s) => { const x = new Set(s); if (x.has(n)) x.delete(n); else x.add(n); return x; });
  const running = candidates.filter((i) => picked.has(i.name) && i.status === 'Running');
  const ok = picked.size > 0 && (!running.length || stop);
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className={DIALOG_LG}>
        <DialogHeader>
          <DialogTitle>Move guests to {target}</DialogTitle>
          <DialogDescription className="text-left">Each guest is snapshotted, then `incus move --storage {target}`. Running guests must be stopped for the move and are started again afterwards.</DialogDescription>
        </DialogHeader>
        <div className={DIALOG_BODY}>
          {!candidates.length ? <Notice>Every guest already lives on {target}.</Notice> : (
            <div className="divide-y border rounded">
              {candidates.map((i) => (
                <Checkbox key={i.name} className="px-3" checked={picked.has(i.name)} onChange={() => toggle(i.name)}
                  label={<span className="font-mono">{i.name}</span>}
                  hint={`${i.type || 'container'} · ${i.status || '?'} · pool ${i.pool || '—'}`} />
              ))}
            </div>
          )}
          {running.length > 0 && <Checkbox checked={stop} onChange={setStop} label={`Stop ${running.map((r) => r.name).join(', ')} for the move`} hint="They are started again once moved." />}
          <Checkbox checked={startAfter} onChange={setStartAfter} label="Start stopped guests after the move" />
        </div>
        <DialogFooter className="gap-2 pt-2 border-t">
          <Button type="button" variant="ghost" className={BTN} onClick={onClose}>Cancel</Button>
          <Button type="button" className={BTN} disabled={!ok} onClick={() => { onPlan({ op: 'move_guest_storage', params: { guests: [...picked], pool: target, stop, start_after: startAfter }, title: `Move ${picked.size} guest(s) to ${target}` }); onClose(); }}>Review plan</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PoolCard({ pool, fresh, managed, incusPools, onPlan, onIncusDialog, onMoveDialog }) {
  const st = pool.status;
  const isManaged = managed?.pool === pool.name;
  const scrub = fresh?.scrub;
  const boundIncus = incusPools.filter((p) => p.driver === 'zfs' && p.source && p.source.split('/')[0] === pool.name);
  const scrubOp = (action, extra = {}) => onPlan({ op: 'zpool_scrub', params: { pool: pool.name, action, ...extra }, title: `${action === 'start' ? 'Scrub' : action === 'stop' ? 'Stop scrub of' : 'Pause scrub of'} ${pool.name}` });
  return (
    <Card className={isManaged ? 'border-primary/50' : ''}>
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-center gap-2">
          <Layers className="h-5 w-5 text-muted-foreground" />
          <CardTitle className="text-lg font-mono truncate">{pool.name}</CardTitle>
          <HealthChip health={st?.state || pool.health} title={st?.status || undefined} />
          {isManaged && <Chip level="info">managed</Chip>}
          {pool.readonly && <Chip level="warn">read-only</Chip>}
          {boundIncus.map((p) => <Chip key={p.name} level="accent" title={`Incus storage pool on ${p.source}`}>incus:{p.name}</Chip>)}
        </div>
        {st?.status && <p className="text-xs text-muted-foreground break-words">{st.status}{st.action ? ` ${st.action}` : ''}</p>}
      </CardHeader>
      <CardContent className="space-y-3">
        <CapacityBar pct={pool.capacity_pct} />
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1">
          <KV label="Size">{fmtBytes(pool.size_bytes)}</KV>
          <KV label="Free">{fmtBytes(pool.free_bytes)}</KV>
          <KV label="Allocated">{fmtBytes(pool.allocated_bytes)}</KV>
          <KV label="Fragmentation">{pool.fragmentation_pct == null ? '—' : `${pool.fragmentation_pct}%`}</KV>
          <KV label="ashift">{pool.ashift ?? '—'}</KV>
          <KV label="Dedup ratio">{pool.dedup_ratio == null ? '—' : `${pool.dedup_ratio}x`}</KV>
        </div>

        <div className="text-sm space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-muted-foreground text-xs uppercase tracking-wide">Scrub</span>
            {scrub ? <StatusChip status={scrub.status} /> : <Chip>unknown</Chip>}
            {scrub?.in_progress && <span className="text-xs font-mono">{scrub.percent ?? '?'}% done{st?.scan?.to_go ? `, ${st.scan.to_go} to go` : ''}</span>}
            {!scrub?.in_progress && scrub?.last_at && <span className="text-xs" title={fmtDate(scrub.last_at)}>last {scrub.age} ago</span>}
            {!scrub?.in_progress && scrub && !scrub.last_at && <span className="text-xs text-muted-foreground">never scrubbed</span>}
            {scrub?.errors > 0 && <Chip level="fail">{scrub.errors} error(s)</Chip>}
            {fresh?.device_errors > 0 && <Chip level="fail">{fresh.device_errors} device error(s)</Chip>}
          </div>
          {fresh?.data_errors && <p className="text-xs text-red-500 break-words">{fresh.data_errors}</p>}
          {st?.scan?.text && !scrub?.in_progress && <p className="text-xs text-muted-foreground break-words">{st.scan.text}</p>}
        </div>

        <div>
          <div className="text-xs uppercase tracking-wide text-muted-foreground mb-1">Devices</div>
          <VdevTree status={st} />
        </div>

        {isManaged && (
          <div className="border-t pt-3 space-y-1">
            <div className="text-xs uppercase tracking-wide text-muted-foreground">Managed layout</div>
            <KV label="Incus storage pool">{managed.incus_pool || 'not bound yet'}</KV>
            <KV label="Guests dataset">{managed.datasets?.incus}</KV>
            <KV label="Backups dataset">{managed.datasets?.backups}</KV>
            <KV label="Exports dataset">{managed.datasets?.exports}</KV>
          </div>
        )}

        <div className="flex gap-2 flex-wrap pt-1 border-t">
          {scrub?.in_progress ? (
            <>
              <Button variant="outline" size="sm" className={BTN} onClick={() => scrubOp('pause')}><Pause className="h-4 w-4 mr-1.5" />Pause scrub</Button>
              <Button variant="outline" size="sm" className={BTN} onClick={() => scrubOp('stop')}><Square className="h-4 w-4 mr-1.5" />Stop scrub</Button>
            </>
          ) : (
            <Button variant="outline" size="sm" className={BTN} onClick={() => scrubOp('start')}><Play className="h-4 w-4 mr-1.5" />Scrub now</Button>
          )}
          <Button variant="outline" size="sm" className={BTN} title="Starts a scrub and enables proxypilot-zfs-scrub@<pool>.timer (monthly)" onClick={() => onPlan({ op: 'zpool_scrub', params: { pool: pool.name, action: 'start', timer: true }, title: `Enable monthly scrub timer for ${pool.name}` })}>
            <Clock className="h-4 w-4 mr-1.5" />Enable monthly scrub
          </Button>
          {!isManaged && (
            <Button variant="outline" size="sm" className={BTN} onClick={() => onPlan({ op: 'set_managed_pool', params: { pool: pool.name }, title: `Manage pool ${pool.name}` })}>
              <Wrench className="h-4 w-4 mr-1.5" />Set as managed pool
            </Button>
          )}
          <Button variant="outline" size="sm" className={BTN} onClick={() => onIncusDialog(pool.name)}>
            <Boxes className="h-4 w-4 mr-1.5" />Set as Incus storage pool
          </Button>
          {isManaged && (
            <Button variant="outline" size="sm" className={BTN} disabled={!managed.incus_pool} title={managed.incus_pool ? undefined : 'Bind an Incus storage pool first'} onClick={onMoveDialog}>
              <ArrowRightLeft className="h-4 w-4 mr-1.5" />Move guests
            </Button>
          )}
          <Button variant="outline" size="sm" className={`${BTN} text-red-500 hover:text-red-600`} onClick={() => onPlan({ op: 'export_pool', params: { pool: pool.name }, title: `Export pool ${pool.name}` })}>
            <Upload className="h-4 w-4 mr-1.5" />Export
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

export default function PoolsTab({ data, onPlan }) {
  const pools = data?.pools || [];
  const importable = data?.importable || [];
  const managed = data?.managed || null;
  const incusPools = data?.incus?.pools || [];
  const instances = data?.incus?.instances || [];
  const freshPools = data?.freshness?.pools || [];
  const [incusDialogPool, setIncusDialogPool] = useState(null);
  const [moveOpen, setMoveOpen] = useState(false);
  const defaultRoot = data?.incus?.default_profile_root;

  return (
    <div className="space-y-4">
      <SectionHeader title="ZFS pools" description={`${pools.length} imported pool(s)${importable.length ? `, ${importable.length} importable` : ''}.`} />

      {pools.length === 0 ? (
        <EmptyState icon={Layers} title="No imported ZFS pools" hint={data?.toolchain?.zfs === false ? 'ZFS is not installed on the host (run scripts/install-storage.sh).' : 'Select eligible disks under Devices and create a pool, or import an exported one below.'} />
      ) : (
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
          {pools.map((p) => (
            <PoolCard key={p.name} pool={p} fresh={freshPools.find((f) => f.name === p.name)} managed={managed} incusPools={incusPools} onPlan={onPlan}
              onIncusDialog={setIncusDialogPool} onMoveDialog={() => setMoveOpen(true)} />
          ))}
        </div>
      )}

      {importable.length > 0 && (
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-base">Importable pools</CardTitle></CardHeader>
          <CardContent className="space-y-2">
            {importable.map((p) => (
              <div key={p.id || p.name} className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 p-3 border rounded-lg">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2"><span className="font-mono font-medium">{p.name}</span><Chip level={p.state === 'ONLINE' ? 'ok' : 'warn'}>{p.state || '?'}</Chip></div>
                  <p className="text-xs text-muted-foreground break-words">{p.status || 'exported pool'}</p>
                </div>
                <Button variant="outline" className={BTN} onClick={() => onPlan({ op: 'import_pool', params: { pool: p.name, force: p.state !== 'ONLINE' }, title: `Import pool ${p.name}` })}><Download className="h-4 w-4 mr-1.5" />Import</Button>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {(incusPools.length > 0 || defaultRoot) && (
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-base flex items-center gap-2"><Boxes className="h-4 w-4" />Incus storage pools</CardTitle></CardHeader>
          <CardContent className="space-y-2">
            <p className="text-xs text-muted-foreground break-words">
              New guests — containers, VMs, projects and migrations that do not name a pool — land on the
              default. Making another pool the default moves nothing: guests already running stay where they
              are (use Move guests for those).
            </p>
            {incusPools.map((p) => (
              <div key={p.name} className="flex flex-col sm:flex-row sm:items-center gap-2 border rounded p-2.5">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm min-w-0 flex-1">
                  <span className="font-mono font-medium">{p.name}</span>
                  <Chip>{p.driver}</Chip>
                  {p.source && <span className="font-mono text-xs text-muted-foreground break-all">{p.source}</span>}
                  <span className="text-xs text-muted-foreground">used by {p.used_by_count ?? 0}</span>
                  {defaultRoot?.pool === p.name && <Chip level="info">default for new guests</Chip>}
                </div>
                {defaultRoot?.pool !== p.name && (
                  <Button
                    variant="outline" size="sm" className={`${BTN} w-full sm:w-auto`}
                    title={`Point the default profile's root disk at ${p.name} — new guests only`}
                    onClick={() => onPlan({ op: 'set_default_storage_pool', params: { pool: p.name }, title: `Make ${p.name} the default for new guests` })}
                  >
                    <Star className="h-4 w-4 mr-1.5" />Make default
                  </Button>
                )}
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {incusDialogPool && <IncusPoolDialog pool={incusDialogPool} incusPools={incusPools} onClose={() => setIncusDialogPool(null)} onPlan={onPlan} />}
      {moveOpen && managed && <MoveGuestsDialog managed={managed} instances={instances} onClose={() => setMoveOpen(false)} onPlan={onPlan} />}
    </div>
  );
}
