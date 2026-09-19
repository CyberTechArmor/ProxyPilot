// The plan/confirm dialog every Storage action goes through.
//
//   step 1  POST /api/storage/plan { op, params }  → summary, warnings, the exact
//           commands, the reversal note and the sha256 plan_token.
//   step 2  the operator ticks "I have read the commands" (and types the
//           subject for destructive ops; enters the passphrase for an
//           encrypted pool) → POST /api/storage/apply with the same op/params
//           plus the token.  The backend re-plans on the live host:
//             409 { refused, plan, plan_token, commands } → the plan changed;
//                 show the new one and require a fresh confirmation.
//             500 { ok: false, failed: { id, description, error }, results }
//                 → which step failed, its stderr, and the reversal note.
//             200 { ok: true, results }  → per-step ticks, toast, refresh.
//
// The passphrase is entered on step 2 only and travels only to /apply.

import { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Loader2, Play, XCircle, RefreshCw } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { useToast } from '@/hooks/use-toast';
import { BTN, Checkbox, CopyButton, DIALOG_BODY, DIALOG_LG, Notice, fmtMs, opLabel } from './shared';

const DESTRUCTIVE_OPS = new Set(['destroy_dataset', 'zfs_rollback', 'rollback_guest_dataset', 'export_pool']);

/** Ops whose confirm step also asks the operator to type the subject name. */
export function isDestructive(req) {
  if (!req) return false;
  if (req.destructive === true) return true;
  if (DESTRUCTIVE_OPS.has(req.op)) return true;
  return req.op === 'create_zpool' && req.params?.wipe === true;
}

function errMessage(err) {
  return err instanceof ApiError ? err.message : (err?.message || 'unknown error');
}

function StepResults({ results, failed }) {
  if (!results?.length && !failed) return null;
  return (
    <ul className="space-y-1.5">
      {(results || []).map((r) => (
        <li key={r.id} className="text-sm">
          <div className="flex items-start gap-2 min-w-0">
            {r.ok ? <CheckCircle2 className="h-4 w-4 mt-0.5 text-emerald-500 shrink-0" /> : <XCircle className="h-4 w-4 mt-0.5 text-red-500 shrink-0" />}
            <span className="min-w-0 flex-1 break-words">{r.description || r.id}</span>
            <span className="text-xs text-muted-foreground font-mono shrink-0">{fmtMs(r.ms)}</span>
          </div>
          {!r.ok && (r.stderr || r.stdout) && (
            <pre className="mt-1 ml-6 text-xs font-mono bg-muted rounded p-2 overflow-x-auto whitespace-pre-wrap break-all max-h-40">{r.stderr || r.stdout}</pre>
          )}
        </li>
      ))}
      {failed && !(results || []).some((r) => r.id === failed.id) && (
        <li className="text-sm flex items-start gap-2">
          <XCircle className="h-4 w-4 mt-0.5 text-red-500 shrink-0" />
          <span className="min-w-0 break-words">{failed.description || failed.id}: {failed.error}</span>
        </li>
      )}
    </ul>
  );
}

function Commands({ plan, commands }) {
  const lines = commands || [];
  const all = lines.join('\n');
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2">
        <Label className="text-xs uppercase tracking-wide text-muted-foreground">Commands ({lines.length})</Label>
        <CopyButton text={all} label="Copy all" />
      </div>
      <div className="rounded border bg-muted/60 divide-y overflow-hidden">
        {lines.map((cmd, i) => {
          const step = plan?.steps?.[i];
          return (
            <div key={step?.id || i} className="p-2 text-xs">
              {step?.description && (
                <div className="text-muted-foreground mb-1 break-words">
                  # {step.description}{step.kind === 'verify' ? ' (verify)' : ''}{step.ignore_failure ? ' (failure ignored)' : ''}
                </div>
              )}
              <div className="flex items-start gap-1">
                <code className="font-mono flex-1 min-w-0 whitespace-pre-wrap break-all">{cmd}</code>
                <CopyButton text={cmd} label="Copy" className="h-9 w-9 p-0 shrink-0 -my-1" />
              </div>
            </div>
          );
        })}
        {!lines.length && <div className="p-2 text-xs text-muted-foreground">No commands (nothing to run).</div>}
      </div>
    </div>
  );
}

