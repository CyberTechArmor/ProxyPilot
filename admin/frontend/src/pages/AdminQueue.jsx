// Admin queue — the Mock2 queue-of-items view (Phase M8).
//
// The first real admin-facing surface for mock2_queue_items, the table M0–M7 have
// been writing to (framework deviations, drift, retries-exhausted, port-drift,
// flags, provisioning/renewal failures, quota-exhausted). Until M8 these rows sat
// behind the notifications bell; this page reads them with project/kind/status
// filters and lets an admin work them (in progress → resolved/dismissed).
//
// Resolving a framework_deviation clears its linked audit question and resumes
// the blocked build (ADR-002 — a project's answer never writes the framework).
//
// Reachable only when the backend reports Mock2 enabled (GET /api/mock2/status →
// 200); a direct visit on a disabled/pinned host bounces home (ADR-001).
//
// MOBILE_FIRST: single-column cards that grow at sm, filters stack, 44px touch
// targets. Renders clean at 360px with no horizontal scroll.

import { useCallback, useEffect, useState } from 'react';
import { Navigate, Link } from 'react-router-dom';
import { useAuth } from '@/context/AuthContext';
import { api, ApiError } from '@/lib/api';
import { useToast } from '@/hooks/use-toast';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { modelOptionsWith } from '@/lib/model-options';
import {
  Inbox, Loader2, ArrowLeft, CheckCircle2, XCircle, PlayCircle, RotateCcw, AlertTriangle,
} from 'lucide-react';

const KIND_LABEL = {
  framework_deviation: 'Framework deviation',
  drift: 'Framework drift',
  retries_exhausted: 'Retries exhausted',
  flag: 'Flagged',
  orphaned: 'Orphaned',
  port_drift: 'Port drift',
  quota_exhausted: 'Quota exhausted',
  provisioning_failed: 'Provisioning failed',
  renewal_failed: 'Renewal failed',
  egress_grant: 'Egress request',
};

// Integration-gate mode option copy (the block/approve loop relief valve).
const GATE_MODE_LABEL = {
  enforce: {
    title: 'Enforce — block (default)',
    desc: 'A build that ships a simulated or undeclared external integration is blocked until an admin resolves it. The safe default.',
  },
  pending: {
    title: 'Pending verification — deploy, verify live',
    desc: 'A build the gate would block instead deploys as “pending operator verification”, with the live checks recorded for you to confirm against the real system. Lets a build complete so you can test the site; the honesty check moves to a live check, it is not dropped.',
  },
  monitor: {
    title: 'Monitor — never block',
    desc: 'Integration findings are recorded but never block or pend the build — it completes so you can test it. Loosest; use when you just need to see the code run. Findings stay on the record.',
  },
  off: {
    title: 'Off — no live-verification checks',
    desc: 'Monitor, plus the live-verification hand-off is disabled entirely: builds never enter “pending operator verification” and no credential-gated live checks are asked of you. Skipped checks are still recorded on the build record.',
  },
};

const KIND_TONE = {
  framework_deviation: 'bg-amber-500/10 text-amber-600',
  drift: 'bg-sky-500/10 text-sky-600',
  retries_exhausted: 'bg-red-500/10 text-red-600',
  flag: 'bg-red-500/10 text-red-600',
  orphaned: 'bg-amber-500/10 text-amber-600',
  port_drift: 'bg-amber-500/10 text-amber-600',
  quota_exhausted: 'bg-red-500/10 text-red-600',
  provisioning_failed: 'bg-red-500/10 text-red-600',
  renewal_failed: 'bg-red-500/10 text-red-600',
  egress_grant: 'bg-sky-500/10 text-sky-600',
};

const STATUS_TONE = {
  open: 'bg-red-500/10 text-red-600',
  in_progress: 'bg-blue-500/10 text-blue-600',
  resolved: 'bg-emerald-500/10 text-emerald-600',
  dismissed: 'bg-muted text-muted-foreground',
};

