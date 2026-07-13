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
