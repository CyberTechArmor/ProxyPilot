import { useState, useEffect, useMemo } from 'react';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/context/AuthContext';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
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
  Shield,
  ShieldAlert,
  ShieldOff,
  RefreshCw,
  ScanLine,
  Globe,
  Wifi,
  Lock,
  HomeIcon,
  AlertTriangle,
  Plus,
} from 'lucide-react';
import { Navigate } from 'react-router-dom';

// Typed-phrase gates. The CLI always receives --yes from the backend
// (interactive y/N is meaningless over JSON), so the dashboard is the
// only place these confirmations actually happen.
const PANIC_CLOSE_PHRASE = 'close everything to recovery state';
const PUBLIC_OPEN_PHRASE = 'open this port to the public internet';

// Scope chip rendering. The CLI's renderer enforces the same set on
// the wire so an unknown value here would have failed at the API
// boundary; keeping the icons co-located with the page lets the
// table read like the CLI's `firewall list` output.
const SCOPES = ['public', 'lan-only', 'vpn-only', 'localhost-only'];
const SCOPE_ICON = {
  'public': Globe,
  'lan-only': HomeIcon,
  'vpn-only': Wifi,
  'localhost-only': Lock,
};

function fmtPort(r) {
  if (r.port_end && r.port_end !== r.port_start) return `${r.port_start}-${r.port_end}`;
  return String(r.port_start);
}

function fmtRelative(iso) {
  if (!iso) return '—';
  const ageSec = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (ageSec < 60) return `${ageSec}s ago`;
  if (ageSec < 3600) return `${Math.floor(ageSec / 60)}m ago`;
  if (ageSec < 86400) return `${Math.floor(ageSec / 3600)}h ago`;
  return `${Math.floor(ageSec / 86400)}d ago`;
}

