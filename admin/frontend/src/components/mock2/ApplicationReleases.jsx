import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { RefreshCw, Loader2, AlertCircle, CheckCircle2, GitBranch } from 'lucide-react';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ACTIVE_JOB_STATES, profileFromForm, profileToForm, releaseSummary, releaseBranchHead, jobPresentation } from './application-release-model.mjs';

const date = value => value ? new Date(value).toLocaleString() : 'Not recorded';
const errorMessage = error => [error.message, error.next_action].filter(Boolean).join(' ');
const short = sha => sha ? sha.slice(0, 12) : 'Not verified';
function Evidence({ title, sha, detail }) {
  return <div className="min-w-0 rounded-lg border p-3"><p className="text-xs text-muted-foreground">{title}</p><p className="mt-1 break-all font-mono text-sm">{sha ? short(sha) : 'Not verified'}</p><p className="mt-1 break-words text-xs text-muted-foreground">{detail}</p></div>;
}
function ProfileForm({ application, containerName, connectors, busy, onSave, onCancel }) {
  const id = useId();
  const [form, setForm] = useState(() => profileToForm(application?.profile));
  const set = key => event => setForm(value => ({ ...value, [key]: event.target.value }));
  const field = (key, label, placeholder, required = true) => <div className="min-w-0 space-y-1.5" key={key}><Label htmlFor={`${id}-${key}`}>{label}</Label><Input id={`${id}-${key}`} className="w-full h-11" value={form[key]} onChange={set(key)} placeholder={placeholder} required={required} disabled={busy}/></div>;
  const list = (key, label, help) => <div className="min-w-0 space-y-1.5" key={key}><Label htmlFor={`${id}-${key}`}>{label}</Label><textarea id={`${id}-${key}`} className="w-full min-h-24 rounded-md border bg-background p-3 text-sm" value={form[key]} onChange={set(key)} disabled={busy}/><p className="text-xs text-muted-foreground">{help} {key !== 'validationScripts' && 'One absolute path per line.'}</p></div>;
  return <form className="space-y-4 rounded-lg border p-4" onSubmit={event => { event.preventDefault(); onSave(profileFromForm(form, containerName)); }}>
    <div><h3 className="font-medium">{application ? 'Edit application profile' : 'Register an existing application'}</h3><p className="text-sm text-muted-foreground">Connect the application already running in {containerName}. Registration reads its repository; it does not install or restart it.</p></div>
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
      {field('name', 'Application name', 'Nodus')}{field('sourceDir', 'Source directory', '/opt/nodus')}
      {field('serviceName', 'Service unit', 'nodus.service')}{field('healthUrl', 'Health URL', 'http://127.0.0.1:3000/health')}
      <div className="space-y-1.5 min-w-0"><Label htmlFor={`${id}-connector`}>Existing Git connection</Label><select id={`${id}-connector`} className="h-11 w-full rounded-md border bg-background px-3 text-sm" required disabled={busy} value={form.connectorId} onChange={set('connectorId')}><option value="">Choose a connection</option>{connectors.map(c => <option key={c.id} value={c.id}>{c.name} · {c.provider}</option>)}</select></div>
      {field('remoteRepo', 'Repository', 'owner/repository')}{field('remoteBranch', 'Merge target branch', 'main')}
      {field('releaseRoot', 'Existing release directory', '/opt/nodus-releases', false)}
    </div>
    <details className="rounded-md border p-3"><summary className="min-h-11 cursor-pointer text-sm font-medium flex items-center">Build, validation and preserved paths</summary><div className="space-y-4 pt-3">
      {field('installScript', 'Dependency preparation npm script (optional)', 'dependencies:prepare', false)}
      <p className="text-xs text-muted-foreground">Saved for validation in a prepared release. Registration does not execute it. Use an existing package.json script name, not a shell command.</p>
      {field('buildScript', 'Build npm script', 'build', false)}
      {list('validationScripts', 'Validation npm scripts', 'One existing npm script name per line, such as test or test:integration. These checks run before release.')}
      {list('preservePaths', 'Preserved application paths', 'Keep persistent data outside a release.')}
      {list('envFiles', 'Environment files', 'References only; do not enter credentials or file contents.')}
    </div></details>
    {application && <p className="text-sm text-muted-foreground">Saving creates a new profile revision. Existing candidates must be prepared and validated against the new revision.</p>}
    <div className="flex flex-wrap gap-2"><Button className="h-11" disabled={busy}>{busy && <Loader2 className="mr-2 h-4 w-4 animate-spin"/>}{application ? 'Save profile' : 'Register application'}</Button><Button className="h-11" type="button" variant="outline" onClick={onCancel} disabled={busy}>Cancel</Button></div>
  </form>;
}

