// Mock2 quotas admin surface (Phase M5, ADR-003 / risk R5).
//
// Admins set spend budgets (per period, global or per-project) plus self-hosted
// caps (wall-clock, concurrent cycles) and a reservation buffer%. The M6 cycle
// runner enforces these via the pure canStartCycle gate; this page just manages
// the budgets and shows live spend from the ledger.
//
// Reachable only when Mock2 is enabled (ADR-001). MOBILE_FIRST: single column,
// stacked cards, 44px targets, full-screen-on-<sm dialog.

import { useEffect, useState, useCallback } from 'react';
import { Navigate, Link } from 'react-router-dom';
import { useAuth } from '@/context/AuthContext';
import { api, ApiError } from '@/lib/api';
import { useToast } from '@/hooks/use-toast';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ArrowLeft, Loader2, Plus, Trash2, Wallet } from 'lucide-react';

const dollars = (cents) => cents == null ? '—' : `$${(cents / 100).toFixed(2)}`;

export default function Quotas() {
  const { user } = useAuth();
  const storedUser = JSON.parse(localStorage.getItem('user') || '{}');
  const isAdmin = user?.role === 'admin' || storedUser?.role === 'admin';
  const { toast } = useToast();

  const [gate, setGate] = useState('checking');
  const [quotas, setQuotas] = useState([]);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState(null);
  const [form, setForm] = useState({ scope: 'global', project_id: '', period: 'monthly', budget_dollars: '', budget_wall_clock_min: '', max_concurrent_cycles: '', buffer_pct: '15' });

  const load = useCallback(async () => {
    try { const r = await api.mock2ListQuotas(); setQuotas(r.quotas || []); }
    catch (err) { if (!(err instanceof ApiError)) console.error('load quotas failed:', err); }
  }, []);

  useEffect(() => {
    let cancelled = false;
    api.mock2Status()
      .then(() => { if (!cancelled) { setGate('enabled'); load(); } })
      .catch((err) => { if (!cancelled) setGate('disabled'); if (!(err instanceof ApiError)) console.error(err); });
    return () => { cancelled = true; };
  }, [load]);

  const save = async () => {
    setSaving(true);
    try {
      const body = {
        scope: form.scope, period: form.period,
        project_id: form.scope === 'project' ? Number(form.project_id) : undefined,
        budget_cents: form.budget_dollars === '' ? null : Math.round(Number(form.budget_dollars) * 100),
        budget_wall_clock_min: form.budget_wall_clock_min === '' ? null : Number(form.budget_wall_clock_min),
        max_concurrent_cycles: form.max_concurrent_cycles === '' ? null : Number(form.max_concurrent_cycles),
        buffer_pct: form.buffer_pct === '' ? 15 : Number(form.buffer_pct),
      };
      if (body.scope === 'project' && !body.project_id) { toast({ variant: 'destructive', title: 'Project id is required' }); setSaving(false); return; }
      await api.mock2SetQuota(body);
      setOpen(false); await load(); toast({ title: 'Quota saved' });
    } catch (err) { toast({ variant: 'destructive', title: 'Could not save quota', description: err.message }); }
    finally { setSaving(false); }
  };

  const remove = async (id) => {
    setBusyId(id);
    try { await api.mock2DeleteQuota(id); await load(); toast({ title: 'Quota removed' }); }
    catch (err) { toast({ variant: 'destructive', title: 'Delete failed', description: err.message }); }
    finally { setBusyId(null); }
  };

  if (gate === 'checking') return <div className="flex items-center justify-center p-12"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>;
  if (gate === 'disabled' || !isAdmin) return <Navigate to="/" replace />;

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-4 sm:p-6">
      <div className="space-y-1">
        <Link to="/projects" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="h-4 w-4" /> Flightdeck</Link>
        <h1 className="flex items-center gap-2 text-2xl font-semibold"><Wallet className="h-6 w-6" /> Quotas</h1>
        <p className="text-sm text-muted-foreground">Spend budgets and self-hosted caps. A cycle is refused before it starts if its buffered estimate exceeds the remaining budget (enforced in M6).</p>
      </div>

      <div className="flex justify-end">
        <Button onClick={() => setOpen(true)} className="min-h-[44px]"><Plus className="mr-1 h-4 w-4" /> Set quota</Button>
      </div>

      {quotas.length === 0 && <Card><CardContent className="p-6 text-center text-sm text-muted-foreground">No quotas set — cycles run without a spend cap.</CardContent></Card>}

      {quotas.map((q) => {
        const pct = q.budget_cents ? Math.min(100, Math.round((q.spent_cents / q.budget_cents) * 100)) : null;
        return (
          <Card key={q.id}>
            <CardHeader className="pb-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <CardTitle className="text-base">{q.scope === 'global' ? 'Global' : `Project #${q.project_id}`} · {q.period}</CardTitle>
                <Button variant="ghost" size="sm" className="min-h-[44px] text-red-500" disabled={busyId === q.id} onClick={() => remove(q.id)}><Trash2 className="h-4 w-4" /></Button>
              </div>
            </CardHeader>
            <CardContent className="space-y-2">
              <div className="text-sm">Budget: <strong>{dollars(q.budget_cents)}</strong> · spent this period: <strong>{dollars(q.spent_cents)}</strong> · remaining: <strong>{dollars(q.remaining_cents)}</strong></div>
              {pct != null && (
                <div className="h-2 w-full overflow-hidden rounded bg-muted">
                  <div className={`h-full ${pct >= 100 ? 'bg-red-500' : pct >= 80 ? 'bg-amber-500' : 'bg-emerald-500'}`} style={{ width: `${pct}%` }} />
                </div>
              )}
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                <span>buffer {q.buffer_pct}%</span>
                {q.max_concurrent_cycles != null && <span>max concurrent {q.max_concurrent_cycles}</span>}
                {q.budget_wall_clock_min != null && <span>wall-clock {q.budget_wall_clock_min} min</span>}
              </div>
            </CardContent>
          </Card>
        );
      })}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>Set quota</DialogTitle><DialogDescription>Upserts on scope + period. Leave a field blank for unlimited.</DialogDescription></DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Scope</Label>
              <Select value={form.scope} onValueChange={(v) => setForm({ ...form, scope: v })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="global">Global</SelectItem><SelectItem value="project">Project</SelectItem></SelectContent>
              </Select>
            </div>
            {form.scope === 'project' && (
              <div><Label htmlFor="pid">Project id</Label><Input id="pid" type="number" value={form.project_id} onChange={(e) => setForm({ ...form, project_id: e.target.value })} /></div>
            )}
            <div>
              <Label>Period</Label>
              <Select value={form.period} onValueChange={(v) => setForm({ ...form, period: v })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="monthly">Monthly</SelectItem><SelectItem value="weekly">Weekly</SelectItem></SelectContent>
              </Select>
            </div>
            <div><Label htmlFor="bd">Budget ($)</Label><Input id="bd" type="number" step="0.01" value={form.budget_dollars} onChange={(e) => setForm({ ...form, budget_dollars: e.target.value })} placeholder="e.g. 50.00" /></div>
            <div className="grid grid-cols-2 gap-3">
              <div><Label htmlFor="bp">Buffer %</Label><Input id="bp" type="number" value={form.buffer_pct} onChange={(e) => setForm({ ...form, buffer_pct: e.target.value })} /></div>
              <div><Label htmlFor="mc">Max cycles</Label><Input id="mc" type="number" value={form.max_concurrent_cycles} onChange={(e) => setForm({ ...form, max_concurrent_cycles: e.target.value })} placeholder="unlimited" /></div>
            </div>
            <div><Label htmlFor="wc">Wall-clock cap (min, self-hosted)</Label><Input id="wc" type="number" value={form.budget_wall_clock_min} onChange={(e) => setForm({ ...form, budget_wall_clock_min: e.target.value })} placeholder="unlimited" /></div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={save} disabled={saving}>{saving && <Loader2 className="mr-1 h-4 w-4 animate-spin" />} Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
