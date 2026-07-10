// Mock2 parent-domains admin surface (Phase M1, ADR-009).
//
// Admins register a dev parent domain (dev.example.com) whose wildcard DNS
// (*.dev.example.com) points at this host. The backend verifies it in two
// stages — wildcard DNS resolves here, then a probe certificate is issued on a
// canary FQDN — and only a cert_ok + enabled domain becomes selectable for
// projects (M2). This page drives register → poll verify status → enable →
// disable/delete.
//
// Reachable only when the backend reports Mock2 enabled (GET /api/mock2/status
// → 200); a direct visit on a disabled/pinned host bounces home (ADR-001).
//
// MOBILE_FIRST: single column, stacked rows with truncation, 44px primary
// touch targets, full-screen-on-<sm confirmation dialog. Renders clean at 360px.

import { useEffect, useState, useCallback } from 'react';
import { Navigate, Link } from 'react-router-dom';
import { useAuth } from '@/context/AuthContext';
import { api, ApiError } from '@/lib/api';
import { useToast } from '@/hooks/use-toast';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import {
  ArrowLeft, Globe, Loader2, ShieldCheck, ShieldAlert, ShieldQuestion, Trash2, RefreshCw,
} from 'lucide-react';

// verify_status → { label, tone, Icon }. Tone maps to a Tailwind text color.
function statusBadge(row) {
  if (row.verifying) return { label: 'Verifying…', tone: 'text-blue-500', Icon: Loader2, spin: true };
  switch (row.verify_status) {
    // DNS-verified is the terminal success state — the per-slug cert is issued
    // when a project is created, so a dns_ok domain is ready to enable and use.
    case 'dns_ok': return { label: 'Verified (DNS)', tone: 'text-emerald-500', Icon: ShieldCheck };
    case 'cert_ok': return { label: 'Verified', tone: 'text-emerald-500', Icon: ShieldCheck };
    case 'failed': return { label: 'Failed', tone: 'text-red-500', Icon: ShieldAlert };
    default: return { label: 'Pending', tone: 'text-muted-foreground', Icon: ShieldQuestion };
  }
}

// A domain that has cleared verification (DNS today; a legacy cert_ok still
// counts) is ready to enable and to host projects.
function isVerified(row) {
  return row.verify_status === 'dns_ok' || row.verify_status === 'cert_ok';
}

