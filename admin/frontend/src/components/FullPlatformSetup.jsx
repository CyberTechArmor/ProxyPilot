import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, Lock, Loader2, XCircle, CircleDot } from 'lucide-react';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardHeader, CardDescription, CardContent } from '@/components/ui/card';
import OpenBaoSetup from '@/components/OpenBaoSetup';
import VaultwardenSetup from '@/components/VaultwardenSetup';
import SsoSetup from '@/components/SsoSetup';
import PlatformOverview from '@/components/PlatformOverview';
import PlatformReset from '@/components/PlatformReset';
import SetupJobs from '@/components/SetupJobs';

// Platform Setup — one path. All five services are installed and managed as
// one system, in stages; each is actionable only when the one before it is
// verified (the server refuses a later stage early, so these locks are a view
// of that rule, not the rule itself):
//   A domains, realm, networks → review · B Keycloak and the permanent
//   administrator · C Pomerium · D Infisical, OpenBao, Vaultwarden · E verify
//   everything → activate SSO → complete.
const names = { keycloak: 'Keycloak', pomerium: 'Pomerium', infisical: 'Infisical', openbao: 'OpenBao', vaultwarden: 'Vaultwarden' };
const label = value => String(value || 'not checked').replaceAll('_', ' ');
const STATUS = {
  done: ['Verified', CheckCircle2, 'text-primary'],
  current: ['Current stage', CircleDot, 'text-foreground'],
  running: ['Running', Loader2, 'text-foreground'],
  failed: ['Needs attention', XCircle, 'text-destructive'],
  locked: ['Locked', Lock, 'text-muted-foreground'],
};

