// Start a migration: pick the mode and the guest it lands in, get back the
// one line the operator pastes on the source host.
//
// The dialog is deliberately two screens, not a wizard: a form, then the
// command. The command screen is the product of this dialog — the token is
// shown ONCE and is never recoverable, so it stays up until the operator
// dismisses it.

import { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Loader2, Terminal } from 'lucide-react';
import { ApiError, api } from '@/lib/api';
import { BTN, DIALOG_BODY, DIALOG_LG, Checkbox, CopyButton, Notice } from './shared';

const MODES = [
  { value: 'whole-machine', label: 'Whole machine', hint: 'A physical host, a VM on any hypervisor (including Proxmox) or an LXC. Wraps the official incus-migrate; a Proxmox LXC takes the rootfs-tar path automatically.' },
  { value: 'application', label: 'Application (adopt)', hint: 'Leave the source running. A fresh guest is created and the application directories, database and vhost come across.' },
];

export default function NewMigrationDialog({ open, onClose, onCreated }) {
  const [form, setForm] = useState({
    mode: 'whole-machine', name: '', type: 'container', source_kind: '', source_label: '',
    cpu: 2, memory_gb: 4, disk_gb: '', pool: '', network: '', nested: false,
    image: 'images:debian/13', app_dirs: '', database: 'none', service_name: '', freeze: 'stop',
    auto_transfer: false, keep_agent: false,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [created, setCreated] = useState(null);
  const set = (k) => (v) => setForm((f) => ({ ...f, [k]: v }));

  const submit = async () => {
    setBusy(true); setError(null);
    try {
      const body = {
        mode: form.mode, name: form.name.trim(), type: form.type,
        cpu: Number(form.cpu), memory_gb: Number(form.memory_gb),
        nested: !!form.nested, freeze: form.freeze,
        auto_transfer: !!form.auto_transfer, keep_agent: !!form.keep_agent,
      };
      if (form.disk_gb) body.disk_gb = Number(form.disk_gb);
      if (form.pool.trim()) body.pool = form.pool.trim();
      if (form.network.trim()) body.network = form.network.trim();
      if (form.source_kind) body.source_kind = form.source_kind;
      if (form.source_label.trim()) body.source_label = form.source_label.trim();
      if (form.mode === 'application') {
        body.image = form.image.trim() || 'images:debian/13';
        body.database = form.database;
        if (form.service_name.trim()) body.service_name = form.service_name.trim();
        const dirs = form.app_dirs.split('\n').map((s) => s.trim()).filter(Boolean);
        if (dirs.length) body.app_dirs = dirs;
      }
      const r = await api.migrations.create(body);
      setCreated(r);
      onCreated?.(r);
    } catch (e) {
      setError(e instanceof ApiError ? (e.body?.error || e.message) : e.message);
    } finally { setBusy(false); }
  };

  const close = () => { setCreated(null); setError(null); onClose?.(); };

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) close(); }}>
      <DialogContent className={DIALOG_LG}>
        <DialogHeader>
          <DialogTitle>{created ? `Migration ${created.migration.id} is waiting for the source` : 'New migration'}</DialogTitle>
          <DialogDescription>
            {created
              ? 'Run this on the SOURCE host as root. Nothing is copied until you approve the inventory it sends back.'
              : 'ProxyPilot mints a single-use token and prints one command for the source host. The source is not touched until you run it.'}
          </DialogDescription>
        </DialogHeader>

        {created ? (
          <div className={DIALOG_BODY}>
            <div className="rounded border bg-muted/40 p-3 space-y-2">
              <div className="flex items-center gap-2 text-sm font-medium"><Terminal className="h-4 w-4" />Run on the source host</div>
              <pre className="text-xs font-mono whitespace-pre-wrap break-all bg-background rounded p-2 border">{created.command}</pre>
              <CopyButton text={created.command} label="Copy the command" className={BTN} />
            </div>
            <Notice level="warn">
              <p className="font-medium">This is the only time the token is shown.</p>
              <p>It is single-use, scoped to migration {created.migration.id} and expires {new Date(created.expires_at).toLocaleString()}. If you lose it, cancel this migration and create another.</p>
            </Notice>
            {!created.tls_pin && (
              <Notice level="warn">
                <p>No TLS certificate could be read for this ProxyPilot, so the agent will fall back to the system trust store instead of pinning. That is fine on a private network and worth fixing before migrating over the internet.</p>
              </Notice>
            )}
            <details className="text-xs text-muted-foreground">
              <summary className="cursor-pointer py-2">Rather read the script first?</summary>
              <pre className="mt-2 whitespace-pre-wrap break-all font-mono">{(created.command_steps || []).join('\n')}</pre>
            </details>
          </div>
        ) : (
          <div className={DIALOG_BODY}>
            {error && <Notice level="error"><p className="break-words">{error}</p></Notice>}

            <div className="space-y-2">
              <Label>What are you moving?</Label>
              <div className="grid grid-cols-1 gap-2">
                {MODES.map((m) => (
                  <button
                    key={m.value} type="button" onClick={() => set('mode')(m.value)}
                    className={`text-left rounded border p-3 min-h-[44px] ${form.mode === m.value ? 'border-primary bg-primary/5' : 'border-border'}`}
                  >
                    <div className="text-sm font-medium">{m.label}</div>
                    <div className="text-xs text-muted-foreground mt-0.5">{m.hint}</div>
                  </button>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="mig-name">New guest name</Label>
                <Input id="mig-name" className="h-11 sm:h-9" value={form.name} onChange={(e) => set('name')(e.target.value)} placeholder="old-web01" />
                <p className="text-xs text-muted-foreground">Becomes pp-{form.name || '…'}.</p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="mig-label">Source label</Label>
                <Input id="mig-label" className="h-11 sm:h-9" value={form.source_label} onChange={(e) => set('source_label')(e.target.value)} placeholder="old-web01 at Hetzner" />
              </div>
              <div className="space-y-1.5">
                <Label>Guest type</Label>
                <Select value={form.type} onValueChange={set('type')}>
                  <SelectTrigger className="h-11 sm:h-9"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="container">Container</SelectItem>
                    <SelectItem value="virtual-machine">Virtual machine</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Source kind</Label>
                <Select value={form.source_kind || 'auto'} onValueChange={(v) => set('source_kind')(v === 'auto' ? '' : v)}>
                  <SelectTrigger className="h-11 sm:h-9"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="auto">Detect from the source</SelectItem>
                    <SelectItem value="physical">Physical host</SelectItem>
                    <SelectItem value="vm">VM</SelectItem>
                    <SelectItem value="lxc">LXC</SelectItem>
                    <SelectItem value="proxmox-lxc">Proxmox LXC (rootfs tar)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="mig-cpu">vCPUs</Label>
                <Input id="mig-cpu" className="h-11 sm:h-9" type="number" min="1" value={form.cpu} onChange={(e) => set('cpu')(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="mig-mem">Memory (GB)</Label>
                <Input id="mig-mem" className="h-11 sm:h-9" type="number" min="0.25" step="0.25" value={form.memory_gb} onChange={(e) => set('memory_gb')(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="mig-disk">Disk (GB){form.type === 'virtual-machine' ? '' : ' — optional'}</Label>
                <Input id="mig-disk" className="h-11 sm:h-9" type="number" min="1" value={form.disk_gb} onChange={(e) => set('disk_gb')(e.target.value)} placeholder={form.type === 'virtual-machine' ? 'required for a VM' : 'pool default'} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="mig-pool">Storage pool — optional</Label>
                <Input id="mig-pool" className="h-11 sm:h-9" value={form.pool} onChange={(e) => set('pool')(e.target.value)} placeholder="the profile's pool" />
              </div>
            </div>

            {form.mode === 'application' && (
              <div className="space-y-3 rounded border p-3">
                <p className="text-sm font-medium">Application mode</p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label htmlFor="mig-image">Base image</Label>
                    <Input id="mig-image" className="h-11 sm:h-9" value={form.image} onChange={(e) => set('image')(e.target.value)} />
                  </div>
                  <div className="space-y-1.5">
                    <Label>Database</Label>
                    <Select value={form.database} onValueChange={set('database')}>
                      <SelectTrigger className="h-11 sm:h-9"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">None</SelectItem>
                        <SelectItem value="postgres">PostgreSQL</SelectItem>
                        <SelectItem value="mysql">MySQL / MariaDB</SelectItem>
                        <SelectItem value="sqlite">SQLite (travels with the files)</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5 sm:col-span-2">
                    <Label htmlFor="mig-dirs">Application directories — one per line</Label>
                    <textarea
                      id="mig-dirs" rows={3} value={form.app_dirs} onChange={(e) => set('app_dirs')(e.target.value)}
                      placeholder={'/srv/myapp\n/var/www/myapp'}
                      className="w-full rounded border bg-background p-2 text-sm font-mono"
                    />
                    <p className="text-xs text-muted-foreground">Leave empty and the inventory will propose them; you can still add them before approving.</p>
                  </div>
                  <div className="space-y-1.5 sm:col-span-2">
                    <Label htmlFor="mig-unit">Source service to stop at cutover</Label>
                    <Input id="mig-unit" className="h-11 sm:h-9" value={form.service_name} onChange={(e) => set('service_name')(e.target.value)} placeholder="myapp.service" />
                  </div>
                </div>
              </div>
            )}

            <div className="space-y-2">
              <Checkbox checked={form.nested} onChange={set('nested')} label="The source runs docker or compose" hint="Turns on security.nesting so the container stack keeps working inside the guest." />
              <Checkbox checked={form.auto_transfer} onChange={set('auto_transfer')} label="Start copying without waiting for me" hint="Off is the right answer for production: it is the review of the inventory that keeps a surprise off the wire." />
              <Checkbox checked={form.keep_agent} onChange={set('keep_agent')} label="Leave the agent on the source afterwards" hint="By default it deletes itself when the migration ends." />
            </div>
          </div>
        )}

        <DialogFooter className="flex-col sm:flex-row gap-2">
          {created ? (
            <Button className={BTN} onClick={close}>Done</Button>
          ) : (
            <>
              <Button variant="outline" className={BTN} onClick={close} disabled={busy}>Cancel</Button>
              <Button className={BTN} onClick={submit} disabled={busy || !form.name.trim()}>
                {busy ? <><Loader2 className="h-4 w-4 mr-1.5 animate-spin" />Creating…</> : 'Create and show the command'}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