export default function Firewall() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin' || JSON.parse(localStorage.getItem('user') || '{}').role === 'admin';
  const { toast } = useToast();

  const [rules, setRules] = useState([]);
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [reconciling, setReconciling] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [tab, setTab] = useState('base');
  // Per-row mutation flag so concurrent toggles don't overlap a
  // reconcile-after-write storm in the host CLI.
  const [pendingId, setPendingId] = useState(null);

  // Panic-close typed-phrase gate. panicOpen is just a confirm.
  const [panicCloseOpen, setPanicCloseOpen] = useState(false);
  const [panicClosePhrase, setPanicClosePhrase] = useState('');
  const [panicCloseBusy, setPanicCloseBusy] = useState(false);
  const [panicOpenOpen, setPanicOpenOpen] = useState(false);
  const [panicOpenBusy, setPanicOpenBusy] = useState(false);

  // Public-internet enable confirm: rule + typed phrase. The actual
  // enable() call is deferred until the operator types the phrase.
  const [publicConfirm, setPublicConfirm] = useState(null); // rule | null
  const [publicPhrase, setPublicPhrase] = useState('');
  const [publicBusy, setPublicBusy] = useState(false);

  // Egress state. Loaded alongside firewall on initial mount and
  // refreshed after every egress mutation. `egressServices` is the
  // NAMED_SERVICES map keyed by service name (used to populate the
  // "+ Add egress" modal's service dropdown).
  const [egressEntries, setEgressEntries] = useState([]);
  const [egressServices, setEgressServices] = useState({});
  const [egressLoading, setEgressLoading] = useState(false);
  const [egressPendingKey, setEgressPendingKey] = useState(null); // `${container}:${service}`
  const [addEgressOpen, setAddEgressOpen] = useState(false);
  const [addEgressBusy, setAddEgressBusy] = useState(false);
  const [addEgressForm, setAddEgressForm] = useState({
    container: '', service: '', reason: '', container_ip: '',
  });

  // Manual-rule modal. Mirrors the manualSchema shape on the backend
  // (port_start/end ints, proto enum, scope enum, optional service for
  // vpn-only, csv source_cidrs parsed to array, required reason).
  const [manualOpen, setManualOpen] = useState(false);
  const [manualBusy, setManualBusy] = useState(false);
  const [manualForm, setManualForm] = useState({
    port_start: '',
    port_end: '',
    proto: 'tcp',
    scope: 'lan-only',
    service: '',
    source_cidrs: '',
    reason: '',
  });

  useEffect(() => {
    if (isAdmin) {
      loadAll();
      loadEgress();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdmin]);

  if (!isAdmin) return <Navigate to="/" replace />;

  async function loadAll() {
    setLoading(true);
    try {
      const r = await api.listFirewall();
      setRules(r.rules || []);
      setStatus(r.status || null);
    } catch (e) {
      toast({ variant: 'destructive', title: 'Failed to load firewall', description: e.message });
    } finally {
      setLoading(false);
    }
  }

  async function loadEgress() {
    setEgressLoading(true);
    try {
      const r = await api.listFirewallEgress();
      setEgressEntries(r.entries || []);
      setEgressServices(r.services || {});
    } catch (e) {
      toast({ variant: 'destructive', title: 'Failed to load egress', description: e.message });
    } finally {
      setEgressLoading(false);
    }
  }

  async function handleEgressDeny(container, service) {
    const key = `${container}:${service}`;
    setEgressPendingKey(key);
    try {
      await api.denyFirewallEgress({ container, service });
      toast({ title: `Denied ${service} for ${container}` });
      loadEgress();
    } catch (e) {
      toast({ variant: 'destructive', title: 'Egress deny failed', description: e.message });
    } finally {
      setEgressPendingKey(null);
    }
  }

  async function submitAddEgress() {
    const container = addEgressForm.container.trim();
    const service = addEgressForm.service.trim();
    if (!container) { toast({ variant: 'destructive', title: 'Container required' }); return; }
    if (!service) { toast({ variant: 'destructive', title: 'Service required' }); return; }
    const body = { container, service };
    if (addEgressForm.reason.trim()) body.reason = addEgressForm.reason.trim();
    if (addEgressForm.container_ip.trim()) body.container_ip = addEgressForm.container_ip.trim();
    setAddEgressBusy(true);
    try {
      await api.allowFirewallEgress(body);
      toast({ title: `Allowed ${service} for ${container}` });
      setAddEgressOpen(false);
      setAddEgressForm({ container: '', service: '', reason: '', container_ip: '' });
      loadEgress();
    } catch (e) {
      toast({ variant: 'destructive', title: 'Egress allow failed', description: e.message });
    } finally {
      setAddEgressBusy(false);
    }
  }

  async function handleReconcile() {
    setReconciling(true);
    try {
      const r = await api.reconcileFirewall(false);
      if (r.ok && r.applied) {
        toast({ title: 'Reconciled', description: `${r.rule_count} rules, ${r.checksum}` });
      } else {
        toast({
          variant: 'destructive',
          title: 'Reconcile rejected',
          description: r.rejection?.reason ?? 'unknown',
        });
      }
      loadAll();
    } catch (e) {
      toast({ variant: 'destructive', title: 'Reconcile failed', description: e.message });
    } finally {
      setReconciling(false);
    }
  }

  async function handleScan() {
    setScanning(true);
    try {
      const r = await api.scanFirewall();
      toast({
        title: 'Scan complete',
        description: `added=${r.added ?? 0} refreshed=${r.refreshed ?? 0} gc=${r.gc ?? 0}`,
      });
      loadAll();
    } catch (e) {
      toast({ variant: 'destructive', title: 'Scan failed', description: e.message });
    } finally {
      setScanning(false);
    }
  }

  async function toggleRule(rule) {
    if (rule.enabled) {
      setPendingId(rule.id);
      try {
        await api.disableFirewallRule(rule.id);
        toast({ title: `Disabled ${rule.id}` });
        loadAll();
      } catch (e) {
        toast({ variant: 'destructive', title: 'Toggle failed', description: e.message });
      } finally {
        setPendingId(null);
      }
      return;
    }
    // Enable path. Public scope opens the port to the public internet
    // (the backend always passes --yes); the typed-phrase modal is
    // the only place the operator confirms. Anything else enables
    // immediately.
    if (rule.scope === 'public') {
      setPublicConfirm(rule);
      setPublicPhrase('');
      return;
    }
    setPendingId(rule.id);
    try {
      await api.enableFirewallRule(rule.id, {});
      toast({ title: `Enabled ${rule.id}` });
      loadAll();
    } catch (e) {
      toast({ variant: 'destructive', title: 'Toggle failed', description: e.message });
    } finally {
      setPendingId(null);
    }
  }

  async function confirmPublicEnable() {
    if (!publicConfirm || publicPhrase !== PUBLIC_OPEN_PHRASE) return;
    setPublicBusy(true);
    try {
      await api.enableFirewallRule(publicConfirm.id, { confirm: true });
      toast({ title: `Enabled ${publicConfirm.id} (public)` });
      setPublicConfirm(null);
      setPublicPhrase('');
      loadAll();
    } catch (e) {
      toast({ variant: 'destructive', title: 'Toggle failed', description: e.message });
    } finally {
      setPublicBusy(false);
    }
  }

  async function handlePanicClose() {
    if (panicClosePhrase !== PANIC_CLOSE_PHRASE) return;
    setPanicCloseBusy(true);
    try {
      const r = await api.panicCloseFirewall();
      toast({
        variant: 'destructive',
        title: 'Panic-close engaged',
        description: `${r.rule_count ?? '?'} rules · ${r.checksum ?? ''}`,
      });
      setPanicCloseOpen(false);
      setPanicClosePhrase('');
      loadAll();
    } catch (e) {
      toast({ variant: 'destructive', title: 'Panic-close failed', description: e.message });
    } finally {
      setPanicCloseBusy(false);
    }
  }

  function resetManualForm() {
    setManualForm({
      port_start: '', port_end: '', proto: 'tcp', scope: 'lan-only',
      service: '', source_cidrs: '', reason: '',
    });
  }

  async function submitManual() {
    const portStart = Number(manualForm.port_start);
    if (!Number.isInteger(portStart) || portStart < 1 || portStart > 65535) {
      toast({ variant: 'destructive', title: 'Invalid port', description: 'Start port must be 1–65535.' });
      return;
    }
    let portEnd = null;
    if (manualForm.port_end !== '') {
      portEnd = Number(manualForm.port_end);
      if (!Number.isInteger(portEnd) || portEnd < portStart || portEnd > 65535) {
        toast({ variant: 'destructive', title: 'Invalid port range', description: 'End port must be ≥ start and ≤ 65535.' });
        return;
      }
    }
    if (!manualForm.reason.trim()) {
      toast({ variant: 'destructive', title: 'Reason required' });
      return;
    }
    if (manualForm.scope === 'vpn-only' && !manualForm.service.trim()) {
      toast({ variant: 'destructive', title: 'Service required for vpn-only' });
      return;
    }
    const cidrs = manualForm.source_cidrs
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);
    const body = {
      port_start: portStart,
      port_end: portEnd,
      proto: manualForm.proto,
      scope: manualForm.scope,
      reason: manualForm.reason.trim(),
    };
    if (manualForm.scope === 'vpn-only') body.service = manualForm.service.trim();
    if (cidrs.length) body.source_cidrs = cidrs;
    setManualBusy(true);
    try {
      const r = await api.addFirewallManualRule(body);
      toast({ title: `Added manual rule ${r.rule?.id ?? ''}` });
      setManualOpen(false);
      resetManualForm();
      loadAll();
    } catch (e) {
      toast({ variant: 'destructive', title: 'Add manual rule failed', description: e.message });
    } finally {
      setManualBusy(false);
    }
  }

  async function handlePanicOpen() {
    setPanicOpenBusy(true);
    try {
      const r = await api.panicOpenFirewall();
      toast({
        title: r.alreadyOpen ? 'Already in normal state' : 'Panic-close cleared',
      });
      setPanicOpenOpen(false);
      loadAll();
    } catch (e) {
      toast({ variant: 'destructive', title: 'Panic-open failed', description: e.message });
    } finally {
      setPanicOpenBusy(false);
    }
  }

  async function changeScope(rule, nextScope) {
    if (nextScope === rule.scope) return;
    setPendingId(rule.id);
    try {
      await api.setFirewallRuleScope(rule.id, { scope: nextScope });
      toast({ title: `${rule.id} → ${nextScope}` });
      loadAll();
    } catch (e) {
      toast({ variant: 'destructive', title: 'Set scope failed', description: e.message });
    } finally {
      setPendingId(null);
    }
  }

  // Tab partitioning. Manual rules live inside state.discovered with
  // source='manual'; everything else with a non-base _section is the
  // discovered tab. Egress is its own table (separate API), shipped
  // in a follow-up commit.
  const filteredRules = useMemo(() => {
    return rules.filter(r => {
      if (tab === 'base') return r._section === 'base';
      if (tab === 'manual') return r._section === 'manual' || r.source === 'manual';
      // 'discovered' = everything else (host / lxc / docker / caddy-l4)
      return r._section !== 'base' && r._section !== 'manual' && r.source !== 'manual';
    });
  }, [rules, tab]);

  const counts = useMemo(() => ({
    base: rules.filter(r => r._section === 'base').length,
    discovered: rules.filter(r => r._section !== 'base' && r._section !== 'manual' && r.source !== 'manual').length,
    manual: rules.filter(r => r._section === 'manual' || r.source === 'manual').length,
  }), [rules]);

  return (
    <div className="space-y-6 p-4 md:p-6">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-4">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Shield className="h-5 w-5" /> Firewall
            </CardTitle>
            <CardDescription>
              Default-deny nftables ruleset managed via <code>proxypilot firewall</code>. New
              listeners surface in <em>Discovered</em> and stay disabled until you review them.
            </CardDescription>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => { resetManualForm(); setManualOpen(true); }}>
              <Plus className="h-4 w-4 mr-2" />
              Add manual rule
            </Button>
            <Button variant="outline" onClick={handleScan} disabled={scanning}>
              {scanning ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <ScanLine className="h-4 w-4 mr-2" />}
              Scan now
            </Button>
            <Button variant="outline" onClick={handleReconcile} disabled={reconciling}>
              {reconciling ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <RefreshCw className="h-4 w-4 mr-2" />}
              Reconcile
            </Button>
            {status?.panic_close ? (
              <Button variant="outline" onClick={() => setPanicOpenOpen(true)}>
                <ShieldOff className="h-4 w-4 mr-2" />
                Panic open
              </Button>
            ) : (
              <Button variant="destructive" onClick={() => { setPanicClosePhrase(''); setPanicCloseOpen(true); }}>
                <ShieldAlert className="h-4 w-4 mr-2" />
                Panic close
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {status?.panic_close && (
            <div className="flex items-start gap-2 rounded border border-amber-500/50 bg-amber-500/10 p-3 text-sm">
              <AlertTriangle className="h-5 w-5 shrink-0 text-amber-600 dark:text-amber-400" />
              <div>
                <div className="font-semibold text-amber-700 dark:text-amber-300">Panic-close active</div>
                <div className="text-muted-foreground">
                  All non-recovery rules are dropped. Use <strong>Panic open</strong> to restore normal
                  operation when the incident is resolved.
                </div>
              </div>
            </div>
          )}
          {status && (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
              <StatusCell label="Backend" value={`${status.backend ?? 'nftables'} (${status.table ?? 'inet/proxypilot'})`} />
              <StatusCell label="Default policy" value={status.default_policy ?? '—'} />
              <StatusCell
                label="Panic-close"
                value={status.panic_close ? 'YES' : 'no'}
                tone={status.panic_close ? 'warn' : 'ok'}
              />
              <StatusCell
                label="Last reconcile"
                value={
                  status.last_reconcile
                    ? `${status.last_reconcile.applied ? 'applied' : `rejected (${status.last_reconcile.rejection_reason ?? '?'})`} · ${status.last_reconcile.rule_count} rules`
                    : 'never'
                }
                tone={status.last_reconcile?.applied === false ? 'warn' : undefined}
              />
            </div>
          )}

          <Tabs value={tab} onValueChange={setTab}>
            <TabsList>
              <TabsTrigger value="base">Base ({counts.base})</TabsTrigger>
              <TabsTrigger value="discovered">Discovered ({counts.discovered})</TabsTrigger>
              <TabsTrigger value="manual">Manual ({counts.manual})</TabsTrigger>
              <TabsTrigger value="egress">Egress ({egressEntries.length})</TabsTrigger>
            </TabsList>
          </Tabs>

          {tab === 'egress' ? (
            <EgressPanel
              loading={egressLoading}
              entries={egressEntries}
              services={egressServices}
              pendingKey={egressPendingKey}
              onDeny={handleEgressDeny}
              onAdd={() => {
                setAddEgressForm({
                  container: '',
                  service: Object.keys(egressServices)[0] ?? '',
                  reason: '',
                  container_ip: '',
                });
                setAddEgressOpen(true);
              }}
            />
          ) : loading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading…
            </div>
          ) : filteredRules.length === 0 ? (
            <p className="text-sm text-muted-foreground">No rules in this section.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left border-b">
                    <th className="py-2 pr-3">ID</th>
                    <th className="py-2 pr-3">Source</th>
                    <th className="py-2 pr-3">Port</th>
                    <th className="py-2 pr-3">Proto</th>
                    <th className="py-2 pr-3">Scope</th>
                    <th className="py-2 pr-3">Service</th>
                    <th className="py-2 pr-3">Reason</th>
                    <th className="py-2 pr-3" title="Last time the discovery scan saw this listener">Last seen</th>
                    <th className="py-2 pr-3">Enabled</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredRules.map(rule => {
                    const Icon = SCOPE_ICON[rule.scope] ?? Globe;
                    const pending = pendingId === rule.id;
                    return (
                      <tr key={rule.id} className="border-b last:border-b-0 align-top">
                        <td className="py-2 pr-3 font-mono text-xs">{rule.id}</td>
                        <td className="py-2 pr-3">
                          <span className="text-xs">
                            {rule._section}
                            {rule.container ? ` · ${rule.container}` : ''}
                            {rule.process ? ` (${rule.process})` : ''}
                          </span>
                        </td>
                        <td className="py-2 pr-3 font-mono text-xs">{fmtPort(rule)}</td>
                        <td className="py-2 pr-3 font-mono text-xs">{rule.proto}</td>
                        <td className="py-2 pr-3">
                          <select
                            value={rule.scope}
                            onChange={e => changeScope(rule, e.target.value)}
                            disabled={pending}
                            className="h-8 rounded border bg-background px-2 text-xs"
                            title={rule.source_cidrs ? `Source CIDRs: ${rule.source_cidrs.join(', ')}` : 'No source CIDR pin'}
                          >
                            {SCOPES.map(s => <option key={s} value={s}>{s}</option>)}
                          </select>
                          <Icon className="h-3 w-3 inline-block ml-2 text-muted-foreground" />
                        </td>
                        <td className="py-2 pr-3 text-xs">{rule.service ?? '—'}</td>
                        <td className="py-2 pr-3 text-xs">{rule.reason ?? '—'}</td>
                        <td className="py-2 pr-3 text-xs" title={rule.last_seen}>
                          {fmtRelative(rule.last_seen)}
                        </td>
                        <td className="py-2 pr-3">
                          <Button
                            size="sm"
                            variant={rule.enabled ? 'default' : 'outline'}
                            onClick={() => toggleRule(rule)}
                            disabled={pending}
                          >
                            {pending && <Loader2 className="h-3 w-3 animate-spin mr-1" />}
                            {rule.enabled ? 'on' : 'off'}
                          </Button>
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

      {/* Add per-container egress allow. Service dropdown is keyed
          off NAMED_SERVICES from the egress endpoint's response. */}
      <Dialog open={addEgressOpen} onOpenChange={(o) => { if (!o) setAddEgressOpen(false); }}>
        <DialogContent className="w-[95vw] max-w-[95vw] sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Allow container egress</DialogTitle>
            <DialogDescription>
              Default-deny applies to all bridge → host flows. Pick a named service the
              container should be allowed to reach.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 py-2">
            <div className="space-y-1">
              <Label htmlFor="eg-container">Container *</Label>
              <Input
                id="eg-container"
                value={addEgressForm.container}
                onChange={e => setAddEgressForm(f => ({ ...f, container: e.target.value }))}
                placeholder="e.g. pp-app"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="eg-service">Service *</Label>
              <select
                id="eg-service"
                value={addEgressForm.service}
                onChange={e => setAddEgressForm(f => ({ ...f, service: e.target.value }))}
                className="h-9 w-full rounded border bg-background px-2 text-sm"
              >
                {Object.keys(egressServices).length === 0 && (
                  <option value="">no named services available</option>
                )}
                {Object.keys(egressServices).map(name => (
                  <option key={name} value={name}>{name}</option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="eg-ip">Container IP (optional pin)</Label>
              <Input
                id="eg-ip"
                value={addEgressForm.container_ip}
                onChange={e => setAddEgressForm(f => ({ ...f, container_ip: e.target.value }))}
                placeholder="leave blank to use whatever IP the container has now"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="eg-reason">Reason (optional)</Label>
              <Input
                id="eg-reason"
                value={addEgressForm.reason}
                onChange={e => setAddEgressForm(f => ({ ...f, reason: e.target.value }))}
                placeholder="why this container needs this service"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddEgressOpen(false)} disabled={addEgressBusy}>
              Cancel
            </Button>
            <Button onClick={submitAddEgress} disabled={addEgressBusy}>
              {addEgressBusy && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
              Allow
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Add manual rule. Mirrors the backend's manualSchema: port
          range, proto, scope, optional service (required for
          vpn-only), comma-separated source CIDRs, and a free-form
          reason that ends up in the audit row + the rule's
          `reason` field. */}
      <Dialog open={manualOpen} onOpenChange={(o) => { if (!o) { setManualOpen(false); resetManualForm(); } }}>
        <DialogContent className="w-[95vw] max-w-[95vw] sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Add manual firewall rule</DialogTitle>
            <DialogDescription>
              Manual rules live alongside discovered listeners. Reconcile runs after submit.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 py-2">
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <Label htmlFor="m-port-start">Port (start) *</Label>
                <Input
                  id="m-port-start"
                  type="number"
                  min="1"
                  max="65535"
                  value={manualForm.port_start}
                  onChange={e => setManualForm(f => ({ ...f, port_start: e.target.value }))}
                  placeholder="22"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="m-port-end">Port (end, optional)</Label>
                <Input
                  id="m-port-end"
                  type="number"
                  min="1"
                  max="65535"
                  value={manualForm.port_end}
                  onChange={e => setManualForm(f => ({ ...f, port_end: e.target.value }))}
                  placeholder=""
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <Label htmlFor="m-proto">Proto *</Label>
                <select
                  id="m-proto"
                  value={manualForm.proto}
                  onChange={e => setManualForm(f => ({ ...f, proto: e.target.value }))}
                  className="h-9 w-full rounded border bg-background px-2 text-sm"
                >
                  <option value="tcp">tcp</option>
                  <option value="udp">udp</option>
                </select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="m-scope">Scope *</Label>
                <select
                  id="m-scope"
                  value={manualForm.scope}
                  onChange={e => setManualForm(f => ({ ...f, scope: e.target.value }))}
                  className="h-9 w-full rounded border bg-background px-2 text-sm"
                >
                  {SCOPES.map(s => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
            </div>
            {manualForm.scope === 'vpn-only' && (
              <div className="space-y-1">
                <Label htmlFor="m-service">Service tag * (vpn-only requires it)</Label>
                <Input
                  id="m-service"
                  value={manualForm.service}
                  onChange={e => setManualForm(f => ({ ...f, service: e.target.value }))}
                  placeholder="e.g. caddy-admin"
                />
              </div>
            )}
            <div className="space-y-1">
              <Label htmlFor="m-cidrs">Source CIDRs (comma-separated, optional)</Label>
              <Input
                id="m-cidrs"
                value={manualForm.source_cidrs}
                onChange={e => setManualForm(f => ({ ...f, source_cidrs: e.target.value }))}
                placeholder="10.0.0.0/8, 192.168.1.0/24"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="m-reason">Reason *</Label>
              <Input
                id="m-reason"
                value={manualForm.reason}
                onChange={e => setManualForm(f => ({ ...f, reason: e.target.value }))}
                placeholder="why this rule exists — surfaces in the audit log"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setManualOpen(false); resetManualForm(); }} disabled={manualBusy}>
              Cancel
            </Button>
            <Button onClick={submitManual} disabled={manualBusy}>
              {manualBusy && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
              Add rule
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Public-internet enable confirm. The CLI's interactive y/N
          is bypassed by --yes from the backend; this is the only
          place the operator confirms exposing the port. */}
      <Dialog open={!!publicConfirm} onOpenChange={(o) => { if (!o) { setPublicConfirm(null); setPublicPhrase(''); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Open {publicConfirm?.id} to the public internet?</DialogTitle>
            <DialogDescription>
              This rule will accept traffic from any source IP. Make sure you understand the
              listener — port <code>{publicConfirm ? fmtPort(publicConfirm) : ''}</code> /
              <code>{publicConfirm?.proto}</code>{publicConfirm?.service ? ` (${publicConfirm.service})` : ''}.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 py-2">
            <Label htmlFor="public-phrase">type to confirm: <code>{PUBLIC_OPEN_PHRASE}</code></Label>
            <Input
              id="public-phrase"
              autoFocus
              value={publicPhrase}
              onChange={e => setPublicPhrase(e.target.value)}
              placeholder={PUBLIC_OPEN_PHRASE}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setPublicConfirm(null); setPublicPhrase(''); }} disabled={publicBusy}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={confirmPublicEnable}
              disabled={publicBusy || publicPhrase !== PUBLIC_OPEN_PHRASE}
            >
              {publicBusy && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
              Open to public
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Panic-close: drop everything except the recovery rules. */}
      <Dialog open={panicCloseOpen} onOpenChange={(o) => { if (!o) { setPanicCloseOpen(false); setPanicClosePhrase(''); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Engage panic-close?</DialogTitle>
            <DialogDescription>
              Every non-recovery rule is dropped immediately. SSH from the recovery CIDR set
              keeps working; everything else stops. Use this for active incidents only.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 py-2">
            <Label htmlFor="panic-phrase">type to confirm: <code>{PANIC_CLOSE_PHRASE}</code></Label>
            <Input
              id="panic-phrase"
              autoFocus
              value={panicClosePhrase}
              onChange={e => setPanicClosePhrase(e.target.value)}
              placeholder={PANIC_CLOSE_PHRASE}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setPanicCloseOpen(false); setPanicClosePhrase(''); }} disabled={panicCloseBusy}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handlePanicClose}
              disabled={panicCloseBusy || panicClosePhrase !== PANIC_CLOSE_PHRASE}
            >
              {panicCloseBusy && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
              Engage panic-close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Panic-open: clear panic-close, restore the saved ruleset. */}
      <Dialog open={panicOpenOpen} onOpenChange={(o) => { if (!o) setPanicOpenOpen(false); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Clear panic-close?</DialogTitle>
            <DialogDescription>
              Restore the saved ruleset. Rules that were enabled before panic-close come back
              to whatever state they were in.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPanicOpenOpen(false)} disabled={panicOpenBusy}>
              Cancel
            </Button>
            <Button onClick={handlePanicOpen} disabled={panicOpenBusy}>
              {panicOpenBusy && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
              Clear panic-close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function EgressPanel({ loading, entries, services, pendingKey, onDeny, onAdd }) {
  const serviceCount = Object.keys(services).length;
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <p className="text-xs text-muted-foreground">
          Default-deny on bridge → host. {serviceCount} named service{serviceCount === 1 ? '' : 's'} known.
        </p>
        <Button size="sm" variant="outline" onClick={onAdd} disabled={serviceCount === 0}>
          <Plus className="h-4 w-4 mr-2" />
          Add egress
        </Button>
      </div>
      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </div>
      ) : entries.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No container-egress allow rules. Default-deny applies to every bridge → host flow.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left border-b">
                <th className="py-2 pr-3">Container</th>
                <th className="py-2 pr-3">Allowed services</th>
                <th className="py-2 pr-3">Reason</th>
                <th className="py-2 pr-3">Container IP</th>
              </tr>
            </thead>
            <tbody>
              {entries.map(e => (
                <tr key={e.container} className="border-b last:border-b-0 align-top">
                  <td className="py-2 pr-3 font-mono text-xs">{e.container}</td>
                  <td className="py-2 pr-3">
                    <div className="flex flex-wrap gap-1">
                      {(e.allow ?? []).map(svc => {
                        const key = `${e.container}:${svc}`;
                        const pending = pendingKey === key;
                        return (
                          <span key={svc} className="inline-flex items-center gap-1 rounded border bg-muted/40 px-2 py-0.5 text-xs">
                            <span className="font-mono">{svc}</span>
                            <button
                              type="button"
                              onClick={() => onDeny(e.container, svc)}
                              disabled={pending}
                              title={`Deny ${svc} for ${e.container}`}
                              className="ml-1 inline-flex h-4 w-4 items-center justify-center rounded hover:bg-destructive/20 disabled:opacity-50"
                            >
                              {pending ? <Loader2 className="h-3 w-3 animate-spin" /> : <span className="leading-none">×</span>}
                            </button>
                          </span>
                        );
                      })}
                    </div>
                  </td>
                  <td className="py-2 pr-3 text-xs">{e.reason ?? '—'}</td>
                  <td className="py-2 pr-3 font-mono text-xs">{e.container_ip ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function StatusCell({ label, value, tone }) {
  const toneClass = tone === 'warn'
    ? 'text-amber-600 dark:text-amber-400'
    : tone === 'ok'
    ? 'text-emerald-600'
    : '';
  return (
    <div className="rounded border p-2">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={`font-medium ${toneClass}`}>{value}</div>
    </div>
  );
}
