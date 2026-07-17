// Mock2 model & git connectors admin surface (Phase M5, ADR-003 / ADR-006).
//
// Admins register the model connectors a build cycle calls (Anthropic / OpenAI /
// Gemini / Ollama / OpenAI-compatible), test them, assign each of the 7 slots a
// connector+model (capability-enforced — a chat-only model can't be the
// build_runner), and acknowledge the one-time BAA on cloud connectors (Q7). A
// second tab manages optional git push connectors (ADR-006).
//
// Reachable only when the backend reports Mock2 enabled (GET /api/mock2/status
// → 200); a direct visit on a disabled/pinned host bounces home (ADR-001).
//
// MOBILE_FIRST: single-column stacked cards, tabs that wrap, 44px touch targets,
// full-screen-on-<sm dialogs. Renders clean at 360px with no horizontal scroll.

import { useEffect, useState, useCallback } from 'react';
import { Navigate, Link } from 'react-router-dom';
import { useAuth } from '@/context/AuthContext';
import { api, ApiError } from '@/lib/api';
import { useToast } from '@/hooks/use-toast';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  ArrowLeft, Loader2, Plus, Trash2, CheckCircle2, XCircle, CircleDashed, ShieldCheck, Cpu, GitBranch, Route,
} from 'lucide-react';
import {
  SLOT_SUGGESTED_MODEL, RECOMMENDED_ESCALATE_MODEL, modelLabel, modelOptionsWith,
} from '@/lib/model-options';

const PROVIDERS = ['anthropic', 'openai', 'gemini', 'ollama', 'openai_compatible'];
const CAPABILITIES = ['chat', 'agentic_build', 'summarize', 'classify'];
const SLOTS = ['concept_chat', 'mockup', 'audit', 'classifier', 'build_runner', 'summary', 'remediation'];
const SLOT_CAP = {
  concept_chat: 'chat', mockup: 'chat', audit: 'chat', classifier: 'classify',
  build_runner: 'agentic_build', summary: 'summarize', remediation: 'agentic_build',
};

const GIT_PROVIDERS = ['github', 'gitea', 'generic_https', 'generic_ssh'];

function TestBadge({ test }) {
  if (!test) return <span className="inline-flex items-center gap-1 text-xs text-muted-foreground"><CircleDashed className="h-3.5 w-3.5" /> untested</span>;
  if (test.ok === true) return <span className="inline-flex items-center gap-1 text-xs text-emerald-500"><CheckCircle2 className="h-3.5 w-3.5" /> {test.detail || 'ok'}</span>;
  if (test.ok === false) return <span className="inline-flex items-center gap-1 text-xs text-red-500"><XCircle className="h-3.5 w-3.5" /> {test.detail || 'failed'}</span>;
  return <span className="inline-flex items-center gap-1 text-xs text-amber-500"><CircleDashed className="h-3.5 w-3.5" /> {test.detail || 'n/a'}</span>;
}

