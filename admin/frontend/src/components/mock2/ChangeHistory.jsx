// ChangeHistory — the project's append-only, hash-chained change history, with a
// chain-verification badge, per-change troubleshooting detail, and a downloadable
// build transcript.
//
// Each record is one build checkpoint. Expanding it loads that cycle's full
// transcript (mock2GetCycleLog) for INSPECTION — the task text, every AI message,
// tool call/result, gate outcomes, the checkpoint and the deploy.
//
// DOWNLOADS are request-scoped: one build request = ONE log. A request that
// halted/resumed/retried spans several checkpoints, but "Download log" on any of
// them fetches the request's merged, deduplicated artifact (mock2GetRequestLog),
// which is idempotent per content — every checkpoint of the same request saves
// the same file. Only a legacy record whose cycle predates the request umbrella
// (request_id null) falls back to its per-cycle log.
//
// MOBILE_FIRST: single column, wrapping rows, 44px expand targets; clean at 360px.

import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { useToast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import {
  ShieldCheck, XCircle, ChevronDown, ChevronRight, ChevronLeft, GitCommitHorizontal, Loader2, Coins, Download,
} from 'lucide-react';
import { fmtUsage } from './ProjectTimeCard';

const GATE_TONE = {
  passed: 'text-green-600', failed: 'text-red-500', running: 'text-cyan-500', pending: 'text-muted-foreground',
};

// Event kind → a compact label + tone for the transcript view.
const EVENT_LABEL = {
  task: { label: 'Task', tone: 'text-primary' },
  ai_message: { label: 'AI', tone: 'text-cyan-600' },
  tool_call: { label: 'Tool →', tone: 'text-violet-500' },
  tool_result: { label: 'Result ←', tone: 'text-muted-foreground' },
  gate: { label: 'Gates', tone: 'text-amber-600' },
  checkpoint: { label: 'Checkpoint', tone: 'text-emerald-600' },
  deploy: { label: 'Deploy', tone: 'text-emerald-600' },
  note: { label: 'Note', tone: 'text-muted-foreground' },
};

// Trigger a client-side download of an object as pretty JSON (no server round-trip
// beyond the fetch that already happened). Self-contained; revokes the blob URL.
function downloadJson(filename, obj) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function EventRow({ ev }) {
  const meta = EVENT_LABEL[ev.kind] || { label: ev.kind, tone: 'text-muted-foreground' };
  const toolName = ev.meta?.name;
  const tokens = ev.kind === 'ai_message' && ev.meta
    ? `${(ev.meta.output_tokens ?? 0)} out · ${(ev.meta.input_tokens ?? 0)} in`
    : null;
  const hasBody = ev.content && ev.content.trim().length > 0;
  return (
    <div className="rounded-md border bg-background/40 px-2 py-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className={`text-[11px] font-medium ${meta.tone}`}>
          {meta.label}{toolName ? ` ${toolName}` : ''}
        </span>
        {tokens ? <span className="font-mono text-[10px] text-muted-foreground whitespace-nowrap">{tokens}</span> : null}
      </div>
      {ev.kind === 'tool_call' && ev.meta?.input ? (
        <pre className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap break-words text-[11px] text-muted-foreground">{JSON.stringify(ev.meta.input, null, 2)}</pre>
      ) : null}
      {hasBody ? (
        <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words text-[11px] text-foreground/90">{ev.content}</pre>
      ) : null}
    </div>
  );
}

function ChangeDetail({ projectId, record }) {
  const { toast } = useToast();
  const [loading, setLoading] = useState(true);
  const [log, setLog] = useState(null); // { cycle, events, messages, ... }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        // The cycle log carries the full transcript (events) + the linked cycle
        // (gate results). Best-effort — a record can pre-date a cycle (the design
        // sign-off #1), in which case we just show what the record itself holds.
        const l = record.cycle_id != null ? await api.mock2GetCycleLog(projectId, record.cycle_id).catch(() => null) : null;
        if (!cancelled) setLog(l);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [projectId, record.cycle_id]);

  const gates = log?.cycle?.gates || [];
  const events = log?.events || [];
  const rules = Array.isArray(record.rules_touched) ? record.rules_touched : [];

  // One build request = one log: download the request's merged artifact under
  // its stable, content-hashed filename, so every checkpoint of the same request
  // yields the SAME file. Per-cycle fallback only for legacy records.
  const download = async () => {
    try {
      if (record.request_id != null) {
        const artifact = await api.mock2GetRequestLog(projectId, record.request_id);
        downloadJson(artifact.filename || `request-${record.request_id}.json`, artifact);
        return;
      }
      const full = log || (record.cycle_id != null ? await api.mock2GetCycleLog(projectId, record.cycle_id) : { record });
      downloadJson(`build-log-change-${record.seq}.json`, full);
    } catch (err) {
      toast({ variant: 'destructive', title: 'Could not build the log', description: err.message });
    }
  };

  return (
    <div className="mt-2 space-y-3 border-t pt-2.5">
      {/* Commit + spend + download */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
          <span className="inline-flex items-center gap-1">
            <GitCommitHorizontal className="h-3.5 w-3.5" />
            <span className="font-mono">{record.commit_sha ? record.commit_sha.slice(0, 8) : 'no commit'}</span>
          </span>
          {record.request_id != null ? (
            <span className="rounded-full bg-muted px-2 py-0.5 font-mono">request #{record.request_id}</span>
          ) : null}
          {record.used_tokens != null || record.used_cost_cents != null ? (
            <span className="inline-flex items-center gap-1">
              <Coins className="h-3.5 w-3.5" />
              <span className="font-mono">{fmtUsage(record.used_tokens, record.used_cost_cents)}</span>
            </span>
          ) : null}
        </div>
        <Button variant="outline" size="sm" className="h-8" onClick={download}>
          <Download className="h-3.5 w-3.5 mr-1" /> {record.request_id != null ? 'Download request log' : 'Download log'}
        </Button>
      </div>

      {/* Rules touched */}
      {rules.length ? (
        <div className="space-y-1">
          <p className="text-[11px] font-medium text-muted-foreground">Rules touched</p>
          <div className="flex flex-wrap gap-1">
            {rules.map((r, i) => (
              <span key={i} className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-mono break-all">{String(r)}</span>
            ))}
          </div>
        </div>
      ) : null}

      {/* Gate results */}
      <div className="space-y-1">
        <p className="text-[11px] font-medium text-muted-foreground">Gate results</p>
        {loading ? (
          <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground"><Loader2 className="h-3 w-3 animate-spin" /> Loading…</p>
        ) : gates.length ? (
          <ul className="space-y-0.5">
            {gates.map((g, i) => (
              <li key={i} className="flex items-center justify-between gap-2 text-[11px]">
                <span className="font-mono truncate">{g.name}</span>
                <span className={`font-medium whitespace-nowrap ${GATE_TONE[g.status] || 'text-muted-foreground'}`}>{g.status}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[11px] text-muted-foreground">
            {Array.isArray(record.gates_run) && record.gates_run.length
              ? record.gates_run.join(', ')
              : 'No gate results recorded for this change.'}
          </p>
        )}
      </div>

      {/* Full transcript — what the AI actually did */}
      <div className="space-y-1.5">
        <p className="text-[11px] font-medium text-muted-foreground">AI interactions &amp; actions</p>
        {loading ? (
          <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground"><Loader2 className="h-3 w-3 animate-spin" /> Loading…</p>
        ) : events.length ? (
          <div className="space-y-1.5">
            {events.map((ev, i) => <EventRow key={i} ev={ev} />)}
          </div>
        ) : (
          <p className="text-[11px] text-muted-foreground">
            No transcript recorded for this change (it predates transcript logging, or was a non-runner checkpoint).
          </p>
        )}
      </div>
    </div>
  );
}

export default function ChangeHistory({ projectId }) {
  const { toast } = useToast();
  const [data, setData] = useState(null); // { records, verification } | null
  const [error, setError] = useState(false);
  const [expanded, setExpanded] = useState(null); // seq of the open row, or null
  const [downloadingAll, setDownloadingAll] = useState(false);
  const [page, setPage] = useState(0); // 0-based page of change records (newest first)
  const PAGE_SIZE = 8;

  const load = useCallback(async () => {
    try {
      setData(await api.mock2GetChangeRecords(projectId));
      setError(false);
    } catch (err) {
      if (!(err instanceof ApiError)) console.error('load change records failed:', err);
      setError(true);
    }
  }, [projectId]);

  useEffect(() => { load(); }, [load]);

  const downloadAll = async () => {
    setDownloadingAll(true);
    try {
      const full = await api.mock2GetProjectLog(projectId);
      downloadJson(`build-log-project-${projectId}.json`, full);
    } catch (err) {
      toast({ variant: 'destructive', title: 'Could not build the full log', description: err.message });
    } finally {
      setDownloadingAll(false);
    }
  };

  if (error) return <p className="text-sm text-muted-foreground">Could not load the change history.</p>;
  if (!data) return <p className="flex items-center gap-1.5 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading change history…</p>;

  const { records = [], verification } = data;
  // Newest first, then paginate — a long history shouldn't wall of scroll.
  const ordered = [...records].sort((a, b) => b.seq - a.seq);
  const pageCount = Math.max(1, Math.ceil(ordered.length / PAGE_SIZE));
  const clampedPage = Math.min(page, pageCount - 1);
  const start = clampedPage * PAGE_SIZE;
  const shown = ordered.slice(start, start + PAGE_SIZE);
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs flex items-center gap-1">
          {verification?.ok
            ? <><ShieldCheck className="h-3.5 w-3.5 text-green-500" /> <span className="text-green-600">Hash chain verified ({verification.count} record{verification.count === 1 ? '' : 's'})</span></>
            : <><XCircle className="h-3.5 w-3.5 text-red-500" /> <span className="text-red-500">Chain broken at #{verification?.brokenAt}</span></>}
        </p>
        <Button variant="outline" size="sm" className="h-8" disabled={downloadingAll} onClick={downloadAll}>
          {downloadingAll ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <Download className="h-3.5 w-3.5 mr-1" />}
          Download full log
        </Button>
      </div>
      {records.length === 0 ? (
        <p className="text-xs text-muted-foreground">No change records yet.</p>
      ) : (
        <ul className="space-y-1.5">
          {shown.map((r) => {
            const open = expanded === r.seq;
            return (
              <li key={r.seq} className="text-xs border rounded-md">
                <button
                  type="button"
                  className="flex w-full items-start gap-2 px-2 py-2 text-left min-h-[44px]"
                  aria-expanded={open}
                  onClick={() => setExpanded(open ? null : r.seq)}
                >
                  {open ? <ChevronDown className="h-3.5 w-3.5 mt-0.5 shrink-0" /> : <ChevronRight className="h-3.5 w-3.5 mt-0.5 shrink-0" />}
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center justify-between gap-2">
                      <span className="font-mono">#{r.seq}</span>
                      <span className="font-mono text-muted-foreground truncate">{r.commit_sha ? r.commit_sha.slice(0, 8) : '—'}</span>
                    </span>
                    <span className="block truncate">{r.summary}</span>
                    {r.used_tokens != null || r.used_cost_cents != null ? (
                      <span className="mt-0.5 block font-mono text-[11px] text-muted-foreground">{fmtUsage(r.used_tokens, r.used_cost_cents)}</span>
                    ) : null}
                  </span>
                </button>
                {open ? <div className="px-2 pb-2"><ChangeDetail projectId={projectId} record={r} /></div> : null}
              </li>
            );
          })}
        </ul>
      )}
      {pageCount > 1 ? (
        <div className="flex items-center justify-between gap-2 pt-1">
          <Button variant="ghost" size="sm" className="h-8" disabled={clampedPage === 0} onClick={() => { setExpanded(null); setPage(clampedPage - 1); }}>
            <ChevronLeft className="h-3.5 w-3.5 mr-1" /> Newer
          </Button>
          <span className="text-[11px] text-muted-foreground">
            {start + 1}–{Math.min(start + PAGE_SIZE, ordered.length)} of {ordered.length}
          </span>
          <Button variant="ghost" size="sm" className="h-8" disabled={clampedPage >= pageCount - 1} onClick={() => { setExpanded(null); setPage(clampedPage + 1); }}>
            Older <ChevronRight className="h-3.5 w-3.5 ml-1" />
          </Button>
        </div>
      ) : null}
    </div>
  );
}
