import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';

// Put Keycloak sign-in in front of an existing site: Caddy → Pomerium → app.
// Backend: routes/pomerium.js (/routes/review, /routes/apply) and
// lib/setup-engine/pomerium-store.js (routeSnapshot decides what is supported).
export default function PomeriumRouteProtection() {
  const [data, setData] = useState(null), [busy, setBusy] = useState(false), [error, setError] = useState(''), [message, setMessage] = useState('');
  const [routeId, setRoute] = useState(''), [subjects, setSubjects] = useState([]), [review, setReview] = useState(null);
  const state = data?.state;
  async function refresh() { const value = await api.getPomeriumSetup(); setData(value); return value; }
  useEffect(() => { let active = true; const poll = async () => { try { const value = await api.getPomeriumSetup(); if (active) setData(value); } catch { if (active) setError('Gateway status could not be refreshed.'); } }; poll(); const timer = setInterval(poll, 5000); return () => { active = false; clearInterval(timer); }; }, []);
  useEffect(() => setReview(null), [state?.revision, routeId, subjects]);
  async function run(fn) { setBusy(true); setError(''); setMessage(''); try { await fn(); await refresh(); } catch (e) { setError(e.message); } finally { setBusy(false); } }
  if (!data) return <p role="status" className="text-sm">Loading protected sites…</p>;
  if (!state) return <p className="text-sm">Pomerium is not set up yet (stage C).</p>;
  const supported = data.routes.filter(r => r.supported), unsupported = data.routes.filter(r => !r.supported);
  const active = state.intents.filter(i => i.state !== 'removed');
  return <div className="space-y-4 min-w-0">
    <p className="text-sm">Pick a site ProxyPilot already routes and choose who may open it. Visitors are sent to Keycloak to sign in (with your passkey), and everyone not on the list is refused. The app itself is unchanged and needs no login of its own.</p>
    {error && <p role="alert" className="text-destructive text-sm break-words">{error}</p>}
    {message && <p role="status" className="border rounded-lg p-3 text-sm break-words">{message}</p>}
    {active.length > 0 && <ul className="space-y-2">{active.map(i => <li key={i.routeId} className="border rounded-lg p-3 space-y-2 text-sm min-w-0"><p className="font-medium break-all">{i.domain} · {i.state}</p><Button className="min-h-11 w-full sm:w-auto" variant="outline" disabled={busy} onClick={() => run(async () => { setRoute(i.routeId); setSubjects([]); const result = await api.reviewPomeriumRoute({ expectedRevision: state.revision, routeId: i.routeId, subjects: [], action: 'remove' }); setReview(result.review); })}>Review removing sign-in</Button></li>)}</ul>}
    <div className="space-y-2"><Label htmlFor="pp-protect-route">Site</Label><select id="pp-protect-route" className="w-full min-h-11 rounded-md border bg-background px-3" value={routeId} onChange={e => setRoute(e.target.value)}><option value="">{supported.length ? 'Select a site' : 'No site can be protected yet (see below)'}</option>{supported.map(r => <option key={r.id} value={r.id}>{r.domain}</option>)}</select></div>
    <fieldset className="space-y-1 min-w-0"><legend className="text-sm font-medium">Who may open it (everyone else is refused)</legend>
      {!data.identities.length && <p className="text-sm">No linked Keycloak accounts yet. Link your ProxyPilot account to Keycloak first (stage B).</p>}
      {data.identities.map(i => <label key={i.subject} className="flex items-center gap-3 min-h-11 text-sm break-all"><input type="checkbox" className="h-5 w-5 shrink-0" checked={subjects.includes(i.subject)} onChange={e => setSubjects(old => e.target.checked ? [...old, i.subject] : old.filter(x => x !== i.subject))} /><span>{i.username}</span></label>)}
    </fieldset>
    <Button className="min-h-11 w-full sm:w-auto" disabled={busy || !routeId || !subjects.length} onClick={() => run(async () => setReview((await api.reviewPomeriumRoute({ expectedRevision: state.revision, routeId, subjects, action: 'protect' })).review))}>Review sign-in for this site</Button>
    {review && <section aria-label="Reviewed change" className="rounded-lg border-2 border-primary p-4 space-y-3 text-sm min-w-0">
      <h4 className="font-semibold">{review.action === 'remove' ? 'Remove sign-in' : 'Require sign-in'}</h4>
      <p className="break-all">{review.domain} → {review.upstream}</p>
      <p className="break-all">Allowed: {review.subjects.join(', ') || 'the site goes back to its own access rules'}</p>
      {review.warning && <p>{review.warning}</p>}
      <Button className="min-h-11 w-full sm:w-auto" disabled={busy} onClick={() => run(async () => { await api.applyPomeriumRoute({ expectedRevision: state.revision, routeId: review.routeId, subjects: review.subjects, action: review.action, reviewToken: review.reviewToken, reviewed: true }); setReview(null); setMessage('Queued. The site is paused (503) until the gateway verifies the new rule, then asks for sign-in.'); })}>{review.action === 'remove' ? 'Confirm: remove sign-in' : 'Confirm: require sign-in'}</Button>
    </section>}
    {unsupported.length > 0 && <details><summary className="min-h-11 cursor-pointer flex items-center text-sm">Sites that cannot be protected yet ({unsupported.length})</summary><ul className="space-y-2 text-sm pt-2">{unsupported.map(r => <li key={r.id} className="break-words"><strong className="break-all">{r.domain}</strong>: {r.reason}</li>)}</ul></details>}
  </div>;
}
