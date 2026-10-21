// Application storage — per-application storage check, cleanup, cleanup rules
// and alerts (DESIGN §7). /storage/applications shows every registered
// application and Dev Studio project; ?target=<kind>:<id> opens one target:
// its latest check, the selection and the review dialog (?cleanup=<id> keeps
// a running or finished cleanup open across a reload), the cleanup rules and
// the past cleanups. Admin only, like /storage; the backend requires an
// admin session and sudo for every change.

import { useCallback, useEffect, useState } from 'react';
import { Link, Navigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft, History, ListChecks, Loader2, PieChart, RefreshCw, Settings2 } from 'lucide-react';
import { useAuth } from '@/context/AuthContext';
import { api } from '@/lib/api';
import { useToast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { BTN, Chip, EmptyState, Notice } from '@/components/storage/shared';
import StorageOverview from '@/components/app-storage/StorageOverview';
import StorageCheckDetail, { CheckHeader } from '@/components/app-storage/StorageCheckDetail';
import CleanupReview from '@/components/app-storage/CleanupReview';
import RetentionPolicy from '@/components/app-storage/RetentionPolicy';
import { emptySelection, formatAge, formatBytes, formatDateTime, isCheckFinished, parseTargetKey } from '@/components/app-storage/app-storage-model.mjs';
import { TEXT } from '@/components/app-storage/app-storage-text.js';
import { errorText, usePolling } from '@/components/app-storage/parts.jsx';

function useAdmin() {
  const { user } = useAuth();
  let stored = {};
  try { stored = JSON.parse(localStorage.getItem('user') || '{}'); } catch { /* corrupt cache */ }
  return user?.role === 'admin' || stored.role === 'admin';
}

/* --------------------------------- overview -------------------------------- */

function OverviewView() {
  const { toast } = useToast();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [running, setRunning] = useState({}); // targetKey -> checkId

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const d = await api.appStorage.overview();
      setData(d); setError('');
      setRunning((r) => {
        const next = { ...r };
        for (const t of d.targets || []) if (t.runningCheckId && !next[t.key]) next[t.key] = t.runningCheckId;
        return next;
      });
    } catch (err) { setError(errorText(err, TEXT.loadFailed)); } finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const requestCheck = async (t) => {
    setRunning((r) => ({ ...r, [t.key]: r[t.key] || 'pending' }));
    try {
      const res = await api.appStorage.requestCheck(t.kind, t.id);
      setRunning((r) => ({ ...r, [t.key]: res.checkId }));
      if (res.reused) toast({ title: TEXT.checkReused });
    } catch (err) {
      setRunning((r) => { const { [t.key]: _drop, ...rest } = r; return rest; });
      toast({ title: TEXT.checkFailed, description: errorText(err, ''), variant: 'destructive' });
    }
  };

  const ids = Object.entries(running).filter(([, id]) => id && id !== 'pending');
  usePolling(ids.length > 0, async () => {
    const results = await Promise.all(ids.map(async ([key, id]) => [key, await api.appStorage.check(id).catch(() => null)]));
    const done = results.filter(([, c]) => c && isCheckFinished(c.status));
    if (!done.length) return false;
    setRunning((r) => { const next = { ...r }; for (const [key] of done) delete next[key]; return next; });
    for (const [, c] of done) if (c.status === 'failed') toast({ title: TEXT.checkFailed, description: c.error?.message || c.target?.name, variant: 'destructive' });
    await load();
    return done.length === ids.length;
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <h1 className="text-lg font-semibold flex items-center gap-2"><PieChart className="h-5 w-5 text-primary shrink-0" />{TEXT.pageTitle}</h1>
          <p className="text-sm text-muted-foreground max-w-3xl">{TEXT.pageDescription}</p>
        </div>
        <Button variant="outline" className={`${BTN} shrink-0`} onClick={load} disabled={loading}>
          <RefreshCw className={`h-4 w-4 mr-1.5 ${loading ? 'animate-spin' : ''}`} />{TEXT.refresh}
        </Button>
      </div>
      {error && <Notice level="error"><p>{error}</p></Notice>}
      {loading && !data ? (
        <p className="flex items-center justify-center gap-2 text-sm text-muted-foreground py-12"><Loader2 className="h-4 w-4 animate-spin" />{TEXT.loading}</p>
      ) : data ? (
        <StorageOverview data={data} running={running} onRequestCheck={requestCheck} />
      ) : (
        <Card><CardContent className="p-6 text-center text-sm text-muted-foreground">{TEXT.loadFailed} <Button variant="link" className="px-1 h-11" onClick={load}>{TEXT.tryAgain}</Button></CardContent></Card>
      )}
    </div>
  );
}

/* ---------------------------------- target --------------------------------- */

const TABS = ['storage', 'rules', 'history'];

function PastCleanups({ cleanups, onOpen }) {
  if (!cleanups?.length) return <EmptyState icon={History} title={TEXT.noPastCleanups} />;
  return (
    <ul className="space-y-2">
      {cleanups.map((c) => {
        const r = c.result || {};
        const when = c.finishedAt || c.finished_at || c.createdAt || c.created_at;
        return (
          <li key={c.id} className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 p-3 border rounded-lg">
            <div className="min-w-0 flex-1 space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <Chip level={c.status === 'succeeded' ? 'ok' : c.status === 'failed' ? 'fail' : c.status === 'partial' || c.status === 'refused' ? 'warn' : 'info'}>{TEXT.cleanupStatus[c.status] || c.status}</Chip>
                <span className="text-xs text-muted-foreground">{TEXT.origin[c.origin] || c.origin}</span>
              </div>
              <p className="text-xs text-muted-foreground flex flex-wrap gap-x-3 gap-y-1">
                <span title={formatDateTime(when)}>{formatAge(when)}</span>
                {r.removed && <span>{TEXT.removedCount(r.removed.length)}</span>}
                {r.skipped?.length > 0 && <span>{TEXT.skippedCount(r.skipped.length)}</span>}
                {r.failed?.length > 0 && <span>{TEXT.failedCount(r.failed.length)}</span>}
                {r.reclaimed?.guestBytes != null && <span>{TEXT.reclaimedShort(formatBytes(r.reclaimed.guestBytes))}</span>}
              </p>
            </div>
            <Button variant="outline" className={BTN} onClick={() => onOpen(c.id)}>{TEXT.viewResult}</Button>
          </li>
        );
      })}
    </ul>
  );
}

function TargetView({ target }) {
  const { toast } = useToast();
  const [params, setParams] = useSearchParams();
  const [detail, setDetail] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [runningCheckId, setRunningCheckId] = useState(null);
  const [requesting, setRequesting] = useState(false);
  const [selection, setSelection] = useState(() => emptySelection());
  const [reviewOpen, setReviewOpen] = useState(false);
  const cleanupId = params.get('cleanup');
  const tab = TABS.includes(params.get('tab')) ? params.get('tab') : 'storage';

  const load = useCallback(async () => {
    try {
      const d = await api.appStorage.target(target.kind, target.id);
      setDetail(d); setError('');
      if (d.runningCheckId) setRunningCheckId(d.runningCheckId);
    } catch (err) { setError(errorText(err, TEXT.loadFailed)); } finally { setLoading(false); }
  }, [target.kind, target.id]);
  useEffect(() => { load(); }, [load]);

  const check = detail?.latestCheck || null;
  // A selection belongs to one check: a new check starts with nothing selected.
  useEffect(() => { setSelection(emptySelection(check?.checkId ?? null)); }, [check?.checkId]);

  const requestCheck = async () => {
    setRequesting(true);
    try {
      const res = await api.appStorage.requestCheck(target.kind, target.id);
      setRunningCheckId(res.checkId);
      if (res.reused) toast({ title: TEXT.checkReused });
    } catch (err) {
      toast({ title: TEXT.checkFailed, description: errorText(err, ''), variant: 'destructive' });
    } finally { setRequesting(false); }
  };

  usePolling(Boolean(runningCheckId), async () => {
    const c = await api.appStorage.check(runningCheckId);
    if (!isCheckFinished(c?.status)) return false;
    setRunningCheckId(null);
    await load();
    toast(c.status === 'failed' ? { title: TEXT.checkFailed, description: c.error?.message, variant: 'destructive' } : { title: TEXT.checkFinished });
    return true;
  });

  const setParam = (key, value) => {
    const next = new URLSearchParams(window.location.search);
    if (value) next.set(key, value); else next.delete(key);
    setParams(next, { replace: true });
  };
  const setCleanupParam = (id) => setParam('cleanup', id);
  const setTab = (value) => setParam('tab', value === 'storage' ? null : value);
  const openCleanup = (id) => { setReviewOpen(true); setCleanupParam(id); };
  const closeDialog = () => {
    const hadCleanup = Boolean(cleanupId);
    setReviewOpen(false);
    if (hadCleanup) { setCleanupParam(null); load(); }
  };
  const runNewCheck = () => { closeDialog(); setTab('storage'); requestCheck(); };

  const name = detail?.target?.name || target.key;
  const t = detail?.target ? { ...detail.target, kind: target.kind, id: target.id } : { kind: target.kind, id: target.id, key: target.key, name };
  const running = Boolean(runningCheckId) || requesting;

  return (
    <div className="space-y-4">
      <nav aria-label={TEXT.breadcrumb} className="flex flex-wrap items-center gap-1 text-sm min-w-0">
        <Button asChild variant="ghost" className={`${BTN} -ml-2 px-2`}><Link to="/storage/applications"><ArrowLeft className="h-4 w-4 mr-1.5" />{TEXT.backToOverview}</Link></Button>
        <span className="text-muted-foreground" aria-hidden="true">/</span>
        <h1 className="font-semibold break-words min-w-0">{name}</h1>
      </nav>
      {error && <Notice level="error"><p>{error}</p><Button variant="outline" className={`${BTN} mt-1`} onClick={load}>{TEXT.tryAgain}</Button></Notice>}
      {loading && !detail ? (
        <p className="flex items-center justify-center gap-2 text-sm text-muted-foreground py-12"><Loader2 className="h-4 w-4 animate-spin" />{TEXT.loading}</p>
      ) : detail ? (
        <>
          <CheckHeader target={t} check={check} running={running} onRequestCheck={requestCheck} />
          <Tabs value={tab} onValueChange={setTab} className="w-full">
            <TabsList className="flex flex-wrap h-auto w-full sm:w-auto justify-start gap-1">
              <TabsTrigger value="storage" className="h-11 sm:h-9"><ListChecks className="h-4 w-4 mr-1.5" />{TEXT.tabStorage}</TabsTrigger>
              <TabsTrigger value="rules" className="h-11 sm:h-9"><Settings2 className="h-4 w-4 mr-1.5" />{TEXT.tabRules}</TabsTrigger>
              <TabsTrigger value="history" className="h-11 sm:h-9"><History className="h-4 w-4 mr-1.5" />{TEXT.tabHistory}</TabsTrigger>
            </TabsList>
            <TabsContent value="storage" className="mt-4">
              <StorageCheckDetail check={check} selection={selection} onSelectionChange={setSelection} onReview={() => setReviewOpen(true)} running={running} onRequestCheck={requestCheck} />
            </TabsContent>
            <TabsContent value="rules" className="mt-4">
              <RetentionPolicy target={t} checkId={check?.checkId ?? null} running={running} onRequestCheck={requestCheck} />
            </TabsContent>
            <TabsContent value="history" className="mt-4">
              <h2 className="text-base font-semibold mb-3">{TEXT.pastCleanups}</h2>
              <PastCleanups cleanups={detail.cleanups} onOpen={openCleanup} />
            </TabsContent>
          </Tabs>
          <CleanupReview open={reviewOpen || Boolean(cleanupId)} onClose={closeDialog} target={t} check={check}
            selection={selection} onSelectionChange={setSelection} cleanupId={cleanupId}
            onStarted={(res) => { setSelection(emptySelection(check?.checkId ?? null)); openCleanup(res.cleanupId); }} onRunCheck={runNewCheck} />
        </>
      ) : null}
    </div>
  );
}

export default function AppStorage() {
  const isAdmin = useAdmin();
  const [params] = useSearchParams();
  if (!isAdmin) return <Navigate to="/" replace />;
  const raw = params.get('target');
  const target = raw ? parseTargetKey(raw) : null;
  if (raw && !target) return <Navigate to="/storage/applications" replace />;
  return target ? <TargetView key={target.key} target={target} /> : <OverviewView />;
}
