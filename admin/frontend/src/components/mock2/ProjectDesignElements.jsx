// New elements — the approved design's growth path.
//
// state/design.css is generated from the approved mockup, and everything
// downstream judges the app against it: the adherence gate counts the mockup's
// class names in the built markup, the review compares screens to the same
// contract. That vocabulary is frozen at the moment the operator has seen the
// least — one mockup, before a single screen was used for anything.
//
// So a screen invented in build six had no approved classes by construction:
// the build that thought of a better element measured worse than the build that
// traced, and nothing could ever change that. This panel is the mechanism that
// can. Accepting an element appends it to the approved design, after which
// later builds inherit it and the adherence check counts it.
//
// Token-clean elements are offered first and plainly; ones with the colours
// typed in are shown with the reason, because promoting those would make the
// drift permanent — the whole point of an approved variable is that re-valuing
// the design re-values everything built on it.
//
// MOBILE_FIRST: one column throughout, 44px targets, completes at 360px.

import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useToast } from '@/hooks/use-toast';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Sparkles, Loader2, RefreshCw, Check, AlertTriangle } from 'lucide-react';

export default function ProjectDesignElements({ projectId, canEdit = false }) {
  const { toast } = useToast();
  const [state, setState] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [chosen, setChosen] = useState(() => new Set());
  const [error, setError] = useState('');
  const [open, setOpen] = useState(() => new Set());

  const load = useCallback(async () => {
    setLoading(true);
    try { setState(await api.mock2DesignElements(projectId)); }
    catch { setState(null); }
    finally { setLoading(false); }
  }, [projectId]);

  useEffect(() => { load(); }, [load]);

  const toggle = (set, name) => {
    const next = new Set(set);
    if (next.has(name)) next.delete(name); else next.add(name);
    return next;
  };

  const promote = async () => {
    setError('');
    setBusy(true);
    try {
      const res = await api.mock2PromoteDesignElements(projectId, [...chosen]);
      setChosen(new Set());
      await load();
      toast({
        title: `Promoted ${res.promoted?.length || 0} element${res.promoted?.length === 1 ? '' : 's'}`,
        description: 'They are part of the approved design now — later builds inherit them.',
      });
    } catch (err) {
      setError(String(err?.message || err));
    } finally {
      setBusy(false);
    }
  };

  const candidates = state?.candidates || [];
  const promoted = state?.promoted || [];
  const clean = candidates.filter((c) => c.tokenClean);
  const drifting = candidates.filter((c) => !c.tokenClean);

  const row = (c) => (
    <li key={c.name} className="rounded-md border p-3">
      <div className="flex flex-wrap items-start gap-3">
        {/* Native checkbox: the kit has no Checkbox primitive, and a 44px
            touch wrapper around a 20px control satisfies MOBILE_FIRST without
            inventing one for a single panel. */}
        {canEdit && c.tokenClean ? (
          <span className="flex min-h-[44px] min-w-[44px] items-center justify-center">
            <input
              type="checkbox"
              id={`el-${c.name}`}
              className="h-5 w-5 accent-current"
              checked={chosen.has(c.name)}
              onChange={() => setChosen((s) => toggle(s, c.name))}
            />
          </span>
        ) : null}
        <div className="min-w-0 flex-1">
          <label htmlFor={`el-${c.name}`} className="block cursor-pointer break-all font-mono text-sm font-medium">
            .{c.name}
          </label>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {c.ruleCount} rule{c.ruleCount === 1 ? '' : 's'} · {c.chars} chars
            {c.responsive ? ' · has responsive rules' : ''}
            {c.tokenClean
              ? ' · built from the approved variables'
              : ` · ${c.hardcodedColors.length} hardcoded colour${c.hardcodedColors.length === 1 ? '' : 's'}`}
          </p>
          {!c.tokenClean ? (
            <p className="mt-1 text-xs text-amber-500">
              <AlertTriangle className="mr-1 inline h-3.5 w-3.5" />
              Promoting this would make the hardcoded colours part of the design, so it would stop following the
              theme. Ask the next build to rewrite it on <code>var(--…)</code> first.
            </p>
          ) : null}
          <Button
            variant="ghost" size="sm" className="mt-1 h-auto min-h-[44px] px-0 text-xs"
            onClick={() => setOpen((s) => toggle(s, c.name))}
          >
            {open.has(c.name) ? 'Hide CSS' : 'Show CSS'}
          </Button>
          {open.has(c.name) ? (
            <pre className="mt-1 max-h-64 overflow-auto rounded bg-muted p-2 text-xs">
              <code>{c.css}</code>
            </pre>
          ) : null}
        </div>
      </div>
    </li>
  );

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
        <CardTitle className="flex items-center gap-2 text-base">
          <Sparkles className="h-4 w-4" /> New elements
        </CardTitle>
        <Button variant="ghost" size="sm" className="min-h-[44px]" onClick={load} disabled={loading}>
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          <span className="sr-only">Refresh</span>
        </Button>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        {loading && !state ? (
          <p className="text-muted-foreground">Looking at what the build designed…</p>
        ) : (
          <>
            <p className="text-muted-foreground">
              {state?.reason
                || (candidates.length
                  ? 'Elements the builds designed that the approved mockup does not have. Promote the ones worth keeping and they become part of the design — later builds inherit them, and the adherence check counts them instead of marking them as invented.'
                  : 'The builds have not designed anything the approved design does not already have.')}
            </p>

            {promoted.length ? (
              <p className="text-xs text-muted-foreground">
                <Check className="mr-1 inline h-3.5 w-3.5 text-emerald-500" />
                Already part of the design: {promoted.map((n) => `.${n}`).join(', ')}
              </p>
            ) : null}

            {clean.length ? <ul className="space-y-2">{clean.map(row)}</ul> : null}

            {clean.length && canEdit ? (
              <div className="space-y-2 border-t pt-4">
                {error ? <p className="text-sm text-red-500">{error}</p> : null}
                <Button
                  onClick={promote} disabled={busy || !chosen.size}
                  className="min-h-[44px] w-full sm:w-auto"
                >
                  {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                  Promote {chosen.size || ''} into the design
                </Button>
              </div>
            ) : null}

            {drifting.length ? (
              <div className="space-y-2 border-t pt-4">
                <p className="text-xs text-muted-foreground">
                  Not offered — these were built beside the design system rather than out of it:
                </p>
                <ul className="space-y-2">{drifting.map(row)}</ul>
              </div>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}
