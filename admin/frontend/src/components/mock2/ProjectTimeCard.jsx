// ProjectTimeCard — the Details-tab stopwatch: project start + where the time
// went (AI: mockup / building / adjustments, admin-wait, active typing), refreshed
// live. Plus a framework-decisions log (admin) of every deviation request and how
// it was resolved. Data comes from the derived time-summary endpoint + the queue.
//
// MOBILE_FIRST: single column, wraps, no fixed widths; clean at 360px.

import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Clock, Sparkles, Hammer, Wrench, ShieldAlert, Keyboard, CheckCircle2, Ban, Timer, Coins } from 'lucide-react';

function fmt(s) {
  const n = Math.max(0, Math.round(Number(s) || 0));
  if (n < 60) return `${n}s`;
  const h = Math.floor(n / 3600);
  const m = Math.floor((n % 3600) / 60);
  const sec = n % 60;
  if (h) return `${h}h ${m}m`;
  return `${m}m ${sec}s`;
}

// Model spend, shown the same way per change record: "12,480 tok · $0.09".
export function fmtTokens(t) {
  return `${Math.max(0, Math.round(Number(t) || 0)).toLocaleString()} tok`;
}
export function fmtCost(cents) {
  return `$${(Math.max(0, Number(cents) || 0) / 100).toFixed(2)}`;
}
export function fmtUsage(tokens, cents) {
  return `${fmtTokens(tokens)} · ${fmtCost(cents)}`;
}

function UsageRow({ icon: Icon, label, tokens, cents, strong = false, indent = false }) {
  return (
    <div className={`flex items-center justify-between gap-3 text-sm ${indent ? 'pl-5' : ''}`}>
      <span className={`flex items-center gap-2 min-w-0 ${strong ? 'font-medium' : 'text-muted-foreground'}`}>
        {Icon ? <Icon className="h-3.5 w-3.5 shrink-0" /> : null}
        <span className="truncate">{label}</span>
      </span>
      <span className={`font-mono text-xs whitespace-nowrap ${strong ? 'font-medium' : ''}`}>{fmtUsage(tokens, cents)}</span>
    </div>
  );
}

function Row({ icon: Icon, label, seconds, strong = false, indent = false }) {
  return (
    <div className={`flex items-center justify-between gap-3 text-sm ${indent ? 'pl-5' : ''}`}>
      <span className={`flex items-center gap-2 min-w-0 ${strong ? 'font-medium' : 'text-muted-foreground'}`}>
        {Icon ? <Icon className="h-3.5 w-3.5 shrink-0" /> : null}
        <span className="truncate">{label}</span>
      </span>
      <span className={`font-mono whitespace-nowrap ${strong ? 'font-medium' : ''}`}>{fmt(seconds)}</span>
    </div>
  );
}