function QueueItem({ item, onStatus, busy }) {
  const kindLabel = KIND_LABEL[item.kind] || item.kind;
  const done = item.status === 'resolved' || item.status === 'dismissed';
  return (
    <Card>
      <CardContent className="p-4 space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className={`text-[11px] px-2 py-0.5 rounded-full whitespace-nowrap ${KIND_TONE[item.kind] || 'bg-muted text-muted-foreground'}`}>
            {kindLabel}
          </span>
          <span className={`text-[11px] px-2 py-0.5 rounded-full whitespace-nowrap ${STATUS_TONE[item.status] || 'bg-muted text-muted-foreground'}`}>
            {item.status.replace(/_/g, ' ')}
          </span>
          {item.project_id ? (
            <Link to={`/projects/${item.project_id}`} className="text-xs text-primary hover:underline truncate">
              {item.project_name || `project ${item.project_id}`}
            </Link>
          ) : (
            <span className="text-xs text-muted-foreground">host-level</span>
          )}
          <span className="ml-auto text-[11px] text-muted-foreground whitespace-nowrap">{item.raised_at}</span>
        </div>

        {item.detail ? <p className="text-sm break-words">{item.detail}</p> : null}
        {done && item.resolution ? (
          <p className="text-xs text-muted-foreground break-words">Resolution: {item.resolution}</p>
        ) : null}

        <div className="flex flex-wrap gap-2">
          {!done ? (
            <>
              {item.status !== 'in_progress' ? (
                <Button variant="outline" size="sm" className="h-9" disabled={busy} onClick={() => onStatus(item, 'in_progress')}>
                  <PlayCircle className="h-4 w-4 mr-1" /> In progress
                </Button>
              ) : null}
              <Button size="sm" className="h-9" disabled={busy} onClick={() => onStatus(item, 'resolved')}>
                <CheckCircle2 className="h-4 w-4 mr-1" /> Resolve
              </Button>
              <Button variant="ghost" size="sm" className="h-9 text-muted-foreground" disabled={busy} onClick={() => onStatus(item, 'dismissed')}>
                <XCircle className="h-4 w-4 mr-1" /> Dismiss
              </Button>
            </>
          ) : (
            <Button variant="outline" size="sm" className="h-9" disabled={busy} onClick={() => onStatus(item, 'open')}>
              <RotateCcw className="h-4 w-4 mr-1" /> Reopen
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

export default function AdminQueue() {
  const { user } = useAuth();
  const storedUser = JSON.parse(localStorage.getItem('user') || '{}');
  const isAdmin = user?.role === 'admin' || storedUser?.role === 'admin';
  const { toast } = useToast();

  const [gate, setGate] = useState('checking'); // 'checking' | 'enabled' | 'disabled'
  const [items, setItems] = useState([]);
  const [counts, setCounts] = useState({ total: 0, byKind: {} });
  const [kinds, setKinds] = useState([]);
  const [statuses, setStatuses] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState({ kind: 'all', status: 'open' });
  const [chatMax, setChatMax] = useState(null);          // current limit (number) or null while loading
  const [chatOptions, setChatOptions] = useState([]);    // selectable ceilings
  const [savingChat, setSavingChat] = useState(false);
  const [gateMode, setGateMode] = useState(null);        // 'enforce' | 'pending' | 'monitor' or null while loading
  const [gateModeOptions, setGateModeOptions] = useState([]);
  const [savingGateMode, setSavingGateMode] = useState(false);
  const [autoApply, setAutoApply] = useState(null);      // boolean or null while loading
  const [savingAutoApply, setSavingAutoApply] = useState(false);
  const [laneTuning, setLaneTuning] = useState(null);    // { lanes, options } or null while loading
  const [savingTune, setSavingTune] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.mock2ListQueue({
        kind: filter.kind === 'all' ? undefined : filter.kind,
        status: filter.status === 'all' ? undefined : filter.status,
      });
      setItems(res.items || []);
      setCounts(res.counts || { total: 0, byKind: {} });
      if (res.kinds) setKinds(res.kinds);
      if (res.statuses) setStatuses(res.statuses);
    } catch (err) {
      if (!(err instanceof ApiError)) console.error('load queue failed:', err);
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    let cancelled = false;
    api.mock2Status()
      .then(() => { if (!cancelled) setGate('enabled'); })
      .catch((err) => {
        if (!cancelled) setGate('disabled');
        if (!(err instanceof ApiError)) console.error('mock2 status check failed:', err);
      });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => { if (gate === 'enabled') load(); }, [gate, load]);

  // Concept chat message limit (admin-configurable, 4k/8k/16k/32k).
  useEffect(() => {
    if (gate !== 'enabled') return;
    api.mock2GetChatMaxChars()
      .then((r) => { setChatMax(r.max_chars); setChatOptions(r.options || []); })
      .catch((err) => { if (!(err instanceof ApiError)) console.error('load chat limit failed:', err); });
  }, [gate]);

  const onChatMaxChange = async (value) => {
    const next = Number(value);
    const prev = chatMax;
    setChatMax(next); // optimistic
    setSavingChat(true);
    try {
      const res = await api.mock2SetChatMaxChars(next);
      setChatMax(res.max_chars);
      toast({ title: 'Chat message limit updated', description: `${res.max_chars.toLocaleString()} characters per message.` });
    } catch (err) {
      setChatMax(prev); // roll back
      toast({ variant: 'destructive', title: 'Could not update limit', description: err.message });
    } finally {
      setSavingChat(false);
    }
  };

  // Integration-gate mode (admin-configurable — enforce/pending/monitor).
  useEffect(() => {
    if (gate !== 'enabled') return;
    api.mock2GetIntegrationGateMode()
      .then((r) => { setGateMode(r.mode); setGateModeOptions(r.options || []); })
      .catch((err) => { if (!(err instanceof ApiError)) console.error('load gate mode failed:', err); });
  }, [gate]);

  const onGateModeChange = async (value) => {
    const prev = gateMode;
    setGateMode(value); // optimistic
    setSavingGateMode(true);
    try {
      const res = await api.mock2SetIntegrationGateMode(value);
      setGateMode(res.mode);
      toast({ title: 'Integration gate mode updated', description: GATE_MODE_LABEL[res.mode]?.title || res.mode });
    } catch (err) {
      setGateMode(prev); // roll back
      toast({ variant: 'destructive', title: 'Could not update mode', description: err.message });
    } finally {
      setSavingGateMode(false);
    }
  };

  // Component auto-apply (admin-configurable — install every published
  // standard component into every build automatically).
  useEffect(() => {
    if (gate !== 'enabled') return;
    api.mock2GetComponentAutoApply()
      .then((r) => setAutoApply(!!r.enabled))
      .catch((err) => { if (!(err instanceof ApiError)) console.error('load component auto-apply failed:', err); });
  }, [gate]);

  const onAutoApplyChange = async (checked) => {
    const prev = autoApply;
    setAutoApply(checked); // optimistic
    setSavingAutoApply(true);
    try {
      const res = await api.mock2SetComponentAutoApply(checked);
      setAutoApply(!!res.enabled);
      toast({
        title: `Component auto-apply ${res.enabled ? 'enabled' : 'disabled'}`,
        description: res.enabled
          ? 'Every published component installs into every build automatically.'
          : 'Components are suggested on capability match and confirmed per project.',
      });
    } catch (err) {
      setAutoApply(prev); // roll back
      toast({ variant: 'destructive', title: 'Could not update auto-apply', description: err.message });
    } finally {
      setSavingAutoApply(false);
    }
  };

  // Lane tuning (admin-configurable — per-lane model / effort / thinking).
  useEffect(() => {
    if (gate !== 'enabled') return;
    api.mock2GetLaneTuning()
      .then((r) => setLaneTuning(r))
      .catch((err) => { if (!(err instanceof ApiError)) console.error('load lane tuning failed:', err); });
  }, [gate]);

  // Browser smoke connector (post-deploy UI verification) — toggle + readiness.
  const [smokeBrowser, setSmokeBrowser] = useState(null);
  const [savingSmoke, setSavingSmoke] = useState(false);
  useEffect(() => {
    if (gate !== 'enabled') return;
    api.mock2GetSmokeBrowser()
      .then(setSmokeBrowser)
      .catch((err) => { if (!(err instanceof ApiError)) console.error('load smoke-browser failed:', err); });
  }, [gate]);
  const saveSmokeBrowser = async (setting) => {
    setSavingSmoke(true);
    try {
      await api.mock2SetSmokeBrowser(setting);
      const fresh = await api.mock2GetSmokeBrowser();
      setSmokeBrowser(fresh);
      toast({
        title: 'Browser verification updated',
        description: setting === 'off'
          ? 'Builds ship without the browser check — you test the deployed app by hand.'
          : 'User-facing builds are driven in a real browser after deploy (dead buttons and console errors fail the build).',
      });
    } catch (err) {
      toast({ variant: 'destructive', title: 'Could not save', description: err.message });
    } finally { setSavingSmoke(false); }
  };

  // Save one lane's patch; on failure re-fetch to resync (edits are per-field).
  const saveLaneTuning = async (lane, patch) => {
    setLaneTuning((cur) => cur && ({ ...cur, lanes: { ...cur.lanes, [lane]: { ...cur.lanes[lane], ...patch } } }));
    setSavingTune(true);
    try {
      const res = await api.mock2SetLaneTuning(lane, patch);
      setLaneTuning((cur) => cur && ({ ...cur, lanes: res.lanes }));
      toast({ title: 'Thinking settings updated', description: `${laneTuning?.options?.labels?.[lane] || lane} lane saved.` });
    } catch (err) {
      toast({ variant: 'destructive', title: 'Could not save', description: err.message });
      api.mock2GetLaneTuning().then(setLaneTuning).catch(() => {});
    } finally {
      setSavingTune(false);
    }
  };

  // Flip the global thinking switch — 'off' disables thinking for every lane
  // at once (per-lane settings are kept and come back when re-enabled).
  const saveGlobalThinking = async (off) => {
    const mode = off ? 'off' : 'default';
    setLaneTuning((cur) => cur && ({ ...cur, global_thinking: mode }));
    setSavingTune(true);
    try {
      const res = await api.mock2SetGlobalThinking(mode);
      setLaneTuning((cur) => cur && ({ ...cur, global_thinking: res.global_thinking }));
      toast({
        title: res.global_thinking === 'off' ? 'Thinking disabled everywhere' : 'Thinking re-enabled',
        description: res.global_thinking === 'off'
          ? 'Every lane now runs without thinking, regardless of per-lane settings.'
          : 'Per-lane thinking settings apply again.',
      });
    } catch (err) {
      toast({ variant: 'destructive', title: 'Could not save', description: err.message });
      api.mock2GetLaneTuning().then(setLaneTuning).catch(() => {});
    } finally {
      setSavingTune(false);
    }
  };

  const onStatus = async (item, status) => {
    setBusy(true);
    try {
      const res = await api.mock2SetQueueItemStatus(item.id, status);
      toast({
        title: `Item ${status.replace(/_/g, ' ')}`,
        description: res.resumed ? 'The blocked build has resumed.' : undefined,
      });
      await load();
    } catch (err) {
      toast({ variant: 'destructive', title: 'Could not update item', description: err.message });
    } finally {
      setBusy(false);
    }
  };

  if (!isAdmin) return <Navigate to="/" replace />;
  if (gate === 'disabled') return <Navigate to="/" replace />;
  if (gate === 'checking') {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Button asChild variant="ghost" size="icon" className="h-9 w-9 shrink-0">
          <Link to="/projects" aria-label="Back to projects"><ArrowLeft className="h-5 w-5" /></Link>
        </Button>
        <Inbox className="h-6 w-6 shrink-0 text-primary" />
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-bold tracking-tight truncate">Admin queue</h1>
          <p className="text-sm text-muted-foreground">
            {counts.total} open item{counts.total === 1 ? '' : 's'} needing attention
          </p>
        </div>
        <Button variant="outline" size="icon" className="h-10 w-10 shrink-0" disabled={loading} onClick={load} aria-label="Refresh">
          <RotateCcw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
        </Button>
      </div>

      {/* Concept chat settings — admin-configurable per-message character limit. */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Chat message limit</CardTitle>
          <CardDescription>
            Maximum characters a user can send in a single design-chat message.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-1.5 max-w-xs">
            <label className="text-xs text-muted-foreground" htmlFor="chat-max">Characters per message</label>
            <Select
              value={chatMax != null ? String(chatMax) : undefined}
              onValueChange={onChatMaxChange}
              disabled={chatMax == null || savingChat}
            >
              <SelectTrigger id="chat-max" className="h-11 sm:h-10">
                <SelectValue placeholder="Loading…" />
              </SelectTrigger>
              <SelectContent>
                {chatOptions.map((n) => (
                  <SelectItem key={n} value={String(n)}>{n.toLocaleString()} characters</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      {/* Component auto-apply — every published standard component, every build. */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Auto-apply standard components</CardTitle>
          <CardDescription>
            When on, every published component in the library is installed into every build
            automatically (zero build credits) and the build wires the design to its APIs
            instead of rebuilding it from scratch. When off, components are only suggested
            when the design&apos;s capabilities match, and must be confirmed per project.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <label htmlFor="component-auto-apply" className="flex min-h-11 items-center gap-3 cursor-pointer">
            <Switch
              id="component-auto-apply"
              checked={!!autoApply}
              disabled={autoApply == null || savingAutoApply}
              onCheckedChange={onAutoApplyChange}
            />
            <span className="text-sm">
              {autoApply == null
                ? 'Loading…'
                : autoApply
                  ? 'On — all published components install on every build'
                  : 'Off — suggest on capability match, confirm per project'}
            </span>
          </label>
          <p className="pt-2 text-xs text-muted-foreground">
            Explicitly declined components stay declined, and files a build already adapted are never overwritten.
          </p>
        </CardContent>
      </Card>

      {/* Lane tuning — per-lane model / effort / thinking-off overrides. */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Model thinking &amp; effort</CardTitle>
          <CardDescription>
            Per-lane overrides for how the harness thinks: pin a specific model, raise or lower the
            reasoning effort, or turn thinking off entirely for a lane. Blank/default keeps each
            lane&apos;s built-in choice (slots, routing, and the MVP fast model).
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {laneTuning == null ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading…
            </div>
          ) : (
            <>
            {/* Global thinking kill switch — overrides every lane at once. */}
            <label htmlFor="global-thinking-off" className="flex min-h-11 items-center gap-3 cursor-pointer rounded-md border p-3">
              <Switch
                id="global-thinking-off"
                checked={laneTuning.global_thinking === 'off'}
                disabled={savingTune}
                onCheckedChange={saveGlobalThinking}
              />
              <span className="text-sm">
                <span className="font-medium">Turn off thinking everywhere</span>
                <span className="block text-xs text-muted-foreground">
                  {laneTuning.global_thinking === 'off'
                    ? 'On — every model call runs without thinking (fastest, least reasoning depth).'
                    : 'Off — each lane uses its own thinking setting below.'}
                </span>
              </span>
            </label>
            {laneTuning.options.lanes.map((lane) => {
              const entry = laneTuning.lanes[lane] || { model: null, effort: 'default', thinking: 'default' };
              return (
                <div key={lane} className="space-y-1.5">
                  <p className="text-sm font-medium">{laneTuning.options.labels?.[lane] || lane}</p>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                    <div className="space-y-1">
                      <label className="text-xs text-muted-foreground" htmlFor={`tune-model-${lane}`}>Model override</label>
                      <Select
                        value={entry.model || 'default'}
                        disabled={savingTune}
                        onValueChange={(v) => saveLaneTuning(lane, { model: v === 'default' ? null : v })}
                      >
                        <SelectTrigger id={`tune-model-${lane}`} className="h-11 sm:h-10">
                          <SelectValue>
                            <span className="truncate">
                              {entry.model ? (modelOptionsWith(entry.model).find((m) => m.id === entry.model)?.label || entry.model) : 'Default (recommended)'}
                            </span>
                          </SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="default">Default (recommended) — slot / routing choice</SelectItem>
                          {modelOptionsWith(entry.model).map((m) => (
                            <SelectItem key={m.id} value={m.id}>
                              <span className="flex flex-col">
                                <span>{m.label}</span>
                                <span className="text-[11px] text-muted-foreground">
                                  {m.tier}{m.inPerM != null ? ` · $${m.inPerM}/$${m.outPerM} per M tok` : ''}
                                </span>
                              </span>
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-1">
                      <label className="text-xs text-muted-foreground" htmlFor={`tune-effort-${lane}`}>Effort</label>
                      <Select
                        value={entry.effort}
                        disabled={savingTune}
                        onValueChange={(v) => saveLaneTuning(lane, { effort: v })}
                      >
                        <SelectTrigger id={`tune-effort-${lane}`} className="h-11 sm:h-10"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          {laneTuning.options.efforts.map((ef) => (
                            <SelectItem key={ef} value={ef}>{ef === 'default' ? 'Lane default' : ef}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-1">
                      <label className="text-xs text-muted-foreground" htmlFor={`tune-think-${lane}`}>Thinking</label>
                      <Select
                        value={entry.thinking}
                        disabled={savingTune}
                        onValueChange={(v) => saveLaneTuning(lane, { thinking: v })}
                      >
                        <SelectTrigger id={`tune-think-${lane}`} className="h-11 sm:h-10"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="default">Adaptive (default)</SelectItem>
                          <SelectItem value="off">Off — no thinking</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                </div>
              );
            })}
            </>
          )}
          <p className="text-xs text-muted-foreground">
            A pinned model must be one the lane&apos;s connector can serve; effort levels above a model&apos;s
            support are clamped automatically. Turning thinking off speeds a lane up at the cost of
            reasoning depth (the mockup lane is off by default on purpose).
          </p>
        </CardContent>
      </Card>

      {/* Browser verification (smoke connector) — drives the deployed UI after
          user-facing diffs; dead buttons and console errors fail the build. */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Browser verification</CardTitle>
          <CardDescription>
            After a build that touches user-facing files deploys, a real (headless) browser opens the live
            app and runs its interaction checks — dead buttons, broken forms, and console errors fail the
            build instead of shipping. Turning it off ships builds for live human testing instead.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {smokeBrowser == null ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading…
            </div>
          ) : (
            <>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 items-end">
                <div className="space-y-1">
                  <label className="text-xs text-muted-foreground" htmlFor="smoke-browser-setting">Browser checks</label>
                  <Select
                    value={smokeBrowser.setting === '' ? 'default' : smokeBrowser.setting}
                    disabled={savingSmoke}
                    onValueChange={(v) => saveSmokeBrowser(v === 'default' ? '' : v)}
                  >
                    <SelectTrigger id="smoke-browser-setting" className="h-11 sm:h-10"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="on">On (recommended) — verify user-facing builds in a real browser</SelectItem>
                      <SelectItem value="default">Follow .env ({smokeBrowser.env_enabled ? 'currently on' : 'currently off'})</SelectItem>
                      <SelectItem value="off">Off — ship for live human testing</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <p className={`text-xs ${smokeBrowser.ready ? 'text-emerald-600' : 'text-amber-600'}`}>
                  {smokeBrowser.ready
                    ? `Ready — driver installed, browser at ${smokeBrowser.executable}`
                    : !smokeBrowser.driver_installed
                      ? 'Not ready: playwright-core is not installed — run update.sh (or npm install in admin/backend).'
                      : 'Not ready: no Chromium found — run update.sh (installs it) or set SMOKE_BROWSER_EXECUTABLE.'}
                </p>
              </div>
              <p className="text-xs text-muted-foreground">
                The check only runs when a build&apos;s diff touches user-facing paths (HTML/CSS/public/views) —
                backend-only changes never start a browser. If it&apos;s enabled but can&apos;t run, the build fails
                visibly rather than pretending it was checked.
              </p>
            </>
          )}
        </CardContent>
      </Card>

      {/* Integration gate mode — the block/approve loop relief valve. */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Integration gate mode</CardTitle>
          <CardDescription>
            How the integration-truthfulness gate treats a build it would block. Relax it to let a build complete and deploy for live testing — the findings stay on the record either way.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-1.5 max-w-md">
            <label className="text-xs text-muted-foreground" htmlFor="gate-mode">Mode</label>
            <Select
              value={gateMode || undefined}
              onValueChange={onGateModeChange}
              disabled={gateMode == null || savingGateMode}
            >
              <SelectTrigger id="gate-mode" className="h-11 sm:h-10">
                <SelectValue placeholder="Loading…" />
              </SelectTrigger>
              <SelectContent>
                {gateModeOptions.map((m) => (
                  <SelectItem key={m} value={m}>{GATE_MODE_LABEL[m]?.title || m}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            {gateMode && GATE_MODE_LABEL[gateMode] && (
              <p className="pt-1 text-xs text-muted-foreground">{GATE_MODE_LABEL[gateMode].desc}</p>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Filters — stack on mobile. */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <label className="text-xs text-muted-foreground" htmlFor="q-kind">Kind</label>
          <Select value={filter.kind} onValueChange={(v) => setFilter((s) => ({ ...s, kind: v }))}>
            <SelectTrigger id="q-kind" className="h-11 sm:h-10"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All kinds</SelectItem>
              {kinds.map((k) => (
                <SelectItem key={k} value={k}>{KIND_LABEL[k] || k}{counts.byKind?.[k] ? ` (${counts.byKind[k]})` : ''}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <label className="text-xs text-muted-foreground" htmlFor="q-status">Status</label>
          <Select value={filter.status} onValueChange={(v) => setFilter((s) => ({ ...s, status: v }))}>
            <SelectTrigger id="q-status" className="h-11 sm:h-10"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              {statuses.map((s) => (
                <SelectItem key={s} value={s}>{s.replace(/_/g, ' ')}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : items.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <CheckCircle2 className="h-5 w-5 text-emerald-500" /> Nothing to work
            </CardTitle>
            <CardDescription>
              No queue items match this filter. Framework deviations, drift, retries, and flags land here.
            </CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <div className="space-y-3">
          {items.some((i) => i.kind === 'framework_deviation' && i.status === 'open') ? (
            <p className="text-xs text-muted-foreground flex items-center gap-1">
              <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />
              Resolving a framework deviation unblocks the project's build.
            </p>
          ) : null}
          {items.map((it) => <QueueItem key={it.id} item={it} onStatus={onStatus} busy={busy} />)}
        </div>
      )}
    </div>
  );
}
