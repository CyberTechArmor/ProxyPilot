// BuildMode — the post-approval Chat-tab layout: build information on the LEFT,
// the build/run/maintenance chat on the RIGHT.
//
// This keeps the same left-preview / right-chat structure as the pre-approval
// design view, so the UI stays consistent across stages. It owns the single
// build-cycle poll (so the task list on the left and the chat on the right agree
// on state), exposes the retry/interrupt/remediate actions, reloads the preview
// when a build lands, and fires an in-browser notification when a build
// finishes. The design conversation that preceded approval lives read-only in
// the Details tab.
//
// MOBILE_FIRST: stacks to one column below lg; the preview sits above the build
// status, the chat below. Renders clean at 360px.

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { useToast } from '@/hooks/use-toast';
import { LiveAppBar, PreviewPlaceholder } from './ProjectPreview';
import BuildStatus from './BuildStatus';
import BuildChat from './BuildChat';
import { deriveBuildTasks } from '@/lib/build-tasks';
import { ensureNotifyPermission, notifyBrowser } from '@/lib/browser-notify';

export default function BuildMode({
  projectId, project, canEdit, isAdmin, previewSrc, provLog, provMessage, onChanged, onBuilt,
}) {
  const { toast } = useToast();
  const [cycle, setCycle] = useState(null);
  const [job, setJob] = useState(null);
  const [busy, setBusy] = useState(false);
  const lastBuiltCycleId = useRef(null);
  const lastTerminalKey = useRef(null);

  const online = project?.lifecycle === 'active';

  const load = useCallback(async () => {
    try {
      const r = await api.mock2GetLatestCycle(projectId);
      setCycle(r.cycle || null);
      setJob(r.job || null);
    } catch (err) {
      if (!(err instanceof ApiError)) console.error('load cycle failed:', err);
    }
  }, [projectId]);

  useEffect(() => { load(); }, [load]);

  const active = cycle && ['queued', 'estimating', 'running', 'awaiting_user', 'awaiting_admin'].includes(cycle.status);
  // Fast (3s) while a cycle is live so its status/task-list update on their own;
  // gentle (8s) otherwise while online so a cycle started elsewhere (or a missed
  // terminal transition) still surfaces without a manual refresh.
  useEffect(() => {
    if (!online) return undefined;
    const t = setInterval(() => { load(); if (active && onChanged) onChanged(); }, active ? 3000 : 8000);
    return () => clearInterval(t);
  }, [online, active, load, onChanged]);

  // Ask for browser-notification permission once, when a build is live, so the
  // finish alert can fire. (The Notifications settings page also has an explicit
  // enable button for browsers that require a direct gesture.)
  useEffect(() => { if (active) ensureNotifyPermission(); }, [active]);

  // A build landed successfully — reload the preview so the live site shows the
  // new app. Fire once per cycle id.
  useEffect(() => {
    if (cycle?.status === 'succeeded' && cycle.id && lastBuiltCycleId.current !== cycle.id) {
      lastBuiltCycleId.current = cycle.id;
      if (onBuilt) onBuilt();
    }
  }, [cycle?.status, cycle?.id, onBuilt]);

  // Fire an in-browser + toast notification when a build reaches a terminal
  // state. Deduped per cycle+outcome so a re-render or poll doesn't repeat it.
  useEffect(() => {
    if (!cycle) return;
    const { terminal } = deriveBuildTasks(cycle, job);
    if (!terminal) return;
    const key = `${cycle.id}:${terminal}`;
    if (lastTerminalKey.current === key) return;
    lastTerminalKey.current = key;
    const name = project?.name || 'your project';
    if (terminal === 'succeeded') {
      const deployed = cycle.deploy_status === 'serving';
      notifyBrowser(`Build finished — ${name}`, deployed ? 'The app is live on its URL.' : 'Gates passed and the change was checkpointed.', { url: project?.url || undefined });
      toast({ title: 'Build finished', description: deployed ? 'The app is live on its URL.' : 'Gates passed — change checkpointed.' });
    } else if (terminal === 'paused') {
      // A soft pause is not a failure — checkpointed and resumable in one click.
      const desc = cycle.error ? String(cycle.error).slice(0, 140) : 'Checkpointed on a token/time budget — resume to continue.';
      notifyBrowser(`Build paused — ${name}`, desc);
      toast({ title: 'Build paused', description: desc });
    } else {
      const label = terminal === 'deploy_failed' ? 'Deploy failed' : 'Build failed';
      notifyBrowser(`${label} — ${name}`, cycle.error ? String(cycle.error).slice(0, 140) : 'See the build panel for details.');
      toast({ variant: 'destructive', title: label, description: cycle.error ? String(cycle.error).slice(0, 140) : undefined });
    }
  }, [cycle, job, project?.name, project?.url, toast]);

  // ---- cycle actions (owned here so the poll refreshes after each) ----

  const refresh = () => { load(); if (onChanged) onChanged(); };

  const retry = async () => {
    if (!cycle) return;
    const resuming = cycle.status === 'interrupted' && !!cycle.pause_reason;
    setBusy(true);
    try {
      const res = await api.mock2RetryCycle(projectId, cycle.id);
      if (res.refused) toast({ variant: 'destructive', title: resuming ? 'Resume refused' : 'Continue refused', description: res.reason || 'Quota exceeded.' });
      else toast({ title: resuming ? 'Resuming the build' : 'Continuing the build', description: 'Continuing from where it stopped.' });
      refresh();
    } catch (err) { toast({ variant: 'destructive', title: 'Could not resume', description: err.message }); }
    finally { setBusy(false); }
  };

  const retryDeploy = async () => {
    if (!cycle) return;
    setBusy(true);
    try {
      await api.mock2RetryDeploy(projectId, cycle.id);
      toast({ title: 'Retrying the deploy', description: 'Redeploying the existing build — no rebuild.' });
      refresh();
    } catch (err) { toast({ variant: 'destructive', title: 'Could not retry the deploy', description: err.message }); }
    finally { setBusy(false); }
  };

  const interrupt = async (action) => {
    if (!cycle) return;
    setBusy(true);
    try { await api.mock2InterruptCycle(projectId, cycle.id, action); toast({ title: `Cycle: ${action.replace(/_/g, ' ')}` }); await load(); }
    catch (err) { toast({ variant: 'destructive', title: 'Could not interrupt', description: err.message }); }
    finally { setBusy(false); }
  };

  const stopAll = async () => {
    try { await api.mock2StopAllCycles(); await load(); }
    catch (err) { toast({ variant: 'destructive', title: 'Could not stop cycles', description: err.message }); }
  };

  // Explicit-consent framework adoption (ADR-003). Starts an update cycle.
  const remediate = async () => {
    const from = project?.framework_last_built_version;
    const to = project?.framework_current_version;
    const text = `Adopt framework ${from ? `v${from} → ` : ''}v${to}: re-run the full gate battery and reconcile the app with the updated constitution and confirmed rules (Mock2 ${from ? `v${from} → ` : ''}v${to}).`;
    setBusy(true);
    try {
      const res = await api.mock2StartCycle(projectId, text);
      if (res.refused) toast({ variant: 'destructive', title: 'Update refused', description: res.reason || 'Quota exceeded.' });
      else toast({ title: 'Update cycle started' });
      refresh();
    } catch (err) { toast({ variant: 'destructive', title: 'Could not start update cycle', description: err.message }); }
    finally { setBusy(false); }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto lg:flex-row lg:overflow-hidden">
      {/* LEFT — build information: the live-app link + the build status/task list.
          In build mode the app is the deployed site (it refuses to be iframed),
          so we show a compact open-in-new-tab bar instead of an embedded preview. */}
      <div className="min-w-0 flex flex-col gap-4 lg:flex-[1.55] lg:min-h-0 lg:overflow-y-auto">
        {online ? (
          <LiveAppBar url={project.url || previewSrc || null} />
        ) : (
          <PreviewPlaceholder project={project} provLog={provLog} provMessage={provMessage} />
        )}
        <BuildStatus
          projectId={projectId}
          canEdit={canEdit}
          isAdmin={isAdmin}
          online={online}
          project={project}
          cycle={cycle}
          job={job}
          busy={busy}
          onRetry={retry}
          onRetryDeploy={retryDeploy}
          onInterrupt={interrupt}
          onRemediate={remediate}
          onStopAll={stopAll}
          onRefresh={refresh}
        />
      </div>

      {/* RIGHT — the build/run/maintenance chat. */}
      <div className="min-w-0 flex flex-col lg:flex-1 lg:min-h-0">
        <BuildChat
          projectId={projectId}
          project={project}
          canEdit={canEdit}
          online={online}
          active={active}
          job={job}
          onStarted={refresh}
        />
      </div>
    </div>
  );
}
