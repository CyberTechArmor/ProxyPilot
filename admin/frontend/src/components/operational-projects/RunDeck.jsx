import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { AlertTriangle, AppWindow, Hand, Info, Maximize2, MessageSquare, RotateCcw, Square } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import MobilePanelBar from '@/components/mock2/MobilePanelBar';
import { Action } from './shared';
import { ACTION_TEXT, CLAIM_TEXT, DECK_TEXT, HELP_DECISION, KIND_TEXT, LIVE_TEXT, ORIGIN_TEXT, RECONCILE_TEXT, RESULT_TEXT,
  RULE_TEXT, STALE_TEXT, STATE_TEXT, SUMMARY_TEXT, clock, critiqueText, grouped, resultLabel, shortId, when,
  whenShort } from './agent-run-text';
import { callSummary, firstStepFinishedAt } from './run-deck-logic';
import { LiveBrowser } from './LiveBrowser';

// The run deck: one run's detail laid out like Flightdeck. On a laptop the
// Browser pane and the Activity column share a fixed-height deck under the run
// bar and the approval banner, with Details below; on a phone one panel shows
// at a time behind the shared MobilePanelBar. A layout over the run detail and
// the view frames the server already returns: frames stay in this page's memory.
// A7 adds the live video (and takeover) in the Browser pane, the decisions a
// person records after a run, resume, the origin of a run, and the Review tab.