export default function ApplicationReleases({ containerName, client = api }) {
  const [applications, setApplications] = useState([]), [applicationId, setApplicationId] = useState(''), [selectedSha, setSelectedSha] = useState('');
  const [connectors, setConnectors] = useState([]), [editing, setEditing] = useState(false), [registering, setRegistering] = useState(false);
  const [jobs, setJobs] = useState([]), [jobDetail, setJobDetail] = useState(null), [selectedJob, setSelectedJob] = useState('');
  const [patch, setPatch] = useState(''), [branch, setBranch] = useState('feature/application-update'), [commitMessage, setCommitMessage] = useState(''), [expectedRemoteSha, setExpectedRemoteSha] = useState(''), [reviewBranch, setReviewBranch] = useState('review/application-update'), [remoteAbsent, setRemoteAbsent] = useState(false);
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(''), [error, setError] = useState(''), [notice, setNotice] = useState(''), [ref, setRef] = useState('HEAD');
  const scope = useRef(containerName); scope.current = containerName;
  const application = applications.find(a => String(a.id) === String(applicationId)) ?? applications[0];
  const state = releaseSummary(application, selectedSha), candidate = state.candidate;
  const mergeExpected = expectedRemoteSha || releaseBranchHead(application, candidate?.publication) || releaseBranchHead(application, state.published?.publication);
  const refresh = useCallback(async () => {
    const target = containerName;
    const result = await client.listApplications(target);
    if (scope.current === target) setApplications(result.applications ?? []);
  }, [client, containerName]);
  useEffect(() => {
    let active = true; scope.current = containerName; setLoading(true); setApplications([]); setApplicationId(''); setSelectedSha(''); setError(''); setEditing(false); setRegistering(false);
    Promise.all([refresh(), client.mock2ListGitConnectors()]).then(([, result]) => { if (active) setConnectors(Array.isArray(result) ? result : result.connectors ?? []); }).catch(e => { if (active) setError(errorMessage(e)); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; scope.current = null; };
  }, [client, containerName, refresh]);
  useEffect(() => {
    if (!application?.id) { setJobs([]); setJobDetail(null); return; }
    let active = true; setJobDetail(null);
    const poll = async () => {
      try {
        const result = await client.listApplicationReleaseJobs(application.id);
        if (!active) return; setJobs(result.jobs ?? []);
        const jobId = selectedJob || result.jobs?.[0]?.id;
        if (jobId) { const detail = await client.getApplicationReleaseJob(application.id, jobId); if (active) setJobDetail(detail); }
        else setJobDetail(null);
        await refresh();
      } catch (e) { if (active) setError(errorMessage(e)); }
    };
    void poll(); const timer = setInterval(poll, 5000);
    return () => { active = false; clearInterval(timer); };
  }, [client, application?.id, selectedJob, refresh]);
  const run = async (label, work) => {
    const target = containerName; setBusy(label); setError(''); setNotice('');
    try { await work(); if (scope.current === target) await refresh(); }
    catch (e) { if (scope.current === target) setError(errorMessage(e)); }
    finally { if (scope.current === target) setBusy(''); }
  };
  const action = name => run(name, async () => {
    const result = await client.applicationReleaseAction(application.id, name, { sha: candidate.sha, ...(['publish', 'remote-check'].includes(name) ? { branch: reviewBranch } : {}) });
    if (result.job) { setSelectedJob(result.job.id); setJobs(value => [result.job, ...value.filter(j => j.id !== result.job.id)]); setNotice(`${name[0].toUpperCase()+name.slice(1)} queued. Follow the job below for its result.`); }
    else setNotice(name === 'prepare' ? 'Candidate and profile prepared. Validation is still required before release.' : name === 'remote-check' ? 'Remote verification finished. Review the recorded publication evidence below.' : 'Publication request finished. Review remote verification separately from the live version.');
  });
  const save = profile => run('profile', async () => {
    const result = registering ? await client.registerApplication(profile) : await client.updateApplicationProfile(editing.id, profile, editing.profile.revision);
    setApplicationId(result.application.id); setEditing(false); setRegistering(false); setNotice('Application profile saved.');
  });
  const running = jobs.some(job => ACTIVE_JOB_STATES.has(job.status));
  const disabled = Boolean(busy) || running || Boolean(editing) || registering;
  const selectedDetail = jobDetail?.job ?? jobDetail;
  const jobState = jobPresentation(selectedDetail);
  return <section className="min-w-0 space-y-5 py-3" aria-label="Application releases">
    <header className="flex flex-col sm:flex-row sm:justify-between gap-3"><div className="min-w-0"><h2 className="text-lg font-semibold flex items-center gap-2"><GitBranch className="h-5 w-5 shrink-0"/>Application releases</h2><p className="text-sm text-muted-foreground">Prepare, check and release an existing application. Track source publication separately from deployment.</p></div><Button className="h-11 self-start" variant="outline" disabled={Boolean(busy) || loading} onClick={() => run('refresh', refresh)}><RefreshCw className="h-4 w-4 mr-2"/>Refresh</Button></header>
    {loading && <p role="status" className="flex items-center gap-2 text-sm"><Loader2 className="h-4 w-4 animate-spin"/>Loading applications…</p>}
    {error && <div role="alert" className="rounded-lg border border-destructive/40 p-3 text-sm break-words flex gap-2"><AlertCircle className="h-5 w-5 shrink-0"/><span>{error}</span></div>}
    {notice && <p role="status" className="rounded-lg border p-3 text-sm break-words">{notice}</p>}
    {!loading && <div className="flex flex-col sm:flex-row gap-2"><label className="flex-1 min-w-0 text-sm">Application<select aria-label="Application" className="mt-1 h-11 w-full rounded-md border bg-background px-3" value={application?.id ?? ''} onChange={e => { setApplicationId(e.target.value); setSelectedSha(''); setSelectedJob(''); setEditing(false); }} disabled={disabled}><option value="" disabled>{applications.length ? 'Choose application' : 'No registered application'}</option>{applications.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label>{applications.length === 0 && <Button className="h-11 sm:self-end" variant="outline" disabled={disabled} onClick={() => { setRegistering(true); setEditing(false); }}>Register existing app</Button>}</div>}
    {(registering || editing) && <ProfileForm key={registering ? 'new' : `${editing.id}-${editing.profile.revision}`} application={registering ? null : editing} containerName={containerName} connectors={connectors} busy={Boolean(busy)} onSave={save} onCancel={() => { setEditing(false); setRegistering(false); }}/>}
    {application && <>
      <div className="rounded-lg border p-3 flex flex-col sm:flex-row gap-3 sm:justify-between"><div className="min-w-0 text-sm"><strong className="break-words">{application.name}</strong><p className="break-all font-mono text-xs mt-1">{application.profile.sourceDir}</p><p className="text-xs text-muted-foreground mt-1">Profile revision {application.profile.revision} · {application.profile.serviceName}</p></div><Button variant="outline" className="h-11" disabled={disabled || registering} onClick={() => setEditing(application)}>Edit profile</Button></div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Evidence title="Selected candidate" sha={candidate?.sha} detail={candidate ? `Profile revision ${candidate.profileRevision}` : 'Checkpoint a source commit first.'}/>
        <Evidence title="Latest passed validation" sha={state.tested?.sha} detail={date(state.tested?.validation?.validatedAt)}/>
        <Evidence title="Last verified live version" sha={state.live?.sha} detail={date(state.live?.live?.verifiedAt)}/>
        <Evidence title="Last verified remote version" sha={state.published?.publication?.remoteSha} detail={state.published ? `${state.published.publication.branch || 'Unrecorded branch'} · ${date(state.published.publication.verifiedAt)}` : 'No remote branch has been verified.'}/>
      </div>
      <p className="text-sm break-words"><span className="text-muted-foreground">Merge target branch: </span>{application.profile.remoteBranch}<span className="text-muted-foreground"> · Remote default branch: </span>{candidate?.publication?.defaultBranch ?? state.published?.publication?.defaultBranch ?? 'Not verified'}</p>
      {application.operation && <div className="rounded-lg border p-3 space-y-2"><p className="text-sm break-words">An application operation is recorded: {application.operation.kind}, started {date(application.operation.startedAt)}.</p><p className="text-xs text-muted-foreground">Reconciliation checks whether its worker has stopped. Active work is never taken over.</p><Button className="h-11" variant="outline" disabled={Boolean(busy)} onClick={() => run('reconcile', async () => { await client.applicationReleaseAction(application.id, 'reconcile', { token: application.operation.token }); setNotice('Operation reconciliation completed. Review the current status before retrying.'); })}>Reconcile interrupted operation</Button></div>}
      <form className="flex flex-col sm:flex-row gap-2" onSubmit={e => { e.preventDefault(); void run('checkpoint', async () => { const result = await client.applicationReleaseAction(application.id, 'checkpoint', { ref }); setSelectedSha(result.candidate.sha); setNotice('Source checkpoint created. It has not been validated or deployed.'); }); }}><label className="flex-1 min-w-0 text-sm">Source commit or ref<Input className="mt-1 h-11 w-full" aria-label="Source commit or ref" value={ref} onChange={e => setRef(e.target.value)} required disabled={disabled}/></label><Button className="h-11 sm:self-end" disabled={disabled}>Checkpoint source</Button></form>
      <details className="rounded-lg border p-3"><summary className="flex min-h-11 items-center cursor-pointer text-sm font-medium">Create a commit from a patch</summary>
        <form className="space-y-3 pt-3" onSubmit={e => { e.preventDefault(); void run('commit', async () => { const result = await client.applicationReleaseAction(application.id, 'commit', { patch, branch, message: commitMessage, expectedParentSha: candidate.sha }); setSelectedSha(result.candidate?.sha ?? ''); setPatch(''); setNotice('Commit created from the expected parent. Validate this new candidate before deployment.'); }); }}>
          <p className="text-xs text-muted-foreground break-all">Expected parent: {candidate?.sha ?? 'Checkpoint a parent commit first.'}</p>
          <label className="block text-sm">Working branch<Input className="mt-1 h-11" value={branch} onChange={e => setBranch(e.target.value)} required disabled={disabled}/></label>
          <label className="block text-sm">Commit message<Input className="mt-1 h-11" value={commitMessage} maxLength={2000} onChange={e => setCommitMessage(e.target.value)} required disabled={disabled}/></label>
          <label className="block text-sm">Unified patch<textarea className="mt-1 w-full min-h-40 rounded-md border bg-background p-3 font-mono text-xs" value={patch} onChange={e => setPatch(e.target.value)} placeholder="diff --git a/file b/file" required disabled={disabled}/></label>
          <Button className="h-11" disabled={disabled || !candidate || !patch.trim() || !commitMessage.trim()}>Create commit</Button>
        </form>
      </details>
      <label className="block text-sm">Candidate<select aria-label="Candidate" className="mt-1 h-11 w-full rounded-md border bg-background px-3" value={candidate?.sha ?? ''} disabled={disabled || !candidate} onChange={e => setSelectedSha(e.target.value)}>{!candidate && <option value="">No candidates yet</option>}{(application.candidates ?? []).map(c => <option key={c.sha} value={c.sha}>{short(c.sha)} · {c.validation?.passed ? 'Validation passed' : 'Validation required'}</option>)}</select></label>
      {candidate && <div className="space-y-3">
        {!state.currentProfile && <p role="status" className="rounded-lg border p-3 text-sm">This candidate belongs to an older profile revision. Create a new checkpoint using the current profile before validation or release.</p>}
        <label className="block text-sm">Review branch for source publication<Input className="mt-1 h-11" value={reviewBranch} onChange={e => setReviewBranch(e.target.value)} disabled={disabled}/></label>
        <p className="text-xs text-muted-foreground">Publish and Verify remote use this review branch. Merge targets the configured branch after live verification.</p>
        <div className="flex flex-wrap gap-2">{[['prepare','Prepare'],['validate','Validate'],['deploy','Deploy'],['verify','Verify live'],['publish','Publish source'],['remote-check','Verify remote'],['rollback','Roll back']].map(([name,label]) => <Button key={name} className="h-11" variant={name === 'deploy' ? 'default' : 'outline'} disabled={disabled || !state.currentProfile || (['deploy','publish'].includes(name) && !state.validated)} onClick={() => action(name)}>{busy === name && <Loader2 className="mr-2 h-4 w-4 animate-spin"/>}{label}</Button>)}</div>
        {!state.validated && <p className="text-xs text-muted-foreground">Deploy and publish require passed validation for this exact commit and profile revision.</p>}
        {candidate.validation && <div className="rounded-lg border p-3 text-sm"><p className="flex gap-2 items-center">{candidate.validation.passed ? <CheckCircle2 className="w-4 h-4 shrink-0"/> : <AlertCircle className="w-4 h-4 shrink-0"/>}Validation {candidate.validation.passed ? 'passed' : 'did not pass'}</p><p className="mt-1 break-all text-xs text-muted-foreground">Evidence {candidate.validation.evidenceDigest || 'No evidence digest recorded'}</p></div>}
        <details className="rounded-lg border p-3"><summary className="flex min-h-11 items-center cursor-pointer text-sm font-medium">Merge verified candidate</summary><form className="space-y-3 pt-3" onSubmit={e => { e.preventDefault(); void run('merge', async () => { await client.applicationReleaseAction(application.id, 'merge', { sha: candidate.sha, expectedRemoteSha: remoteAbsent ? null : mergeExpected }); setNotice('Merge request finished. Review the configured release-branch evidence.'); }); }}><p className="text-xs text-muted-foreground">Requires this candidate to be the verified live version and an unchanged configured release branch. The server checks both before merging.</p><label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" checked={remoteAbsent} onChange={e => setRemoteAbsent(e.target.checked)} disabled={disabled}/>Remote release branch does not exist</label><p className="text-xs text-muted-foreground">Select only for an initial branch. The server verifies that it is absent before creating it.</p><label className="block text-sm">Expected remote release-branch SHA<Input className="mt-1 h-11 font-mono text-xs" value={mergeExpected} onChange={e => setExpectedRemoteSha(e.target.value)} placeholder="40-character SHA from release-branch verification" pattern="[a-f0-9]{40}" required={!remoteAbsent} disabled={disabled || remoteAbsent}/></label><Button className="h-11" variant="outline" disabled={disabled || !state.mergeEligible || (!remoteAbsent && !/^[a-f0-9]{40}$/.test(mergeExpected))}>Merge candidate</Button></form></details>
        {candidate.publication?.error && <p role="alert" className="text-sm break-words">Remote verification: {candidate.publication.error}</p>}
      </div>}
      <section className="space-y-2" aria-label="Release jobs"><h3 className="font-medium">Release jobs</h3>{!jobs.length ? <p className="text-sm text-muted-foreground">No release jobs recorded.</p> : <><select aria-label="Release job" className="h-11 w-full rounded-md border bg-background px-3 text-sm" value={selectedJob || jobs[0]?.id} onChange={e => setSelectedJob(e.target.value)}>{jobs.map(job => <option key={job.id} value={job.id}>{job.kind?.replace('application_', '')} · {job.status} · {job.id.slice(0, 8)}</option>)}</select>{selectedDetail && <div className="rounded-lg border p-3 space-y-2 text-sm"><p className="break-words">{selectedDetail.kind?.replace('application_', '')} — <strong>{selectedDetail.status ?? 'Unknown'}</strong></p>{jobState.outcome && <p className="break-words text-xs text-muted-foreground">Outcome: {jobState.outcome}</p>}{jobState.reason && <p role={['failed', 'refused', 'recovery_required'].includes(selectedDetail.status) && selectedDetail.outcome !== 'application_recovered' ? 'alert' : undefined} className="break-words">{jobState.reason}</p>}{jobState.recoveryRequired && <div className="rounded-md border p-3 space-y-2"><p>Select the interrupted candidate, then use Roll back to restore the recorded previous release. Do not replay the deployment.</p>{(application.candidates ?? []).some(c => c.sha === jobState.interruptedSha) ? <Button className="h-11" variant="outline" disabled={disabled} onClick={() => { setSelectedSha(jobState.interruptedSha); setNotice('Interrupted candidate selected. Use Roll back to restore the recorded previous release.'); }}>Select interrupted candidate</Button> : <p className="text-xs text-muted-foreground">The interrupted candidate is unavailable in this profile. Review the recorded job before further release work.</p>}</div>}<p className="text-xs text-muted-foreground">{ACTIVE_JOB_STATES.has(selectedDetail.status) ? 'Running in the background. This view refreshes every five seconds.' : selectedDetail.outcome === 'application_recovered' ? 'The interrupted operation was recovered. Review the verified live version above.' : selectedDetail.status === 'succeeded' ? 'Runner step succeeded. Review validation, live and remote evidence independently above.' : 'This operation needs review. Resolve its error or recovery state before retrying.'}</p>{(jobDetail.events ?? []).slice(-12).map((event,index) => <p className="text-xs break-words" key={event.id ?? index}>{event.message ?? event.type ?? event.kind}</p>)}</div>}</>}</section>
    </>}
  </section>;
}
