// Storage → Datasets: zfs list (parse.js parseZfsList) joined with the policy
// status from freshness.datasets; New dataset / Set properties (allowlisted
// keys mirror planner.js DATASET_PROP_RULES) / Snapshot now / Destroy.

import { useMemo, useState } from 'react';
import { Camera, Database, Plus, Settings2, Trash2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { BTN, Checkbox, Chip, DIALOG_BODY, DIALOG_LG, DIALOG_SM, EmptyState, KV, Notice, SectionHeader, StatusChip, fmtBytes, guestForDataset } from './shared';

// Settable keys and the values the planner accepts (planner.js DATASET_PROP_RULES).
export const DATASET_PROPS = {
  compression: 'on | off | lz4 | lzjb | zle | gzip[-1…9] | zstd[-N | -fast[-N]]',
  atime: 'on | off', relatime: 'on | off', readonly: 'on | off', exec: 'on | off', setuid: 'on | off', devices: 'on | off', nbmand: 'on | off', overlay: 'on | off',
  quota: 'size (10G, 512M, 1.5T) or none', refquota: 'size or none', reservation: 'size or none', refreservation: 'size or none',
  recordsize: '512 | 1K | … | 128K | … | 16M', mountpoint: '/absolute/path | none | legacy', canmount: 'on | off | noauto',
  snapdir: 'hidden | visible', sync: 'standard | always | disabled', logbias: 'latency | throughput',
  primarycache: 'all | none | metadata', secondarycache: 'all | none | metadata', xattr: 'on | off | sa',
  acltype: 'off | noacl | nfsv4 | posix | posixacl', dnodesize: 'legacy | auto | 1k | 2k | 4k | 8k | 16k', copies: '1 | 2 | 3',
  dedup: 'on | off | verify | sha256[,verify] | sha512[,verify] | skein[,verify] | edonr,verify | blake3[,verify]',
  checksum: 'on | off | fletcher2 | fletcher4 | sha256 | sha512 | skein | edonr | blake3',
  'com.sun:auto-snapshot': 'true | false',
};
const PROP_KEYS = Object.keys(DATASET_PROPS);

function PropRows({ rows, setRows }) {
  const update = (i, patch) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const remove = (i) => setRows(rows.filter((_, j) => j !== i));
  return (
    <div className="space-y-2">
      {rows.map((r, i) => (
        <div key={i} className="grid grid-cols-1 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] gap-2 items-start border sm:border-0 rounded p-2 sm:p-0">
          <Select value={r.key} onValueChange={(v) => update(i, { key: v })}>
            <SelectTrigger><SelectValue placeholder="property" /></SelectTrigger>
            <SelectContent>{PROP_KEYS.map((k) => <SelectItem key={k} value={k}>{k}</SelectItem>)}</SelectContent>
          </Select>
          <div className="space-y-1 min-w-0">
            <Input value={r.value} onChange={(e) => update(i, { value: e.target.value })} placeholder={r.key ? DATASET_PROPS[r.key] : 'value'} className="font-mono" />
            {r.key && <p className="text-[11px] text-muted-foreground break-words">{DATASET_PROPS[r.key]}</p>}
          </div>
          <Button type="button" variant="ghost" className="h-11 w-11 sm:h-10 sm:w-10 p-0 justify-self-end" onClick={() => remove(i)} title="Remove"><X className="h-4 w-4" /></Button>
        </div>
      ))}
      <Button type="button" variant="outline" size="sm" className={BTN} onClick={() => setRows([...rows, { key: '', value: '' }])}><Plus className="h-4 w-4 mr-1.5" />Add property</Button>
    </div>
  );
}

const rowsToProps = (rows) => Object.fromEntries(rows.filter((r) => r.key && r.value.trim()).map((r) => [r.key, r.value.trim()]));

function NewDatasetDialog({ datasets, managed, onClose, onPlan }) {
  const [parent, setParent] = useState(managed?.pool || datasets[0]?.name || '');
  const [child, setChild] = useState('');
  const [rows, setRows] = useState([]);
  const name = parent && child ? `${parent}/${child}` : '';
  const ok = !!parent && /^[A-Za-z0-9_.:-]+(\/[A-Za-z0-9_.:-]+)*$/.test(child) && !datasets.some((d) => d.name === name);
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className={DIALOG_LG}>
        <DialogHeader><DialogTitle>New dataset</DialogTitle><DialogDescription className="text-left">zfs create under an existing dataset, optionally with properties.</DialogDescription></DialogHeader>
        <div className={DIALOG_BODY}>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label>Parent</Label>
              <Select value={parent} onValueChange={setParent}>
                <SelectTrigger><SelectValue placeholder="parent dataset" /></SelectTrigger>
                <SelectContent>{datasets.map((d) => <SelectItem key={d.name} value={d.name}>{d.name}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="nd-child">Name</Label>
              <Input id="nd-child" value={child} onChange={(e) => setChild(e.target.value.trim())} className="font-mono" placeholder="data" autoComplete="off" />
            </div>
          </div>
          {name && <p className="text-xs font-mono break-all">{name}</p>}
          <div className="space-y-1"><Label>Properties (optional)</Label><PropRows rows={rows} setRows={setRows} /></div>
        </div>
        <DialogFooter className="gap-2 pt-2 border-t">
          <Button type="button" variant="ghost" className={BTN} onClick={onClose}>Cancel</Button>
          <Button type="button" className={BTN} disabled={!ok} onClick={() => { const props = rowsToProps(rows); onPlan({ op: 'create_dataset', params: { name, ...(Object.keys(props).length ? { props } : {}) }, title: `Create dataset ${name}` }); onClose(); }}>Review plan</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PropsDialog({ dataset, onClose, onPlan }) {
  const [rows, setRows] = useState([{ key: 'compression', value: dataset.compression || '' }]);
  const props = rowsToProps(rows);
  const current = [
    ['compression', dataset.compression], ['atime', dataset.atime], ['xattr', dataset.xattr], ['recordsize', dataset.recordsize_bytes ? fmtBytes(dataset.recordsize_bytes) : null],
    ['quota', dataset.quota_bytes ? fmtBytes(dataset.quota_bytes) : 'none'], ['refquota', dataset.refquota_bytes ? fmtBytes(dataset.refquota_bytes) : 'none'],
    ['mountpoint', dataset.mountpoint], ['canmount', dataset.canmount], ['readonly', dataset.readonly ? 'on' : 'off'],
  ].filter(([, v]) => v != null);
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className={DIALOG_LG}>
        <DialogHeader><DialogTitle>Set properties</DialogTitle><DialogDescription className="font-mono text-left break-all">{dataset.name}</DialogDescription></DialogHeader>
        <div className={DIALOG_BODY}>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-0.5">{current.map(([k, v]) => <KV key={k} label={k}>{v}</KV>)}</div>
          <PropRows rows={rows} setRows={setRows} />
        </div>
        <DialogFooter className="gap-2 pt-2 border-t">
          <Button type="button" variant="ghost" className={BTN} onClick={onClose}>Cancel</Button>
          <Button type="button" className={BTN} disabled={!Object.keys(props).length} onClick={() => { onPlan({ op: 'set_dataset_props', params: { dataset: dataset.name, props }, title: `Set properties on ${dataset.name}` }); onClose(); }}>Review plan</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SnapshotDialog({ dataset, onClose, onPlan }) {
  const [name, setName] = useState('');
  const [recursive, setRecursive] = useState(false);
  const ok = !name || /^[A-Za-z0-9_.:-]{1,200}$/.test(name);
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className={DIALOG_SM}>
        <DialogHeader><DialogTitle>Snapshot now</DialogTitle><DialogDescription className="font-mono text-left break-all">{dataset.name}</DialogDescription></DialogHeader>
        <div className={DIALOG_BODY}>
          <div className="space-y-1">
            <Label htmlFor="sn-name">Snapshot name (optional)</Label>
            <Input id="sn-name" value={name} onChange={(e) => setName(e.target.value.trim())} className="font-mono" placeholder="pp-manual-<timestamp>" autoComplete="off" />
          </div>
          <Checkbox checked={recursive} onChange={setRecursive} label="Recursive (-r): snapshot every child dataset too" />
        </div>
        <DialogFooter className="gap-2 pt-2 border-t">
          <Button type="button" variant="ghost" className={BTN} onClick={onClose}>Cancel</Button>
          <Button type="button" className={BTN} disabled={!ok} onClick={() => { onPlan({ op: 'zfs_snapshot', params: { dataset: dataset.name, ...(name ? { name } : {}), recursive }, title: `Snapshot ${dataset.name}` }); onClose(); }}>Review plan</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function DatasetsTab({ data, onPlan }) {
  const all = useMemo(() => (data?.datasets || []).filter((d) => d.type !== 'snapshot'), [data]);
  const freshMap = useMemo(() => new Map((data?.freshness?.datasets || []).map((d) => [d.name, d])), [data]);
  const instances = data?.incus?.instances || [];
  const [filter, setFilter] = useState('');
  const [newOpen, setNewOpen] = useState(false);
  const [propsFor, setPropsFor] = useState(null);
  const [snapFor, setSnapFor] = useState(null);
  const list = all.filter((d) => !filter || d.name.toLowerCase().includes(filter.toLowerCase()));

  const destroy = (d) => onPlan({ op: 'destroy_dataset', params: { dataset: d.name }, title: `Destroy dataset ${d.name}` });

  const PolicyCell = ({ d }) => {
    const f = freshMap.get(d.name);
    if (!f) return <span className="text-muted-foreground">—</span>;
    return (
      <span className="inline-flex flex-wrap items-center gap-1">
        {f.class && <Chip level="info">{f.class}</Chip>}
        <StatusChip status={f.status} title={f.last_snapshot_at ? `last snapshot ${f.age} ago (${f.last_snapshot})` : 'no snapshot yet'} />
        {f.policy_enabled === false && <Chip level="warn">disabled</Chip>}
      </span>
    );
  };
  const Actions = ({ d, dense }) => (
    <div className="flex gap-1 flex-wrap">
      <Button variant="ghost" size="sm" className={dense ? 'h-9 w-9 p-0' : BTN} title="Snapshot now" onClick={() => setSnapFor(d)}><Camera className="h-4 w-4" />{!dense && <span className="ml-1.5">Snapshot</span>}</Button>
      <Button variant="ghost" size="sm" className={dense ? 'h-9 w-9 p-0' : BTN} title="Set properties" onClick={() => setPropsFor(d)}><Settings2 className="h-4 w-4" />{!dense && <span className="ml-1.5">Properties</span>}</Button>
      {d.name.includes('/') && (
        <Button variant="ghost" size="sm" className={`${dense ? 'h-9 w-9 p-0' : BTN} text-red-500 hover:text-red-600`} title="Destroy (snapshot + stream to backups first)" onClick={() => destroy(d)}><Trash2 className="h-4 w-4" />{!dense && <span className="ml-1.5">Destroy</span>}</Button>
      )}
    </div>
  );
  const enc = (d) => (d.encryption ? `${d.encryption}${d.keystatus ? ` / ${d.keystatus}` : ''}` : 'off');

  return (
    <div className="space-y-4">
      <SectionHeader title="Datasets" description={`${all.length} filesystem(s) / volume(s).`}>
        <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter by name" className="w-full sm:w-56" />
        <Button className={BTN} onClick={() => setNewOpen(true)} disabled={!all.length}><Plus className="h-4 w-4 mr-1.5" />New dataset</Button>
      </SectionHeader>

      {!all.length ? (
        <EmptyState icon={Database} title="No ZFS datasets" hint={data?.toolchain?.zfs === false ? 'ZFS is not installed on the host.' : 'Create a pool first.'} />
      ) : !list.length ? (
        <EmptyState icon={Database} title="No dataset matches the filter" />
      ) : (
        <>
          {/* Desktop table */}
          <div className="hidden md:block border rounded-lg overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-xs text-muted-foreground">
                <tr>
                  <th className="text-left font-medium p-2">Name</th>
                  <th className="text-right font-medium p-2">Used</th>
                  <th className="text-right font-medium p-2">Avail</th>
                  <th className="text-right font-medium p-2">Refer</th>
                  <th className="text-right font-medium p-2">Quota</th>
                  <th className="text-left font-medium p-2">Compression</th>
                  <th className="text-left font-medium p-2">Encryption</th>
                  <th className="text-left font-medium p-2">Mountpoint</th>
                  <th className="text-left font-medium p-2">Policy</th>
                  <th className="p-2" />
                </tr>
              </thead>
              <tbody className="divide-y">
                {list.map((d) => {
                  const g = guestForDataset(instances, d.name);
                  return (
                    <tr key={d.name} className="align-top">
                      <td className="p-2 font-mono text-xs break-all max-w-[22rem]">
                        {d.name}
                        <div className="flex gap-1 mt-0.5">{d.type === 'volume' && <Chip>zvol</Chip>}{g && <Chip level="ok" title="Incus guest storage">guest {g.name}</Chip>}</div>
                      </td>
                      <td className="p-2 text-right font-mono text-xs whitespace-nowrap">{fmtBytes(d.used_bytes)}</td>
                      <td className="p-2 text-right font-mono text-xs whitespace-nowrap">{fmtBytes(d.available_bytes)}</td>
                      <td className="p-2 text-right font-mono text-xs whitespace-nowrap">{fmtBytes(d.referenced_bytes)}</td>
                      <td className="p-2 text-right font-mono text-xs whitespace-nowrap">{d.quota_bytes ? fmtBytes(d.quota_bytes) : '—'}</td>
                      <td className="p-2 font-mono text-xs whitespace-nowrap">{d.compression || '—'}{d.compress_ratio ? ` (${d.compress_ratio}x)` : ''}</td>
                      <td className="p-2 font-mono text-xs whitespace-nowrap">{enc(d)}</td>
                      <td className="p-2 font-mono text-xs break-all">{d.mountpoint || '—'}{d.mountpoint && d.mountpoint !== 'none' && d.mountpoint !== 'legacy' && !d.mounted ? ' (not mounted)' : ''}</td>
                      <td className="p-2"><PolicyCell d={d} /></td>
                      <td className="p-2"><Actions d={d} dense /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {/* Phone / tablet cards */}
          <div className="md:hidden space-y-3">
            {list.map((d) => {
              const g = guestForDataset(instances, d.name);
              return (
                <Card key={d.name}>
                  <CardContent className="p-4 space-y-2">
                    <div className="font-mono text-sm break-all">{d.name}</div>
                    <div className="flex flex-wrap gap-1">{d.type === 'volume' && <Chip>zvol</Chip>}{g && <Chip level="ok">guest {g.name}</Chip>}<PolicyCell d={d} /></div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-0.5">
                      <KV label="Used">{fmtBytes(d.used_bytes)}</KV>
                      <KV label="Available">{fmtBytes(d.available_bytes)}</KV>
                      <KV label="Referenced">{fmtBytes(d.referenced_bytes)}</KV>
                      <KV label="Quota">{d.quota_bytes ? fmtBytes(d.quota_bytes) : '—'}</KV>
                      <KV label="Compression">{d.compression || '—'}{d.compress_ratio ? ` (${d.compress_ratio}x)` : ''}</KV>
                      <KV label="Encryption">{enc(d)}</KV>
                      <KV label="Mountpoint" className="sm:col-span-2">{d.mountpoint || '—'}</KV>
                    </div>
                    <div className="pt-1 border-t"><Actions d={d} /></div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        </>
      )}

      {newOpen && <NewDatasetDialog datasets={all} managed={data?.managed} onClose={() => setNewOpen(false)} onPlan={onPlan} />}
      {propsFor && <PropsDialog dataset={propsFor} onClose={() => setPropsFor(null)} onPlan={onPlan} />}
      {snapFor && <SnapshotDialog dataset={snapFor} onClose={() => setSnapFor(null)} onPlan={onPlan} />}
      {data?.managed == null && all.length > 0 && <Notice>No managed pool yet — policy classes only apply once a pool is managed (Pools → Set as managed pool).</Notice>}
    </div>
  );
}
