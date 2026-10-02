import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { AlertTriangle, AppWindow, BookOpen, CheckCircle2, Globe, Hand, Info, Maximize2, MessageSquare, RotateCcw, Square } from 'lucide-react';
import { operationsApi as api } from '@/lib/api';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import MobilePanelBar from '@/components/mock2/MobilePanelBar';
import { Action } from './shared';
import { ACTION_TEXT, CLAIM_TEXT, DECK_TEXT, HELP_DECISION, KIND_TEXT, LIVE_TEXT, ORIGIN_TEXT, RECONCILE_TEXT, RESULT_TEXT,
  RULE_TEXT, STALE_TEXT, STATE_TEXT, SUMMARY_TEXT, clock, critiqueText, grouped, resultLabel, shortId, when,
  whenShort } from './agent-run-text';
import { callSummary, firstStepFinishedAt } from './run-deck-logic';
import { LiveBrowser } from './LiveBrowser';
import { matchesPinnedGuide } from './run-readiness';

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
  return <div role="note" className={`rounded-md border p-3 space-y-1 ${help.open === false ? 'bg-muted/30' : 'border-amber-500/70 bg-amber-500/10'}`}>
    <p className="font-semibold flex items-start gap-2"><AlertTriangle aria-hidden="true" className="h-5 w-5 shrink-0"/><span>{help.open === false ? 'Historical review' : 'Review needed'}: {resultLabel(help.result_class)}</span></p>
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
  system: 'bg-muted text-muted-foreground', rule: 'bg-muted text-muted-foreground',
  model: 'bg-muted text-muted-foreground', approval: 'bg-amber-500/15 text-amber-800 dark:text-amber-300',
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
  const box = 'flex gap-3 border-b border-border/70 pb-2 min-w-0';
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
    return <li className={`${box} rounded-md border bg-muted/30 p-3`} data-testid="feed-result">
      <div className="min-w-0 flex-1 space-y-0.5">{head(RESULT_TONE[stateTone(r.final_state)], <Badge tone={stateTone(r.final_state)}>{STATE_TEXT[r.final_state]}</Badge>)}
        <p className="text-sm font-semibold break-words">Result: {resultLabel(r.result_class)}</p>
        <p className="text-[13px] text-muted-foreground break-words">{RESULT_TEXT[r.result_class]?.[1]}</p>
      </div>
    </li>;
  }
  return <li className={`${box} ${item.open ? 'rounded-md border border-amber-500/70 bg-amber-500/10 p-2' : ''}`}>
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
    <ul className="text-sm grid grid-cols-1 gap-y-1">
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
  return <section aria-labelledby={`${run.id}-title`} className="space-y-3 min-w-0 pb-1" data-run-header>
    <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-3 min-w-0">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 min-w-0">
          <h1 id={`${run.id}-title`} className="operations-title !text-[28px] sm:!text-[32px] break-words [overflow-wrap:anywhere]">{run.profile_name ?? 'Demo sign-in run'}</h1>
          <StateBadge run={run}/>{run.awaiting_approval && <Badge tone="warn">Awaiting approval</Badge>}
        </div>
        <p className="mt-2 text-sm text-muted-foreground break-words">Demo sign-in · Run {shortId(run.id)} · Step {run.action_count} of at most {run.max_actions}</p>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1"><OriginBadges origin={data.origin} onOpenRun={onOpenRun}/>
          {data.origin?.practice && data.origin.expected_result && <span className="text-sm text-muted-foreground">{ORIGIN_TEXT.expected(data.origin.expected_result)}</span>}</div>
        <p className="text-xs text-muted-foreground break-words">Started by {run.started_by.username ?? run.started_by.id} · {whenShort(run.started_at)} · Guide v{run.guide_version_number ?? '?'}</p>
      </div>
      <div className="flex shrink-0 flex-wrap gap-2 lg:justify-end">
        <Action variant="outline" onClick={onBack}>{DECK_TEXT.back}</Action>
        {needsPerson && controls.resume && <Action variant={controls.resume.enabled ? 'default' : 'outline'} className="gap-2"
          disabled={!controls.resume.enabled || busy} aria-describedby={resumeHint} onClick={onResume}>
          <RotateCcw aria-hidden="true" className="h-4 w-4"/>{ORIGIN_TEXT.resume}</Action>}
        <Action variant={controls.stop.enabled ? 'destructive' : 'outline'} disabled={!controls.stop.enabled || busy} className="gap-2"
          aria-label={DECK_TEXT.stop} aria-describedby={stopHint} onClick={onStop}>
          <Square aria-hidden="true" className="h-3.5 w-3.5 fill-current"/>
          <span className="sm:hidden">{DECK_TEXT.stopShort}</span><span className="hidden sm:inline">{DECK_TEXT.stop}</span></Action>
      </div>
    </div>
    <p id={stopHint} className={controls.stop.enabled && !controls.stop.retry ? 'sr-only' : 'text-xs text-muted-foreground break-words'}>{hint}</p>
    {needsPerson && controls.resume && <p id={resumeHint} className="text-xs text-muted-foreground break-words">
        {controls.resume.enabled ? ORIGIN_TEXT.resumeHint : ORIGIN_TEXT.resumeUnavailable(controls.resume.reason)}</p>
    }
    <p id={statusId} role="status" aria-live="polite" className={busy || message ? 'text-sm' : 'sr-only'}>{busy ? 'Working…' : message}</p>
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
      {item.subject.startsWith('step:') && <div className="text-sm break-words space-y-1" data-testid="supervisor-record">
        <p>{RECONCILE_TEXT.supervisor(item)}</p>
        <p className="text-muted-foreground">{RECONCILE_TEXT.supervisorNote}</p>
      </div>}
      {item.decision && <p className="text-sm break-words">{RECONCILE_TEXT.decision[item.decision.decision] ?? item.decision.decision} · {RECONCILE_TEXT.by(item.decision.decided_by, when(item.decision.decided_at))}</p>}
      {item.open && <div className="grid grid-cols-1 sm:flex sm:flex-wrap gap-2">{choices(item).map(choice =>
        <Action key={choice} variant="outline" disabled={busy} onClick={() => onDecide(item.subject, choice)}>
          {choice === 'acknowledged' ? 'Acknowledge' : choice === 'happened' ? 'It happened' : choice === 'did_not_happen' ? 'It did not happen' : 'Not known yet'}</Action>)}</div>}
    </li>)}</ul>
  </section>;
}

