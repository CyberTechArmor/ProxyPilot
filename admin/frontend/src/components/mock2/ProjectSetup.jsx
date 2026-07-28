// Guided setup — the first-run path.
//
// Creating a project used to drop you on a page with fifteen cards and no
// direction, so the common first move was to type one sentence into the prompt
// box and hope. That sentence is the highest-leverage input in the pipeline:
// the mockup comes from it, the inventory from the mockup, the first build's
// instruction from the inventory, and both the adherence gate and the design
// review measure the app against that mockup. All of it was calibrated to a
// document written by someone who was never asked who the app is for.
//
// NOTHING HERE BLOCKS. Every step has a visible skip, and skipping all of them
// reproduces the previous behaviour exactly — which is also what the admin
// "classic" setting does globally.
//
// Every step's done-state is computed server-side from real data (an account
// the app knows about, an asset row, a file in the container, a column on the
// project). There is no progress counter to desync: close the tab at step 4 and
// it is still step 4 tomorrow, on any device.
//
// MOBILE_FIRST: one column throughout, 44px targets, completes at 360px.

import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useToast } from '@/hooks/use-toast';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Check, Circle, Loader2, Rocket, X, Clock } from 'lucide-react';

export default function ProjectSetup({ projectId, canEdit = false, onJump }) {
  const { toast } = useToast();
  const [state, setState] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState(null);

  const load = useCallback(async () => {
    try {
      const s = await api.mock2Setup(projectId);
      setState(s);
      // Only seed the draft once, or typing would be overwritten by a poll.
      setDraft((cur) => cur ?? { ...s.intake });
    } catch { setState(null); }
    finally { setLoading(false); }
  }, [projectId]);

  useEffect(() => { load(); }, [load]);

  // A step can complete somewhere else entirely — the account gets created in
  // the App access panel, the logo in Assets, the mockup in the design chat —
  // so the panel follows the project rather than waiting to be told.
  useEffect(() => {
    if (!state || state.complete || state.dismissed) return undefined;
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, [state, load]);

  const saveIntake = async () => {
    setBusy(true);
    try {
      setState(await api.mock2SaveSetupIntake(projectId, draft || {}));
      toast({
        title: 'Saved',
        description: 'These shape the first mockup, and become how the app describes itself on its sign-in screen.',
      });
    } catch (err) {
      toast({ variant: 'destructive', title: 'Could not save', description: err.message });
    } finally { setBusy(false); }
  };

  const dismiss = async () => {
    setBusy(true);
    try { setState(await api.mock2DismissSetup(projectId, true)); }
    catch (err) { toast({ variant: 'destructive', title: 'Could not dismiss', description: err.message }); }
    finally { setBusy(false); }
  };

  if (loading || !state || !state.show) return null;

  const { steps = [], progress = { done: 0, total: 0 }, current, fields = [] } = state;
  const currentStep = steps.find((s) => s.id === current);

  const icon = (s) => {
    if (s.done) return <Check className="h-4 w-4 shrink-0 text-emerald-500" />;
    if (s.blocked) return <Clock className="h-4 w-4 shrink-0 text-muted-foreground" />;
    return <Circle className="h-4 w-4 shrink-0 text-muted-foreground" />;
  };

  return (
    <Card className="border-primary/30">
      <CardHeader className="flex flex-row items-start justify-between gap-2 space-y-0 pb-3">
        <div>
          <CardTitle className="flex items-center gap-2 text-base">
            <Rocket className="h-4 w-4" /> Setting up this project
          </CardTitle>
          <p className="mt-1 text-xs text-muted-foreground">
            {progress.done} of {progress.total} done · every step is optional
          </p>
        </div>
        {canEdit ? (
          <Button variant="ghost" size="sm" className="min-h-[44px]" onClick={dismiss} disabled={busy} title="Hide this panel">
            <X className="h-4 w-4" />
            <span className="sr-only">Hide setup</span>
          </Button>
        ) : null}
      </CardHeader>

      <CardContent className="space-y-4 text-sm">
        {/* The whole list, always — being able to see what is coming is most of
            what makes a first run feel finite. */}
        <ol className="space-y-1">
          {steps.map((s) => (
            <li key={s.id} className={`flex flex-wrap items-baseline gap-2 ${s.id === current ? 'font-medium' : 'text-muted-foreground'}`}>
              {icon(s)}
              <span>{s.title}</span>
              {s.done ? null : s.detail ? <span className="text-xs text-muted-foreground">— {s.detail}</span> : null}
            </li>
          ))}
        </ol>

        {currentStep ? (
          <div className="space-y-3 border-t pt-4">
            <div>
              <p className="font-medium">{currentStep.title}</p>
              <p className="text-muted-foreground">{currentStep.blurb}</p>
            </div>

            {/* The one step that is a form. The others live where they already
                live — the App access panel, the asset library, the design chat —
                and the panel points at them rather than reimplementing them. */}
            {current === 'about' && canEdit ? (
              <form
                className="space-y-3"
                onSubmit={(e) => { e.preventDefault(); saveIntake(); }}
              >
                {fields.map((f) => (
                  <div key={f.key} className="space-y-1">
                    <label className="text-xs font-medium" htmlFor={`setup-${f.key}`}>{f.label}</label>
                    <Input
                      id={`setup-${f.key}`}
                      className="min-h-[44px]"
                      placeholder={f.placeholder}
                      value={draft?.[f.key] ?? ''}
                      maxLength={600}
                      onChange={(ev) => setDraft((d) => ({ ...d, [f.key]: ev.target.value }))}
                    />
                    <p className="text-xs text-muted-foreground">{f.hint}</p>
                  </div>
                ))}
                <Button type="submit" disabled={busy} className="min-h-[44px] w-full sm:w-auto">
                  {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                  Save and continue
                </Button>
              </form>
            ) : null}

            {current === 'account' ? (
              <p className="text-xs text-muted-foreground">
                {state.app_reachable
                  ? 'Create it in the App access panel below — it goes straight to the app, and the password is never stored here.'
                  : 'The app is not answering yet. This can be done any time before the first build.'}
              </p>
            ) : null}

            {current === 'brand' ? (
              <p className="text-xs text-muted-foreground">
                Upload it in the project’s Assets panel, tagged <strong>Logo</strong>. The mockup render actually looks at it.
              </p>
            ) : null}

            {current === 'design' && onJump ? (
              <Button variant="outline" className="min-h-[44px] w-full sm:w-auto" onClick={() => onJump('design')}>
                Open the design chat
              </Button>
            ) : null}

            {current === 'approve' ? (
              <p className="text-xs text-muted-foreground">
                Approving the mockup is what unlocks Build — it is the sign-off everything downstream is measured against.
              </p>
            ) : null}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
