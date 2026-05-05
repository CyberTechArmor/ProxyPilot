// Service detail panel for Phase 2c — L4 forwards + always-visible
// detected-port chip row.
//
// Lives inside the existing service settings dialog so the operator
// gets one place to configure HTTP routes, raw L4 forwards, and
// rescan the LXC for listening ports. The detected-port chips have
// per-chip "+ Add as HTTP route" / "+ Add as L4 forward" actions —
// the HTTP action is disabled (with tooltip) for range chips since
// Caddy can't reverse-proxy a port range.
//
// Wires only into the existing Phase 2c API surface
// (api.getServiceL4Forwards / createServiceL4Forward / etc.) and
// emits two callbacks the host dialog uses to seed its own route-add
// flow when an operator clicks "Add as HTTP route" on a single-port
// chip.

import { useEffect, useState } from 'react';
import { Loader2, Plus, RefreshCcw, Trash2 } from 'lucide-react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Switch } from './ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from './ui/select';

function fmtPort(p) {
  return p.portEnd && p.portEnd !== p.port ? `${p.port}-${p.portEnd}` : String(p.port);
}

function fmtForwardRange(f) {
  return f.listenPortEnd && f.listenPortEnd !== f.listenPort
    ? `${f.listenPort}-${f.listenPortEnd}`
    : String(f.listenPort);
}

