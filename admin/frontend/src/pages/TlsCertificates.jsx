import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Switch } from '@/components/ui/switch';
import { useToast } from '@/hooks/use-toast';
import {
  Lock, Loader2, Plus, Trash2, RefreshCw, ShieldCheck, AlertTriangle, Pencil,
} from 'lucide-react';

// Manual (pasted) TLS certificates — admin management of certs Caddy serves
// INSTEAD of issuing via ACME, for networks that block Let's Encrypt. The
// private key is WRITE-ONLY: pasted on add/rotate, never returned or shown
// again (the list is metadata + coverage + expiry only). MOBILE_FIRST: single
// column on <sm, ≥44px targets, dialogs completable on a 360px screen.

// A styled multiline paste field (no Textarea primitive in the kit).
function PemField({ id, label, value, onChange, placeholder, rows = 5, required }) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}{required ? ' *' : ' (optional)'}</Label>
      <textarea
        id={id}
        rows={rows}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        spellCheck={false}
        className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-xs font-mono ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
      />
    </div>
  );
}

const STATUS_BADGE = {
  valid: { label: 'Valid', cls: 'bg-green-500/10 text-green-600' },
  expiring: { label: 'Expiring soon', cls: 'bg-amber-500/10 text-amber-600' },
  expired: { label: 'Expired', cls: 'bg-red-500/10 text-red-600' },
  unknown: { label: 'Unknown', cls: 'bg-muted text-muted-foreground' },
};

