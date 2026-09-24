import { useEffect, useState } from 'react';
import { Lock, Globe } from 'lucide-react';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';

// Who can reach each platform service (backend: lib/setup-engine/platform-access.js).
// Recovery, OpenBao and Infisical are always VPN-only; three switches apply at once.
export default function PlatformAccess() {
  const [data, setData] = useState(null), [draft, setDraft] = useState(null), [busy, setBusy] = useState(false), [error, setError] = useState(''), [message, setMessage] = useState('');
  const load = async () => { const v = await api.getPlatformAccess(); setData(v); setDraft(v.choices); return v; };
  useEffect(() => { load().catch((e) => setError(e.message)); }, []);
  if (!data || !draft) return error ? <p role="alert" className="text-destructive text-sm break-words">{error}</p> : <p role="status" className="text-sm">Loading access settings…</p>;
  const changed = data.switches.some((s) => s.available && (draft[s.id] !== data.applied[s.id]));
  const apply = async () => {
    setBusy(true); setError(''); setMessage('');
    try { const v = await api.applyPlatformAccess({ ...draft, reviewed: true }); setData(v); setDraft(v.choices); setMessage('Applied. Caddy was validated and reloaded.'); }
    catch (e) { setError(e.message); } finally { setBusy(false); }
  };
  const Badge = ({ open }) => <span className={`inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs font-medium ${open ? 'bg-amber-500/15 text-amber-600 dark:text-amber-400' : 'bg-primary/10 text-primary'}`}>{open ? <Globe className="h-3 w-3" aria-hidden="true" /> : <Lock className="h-3 w-3" aria-hidden="true" />}{open ? 'Open' : 'VPN only'}</span>;
  return <div className="space-y-4 min-w-0 text-sm">
    <p>VPN only means the VPN plus your additional restricted networks{data.networks.length ? <> (<span className="break-all">{data.networks.join(', ')}</span>)</> : ''}. This browser is connecting from <code className="break-all">{data.client || 'unknown'}</code>.</p>
    <ul className="space-y-2">{data.fixed.map((f) => <li key={f.id} className="rounded-lg border p-3 space-y-1 min-w-0"><div className="flex flex-wrap items-center gap-2"><span className="font-medium">{f.name}</span><Badge open={false} /><span className="text-xs text-muted-foreground">always</span></div><p className="text-muted-foreground">{f.reason}</p></li>)}</ul>
    <ul className="space-y-2">{data.switches.map((s) => {
      const open = draft[s.id] === 'open';
      return <li key={s.id} className="rounded-lg border p-3 space-y-2 min-w-0">
        <div className="flex flex-wrap items-center gap-2"><span className="font-medium">{s.name}</span>{s.host && <span className="text-xs text-muted-foreground break-all">{s.host}</span>}{s.available && <Badge open={data.applied[s.id] === 'open'} />}{s.available && data.applied[s.id] !== draft[s.id] && <span className="text-xs text-amber-600 dark:text-amber-400">changes on Apply</span>}</div>
        {!s.available ? <p className="text-muted-foreground">{s.reason || 'Not installed yet.'}</p> : <>
          <fieldset className="flex flex-col sm:flex-row gap-2"><legend className="sr-only">{s.name} access</legend>
            {['restricted', 'open'].map((v) => <label key={v} className={`flex items-center gap-2 min-h-11 rounded-md border px-3 cursor-pointer ${draft[s.id] === v ? 'border-primary bg-primary/10' : ''}`}><input type="radio" name={`access-${s.id}`} className="h-4 w-4" checked={draft[s.id] === v} onChange={() => setDraft((d) => ({ ...d, [s.id]: v }))} />{v === 'open' ? 'Open to the internet' : 'VPN only'}</label>)}
          </fieldset>
          <p className="text-muted-foreground">{open ? s.open : s.restricted}</p>
        </>}
      </li>;
    })}</ul>
    {error && <p role="alert" className="text-destructive break-words">{error}</p>}
    {message && <p role="status" className="rounded-lg border p-3 break-words">{message}</p>}
    <Button className="min-h-11 w-full sm:w-auto" disabled={busy || !changed} onClick={apply}>{busy ? 'Applying…' : 'Apply access changes'}</Button>
    <p className="text-xs text-muted-foreground">Apply needs a fresh local sign-in. Caddy is validated before reload; if anything fails, every change is restored.</p>
  </div>;
}

