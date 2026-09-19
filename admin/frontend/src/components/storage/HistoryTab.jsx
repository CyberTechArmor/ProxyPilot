// Storage → History: the storage_ops ledger (service.listOps): every
// plan/apply with its outcome; expand a row for the plan summary, the
// commands (rendered from the recorded plan's argv) and the failure detail.

import { useState } from 'react';
import { ChevronDown, ChevronRight, History, Loader2 } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { BTN, Chip, EmptyState, OutcomeChip, SectionHeader, fmtDate, fmtMs, opLabel, shellQuote } from './shared';

function OpRow({ o }) {
  const [open, setOpen] = useState(false);
  const plan = o.plan;
  const commands = (plan?.steps || []).map((s) => shellQuote(s.argv));
  return (
    <div className="border rounded-lg">
      <button type="button" className="w-full text-left p-3 flex items-start gap-2 min-h-[44px]" onClick={() => setOpen((s) => !s)} aria-expanded={open}>
        {open ? <ChevronDown className="h-4 w-4 mt-0.5 shrink-0 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 mt-0.5 shrink-0 text-muted-foreground" />}
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">{opLabel(o.op)}</span>
            <OutcomeChip outcome={o.outcome} />
            {o.subject && <span className="font-mono text-xs break-all">{o.subject}</span>}
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span>{fmtDate(o.ts)}</span>
            <span>{o.actor ? `user #${o.actor}` : 'system'}</span>
            {o.via && <Chip>{o.via}</Chip>}
            {o.duration_ms != null && <span className="font-mono">{fmtMs(o.duration_ms)}</span>}
          </div>
        </div>
      </button>
      {open && (
        <div className="px-3 pb-3 pl-9 space-y-2 text-xs">
          {plan?.summary && <p className="break-words">{plan.summary}</p>}
          {o.detail?.error && <p className="text-red-500 break-words">{o.detail.error}</p>}
          {o.detail?.failed && <p className="text-red-500 break-words">Failed at {o.detail.failed.id} ({o.detail.failed.description}): {o.detail.failed.error}</p>}
          {plan?.warnings?.length > 0 && <ul className="text-amber-500 list-disc pl-4">{plan.warnings.map((w, i) => <li key={i} className="break-words">{w}</li>)}</ul>}
          {commands.length > 0 && (
            <div className="rounded border bg-muted/60 divide-y">
              {commands.map((c, i) => {
                const st = o.detail?.steps?.find((s) => s.id === plan.steps[i]?.id);
                return (
                  <div key={i} className="p-2 flex items-start gap-2">
                    {st && <span className={st.ok ? 'text-emerald-500' : 'text-red-500'}>{st.ok ? '✓' : '✗'}</span>}
                    <code className="font-mono whitespace-pre-wrap break-all min-w-0">{c}</code>
                  </div>
                );
              })}
            </div>
          )}
          {plan?.reversal && <p className="text-muted-foreground break-words">Reversal: <span className="font-mono">{plan.reversal}</span></p>}
          {o.plan_token && <p className="text-muted-foreground font-mono break-all">token {o.plan_token}</p>}
        </div>
      )}
    </div>
  );
}

export default function HistoryTab({ data }) {
  const [rows, setRows] = useState(null); // null = use overview's ops
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const ops = rows || data?.ops || [];
  const loadMore = async () => {
    setLoading(true); setError(null);
    try { const r = await api.storage.ops({ limit: 500 }); setRows(r.ops || []); } catch (err) { setError(err instanceof ApiError ? err.message : (err?.message || 'failed to load')); } finally { setLoading(false); }
  };
  return (
    <div className="space-y-4">
      <SectionHeader title="History" description="Every storage plan that was applied (or refused) through the dashboard, the MCP tools or the API.">
        {!rows && <Button variant="outline" size="sm" className={BTN} onClick={loadMore} disabled={loading}>{loading ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <History className="h-4 w-4 mr-1.5" />}Load full ledger</Button>}
      </SectionHeader>
      {error && <p className="text-sm text-red-500">{error}</p>}
      {!ops.length ? <EmptyState icon={History} title="No storage operations recorded yet" /> : (
        <div className="space-y-2">{ops.map((o) => <OpRow key={o.id ?? `${o.ts}-${o.op}`} o={o} />)}</div>
      )}
    </div>
  );
}
