// Lean BEAF Pro — Briefs feed. A running list of briefs: today's daily brief
// plus one brief per meeting-to-meeting period (the "notes between meetings").
// Every figure is grounded — each moved project cites the activity records
// behind it (R07). Read-only; generated deterministically server-side.

import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '@/lib/api';
import { Loader2, ArrowLeft, ScrollText, Sparkles, ChevronRight, Sun } from 'lucide-react';
import { fmtDate } from '@/components/lbp/shared';

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

  const openProject = (id, tab) => navigate(`/lean-beaf/${id}${tab ? `?tab=${tab}` : ''}`);

  return (
    <div className="mx-auto w-full max-w-3xl space-y-4">
      <div>
        <button type="button" onClick={() => navigate('/lean-beaf')} className="mb-2 inline-flex items-center gap-1 text-sm font-semibold text-muted-foreground">
          <ArrowLeft className="h-4 w-4" /> Projects
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
          <h2 className="pt-2 text-xs font-bold uppercase tracking-wide text-muted-foreground">Between meetings</h2>
          {data.periods.map((p, i) => (
            <BriefCard key={`${p.from}-${p.to}-${i}`} brief={p} onOpenBoard={openProject} />
          ))}
        </>
      )}
    </div>
  );
}
