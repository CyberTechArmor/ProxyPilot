import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { operationsApi as api } from '@/lib/api';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Action, Panel } from './shared';
import { ACTION_TEXT, ACTIVE_STATES, DECK_TEXT, STALE_TEXT, STATE_TEXT, resultLabel, shortId, when } from './agent-run-text';
import { ApprovalFields, Badge, FrameDialog, HelpBanner, RunDeck, StateBadge } from './RunDeck';
import { EMPTY_VIEW, acceptFrame, feedOf, firstStepFinishedAt, panelFor } from './run-deck-logic';

// A6 supervision UI. Everything shown comes from durable server state except the
// live browser frames (pixels only, held in this page's memory and gone on
// refresh). Every control either acts or says why it cannot. The run detail is
// laid out by RunDeck.jsx.

const visible = () => typeof document === 'undefined' || document.visibilityState !== 'hidden';
// Runs `load` now, then every `interval` ms while enabled and the page is
// visible, and again when the window regains focus.
function usePolling(load, interval, enabled = true) {
  const saved = useRef(load);
  useEffect(() => { saved.current = load; }, [load]);
  useEffect(() => {
    if (!enabled) return undefined;
    let stopped = false;
    const tick = () => { if (!stopped && visible()) saved.current(); };
    const timer = interval ? setInterval(tick, interval) : null;
    window.addEventListener('focus', tick);
    return () => { stopped = true; if (timer) clearInterval(timer); window.removeEventListener('focus', tick); };
  }, [interval, enabled]);
}

// The one approval gesture: the session's sudo elevation (the api client opens
// the sudo prompt on the server's 401) plus at least the first 12 characters of
// the digest shown. A closed approval never keeps a usable Approve control.
export function ApprovalDialog({ approval, onClose, onApproved }) {
  const [typed, setTyped] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [closed, setClosed] = useState('');
  const inputId = useId(), hintId = useId();
  const serverClosed = !approval ? 'This approval is no longer listed for you.' : !approval.open
    ? `This approval is closed (${approval.state}${approval.stale_reason ? `: ${STALE_TEXT[approval.stale_reason] ?? approval.stale_reason}` : ''}). Nothing was approved.` : '';
  const closedText = closed || serverClosed;
  const value = typed.replace(/\s+/g, '').toLowerCase();
  const matches = !!approval && value.length >= 12 && /^[0-9a-f]+$/.test(value) && approval.digest.startsWith(value);
  const hint = !value ? 'Type at least the first 12 characters of the digest shown above.'
    : !approval?.digest.startsWith(value) || !/^[0-9a-f]+$/.test(value) ? 'That does not match the digest shown. Compare it character by character.'
      : value.length < 12 ? `Keep typing: ${value.length} of at least 12 characters match.` : `Matches the digest shown (${value.length} characters).`;
  async function submit(event) {
    event.preventDefault();
    if (!matches || closedText || busy) return;
    setBusy(true); setError('');
    try {
      await api.write(`/agent-approvals/${approval.id}`, { digest: approval.digest, confirmation: typed });
      onApproved();
    } catch (e) {
      const closing = ['APPROVAL_STALE', 'APPROVAL_NOT_PENDING', 'APPROVAL_UNKNOWN', 'APPROVAL_DIGEST_MISMATCH',
        'RUN_ACCESS_DENIED', 'EXECUTION_UNAVAILABLE'].includes(e.code) || [403, 404].includes(e.status);
      const reason = e.stale_reason ? ` Reason: ${STALE_TEXT[e.stale_reason] ?? e.stale_reason}.` : '';
      if (closing) setClosed(`${e.message}${reason}`);
      else setError(e.status === 401 ? 'Sudo was not confirmed, so nothing was approved.' : e.message);
    } finally { setBusy(false); }
  }
  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
    <DialogContent className="max-w-full h-full rounded-none sm:max-w-2xl sm:h-auto sm:max-h-[90vh] sm:rounded-lg flex flex-col">
      <DialogHeader>
        <DialogTitle>Approve: {approval ? ACTION_TEXT[approval.action] ?? approval.action : 'approval'}</DialogTitle>
        <DialogDescription>The agent waits for a person before it submits the bound credential. Check the fields, then type the digest to approve. Your sudo confirmation is asked next if it has lapsed.</DialogDescription>
      </DialogHeader>
      <form onSubmit={submit} className="space-y-4 min-w-0">
        {approval && <ApprovalFields approval={approval}/>}
        {closedText ? <p role="alert" className="rounded-md border border-destructive p-3 text-destructive break-words">{closedText}</p> : <>
          <div className="space-y-2">
            <label htmlFor={inputId} className="block text-sm font-medium">Approval digest, at least the first 12 characters</label>
            <input id={inputId} aria-describedby={hintId} value={typed} onChange={e => setTyped(e.target.value)}
              autoComplete="off" autoCapitalize="none" spellCheck={false} maxLength={200}
              className="flex min-h-11 w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"/>
            <p id={hintId} aria-live="polite" className={`text-sm ${value && !matches && approval?.digest.startsWith(value) ? '' : value && !matches ? 'text-destructive' : ''}`}>{hint}</p>
          </div>
          {error && <p role="alert" className="text-destructive break-words">{error}</p>}
        </>}
        <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2">
          <Action type="button" variant="outline" onClick={onClose}>{closedText ? 'Close' : 'Cancel'}</Action>
          {!closedText && <Action type="submit" disabled={!matches || busy} aria-describedby={hintId}>{busy ? 'Approving…' : 'Approve submit'}</Action>}
        </div>
      </form>
    </DialogContent>
  </Dialog>;
}

