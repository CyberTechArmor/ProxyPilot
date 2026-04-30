import { useState, useEffect } from 'react';
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
