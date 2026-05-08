// TLS cert-mount section for the LXC details dialog.
//
// Counterpart to ServiceCertMounts (which lives on the per-route
// settings dialog). Same backend, opposite UX: instead of starting
// from a service and picking a target LXC, this starts from an LXC
// and picks which service's cert to bind in. Common case in MEET
// installs is the LXC owns one service; we render it as a one-click
// "Bind <domain>'s cert into this LXC" button. Multi-service LXCs
// get a service picker.
//
// Data comes from a single endpoint:
//   GET /api/lxc/containers/:name/cert-mounts
//     → { mounts, eligibleServices }
// Mutation reuses the per-service endpoints
// (POST/DELETE/RECONCILE on /services/:id/cert-mounts) so we don't
// duplicate the create logic, and the audit-log path stays single-
// sourced.

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
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

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

function CopyChip({ value, toast }) {
  const [done, setDone] = useState(false);
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="h-6 px-1.5"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value || '');
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        } catch (e) {
          toast({ variant: 'destructive', title: 'Copy failed', description: e.message });
        }
      }}
      title="Copy"
    >
      {done ? <Check className="h-3 w-3 text-green-600" /> : <Copy className="h-3 w-3" />}
    </Button>
  );
}

function DriftBadge({ drift }) {
  if (!drift) return null;
  let label = '⚠ drift';
  let title = '';
  if (drift.kind === 'missing') {
    label = '⚠ device missing';
    title = 'Incus device gone but DB row remains. Click Reconcile to re-attach.';
  } else if (drift.kind === 'wrong_source') {
    label = `⚠ source changed${drift.incus_source ? ` (${drift.incus_source})` : ''}`;
    title = 'Device exists but points at a different host directory.';
  } else if (drift.kind === 'container_missing') {
    label = '⚠ container missing';
    title = 'Target LXC isn’t running or doesn’t exist.';
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

export default function LxcCertMounts({ container, api, toast }) {
  const containerName = container?.incusName || (container?.name ? `pp-${container.name}` : null);
  const [data, setData] = useState({ mounts: [], eligibleServices: [] });
  const [loading, setLoading] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [draft, setDraft] = useState({
    serviceId: '',
    deviceName: 'meet-tls',
    targetPath: '/var/meet-tls',
  });
  const [saving, setSaving] = useState(false);
  const [reconcilingId, setReconcilingId] = useState(null);
  const [removingId, setRemovingId] = useState(null);

  const reload = async () => {
    if (!containerName) return;
    setLoading(true);
    try {
      const r = await api.getLxcContainerCertMounts(containerName);
      setData({ mounts: r.mounts || [], eligibleServices: r.eligibleServices || [] });
    } catch (e) {
      toast({ variant: 'destructive', title: 'Failed to load cert mounts', description: e.message });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [containerName]);

  const eligible = data.eligibleServices || [];
  const eligibleWithCert = eligible.filter((s) => s.cert?.available);
  const onlyService = eligibleWithCert.length === 1 ? eligibleWithCert[0] : null;

  const openModalFor = (svc) => {
    setDraft({
      serviceId: svc?.id || (eligibleWithCert[0]?.id ?? ''),
      deviceName: 'meet-tls',
      targetPath: '/var/meet-tls',
    });
    setModalOpen(true);
  };

  const onSubmit = async () => {
    if (!draft.serviceId) {
      toast({ variant: 'destructive', title: 'Pick a service' });
      return;
    }
    setSaving(true);
    try {
      await api.createServiceCertMount(draft.serviceId, {
        containerName,
        deviceName: draft.deviceName || undefined,
        targetPath: draft.targetPath || undefined,
        readonly: true,
      });
      toast({ title: 'Cert bind-mounted', description: `${containerName}:${draft.targetPath}` });
      await reload();
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
      await api.deleteServiceCertMount(m.serviceId, m.id);
      toast({ title: 'Bind-mount removed' });
      await reload();
    } catch (e) {
      toast({ variant: 'destructive', title: 'Remove failed', description: e.message });
    } finally {
      setRemovingId(null);
    }
  };

  const onReconcile = async (m) => {
    setReconcilingId(m.id);
    try {
      const r = await api.reconcileServiceCertMount(m.serviceId, m.id);
      const action = r?.outcome?.action || 'unknown';
      toast({ title: `Reconciled: ${action}` });
      await reload();
    } catch (e) {
      toast({ variant: 'destructive', title: 'Reconcile failed', description: e.message });
    } finally {
      setReconcilingId(null);
    }
  };

  if (!containerName) return null;

  return (
    <div>
      <h4 className="text-sm font-medium mb-2 flex items-center gap-2">
        <span>TLS certificate bind-mounts</span>
        {loading && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
      </h4>

      {/* Existing mounts */}
      {data.mounts.length > 0 ? (
        <ul className="space-y-1.5 mb-3">
          {data.mounts.map((m) => (
            <li key={m.id} className="text-sm flex items-center gap-2 flex-wrap">
              <span className="font-mono text-xs">
                {m.deviceName} → {m.targetPath}
              </span>
              {m.hostname && (
                <span className="text-xs text-muted-foreground">cert: {m.hostname}</span>
              )}
              {m.readonly && <span className="text-[10px] text-muted-foreground">(ro)</span>}
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
                className="h-6 px-2 text-destructive ml-auto"
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
      ) : (
        !loading && (
          <p className="text-xs text-muted-foreground mb-3">
            No TLS cert bind-mounts on this LXC yet.
          </p>
        )
      )}

      {/* Per-service cert availability + bind buttons.
          - If an LXC owns multiple services, render one row each
            with its own bind button.
          - If a service has no Caddy cert yet, the row is informative
            (disabled bind, with a hint to obtain HTTPS first). */}
      {eligible.length > 0 && (
        <div className="space-y-1.5">
          {eligible.map((svc) => {
            const cert = svc.cert || { available: false };
            const alreadyMounted = data.mounts.some(
              (m) => m.serviceId === svc.id && m.targetPath === '/var/meet-tls'
            );
            return (
              <div
                key={svc.id}
                className="flex items-center gap-2 text-sm border rounded p-2 flex-wrap"
              >
                <span className="font-mono text-xs">{svc.domain || svc.name || svc.id}</span>
                {cert.available ? (
                  <>
                    <span className="text-[10px] text-muted-foreground">
                      cert at {cert.directory}
                    </span>
                    <CopyChip value={cert.directory} toast={toast} />
                    {cert.lastRotatedAt && (
                      <span className="text-[10px] text-muted-foreground">
                        rotated {fmtAge(cert.lastRotatedAt)}
                      </span>
                    )}
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="ml-auto h-7"
                      disabled={alreadyMounted}
                      onClick={() => openModalFor(svc)}
                      title={alreadyMounted ? 'Already bind-mounted at /var/meet-tls' : ''}
                    >
                      <Plus className="h-3 w-3 mr-1" />
                      {alreadyMounted ? 'Already mounted' : 'Bind into this LXC'}
                    </Button>
                  </>
                ) : (
                  <span className="text-xs text-muted-foreground ml-auto">
                    No cert yet — visit {svc.domain || 'the domain'} over HTTPS so Caddy obtains one.
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}

      <Dialog open={modalOpen} onOpenChange={setModalOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Bind-mount cert into {containerName}</DialogTitle>
            <DialogDescription>
              Attaches the chosen service's Caddy cert directory as a read-only disk
              device on this LXC. Cert rotations propagate live — no copy, no restart
              of ProxyPilot needed.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            {eligibleWithCert.length > 1 ? (
              <div>
                <Label htmlFor="cm-service">Source service / cert</Label>
                <Select
                  value={draft.serviceId}
                  onValueChange={(v) => setDraft((d) => ({ ...d, serviceId: v }))}
                >
                  <SelectTrigger id="cm-service">
                    <SelectValue placeholder="Pick a service" />
                  </SelectTrigger>
                  <SelectContent>
                    {eligibleWithCert.map((s) => (
                      <SelectItem key={s.id} value={s.id}>
                        {s.domain || s.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ) : onlyService ? (
              <div className="text-sm">
                Source cert: <span className="font-mono">{onlyService.domain}</span>
              </div>
            ) : null}

            <div>
              <Label htmlFor="cm-target-path">Target path inside LXC</Label>
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
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setModalOpen(false)} disabled={saving}>
              <X className="h-4 w-4 mr-1" /> Cancel
            </Button>
            <Button onClick={onSubmit} disabled={saving || !draft.serviceId}>
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