export function Badge({ children, tone = 'neutral' }) {
  const tones = { neutral: 'border-border', warn: 'border-amber-500/70 text-amber-700 dark:text-amber-300',
    good: 'border-emerald-600/70 text-emerald-700 dark:text-emerald-300', bad: 'border-destructive/70 text-destructive' };
  return <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${tones[tone]}`}>{children}</span>;
}
export const stateTone = s => s === 'completed' ? 'good' : ['blocked', 'failed'].includes(s) ? 'bad' : s === 'cancelled' ? 'neutral' : 'warn';
export function StateBadge({ run }) {
  return <Badge tone={stateTone(run.state)}>{STATE_TEXT[run.state] ?? run.state}</Badge>;
}

export function HelpBanner({ help }) {
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

export function FrameDialog({ frame, onClose }) {
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

const KIND_TONE = {
  system: 'bg-muted text-muted-foreground', rule: 'bg-blue-500/15 text-blue-700 dark:text-blue-300',
  model: 'bg-violet-500/15 text-violet-700 dark:text-violet-300', approval: 'bg-amber-500/15 text-amber-800 dark:text-amber-300',
  person: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
};
const RESULT_TONE = { good: KIND_TONE.person, bad: 'bg-red-500/15 text-red-700 dark:text-red-300', warn: KIND_TONE.approval,
  neutral: KIND_TONE.system };
function KindChip({ kind, tone }) {
  return <span className={`rounded px-1.5 py-0.5 text-[11px] font-bold uppercase tracking-wider ${tone ?? KIND_TONE[kind] ?? KIND_TONE.system}`}>{KIND_TEXT[kind] ?? kind}</span>;
}

function Thumb({ frame, onFrame }) {
  return <button type="button" onClick={() => onFrame(frame)}
    className="shrink-0 self-start w-[72px] lg:w-[88px] min-h-11 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
    <img src={`data:image/png;base64,${frame.png_base64}`} alt={DECK_TEXT.thumbAlt(frame.action_count ?? 0)}
      className="block w-full aspect-[16/10] object-cover rounded border bg-zinc-950"/></button>;
}

function FeedItem({ item, data, thumb, onFrame }) {
  const head = (tone, extra = null) => <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
    <KindChip kind={item.kind} tone={tone}/><time dateTime={item.at}>{clock(item.at)}</time>{extra}</p>;
  const box = 'flex gap-3 rounded-md border bg-background p-2.5 min-w-0';
  if (item.step) {
    const { step: s, call } = item;
    return <li className={box} data-testid={`step-${s.ordinal}`}>
      <div className="min-w-0 flex-1 space-y-0.5">{head(undefined, <Badge tone={s.state === 'done' ? 'good' : s.state === 'reserved' ? 'warn' : 'bad'}>{s.state === 'reserved' ? 'in progress' : s.state}</Badge>)}
        <p className="text-sm font-medium break-words">Step {s.ordinal}: {ACTION_TEXT[s.action] ?? s.action}</p>
        <p className="text-[13px] text-muted-foreground break-words">{s.decided_by === 'rule' ? `Decided by ${RULE_TEXT[s.rule] ?? s.rule} (rule: ${s.rule}).`
          : `Decided by the model, choosing from ${callSummary(call)}.`}</p>
        {s.approval_id && <p className="text-sm">Performed under a person's approval.</p>}
        <Claims claims={s.claims}/>
        {s.error_code && <p className="text-sm text-destructive break-all">Error: {s.error_code}</p>}
      </div>
      {thumb && <Thumb frame={thumb} onFrame={onFrame}/>}
    </li>;
  }
  if (item.kind === 'result') {
    const r = data.result;
    return <li className={`${box} border-2`} data-testid="feed-result">
      <div className="min-w-0 flex-1 space-y-0.5">{head(RESULT_TONE[stateTone(r.final_state)], <Badge tone={stateTone(r.final_state)}>{STATE_TEXT[r.final_state]}</Badge>)}
        <p className="text-sm font-semibold break-words">Result: {resultLabel(r.result_class)}</p>
        <p className="text-[13px] text-muted-foreground break-words">{RESULT_TEXT[r.result_class]?.[1]}</p>
      </div>
    </li>;
  }
  return <li className={`${box} ${item.open ? 'border-2 border-amber-500/70' : ''}`}>
    <div className="min-w-0 flex-1 space-y-0.5">{head()}
      <p className="text-sm font-medium break-words">{item.title}</p>
      {item.body && <p className="text-[13px] text-muted-foreground break-words">{item.body}</p>}
    </div>
  </li>;
}

// The full run summary, unchanged from the as-built detail; it lives in Details.
function ResultSummary({ result: r }) {
  return <div className="rounded-md border-2 p-3 space-y-2 min-w-0" data-testid="run-result">
    <p className="font-semibold break-words">Result: {resultLabel(r.result_class)} <Badge tone={stateTone(r.final_state)}>{STATE_TEXT[r.final_state]}</Badge></p>
    <p className="text-sm break-words">{RESULT_TEXT[r.result_class]?.[1]}</p>
    <ul className="text-sm grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1">
      <li>Verified account: {r.verified_account ? 'yes' : 'no'}</li><li>Steps: {r.steps} ({r.rule_steps} by rule, {r.model_steps} by the model)</li>
      <li>Model calls: {r.model_calls}</li><li>Uncertain steps: {r.uncertain_steps}</li>
      <li>Submit outcome: {r.submit_outcome?.replaceAll('_', ' ') ?? 'no submit'}</li><li>Sign-out: {r.logout ?? 'not recorded'}</li>
      <li className="break-all">Binding: {r.binding_id ? `${r.binding_id} · revision ${r.binding_revision}` : 'none'}</li>
      <li className="break-all">Teardown receipt: {r.receipt.verified ? `verified · key ${r.receipt.key_id ? shortId(r.receipt.key_id) : 'unknown'}` : 'none (no worker was started)'}</li>
    </ul>
  </div>;
}

function runMeta(run) {
  return DECK_TEXT.runMeta({ by: run.started_by.username ?? run.started_by.id, at: whenShort(run.started_at), step: run.action_count,
    max: run.max_actions, guide: run.guide_version_number ?? '?',
    binding: run.credential_binding_id ? `${shortId(run.credential_binding_id)} rev ${run.credential_binding_revision}` : 'none' });
}

function OriginBadges({ origin, onOpenRun }) {
  if (!origin) return null;
  const link = (id, text) => <button type="button" onClick={() => onOpenRun?.(id)}
    className="inline-flex min-h-11 items-center text-sm underline underline-offset-2">{text}</button>;
  return <>
    {origin.practice && <Badge tone="warn">{ORIGIN_TEXT.practice(origin.fixture_mode)}</Badge>}
    {origin.resumed_from_run_id && link(origin.resumed_from_run_id, ORIGIN_TEXT.resumedFrom(origin.resumed_from_run_id))}
    {origin.resumed_as_run_id && link(origin.resumed_as_run_id, ORIGIN_TEXT.resumedAs(origin.resumed_as_run_id))}
  </>;
}

function RunBar({ data, busy, message, statusId, onBack, onStop, onResume, onOpenRun }) {
  const { run, controls } = data;
  const resumeHint = useId();
  const needsPerson = !!data.result?.needs_human;
  const stopHint = useId();
  const hint = !controls.stop.enabled ? DECK_TEXT.stopUnavailable(controls.stop.reason)
    : controls.stop.retry ? DECK_TEXT.stopRetry : DECK_TEXT.stopHint;
  return <section aria-labelledby={`${run.id}-title`} className="space-y-2 min-w-0 lg:rounded-lg lg:border lg:bg-card lg:px-4 lg:py-2.5">
    <Action variant="outline" className="lg:hidden" onClick={onBack}>{DECK_TEXT.back}</Action>
    <div className="flex items-start gap-3 min-w-0">
      <div className="min-w-0 flex-1">
        <h2 id={`${run.id}-title`} className="text-lg font-semibold flex flex-wrap items-center gap-x-2 gap-y-1 min-w-0">
          <span className="break-words [overflow-wrap:anywhere]">{run.profile_name ?? 'Agent run'} · run {shortId(run.id)}</span>
          <StateBadge run={run}/>{run.awaiting_approval && <Badge tone="warn">Awaiting approval</Badge>}</h2>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1"><OriginBadges origin={data.origin} onOpenRun={onOpenRun}/>
          {data.origin?.practice && data.origin.expected_result && <span className="text-sm text-muted-foreground">{ORIGIN_TEXT.expected(data.origin.expected_result)}</span>}</div>
        <p className="hidden sm:block truncate text-sm text-muted-foreground" title={runMeta(run)}>{runMeta(run)}</p>
        <p id={statusId} role="status" aria-live="polite" className="text-sm">{busy ? 'Working…' : message}</p>
      </div>
      <div className="flex shrink-0 flex-wrap justify-end gap-2">
        <Action variant="outline" className="hidden lg:inline-flex" onClick={onBack}>{DECK_TEXT.back}</Action>
        <Action variant={controls.stop.enabled ? 'destructive' : 'outline'} disabled={!controls.stop.enabled || busy} className="gap-2"
          aria-label={DECK_TEXT.stop} aria-describedby={stopHint} onClick={onStop}>
          <Square aria-hidden="true" className="h-3.5 w-3.5 fill-current"/>
          <span className="sm:hidden">{DECK_TEXT.stopShort}</span><span className="hidden sm:inline">{DECK_TEXT.stop}</span></Action>
      </div>
    </div>
    <p id={stopHint} className={controls.stop.enabled && !controls.stop.retry ? 'sr-only' : 'text-sm text-muted-foreground break-words'}>{hint}</p>
    {needsPerson && controls.resume && <div className="flex flex-col sm:flex-row sm:items-center gap-2">
      <Action variant={controls.resume.enabled ? 'default' : 'outline'} className="gap-2 shrink-0"
        disabled={!controls.resume.enabled || busy} aria-describedby={resumeHint} onClick={onResume}>
        <RotateCcw aria-hidden="true" className="h-4 w-4"/>{ORIGIN_TEXT.resume}</Action>
      <p id={resumeHint} className="min-w-0 text-sm text-muted-foreground break-words">
        {controls.resume.enabled ? ORIGIN_TEXT.resumeHint : ORIGIN_TEXT.resumeUnavailable(controls.resume.reason)}</p>
    </div>}
  </section>;
}

// A7 decision 3: what a person records about each uncertain item of a finished
// run. The server keeps each decision with who and when; nothing is re-sent.
export function ReconcilePanel({ data, busy, onDecide }) {
  const items = data.reconciliation?.items ?? [];
  const headingId = useId();
  if (!items.length) return null;
  const choices = item => item.kind === 'run' ? ['acknowledged'] : ['happened', 'did_not_happen', 'unknown'];
  return <section aria-labelledby={headingId} className="rounded-lg border-2 border-amber-500/70 p-3 space-y-3 min-w-0" data-testid="reconcile">
    <h3 id={headingId} className="font-semibold">{RECONCILE_TEXT.heading}</h3>
    <p className="text-sm break-words">{RECONCILE_TEXT.note}</p>
    <ul className="space-y-3">{items.map(item => <li key={item.subject} className="rounded-md border p-3 space-y-2 min-w-0"
      data-testid={`reconcile-${item.subject}`}>
      <p className="font-medium break-words flex flex-wrap items-center gap-2">{RECONCILE_TEXT.title(item)}
        {item.gates && <Badge tone="bad">Blocks the next start</Badge>}
        {!item.open && <Badge tone="good">Decided</Badge>}</p>
      <p className="text-sm text-muted-foreground break-words">Why: {RECONCILE_TEXT.reason(item.reason)}. {RECONCILE_TEXT.question(item)}</p>
      {item.decision && <p className="text-sm break-words">{RECONCILE_TEXT.decision[item.decision.decision] ?? item.decision.decision} · {RECONCILE_TEXT.by(item.decision.decided_by, when(item.decision.decided_at))}</p>}
      {item.open && <div className="grid grid-cols-1 sm:flex sm:flex-wrap gap-2">{choices(item).map(choice =>
        <Action key={choice} variant="outline" disabled={busy} onClick={() => onDecide(item.subject, choice)}>
          {choice === 'acknowledged' ? 'Acknowledge' : choice === 'happened' ? 'It happened' : choice === 'did_not_happen' ? 'It did not happen' : 'Not known yet'}</Action>)}</div>}
    </li>)}</ul>
  </section>;
}

// Compact: the nine digest fields stay in the dialog and the inbox; approving
// still needs the dialog. On a phone the Activity and Details panels get a
// one-row form.
function ApprovalBanner({ approval, compact, onReview }) {
  const action = ACTION_TEXT[approval.action] ?? approval.action;
  // Sticky under the app bar on a phone or tablet: the padding strip covers the
  // layout scroller's own padding, and the negative margin keeps the flow gap.
  return <section aria-label={DECK_TEXT.approvalNeeded} className="sticky -top-4 z-20 -mt-4 bg-background pt-4 md:-top-8 md:-mt-8 md:pt-8 lg:static lg:mt-0 lg:pt-0">
    <div className={`flex gap-3 rounded-lg border-2 border-amber-500/70 bg-amber-500/10 p-3 lg:flex-row lg:items-center lg:gap-4 lg:py-2 ${compact ? 'flex-row items-center' : 'flex-col'}`}>
      <AlertTriangle aria-hidden="true" className="hidden lg:block h-6 w-6 shrink-0 text-amber-600 dark:text-amber-400"/>
      <div className={`min-w-0 flex-1 ${compact ? 'hidden lg:block' : ''}`}>
        <p className="font-semibold break-words">{DECK_TEXT.approvalTitle(action)}</p>
        <p className="text-sm break-words">{DECK_TEXT.approvalLine(clock(approval.requested_at), grouped(approval.digest.slice(0, 12)))}</p>
      </div>
      {compact && <p className="min-w-0 flex-1 font-semibold lg:hidden">{DECK_TEXT.approvalNeeded}</p>}
      <Action aria-label={DECK_TEXT.review} className={`shrink-0 ${compact ? '' : 'w-full lg:w-auto'}`} onClick={onReview}>
        {compact ? <><span className="lg:hidden">{DECK_TEXT.reviewShort}</span><span className="hidden lg:inline">{DECK_TEXT.review}</span></> : DECK_TEXT.review}</Action>
    </div>
  </section>;
}

function LivePill({ state }) {
  if (state === 'live') return <span data-testid="browser-state" className="inline-flex items-center gap-1.5 rounded-full border border-red-500/60 bg-red-500/10 px-2 py-0.5 text-[11px] font-bold tracking-wider text-red-700 dark:text-red-300">
    <span aria-hidden="true" className="h-2 w-2 rounded-full bg-red-500"/>{DECK_TEXT.live}</span>;
  return <span data-testid="browser-state" className="inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium text-muted-foreground">
    {state === 'paused' ? DECK_TEXT.paused : DECK_TEXT.ended}</span>;
}

function WatchSwitch({ checked, onChange }) {
  return <button type="button" role="switch" aria-checked={checked} onClick={() => onChange(!checked)}
    className="inline-flex min-h-11 items-center gap-2 rounded-md px-1 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
    <span aria-hidden="true" className={`inline-flex h-6 w-10 shrink-0 items-center rounded-full transition-colors motion-reduce:transition-none ${checked ? 'bg-primary' : 'bg-input'}`}>
      <span className={`h-5 w-5 rounded-full bg-background shadow transition-transform motion-reduce:transition-none ${checked ? 'translate-x-[18px]' : 'translate-x-0.5'}`}/></span>
    <span>{DECK_TEXT.watch}</span></button>;
}

function TakeoverBar({ data, live, me, busy, onTakeover, onEndTakeover }) {
  const t = data.controls.takeover;
  const hint = useId();
  if (!t) return null;
  const mine = live.control.mine || (t.holder && t.holder.user_id === me);
  if (t.holder) return <div className={`flex flex-col sm:flex-row sm:items-center gap-2 rounded-md border p-2 ${mine ? 'border-emerald-600/70 bg-emerald-500/10' : ''}`}>
    <p className="min-w-0 flex-1 text-sm font-medium break-words" role="status">{mine ? LIVE_TEXT.holderMe : LIVE_TEXT.holder(t.holder.user, clock(t.holder.since))}</p>
    {mine && <Action variant="destructive" disabled={busy} onClick={onEndTakeover}>{LIVE_TEXT.giveBack}</Action>}
  </div>;
  const ready = live.state === 'live' && !!live.viewer;
  return <div className="flex flex-col sm:flex-row sm:items-center gap-2">
    <Action className="gap-2" disabled={!t.enabled || !ready || busy} aria-describedby={hint} onClick={onTakeover}>
      <Hand aria-hidden="true" className="h-4 w-4"/>{LIVE_TEXT.takeover}</Action>
    <p id={hint} className="text-sm text-muted-foreground break-words">{!t.enabled ? t.reason : !ready ? LIVE_TEXT.takeoverWait : LIVE_TEXT.takeoverHint}</p>
  </div>;
}

function BrowserPane({ data, active, live: frame, watch, onWatch, onEnlarge, viewNote, className, liveView, me, busy,
  onTakeover, onEndTakeover }) {
  const { controls, steps } = data;
  const headingId = useId();
  const video = !!liveView && liveView.mode === 'live' && controls.live?.enabled;
  if (video) return <section aria-labelledby={headingId} className={`${className} flex-col gap-3 rounded-lg border bg-card p-3 min-w-0 lg:min-h-0 lg:overflow-y-auto`}>
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <h3 id={headingId} className="font-semibold">{DECK_TEXT.browser}</h3>
      {liveView.state === 'live' && <LivePill state="live"/>}
    </div>
    <LiveBrowser base={liveView.base} runId={data.run.id} onState={liveView.onState} onControl={liveView.onControl}
      onViewer={liveView.onViewer}/>
    <TakeoverBar data={data} live={liveView} me={me} busy={busy} onTakeover={onTakeover} onEndTakeover={onEndTakeover}/>
    <p className="text-xs text-muted-foreground">{DECK_TEXT.liveNote}</p>
  </section>;
  const live = frame;
  const firstDone = firstStepFinishedAt(steps) !== null;
  const pill = !active ? 'ended' : controls.view.enabled ? (watch ? 'live' : 'paused') : null;
  const at = live?.action_count ?? 0;
  const step = live ? steps.find(s => s.ordinal === at) : null;
  const placeholder = !active ? DECK_TEXT.noBrowser : !firstDone ? DECK_TEXT.starting
    : !controls.view.enabled ? DECK_TEXT.noBrowser : !watch ? DECK_TEXT.watchingPaused : DECK_TEXT.firstFrame;
  return <section aria-labelledby={headingId} className={`${className} flex-col gap-3 rounded-lg border bg-card p-3 min-w-0 lg:min-h-0 lg:overflow-y-auto`}>
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <h3 id={headingId} className="font-semibold">{DECK_TEXT.browser}</h3>
      {pill && <LivePill state={pill}/>}
      <div className="ml-auto flex items-center gap-2">
        {controls.view.enabled && <WatchSwitch checked={watch} onChange={onWatch}/>}
        {live && <Action variant="outline" size="icon" className="w-11 shrink-0" aria-label={DECK_TEXT.enlarge} onClick={() => onEnlarge(live)}>
          <Maximize2 aria-hidden="true" className="h-4 w-4"/></Action>}
      </div>
    </div>
    <div className="relative w-full aspect-[16/10] shrink-0 overflow-hidden rounded-md bg-zinc-950" data-testid="browser-frame">
      {live ? <img src={`data:image/png;base64,${live.png_base64}`} alt={active ? DECK_TEXT.liveAlt(at) : DECK_TEXT.lastAlt(at)}
        className="absolute inset-0 h-full w-full object-contain"/>
        : <p role="status" className="absolute inset-0 flex items-center justify-center p-4 text-center text-sm text-zinc-300">{placeholder}</p>}
    </div>
    {live && <p className="text-sm break-words" data-testid="browser-caption">{active
      ? DECK_TEXT.captionLive(at, ACTION_TEXT[step?.action] ?? step?.action ?? '—', clock(live.captured_at)) : DECK_TEXT.captionEnded(at)}</p>}
    {!controls.view.enabled && <p className="text-sm break-words">{DECK_TEXT.viewUnavailable(controls.view.reason)}</p>}
    {viewNote && controls.view.enabled && <p className="text-sm break-words" role="status">{viewNote}</p>}
    {liveView?.note && controls.live?.enabled && <div className="flex flex-col sm:flex-row sm:items-center gap-2">
      <p className="min-w-0 flex-1 text-sm break-words" role="status">{liveView.note}</p>
      {liveView.retry && <Action variant="outline" onClick={liveView.onRetry}>{LIVE_TEXT.retry}</Action>}</div>}
    {controls.takeover?.holder && <TakeoverBar data={data} live={liveView ?? { control: {}, state: 'off' }} me={me} busy={busy}
      onTakeover={onTakeover} onEndTakeover={onEndTakeover}/>}
    <p className="text-xs text-muted-foreground">{DECK_TEXT.viewNote}</p>
  </section>;
}

// A7 decision 5: the rule-based review and, with the owner's consent, the
// model's summary written from typed facts. Untrusted model text is shown as
// plain text, never as markup or a link.
function ReviewTab({ data }) {
  const c = data.critique, sum = data.summary;
  const section = (title, list, tone) => list?.length ? <div className="space-y-1">
    <h4 className="text-sm font-semibold">{title}</h4>
    <ul className="space-y-1">{list.map((item, i) => <li key={`${item.code}-${i}`} className="flex gap-2 text-sm break-words">
      <Badge tone={tone}>{tone === 'good' ? 'Good' : tone === 'bad' ? 'Wrong' : 'Check'}</Badge><span className="min-w-0">{critiqueText(item)}</span></li>)}</ul>
  </div> : null;
  return <div className="space-y-4" data-testid="run-review">
    {!c?.final ? <p className="text-sm">{DECK_TEXT.noResult}</p> : <>
      {section('What went well', c.good, 'good')}
      {section('What went wrong', c.bad, 'bad')}
      {section('What to check', c.check, 'warn')}
    </>}
    <div className="rounded-md border p-3 space-y-2" data-testid="run-summary">
      <h4 className="text-sm font-semibold">{SUMMARY_TEXT.heading}</h4>
      {!sum ? <p className="text-sm">{SUMMARY_TEXT.none}</p> : sum.state === 'written' ? <>
        <blockquote className="border-l-4 pl-3 text-sm whitespace-pre-wrap break-words">{sum.text}</blockquote>
        <p className="text-xs text-muted-foreground">{SUMMARY_TEXT.written} {SUMMARY_TEXT.usage(sum.prompt_tokens, sum.completion_tokens, sum.settled_usd)}</p>
      </> : <p className="text-sm break-words">{sum.state === 'refused' ? SUMMARY_TEXT.refused(sum.refusal_code) : SUMMARY_TEXT[sum.state]}</p>}
    </div>
  </div>;
}

// What scrolls the feed: the column itself on a laptop (overflow-y-auto at lg),
// the page's own scroller on a phone. Null while the panel is hidden.
function scrollerFor(el) {
  if (!el || el.offsetParent === null) return null;
  const scrolls = node => ['auto', 'scroll'].includes(getComputedStyle(node).overflowY);
  if (scrolls(el)) return el;
  for (let node = el.parentElement; node; node = node.parentElement) if (scrolls(node)) return node;
  return document.scrollingElement;
}

// Chat rhythm, newest last. It follows the newest item unless the reader has
// scrolled up; then new items are counted and a pill jumps back down.
function ActivityColumn({ feed, data, thumbs, visible, onFrame, className }) {
  const headingId = useId(), noteId = useId();
  const box = useRef(null), follow = useRef(true), seen = useRef(feed.length);
  const [unseen, setUnseen] = useState(0);
  const toEnd = useCallback(() => { const el = scrollerFor(box.current); if (el) el.scrollTop = el.scrollHeight; }, []);
  useLayoutEffect(() => {
    const added = feed.length - seen.current;
    seen.current = feed.length;
    if (follow.current) toEnd();
    else if (added > 0) setUnseen(n => n + added);
  }, [feed, thumbs, toEnd]);
  useLayoutEffect(() => { if (follow.current) toEnd(); }, [visible, toEnd]);
  // Listen to whichever element scrolls now; a resize across lg or a panel
  // switch changes it.
  useEffect(() => {
    let current = null;
    const onScroll = () => {
      if (!current?.clientHeight) return;
      follow.current = current.scrollHeight - current.scrollTop - current.clientHeight < 32;
      if (follow.current) setUnseen(0);
    };
    const bind = () => {
      const next = scrollerFor(box.current);
      if (next === current) return;
      current?.removeEventListener('scroll', onScroll);
      current = next;
      current?.addEventListener('scroll', onScroll, { passive: true });
    };
    bind();
    window.addEventListener('resize', bind);
    return () => { window.removeEventListener('resize', bind); current?.removeEventListener('scroll', onScroll); };
  }, [visible]);
  const jump = () => { follow.current = true; toEnd(); setUnseen(0); };
  const open = data.approvals.some(a => a.open);
  return <section aria-labelledby={headingId} className={`${className} relative flex-col rounded-lg border bg-card min-w-0 lg:min-h-0`}>
    <div className="flex flex-wrap items-baseline gap-x-2 border-b px-3 py-2">
      <h3 id={headingId} className="font-semibold">{DECK_TEXT.activity}</h3>
      <span className="text-sm text-muted-foreground">{DECK_TEXT.events(feed.length)}</span>
    </div>
    <p id={noteId} className="sr-only">{DECK_TEXT.activityNote}</p>
    <div ref={box} className="space-y-2 p-3 lg:flex-auto lg:min-h-0 lg:overflow-y-auto" data-testid="activity-scroller">
      <ol className="space-y-2" aria-label="Run activity" aria-describedby={noteId}>{feed.map(item =>
        <FeedItem key={item.key} item={item} data={data} thumb={item.step ? thumbs.get(item.step.ordinal) : null} onFrame={onFrame}/>)}</ol>
      <p aria-live="polite" className="flex items-center gap-2 px-1 text-sm text-amber-700 dark:text-amber-300">{open && <>
        <span aria-hidden="true" className="flex gap-1">{[0, 1, 2].map(i => <span key={i} style={{ animationDelay: `${i * 200}ms` }}
          className="h-1.5 w-1.5 rounded-full bg-current animate-pulse motion-reduce:animate-none"/>)}</span>
        {DECK_TEXT.pausedUntilApproval}</>}</p>
    </div>
    {unseen > 0 && <div className="pointer-events-none sticky bottom-[calc(4.5rem+env(safe-area-inset-bottom))] flex justify-center pb-2 md:bottom-16 lg:absolute lg:inset-x-0 lg:bottom-3 lg:pb-0">
      <Action variant="outline" className="pointer-events-auto rounded-full bg-background shadow-md" onClick={jump}>{DECK_TEXT.jump(unseen)}</Action></div>}
  </section>;
}

function RunDetails({ data, tab, onTab, busy, statusId, onRefresh, className }) {
  const { run } = data;
  const trigger = 'min-h-11 rounded-md border px-3 data-[state=active]:bg-muted data-[state=active]:shadow-none';
  const pins = [['Run', run.id], ['Fence', run.fence], ['Policy digest', run.policy_digest], ['Guide hash', run.guide_hash],
    ['Deadline', run.deadline_at ?? 'none']];
  return <section aria-label={DECK_TEXT.details} className={`${className} min-w-0`}>
    <Tabs value={tab} onValueChange={onTab}>
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
        <TabsList className="grid h-auto grid-cols-2 gap-2 bg-transparent p-0 sm:flex sm:flex-wrap sm:justify-start">
          <TabsTrigger className={trigger} value="result">{DECK_TEXT.result}</TabsTrigger>
          <TabsTrigger className={trigger} value="review">{DECK_TEXT.reviewTab}</TabsTrigger>
          <TabsTrigger className={trigger} value="calls">{DECK_TEXT.modelCalls(data.model_calls.length)}</TabsTrigger>
          <TabsTrigger className={trigger} value="approvals">{DECK_TEXT.approvals(data.approvals.length)}</TabsTrigger>
          <TabsTrigger className={trigger} value="pins">{DECK_TEXT.pins}</TabsTrigger>
        </TabsList>
        <Action variant="outline" disabled={busy} aria-describedby={statusId} onClick={onRefresh}>{DECK_TEXT.refresh}</Action>
      </div>
      <TabsContent value="result" className="mt-3">
        {data.result ? <ResultSummary result={data.result}/> : <p className="text-sm">{DECK_TEXT.noResult}</p>}
      </TabsContent>
      <TabsContent value="review" className="mt-3"><ReviewTab data={data}/></TabsContent>
      <TabsContent value="calls" className="mt-3">
        <ul className="space-y-2">{data.model_calls.map(c => <li key={c.call_id} className="text-sm break-words border-t pt-2">
          <span className="font-medium">{c.state}</span>{c.choice && ` · chose ${ACTION_TEXT[c.choice] ?? c.choice}`}{c.refusal_code && ` · refused ${c.refusal_code}`} · allowed {c.allowed.join(', ')} · {c.prompt_tokens ?? 0}+{c.completion_tokens ?? 0} tokens · ${c.settled_usd ?? '—'}{c.replayed ? ' · replayed' : ''}</li>)}
        {!data.model_calls.length && <li className="text-sm">No model call: every step was decided by a rule.</li>}</ul>
      </TabsContent>
      <TabsContent value="approvals" className="mt-3">
        <ul className="space-y-3">{data.approvals.map(a => <li key={a.id} className="space-y-2 border-t pt-2">
          <p className="text-sm font-medium">{ACTION_TEXT[a.action] ?? a.action} · {a.state}{a.stale_reason ? ` (${STALE_TEXT[a.stale_reason] ?? a.stale_reason})` : ''}{a.decided_by ? ` · approved by ${a.decided_by.username ?? a.decided_by.id}` : ''}</p>
          <ApprovalFields approval={a}/></li>)}
        {!data.approvals.length && <li className="text-sm">No approval was requested.</li>}</ul>
      </TabsContent>
      <TabsContent value="pins" className="mt-3">
        <p className="text-sm text-muted-foreground break-words mb-2">{runMeta(run)}</p>
        <dl className="grid grid-cols-1 sm:grid-cols-3 gap-x-4 gap-y-1 text-sm">
          {pins.map(([k, v]) => <div key={k} className="contents"><dt className="text-muted-foreground">{k}</dt><dd className="sm:col-span-2 mb-2 sm:mb-0 break-all font-mono text-xs sm:text-sm">{String(v)}</dd></div>)}
        </dl>
      </TabsContent>
    </Tabs>
  </section>;
}

// `panel` only matters below lg, where one panel shows at a time.
export function RunDeck({ data, feed, view, active, panel, onPanel, tab, onTab, watch, onWatch, viewNote, busy, message,
  error, announce, onBack, onStop, onRefresh, onReview, onFrame, liveView = null, me = null, onTakeover, onEndTakeover,
  onResume, onOpenRun, onDecide }) {
  const statusId = useId();
  const open = data.approvals.find(a => a.open) ?? null;
  const shown = key => `${panel === key ? 'flex' : 'hidden'} lg:flex`;
  const panels = [
    { key: 'browser', label: DECK_TEXT.browser, icon: AppWindow },
    { key: 'activity', label: <span>{DECK_TEXT.activity} <span className="rounded-full bg-muted px-1.5 text-[10px] text-foreground">{feed.length}</span></span>, icon: MessageSquare },
    { key: 'details', label: DECK_TEXT.details, icon: Info },
  ];
  return <div className="flex flex-col gap-3 min-w-0 pb-[calc(4.5rem+env(safe-area-inset-bottom))] md:pb-0">
    <p className="sr-only" role="status" aria-live="polite">{announce}</p>
    <RunBar data={data} busy={busy} message={message} statusId={statusId} onBack={onBack} onStop={onStop} onResume={onResume}
      onOpenRun={onOpenRun}/>
    {error && <p role="alert" className="text-destructive break-words">{error}</p>}
    <HelpBanner help={data.run.help}/>
    <ReconcilePanel data={data} busy={busy} onDecide={onDecide}/>
    {open && <ApprovalBanner approval={open} compact={panel !== 'browser'} onReview={() => onReview(open.id)}/>}
    <div className="min-w-0 lg:grid lg:h-[calc(100dvh-15rem)] lg:min-h-[30rem] lg:grid-cols-[minmax(0,1fr)_380px] lg:grid-rows-[minmax(0,1fr)] lg:gap-3">
      <BrowserPane className={shown('browser')} data={data} active={active} live={view.live} watch={watch} onWatch={onWatch}
        onEnlarge={onFrame} viewNote={viewNote} liveView={liveView} me={me} busy={busy} onTakeover={onTakeover}
        onEndTakeover={onEndTakeover}/>
      <ActivityColumn className={shown('activity')} feed={feed} data={data} thumbs={view.thumbs} visible={panel === 'activity'} onFrame={onFrame}/>
    </div>
    <RunDetails className={`${panel === 'details' ? 'block' : 'hidden'} lg:block`} data={data} tab={tab} onTab={onTab} busy={busy}
      statusId={statusId} onRefresh={onRefresh}/>
    <nav aria-label={DECK_TEXT.panels} className="fixed inset-x-0 bottom-0 z-30 md:sticky lg:hidden">
      <MobilePanelBar panels={panels} current={panel} onSelect={onPanel}/>
    </nav>
  </div>;
}
