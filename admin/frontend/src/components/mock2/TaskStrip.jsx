// TaskStrip — the one line above the build chat's composer that says which
// task Flightdeck remembers right now and what can be done about it:
// "Building: …", "Resuming build: …", "Investigating: …", "Interrupted: …"
// (Resume / Stop), "Stopped with an error: …" (Try again), "Blocked: …"
// (Resume) or "Waiting on you: …" (Show). Fed by the chat poll's
// `current_task`; the words and the state mapping live in task-strip-logic.js.
//
// Why it exists: a task outlives the chat. After a reload, a dropped
// connection or a restarted worker the person must see — without doing
// anything — that the build is still running or where it stopped, and what
// will be checked before anything is repeated.
//
// MOBILE_FIRST: compact at rest because every pixel here is a line of
// conversation lost on a 360px screen — a live task is ONE row (status + goal
// clipped to one line, the current step under it); a task with actions adds
// one line for the next step and the 44px buttons (rule 4: actions stack,
// they never squeeze the status). The details expand on tap and scroll inside
// a bounded box so server-length text never sizes the column.

import { useEffect, useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  AlertTriangle, ChevronDown, HelpCircle, Loader2, PauseCircle, Play, RotateCcw, ShieldAlert, StopCircle,
} from 'lucide-react';
import { describeTask, taskDetails } from './task-strip-logic';

const TONES = {
  live: { box: 'border-sky-500/30 bg-sky-500/5', icon: 'text-sky-500' },
  paused: { box: 'border-amber-500/40 bg-amber-500/10', icon: 'text-amber-600 dark:text-amber-400' },
  error: { box: 'border-red-500/40 bg-red-500/10', icon: 'text-red-600 dark:text-red-400' },
  blocked: { box: 'border-amber-500/40 bg-amber-500/10', icon: 'text-amber-600 dark:text-amber-400' },
  waiting: { box: 'border-primary/30 bg-primary/5', icon: 'text-primary' },
};
const ICONS = {
  building: Loader2, resuming: Loader2, investigating: Loader2,
  interrupted: PauseCircle, failed: AlertTriangle, blocked: ShieldAlert, waiting: HelpCircle,
};

