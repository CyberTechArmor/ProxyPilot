import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '@/context/AuthContext';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Globe, Loader2, Eye, EyeOff, CheckCircle2,
  XCircle, AlertTriangle, Lock, Sparkles,
} from 'lucide-react';

// Add Domain — ADMIN-GATED dashboard page: provision a domain on the Caddy
// reverse proxy with an automatic Let's Encrypt certificate. Requests ride
// the normal admin cookie session (CSRF included) through the api client;
// the provisioning API keys managed on the Domains page remain for
// scripted/API clients hitting the same endpoints with X-API-Key.
//
// The Cloudflare token field is a Caddy-facing credential (DNS-01
// challenge only): shown only when DNS-01 applies, masked, optional
// (blank = the server's global token), and never echoed back.

const METHOD_LABELS = {
  http01: "Standard Let's Encrypt (HTTP-01 / TLS-ALPN)",
  dns01: "Let's Encrypt via Cloudflare DNS-01",
};

export default function AddDomain() {
  const { user } = useAuth();
  const storedUser = (() => { try { return JSON.parse(localStorage.getItem('user') || 'null'); } catch { return null; } })();
  const isAdmin = user?.role === 'admin' || storedUser?.role === 'admin';

  const [globalTokenAvailable, setGlobalTokenAvailable] = useState(false);

  // ---- form ----
  const [domain, setDomain] = useState('');
  const [upstream, setUpstream] = useState('');
  const [method, setMethod] = useState('auto');
  const [wildcard, setWildcard] = useState(false);
  const [acmeEmail, setAcmeEmail] = useState('');
  const [cfToken, setCfToken] = useState('');
  const [showCfToken, setShowCfToken] = useState(false);

  // ---- resolution preview / submit / issuance ----
  const [resolved, setResolved] = useState(null); // { method, reason } | { error, method, needsToken }
  const [submitBusy, setSubmitBusy] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const [result, setResult] = useState(null); // provision response
  const [issuance, setIssuance] = useState(null); // status poll payload
  const pollTimer = useRef(null);

  useEffect(() => {
    if (!isAdmin) return;
    api.domainProvisionAccess()
      .then((r) => setGlobalTokenAvailable(!!r.globalTokenAvailable))
      .catch(() => undefined);
  }, [isAdmin]);

  // Live method resolution: debounce while the admin types so the resolved
  // certificate path (and any blocker, e.g. wildcard with no token) is
  // visible BEFORE submit.
  const resolveNow = useCallback(async () => {
    if (!isAdmin) return;
    const d = domain.trim();
    if (!d || !d.includes('.')) { setResolved(null); return; }
    try {
      const r = await api.domainProvisionResolve({
        domain: d,
        upstream: upstream.trim() || 'localhost:80',
        method, wildcard,
        acmeEmail: acmeEmail.trim() || 'placeholder@example.com',
        cfToken: cfToken.trim(),
      });
      setResolved(r.ok ? { method: r.method, reason: r.reason } : { error: r.error, method: r.method, needsToken: r.needsToken });
      if (typeof r.globalTokenAvailable === 'boolean') setGlobalTokenAvailable(r.globalTokenAvailable);
    } catch {
      setResolved(null); // preview only — submit re-validates everything
    }
  }, [isAdmin, domain, upstream, method, wildcard, acmeEmail, cfToken]);

  useEffect(() => {
    const t = setTimeout(resolveNow, 350);
    return () => clearTimeout(t);
  }, [resolveNow]);

  const dnsApplies = resolved?.method === 'dns01' || wildcard || method === 'dns01';

  const startPolling = useCallback((d) => {
    const startedAt = Date.now();
    const tick = async () => {
      try {
        const s = await api.domainProvisionIssuance(d);
        setIssuance(s);
        if (s.status === 'issued') return; // done — stop polling
      } catch { /* transient; keep polling */ }
      if (Date.now() - startedAt < 5 * 60 * 1000) {
        pollTimer.current = setTimeout(tick, 5000);
      }
    };
    tick();
  }, []);

  useEffect(() => () => clearTimeout(pollTimer.current), []);

  const submit = async (e) => {
    e.preventDefault();
    setSubmitBusy(true);
    setSubmitError('');
    setResult(null);
    setIssuance(null);
    try {
      const r = await api.domainProvision({
        domain: domain.trim(),
        upstream: upstream.trim(),
        method, wildcard,
        acmeEmail: acmeEmail.trim(),
        cfToken: cfToken.trim(),
      });
      setResult(r);
      setCfToken(''); // the credential's job is done client-side
      startPolling(r.domain);
    } catch (err) {
      setSubmitError(err.message);
    } finally {
      setSubmitBusy(false);
    }
  };

  const issuanceBadge = () => {
    const status = issuance?.status || result?.status || 'pending';
    if (status === 'issued') {
      return (
        <div className="flex items-start gap-3 rounded-lg border border-green-500/30 bg-green-500/10 p-4">
          <CheckCircle2 className="h-5 w-5 shrink-0 text-green-500 mt-0.5" />
          <div>
            <p className="font-medium">Certificate issued</p>
            <p className="text-sm text-muted-foreground">
              https://{result.domain} is live{result.wildcard ? ` (including *.${result.domain})` : ''}.
              Caddy renews it automatically before expiry — nothing more to do.
            </p>
          </div>
        </div>
      );
    }
    if (status === 'failed') {
      return (
        <div className="flex items-start gap-3 rounded-lg border border-red-500/30 bg-red-500/10 p-4">
          <XCircle className="h-5 w-5 shrink-0 text-red-500 mt-0.5" />
          <div className="min-w-0">
            <p className="font-medium">Certificate issuance failed</p>
            <p className="text-sm text-muted-foreground break-words">{issuance.error}</p>
            {issuance.detail && (
              <p className="mt-1 text-xs font-mono text-muted-foreground/80 break-all">{issuance.detail}</p>
            )}
            <p className="mt-1 text-xs text-muted-foreground">Caddy keeps retrying with backoff — fixing the cause above is usually enough.</p>
          </div>
        </div>
      );
    }
    return (
      <div className="flex items-start gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-4">
        <Loader2 className="h-5 w-5 shrink-0 animate-spin text-amber-500 mt-0.5" />
        <div>
          <p className="font-medium">Obtaining the certificate…</p>
          <p className="text-sm text-muted-foreground">{result?.message || 'Caddy is completing the ACME challenge.'}</p>
        </div>
      </div>
    );
  };

  if (!isAdmin) {
    return (
      <div className="flex flex-col items-center justify-center py-24 gap-3 text-center px-4">
        <Lock className="h-8 w-8 text-muted-foreground" />
        <p className="font-medium">Administrators only</p>
        <p className="text-sm text-muted-foreground max-w-sm">
          Adding domains to the proxy is limited to administrator accounts. Ask an admin if you need a domain provisioned.
        </p>
      </div>
    );
  }

  return (
    <div className="max-w-xl space-y-6">
      <div className="flex items-center gap-3">
        <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary/15">
          <Globe className="h-6 w-6 text-primary" />
        </div>
        <div>
          <h1 className="text-xl font-semibold leading-tight">Add a domain</h1>
          <p className="text-sm text-muted-foreground">
            Provision a domain on this proxy with automatic HTTPS — issued and renewed for you.
          </p>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Domain details</CardTitle>
          <CardDescription>
            ProxyPilot writes the Caddy config, reloads it, and obtains the certificate.
            Renewal is automatic forever.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="domain">Domain name</Label>
                <Input id="domain" value={domain} onChange={(e) => setDomain(e.target.value)}
                  placeholder="example.com" required className="min-h-[44px]" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="upstream">Upstream (backend target)</Label>
                <Input id="upstream" value={upstream} onChange={(e) => setUpstream(e.target.value)}
                  placeholder="localhost:8080" required className="min-h-[44px]" />
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="method">Certificate method</Label>
                <select
                  id="method"
                  value={method}
                  onChange={(e) => setMethod(e.target.value)}
                  className="flex w-full min-h-[44px] rounded-md border border-input bg-background px-3 py-2 text-sm"
                >
                  <option value="auto">Auto (recommended)</option>
                  <option value="http01">Standard Let&apos;s Encrypt</option>
                  <option value="dns01">Cloudflare DNS-01</option>
                </select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="email">ACME contact email</Label>
                <Input id="email" type="email" value={acmeEmail} onChange={(e) => setAcmeEmail(e.target.value)}
                  placeholder="you@example.com" required className="min-h-[44px]" />
              </div>
            </div>

            <label className="flex items-start gap-3 rounded-lg border p-3 cursor-pointer min-h-[44px]">
              <input
                type="checkbox"
                checked={wildcard}
                onChange={(e) => setWildcard(e.target.checked)}
                className="mt-1 h-4 w-4"
              />
              <span className="text-sm">
                <span className="font-medium">Wildcard certificate</span>
                <span className="block text-muted-foreground">
                  Also cover *.{domain.trim() || 'example.com'} with one certificate.
                  Wildcards can only be issued via DNS validation, so this forces the Cloudflare DNS-01 method.
                </span>
              </span>
            </label>

            {dnsApplies && (
              <div className="space-y-2">
                <Label htmlFor="cftoken">Cloudflare API token <span className="text-muted-foreground font-normal">(optional override)</span></Label>
                <div className="relative">
                  <Input
                    id="cftoken"
                    type={showCfToken ? 'text' : 'password'}
                    autoComplete="off"
                    value={cfToken}
                    onChange={(e) => setCfToken(e.target.value)}
                    placeholder={globalTokenAvailable ? 'Leave blank to use the server’s global token' : 'Required — no global token is configured'}
                    className="pr-11 min-h-[44px]"
                  />
                  <button
                    type="button"
                    onClick={() => setShowCfToken((v) => !v)}
                    className="absolute right-0 top-0 flex h-full w-11 items-center justify-center text-muted-foreground"
                    aria-label={showCfToken ? 'Hide token' : 'Show token'}
                  >
                    {showCfToken ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
                <p className="text-xs text-muted-foreground">
                  Only used for DNS validation. Needs <span className="font-mono">Zone → DNS → Edit</span> and{' '}
                  <span className="font-mono">Zone → Zone → Read</span> on this domain&apos;s zone. Stored encrypted so
                  renewals keep working; never shown again.
                </p>
              </div>
            )}

            {resolved && (
              resolved.error ? (
                <div className="flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm">
                  <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0 text-red-500" />
                  <span>{resolved.error}</span>
                </div>
              ) : (
                <div className="flex items-start gap-2 rounded-lg border border-primary/30 bg-primary/5 p-3 text-sm">
                  <Sparkles className="h-4 w-4 mt-0.5 shrink-0 text-primary" />
                  <span>
                    <span className="font-medium">Will use: {METHOD_LABELS[resolved.method]}.</span>{' '}
                    <span className="text-muted-foreground">{resolved.reason}</span>
                  </span>
                </div>
              )
            )}

            {submitError && (
              <div className="flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm">
                <XCircle className="h-4 w-4 mt-0.5 shrink-0 text-red-500" />
                <span className="break-words">{submitError}</span>
              </div>
            )}

            <Button
              type="submit"
              disabled={submitBusy || !!resolved?.error}
              className="w-full min-h-[44px]"
            >
              {submitBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Globe className="h-4 w-4" />}
              <span className="ml-2">{submitBusy ? 'Provisioning…' : 'Provision domain'}</span>
            </Button>
          </form>
        </CardContent>
      </Card>

      {result && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Status — {result.domain}</CardTitle>
            <CardDescription>
              Issued via {METHOD_LABELS[result.method]}. {result.methodReason}
            </CardDescription>
          </CardHeader>
          <CardContent>{issuanceBadge()}</CardContent>
        </Card>
      )}
    </div>
  );
}
