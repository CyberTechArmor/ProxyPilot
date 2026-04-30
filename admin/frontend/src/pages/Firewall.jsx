import { useState, useEffect, useMemo } from 'react';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/context/AuthContext';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useToast } from '@/hooks/use-toast';
import {
  Loader2,
  Shield,
  RefreshCw,
  ScanLine,
  Globe,
  Wifi,
  Lock,
  HomeIcon,
} from 'lucide-react';
import { Navigate } from 'react-router-dom';

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

  useEffect(() => {
    if (isAdmin) loadAll();
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
    setPendingId(rule.id);
    try {
      if (rule.enabled) {
        await api.disableFirewallRule(rule.id);
        toast({ title: `Disabled ${rule.id}` });
      } else {
        // Public scope on enable would normally trip the CLI's y/N
        // prompt; the backend always passes --yes. The dashboard
        // could add a typed-phrase guard here later, but the operator
        // already sees the scope chip + reason so the UI signal is
        // present.
        await api.enableFirewallRule(rule.id, {});
        toast({ title: `Enabled ${rule.id}` });
      }
      loadAll();
    } catch (e) {
      toast({ variant: 'destructive', title: 'Toggle failed', description: e.message });
    } finally {
      setPendingId(null);
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
            <Button variant="outline" onClick={handleScan} disabled={scanning}>
              {scanning ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <ScanLine className="h-4 w-4 mr-2" />}
              Scan now
            </Button>
            <Button variant="outline" onClick={handleReconcile} disabled={reconciling}>
              {reconciling ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <RefreshCw className="h-4 w-4 mr-2" />}
              Reconcile
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
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
            </TabsList>
          </Tabs>

          {loading ? (
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