// One approval card, before Browser in the DOM. The desktop grid places it
// above the context rail; on phones it stays visible before every panel.
// The nine digest fields stay in the dialog and inbox. Approval still requires
// that dialog, the digest confirmation and sudo.
function ApprovalBanner({ approval, compact, onReview }) {
  const action = ACTION_TEXT[approval.action] ?? approval.action;
  // Sticky under the app bar on a phone or tablet: the padding strip covers the
  // layout scroller's own padding, and the negative margin keeps the flow gap.
  return <section aria-label={DECK_TEXT.approvalNeeded} className="sticky -top-4 z-20 -mt-4 bg-background pt-4 md:-top-8 md:-mt-8 md:pt-8 lg:static lg:col-start-2 lg:row-start-1 lg:mt-0 lg:pt-0" data-run-approval>
    <div className={`operations-card flex gap-2 rounded-md border border-amber-500/70 bg-amber-500/10 p-3 lg:flex-col lg:items-stretch ${compact ? 'flex-row items-center' : 'flex-col'}`}>
      <div className={`min-w-0 flex-1 ${compact ? 'hidden lg:block' : ''}`}>
        <h2 className="text-lg font-semibold flex items-center gap-2"><AlertTriangle aria-hidden="true" className="hidden lg:block h-5 w-5 shrink-0 text-amber-600 dark:text-amber-400"/>{DECK_TEXT.approvalNeeded}</h2>
        <p className="mt-1 text-sm font-medium break-words">{action}</p>
        <p className="mt-1 text-xs text-muted-foreground break-words">{DECK_TEXT.approvalLine(clock(approval.requested_at), grouped(approval.digest.slice(0, 12)))}</p>
      </div>
      {compact && <p className="min-w-0 flex-1 font-semibold lg:hidden">{DECK_TEXT.approvalNeeded}</p>}
      <Action aria-label={DECK_TEXT.review} className={`shrink-0 lg:w-full ${compact ? '' : 'w-full'}`} onClick={onReview}>
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
  if (video) return <section aria-labelledby={headingId} className={`${className} operations-card flex-col gap-4 rounded-md border bg-card p-4 min-w-0 lg:min-h-0 lg:overflow-y-auto`} data-browser-pane>
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <h2 id={headingId} className="text-base font-semibold flex items-center gap-2"><Globe aria-hidden="true" className="h-5 w-5 text-muted-foreground"/>Live browser</h2>
      {liveView.state === 'live' && <LivePill state="live"/>}
      <span className="text-xs text-muted-foreground">{liveView.control?.mine ? 'You have control' : 'View only'}</span>
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
  return <section aria-labelledby={headingId} className={`${className} operations-card flex-col gap-4 rounded-md border bg-card p-4 min-w-0 lg:min-h-0 lg:overflow-y-auto`} data-browser-pane>
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <h2 id={headingId} className="text-base font-semibold flex items-center gap-2"><Globe aria-hidden="true" className="h-5 w-5 text-muted-foreground"/>{active ? 'Live browser' : DECK_TEXT.browser}</h2>
      {pill && <LivePill state={pill}/>}
      <div className="ml-auto flex items-center gap-2">
        {controls.view.enabled && <WatchSwitch checked={watch} onChange={onWatch}/>}
        {live && <Action variant="outline" size="icon" className="w-11 shrink-0" aria-label={DECK_TEXT.enlarge} onClick={() => onEnlarge(live)}>
          <Maximize2 aria-hidden="true" className="h-4 w-4"/></Action>}
      </div>
    </div>
    <div className={`relative w-full shrink-0 overflow-hidden rounded-md ${live || active ? 'aspect-[16/10] bg-zinc-950' : 'border bg-muted/30 p-6 sm:p-8'}`} data-testid="browser-frame">
      {live ? <img src={`data:image/png;base64,${live.png_base64}`} alt={active ? DECK_TEXT.liveAlt(at) : DECK_TEXT.lastAlt(at)}
        className="absolute inset-0 h-full w-full object-contain"/>
        : active ? <p role="status" className="absolute inset-0 flex items-center justify-center p-4 text-center text-sm text-zinc-300">{placeholder}</p>
          : <div className="space-y-3 text-center py-4 sm:py-8" data-testid="browser-ended">
            <AppWindow aria-hidden="true" className="h-8 w-8 mx-auto text-muted-foreground"/>
            <h3 className="text-lg font-semibold">Browser session ended</h3>
            <p className="text-sm text-muted-foreground max-w-md mx-auto">Live video and frames are held only while viewing. This run's activity and outcome remain available.</p>
            {data.result && <p className="font-medium">{resultLabel(data.result.result_class)}</p>}
          </div>}
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
    <p className="text-xs text-muted-foreground">{active ? DECK_TEXT.viewNote : 'This is a historical run. No browser session is active.'}</p>
    <div className="border-t pt-4 space-y-3" data-testid="run-overview">
      <div className="flex items-start gap-2"><Info aria-hidden="true" className="h-4 w-4 mt-0.5 shrink-0 text-muted-foreground"/>
        <div className="min-w-0"><p className="text-sm font-semibold">{data.result ? 'Run outcome' : 'Current task'}</p>
          <p className="text-sm text-muted-foreground break-words">{data.result ? RESULT_TEXT[data.result.result_class]?.[1]
            : data.run.awaiting_approval ? 'The agent is waiting for approval before submitting the bound demo credential.'
              : 'Follow the approved synthetic sign-in guide and verify the account before signing out.'}</p></div></div>
      <ol aria-label="Recent steps" className="flex flex-col sm:flex-row sm:flex-wrap gap-2">{steps.slice(-3).map(s =>
        <li key={s.ordinal} className="inline-flex items-start gap-2 rounded-md bg-muted/40 px-3 py-2 text-xs min-w-0">
          {s.state === 'done' && <CheckCircle2 aria-hidden="true" className="h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400"/>}
          <span className="break-words">{s.ordinal}. {ACTION_TEXT[s.action] ?? s.action} · {s.state === 'reserved' ? 'in progress' : s.state}</span></li>)}</ol>
    </div>
  </section>;
}