export default function TaskStrip({
  task,
  // Editors act; viewers see the same strip without buttons.
  canAct = false,
  // Resuming needs the project's container; Stop does not.
  online = true,
  // 'resume' | 'stop' | null — which of this strip's requests is in flight.
  busy = null,
  // Another send is in flight in the composer: hold the buttons.
  disabled = false,
  // The composer holds text that a Resume would carry as guidance.
  guidancePending = false,
  // The running build's / answer's current step (live tasks only).
  currentAction = null,
  onResume, onStop, onShow,
}) {
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();
  // A different task opens at rest — an expansion belongs to the task it was
  // opened on.
  useEffect(() => { setExpanded(false); }, [task?.key]);

  const view = describeTask(task);
  if (!view) return null;
  const details = taskDetails(task);
  const tone = TONES[view.tone] || TONES.waiting;
  const Icon = ICONS[view.state] || HelpCircle;
  const spinning = view.live && Icon === Loader2;
  const stopInDetails = canAct && view.stop === 'details' && !!onStop;
  const expandable = details.any || view.checkFirst.length > 0 || stopInDetails;
  const secondary = view.live
    ? (String(currentAction || '').trim() || details.done[details.done.length - 1] || null)
    : view.detail;
  const anyBusy = !!busy || disabled;
  const resumeTitle = !online
    ? 'Bring the project online to resume'
    : guidancePending
      ? `${view.resumeLabel} — the text in the message box rides along as guidance`
      : view.investigation
        ? 'Continue this investigation — read-only, nothing is changed'
        : `${view.resumeLabel} from the last checkpoint — what was uncertain is checked before anything is repeated`;

  const toggle = () => setExpanded((v) => !v);
  const fullTitle = `${view.label}: ${view.subject}${view.subject !== view.goal ? ` — ${view.goal}` : ''}`;

  const actions = [];
  if (canAct && view.resumeLabel && onResume) {
    actions.push(
      <Button
        key="resume" type="button" size="sm" className="h-11 sm:h-8 shrink-0 px-3"
        disabled={anyBusy || !online}
        onClick={onResume}
        title={resumeTitle}
      >
        {/* Icons from sm up: on a phone the next-step text needs the width. */}
        {busy === 'resume'
          ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
          : view.resumeLabel === 'Try again'
            ? <RotateCcw className="hidden sm:block h-3.5 w-3.5 mr-1" />
            : <Play className="hidden sm:block h-3.5 w-3.5 mr-1" />}
        {view.resumeLabel}
      </Button>,
    );
  }
  if (canAct && view.stop === 'row' && onStop) {
    actions.push(
      <Button
        key="stop" type="button" size="sm" variant="outline" className="h-11 sm:h-8 shrink-0 px-3"
        disabled={anyBusy}
        onClick={onStop}
        title="Stop this task — it stays stopped unless you resume it"
      >
        {busy === 'stop' ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <StopCircle className="hidden sm:block h-3.5 w-3.5 mr-1" />}
        Stop
      </Button>,
    );
  }
  if (view.show && onShow) {
    actions.push(
      <Button
        key="show" type="button" size="sm" variant="ghost"
        className="h-11 sm:h-8 shrink-0 px-2 underline underline-offset-2"
        onClick={onShow}
        title="Show what it is waiting on in the chat"
      >
        Show
      </Button>,
    );
  }
  // Line 1 is ALWAYS the full width: the status word and the goal are what
  // the strip is for, and the chat column is ~300px on a phone AND in
  // Flightdeck's desktop chat pane — sharing the line with two 44px labelled
  // buttons clipped "Interrupted" to "Interr…". So the actions stack onto
  // line 2 beside the secondary text (MOBILE_FIRST rule 4), and a strip with
  // no actions (a live task) stays one two-line row.
  const twoLines = actions.length > 0;
  const labelBody = (
    <>
      <Icon className={`h-4 w-4 shrink-0 ${tone.icon} ${spinning ? 'animate-spin' : ''}`} aria-hidden="true" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs">
          <span className="font-medium">{view.label}:</span> {view.subject}
        </span>
        {!twoLines && secondary ? (
          <span className="block truncate text-[11px] text-muted-foreground">{secondary}</span>
        ) : null}
      </span>
      {expandable ? (
        <ChevronDown
          className={`h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform ${expanded ? 'rotate-180' : ''}`}
          aria-hidden="true"
        />
      ) : null}
    </>
  );
  // Expand target: 44px on a phone when it is the only thing on the row; a
  // dense 32px line above the 44px action buttons otherwise.
  const labelClass = `flex w-full min-w-0 items-center gap-2 rounded text-left ${twoLines ? 'min-h-[32px] sm:min-h-[28px]' : 'min-h-[44px] sm:min-h-[32px]'}`;

  const checkFirst = view.checkFirst;
  return (
    <section
      aria-label="Current task"
      data-task-strip=""
      data-task-state={view.state}
      className={`shrink-0 rounded-md border px-2 py-1 ${tone.box}`}
    >
      {/* State changes are announced once; the visible row is not a live
          region, so expanding it does not read everything out again. */}
      <span className="sr-only" role="status">{`${view.label}: ${view.subject}`}</span>
      {expandable ? (
        <button
          type="button"
          data-task-toggle=""
          className={`${labelClass} hover:bg-foreground/5 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring`}
          onClick={toggle}
          aria-expanded={expanded}
          aria-controls={detailsId}
          title={fullTitle}
        >
          {labelBody}
        </button>
      ) : (
        <div className={labelClass} title={fullTitle}>{labelBody}</div>
      )}
      {twoLines ? (
        <div className="flex items-center gap-2">
          {/* pl-6 lines the text up under the status words, past the icon. */}
          <span className="min-w-0 flex-1 truncate pl-6 text-[11px] text-muted-foreground" title={secondary || undefined}>
            {secondary}
          </span>
          {actions}
        </div>
      ) : null}

      {/* What will be checked before anything is repeated — safety, so it
          shows at rest: one line + "more" on a phone, the first few on wider
          screens, everything once expanded. */}
      {checkFirst.length ? (
        expanded ? (
          <div className="mt-0.5 pb-1 text-[11px]">
            <p className="font-medium">Will check first:</p>
            <ul className="list-disc space-y-0.5 pl-4 text-muted-foreground">
              {checkFirst.map((u, i) => <li key={i} className="break-words">{u}</li>)}
            </ul>
          </div>
        ) : (
          <>
            <button
              type="button"
              className="flex min-h-[28px] w-full min-w-0 items-center gap-1 text-left text-[11px] sm:hidden"
              onClick={toggle}
              aria-expanded={false}
              aria-controls={detailsId}
            >
              <span className="shrink-0 font-medium">Will check first:</span>
              <span className="min-w-0 flex-1 truncate text-muted-foreground">{checkFirst[0]}</span>
              {/* Foreground + underline, not the primary green: green on the
                  amber/red tints fails contrast in the midnight theme. */}
              <span className="shrink-0 font-medium underline underline-offset-2">more</span>
            </button>
            <div className="hidden pb-1 text-[11px] sm:block">
              <p className="font-medium">Will check first:</p>
              <ul className="list-disc space-y-0.5 pl-4 text-muted-foreground">
                {checkFirst.slice(0, 3).map((u, i) => <li key={i} className="line-clamp-2 break-words">{u}</li>)}
              </ul>
              {checkFirst.length > 3 ? (
                <button
                  type="button" onClick={toggle}
                  className="min-h-[28px] font-medium underline underline-offset-2"
                  aria-expanded={false} aria-controls={detailsId}
                >
                  {checkFirst.length - 3} more
                </button>
              ) : null}
            </div>
          </>
        )
      ) : null}

      {expanded ? (
        // Focusable so a keyboard can scroll it (it is bounded and scrolls).
        <div
          id={detailsId}
          role="region"
          aria-label="Task details"
          tabIndex={0}
          className="mb-1 mt-0.5 max-h-48 space-y-1.5 overflow-y-auto rounded-sm border-t border-foreground/10 pt-1.5 text-[11px] text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          {details.nextStep ? (
            <p className="break-words"><span className="font-medium text-foreground">Next step:</span> {details.nextStep}</p>
          ) : null}
          {details.lastVerified ? (
            <p className="break-words"><span className="font-medium text-foreground">Last verified:</span> {details.lastVerified}</p>
          ) : null}
          {details.blockers.length ? (
            <div>
              <p className="font-medium text-foreground">Blocked by:</p>
              <ul className="list-disc pl-4">{details.blockers.map((b, i) => <li key={i} className="break-words">{b}</li>)}</ul>
            </div>
          ) : null}
          {details.remaining.length ? (
            <div>
              <p className="font-medium text-foreground">Still to do:</p>
              <ul className="list-disc pl-4">{details.remaining.map((r, i) => <li key={i} className="break-words">{r}</li>)}</ul>
            </div>
          ) : null}
          {details.checks.length ? (
            <p className="break-words">
              <span className="font-medium text-foreground">Checks:</span>{' '}
              {details.checks.map((c) => `${c.key}${c.status ? ` ${c.status}` : ''}`).join(' · ')}
            </p>
          ) : null}
          {details.done.length ? (
            <div>
              <p className="font-medium text-foreground">Done so far:</p>
              <ul className="list-disc pl-4">{details.done.map((d, i) => <li key={i} className="break-words">{d}</li>)}</ul>
            </div>
          ) : null}
          {stopInDetails ? (
            <Button
              type="button" size="sm" variant="outline" className="h-11 sm:h-8"
              disabled={anyBusy} onClick={onStop}
              title="Stop this task — it stays stopped unless you resume it"
            >
              {busy === 'stop' ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <StopCircle className="h-3.5 w-3.5 mr-1" />}
              Stop this task
            </Button>
          ) : null}
          {details.folder ? (
            <p className="break-all text-[10px]">Saved with the project in {details.folder}</p>
          ) : null}
        </div>
      ) : (
        // aria-controls must name an element that exists.
        <div id={detailsId} hidden />
      )}
    </section>
  );
}
