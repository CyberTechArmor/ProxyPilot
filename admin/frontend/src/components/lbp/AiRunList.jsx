// Lean BEAF Pro — AI run list. Every AI generation (brief restyle or grounded
// question) is recorded; this shows them newest-first with the produced text
// stored, so any run can be re-read by expanding it. Bare (no card/header) so
// it can be dropped into whichever section hosts it.

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { ChevronRight, ChevronDown, CheckCircle2, AlertTriangle, Loader2 } from 'lucide-react';
import BriefText from '@/components/lbp/BriefText';
import { timeAgo } from '@/components/lbp/shared';

function formatUsd(n) {
  const v = Number(n) || 0;
  if (v === 0) return '$0.00';
  if (v < 0.01) return `$${v.toFixed(4)}`;
  return `$${v.toFixed(2)}`;
}

const RUN_MODE_LABELS = { daily: 'Daily', since_meeting: 'Since meeting', leadership: 'Leadership', question: 'Question' };

export default function AiRunList({ onOpenArea }) {
  const [data, setData] = useState(null);
  const [openId, setOpenId] = useState(null);

  useEffect(() => {
    api.lbpBriefRuns().then(setData).catch(() => setData({ runs: [], totals: { runs: 0, cost_usd: 0 }, refs: {} }));
  }, []);

  if (!data) return <div className="flex h-full items-center justify-center py-8"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>;

  const totals = data.totals || { runs: 0, cost_usd: 0 };

  if (!data.runs.length) {
    return <p className="text-sm text-muted-foreground">No AI briefs or answers yet. Ask the assistant a question — each run is saved here to re-read.</p>;
  }

  return (
    <div className="flex h-full flex-col">
      <p className="mb-2 shrink-0 text-[11px] text-muted-foreground">
        {totals.runs} run{totals.runs === 1 ? '' : 's'} · {formatUsd(totals.cost_usd)} total · tap to re-read
      </p>
      <div className="min-h-0 flex-1 divide-y overflow-y-auto rounded-lg border">
        {data.runs.map((r) => {
          const open = openId === r.id;
          return (
            <div key={r.id}>
              <button
                type="button"
                onClick={() => setOpenId(open ? null : r.id)}
                className="flex w-full items-center gap-2 px-2.5 py-2.5 text-left text-xs"
              >
                {open ? <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />}
                {r.ok
                  ? <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-green-600 dark:text-green-400" title="AI text shown" />
                  : <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-500" title="Fell back to the grounded brief" />}
                <span className="min-w-0 flex-1 truncate">
                  <b className="font-semibold">{r.username || 'unknown'}</b>
                  <span className="text-muted-foreground"> · {RUN_MODE_LABELS[r.mode] || r.mode}{r.ok ? '' : ' · grounded fallback'}</span>
                </span>
                <span className="hidden shrink-0 font-mono text-[10px] text-muted-foreground sm:inline">{r.model}</span>
                <span className="shrink-0 font-semibold">{formatUsd(r.cost_usd)}</span>
                <span className="shrink-0 text-[10px] text-muted-foreground">{timeAgo(r.created_at)}</span>
              </button>
              {open && (
                <div className="border-t bg-muted/30 px-3 py-3">
                  <div className="mb-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-muted-foreground">
                    <span className="font-mono">{r.model}</span>
                    <span>{(r.input_tokens || 0).toLocaleString()} in / {(r.output_tokens || 0).toLocaleString()} out</span>
                    <span>{formatUsd(r.cost_usd)}</span>
                    {!r.ok && r.error && r.error !== 'not_configured' && <span className="text-amber-600 dark:text-amber-400">rejected: {r.error}</span>}
                    {r.error === 'not_configured' && <span className="text-amber-600 dark:text-amber-400">no model connected</span>}
                  </div>
                  {r.output_text
                    ? <div className="rounded-lg border bg-background p-3"><BriefText text={r.output_text} refs={data.refs} onOpen={onOpenArea} /></div>
                    : <p className="text-xs text-muted-foreground">No text was saved for this run.</p>}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
