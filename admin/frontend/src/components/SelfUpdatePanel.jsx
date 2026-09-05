// SelfUpdatePanel — the "Update" block of Profile → Application Settings.
//
// What it shows: the installed build (version, short sha, branch, a warning
// when the host checkout has uncommitted changes), the latest release and
// latest commit on GitHub, the Mock2 standards line (seed vs site), and the
// Update now button. What it does: confirms, asks the backend to request an
// update (POST /user/version/update → the host runner runs update.sh), then
// switches to progress mode and polls /user/version/update/progress every
// 2 s. The container is torn down and rebuilt mid-run, so polls fail for a
// minute or two: failures are tolerated silently, "Restarting…" appears after
// three in a row, and polling resumes when the new backend answers. The
// state lives on the host, so a page reload mid-update adopts the live run.
//
// MOBILE_FIRST: single column, wrapping rows, 44px targets, the confirm
// dialog is full-screen under sm, the log tail scrolls inside its own box.

import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useToast } from '@/hooks/use-toast';
import {
  AlertTriangle,
  ArrowUpCircle,
  CheckCircle2,
  Circle,
  Download,
  Loader2,
  RotateCw,
  XCircle,
} from 'lucide-react';

const POLL_MS = 2000;
const FAILURES_BEFORE_RESTARTING = 3;
const TERMINAL = new Set(['success', 'failed', 'refused']);
const LIVE = new Set(['queued', 'running']);

