// ChangeHistory — the project's append-only, hash-chained change history,
// GROUPED BY BUILD REQUEST: one build request = ONE entry = ONE log, however
// many checkpoints (rule confirmations, the build itself, halts/resumes) it took.
//
// Each top-level entry is a request: its instruction, cumulative spend, and its
// checkpoints nested inside — so a build is reviewed self-contained and compared
// against the others. Expanding a checkpoint loads that cycle's transcript
// (mock2GetCycleLog) for step-level inspection.
//
// Downloads, built for offline analysis/comparison:
//   - the per-row download icon saves THAT request's merged artifact
//     (mock2GetRequestLog), idempotent per content — the same request always
//     saves as the same file;
//   - the per-row checkboxes select multiple entries → "Download selected"
//     bundles them into one JSON document (browsers block a burst of separate
//     programmatic downloads, and one bundle diffs/compares cleanly);
//   - "Download all" bundles every entry the same way.
//
// Records whose cycle predates the request umbrella (request_id null) render as
// standalone single-checkpoint entries with their per-cycle log — legacy only.
// (A restore's own record is also cycle-less and renders the same way.)
//
// RESTORE: every checkpoint is a point in time. With canRestore, an expanded
// checkpoint offers "Restore to this checkpoint" — the server appends a NEW
// checkpoint whose code + database snapshot match the chosen one, and the next
// build works off it. The newest seq wears the "current" chip (the default,
// with no restore, is what was last built).
//
// MOBILE_FIRST: single column, wrapping rows, 44px expand targets; clean at 360px.

