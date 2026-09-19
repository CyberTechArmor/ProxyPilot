// Migrations — copy a running web application from another server, VM or
// container onto a ProxyPilot guest.
//
// The page is a list and a detail: the list is every migration with where it
// got to; the detail is the phase rail, the transfer progress, the inventory
// the source sent (the review that gates the copy), the cutover checklist
// and the agent's own log. Everything comes from /api/migrations
// (routes/migrations.js); the source host talks to a different router with a
// single-use token and never touches a session.

import { useCallback, useEffect, useRef, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '@/context/AuthContext';
import { api, ApiError } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { useToast } from '@/hooks/use-toast';
import { ArrowLeft, ClipboardList, Loader2, MoveRight, Plus, RefreshCw, ScrollText, Server, XCircle } from 'lucide-react';
import NewMigrationDialog from '@/components/migration/NewMigrationDialog';
import InventoryReview from '@/components/migration/InventoryReview';
import CutoverChecklist from '@/components/migration/CutoverChecklist';
import MigrationPreflight from '@/components/migration/MigrationPreflight';
import { BTN, Chip, EmptyState, KV, MigrationStatus, Notice, PhaseRail, TransferBar, fmtDate } from '@/components/migration/shared';

const LIVE = ['created', 'running', 'awaiting_review'];

function MigrationRow({ m, onOpen }) {
  return (
    <button type="button" onClick={() => onOpen(m.id)} className="w-full text-left border rounded-lg p-3 hover:bg-muted/40 min-h-[44px] space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-sm break-all">{m.target}</span>
        <MigrationStatus status={m.status} />
        <Chip level="muted">{m.mode}</Chip>
        <Chip level="muted" mono>{m.transport}</Chip>
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span>#{m.id}</span>
        {m.source_label && <span className="break-all">from {m.source_label}</span>}
        <span>{fmtDate(m.created_at)}</span>
        <span>{m.checklist_progress.done}/{m.checklist_progress.total} cutover steps</span>
      </div>
      {m.status === 'running' && <TransferBar progress={m.progress} />}
      {m.error && <p className="text-xs text-red-500 break-words">{m.error}</p>}
    </button>
  );
}

function EventLog({ events }) {
  const endRef = useRef(null);
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'nearest' }); }, [events]);
  if (!events?.length) return <p className="text-sm text-muted-foreground">Nothing yet. The agent's log appears here as it runs.</p>;
  const tone = { error: 'text-red-500', state: 'text-foreground', progress: 'text-cyan-600 dark:text-cyan-400' };
  return (
    <div className="max-h-[50vh] overflow-y-auto rounded border bg-muted/30 p-2 font-mono text-xs space-y-0.5">
      {events.map((e) => (
        <div key={e.id} className={`break-words ${tone[e.kind] || 'text-muted-foreground'}`}>
          <span className="opacity-60">{new Date(e.at).toLocaleTimeString()} </span>{e.message}
        </div>
      ))}
      <div ref={endRef} />
    </div>
  );
}