function fmtWhen(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

function PhaseIcon({ state }) {
  if (state === 'done') return <CheckCircle2 className="h-4 w-4 shrink-0 text-green-500" aria-hidden="true" />;
  if (state === 'active') return <Loader2 className="h-4 w-4 shrink-0 animate-spin text-primary" aria-hidden="true" />;
  if (state === 'failed') return <XCircle className="h-4 w-4 shrink-0 text-destructive" aria-hidden="true" />;
  return <Circle className="h-4 w-4 shrink-0 text-muted-foreground/50" aria-hidden="true" />;
}

export default function SelfUpdatePanel({ updateInfo, checking, onRefresh }) {
  const { toast } = useToast();
  const [runId, setRunId] = useState(null);   // the run we are following
  const [run, setRun] = useState(null);       // its latest progress payload
  const [last, setLast] = useState(null);     // the last finished run, when not following one
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [rebuild, setRebuild] = useState(false);
  const [starting, setStarting] = useState(false);
  const [failures, setFailures] = useState(0);
  const logRef = useRef(null);
  const refreshRef = useRef(onRefresh);
  refreshRef.current = onRefresh;

  // Adopt a live run on mount (page reloaded mid-update) or show the last one.
  useEffect(() => {
    let cancelled = false;
    api.getUpdateProgress(undefined, { tail: 4096 })
      .then((p) => {
        if (cancelled || !p || !p.id) return;
        if (LIVE.has(p.status) && p.live !== false) {
          setRun(p);
          setRunId(p.id);
        } else if (p.status !== 'idle') {
          setLast(p);
        }
      })
      .catch(() => { /* no agent / nothing recorded: the button explains */ });
    return () => { cancelled = true; };
  }, []);

  // Poll while following a run. Fetch failures are expected mid-run.
  useEffect(() => {
    if (!runId) return undefined;
    let cancelled = false;
    let timer = null;
    const tick = async () => {
      try {
        const p = await api.getUpdateProgress(runId, { tail: 16384 });
        if (cancelled) return;
        setFailures(0);
        setRun(p);
        if (p.id === runId && TERMINAL.has(p.status)) {
          setRunId(null);
          setLast(p);
          refreshRef.current?.();
          return;
        }
      } catch {
        if (cancelled) return;
        setFailures((f) => f + 1);
      }
      timer = setTimeout(tick, POLL_MS);
    };
    tick();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [runId]);

  // Keep the log tail scrolled to the newest line.
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [run?.log_tail]);

  const openConfirm = () => {
    setRebuild(!updateInfo?.updateAvailable);
    setConfirmOpen(true);
  };

  const start = async () => {
    setStarting(true);
    try {
      const r = await api.startUpdate({ rebuild });
      setConfirmOpen(false);
      setFailures(0);
      setLast(null);
      setRun({ id: r.id, status: 'queued', phase: 'Queued', phase_index: 0, phases: [], log_tail: '' });
      setRunId(r.id);
      toast({ title: 'Update requested', description: 'The host runner has been asked to run update.sh.' });
    } catch (err) {
      toast({ variant: 'destructive', title: 'Update not started', description: err.message });
      refreshRef.current?.();
    } finally {
      setStarting(false);
    }
  };

  const info = updateInfo;
  const installed = info?.installed;
  const standards = info?.standards;
  const following = !!runId;
  const restarting = following && failures >= FAILURES_BEFORE_RESTARTING;
  const disabledReason = starting
    ? 'Starting…'
    : following
      ? 'An update is running'
      : !info
        ? (checking ? 'Checking for updates…' : 'Check for updates first')
        : info.cannotUpdateReason;

  const shown = run || last;
  const phases = shown?.phases || [];

  return (
    <div className="space-y-4">
      {/* Installed / latest / standards */}
      <div className="rounded-lg bg-muted p-4 space-y-3 text-sm">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <span className="text-muted-foreground">Installed</span>
          <span className="font-medium break-all">
            v{info?.currentVersion || '…'}
            {installed?.short_sha && <span className="font-mono text-xs text-muted-foreground"> · {installed.short_sha}</span>}
            {installed?.branch && <span className="text-xs text-muted-foreground"> · {installed.branch}</span>}
          </span>
        </div>
        {installed?.head_date && (
          <p className="text-xs text-muted-foreground -mt-2">
            Commit from {fmtWhen(installed.head_date)}{installed.head_subject ? ` — ${installed.head_subject}` : ''}
          </p>
        )}
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <span className="text-muted-foreground">Latest</span>
          <span className="font-medium break-all">
            v{info?.latestVersion || '…'}
            {info?.latest_sha_short && <span className="font-mono text-xs text-muted-foreground"> · {info.latest_sha_short}</span>}
            {Number.isFinite(info?.commits_behind) && info.commits_behind > 0 && (
              <span className="text-xs text-muted-foreground"> · {info.commits_behind} commit{info.commits_behind === 1 ? '' : 's'} behind</span>
            )}
          </span>
        </div>
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <span className="text-muted-foreground">Status</span>
          <span className={`font-medium ${info?.updateAvailable ? 'text-primary' : 'text-green-500'}`}>
            {!info ? '…' : info.updateAvailable
              ? (info.updateReason === 'newer_commit' ? 'Newer commit available' : 'Update available')
              : (info.updateReason === 'unknown' ? 'Unknown' : 'Up to date')}
          </span>
        </div>
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <span className="text-muted-foreground">Mock2 standards</span>
          <span className="font-medium text-right">
            {standards ? (
              <>
                seed {standards.seed_version || '?'}
                {standards.site_version
                  ? <>, site {standards.site_version} — {standards.update_available
                    ? <span className="text-primary">site {standards.site_version} available, update ProxyPilot to pick it up</span>
                    : <span className="text-green-500">current</span>}</>
                  : <span className="text-muted-foreground">, site unreachable</span>}
              </>
            ) : '…'}
          </span>
        </div>
        {info?.github?.error && (
          <p className="text-xs text-muted-foreground">GitHub: {info.github.error}</p>
        )}
        {info?.releaseUrl && (
          <div className="pt-2 border-t">
            <a href={info.releaseUrl} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-[44px] items-center gap-1 text-primary hover:underline">
              <Download className="h-4 w-4" /> View release notes
            </a>
          </div>
        )}
      </div>

      {/* Warnings that disable the button */}
      {installed && !installed.reachable && (
        <div className="flex items-start gap-2 rounded-md border border-yellow-500/50 bg-yellow-500/10 p-3 text-sm">
          <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5 text-yellow-600" />
          <div>
            <p className="font-medium">Host agent unreachable</p>
            <p className="text-muted-foreground break-words">{installed.error || 'proxypilot-agent is not answering; updates need it.'}</p>
          </div>
        </div>
      )}
      {installed?.reachable && !installed.configured && (
        <div className="flex items-start gap-2 rounded-md border border-yellow-500/50 bg-yellow-500/10 p-3 text-sm">
          <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5 text-yellow-600" />
          <p className="text-muted-foreground break-words">{installed.error || 'No checkout recorded on the host yet — run update.sh once by hand.'}</p>
        </div>
      )}
      {installed?.dirty && (
        <div className="flex items-start gap-2 rounded-md border border-yellow-500/50 bg-yellow-500/10 p-3 text-sm">
          <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5 text-yellow-600" />
          <div className="min-w-0">
            <p className="font-medium">Local changes on the host</p>
            <p className="text-muted-foreground">
              {installed.dirty_count} uncommitted change{installed.dirty_count === 1 ? '' : 's'} in {installed.source_dir || 'the checkout'}. update.sh refuses to run over them; commit, stash or discard them on the host.
            </p>
            {installed.dirty_files?.length > 0 && (
              <pre className="mt-1 max-h-24 overflow-auto rounded bg-background/60 p-2 text-xs">{installed.dirty_files.join('\n')}</pre>
            )}
          </div>
        </div>
      )}

      {/* Action */}
      <div className="flex flex-wrap items-center gap-2">
        <Button className="min-h-[44px]" onClick={openConfirm} disabled={!!disabledReason}>
          {starting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <ArrowUpCircle className="mr-2 h-4 w-4" />}
          Update now
        </Button>
        {disabledReason && !following && (
          <span className="text-xs text-muted-foreground break-words">{disabledReason}</span>
        )}
      </div>

      {/* Progress / last run */}
      {shown && shown.status && shown.status !== 'idle' && (
        <div className="rounded-lg border p-4 space-y-3 text-sm" aria-live="polite">
          <div className="flex flex-wrap items-center gap-2">
            {shown.status === 'success' && <CheckCircle2 className="h-5 w-5 text-green-500" />}
            {shown.status === 'failed' && <XCircle className="h-5 w-5 text-destructive" />}
            {shown.status === 'refused' && <AlertTriangle className="h-5 w-5 text-yellow-600" />}
            {LIVE.has(shown.status) && <Loader2 className="h-5 w-5 animate-spin text-primary" />}
            <span className="font-medium">
              {shown.status === 'success' && (shown.up_to_date ? 'Already up to date' : 'Update complete')}
              {shown.status === 'failed' && 'Update failed'}
              {shown.status === 'refused' && 'Update refused'}
              {shown.status === 'queued' && 'Waiting for the host runner…'}
              {shown.status === 'running' && (restarting ? 'Restarting…' : `Updating — ${shown.phase || 'working'}`)}
            </span>
            {!following && shown.finished_at && (
              <span className="text-xs text-muted-foreground">{fmtWhen(shown.finished_at)}</span>
            )}
          </div>
          {restarting && (
            <p className="text-xs text-muted-foreground">
              The container is being rebuilt; the dashboard is unreachable for a minute or two. This page keeps polling and reconnects on its own.
            </p>
          )}
          {shown.reason && (
            <p className="text-muted-foreground break-words">{shown.reason}</p>
          )}
          {(shown.from_sha || shown.to_sha) && (
            <p className="font-mono text-xs text-muted-foreground break-all">
              {(shown.from_sha || '?').slice(0, 10)} → {(shown.to_sha || '…').slice(0, 10)}
              {shown.from_version && shown.to_version && shown.from_version !== shown.to_version ? ` (v${shown.from_version} → v${shown.to_version})` : ''}
              {shown.requested_by ? ` · requested by ${shown.requested_by}` : ''}
            </p>
          )}
          {phases.length > 0 && (
            <ul className="grid grid-cols-1 sm:grid-cols-3 gap-x-4 gap-y-1">
              {phases.map((p) => (
                <li key={p.index} className={`flex items-center gap-2 ${p.state === 'pending' ? 'text-muted-foreground' : ''}`}>
                  <PhaseIcon state={p.state} />
                  <span className="truncate">{p.label}</span>
                </li>
              ))}
            </ul>
          )}
          {shown.log_tail && (
            <pre ref={logRef} className="max-h-64 overflow-auto rounded bg-muted p-2 text-xs whitespace-pre-wrap break-all">{shown.log_tail}</pre>
          )}
          {shown.log_path && !following && (
            <p className="text-xs text-muted-foreground break-all">Full log on the host: {shown.log_path}</p>
          )}
          {shown.status === 'success' && !following && (
            <div className="flex flex-wrap gap-2">
              <Button className="min-h-[44px]" onClick={() => window.location.reload()}>
                <RotateCw className="mr-2 h-4 w-4" /> Reload dashboard
              </Button>
              <span className="self-center text-xs text-muted-foreground">The new build is live; reload to use it.</span>
            </div>
          )}
        </div>
      )}

      {/* Confirm */}
      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent className="max-w-full h-full rounded-none sm:max-w-md sm:h-auto sm:rounded-lg flex flex-col">
          <DialogHeader>
            <DialogTitle>Update ProxyPilot?</DialogTitle>
            <DialogDescription>
              {info?.updateAvailable
                ? `v${info.currentVersion} → v${info.latestVersion}${info.latest_sha_short ? ` (${info.latest_sha_short})` : ''}`
                : 'The checkout is already up to date; enable the rebuild switch to rebuild anyway.'}
            </DialogDescription>
          </DialogHeader>
          <div className="flex-1 overflow-y-auto space-y-3 text-sm">
            <ul className="list-disc pl-5 space-y-1">
              <li>The database is backed up first and restored automatically if the update fails.</li>
              <li>Pulls the latest code from GitHub{info?.github?.repo ? ` (${info.github.repo})` : ''}{installed?.branch ? ` on ${installed.branch}` : ''}, rebuilds the host agent, installs dependencies and builds the dashboard.</li>
              <li>Rebuilds and restarts the container: the dashboard and API are unavailable for about 1–2 minutes. This page keeps polling and reconnects.</li>
              <li>Project containers and anything running in them are not touched.</li>
            </ul>
            <div className="flex items-center justify-between gap-3 rounded-md border p-3">
              <Label htmlFor="pp-update-rebuild" className="text-sm">Force rebuild even if already up to date</Label>
              <Switch id="pp-update-rebuild" checked={rebuild} onCheckedChange={setRebuild} />
            </div>
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" className="min-h-[44px]" onClick={() => setConfirmOpen(false)} disabled={starting}>
              Cancel
            </Button>
            <Button className="min-h-[44px]" onClick={start} disabled={starting}>
              {starting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <ArrowUpCircle className="mr-2 h-4 w-4" />}
              Update now
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
