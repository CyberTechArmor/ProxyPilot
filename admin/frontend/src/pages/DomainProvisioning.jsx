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
  AlertTriangle, ExternalLink, ListChecks,
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
        <div className="flex flex-col gap-1 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1.5">
            {status?.globalTokenAvailable
              ? <><ShieldCheck className="h-3.5 w-3.5 text-green-500" /> Global Cloudflare token configured</>
              : <><AlertTriangle className="h-3.5 w-3.5 text-amber-500" /> No global Cloudflare token (CLOUDFLARE_API_TOKEN) — DNS-01 needs per-domain tokens</>}
          </span>
          <span className="inline-flex items-center gap-1.5">
            {status?.cloudflarePlugin === true && <><ShieldCheck className="h-3.5 w-3.5 text-green-500" /> Caddy Cloudflare DNS plugin installed</>}
            {status?.cloudflarePlugin === false && <><AlertTriangle className="h-3.5 w-3.5 text-amber-500" /> Caddy lacks the Cloudflare plugin — run `caddy add-package github.com/caddy-dns/cloudflare`</>}
            {status?.cloudflarePlugin == null && <><AlertTriangle className="h-3.5 w-3.5 text-muted-foreground" /> Could not check the Caddy Cloudflare plugin</>}
          </span>
        </div>
      </div>

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
