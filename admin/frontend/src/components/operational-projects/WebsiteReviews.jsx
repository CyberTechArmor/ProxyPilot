import { useEffect, useId, useRef, useState } from 'react';
import { Globe } from 'lucide-react';
import { operationsApi as api } from '@/lib/api';
import { Action, Field, Panel } from './shared';

const CONSENT = "Send this review agent's approved guide and public page content to the model provider";
const ACTIVE = ['queued', 'extracting', 'reviewing'];
const DEFAULT_LIMITS = { max_pages: 3, max_seconds: 120, max_tokens: 20000, max_usd: 0.05 };
const blank = () => ({ name: '', url: '', objective: '', limits: { ...DEFAULT_LIMITS } });
const reason = {
  MODEL_CONSENT_REQUIRED: 'The owner must give model consent for this saved configuration.',
  STALE_CONFIGURATION: 'The approved guide or saved configuration changed. Save the current guide assignment and check readiness again.',
  PROJECT_ARCHIVED: 'Restore this project before starting a review.',
  RUN_ACCESS_DENIED: 'Your project role cannot start reviews.',
  PROVIDER_UNAVAILABLE: 'The model provider or reviewed runtime bridge is unavailable.',
  PRICE_UNKNOWN: 'The operator must configure the provider price table.',
  EXTRACTION_UNAVAILABLE: 'The public page extraction runtime is unavailable.',
  RUN_ALREADY_ACTIVE: 'A review is already active for this agent.',
  GUIDE_TOO_LARGE: 'The approved guide exceeds the 3,500-byte review limit.',
  REVIEW_CAPACITY: 'The review runtime is at capacity. Try again after an active review finishes.',
};
const words = value => String(value || '').replaceAll('_', ' ');
function safeLink(value) {
  try { const u = new URL(value); return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password ? u.href : null; }
  catch { return null; }
}
function Url({ value }) {
  const href = safeLink(value);
  return href ? <a href={href} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center break-all underline underline-offset-4">{value}</a> : <span className="break-all">{value}</span>;
}
function Pins({ agent, title = 'Pinned approved guide' }) {
  return <details className="text-sm"><summary className="min-h-11 cursor-pointer py-3 font-medium">{title}</summary>
    <dl className="space-y-2 text-xs text-muted-foreground"><div><dt>Guide version</dt><dd className="break-all">{agent.guide_version_id}</dd></div>
      <div><dt>SHA-256</dt><dd className="break-all">{agent.guide_hash}</dd></div>
      <div><dt>Agent revision</dt><dd>{agent.revision ?? agent.agent_revision}</dd></div></dl>
  </details>;
}
function Limits({ limits }) {
  return <p className="text-sm break-words">At most {limits.max_pages} pages · {limits.max_seconds} seconds · {limits.max_tokens.toLocaleString()} tokens · ${Number(limits.max_usd).toFixed(3)}</p>;
}

