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
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
  Hammer, RefreshCw, Loader2, Square, RotateCcw, ShieldAlert, ShieldCheck, Clock, GitBranch,
  CheckCircle2, Ban, PauseCircle, Play, ThumbsUp, ThumbsDown, Wrench, Package,
} from 'lucide-react';
import BuildTaskList from './BuildTaskList';
import ChangeHistory from './ChangeHistory';
import ExplainThis from './ExplainThis';
import VerificationChecklist from './VerificationChecklist';
import { ProjectComponentsPanel } from './ProjectTimeCard';

const STATUS_TONE = {
  running: 'text-cyan-500', succeeded: 'text-green-500', failed: 'text-red-500',
  refused_quota: 'text-red-500', awaiting_user: 'text-violet-500', awaiting_admin: 'text-amber-500',
  interrupted: 'text-amber-500', abandoned: 'text-muted-foreground', queued: 'text-blue-500', estimating: 'text-blue-500',
};

// The cycle's wall-clock build time: started_at (falling back to created_at)
// until finished_at, or until "now" while the cycle is still live. Null when the
// timestamps are missing/inconsistent so the caller can just omit it.
function buildElapsed(cycle, nowMs) {
  if (!cycle) return null;
  const start = Date.parse(cycle.started_at || cycle.created_at || '');
  if (!Number.isFinite(start)) return null;
  const end = cycle.finished_at ? Date.parse(cycle.finished_at) : nowMs;
  if (!Number.isFinite(end) || end < start) return null;
  const total = Math.floor((end - start) / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

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

// CycleChangeSummary — the review panel for a completed build: this cycle's
// change-record summaries (the build's own "what was done" + acceptance
// evidence + diff stat), fetched lazily so the requester can review the change
// without leaving the Build panel. Renders nothing until records exist.
function CycleChangeSummary({ projectId, cycle }) {
  const [records, setRecords] = useState(null);
  useEffect(() => {
    let cancelled = false;
    api.mock2GetChangeRecords(projectId)
      .then((r) => {
        if (cancelled) return;
        setRecords((r.records || []).filter((rec) => Number(rec.cycle_id) === Number(cycle.id)));
      })
      .catch((err) => { if (!cancelled && !(err instanceof ApiError)) console.error('load cycle summary failed:', err); });
    return () => { cancelled = true; };
  }, [projectId, cycle.id, cycle.status]);
  if (!records?.length) return null;
  return (
    // Collapsed by default — even for a single record — so a finished build
    // fits on screen; the review is one tap away.
    <details className="rounded-md border bg-muted/30 text-xs">
      <summary className="cursor-pointer select-none px-3 py-2 font-medium text-muted-foreground">
        What was done — review this build&apos;s change{records.length === 1 ? '' : `s (${records.length})`}
      </summary>
      <div className="max-h-72 overflow-auto border-t px-3 py-2 space-y-3">
        {records.map((rec) => (
          <div key={rec.seq} className="space-y-1">
            <p className="font-mono text-[11px] text-muted-foreground">
              change #{rec.seq}{rec.commit_sha ? ` · ${rec.commit_sha.slice(0, 10)}` : ''}{rec.created_at ? ` · ${rec.created_at.slice(0, 16).replace('T', ' ')}` : ''}
            </p>
            <pre className="whitespace-pre-wrap break-words text-[11px] leading-relaxed text-foreground/90">{rec.summary}</pre>
          </div>
        ))}
      </div>
    </details>
  );
}

// Format a millisecond duration compactly: 95000 → "1m 35s", 4200000 → "1h 10m".
function fmtDuration(ms) {
  const total = Math.round(Number(ms) / 1000);
  if (!Number.isFinite(total) || total <= 0) return null;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m${s ? ` ${s}s` : ''}`;
  return `${s}s`;
}

export default function BuildStatus({
  projectId, canEdit, isAdmin, online, project, cycle, job, busy,
  onRetry, onRetryDeploy, onInterrupt, onRemediate, onStopAll, onRefresh,
  needsFeedback = false, onFeedback, typical = null,
}) {
  const { toast } = useToast();
  const [view, setView] = useState('build'); // 'build' | 'changes' | 'components'
  const [deviations, setDeviations] = useState([]); // open framework_deviation queue items (admin)
  const [devBusy, setDevBusy] = useState(false);
  const [fbRating, setFbRating] = useState(null); // 'up' | 'down' | null — note composer open for this rating
  const [note, setNote] = useState('');
  const [fbBusy, setFbBusy] = useState(false);
  const [resumeMsg, setResumeMsg] = useState(''); // operator guidance carried on resume / with a chosen option
  const [otherText, setOtherText] = useState(''); // free-text "Other" resolution (the escape hatch)
  const [resuming, setResuming] = useState(false);
  const [repairing, setRepairing] = useState(false); // one-click integration-manifest repair
  const [gateInfo, setGateInfo] = useState(null); // the blocked cycle's full finding list (resolutions endpoint)
  const [auths, setAuths] = useState([]); // open one-time authorization requests
  const [authBusy, setAuthBusy] = useState(false);
  const [devEdit, setDevEdit] = useState({}); // deviation id -> edited text (approve-as-edited)
  // Admin completion/networking valves for a build blocked on an external
  // integration the sealed fence can't verify live.
  const [acceptOpen, setAcceptOpen] = useState(false); // accept-as-pending attestation form
  const [attestation, setAttestation] = useState('');
  const [accepting, setAccepting] = useState(false);
  const [egressOpen, setEgressOpen] = useState(false); // operator egress-grant form
  const [egress, setEgress] = useState({ host: '', port: '', protocol: 'tcp', reason: '' });
  const [egressBusy, setEgressBusy] = useState(false);
  // The audited lanes live HERE (the build chat only offers Ask/Quick update):
  // Full build takes an instruction through the whole gate battery; the
  // production check validates the app as-is with no new features.
  const [fullOpen, setFullOpen] = useState(false);
  const [fullText, setFullText] = useState('');
  const [fullBusy, setFullBusy] = useState(false);
  const [checkBusy, setCheckBusy] = useState(false);

  const active = cycle && ['queued', 'estimating', 'running', 'awaiting_user', 'awaiting_admin'].includes(cycle.status);

  const startFullBuild = async () => {
    const body = fullText.trim();
    if (!body) return;
    setFullBusy(true);
    try {
      const res = await api.mock2StartCycle(projectId, body, null, 'full');
      if (res.refused) {
        toast({ variant: 'destructive', title: 'Full build refused', description: res.reason || 'Quota exceeded.' });
      } else {
        toast({
          title: res.audit ? 'Auditing the build…' : 'Full build started',
          description: 'The audited lane: rule questions, per-rule tests, and the whole gate battery.',
        });
        setFullOpen(false);
        setFullText('');
      }
      if (onRefresh) onRefresh();
    } catch (err) {
      toast({ variant: 'destructive', title: 'Could not start the full build', description: err.message });
    } finally { setFullBusy(false); }
  };

  const productionCheck = async () => {
    setCheckBusy(true);
    try {
      const r = await api.mock2ProductionCheck(projectId);
      if (r.refused) toast({ variant: 'destructive', title: 'Production check refused', description: r.reason || 'Quota exceeded.' });
      else toast({ title: 'Production check started', description: 'Full readiness pass: rule interview, per-rule tests, acceptance checks, and every gate. No new features.' });
      if (onRefresh) onRefresh();
    } catch (err) {
      toast({ variant: 'destructive', title: 'Could not start the production check', description: err.message });
    } finally { setCheckBusy(false); }
  };
  // The running build clock: tick once a second while the cycle is live so the
  // elapsed time next to the spend counts up; a finished cycle shows its final
  // duration (finished_at) and needs no ticking.
  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    const t = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  const elapsed = buildElapsed(cycle, nowTick);
  // The "typically ~4–7m" band (from the project's recent succeeded builds of
  // the same mode). Collapses to one figure when p50≈p80.
  const typicalRange = (() => {
    if (!typical?.p50) return null;
    const lo = fmtDuration(typical.p50);
    const hi = fmtDuration(typical.p80);
    if (!lo) return null;
    return hi && hi !== lo ? `~${lo}–${hi}` : `~${lo}`;
  })();
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
    model_refusal: 'the model declined to continue (safety refusal) — review and redirect it',
    no_tool_calls: 'no progress — repeated turns with no action',
    repeated_output: 'no progress — the same response repeated without changes',
    no_state_change: 'no progress — repeated the same action with no change',
    max_turns: 'reached the step ceiling without finishing',
  };
  const statusLabel = blocked ? 'blocked' : paused ? 'paused' : cycle ? cycle.status.replace(/_/g, ' ') : '';
  // The blocker card's full engineer-facing text, assembled for "Explain this": the
  // halt reason, the model's error detail, and every proposed option (with its risk +
  // the exact operation a grant option would run) plus any legacy authorization scopes.
  const blockerExplainText = [
    HALT_LABELS[cycle?.halt_reason] ? `The build stopped: ${HALT_LABELS[cycle.halt_reason]}` : null,
    cycle?.error || null,
    ...(cycle?.halt_options || []).map((o) => `Option — ${o.label}${o.risk || o.detail ? `: ${o.risk || o.detail}` : ''}${o.authorization?.scope ? ` (it would run: ${o.authorization.scope}${o.authorization.expectedRows != null && o.authorization.expectedRows !== '' ? `, affecting ${o.authorization.expectedRows} row(s)` : ''})` : ''}`),
    ...auths.map((a) => `Requested one-time permission: ${a.scope}${a.reason ? ` — ${a.reason}` : ''}`),
  ].filter(Boolean).join('\n');
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

  // One-click manifest repair (the manifest-invalid / wrong-schema loop): the
  // server archives the broken state/integrations.json, migrates near-miss
  // entries into the required shape, writes a valid scaffold, and resumes the
  // blocked cycle so the gate re-reads it. A valid manifest is a graceful no-op.
  const repairManifest = async () => {
    setRepairing(true);
    try {
      const r = await api.mock2RepairIntegrationManifest(projectId);
      if (r.repaired === false) {
        toast({ title: 'Nothing to repair', description: r.reason });
      } else {
        const migrated = (r.migrated || []).length;
        const dropped = (r.dropped || []).length;
        toast({
          title: 'Manifest repaired',
          description: `${(r.salvaged || []).length} entr${(r.salvaged || []).length === 1 ? 'y' : 'ies'} kept${migrated ? ` (${migrated} migrated into the required shape)` : ''}${dropped ? `, ${dropped} dropped (see the audit log)` : ''}. Original archived to ${r.archived_to}. ${r.resume === 'started' ? 'The build is resuming.' : ''}`,
        });
      }
      if (onRefresh) onRefresh();
    } catch (err) {
      toast({ variant: 'destructive', title: 'Could not repair the manifest', description: err.message });
    } finally { setRepairing(false); }
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

  // Admin: accept a blocked build as pending LIVE verification — convert the
  // unverifiable-in-fence integration block to pending-operator-verification and
  // deploy, with a required attestation. Never records "succeeded".
  const doAcceptPending = async () => {
    if (!cycle || !attestation.trim()) return;
    setAccepting(true);
    try {
      const res = await api.mock2AcceptPending(projectId, cycle.id, attestation.trim());
      setAcceptOpen(false); setAttestation('');
      toast({ title: 'Accepted as pending verification', description: res?.warn || 'Deploying — verify the live check against the real system when ready.' });
      if (onRefresh) onRefresh();
    } catch (err) {
      toast({ variant: 'destructive', title: 'Could not accept', description: err.message });
    } finally { setAccepting(false); }
  };

  // Admin: open the build fence to a LAN / external host:port directly, so a build
  // that must reach an internal endpoint (a directory server, an ADP endpoint) can
  // — on an install whose host can route there — verify the real handshake in-fence.
  const doAddEgress = async () => {
    const host = egress.host.trim();
    const port = Number(egress.port);
    if (!host || !port) return;
    setEgressBusy(true);
    try {
      await api.mock2AddEgress(projectId, { host, port, protocol: egress.protocol, reason: egress.reason.trim() });
      setEgressOpen(false); setEgress({ host: '', port: '', protocol: 'tcp', reason: '' });
      toast({ title: 'Fence egress granted', description: `The build fence can now reach ${host}:${port}. Resume the build to verify the live connection.` });
      if (onRefresh) onRefresh();
    } catch (err) {
      toast({ variant: 'destructive', title: 'Could not grant egress', description: err.message });
    } finally { setEgressBusy(false); }
  };

  // While blocked on the integration gate, load the cycle's FULL finding list —
  // "20 findings across 1 class" is not actionable without the 20 items. The
  // same list is carried into the resume as authoritative guidance server-side.
  const integrationBlocked = !!cycle && ['integration_gate', 'simulation_disclosure', 'resolution_ineffective'].includes(cycle.halt_reason);
  useEffect(() => {
    if (!integrationBlocked || !cycle?.id) { setGateInfo(null); return; }
    let cancelled = false;
    api.mock2GetCycleResolutions(projectId, cycle.id)
      .then((r) => { if (!cancelled) setGateInfo(r?.blocked ? r : null); })
      .catch((err) => { if (!(err instanceof ApiError)) console.error('load gate findings failed:', err); });
    return () => { cancelled = true; };
  }, [integrationBlocked, cycle?.id, projectId]);

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
          <button
            type="button" role="tab" aria-selected={view === 'components'}
            onClick={() => setView('components')}
            className={`inline-flex items-center gap-1 rounded px-2.5 py-1.5 text-xs font-medium ${view === 'components' ? 'bg-muted text-foreground' : 'text-muted-foreground'}`}
          >
            <Package className="h-3.5 w-3.5" /> Components
          </button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {view === 'changes' ? <ChangeHistory projectId={projectId} canRestore={!!canEdit && !!online && !active} />
        : view === 'components' ? <ProjectComponentsPanel projectId={projectId} canEdit={!!canEdit} isActive={!!online} />
        : (
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

        {/* Live-verification hand-off (pending-operator-verification): the
            credential-gated checks only the operator can run against the real
            system. Renders nothing when no live check is outstanding. */}
        <VerificationChecklist projectId={projectId} canEdit={canEdit} isAdmin={isAdmin} online={online} cycle={cycle} onRefresh={onRefresh} />

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
                {elapsed ? (
                  <span title={active ? 'Running build time' : 'Total build time'}>
                    {' · '}<Clock className="inline h-3 w-3 mb-0.5" /> {elapsed}
                  </span>
                ) : null}
                {active && typicalRange ? (
                  <span title={`Based on your last ${typical.n} ${typical.n === 1 ? 'build' : 'builds'} of this kind`}>
                    {' · typically '}{typicalRange}
                  </span>
                ) : null}
              </div>
            </div>

            {/* While a build runs: it keeps going without this page open — the
                finish fires a browser notification, and Interrupt (in the chat)
                stops it at the next safe step. */}
            {active ? (
              <p className="text-[11px] text-muted-foreground">
                You can leave this page — the build keeps running and you&apos;ll get a notification when it
                finishes. Use Interrupt in the build chat to stop and redirect it.
              </p>
            ) : null}

            {/* Model routing (reviewable): which model ran this build, at what
                effort, and why — including deterministic escalation to a stronger
                model after a failed attempt. null on pre-routing cycles. */}
            {cycle.routing?.applied_model || cycle.routing?.model ? (
              <p className="text-[11px] text-muted-foreground break-words">
                Model: <code>{cycle.routing.applied_model || cycle.routing.model}</code>
                {cycle.routing.mode === 'on' && cycle.routing.effort ? <> · effort {cycle.routing.effort}</> : null}
                {cycle.routing.rung > 0 ? <span className="text-amber-500"> · escalated</span> : null}
                {cycle.routing.task_kind && cycle.routing.task_kind !== 'default' ? <> · task: {cycle.routing.task_kind}{cycle.routing.difficulty ? ` (difficulty ${cycle.routing.difficulty}/5)` : ''}</> : null}
                {cycle.routing.mode === 'shadow' ? <span className="text-amber-500"> · routing shadow (would pick {cycle.routing.model})</span> : null}
              </p>
            ) : null}

            {/* The Claude-Code-style task list — what's running and how many steps are left. */}
            <BuildTaskList cycle={cycle} job={job} />

            {cycle.error && !paused && !blocked ? <p className="text-xs text-red-500 break-words">{cycle.error}</p> : null}

            {/* Blocked — the build could not honestly finish (it called halt), or
                the no-progress circuit breaker stopped a stuck loop. Needs human
                attention; resumable once the blocker is cleared. Distinct from a
                success, a user stop, and a soft budget pause. */}
            {blocked ? (
              <div className="space-y-2 rounded-md border border-orange-500/30 bg-orange-500/5 p-3">
                <div className="flex items-start justify-between gap-2">
                  <p className="text-xs text-orange-600 flex items-start gap-1">
                    <ShieldAlert className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                    <span>
                      <span className="font-medium">Blocked — needs attention.</span>{' '}
                      {HALT_LABELS[cycle.halt_reason] || 'The build stopped without finishing.'}
                      {cycle.error ? <span className="block mt-1 text-orange-700/90 break-words">{cycle.error}</span> : null}
                      {' '}Your work so far is checkpointed — add context or resolve the blocker, then resume.
                    </span>
                  </p>
                  <ExplainThis
                    projectId={projectId} kind="blocker" cardId={`blocker-${cycle.id}`}
                    title={cycle.instruction || ''} status={statusLabel} text={blockerExplainText}
                    className="shrink-0"
                  />
                </div>

                {/* Direct actions on the blocker — no option pick required:
                    the one-click manifest repair (integration blocks; migrates
                    wrong-schema entries, archives the original, resumes — safe
                    when the manifest is fine, it just says so), and Abandon
                    (closes the cycle as abandoned; any typed context above is
                    recorded with it; still resumable later via Continue). */}
                {canEdit ? (
                  <div className="flex flex-wrap gap-2">
                    {online && integrationBlocked ? (
                      <Button variant="outline" size="sm" className="h-9" disabled={repairing || resuming} onClick={repairManifest}>
                        {repairing ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Wrench className="h-4 w-4 mr-1" />}
                        Repair integration manifest
                      </Button>
                    ) : null}
                    {/* Admin valves for a build blocked because the sealed fence
                        cannot verify a live external integration: grant the fence
                        egress to the real endpoint (verify live in-fence), or
                        accept the real code as pending operator verification
                        (deploy now, verify live yourself). Both admin-only. */}
                    {isAdmin && online ? (
                      <Button
                        variant="outline" size="sm" className="h-9"
                        disabled={resuming || repairing || accepting}
                        title="Open the build fence to a LAN / external host:port so the build can reach the real endpoint."
                        onClick={() => { setEgressOpen((v) => !v); setAcceptOpen(false); }}
                      >
                        <Wrench className="h-4 w-4 mr-1" /> Grant fence egress…
                      </Button>
                    ) : null}
                    {isAdmin && online ? (
                      <Button
                        variant="outline" size="sm" className="h-9"
                        disabled={resuming || repairing || accepting}
                        title="The code is real but the fence can't run the live check — deploy it and verify live yourself (records as pending verification, never 'succeeded')."
                        onClick={() => { setAcceptOpen((v) => !v); setEgressOpen(false); }}
                      >
                        <ShieldAlert className="h-4 w-4 mr-1" /> Accept as pending verification…
                      </Button>
                    ) : null}
                    <Button
                      variant="ghost" size="sm" className="h-9 text-red-500"
                      disabled={resuming || repairing}
                      title="Close this build as abandoned — no option pick needed. You can continue it later."
                      onClick={() => doResume({ abandon: true, ...(resumeMsg.trim() ? { message: resumeMsg.trim() } : {}) })}
                    >
                      <Ban className="h-4 w-4 mr-1" /> Abandon build
                    </Button>
                  </div>
                ) : null}

                {/* Operator egress-grant form (admin) — opens the fence to a real
                    endpoint. Full-width, stacks on mobile. */}
                {isAdmin && egressOpen ? (
                  <div className="space-y-2 rounded-md border border-orange-500/30 bg-background/50 p-2.5">
                    <p className="text-[11px] font-medium text-orange-600">
                      Grant the build fence egress to a real endpoint. Use this when the build must reach a LAN/external host (e.g. a directory server at 10.0.1.4:636) and this ProxyPilot host can route to it — the build then verifies the live connection in-fence.
                    </p>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      <input
                        className="flex h-11 w-full rounded-md border border-input bg-transparent px-3 py-2 text-xs shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                        placeholder="host (IP or hostname, e.g. 10.0.1.4)"
                        value={egress.host} disabled={egressBusy}
                        onChange={(e) => setEgress((s) => ({ ...s, host: e.target.value }))}
                      />
                      <div className="grid grid-cols-2 gap-2">
                        <input
                          className="flex h-11 w-full rounded-md border border-input bg-transparent px-3 py-2 text-xs shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                          placeholder="port (e.g. 636)" inputMode="numeric"
                          value={egress.port} disabled={egressBusy}
                          onChange={(e) => setEgress((s) => ({ ...s, port: e.target.value.replace(/[^0-9]/g, '') }))}
                        />
                        <select
                          className="flex h-11 w-full rounded-md border border-input bg-transparent px-3 py-2 text-xs shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                          value={egress.protocol} disabled={egressBusy}
                          onChange={(e) => setEgress((s) => ({ ...s, protocol: e.target.value }))}
                        >
                          <option value="tcp">tcp</option>
                          <option value="udp">udp</option>
                        </select>
                      </div>
                    </div>
                    <input
                      className="flex h-11 w-full rounded-md border border-input bg-transparent px-3 py-2 text-xs shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                      placeholder="reason (why the build needs this endpoint)"
                      value={egress.reason} disabled={egressBusy}
                      onChange={(e) => setEgress((s) => ({ ...s, reason: e.target.value }))}
                    />
                    <div className="flex justify-end">
                      <Button size="sm" className="h-9" disabled={egressBusy || !egress.host.trim() || !egress.port} onClick={doAddEgress}>
                        {egressBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Grant egress + reconcile fence'}
                      </Button>
                    </div>
                  </div>
                ) : null}

                {/* Accept-as-pending attestation form (admin). */}
                {isAdmin && acceptOpen ? (
                  <div className="space-y-2 rounded-md border border-orange-500/30 bg-background/50 p-2.5">
                    <p className="text-[11px] font-medium text-orange-600">
                      Accept this build as pending LIVE verification. Use this when the integration code is real but the sealed fence can’t run the live check (it needs production network/credentials). The app deploys and the cycle is recorded as pending-operator-verification — never “succeeded” — with the live check left for you to confirm against the real system.
                    </p>
                    <textarea
                      className="flex min-h-[44px] w-full rounded-md border border-input bg-transparent px-3 py-2 text-xs shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-60"
                      placeholder="Attestation (required): state that the integration code is real and that you will verify it live — e.g. “the LDAPS transport is real; I’ll bind against the prod directory after deploy.”"
                      value={attestation} disabled={accepting}
                      onChange={(e) => setAttestation(e.target.value)}
                    />
                    <div className="flex justify-end">
                      <Button size="sm" className="h-9" disabled={accepting || !attestation.trim()} onClick={doAcceptPending}>
                        {accepting ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Accept + deploy for live verification'}
                      </Button>
                    </div>
                  </div>
                ) : null}

                {/* The gate's FULL finding list — what the count actually is.
                    Resuming carries this same list to the build as guidance. */}
                {gateInfo?.findings?.length ? (
                  <details className="rounded-md border border-orange-500/30 bg-background/50 text-xs" open={gateInfo.findings.length <= 8}>
                    <summary className="cursor-pointer select-none px-2.5 py-2 font-medium text-orange-600">
                      All {gateInfo.findings.length} finding{gateInfo.findings.length === 1 ? '' : 's'} — resuming feeds this exact list to the build
                    </summary>
                    <ul className="max-h-64 overflow-auto border-t px-2.5 py-2 space-y-1.5">
                      {gateInfo.findings.map((f, i) => (
                        <li key={i} className="break-words font-mono text-[11px] leading-relaxed text-foreground/90">{f}</li>
                      ))}
                    </ul>
                  </details>
                ) : null}

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

                {/* Admin gate waiver — the real bypass for a red gate whose
                    findings are pre-existing/unrelated to this diff (e.g.
                    npm-audit transitive dev-dep vulns blocking a copy edit).
                    Resumes with the gate excluded from this ONE cycle's
                    battery; the next build runs the full battery again. */}
                {isAdmin && online && (cycle.gates || []).some((g) => g && g.status === 'failed') ? (
                  <div className="space-y-1.5 rounded-md border border-orange-500/30 bg-background/50 p-2.5">
                    <p className="text-[11px] font-medium text-orange-600">
                      Admin bypass — waive a red gate for this resume only (the next build runs it again; findings stay on record):
                    </p>
                    <div className="flex flex-wrap gap-2">
                      {(cycle.gates || []).filter((g) => g && g.status === 'failed').map((g) => (
                        <Button
                          key={g.name} variant="outline" size="sm" className="h-11 sm:h-9"
                          disabled={resuming}
                          onClick={() => doResume({
                            waivers: [`gate:${g.name}`],
                            message: resumeMsg.trim() || `Admin waived the ${g.name} gate for this resume — its findings are pre-existing and tracked separately from this diff.`,
                          })}
                        >
                          <ShieldCheck className="h-4 w-4 mr-1" /> Waive {g.name} + resume
                        </Button>
                      ))}
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
                    <div className="flex items-start justify-between gap-2">
                      <p className="text-xs text-foreground/90 break-words">{d.detail || 'Framework deviation'}</p>
                      {d.detail ? (
                        <ExplainThis
                          projectId={projectId} kind="deviation" cardId={`dev-${d.id}`}
                          title={cycle?.instruction || ''} status="needs an admin decision" text={d.detail}
                          className="shrink-0"
                        />
                      ) : null}
                    </div>
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
                  ? ((cycle.gates || []).length
                    ? 'Gates green and deployed — the app is live on its URL. The preview reloads automatically.'
                    : 'Deployed — the app is live on its URL. The preview reloads automatically.')
                  : ((cycle.gates || []).length
                    ? 'Gates green — change checkpointed into the repo.'
                    : 'Change checkpointed into the repo.')}
              </p>
            ) : null}

            {/* Review summary — what this completed build actually did (its
                change records: summary, acceptance evidence, diff stat). Shown
                for a success and for a pending-live-verification completion. */}
            {cycle.status === 'succeeded' || (cycle.status === 'awaiting_user' && cycle.verification_state === 'pending') ? (
              <CycleChangeSummary projectId={projectId} cycle={cycle} />
            ) : null}

            {/* Redeploy (restart) the app from the last checkpoint. A deployed app
                can stop serving AFTER a successful build (it crashed, the container
                restarted into a bad state) — the site 502s while the build reads
                green. This reruns install → migrate → build → start → health with
                no model round and restores the build's status when done. */}
            {canEdit && online
              && (cycle.status === 'succeeded' || (cycle.status === 'awaiting_user' && cycle.verification_state === 'pending')) ? (
              <div className="space-y-1.5">
                <Button variant="outline" size="sm" className="h-11 sm:h-9" disabled={busy}
                  title="App not loading (502)? Redeploys the existing build — reinstall, rebuild, restart, health-check. No model calls, nothing about the build changes."
                  onClick={onRetryDeploy}>
                  {busy ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <RotateCcw className="h-4 w-4 mr-1" />}
                  Redeploy app — restart it on its URL
                </Button>
              </div>
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

        {/* Production readiness — the audited lanes (the chat only offers
            Ask / Quick update). Full build runs one change through the whole
            gate battery; the production check validates the app as-is. */}
        {canEdit && online && !active ? (
          <div className="rounded-md border p-3 space-y-2">
            <p className="text-xs font-medium flex items-center gap-1">
              <ShieldCheck className="h-3.5 w-3.5" /> Production readiness
            </p>
            <p className="text-xs text-muted-foreground">
              Quick updates skip the gates to keep iteration fast. When the app (or a feature) is worth
              keeping, run it through the audited lane.
            </p>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Button
                variant="outline" className="min-h-[44px] flex-1"
                disabled={fullBusy}
                onClick={() => setFullOpen(true)}
                title="Build one change through the audited lane: rule questions, per-rule tests, the whole gate battery"
              >
                <Hammer className="h-4 w-4 mr-1" /> Full build
              </Button>
              <Button
                variant="outline" className="min-h-[44px] flex-1"
                disabled={checkBusy}
                onClick={productionCheck}
                title="Full-gate readiness pass over the app as it is — rule interview, per-rule tests, acceptance checks. No new features."
              >
                {checkBusy ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <ShieldCheck className="h-4 w-4 mr-1" />}
                Production check
              </Button>
            </div>
          </div>
        ) : null}
        </>
        )}
      </CardContent>

      {/* Full-build dialog — the audited lane needs an instruction; everything
          else about the cycle (audit, rule questions, gates) runs as usual.
          Full-screen on <sm (MOBILE_FIRST). */}
      <Dialog open={fullOpen} onOpenChange={(o) => { if (!fullBusy) setFullOpen(o); }}>
        <DialogContent className="max-w-full h-full rounded-none overflow-y-auto sm:max-w-md sm:h-auto sm:rounded-lg">
          <DialogHeader>
            <DialogTitle>Full build (audited)</DialogTitle>
            <DialogDescription>
              Describe the change to build through the audited lane — rule questions, per-rule tests,
              and the whole gate battery. Slower than a Quick update; this is the production-grade pass.
            </DialogDescription>
          </DialogHeader>
          <textarea
            className="flex min-h-[96px] w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            placeholder="e.g. “Harden the check-in flow: validation, error states, and tests for every rule”"
            value={fullText}
            disabled={fullBusy}
            onChange={(e) => setFullText(e.target.value)}
          />
          <DialogFooter className="gap-2">
            <Button variant="ghost" className="min-h-[44px]" disabled={fullBusy} onClick={() => setFullOpen(false)}>Cancel</Button>
            <Button className="min-h-[44px]" disabled={fullBusy || !fullText.trim()} onClick={startFullBuild}>
              {fullBusy ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Hammer className="h-4 w-4 mr-1" />}
              Start full build
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
