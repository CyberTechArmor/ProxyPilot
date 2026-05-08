// TLS cert section for the service settings dialog.
//
// Renders three things:
//
//   1. Read-only cert path / cert filename / key filename rows with
//      copy buttons. Hidden when service.cert.available !== true (no
//      Caddy-issued cert yet, e.g. HTTP-only or ACME pending).
//   2. A "Bind-mount cert into another LXC" button that opens a modal
//      with target LXC dropdown + path/device fields, plus a list of
//      existing bind-mounts for this service.
//   3. Drift badges next to existing mounts when the live Incus state
//      doesn't match the DB row (device removed by hand, or its
//      `source=` repointed elsewhere). Each badge has a Reconcile
//      button that re-runs the reconciler for that one row only.
//
// The modal lists existing mounts INSIDE itself per the spec — that
// keeps the operator one click away from "remove the wrong mount and
// add the right one" without flipping between dialogs. Remove
// requires sudo on the backend; the frontend just calls the API and
// surfaces the error if sudo is required and not granted.
//
// Data flow:
//   - Cert metadata comes through service.cert (set by GET
//     /api/services/:id; null when no cert yet).
//   - Mounts come from GET /api/services/:id/cert-mounts; we poll on
//     mount + after every mutation.
//
// The component is intentionally a peer of ServiceL4AndPorts — same
// dialog, same toast/api props, same useEffect-on-service.id pattern.

import { useEffect, useState } from 'react';
import {
  AlertTriangle,
  Check,
  Copy,
  Loader2,
  Plus,
  RefreshCcw,
  Trash2,
  X,
} from 'lucide-react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from './ui/select';

