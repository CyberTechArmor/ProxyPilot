import InfisicalSetup from '@/components/InfisicalSetup';
import PomeriumSetup from '@/components/PomeriumSetup';
import SsoSetup from '@/components/SsoSetup';
import KeycloakSetup from '@/components/KeycloakSetup';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { CheckCircle2, HelpCircle, ClipboardList, RefreshCw, XCircle } from 'lucide-react';
import { useAuth } from '@/context/AuthContext';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

const modeLabel = { install: 'Install', connect: 'Connect existing', skip: 'Skip' };
const statusLabel = (value) => String(value || 'not_checked').replaceAll('_', ' ');
const timestamp = (value) => value ? new Date(value).toLocaleString() : 'Never';

function CheckResult({ check }) {
  const Icon = check.status === 'pass' ? CheckCircle2 : check.status === 'fail' ? XCircle : HelpCircle;
  return <li className="flex gap-3 rounded-lg border p-3 min-w-0">
    <Icon aria-hidden="true" className={`mt-0.5 h-5 w-5 shrink-0 ${check.status === 'pass' ? 'text-primary' : check.status === 'fail' ? 'text-destructive' : 'text-muted-foreground'}`} />
    <div className="min-w-0 space-y-1 break-words">
      <p className="font-medium">{check.label} <span className="text-sm font-normal capitalize">— {statusLabel(check.status)}</span></p>
      <p className="text-sm text-muted-foreground">{check.reason}</p>
      {check.facts && <dl className="text-xs grid grid-cols-1 sm:grid-cols-2 gap-x-5 gap-y-1">{Object.entries(check.facts).map(([key, value]) => <div key={key}><dt className="inline">{key.replace(/([A-Z])/g, ' $1')}: </dt><dd className="inline">{value === null ? 'Not checked' : typeof value === 'number' && key.endsWith('Bytes') ? `${(value / 1024 ** 3).toFixed(1)} GiB` : String(value)}</dd></div>)}</dl>}
    </div>
  </li>;
}

function SetupJobs() {
  const [overview, setOverview] = useState(null);
  const [detail, setDetail] = useState(null);
  const [selected, setSelected] = useState('');
  const [error, setError] = useState('');
  const requestId = useRef(0);
  const refresh = useCallback(async () => {
    const id = ++requestId.current;
    try {
      const [next, job] = await Promise.all([api.getSetupOverview(), selected ? api.getSetupJob(selected) : Promise.resolve(null)]);
      if (requestId.current !== id) return;
      setOverview(next); setDetail(job); setError('');
    } catch (err) { if (requestId.current === id) setError(err.message); }
  }, [selected]);
  useEffect(() => { refresh(); const timer = setInterval(refresh, 10000); return () => { clearInterval(timer); requestId.current++; }; }, [refresh]);
  return <Card>
    <CardHeader className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
      <div className="space-y-1.5"><CardTitle>Existing setup jobs</CardTitle><CardDescription>Execution and verification are separate. This saved plan does not create a job.</CardDescription></div>
      <Button variant="outline" className="min-h-11 shrink-0" onClick={refresh}><RefreshCw className="h-4 w-4 mr-2" aria-hidden="true" />Refresh jobs</Button>
    </CardHeader>
    <CardContent className="space-y-4">
      {error && <p role="alert" className="text-destructive break-words">Job status could not be refreshed: {error}. Previously loaded records may be out of date.</p>}
      {!overview && !error && <p role="status">Loading jobs…</p>}
      {overview?.locks?.length > 0 && <div className="rounded-lg border p-3 text-sm space-y-2">{overview.locks.map((lock) => <p key={lock.app} className="break-all">{lock.app}: {lock.stale ? 'Stale lease — recovery needs attention' : 'Operation holds a live lease'} ({lock.operation})</p>)}</div>}
      {overview?.jobs?.length === 0 && <p className="text-sm text-muted-foreground">No recorded setup jobs. Service installation state remains unverified.</p>}
      <ul className="space-y-2">{overview?.jobs?.map((job) => <li key={job.id} className="rounded-lg border p-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div className="min-w-0 break-words"><p className="font-medium">{job.app} · {statusLabel(job.kind)}</p><p className="text-sm">Status: {statusLabel(job.status)} · Outcome: {job.outcome ? statusLabel(job.outcome) : 'Not recorded'}</p><p className="text-sm text-muted-foreground">Verification: {job.verification?.state ? statusLabel(job.verification.state) : 'Not checked'}{job.verification?.pending?.length ? ` · Pending: ${job.verification.pending.map(statusLabel).join(', ')}` : ''}</p></div>
        <Button variant="outline" className="min-h-11 shrink-0" aria-expanded={selected === job.id} onClick={() => { setDetail(null); setSelected(selected === job.id ? '' : job.id); }}> {selected === job.id ? 'Hide events' : 'View events'}<span className="sr-only"> for {job.app}</span></Button>
      </li>)}</ul>
      {detail && <section aria-label="Selected job events" className="rounded-lg border p-4 space-y-3 min-w-0">
        <h3 className="font-semibold break-words">{detail.job.app}: {statusLabel(detail.job.status)}</h3>
        <p className="text-sm break-words">{detail.job.reason || 'No reason recorded.'}</p>
        <p className="text-xs text-muted-foreground break-all">Job {detail.job.id} · {timestamp(detail.job.updated_at)}</p>
        {detail.events.length === 0 ? <p className="text-sm">No recorded events.</p> : <ol className="space-y-3">{detail.events.map((event) => <li key={event.id} className="border-t pt-3 text-sm min-w-0"><p>{timestamp(event.at || event.created_at)} · {statusLabel(event.kind)}</p><p className="break-words">{event.message}</p><pre className="mt-1 whitespace-pre-wrap break-all font-sans text-muted-foreground">{JSON.stringify(event.data, null, 2)}</pre></li>)}</ol>}
      </section>}
    </CardContent>
  </Card>;
}