// One service's access, inside its Manage panel (PlatformOverview → Manage).
// The switch applies on its own: the other switches keep what is applied now.
const SERVICE_SWITCH = { vaultwarden: 'vaultwarden', keycloak: 'keycloakAdmin' };
export function ServiceAccess({ service }) {
  const [data, setData] = useState(null), [busy, setBusy] = useState(false), [error, setError] = useState(''), [message, setMessage] = useState('');
  useEffect(() => { let on = true; api.getPlatformAccess().then((v) => on && setData(v)).catch((e) => on && setError(e.message)); return () => { on = false; }; }, [service]);
  const key = SERVICE_SWITCH[service], fixed = data?.fixed.find((f) => f.id === service), sw = key && data?.switches.find((s) => s.id === key);
  const set = async (value) => {
    setBusy(true); setError(''); setMessage('');
    // Keep every other switch exactly as applied (a saved-but-unapplied choice is not applied from here).
    const choices = Object.fromEntries(Object.entries(data.applied).map(([k, v]) => [k, v ?? data.choices[k]]));
    try { const v = await api.applyPlatformAccess({ ...choices, [key]: value, reviewed: true }); setData(v); setMessage(value === 'open' ? 'Now open to the internet.' : 'Now VPN only.'); }
    catch (e) { setError(e.message); } finally { setBusy(false); }
  };
  const Pill = ({ open }) => <span className={`inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs font-medium ${open ? 'bg-amber-500/15 text-amber-600 dark:text-amber-400' : 'bg-primary/10 text-primary'}`}>{open ? <Globe className="h-3 w-3" aria-hidden="true" /> : <Lock className="h-3 w-3" aria-hidden="true" />}{open ? 'Open' : 'VPN only'}</span>;
  return <section className="space-y-2 min-w-0" aria-labelledby={`access-${service}`}>
    <h4 id={`access-${service}`} className="font-semibold">Access</h4>
    {!data ? (error ? <p role="alert" className="text-sm text-destructive break-words">{error}</p> : <p role="status" className="text-sm">Loading…</p>)
      : service === 'pomerium' ? <p className="text-sm">Public: it is the sign-in gate in front of the sites you protect, so visitors must reach it. It holds no data of its own.</p>
      : fixed ? <div className="rounded-lg border p-3 space-y-1 text-sm"><div className="flex flex-wrap items-center gap-2"><Pill open={false} /><span className="text-xs text-muted-foreground">always</span></div><p className="text-muted-foreground">{fixed.reason}</p></div>
      : sw ? <div className="rounded-lg border p-3 space-y-2 text-sm min-w-0">
          <div className="flex flex-wrap items-center gap-2"><span className="font-medium">{sw.name}</span>{sw.available && <Pill open={data.applied[key] === 'open'} />}</div>
          {!sw.available ? <p className="text-muted-foreground">{sw.reason || 'Not installed yet.'}</p> : <>
            <p className="text-muted-foreground">{data.applied[key] === 'open' ? sw.open : sw.restricted}</p>
            <div className="flex flex-col sm:flex-row gap-2">
              {['restricted', 'open'].map((v) => <Button key={v} variant={data.applied[key] === v ? 'default' : 'outline'} className="min-h-11 w-full sm:w-auto" disabled={busy || data.applied[key] === v} onClick={() => set(v)}>{busy ? 'Applying…' : v === 'open' ? 'Open to the internet' : 'VPN only'}</Button>)}
            </div>
            <p className="text-xs text-muted-foreground">Applies now (needs a fresh local sign-in). Caddy is validated before reload; a failure restores everything.</p>
          </>}
        </div>
      : <p className="text-sm text-muted-foreground">No access switch for this service.</p>}
    {error && data && <p role="alert" className="text-sm text-destructive break-words">{error}</p>}
    {message && <p role="status" className="rounded-lg border p-2 text-sm">{message}</p>}
  </section>;
}
