// Storage → Devices: one card per whole disk (lib/storage/parse.js
// buildDeviceInventory + deviceEligibility), a multi-select feeding the
// Create pool dialog, Import pool for exported pools found on the disks,
// and Replace disk for pool members. Every action ends in <PlanDialog>.

import { useMemo, useState } from 'react';
import { Disc3, Download, HardDrive, Plus, Replace } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { BTN, Checkbox, Chip, DIALOG_BODY, DIALOG_LG, DIALOG_SM, EmptyState, KV, Notice, SectionHeader, SmartChip, fmtBytes } from './shared';

// Mirrors planner.js LAYOUTS (min devices per vdev) for early client-side validation.
const LAYOUTS = {
  single: { min: 1, label: 'Single / stripe (no redundancy)' },
  mirror: { min: 2, label: 'Mirror' },
  raidz1: { min: 3, label: 'RAID-Z1 (single parity)' },
  raidz2: { min: 4, label: 'RAID-Z2 (double parity)' },
  raidz3: { min: 5, label: 'RAID-Z3 (triple parity)' },
};
const COMPRESSIONS = ['zstd', 'lz4', 'zstd-3', 'gzip', 'on', 'off'];
const POOL_NAME_RE = /^[A-Za-z][A-Za-z0-9_.:-]{0,254}$/;

const primaryId = (d) => (d.by_id || [])[0] || null;
const selectable = (d) => !!primaryId(d) && (d.eligibility?.eligible || d.eligibility_with_wipe);

function SmartLine({ smart }) {
  if (!smart?.available) return null;
  const bits = [];
  if (smart.temperature_c != null) bits.push(`${smart.temperature_c}°C`);
  if (smart.power_on_hours != null) bits.push(`${smart.power_on_hours} h on`);
  if (smart.reallocated_sectors != null) bits.push(`realloc ${smart.reallocated_sectors}`);
  if (smart.pending_sectors != null) bits.push(`pending ${smart.pending_sectors}`);
  if (smart.percentage_used != null) bits.push(`${smart.percentage_used}% used`);
  if (smart.media_errors != null) bits.push(`media err ${smart.media_errors}`);
  return bits.length ? <p className="text-xs text-muted-foreground font-mono break-words">{bits.join(' · ')}</p> : null;
}

