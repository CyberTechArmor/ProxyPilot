// DeployButton — "is the app actually live, and make it live".
//
// WHY (operator report): "the app did not work until redeployed". A build can
// close clean, pass every gate, and leave nothing serving — a held deploy, a
// crashed unit, a port taken. The platform now checks and self-heals after every
// build, but the operator still needs to be able to ASK, and to fix it without
// hunting through Build history for a cycle to retry (the cycle-bound retry is
// useless when the last build is old, or when there is no build at all).
//
// Two states, one control:
//   live         → "Live", the button says Deploy and only deploys if asked.
//   not serving  → "Not answering" in destructive colours; Deploy is the fix.
//
// MOBILE_FIRST: 44px target in the `full` variant (phone), a compact 32px
// toolbar button on md+ where it sits in a dense top bar next to other h-8
// controls. Nothing here has a fixed width; the label collapses to the icon at
// the narrowest sizes.

import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { useToast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { Rocket, Loader2, CheckCircle2, AlertCircle } from 'lucide-react';

const POLL_MS = 20000;

export default function DeployButton({ projectId, online, canEdit, variant = 'compact', onDeployed = null }) {
  const { toast } = useToast();
  const [serving, setServing] = useState(null); // null = not checked yet
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const probe = useCallback(async () => {
    if (!online) { setServing(null); return; }
    try {
      const r = await api.mock2Serving(projectId);
      if (alive.current) setServing(!!r.serving);
    } catch { /* transient — keep the last known answer rather than flapping */ }
  }, [projectId, online]);

  useEffect(() => { probe(); }, [probe]);
  useEffect(() => {
    if (!online) return undefined;
    const t = setInterval(probe, POLL_MS);
    return () => clearInterval(t);
  }, [online, probe]);

  const deploy = async () => {
    setBusy(true);
    try {
      // force only when the app already answers: the operator is then saying
      // "it responds but it is stale", which a probe can never detect.
      const r = await api.mock2Deploy(projectId, { force: serving === true });
      if (alive.current) setServing(!!r.serving);
      toast({
        variant: r.ok ? undefined : 'destructive',
        title: r.ok ? 'The app is live' : 'The deploy did not bring the app up',
        description: r.message,
      });
      onDeployed?.(r);
    } catch (err) {
      toast({ variant: 'destructive', title: 'Could not deploy', description: err.message });
    } finally {
      if (alive.current) setBusy(false);
      probe();
    }
  };

  if (!online) return null;

  const down = serving === false;
  const full = variant === 'full';
  const label = busy ? 'Deploying…' : (down ? 'Deploy — the app is not answering' : 'Deploy');

  return (
    <div className={`flex items-center gap-2 ${full ? 'flex-wrap' : ''}`}>
      {serving !== null ? (
        <span
          className={`inline-flex items-center gap-1 text-xs ${down ? 'text-destructive' : 'text-muted-foreground'}`}
          title={down ? 'The app is not answering on its port' : 'The app is answering'}
        >
          {down ? <AlertCircle className="h-3.5 w-3.5" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
          {down ? 'Not answering' : 'Live'}
        </span>
      ) : null}
      {canEdit ? (
        <Button
          size={full ? 'default' : 'sm'}
          variant={down ? 'default' : 'outline'}
          className={full ? 'min-h-[44px]' : 'h-8'}
          disabled={busy}
          onClick={deploy}
          title={serving === true
            ? 'Deploy the current checkpoint again (install → migrate → build → start)'
            : 'Deploy the app'}
        >
          {busy ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <Rocket className="h-3.5 w-3.5 mr-1" />}
          {full ? label : (busy ? 'Deploying…' : 'Deploy')}
        </Button>
      ) : null}
    </div>
  );
}
