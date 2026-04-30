import { useState, useEffect } from 'react';
import QRCode from 'qrcode';
import { api } from '@/lib/api';
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
  Plus,
  Copy,
  Check,
  ShieldAlert,
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
  const [enableForm, setEnableForm] = useState({
    endpoint: '', port: '51820', dns: '10.100.0.1',
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
                  </tr>
                </thead>
                <tbody>
                  {peers.map(p => (
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
                    </tr>
                  ))}
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
