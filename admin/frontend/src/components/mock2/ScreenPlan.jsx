// ScreenPlan — the per-screen apply panel (post-approval, left column). One row
// per inventory screen: approve/defer each, apply the kept ones, and watch them
// build one at a time in the background. The Production check action lives in
// the BuildStatus panel above (with Full build), not here.
//
// MOBILE_FIRST: single-column rows, 44px touch targets, no fixed widths.

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { useToast } from '@/hooks/use-toast';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import {
  Loader2, LayoutList, CheckCircle2, XCircle, Clock, Hammer, PauseCircle,
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
  const [items, setItems] = useState([]); // feature checklist rows
  const [selected, setSelected] = useState(() => new Set()); // item ids picked to build next
  const [itemsBusy, setItemsBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const timer = useRef(null);

  const load = useCallback(async () => {
    try {
      const r = await api.mock2ListScreens(projectId);
      setScreens(r.screens || []);
      setCounts(r.counts || null);
      setItems(r.items || []);
    } catch (err) {
      if (!(err instanceof ApiError)) console.error('load screens failed:', err);
      setScreens((cur) => cur || []);
    }
  }, [projectId]);

  useEffect(() => { load(); }, [load]);

  // Poll while work is in flight so rows flip without a refresh.
  const activeWork = (screens || []).some((s) => ['queued', 'building'].includes(s.status)) || (items || []).some((i) => i.building);
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

  // ---- feature checklist (per-screen is/isn't-done items) ----
  const itemsFor = (screenId) => (items || []).filter((i) => i.screen_id === screenId);
  const pendingItems = (items || []).filter((i) => i.status === 'pending' && !i.building);
  const toggleSelect = (id) => setSelected((cur) => {
    const next = new Set(cur);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const markItem = async (item, status) => {
    try { await api.mock2SetScreenItem(projectId, item.id, status); await load(); }
    catch (err) { toast({ variant: 'destructive', title: 'Could not update the item', description: err.message }); }
  };
  const buildItems = async (ids) => {
    setItemsBusy(true);
    try {
      const r = await api.mock2BuildScreenItems(projectId, ids);
      toast({
        title: `Building ${r.started} feature${r.started === 1 ? '' : 's'}`,
        description: 'One scoped build — each item flips to built when it succeeds (or back to selectable if it fails).',
      });
      setSelected(new Set());
      await load();
      if (onChanged) onChanged();
    } catch (err) {
      toast({ variant: 'destructive', title: 'Could not start the feature build', description: err.message });
    } finally { setItemsBusy(false); }
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
          From the approved design — screens plus the feature checklist under each. A built screen can still
          have unfinished features: tick the ones to finish next and press &quot;Build selected&quot; (or finish
          all remaining). Unfinished features show a &quot;Not built yet&quot; badge inside the running app.
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
                {/* The screen's feature checklist: tap the row to select it for
                    the next build; "done" flips honestly (auto on a targeted
                    build's success, manual for human-verified work). */}
                {itemsFor(s.id).length ? (
                  <div className="w-full basis-full space-y-0.5 border-t pt-1.5 mt-1">
                    {itemsFor(s.id).map((it) => (
                      <div key={it.id} className="flex items-center gap-1.5">
                        <label className={`flex min-h-[40px] flex-1 min-w-0 items-center gap-2 rounded px-1 text-xs ${it.status === 'built' ? 'text-muted-foreground' : ''} ${canEdit && it.status === 'pending' && !it.building ? 'cursor-pointer hover:bg-muted/40' : ''}`}>
                          {canEdit ? (
                            <input
                              type="checkbox" className="h-4 w-4 shrink-0 accent-primary"
                              disabled={it.status === 'built' || it.building}
                              checked={selected.has(it.id)}
                              onChange={() => toggleSelect(it.id)}
                              aria-label={`Select "${it.name}" to build next`}
                            />
                          ) : (
                            <span className={`h-2 w-2 shrink-0 rounded-full ${it.status === 'built' ? 'bg-emerald-500' : 'bg-muted-foreground/40'}`} />
                          )}
                          <span className={`min-w-0 break-words ${it.status === 'built' ? 'line-through decoration-muted-foreground/50' : ''}`}>
                            {it.name}
                            {it.kind === 'state' ? <span className="text-muted-foreground/70"> (state)</span> : null}
                          </span>
                          {it.building ? <Loader2 className="h-3 w-3 shrink-0 animate-spin text-sky-500" /> : null}
                        </label>
                        {canEdit && !it.building ? (
                          <Button
                            variant="ghost" size="sm" className="h-9 shrink-0 px-2 text-[11px] text-muted-foreground"
                            onClick={() => markItem(it, it.status === 'built' ? 'pending' : 'built')}
                            title={it.status === 'built' ? 'Mark as not done (it needs more work)' : 'Mark as done (verified by you)'}
                          >
                            {it.status === 'built' ? 'reopen' : 'done'}
                          </Button>
                        ) : null}
                      </div>
                    ))}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
        {canEdit ? (
          <div className="space-y-2 pt-1">
            {applicable ? (
              <Button
                className="min-h-[44px] w-full"
                disabled={busy || !online}
                onClick={applyAll}
              >
                {busy ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Hammer className="mr-1 h-4 w-4" />}
                Build {applicable} screen{applicable === 1 ? '' : 's'} in the background
              </Button>
            ) : null}
            {pendingItems.length ? (
              <div className="flex flex-col gap-2 sm:flex-row">
                <Button
                  variant={selected.size ? 'default' : 'outline'}
                  className="min-h-[44px] flex-1"
                  disabled={itemsBusy || !online || !selected.size}
                  onClick={() => buildItems([...selected])}
                  title="One scoped build over exactly the ticked features"
                >
                  {itemsBusy ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Hammer className="mr-1 h-4 w-4" />}
                  Build selected{selected.size ? ` (${selected.size})` : ''}
                </Button>
                <Button
                  variant="outline"
                  className="min-h-[44px] flex-1"
                  disabled={itemsBusy || !online}
                  onClick={() => buildItems(null)}
                  title="One build that finishes every pending feature on the checklist"
                >
                  Finish all remaining ({pendingItems.length})
                </Button>
              </div>
            ) : null}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
