import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { operationsApi as api } from '@/lib/api';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Action, Panel } from './shared';
import { ACTION_TEXT, ACTIVE_STATES, CLAIM_TEXT, HELP_DECISION, RESULT_TEXT, RULE_TEXT, STALE_TEXT, STATE_TEXT,
  eventText, grouped, resultLabel, shortId, when } from './agent-run-text';

// A6 supervision UI. Everything shown comes from durable server state except the
// live browser frames (pixels only, held in this page's memory and gone on
// refresh). Every control either acts or says why it cannot.

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

function Badge({ children, tone = 'neutral' }) {
  const tones = { neutral: 'border-border', warn: 'border-amber-500/70 text-amber-700 dark:text-amber-300',
    good: 'border-emerald-600/70 text-emerald-700 dark:text-emerald-300', bad: 'border-destructive/70 text-destructive' };
  return <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${tones[tone]}`}>{children}</span>;
}
const stateTone = s => s === 'completed' ? 'good' : ['blocked', 'failed'].includes(s) ? 'bad' : s === 'cancelled' ? 'neutral' : 'warn';
function StateBadge({ run }) {
  return <Badge tone={stateTone(run.state)}>{STATE_TEXT[run.state] ?? run.state}</Badge>;
}

function HelpBanner({ help }) {
  if (!help) return null;
  return <div role="note" className="rounded-md border-2 border-amber-500/70 bg-amber-500/10 p-3 space-y-1">
    <p className="font-semibold">A person needs to decide: {resultLabel(help.result_class)}</p>
    <p className="text-sm break-words">{HELP_DECISION[help.result_class] ?? RESULT_TEXT[help.result_class]?.[1]}</p>
    {help.uncertain_steps > 0 && help.result_class !== 'uncertain_step' && <p className="text-sm break-words">{help.uncertain_steps === 1 ? 'One step' : `${help.uncertain_steps} steps`} may or may not have taken effect; see the activity.</p>}
  </div>;
}

export function ApprovalFields({ approval }) {
  const rows = [['Action', ACTION_TEXT[approval.action] ?? approval.action, false], ['Run', approval.run_id, true],
    ['Attempt', approval.attempt_id, true], ['Fence', approval.fence, false], ['Binding', approval.binding_id ?? 'None', true],
    ['Binding revision', approval.binding_revision ?? 'Not active', false], ['Guide hash', approval.guide_hash, true],
    ['Policy digest', approval.policy_digest, true], ['Origin', approval.origin, false]];
  return <dl className="grid grid-cols-1 sm:grid-cols-3 gap-x-4 gap-y-1 text-sm min-w-0">
    {rows.map(([label, value, mono]) => <div key={label} className="contents"><dt className="text-muted-foreground">{label}</dt>
      <dd className={`sm:col-span-2 mb-2 sm:mb-0 break-all ${mono ? 'font-mono text-xs sm:text-sm' : ''}`}>{String(value)}</dd></div>)}
    <dt className="text-muted-foreground">Approval digest</dt>
    <dd className="sm:col-span-2 break-words font-mono text-sm font-semibold" data-testid="approval-digest">{grouped(approval.digest)}</dd>
  </dl>;
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

function FrameDialog({ frame, onClose }) {
  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
    <DialogContent className="max-w-full h-full rounded-none sm:max-w-5xl sm:h-auto sm:max-h-[90vh] sm:rounded-lg flex flex-col">
      <DialogHeader><DialogTitle>Browser frame</DialogTitle>
        <DialogDescription>Captured {when(frame.captured_at)} at step {frame.action_count ?? 0}. Live frames are not stored.</DialogDescription></DialogHeader>
      <div className="overflow-auto min-h-0"><img src={`data:image/png;base64,${frame.png_base64}`} width={frame.width} height={frame.height}
        className="max-w-full h-auto rounded border" alt={`Browser frame at step ${frame.action_count ?? 0}`}/></div>
      <Action variant="outline" onClick={onClose}>Close</Action>
    </DialogContent>
  </Dialog>;
}

function Claims({ claims }) {
  const entries = Object.entries(claims ?? {});
  if (!entries.length) return null;
  return <ul className="flex flex-wrap gap-2" aria-label="Typed claims">{entries.map(([key, value]) =>
    <li key={key}><Badge tone={value === true || value === 'signed_in' ? 'good' : value === false ? 'neutral' : 'warn'}>
      {CLAIM_TEXT[key] ?? key}: {typeof value === 'boolean' ? (value ? 'yes' : 'no') : String(value).replaceAll('_', ' ')}</Badge></li>)}</ul>;
}

function feedOf(data, frames) {
  const items = [];
  const calls = new Map(data.model_calls.map(c => [c.call_id, c]));
  const stepCalls = new Set(data.steps.map(s => s.model_call_id).filter(Boolean));
  items.push({ key: 'start', at: data.run.started_at, order: 0, kind: 'system',
    title: `Run started by ${data.run.started_by.username ?? data.run.started_by.id}`,
    body: `Profile ${data.run.profile_name ?? data.run.profile_id} · guide v${data.run.guide_version_number ?? '?'}` });
  for (const e of data.events) {
    const text = eventText(e.kind);
    if (text) items.push({ key: `e${e.id}`, at: e.created_at, order: 1, kind: 'system', title: text });
  }
  for (const c of data.model_calls) if (!stepCalls.has(c.call_id)) items.push({ key: c.call_id, at: c.created_at, order: 2,
    kind: 'model', title: c.state === 'chosen' ? `The model chose ${ACTION_TEXT[c.choice] ?? c.choice}` : c.state === 'reserved'
      ? 'Asking the model to choose the next step' : `Model call ${c.state}${c.refusal_code ? `: ${c.refusal_code}` : ''}`,
    body: `Allowed: ${c.allowed.map(a => ACTION_TEXT[a] ?? a).join(', ')}` });
  for (const s of data.steps) {
    const call = s.model_call_id ? calls.get(s.model_call_id) : null;
    items.push({ key: `s${s.ordinal}`, at: s.created_at, order: 3, kind: s.decided_by, step: s, call });
  }
  for (const a of data.approvals) {
    items.push({ key: `a${a.id}`, at: a.requested_at, order: 2, kind: 'approval',
      title: `Approval requested: ${ACTION_TEXT[a.action] ?? a.action}`, body: `Digest ${grouped(a.digest.slice(0, 16))}…` });
    if (a.decided_at) items.push({ key: `d${a.id}`, at: a.decided_at, order: 4, kind: 'person',
      title: `Approved by ${a.decided_by?.username ?? a.decided_by?.id}` });
    if (['stale', 'expired'].includes(a.state)) items.push({ key: `c${a.id}`, at: a.closed_at, order: 4, kind: 'system',
      title: a.state === 'expired' ? 'The approval expired unanswered.' : `The approval became stale: ${STALE_TEXT[a.stale_reason] ?? a.stale_reason}.` });
  }
  for (const f of frames) items.push({ key: `f${f.captured_at}`, at: f.captured_at, order: 5, kind: 'frame', frame: f });
  if (data.result) items.push({ key: 'result', at: data.result.created_at, order: 9, kind: 'result' });
  return items.sort((a, b) => String(a.at).localeCompare(String(b.at)) || a.order - b.order);
}

const who = { rule: 'Rule', model: 'Model', person: 'Person', approval: 'Approval', system: 'System', frame: 'Browser', result: 'Result' };
function FeedItem({ item, data, onFrame }) {
  const head = <p className="text-xs text-muted-foreground flex flex-wrap gap-x-3"><span className="font-semibold uppercase tracking-wide">{who[item.kind] ?? item.kind}</span><time dateTime={item.at}>{when(item.at)}</time></p>;
  if (item.step) {
    const { step: s, call } = item;
    return <li className="rounded-md border p-3 space-y-2 min-w-0" data-testid={`step-${s.ordinal}`}>{head}
      <p className="font-medium break-words">Step {s.ordinal}: {ACTION_TEXT[s.action] ?? s.action} <Badge tone={s.state === 'done' ? 'good' : s.state === 'reserved' ? 'warn' : 'bad'}>{s.state === 'reserved' ? 'in progress' : s.state}</Badge></p>
      <p className="text-sm break-words">{s.decided_by === 'rule' ? `Decided by ${RULE_TEXT[s.rule] ?? s.rule} (rule: ${s.rule}).`
        : `Decided by the model, choosing from ${(call?.allowed ?? []).map(a => ACTION_TEXT[a] ?? a).join(', ')}${call ? ` · ${(call.prompt_tokens ?? 0) + (call.completion_tokens ?? 0)} tokens · $${call.settled_usd ?? '?'}` : ''}.`}</p>
      {s.approval_id && <p className="text-sm">Performed under a person's approval.</p>}
      <Claims claims={s.claims}/>
      {s.error_code && <p className="text-sm text-destructive break-all">Error: {s.error_code}</p>}
    </li>;
  }
  if (item.kind === 'frame') {
    const f = item.frame;
    return <li className="rounded-md border p-3 space-y-2 min-w-0">{head}
      <button type="button" onClick={() => onFrame(f)} className="block w-full sm:w-72 max-w-full min-h-11 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <img src={`data:image/png;base64,${f.png_base64}`} alt={`Browser frame at step ${f.action_count ?? 0}; open it larger`} className="w-full h-auto rounded border"/></button>
      <p className="text-xs text-muted-foreground">Live frame at step {f.action_count ?? 0}. Not stored: a refresh shows only the durable record.</p>
    </li>;
  }
  if (item.kind === 'result') {
    const r = data.result;
    return <li className="rounded-md border-2 p-3 space-y-2 min-w-0" data-testid="run-result">{head}
      <p className="font-semibold break-words">Result: {resultLabel(r.result_class)} <Badge tone={stateTone(r.final_state)}>{STATE_TEXT[r.final_state]}</Badge></p>
      <p className="text-sm break-words">{RESULT_TEXT[r.result_class]?.[1]}</p>
      <ul className="text-sm grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1">
        <li>Verified account: {r.verified_account ? 'yes' : 'no'}</li><li>Steps: {r.steps} ({r.rule_steps} by rule, {r.model_steps} by the model)</li>
        <li>Model calls: {r.model_calls}</li><li>Uncertain steps: {r.uncertain_steps}</li>
        <li>Submit outcome: {r.submit_outcome?.replaceAll('_', ' ') ?? 'no submit'}</li><li>Sign-out: {r.logout ?? 'not recorded'}</li>
        <li className="break-all">Binding: {r.binding_id ? `${r.binding_id} · revision ${r.binding_revision}` : 'none'}</li>
        <li className="break-all">Teardown receipt: {r.receipt.verified ? `verified · key ${r.receipt.key_id ? shortId(r.receipt.key_id) : 'unknown'}` : 'none (no worker was started)'}</li>
      </ul>
    </li>;
  }
  return <li className="rounded-md border p-3 space-y-1 min-w-0">{head}<p className="font-medium break-words">{item.title}</p>{item.body && <p className="text-sm break-words">{item.body}</p>}</li>;
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
  const [live, setLive] = useState(null), [frames, setFrames] = useState([]), [viewNote, setViewNote] = useState('');
  const [watch, setWatch] = useState(true), [approving, setApproving] = useState(null), [enlarged, setEnlarged] = useState(null);
  const [busy, setBusy] = useState(false), [message, setMessage] = useState(''), [error, setError] = useState('');
  const previous = useRef(null), alive = useRef(true), viewing = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const load = useCallback(async () => {
    try {
      const next = await api.get(`${base}/agent-runs/${runId}`);
      if (!alive.current) return;
      const text = announcementFor(previous.current, next);
      if (text) setAnnounce(text);
      previous.current = next;
      setData(next); setRefusal('');
    } catch (e) {
      if (!alive.current) return;
      if ([401, 403, 404].includes(e.status)) { setData(null); setLive(null); setFrames([]); setApproving(null); setRefusal(e.message); }
      else setError(e.message);
    }
  }, [base, runId]);
  useEffect(() => { previous.current = null; setData(null); setLive(null); setFrames([]); load(); }, [load]);
  const active = !!data && ACTIVE_STATES.includes(data.run.state);
  usePolling(load, active ? 1500 : 0, !!data);
  const viewEnabled = !!data?.controls.view.enabled && watch;
  const loadFrame = useCallback(async () => {
    if (viewing.current) return;
    viewing.current = true;
    try {
      const { frame } = await api.get(`${base}/agent-runs/${runId}/view`);
      if (!alive.current) return;
      setLive(frame); setViewNote('');
      setFrames(old => old.length && old.at(-1).action_count === frame.action_count ? old : [...old, frame].slice(-12));
    } catch (e) {
      if (!alive.current) return;
      if (e.code === 'VIEW_BUSY') return;
      setViewNote(e.message);
      if ([401, 403, 404].includes(e.status)) load();
    } finally { viewing.current = false; }
  }, [base, runId, load]);
  useEffect(() => { if (viewEnabled) loadFrame(); }, [viewEnabled, loadFrame]);
  usePolling(loadFrame, 2000, viewEnabled);
  const feed = useMemo(() => data ? feedOf(data, frames) : [], [data, frames]);
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
  const openApproval = data?.approvals.find(a => a.open) ?? null;
  const dialogApproval = approving ? data?.approvals.find(a => a.id === approving) ?? null : null;
  const stopHint = useId(), viewHint = useId();
  if (!data) return <div className="space-y-3">
    <Action variant="outline" onClick={onBack}>Back to agent runs</Action>
    <p role={refusal ? 'alert' : 'status'} className={refusal ? 'text-destructive break-words' : ''}>{refusal ? `This run is not available to you: ${refusal}` : error || 'Loading the run…'}</p>
  </div>;
  const { run, controls } = data;
  return <div className="space-y-4 min-w-0">
    <p className="sr-only" role="status" aria-live="polite">{announce}</p>
    <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
      <Action variant="outline" onClick={onBack}>Back to agent runs</Action>
      <div className="flex flex-wrap gap-2">
        <Action variant="outline" disabled={busy} onClick={() => load()}>Refresh run</Action>
        <Action variant={controls.stop.enabled ? 'destructive' : 'outline'} disabled={!controls.stop.enabled || busy} aria-describedby={stopHint} onClick={stop}>Stop run</Action>
      </div>
    </div>
    <p id={stopHint} className="text-sm text-muted-foreground">{!controls.stop.enabled ? `Stop is not available: ${controls.stop.reason}`
      : controls.stop.retry ? 'The run is fenced and stopping. Stop again retries collecting the verified teardown receipt; the run never resumes.'
        : 'Stop fences the run at once; nothing more happens, and the verified teardown receipt is collected.'}</p>
    <header className="space-y-1 min-w-0">
      <h3 className="text-lg font-semibold break-words">{run.profile_name ?? 'Agent run'} · run {shortId(run.id)} <StateBadge run={run}/>{run.awaiting_approval && <> <Badge tone="warn">Awaiting approval</Badge></>}</h3>
      <p className="text-sm text-muted-foreground flex flex-wrap gap-x-4 gap-y-1"><span>Started by {run.started_by.username ?? run.started_by.id}</span><span>{when(run.started_at)}</span>
        <span>Steps {run.action_count}{run.max_actions ? ` of at most ${run.max_actions}` : ''}</span><span>Guide v{run.guide_version_number ?? '?'}</span><span className="break-all">Binding {run.credential_binding_id ? `${shortId(run.credential_binding_id)} · rev ${run.credential_binding_revision}` : 'none'}</span></p>
    </header>
    {error && <p role="alert" className="text-destructive break-words">{error}</p>}
    <p role="status" aria-live="polite" className="text-sm">{busy ? 'Working…' : message}</p>
    <HelpBanner help={run.help}/>
    {openApproval && <section className="rounded-lg border-2 border-amber-500/70 p-4 space-y-3 min-w-0" aria-label="Approval needed">
      <h4 className="font-semibold">Approval needed: {ACTION_TEXT[openApproval.action] ?? openApproval.action}</h4>
      <p className="text-sm">The agent is waiting. Nothing is submitted until a person with run access approves with sudo and the digest; the approval closes if the run, binding, guide or policy changes.</p>
      <ApprovalFields approval={openApproval}/>
      <Action onClick={() => setApproving(openApproval.id)}>Review and approve</Action>
    </section>}
    <div className="grid grid-cols-1 lg:grid-cols-5 gap-4 min-w-0">
      <section className="lg:col-span-2 lg:order-2 lg:sticky lg:top-4 lg:self-start space-y-2 min-w-0" aria-labelledby={`${runId}-browser`}>
        <h4 id={`${runId}-browser`} className="font-semibold">Browser</h4>
        {controls.view.enabled ? <label className="flex min-h-11 items-center gap-3"><input type="checkbox" checked={watch} onChange={e => setWatch(e.target.checked)}/><span>Watch the browser live (view only)</span></label>
          : <p id={viewHint} className="text-sm">Live view is not available: {controls.view.reason}</p>}
        {live && (controls.view.enabled || frames.length) ? <button type="button" onClick={() => setEnlarged(live)} className="block w-full min-h-11 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <img src={`data:image/png;base64,${live.png_base64}`} alt={`Live browser frame at step ${live.action_count ?? 0}; open it larger`} className="w-full h-auto rounded border"/></button>
          : <div className="aspect-[16/10] w-full rounded border border-dashed flex items-center justify-center p-4 text-sm text-muted-foreground text-center">{controls.view.enabled ? (watch ? 'Waiting for the first frame…' : 'Watching is paused.') : 'No live browser.'}</div>}
        {live && <p className="text-xs text-muted-foreground">{controls.view.enabled ? 'Live' : 'Last'} frame · captured {when(live.captured_at)} · at step {live.action_count ?? 0}. Pixels only; frames are not stored.</p>}
        {viewNote && controls.view.enabled && <p className="text-sm break-words" role="status">{viewNote}</p>}
      </section>
      <section className="lg:col-span-3 lg:order-1 space-y-2 min-w-0" aria-labelledby={`${runId}-activity`}>
        <h4 id={`${runId}-activity`} className="font-semibold">Activity</h4>
        <p className="text-sm text-muted-foreground">Typed progress from the durable record: each step, who decided it (a rule or the model), the claims kept and any error. Page text never reaches this view.</p>
        <ol className="space-y-2" aria-label="Run activity">{feed.map(item => <FeedItem key={item.key} item={item} data={data} onFrame={setEnlarged}/>)}</ol>
      </section>
    </div>
    <details className="rounded-md border p-3"><summary className="cursor-pointer min-h-11 py-2 font-medium">Model calls ({data.model_calls.length})</summary>
      <ul className="space-y-2 pt-2">{data.model_calls.map(c => <li key={c.call_id} className="text-sm break-words border-t pt-2">
        <span className="font-medium">{c.state}</span>{c.choice && ` · chose ${ACTION_TEXT[c.choice] ?? c.choice}`}{c.refusal_code && ` · refused ${c.refusal_code}`} · allowed {c.allowed.join(', ')} · {c.prompt_tokens ?? 0}+{c.completion_tokens ?? 0} tokens · ${c.settled_usd ?? '—'}{c.replayed ? ' · replayed' : ''}</li>)}
      {!data.model_calls.length && <li className="text-sm">No model call: every step was decided by a rule.</li>}</ul></details>
    <details className="rounded-md border p-3"><summary className="cursor-pointer min-h-11 py-2 font-medium">Approvals ({data.approvals.length})</summary>
      <ul className="space-y-3 pt-2">{data.approvals.map(a => <li key={a.id} className="space-y-2 border-t pt-2">
        <p className="text-sm font-medium">{ACTION_TEXT[a.action] ?? a.action} · {a.state}{a.stale_reason ? ` (${STALE_TEXT[a.stale_reason] ?? a.stale_reason})` : ''}{a.decided_by ? ` · approved by ${a.decided_by.username ?? a.decided_by.id}` : ''}</p>
        <ApprovalFields approval={a}/></li>)}
      {!data.approvals.length && <li className="text-sm">No approval was requested.</li>}</ul></details>
    <details className="rounded-md border p-3"><summary className="cursor-pointer min-h-11 py-2 font-medium">Pins</summary>
      <dl className="grid grid-cols-1 sm:grid-cols-3 gap-x-4 gap-y-1 text-sm pt-2">
        {[['Run', run.id], ['Fence', run.fence], ['Policy digest', run.policy_digest], ['Guide hash', run.guide_hash], ['Deadline', run.deadline_at ?? 'none']].map(([k, v]) =>
          <div key={k} className="contents"><dt className="text-muted-foreground">{k}</dt><dd className="sm:col-span-2 mb-2 sm:mb-0 break-all font-mono text-xs sm:text-sm">{String(v)}</dd></div>)}
      </dl></details>
    {approving && <ApprovalDialog approval={dialogApproval} onClose={() => setApproving(null)}
      onApproved={() => { setApproving(null); setMessage('Approved. The agent may now submit the bound credential.'); load(); }}/>}
    {enlarged && <FrameDialog frame={enlarged} onClose={() => setEnlarged(null)}/>}
  </div>;
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
  if (runId) return <Panel title="Agent run"><AgentRunDetail base={base} runId={runId} onBack={() => { onCloseRun(); load(); }}/></Panel>;
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