function PlatformSetupContent() {
  const [data, setData] = useState(null);
  const [choices, setChoices] = useState(null);
  const [stage, setStage] = useState('choose');
  const [checks, setChecks] = useState(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [dirty, setDirty] = useState(false);
  const load = useCallback(async () => {
    setBusy('load'); setError('');
    try { const next = await api.getPlatformSetup(); setData(next); setChoices(next.plan.choices); setChecks(next.plan.checks); setDirty(false); setStage('choose'); setMessage(''); }
    catch (err) { setError(err.message); }
    finally { setBusy(''); }
  }, []);
  useEffect(() => { load(); }, [load]);
  function change(id, field, value) {
    setChoices(prior => {
      let next = { ...prior[id], [field]: value };
      if (field === 'mode' && value === 'skip') next = { mode: 'skip', url: '', ...(id === 'infisical' ? { agentProxyMode: 'skip', agentProxyUrl: '' } : {}) };
      if (id === 'infisical' && field === 'agentProxyMode' && value === 'skip') next.agentProxyUrl = '';
      return { ...prior, [id]: next };
    });
    setChecks(null); setDirty(true); setMessage(''); setError('');
  }
  async function runChecks() {
    setBusy('checks'); setError(''); setMessage('');
    try { setChecks(await api.checkPlatformPlan({ schemaVersion: 1, choices })); }
    catch (err) { setError(err.message); }
    finally { setBusy(''); }
  }
  async function save() {
    setBusy('save'); setError(''); setMessage('');
    try {
      const { plan } = await api.savePlatformPlan({ schemaVersion: 1, choices, expectedRevision: data.plan.revision, reviewed: true });
      setData((prior) => ({ ...prior, plan })); setChoices(plan.choices); setChecks(plan.checks); setDirty(false);
      setMessage(`Saved plan · revision ${plan.revision}. You can return later. No services were installed or connected.`);
    } catch (err) { setError(err.message); }
    finally { setBusy(''); }
  }
  return <div className="space-y-6 min-w-0 max-w-6xl">
    <header className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
      <div className="space-y-2 min-w-0"><h1 className="text-2xl md:text-3xl font-bold flex items-center gap-2"><ClipboardList className="h-7 w-7 shrink-0" aria-hidden="true" />Platform Setup</h1><p className="text-muted-foreground">Choose additional services, check what is available and save a plan.</p></div>
      <Button variant="outline" className="min-h-11 shrink-0" disabled={!!busy} onClick={load}>{dirty ? 'Discard changes and reopen' : 'Reopen saved plan'}</Button>
    </header>
    {error && <p role="alert" className="rounded-lg border border-destructive p-4 text-destructive break-words">{error}</p>}
    {message && <p role="status" className="rounded-lg border border-primary p-4">{message}</p>}
    {!data ? <p role="status">{busy ? 'Loading platform plan…' : 'The platform plan could not be loaded. Try reopening it.'}</p> : <>
      <div className="rounded-lg border bg-muted/30 p-4 space-y-2 text-sm">
        <p className="font-medium">{dirty ? 'Unsaved changes' : data.plan.status === 'saved_plan' ? `Saved plan · revision ${data.plan.revision}` : 'No saved plan yet'}{data.plan.reviewedAt ? ` · Last saved ${timestamp(data.plan.reviewedAt)}` : ''}</p>
        <p>{data.installation.reason}</p>
        <p>Your current login and running applications stay in place. Keycloak can be installed or connected after a separate review and explicit application. Configure and test SSO in the guide below before explicit activation.</p>
      </div>
      <nav aria-label="Setup steps" className="flex flex-col sm:flex-row gap-2">
        <Button variant={stage === 'choose' ? 'secondary' : 'outline'} className="min-h-11" aria-current={stage === 'choose' ? 'step' : undefined} disabled={!!busy} onClick={() => setStage('choose')}>1. Choose services</Button>
        <Button variant={stage === 'review' ? 'secondary' : 'outline'} className="min-h-11" aria-current={stage === 'review' ? 'step' : undefined} disabled={!!busy} onClick={() => setStage('review')}>2. Review and save</Button>
      </nav>
      {stage === 'choose' ? <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">{data.services.map((service) => {
        const selected = choices[service.id];
        return <Card key={service.id} className="min-w-0"><CardHeader><CardTitle>{service.name}</CardTitle><CardDescription>{service.description}</CardDescription></CardHeader><CardContent className="space-y-4">
          <fieldset disabled={!!busy} className="min-w-0"><legend className="sr-only">{service.name} choice</legend><div className="flex flex-col sm:flex-row flex-wrap gap-2">{Object.entries(modeLabel).map(([mode, label]) => <label key={mode} className={`flex items-center gap-2 min-h-11 px-3 py-2 rounded-md border cursor-pointer text-sm ${selected.mode === mode ? 'border-primary bg-primary/10' : ''}`}><input type="radio" name={`${service.id}-mode`} value={mode} checked={selected.mode === mode} onChange={() => change(service.id, 'mode', mode)} />{label}</label>)}</div></fieldset>
          {selected.mode !== 'skip' && <div className="space-y-3">
            <div className="space-y-2"><Label htmlFor={`${service.id}-url`}>{service.name} origin</Label><Input id={`${service.id}-url`} type="url" value={selected.url} disabled={!!busy} autoComplete="off" spellCheck={false} placeholder={`https://${service.id}.example.com`} onChange={e => change(service.id, 'url', e.target.value)} /><p className="text-xs text-muted-foreground">{service.id === 'infisical' ? 'Dedicated HTTPS DNS origin on port 443. No credentials, paths or tokens.' : 'Domain with http(s); optional port. No credentials, paths or tokens.'}</p></div>
            {service.id === 'infisical' && <>
              <fieldset disabled={!!busy} className="min-w-0"><legend className="text-sm font-medium mb-2">Agent Proxy choice</legend><div className="flex flex-col sm:flex-row flex-wrap gap-2">{Object.entries(modeLabel).map(([mode, label]) => <label key={mode} className="flex items-center gap-2 min-h-11 px-3 py-2 rounded-md border cursor-pointer text-sm"><input type="radio" name="infisical-agent-mode" value={mode} checked={(selected.agentProxyMode || selected.mode) === mode} onChange={() => change(service.id, 'agentProxyMode', mode)} />{label}</label>)}</div></fieldset>
              {(selected.agentProxyMode || selected.mode) !== 'skip' && <div className="space-y-2"><Label htmlFor="infisical-agentProxyUrl">Agent Proxy private origin</Label><Input id="infisical-agentProxyUrl" type="url" value={selected.agentProxyUrl} disabled={!!busy} autoComplete="off" spellCheck={false} placeholder="http://10.20.30.40:17322" onChange={e => change(service.id, 'agentProxyUrl', e.target.value)} /><p className="text-xs text-muted-foreground">HTTP on the runner host's private IPv4, port 17322. Agent Proxy is private and separate from Caddy's public HTTPS routes.</p></div>}
            </>}
          </div>}
          {service.id === 'keycloak' && selected.mode !== 'skip' && <div className="space-y-2"><Label htmlFor="keycloak-realm">Keycloak realm</Label><Input id="keycloak-realm" value={selected.realm || ''} disabled={!!busy} placeholder="proxypilot" autoComplete="off" spellCheck={false} onChange={e => change(service.id, 'realm', e.target.value)} /><p className="text-xs text-muted-foreground">Realm name only. The issuer is the HTTPS origin followed by /realms/ and this name. Managed installation uses port 443 and a new realm other than master.</p></div>}
          <p className="text-xs text-muted-foreground">{['keycloak','pomerium','infisical'].includes(service.id) ? 'Verified connection and progress are shown below.' : 'Verified installed state: not checked. A service-specific adapter is required.'}</p>
        </CardContent></Card>;
      })}</div> : <Card><CardHeader><CardTitle>Review your plan</CardTitle><CardDescription>These are intended additions and connections. Unresolved checks can be saved for later.</CardDescription></CardHeader><CardContent className="space-y-4">
        <ul className="divide-y">{data.services.map((service) => <li key={service.id} className="py-3 min-w-0 break-words"><p className="font-medium">{service.name} · {modeLabel[choices[service.id].mode]}</p>{choices[service.id].mode !== 'skip' && <><p className="text-sm break-all">{choices[service.id].url || 'Endpoint required'}</p>{service.id === 'keycloak' && <p className="text-sm break-all">Realm: {choices.keycloak.realm || 'Realm required before applying'}</p>}{service.id === 'infisical' && <p className="text-sm break-all">Agent Proxy: {modeLabel[choices.infisical.agentProxyMode || choices.infisical.mode]}{(choices.infisical.agentProxyMode || choices.infisical.mode) !== 'skip' && ` · ${choices.infisical.agentProxyUrl || 'Endpoint required'}`}</p>}</>}<p className="text-xs text-muted-foreground">Installation / connection unverified</p></li>)}</ul>
        <div className="rounded-lg border p-3 text-sm">Keycloak, Pomerium and Infisical have separate review and apply steps below. Other services remain saved intentions. ProxyPilot SSO has its own activation guide.</div>
        <div className="flex flex-col sm:flex-row flex-wrap gap-2"><Button className="min-h-11 bg-foreground text-background hover:bg-foreground/90" disabled={!!busy} onClick={save}>{busy === 'save' ? 'Saving plan…' : 'Save reviewed plan'}</Button></div>
        <p className="text-xs text-muted-foreground">Saving refreshes available checks and requires the existing administrator re-authentication when needed. It does not queue installation.</p>
      </CardContent></Card>}
      <KeycloakSetup revision={data.plan.revision} dirty={dirty} mode={choices.keycloak.mode} />
      <Card><CardHeader className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3"><div className="space-y-1.5"><CardTitle>Read-only checks</CardTitle><CardDescription>{checks ? `Snapshot from ${timestamp(checks.checkedAt)}. Run again to refresh.` : 'Not checked for these choices. Run available checks or save to collect a snapshot.'}</CardDescription></div><Button variant="outline" className="min-h-11 shrink-0" disabled={!!busy} onClick={runChecks}>{busy === 'checks' ? 'Checking…' : 'Run available checks'}</Button></CardHeader><CardContent className="space-y-3">
        {checks?.dependencies?.length > 0 && <div role="status" className="rounded-lg border border-destructive p-3"><p className="font-medium">Unresolved dependencies or conflicts</p><ul className="list-disc pl-5 text-sm space-y-1">{checks.dependencies.map((issue) => <li key={issue} className="break-words">{issue}</li>)}</ul></div>}
        {checks && <ul className="space-y-2">{checks.checks.map((check) => <CheckResult key={check.id} check={check} />)}</ul>}
      </CardContent></Card>
      <SsoSetup connections={data.keycloak || []} />
      <PomeriumSetup revision={data.plan.revision} dirty={dirty} mode={choices.pomerium.mode} origin={choices.pomerium.url} connections={data.keycloak || []} />
      <InfisicalSetup revision={data.plan.revision} dirty={dirty} choice={choices.infisical} />
      <SetupJobs />
    </>}
  </div>;
}
export default function PlatformSetup() {
  const { user, loading } = useAuth();
  if (loading) return <p role="status">Loading…</p>;
  if (user?.role !== 'admin') return <Navigate to="/" replace />;
  return <PlatformSetupContent />;
}
