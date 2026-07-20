import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useToast } from '@/hooks/use-toast';
import {
  Globe, KeyRound, Loader2, Plus, Trash2, Copy, Check, ShieldCheck,
  AlertTriangle, ExternalLink, ListChecks, Cloud, Eye, EyeOff, Download,
} from 'lucide-react';

// Admin management for the self-service "Add Domain" page (/add-domain):
// provisioning API keys (shown once, stored hashed), the DNS-01
// specified-domain list, and the provisioned-domain records. Cloudflare
// tokens are intentionally absent everywhere here — the server only ever
// reports presence ("set"), never values.

const METHOD_SHORT = { http01: "Let's Encrypt (HTTP-01)", dns01: 'Cloudflare DNS-01' };
const STATUS_TONE = {
  issued: 'text-green-500',
  pending: 'text-amber-500',
  failed: 'text-red-500',
};

export default function DomainProvisioning() {
  const { toast } = useToast();
  const [status, setStatus] = useState(null);
  const [keys, setKeys] = useState([]);
  const [domains, setDomains] = useState([]);
  const [dnsList, setDnsList] = useState('');
  const [dnsSaved, setDnsSaved] = useState([]);
  const [loading, setLoading] = useState(true);

  const [cfTokenInput, setCfTokenInput] = useState('');
  const [showCfToken, setShowCfToken] = useState(false);
  const [savingCfToken, setSavingCfToken] = useState(false);
  const [installingPlugin, setInstallingPlugin] = useState(false);

  const [newKeyName, setNewKeyName] = useState('');
  const [creatingKey, setCreatingKey] = useState(false);
  const [freshKey, setFreshKey] = useState(null); // { name, key } — shown ONCE
  const [copied, setCopied] = useState(false);
  const [savingList, setSavingList] = useState(false);

  const load = useCallback(async () => {
    try {
      const [s, k, d, l] = await Promise.all([
        api.domainProvisionStatus(),
        api.domainProvisionKeys(),
        api.domainProvisionDomains(),
        api.domainProvisionDns01List(),
      ]);
      setStatus(s);
      setKeys(k.keys || []);
      setDomains(d.domains || []);
      setDnsSaved(l.list || []);
      setDnsList((l.list || []).join('\n'));
    } catch (e) {
      toast({ title: 'Could not load domain provisioning', description: e.message, variant: 'destructive' });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => { load(); }, [load]);

  const saveCfToken = async (e) => {
    e.preventDefault();
    if (!cfTokenInput.trim()) return;
    setSavingCfToken(true);
    try {
      const r = await api.domainCloudflareTokenSave(cfTokenInput.trim());
      setCfTokenInput('');
      setStatus((s) => ({ ...s, globalTokenAvailable: r.globalTokenAvailable, globalTokenSource: r.globalTokenSource }));
      toast({ title: 'Cloudflare connected', description: 'The global token is saved (encrypted) and will be used for every DNS-01 domain.' });
    } catch (err) {
      toast({ title: 'Could not save the token', description: err.message, variant: 'destructive' });
    } finally {
      setSavingCfToken(false);
    }
  };

  const clearCfToken = async () => {
    if (!window.confirm('Remove the saved global Cloudflare token? Already-provisioned domains keep renewing (their credential is stored per-domain), but new DNS-01 domains will need a token again.')) return;
    try {
      const r = await api.domainCloudflareTokenClear();
      setStatus((s) => ({ ...s, globalTokenAvailable: r.globalTokenAvailable, globalTokenSource: r.globalTokenSource }));
      toast({ title: 'Global Cloudflare token removed' });
    } catch (err) {
      toast({ title: 'Could not remove the token', description: err.message, variant: 'destructive' });
    }
  };

  const installPlugin = async () => {
    setInstallingPlugin(true);
    try {
      const r = await api.domainCloudflarePluginInstall();
      setStatus((s) => ({ ...s, cloudflarePlugin: r.cloudflarePlugin }));
      toast({ title: 'Cloudflare DNS plugin ready', description: r.message });
    } catch (err) {
      toast({ title: 'Plugin install failed', description: err.message, variant: 'destructive' });
    } finally {
      setInstallingPlugin(false);
    }
  };

  const createKey = async (e) => {
    e.preventDefault();
    if (!newKeyName.trim()) return;
    setCreatingKey(true);
    try {
      const r = await api.domainProvisionKeyCreate(newKeyName.trim());
      setFreshKey(r);
      setNewKeyName('');
      setCopied(false);
      load();
    } catch (err) {
      toast({ title: 'Could not create the key', description: err.message, variant: 'destructive' });
    } finally {
      setCreatingKey(false);
    }
  };

  const revokeKey = async (k) => {
    if (!window.confirm(`Revoke the key "${k.name}"? Anyone using it loses access to the Add Domain page immediately.`)) return;
    try {
      await api.domainProvisionKeyRevoke(k.id);
      load();
    } catch (err) {
      toast({ title: 'Could not revoke the key', description: err.message, variant: 'destructive' });
    }
  };

  const saveDnsList = async () => {
    setSavingList(true);
    try {
      const r = await api.domainProvisionDns01Save(dnsList.split('\n'));
      setDnsSaved(r.list || []);
      setDnsList((r.list || []).join('\n'));
      toast({ title: 'DNS-01 domain list saved', description: `${(r.list || []).length} entr${(r.list || []).length === 1 ? 'y' : 'ies'}.` });
    } catch (err) {
      toast({ title: 'Could not save the list', description: err.message, variant: 'destructive' });
    } finally {
      setSavingList(false);
    }
  };

  const deleteDomain = async (d) => {
    if (!window.confirm(`Remove ${d.domain} from the proxy? The site stops being served; the issued certificate stays cached in Caddy.`)) return;
    try {
      await api.domainProvisionDomainDelete(d.id);
      load();
    } catch (err) {
      toast({ title: 'Could not remove the domain', description: err.message, variant: 'destructive' });
    }
  };

  const copyFreshKey = async () => {
    try {
      await navigator.clipboard.writeText(freshKey.key);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard denied — the key is still visible to copy by hand */ }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Globe className="h-6 w-6" /> Domain Provisioning
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            HTTPS domains on the proxy. Admins provision at{' '}
            <Link to="/add-domain" className="underline inline-flex items-center gap-1">
              Add Domain <ExternalLink className="h-3 w-3" />
            </Link>
            ; the API keys below authenticate scripted/API clients on the same endpoints.
          </p>
        </div>
      </div>

      {/* Cloudflare connection — everything needed for DNS-01, from here */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Cloud className="h-4 w-4" /> Cloudflare connection
          </CardTitle>
          <CardDescription>
            Needed only for the DNS-01 method (wildcards, geo-blocked domains, the DNS-01 list below).
            Create a token in Cloudflare (My Profile → API Tokens → &quot;Edit zone DNS&quot; template) with{' '}
            <span className="font-mono">Zone → DNS → Edit</span> and <span className="font-mono">Zone → Zone → Read</span>{' '}
            on your zone, and paste it here — it is stored encrypted and never shown again.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-start gap-2 text-sm">
            {status?.globalTokenAvailable
              ? <><ShieldCheck className="h-4 w-4 mt-0.5 shrink-0 text-green-500" /><span>Global token configured{status?.globalTokenSource === 'env' ? ' (via the server .env — saving one here overrides it)' : ''}. All DNS-01 domains use it unless a per-domain token is entered on the Add Domain form.</span></>
              : <><AlertTriangle className="h-4 w-4 mt-0.5 shrink-0 text-amber-500" /><span>No global token yet — DNS-01 domains will each need their own token until one is saved.</span></>}
          </div>
          <form onSubmit={saveCfToken} className="flex flex-col sm:flex-row gap-2">
            <div className="relative flex-1">
              <Label htmlFor="cf-global-token" className="sr-only">Cloudflare API token</Label>
              <Input
                id="cf-global-token"
                type={showCfToken ? 'text' : 'password'}
                autoComplete="off"
                value={cfTokenInput}
                onChange={(e) => setCfTokenInput(e.target.value)}
                placeholder={status?.globalTokenAvailable ? 'Paste a new token to replace the saved one' : 'Paste your Cloudflare API token'}
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
            <div className="flex gap-2">
              <Button type="submit" disabled={savingCfToken || !cfTokenInput.trim()} className="min-h-[44px] flex-1 sm:flex-none">
                {savingCfToken ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                <span className="ml-2">Save token</span>
              </Button>
              {status?.globalTokenSource === 'ui' && (
                <Button type="button" variant="outline" onClick={clearCfToken} className="min-h-[44px]">
                  <Trash2 className="h-4 w-4 sm:mr-1" /><span className="hidden sm:inline">Remove</span>
                </Button>
              )}
            </div>
          </form>
          <div className="flex flex-col sm:flex-row sm:items-center gap-2 rounded-lg border p-3">
            <div className="flex items-start gap-2 text-sm min-w-0 flex-1">
              {status?.cloudflarePlugin === true && <><ShieldCheck className="h-4 w-4 mt-0.5 shrink-0 text-green-500" /><span>Caddy&apos;s Cloudflare DNS plugin is installed — DNS-01 issuance is ready.</span></>}
              {status?.cloudflarePlugin === false && <><AlertTriangle className="h-4 w-4 mt-0.5 shrink-0 text-amber-500" /><span>Caddy is missing the Cloudflare DNS plugin. Install it to enable DNS-01 — Caddy restarts briefly (a couple of seconds).</span></>}
              {status?.cloudflarePlugin == null && <><AlertTriangle className="h-4 w-4 mt-0.5 shrink-0 text-muted-foreground" /><span>Could not check the Caddy Cloudflare plugin from here.</span></>}
            </div>
            {status?.cloudflarePlugin !== true && (
              <Button onClick={installPlugin} disabled={installingPlugin} className="min-h-[44px]">
                {installingPlugin ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                <span className="ml-2">{installingPlugin ? 'Installing…' : 'Install plugin'}</span>
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Access API keys */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <KeyRound className="h-4 w-4" /> Access API keys
          </CardTitle>
          <CardDescription>
            Application-level keys for provisioning domains over the API (send as X-API-Key) — the Add Domain page itself
            uses your admin session. Stored hashed; each key is shown exactly once at creation.
            These are ProxyPilot credentials, not Cloudflare tokens.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <form onSubmit={createKey} className="flex flex-col sm:flex-row gap-2">
            <div className="flex-1">
              <Label htmlFor="keyname" className="sr-only">Key name</Label>
              <Input id="keyname" value={newKeyName} onChange={(e) => setNewKeyName(e.target.value)}
                placeholder="Key name — who or what will use it" className="min-h-[44px]" />
            </div>
            <Button type="submit" disabled={creatingKey || !newKeyName.trim()} className="min-h-[44px]">
              {creatingKey ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
              <span className="ml-2">Create key</span>
            </Button>
          </form>

          {keys.length === 0 ? (
            <p className="text-sm text-muted-foreground">No keys yet — create one to hand out access.</p>
          ) : (
            <div className="divide-y rounded-lg border">
              {keys.map((k) => (
                <div key={k.id} className="flex flex-col sm:flex-row sm:items-center gap-2 p-3">
                  <div className="min-w-0 flex-1">
                    <p className={`font-medium truncate ${k.revoked_at ? 'line-through text-muted-foreground' : ''}`}>{k.name}</p>
                    <p className="text-xs text-muted-foreground">
                      Created {k.created_at?.slice(0, 10)}
                      {k.last_used_at ? ` · last used ${k.last_used_at.slice(0, 10)}` : ' · never used'}
                      {k.revoked_at ? ` · revoked ${k.revoked_at.slice(0, 10)}` : ''}
                    </p>
                  </div>
                  {!k.revoked_at && (
                    <Button variant="outline" size="sm" className="min-h-[44px] sm:min-h-9" onClick={() => revokeKey(k)}>
                      <Trash2 className="h-4 w-4 sm:mr-1" /><span className="hidden sm:inline">Revoke</span>
                    </Button>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* DNS-01 domain list */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <ListChecks className="h-4 w-4" /> DNS-01 domains
          </CardTitle>
          <CardDescription>
            Domains that must use Cloudflare DNS validation — typically geo-blocked or wildcard-serving zones.
            One per line: exact domains (<span className="font-mono">internal.example.com</span>) or suffix patterns
            (<span className="font-mono">*.example.com</span> matches subdomains). Everything else defaults to standard Let&apos;s Encrypt.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <textarea
            value={dnsList}
            onChange={(e) => setDnsList(e.target.value)}
            rows={Math.max(3, dnsList.split('\n').length)}
            spellCheck={false}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono"
            placeholder={'internal.example.com\n*.example.com'}
          />
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs text-muted-foreground">{dnsSaved.length} saved entr{dnsSaved.length === 1 ? 'y' : 'ies'}</p>
            <Button onClick={saveDnsList} disabled={savingList} className="min-h-[44px]">
              {savingList ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
              <span className="ml-2">Save list</span>
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Provisioned domains */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Globe className="h-4 w-4" /> Provisioned domains
          </CardTitle>
          <CardDescription>Domains added through the self-service page. Certificates renew automatically via Caddy.</CardDescription>
        </CardHeader>
        <CardContent>
          {domains.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing provisioned yet.</p>
          ) : (
            <div className="divide-y rounded-lg border">
              {domains.map((d) => (
                <div key={d.id} className="flex flex-col sm:flex-row sm:items-center gap-2 p-3">
                  <div className="min-w-0 flex-1">
                    <p className="font-medium truncate">
                      {d.domain}{d.wildcard ? <span className="text-muted-foreground"> + *.{d.domain}</span> : null}
                    </p>
                    <p className="text-xs text-muted-foreground truncate">
                      → {d.upstream} · {METHOD_SHORT[d.method_resolved] || d.method_resolved}
                      {d.cf_token ? ` · CF token: ${d.cf_token_source}` : ''}
                    </p>
                    {d.status === 'failed' && d.last_error && (
                      <p className="text-xs text-red-500 mt-1 break-words">{d.last_error}</p>
                    )}
                  </div>
                  <div className="flex items-center gap-3">
                    <span className={`text-xs font-medium capitalize ${STATUS_TONE[d.status] || ''}`}>{d.status}</span>
                    <Button variant="outline" size="sm" className="min-h-[44px] sm:min-h-9" onClick={() => deleteDomain(d)}>
                      <Trash2 className="h-4 w-4 sm:mr-1" /><span className="hidden sm:inline">Remove</span>
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* One-time key reveal */}
      <Dialog open={!!freshKey} onOpenChange={(open) => { if (!open) setFreshKey(null); }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>API key created</DialogTitle>
            <DialogDescription>
              This is the only time the key is shown — ProxyPilot stores just a hash. Copy it now and hand it to whoever
              will use the Add Domain page.
            </DialogDescription>
          </DialogHeader>
          {freshKey && (
            <div className="space-y-3">
              <p className="text-sm"><span className="text-muted-foreground">Name:</span> {freshKey.name}</p>
              <div className="flex items-center gap-2">
                <code className="flex-1 rounded-md border bg-muted px-3 py-2 text-xs break-all">{freshKey.key}</code>
                <Button variant="outline" size="sm" onClick={copyFreshKey} className="min-h-[44px] shrink-0">
                  {copied ? <Check className="h-4 w-4 text-green-500" /> : <Copy className="h-4 w-4" />}
                </Button>
              </div>
              <Button className="w-full min-h-[44px]" onClick={() => setFreshKey(null)}>Done — I saved it</Button>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