export default function ModelConnectors() {
  const { user } = useAuth();
  const storedUser = JSON.parse(localStorage.getItem('user') || '{}');
  const isAdmin = user?.role === 'admin' || storedUser?.role === 'admin';
  const { toast } = useToast();

  const [gate, setGate] = useState('checking');
  const [connectors, setConnectors] = useState([]);
  const [slots, setSlots] = useState([]);
  const [gitConnectors, setGitConnectors] = useState([]);
  const [routing, setRouting] = useState(null);   // { mode, rules, env_escalate_model, efforts }
  const [outcomes, setOutcomes] = useState(null); // { stats, recent }
  const [busyId, setBusyId] = useState(null);

  const load = useCallback(async () => {
    try {
      const [c, s, g, r, o] = await Promise.all([
        api.mock2ListConnectors(),
        api.mock2ListModelSlots(),
        api.mock2ListGitConnectors().catch(() => ({ connectors: [] })),
        api.mock2RoutingRules().catch(() => null),
        api.mock2RoutingOutcomes().catch(() => null),
      ]);
      setConnectors(c.connectors || []);
      setSlots(s.slots || []);
      setGitConnectors(g.connectors || []);
      setRouting(r);
      setOutcomes(o);
    } catch (err) {
      if (!(err instanceof ApiError)) console.error('load connectors failed:', err);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    api.mock2Status()
      .then(() => { if (!cancelled) { setGate('enabled'); load(); } })
      .catch((err) => {
        if (!cancelled) setGate('disabled');
        if (!(err instanceof ApiError)) console.error('mock2 status check failed:', err);
      });
    return () => { cancelled = true; };
  }, [load]);

  // ---- add connector dialog ----
  const [addOpen, setAddOpen] = useState(false);
  const [form, setForm] = useState({ name: '', provider: 'anthropic', base_url: '', api_key: '', capabilities: [] });
  const [saving, setSaving] = useState(false);
  const [baaAck, setBaaAck] = useState(null); // connector row awaiting BAA ack

  const resetForm = () => setForm({ name: '', provider: 'anthropic', base_url: '', api_key: '', capabilities: [] });
  const toggleCap = (cap) => setForm((f) => ({
    ...f, capabilities: f.capabilities.includes(cap) ? f.capabilities.filter((c) => c !== cap) : [...f.capabilities, cap],
  }));
  const needsBaseUrl = form.provider === 'ollama' || form.provider === 'openai_compatible';

  const createConnector = async () => {
    if (!form.name.trim()) { toast({ variant: 'destructive', title: 'Name is required' }); return; }
    setSaving(true);
    try {
      const body = {
        name: form.name.trim(), provider: form.provider,
        base_url: needsBaseUrl ? form.base_url.trim() : undefined,
        api_key: form.api_key ? form.api_key : undefined,
        capabilities: form.capabilities.length ? form.capabilities : undefined,
      };
      const res = await api.mock2CreateConnector(body);
      setAddOpen(false);
      resetForm();
      await load();
      if (res.baa_ack_required) setBaaAck(res.connector);
      else toast({ title: 'Connector added' });
    } catch (err) {
      toast({ variant: 'destructive', title: 'Could not add connector', description: err.message });
    } finally {
      setSaving(false);
    }
  };

  const ackBaa = async () => {
    const row = baaAck;
    setBaaAck(null);
    try { await api.mock2AckConnectorBaa(row.id); await load(); toast({ title: 'BAA acknowledged' }); }
    catch (err) { toast({ variant: 'destructive', title: 'Ack failed', description: err.message }); }
  };

  const act = async (id, fn, okMsg) => {
    setBusyId(id);
    try { const r = await fn(); await load(); if (okMsg) toast({ title: typeof okMsg === 'function' ? okMsg(r) : okMsg }); }
    catch (err) { toast({ variant: 'destructive', title: 'Action failed', description: err.message }); }
    finally { setBusyId(null); }
  };

  // ---- slot assignment ----
  const assignSlot = async (slot, connectorId, model) => {
    if (!connectorId || !model) { toast({ variant: 'destructive', title: 'Pick a connector and enter a model id' }); return; }
    try { await api.mock2AssignModelSlot(slot, { connector_id: connectorId, model }); await load(); toast({ title: `${slot} assigned` }); }
    catch (err) { toast({ variant: 'destructive', title: 'Assignment refused', description: err.message }); }
  };

  // ---- add git connector dialog ----
  const [gitOpen, setGitOpen] = useState(false);
  const [gitForm, setGitForm] = useState({ name: '', provider: 'github', base_url: '', auth_kind: 'token', credential: '' });
  const [gitSaving, setGitSaving] = useState(false);
  const resetGit = () => setGitForm({ name: '', provider: 'github', base_url: '', auth_kind: 'token', credential: '' });
  const createGit = async () => {
    if (!gitForm.name.trim() || !gitForm.credential) { toast({ variant: 'destructive', title: 'Name and credential are required' }); return; }
    setGitSaving(true);
    try {
      await api.mock2CreateGitConnector({
        name: gitForm.name.trim(), provider: gitForm.provider,
        base_url: gitForm.base_url.trim() || undefined, auth_kind: gitForm.auth_kind, credential: gitForm.credential,
      });
      setGitOpen(false); resetGit(); await load(); toast({ title: 'Git connector added' });
    } catch (err) {
      toast({ variant: 'destructive', title: 'Could not add git connector', description: err.message });
    } finally { setGitSaving(false); }
  };

  if (gate === 'checking') {
    return <div className="flex items-center justify-center p-12"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>;
  }
  if (gate === 'disabled' || !isAdmin) return <Navigate to="/" replace />;

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-4 sm:p-6">
      <div className="space-y-1">
        <Link to="/projects" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-4 w-4" /> Projects
        </Link>
        <h1 className="flex items-center gap-2 text-2xl font-semibold"><Cpu className="h-6 w-6" /> Connectors</h1>
        <p className="text-sm text-muted-foreground">
          The AI models a build cycle calls, and optional git push targets. Keys are encrypted at rest and never leave the server.
        </p>
      </div>

      <Tabs defaultValue="models">
        <TabsList className="flex-wrap">
          <TabsTrigger value="models">Model connectors</TabsTrigger>
          <TabsTrigger value="slots">Slots</TabsTrigger>
          <TabsTrigger value="routing">Routing</TabsTrigger>
          <TabsTrigger value="git">Git connectors</TabsTrigger>
        </TabsList>

        {/* ---- Model connectors ---- */}
        <TabsContent value="models" className="space-y-4">
          <div className="flex justify-end">
            <Button onClick={() => { resetForm(); setAddOpen(true); }} className="min-h-[44px]"><Plus className="mr-1 h-4 w-4" /> Add connector</Button>
          </div>
          {connectors.length === 0 && (
            <Card><CardContent className="p-6 text-center text-sm text-muted-foreground">No model connectors yet. Add one to enable build cycles.</CardContent></Card>
          )}
          {connectors.map((c) => (
            <Card key={c.id}>
              <CardHeader className="pb-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <CardTitle className="text-base">{c.name}</CardTitle>
                  <span className="rounded bg-muted px-2 py-0.5 text-xs">{c.provider}</span>
                </div>
                <CardDescription className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <TestBadge test={c.test} />
                  {!c.enabled && <span className="text-xs text-amber-500">disabled</span>}
                  {c.has_key && !c.secret_decryptable && <span className="text-xs text-red-500">key not decryptable</span>}
                  {c.is_cloud && (c.baa_ack_at ? <span className="inline-flex items-center gap-1 text-xs text-emerald-500"><ShieldCheck className="h-3.5 w-3.5" /> BAA ack</span> : <span className="text-xs text-amber-500">BAA not acknowledged</span>)}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex flex-wrap gap-1">
                  {c.capabilities.map((cap) => <span key={cap} className="rounded border px-1.5 py-0.5 text-[11px] text-muted-foreground">{cap}</span>)}
                </div>
                {c.egress_host && <p className="text-xs text-muted-foreground">Egress host allowed to project containers: <code>{c.egress_host}</code></p>}
                <div className="flex flex-wrap gap-2">
                  <Button variant="outline" size="sm" className="min-h-[44px]" disabled={busyId === c.id}
                    onClick={() => act(c.id, () => api.mock2TestConnector(c.id), (r) => r.ok ? 'Connection ok' : 'Connection failed')}>
                    {busyId === c.id ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Test'}
                  </Button>
                  <Button variant="outline" size="sm" className="min-h-[44px]" disabled={busyId === c.id}
                    onClick={() => act(c.id, () => api.mock2UpdateConnector(c.id, { enabled: !c.enabled }), c.enabled ? 'Disabled' : 'Enabled')}>
                    {c.enabled ? 'Disable' : 'Enable'}
                  </Button>
                  {c.is_cloud && !c.baa_ack_at && (
                    <Button variant="outline" size="sm" className="min-h-[44px]" onClick={() => setBaaAck(c)}>Acknowledge BAA</Button>
                  )}
                  <Button variant="ghost" size="sm" className="min-h-[44px] text-red-500" disabled={busyId === c.id}
                    onClick={() => act(c.id, () => api.mock2DeleteConnector(c.id), 'Deleted')}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </TabsContent>

        {/* ---- Slots ---- */}
        <TabsContent value="slots" className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Each stage of a build cycle calls one connector + model. Assignment is capability-enforced — e.g. <strong>build_runner</strong> refuses a chat-only model.
            Each slot shows a suggested model: spend <strong>Opus</strong> only on the hard agentic build, <strong>Sonnet</strong> where quality matters,
            and <strong>Haiku</strong> on the cheap classify/summarize stages — the biggest lever on cost.
          </p>
          {SLOTS.map((slot) => {
            const cur = slots.find((s) => s.slot === slot) || {};
            const eligible = connectors.filter((c) => c.enabled && c.capabilities.includes(SLOT_CAP[slot]));
            return <SlotRow key={slot} slot={slot} cur={cur} eligible={eligible} onAssign={assignSlot} onClear={() => act(slot, () => api.mock2ClearModelSlot(slot), 'Cleared')} />;
          })}
        </TabsContent>

        {/* ---- Model routing knowledge base ---- */}
        <TabsContent value="routing" className="space-y-4">
          <p className="text-sm text-muted-foreground">
            The routing <strong>knowledge base</strong>: the define audit classifies every build task
            (kind + difficulty 1–5), and these rules decide which model runs it, at what reasoning effort,
            and which stronger model to <strong>escalate</strong> to after a failed/blocked attempt (or a
            difficulty-5 task). Leave a field empty to keep the default (the build_runner slot model, the
            lane&apos;s effort). Every decision is stamped on the cycle and logged; the scoreboard below is
            the evidence to tune against.
          </p>
          {routing ? (
            <>
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className={`rounded px-2 py-0.5 ${routing.mode === 'on' ? 'bg-emerald-500/10 text-emerald-500' : routing.mode === 'shadow' ? 'bg-amber-500/10 text-amber-500' : 'bg-muted text-muted-foreground'}`}>
                  routing: {routing.mode}{routing.mode === 'shadow' ? ' (recorded, not applied)' : routing.mode === 'off' ? ' (disabled)' : ''}
                </span>
                <span className="text-muted-foreground">
                  Fallback escalation model (MOCK2_ESCALATE_MODEL): {routing.env_escalate_model ? <code>{routing.env_escalate_model}</code> : 'not set'}
                </span>
              </div>
              {(routing.rules || []).map((r) => (
                <RoutingRuleRow key={r.task_kind} rule={r} efforts={routing.efforts || []}
                  onSave={async (patch) => {
                    try {
                      const res = await api.mock2UpdateRoutingRule(r.task_kind, patch);
                      setRouting((cur) => ({ ...cur, rules: (cur.rules || []).map((x) => (x.task_kind === r.task_kind ? res.rule : x)) }));
                      toast({ title: `Rule "${r.task_kind}" saved` });
                    } catch (err) {
                      toast({ variant: 'destructive', title: 'Save failed', description: err.message });
                    }
                  }} />
              ))}
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-base">Outcome scoreboard</CardTitle>
                  <CardDescription>Per task kind × model that actually ran — from every finished routed build. Success counts deployed builds (succeeded / awaiting review); failure counts failed / blocked ones.</CardDescription>
                </CardHeader>
                <CardContent>
                  {outcomes?.stats?.length ? (
                    <div className="overflow-x-auto">
                      <table className="w-full min-w-[560px] text-sm">
                        <thead>
                          <tr className="border-b text-left text-xs text-muted-foreground">
                            <th className="py-1.5 pr-2 font-medium">Task kind</th>
                            <th className="py-1.5 pr-2 font-medium">Model</th>
                            <th className="py-1.5 pr-2 font-medium">Runs</th>
                            <th className="py-1.5 pr-2 font-medium">Success</th>
                            <th className="py-1.5 pr-2 font-medium">Escalated</th>
                            <th className="py-1.5 font-medium">Avg cost</th>
                          </tr>
                        </thead>
                        <tbody>
                          {outcomes.stats.map((s) => (
                            <tr key={`${s.task_kind}|${s.model}`} className="border-b last:border-0">
                              <td className="py-1.5 pr-2">{s.task_kind}</td>
                              <td className="py-1.5 pr-2"><code className="text-xs">{s.model}</code></td>
                              <td className="py-1.5 pr-2">{s.runs}</td>
                              <td className={`py-1.5 pr-2 ${s.success_rate != null && s.success_rate < 50 ? 'text-red-500' : s.success_rate != null && s.success_rate >= 80 ? 'text-emerald-500' : ''}`}>
                                {s.success_rate != null ? `${s.success_rate}%` : '—'}
                              </td>
                              <td className="py-1.5 pr-2">{s.escalated}</td>
                              <td className="py-1.5">{s.avg_cost_cents != null ? `$${(s.avg_cost_cents / 100).toFixed(2)}` : '—'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground">No routed builds have finished yet — the scoreboard fills in as builds complete.</p>
                  )}
                </CardContent>
              </Card>
            </>
          ) : (
            <Card><CardContent className="p-6 text-center text-sm text-muted-foreground">Routing rules could not be loaded.</CardContent></Card>
          )}
        </TabsContent>

        {/* ---- Git connectors ---- */}
        <TabsContent value="git" className="space-y-4">
          <p className="text-sm text-muted-foreground">Optional push targets. Credentials are encrypted and never enter a container — pushes run server-side (ADR-006).</p>
          <div className="flex justify-end">
            <Button onClick={() => { resetGit(); setGitOpen(true); }} className="min-h-[44px]"><Plus className="mr-1 h-4 w-4" /> Add git connector</Button>
          </div>
          {gitConnectors.length === 0 && (
            <Card><CardContent className="p-6 text-center text-sm text-muted-foreground">No git connectors. The local bare repo is always primary; these are optional.</CardContent></Card>
          )}
          {gitConnectors.map((g) => (
            <Card key={g.id}>
              <CardHeader className="pb-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <CardTitle className="text-base flex items-center gap-2"><GitBranch className="h-4 w-4" /> {g.name}</CardTitle>
                  <span className="rounded bg-muted px-2 py-0.5 text-xs">{g.provider} · {g.auth_kind}</span>
                </div>
                <CardDescription><TestBadge test={g.test} /></CardDescription>
              </CardHeader>
              <CardContent className="flex flex-wrap gap-2">
                <Button variant="outline" size="sm" className="min-h-[44px]" disabled={busyId === `g${g.id}`}
                  onClick={() => act(`g${g.id}`, () => api.mock2TestGitConnector(g.id), (r) => r.ok ? 'Credentials ok' : 'Test done')}>
                  {busyId === `g${g.id}` ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Test'}
                </Button>
                <Button variant="ghost" size="sm" className="min-h-[44px] text-red-500" disabled={busyId === `g${g.id}`}
                  onClick={() => act(`g${g.id}`, () => api.mock2DeleteGitConnector(g.id), 'Deleted')}>
                  <Trash2 className="h-4 w-4" />
                </Button>
              </CardContent>
            </Card>
          ))}
        </TabsContent>
      </Tabs>

      {/* ---- add connector dialog ---- */}
      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Add model connector</DialogTitle>
            <DialogDescription>The key is encrypted at rest with the server&apos;s encryption key.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div><Label htmlFor="cn">Name</Label><Input id="cn" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Claude (prod)" /></div>
            <div>
              <Label>Provider</Label>
              <Select value={form.provider} onValueChange={(v) => setForm({ ...form, provider: v, capabilities: [] })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>{PROVIDERS.map((p) => <SelectItem key={p} value={p}>{p}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            {needsBaseUrl && (
              <div><Label htmlFor="bu">Base URL</Label><Input id="bu" value={form.base_url} onChange={(e) => setForm({ ...form, base_url: e.target.value })} placeholder="http://localhost:11434" /></div>
            )}
            <div><Label htmlFor="ak">API key {form.provider === 'ollama' && <span className="text-muted-foreground">(optional for local)</span>}</Label><Input id="ak" type="password" value={form.api_key} onChange={(e) => setForm({ ...form, api_key: e.target.value })} placeholder="sk-…" /></div>
            <div>
              <Label>Capabilities <span className="text-muted-foreground text-xs">(default: sensible per provider)</span></Label>
              <div className="mt-1 flex flex-wrap gap-2">
                {CAPABILITIES.map((cap) => (
                  <button key={cap} type="button" onClick={() => toggleCap(cap)}
                    className={`min-h-[44px] rounded border px-3 text-sm ${form.capabilities.includes(cap) ? 'border-primary bg-primary/10 text-foreground' : 'text-muted-foreground'}`}>
                    {cap}
                  </button>
                ))}
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setAddOpen(false)}>Cancel</Button>
            <Button onClick={createConnector} disabled={saving}>{saving && <Loader2 className="mr-1 h-4 w-4 animate-spin" />} Add</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ---- BAA ack dialog (Q7) ---- */}
      <Dialog open={!!baaAck} onOpenChange={(o) => { if (!o) setBaaAck(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Business Associate Agreement</DialogTitle>
            <DialogDescription>One-time acknowledgement for a cloud model provider.</DialogDescription>
          </DialogHeader>
          <p className="text-sm">
            Confirm this account is covered by a BAA if this instance will handle PHI-adjacent work.
            This is recorded (who and when) on the connector — it is an acknowledgement, not a blocker.
          </p>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setBaaAck(null)}>Later</Button>
            <Button onClick={ackBaa}>I acknowledge</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ---- add git connector dialog ---- */}
      <Dialog open={gitOpen} onOpenChange={setGitOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>Add git connector</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div><Label htmlFor="gn">Name</Label><Input id="gn" value={gitForm.name} onChange={(e) => setGitForm({ ...gitForm, name: e.target.value })} /></div>
            <div>
              <Label>Provider</Label>
              <Select value={gitForm.provider} onValueChange={(v) => setGitForm({ ...gitForm, provider: v, auth_kind: v === 'generic_ssh' ? 'ssh_key' : gitForm.auth_kind })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>{GIT_PROVIDERS.map((p) => <SelectItem key={p} value={p}>{p}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            {gitForm.provider !== 'github' && (
              <div><Label htmlFor="gb">Base URL</Label><Input id="gb" value={gitForm.base_url} onChange={(e) => setGitForm({ ...gitForm, base_url: e.target.value })} placeholder="https://git.example.com" /></div>
            )}
            <div>
              <Label>Auth kind</Label>
              <Select value={gitForm.auth_kind} onValueChange={(v) => setGitForm({ ...gitForm, auth_kind: v })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="token">token</SelectItem><SelectItem value="ssh_key">ssh_key</SelectItem></SelectContent>
              </Select>
            </div>
            <div><Label htmlFor="gc">{gitForm.auth_kind === 'token' ? 'Token' : 'SSH private key'}</Label>
              <textarea id="gc" value={gitForm.credential} onChange={(e) => setGitForm({ ...gitForm, credential: e.target.value })}
                className="min-h-[80px] w-full rounded-md border bg-background p-2 text-sm" placeholder={gitForm.auth_kind === 'token' ? 'ghp_…' : '-----BEGIN OPENSSH PRIVATE KEY-----'} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setGitOpen(false)}>Cancel</Button>
            <Button onClick={createGit} disabled={gitSaving}>{gitSaving && <Loader2 className="mr-1 h-4 w-4 animate-spin" />} Add</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// One knowledge-base rule: task kind → model / escalation model / effort /
// notes. The model dropdowns default to the recommendation: 'auto' (no
// override — routing sends routine tasks to the fast code model and hard ones
// to the slot model) for Model, and the strongest coding model for Escalate.
// Sentinels ('auto' / 'none') map to null on save, meaning "the default
// applies"; the effort select uses a 'default' sentinel for the same reason.
function RoutingRuleRow({ rule, efforts, onSave }) {
  const [model, setModel] = useState(rule.model || 'auto');
  // Default the escalation dropdown to the recommended model when the rule has
  // none yet — Save applies it; pick "None" to keep escalation off.
  const [escalate, setEscalate] = useState(rule.escalate_model || RECOMMENDED_ESCALATE_MODEL);
  const [effort, setEffort] = useState(rule.effort || 'default');
  const [notes, setNotes] = useState(rule.notes || '');
  const [saving, setSaving] = useState(false);

  const dirty = (model === 'auto' ? null : model) !== (rule.model || null)
    || (escalate === 'none' ? null : escalate) !== (rule.escalate_model || null)
    || (effort === 'default' ? null : effort) !== (rule.effort || null)
    || (notes.trim() || null) !== (rule.notes || null);

  const save = async () => {
    setSaving(true);
    try {
      await onSave({
        model: model === 'auto' ? null : model,
        escalate_model: escalate === 'none' ? null : escalate,
        effort: effort === 'default' ? null : effort,
        notes: notes.trim() || null,
      });
    } finally { setSaving(false); }
  };

  const modelItem = (m, suffix = '') => (
    <SelectItem key={m.id} value={m.id}>
      <span className="flex flex-col">
        <span>{m.label}{suffix}</span>
        <span className="text-[11px] text-muted-foreground">
          {m.tier}{m.inPerM != null ? ` · $${m.inPerM}/$${m.outPerM} per M tok` : ''}
        </span>
      </span>
    </SelectItem>
  );

  return (
    <Card>
      <CardContent className="space-y-2 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2 font-medium"><Route className="h-4 w-4 text-muted-foreground" /> {rule.label}</div>
          <code className="rounded bg-muted px-1.5 py-0.5 text-[11px]">{rule.task_kind}</code>
        </div>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          <div>
            <Label className="text-xs">Model</Label>
            <Select value={model} onValueChange={setModel}>
              <SelectTrigger className="min-h-[44px]"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">
                  <span className="flex flex-col">
                    <span>Auto · recommended</span>
                    <span className="text-[11px] text-muted-foreground">Fast model for routine tasks, slot model for hard ones</span>
                  </span>
                </SelectItem>
                {modelOptionsWith(rule.model).map((m) => modelItem(m))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="text-xs">Escalate to (on failure / difficulty 5)</Label>
            <Select value={escalate} onValueChange={setEscalate}>
              <SelectTrigger className="min-h-[44px]"><SelectValue /></SelectTrigger>
              <SelectContent>
                {modelOptionsWith(rule.escalate_model).map((m) => modelItem(m, m.id === RECOMMENDED_ESCALATE_MODEL ? ' · recommended' : ''))}
                <SelectItem value="none">
                  <span className="flex flex-col">
                    <span>None</span>
                    <span className="text-[11px] text-muted-foreground">MOCK2_ESCALATE_MODEL env fallback, else no escalation</span>
                  </span>
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="text-xs">Reasoning effort</Label>
            <Select value={effort} onValueChange={setEffort}>
              <SelectTrigger className="min-h-[44px]"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="default">default (by difficulty)</SelectItem>
                {efforts.map((e) => <SelectItem key={e} value={e}>{e}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
        </div>
        <div>
          <Label htmlFor={`rn-${rule.task_kind}`} className="text-xs">Notes (why this rule is set this way)</Label>
          <Input id={`rn-${rule.task_kind}`} value={notes} onChange={(e) => setNotes(e.target.value)}
            placeholder="e.g. Haiku handles chores fine — 95% success over 40 runs" className="min-h-[44px]" />
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="text-[11px] text-muted-foreground">
            {rule.updated_at ? `Last tuned ${new Date(rule.updated_at).toLocaleDateString()}` : 'Seed defaults'}
          </span>
          <Button size="sm" className="min-h-[44px]" onClick={save} disabled={!dirty || saving}>
            {saving && <Loader2 className="mr-1 h-4 w-4 animate-spin" />} Save
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function SlotRow({ slot, cur, eligible, onAssign, onClear }) {
  const suggested = SLOT_SUGGESTED_MODEL[slot];
  // Default the connector to the currently-assigned one, else the only eligible
  // one (so a single-provider setup needs no picking). Default the model to the
  // current assignment, else this slot's suggestion.
  const [connectorId, setConnectorId] = useState(
    cur.connector_id ? String(cur.connector_id) : (eligible.length === 1 ? String(eligible[0].id) : ''),
  );
  const [model, setModel] = useState(cur.model || suggested || '');

  // Offer the standard models plus, if the slot already runs a custom id, that
  // id too (so the dropdown never silently drops an existing assignment).
  const options = modelOptionsWith(model);

  return (
    <Card>
      <CardContent className="space-y-2 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="font-medium">{slot}</div>
          <span className="text-xs text-muted-foreground">needs <code>{SLOT_CAP[slot]}</code></span>
        </div>
        {cur.connector_name ? (
          <p className="text-xs text-muted-foreground">Current: {cur.connector_name} · <code>{cur.model}</code></p>
        ) : <p className="text-xs text-amber-500">unassigned</p>}
        {suggested ? (
          <p className="text-xs text-muted-foreground">
            Suggested: <span className="text-foreground">{modelLabel(suggested)}</span>
            {model !== suggested ? (
              <button type="button" className="ml-1 text-primary hover:underline" onClick={() => setModel(suggested)}>use</button>
            ) : <span className="ml-1 text-emerald-500">✓</span>}
          </p>
        ) : null}
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_1fr_auto]">
          <Select value={connectorId} onValueChange={setConnectorId}>
            <SelectTrigger className="min-h-[44px]"><SelectValue placeholder={eligible.length ? 'Connector' : 'no eligible connector'} /></SelectTrigger>
            <SelectContent>{eligible.map((c) => <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>)}</SelectContent>
          </Select>
          <Select value={model} onValueChange={setModel}>
            <SelectTrigger className="min-h-[44px]"><SelectValue placeholder="Model" /></SelectTrigger>
            <SelectContent>
              {options.map((m) => (
                <SelectItem key={m.id} value={m.id}>
                  <span className="flex flex-col">
                    <span>{m.label}{m.id === suggested ? ' · suggested' : ''}</span>
                    <span className="text-[11px] text-muted-foreground">
                      {m.tier}{m.inPerM != null ? ` · $${m.inPerM}/$${m.outPerM} per M tok` : ''}
                    </span>
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="flex gap-2">
            <Button size="sm" className="min-h-[44px] flex-1" onClick={() => onAssign(slot, connectorId, (model || '').trim())}>Assign</Button>
            {cur.connector_name && <Button size="sm" variant="ghost" className="min-h-[44px]" onClick={onClear}>Clear</Button>}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
