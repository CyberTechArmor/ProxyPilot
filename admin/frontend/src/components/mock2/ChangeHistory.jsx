// ChangeHistory — the project's append-only, hash-chained change history, with a
// chain-verification badge and per-change troubleshooting detail.
//
// Each record is one build checkpoint. It shows a compact line (seq, commit,
// summary, and the linked cycle's token/cost spend); expanding it fetches that
// cycle (mock2GetCycle) for the gate results and pulls the cycle's slice of the
// chat (mock2GetChat filtered to cycle_id) so you can see the AI interactions,
// the gates that ran, the commit, and the rules the change touched — everything
// needed to troubleshoot a single change without leaving the build view.
//
// MOBILE_FIRST: single column, wrapping rows, 44px expand targets; clean at 360px.

import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import {
  ShieldCheck, XCircle, ChevronDown, ChevronRight, GitCommitHorizontal, Loader2, Coins,
} from 'lucide-react';
import { ChatBubble } from './chat-messages';
import { fmtUsage } from './ProjectTimeCard';

const GATE_TONE = {
  passed: 'text-green-600', failed: 'text-red-500', running: 'text-cyan-500', pending: 'text-muted-foreground',
};

function ChangeDetail({ projectId, record }) {
  const [loading, setLoading] = useState(true);
  const [cycle, setCycle] = useState(null);
  const [messages, setMessages] = useState([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        // The cycle carries the gate results; the chat carries the AI interactions.
        // Both are best-effort — a record can pre-date a cycle (e.g. the design
        // sign-off #1), in which case we simply show what the record itself holds.
        const [cy, chat] = await Promise.all([
          record.cycle_id != null ? api.mock2GetCycle(projectId, record.cycle_id).catch(() => null) : Promise.resolve(null),
          api.mock2GetChat(projectId).catch(() => null),
        ]);
        if (cancelled) return;
        setCycle(cy?.cycle || null);
        const msgs = (chat?.messages || []).filter((m) => record.cycle_id != null && m.cycle_id === record.cycle_id);
        setMessages(msgs);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [projectId, record.cycle_id]);

  const gates = cycle?.gates || [];
  const rules = Array.isArray(record.rules_touched) ? record.rules_touched : [];

  return (
    <div className="mt-2 space-y-3 border-t pt-2.5">
      {/* Commit + spend */}
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

      {/* AI interactions for this cycle */}
      <div className="space-y-1.5">
        <p className="text-[11px] font-medium text-muted-foreground">AI interactions</p>
        {loading ? (
          <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground"><Loader2 className="h-3 w-3 animate-spin" /> Loading…</p>
        ) : messages.length ? (
          <div className="space-y-2 rounded-lg border bg-background/40 p-2">
            {messages.map((m) => <ChatBubble key={m.id} m={m} />)}
          </div>
        ) : (
          <p className="text-[11px] text-muted-foreground">No chat activity linked to this change.</p>
        )}
      </div>
    </div>
  );
}

export default function ChangeHistory({ projectId }) {
  const [data, setData] = useState(null); // { records, verification } | null
  const [error, setError] = useState(false);
  const [expanded, setExpanded] = useState(null); // seq of the open row, or null

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

  if (error) return <p className="text-sm text-muted-foreground">Could not load the change history.</p>;
  if (!data) return <p className="flex items-center gap-1.5 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading change history…</p>;

  const { records = [], verification } = data;
  return (
    <div className="space-y-2">
      <p className="text-xs flex items-center gap-1">
        {verification?.ok
          ? <><ShieldCheck className="h-3.5 w-3.5 text-green-500" /> <span className="text-green-600">Hash chain verified ({verification.count} record{verification.count === 1 ? '' : 's'})</span></>
          : <><XCircle className="h-3.5 w-3.5 text-red-500" /> <span className="text-red-500">Chain broken at #{verification?.brokenAt}</span></>}
      </p>
      {records.length === 0 ? (
        <p className="text-xs text-muted-foreground">No change records yet.</p>
      ) : (
        <ul className="space-y-1.5">
          {records.map((r) => {
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
    </div>
  );
}