function DeviceCard({ d, selected, onToggle }) {
  const e = d.eligibility || { eligible: false, hard: [], soft: [], warnings: [], needs_wipe: false };
  const canSelect = selectable(d);
  return (
    <Card className={selected ? 'border-primary/60' : ''}>
      <CardHeader className="pb-2">
        <div className="flex items-start gap-3">
          {canSelect ? (
            <label className="flex items-center min-h-[44px] -my-2 cursor-pointer" title="Select for a new pool">
              <input type="checkbox" className="h-5 w-5 accent-primary" checked={selected} onChange={() => onToggle(d)} />
            </label>
          ) : <HardDrive className="h-5 w-5 mt-0.5 text-muted-foreground shrink-0" />}
          <div className="min-w-0 flex-1 space-y-1">
            <CardTitle className="text-base truncate" title={d.model || d.name}>{d.model || d.name}</CardTitle>
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="font-mono text-xs">{d.path}</span>
              <span className="text-xs text-muted-foreground">{fmtBytes(d.size_bytes)}</span>
              {d.os && <Chip level="fail" title={d.os_reason || 'backs the operating system'}>OS</Chip>}
              <SmartChip verdict={d.smart_verdict} />
              {d.transport && <Chip>{d.transport}</Chip>}
              <Chip>{d.rotational ? 'HDD' : 'SSD'}</Chip>
              {d.removable && <Chip level="warn">removable</Chip>}
              {d.read_only && <Chip level="warn">read-only</Chip>}
              {d.in_pool && <Chip level="info" title="member of an imported pool">pool {d.in_pool}</Chip>}
              {d.importable_pool && <Chip level="accent" title={`exported pool, state ${d.importable_pool.state || '?'}`}>importable {d.importable_pool.name}</Chip>}
              {(d.signatures || []).map((s) => <Chip key={s} mono title="signature found by blkid">{s}</Chip>)}
            </div>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1">
          <KV label="Serial">{d.serial || '—'}</KV>
          <KV label="by-id">{primaryId(d) ? primaryId(d).replace('/dev/disk/by-id/', '') : '—'}</KV>
        </div>
        <SmartLine smart={d.smart} />
        {d.partitions?.length > 0 && (
          <div className="text-xs space-y-0.5">
            <div className="text-muted-foreground">Partitions</div>
            {d.partitions.map((p) => (
              <div key={p.path} className="flex flex-wrap items-center gap-x-3 gap-y-0.5 font-mono">
                <span>{p.name}</span>
                <span className="text-muted-foreground">{fmtBytes(p.size_bytes)}</span>
                {p.fstype && <span>{p.fstype}</span>}
                {p.mountpoints?.length > 0 && <span className="text-muted-foreground break-all">{p.mountpoints.join(', ')}</span>}
              </div>
            ))}
          </div>
        )}
        {d.mounted && d.mounted_at?.length > 0 && !d.partitions?.length && (
          <p className="text-xs text-muted-foreground break-all">Mounted at {d.mounted_at.join(', ')}</p>
        )}
        <div className="pt-1 border-t text-xs space-y-1">
          {e.eligible && <p className="text-emerald-500">Eligible for a new pool.</p>}
          {!e.eligible && e.needs_wipe && (
            <p className="text-amber-500">Needs wipe: {e.soft.join('; ')}.</p>
          )}
          {!e.eligible && !e.needs_wipe && e.hard.length > 0 && (
            <p className="text-muted-foreground">Not eligible: {e.hard.join('; ')}.</p>
          )}
          {!primaryId(d) && <p className="text-muted-foreground">No /dev/disk/by-id link — pools are built from stable by-id paths.</p>}
          {e.warnings?.map((w, i) => <p key={i} className="text-amber-500">{w}</p>)}
        </div>
      </CardContent>
    </Card>
  );
}