function announcementFor(prev, next) {
  if (!next) return '';
  if (!prev) return `Run ${STATE_TEXT[next.run.state] ?? next.run.state}.`;
  if (next.result && !prev.result) return `Run finished: ${resultLabel(next.result.result_class)}.`;
  const open = next.approvals.find(a => a.open), was = prev.approvals.find(a => a.open);
  if (open && !was) return `Approval needed: ${ACTION_TEXT[open.action] ?? open.action}.`;
  if (next.steps.length > prev.steps.length) { const s = next.steps.at(-1); return `Step ${s.ordinal}: ${ACTION_TEXT[s.action] ?? s.action}.`; }
  if (next.run.state !== prev.run.state) return `Run ${STATE_TEXT[next.run.state] ?? next.run.state}.`;
  return '';
}

export function AgentRunDetail({ base, runId, onBack }) {
  const [data, setData] = useState(null), [refusal, setRefusal] = useState(''), [announce, setAnnounce] = useState('');
  const [view, setView] = useState(EMPTY_VIEW), [viewNote, setViewNote] = useState(''), [tab, setTab] = useState('result');
  const [watch, setWatch] = useState(true), [approving, setApproving] = useState(null), [enlarged, setEnlarged] = useState(null);
  const [busy, setBusy] = useState(false), [message, setMessage] = useState(''), [error, setError] = useState('');
  const [params, setParams] = useSearchParams();
  const previous = useRef(null), alive = useRef(true), viewing = useRef(false), steps = useRef([]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const load = useCallback(async () => {
    try {
      const next = await api.get(`${base}/agent-runs/${runId}`);
      if (!alive.current) return;
      const text = announcementFor(previous.current, next);
      if (text) setAnnounce(text);
      // Details open on the result when the run ends.
      if (previous.current && ACTIVE_STATES.includes(previous.current.run.state) && !ACTIVE_STATES.includes(next.run.state)) setTab('result');
      previous.current = next;
      steps.current = next.steps;
      setData(next); setRefusal('');
    } catch (e) {
      if (!alive.current) return;
      if ([401, 403, 404].includes(e.status)) { setData(null); setView(EMPTY_VIEW); setApproving(null); setRefusal(e.message); }
      else setError(e.message);
    }
  }, [base, runId]);
  useEffect(() => { previous.current = null; steps.current = []; setData(null); setView(EMPTY_VIEW); setTab('result'); load(); }, [load]);
  const active = !!data && ACTIVE_STATES.includes(data.run.state);
  usePolling(load, active ? 1500 : 0, !!data);
  // No frame is asked for before step 1 has finished: the browser before its
  // first page is a blank frame.
  const viewEnabled = !!data?.controls.view.enabled && watch && firstStepFinishedAt(data.steps) !== null;
  const loadFrame = useCallback(async () => {
    if (viewing.current) return;
    viewing.current = true;
    try {
      const { frame } = await api.get(`${base}/agent-runs/${runId}/view`);
      if (!alive.current) return;
      setViewNote('');
      setView(old => acceptFrame(old, frame, steps.current));
    } catch (e) {
      if (!alive.current) return;
      if (e.code === 'VIEW_BUSY') return;
      setViewNote(e.message);
      if ([401, 403, 404].includes(e.status)) load();
    } finally { viewing.current = false; }
  }, [base, runId, load]);
  useEffect(() => { if (viewEnabled) loadFrame(); }, [viewEnabled, loadFrame]);
  usePolling(loadFrame, 2000, viewEnabled);
  const feed = useMemo(() => data ? feedOf(data) : [], [data]);
  async function stop() {
    if (busy) return;
    setBusy(true); setError(''); setMessage('');
    try {
      const result = await api.write(`${base}/agent-runs/${runId}/stop`, {});
      setMessage(result.stopping ? 'Stopping: the run is fenced; the verified teardown receipt follows.' : 'The run is stopped.');
      await load();
    } catch (e) { setError(e.message); if ([403, 404].includes(e.status)) load(); }
    finally { setBusy(false); }
  }
  // A phone shows one panel at a time; the choice rides in the URL (&panel=).
  const panel = panelFor(params.get('panel'), active);
  const choosePanel = key => setParams(old => { const next = new URLSearchParams(old); next.set('panel', key); return next; }, { replace: true });
  const dialogApproval = approving ? data?.approvals.find(a => a.id === approving) ?? null : null;
  if (!data) return <div className="space-y-3">
    <Action variant="outline" onClick={onBack}>{DECK_TEXT.back}</Action>
    <p role={refusal ? 'alert' : 'status'} className={refusal ? 'text-destructive break-words' : ''}>{refusal ? `This run is not available to you: ${refusal}` : error || 'Loading the run…'}</p>
  </div>;
  return <>
    <RunDeck data={data} feed={feed} view={view} active={active} panel={panel} onPanel={choosePanel} tab={tab} onTab={setTab}
      watch={watch} onWatch={setWatch} viewNote={viewNote} busy={busy} message={message} error={error} announce={announce}
      onBack={onBack} onStop={stop} onRefresh={() => load()} onReview={setApproving} onFrame={setEnlarged}/>
    {approving && <ApprovalDialog approval={dialogApproval} onClose={() => setApproving(null)}
      onApproved={() => { setApproving(null); setMessage('Approved. The agent may now submit the bound credential.'); load(); }}/>}
    {enlarged && <FrameDialog frame={enlarged} onClose={() => setEnlarged(null)}/>}
  </>;
}

export function AgentRunsPanel({ base, project, runId, onOpenRun, onCloseRun }) {
  const [list, setList] = useState(null), [refusal, setRefusal] = useState(''), [error, setError] = useState('');
  const [busy, setBusy] = useState(false), [message, setMessage] = useState(''), [older, setOlder] = useState([]);
  const [activeLink, setActiveLink] = useState(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const load = useCallback(async () => {
    try {
      const next = await api.get(`${base}/agent-runs`);
      if (alive.current) { setList(next); setRefusal(''); }
    } catch (e) {
      if (!alive.current) return;
      if ([401, 403, 404].includes(e.status)) { setList(null); setRefusal(e.message); } else setError(e.message);
    }
  }, [base]);
  useEffect(() => { if (!runId) load(); }, [load, runId, project.revision]);
  const anyActive = !!list?.runs.some(r => ACTIVE_STATES.includes(r.state));
  usePolling(load, anyActive ? 4000 : 20000, !runId);
  if (runId) return <AgentRunDetail base={base} runId={runId} onBack={() => { onCloseRun(); load(); }}/>;
  async function start(profile) {
    if (busy) return;
    setBusy(true); setError(''); setMessage(''); setActiveLink(null);
    try {
      const result = await api.write(`${base}/agent-runs`, { profile_id: profile.profile_id,
        credential_binding_id: profile.binding?.binding_id ?? null });
      onOpenRun(result.run.id);
    } catch (e) {
      setError(e.message);
      if (e.code === 'RUN_ALREADY_ACTIVE' && e.active_run_id) setActiveLink(e.active_run_id);
      await load();
    } finally { if (alive.current) setBusy(false); }
  }
  async function loadOlder() {
    const before = (older.length ? older : list.runs).length ? (older.at(-1) ?? list.runs.at(-1)).started_at : null;
    try { const page = await api.get(`${base}/agent-runs?before=${encodeURIComponent(before)}`); setOlder(o => [...o, ...page.runs]); }
    catch (e) { setError(e.message); }
  }
  return <Panel title="Agent runs">
    <p className="text-sm">One supervised run of the synthetic sign-in workflow at a time per profile. Starting, stopping and approving are human actions; the agent submits the bound credential only after a person approves.</p>
    {error && <p role="alert" className="text-destructive break-words">{error}</p>}
    {activeLink && <Action variant="outline" onClick={() => onOpenRun(activeLink)}>Open the active run</Action>}
    <p role="status" aria-live="polite" className="text-sm">{busy ? 'Working…' : message}</p>
    {refusal ? <p role="alert" className="break-words">Agent runs are not available to you: {refusal}</p> : !list ? <p role="status">Loading agent runs…</p> : <>
      {!list.execution.available && <p className="rounded-md border border-amber-500/70 p-3 text-sm break-words" role="note">{list.execution.message} Runs already recorded stay readable.</p>}
      <section className="space-y-3" aria-labelledby="agent-profiles-heading">
        <h3 id="agent-profiles-heading" className="font-semibold">Start a run</h3>
        {!list.profiles.length && <p className="text-sm">No agent profiles. Create one in Agents.</p>}
        <ul className="space-y-3">{list.profiles.map(profile => <ProfileStart key={profile.profile_id} profile={profile} busy={busy}
          onStart={() => start(profile)} onOpenRun={onOpenRun}/>)}</ul>
      </section>
      <section className="space-y-3" aria-labelledby="agent-runs-heading">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
          <h3 id="agent-runs-heading" className="font-semibold">Runs</h3>
          <Action variant="outline" onClick={() => load()}>Refresh runs</Action>
        </div>
        {!list.runs.length && <p className="text-sm">No agent runs yet.</p>}
        <ul className="space-y-3">{[...list.runs, ...older].map(r => <RunRow key={r.id} run={r} onOpen={() => onOpenRun(r.id)}/>)}</ul>
        {list.next_before && !older.length && <Action variant="outline" onClick={loadOlder}>Load older runs</Action>}
      </section>
    </>}
  </Panel>;
}

function ProfileStart({ profile, busy, onStart, onOpenRun }) {
  const reasons = useId();
  return <li className="rounded-md border p-3 space-y-2 min-w-0">
    <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
      <div className="min-w-0 space-y-1">
        <h4 className="font-medium break-words">{profile.display_name}</h4>
        <p className="text-sm break-all">Credential: {profile.binding ? `${profile.binding.username} · binding ${shortId(profile.binding.binding_id)} · revision ${profile.binding.revision}` : 'no active binding'}</p>
        <p className="text-sm">Model provider consent: {profile.model_guide_consent ? 'given' : 'not given'}</p>
      </div>
      <Action disabled={!profile.ready || busy} aria-describedby={reasons} onClick={onStart}>Start run</Action>
    </div>
    {profile.ready ? <p id={reasons} className="text-sm text-muted-foreground">Ready. Start pins this profile, its guide, the site and the binding revision for the run.</p>
      : <div id={reasons} className="text-sm space-y-1"><p className="font-medium">Start is not available:</p><ul className="list-disc pl-5 space-y-1">{profile.reasons.map(r => <li key={r} className="break-words">{r}</li>)}</ul></div>}
    {profile.active_run_id && <Action variant="outline" onClick={() => onOpenRun(profile.active_run_id)}>Open the active run</Action>}
  </li>;
}

function RunRow({ run, onOpen }) {
  return <li className="rounded-md border p-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 min-w-0">
    <div className="min-w-0 space-y-1">
      <p className="font-medium break-words flex flex-wrap items-center gap-2"><span>{run.profile_name ?? 'Profile'} · run {shortId(run.id)}</span><StateBadge run={run}/>
        {run.awaiting_approval && <Badge tone="warn">Awaiting approval</Badge>}{run.needs_human && <Badge tone="warn">Needs a person</Badge>}</p>
      <p className="text-sm text-muted-foreground flex flex-wrap gap-x-4 gap-y-1"><span>Started by {run.started_by.username ?? run.started_by.id}</span><span>{when(run.started_at)}</span>
        {run.result_class && <span>Result: {resultLabel(run.result_class)}</span>}</p>
    </div>
    <Action variant="outline" onClick={onOpen} aria-label={`Open run ${shortId(run.id)}`}>Open run</Action>
  </li>;
}

// The caller's pending approvals and open help requests across operations.
export function AgentInbox() {
  const [data, setData] = useState(null), [error, setError] = useState(''), [hidden, setHidden] = useState(false);
  const [approving, setApproving] = useState(null), [message, setMessage] = useState('');
  const load = useCallback(async () => {
    try { setData(await api.get('/agent-approvals')); setError(''); }
    catch (e) { if (e.status === 404) setHidden(true); else setError(e.message); }
  }, []);
  useEffect(() => { load(); }, [load]);
  usePolling(load, approving ? 3000 : 10000, !hidden);
  if (hidden) return null;
  const link = r => `/operational-projects/${r.project_id}?section=${encodeURIComponent('Agent runs')}&run=${r.run_id ?? r.id}`;
  const current = approving ? data?.approvals.find(a => a.id === approving) ?? null : null;
  return <Panel title="Agent inbox">
    <p className="text-sm">Approvals waiting for you and runs that need a person, across the operations where you may run agents.</p>
    {error && <p role="alert" className="text-destructive break-words">{error}</p>}
    <p role="status" aria-live="polite" className="text-sm">{message}</p>
    {!data ? <p role="status">Loading the inbox…</p> : <>
      {data.execution && !data.execution.available && <p className="text-sm break-words" role="note">{data.execution.message}</p>}
      <section className="space-y-3" aria-labelledby="inbox-approvals"><h3 id="inbox-approvals" className="font-semibold">Pending approvals ({data.approvals.length})</h3>
        {!data.approvals.length && <p className="text-sm">No approval is waiting for you.</p>}
        <ul className="space-y-3">{data.approvals.map(a => <li key={a.id} className="rounded-md border p-3 space-y-3 min-w-0">
          <p className="font-medium break-words">{a.project_name} · {a.profile_name ?? 'profile'} · {ACTION_TEXT[a.action] ?? a.action}</p>
          <p className="text-sm text-muted-foreground">Requested {when(a.requested_at)}</p>
          <ApprovalFields approval={a}/>
          <div className="flex flex-wrap gap-2"><Action onClick={() => setApproving(a.id)}>Review and approve</Action>
            <Link className="inline-flex min-h-11 items-center underline" to={link(a)}>Open the run</Link></div>
        </li>)}</ul></section>
      <section className="space-y-3" aria-labelledby="inbox-help"><h3 id="inbox-help" className="font-semibold">Help requests ({data.help_requests.length})</h3>
        {!data.help_requests.length && <p className="text-sm">No run needs a person.</p>}
        <ul className="space-y-3">{data.help_requests.map(r => <li key={r.id} className="rounded-md border p-3 space-y-2 min-w-0">
          <p className="font-medium break-words">{r.project_name} · {r.profile_name ?? 'profile'} · run {shortId(r.id)} · {resultLabel(r.result_class)}</p>
          <p className="text-sm text-muted-foreground">Ended {when(r.updated_at)} · started by {r.started_by.username ?? r.started_by.id}</p>
          <HelpBanner help={r.help}/>
          <Link className="inline-flex min-h-11 items-center underline" to={link({ project_id: r.project_id, run_id: r.id })}>Open the run</Link>
        </li>)}</ul></section>
    </>}
    {approving && <ApprovalDialog approval={current} onClose={() => setApproving(null)}
      onApproved={() => { setApproving(null); setMessage('Approved. The agent may now submit the bound credential.'); load(); }}/>}
  </Panel>;
}
