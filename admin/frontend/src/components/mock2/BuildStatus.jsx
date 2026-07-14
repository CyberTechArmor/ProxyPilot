// BuildStatus — the build information panel (left column in build mode).
//
// Everything that describes the build rather than drives the conversation: the
// framework-drift banner, the live Claude-Code-style task list, the current/last
// cycle's status + spend, deploy sub-state, retry/interrupt controls, and the
// hash-chained change history with its chain-verification badge. The composer
// that starts a cycle lives in BuildChat (right column); cycle polling is owned
// by the BuildMode parent, which passes cycle + job in.
//
// MOBILE_FIRST: single column, wrapping button rows, 44px targets; clean at 360px.

import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { useToast } from '@/hooks/use-toast';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import {
  Hammer, RefreshCw, Loader2, Square, RotateCcw, ShieldAlert, ShieldCheck, Clock, GitBranch,
  CheckCircle2, Ban, PauseCircle, Play, ThumbsUp, ThumbsDown,
} from 'lucide-react';
import BuildTaskList from './BuildTaskList';
import ChangeHistory from './ChangeHistory';

const STATUS_TONE = {
  running: 'text-cyan-500', succeeded: 'text-green-500', failed: 'text-red-500',
  refused_quota: 'text-red-500', awaiting_user: 'text-violet-500', awaiting_admin: 'text-amber-500',
  interrupted: 'text-amber-500', abandoned: 'text-muted-foreground', queued: 'text-blue-500', estimating: 'text-blue-500',
};

// How each typed halt-resolution kind reads on the choice card. adminOnly kinds
// (grant an authorization, override a rule) can only be picked by an admin — that's
// where Grant/Deny folds into choosing/rejecting the option.
const HALT_KIND_META = {
  grant_authorization: { label: 'Grant once', adminOnly: true },
  override_rule: { label: 'Override rule', adminOnly: true },
  expand_scope: { label: 'Expand scope', adminOnly: false },
  run_dependency_first: { label: 'Run dependency first', adminOnly: false },
  abandon: { label: 'Abandon', adminOnly: false },
};