function fmtAge(iso) {
  if (!iso) return '—';
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '—';
  const ageMs = Date.now() - t;
  if (ageMs < 0) return new Date(iso).toLocaleString();
  const sec = Math.floor(ageMs / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} min ago`;
  const hr = Math.floor(min / 60);
  if (hr < 48) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  return new Date(iso).toLocaleDateString();
}

function CopyButton({ text, label, toast }) {
  const [done, setDone] = useState(false);
  const onClick = async () => {
    try {
      await navigator.clipboard.writeText(text || '');
      setDone(true);
      setTimeout(() => setDone(false), 1500);
    } catch (e) {
      toast({ variant: 'destructive', title: 'Copy failed', description: e.message });
    }
  };
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="h-7 px-2"
      onClick={onClick}
      title={`Copy ${label}`}
    >
      {done ? <Check className="h-3.5 w-3.5 text-green-600" /> : <Copy className="h-3.5 w-3.5" />}
    </Button>
  );
}

function DriftBadge({ drift }) {
  if (!drift) return null;
  let label = '⚠ drift';
  let title = '';
  if (drift.kind === 'missing') {
    label = '⚠ device missing';
    title = 'The Incus device is gone but the DB row is still here. Click Reconcile to re-attach.';
  } else if (drift.kind === 'wrong_source') {
    label = `⚠ source changed${drift.incus_source ? ` (${drift.incus_source})` : ''}`;
    title = 'The device exists but points at a different host directory. Click Reconcile to overwrite, or remove + recreate.';
  } else if (drift.kind === 'container_missing') {
    label = '⚠ container missing';
    title = 'The target LXC isn’t running or doesn’t exist. Bring it up before reconciling.';
  } else if (drift.kind === 'inspect_error') {
    label = '⚠ inspect failed';
    title = drift.error || '';
  }
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full bg-amber-100 dark:bg-amber-900/40 text-amber-900 dark:text-amber-100 px-2 py-0.5 text-xs"
      title={title}
    >
      <AlertTriangle className="h-3 w-3" />
      {label}
    </span>
  );
}

export default function ServiceCertMounts({ service, api, toast }) {
  const cert = service?.cert || { available: false };
  const [mounts, setMounts] = useState([]);
  const [loadingMounts, setLoadingMounts] = useState(false);
  const [containers, setContainers] = useState([]);
  const [containersLoading, setContainersLoading] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [draft, setDraft] = useState({
    containerName: '',
    deviceName: 'meet-tls',
    targetPath: '/var/meet-tls',
  });
  const [saving, setSaving] = useState(false);
  const [reconcilingId, setReconcilingId] = useState(null);
  const [removingId, setRemovingId] = useState(null);

  const loadMounts = async () => {
    if (!service?.id) return;
    setLoadingMounts(true);
    try {
      const r = await api.getServiceCertMounts(service.id);
      setMounts(r.mounts || []);
    } catch (e) {
      toast({ variant: 'destructive', title: 'Failed to load cert mounts', description: e.message });
    } finally {
      setLoadingMounts(false);
    }
  };

  useEffect(() => {
    loadMounts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [service?.id]);

  const openModal = async () => {
    setModalOpen(true);
    setDraft({
      containerName: '',
      deviceName: 'meet-tls',
      targetPath: '/var/meet-tls',
    });
    setContainersLoading(true);
    try {
      const r = await api.getAllLxcContainers();
      setContainers(r.containers || []);
    } catch (e) {
      toast({ variant: 'destructive', title: 'Failed to list LXCs', description: e.message });
    } finally {
      setContainersLoading(false);
    }
  };

  const onSubmit = async () => {
    if (!draft.containerName) {
      toast({ variant: 'destructive', title: 'Pick a target container' });
      return;
    }
    setSaving(true);
    try {
      await api.createServiceCertMount(service.id, {
        containerName: draft.containerName,
        deviceName: draft.deviceName || undefined,
        targetPath: draft.targetPath || undefined,
        readonly: true,
      });
      toast({ title: 'Bind-mount attached', description: `${draft.containerName}:${draft.targetPath}` });
      await loadMounts();
      setModalOpen(false);
    } catch (e) {
      toast({ variant: 'destructive', title: 'Bind-mount failed', description: e.message });
    } finally {
      setSaving(false);
    }
  };

  const onRemove = async (m) => {
    if (!window.confirm(`Remove bind-mount ${m.deviceName} from ${m.containerName}?`)) return;
    setRemovingId(m.id);
    try {
      await api.deleteServiceCertMount(service.id, m.id);
      toast({ title: 'Bind-mount removed' });
      await loadMounts();
    } catch (e) {
      toast({ variant: 'destructive', title: 'Remove failed', description: e.message });
    } finally {
      setRemovingId(null);
    }
  };

  const onReconcile = async (m) => {
    setReconcilingId(m.id);
    try {
      const r = await api.reconcileServiceCertMount(service.id, m.id);
      const action = r?.outcome?.action || 'unknown';
      toast({ title: `Reconciled: ${action}` });
      await loadMounts();
    } catch (e) {
      toast({ variant: 'destructive', title: 'Reconcile failed', description: e.message });
    } finally {
      setReconcilingId(null);
    }
  };

  return (
    <div className="border rounded-md p-4 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">TLS certificate</h3>
        {cert.available && cert.lastRotatedAt && (
          <span className="text-xs text-muted-foreground">
            Last rotation: {fmtAge(cert.lastRotatedAt)}
          </span>
        )}
      </div>

      {!cert.available && (
        <p className="text-sm text-muted-foreground">
          No cert yet — Caddy will obtain one on the next request to this hostname.
        </p>
      )}

      {cert.available && (
        <div className="space-y-2">
          <CertRow label="Cert location" value={cert.directory} toast={toast} />
          <CertRow label="Cert filename" value={cert.certFilename} toast={toast} />
          <CertRow label="Key filename" value={cert.keyFilename} toast={toast} />
          {cert.issuer && (
            <div className="text-xs text-muted-foreground">Issuer: {cert.issuer}</div>
          )}
          <div className="pt-2">
            <Button type="button" variant="outline" size="sm" onClick={openModal}>
              <Plus className="h-4 w-4 mr-1" />
              Bind-mount cert into another LXC…
            </Button>
          </div>
        </div>
      )}

      {/* Existing mounts list (always shown when there are any, even if cert is gone) */}
      {mounts.length > 0 && (
        <div className="space-y-1">
          <div className="text-xs font-medium text-muted-foreground">Existing bind-mounts</div>
          <ul className="space-y-1">
            {mounts.map((m) => (
              <li key={m.id} className="flex items-center gap-2 text-sm">
                <span className="font-mono">
                  {m.containerName}: {m.deviceName} → {m.targetPath}
                </span>
                {m.readonly && <span className="text-xs text-muted-foreground">(read-only)</span>}
                <DriftBadge drift={m.drift} />
                {m.drift && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-6 px-2"
                    disabled={reconcilingId === m.id}
                    onClick={() => onReconcile(m)}
                  >
                    {reconcilingId === m.id ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <RefreshCcw className="h-3 w-3" />
                    )}
                    <span className="ml-1 text-xs">Reconcile</span>
                  </Button>
                )}
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-6 px-2 text-destructive"
                  disabled={removingId === m.id}
                  onClick={() => onRemove(m)}
                >
                  {removingId === m.id ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <Trash2 className="h-3 w-3" />
                  )}
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {loadingMounts && (
        <div className="text-xs text-muted-foreground flex items-center gap-1">
          <Loader2 className="h-3 w-3 animate-spin" /> loading mounts…
        </div>
      )}

      <Dialog open={modalOpen} onOpenChange={setModalOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Bind-mount cert into another LXC</DialogTitle>
            <DialogDescription>
              Attaches {cert.directory || 'this cert directory'} as a read-only disk device
              on the target container. Cert rotations propagate live — no copy, no restart.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div>
              <Label htmlFor="cm-target">Target LXC</Label>
              <Select
                value={draft.containerName}
                onValueChange={(v) => setDraft((d) => ({ ...d, containerName: v }))}
              >
                <SelectTrigger id="cm-target">
                  <SelectValue
                    placeholder={containersLoading ? 'Loading…' : 'Select a container'}
                  />
                </SelectTrigger>
                <SelectContent>
                  {containers.map((c) => (
                    <SelectItem key={c.name} value={c.name}>
                      {c.name} {c.status && `(${c.status})`}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label htmlFor="cm-target-path">Target path</Label>
              <Input
                id="cm-target-path"
                value={draft.targetPath}
                onChange={(e) => setDraft((d) => ({ ...d, targetPath: e.target.value }))}
                placeholder="/var/meet-tls"
              />
            </div>
            <div>
              <Label htmlFor="cm-device-name">Device name</Label>
              <Input
                id="cm-device-name"
                value={draft.deviceName}
                onChange={(e) => setDraft((d) => ({ ...d, deviceName: e.target.value }))}
                placeholder="meet-tls"
              />
            </div>
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <input type="checkbox" checked disabled />
              Read-only (v1 only)
            </div>

            {mounts.length > 0 && (
              <div className="border-t pt-3 space-y-1">
                <div className="text-xs font-medium">Existing mounts for this service</div>
                <ul className="text-xs space-y-1">
                  {mounts.map((m) => (
                    <li key={m.id} className="flex items-center gap-2">
                      <span className="font-mono">
                        {m.containerName}: {m.deviceName} → {m.targetPath}
                      </span>
                      <DriftBadge drift={m.drift} />
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-5 px-1 ml-auto text-destructive"
                        disabled={removingId === m.id}
                        onClick={() => onRemove(m)}
                      >
                        {removingId === m.id ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          'Remove'
                        )}
                      </Button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setModalOpen(false)} disabled={saving}>
              <X className="h-4 w-4 mr-1" /> Cancel
            </Button>
            <Button onClick={onSubmit} disabled={saving || !draft.containerName}>
              {saving ? (
                <>
                  <Loader2 className="h-4 w-4 mr-1 animate-spin" /> Attaching…
                </>
              ) : (
                <>
                  <Plus className="h-4 w-4 mr-1" /> Bind-mount
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function CertRow({ label, value, toast }) {
  return (
    <div className="flex items-center gap-2 text-sm">
      <span className="text-muted-foreground w-32 shrink-0">{label}:</span>
      <span className="font-mono text-xs break-all flex-1">{value || '—'}</span>
      {value && <CopyButton text={value} label={label.toLowerCase()} toast={toast} />}
    </div>
  );
}
