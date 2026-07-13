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

import { useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import {
  Hammer, RefreshCw, Loader2, Square, RotateCcw, ShieldAlert, ShieldCheck, Clock, GitBranch,
  XCircle,
} from 'lucide-react';
import BuildTaskList from './BuildTaskList';

const STATUS_TONE = {
  running: 'text-cyan-500', succeeded: 'text-green-500', failed: 'text-red-500',
  refused_quota: 'text-red-500', awaiting_user: 'text-violet-500', awaiting_admin: 'text-amber-500',
  interrupted: 'text-amber-500', abandoned: 'text-muted-foreground', queued: 'text-blue-500', estimating: 'text-blue-500',
};

export default function BuildStatus({
  projectId, canEdit, isAdmin, online, project, cycle, job, busy,
  onRetry, onRetryDeploy, onInterrupt, onRemediate, onStopAll,
}) {
  const [changes, setChanges] = useState(null); // { records, verification } | null
  const [showChanges, setShowChanges] = useState(false);

  const active = cycle && ['queued', 'estimating', 'running', 'awaiting_user', 'awaiting_admin'].includes(cycle.status);
  const driftAvailable = !!project?.framework_update_available;

  const loadChanges = async () => {
    setShowChanges((s) => !s);
    if (changes) return;
    try { setChanges(await api.mock2GetChangeRecords(projectId)); }
    catch (err) { if (!(err instanceof ApiError)) console.error('load change records failed:', err); }
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2"><Hammer className="h-4 w-4" /> Build</CardTitle>
        <CardDescription>
          Describe a change in the build chat. Each build audits the change against the rules and framework, edits
          the code in the fenced container, runs the pinned gate battery, and checkpoints into the repo.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
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
                <p className={`text-xs font-medium ${STATUS_TONE[cycle.status] || 'text-muted-foreground'}`}>
                  {cycle.status.replace(/_/g, ' ')}{cycle.current_gate ? ` · ${cycle.current_gate}` : ''}
                </p>
              </div>
              <div className="text-xs text-muted-foreground whitespace-nowrap">
                {cycle.used_cost_cents ? `$${(cycle.used_cost_cents / 100).toFixed(2)}` : '$0.00'} · {cycle.used_tokens || 0} tok
              </div>
            </div>

            {/* The Claude-Code-style task list — what's running and how many steps are left. */}
            <BuildTaskList cycle={cycle} job={job} />

            {cycle.error ? <p className="text-xs text-red-500 break-words">{cycle.error}</p> : null}

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
            {cycle.status === 'awaiting_admin' ? (
              <p className="text-xs text-amber-500 flex items-start gap-1">
                <ShieldAlert className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                {cycle.error
                  ? 'The build stalled on a transient error — once you’ve fixed the cause (e.g. added billing or raised your model rate limit), retry to continue where it stopped.'
                  : 'A framework deviation was sent to the admin queue — the build resumes once an admin resolves it.'}
              </p>
            ) : null}

            {/* Retry (editors) — resume a cycle that stalled on a transient
                failure. A deploy failure has its own Retry deploy / Rebuild
                controls above, so exclude it here. */}
            {canEdit && online && cycle.deploy_status !== 'deploy_failed'
              && (cycle.status === 'failed' || (cycle.status === 'awaiting_admin' && cycle.error)) ? (
                <Button size="sm" className="h-9" disabled={busy} onClick={onRetry}>
                  {busy ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <RotateCcw className="h-4 w-4 mr-1" />}
                  Retry build
                </Button>
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
          </div>
        ) : (
          online ? <p className="text-sm text-muted-foreground">No builds yet. Describe a change in the build chat to start one.</p> : null
        )}

        {/* Change history + chain verification */}
        <div className="border-t pt-3">
          <Button variant="ghost" size="sm" className="h-9 px-0" onClick={loadChanges}>
            <GitBranch className="h-4 w-4 mr-1" />{showChanges ? 'Hide' : 'Show'} change history
          </Button>
          {showChanges && changes ? (
            <div className="mt-2 space-y-2">
              <p className="text-xs flex items-center gap-1">
                {changes.verification?.ok
                  ? <><ShieldCheck className="h-3.5 w-3.5 text-green-500" /> <span className="text-green-600">Hash chain verified ({changes.verification.count} record{changes.verification.count === 1 ? '' : 's'})</span></>
                  : <><XCircle className="h-3.5 w-3.5 text-red-500" /> <span className="text-red-500">Chain broken at #{changes.verification?.brokenAt}</span></>}
              </p>
              {(changes.records || []).length === 0 ? (
                <p className="text-xs text-muted-foreground">No change records yet.</p>
              ) : (
                <ul className="space-y-1.5">
                  {changes.records.map((r) => (
                    <li key={r.seq} className="text-xs border rounded-md px-2 py-1.5">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-mono">#{r.seq}</span>
                        <span className="font-mono text-muted-foreground truncate">{r.commit_sha ? r.commit_sha.slice(0, 8) : '—'}</span>
                      </div>
                      <p className="truncate">{r.summary}</p>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}
