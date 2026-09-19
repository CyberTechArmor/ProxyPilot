// Storage → Snapshots: zfs snapshots (parse.js parseZfsSnapshots, kind from
// the name) filtered by dataset / guest / kind, newest first. Roll back goes
// through rollback_guest_dataset when the dataset is Incus guest storage
// (incus.instances[].dataset), zfs_rollback otherwise; Restore as new guest
// and Destroy snapshot complete the set.

import { useMemo, useState } from 'react';
import { Camera, Copy, RotateCcw, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { BTN, Checkbox, Chip, DIALOG_BODY, DIALOG_SM, EmptyState, KindChip, Notice, SectionHeader, fmtAge, fmtBytes, fmtDate, guestForDataset } from './shared';

const KINDS = ['sanoid', 'syncoid', 'incus', 'proxypilot', 'manual'];
const PAGE = 150;

function RollbackDialog({ snap, guest, onClose, onPlan }) {
  const [destroyNewer, setDestroyNewer] = useState(false);
  const [stop, setStop] = useState(!!guest);
  const running = guest?.status === 'Running';
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className={DIALOG_SM}>
        <DialogHeader>
          <DialogTitle>Roll back to snapshot</DialogTitle>
          <DialogDescription className="font-mono text-left break-all">{snap.name}</DialogDescription>
        </DialogHeader>
        <div className={DIALOG_BODY}>
          <Notice level="warn"><p>Everything written to {snap.dataset} after {fmtDate(snap.created_at)} is lost. Restore as new guest is the non-destructive alternative.</p></Notice>
          {guest && <p className="text-sm">This dataset is the storage of guest <span className="font-mono">{guest.name}</span> ({guest.status || '?'}); the guest is {running ? 'stopped for the rollback and started again' : 'left stopped'}.</p>}
          {running && <Checkbox checked={stop} onChange={setStop} label={`Stop ${guest.name} for the rollback`} hint="Required while the guest is running." />}
          <Checkbox checked={destroyNewer} onChange={setDestroyNewer} label="Destroy newer snapshots (-r)" hint="Required when snapshots exist after this one; the plan lists them." />
        </div>
        <DialogFooter className="gap-2 pt-2 border-t">
          <Button type="button" variant="ghost" className={BTN} onClick={onClose}>Cancel</Button>
          <Button type="button" variant="destructive" className={BTN} disabled={running && !stop} onClick={() => {
            if (guest) onPlan({ op: 'rollback_guest_dataset', params: { guest: guest.name, snapshot: snap.name, stop, destroy_newer: destroyNewer }, title: `Roll back guest ${guest.name}` });
            else onPlan({ op: 'zfs_rollback', params: { snapshot: snap.name, destroy_newer: destroyNewer }, title: `Roll back ${snap.dataset}` });
            onClose();
          }}>Review plan</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RestoreDialog({ snap, guest, onClose, onPlan }) {
  const [name, setName] = useState(`${guest.name}-restored`);
  const [start, setStart] = useState(false);
  const ok = /^[a-zA-Z0-9][a-zA-Z0-9-]{0,62}$/.test(name) && name !== guest.name;
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className={DIALOG_SM}>
        <DialogHeader>
          <DialogTitle>Restore as new guest</DialogTitle>
          <DialogDescription className="font-mono text-left break-all">{snap.name}</DialogDescription>
        </DialogHeader>
        <div className={DIALOG_BODY}>
          <div className="space-y-1">
            <Label htmlFor="rs-name">New guest name</Label>
            <Input id="rs-name" value={name} onChange={(e) => setName(e.target.value.trim())} className="font-mono" autoComplete="off" />
            <p className="text-xs text-muted-foreground">Letters, digits, hyphens; must differ from {guest.name}. The copy keeps the source config (static IP, proxy devices) — adjust before routing to it.</p>
          </div>
          <Checkbox checked={start} onChange={setStart} label="Start the new guest afterwards" />
        </div>
        <DialogFooter className="gap-2 pt-2 border-t">
          <Button type="button" variant="ghost" className={BTN} onClick={onClose}>Cancel</Button>
          <Button type="button" className={BTN} disabled={!ok} onClick={() => { onPlan({ op: 'restore_guest_from_snapshot', params: { guest: guest.name, snapshot: snap.name, new_name: name, start }, title: `Restore ${guest.name} → ${name}` }); onClose(); }}>Review plan</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function SnapshotsTab({ data, onPlan }) {
  const instances = data?.incus?.instances || [];
  const all = useMemo(() => [...(data?.snapshots || [])].sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || ''))), [data]);
  const datasetNames = useMemo(() => [...new Set(all.map((s) => s.dataset))].sort(), [all]);
  const guests = useMemo(() => instances.filter((i) => i.dataset), [instances]);
  const [dataset, setDataset] = useState('all');
  const [guest, setGuest] = useState('all');
  const [kinds, setKinds] = useState(() => new Set(KINDS));
  const [limit, setLimit] = useState(PAGE);
  const [rollback, setRollback] = useState(null);
  const [restore, setRestore] = useState(null);

  const guestDs = guest !== 'all' ? guests.find((g) => g.name === guest)?.dataset : null;
  const list = all.filter((s) => (dataset === 'all' || s.dataset === dataset || s.dataset.startsWith(`${dataset}/`)) && (!guestDs || s.dataset === guestDs) && kinds.has(s.kind));
  const shown = list.slice(0, limit);
  const toggleKind = (k) => setKinds((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; });

  const Row = ({ s, dense }) => {
    const g = guestForDataset(instances, s.dataset);
    const actions = (
      <div className="flex gap-1 flex-wrap">
        <Button variant="ghost" size="sm" className={dense ? 'h-9 w-9 p-0' : BTN} title="Roll back" onClick={() => setRollback({ snap: s, guest: g })}><RotateCcw className="h-4 w-4" />{!dense && <span className="ml-1.5">Roll back</span>}</Button>
        {g && <Button variant="ghost" size="sm" className={dense ? 'h-9 w-9 p-0' : BTN} title="Restore as new guest" onClick={() => setRestore({ snap: s, guest: g })}><Copy className="h-4 w-4" />{!dense && <span className="ml-1.5">Restore as new guest</span>}</Button>}
        <Button variant="ghost" size="sm" className={`${dense ? 'h-9 w-9 p-0' : BTN} text-red-500 hover:text-red-600`} title={s.kind === 'incus' ? 'Incus snapshots are deleted from the Incus page so Incus stays consistent' : s.clones?.length ? 'has clones' : 'Destroy snapshot'} disabled={s.kind === 'incus' || s.clones?.length > 0}
          onClick={() => onPlan({ op: 'destroy_zfs_snapshot', params: { snapshot: s.name }, title: `Destroy snapshot ${s.snapshot}` })}><Trash2 className="h-4 w-4" />{!dense && <span className="ml-1.5">Destroy</span>}</Button>
      </div>
    );
    if (dense) {
      return (
        <tr className="align-top">
          <td className="p-2 font-mono text-xs break-all max-w-[26rem]"><span className="text-muted-foreground">{s.dataset}@</span>{s.snapshot}{g && <div className="mt-0.5"><Chip level="ok">guest {g.name}</Chip></div>}</td>
          <td className="p-2"><KindChip kind={s.kind} /></td>
          <td className="p-2 text-xs whitespace-nowrap" title={fmtDate(s.created_at)}>{fmtAge(s.created_at)} ago<div className="text-muted-foreground">{fmtDate(s.created_at)}</div></td>
          <td className="p-2 text-right font-mono text-xs whitespace-nowrap">{fmtBytes(s.used_bytes)}</td>
          <td className="p-2 text-right font-mono text-xs whitespace-nowrap">{fmtBytes(s.referenced_bytes)}</td>
          <td className="p-2 text-xs">{s.clones?.length ? s.clones.join(', ') : ''}{s.holds ? ` holds ${s.holds}` : ''}</td>
          <td className="p-2">{actions}</td>
        </tr>
      );
    }
    return (
      <Card>
        <CardContent className="p-4 space-y-2">
          <div className="font-mono text-sm break-all"><span className="text-muted-foreground">{s.dataset}@</span>{s.snapshot}</div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
            <KindChip kind={s.kind} />
            {g && <Chip level="ok">guest {g.name}</Chip>}
            <span title={fmtDate(s.created_at)}>{fmtAge(s.created_at)} ago</span>
            <span className="font-mono">used {fmtBytes(s.used_bytes)}</span>
            <span className="font-mono">refer {fmtBytes(s.referenced_bytes)}</span>
            {s.clones?.length > 0 && <span className="text-muted-foreground break-all">clones {s.clones.join(', ')}</span>}
          </div>
          <div className="pt-1 border-t">{actions}</div>
        </CardContent>
      </Card>
    );
  };

  return (
    <div className="space-y-4">
      <SectionHeader title="Snapshots" description={`${all.length} snapshot(s) on the host; ${list.length} match the filters.`} />
      <div className="flex flex-col sm:flex-row sm:flex-wrap gap-2">
        <Select value={dataset} onValueChange={(v) => { setDataset(v); setLimit(PAGE); }}>
          <SelectTrigger className="w-full sm:w-64"><SelectValue placeholder="Dataset" /></SelectTrigger>
          <SelectContent><SelectItem value="all">All datasets</SelectItem>{datasetNames.map((d) => <SelectItem key={d} value={d}>{d}</SelectItem>)}</SelectContent>
        </Select>
        <Select value={guest} onValueChange={(v) => { setGuest(v); setLimit(PAGE); }}>
          <SelectTrigger className="w-full sm:w-48"><SelectValue placeholder="Guest" /></SelectTrigger>
          <SelectContent><SelectItem value="all">All guests</SelectItem>{guests.map((g) => <SelectItem key={g.name} value={g.name}>{g.name}</SelectItem>)}</SelectContent>
        </Select>
        <div className="flex flex-wrap gap-1">
          {KINDS.map((k) => (
            <Button key={k} type="button" variant={kinds.has(k) ? 'secondary' : 'outline'} size="sm" className="h-11 sm:h-9" onClick={() => toggleKind(k)} aria-pressed={kinds.has(k)}>{k}</Button>
          ))}
        </div>
      </div>

      {!all.length ? (
        <EmptyState icon={Camera} title="No snapshots" hint="sanoid takes them on schedule once a backup policy is set; Datasets → Snapshot now takes one immediately." />
      ) : !list.length ? (
        <EmptyState icon={Camera} title="Nothing matches the filters" />
      ) : (
        <>
          <div className="hidden md:block border rounded-lg overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-xs text-muted-foreground">
                <tr>
                  <th className="text-left font-medium p-2">Snapshot</th>
                  <th className="text-left font-medium p-2">Kind</th>
                  <th className="text-left font-medium p-2">Created</th>
                  <th className="text-right font-medium p-2">Used</th>
                  <th className="text-right font-medium p-2">Refer</th>
                  <th className="text-left font-medium p-2">Clones</th>
                  <th className="p-2" />
                </tr>
              </thead>
              <tbody className="divide-y">{shown.map((s) => <Row key={s.name} s={s} dense />)}</tbody>
            </table>
          </div>
          <div className="md:hidden space-y-3">{shown.map((s) => <Row key={s.name} s={s} />)}</div>
          {list.length > shown.length && (
            <div className="flex justify-center"><Button variant="outline" className={BTN} onClick={() => setLimit((l) => l + PAGE)}>Show more ({list.length - shown.length} left)</Button></div>
          )}
        </>
      )}

      {rollback && <RollbackDialog snap={rollback.snap} guest={rollback.guest} onClose={() => setRollback(null)} onPlan={onPlan} />}
      {restore && <RestoreDialog snap={restore.snap} guest={restore.guest} onClose={() => setRestore(null)} onPlan={onPlan} />}
    </div>
  );
}