function Detail({ id, onBack, onChanged }) {
  const { toast } = useToast();
  const [m, setM] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [tab, setTab] = useState('inventory');

  const load = useCallback(async ({ quiet = false } = {}) => {
    if (!quiet) setLoading(true);
    try {
      const r = await api.migrations.get(id, { events: 300 });
      setM(r.migration); setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? (e.body?.error || e.message) : e.message);
    } finally { setLoading(false); }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  // A running transfer is worth watching; a finished one is not worth polling.
  useEffect(() => {
    if (!m || !LIVE.includes(m.status)) return undefined;
    const t = setInterval(() => load({ quiet: true }), m.status === 'running' ? 5000 : 10000);
    return () => clearInterval(t);
  }, [m, load]);

  const act = async (fn, okMsg) => {
    setBusy(true);
    try {
      await fn();
      if (okMsg) toast({ title: okMsg });
      await load({ quiet: true });
      onChanged?.();
    } catch (e) {
      toast({ title: 'That did not work', description: e instanceof ApiError ? (e.body?.error || e.message) : e.message, variant: 'destructive' });
    } finally { setBusy(false); }
  };

  if (loading && !m) return <div className="flex items-center gap-2 text-sm text-muted-foreground py-12 justify-center"><Loader2 className="h-4 w-4 animate-spin" />Loading migration {id}…</div>;
  if (error && !m) return <Notice level="error"><p>{error}</p></Notice>;
  if (!m) return null;

  const tabs = [
    { value: 'inventory', label: 'Inventory', icon: Server },
    { value: 'cutover', label: 'Cutover', icon: ClipboardList },
    { value: 'log', label: 'Log', icon: ScrollText },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <Button variant="ghost" size="sm" className={BTN} onClick={onBack}><ArrowLeft className="h-4 w-4" /></Button>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-base font-semibold font-mono break-all">{m.target.incus_name}</h2>
              <MigrationStatus status={m.status} />
            </div>
            <p className="text-xs text-muted-foreground break-words">
              #{m.id} · {m.mode} via {m.transport}{m.source_label ? ` · from ${m.source_label}` : ''}
            </p>
          </div>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" className={BTN} onClick={() => load()} disabled={loading}><RefreshCw className={`h-4 w-4 mr-1.5 ${loading ? 'animate-spin' : ''}`} />Refresh</Button>
          {!['completed', 'failed', 'cancelled'].includes(m.status) && (
            <Button variant="outline" className={BTN} disabled={busy} onClick={() => act(() => api.migrations.cancel(m.id), 'Migration cancelled')}>
              <XCircle className="h-4 w-4 mr-1.5" />Cancel
            </Button>
          )}
        </div>
      </div>

      <Card><CardContent className="p-4 space-y-3">
        <PhaseRail phases={m.phases} />
        {m.status === 'running' && <TransferBar progress={m.progress} />}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-6 gap-y-1">
          <KV label="Target">{m.target.incus_name}</KV>
          <KV label="Guest">{m.spec.type} · {m.spec.cpu} vCPU · {m.spec.memory_gb} GB{m.spec.disk_gb ? ` · ${m.spec.disk_gb} GB disk` : ''}</KV>
          <KV label="Token">{m.token.claimed ? `claimed ${fmtDate(m.token.claimed_at)}` : 'not used yet'}</KV>
          <KV label="Token expires">{fmtDate(m.token.expires_at)}</KV>
          <KV label="Agent last seen">{m.token.last_seen_at ? fmtDate(m.token.last_seen_at) : '—'}</KV>
          <KV label="TLS pin">{m.token.tls_pin ? `${m.token.tls_pin.slice(0, 20)}…` : 'none (system trust)'}</KV>
        </div>
        {m.error && <Notice level="error"><p className="break-words">{m.error}</p></Notice>}
        {m.status === 'created' && (
          <Notice level="info">
            <p>Waiting for the source host. Run the command this migration printed, as root, on {m.source_label || 'the source'}.</p>
            <p className="text-xs">The token is shown only once — if it was lost, cancel and create a new migration.</p>
          </Notice>
        )}
      </CardContent></Card>

      <Tabs value={tab} onValueChange={setTab} className="w-full">
        <TabsList className="flex h-auto w-full max-w-full justify-start overflow-x-auto">
          {tabs.map((t) => (
            <TabsTrigger key={t.value} value={t.value} className="shrink-0 h-10"><t.icon className="h-4 w-4 mr-1.5" />{t.label}</TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="inventory">
          <InventoryReview
            migration={m} busy={busy}
            onApprove={() => act(() => api.migrations.approve(m.id), 'Transfer approved — the agent starts within a few seconds')}
            onEgress={(e, decision) => act(() => api.migrations.egress(m.id, { host: e.host, port: e.port, decision }), `Egress ${decision === 'approve' ? 'allowed' : 'denied'}`)}
          />
        </TabsContent>
        <TabsContent value="cutover">
          <CutoverChecklist
            migration={m} busy={busy}
            onStep={(step, done, note) => act(() => api.migrations.checklist(m.id, { step, done, note }))}
          />
        </TabsContent>
        <TabsContent value="log"><Card><CardContent className="p-4"><EventLog events={m.events} /></CardContent></Card></TabsContent>
      </Tabs>
    </div>
  );
}

export default function Migrations() {
  const { user } = useAuth();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [openId, setOpenId] = useState(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await api.migrations.list({ limit: 100 }));
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? (e.body?.error || e.message) : e.message);
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  if (user && user.role !== 'admin') return <Navigate to="/" replace />;

  const rows = data?.migrations || [];

  if (openId) return <div className="space-y-4 p-1"><Detail id={openId} onBack={() => { setOpenId(null); load(); }} onChanged={load} /></div>;

  return (
    <div className="space-y-4 p-1">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div className="flex items-center gap-2 flex-wrap min-w-0">
          <MoveRight className="h-5 w-5 text-primary" />
          <h1 className="text-lg font-semibold">Migrations</h1>
          <span className="text-xs text-muted-foreground">adopt a server, VM or container into this host</span>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" className={BTN} onClick={load} disabled={loading}><RefreshCw className={`h-4 w-4 mr-1.5 ${loading ? 'animate-spin' : ''}`} />Refresh</Button>
          <Button className={BTN} onClick={() => setCreating(true)}><Plus className="h-4 w-4 mr-1.5" />New migration</Button>
        </div>
      </div>

      {error && <Notice level="error"><p className="break-words">{error}</p></Notice>}

      {/* Readiness sits above the list: the agent build, the callback URL, the
          TLS pin and the Incus listener are what decide whether the command
          you are about to paste on a source host can work at all. */}
      <MigrationPreflight onChanged={load} />

      {loading && !data ? (
        <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground py-12"><Loader2 className="h-4 w-4 animate-spin" />Loading…</div>
      ) : rows.length === 0 ? (
        <EmptyState
          icon={MoveRight}
          title="No migrations yet"
          hint="A migration copies a running application from another server, VM or container onto a guest here. ProxyPilot prints one command to run on the source; nothing is copied until you have read what it found."
          action={<Button className={BTN} onClick={() => setCreating(true)}><Plus className="h-4 w-4 mr-1.5" />New migration</Button>}
        />
      ) : (
        <div className="grid grid-cols-1 gap-2">
          {rows.map((m) => <MigrationRow key={m.id} m={m} onOpen={setOpenId} />)}
        </div>
      )}

      <NewMigrationDialog
        open={creating}
        onClose={() => { setCreating(false); load(); }}
        onCreated={() => load()}
      />
    </div>
  );
}