import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { useToast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import {
  ShieldCheck, XCircle, ChevronDown, ChevronRight, ChevronLeft, GitCommitHorizontal, Loader2, Coins, Download,
  RotateCcw,
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

const REQUEST_STATUS_TONE = {
  succeeded: 'text-green-600', open: 'text-cyan-600', failed: 'text-red-500', abandoned: 'text-muted-foreground',
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

// One checkpoint's inspection panel: gates, rules touched, and that cycle's own
// step transcript. The request-level log download lives on the GROUP header —
// only a legacy record (no request) still offers its per-cycle download here.
// The "current" chip — the checkpoint the next build works off (always the
// newest one, unless a restore has made an older tree current again).
function CurrentChip() {
  return <span className="rounded-full bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-600 whitespace-nowrap">current</span>;
}

function ChangeDetail({ projectId, record, isCurrent = false, canRestore = false, restoring = false, onRestore = null }) {
  const [loading, setLoading] = useState(true);
  const [log, setLog] = useState(null); // { cycle, events, messages, ... }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        // The cycle log carries the step transcript (events) + the linked cycle
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

  return (
    <div className="mt-2 space-y-3 border-t pt-2.5">
      {/* Commit + spend (downloads live on the entry row, not here) */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
        <span className="inline-flex items-center gap-1">
          <GitCommitHorizontal className="h-3.5 w-3.5" />
          <span className="font-mono">{record.commit_sha ? record.commit_sha.slice(0, 8) : 'no commit'}</span>
        </span>
        {record.used_tokens != null || record.used_cost_cents != null ? (
          <span className="inline-flex items-center gap-1">
            <Coins className="h-3.5 w-3.5" />
            <span className="font-mono">{fmtUsage(record.used_tokens, record.used_cost_cents)}</span>
          </span>
        ) : null}
      </div>

      {/* Restore — every checkpoint is a point in time; restoring appends a NEW
          checkpoint whose code + database snapshot match this one, and the next
          build works off it. The newest checkpoint IS the current state, so it
          offers no button. */}
      {canRestore ? (
        isCurrent ? (
          <p className="text-[11px] text-muted-foreground">
            This checkpoint is the current state — the next build works off it.
          </p>
        ) : record.commit_sha ? (
          <div className="space-y-1">
            <Button
              variant="outline" size="sm" className="min-h-[44px] w-full sm:w-auto"
              disabled={restoring}
              onClick={onRestore}
            >
              {restoring ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="mr-1 h-3.5 w-3.5" />}
              Restore to this checkpoint
            </Button>
            <p className="text-[11px] text-muted-foreground">
              Rolls code and database back to this point in time as a new checkpoint — nothing above is deleted.
            </p>
          </div>
        ) : null
      ) : null}

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

      {/* Step transcript — what the AI actually did at this checkpoint */}
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

// One checkpoint row inside a request group (expandable to ChangeDetail).
function RecordRow({ projectId, record, open, onToggle, isCurrent = false, canRestore = false, restoring = false, onRestore = null }) {
  return (
    <li className="text-xs border rounded-md">
      <button
        type="button"
        className="flex w-full items-start gap-2 px-2 py-2 text-left min-h-[44px]"
        aria-expanded={open}
        onClick={onToggle}
      >
        {open ? <ChevronDown className="h-3.5 w-3.5 mt-0.5 shrink-0" /> : <ChevronRight className="h-3.5 w-3.5 mt-0.5 shrink-0" />}
        <span className="min-w-0 flex-1">
          <span className="flex items-center justify-between gap-2">
            <span className="inline-flex items-center gap-1.5">
              <span className="font-mono">#{record.seq}</span>
              {isCurrent ? <CurrentChip /> : null}
            </span>
            <span className="font-mono text-muted-foreground truncate">{record.commit_sha ? record.commit_sha.slice(0, 8) : '—'}</span>
          </span>
          <span className="block truncate">{record.summary}</span>
          {record.used_tokens != null || record.used_cost_cents != null ? (
            <span className="mt-0.5 block font-mono text-[11px] text-muted-foreground">{fmtUsage(record.used_tokens, record.used_cost_cents)}</span>
          ) : null}
        </span>
      </button>
      {open ? (
        <div className="px-2 pb-2">
          <ChangeDetail
            projectId={projectId} record={record}
            isCurrent={isCurrent} canRestore={canRestore} restoring={restoring} onRestore={onRestore}
          />
        </div>
      ) : null}
    </li>
  );
}

// Group the flat change records into build-request entries. Records sharing a
// request_id form one entry (newest first by their newest checkpoint); a legacy
// record with no request_id is its own single-checkpoint entry.
function groupByRequest(records, requestsById) {
  const groups = new Map();
  for (const r of records) {
    const key = r.request_id != null ? `req:${r.request_id}` : `legacy:${r.seq}`;
    if (!groups.has(key)) {
      groups.set(key, { key, request: r.request_id != null ? (requestsById.get(r.request_id) || { id: r.request_id }) : null, records: [] });
    }
    groups.get(key).records.push(r);
  }
  const out = [...groups.values()];
  for (const g of out) g.records.sort((a, b) => Number(b.seq || 0) - Number(a.seq || 0)); // newest checkpoint first
  // Entries order by MOST RECENT ACTIVITY: the newest checkpoint's hash-chain
  // seq, descending. Note the three number systems on screen are different:
  // "Build request #N" is the request id, "#N" on a checkpoint is the chain
  // seq — request #10 can legitimately contain change #77.
  out.sort((a, b) => Number(b.records[0].seq || 0) - Number(a.records[0].seq || 0));
  return out;
}

function sumGroupUsage(records) {
  let tokens = 0; let cents = 0; let any = false;
  for (const r of records) {
    if (r.used_tokens != null || r.used_cost_cents != null) any = true;
    tokens += Number(r.used_tokens || 0);
    cents += Number(r.used_cost_cents || 0);
  }
  return any ? { tokens, cents } : null;
}

export default function ChangeHistory({ projectId, canRestore = false }) {
  const { toast } = useToast();
  const [data, setData] = useState(null); // { records, verification } | null
  const [requestsById, setRequestsById] = useState(new Map());
  const [error, setError] = useState(false);
  const [openGroup, setOpenGroup] = useState(null);   // group key
  const [openRecord, setOpenRecord] = useState(null); // record seq
  const [selected, setSelected] = useState(() => new Set()); // group keys picked for a bundle
  const [downloadingKey, setDownloadingKey] = useState(null); // group key | 'selected' | 'all'
  const [page, setPage] = useState(0); // 0-based page of request entries (newest first)
  const PAGE_SIZE = 6;

  const load = useCallback(async () => {
    try {
      // Requests carry the instruction + final status for the group headers;
      // best-effort so the history still renders if that fetch fails.
      const [records, requests] = await Promise.all([
        api.mock2GetChangeRecords(projectId),
        api.mock2ListRequests(projectId).catch(() => ({ requests: [] })),
      ]);
      setData(records);
      setRequestsById(new Map((requests.requests || []).map((r) => [r.id, r])));
      setError(false);
    } catch (err) {
      if (!(err instanceof ApiError)) console.error('load change records failed:', err);
      setError(true);
    }
  }, [projectId]);

  useEffect(() => { load(); }, [load]);

  // One entry = one log. A request entry fetches its merged, content-hashed
  // artifact; a legacy (pre-request) entry falls back to its per-cycle log,
  // wrapped in the same envelope so bundles have one uniform shape to analyze.
  const fetchGroupLog = async (group) => {
    if (group.request) {
      const artifact = await api.mock2GetRequestLog(projectId, group.request.id);
      return { filename: artifact.filename || `request-${group.request.id}.json`, ...artifact };
    }
    const head = group.records[0];
    const log = head.cycle_id != null
      ? await api.mock2GetCycleLog(projectId, head.cycle_id)
      : { record: head };
    return { filename: `build-log-change-${head.seq}.json`, legacy: true, log };
  };

  const downloadOne = async (group) => {
    setDownloadingKey(group.key);
    try {
      const one = await fetchGroupLog(group);
      downloadJson(one.filename, one);
    } catch (err) {
      toast({ variant: 'destructive', title: 'Could not build the log', description: err.message });
    } finally {
      setDownloadingKey(null);
    }
  };

  // Bundle several entries into ONE JSON document (a burst of separate
  // programmatic downloads gets blocked by browsers; one bundle also
  // diffs/compares cleanly). Sequential fetches — the counts are small.
  const downloadBundle = async (targetGroups, label) => {
    setDownloadingKey(label);
    try {
      const logs = [];
      for (const g of targetGroups) logs.push(await fetchGroupLog(g));
      downloadJson(`build-logs-project-${projectId}-${label}-${logs.length}.json`, {
        project_id: projectId,
        generated_at: new Date().toISOString(),
        count: logs.length,
        logs,
      });
    } catch (err) {
      toast({ variant: 'destructive', title: 'Could not build the log bundle', description: err.message });
    } finally {
      setDownloadingKey(null);
    }
  };

  // Restore — roll the project back to a checkpoint. Append-only on the server
  // (a NEW checkpoint restores that point's code + database snapshot), so the
  // history list only ever grows; reload shows the new "current".
  const [restoringSeq, setRestoringSeq] = useState(null);
  const restore = async (record) => {
    if (!window.confirm(
      `Restore the project to checkpoint #${record.seq}?\n\n` +
      'Code and database roll back to that point in time as a NEW checkpoint — nothing is deleted, ' +
      'and the next build works off the restored state.',
    )) return;
    setRestoringSeq(record.seq);
    try {
      const r = await api.mock2RestoreCheckpoint(projectId, record.seq);
      toast({
        title: `Restored to checkpoint #${record.seq}`,
        description: r.db === 'restored'
          ? `Code and database now match that point in time (new checkpoint #${r.record_seq ?? '—'}).`
          : `Code now matches that point in time (new checkpoint #${r.record_seq ?? '—'})${r.db === 'no_snapshot' ? ' — that checkpoint predates database snapshots, so the database was left as-is' : ''}.`,
      });
      setOpenGroup(null); setOpenRecord(null); setPage(0);
      await load();
    } catch (err) {
      toast({ variant: 'destructive', title: 'Restore failed', description: err.message });
    } finally {
      setRestoringSeq(null);
    }
  };

  const toggleSelected = (key) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  if (error) return <p className="text-sm text-muted-foreground">Could not load the change history.</p>;
  if (!data) return <p className="flex items-center gap-1.5 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading change history…</p>;

  const { records = [], verification } = data;
  // The newest chain seq IS the current state — what the next build works off
  // by default (a restore appends a new checkpoint, so this stays true).
  const latestSeq = records.reduce((m, r) => Math.max(m, Number(r.seq || 0)), 0);
  const groups = groupByRequest(records, requestsById);
  const pageCount = Math.max(1, Math.ceil(groups.length / PAGE_SIZE));
  const clampedPage = Math.min(page, pageCount - 1);
  const start = clampedPage * PAGE_SIZE;
  const shown = groups.slice(start, start + PAGE_SIZE);

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs flex items-center gap-1">
          {verification?.ok
            ? <><ShieldCheck className="h-3.5 w-3.5 text-green-500" /> <span className="text-green-600">Hash chain verified ({verification.count} record{verification.count === 1 ? '' : 's'})</span></>
            : <><XCircle className="h-3.5 w-3.5 text-red-500" /> <span className="text-red-500">Chain broken at #{verification?.brokenAt}</span></>}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          {selected.size > 0 ? (
            <>
              <Button variant="outline" size="sm" className="h-8" disabled={downloadingKey === 'selected'}
                onClick={() => downloadBundle(groups.filter((g) => selected.has(g.key)), 'selected')}>
                {downloadingKey === 'selected' ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <Download className="h-3.5 w-3.5 mr-1" />}
                Download selected ({selected.size})
              </Button>
              <Button variant="ghost" size="sm" className="h-8" onClick={() => setSelected(new Set())}>Clear</Button>
            </>
          ) : null}
          <Button variant="outline" size="sm" className="h-8" disabled={downloadingKey === 'all' || groups.length === 0}
            onClick={() => downloadBundle(groups, 'all')}>
            {downloadingKey === 'all' ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <Download className="h-3.5 w-3.5 mr-1" />}
            Download all
          </Button>
        </div>
      </div>
      {records.length === 0 ? (
        <p className="text-xs text-muted-foreground">No change records yet.</p>
      ) : (
        <ul className="space-y-2">
          {shown.map((g) => {
            const open = openGroup === g.key;
            const isRequest = !!g.request;
            const head = g.records[0];
            const usage = sumGroupUsage(g.records);
            const instruction = g.request?.instruction || head.summary;
            const status = g.request?.final_status || g.request?.status || null;
            return (
              <li key={g.key} className="text-xs border rounded-md">
                {/* Row = select checkbox · expand toggle · download icon. The
                    checkbox and icon sit OUTSIDE the toggle so a tap on either
                    never also expands/collapses the entry. */}
                <div className="flex items-start">
                  <label className="flex min-h-[44px] cursor-pointer items-center px-2" aria-label={`Select ${isRequest ? `build request ${g.request.id}` : `change ${head.seq}`} for download`}>
                    <input
                      type="checkbox"
                      className="h-4 w-4 accent-primary"
                      checked={selected.has(g.key)}
                      onChange={() => toggleSelected(g.key)}
                    />
                  </label>
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 items-start gap-2 py-2 pr-1 text-left min-h-[44px]"
                    aria-expanded={open}
                    onClick={() => { setOpenGroup(open ? null : g.key); setOpenRecord(null); }}
                  >
                    {open ? <ChevronDown className="h-3.5 w-3.5 mt-0.5 shrink-0" /> : <ChevronRight className="h-3.5 w-3.5 mt-0.5 shrink-0" />}
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center justify-between gap-x-2 gap-y-0.5">
                        <span className="font-medium">
                          {isRequest ? `Build request #${g.request.id}` : `Change #${head.seq}`}
                        </span>
                        <span className="flex items-center gap-2">
                          {Number(head.seq) === latestSeq ? <CurrentChip /> : null}
                          {status ? <span className={`font-medium ${REQUEST_STATUS_TONE[status] || 'text-muted-foreground'}`}>{status}</span> : null}
                          <span className="font-mono text-muted-foreground">{head.commit_sha ? head.commit_sha.slice(0, 8) : '—'}</span>
                        </span>
                      </span>
                      <span className="block truncate">{instruction}</span>
                      {/* The visible SORT KEY: entries order by their newest
                          checkpoint's hash-chain seq (most recent activity
                          first) — show it so the ordering is self-evident. */}
                      <span className="mt-0.5 block font-mono text-[11px] text-muted-foreground">
                        {g.records.length} checkpoint{g.records.length === 1 ? '' : 's'}
                        {` · latest #${head.seq}${head.created_at ? ` (${head.created_at.slice(0, 10)})` : ''}`}
                        {usage ? ` · ${fmtUsage(usage.tokens, usage.cents)}` : ''}
                      </span>
                    </span>
                  </button>
                  <Button
                    variant="ghost" size="sm"
                    className="h-11 w-11 shrink-0 p-0"
                    aria-label={`Download log for ${isRequest ? `build request ${g.request.id}` : `change ${head.seq}`}`}
                    disabled={downloadingKey === g.key}
                    onClick={() => downloadOne(g)}
                  >
                    {downloadingKey === g.key ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                  </Button>
                </div>
                {open ? (
                  <div className="space-y-1.5 px-2 pb-2">
                    <ul className="space-y-1.5">
                      {g.records.map((r) => (
                        <RecordRow
                          key={r.seq}
                          projectId={projectId}
                          record={r}
                          open={openRecord === r.seq}
                          onToggle={() => setOpenRecord(openRecord === r.seq ? null : r.seq)}
                          isCurrent={Number(r.seq) === latestSeq}
                          canRestore={canRestore}
                          restoring={restoringSeq === r.seq}
                          onRestore={() => restore(r)}
                        />
                      ))}
                    </ul>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      {pageCount > 1 ? (
        <div className="flex items-center justify-between gap-2 pt-1">
          <Button variant="ghost" size="sm" className="h-8" disabled={clampedPage === 0} onClick={() => { setOpenGroup(null); setOpenRecord(null); setPage(clampedPage - 1); }}>
            <ChevronLeft className="h-3.5 w-3.5 mr-1" /> Newer
          </Button>
          <span className="text-[11px] text-muted-foreground">
            {start + 1}–{Math.min(start + PAGE_SIZE, groups.length)} of {groups.length} entr{groups.length === 1 ? 'y' : 'ies'} · newest activity first
          </span>
          <Button variant="ghost" size="sm" className="h-8" disabled={clampedPage >= pageCount - 1} onClick={() => { setOpenGroup(null); setOpenRecord(null); setPage(clampedPage + 1); }}>
            Older <ChevronRight className="h-3.5 w-3.5 ml-1" />
          </Button>
        </div>
      ) : null}
    </div>
  );
}
