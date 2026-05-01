import { useState, useEffect } from 'react';
import QRCode from 'qrcode';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/context/AuthContext';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useToast } from '@/hooks/use-toast';
import {
  Loader2,
  Cable,
  RefreshCw,
  AlertTriangle,
  Power,
  PowerOff,
  Plus,
  Copy,
  Check,
  ShieldAlert,
  Trash2,
  Sliders,
} from 'lucide-react';
import { Navigate } from 'react-router-dom';

function fmtBytes(n) {
  if (!n) return '0';
  const u = ['B', 'K', 'M', 'G', 'T'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return v >= 100 ? `${v.toFixed(0)}${u[i]}` : `${v.toFixed(1)}${u[i]}`;
}

function fmtRelative(iso) {
  if (!iso) return 'never';
  const ageSec = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (ageSec < 60) return `${ageSec}s ago`;
  if (ageSec < 3600) return `${Math.floor(ageSec / 60)}m ago`;
  if (ageSec < 86400) return `${Math.floor(ageSec / 3600)}h ago`;
  return `${Math.floor(ageSec / 86400)}d ago`;
}

export default function Vpn() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin' || JSON.parse(localStorage.getItem('user') || '{}').role === 'admin';
  const { toast } = useToast();

  const [status, setStatus] = useState(null);
  const [peers, setPeers] = useState([]);
  const [loading, setLoading] = useState(true);

  // Enable VPN modal. Backend's enableSchema requires a `host:port` (or
  // host) endpoint string; port and dns are optional with sensible
  // defaults that match the CLI's WG_DEFAULT_*. The form keeps `port`
  // separate so the operator can paste an endpoint without thinking
  // about the port suffix.
  const [enableOpen, setEnableOpen] = useState(false);
  const [enableBusy, setEnableBusy] = useState(false);
  // The default below is a public resolver, but operators MUST be
  // aware: any DNS value that isn't covered by a peer's AllowedIPs
  // breaks name resolution on that peer.
  //
  // - scope=full peers: AllowedIPs = 0.0.0.0/0, so 1.1.1.1 (or any
  //   public resolver) routes through the tunnel and works (assuming
  //   the host's masquerade rule is up).
  // - scope=admin/services peers: AllowedIPs = 10.100.0.0/24 only.
  //   1.1.1.1 isn't in that range, so DNS queries get stuck — Windows
  //   NRPT redirects them to the tunnel, the tunnel has no route to
  //   1.1.1.1, queries silently fail. Operators using these scopes
  //   should DELETE the DNS line from each peer's local wg config
  //   after import (or run a resolver on the tunnel address; see
  //   the "vpn dns" follow-up prompt).
  //
  // The proper fix is a CLI/backend change to allow null DNS so
  // peers ship without a `DNS =` line at all. That's prompted out
  // separately.
  const [enableForm, setEnableForm] = useState({
    endpoint: '', port: '51820', dns: '1.1.1.1',
  });

  // Add-peer modal — has TWO phases on a single Dialog:
  //   form    — name + scope + (services when scope=services)
  //   reveal  — once-only show of {private_key, config, QR}; the
  //             backend never persists the private key, so when this
  //             dialog closes the React state is wiped and there's no
  //             way to get it back. The operator must save it before
  //             clicking "I've saved it".
  const [addPeerOpen, setAddPeerOpen] = useState(false);
  const [addPeerBusy, setAddPeerBusy] = useState(false);
  const [addPeerForm, setAddPeerForm] = useState({
    name: '', scope: 'admin', services: '',
  });
  // Reveal payload: { name, ip, scope, services, public_key, config,
  // private_key }. Set once on add/rotate response, cleared on close.
  const [reveal, setReveal] = useState(null);

  // Per-peer mutation guard so two clicks on the same row don't fire
  // overlapping reconciles in the host CLI.
  const [pendingPeer, setPendingPeer] = useState(null); // peer name | null

  // Lockout-gate modal. The backend 409s with { code, requires_force }
  // on certain destructive operations; we re-prompt with the action's
  // typed phrase and re-issue with force:true on confirm. The CLI may
  // still refuse a force (requires_typed_confirm: true) — that's the
  // "interactive CLI session" exit and we surface it to the operator.
  // gate shape: { peer, action, code, phrase, args }
  const [gate, setGate] = useState(null);
  const [gatePhrase, setGatePhrase] = useState('');
  const [gateBusy, setGateBusy] = useState(false);

  // Set-scope dialog. setScope.peer carries the peer being edited;
  // form holds the next scope + services list.
  const [setScope, setSetScope] = useState(null); // peer | null
  const [setScopeForm, setSetScopeForm] = useState({ scope: 'admin', services: '' });
  const [setScopeBusy, setSetScopeBusy] = useState(false);

  // Remove confirm (no gate yet — the CLI returns 200 on a clean
  // remove). When the gate trips, the lockout modal takes over.
  const [removePeer, setRemovePeer] = useState(null); // peer | null
  const [removeBusy, setRemoveBusy] = useState(false);

  // Rotate confirm. Rotate is destructive in the sense that the
  // peer's currently-installed config stops working until they
  // re-import the new one. Use a styled Dialog rather than
  // window.confirm() so it matches the rest of the page and works
  // inside the dashboard modal stack.
  const [rotateConfirmPeer, setRotateConfirmPeer] = useState(null);
  const [rotateBusy, setRotateBusy] = useState(false);

  useEffect(() => {
    if (isAdmin) loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdmin]);

  if (!isAdmin) return <Navigate to="/" replace />;

  async function loadAll() {
    setLoading(true);
    try {
      const r = await api.listVpn();
      setStatus(r.status || null);
      setPeers(r.peers || []);
    } catch (e) {
      toast({ variant: 'destructive', title: 'Failed to load VPN', description: e.message });
    } finally {
      setLoading(false);
    }
  }

  // ── Lockout-gate phrase mapping ─────────────────────────────────
  // Codes come from the CLI's --json error envelope; the backend
  // re-emits them as 409 with requires_force=true. Each code has a
  // unique phrase the operator must type before the dashboard
  // re-issues with force:true.
  const LOCKOUT_PHRASES = {
    LAST_ENABLED_PEER: 'I understand this locks everyone out',
    RECENTLY_ACTIVE: 'remove this active peer',
    LAST_FULL_ADMIN_DEMOTE: 'demote the last admin peer',
  };

  // Centralised lockout-gate dispatcher. `action` decides which API
  // call to retry with force:true once the operator clears the
  // typed-phrase modal. `args` carries the call's payload (e.g. the
  // next scope + services for set-scope).
  function tripGate({ peer, action, error, args = {} }) {
    const code = error?.code;
    const phrase = LOCKOUT_PHRASES[code];
    if (!phrase) {
      // Unknown gate code — surface the raw error and bail.
      toast({ variant: 'destructive', title: 'Action refused', description: error?.message ?? error?.error ?? 'unknown' });
      return;
    }
    setGate({ peer, action, code, phrase, args });
    setGatePhrase('');
  }

  async function executeGated() {
    if (!gate || gatePhrase !== gate.phrase) return;
    setGateBusy(true);
    try {
      const { peer, action, args } = gate;
      const body = { ...args, force: true };
      let r;
      if (action === 'disable') r = await api.disableVpnPeer(peer.name, body);
      else if (action === 'remove') r = await api.removeVpnPeer(peer.name, body);
      else if (action === 'set-scope') r = await api.setVpnPeerScope(peer.name, body);
      else throw new Error(`unknown gated action: ${action}`);
      toast({ title: `Forced ${action} on ${peer.name}` });
      setGate(null);
      setGatePhrase('');
      // Close any other dialog that triggered the gate.
      setSetScope(null);
      setRemovePeer(null);
      loadAll();
    } catch (e) {
      // Per the backend comment: the CLI may still refuse --force on
      // these gates with requires_typed_confirm:true. There is no
      // dashboard-side bypass for that — the operator has to use
      // an interactive CLI session.
      if (e instanceof ApiError && e.requires_typed_confirm) {
        toast({
          variant: 'destructive',
          title: 'Force refused by CLI',
          description: 'This gate requires an interactive CLI session. Use `proxypilot vpn …` on the host.',
        });
      } else {
        toast({ variant: 'destructive', title: `Force ${gate.action} failed`, description: e.message });
      }
    } finally {
      setGateBusy(false);
    }
  }

  function rotatePeer(peer) {
    setRotateConfirmPeer(peer);
  }

  async function confirmRotate() {
    if (!rotateConfirmPeer) return;
    const peer = rotateConfirmPeer;
    setRotateBusy(true);
    setPendingPeer(peer.name);
    try {
      const r = await api.rotateVpnPeer(peer.name);
      setRotateConfirmPeer(null);
      // Same shape as add-peer — open the reveal dialog.
      setReveal(r);
      loadAll();
    } catch (e) {
      toast({ variant: 'destructive', title: 'Rotate failed', description: e.message });
    } finally {
      setRotateBusy(false);
      setPendingPeer(null);
    }
  }

  async function enablePeer(peer) {
    setPendingPeer(peer.name);
    try {
      await api.enableVpnPeer(peer.name);
      toast({ title: `Enabled ${peer.name}` });
      loadAll();
    } catch (e) {
      toast({ variant: 'destructive', title: 'Enable failed', description: e.message });
    } finally {
      setPendingPeer(null);
    }
  }

  async function disablePeer(peer) {
    setPendingPeer(peer.name);
    try {
      await api.disableVpnPeer(peer.name);
      toast({ title: `Disabled ${peer.name}` });
      loadAll();
    } catch (e) {
      if (e instanceof ApiError && e.requires_force) {
        tripGate({ peer, action: 'disable', error: e });
      } else {
        toast({ variant: 'destructive', title: 'Disable failed', description: e.message });
      }
    } finally {
      setPendingPeer(null);
    }
  }

  async function confirmRemove() {
    if (!removePeer) return;
    setRemoveBusy(true);
    try {
      await api.removeVpnPeer(removePeer.name);
      toast({ title: `Removed ${removePeer.name}` });
      setRemovePeer(null);
      loadAll();
    } catch (e) {
      if (e instanceof ApiError && e.requires_force) {
        tripGate({ peer: removePeer, action: 'remove', error: e });
      } else {
        toast({ variant: 'destructive', title: 'Remove failed', description: e.message });
      }
    } finally {
      setRemoveBusy(false);
    }
  }

  function openSetScope(peer) {
    setSetScopeForm({
      scope: peer.scope ?? 'admin',
      services: (peer.services ?? []).join(', '),
    });
    setSetScope(peer);
  }

  async function submitSetScope() {
    if (!setScope) return;
    const body = { scope: setScopeForm.scope };
    if (setScopeForm.scope === 'services') {
      const services = setScopeForm.services.split(',').map(s => s.trim()).filter(Boolean);
      if (services.length === 0) {
        toast({ variant: 'destructive', title: 'At least one service tag required' });
        return;
      }
      body.services = services;
    }
    setSetScopeBusy(true);
    try {
      await api.setVpnPeerScope(setScope.name, body);
      toast({ title: `${setScope.name} → scope=${body.scope}` });
      setSetScope(null);
      loadAll();
    } catch (e) {
      if (e instanceof ApiError && e.requires_force) {
        tripGate({ peer: setScope, action: 'set-scope', error: e, args: body });
      } else {
        toast({ variant: 'destructive', title: 'Set scope failed', description: e.message });
      }
    } finally {
      setSetScopeBusy(false);
    }
  }

  function resetAddPeer() {
    setAddPeerForm({ name: '', scope: 'admin', services: '' });
  }

  async function submitAddPeer() {
    const name = addPeerForm.name.trim();
    if (!name) { toast({ variant: 'destructive', title: 'Name required' }); return; }
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
      toast({ variant: 'destructive', title: 'Invalid name', description: 'letters, digits, ., _, - only; must start with a letter or digit' });
      return;
    }
    const body = { name, scope: addPeerForm.scope };
    if (addPeerForm.scope === 'services') {
      const services = addPeerForm.services
        .split(',').map(s => s.trim()).filter(Boolean);
      if (services.length === 0) {
        toast({ variant: 'destructive', title: 'At least one service tag required' });
        return;
      }
      body.services = services;
    }
    setAddPeerBusy(true);
    try {
      const r = await api.addVpnPeer(body);
      // Flip the dialog into reveal mode. The state IS the private key
      // — when the operator closes the dialog (or this page unmounts),
      // it's gone. The backend never persists it, the audit row only
      // carries the public key.
      setReveal(r);
      setAddPeerOpen(false);
      resetAddPeer();
      loadAll();
    } catch (e) {
      toast({ variant: 'destructive', title: 'Add peer failed', description: e.message });
    } finally {
      setAddPeerBusy(false);
    }
  }

  async function submitEnable() {
    const endpoint = enableForm.endpoint.trim();
    if (!endpoint) {
      toast({ variant: 'destructive', title: 'Endpoint required' });
      return;
    }
    const body = { endpoint };
    if (enableForm.port.trim()) {
      const p = Number(enableForm.port);
      if (!Number.isInteger(p) || p < 1 || p > 65535) {
        toast({ variant: 'destructive', title: 'Invalid port' });
        return;
      }
      body.port = p;
    }
    if (enableForm.dns.trim()) body.dns = enableForm.dns.trim();
    setEnableBusy(true);
    try {
      const r = await api.enableVpn(body);
      toast({ title: 'VPN enabled', description: r.public_key ? `pubkey ${r.public_key.slice(0, 18)}…` : '' });
      setEnableOpen(false);
      loadAll();
    } catch (e) {
      toast({ variant: 'destructive', title: 'Enable VPN failed', description: e.message });
    } finally {
      setEnableBusy(false);
    }
  }

  const enabled = !!status?.enabled;

  return (
    <div className="space-y-6 p-4 md:p-6">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-4">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Cable className="h-5 w-5" /> VPN
            </CardTitle>
            <CardDescription>
              WireGuard server managed via <code>proxypilot vpn</code>. Peers are scoped to
              full network access, admin-only paths, or an explicit service list — the
              firewall renderer pins each peer to those flows.
            </CardDescription>
          </div>
          <div className="flex flex-wrap gap-2">
            {enabled && (
              <Button variant="outline" onClick={() => { resetAddPeer(); setAddPeerOpen(true); }}>
                <Plus className="h-4 w-4 mr-2" />
                Add peer
              </Button>
            )}
            <Button variant="outline" onClick={loadAll} disabled={loading}>
              {loading ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <RefreshCw className="h-4 w-4 mr-2" />}
              Refresh
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {!enabled && !loading && (
            <div className="flex items-start justify-between gap-3 rounded border border-amber-500/50 bg-amber-500/10 p-3 text-sm">
              <div className="flex items-start gap-2">
                <AlertTriangle className="h-5 w-5 shrink-0 text-amber-600 dark:text-amber-400" />
                <div>
                  <div className="font-semibold text-amber-700 dark:text-amber-300">VPN is not enabled</div>
                  <div className="text-muted-foreground">
                    Set the public endpoint and turn on the WireGuard server. The base-wireguard
                    firewall rule is created automatically.
                  </div>
                </div>
              </div>
              <Button
                size="sm"
                onClick={() => setEnableOpen(true)}
              >
                <Power className="h-4 w-4 mr-2" />
                Enable VPN
              </Button>
            </div>
          )}

          {status && (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
              <StatusCell label="Endpoint" value={status.endpoint ?? '—'} />
              <StatusCell label="Listen port" value={`${status.listen_port ?? '—'}/udp`} />
              <StatusCell
                label="Interface"
                value={status.interface_up ? `up (${status.live_peer_count ?? 0} live)` : 'down'}
                tone={status.interface_up ? 'ok' : (enabled ? 'warn' : undefined)}
              />
              <StatusCell
                label="base-wireguard rule"
                value={
                  status.base_wireguard_rule
                    ? `${status.base_wireguard_rule.enabled ? 'enabled' : 'disabled'} (${status.base_wireguard_rule.scope})`
                    : 'missing — run firewall scan'
                }
                tone={
                  !status.base_wireguard_rule
                    ? 'warn'
                    : status.base_wireguard_rule.enabled ? 'ok' : 'warn'
                }
              />
              <StatusCell label="CIDR" value={status.cidr ?? '—'} />
              <StatusCell label="DNS" value={status.dns ?? '—'} />
              <StatusCell
                label="Server pubkey"
                value={status.server_public_key ? `${status.server_public_key.slice(0, 20)}…` : '—'}
                title={status.server_public_key ?? undefined}
              />
              <StatusCell label="Default iface" value={status.default_iface ?? '—'} />
            </div>
          )}

          {loading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading…
            </div>
          ) : peers.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {enabled
                ? 'No peers configured. Add one with `proxypilot vpn peer add <name>`.'
                : 'Enable the VPN first to add peers.'}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left border-b">
                    <th className="py-2 pr-3">Name</th>
                    <th className="py-2 pr-3">IP</th>
                    <th className="py-2 pr-3">Scope</th>
                    <th className="py-2 pr-3">Status</th>
                    <th className="py-2 pr-3">Online</th>
                    <th className="py-2 pr-3">Handshake</th>
                    <th className="py-2 pr-3">RX</th>
                    <th className="py-2 pr-3">TX</th>
                    <th className="py-2 pr-3">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {peers.map(p => {
                    const pending = pendingPeer === p.name;
                    return (
                      <tr key={p.name} className="border-b last:border-b-0 align-top">
                        <td className="py-2 pr-3 font-mono text-xs">{p.name}</td>
                        <td className="py-2 pr-3 font-mono text-xs">{p.ip}</td>
                        <td className="py-2 pr-3 text-xs">
                          <span className="inline-flex items-center gap-1 rounded border bg-muted/40 px-2 py-0.5 font-mono">
                            {p.scope}
                            {p.services?.length ? <span className="text-muted-foreground">({p.services.join(',')})</span> : null}
                          </span>
                        </td>
                        <td className="py-2 pr-3 text-xs">
                          <span className={p.status === 'enabled' ? 'text-emerald-600' : 'text-muted-foreground'}>
                            {p.status}
                          </span>
                        </td>
                        <td className="py-2 pr-3 text-xs">
                          {p.online ? <span className="text-emerald-600">yes</span> : <span className="text-muted-foreground">no</span>}
                        </td>
                        <td className="py-2 pr-3 text-xs" title={p.lastHandshakeAt ?? ''}>
                          {fmtRelative(p.lastHandshakeAt)}
                        </td>
                        <td className="py-2 pr-3 font-mono text-xs">{fmtBytes(p.rxBytes)}</td>
                        <td className="py-2 pr-3 font-mono text-xs">{fmtBytes(p.txBytes)}</td>
                        <td className="py-2 pr-3">
                          <div className="flex items-center gap-1">
                            {pending && <Loader2 className="h-3 w-3 animate-spin" />}
                            <Button
                              size="icon"
                              variant="ghost"
                              title="Rotate keypair"
                              onClick={() => rotatePeer(p)}
                              disabled={pending}
                              className="h-7 w-7"
                            >
                              <RefreshCw className="h-4 w-4" />
                            </Button>
                            {p.status === 'enabled' ? (
                              <Button
                                size="icon"
                                variant="ghost"
                                title="Disable peer"
                                onClick={() => disablePeer(p)}
                                disabled={pending}
                                className="h-7 w-7"
                              >
                                <PowerOff className="h-4 w-4" />
                              </Button>
                            ) : (
                              <Button
                                size="icon"
                                variant="ghost"
                                title="Enable peer"
                                onClick={() => enablePeer(p)}
                                disabled={pending}
                                className="h-7 w-7"
                              >
                                <Power className="h-4 w-4" />
                              </Button>
                            )}
                            <Button
                              size="icon"
                              variant="ghost"
                              title="Set scope"
                              onClick={() => openSetScope(p)}
                              disabled={pending}
                              className="h-7 w-7"
                            >
                              <Sliders className="h-4 w-4" />
                            </Button>
                            <Button
                              size="icon"
                              variant="ghost"
                              title="Remove peer"
                              onClick={() => setRemovePeer(p)}
                              disabled={pending}
                              className="h-7 w-7 text-destructive hover:text-destructive"
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Add peer (form phase). On submit the response opens the
          PeerRevealDialog with the private key + QR. The form
          dialog itself never sees the secret. */}
      <Dialog open={addPeerOpen} onOpenChange={(o) => { if (!o) { setAddPeerOpen(false); resetAddPeer(); } }}>
        <DialogContent className="w-[95vw] max-w-[95vw] sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Add VPN peer</DialogTitle>
            <DialogDescription>
              Each peer gets its own keypair and IP. The private key is shown once after
              creation — the server cannot reprint it.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 py-2">
            <div className="space-y-1">
              <Label htmlFor="peer-name">Name *</Label>
              <Input
                id="peer-name"
                value={addPeerForm.name}
                onChange={e => setAddPeerForm(f => ({ ...f, name: e.target.value }))}
                placeholder="laptop-anna"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="peer-scope">Scope *</Label>
              <select
                id="peer-scope"
                value={addPeerForm.scope}
                onChange={e => setAddPeerForm(f => ({ ...f, scope: e.target.value }))}
                className="h-9 w-full rounded border bg-background px-2 text-sm"
              >
                <option value="full">full — full network access</option>
                <option value="admin">admin — admin paths + services</option>
                <option value="services">services — explicit list only</option>
              </select>
            </div>
            {addPeerForm.scope === 'services' && (
              <div className="space-y-1">
                <Label htmlFor="peer-services">Service tags (comma-separated) *</Label>
                <Input
                  id="peer-services"
                  value={addPeerForm.services}
                  onChange={e => setAddPeerForm(f => ({ ...f, services: e.target.value }))}
                  placeholder="caddy-admin, app-postgres"
                />
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setAddPeerOpen(false); resetAddPeer(); }} disabled={addPeerBusy}>
              Cancel
            </Button>
            <Button onClick={submitAddPeer} disabled={addPeerBusy}>
              {addPeerBusy && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
              Add peer
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Reveal phase: shown for both add-peer and (later) rotate
          responses. Closing this dialog DROPS the private key from
          React state — there is no second chance. */}
      <PeerRevealDialog reveal={reveal} onClose={() => setReveal(null)} />

      {/* Set scope. Demoting the last full|admin peer trips
          LAST_FULL_ADMIN_DEMOTE on the backend; the lockout gate
          handles that path. */}
      <Dialog open={!!setScope} onOpenChange={(o) => { if (!o) setSetScope(null); }}>
        <DialogContent className="w-[95vw] max-w-[95vw] sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Set scope for "{setScope?.name}"</DialogTitle>
            <DialogDescription>
              Scope controls which firewall paths the peer can reach. Demoting the only
              full/admin peer to services-only triggers a lockout-gate confirmation.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 py-2">
            <div className="space-y-1">
              <Label htmlFor="ss-scope">Scope</Label>
              <select
                id="ss-scope"
                value={setScopeForm.scope}
                onChange={e => setSetScopeForm(f => ({ ...f, scope: e.target.value }))}
                className="h-9 w-full rounded border bg-background px-2 text-sm"
              >
                <option value="full">full</option>
                <option value="admin">admin</option>
                <option value="services">services</option>
              </select>
            </div>
            {setScopeForm.scope === 'services' && (
              <div className="space-y-1">
                <Label htmlFor="ss-services">Service tags (comma-separated) *</Label>
                <Input
                  id="ss-services"
                  value={setScopeForm.services}
                  onChange={e => setSetScopeForm(f => ({ ...f, services: e.target.value }))}
                  placeholder="caddy-admin, app-postgres"
                />
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSetScope(null)} disabled={setScopeBusy}>
              Cancel
            </Button>
            <Button onClick={submitSetScope} disabled={setScopeBusy}>
              {setScopeBusy && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Rotate confirm. Reissues the peer's keypair; the currently-
          installed config on the operator's client stops working
          until they re-import the new one shown in the reveal
          dialog that opens after this confirm. */}
      <Dialog open={!!rotateConfirmPeer} onOpenChange={(o) => { if (!o) setRotateConfirmPeer(null); }}>
        <DialogContent className="w-[95vw] max-w-[95vw] sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Rotate keypair for "{rotateConfirmPeer?.name}"?</DialogTitle>
            <DialogDescription>
              Issues a fresh keypair and IP for this peer. The current installed config
              stops working immediately — the operator must re-import the new config that
              appears after you confirm. The new private key is shown only once.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRotateConfirmPeer(null)} disabled={rotateBusy}>
              Cancel
            </Button>
            <Button onClick={confirmRotate} disabled={rotateBusy}>
              {rotateBusy && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
              Rotate
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Remove peer confirm. The lockout gate kicks in if this is the
          only enabled peer (LAST_ENABLED_PEER) or recently active
          (RECENTLY_ACTIVE). */}
      <Dialog open={!!removePeer} onOpenChange={(o) => { if (!o) setRemovePeer(null); }}>
        <DialogContent className="w-[95vw] max-w-[95vw] sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Remove peer "{removePeer?.name}"?</DialogTitle>
            <DialogDescription>
              Drops the peer from wg0.conf and the database. The peer's installed config
              stops working immediately.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRemovePeer(null)} disabled={removeBusy}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={confirmRemove} disabled={removeBusy}>
              {removeBusy && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
              Remove
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Lockout-gate typed-phrase modal. Phrase varies by gate code:
            LAST_ENABLED_PEER     → 'I understand this locks everyone out'
            RECENTLY_ACTIVE       → 'remove this active peer'
            LAST_FULL_ADMIN_DEMOTE → 'demote the last admin peer' */}
      <Dialog open={!!gate} onOpenChange={(o) => { if (!o) { setGate(null); setGatePhrase(''); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ShieldAlert className="h-5 w-5 text-red-600" />
              {gate?.action === 'remove' ? 'Force remove' : gate?.action === 'disable' ? 'Force disable' : 'Force scope change'} "{gate?.peer?.name}"?
            </DialogTitle>
            <DialogDescription>
              The CLI refused this action because: <code>{gate?.code}</code>. Confirm by
              typing the exact phrase below — this bypasses the lockout safeguard.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 py-2">
            <Label htmlFor="gate-phrase">type to confirm: <code>{gate?.phrase}</code></Label>
            <Input
              id="gate-phrase"
              autoFocus
              value={gatePhrase}
              onChange={e => setGatePhrase(e.target.value)}
              placeholder={gate?.phrase ?? ''}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setGate(null); setGatePhrase(''); }} disabled={gateBusy}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={executeGated}
              disabled={gateBusy || gatePhrase !== gate?.phrase}
            >
              {gateBusy && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
              Confirm and {gate?.action ?? 'force'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Enable VPN. The CLI generates the server keypair, writes
          wg0.conf, brings up wg-quick@wg0, and creates the
          base-wireguard firewall rule scoped to the listen port. */}
      <Dialog open={enableOpen} onOpenChange={(o) => { if (!o) setEnableOpen(false); }}>
        <DialogContent className="w-[95vw] max-w-[95vw] sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Enable VPN</DialogTitle>
            <DialogDescription>
              The public endpoint is what clients connect to (host or host:port the server is
              reachable on from the public internet). The listen port and DNS default to the
              WireGuard convention.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 py-2">
            <div className="space-y-1">
              <Label htmlFor="vpn-endpoint">Public endpoint *</Label>
              <Input
                id="vpn-endpoint"
                value={enableForm.endpoint}
                onChange={e => setEnableForm(f => ({ ...f, endpoint: e.target.value }))}
                placeholder="vpn.example.com:51820"
              />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <Label htmlFor="vpn-port">Listen port</Label>
                <Input
                  id="vpn-port"
                  type="number"
                  min="1"
                  max="65535"
                  value={enableForm.port}
                  onChange={e => setEnableForm(f => ({ ...f, port: e.target.value }))}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="vpn-dns">DNS</Label>
                <Input
                  id="vpn-dns"
                  value={enableForm.dns}
                  onChange={e => setEnableForm(f => ({ ...f, dns: e.target.value }))}
                />
                <p className="text-[10px] text-muted-foreground">
                  Goes into every peer's [Interface] block. For <strong>admin</strong> /
                  <strong> services</strong> scope peers (AllowedIPs = 10.100.0.0/24),
                  delete the <code>DNS =</code> line from the local wg config after
                  import — otherwise the OS routes DNS through the tunnel and resolution
                  fails. For <strong>full</strong> scope peers a public resolver works.
                </p>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEnableOpen(false)} disabled={enableBusy}>
              Cancel
            </Button>
            <Button onClick={submitEnable} disabled={enableBusy}>
              {enableBusy && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
              Enable
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/**
 * Once-only display of the peer's private material.
 *
 * Critical invariants:
 * - The `reveal` prop is the ONLY copy of the private key in the
 *   browser. When this dialog closes (`onClose`), the parent wipes
 *   that state — there is no server-side persistence to fall back on,
 *   the audit row only carries the public key.
 * - The QR is generated client-side from the config body via the
 *   `qrcode` package. We don't fetch a QR endpoint because that would
 *   send the private key through another HTTP round-trip.
 * - Closing the dialog is the ONLY way out: there is no auto-dismiss,
 *   no "save for later". The operator must click "I've saved it".
 */
function PeerRevealDialog({ reveal, onClose }) {
  const [qrDataUrl, setQrDataUrl] = useState('');
  const [copied, setCopied] = useState(false);
  const open = !!reveal;

  useEffect(() => {
    if (!reveal?.config) { setQrDataUrl(''); return; }
    let cancelled = false;
    QRCode.toDataURL(reveal.config, { width: 256, margin: 1 })
      .then((dataUrl) => { if (!cancelled) setQrDataUrl(dataUrl); })
      .catch((err) => {
        console.error('Failed to generate VPN QR code:', err);
        if (!cancelled) setQrDataUrl('');
      });
    return () => { cancelled = true; };
  }, [reveal]);

  async function copyConfig() {
    if (!reveal?.config) return;
    try {
      await navigator.clipboard.writeText(reveal.config);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard may be blocked; the textarea is still selectable
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="w-[95vw] max-w-[95vw] sm:max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldAlert className="h-5 w-5 text-red-600" />
            Save peer config now — server cannot reprint
          </DialogTitle>
          <DialogDescription>
            The private key below is shown only this once. The server does not store it.
            Save it to your client (or scan the QR) before closing this dialog.
          </DialogDescription>
        </DialogHeader>

        {reveal && (
          <div className="space-y-4 py-2">
            <div className="rounded border border-red-500/50 bg-red-500/10 p-3 text-sm">
              <div className="font-semibold text-red-700 dark:text-red-300">
                Peer "{reveal.name}" · {reveal.ip} · scope={reveal.scope}
                {reveal.services?.length ? ` (${reveal.services.join(',')})` : ''}
              </div>
              <div className="text-muted-foreground text-xs">
                Closing this dialog wipes the private key from the browser. There is no recovery.
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-[1fr_auto]">
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label>WireGuard config</Label>
                  <Button size="sm" variant="outline" onClick={copyConfig}>
                    {copied ? <Check className="h-4 w-4 mr-2" /> : <Copy className="h-4 w-4 mr-2" />}
                    {copied ? 'Copied' : 'Copy'}
                  </Button>
                </div>
                <textarea
                  readOnly
                  value={reveal.config ?? ''}
                  className="w-full h-72 rounded border bg-muted/40 p-2 font-mono text-xs"
                  onFocus={e => e.target.select()}
                />
              </div>
              <div className="flex flex-col items-center gap-2">
                <Label>QR (scan from WireGuard mobile)</Label>
                {qrDataUrl ? (
                  <img src={qrDataUrl} alt="WireGuard config QR" className="border rounded bg-white p-2" />
                ) : (
                  <div className="h-64 w-64 flex items-center justify-center text-xs text-muted-foreground border rounded">
                    generating…
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        <DialogFooter>
          <Button onClick={onClose}>I've saved it</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function StatusCell({ label, value, tone, title }) {
  const toneClass = tone === 'warn'
    ? 'text-amber-600 dark:text-amber-400'
    : tone === 'ok'
    ? 'text-emerald-600'
    : '';
  return (
    <div className="rounded border p-2" title={title}>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={`font-medium break-all ${toneClass}`}>{value}</div>
    </div>
  );
}
