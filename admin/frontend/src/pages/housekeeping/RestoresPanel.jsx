// Restores panel — past + in-flight restore_runs.
//
// Two modes:
//   Compact list: all rows, newest first, sortable by status.
//   Detail view:  per-run state machine — each step's start ts,
//                 status, and any error / detail blob.  Polls
//                 GET /restores/:id every 2s while status is
//                 'running' so the operator sees live progress.
//
// The panel is expanded by default when the parent passes a
// `focusRunId` (e.g. just-started restore from the dialog).

import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useToast } from '@/hooks/use-toast';
import {
  CheckCircle2, ChevronDown, ChevronRight, Clock, FlaskConical, Loader2, RefreshCw, Sparkles, XCircle,
} from 'lucide-react';

function fmtAge(iso) {
  if (!iso) return '—';
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return 'just now';
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`;
  return `${Math.round(ms / 86_400_000)}d ago`;
}

function StatusPill({ status }) {
  if (status === 'ok') {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400">
        <CheckCircle2 className="h-3.5 w-3.5" /> ok
      </span>
    );
  }
  if (status === 'running') {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400">
        <Loader2 className="h-3.5 w-3.5 animate-spin" /> running
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-xs text-red-600 dark:text-red-400">
      <XCircle className="h-3.5 w-3.5" /> {status || 'failed'}
    </span>
  );
}

function StepLine({ step }) {
  const ok = step.status === 'ok';
  const failed = step.status === 'failed';
  const partial = step.status === 'partial';
  return (
    <div className="grid grid-cols-[7rem_5rem_1fr] gap-2 text-xs items-baseline">
      <span className="font-mono text-muted-foreground truncate" title={step.ts}>
        {new Date(step.ts).toLocaleTimeString()}
      </span>
      <span className={`font-mono ${ok ? 'text-emerald-600' : failed ? 'text-red-600' : partial ? 'text-amber-600' : 'text-muted-foreground'}`}>
        {step.stage}
      </span>
      <span className="font-mono text-muted-foreground break-all">
        {step.status}
        {step.error ? ` — ${step.error}` : ''}
        {step.size_bytes != null ? ` (${step.size_bytes} B)` : ''}
        {step.tier ? ` tier=${step.tier}` : ''}
        {step.file_count != null ? ` files=${step.file_count}` : ''}
        {step.mismatches != null && step.mismatches > 0 ? ` mismatches=${step.mismatches}` : ''}
        {step.missing != null && step.missing > 0 ? ` missing=${step.missing}` : ''}
        {step.extra != null && step.extra > 0 ? ` extra=${step.extra}` : ''}
        {step.imported != null ? ` imported=${step.imported}` : ''}
        {step.dir ? ` dir=${step.dir}` : ''}
      </span>
    </div>
  );
}

function RestoreDetail({ runId, onClose }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  // notFound is sticky: once the run is genuinely gone (404),
  // there's no point continuing to poll — the row was either
  // deleted (cascade from a backup delete) or never existed.
  // Without this gate the bare `catch {}` below kept the 2s
  // interval running forever and filled the network panel
  // with "restore run not found" responses.
  const [notFound, setNotFound] = useState(false);
  const pollRef = useRef(null);

  const stopPolling = () => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  };

  const refresh = async () => {
    try {
      const r = await api.backupsGetRestore(runId);
      setData(r.restore);
      // Stop polling once we hit a terminal state.
      if (r.restore?.status !== 'running') stopPolling();
    } catch (err) {
      // 404 = run genuinely gone; stop the poll so we don't
      // hammer the API.  Other errors (network blip, 5xx) are
      // tolerated — the next tick retries.
      const status = err instanceof ApiError ? err.status : null;
      if (status === 404) {
        setNotFound(true);
        stopPolling();
      }
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    setNotFound(false); // re-arm if the operator clicks a different run
    refresh();
    pollRef.current = setInterval(refresh, 2000);
    return () => stopPolling();
    /* eslint-disable-next-line */
  }, [runId]);

  if (notFound) {
    return (
      <Card>
        <CardContent className="py-4 text-sm text-muted-foreground flex items-center justify-between gap-3">
          <span>
            Restore run <code className="font-mono">{runId.slice(0, 8)}…</code> no
            longer exists.  It was likely cleaned up alongside its backup; nothing
            more to show.
          </span>
          <Button variant="outline" size="sm" onClick={onClose}>Close</Button>
        </CardContent>
      </Card>
    );
  }

  if (!data) {
    return (
      <Card>
        <CardContent className="py-4 text-sm text-muted-foreground">
          {loading ? 'Loading restore run…' : 'Restore run not found.'}
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start gap-3">
          <FlaskConical className="h-5 w-5 mt-0.5 text-muted-foreground" />
          <div className="space-y-1 flex-1 min-w-0">
            <CardTitle className="text-base">
              Restore <code className="font-mono text-xs">{data.id.slice(0, 8)}…</code>
            </CardTitle>
            <CardDescription className="text-xs">
              <span className="font-mono">target={data.target}</span>
              {' · '}
              <span className="font-mono">mode={data.mode}</span>
              {' · '}
              backup <code className="font-mono">{data.backup_id.slice(0, 8)}…</code>
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <StatusPill status={data.status} />
            <Button variant="outline" size="sm" onClick={refresh}>
              <RefreshCw className="h-3.5 w-3.5 mr-1.5" /> Refresh
            </Button>
            <Button variant="ghost" size="sm" onClick={onClose}>Close</Button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <div className="space-y-1">
          {(data.steps || []).map((s, i) => <StepLine key={i} step={s} />)}
        </div>
        {data.sandbox_dir && (
          <div className="mt-3 text-xs text-muted-foreground">
            Sandbox: <code className="font-mono text-foreground break-all">{data.sandbox_dir}</code>
          </div>
        )}
        {data.notes && (
          <div className="mt-2 text-xs">
            Notes: <span className="font-mono">{data.notes}</span>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default function RestoresPanel({ focusRunId, onUnfocus }) {
  const { toast } = useToast();
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState(focusRunId || null);

  useEffect(() => {
    if (focusRunId) setExpandedId(focusRunId);
  }, [focusRunId]);

  const refresh = async () => {
    setLoading(true);
    try {
      const r = await api.backupsListRestores();
      setItems(r.restores || []);
    } catch (err) {
      toast({
        title: 'Could not load restores',
        description: err instanceof ApiError ? err.message : (err?.message || 'unknown error'),
        variant: 'destructive',
      });
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { refresh(); /* eslint-disable-next-line */ }, []);

  // Auto-refresh while any run is in 'running' state so the
  // collapsed list reflects status changes without a manual click.
  useEffect(() => {
    const anyRunning = items.some((r) => r.status === 'running');
    if (!anyRunning) return undefined;
    const id = setInterval(refresh, 3000);
    return () => clearInterval(id);
    /* eslint-disable-next-line */
  }, [items]);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start gap-3">
          <Sparkles className="h-5 w-5 mt-0.5 text-muted-foreground" />
          <div className="space-y-1 flex-1">
            <CardTitle className="text-base">Restore dry-runs</CardTitle>
            <CardDescription className="text-xs">
              These are <strong>dry-runs</strong> — verifying that a backup is restorable, not
              actually overwriting production. Two modes: sandbox (decrypt + extract under a
              throwaway tmp dir) or manifest-only (decrypt + verify every file's sha256, no disk
              touch). Click a row for the live step machine.
            </CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={refresh} disabled={loading}>
            <RefreshCw className={`h-4 w-4 mr-1.5 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {expandedId && (
          <div className="mb-3">
            <RestoreDetail runId={expandedId} onClose={() => { setExpandedId(null); onUnfocus?.(); }} />
          </div>
        )}
        {items.length === 0 && !expandedId ? (
          <p className="text-xs text-muted-foreground">
            No dry-runs yet. Click <strong>Restore</strong> on any backup row to verify it's intact.
          </p>
        ) : items.length === 0 ? null : (
          <div className="space-y-1">
            {items.map((r) => (
              <button
                key={r.id}
                type="button"
                className="w-full text-left border rounded px-3 py-2 hover:bg-muted/40 transition-colors"
                onClick={() => setExpandedId(expandedId === r.id ? null : r.id)}
              >
                <div className="flex items-baseline gap-2 flex-wrap">
                  {expandedId === r.id ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                  <span className="font-mono text-xs">{r.id.slice(0, 8)}…</span>
                  <span className="text-xs text-muted-foreground">{r.target}</span>
                  <span className="ml-auto flex items-center gap-2 text-xs">
                    <Clock className="h-3 w-3" />
                    <span title={r.started_at}>{fmtAge(r.started_at)}</span>
                    <StatusPill status={r.status} />
                  </span>
                </div>
                {r.notes && (
                  <div className="text-[11px] text-muted-foreground truncate" title={r.notes}>
                    {r.notes}
                  </div>
                )}
              </button>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
