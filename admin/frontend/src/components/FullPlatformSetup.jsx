import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardHeader, CardTitle as BaseCardTitle, CardDescription, CardContent } from '@/components/ui/card';
import OpenBaoSetup from '@/components/OpenBaoSetup';
import VaultwardenSetup from '@/components/VaultwardenSetup';
import SsoSetup from '@/components/SsoSetup';
import PlatformOverview from '@/components/PlatformOverview';
const CardTitle = props => <BaseCardTitle aria-level={2} {...props} />;

const steps = [['domains', 'Domains and realm'], ['review', 'Review'], ['install', 'Install and connect'], ['administrator', 'Administrator and recovery'], ['verify', 'Verify and activate'], ['complete', 'Complete']];
const names = { keycloak: 'Keycloak', pomerium: 'Pomerium', infisical: 'Infisical', openbao: 'OpenBao', vaultwarden: 'Vaultwarden' };
const label = value => String(value || 'not checked').replaceAll('_', ' ');

function Address({ id, title, value, domains, onChange, disabled }) {
  const hostname = value.replace(/^https:\/\//, '');
  const match = domains.find(d => hostname === d.domain || hostname.endsWith(`.${d.domain}`));
  const [selected, setSelected] = useState(match?.domain || 'other');
  useEffect(() => { if (match) { setSelected(match.domain); setSubdomain(hostname === match.domain ? '' : hostname.slice(0, -(match.domain.length + 1))); } }, [domains, value]);
  const [subdomain, setSubdomain] = useState(match ? hostname.slice(0, -(match.domain.length + 1)) : '');
  return <fieldset disabled={disabled} className="space-y-2 min-w-0 rounded-lg border p-4">
    <legend className="px-1 font-medium">{title}</legend>
    <Label htmlFor={`${id}-domain`}>Linked domain for {title}</Label>
    <select id={`${id}-domain`} className="w-full min-h-11 rounded-md border bg-background px-3" value={selected} onChange={e => { const domain = e.target.value; setSelected(domain); if (domain !== 'other') onChange(`https://${subdomain ? `${subdomain}.` : ''}${domain}`); }}>
      {domains.map(d => <option key={d.domain} value={d.domain}>{d.domain}</option>)}
      <option value="other">Enter another hostname</option>
    </select>
    {selected === 'other' ? <><Label htmlFor={`${id}-hostname`}>{title} hostname</Label><Input id={`${id}-hostname`} value={hostname} autoComplete="off" spellCheck={false} placeholder="service.example.com" onChange={e => onChange(e.target.value ? `https://${e.target.value.replace(/^https:\/\//, '')}` : '')} /></> : <><Label htmlFor={`${id}-subdomain`}>{title} subdomain (optional)</Label><Input id={`${id}-subdomain`} autoComplete="off" spellCheck={false} value={subdomain} onChange={e => { setSubdomain(e.target.value); onChange(`https://${e.target.value ? `${e.target.value}.` : ''}${selected}`); }} /></>}
    <p className="text-sm text-muted-foreground break-all">{value || 'Choose a hostname'}</p>
  </fieldset>;
}

export default function FullPlatformSetup({ onCustom }) {
  const [data, setData] = useState(null), [config, setConfig] = useState(null), [domains, setDomains] = useState([]);
  const [step, setStep] = useState('domains'), [busy, setBusy] = useState(''), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [review, setReview] = useState(null), [dirty, setDirty] = useState(false), [revealed, setRevealed] = useState(null), [connections, setConnections] = useState([]);
  const [administrator, setAdministrator] = useState({ useCurrent: true, username: '', email: '', firstName: '', lastName: '', password: '', otp: '' });
  const [lifecycle, setLifecycle] = useState(null), [lifecycleConfirmed, setLifecycleConfirmed] = useState(false);
  const request = useRef(0), alive = useRef(true);
  async function load(reset = false) {
    const id = ++request.current;
    const next = await api.getFullPlatform();
    if (!alive.current || id !== request.current) return;
    setData(next);
    if (reset) { setConfig(next.config); setDirty(false); setReview(next.review); setStep(next.stage); setAdministrator(p => ({ ...p, firstName: next.state.administrator?.firstName || '', lastName: next.state.administrator?.lastName || '', username: next.state.administrator?.username || next.administrator?.username || '', email: next.state.administrator?.email || next.administrator?.email || '' })); }
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
  async function run(name, fn) {
    setBusy(name); setError(''); setNotice('');
    try { await fn(); } catch (e) { setError(e.message); } finally { setBusy(''); }
  }
  const locked = !!busy || ['queued', 'running'].includes(data?.job?.status);
  return <div id="full-platform-setup" className="space-y-6 min-w-0 max-w-6xl shrink-0 pb-6">
    <header className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
      <div><h1 className="text-2xl md:text-3xl font-bold">Platform Setup</h1><p className="mt-2 text-muted-foreground">Full Platform · one saved setup for identity, access and secrets.</p></div>
      <Button variant="outline" className="min-h-11" onClick={onCustom}>Custom / Advanced</Button>
    </header>
    {/* Top of the Platform section: the MCP access switch, then the overview. */}
    <PlatformOverview />
    {error && <p role="alert" className="rounded-lg border border-destructive p-4 text-destructive break-words">{error}</p>}
    {notice && <p role="status" className="rounded-lg border p-4">{notice}</p>}
    {!config ? <p role="status">Loading saved setup…</p> : <>
      <nav aria-label="Full Platform steps"><ol className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">{steps.map(([key, title], index) => <li key={key}><Button variant={step === key ? 'secondary' : 'outline'} className="w-full min-h-11 h-auto whitespace-normal text-left justify-start" aria-current={step === key ? 'step' : undefined} disabled={key === 'complete' && !data.complete} onClick={() => { setRevealed(null); setStep(key); }}>{index + 1}. {title}</Button></li>)}</ol></nav>
      <p className="text-sm text-muted-foreground">{dirty ? 'Unsaved changes' : data.revision ? `Saved revision ${data.revision}` : 'New setup'} · {data.job ? `Operation ${label(data.job.status)}` : 'Saving does not install or change services.'}</p>
      {step === 'domains' && <Card><CardHeader><CardTitle>Domains and realm</CardTitle><CardDescription>Existing installations are prefilled. Connection values and private service settings are managed automatically.</CardDescription></CardHeader><CardContent className="space-y-5">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Address id="full-public" title="ProxyPilot" value={config.publicOrigin} domains={domains} disabled={locked} onChange={v => change({ ...config, publicOrigin: v })} />
          <Address id="full-recovery" title="Local recovery" value={config.recoveryOrigin} domains={domains} disabled={locked} onChange={v => change({ ...config, recoveryOrigin: v })} />
          {Object.entries(config.services).map(([id, s]) => <Address key={id} id={`full-${id}`} title={names[id]} value={s.url} domains={domains} disabled={locked} onChange={v => change({ ...config, services: { ...config.services, [id]: { ...s, url: v } } })} />)}
        </div>
        <div className="space-y-2"><Label htmlFor="full-realm">Realm name</Label><Input id="full-realm" value={config.realm} disabled={locked} onChange={e => change({ ...config, realm: e.target.value })} /></div>
        <Button className="min-h-11" disabled={locked} onClick={() => run('review', async () => { setReview(await api.reviewFullPlatform(config)); setStep('review'); })}>Review setup</Button>
      </CardContent></Card>}
      {step === 'review' && <Card><CardHeader><CardTitle>Review and save</CardTitle><CardDescription>Confirm addresses, existing services and recovery access before applying.</CardDescription></CardHeader><CardContent className="space-y-5">
        <ul className="divide-y">{Object.entries(config.services).map(([id, s]) => <li key={id} className="py-3 break-words"><p className="font-medium">{names[id]} · {s.mode === 'install' ? 'Install or reuse owned service' : label(s.mode)}</p><p className="text-sm break-all">{s.url}</p></li>)}</ul>
        {review?.changes?.length > 0 && <ul className="space-y-2 text-sm" aria-label="Proposed changes">{review.changes.map(c => <li key={c.field} className="break-words">{c.field}: {c.before} → {c.after}</li>)}</ul>}
        {review?.dependencies?.map(d => <p key={d.service} className="rounded border p-3 text-sm">{d.reason}</p>)}
        <div className="space-y-2"><Label htmlFor="full-networks">Confirm approved administrator / VPN recovery networks</Label><Input id="full-networks" value={config.recoveryNetworks.join(', ')} placeholder="Existing administrator IP or VPN CIDR" disabled={locked} onChange={e => change({ ...config, recoveryNetworks: e.target.value.split(',').map(x => x.trim()).filter(Boolean) })} /><p className="text-sm text-muted-foreground">{config.recoveryNetworks.length ? 'Review these restrictions before applying.' : 'No approved recovery network was discovered. Specify your existing administrator/VPN network to continue.'}</p></div>
        <details className="rounded border p-3"><summary className="min-h-11 cursor-pointer">DNS and managed settings</summary><p className="text-sm mt-2">{review?.managed}</p><ul className="space-y-3 mt-3 text-sm">{review?.dns?.map(d => <li key={d.service} className="break-words"><strong className="break-all">{d.url}</strong><p>{d.action}</p></li>)}</ul></details>
        <div className="flex flex-col sm:flex-row gap-3">
          <Button className="min-h-11" disabled={locked} onClick={() => run('save', async () => { const next = await api.saveFullPlatform({ expectedRevision: data.revision, config, reviewed: true }); setData(next); setConfig(next.config); setReview(next.review); setDirty(false); setNotice('Plan saved. No services or identity settings changed.'); })}>Save reviewed plan</Button>
          <Button className="min-h-11" variant="outline" disabled={locked || dirty || !data.revision} onClick={() => run('apply', async () => { await api.applyFullPlatform({ revision: data.revision, reviewToken: data.review.reviewToken, reviewed: true }); await load(); setStep('install'); })}>Apply saved setup</Button>
        </div>
      </CardContent></Card>}
      {step === 'install' && <Card><CardHeader><CardTitle>Installation and connection progress</CardTitle><CardDescription>Progress comes from saved server jobs. You can close or reload this page.</CardDescription></CardHeader><CardContent className="space-y-4">
        <ol className="space-y-3">{data.services.map(s => <li key={s.id} className="rounded-lg border p-4 space-y-2 min-w-0"><div className="flex flex-col sm:flex-row sm:justify-between gap-1"><h3 className="font-semibold">{s.name}</h3><span className="text-sm capitalize">{label(s.state)}</span></div><p className="text-sm break-all">{s.url}</p>{s.action && <p className="text-sm break-words">{s.action}</p>}{s.job?.phase && <p className="text-xs text-muted-foreground">Current action: {label(s.job.phase)}</p>}{s.ownership === 'managed' && <details className="text-sm"><summary className="min-h-11 cursor-pointer">Repair, reinstall or remove runtime</summary><div className="flex flex-col sm:flex-row gap-2">{['repair','reinstall','remove'].map(action => <Button key={action} variant="outline" className="min-h-11 capitalize" disabled={locked} onClick={() => run('lifecycle-review', async () => { setLifecycle(await api.fullPlatformLifecycleReview({service:s.id,action}));setLifecycleConfirmed(false); })}>{action}</Button>)}</div></details>}</li>)}</ol>
        {lifecycle && <section className="rounded-lg border p-4 space-y-3" aria-label="Reviewed runtime action"><h3 className="font-semibold capitalize">{lifecycle.action} {names[lifecycle.service]}</h3><ul className="space-y-2 text-sm">{lifecycle.effects.map(effect=><li key={effect}>{effect}</li>)}</ul><details><summary className="min-h-11 cursor-pointer">Affected runtime and boundaries</summary><p className="text-sm break-all">{lifecycle.containers.join(', ')}</p><p className="text-sm">{lifecycle.unsupported}</p></details>{lifecycle.blockers.map(b=><p role="alert" key={b} className="text-sm">{b}</p>)}<label className="flex gap-2 items-start min-h-11 text-sm"><input type="checkbox" className="mt-1" checked={lifecycleConfirmed} onChange={e=>setLifecycleConfirmed(e.target.checked)}/><span>I reviewed the affected runtime and service downtime. Keep all persistent data and credentials.</span></label><div className="flex gap-2 flex-wrap"><Button variant="outline" className="min-h-11" onClick={()=>setLifecycle(null)}>Cancel</Button><Button className="min-h-11" disabled={locked||!lifecycleConfirmed||lifecycle.blockers.length>0} onClick={()=>run('lifecycle',async()=>{await api.fullPlatformLifecycle({revision:lifecycle.revision,service:lifecycle.service,action:lifecycle.action,reviewToken:lifecycle.reviewToken,reviewed:true,retainData:true});setLifecycle(null);await load();})}>Apply reviewed runtime action</Button></div></section>}
        {data.job?.reason && <p role="status" className="text-sm break-words">{data.job.reason}</p>}
        <div className="flex flex-col sm:flex-row gap-3"><Button className="min-h-11" disabled={locked || dirty || !data.revision} onClick={() => run('retry', async () => { await api.applyFullPlatform({ revision: data.revision, reviewToken: data.review.reviewToken, reviewed: true }); await load(); })}>Continue saved setup</Button><Button className="min-h-11" variant="outline" onClick={() => setStep('administrator')}>Administrator and recovery</Button></div>
      </CardContent></Card>}
      {step === 'administrator' && <Card><CardHeader><CardTitle>Administrator and recovery</CardTitle><CardDescription>Keep permanent administration, application sign-in and local recovery available.</CardDescription></CardHeader><CardContent className="space-y-4">
        <p>Use my current ProxyPilot administrator: <strong>{data.administrator?.username || 'Current administrator'}</strong></p>
        <p className="text-sm">Your existing ProxyPilot account ID, local credentials and roles are preserved. Linking requires proof of both accounts.</p>
        <fieldset disabled={locked} className="space-y-3 rounded border p-4 min-w-0"><legend className="px-1 font-medium">Permanent Keycloak administrator</legend>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">{[['firstName','First name'],['lastName','Last name']].map(([key,title])=><div className="space-y-2" key={key}><Label htmlFor={`full-admin-${key}`}>{title}</Label><Input id={`full-admin-${key}`} value={administrator[key]} autoComplete={key==='firstName'?'given-name':'family-name'} onChange={e=>setAdministrator(p=>({...p,[key]:e.target.value}))}/></div>)}</div>
          <label className="flex items-center gap-2 min-h-11"><input type="checkbox" checked={administrator.useCurrent} onChange={e => setAdministrator(p => ({ ...p, useCurrent: e.target.checked }))} />Use my current ProxyPilot administrator</label>
          {!administrator.useCurrent && <div className="space-y-2"><Label htmlFor="full-admin-name">Permanent administrator username</Label><Input id="full-admin-name" value={administrator.username} onChange={e => setAdministrator(p => ({ ...p, username: e.target.value }))} /></div>}
          <div className="space-y-2"><Label htmlFor="full-admin-email">Administrator email</Label><Input id="full-admin-email" type="email" value={administrator.email} autoComplete="email" onChange={e => setAdministrator(p => ({ ...p, email: e.target.value }))} /></div>
          <div className="space-y-2"><Label htmlFor="full-admin-password">Permanent Keycloak password</Label><Input id="full-admin-password" type="password" value={administrator.password} autoComplete="new-password" onChange={e => setAdministrator(p => ({ ...p, password: e.target.value }))} /><p className="text-sm text-muted-foreground">Choose this personal credential once. Retry preserves existing credentials. Your ProxyPilot password is never copied.</p></div>
          <div className="space-y-2"><Label htmlFor="full-admin-otp">Keycloak one-time code (if already enrolled)</Label><Input id="full-admin-otp" inputMode="numeric" autoComplete="one-time-code" value={administrator.otp} onChange={e => setAdministrator(p => ({ ...p, otp: e.target.value }))} /></div>
          <div className="flex flex-col sm:flex-row gap-2">{[['create', 'Create or resume permanent administrator'], ['verify_and_retire', 'Verify administration and retire bootstrap']].map(([action, title]) => <Button key={action} variant="outline" className="min-h-11 h-auto whitespace-normal" disabled={!data.state.identity?.bootstrapRef || action === 'verify_and_retire' && !data.state.administrator?.masterId} onClick={() => run(action, async () => { try { await api.fullPlatformAdministrator({ ...administrator, otp: administrator.otp || undefined, revision: data.revision, action, reviewed: true }); setNotice('Administrator operation queued. Progress and saved identities are retained across reloads.'); await load(); } finally { setAdministrator(p => ({ ...p, password: '', otp: '' })); } })}>{title}</Button>)}</div>
        </fieldset>
        <Button className="min-h-11" variant="outline" disabled={!!busy || !data.state.identity?.bootstrapRef} onClick={() => run('reveal', async () => { const v = await api.revealKeycloakBootstrap(); if (v.retired) setNotice(v.label); else setRevealed(v); })}>Reveal initial Keycloak password</Button>
        {revealed && <section aria-label="Initial Keycloak password" className="rounded border p-4 space-y-3"><p className="text-sm">{revealed.username} · hidden after 30 seconds or when you leave this page</p><Label htmlFor="full-bootstrap">Initial password</Label><Input id="full-bootstrap" readOnly autoComplete="off" value={revealed.password} /><Button className="min-h-11" variant="outline" onClick={() => setRevealed(null)}>Hide password</Button></section>}
        {Object.entries(data.state.actions || {}).map(([id, action]) => <p key={id} className="text-sm rounded border p-3 break-words">{names[id] || label(id)}: {action}</p>)}
        {data.state.administrator?.applicationId && <div className="text-sm space-y-2"><p>Enroll the application identity’s discoverable passkey in Keycloak Account Console, using the personal password you chose. The managed sign-in flow then requires that passkey. Confirm the administrator’s email in Keycloak before testing Vaultwarden.</p><a className="inline-flex min-h-11 items-center underline break-all" href={`${config.services.keycloak.url}/realms/${encodeURIComponent(config.realm)}/account`} target="_blank" rel="noreferrer">Open Keycloak passkey enrollment</a><p>Master-realm administration is a separate identity; verify it with the permanent password above after the ProxyPilot login, step-up and recovery tests.</p></div>}
        {config.services.infisical.mode !== 'skip' && <details className="rounded-lg border p-4"><summary className="min-h-11 cursor-pointer font-medium">Infisical administrator</summary><form className="pt-3 space-y-3" onSubmit={e => { e.preventDefault(); const f = new FormData(e.currentTarget), input = {revision:data.revision,email:f.get('email'),password:f.get('password'),reviewed:true}; e.currentTarget.elements.password.value=''; run('infisical-admin',async()=>{await api.fullPlatformInfisicalAdministrator(input);await load();setNotice('Personal Infisical handoff queued. The organization and machine connections are managed automatically.');}); }}><p className="text-sm">The selected edition uses Infisical’s local human login. Keycloak human SSO requires the separate oidcSSO entitlement and is not configured. Choose this personal password once; retries use the same account. It is removed from the protected handoff after use or expiry.</p><Label htmlFor="full-if-email">Infisical administrator email</Label><Input id="full-if-email" name="email" type="email" required defaultValue={administrator.email} autoComplete="email"/><Label htmlFor="full-if-password">Infisical personal password</Label><Input id="full-if-password" name="password" type="password" required minLength={12} autoComplete="new-password"/><Button type="submit" className="min-h-11" disabled={locked}>Create or resume Infisical administration</Button></form></details>}
        {config.services.openbao.mode !== 'skip' && <details className="rounded-lg border p-4"><summary className="min-h-11 cursor-pointer font-medium">OpenBao recovery custody and manual unseal</summary><div className="pt-3"><OpenBaoSetup revision={data.planRevision} fullRevision={data.revision} dirty={dirty} choice={config.services.openbao} connections={connections} managed /></div></details>}
        <Button className="min-h-11" onClick={() => setStep('verify')}>Continue to access checks</Button>
      </CardContent></Card>}
      {step === 'verify' && <><SsoSetup connections={connections} managed administratorVerified={data.state.administratorVerified} />{config.services.vaultwarden.mode !== 'skip' && <details className="rounded-lg border p-4"><summary className="min-h-11 font-medium cursor-pointer">Vaultwarden sign-in and unlock checks</summary><div className="pt-3"><VaultwardenSetup revision={data.planRevision} dirty={dirty} choice={config.services.vaultwarden} connections={connections} managed /></div></details>}<Button variant="outline" className="min-h-11" onClick={() => setStep(data.complete ? 'complete' : 'administrator')}>{data.complete ? 'View completed setup' : 'Return to administrator handoff'}</Button></>}
      {step === 'complete' && data.complete && <Card><CardHeader><CardTitle>Full Platform setup complete</CardTitle><CardDescription>Selected service connections and administrator recovery checks passed.</CardDescription></CardHeader><CardContent><Button className="min-h-11" variant="outline" onClick={() => setStep('domains')}>Review saved setup</Button></CardContent></Card>}
    </>}
  </div>;
}