export function ProjectTimeCard({ projectId }) {
  const [summary, setSummary] = useState(null);
  const [usage, setUsage] = useState(null);

  const load = useCallback(async () => {
    try {
      const r = await api.mock2GetTimeSummary(projectId);
      setSummary(r.summary || null);
      setUsage(r.usage || null);
    } catch (err) {
      if (!(err instanceof ApiError)) console.error('load time summary failed:', err);
    }
  }, [projectId]);

  // Poll so the running-cycle + waiting-for-admin buckets tick up live.
  useEffect(() => { load(); const t = setInterval(load, 20000); return () => clearInterval(t); }, [load]);

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2"><Timer className="h-4 w-4" /> Time tracking</CardTitle>
        <CardDescription>Where this project&apos;s time has gone, updated as it happens.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {!summary ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : (
          <>
            <div className="flex items-center justify-between gap-3 text-sm">
              <span className="flex items-center gap-2 text-muted-foreground"><Clock className="h-3.5 w-3.5" /> Project started</span>
              <span className="font-mono text-xs whitespace-nowrap">
                {summary.project_start ? new Date(summary.project_start).toLocaleString() : '—'}
              </span>
            </div>
            {summary.elapsed_seconds != null ? (
              <Row icon={Clock} label="Elapsed since start" seconds={summary.elapsed_seconds} />
            ) : null}

            <div className="border-t pt-3 space-y-1.5">
              <Row icon={Sparkles} label="Time with AI" seconds={summary.ai.total_seconds} strong />
              <Row label="Mockup build" seconds={summary.ai.mockup_seconds} indent />
              <Row icon={Hammer} label="Building the app" seconds={summary.ai.building_seconds} indent />
              <Row icon={Wrench} label="Adjustments" seconds={summary.ai.adjustments_seconds} indent />
            </div>

            <div className="border-t pt-3 space-y-1.5">
              <Row icon={ShieldAlert} label="Waiting for admin" seconds={summary.admin_wait_seconds} />
              <Row icon={Keyboard} label="Actively typing in chat" seconds={summary.typing_seconds} />
            </div>

            <div className="border-t pt-3">
              <Row icon={Timer} label="Total tracked" seconds={summary.total_tracked_seconds} strong />
            </div>

            {usage ? (
              <div className="border-t pt-3 space-y-1.5">
                <UsageRow icon={Coins} label="Tokens &amp; cost" tokens={usage.total_tokens} cents={usage.total_cost_cents} strong />
                <UsageRow label="Mockup build" tokens={usage.by_stage?.mockup?.tokens} cents={usage.by_stage?.mockup?.cost_cents} indent />
                <UsageRow label="Building the app" tokens={usage.by_stage?.building?.tokens} cents={usage.by_stage?.building?.cost_cents} indent />
                <UsageRow label="Adjustments" tokens={usage.by_stage?.adjustments?.tokens} cents={usage.by_stage?.adjustments?.cost_cents} indent />
              </div>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}

// FrameworkDecisionsLog — the durable record of every framework-deviation request
// on this project and how it was decided (approved / denied / pending), for
// admins. The queue rows are the log; this just surfaces them per project.
export function FrameworkDecisionsLog({ projectId }) {
  const [items, setItems] = useState(null);

  const load = useCallback(async () => {
    try {
      const r = await api.mock2ListQueue({ project_id: projectId, kind: 'framework_deviation' });
      setItems(r.items || []);
    } catch (err) {
      if (!(err instanceof ApiError)) console.error('load decisions failed:', err);
    }
  }, [projectId]);

  useEffect(() => { load(); const t = setInterval(load, 20000); return () => clearInterval(t); }, [load]);

  const badge = (status) => {
    if (status === 'resolved') return <span className="inline-flex items-center gap-1 text-emerald-500"><CheckCircle2 className="h-3.5 w-3.5" /> Approved</span>;
    if (status === 'dismissed') return <span className="inline-flex items-center gap-1 text-red-500"><Ban className="h-3.5 w-3.5" /> Denied</span>;
    if (status === 'in_progress') return <span className="text-amber-500">In progress</span>;
    return <span className="text-amber-500">Open</span>;
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2"><ShieldAlert className="h-4 w-4" /> Framework decisions</CardTitle>
        <CardDescription>Every framework-deviation request on this project and how it was decided.</CardDescription>
      </CardHeader>
      <CardContent>
        {items === null ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : items.length === 0 ? (
          <p className="text-sm text-muted-foreground">No framework deviations have been raised.</p>
        ) : (
          <ul className="space-y-2">
            {items.map((it) => (
              <li key={it.id} className="rounded-md border px-3 py-2 text-xs space-y-1">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium">{badge(it.status)}</span>
                  <span className="text-muted-foreground whitespace-nowrap">{it.raised_at ? new Date(`${String(it.raised_at).replace(' ', 'T')}Z`).toLocaleString() : ''}</span>
                </div>
                <p className="break-words text-foreground/90">{it.detail || 'Framework deviation'}</p>
                {it.resolution ? <p className="text-muted-foreground">Decision: {it.resolution}</p> : null}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