export default function ParentDomains() {
  const { user } = useAuth();
  const storedUser = JSON.parse(localStorage.getItem('user') || '{}');
  const isAdmin = user?.role === 'admin' || storedUser?.role === 'admin';
  const { toast } = useToast();

  const [gate, setGate] = useState('checking'); // 'checking' | 'enabled' | 'disabled'
  const [domains, setDomains] = useState([]);
  const [loading, setLoading] = useState(true);
  const [newDomain, setNewDomain] = useState('');
  const [registering, setRegistering] = useState(false);
  const [busyId, setBusyId] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(null); // row pending deletion

  const load = useCallback(async () => {
    try {
      const res = await api.mock2ListParentDomains();
      setDomains(res.domains || []);
    } catch (err) {
      if (!(err instanceof ApiError)) console.error('load parent domains failed:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    api.mock2Status()
      .then(() => { if (!cancelled) { setGate('enabled'); load(); } })
      .catch((err) => {
        if (!cancelled) setGate('disabled');
        if (!(err instanceof ApiError)) console.error('mock2 status check failed:', err);
      });
    return () => { cancelled = true; };
  }, [load]);

  // Poll while any domain is mid-verification so the badge flips without a
  // manual refresh (verification takes seconds for the probe cert).
  useEffect(() => {
    if (gate !== 'enabled') return undefined;
    const anyVerifying = domains.some((d) => d.verify_status === 'pending' || d.verify_status === 'dns_ok');
    if (!anyVerifying) return undefined;
    const id = setInterval(load, 4000);
    return () => clearInterval(id);
  }, [gate, domains, load]);

  const register = async () => {
    const domain = newDomain.trim();
    if (!domain) return;
    setRegistering(true);
    try {
      await api.mock2RegisterParentDomain(domain);
      setNewDomain('');
      toast({ title: 'Domain registered', description: `Verifying ${domain} — this takes a few seconds.` });
      load();
    } catch (err) {
      toast({ variant: 'destructive', title: 'Could not register', description: err.message });
    } finally {
      setRegistering(false);
    }
  };

  const act = async (id, fn, okMsg) => {
    setBusyId(id);
    try {
      await fn(id);
      if (okMsg) toast({ title: okMsg });
      load();
    } catch (err) {
      toast({ variant: 'destructive', title: 'Action failed', description: err.message });
    } finally {
      setBusyId(null);
    }
  };

  const doDelete = async () => {
    const row = confirmDelete;
    setConfirmDelete(null);
    // api.request() handles the sudo-elevation modal + replay on its own.
    await act(row.id, api.mock2DeleteParentDomain, `Removed ${row.domain}`);
  };

  if (!isAdmin) return <Navigate to="/" replace />;
  if (gate === 'disabled') return <Navigate to="/" replace />;
  if (gate === 'checking') {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Globe className="h-6 w-6 shrink-0 text-primary" />
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-bold tracking-tight truncate">Parent domains</h1>
          <p className="text-sm text-muted-foreground">Dev domains for Mock2 project URLs</p>
        </div>
        <Button asChild variant="ghost" size="sm" className="shrink-0">
          <Link to="/projects"><ArrowLeft className="h-4 w-4 mr-1" />Projects</Link>
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Register a domain</CardTitle>
          <CardDescription>
            Point wildcard DNS <code className="text-xs">*.your-domain</code> at this host first.
            ProxyPilot verifies the wildcard resolves here, then you enable it. Each project gets
            its own subdomain (<code className="text-xs">&lt;project&gt;.your-domain</code>) and its
            HTTPS certificate is issued from Let&apos;s Encrypt the moment the project is created.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            onSubmit={(e) => { e.preventDefault(); register(); }}
            className="flex flex-col sm:flex-row gap-3 sm:items-end"
          >
            <div className="flex-1 min-w-0 space-y-1.5">
              <Label htmlFor="new-domain">Domain</Label>
              <Input
                id="new-domain"
                placeholder="dev.example.com"
                value={newDomain}
                onChange={(e) => setNewDomain(e.target.value)}
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
              />
            </div>
            <Button type="submit" disabled={registering || !newDomain.trim()} className="h-11 sm:h-10 shrink-0">
              {registering ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
              Register
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Registered domains</CardTitle>
          <CardDescription>Only verified &amp; enabled domains can host projects.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : domains.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4">No domains registered yet.</p>
          ) : (
            domains.map((row) => {
              const badge = statusBadge(row);
              const busy = busyId === row.id;
              return (
                <div
                  key={row.id}
                  className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 p-4 border rounded-lg"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 min-w-0">
                      <badge.Icon className={`h-4 w-4 shrink-0 ${badge.tone} ${badge.spin ? 'animate-spin' : ''}`} />
                      <span className="font-medium truncate">{row.domain}</span>
                      {row.enabled ? (
                        <span className="text-[11px] px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-500 shrink-0">enabled</span>
                      ) : null}
                    </div>
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-1 text-xs text-muted-foreground">
                      <span className={badge.tone}>{badge.label}</span>
                      {row.selectable ? <span className="text-emerald-500">selectable for projects</span> : null}
                      {row.renewal_error ? (
                        <span className="text-red-500 break-all">{row.renewal_error}</span>
                      ) : null}
                    </div>
                  </div>
                  <div className="flex gap-1 flex-wrap shrink-0">
                    {!isVerified(row) ? (
                      <Button
                        variant="outline" size="sm" disabled={busy}
                        onClick={() => act(row.id, api.mock2VerifyParentDomain, 'Verification started')}
                      >
                        <RefreshCw className={`h-4 w-4 mr-1 ${busy ? 'animate-spin' : ''}`} />Verify
                      </Button>
                    ) : null}
                    {isVerified(row) && !row.enabled ? (
                      <Button
                        variant="default" size="sm" disabled={busy}
                        onClick={() => act(row.id, api.mock2EnableParentDomain, `Enabled ${row.domain}`)}
                      >
                        Enable
                      </Button>
                    ) : null}
                    {row.enabled ? (
                      <Button
                        variant="outline" size="sm" disabled={busy}
                        onClick={() => act(row.id, api.mock2DisableParentDomain, `Disabled ${row.domain}`)}
                      >
                        Disable
                      </Button>
                    ) : null}
                    <Button
                      variant="ghost" size="icon" disabled={busy}
                      className="h-9 w-9 text-red-500 hover:text-red-600"
                      onClick={() => setConfirmDelete(row)}
                      aria-label={`Delete ${row.domain}`}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              );
            })
          )}
        </CardContent>
      </Card>

      <Dialog open={!!confirmDelete} onOpenChange={(o) => !o && setConfirmDelete(null)}>
        <DialogContent className="max-w-full h-full rounded-none sm:max-w-md sm:h-auto sm:rounded-lg">
          <DialogHeader>
            <DialogTitle>Delete parent domain?</DialogTitle>
            <DialogDescription>
              This removes <span className="font-medium">{confirmDelete?.domain}</span> and its Caddy
              site file. Any project using it would lose its URL. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="flex-col sm:flex-row gap-2">
            <Button variant="outline" onClick={() => setConfirmDelete(null)} className="h-11 sm:h-10">Cancel</Button>
            <Button variant="destructive" onClick={doDelete} className="h-11 sm:h-10">Delete</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
