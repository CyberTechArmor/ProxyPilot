import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

const emptyIdentities = () => Object.fromEntries(['workload', 'proxy', 'agent'].map(role => [role, { identityId: '', clientId: '', clientSecret: '' }]));
const modeLabel = { install: 'Install', connect: 'Connect existing', skip: 'Skip' };

export default function InfisicalSetup({ revision, dirty, choice }) {
  const [data, setData] = useState(null), [busy, setBusy] = useState(false);
  const [error, setError] = useState(''), [message, setMessage] = useState(''), [reviewed, setReviewed] = useState(false);
  const [host, setHost] = useState(''), [vm, setVm] = useState(''), [ips, setIps] = useState(''), [container, setContainer] = useState('');
  const [organization, setOrganization] = useState(''), [project, setProject] = useState(''), [identities, setIdentities] = useState(emptyIdentities);
  const state = data?.state, review = data?.review, handoff = review?.handoff;
  const agentMode = choice.mode === 'skip' ? 'skip' : choice.agentProxyMode || choice.mode;
  const pending = ['queued', 'running'].includes(state?.job?.status);
  const matchesPlan = !state || (state.config.mode === choice.mode && state.config.origin === choice.url && state.config.agentMode === agentMode && (agentMode === 'skip' || state.config.proxyOrigin === choice.agentProxyUrl));
  const canConfigure = !!data && !dirty && revision > 0 && choice.mode !== 'skip' && matchesPlan;
  const roles = (state?.config.agentMode || agentMode) === 'skip' ? ['workload'] : ['workload', 'proxy', 'agent'];

  useEffect(() => {
    let active = true;
    const poll = async () => {
      try { const next = await api.getInfisicalSetup(); if (active) { setData(next); setError(''); } }
      catch { if (active) { setData(null); setError('Secrets setup status is unavailable. Reopen before applying.'); } }
    };
    poll(); const timer = setInterval(poll, 5000);
    return () => { active = false; clearInterval(timer); };
  }, []);
  useEffect(() => setReviewed(false), [revision, dirty, choice.mode, agentMode, review?.reviewToken]);
  useEffect(() => setIdentities(emptyIdentities()), [choice.mode, agentMode]);
  async function run(action) {
    setBusy(true); setError(''); setMessage(''); setReviewed(false);
    try { await action(); setData(await api.getInfisicalSetup()); }
    catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }
  function saveTargets(e) {
    e.preventDefault();
    run(async () => {
      await api.saveInfisicalSetup({ expectedPlanRevision: revision, expectedRevision: 0, agentMode, testHost: host.trim(), agentVm: vm.trim(), allowedIps: ips.split(/[\s,]+/).filter(Boolean), ...(agentMode === 'connect' ? { externalProxyContainer: container.trim() } : {}), reviewed: true });
      setMessage('Secrets targets saved. Nothing was installed. Complete the handoff, review and explicitly apply.');
    });
  }
  function saveIdentities(e) {
    e.preventDefault();
    const body = { expectedRevision: state.revision, organizationId: organization.trim(), projectId: project.trim(), ...Object.fromEntries(roles.map(role => [role, identities[role]])), reviewed: true };
    setIdentities(emptyIdentities());
    run(async () => { await api.saveInfisicalIdentities(body); setMessage('Protected identity references saved. Apply the exact policies below in Infisical, then review and retry verification.'); });
  }
  return <Card id="infisical-setup" className="min-w-0">
    <CardHeader><CardTitle>Set up Infisical and Agent Proxy</CardTitle><CardDescription>Verify one disposable application secret and a separate brokered credential. Your existing application and ProxyPilot credentials stay in place.</CardDescription></CardHeader>
    <CardContent className="space-y-5 min-w-0">
      {choice.mode === 'skip' && <p className="text-sm">Infisical is skipped. No setup can be applied. Skipping does not uninstall an existing service or remove saved resources.</p>}
      {(dirty || !revision) && <p className="text-sm">Save the reviewed platform plan before configuring secrets.</p>}
      {!matchesPlan && <p role="alert" className="text-sm">The platform choices differ from the saved secrets targets. Restore the saved choices before applying. Changing installation targets or rotating credentials is outside this guide.</p>}
      {error && <p role="alert" className="text-destructive break-words">{error}</p>}
      {message && <p role="status" className="rounded-lg border p-3 break-words">{message}</p>}
      {!data && !error && <p role="status">Loading secrets setup…</p>}
      {!state && canConfigure && <form className="space-y-4" onSubmit={saveTargets}>
        <div className="rounded-lg bg-muted p-4 space-y-2 text-sm break-words">
          <p className="font-medium">Review the test targets</p>
          <p className="break-all">Infisical: {modeLabel[choice.mode]} · {choice.url}</p>
          <p className="break-all">Agent Proxy: {modeLabel[agentMode]}{agentMode !== 'skip' && ` · ${choice.agentProxyUrl}`}</p>
          <p>Use an existing running disposable Incus VM with Python 3, no host mounts, raw settings or device passthrough. No VM is provisioned. The host private IPv4 must be reachable from this VM. The temporary test destination uses port 18086; Agent Proxy uses private HTTP port 17322.</p>
          <p>Caddy keeps public ports and certificates. Managed Infisical uses a loopback listener, persistent PostgreSQL and Redis data, and an independent lifecycle. Its public route is restricted to the source IPv4 addresses below, including the runner's source address for HTTPS verification.</p>
          <p>Saved targets are immutable in this guide. Connect preserves the external installation and verifies only the selected test resources. Agent Proxy connects only to a compatible local Docker container with a dedicated bridge and named state volume.</p>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div><Label htmlFor="if-host">Private IPv4 on the runner host</Label><Input id="if-host" value={host} onChange={e => setHost(e.target.value)} autoComplete="off" placeholder="10.20.30.40" required /></div>
          <div><Label htmlFor="if-vm">Existing disposable test VM</Label><Input id="if-vm" value={vm} onChange={e => setVm(e.target.value)} autoComplete="off" placeholder="g5-disposable" required /></div>
        </div>
        <div><Label htmlFor="if-ips">Allowed administrator and runner source IPv4 addresses</Label><Input id="if-ips" value={ips} onChange={e => setIps(e.target.value)} autoComplete="off" required /><p className="text-xs text-muted-foreground">One to eight addresses, separated by commas. Include your actual source address to reach the first-administrator screen.</p></div>
        {agentMode === 'connect' && <div><Label htmlFor="if-container">Existing Agent Proxy container on this host</Label><Input id="if-container" value={container} onChange={e => setContainer(e.target.value)} autoComplete="off" required /></div>}
        <Button className="min-h-11 w-full sm:w-auto" disabled={busy}>Save reviewed secrets targets</Button>
      </form>}
      {state && <>
        <section aria-label="Saved Infisical settings" className="rounded-lg border p-4 space-y-2 text-sm break-words">
          <p className="font-semibold break-all">{state.config.origin} · {modeLabel[state.config.mode]}</p>
          <p className="break-all">Agent Proxy: {modeLabel[state.config.agentMode]}{state.config.proxyOrigin && ` · ${state.config.proxyOrigin}`}</p>
          <p className="break-all">Test VM: {state.config.agentVm} · Private host: {state.config.testHost}</p>
          <p className="break-all">Allowed source addresses: {state.config.allowedIps.join(', ')}</p>
          <p className="break-all">{review?.images.infisical} · {review?.images.agentProxy}</p>
          <p className="break-all">Protected credential reference: {state.credentialRef} · revision {state.revision}</p>
          <p role="status">Job: {state.job?.status || 'Not submitted'} · Phase: {(state.job?.phase || 'Not started').replaceAll('_', ' ')}</p>
          {state.job?.reason && <p className="break-words">{state.job.reason}</p>}
          <p>{state.verification?.label || 'Credential flows are not verified. Saving settings or a running service does not establish successful delivery.'}</p>
          {state.verification && <p>Verified for saved revision {state.verification.revision} at {state.verification.verifiedAt}. This recorded result is not a continuous health check.</p>}
          {pending && <p>The independent runner owns this job. You can close the browser and return to its saved progress. Existing setup jobs below show redacted events.</p>}
        </section>
        {handoff && <section aria-label="Infisical administrator handoff" className="space-y-3 text-sm break-words">
          <h3 className="font-semibold">Complete the administrator handoff</h3>
          {state.config.mode === 'install' && <p>For a new server, review and apply below to prepare its private runtime and restricted Caddy route. When the job requests administrator setup, open the saved HTTPS origin from an allowed address, register the first administrator, then complete this handoff and retry.</p>}
          <ol className="list-decimal pl-5 space-y-2">
            <li>{handoff.organization} {handoff.project}</li>
            <li>Create environment <strong>{handoff.environment}</strong> and folder <strong>{handoff.path}</strong>. Reserve <strong>{handoff.secretName}</strong>{state.config.agentMode !== 'skip' && <> and <strong>{handoff.proxySecretName}</strong></>} for the disposable tests; the runner creates their values only if absent.</li>
            <li>{handoff.identityInstructions} {state.config.agentMode === 'skip' ? 'Only the workload identity is required.' : 'Use separate workload, proxy and agent identities. The agent must have no secret-value read permission.'}</li>
            <li>Save the organization, project and machine references below, then configure the exact effective policies shown in the review. They include identity IDs, so they appear after saving. Broad, inherited, group and folder grants are audited and refused.</li>
            {state.config.agentMode !== 'skip' && <li>In Infisical Agent Proxy, add exactly the proxied-service definition shown below in this test folder. It permits only the reviewed destination and header placeholder. Do not use the separate secret-rendering Infisical Agent.</li>}
          </ol>
          <p>{handoff.edition}</p>
        </section>}
        {!state.identities && <form className="space-y-4" onSubmit={saveIdentities}>
          <fieldset disabled={busy || pending || !canConfigure} className="space-y-4 min-w-0">
            <legend className="font-semibold mb-3">Save the dedicated test identities</legend>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4"><div><Label htmlFor="if-org">Organization ID</Label><Input id="if-org" value={organization} onChange={e => setOrganization(e.target.value)} required /></div><div><Label htmlFor="if-project">Project ID</Label><Input id="if-project" value={project} onChange={e => setProject(e.target.value)} required /></div></div>
            {roles.map(role => <fieldset key={role} className="rounded-lg border p-3 space-y-3 min-w-0"><legend className="px-1 font-medium capitalize">{role} identity</legend>
              {Object.entries({ identityId: 'Machine identity ID', clientId: 'Universal Auth client ID', clientSecret: 'Client secret (saved once)' }).map(([field, label]) => <div key={field}><Label htmlFor={`if-${role}-${field}`}>{label}</Label><Input id={`if-${role}-${field}`} value={identities[role][field]} type={field === 'clientSecret' ? 'password' : 'text'} autoComplete={field === 'clientSecret' ? 'new-password' : 'off'} minLength={field === 'clientSecret' ? 16 : undefined} required onChange={e => setIdentities(old => ({ ...old, [role]: { ...old[role], [field]: e.target.value } }))} /></div>)}
            </fieldset>)}
            <p className="text-sm">Credentials are encrypted on the server and cleared from this form on submission. They are never part of the platform plan or browser storage. Retry keeps the same identities and credentials.</p>
            <Button className="min-h-11 w-full sm:w-auto">Save reviewed test identities</Button>
          </fieldset>
        </form>}
        {review && <section aria-label="Review Infisical changes" className="rounded-lg border-2 border-primary p-4 space-y-4 text-sm min-w-0">
          <h3 className="font-semibold">Review Infisical changes</h3>
          <ul className="list-disc pl-5 space-y-2">{review.changes.map(change => <li key={change}>{change}</li>)}</ul>
          {state.identities && <details><summary className="min-h-11 cursor-pointer flex items-center font-medium">Exact policies and proxied service</summary><p>Configure these policies in the selected project. These are references and permission rules, not secret values.</p><pre className="whitespace-pre-wrap break-all text-xs mt-3">{JSON.stringify({ identities: state.identities, policies: handoff.policies, proxiedService: handoff.proxiedService }, null, 2)}</pre></details>}
          {!state.identities && <p>Identity handoff is incomplete. An initial managed apply can prepare the server; it will report the remaining handoff, never a verified credential flow.</p>}
          <label htmlFor="if-reviewed" className="flex items-start gap-3 min-h-11 cursor-pointer"><input id="if-reviewed" className="mt-1" type="checkbox" checked={reviewed} disabled={!canConfigure || busy || pending} onChange={e => setReviewed(e.target.checked)} /><span>I reviewed these additions, test identities, private targets and required handoffs.</span></label>
          <Button className="min-h-11 w-full sm:w-auto" disabled={!canConfigure || busy || pending || !reviewed} onClick={() => run(async () => { const result = await api.applyInfisicalSetup({ revision: state.revision, reviewToken: review.reviewToken, reviewed: true }); setMessage(`Job ${result.job.id}: ${result.job.status}. Progress and retries use the saved configuration.`); })}>Apply / retry reviewed setup</Button>
        </section>}
        {handoff && <details><summary className="min-h-11 cursor-pointer flex items-center font-medium">Proxy connection and matching backup set</summary><div className="space-y-3 text-sm break-words">
          {state.config.agentMode !== 'skip' && <><p>Proxy credentials remain on the runner host and in the separate proxy container. The isolated agent receives a short-lived agent token and a placeholder only. The existing VM must not access host storage or the proxy state volume.</p><pre className="whitespace-pre-wrap break-all text-xs">{JSON.stringify(handoff.proxyRuntime, null, 2)}</pre>{state.config.agentMode === 'connect' && <p>The runner prepares the protected environment reference during apply. Through the host console, configure only your selected test proxy with the pinned image, command, dedicated bridge, named state volume and private port shown here. It must be running with restart policy unless-stopped and logging disabled. Connect inspects it without creating, renaming or restarting external resources.</p>}</>}
          <p className="break-all">Protected local directory: {handoff.protectedDirectory}</p><p>{handoff.backup}</p><p>Use the existing configuration/file backup mechanisms and the service's consistent data backup. Restore matching data, configuration and encryption material; missing or changed keys stop retries. Do not regenerate keys or migrate existing credentials.</p>
        </div></details>}
      </>}
    </CardContent>
  </Card>;
}