function CreatePoolDialog({ open, onClose, devices, onPlan }) {
  const [name, setName] = useState('tank');
  const [layout, setLayout] = useState('mirror');
  const [ashift, setAshift] = useState('12');
  const [compression, setCompression] = useState('zstd');
  const [atime, setAtime] = useState('off');
  const [xattr, setXattr] = useState('sa');
  const [encryption, setEncryption] = useState('none');
  const [keyformat, setKeyformat] = useState('raw');
  const [keylocation, setKeylocation] = useState('');
  const [wipe, setWipe] = useState(false);
  const [managed, setManaged] = useState(true);

  const needsWipe = devices.filter((d) => d.eligibility?.needs_wipe);
  const min = LAYOUTS[layout]?.min || 1;
  const problems = [];
  if (!POOL_NAME_RE.test(name)) problems.push('Name: letter first, then letters, digits, _ . : -');
  if (devices.length < min) problems.push(`${LAYOUTS[layout].label} needs at least ${min} device(s); ${devices.length} selected.`);
  if (needsWipe.length && !wipe) problems.push(`${needsWipe.length} selected device(s) carry signatures — tick "wipe" to clear them.`);
  if (encryption === 'keyfile' && !/^\/[^\s]+$/.test(keylocation)) problems.push('Key file: absolute path on the host.');
  const a = Number(ashift);
  if (!Number.isInteger(a) || a < 9 || a > 16) problems.push('ashift: integer 9–16.');

  const submit = () => {
    if (problems.length) return;
    const params = { name, layout, devices: devices.map(primaryId), ashift: a, compression, atime, xattr, wipe: needsWipe.length > 0 && wipe, managed };
    if (encryption === 'passphrase') params.encryption = { keyformat: 'passphrase' };
    if (encryption === 'keyfile') params.encryption = { keyformat, keylocation: `file://${keylocation}` };
    onPlan({ op: 'create_zpool', params, title: `Create pool ${name}` });
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className={DIALOG_LG}>
        <DialogHeader>
          <DialogTitle>Create ZFS pool</DialogTitle>
          <DialogDescription className="text-left">{devices.length} device(s) selected. The commands are shown before anything runs.</DialogDescription>
        </DialogHeader>
        <div className={DIALOG_BODY}>
          <ul className="text-xs font-mono space-y-0.5 bg-muted/60 rounded p-2 max-h-40 overflow-y-auto">
            {devices.map((d) => (
              <li key={d.path} className="flex flex-wrap gap-x-2 break-all">
                <span>{d.path}</span><span className="text-muted-foreground">{d.model} · {fmtBytes(d.size_bytes)}</span>
                {d.eligibility?.needs_wipe && <span className="text-amber-500">needs wipe</span>}
              </li>
            ))}
          </ul>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label htmlFor="cp-name">Pool name</Label>
              <Input id="cp-name" value={name} onChange={(e) => setName(e.target.value.trim())} className="font-mono" autoComplete="off" />
            </div>
            <div className="space-y-1">
              <Label>Layout</Label>
              <Select value={layout} onValueChange={setLayout}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>{Object.entries(LAYOUTS).map(([k, v]) => <SelectItem key={k} value={k}>{v.label} — min {v.min}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="cp-ashift">ashift</Label>
              <Input id="cp-ashift" inputMode="numeric" value={ashift} onChange={(e) => setAshift(e.target.value)} />
              <p className="text-xs text-muted-foreground">12 = 4 KiB sectors (default).</p>
            </div>
            <div className="space-y-1">
              <Label>Compression</Label>
              <Select value={compression} onValueChange={setCompression}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>{COMPRESSIONS.map((c) => <SelectItem key={c} value={c}>{c}{c === 'zstd' ? ' (default)' : ''}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>atime</Label>
              <Select value={atime} onValueChange={setAtime}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="off">off (default)</SelectItem><SelectItem value="on">on</SelectItem></SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>xattr</Label>
              <Select value={xattr} onValueChange={setXattr}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="sa">sa (default)</SelectItem><SelectItem value="on">on</SelectItem><SelectItem value="off">off</SelectItem></SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>Encryption</Label>
              <Select value={encryption} onValueChange={setEncryption}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">none</SelectItem>
                  <SelectItem value="passphrase">passphrase (asked at confirm time)</SelectItem>
                  <SelectItem value="keyfile">key file on the host</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {encryption === 'keyfile' && (
              <>
                <div className="space-y-1">
                  <Label>Key format</Label>
                  <Select value={keyformat} onValueChange={setKeyformat}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent><SelectItem value="raw">raw (32 bytes)</SelectItem><SelectItem value="hex">hex</SelectItem><SelectItem value="passphrase">passphrase in file</SelectItem></SelectContent>
                  </Select>
                </div>
                <div className="space-y-1 sm:col-span-2">
                  <Label htmlFor="cp-key">Key file path (on the host)</Label>
                  <Input id="cp-key" value={keylocation} onChange={(e) => setKeylocation(e.target.value.trim())} placeholder="/etc/zfs/keys/tank.key" className="font-mono" />
                  <p className="text-xs text-muted-foreground">Sent as file://… — ProxyPilot never reads or stores the key.</p>
                </div>
              </>
            )}
          </div>
          <p className="text-xs text-muted-foreground">Also set on the pool: acltype=posixacl, dnodesize=auto.</p>
          {needsWipe.length > 0 && (
            <Checkbox checked={wipe} onChange={setWipe} label={`Wipe existing signatures on ${needsWipe.map((d) => d.path).join(', ')}`} hint="Runs wipefs -a (and zpool labelclear for old ZFS labels) before zpool create. Anything on those disks is gone." />
          )}
          <Checkbox checked={managed} onChange={setManaged} label="Make this the managed pool" hint={`Creates ${name || 'pool'}/incus, /backups and /exports and records the pool as ProxyPilot's managed pool.`} />
          {problems.length > 0 && <Notice level="warn">{problems.map((p, i) => <p key={i}>{p}</p>)}</Notice>}
        </div>
        <DialogFooter className="gap-2 pt-2 border-t">
          <Button type="button" variant="ghost" className={BTN} onClick={onClose}>Cancel</Button>
          <Button type="button" className={BTN} onClick={submit} disabled={problems.length > 0}>Review plan</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ImportPoolDialog({ pool, onClose, onPlan }) {
  const [force, setForce] = useState(false);
  const [readonly, setReadonly] = useState(false);
  if (!pool) return null;
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className={DIALOG_SM}>
        <DialogHeader>
          <DialogTitle>Import pool {pool.name}</DialogTitle>
          <DialogDescription className="text-left">id {pool.id || '?'} · state {pool.state || '?'}{pool.status ? ` · ${pool.status}` : ''}</DialogDescription>
        </DialogHeader>
        <div className={DIALOG_BODY}>
          {pool.devices?.length > 0 && <p className="text-xs font-mono break-all text-muted-foreground">{pool.devices.join(', ')}</p>}
          <Checkbox checked={force} onChange={setForce} label="Force (-f)" hint="Needed when the pool was last used by another system or is not ONLINE." />
          <Checkbox checked={readonly} onChange={setReadonly} label="Import read-only" />
        </div>
        <DialogFooter className="gap-2 pt-2 border-t">
          <Button type="button" variant="ghost" className={BTN} onClick={onClose}>Cancel</Button>
          <Button type="button" className={BTN} onClick={() => { onPlan({ op: 'import_pool', params: { pool: pool.name, force, readonly }, title: `Import pool ${pool.name}` }); onClose(); }}>Review plan</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ReplaceDiskDialog({ open, onClose, pools, devices, onPlan }) {
  const [pool, setPool] = useState('');
  const [member, setMember] = useState('');
  const [device, setDevice] = useState('');
  const [wipe, setWipe] = useState(false);
  const status = pools.find((p) => p.name === pool)?.status;
  const members = (status?.vdevs || []).flatMap((g) => g.devices.map((d) => ({ ...d, group: g })));
  const candidates = devices.filter((d) => selectable(d));
  const chosen = candidates.find((d) => primaryId(d) === device);
  const needsWipe = !!chosen?.eligibility?.needs_wipe;
  const ok = pool && member && device && (!needsWipe || wipe);
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className={DIALOG_LG}>
        <DialogHeader>
          <DialogTitle>Replace a pool member</DialogTitle>
          <DialogDescription className="text-left">zpool replace starts a resilver onto the new device; the old one can be detached once it finishes.</DialogDescription>
        </DialogHeader>
        <div className={DIALOG_BODY}>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label>Pool</Label>
              <Select value={pool} onValueChange={(v) => { setPool(v); setMember(''); }}>
                <SelectTrigger><SelectValue placeholder="Choose a pool" /></SelectTrigger>
                <SelectContent>{pools.map((p) => <SelectItem key={p.name} value={p.name}>{p.name} ({p.status?.state || p.health || '?'})</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>Member to replace</Label>
              <Select value={member} onValueChange={setMember} disabled={!pool}>
                <SelectTrigger><SelectValue placeholder="Choose a member" /></SelectTrigger>
                <SelectContent>{members.map((m) => <SelectItem key={m.name} value={m.name}>{m.name} — {m.state}{m.group.type !== 'single' ? ` (${m.group.name})` : ''}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className="space-y-1 sm:col-span-2">
              <Label>New device</Label>
              <Select value={device} onValueChange={setDevice}>
                <SelectTrigger><SelectValue placeholder={candidates.length ? 'Choose an eligible disk' : 'No eligible disk'} /></SelectTrigger>
                <SelectContent>{candidates.map((d) => <SelectItem key={d.path} value={primaryId(d)}>{d.path} · {d.model || d.name} · {fmtBytes(d.size_bytes)}{d.eligibility?.needs_wipe ? ' · needs wipe' : ''}</SelectItem>)}</SelectContent>
              </Select>
            </div>
          </div>
          {needsWipe && <Checkbox checked={wipe} onChange={setWipe} label={`Wipe signatures on ${chosen.path} first`} hint={chosen.eligibility.soft.join('; ')} />}
        </div>
        <DialogFooter className="gap-2 pt-2 border-t">
          <Button type="button" variant="ghost" className={BTN} onClick={onClose}>Cancel</Button>
          <Button type="button" className={BTN} disabled={!ok} onClick={() => { onPlan({ op: 'replace_disk', params: { pool, old_device: member, new_device: device, wipe: needsWipe && wipe }, title: `Replace ${member} in ${pool}` }); onClose(); }}>Review plan</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function DevicesTab({ data, onPlan }) {
  const devices = data?.devices || [];
  const importable = data?.importable || [];
  const pools = data?.pools || [];
  const [selected, setSelected] = useState(() => new Set());
  const [createOpen, setCreateOpen] = useState(false);
  const [replaceOpen, setReplaceOpen] = useState(false);
  const [importPool, setImportPool] = useState(null);

  const selectedDevices = useMemo(() => devices.filter((d) => selected.has(d.path) && selectable(d)), [devices, selected]);
  const toggle = (d) => setSelected((s) => { const n = new Set(s); if (n.has(d.path)) n.delete(d.path); else n.add(d.path); return n; });
  const eligibleCount = devices.filter(selectable).length;

  return (
    <div className="space-y-4">
      <SectionHeader title="Host drives" description={`${devices.length} whole disk(s); ${eligibleCount} selectable for a new pool. OS disks and pool members are never offered.`}>
        <Button className={BTN} onClick={() => setCreateOpen(true)} disabled={!selectedDevices.length}>
          <Plus className="h-4 w-4 mr-1.5" />Create pool{selectedDevices.length ? ` (${selectedDevices.length})` : ''}
        </Button>
        <Button variant="outline" className={BTN} onClick={() => setReplaceOpen(true)} disabled={!pools.length}>
          <Replace className="h-4 w-4 mr-1.5" />Replace disk
        </Button>
      </SectionHeader>

      {importable.length > 0 && (
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-base flex items-center gap-2"><Disc3 className="h-4 w-4" />Importable pools</CardTitle></CardHeader>
          <CardContent className="space-y-2">
            {importable.map((p) => (
              <div key={p.id || p.name} className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 p-3 border rounded-lg">
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex flex-wrap items-center gap-2"><span className="font-mono font-medium">{p.name}</span><Chip level={p.state === 'ONLINE' ? 'ok' : 'warn'}>{p.state || '?'}</Chip></div>
                  <p className="text-xs text-muted-foreground break-words">{p.status || 'exported pool'}{p.devices?.length ? ` · ${p.devices.join(', ')}` : ''}</p>
                </div>
                <Button variant="outline" className={BTN} onClick={() => setImportPool(p)}><Download className="h-4 w-4 mr-1.5" />Import</Button>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {devices.length === 0 ? (
        <EmptyState icon={HardDrive} title="No disks reported" hint={data?.warnings?.length ? data.warnings.join(' · ') : 'lsblk returned no whole disks.'} />
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {devices.map((d) => <DeviceCard key={d.path} d={d} selected={selected.has(d.path)} onToggle={toggle} />)}
        </div>
      )}

      {createOpen && <CreatePoolDialog open onClose={() => setCreateOpen(false)} devices={selectedDevices} onPlan={onPlan} />}
      {replaceOpen && <ReplaceDiskDialog open onClose={() => setReplaceOpen(false)} pools={pools} devices={devices} onPlan={onPlan} />}
      <ImportPoolDialog pool={importPool} onClose={() => setImportPool(null)} onPlan={onPlan} />
    </div>
  );
}
