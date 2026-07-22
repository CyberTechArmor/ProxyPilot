// Lean BEAF Pro — Briefs feed. A running list of briefs: today's daily brief
// plus one brief per meeting-to-meeting period (the "notes between meetings").
// Every figure is grounded — each moved project cites the activity records
// behind it (R07). Read-only; generated deterministically server-side.

import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Loader2, ArrowLeft, ScrollText, Sparkles, ChevronRight, ChevronDown, Sun, Wand2, CheckCircle2, AlertTriangle } from 'lucide-react';
import { fmtDate, timeAgo } from '@/components/lbp/shared';

function formatUsd(n) {
  const v = Number(n) || 0;
  if (v === 0) return '$0.00';
  if (v < 0.01) return `$${v.toFixed(4)}`;
  return `$${v.toFixed(2)}`;
}

const RUN_MODE_LABELS = { daily: 'Daily', since_meeting: 'Since meeting', leadership: 'Leadership' };

// AI generation audit + review area — every restyle run (who ran it, model,
// tokens, cost) with the generated brief stored so it can be re-read: click a
// row to expand the exact text that was shown (the accepted AI rewrite, or the
// grounded fallback for a run that fell back).
function AiRunLog() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [openId, setOpenId] = useState(null);

  useEffect(() => {
    api.lbpBriefRuns().then(setData).catch((e) => setErr(e.message));
  }, []);

  if (err) return null;
  if (!data) return null;

  const totals = data.totals || { runs: 0, cost_usd: 0 };

  return (
    <section className="rounded-xl border bg-card p-4">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-purple-500/10 text-purple-600 dark:text-purple-400">
          <Wand2 className="h-4 w-4" />
        </span>
        <b className="text-sm">AI generation log</b>
        <span className="ml-auto text-[11px] text-muted-foreground">
          {totals.runs} run{totals.runs === 1 ? '' : 's'} · {formatUsd(totals.cost_usd)} total
        </span>
      </div>
      {data.runs.length === 0 ? (
        <p className="text-sm text-muted-foreground">No AI briefs generated yet. Use “Generate with AI” on the dashboard to restyle a grounded brief — each run is saved here to review.</p>
      ) : (
        <>
          <p className="mb-2 text-[11px] text-muted-foreground">Tap a run to re-read the brief it produced.</p>
          <div className="divide-y rounded-lg border">
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
                      ? <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-green-600 dark:text-green-400" title="AI rewrite shown" />
                      : <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-500" title="Fell back to the grounded brief" />}
                    <span className="min-w-0 flex-1">
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
                        ? <p className="whitespace-pre-wrap rounded-lg border bg-background p-3 text-sm leading-relaxed">{r.output_text}</p>
                        : <p className="text-xs text-muted-foreground">No text was saved for this run.</p>}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
    </section>
  );
}

function windowLabel(from, to) {
  if (from && to) return `${fmtDate(from)} → ${fmtDate(to)}`;
  if (from && !to) return `${fmtDate(from)} → now`;
  if (!from && to) return `Start → ${fmtDate(to)}`;
  return 'All time';
}

function BriefCard({ brief, icon, onOpenBoard }) {
  const Icon = icon || Sparkles;
  return (
    <div className="rounded-xl border bg-card p-4">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-purple-500/10 text-purple-600 dark:text-purple-400">
          <Icon className="h-4 w-4" />
        </span>
        <b className="text-sm">{brief.label}</b>
        <span className="text-xs text-muted-foreground">{windowLabel(brief.from, brief.to)}</span>
        <span className="ml-auto text-[11px] text-muted-foreground">{brief.entry_count} update{brief.entry_count === 1 ? '' : 's'}</span>
      </div>
      {brief.moved.length === 0 ? (
        <p className="text-sm text-muted-foreground">No movement recorded in this window.</p>
      ) : (
        <div className="divide-y">
          {brief.moved.map((m) => (
            <button
              key={m.project_id}
              type="button"
              onClick={() => onOpenBoard(m.project_id)}
              className="flex w-full items-start gap-2 py-2.5 text-left"
              title="Open project"
            >
              <div className="min-w-0 flex-1">
                <span className="block truncate text-sm font-semibold">{m.name}</span>
                <span className="block text-xs text-muted-foreground">{m.changes.join(' · ')}</span>
                <span className="mt-0.5 block font-mono text-[10px] text-muted-foreground/70">
                  {m.activity_ids.map((id) => `#${id}`).join(' ')}
                </span>
              </div>
              <ChevronRight className="mt-1 h-4 w-4 shrink-0 text-muted-foreground" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default function LbpBriefs() {
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');

  const load = useCallback(() => {
    api.lbpBriefsFeed().then(setData).catch((e) => setErr(e.message));
  }, []);
  useEffect(() => { load(); }, [load]);

  const openProject = (id) => navigate(`/lean-beaf/${id}`);

  return (
    <div className="mx-auto w-full max-w-3xl space-y-4">
      <div>
        <button type="button" onClick={() => navigate('/lean-beaf')} className="mb-2 inline-flex items-center gap-1 text-sm font-semibold text-muted-foreground">
          <ArrowLeft className="h-4 w-4" /> Lean BEAF Pro
        </button>
        <div className="flex items-center gap-2">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <ScrollText className="h-4 w-4" />
          </span>
          <div>
            <h1 className="text-xl font-bold leading-tight">Briefs</h1>
            <p className="text-xs text-muted-foreground">Today, plus every meeting-to-meeting period · each number cites its record</p>
          </div>
        </div>
      </div>

      {err && <p className="text-sm text-destructive">{err}</p>}
      {!data && !err && <div className="flex justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>}

      {data && (
        <>
          <BriefCard brief={data.today} icon={Sun} onOpenBoard={openProject} />
          <AiRunLog />
          <h2 className="pt-2 text-xs font-bold uppercase tracking-wide text-muted-foreground">Between meetings</h2>
          {data.periods.map((p, i) => (
            <BriefCard key={`${p.from}-${p.to}-${i}`} brief={p} onOpenBoard={openProject} />
          ))}
        </>
      )}
    </div>
  );
}
