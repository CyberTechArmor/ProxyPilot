// ScreenPlan — what the app is made of and what is actually built
// (post-approval, left column). One row per inventory screen with its feature
// checklist: built / pending / deferred, and an editor can correct a status.
//
// It is a STATUS VIEW, not a build launcher. It used to carry two more build
// buttons ("Build N screens in the background", "Build selected features") on
// top of MVP, Quick update, Full build, Production check and Polish — six
// doors onto what were really two lanes. Building is now asked for in the
// chat: describe the screen or feature and send it as a Quick update, or run
// a Full build. This panel answers "what is done", which is the question it
// was actually good at.
//
// MOBILE_FIRST: single-column rows, 44px touch targets, no fixed widths.

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { useToast } from '@/hooks/use-toast';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import {
  Loader2, LayoutList, CheckCircle2, XCircle, Clock, Hammer, PauseCircle, ChevronDown, ChevronRight,
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
  const [expandedScreens, setExpandedScreens] = useState({}); // screen id -> manual expand/collapse override
  const [openItems, setOpenItems] = useState(() => new Set()); // item ids with version history open
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

  // ---- feature checklist (per-screen is/isn't-done items) ----
  const itemsFor = (screenId) => (items || []).filter((i) => i.screen_id === screenId);
  // Collapse rule: all items done -> collapsed; any pending -> expanded; a
  // manual toggle (chevron) overrides either way.
  const isExpanded = (screenId) => {
    const list = itemsFor(screenId);
    if (!list.length) return false;
    const override = expandedScreens[screenId];
    if (override !== undefined) return override;
    return list.some((i) => i.status === 'pending' || i.building);
  };
  const toggleScreen = (screenId) => setExpandedScreens((cur) => ({ ...cur, [screenId]: !isExpanded(screenId) }));
  const toggleItemOpen = (id) => setOpenItems((cur) => {
    const next = new Set(cur);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const pendingItems = (items || []).filter((i) => i.status === 'pending' && !i.building);
  const markItem = async (item, status) => {
    try { await api.mock2SetScreenItem(projectId, item.id, status); await load(); }
    catch (err) { toast({ variant: 'destructive', title: 'Could not update the item', description: err.message }); }
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
          have unfinished features; those show a &quot;Not built yet&quot; badge inside the running app.
          To build one, describe it in the chat.
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
                {/* Expand/collapse the screen's checklist: auto-collapsed when
                    every feature is done, auto-expanded while any is pending;
                    the chevron overrides manually. */}
                {itemsFor(s.id).length ? (
                  <button
                    type="button"
                    className="inline-flex min-h-[44px] items-center gap-1 rounded px-1.5 text-[11px] text-muted-foreground hover:text-foreground"
                    onClick={() => toggleScreen(s.id)}
                    aria-expanded={isExpanded(s.id)}
                    aria-label={`${isExpanded(s.id) ? 'Collapse' : 'Expand'} the ${s.name} feature checklist`}
                  >
                    {isExpanded(s.id) ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                    {itemsFor(s.id).filter((i) => i.status === 'built').length}/{itemsFor(s.id).length} done
                  </button>
                ) : null}
                {/* The screen's feature checklist: tick to select for the next
                    build; tap a feature name to read its version history
                    (newest first); "done"/"reopen" is the human override. */}
                {itemsFor(s.id).length && isExpanded(s.id) ? (
                  <div className="w-full basis-full space-y-0.5 border-t pt-1.5 mt-1">
                    {itemsFor(s.id).map((it) => (
                      <div key={it.id} className="min-w-0">
                        <div className="flex items-center gap-1.5">
                          <div className={`flex min-h-[40px] flex-1 min-w-0 items-center gap-2 rounded px-1 text-xs ${it.status === 'built' ? 'text-muted-foreground' : ''}`}>
                            <span
                              className={`h-2 w-2 shrink-0 rounded-full ${it.status === 'built' ? 'bg-emerald-500' : 'bg-muted-foreground/40'}`}
                              title={it.status === 'built' ? 'Built' : 'Not built yet'}
                            />
                            <button
                              type="button"
                              className={`min-w-0 break-words text-left hover:underline decoration-dotted ${it.status === 'built' ? 'line-through decoration-muted-foreground/50' : ''}`}
                              onClick={() => toggleItemOpen(it.id)}
                              aria-expanded={openItems.has(it.id)}
                              title="Show this feature's change history"
                            >
                              {it.name}
                              {it.kind === 'state' ? <span className="text-muted-foreground/70"> (state)</span> : null}
                            </button>
                            {it.building ? <Loader2 className="h-3 w-3 shrink-0 animate-spin text-sky-500" /> : null}
                          </div>
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
                        {openItems.has(it.id) ? (
                          <div className="ml-6 mb-1 space-y-1 rounded-md border bg-muted/20 p-2">
                            {(it.history || []).length ? (it.history || []).map((h, i) => (
                              <div key={i} className="text-[11px]">
                                <span className="text-muted-foreground">{String(h.created_at || '').slice(0, 16).replace('T', ' ')}</span>
                                <span className="block break-words text-foreground/90">{h.summary}</span>
                              </div>
                            )) : (
                              <p className="text-[11px] text-muted-foreground">
                                No recorded changes yet — history starts with the next build (or manual mark) that touches this feature.
                              </p>
                            )}
                          </div>
                        ) : null}
                      </div>
                    ))}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
        {canEdit && (applicable || pendingItems.length) ? (
          <p className="pt-1 text-xs text-muted-foreground">
            {applicable ? `${applicable} screen${applicable === 1 ? '' : 's'} not built yet` : ''}
            {applicable && pendingItems.length ? ' · ' : ''}
            {pendingItems.length ? `${pendingItems.length} feature${pendingItems.length === 1 ? '' : 's'} pending` : ''}
            {' — '}describe what you want next in the chat and send it as a Quick update, or run a Full build.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