function Address({ id, title, value, domains, onChange, disabled, apexNote = false }) {
  const hostname = value.replace(/^https:\/\//, '');
  const match = domains.find(d => hostname === d.domain || hostname.endsWith(`.${d.domain}`));
  const [selected, setSelected] = useState(match?.domain || 'other');
  const [subdomain, setSubdomain] = useState(match ? hostname.slice(0, -(match.domain.length + 1)) : '');
  useEffect(() => { if (match) { setSelected(match.domain); setSubdomain(hostname === match.domain ? '' : hostname.slice(0, -(match.domain.length + 1))); } }, [domains, value]);
  return <fieldset disabled={disabled} className="space-y-2 min-w-0 rounded-lg border p-4">
    <legend className="px-1 font-medium">{title}</legend>
    <Label htmlFor={`${id}-domain`}>Linked domain for {title}</Label>
    <select id={`${id}-domain`} className="w-full min-h-11 rounded-md border bg-background px-3" value={selected} onChange={e => { const domain = e.target.value; setSelected(domain); if (domain !== 'other') onChange(`https://${subdomain ? `${subdomain}.` : ''}${domain}`); }}>
      {domains.map(d => <option key={d.domain} value={d.domain}>{d.domain}</option>)}
      <option value="other">Enter another hostname</option>
    </select>
    {selected === 'other' ? <><Label htmlFor={`${id}-hostname`}>{title} hostname</Label><Input id={`${id}-hostname`} className="min-h-11" value={hostname} autoComplete="off" spellCheck={false} placeholder="service.example.com" onChange={e => onChange(e.target.value ? `https://${e.target.value.replace(/^https:\/\//, '')}` : '')} /></> : <><Label htmlFor={`${id}-subdomain`}>{title} subdomain (optional)</Label><Input id={`${id}-subdomain`} className="min-h-11" autoComplete="off" spellCheck={false} value={subdomain} onChange={e => { setSubdomain(e.target.value); onChange(`https://${e.target.value ? `${e.target.value}.` : ''}${selected}`); }} /></>}
    <p className="text-sm text-muted-foreground break-all">{value || 'Choose a hostname'}</p>
    {apexNote && match && hostname === match.domain && <p role="note" className="text-sm text-amber-600 dark:text-amber-400 break-words">This is the bare domain {match.domain}. It works only if {match.domain} itself points at this server; it usually points at the main website. Use a subdomain such as recovery.{match.domain}. It cannot be changed after apply.</p>}
  </fieldset>;
}

/** Additional addresses before apply: part of the saved plan. The VPN rows are locked. */
function PlanNetworks({ vpn, additional, onChange, disabled }) {
  const [draft, setDraft] = useState(''), [error, setError] = useState('');
  const add = () => { const v = draft.trim(); if (!v) return; if (/\/0$/.test(v)) { setError('Unrestricted access (/0) is refused.'); return; } setError(''); if (!additional.includes(v)) onChange([...additional, v]); setDraft(''); };
  return <fieldset disabled={disabled} className="space-y-3 rounded-lg border p-4 min-w-0">
    <legend className="px-1 font-medium">Restricted networks</legend>
    <p className="text-sm text-muted-foreground">Local recovery and every restricted service route accept only the VPN networks plus these additional addresses. You can change the additional addresses at any time later, also after SSO is active.</p>
    <ul className="space-y-2">
      {vpn.map(n => <li key={`vpn-${n}`} className="flex items-center justify-between gap-3 rounded-md border bg-muted/40 px-3 min-h-11 min-w-0"><span className="font-mono text-sm break-all">{n}</span><span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground"><Lock className="h-3.5 w-3.5" aria-hidden="true" />VPN · automatic</span></li>)}
      {vpn.length === 0 && <li className="rounded-md border px-3 py-2 text-sm text-muted-foreground">The VPN is not enabled on this host. Add at least one administrator address.</li>}
      {additional.map(n => <li key={n} className="flex items-center justify-between gap-3 rounded-md border px-3 min-h-11 min-w-0"><span className="font-mono text-sm break-all">{n}</span><Button type="button" variant="ghost" className="min-h-11 min-w-11 shrink-0" aria-label={`Remove ${n}`} onClick={() => onChange(additional.filter(x => x !== n))}>Remove</Button></li>)}
    </ul>
    <div className="flex flex-col sm:flex-row gap-2">
      <div className="flex-1 min-w-0"><Label htmlFor="full-additional-network" className="sr-only">Additional address or CIDR</Label><Input id="full-additional-network" className="min-h-11" value={draft} placeholder="203.0.113.7 or 203.0.113.0/28" autoComplete="off" spellCheck={false} onChange={e => setDraft(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); add(); } }} /></div>
      <Button type="button" variant="outline" className="min-h-11" disabled={!draft.trim()} onClick={add}>Add address</Button>
    </div>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
  </fieldset>;
}

function StageHeader({ stage }) {
  const [text, Icon, tone] = STATUS[stage.status] || STATUS.locked;
  return <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
    <h2 className="text-lg font-semibold">{stage.id}. {stage.name}</h2>
    <span className={`inline-flex items-center gap-1.5 text-sm ${tone}`}><Icon className={`h-4 w-4 shrink-0 ${stage.status === 'running' ? 'animate-spin' : ''}`} aria-hidden="true" />{text}</span>
  </div>;
}

function ServiceRows({ ids, services, locked, onLifecycle }) {
  return <ol className="space-y-3">{services.filter(s => ids.includes(s.id)).map(s => <li key={s.id} className="rounded-lg border p-4 space-y-2 min-w-0">
    <div className="flex flex-col sm:flex-row sm:justify-between gap-1"><h3 className="font-semibold">{s.name}</h3><span className="text-sm capitalize">{label(s.state)}</span></div>
    <p className="text-sm break-all">{s.url}</p>
    {s.action && <p className="text-sm break-words">{s.action}</p>}
    {s.job?.phase && <p className="text-xs text-muted-foreground">Current action: {label(s.job.phase)}</p>}
    {s.ownership === 'managed' && onLifecycle && <details className="text-sm"><summary className="min-h-11 cursor-pointer flex items-center">Repair, reinstall or remove runtime</summary><div className="flex flex-col sm:flex-row gap-2">{['repair', 'reinstall', 'remove'].map(action => <Button key={action} variant="outline" className="min-h-11 capitalize" disabled={locked} onClick={() => onLifecycle(s.id, action)}>{action}</Button>)}</div></details>}
  </li>)}</ol>;
}

export default function FullPlatformSetup() {
  const [data, setData] = useState(null), [config, setConfig] = useState(null), [domains, setDomains] = useState([]);
  const [busy, setBusy] = useState(''), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [review, setReview] = useState(null), [dirty, setDirty] = useState(false), [revealed, setRevealed] = useState(null), [connections, setConnections] = useState([]);
  const [administrator, setAdministrator] = useState({ useCurrent: true, username: '', email: '', firstName: '', lastName: '', password: '', otp: '' });
  // Retirement takes its own fresh login: the step-2 password is cleared after use.
  const [retire, setRetire] = useState({ password: '', otp: '' });
  const [lifecycle, setLifecycle] = useState(null), [lifecycleConfirmed, setLifecycleConfirmed] = useState(false);
  const request = useRef(0), alive = useRef(true);
  async function load(reset = false) {
    const id = ++request.current;
    const next = await api.getFullPlatform();
    if (!alive.current || id !== request.current) return;
    setData(next);
    if (reset) { setConfig({ ...next.config, additionalNetworks: next.networks?.additional || [] }); setDirty(false); setReview(next.review); setAdministrator(p => ({ ...p, firstName: next.state.administrator?.firstName || '', lastName: next.state.administrator?.lastName || '', username: next.state.administrator?.username || next.administrator?.username || '', email: next.state.administrator?.email || next.administrator?.email || '' })); }
  }
  useEffect(() => {
    alive.current = true;
    load(true).catch(e => setError(e.message));
    api.mock2ListParentDomains().then(r => setDomains((r.domains || []).sort((a, b) => b.domain.length - a.domain.length))).catch(() => {});
    api.getPlatformSetup().then(r => setConnections(r.keycloak || [])).catch(() => {});
    const timer = setInterval(() => load().catch(e => setError(e.message)), 5000);
    return () => { alive.current = false; request.current++; clearInterval(timer); };
  }, []);
  useEffect(() => {
    if (!revealed) return;
    const hide = () => setRevealed(null), timer = setTimeout(hide, 30000);
    document.addEventListener('visibilitychange', hide);
    return () => { clearTimeout(timer); document.removeEventListener('visibilitychange', hide); };
  }, [revealed]);
  function change(next) { setConfig(next); setDirty(true); setReview(null); setNotice(''); }
  // Suggest recovery.<domain of the ProxyPilot hostname> while the plan is unapproved and recovery is empty.
  useEffect(() => {
    if (!config || config.recoveryOrigin || data?.approvedRevision || !domains.length || !config.publicOrigin) return;
    const host = config.publicOrigin.replace(/^https:\/\//, ''), d = domains.find(x => host === x.domain || host.endsWith(`.${x.domain}`));
    if (d) change({ ...config, recoveryOrigin: `https://recovery.${d.domain}` });
  }, [config?.publicOrigin, config?.recoveryOrigin, domains, data?.approvedRevision]);
  async function run(name, fn) {
    setBusy(name); setError(''); setNotice('');
    try { await fn(); } catch (e) { setError(e.message); } finally { setBusy(''); }
  }
  const running = ['queued', 'running'].includes(data?.job?.status);
  const locked = !!busy || running;
  const current = data?.stage;
  const stages = data?.stages || [];
  const vpn = data?.networks?.vpn || [];
  const continueSetup = () => run('continue', async () => { await api.applyFullPlatform({ revision: data.revision, reviewToken: data.review.reviewToken, reviewed: true }); setNotice(`Stage ${current} queued. Progress comes from saved server jobs; you can close or reload this page.`); await load(); });
  const reviewLifecycle = (service, action) => run('lifecycle-review', async () => { setLifecycle(await api.fullPlatformLifecycleReview({ service, action })); setLifecycleConfirmed(false); });
  const serviceStage = ids => data.services.some(s => ids.includes(s.id) && ['planned', 'installed', 'failed'].includes(s.state) || ids.includes(s.id) && !s.job);

  function stageBody(stage) {
    const isCurrent = stage.id === current;
    if (stage.status === 'locked') return <p className="text-sm text-muted-foreground break-words">{stage.locked_reason}</p>;
    const failing = stage.failing?.length ? <div role="alert" className="rounded-lg border border-destructive p-3 text-sm space-y-1">{stage.failing.map(f => <p key={`${f.service}-${f.job_id}`} className="break-words"><strong>{names[f.service] || label(f.service)}</strong>{f.phase ? ` (at ${label(f.phase)})` : ''}: {f.reason}</p>)}</div> : null;
    if (stage.id === 'A') {
      if (!isCurrent) return <div className="text-sm space-y-1 break-all"><p>ProxyPilot {config.publicOrigin} · recovery {config.recoveryOrigin} · realm {config.realm}</p><p>{Object.entries(config.services).map(([id, s]) => `${names[id]} ${s.url}`).join(' · ')}</p></div>;
      return <div className="space-y-5">
        <p className="text-sm text-muted-foreground">Keycloak, Pomerium, Infisical, OpenBao and Vaultwarden are installed and managed as one system. Existing installations are prefilled; connection values and private service settings are managed automatically.</p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Address id="full-public" title="ProxyPilot" value={config.publicOrigin} domains={domains} disabled={locked} onChange={v => change({ ...config, publicOrigin: v })} />
          <Address id="full-recovery" title="Local recovery" apexNote value={config.recoveryOrigin} domains={domains} disabled={locked} onChange={v => change({ ...config, recoveryOrigin: v })} />
          {Object.entries(config.services).map(([id, s]) => <Address key={id} id={`full-${id}`} title={names[id]} value={s.url} domains={domains} disabled={locked} onChange={v => change({ ...config, services: { ...config.services, [id]: { ...s, url: v } } })} />)}
        </div>
        <div className="space-y-2"><Label htmlFor="full-realm">Realm name</Label><Input id="full-realm" className="min-h-11" value={config.realm} disabled={locked} onChange={e => change({ ...config, realm: e.target.value })} /></div>
        <PlanNetworks vpn={vpn} additional={config.additionalNetworks || []} disabled={locked} onChange={list => change({ ...config, additionalNetworks: list })} />
        <Button className="min-h-11 w-full sm:w-auto" disabled={locked} onClick={() => run('review', async () => { const { recoveryNetworks, ...plan } = config; setReview(await api.reviewFullPlatform(plan)); })}>Review setup</Button>
        {review && <section aria-label="Review" className="rounded-lg border p-4 space-y-3">
          <h3 className="font-semibold">Review</h3>
          {review.changes?.length > 0 && <ul className="space-y-2 text-sm" aria-label="Proposed changes">{review.changes.map(c => <li key={c.field} className="break-words">{c.field}: {c.before || '—'} → {c.after}</li>)}</ul>}
          {review.dependencies?.map(d => <p key={d.service} className="rounded border p-3 text-sm">{d.reason}</p>)}
          {review.networks && <p className="text-sm break-all">Restricted networks: {review.networks.effective.join(', ') || 'none — add an administrator address'}</p>}
          <details className="rounded border p-3"><summary className="min-h-11 cursor-pointer flex items-center">DNS and managed settings</summary><p className="text-sm mt-2">{review.managed}</p><ul className="space-y-3 mt-3 text-sm">{review.dns?.map(d => <li key={d.service} className="break-words"><strong className="break-all">{d.url}</strong><p>{d.action}</p></li>)}</ul></details>
          <div className="flex flex-col sm:flex-row gap-3">
            <Button className="min-h-11" disabled={locked} onClick={() => run('save', async () => { const { recoveryNetworks, ...plan } = config; const next = await api.saveFullPlatform({ expectedRevision: data.revision, config: plan, reviewed: true }); setData(next); setConfig({ ...next.config, additionalNetworks: next.networks?.additional || [] }); setReview(next.review); setDirty(false); setNotice('Plan saved. No services or identity settings changed.'); })}>Save reviewed plan</Button>
            <Button className="min-h-11" variant="outline" disabled={locked || dirty || !data.revision} onClick={() => run('apply', async () => { await api.applyFullPlatform({ revision: data.revision, reviewToken: data.review.reviewToken, reviewed: true }); setNotice('Applied. Stage B (Keycloak) is running; nothing else is installed until it is verified.'); await load(); })}>Apply and start stage B</Button>
          </div>
        </section>}
      </div>;
    }
    if (stage.id === 'B') {
      const keycloak = data.services.find(s => s.id === 'keycloak');
      const st = data.state || {};
      return <div className="space-y-4">
        {failing}
        <ServiceRows ids={['keycloak']} services={data.services} locked={locked} onLifecycle={isCurrent ? reviewLifecycle : null} />
        {isCurrent && (keycloak?.state !== 'verified' || !st.identity?.bootstrapRef) && <Button className="min-h-11 w-full sm:w-auto" disabled={locked || dirty} onClick={continueSetup}>{running ? 'Stage B is running…' : 'Continue stage B'}</Button>}
        {isCurrent && st.identity?.bootstrapRef && <>
          <section className="rounded-lg border p-4 space-y-3"><h3 className="font-semibold">1. Initial Keycloak password</h3>
            <p className="text-sm">Needed once, to sign in as the temporary bootstrap administrator. Hidden after 30 seconds or when you leave the page.</p>
            <Button className="min-h-11" variant="outline" disabled={!!busy} onClick={() => run('reveal', async () => { const v = await api.revealKeycloakBootstrap(); if (v.retired) setNotice(v.label); else setRevealed(v); })}>Reveal initial Keycloak password</Button>
            {revealed && <div aria-label="Initial Keycloak password" className="space-y-2"><p className="text-sm">{revealed.username}</p><Label htmlFor="full-bootstrap">Initial password</Label><Input id="full-bootstrap" className="min-h-11" readOnly autoComplete="off" value={revealed.password} /><Button className="min-h-11" variant="outline" onClick={() => setRevealed(null)}>Hide password</Button></div>}
          </section>
          <fieldset disabled={locked} className="space-y-3 rounded-lg border p-4 min-w-0"><legend className="px-1 font-semibold">2. Permanent Keycloak administrator</legend>
            <p className="text-sm">Your existing ProxyPilot account ID, local credentials and roles are preserved. Linking requires proof of both accounts. Current administrator: <strong>{data.administrator?.username || 'Current administrator'}</strong></p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">{[['firstName', 'First name'], ['lastName', 'Last name']].map(([key, title]) => <div className="space-y-2" key={key}><Label htmlFor={`full-admin-${key}`}>{title}</Label><Input id={`full-admin-${key}`} className="min-h-11" value={administrator[key]} autoComplete={key === 'firstName' ? 'given-name' : 'family-name'} onChange={e => setAdministrator(p => ({ ...p, [key]: e.target.value }))} /></div>)}</div>
            <label className="flex items-center gap-2 min-h-11"><input type="checkbox" checked={administrator.useCurrent} onChange={e => setAdministrator(p => ({ ...p, useCurrent: e.target.checked }))} />Use my current ProxyPilot administrator</label>
            {!administrator.useCurrent && <div className="space-y-2"><Label htmlFor="full-admin-name">Permanent administrator username</Label><Input id="full-admin-name" className="min-h-11" value={administrator.username} onChange={e => setAdministrator(p => ({ ...p, username: e.target.value }))} /></div>}
            <div className="space-y-2"><Label htmlFor="full-admin-email">Administrator email</Label><Input id="full-admin-email" className="min-h-11" type="email" value={administrator.email} autoComplete="email" onChange={e => setAdministrator(p => ({ ...p, email: e.target.value }))} /></div>
            <div className="space-y-2"><Label htmlFor="full-admin-password">Permanent Keycloak password</Label><Input id="full-admin-password" className="min-h-11" type="password" value={administrator.password} autoComplete="new-password" onChange={e => setAdministrator(p => ({ ...p, password: e.target.value }))} /><p className="text-sm text-muted-foreground">Choose this personal credential once. Retry preserves existing credentials. Your ProxyPilot password is never copied.</p></div>
            <div className="space-y-2"><Label htmlFor="full-admin-otp">Keycloak one-time code (if already enrolled)</Label><Input id="full-admin-otp" className="min-h-11" inputMode="numeric" autoComplete="one-time-code" value={administrator.otp} onChange={e => setAdministrator(p => ({ ...p, otp: e.target.value }))} /></div>
            <Button variant="outline" className="min-h-11 h-auto whitespace-normal w-full sm:w-auto" disabled={administrator.password.length < 12} onClick={() => run('create', async () => { try { await api.fullPlatformAdministrator({ ...administrator, otp: administrator.otp || undefined, revision: data.revision, action: 'create', reviewed: true }); setNotice('Administrator operation queued. Progress and saved identities are retained across reloads.'); await load(); } finally { setAdministrator(p => ({ ...p, password: '', otp: '' })); } })}>Create or resume permanent administrator</Button>
          </fieldset>
          <section className="rounded-lg border p-4 space-y-2 text-sm"><h3 className="font-semibold">3. Passkey</h3>
            {st.administrator?.applicationId ? <><p>Enroll the application identity’s discoverable passkey in Keycloak Account Console, using the personal password you chose. The managed sign-in flow then requires that passkey. Confirm the administrator’s email in Keycloak.</p><a className="inline-flex min-h-11 items-center underline break-all" href={`${config.services.keycloak.url}/realms/${encodeURIComponent(config.realm)}/account`} target="_blank" rel="noreferrer">Open Keycloak passkey enrollment</a></> : <p className="text-muted-foreground">Available after the permanent administrator exists.</p>}
          </section>
          <section className="space-y-2"><h3 className="font-semibold">4. Link, SSO login, step-up and recovery checks</h3><SsoSetup connections={connections} managed part="checks" administratorVerified={!!st.administratorVerified} /></section>
          <fieldset disabled={locked || !st.administrator?.masterId} className="space-y-3 rounded-lg border p-4 min-w-0"><legend className="px-1 font-semibold">5. Retire the bootstrap account</legend>
            <p className="text-sm">After the checks above pass: a fresh login as the permanent master administrator proves administration, then the temporary account is removed. Stage C unlocks after this.</p>
            <div className="space-y-2"><Label htmlFor="full-retire-password">Permanent Keycloak password</Label><Input id="full-retire-password" className="min-h-11" type="password" value={retire.password} autoComplete="current-password" onChange={e => setRetire(p => ({ ...p, password: e.target.value }))} /><p className="text-sm text-muted-foreground">The password you chose for the permanent administrator in step 2 (at least 12 characters).</p></div>
            <div className="space-y-2"><Label htmlFor="full-retire-otp">Keycloak one-time code (if enrolled)</Label><Input id="full-retire-otp" className="min-h-11" inputMode="numeric" autoComplete="one-time-code" value={retire.otp} onChange={e => setRetire(p => ({ ...p, otp: e.target.value }))} /></div>
            <Button variant="outline" className="min-h-11 h-auto whitespace-normal w-full sm:w-auto" disabled={retire.password.length < 12 || !!busy} onClick={() => run('retire', async () => { try { await api.fullPlatformAdministrator({ ...administrator, password: retire.password, otp: retire.otp || undefined, revision: data.revision, action: 'verify_and_retire', reviewed: true }); setNotice('Verification and retirement queued.'); await load(); } finally { setRetire({ password: '', otp: '' }); } })}>Verify administration and retire bootstrap</Button>
          </fieldset>
        </>}
      </div>;
    }
    if (stage.id === 'C' || stage.id === 'D') {
      const ids = stage.services;
      return <div className="space-y-4">
        {failing}
        <ServiceRows ids={ids} services={data.services} locked={locked} onLifecycle={isCurrent || stage.status === 'done' ? reviewLifecycle : null} />
        {isCurrent && (serviceStage(ids) || stage.status === 'failed') && <Button className="min-h-11 w-full sm:w-auto" disabled={locked || dirty} onClick={continueSetup}>{running ? `Stage ${stage.id} is running…` : stage.status === 'failed' ? `Retry stage ${stage.id}` : `Continue stage ${stage.id}`}</Button>}
        {isCurrent && stage.id === 'D' && <>
          <details className="rounded-lg border p-4"><summary className="min-h-11 cursor-pointer flex items-center font-medium">Infisical administrator</summary><form className="pt-3 space-y-3" onSubmit={e => { e.preventDefault(); const f = new FormData(e.currentTarget), input = { revision: data.revision, email: f.get('email'), password: f.get('password'), reviewed: true }; e.currentTarget.elements.password.value = ''; run('infisical-admin', async () => { await api.fullPlatformInfisicalAdministrator(input); await load(); setNotice('Personal Infisical handoff queued. The organization and machine connections are managed automatically.'); }); }}><p className="text-sm">The selected edition uses Infisical’s local human login. Keycloak human SSO requires the separate oidcSSO entitlement and is not configured. Choose this personal password once; retries use the same account. It is removed from the protected handoff after use or expiry.</p><Label htmlFor="full-if-email">Infisical administrator email</Label><Input id="full-if-email" className="min-h-11" name="email" type="email" required defaultValue={administrator.email} autoComplete="email" /><Label htmlFor="full-if-password">Infisical personal password</Label><Input id="full-if-password" className="min-h-11" name="password" type="password" required minLength={12} autoComplete="new-password" /><Button type="submit" className="min-h-11" disabled={locked}>Create or resume Infisical administration</Button></form></details>
          <details className="rounded-lg border p-4"><summary className="min-h-11 cursor-pointer flex items-center font-medium">OpenBao recovery custody and manual unseal</summary><div className="pt-3"><OpenBaoSetup revision={data.planRevision} fullRevision={data.revision} dirty={dirty} choice={config.services.openbao} connections={connections} managed /></div></details>
          <details className="rounded-lg border p-4"><summary className="min-h-11 cursor-pointer flex items-center font-medium">Vaultwarden sign-in and unlock checks</summary><div className="pt-3"><VaultwardenSetup revision={data.planRevision} dirty={dirty} choice={config.services.vaultwarden} connections={connections} managed /></div></details>
        </>}
      </div>;
    }
    // E
    return <div className="space-y-4">
      {data.complete ? <p className="text-sm">Full Platform setup is complete: every service is verified, permanent administration and independent recovery were proved, and SSO is active.</p> : <p className="text-sm">Every service is installed and verified. Activate SSO to finish: local sign-in moves to the restricted recovery hostname.</p>}
      {isCurrent && <SsoSetup connections={connections} managed part="activate" administratorVerified={!!data.state?.administratorVerified} />}
    </div>;
  }

  return <div id="full-platform-setup" className="space-y-6 min-w-0 max-w-6xl shrink-0 pb-6">
    <header><h1 className="text-2xl md:text-3xl font-bold">Platform Setup</h1><p className="mt-2 text-muted-foreground">Full Platform · Keycloak, Pomerium, Infisical, OpenBao and Vaultwarden, installed and managed as one system.</p></header>
    <PlatformOverview />
    {error && <p role="alert" className="rounded-lg border border-destructive p-4 text-destructive break-words">{error}</p>}
    {notice && <p role="status" className="rounded-lg border p-4 break-words">{notice}</p>}
    {!config || !data ? <p role="status">Loading saved setup…</p> : <>
      <p className="text-sm text-muted-foreground">{dirty ? 'Unsaved changes' : data.revision ? `Saved revision ${data.revision}` : 'New setup'} · {data.job ? `Last operation ${label(data.job.status)}${data.job.reason ? ` — ${data.job.reason}` : ''}` : 'Saving does not install or change services.'}</p>
      <nav aria-label="Setup stages"><ol className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-2">{stages.map(stage => { const [text, Icon, tone] = STATUS[stage.status] || STATUS.locked; return <li key={stage.id}><a href={`#stage-${stage.id}`} aria-current={stage.id === current ? 'step' : undefined} className={`flex min-h-11 h-full items-start gap-2 rounded-md border p-3 text-sm ${stage.id === current ? 'border-primary bg-primary/10' : ''}`}><Icon className={`mt-0.5 h-4 w-4 shrink-0 ${tone}`} aria-hidden="true" /><span className="min-w-0"><span className="font-medium">{stage.id}. {stage.name}</span><span className="block text-xs text-muted-foreground">{text}</span></span></a></li>; })}</ol></nav>
      {stages.map(stage => <Card key={stage.id} id={`stage-${stage.id}`} className={`min-w-0 ${stage.status === 'locked' ? 'opacity-70' : ''}`}><CardHeader><StageHeader stage={stage} />{stage.id === current && <CardDescription>This is the current stage. Later stages unlock when it is verified.</CardDescription>}</CardHeader><CardContent>{stageBody(stage)}</CardContent></Card>)}
      {lifecycle && <section className="rounded-lg border p-4 space-y-3" aria-label="Reviewed runtime action"><h3 className="font-semibold capitalize">{lifecycle.action} {names[lifecycle.service]}</h3><ul className="space-y-2 text-sm">{lifecycle.effects.map(effect => <li key={effect}>{effect}</li>)}</ul><details><summary className="min-h-11 cursor-pointer flex items-center">Affected runtime and boundaries</summary><p className="text-sm break-all">{lifecycle.containers.join(', ')}</p><p className="text-sm">{lifecycle.unsupported}</p></details>{lifecycle.blockers.map(b => <p role="alert" key={b} className="text-sm">{b}</p>)}<label className="flex gap-2 items-start min-h-11 text-sm"><input type="checkbox" className="mt-1" checked={lifecycleConfirmed} onChange={e => setLifecycleConfirmed(e.target.checked)} /><span>I reviewed the affected runtime and service downtime. Keep all persistent data and credentials.</span></label><div className="flex gap-2 flex-wrap"><Button variant="outline" className="min-h-11" onClick={() => setLifecycle(null)}>Cancel</Button><Button className="min-h-11" disabled={locked || !lifecycleConfirmed || lifecycle.blockers.length > 0} onClick={() => run('lifecycle', async () => { await api.fullPlatformLifecycle({ revision: lifecycle.revision, service: lifecycle.service, action: lifecycle.action, reviewToken: lifecycle.reviewToken, reviewed: true, retainData: true }); setLifecycle(null); await load(); })}>Apply reviewed runtime action</Button></div></section>}
      <details className="rounded-lg border p-4"><summary className="min-h-11 cursor-pointer flex items-center font-medium">Operation history</summary><div className="pt-3"><SetupJobs /></div></details>
      <details className="rounded-lg border p-4"><summary className="min-h-11 cursor-pointer flex items-center font-medium">Reset Full Platform</summary><div className="pt-3"><PlatformReset /></div></details>
    </>}
  </div>;
}