/**
 * <PlanDialog request={{ op, params, title?, destructive? }} onClose onDone />
 * `request` null closes the dialog. onDone(result) fires after a successful apply.
 */
export default function PlanDialog({ request, onClose, onDone }) {
  const { toast } = useToast();
  const [phase, setPhase] = useState('planning'); // planning | plan_error | ready | running | done | failed
  const [plan, setPlan] = useState(null);
  const [token, setToken] = useState(null);
  const [commands, setCommands] = useState([]);
  const [error, setError] = useState(null);
  const [changed, setChanged] = useState(false);
  const [ack, setAck] = useState(false);
  const [typed, setTyped] = useState('');
  const [pass, setPass] = useState('');
  const [pass2, setPass2] = useState('');
  const [result, setResult] = useState(null);

  const open = !!request;
  const destructive = isDestructive(request);
  const needsPassphrase = !!plan?.steps?.some((s) => s.stdin === 'passphrase');

  const runPlan = async () => {
    setPhase('planning'); setError(null); setPlan(null); setToken(null); setCommands([]); setAck(false); setTyped(''); setResult(null);
    try {
      const r = await api.storage.plan(request.op, request.params || {});
      setPlan(r.plan); setToken(r.plan_token); setCommands(r.commands || []); setPhase('ready');
    } catch (err) {
      setError(errMessage(err)); setPhase('plan_error');
    }
  };

  useEffect(() => {
    if (!request) return;
    setChanged(false); setPass(''); setPass2('');
    runPlan();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request]);

  const subjectOk = !destructive || (plan?.subject && typed.trim() === plan.subject);
  const passOk = !needsPassphrase || (pass.length >= 8 && pass === pass2);
  const canRun = phase === 'ready' && ack && subjectOk && passOk && !!token;

  const apply = async () => {
    if (!canRun) return;
    setPhase('running'); setError(null);
    try {
      const r = await api.storage.apply(request.op, request.params || {}, token, needsPassphrase ? { passphrase: pass } : {});
      setResult(r); setPhase('done'); setPass(''); setPass2('');
      toast({ title: `${opLabel(request.op)}: done`, description: r.plan?.summary || r.subject });
      onDone?.(r);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && err.refused) {
        // The host state or the parameters changed since the plan was shown.
        if (err.plan) { setPlan(err.plan); setToken(err.plan_token || null); setCommands(err.commands || []); }
        setChanged(true); setAck(false); setTyped('');
        setError(err.message); setPhase(err.plan ? 'ready' : 'plan_error');
        return;
      }
      if (err instanceof ApiError && err.status === 500 && err.failed) {
        setResult({ results: err.results || [], failed: err.failed, plan: err.plan || plan });
        setError(`${err.failed.description || err.failed.id}: ${err.failed.error}`);
        setPhase('failed');
        toast({ title: `${opLabel(request.op)} failed`, description: err.failed.error, variant: 'destructive' });
        onDone?.(null); // state on the host may have partially changed → refresh
        return;
      }
      setError(errMessage(err)); setPhase('ready');
    }
  };

  const close = () => { if (phase !== 'running') onClose?.(); };
  const title = request?.title || (request ? opLabel(request.op) : '');

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) close(); }}>
      <DialogContent className={DIALOG_LG}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 pr-6">
            {destructive && <AlertTriangle className="h-5 w-5 text-red-500 shrink-0" />}
            <span className="truncate">{title}</span>
          </DialogTitle>
          {plan?.subject && (
            <DialogDescription className="font-mono text-xs break-all text-left">{plan.subject}</DialogDescription>
          )}
        </DialogHeader>

        <div className={DIALOG_BODY}>
          {phase === 'planning' && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground py-6 justify-center">
              <Loader2 className="h-4 w-4 animate-spin" /> Planning on the host…
            </div>
          )}

          {phase === 'plan_error' && (
            <Notice level="error">
              <p className="font-medium">The plan was refused</p>
              <p className="break-words">{error}</p>
            </Notice>
          )}

          {changed && phase === 'ready' && (
            <Notice level="warn">
              <p className="font-medium">The plan changed since you reviewed it</p>
              <p className="break-words">{error}</p>
              <p>Read the new commands below and confirm again.</p>
            </Notice>
          )}
          {!changed && error && phase === 'ready' && <Notice level="error"><p className="break-words">{error}</p></Notice>}

          {plan && phase !== 'planning' && phase !== 'plan_error' && (
            <>
              <p className="text-sm break-words">{plan.summary}</p>

              {plan.warnings?.length > 0 && (
                <Notice level="warn">
                  {plan.warnings.map((w, i) => <p key={i} className="break-words">{w}</p>)}
                </Notice>
              )}

              <Commands plan={plan} commands={commands} />

              {plan.touches?.length > 0 && (
                <p className="text-xs text-muted-foreground break-words">Touches devices: <span className="font-mono">{plan.touches.join(', ')}</span></p>
              )}

              <div className="text-xs space-y-1">
                <div className="text-muted-foreground">Reversal</div>
                <div className="font-mono break-all bg-muted/60 rounded px-2 py-1">{plan.reversal || 'none recorded'}</div>
              </div>

              {token && (
                <div className="flex items-center gap-2 text-xs min-w-0">
                  <span className="text-muted-foreground shrink-0">Plan token</span>
                  <code className="font-mono truncate" title={token}>{token.slice(0, 16)}…</code>
                  <CopyButton text={token} label="Copy" className="h-9 w-9 p-0 shrink-0" />
                </div>
              )}

              {(phase === 'done' || phase === 'failed') && (
                <div className="space-y-2 border-t pt-3">
                  {phase === 'done'
                    ? <p className="text-sm font-medium text-emerald-500 flex items-center gap-2"><CheckCircle2 className="h-4 w-4" /> Completed{result?.stamp ? ` (stamp ${result.stamp})` : ''}</p>
                    : (
                      <Notice level="error">
                        <p className="font-medium">Step {result?.failed?.id} failed: {result?.failed?.description}</p>
                        <p className="break-words font-mono text-xs">{result?.failed?.error}</p>
                        <p>Later steps did not run. Reversal: <span className="font-mono">{plan.reversal || 'none recorded'}</span></p>
                      </Notice>
                    )}
                  <StepResults results={result?.results} failed={phase === 'failed' ? result?.failed : null} />
                </div>
              )}

              {(phase === 'ready' || phase === 'running') && (
                <div className="space-y-2 border-t pt-3">
                  {needsPassphrase && (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div className="space-y-1">
                        <Label htmlFor="pp-pass">Encryption passphrase</Label>
                        <Input id="pp-pass" type="password" autoComplete="new-password" value={pass} onChange={(e) => setPass(e.target.value)} disabled={phase === 'running'} />
                      </div>
                      <div className="space-y-1">
                        <Label htmlFor="pp-pass2">Confirm passphrase</Label>
                        <Input id="pp-pass2" type="password" autoComplete="new-password" value={pass2} onChange={(e) => setPass2(e.target.value)} disabled={phase === 'running'} />
                      </div>
                      <p className="text-xs text-muted-foreground sm:col-span-2">At least 8 characters. It is sent once, on stdin to <code>zpool create</code>, and never stored — there is no recovery if you lose it.</p>
                      {pass && pass2 && pass !== pass2 && <p className="text-xs text-red-500 sm:col-span-2">Passphrases do not match.</p>}
                    </div>
                  )}
                  {destructive && (
                    <div className="space-y-1">
                      <Label htmlFor="pp-typed">Type <span className="font-mono">{plan.subject}</span> to confirm</Label>
                      <Input id="pp-typed" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} className="font-mono" disabled={phase === 'running'} />
                    </div>
                  )}
                  <Checkbox checked={ack} onChange={setAck} disabled={phase === 'running'} label="I have read the commands above and want them run on the host." />
                </div>
              )}
            </>
          )}
        </div>

        <DialogFooter className="gap-2 pt-2 border-t">
          {phase === 'plan_error' && (
            <Button type="button" variant="outline" className={BTN} onClick={runPlan}><RefreshCw className="h-4 w-4 mr-1.5" />Plan again</Button>
          )}
          <Button type="button" variant="ghost" className={BTN} onClick={close} disabled={phase === 'running'}>
            {phase === 'done' || phase === 'failed' ? 'Close' : 'Cancel'}
          </Button>
          {(phase === 'ready' || phase === 'running') && (
            <Button type="button" variant={destructive ? 'destructive' : 'default'} className={BTN} onClick={apply} disabled={!canRun}>
              {phase === 'running' ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <Play className="h-4 w-4 mr-1.5" />}
              {phase === 'running' ? 'Running…' : 'Run'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