export default function ServiceL4AndPorts({
  service,
  api,
  toast,
  onCoverHttp, // (chip) → open route-add form pre-filled with that port
}) {
  const [forwards, setForwards] = useState([]);
  const [forwardsLoading, setForwardsLoading] = useState(false);
  const [detected, setDetected] = useState([]);
  const [scannedAt, setScannedAt] = useState(null);
  const [composeStatus, setComposeStatus] = useState(null);
  const [scanning, setScanning] = useState(false);
  const [savingForward, setSavingForward] = useState(false);
  const [draft, setDraft] = useState(null);

  // Initial load on dialog open / service change.
  useEffect(() => {
    if (!service?.id) return;
    let cancelled = false;
    (async () => {
      setForwardsLoading(true);
      try {
        const [fwRes, dpRes] = await Promise.all([
          api.getServiceL4Forwards(service.id),
          api.getDetectedPorts(service.id),
        ]);
        if (cancelled) return;
        setForwards(fwRes.forwards || []);
        setDetected(dpRes.ports || []);
        setScannedAt(dpRes.scannedAt || null);
      } catch (e) {
        if (!cancelled) {
          toast({
            variant: 'destructive',
            title: 'Failed to load L4 / detected ports',
            description: e.message,
          });
        }
      } finally {
        if (!cancelled) setForwardsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [service?.id, api, toast]);

  const refreshForwards = async () => {
    try {
      const { forwards: fws } = await api.getServiceL4Forwards(service.id);
      setForwards(fws || []);
    } catch (e) {
      // toast in caller
    }
  };

  const onRescan = async () => {
    setScanning(true);
    try {
      const r = await api.rescanDetectedPorts(service.id);
      setDetected(r.ports || []);
      setScannedAt(r.scannedAt || new Date().toISOString());
      setComposeStatus(r.compose || null);
      if (r.scanError) {
        toast({ variant: 'destructive', title: 'Scan reported error', description: r.scanError });
      } else if (r.compose && !r.compose.ready) {
        toast({
          variant: 'destructive',
          title: 'Compose stack not healthy',
          description: 'Check the docker compose ps table below.',
        });
      } else {
        toast({ title: 'Port scan complete' });
      }
    } catch (e) {
      toast({ variant: 'destructive', title: 'Rescan failed', description: e.message });
    } finally {
      setScanning(false);
    }
  };

  const beginAddForward = (seed) => {
    setDraft({
      proto: seed?.proto || 'tcp',
      listenPort: seed?.port != null ? String(seed.port) : '',
      listenPortEnd: seed?.portEnd != null ? String(seed.portEnd) : '',
      connectPort: seed?.port != null ? String(seed.port) : '',
      connectPortEnd: seed?.portEnd != null ? String(seed.portEnd) : '',
      description: '',
    });
  };

  const cancelAddForward = () => setDraft(null);

  const saveForward = async () => {
    if (!draft) return;
    setSavingForward(true);
    try {
      const body = {
        proto: draft.proto,
        listenPort: parseInt(draft.listenPort, 10),
        listenPortEnd: draft.listenPortEnd ? parseInt(draft.listenPortEnd, 10) : null,
        connectPort: parseInt(draft.connectPort, 10),
        connectPortEnd: draft.connectPortEnd ? parseInt(draft.connectPortEnd, 10) : null,
        description: draft.description || null,
      };
      await api.createServiceL4Forward(service.id, body);
      toast({ title: 'L4 forward added' });
      await refreshForwards();
      cancelAddForward();
    } catch (e) {
      toast({ variant: 'destructive', title: 'Failed to add forward', description: e.message });
    } finally {
      setSavingForward(false);
    }
  };

  // Operator-driven re-apply. Walks every forward through the
  // reconciler, recreating any Incus proxy device or firewall row that
  // disappeared (the most common cause being a host reboot where an
  // ephemeral UDP socket grabbed a port inside a forward's range
  // before incus could bind it).
  const reconcileForwards = async () => {
    setSavingForward(true);
    try {
      const r = await api.reconcileServiceL4Forwards(service.id);
      const outcomes = r?.reconcile?.applied || [];
      const errors = outcomes.filter((o) => o.status === 'error');
      if (errors.length > 0) {
        toast({
          variant: 'destructive',
          title: `${errors.length} forward(s) failed to reconcile`,
          description: errors.map((e) => `${e.id}: ${e.error || 'unknown'}`).join('; '),
        });
      } else {
        const applied = outcomes.filter((o) => o.status === 'applied' || o.status === 'present').length;
        const removed = outcomes.filter((o) => o.status === 'removed').length;
        toast({
          title: 'L4 forwards reconciled',
          description: `${applied} present, ${removed} cleaned up`,
        });
      }
      await refreshForwards();
    } catch (e) {
      toast({ variant: 'destructive', title: 'Reconcile failed', description: e.message });
    } finally {
      setSavingForward(false);
    }
  };

  const deleteForward = async (fw) => {
    setSavingForward(true);
    try {
      await api.deleteServiceL4Forward(service.id, fw.id);
      toast({ title: 'L4 forward removed' });
      await refreshForwards();
    } catch (e) {
      toast({ variant: 'destructive', title: 'Failed to remove forward', description: e.message });
    } finally {
      setSavingForward(false);
    }
  };

  // Decide chip status: ✓ routed (covered by an HTTP route or L4
  // forward on this service) vs ⚠ unrouted (listening but uncovered).
  // We only know about routes via the parent dialog (settingsRoutes),
  // so the parent passes a covered-port set in if it can; otherwise
  // we just check forwards.
  const isCovered = (chip) => {
    if (chip.portEnd && chip.portEnd !== chip.port) {
      // Range chip — covered iff a forward has the same proto+range.
      return forwards.some(
        (f) =>
          f.proto === chip.proto &&
          f.listenPort === chip.port &&
          (f.listenPortEnd ?? f.listenPort) === chip.portEnd
      );
    }
    return forwards.some(
      (f) =>
        f.proto === chip.proto &&
        f.listenPort <= chip.port &&
        (f.listenPortEnd ?? f.listenPort) >= chip.port
    );
  };

  return (
    <div className="space-y-6 mt-4 pt-4 border-t">
      {/* Detected ports chip row */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <h4 className="font-medium text-sm">Detected on bridge IP</h4>
          <div className="flex items-center gap-2">
            {scannedAt && (
              <span className="text-xs text-muted-foreground">
                last scan: {new Date(scannedAt).toLocaleTimeString()}
              </span>
            )}
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={onRescan}
              disabled={scanning}
            >
              {scanning ? (
                <Loader2 className="h-4 w-4 mr-1 animate-spin" />
              ) : (
                <RefreshCcw className="h-4 w-4 mr-1" />
              )}
              Rescan
            </Button>
          </div>
        </div>
        {detected.length === 0 ? (
          <div className="text-xs text-muted-foreground italic">
            No ports detected. Click Rescan after the workload is running.
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            {detected.map((chip, idx) => {
              const isRange = chip.portEnd && chip.portEnd !== chip.port;
              const covered = isCovered(chip);
              return (
                <div
                  key={`${chip.proto}-${chip.port}-${chip.portEnd ?? ''}-${idx}`}
                  className={`inline-flex items-center gap-2 rounded-full border px-2.5 py-1 text-xs ${
                    covered
                      ? 'border-green-500/40 bg-green-500/5'
                      : 'border-yellow-500/40 bg-yellow-500/5'
                  }`}
                >
                  <code className="font-mono">
                    {chip.proto}/{fmtPort(chip)}
                  </code>
                  <span className="text-[10px] text-muted-foreground">
                    {covered ? '✓ routed' : '⚠ unrouted'}
                  </span>
                  {!covered && !isRange && (
                    <button
                      type="button"
                      className="text-[10px] underline hover:text-primary"
                      onClick={() =>
                        onCoverHttp &&
                        onCoverHttp({ port: chip.port, proto: chip.proto })
                      }
                      disabled={chip.proto === 'udp'}
                      title={
                        chip.proto === 'udp'
                          ? 'Caddy cannot reverse-proxy UDP — use L4 forward'
                          : 'Add an HTTP route pointing to this port'
                      }
                    >
                      + HTTP route
                    </button>
                  )}
                  {!covered && (
                    <button
                      type="button"
                      className="text-[10px] underline hover:text-primary"
                      onClick={() =>
                        beginAddForward({
                          proto: chip.proto,
                          port: chip.port,
                          portEnd: chip.portEnd,
                        })
                      }
                      title={
                        isRange
                          ? 'Caddy cannot reverse-proxy a port range — use L4 forward'
                          : 'Add an L4 forward for this port'
                      }
                    >
                      + L4 forward
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
        {composeStatus && (
          <div className="mt-2 rounded-md border bg-muted/30 p-2 text-xs">
            <div className="font-medium mb-1">
              docker compose ps ({composeStatus.dir}):{' '}
              <span className={composeStatus.ready ? 'text-green-600' : 'text-yellow-600'}>
                {composeStatus.ready ? 'all healthy' : 'not ready'}
              </span>
            </div>
            <div className="font-mono whitespace-pre">
              {(composeStatus.table || []).map((r) => (
                <div key={r.name}>
                  {r.name.padEnd(28)} {r.state.padEnd(10)} {r.health || '-'}
                </div>
              ))}
            </div>
            {composeStatus.error && (
              <div className="mt-1 text-red-600">error: {composeStatus.error}</div>
            )}
          </div>
        )}
      </div>

      {/* L4 forwards */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <h4 className="font-medium text-sm">
            L4 forwards
            <span className="text-xs text-muted-foreground ml-2">
              {forwardsLoading ? 'Loading…' : `${forwards.length} forward${forwards.length === 1 ? '' : 's'}`}
            </span>
          </h4>
          {!draft && (
            <div className="flex items-center gap-2">
              {forwards.length > 0 && (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={reconcileForwards}
                  disabled={savingForward || forwardsLoading}
                  title="Re-apply all L4 forwards. Use this if a forward stopped working after a host reboot."
                >
                  Reconcile
                </Button>
              )}
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => beginAddForward(null)}
              >
                <Plus className="h-4 w-4 mr-1" />
                Add forward
              </Button>
            </div>
          )}
        </div>

        {forwards.map((fw) => (
          <div
            key={fw.id}
            className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 rounded-md border p-2"
          >
            <div className="min-w-0">
              <code className="font-mono text-sm">
                {fw.proto}/{fmtForwardRange(fw)} → :
                {fw.connectPortEnd && fw.connectPortEnd !== fw.connectPort
                  ? `${fw.connectPort}-${fw.connectPortEnd}`
                  : fw.connectPort}
              </code>
              {fw.description && (
                <div className="text-xs text-muted-foreground">{fw.description}</div>
              )}
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-9 w-9 text-red-500 hover:text-red-600"
              onClick={() => deleteForward(fw)}
              disabled={savingForward}
              title="Delete forward"
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        ))}

        {draft && (
          <div className="rounded-md border bg-muted/30 p-3 space-y-3">
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              <div className="space-y-1">
                <Label className="text-xs">Protocol</Label>
                <Select
                  value={draft.proto}
                  onValueChange={(v) => setDraft({ ...draft, proto: v })}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="tcp">tcp</SelectItem>
                    <SelectItem value="udp">udp</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Listen port</Label>
                <Input
                  type="number"
                  value={draft.listenPort}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      listenPort: e.target.value,
                      // Mirror to connect for the common case where
                      // host edge and bridge use the same port.
                      connectPort: draft.connectPort || e.target.value,
                    })
                  }
                  min="1"
                  max="65535"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Listen end (range)</Label>
                <Input
                  type="number"
                  value={draft.listenPortEnd}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      listenPortEnd: e.target.value,
                      connectPortEnd: draft.connectPortEnd || e.target.value,
                    })
                  }
                  min="1"
                  max="65535"
                  placeholder="(single port)"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Connect port</Label>
                <Input
                  type="number"
                  value={draft.connectPort}
                  onChange={(e) => setDraft({ ...draft, connectPort: e.target.value })}
                  min="1"
                  max="65535"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Connect end</Label>
                <Input
                  type="number"
                  value={draft.connectPortEnd}
                  onChange={(e) => setDraft({ ...draft, connectPortEnd: e.target.value })}
                  min="1"
                  max="65535"
                  placeholder="(single port)"
                />
              </div>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Description</Label>
              <Input
                value={draft.description}
                onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                placeholder="What is this forward for?"
              />
            </div>
            <div className="flex gap-2 justify-end">
              <Button type="button" variant="outline" size="sm" onClick={cancelAddForward}>
                Cancel
              </Button>
              <Button type="button" size="sm" onClick={saveForward} disabled={savingForward}>
                {savingForward ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Add forward'}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