function PinnedGuide({ base, run }) {
  const [state, setState] = useState(null);
  useEffect(() => {
    const controller = new AbortController();
    setState(null);
    api.get(`${base}/versions/${run.guide_version_id}`, controller.signal).then(({ version }) => {
      if (controller.signal.aborted) return;
      setState(matchesPinnedGuide(version, run) ? { version } : { error: 'The returned guide does not match this run\'s pinned version and hash.' });
    }).catch(error => { if (!controller.signal.aborted) setState({ error: error.message }); });
    return () => controller.abort();
  }, [base, run.guide_version_id, run.guide_hash]);
  return <div className="space-y-4 min-w-0" data-testid="pinned-guide">
    <div className="flex items-start gap-2"><BookOpen aria-hidden="true" className="h-5 w-5 shrink-0 text-primary"/>
      <div className="min-w-0"><h3 className="font-semibold">Pinned guide · v{run.guide_version_number ?? '?'}</h3>
        <p className="text-xs text-muted-foreground">The immutable version used by this run.</p></div></div>
    {!state ? <p role="status" className="text-sm">Loading the pinned guide…</p>
      : state.error ? <p role="alert" className="text-sm text-destructive break-words">{state.error}</p>
        : <><h4 className="font-medium break-words">{state.version.title}</h4>
          {state.version.withdrawn_at && <Badge tone="warn">Withdrawn after publication</Badge>}
          <pre className="whitespace-pre-wrap break-words [overflow-wrap:anywhere] font-sans text-sm leading-6">{state.version.instructions}</pre></>}
    <details className="border-t pt-2"><summary className="cursor-pointer min-h-11 flex items-center text-sm font-medium">Guide hash</summary>
      <p className="font-mono text-xs break-all pb-2">{run.guide_hash}</p></details>
  </div>;
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
  return <section aria-labelledby={headingId} className={`${className} relative flex-col min-w-0 lg:min-h-0 lg:flex-1`}>
    <div className="flex flex-wrap items-baseline gap-x-2 border-b px-3 py-2 lg:sr-only lg:border-0 lg:p-0">
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

function RunDetails({ base, data, tab, onTab, busy, statusId, onRefresh, className }) {
  const { run } = data;
  const trigger = 'min-h-11 rounded-md border px-3 data-[state=active]:bg-muted data-[state=active]:shadow-none';
  const pins = [['Run', run.id], ['Fence', run.fence], ['Policy digest', run.policy_digest], ['Guide hash', run.guide_hash],
    ['Deadline', run.deadline_at ?? 'none']];
  return <section aria-label={DECK_TEXT.details} className={`${className} min-w-0`}>
    <Tabs value={tab} onValueChange={onTab}>
      <div className="space-y-3">
        <TabsList className="grid w-full h-auto grid-cols-2 gap-2 bg-transparent p-0">
          <TabsTrigger className={trigger} value="result">{DECK_TEXT.result}</TabsTrigger>
          <TabsTrigger className={trigger} value="review">{DECK_TEXT.reviewTab}</TabsTrigger>
          <TabsTrigger className={trigger} value="calls">{DECK_TEXT.modelCalls(data.model_calls.length)}</TabsTrigger>
          <TabsTrigger className={trigger} value="approvals">{DECK_TEXT.approvals(data.approvals.length)}</TabsTrigger>
          <TabsTrigger className={trigger} value="guide">Guide</TabsTrigger>
          <TabsTrigger className={trigger} value="pins">{DECK_TEXT.pins}</TabsTrigger>
        </TabsList>
        <Action variant="outline" disabled={busy} aria-describedby={statusId} onClick={onRefresh}>{DECK_TEXT.refresh}</Action>
      </div>
      <TabsContent value="result" className="mt-3">
        {data.result ? <ResultSummary result={data.result}/> : <p className="text-sm">{DECK_TEXT.noResult}</p>}
      </TabsContent>
      <TabsContent value="review" className="mt-3"><ReviewTab data={data}/></TabsContent>
      <TabsContent value="guide" className="mt-3"><PinnedGuide base={base} run={run}/></TabsContent>
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
export function RunDeck({ base, data, feed, view, active, panel, onPanel, tab, onTab, watch, onWatch, viewNote, busy, message,
  error, announce, onBack, onStop, onRefresh, onReview, onFrame, liveView = null, me = null, onTakeover, onEndTakeover,
  onResume, onOpenRun, onDecide }) {
  const statusId = useId();
  const railId = useId(), railNav = useRef(null);
  const [railTab, setRailTab] = useState(active ? 'activity' : 'details');
  const open = data.approvals.find(a => a.open) ?? null;
  const shown = key => `${panel === key ? 'flex' : 'hidden'} ${railTab === key ? 'lg:flex' : 'lg:hidden'}`;
  const railTabs = [['activity', 'Activity'], ['guide', 'Guide'], ['details', 'Details']];
  const selectRail = key => setRailTab(key);
  const railKey = event => {
    const index = railTabs.findIndex(([key]) => key === railTab);
    const next = event.key === 'ArrowRight' ? (index + 1) % 3 : event.key === 'ArrowLeft' ? (index + 2) % 3
      : event.key === 'Home' ? 0 : event.key === 'End' ? 2 : null;
    if (next === null) return;
    event.preventDefault(); selectRail(railTabs[next][0]); railNav.current?.children[next]?.focus();
  };
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
    <div className={`min-w-0 space-y-4 lg:space-y-0 lg:grid lg:h-[calc(100dvh-11rem)] lg:min-h-[32rem] lg:grid-cols-[minmax(0,1.65fr)_minmax(320px,1fr)] ${open ? 'lg:grid-rows-[auto_minmax(0,1fr)]' : 'lg:grid-rows-[minmax(0,1fr)]'} lg:gap-4`} data-run-workspace>
      {open && <ApprovalBanner approval={open} compact={panel !== 'browser'} onReview={() => onReview(open.id)}/>}
      <BrowserPane className={`${panel === 'browser' ? 'flex' : 'hidden'} lg:flex lg:col-start-1 lg:row-start-1 ${open ? 'lg:row-span-2' : ''}`} data={data} active={active} live={view.live} watch={watch} onWatch={onWatch}
        onEnlarge={onFrame} viewNote={viewNote} liveView={liveView} me={me} busy={busy} onTakeover={onTakeover}
        onEndTakeover={onEndTakeover}/>
      <aside aria-label="Run context" className={`operations-card ${panel === 'browser' && !data.run.help && !data.reconciliation?.items?.length ? 'hidden lg:flex' : 'flex'} flex-col rounded-md border bg-card min-w-0 lg:min-h-0 lg:col-start-2 ${open ? 'lg:row-start-2' : 'lg:row-start-1'}`} data-run-context>
        {(data.run.help || data.reconciliation?.items?.length > 0) && <div className="space-y-3 p-4 border-b lg:max-h-[45%] lg:overflow-y-auto">
          <HelpBanner help={data.run.help}/>
          <ReconcilePanel data={data} busy={busy} onDecide={onDecide}/>
        </div>}
        <div ref={railNav} role="tablist" aria-label="Run context panels" onKeyDown={railKey} className="hidden lg:flex border-b px-3">
          {railTabs.map(([key, label]) => <button key={key} type="button" role="tab" id={`${railId}-${key}-tab`}
            aria-label={label} aria-controls={`${railId}-${key}`} aria-selected={railTab === key} tabIndex={railTab === key ? 0 : -1}
            onClick={() => selectRail(key)} className={`min-h-11 flex flex-1 items-center justify-center gap-2 border-b-2 px-3 text-sm font-medium ${railTab === key ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground'}`}>{label}
            {key === 'activity' && <span aria-hidden="true" className="rounded-full bg-muted px-1.5 text-xs text-foreground">{feed.length}</span>}</button>)}
        </div>
        <div id={`${railId}-activity`} role="tabpanel" aria-labelledby={`${railId}-activity-tab`} className={`${shown('activity')} flex-col min-w-0 lg:flex-1 lg:min-h-0`}>
          <ActivityColumn className="flex" feed={feed} data={data} thumbs={view.thumbs} visible={`${panel}:${railTab}`} onFrame={onFrame}/>
        </div>
        <div id={`${railId}-guide`} role="tabpanel" aria-labelledby={`${railId}-guide-tab`} className={`${railTab === 'guide' ? 'hidden lg:block' : 'hidden'} p-4 min-w-0 lg:flex-1 lg:min-h-0 lg:overflow-y-auto`}>
          {railTab === 'guide' && <PinnedGuide base={base} run={data.run}/>}
        </div>
        <div id={`${railId}-details`} role="tabpanel" aria-labelledby={`${railId}-details-tab`} className={`${shown('details')} flex-col p-4 min-w-0 lg:flex-1 lg:min-h-0 lg:overflow-y-auto`}>
          <RunDetails base={base} className="block" data={data} tab={tab} onTab={onTab} busy={busy}
            statusId={statusId} onRefresh={onRefresh}/>
        </div>
      </aside>
    </div>
    <nav aria-label={DECK_TEXT.panels} className="fixed inset-x-0 bottom-0 z-30 md:sticky lg:hidden">
      <MobilePanelBar panels={panels} current={panel} onSelect={onPanel}/>
    </nav>
  </div>;
}
