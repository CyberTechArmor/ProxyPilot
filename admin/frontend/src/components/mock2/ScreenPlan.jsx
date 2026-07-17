// ScreenPlan — the per-screen apply panel (post-approval, left column). One row
// per inventory screen: approve/defer each, apply the kept ones, and watch them
// build one at a time in the background. Also hosts the Production check action
// (the full-gate readiness pass) once screens are built.
//
// MOBILE_FIRST: single-column rows, 44px touch targets, no fixed widths.

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { useToast } from '@/hooks/use-toast';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import {
  Loader2, LayoutList, CheckCircle2, XCircle, Clock, Hammer, PauseCircle, ShieldCheck,
} from 'lucide-react';

const STATUS_CHIP = {
  planned: { label: 'planned', cls: 'bg-muted text-muted-foreground', Icon: Clock },
  deferred: { label: 'deferred', cls: 'bg-muted text-muted-foreground', Icon: PauseCircle },
  queued: { label: 'queued', cls: 'bg-amber-500/10 text-amber-500', Icon: Clock },
  building: { label: 'building…', cls: 'bg-sky-500/10 text-sky-500', Icon: Hammer },
  built: { label: 'built', cls: 'bg-emerald-500/10 text-emerald-500', Icon: CheckCircle2 },
  failed: { label: 'failed', cls: 'bg-red-500/10 text-red-500', Icon: XCircle },
};

export default function ScreenPlan({ projectId, canEdit, online, onChanged }) {
  const { toast } = useToast();
  const [screens, setScreens] = useState(null); // null while loading
  const [counts, setCounts] = useState(null);
  const [busy, setBusy] = useState(false);
  const [checkBusy, setCheckBusy] = useState(false);
  const timer = useRef(null);

  const load = useCallback(async () => {
    try {
      const r = await api.mock2ListScreens(projectId);
      setScreens(r.screens || []);
      setCounts(r.counts || null);
    } catch (err) {
      if (!(err instanceof ApiError)) console.error('load screens failed:', err);
      setScreens((cur) => cur || []);
    }
  }, [projectId]);

  useEffect(() => { load(); }, [load]);

  // Poll while work is in flight so rows flip without a refresh.
  const activeWork = (screens || []).some((s) => ['queued', 'building'].includes(s.status));
  useEffect(() => {
    if (!activeWork) return undefined;
    timer.current = setInterval(load, 6000);
    return () => clearInterval(timer.current);
  }, [activeWork, load]);

  const decide = async (screen, status) => {
    setBusy(true);
    try {
      await api.mock2DecideScreen(projectId, screen.id, status);
      await load();
    } catch (err) {
      toast({ variant: 'destructive', title: 'Could not update the screen', description: err.message });
    } finally { setBusy(false); }
  };

  const applyAll = async () => {
    setBusy(true);
    try {
      const r = await api.mock2ApplyScreens(projectId);
      toast({
        title: `Building ${r.queued} screen${r.queued === 1 ? '' : 's'} in the background`,
        description: 'One at a time — the chat reports each screen as it goes live. Keep working meanwhile.',
      });
      await load();
      if (onChanged) onChanged();
    } catch (err) {
      toast({ variant: 'destructive', title: 'Could not apply screens', description: err.message });
    } finally { setBusy(false); }
  };

  const productionCheck = async () => {
    setCheckBusy(true);
    try {
      const r = await api.mock2ProductionCheck(projectId);
      if (r.refused) toast({ variant: 'destructive', title: 'Production check refused', description: r.reason || 'Quota exceeded.' });
      else toast({ title: 'Production check started', description: 'Full build pass: rule interview, per-rule tests, acceptance checks, and every gate. No new features.' });
      if (onChanged) onChanged();
    } catch (err) {
      toast({ variant: 'destructive', title: 'Could not start the production check', description: err.message });
    } finally { setCheckBusy(false); }
  };

  if (screens == null) {
    return (
      <Card>
        <CardContent className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading the screen plan…
        </CardContent>
      </Card>
    );
  }
  if (!screens.length) return null; // pre-approval, or a legacy project with no plan

  const applicable = screens.filter((s) => ['planned', 'failed'].includes(s.status)).length;
  const allBuilt = counts && counts.built > 0 && counts.built + counts.deferred === counts.total;

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <LayoutList className="h-4 w-4" /> Screens
          </CardTitle>
          {counts ? (
            <span className="text-xs text-muted-foreground">
              {counts.built}/{counts.total} built{counts.deferred ? ` · ${counts.deferred} deferred` : ''}
            </span>
          ) : null}
        </div>
        <CardDescription>
          From the approved design — apply screens as small scoped builds that run one at a
          time in the background. Defer the ones you don&apos;t need yet.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        <ul className="space-y-1.5">
          {screens.map((s) => {
            const chip = STATUS_CHIP[s.status] || STATUS_CHIP.planned;
            const { Icon } = chip;
            return (
              <li key={s.id} className="flex flex-wrap items-center gap-2 rounded-md border p-2">
                <span className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] ${chip.cls}`}>
                  <Icon className={`h-3 w-3 ${s.status === 'building' ? 'animate-pulse' : ''}`} /> {chip.label}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{s.name}</span>
                  {s.purpose ? <span className="block truncate text-xs text-muted-foreground">{s.purpose}</span> : null}
                  {s.status === 'failed' && s.error ? <span className="block truncate text-xs text-red-500">{s.error}</span> : null}
                </span>
                {canEdit && ['planned', 'failed'].includes(s.status) ? (
                  <Button variant="ghost" size="sm" className="min-h-[44px]" disabled={busy} onClick={() => decide(s, 'deferred')}>
                    Defer
                  </Button>
                ) : null}
                {canEdit && s.status === 'deferred' ? (
                  <Button variant="ghost" size="sm" className="min-h-[44px]" disabled={busy} onClick={() => decide(s, 'planned')}>
                    Restore
                  </Button>
                ) : null}
              </li>
            );
          })}
        </ul>
        {canEdit ? (
          <div className="flex flex-col gap-2 pt-1 sm:flex-row">
            <Button
              className="min-h-[44px] flex-1"
              disabled={busy || !online || !applicable}
              onClick={applyAll}
            >
              {busy ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Hammer className="mr-1 h-4 w-4" />}
              Build {applicable || 'the'} screen{applicable === 1 ? '' : 's'} in the background
            </Button>
            <Button
              variant={allBuilt ? 'default' : 'outline'}
              className="min-h-[44px] flex-1"
              disabled={checkBusy || !online}
              onClick={productionCheck}
              title="Full-gate readiness pass — rule interview, per-rule tests, acceptance checks. No new features."
            >
              {checkBusy ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <ShieldCheck className="mr-1 h-4 w-4" />}
              Production check
            </Button>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