// This surface uses the central session/CSRF/CAS client. Saving a configuration,
// granting consent and starting a run are three separate, explicit requests.
export function WebsiteReviews({ base, project, onChanged = async () => {} }) {
  const [agents, setAgents] = useState([]), [runs, setRuns] = useState([]);
  const [loading, setLoading] = useState(true), [loaded, setLoaded] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(''), [message, setMessage] = useState('');
  const [lost, setLost] = useState(false), [form, setForm] = useState(null), [editing, setEditing] = useState(null), [stale, setStale] = useState(false);
  const [run, setRun] = useState(null), [runLoading, setRunLoading] = useState(false), [tick, setTick] = useState(0);
  const request = useRef(null), generation = useRef(0), resultGeneration = useRef(0), locked = useRef(false), formHeading = useRef(null), runHeading = useRef(null);
  const editable = ['owner', 'editor'].includes(project.own_role) && !project.archived_at;
  const canRun = ['owner', 'operator', 'editor', 'reviewer'].includes(project.own_role) && !project.archived_at;
  const guide = project.current_version;
  function report(e) {
    if ([401, 403, 404].includes(e.status)) {
      setLost(true); setAgents([]); setRuns([]); setRun(null); setForm(null); setEditing(null);
      request.current?.abort();
      setError('Website reviews are unavailable or your access has changed. Refresh the project to check access.');
    } else setError(`${e.message}${e.code ? ` (${e.code})` : ''}${e.status === 412 ? ' Your entered values are retained. Reload the saved configuration before retrying.' : ''}`);
  }
  async function load(signal, gen = generation.current) {
    const [a, r] = await Promise.all([api.get(`${base}/website-review-agents`, signal), api.get(`${base}/website-review-runs`, signal)]);
    if (gen !== generation.current || signal?.aborted) return;
    setAgents(a.agents); setRuns(r.runs); setLoaded(true);
  }
  useEffect(() => {
    const controller = new AbortController(), gen = ++generation.current;
    request.current?.abort(); request.current = controller;
    setLost(false); setLoading(true); setLoaded(false); setBusy(false); setError(''); setAgents([]); setRuns([]); setRun(null); resultGeneration.current++;
    // An ownership/role change must not retain private local configuration.
    setForm(null); setEditing(null); setStale(false);
    load(controller.signal, gen).catch(e => { if (!controller.signal.aborted && gen === generation.current) report(e); })
      .finally(() => { if (!controller.signal.aborted && gen === generation.current) setLoading(false); });
    return () => { controller.abort(); generation.current++; };
  }, [base, project.own_role, project.archived_at]);
  useEffect(() => { if (form) formHeading.current?.focus(); }, [!!form, editing?.id]);
  useEffect(() => { if (run) runHeading.current?.focus(); }, [run?.id]);
  useEffect(() => {
    if (!run || !ACTIVE.includes(run.state) || lost) return;
    const controller = new AbortController(), gen = generation.current, resultGen = resultGeneration.current;
    const timer = setInterval(async () => {
      try {
        const next = (await api.get(`${base}/website-review-runs/${run.id}`, controller.signal)).run;
        if (controller.signal.aborted || gen !== generation.current || resultGen !== resultGeneration.current) return;
        setRun(next); setRuns(old => old.map(r => r.id === next.id ? next : r));
        if (!ACTIVE.includes(next.state)) setTick(t => t + 1);
      } catch (e) { if (!controller.signal.aborted && gen === generation.current) report(e); }
    }, 2000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [base, run?.id, run?.state, lost]);
  async function perform(fn, success) {
    if (locked.current || lost) return;
    locked.current = true; setBusy(true); setError(''); setMessage('');
    const gen = generation.current, signal = request.current?.signal;
    try {
      await fn(signal);
      if (gen !== generation.current || signal?.aborted) return;
      await load(signal, gen); setTick(t => t + 1); setMessage(success);
      await onChanged();
    } catch (e) {
      if (gen === generation.current && !signal?.aborted) { if (e.status === 412) setStale(true); report(e); }
    } finally { locked.current = false; if (gen === generation.current) setBusy(false); }
  }
  async function refreshReviews() {
    if (locked.current) return;
    locked.current = true;
    const controller = new AbortController(), gen = ++generation.current;
    request.current?.abort(); request.current = controller;
    setBusy(true); setLoading(true); setError(''); setMessage('');
    try {
      await load(controller.signal, gen);
      if (gen !== generation.current || controller.signal.aborted) return;
      setLost(false); setTick(t => t + 1); setMessage('Website reviews refreshed.');
      await onChanged();
    } catch (e) { if (gen === generation.current && !controller.signal.aborted) report(e); }
    finally { locked.current = false; if (gen === generation.current) { setBusy(false); setLoading(false); } }
  }
  function edit(a) { setEditing(a); setForm({ name: a.name, url: a.url, objective: a.objective, limits: { ...a.limits } }); setStale(false); setError(''); }
  function showRun(value) { resultGeneration.current++; setRun(value); }
  async function openRun(id) {
    if (locked.current || lost) return;
    const gen = generation.current, resultGen = ++resultGeneration.current, signal = request.current?.signal;
    setRun(null); setRunLoading(true); setError('');
    try { const data = await api.get(`${base}/website-review-runs/${id}`, signal); if (gen === generation.current && resultGen === resultGeneration.current && !signal?.aborted) setRun(data.run); }
    catch (e) { if (gen === generation.current && resultGen === resultGeneration.current && !signal?.aborted) report(e); }
    finally { if (gen === generation.current && resultGen === resultGeneration.current) setRunLoading(false); }
  }
  return <Panel title="Public website reviews" icon={Globe} description="Review public page content against this project's approved guide.">
    <div className="flex flex-col sm:flex-row sm:justify-end gap-2"><Action variant="outline" disabled={busy || (loading && !lost)} onClick={refreshReviews}>Refresh reviews</Action></div>
    <div className="rounded-md border bg-muted/30 p-3 space-y-2 text-sm">
      <p className="font-medium">Supported pages: public HTML or plain text over HTTP(S), on standard ports.</p>
      <p className="text-muted-foreground">Pages are read without browser JavaScript, login or website writes. Robots restrictions, paywalls and blocked pages produce an explicit outcome.</p>
      <p className="text-muted-foreground">Save stores settings only. The owner gives model consent separately; each review starts with an explicit Start action.</p>
    </div>
    {error && <p role="alert" className="text-destructive break-words">{error}</p>}
    <p role="status" aria-live="polite" className="text-sm">{busy ? 'Working…' : loading ? 'Loading website reviews…' : message}</p>
    {!lost && !loading && loaded && <>
      {!guide && <p className="rounded-md border p-3 text-sm">No current approved guide. Save and approve a guide in Guide before creating or starting a review agent.</p>}
      {project.archived_at && <p className="text-sm">This project is archived. Existing reviews remain available to inspect.</p>}
      {!agents.length && <p className="text-sm text-muted-foreground">No website review agents yet.</p>}
      <ul className="space-y-4">{agents.map(a => <li key={a.id}><ReviewAgent base={base} project={project} agent={a} busy={busy} canRun={canRun} tick={tick} report={report} perform={perform} onEdit={() => edit(a)} onStarted={showRun}/></li>)}</ul>
      {editable && !form && <Action disabled={busy || !guide} onClick={() => { setEditing(null); setForm(blank()); setStale(false); }}>New review agent</Action>}
      {form && editable && <form className="rounded-md border p-4 space-y-4" onSubmit={e => {
        e.preventDefault(); if (!guide || stale) return;
        perform(async signal => {
          await api.write(editing ? `${base}/website-review-agents/${editing.id}` : `${base}/website-review-agents`, {
            ...form, guide_version_id: guide.id, guide_hash: guide.content_hash,
          }, editing?.revision, editing ? 'PATCH' : 'POST', signal);
          if (!signal?.aborted) { setForm(null); setEditing(null); setStale(false); }
        }, 'Review agent saved. No run started; model consent is not given.');
      }}>
        <h3 ref={formHeading} tabIndex={-1} className="font-semibold focus-visible:outline-none">{editing ? 'Edit review agent' : 'New review agent'}</h3>
        <Field label="Review agent name" required maxLength={200} value={form.name} onChange={e => setForm({ ...form, name: e.target.value })}/>
        <Field label="Public website URL" type="url" required maxLength={2048} placeholder="https://example.org/" value={form.url} onChange={e => setForm({ ...form, url: e.target.value })}/>
        <Field label="Review objective" textarea rows={3} required maxLength={1000} value={form.objective} onChange={e => setForm({ ...form, objective: e.target.value })}/>
        <p className="text-sm break-words">Saving pins {guide ? `current approved guide v${guide.version_number}` : 'no guide'} and resets any earlier model consent.</p>
        {guide && <Pins agent={{ guide_version_id: guide.id, guide_hash: guide.content_hash, revision: editing?.revision ?? 1 }}/>}
        <fieldset className="space-y-3"><legend className="text-sm font-medium">Review limits</legend><div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {[[ 'max_pages', 'Maximum pages', 1, 3, 1 ], [ 'max_seconds', 'Maximum seconds', 10, 180, 1 ], [ 'max_tokens', 'Maximum tokens', 1000, 20000, 1 ], [ 'max_usd', 'Maximum spend (USD)', 0.001, 0.10, 0.001 ]].map(([key, label, min, max, step]) => <Field key={key} label={label} type="number" required min={min} max={max} step={step} value={form.limits[key]} onChange={e => setForm({ ...form, limits: { ...form.limits, [key]: e.target.value === '' ? '' : Number(e.target.value) } })}/>)}</div></fieldset>
        <p className="text-xs text-muted-foreground">Project limits can reduce these ceilings. The server verifies the destination and effective limits.</p>
        <div className="flex flex-wrap gap-2"><Action type="submit" disabled={busy || !guide || stale}>Save review agent</Action><Action type="button" variant="outline" disabled={busy} onClick={() => { setForm(null); setEditing(null); setStale(false); }}>Cancel editing</Action>
          {editing && stale && <Action type="button" variant="outline" disabled={busy} onClick={() => perform(async signal => edit((await api.get(`${base}/website-review-agents/${editing.id}`, signal)).agent), 'Saved configuration reloaded. Local edits replaced.')}>Reload saved configuration</Action>}</div>
      </form>}
      <div className="border-t pt-4 space-y-3"><h3 className="font-semibold">Review history</h3>
        {!runs.length ? <p className="text-sm text-muted-foreground">No website reviews started yet.</p> : <ul className="space-y-2">{runs.map(r => <li key={r.id} className="rounded-md border p-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 min-w-0"><div className="min-w-0"><p className="font-medium text-sm break-words">{agents.find(a => a.id === r.agent_id)?.name || 'Website review'} · {words(r.state)}</p><p className="text-xs text-muted-foreground break-words">{r.created_at}</p></div><Action variant="outline" disabled={busy} onClick={() => openRun(r.id)}>View review <span className="sr-only">{r.id}</span></Action></li>)}</ul>}
      </div>
      {runLoading && <p role="status">Loading review evidence…</p>}
      {run && <RunDetail run={run} headingRef={runHeading} canRun={canRun} busy={busy} onCancel={() => {
        resultGeneration.current++;
        perform(async signal => { const next = (await api.write(`${base}/website-review-runs/${run.id}/cancel`, {}, null, 'POST', signal)).run; if (!signal?.aborted) showRun(next); }, 'Cancellation requested. Inspect the recorded outcome and spending status.');
      }}/>}
    </>}
  </Panel>;
}

function ReviewAgent({ base, project, agent, busy, canRun, tick, report, perform, onEdit, onStarted }) {
  const [ready, setReady] = useState(null), [checking, setChecking] = useState(true), [checkError, setCheckError] = useState(''), [reviewed, setReviewed] = useState(false);
  const hint = useId(), alive = useRef(true);
  const current = project.current_version?.id === agent.guide_version_id && project.current_version?.content_hash === agent.guide_hash;
  const editable = ['owner', 'editor'].includes(project.own_role) && !project.archived_at, owner = project.own_role === 'owner' && !project.archived_at;
  useEffect(() => { setReviewed(false); }, [agent.revision, project.own_role]);
  useEffect(() => {
    const controller = new AbortController(); alive.current = true; setReady(null); setChecking(true); setCheckError('');
    api.get(`${base}/website-review-agents/${agent.id}/readiness`, controller.signal).then(r => { if (!controller.signal.aborted) setReady(r.readiness); })
      .catch(e => { if (!controller.signal.aborted) { setCheckError(e.message); if ([401, 403, 404].includes(e.status)) report(e); } })
      .finally(() => { if (!controller.signal.aborted) setChecking(false); });
    return () => { alive.current = false; controller.abort(); };
  }, [base, agent.id, agent.revision, project.revision, project.current_version?.id, project.current_version?.content_hash, tick]);
  const pinsMatch = r => r?.contract_version === 'website-review.v1' && r.pins?.agent_revision === agent.revision && r.pins?.guide_version_id === agent.guide_version_id && r.pins?.guide_hash === agent.guide_hash;
  const supported = r => r?.capabilities?.strategy === 'http_extract_v1' && r.capabilities.read_only === true && r.capabilities.javascript_rendering === false && r.capabilities.credential_binding_required === false;
  const startable = canRun && ready?.can_start === true && pinsMatch(ready) && supported(ready) && current;
  return <article className="rounded-md border p-4 space-y-3 min-w-0">
    <div><h3 className="font-semibold break-words">{agent.name}</h3><p className="text-sm"><Url value={agent.url}/></p><p className="text-sm whitespace-pre-wrap break-words">{agent.objective}</p></div>
    <Pins agent={agent}/><p className="text-sm">{current ? `Current approved guide v${project.current_version.version_number}` : 'Pinned guide is no longer current. Edit and save to pin the current approved guide.'}</p>
    <Limits limits={ready?.capabilities?.limits || agent.limits}/>
    <div className="rounded-md bg-muted/30 p-3 space-y-2 text-sm" aria-live="polite">
      <p className="font-medium">{checking ? 'Checking readiness…' : startable ? 'Ready to start' : 'Cannot start yet'}</p>
      {checkError && <p role="alert" className="break-words">Readiness could not be checked: {checkError}. Use Refresh reviews to retry.</p>}
      {ready && (!pinsMatch(ready) || !supported(ready)) && <p>The returned runtime contract or configuration pins do not match this saved agent. Refresh before starting.</p>}
      <ul className="space-y-2">{ready?.checks?.filter(c => c.state !== 'ready').map(c => <li key={c.kind} className="break-words">{reason[c.code] || `${words(c.kind)}: ${words(c.code)}. ${words(c.next_action)}.`}<span className="block text-xs text-muted-foreground">{c.code}</span></li>)}</ul>
      {ready?.capabilities?.model && <p className="text-muted-foreground">Model: {ready.capabilities.model} · at most {ready.capabilities.max_model_calls} call per review.</p>}
    </div>
    <div className="border-t pt-3 space-y-2"><p className="text-sm font-medium">Model consent: {agent.model_consent ? 'given for this saved configuration' : 'not given'}</p><p id={hint} className="text-sm text-muted-foreground">The model receives the pinned approved guide, objective and extracted public page content. Only the project owner can change consent.</p>
      {owner && (agent.model_consent ? <Action variant="outline" disabled={busy} aria-describedby={hint} onClick={() => perform(signal => api.write(`${base}/website-review-agents/${agent.id}/model-consent`, { enabled: false }, agent.revision, 'PUT', signal), 'Model consent withdrawn.')}>Withdraw model consent</Action> : <>
        <label className="flex min-h-11 items-start gap-3 py-2 text-sm"><input className="mt-1 shrink-0" type="checkbox" checked={reviewed} disabled={busy} onChange={e => setReviewed(e.target.checked)}/><span>I reviewed: {CONSENT}.</span></label>
        <Action disabled={busy || !reviewed} aria-describedby={hint} onClick={() => perform(signal => api.write(`${base}/website-review-agents/${agent.id}/model-consent`, { enabled: true, reviewed_statement: CONSENT }, agent.revision, 'PUT', signal), 'Model consent given. No run started.')}>Give model consent</Action>
      </>)}
    </div>
    <div className="flex flex-wrap gap-2">{editable && <Action variant="outline" disabled={busy} onClick={onEdit}>Edit review agent</Action>}{canRun && <Action disabled={busy || checking || !startable} onClick={() => perform(async signal => {
      // This click rechecks readiness; the server repeats checks and compares
      // these exact pins transactionally before it starts any work.
      const fresh = (await api.get(`${base}/website-review-agents/${agent.id}/readiness`, signal)).readiness;
      if (!alive.current || signal?.aborted) return;
      setReady(fresh);
      if (!fresh.can_start || !pinsMatch(fresh) || !supported(fresh)) throw new Error('Readiness changed. Inspect the current checks and explicitly start again.');
      const result = await api.write(`${base}/website-review-runs`, { agent_id: agent.id, agent_revision: agent.revision, guide_version_id: agent.guide_version_id, guide_hash: agent.guide_hash }, null, 'POST', signal);
      if (!signal?.aborted) onStarted(result.run);
    }, 'Website review started.')}>Start website review</Action>}</div>
  </article>;
}

function RunDetail({ run, headingRef, canRun, busy, onCancel }) {
  const result = run.result, review = result?.review;
  return <section className="rounded-md border p-4 space-y-4 min-w-0" aria-label="Website review result">
    <h3 ref={headingRef} tabIndex={-1} className="font-semibold focus-visible:outline-none">Review result · {words(run.state)}</h3>
    <p className="text-sm"><Url value={run.pins.url}/></p><p className="text-sm whitespace-pre-wrap break-words">Objective: {run.pins.objective}</p><Pins agent={run.pins} title="Immutable run guide and agent pins"/><Limits limits={run.pins.limits}/>
    {ACTIVE.includes(run.state) && <div className="space-y-2"><p role="status" className="text-sm">{run.state === 'reviewing' ? 'The model review is in progress.' : 'The public page review is in progress.'}</p>{canRun && <Action variant="outline" disabled={busy} onClick={onCancel}>Cancel website review</Action>}<p className="text-sm text-muted-foreground">Cancellation stops further requests and review publication. An accepted model call may still settle against its reserved budget.</p></div>}
    {result?.code && <div className="rounded-md border p-3 space-y-2"><p className="font-medium break-words">{result.message}</p><p className="text-xs text-muted-foreground">{result.code}</p>
      <p className="text-sm">{result.model_spend === 'may_be_reserved' ? 'Model spending may remain reserved; an accepted call may still settle. This result does not confirm zero cost.' : result.model_spend === 'not_requested' ? 'The model was not requested for this run.' : 'Inspect the recorded provider settlement for spending status.'}</p></div>}
    {review && <div className="space-y-3"><h4 className="font-semibold">Cited model review</h4><p className="whitespace-pre-wrap break-words text-sm">{review.summary}</p>
      {review.findings.length > 0 && <div><h5 className="text-sm font-medium">Findings</h5><ul className="list-disc pl-5 text-sm space-y-2">{review.findings.map((f, i) => <li key={i} className="break-words">{f}</li>)}</ul></div>}
      {review.limitations.length > 0 && <div><h5 className="text-sm font-medium">Limitations</h5><ul className="list-disc pl-5 text-sm space-y-2">{review.limitations.map((f, i) => <li key={i} className="break-words">{f}</li>)}</ul></div>}
      <ul className="text-sm space-y-2">{review.citations.map(c => <li key={c.source_id}>Source {c.source_id}: <Url value={c.url}/></li>)}</ul>
      <dl className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm"><div><dt className="text-muted-foreground">Model</dt><dd>{result.model}</dd></div><div><dt className="text-muted-foreground">Settled cost</dt><dd>${Number(result.settled_usd).toFixed(6)}</dd></div><div><dt className="text-muted-foreground">Input tokens</dt><dd>{result.usage.prompt_tokens}</dd></div><div><dt className="text-muted-foreground">Output tokens</dt><dd>{result.usage.completion_tokens}</dd></div><div><dt className="text-muted-foreground">Price table revision</dt><dd className="break-all">{result.price_table_revision}</dd></div></dl>
      <p className="text-xs text-muted-foreground break-words">{result.scope}</p>
      <details><summary className="cursor-pointer min-h-11 py-3 text-sm font-medium">Provider receipt</summary><pre className="whitespace-pre-wrap text-xs [overflow-wrap:anywhere] rounded-md bg-muted p-3">{JSON.stringify(result.receipt, null, 2)}</pre></details>
    </div>}
    <details><summary className="cursor-pointer min-h-11 py-3 text-sm font-medium">Sources and extraction evidence ({run.sources.length})</summary><ul className="space-y-3">{run.sources.map(s => <li key={s.id} className="border rounded-md p-3 space-y-2 min-w-0"><h4 className="font-medium text-sm break-words">Source {s.id} · {s.title || 'Untitled page'}</h4><p className="text-sm"><Url value={s.url}/></p><p className="whitespace-pre-wrap text-sm [overflow-wrap:anywhere]">{s.excerpt}</p><p className="text-xs text-muted-foreground break-all">Content SHA-256: {s.content_hash}</p><p className="text-xs text-muted-foreground break-all">Excerpt SHA-256: {s.excerpt_hash}</p><p className="text-xs text-muted-foreground">Extracted: {s.extracted_at}</p></li>)}</ul>{!run.sources.length && <p className="text-sm text-muted-foreground">No source evidence recorded.</p>}</details>
    <details><summary className="cursor-pointer min-h-11 py-3 text-sm font-medium">Review activity ({run.activity.length})</summary><ol className="space-y-2 text-sm">{run.activity.map((a, i) => <li key={i} className="break-words"><p className="font-medium">{words(a.kind)}{a.code && ` · ${a.code}`}</p><time className="text-xs text-muted-foreground">{a.at}</time>{a.url && <p className="break-all">{a.url}</p>}</li>)}</ol>{!run.activity.length && <p className="text-sm text-muted-foreground">No activity recorded yet.</p>}</details>
    <p className="text-xs text-muted-foreground break-all">Run {run.id} · Task SHA-256 {run.pins.task_hash}</p>
  </section>;
}