export default function BuildStatus({
  projectId, canEdit, isAdmin, online, project, cycle, job, busy,
  onRetry, onRetryDeploy, onInterrupt, onRemediate, onStopAll, onRefresh,
  needsFeedback = false, onFeedback,
}) {
  const { toast } = useToast();
  const [view, setView] = useState('build'); // 'build' | 'changes'
  const [deviations, setDeviations] = useState([]); // open framework_deviation queue items (admin)
  const [devBusy, setDevBusy] = useState(false);
  const [fbRating, setFbRating] = useState(null); // 'up' | 'down' | null — note composer open for this rating
  const [note, setNote] = useState('');
  const [fbBusy, setFbBusy] = useState(false);
  const [resumeMsg, setResumeMsg] = useState(''); // operator guidance carried on resume / with a chosen option
  const [otherText, setOtherText] = useState(''); // free-text "Other" resolution (the escape hatch)
  const [resuming, setResuming] = useState(false);
  const [auths, setAuths] = useState([]); // open one-time authorization requests
  const [authBusy, setAuthBusy] = useState(false);
  const [devEdit, setDevEdit] = useState({}); // deviation id -> edited text (approve-as-edited)

  const active = cycle && ['queued', 'estimating', 'running', 'awaiting_user', 'awaiting_admin'].includes(cycle.status);
  // A soft-paused cycle ('interrupted' + pause_reason) is a resumable checkpoint,
  // not a failure — it gets its own label + one-click Resume, distinct from a
  // plain user interrupt.
  const paused = cycle?.status === 'interrupted' && !!cycle?.pause_reason;
  // A HALTED cycle (the build could not honestly finish, or the no-progress breaker
  // tripped) is 'awaiting_admin' + halt_reason. Distinct from success, from a user
  // stop, and from a deviation block (which has no error): needs-attention, resumable.
  const blocked = cycle?.status === 'awaiting_admin' && !!cycle?.halt_reason;
  const HALT_LABELS = {
    model_halt: 'the build reported it was blocked',
    no_tool_calls: 'no progress — repeated turns with no action',
    repeated_output: 'no progress — the same response repeated without changes',
    no_state_change: 'no progress — repeated the same action with no change',
    max_turns: 'reached the step ceiling without finishing',
  };
  const statusLabel = blocked ? 'blocked' : paused ? 'paused' : cycle ? cycle.status.replace(/_/g, ' ') : '';
  // Any non-successful terminal build can be continued (soft retry — it resumes
  // from the checkpoint/working tree in the container, no work lost). A soft
  // pause has its own Resume block and a deploy failure its own Retry deploy /
  // Rebuild controls, so both are excluded here.
  const FAILED_TERMINAL = ['failed', 'abandoned', 'refused_quota', 'interrupted'];
  const canContinueFailed = !!cycle && !paused && !blocked && cycle.deploy_status !== 'deploy_failed'
    && (FAILED_TERMINAL.includes(cycle.status) || (cycle.status === 'awaiting_admin' && cycle.error));
  const driftAvailable = !!project?.framework_update_available;

  // Admins can approve/deny a framework deviation right here (no trip to the
  // admin queue). Load the project's OPEN deviations while the build is blocked
  // on one. mock2ListQueue + mock2SetQueueItemStatus are the existing admin-gated,
  // audit-logged endpoints — the queue rows are themselves the durable log.
  const blockedOnDeviation = cycle?.status === 'awaiting_admin' && !cycle?.error;
  const loadDeviations = useCallback(async () => {
    if (!isAdmin) return;
    try {
      const r = await api.mock2ListQueue({ project_id: projectId, status: 'open', kind: 'framework_deviation' });
      setDeviations(r.items || []);
    } catch (err) {
      if (!(err instanceof ApiError)) console.error('load deviations failed:', err);
    }
  }, [isAdmin, projectId]);

  useEffect(() => {
    if (isAdmin && blockedOnDeviation) loadDeviations();
    else setDeviations([]);
  }, [isAdmin, blockedOnDeviation, loadDeviations]);

  const decideDeviation = async (item, status) => {
    setDevBusy(true);
    try {
      // Approve-as-edited: if the admin edited the deviation text, send it so the
      // EDITED text becomes the authoritative APPROVED record handed to the runner.
      const edited = status === 'resolved' ? (devEdit[item.id] || '').trim() : '';
      const extra = edited ? { editedText: edited } : {};
      const res = await api.mock2SetQueueItemStatus(item.id, status, status === 'resolved' ? (edited ? 'approved as edited' : 'approved from project') : 'denied from project', extra);
      toast({
        title: status === 'resolved' ? (edited ? 'Deviation approved (as edited)' : 'Deviation approved') : 'Deviation denied',
        description: res?.resumed ? 'The build resumes now.' : undefined,
      });
      await loadDeviations();
      if (onRefresh) onRefresh();
    } catch (err) {
      toast({ variant: 'destructive', title: 'Could not update the deviation', description: err.message });
    } finally { setDevBusy(false); }
  };

  // Resume the blocked/paused cycle, optionally carrying operator guidance
  // (a free-text message and/or a chosen halt resolution option).
  const doResume = async (extra = null) => {
    if (!cycle) return;
    setResuming(true);
    try {
      const res = await api.mock2RetryCycle(projectId, cycle.id, extra);
      setResumeMsg('');
      setOtherText('');
      if (res?.abandoned) {
        toast({ title: 'Build abandoned', description: 'The cycle was closed as abandoned.' });
      } else {
        toast({ title: 'Resuming the build', description: extra && (extra.option || extra.message) ? 'Your selection is included.' : undefined });
      }
      if (onRefresh) onRefresh();
    } catch (err) {
      toast({ variant: 'destructive', title: 'Could not resume', description: err.message });
    } finally { setResuming(false); }
  };

  // Load the project's OPEN one-time authorization requests while a build is blocked,
  // so the card can show them (and let an admin grant/deny in place).
  const loadAuths = useCallback(async () => {
    try { const r = await api.mock2ListAuthorizations(projectId); setAuths(r.authorizations || []); }
    catch (err) { if (!(err instanceof ApiError)) console.error('load authorizations failed:', err); }
  }, [projectId]);
  useEffect(() => {
    if (blocked) loadAuths(); else setAuths([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blocked, loadAuths]);

  const decideAuth = async (auth, approved) => {
    setAuthBusy(true);
    try {
      await api.mock2DecideAuthorization(projectId, auth.id, approved, null);
      toast({ title: approved ? 'Authorization granted (one-time)' : 'Authorization denied' });
      await loadAuths();
      if (onRefresh) onRefresh();
    } catch (err) {
      toast({ variant: 'destructive', title: 'Could not decide the authorization', description: err.message });
    } finally { setAuthBusy(false); }
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2"><Hammer className="h-4 w-4" /> Build</CardTitle>
        <CardDescription>
          Describe a change in the build chat. Each build audits the change against the rules and framework, edits
          the code in the fenced container, runs the pinned gate battery, and checkpoints into the repo.
        </CardDescription>
        {/* Build panel OR the change history — one at a time (pill toggle). */}
        <div className="inline-flex self-start rounded-md border p-0.5 mt-1" role="tablist" aria-label="Build view">
          <button
            type="button" role="tab" aria-selected={view === 'build'}
            onClick={() => setView('build')}
            className={`inline-flex items-center gap-1 rounded px-2.5 py-1.5 text-xs font-medium ${view === 'build' ? 'bg-muted text-foreground' : 'text-muted-foreground'}`}
          >
            <Hammer className="h-3.5 w-3.5" /> Build
          </button>
          <button
            type="button" role="tab" aria-selected={view === 'changes'}
            onClick={() => setView('changes')}
            className={`inline-flex items-center gap-1 rounded px-2.5 py-1.5 text-xs font-medium ${view === 'changes' ? 'bg-muted text-foreground' : 'text-muted-foreground'}`}
          >
            <GitBranch className="h-3.5 w-3.5" /> Change history
          </button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {view === 'changes' ? <ChangeHistory projectId={projectId} /> : (
        <>{/* ---- Build panel ---- */}
        {/* Drift banner (ADR-003) — the framework moved since the last build. */}
        {driftAvailable ? (
          <div className="flex flex-col gap-2 rounded-lg border border-sky-500/30 bg-sky-500/5 p-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm text-sky-600 flex items-start gap-2">
              <RefreshCw className="h-4 w-4 mt-0.5 shrink-0" />
              <span>
                Framework update available
                {project?.framework_last_built_version && project?.framework_current_version
                  ? ` (v${project.framework_last_built_version} → v${project.framework_current_version})` : ''}.
                Nothing changes until you run an update cycle.
              </span>
            </p>
            {canEdit && online && !active ? (
              <Button variant="outline" size="sm" className="h-10 shrink-0 self-start sm:self-auto" disabled={busy} onClick={onRemediate}>
                Start update cycle
              </Button>
            ) : null}
          </div>
        ) : null}

        {!online ? (
          <p className="text-sm text-muted-foreground">Bring the project online to run a build.</p>
        ) : null}

        {/* Live / last cycle */}
        {cycle ? (
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div className="min-w-0">
                <p className="text-sm font-medium truncate">{cycle.instruction || '(cycle)'}</p>
                <p className={`text-xs font-medium ${blocked ? 'text-orange-500' : paused ? 'text-amber-500' : STATUS_TONE[cycle.status] || 'text-muted-foreground'}`}>
                  {statusLabel}{cycle.current_gate ? ` · ${cycle.current_gate}` : ''}
                </p>
              </div>
              <div className="text-xs text-muted-foreground whitespace-nowrap">
                {cycle.used_cost_cents ? `$${(cycle.used_cost_cents / 100).toFixed(2)}` : '$0.00'} · {cycle.used_tokens || 0} tok
              </div>
            </div>

            {/* The Claude-Code-style task list — what's running and how many steps are left. */}
            <BuildTaskList cycle={cycle} job={job} />

            {cycle.error && !paused && !blocked ? <p className="text-xs text-red-500 break-words">{cycle.error}</p> : null}

            {/* Blocked — the build could not honestly finish (it called halt), or
                the no-progress circuit breaker stopped a stuck loop. Needs human
                attention; resumable once the blocker is cleared. Distinct from a
                success, a user stop, and a soft budget pause. */}
            {blocked ? (
              <div className="space-y-2 rounded-md border border-orange-500/30 bg-orange-500/5 p-3">
                <p className="text-xs text-orange-600 flex items-start gap-1">
                  <ShieldAlert className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                  <span>
                    <span className="font-medium">Blocked — needs attention.</span>{' '}
                    {HALT_LABELS[cycle.halt_reason] || 'The build stopped without finishing.'}
                    {cycle.error ? <span className="block mt-1 text-orange-700/90 break-words">{cycle.error}</span> : null}
                    {' '}Your work so far is checkpointed — add context or resolve the blocker, then resume.
                  </span>
                </p>

                {/* One choice card (task Part 2): the model's 2–4 proposed resolutions
                    as radio-style choices + a free-text "Other". Picking one resumes the
                    build automatically, injecting the choice (+ any context) as guidance;
                    a grant_authorization option shows the exact scope/rows inline and its
                    selection IS the admin grant. Abandon closes the cycle. */}
                {canEdit && online && (cycle.halt_options || []).length ? (
                  <div className="space-y-2.5 rounded-md border border-orange-500/30 bg-background/50 p-2.5">
                    <p className="text-[11px] font-medium text-orange-600">
                      Choose how to resolve — your pick resumes the build (add context below if it helps):
                    </p>
                    <textarea
                      className="flex min-h-[44px] w-full rounded-md border border-input bg-transparent px-3 py-2 text-xs shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-60"
                      placeholder="Optional context, included with whichever option you pick (e.g. “the test row is safe to remove”)…"
                      value={resumeMsg}
                      disabled={resuming}
                      onChange={(e) => setResumeMsg(e.target.value)}
                    />
                    <div className="flex flex-col gap-1.5" role="radiogroup" aria-label="Resolution options">
                      {cycle.halt_options.map((o) => {
                        const meta = HALT_KIND_META[o.kind] || {};
                        const adminOnly = meta.adminOnly;
                        const blockedForRole = adminOnly && !isAdmin;
                        const auth = o.authorization && o.authorization.scope ? o.authorization : null;
                        return (
                          <div key={o.id} className="space-y-1">
                            <Button
                              variant="outline" size="sm" role="radio" aria-checked={false}
                              className={`h-auto min-h-11 w-full justify-start whitespace-normal py-2 ${o.recommended ? 'border-emerald-500/50 ring-1 ring-emerald-500/20' : ''}`}
                              disabled={resuming || blockedForRole}
                              onClick={() => doResume({ option: o.id, ...(resumeMsg.trim() ? { message: resumeMsg.trim() } : {}) })}
                            >
                              {o.kind === 'abandon' ? <Ban className="h-4 w-4 mr-2 shrink-0 text-red-500" />
                                : o.kind === 'grant_authorization' || o.kind === 'override_rule' ? <ShieldCheck className="h-4 w-4 mr-2 shrink-0" />
                                  : <Play className="h-4 w-4 mr-2 shrink-0" />}
                              <span className="text-left min-w-0">
                                <span className="flex flex-wrap items-center gap-1.5">
                                  <span className="font-medium">{o.label}</span>
                                  {o.recommended ? <span className="rounded-full bg-emerald-500/15 text-emerald-600 text-[10px] font-medium px-1.5 py-0.5">Recommended</span> : null}
                                  {meta.label ? <span className="rounded-full bg-muted text-muted-foreground text-[10px] px-1.5 py-0.5">{meta.label}{adminOnly ? ' · admin' : ''}</span> : null}
                                </span>
                                {o.risk || o.detail ? <span className="block text-[11px] text-muted-foreground mt-0.5">{o.risk || o.detail}</span> : null}
                                {auth ? (
                                  <span className="block mt-1 text-[11px] break-words">
                                    <code className="break-all">{auth.scope}</code>
                                    {auth.expectedRows != null && auth.expectedRows !== '' ? <span className="text-muted-foreground"> · expects {auth.expectedRows} row(s)</span> : null}
                                  </span>
                                ) : null}
                              </span>
                            </Button>
                            {blockedForRole ? <p className="text-[11px] text-muted-foreground pl-1">An admin must choose this one.</p> : null}
                          </div>
                        );
                      })}
                    </div>
                    {/* Free-text "Other" escape hatch — resumes with the typed guidance, no option. */}
                    <div className="flex items-end gap-2 pt-0.5">
                      <textarea
                        className="flex min-h-[44px] flex-1 rounded-md border border-input bg-transparent px-3 py-2 text-xs shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-60"
                        placeholder="Or describe your own resolution…"
                        value={otherText}
                        disabled={resuming}
                        onChange={(e) => setOtherText(e.target.value)}
                      />
                      <Button size="sm" className="h-9 shrink-0" disabled={resuming || !otherText.trim()} onClick={() => doResume({ message: otherText.trim() })}>
                        {resuming ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Resume'}
                      </Button>
                    </div>
                  </div>
                ) : null}

                {/* Legacy path (no proposed options): a standalone request_authorization
                    grant/deny + a plain resume, kept for older halts and breaker stops. */}
                {!(cycle.halt_options || []).length && auths.length ? (
                  <div className="space-y-2">
                    {auths.map((a) => (
                      <div key={a.id} className="rounded-md border border-orange-500/30 bg-background/50 p-2 space-y-1.5">
                        <p className="text-xs break-words"><span className="font-medium">Requested one-time authorization:</span> <code className="text-[11px] break-all">{a.scope}</code></p>
                        {a.reason ? <p className="text-[11px] text-muted-foreground break-words">{a.reason}</p> : null}
                        {isAdmin ? (
                          <div className="flex flex-wrap gap-2">
                            <Button size="sm" className="h-9" disabled={authBusy} onClick={() => decideAuth(a, true)}>
                              {authBusy ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <CheckCircle2 className="h-4 w-4 mr-1" />}Grant once
                            </Button>
                            <Button variant="outline" size="sm" className="h-9 text-red-500" disabled={authBusy} onClick={() => decideAuth(a, false)}>
                              <Ban className="h-4 w-4 mr-1" />Deny
                            </Button>
                          </div>
                        ) : (
                          <p className="text-[11px] text-muted-foreground">An admin must grant this before the build can proceed.</p>
                        )}
                      </div>
                    ))}
                  </div>
                ) : null}

                {!(cycle.halt_options || []).length && canEdit && online ? (
                  <div className="space-y-1.5">
                    <textarea
                      className="flex min-h-[48px] w-full rounded-md border border-input bg-transparent px-3 py-2 text-xs shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-60"
                      placeholder="Optional: add context or an instruction for the resume (e.g. “the test row is safe to remove”)…"
                      value={resumeMsg}
                      disabled={resuming}
                      onChange={(e) => setResumeMsg(e.target.value)}
                    />
                    <Button size="sm" className="h-9" disabled={resuming} onClick={() => doResume(resumeMsg.trim() ? { message: resumeMsg.trim() } : null)}>
                      {resuming ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Play className="h-4 w-4 mr-1" />}
                      {resumeMsg.trim() ? 'Resume with message' : 'Resume build'}
                    </Button>
                  </div>
                ) : null}
              </div>
            ) : null}

            {/* Soft-paused on a token/time budget — a resumable checkpoint, not a
                failure. One-click Resume continues from where it stopped with a
                fresh budget window. */}
            {paused ? (
              <div className="space-y-2 rounded-md border border-amber-500/30 bg-amber-500/5 p-3">
                <p className="text-xs text-amber-600 flex items-start gap-1">
                  <PauseCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                  {cycle.error || 'Build paused on a token/time budget.'} Your work so far is checkpointed —
                  resuming continues from there with a fresh budget.
                </p>
                {canEdit && online ? (
                  <Button size="sm" className="h-9" disabled={busy} onClick={onRetry}>
                    {busy ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Play className="h-4 w-4 mr-1" />}
                    Resume build
                  </Button>
                ) : null}
              </div>
            ) : null}

            {/* Deploy that failed — distinct, retryable. Offer a deploy-only
                retry (redeploy the existing checkpoint — no rebuild) alongside
                the full build retry. */}
            {cycle.status === 'failed' && cycle.deploy_status === 'deploy_failed' ? (
              <div className="space-y-2">
                <p className="text-xs text-red-500 flex items-start gap-1">
                  <ShieldAlert className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                  The change passed its gates but the app did not deploy. Retry the deploy to redeploy the existing
                  build, or fix the cause in the build chat and run a new build.
                </p>
                {canEdit && online ? (
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" className="h-9" disabled={busy} onClick={onRetryDeploy}>
                      {busy ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <RotateCcw className="h-4 w-4 mr-1" />}
                      Retry deploy
                    </Button>
                    <Button variant="outline" size="sm" className="h-9" disabled={busy} onClick={onRetry}>
                      <Hammer className="h-4 w-4 mr-1" />Rebuild
                    </Button>
                  </div>
                ) : null}
              </div>
            ) : null}

            {/* Audit gate (ADR-002) — blocked on a routed question. */}
            {cycle.status === 'awaiting_user' ? (
              <p className="text-xs text-violet-500 flex items-start gap-1">
                <Clock className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                Answer the rule question(s) in the build chat — the build starts automatically once every one is confirmed.
              </p>
            ) : null}
            {/* awaiting_admin, EXCLUDING a governance halt (which has its own blocked
                card above). The "transient error / billing" copy applies only to a
                real retries-exhausted stall (error present, no halt_reason), never to
                a governance halt. */}
            {cycle.status === 'awaiting_admin' && !blocked ? (
              <p className="text-xs text-amber-500 flex items-start gap-1">
                <ShieldAlert className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                {cycle.error
                  ? 'The build stalled on a transient error (e.g. a model rate limit). Once the cause is cleared, retry to continue where it stopped.'
                  : isAdmin
                    ? 'A framework deviation needs an admin decision. Approve it (optionally as edited) to unblock the build, or deny it — either way it’s logged.'
                    : 'A framework deviation was sent to the admin queue — the build resumes once an admin resolves it.'}
              </p>
            ) : null}

            {/* Admin: approve/deny the blocking framework deviation in-place. */}
            {isAdmin && blockedOnDeviation && deviations.length ? (
              <div className="space-y-2">
                {deviations.map((d) => (
                  <div key={d.id} className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3 space-y-2">
                    <p className="text-xs text-foreground/90 break-words">{d.detail || 'Framework deviation'}</p>
                    {/* Approve-as-edited: rewrite the deviation / append conditions.
                        The edited text becomes the authoritative APPROVED record. */}
                    <textarea
                      className="flex min-h-[48px] w-full rounded-md border border-input bg-transparent px-3 py-2 text-xs shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-60"
                      placeholder="Optional: edit the deviation or append conditions before approving…"
                      value={devEdit[d.id] || ''}
                      disabled={devBusy}
                      onChange={(e) => setDevEdit((m) => ({ ...m, [d.id]: e.target.value }))}
                    />
                    <div className="flex flex-wrap gap-2">
                      <Button size="sm" className="h-9" disabled={devBusy} onClick={() => decideDeviation(d, 'resolved')}>
                        {devBusy ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <CheckCircle2 className="h-4 w-4 mr-1" />}
                        {(devEdit[d.id] || '').trim() ? 'Approve as edited' : 'Allow'}
                      </Button>
                      <Button variant="outline" size="sm" className="h-9 text-red-500" disabled={devBusy} onClick={() => decideDeviation(d, 'dismissed')}>
                        <Ban className="h-4 w-4 mr-1" />Deny
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            ) : null}

            {/* Continue (editors) — soft-retry ANY non-successful terminal build.
                It resumes from the last checkpoint / the working tree still in the
                container, so nothing done so far is lost. */}
            {canEdit && online && canContinueFailed ? (
              <div className="space-y-1.5">
                <p className="text-xs text-muted-foreground">
                  Continues from the last checkpoint — your work so far isn&apos;t lost.
                </p>
                <Button size="sm" className="h-9" disabled={busy} onClick={onRetry}>
                  {busy ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <RotateCcw className="h-4 w-4 mr-1" />}
                  Continue build
                </Button>
              </div>
            ) : null}

            {/* Interrupts (editors) while running */}
            {canEdit && active && cycle.status === 'running' ? (
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" size="sm" className="h-9" disabled={busy} onClick={() => onInterrupt('stop_after_step')}>
                  <Square className="h-4 w-4 mr-1" />Stop after step
                </Button>
                <Button variant="ghost" size="sm" className="h-9 text-red-500" disabled={busy} onClick={() => onInterrupt('abandon')}>
                  Abandon
                </Button>
                {isAdmin ? (
                  <Button variant="ghost" size="sm" className="h-9" disabled={busy} onClick={onStopAll}>
                    Stop all
                  </Button>
                ) : null}
              </div>
            ) : null}

            {cycle.status === 'succeeded' ? (
              <p className="text-xs text-green-600 flex items-start gap-1">
                <ShieldCheck className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                {cycle.deploy_status === 'serving'
                  ? 'Gates green and deployed — the app is live on its URL. The preview reloads automatically.'
                  : 'Gates green — change checkpointed into the repo.'}
              </p>
            ) : null}

            {/* Post-build rating — required before the next cycle. A thumbs-down
                opens a note (saved to the build log for evaluation). */}
            {cycle.status === 'succeeded' && cycle.feedback ? (
              <p className="text-xs text-muted-foreground flex items-center gap-1">
                {cycle.feedback.rating === 'up'
                  ? <><ThumbsUp className="h-3.5 w-3.5 text-emerald-500" /> You rated this build good.</>
                  : <><ThumbsDown className="h-3.5 w-3.5 text-amber-500" /> You flagged this build{cycle.feedback.note ? `: “${cycle.feedback.note}”` : '.'}</>}
              </p>
            ) : canEdit && needsFeedback ? (
              <div className="rounded-md border border-primary/30 bg-primary/5 p-3 space-y-2">
                <p className="text-xs font-medium">How did this build go? A rating is required before the next change.</p>
                {!fbRating ? (
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" className="h-9" disabled={fbBusy} onClick={() => { setNote(''); setFbRating('up'); }}>
                      <ThumbsUp className="h-4 w-4 mr-1" /> Looks good
                    </Button>
                    <Button variant="outline" size="sm" className="h-9" disabled={fbBusy} onClick={() => { setNote(''); setFbRating('down'); }}>
                      <ThumbsDown className="h-4 w-4 mr-1" /> Something's off
                    </Button>
                  </div>
                ) : (
                  <div className="space-y-2">
                    <p className="text-xs text-muted-foreground flex items-center gap-1">
                      {fbRating === 'up'
                        ? <><ThumbsUp className="h-3.5 w-3.5 text-emerald-500" /> Anything noteworthy? (optional — saved to the build log)</>
                        : <><ThumbsDown className="h-3.5 w-3.5 text-amber-500" /> What went wrong or could be better? (required)</>}
                    </p>
                    <textarea
                      className="flex min-h-[64px] w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                      placeholder={fbRating === 'up' ? 'Optional note…' : 'Describe the problem…'}
                      value={note}
                      onChange={(e) => setNote(e.target.value)}
                    />
                    <div className="flex flex-wrap gap-2">
                      <Button size="sm" className="h-9" disabled={fbBusy || (fbRating === 'down' && !note.trim())} onClick={async () => { setFbBusy(true); try { await onFeedback(fbRating, note.trim()); setFbRating(null); setNote(''); } catch { /* keep open */ } finally { setFbBusy(false); } }}>
                        {fbBusy ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : null} Submit {fbRating === 'up' ? '👍' : 'feedback'}
                      </Button>
                      <Button variant="ghost" size="sm" className="h-9" disabled={fbBusy} onClick={() => { setFbRating(null); setNote(''); }}>Cancel</Button>
                    </div>
                  </div>
                )}
              </div>
            ) : null}
          </div>
        ) : (
          online ? <p className="text-sm text-muted-foreground">No builds yet. Describe a change in the build chat to start one.</p> : null
        )}
        </>
        )}
      </CardContent>
    </Card>
  );
}