function StatusBadge({ status, days }) {
  const b = STATUS_BADGE[status] || STATUS_BADGE.unknown;
  const suffix = typeof days === 'number'
    ? status === 'expired' ? ` (${Math.abs(days)}d ago)` : ` (${days}d)`
    : '';
  return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${b.cls}`}>{b.label}{suffix}</span>;
}

function DomainBadges({ names }) {
  return (
    <div className="flex flex-wrap gap-1">
      {(names || []).map((n) => (
        <span key={n} className={`inline-flex items-center rounded px-1.5 py-0.5 text-xs font-mono ${n.startsWith('*.') ? 'bg-blue-500/10 text-blue-600' : 'bg-muted text-foreground/80'}`}>
          {n}{n.startsWith('*.') ? ' ·wildcard' : ''}
        </span>
      ))}
    </div>
  );
}

const EMPTY_FORM = { label: '', certificate: '', private_key: '', chain: '', passphrase: '' };

export default function TlsCertificates() {
  const { toast } = useToast();
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [tlsMode, setTlsMode] = useState('acme');
  const [certs, setCerts] = useState([]);
  const [savingMode, setSavingMode] = useState(false);

  const [addOpen, setAddOpen] = useState(false);
  const [rotateFor, setRotateFor] = useState(null); // cert row being rotated
  const [form, setForm] = useState(EMPTY_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState(null);
  const [deleteFor, setDeleteFor] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const r = await api.tlsCerts();
      setTlsMode(r.tls_mode || 'acme');
      setCerts(r.certificates || []);
    } catch (err) {
      setLoadError(err?.message || 'Could not load certificates.');
    } finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const setField = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const toggleMode = async (checked) => {
    const mode = checked ? 'manual' : 'acme';
    setSavingMode(true);
    try {
      await api.tlsModeSet(mode);
      setTlsMode(mode);
      toast({ title: `TLS mode: ${mode === 'manual' ? 'Manual (pasted certs)' : 'Automatic (ACME)'}`, description: 'Applied to Caddy.' });
    } catch (err) {
      toast({ variant: 'destructive', title: 'Could not change TLS mode', description: err.message });
    } finally { setSavingMode(false); }
  };

  const openAdd = () => { setForm(EMPTY_FORM); setFormError(null); setRotateFor(null); setAddOpen(true); };
  const openRotate = (cert) => { setForm({ ...EMPTY_FORM, label: cert.label }); setFormError(null); setRotateFor(cert); setAddOpen(true); };

  const submit = async () => {
    setSubmitting(true);
    setFormError(null);
    try {
      if (rotateFor) {
        const body = { label: form.label };
        if (form.certificate || form.private_key) {
          body.certificate = form.certificate; body.private_key = form.private_key;
          if (form.chain) body.chain = form.chain;
          if (form.passphrase) body.passphrase = form.passphrase;
        }
        await api.tlsCertUpdate(rotateFor.id, body);
        toast({ title: 'Certificate updated', description: 'Caddy reloaded.' });
      } else {
        const body = { label: form.label, certificate: form.certificate, private_key: form.private_key };
        if (form.chain) body.chain = form.chain;
        if (form.passphrase) body.passphrase = form.passphrase;
        const r = await api.tlsCertAdd(body);
        toast({ title: 'Certificate added', description: `Serving ${(r.covered_names || []).length} domain(s) over HTTPS with no ACME.` });
      }
      setAddOpen(false);
      await load();
    } catch (err) {
      setFormError(err?.message || 'Could not save the certificate.');
    } finally { setSubmitting(false); }
  };

  const confirmDelete = async () => {
    if (!deleteFor) return;
    try {
      const r = await api.tlsCertDelete(deleteFor.id);
      toast({ title: 'Certificate deleted', description: r.reload_warning || 'Covered domains fall back to the global TLS mode.' });
      setDeleteFor(null);
      await load();
    } catch (err) {
      toast({ variant: 'destructive', title: 'Could not delete', description: err.message });
    }
  };

  const canSubmit = rotateFor
    ? form.label && (!(form.certificate || form.private_key) || (form.certificate && form.private_key))
    : form.label && form.certificate && form.private_key;

  return (
    <div className="space-y-6 max-w-4xl">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2"><Lock className="h-6 w-6" /> TLS Certificates</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Serve domains with a pasted certificate instead of Let&apos;s Encrypt — for networks that block ACME.
          </p>
        </div>
        <Button onClick={openAdd} className="min-h-[44px]"><Plus className="h-4 w-4 mr-1.5" /> Add certificate</Button>
      </div>

      {/* Global TLS mode */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Global TLS mode</CardTitle>
          <CardDescription>
            <strong>Automatic (ACME)</strong> issues Let&apos;s Encrypt certs — the default. <strong>Manual</strong> is for
            networks that block ACME endpoints: domains covered by a pasted cert always serve it (ACME is never attempted);
            uncovered domains use a self-signed cert instead of a failing ACME request.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-3">
            <Switch checked={tlsMode === 'manual'} onCheckedChange={toggleMode} disabled={savingMode} aria-label="Manual TLS mode" />
            <span className="text-sm font-medium">{tlsMode === 'manual' ? 'Manual (pasted certificates)' : 'Automatic (ACME / Let’s Encrypt)'}</span>
            {savingMode ? <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /> : null}
          </div>
        </CardContent>
      </Card>

      {/* Certificate list */}
      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground py-8 justify-center"><Loader2 className="h-4 w-4 animate-spin" /> Loading certificates…</div>
      ) : loadError ? (
        <div className="flex items-start gap-2 p-4 rounded-lg text-sm bg-red-500/10 text-red-600">
          <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" /><span>{loadError}</span>
        </div>
      ) : certs.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center space-y-3">
            <ShieldCheck className="h-8 w-8 mx-auto text-muted-foreground" />
            <p className="text-sm text-muted-foreground">No pasted certificates yet. Add one to serve its domains without ACME.</p>
            <Button variant="outline" onClick={openAdd} className="min-h-[44px]"><Plus className="h-4 w-4 mr-1.5" /> Add certificate</Button>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {certs.map((c) => (
            <Card key={c.id}>
              <CardContent className="pt-5 space-y-3">
                <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-2">
                  <div className="min-w-0 space-y-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium truncate">{c.label}</span>
                      <StatusBadge status={c.status} days={c.days_until_expiry} />
                    </div>
                    <p className="text-xs text-muted-foreground break-all">SHA-256 {c.fingerprint}</p>
                  </div>
                  <div className="flex gap-2 shrink-0">
                    <Button variant="outline" size="sm" className="min-h-[44px]" onClick={() => openRotate(c)}><RefreshCw className="h-4 w-4 mr-1" /> Rotate</Button>
                    <Button variant="outline" size="sm" className="min-h-[44px]" onClick={() => setDeleteFor(c)}><Trash2 className="h-4 w-4 text-red-500" /></Button>
                  </div>
                </div>
                <div className="space-y-1.5">
                  <p className="text-xs font-medium text-muted-foreground">Covered domains</p>
                  <DomainBadges names={c.covered_names} />
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs text-muted-foreground">
                  <div>Not after: <span className="text-foreground">{c.not_after ? new Date(c.not_after).toLocaleString() : '—'}</span></div>
                  <div>In use by: <span className="text-foreground">{(c.bound_hosts || []).length} route(s)</span></div>
                </div>
                {(c.bound_hosts || []).length ? (
                  <p className="text-xs text-muted-foreground break-all">{c.bound_hosts.join(', ')}</p>
                ) : null}
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Add / Rotate dialog */}
      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{rotateFor ? `Rotate: ${rotateFor.label}` : 'Add certificate'}</DialogTitle>
            <DialogDescription>
              {rotateFor
                ? 'Paste a new certificate + key to replace it, or change only the label. The private key is never shown after saving.'
                : 'Paste a PEM certificate and its private key. The key is encrypted at rest and never displayed again.'}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="cert-label">Label *</Label>
              <Input id="cert-label" value={form.label} onChange={(e) => setField('label', e.target.value)} placeholder="e.g. Cloudflare Origin — example.com" />
            </div>
            <PemField id="cert-pem" label="Certificate (PEM)" value={form.certificate} onChange={(v) => setField('certificate', v)} placeholder="-----BEGIN CERTIFICATE-----" required={!rotateFor} />
            <PemField id="cert-key" label="Private key (PEM)" value={form.private_key} onChange={(v) => setField('private_key', v)} placeholder="-----BEGIN PRIVATE KEY-----" required={!rotateFor} />
            <PemField id="cert-chain" label="Intermediate chain (PEM)" value={form.chain} onChange={(v) => setField('chain', v)} placeholder="-----BEGIN CERTIFICATE----- (optional)" rows={3} />
            <div className="space-y-1.5">
              <Label htmlFor="cert-pass">Key passphrase (optional)</Label>
              <Input id="cert-pass" type="password" autoComplete="new-password" value={form.passphrase} onChange={(e) => setField('passphrase', e.target.value)} placeholder="Only if the key is encrypted" />
            </div>
            {formError ? (
              <div className="flex items-start gap-2 p-3 rounded-lg text-sm bg-red-500/10 text-red-600">
                <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" /><span className="min-w-0 break-words">{formError}</span>
              </div>
            ) : null}
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setAddOpen(false)} className="min-h-[44px]">Cancel</Button>
            <Button onClick={submit} disabled={!canSubmit || submitting} className="min-h-[44px]">
              {submitting ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : rotateFor ? <RefreshCw className="h-4 w-4 mr-1.5" /> : <Plus className="h-4 w-4 mr-1.5" />}
              {rotateFor ? 'Save changes' : 'Add & apply'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirm */}
      <Dialog open={!!deleteFor} onOpenChange={(o) => !o && setDeleteFor(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><AlertTriangle className="h-5 w-5 text-red-500" /> Delete certificate</DialogTitle>
            <DialogDescription>
              Delete <strong>{deleteFor?.label}</strong>? Its {(deleteFor?.bound_hosts || []).length} covered route(s) will
              fall back to the global TLS mode ({tlsMode === 'manual' ? 'self-signed' : 'ACME'}). This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setDeleteFor(null)} className="min-h-[44px]">Cancel</Button>
            <Button variant="destructive" onClick={confirmDelete} className="min-h-[44px]"><Trash2 className="h-4 w-4 mr-1.5" /> Delete</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
