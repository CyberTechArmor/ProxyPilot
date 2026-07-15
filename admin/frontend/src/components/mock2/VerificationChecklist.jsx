// VerificationChecklist — the operator hand-off for credential-gated
// integrations (pending-operator-verification, B.5).
//
// A build that wired a REAL external integration the fence cannot live-test
// (the credentials are the operator's, not the build's) completes calmly into
// pending-operator-verification. This card is the other half of that hand-off:
// it lists each outstanding live check with WHAT to supply (the declared config
// source/key), HOW to run the check, and two honest ways to report the result —
//   · "It works" — records the observed result (never a bare checkbox) and
//     advances the pending cycle to succeeded once every item is confirmed;
//   · "It failed" — records the observation and opens a REAL bug-fix build
//     carrying it (the defect is now legitimately reproducible).
// Renders nothing when no live check is outstanding.
//
// MOBILE_FIRST: single column, stacked forms, 44px touch targets; clean at 360px.

import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { useToast } from '@/hooks/use-toast';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Loader2, ShieldCheck, ShieldAlert, KeyRound, CheckCircle2, Ban, Clock } from 'lucide-react';

export default function VerificationChecklist({ projectId, canEdit, online, cycle, onRefresh }) {
  const { toast } = useToast();
  const [status, setStatus] = useState(null); // integration-status payload
  const [forms, setForms] = useState({});     // item_id -> { environment, observed }
  const [busyItem, setBusyItem] = useState(null);
  const [abandoning, setAbandoning] = useState(false);

  // Escape hatch: drop the outstanding live checks entirely. The build stays
  // deployed; this card goes away. Works even when confirm/defer error, because it
  // never writes an actor row.
  const abandonAll = async () => {
    setAbandoning(true);
    try {
      const res = await api.mock2AbandonVerification(projectId);
      toast({ title: 'Live checks dropped', description: `The build stays deployed; ${res?.abandoned_cycles?.length || 0} pending check group(s) were abandoned.` });
      await load();
      if (onRefresh) onRefresh();
    } catch (err) {
      toast({ variant: 'destructive', title: 'Could not abandon', description: err.message });
    } finally { setAbandoning(false); }
  };

  const load = useCallback(async () => {
    try { setStatus(await api.mock2GetIntegrationStatus(projectId)); }
    catch (err) { if (!(err instanceof ApiError)) console.error('load integration status failed:', err); }
  }, [projectId]);

  // Refresh whenever the cycle changes state — a fresh pending checklist or an
  // advance to succeeded both surface through the same status endpoint.
  useEffect(() => { load(); }, [load, cycle?.id, cycle?.status, cycle?.verification_state]);

  const outstanding = status?.outstanding_checks || [];
  if (!outstanding.length) return null;

  const form = (id) => forms[id] || { environment: 'production', observed: '' };
  const setForm = (id, patch) => setForms((f) => ({ ...f, [id]: { ...form(id), ...patch } }));

  const confirm = async (item) => {
    const f = form(item.item_id);
    if (!f.observed.trim()) { toast({ variant: 'destructive', title: 'Record what you observed', description: 'A bare checkbox is not evidence — note the status, sample volume, or behavior you saw.' }); return; }
    setBusyItem(item.item_id);
    try {
      const res = await api.mock2VerifyCapabilityCheck(projectId, {
        item_id: item.item_id, environment: f.environment.trim() || 'production', observed_result: f.observed.trim(),
      });
      toast({
        title: 'Live check confirmed',
        description: res.production_ready ? 'All live checks are confirmed — the build is fully verified.' : `${res.outstanding_checks?.length || 0} check(s) still outstanding.`,
      });
      await load();
      if (onRefresh) onRefresh();
    } catch (err) {
      toast({ variant: 'destructive', title: 'Could not record the confirmation', description: err.message });
    } finally { setBusyItem(null); }
  };

  const reportFailure = async (item) => {
    const f = form(item.item_id);
    if (!f.observed.trim()) { toast({ variant: 'destructive', title: 'Describe the failure', description: 'The bug-fix build reproduces YOUR observation — include the error message or behavior you saw.' }); return; }
    setBusyItem(item.item_id);
    try {
      const res = await api.mock2ReportCapabilityFailure(projectId, {
        item_id: item.item_id, environment: f.environment.trim() || 'production', observed_result: f.observed.trim(),
      });
      toast({
        title: 'Failure recorded',
        description: res.bugfix?.status === 'started' || res.bugfix?.cycle
          ? 'A bug-fix build was opened with your observation — watch the build panel.'
          : `Recorded. ${res.bugfix?.error ? `Bug-fix build did not start: ${res.bugfix.error}` : ''}`,
      });
      await load();
      if (onRefresh) onRefresh();
    } catch (err) {
      toast({ variant: 'destructive', title: 'Could not report the failure', description: err.message });
    } finally { setBusyItem(null); }
  };

  // Defer: the operator can't run this live check in this environment right now
  // (no route to the endpoint, the app isn't deployed/reachable, no credentials).
  // Records an honest note (reusing the observation field as the reason) and leaves
  // the build calmly pending — no false confirm, no bug-fix build.
  const deferCheck = async (item) => {
    const f = form(item.item_id);
    const reason = f.observed.trim() || 'Operator cannot verify in this environment right now (no access to the live endpoint / app not deployed).';
    setBusyItem(item.item_id);
    try {
      const res = await api.mock2DeferCapabilityCheck(projectId, { item_id: item.item_id, reason });
      toast({ title: 'Deferred — left pending', description: res?.note || 'The build stays pending your live verification; nothing else is required.' });
      await load();
      if (onRefresh) onRefresh();
    } catch (err) {
      toast({ variant: 'destructive', title: 'Could not defer the check', description: err.message });
    } finally { setBusyItem(null); }
  };

  return (
    <Card className="border-sky-500/30">
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-sky-500" /> Live verification — over to you
        </CardTitle>
        <CardDescription>
          The build is <span className="font-medium">complete and deployed</span> — it wired {outstanding.length === 1 ? 'an integration' : `${outstanding.length} integrations`} with real
          transport code and verified everything checkable inside the fence. This is a calm, non-blocking state: the remaining live
          check{outstanding.length === 1 ? ' needs' : 's need'} real credentials/network only you have. Run {outstanding.length === 1 ? 'it' : 'each'} against the real
          system when you can and report what you observe — or, if you can't test it yet (the app isn't reachable from here, no
          credentials), choose <span className="font-medium">Can't verify now</span> and it stays pending. Nothing here is required to proceed.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {outstanding.map((item) => {
          const f = form(item.item_id);
          const busy = busyItem === item.item_id;
          return (
            <div key={item.item_id} className="rounded-md border bg-sky-500/5 p-3 space-y-2">
              <p className="text-sm font-medium break-words">
                {item.subsystem ? `${item.subsystem} · ` : ''}{item.action || item.item_id}
                {item.stale_verification ? <span className="ml-2 rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-600">changed — re-verify</span> : null}
              </p>
              <p className="text-xs text-muted-foreground break-words">{item.description}</p>
              {item.required_config?.key ? (
                <p className="text-xs break-words flex items-start gap-1.5">
                  <KeyRound className="h-3.5 w-3.5 mt-0.5 shrink-0 text-muted-foreground" />
                  <span>
                    <span className="font-medium">Supply:</span>{' '}
                    <code className="break-all">{item.required_config.key}</code>
                    {item.required_config.source && item.required_config.source !== 'unknown' ? <span className="text-muted-foreground"> (from {item.required_config.source})</span> : null}
                    {' '}— {item.required_config.note || 'the build container never held the real value.'}
                  </span>
                </p>
              ) : null}
              {item.how_to_verify ? <p className="text-xs text-muted-foreground break-words">{item.how_to_verify}</p> : null}

              {canEdit && online ? (
                <div className="space-y-2 pt-1">
                  <div className="flex flex-col sm:flex-row gap-2">
                    <input
                      className="flex h-11 sm:h-9 w-full sm:w-40 rounded-md border border-input bg-transparent px-3 text-xs shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-60"
                      placeholder="Environment (production)"
                      value={f.environment}
                      disabled={busy}
                      onChange={(e) => setForm(item.item_id, { environment: e.target.value })}
                    />
                    <textarea
                      className="flex min-h-[44px] flex-1 rounded-md border border-input bg-transparent px-3 py-2 text-xs shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-60"
                      placeholder="What you observed — e.g. “bind OK as svc-proxypilot, search returned 42 users” or the exact error…"
                      value={f.observed}
                      disabled={busy}
                      onChange={(e) => setForm(item.item_id, { observed: e.target.value })}
                    />
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" className="h-11 sm:h-9" disabled={busy || !f.observed.trim()} onClick={() => confirm(item)}>
                      {busy ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <CheckCircle2 className="h-4 w-4 mr-1" />}
                      It works — confirm
                    </Button>
                    <Button variant="outline" size="sm" className="h-11 sm:h-9 text-red-500" disabled={busy || !f.observed.trim()} onClick={() => reportFailure(item)}>
                      <Ban className="h-4 w-4 mr-1" />
                      It failed — open a bug-fix build
                    </Button>
                    <Button variant="ghost" size="sm" className="h-11 sm:h-9" disabled={busy}
                      title="Can't verify this right now (no access to the endpoint, the app isn't deployed/reachable, no credentials). Records a note and leaves the build calmly pending — nothing false, no bug-fix build."
                      onClick={() => deferCheck(item)}>
                      <Clock className="h-4 w-4 mr-1" />
                      Can't verify now
                    </Button>
                  </div>
                </div>
              ) : (
                <p className="text-[11px] text-muted-foreground flex items-center gap-1">
                  <ShieldAlert className="h-3.5 w-3.5" /> An editor runs the live check and reports the result here.
                </p>
              )}
            </div>
          );
        })}
        <p className="text-[11px] text-muted-foreground">
          Confirming records your observed result (append-only evidence, never a checkbox) and marks the build fully
          verified once every check clears. Reporting a failure opens a real bug-fix build carrying your observation.
        </p>
        {canEdit ? (
          <div className="flex items-center justify-between gap-2 border-t pt-3">
            <p className="text-[11px] text-muted-foreground">
              Can’t deal with this now? Drop the live checks entirely — the build stays deployed.
            </p>
            <Button variant="ghost" size="sm" className="h-9 text-red-500 shrink-0" disabled={abandoning}
              title="Abandon the outstanding live verification. The build stays deployed; these checks are dropped and this card goes away."
              onClick={abandonAll}>
              {abandoning ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Ban className="h-4 w-4 mr-1" />}
              Abandon — drop live checks
            </Button>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
