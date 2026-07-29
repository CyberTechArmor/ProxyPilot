// THE RULES THIS APP IS BUILT AGAINST — the read side sign-off #2 never had.
//
// The audit raises rule questions, the editor taps an answer, and it is
// committed to state/rules.md with a hash-chained change record. That is the
// second of the two human approvals that gate all code — and from the moment
// it was given, the only way to read it back was a terminal into the
// container. The stage indicator drew "Define" the whole time.
//
// TWO SECTIONS, NEVER ONE LIST. A confirmed rule is a person signing off on a
// decision about their domain; a baseline rule is a default the platform
// applies to every build. Merging them would make the sign-off look like a
// setting. Confirmed comes first even when empty, because its emptiness is the
// thing worth reading.
//
// MOBILE_FIRST: one column throughout, 44px targets, completes at 360px. The
// rule bodies are prose and wrap; nothing here is a table.

import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { ScrollText, Loader2, RefreshCw, CheckCircle2, Layers, AlertTriangle } from 'lucide-react';

function RuleRow({ rule }) {
  const confirmed = rule.origin === 'confirmed';
  return (
    <li className="rounded-md border bg-background/60 p-3">
      <div className="flex items-start gap-2">
        {confirmed
          ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
          : <Layers className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />}
        <div className="min-w-0 flex-1">
          {/* The QUESTION is the heading for a confirmed rule: it is what the
              operator was actually asked, and reading the answer without it is
              how a rule gets misremembered. */}
          {confirmed && rule.question ? (
            <p className="text-sm font-medium leading-snug break-words">{rule.question}</p>
          ) : null}
          <p className={`text-sm leading-snug break-words ${confirmed && rule.question ? 'mt-1 text-muted-foreground' : ''}`}>
            {rule.answer || <span className="italic text-muted-foreground">No answer recorded — this section was written by hand.</span>}
          </p>
        </div>
      </div>
    </li>
  );
}

export default function ProjectRules({ projectId }) {
  const [state, setState] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try { setState(await api.mock2Rules(projectId)); }
    catch (err) { setError(err.message); }
    finally { setLoading(false); }
  }, [projectId]);

  useEffect(() => { load(); }, [load]);

  const confirmed = state?.confirmed || [];
  const baseline = state?.baseline || [];

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-base flex items-center gap-2">
            <ScrollText className="h-4 w-4" /> Rules
          </CardTitle>
          <Button
            type="button" variant="outline" size="sm" className="h-11 sm:h-8"
            onClick={load} disabled={loading}
            title="Re-read state/rules.md from the container"
          >
            {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin sm:mr-1" /> : <RefreshCw className="h-3.5 w-3.5 sm:mr-1" />}
            <span className="hidden sm:inline">Refresh</span>
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          What every build for this project has to honour.
        </p>
      </CardHeader>

      <CardContent className="space-y-4">
        {error ? (
          <p className="text-sm text-destructive">{error}</p>
        ) : null}

        {/* An unreachable container is NOT "no rules". Saying nothing here
            would let a stopped project read as a project with no rules. */}
        {state && !state.reachable ? (
          <p className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            <span>
              The project is not running, so <code className="text-xs">{state.path}</code> could not be read.
              Confirmed rules may exist. The baseline below applies regardless.
            </span>
          </p>
        ) : null}

        <section>
          <h3 className="mb-2 text-sm font-semibold">
            Confirmed{confirmed.length ? ` (${confirmed.length})` : ''}
          </h3>
          {confirmed.length ? (
            <ul className="space-y-2">
              {confirmed.map((r) => <RuleRow key={r.anchor || r.heading} rule={r} />)}
            </ul>
          ) : (
            <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
              {state?.emptyMessage || 'No rules confirmed yet.'}
            </p>
          )}
        </section>

        <section>
          <h3 className="mb-1 text-sm font-semibold">
            Baseline{baseline.length ? ` (${baseline.length})` : ''}
          </h3>
          <p className="mb-2 text-xs text-muted-foreground">
            Applied to every build, whether or not the audit ran.
          </p>
          <ul className="space-y-2">
            {baseline.map((r) => <RuleRow key={r.anchor} rule={r} />)}
          </ul>
        </section>
      </CardContent>
    </Card>
  );
}
