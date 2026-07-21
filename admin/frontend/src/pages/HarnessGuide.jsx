// Harness — the operator's window into the build pipeline, in two tabs:
//
// CONTROLS: every model-bearing pipeline step as a row of live tunables
// (model / effort / thinking). Editing here IS an actual harness change —
// each control writes the per-step override layer, the topmost precedence
// over lane tuning, env overrides, and slots, applied on the step's very
// next model call. Source badges show where each resolved value came from;
// slot-sourced models link to Model Connectors and lane-sourced values to
// Routing (those pages keep owning their layers — this page writes only the
// step layer). Prompts are deliberately NOT editable: edited prompts
// silently break tool schemas and survive updates; prompt contracts change
// in code review, not settings.
//
// GUIDE: the full harness explanation (every step, prompt contract,
// classifier, gate). The shipped text follows upgrades; an admin can take
// the document over and reset back.
//
// MOBILE_FIRST: single column; step rows stack their controls on mobile;
// tables/code scroll inside their own containers; 44px touch targets.

import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { api, ApiError } from '@/lib/api';
import { useToast } from '@/hooks/use-toast';
import { modelOptionsWith, modelLabel } from '@/lib/model-options';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { ArrowLeft, ChevronDown, ChevronRight, Loader2, Pencil, RotateCcw, Save, X } from 'lucide-react';

const STAGE_ORDER = ['Concept', 'Define', 'Build', 'Post-build'];
const EFFORT_LABELS = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'X-High', max: 'Max' };

// Where each non-step source is owned, for the deep links next to controls.
const SOURCE_META = {
  step: { label: 'step', cls: 'border-primary/50 bg-primary/10 text-primary' },
  lane: { label: 'lane', cls: 'border-sky-500/50 bg-sky-500/10 text-sky-600 dark:text-sky-400' },
  env: { label: 'env', cls: 'border-violet-500/50 bg-violet-500/10 text-violet-600 dark:text-violet-400' },
  slot: { label: 'slot', cls: 'border-amber-500/50 bg-amber-500/10 text-amber-600 dark:text-amber-400' },
  default: { label: 'default', cls: 'border-border text-muted-foreground' },
};

function SourceBadge({ source }) {
  const meta = SOURCE_META[source] || SOURCE_META.default;
  return (
    <span className={`inline-flex items-center rounded-full border px-1.5 py-px text-[10px] font-medium ${meta.cls}`}>
      {meta.label}
    </span>
  );
}

// Document-scale markdown styling for the Guide tab (the chat Markdown
// component renders bubble-scale headings). Same XSS posture: react-markdown
// does not render raw HTML.
const docComponents = {
  h1: ({ children }) => <h1 className="mt-6 first:mt-0 mb-3 text-xl font-bold sm:text-2xl">{children}</h1>,
  h2: ({ children }) => <h2 className="mt-8 first:mt-0 mb-2 border-b pb-1 text-lg font-semibold sm:text-xl">{children}</h2>,
  h3: ({ children }) => <h3 className="mt-5 mb-1.5 text-base font-semibold sm:text-lg">{children}</h3>,
  h4: ({ children }) => <h4 className="mt-4 mb-1 text-sm font-semibold sm:text-base">{children}</h4>,
  p: ({ children }) => <p className="my-2 text-sm leading-relaxed">{children}</p>,
  ul: ({ children }) => <ul className="my-2 ml-5 list-disc space-y-1 text-sm">{children}</ul>,
  ol: ({ children }) => <ol className="my-2 ml-5 list-decimal space-y-1 text-sm">{children}</ol>,
  li: ({ children }) => <li className="break-words leading-relaxed">{children}</li>,
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noreferrer" className="underline underline-offset-2 hover:opacity-80 break-all">
      {children}
    </a>
  ),
  blockquote: ({ children }) => (
    <blockquote className="my-3 border-l-2 border-primary/50 pl-3 text-sm text-muted-foreground">{children}</blockquote>
  ),
  hr: () => <hr className="my-6 border-border" />,
  code: ({ children }) => (
    <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]">{children}</code>
  ),
  pre: ({ children }) => (
    <pre className="my-3 overflow-x-auto rounded-md border bg-muted/50 p-3 font-mono text-xs leading-relaxed [&_code]:bg-transparent [&_code]:p-0">
      {children}
    </pre>
  ),
  table: ({ children }) => (
    <div className="my-3 overflow-x-auto rounded-md border">
      <table className="w-full border-collapse text-xs sm:text-sm">{children}</table>
    </div>
  ),
  th: ({ children }) => <th className="border-b border-r last:border-r-0 bg-muted/60 px-2 py-1.5 text-left font-semibold align-bottom">{children}</th>,
  td: ({ children }) => <td className="border-b border-r last:border-r-0 px-2 py-1.5 align-top">{children}</td>,
};

// One tunable step row. The three controls write the step-override layer:
// picking a value stores an override, picking "Resolved default" clears that
// field. Saves send the FULL desired override (absent fields clear on the
// backend), so local state mirrors the stored override exactly.
function StepRow({ step, options, onSave, busy }) {
  const o = step.override || {};
  const r = step.resolved;
  const spend = step.spend7d;
  const hasOverride = !!(o.model || o.effort || o.thinking);

  const save = (patch) => {
    const next = {
      model: o.model || null, effort: o.effort || null, thinking: o.thinking || null,
      ...patch,
    };
    onSave(step.id, {
      ...(next.model ? { model: next.model } : {}),
      ...(next.effort ? { effort: next.effort } : {}),
      ...(next.thinking ? { thinking: next.thinking } : {}),
    });
  };

  return (
    <Card>
      <CardContent className="space-y-3 p-3 sm:p-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="font-medium leading-tight">
              {step.title}
              {!step.tunable && (
                <span className="ml-2 inline-flex items-center rounded-full border px-1.5 py-px text-[10px] font-medium text-muted-foreground">fixed</span>
              )}
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">{step.description}</p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <span className="rounded-md border px-2 py-1 text-[11px] tabular-nums text-muted-foreground" title="7-day spend">
              {spend ? `${(spend.cents / 100).toFixed(2)} $ · ${spend.calls} calls` : '— 7d'}
            </span>
            {hasOverride && (
              <Button variant="ghost" size="sm" className="h-9 px-2 text-xs" disabled={busy} onClick={() => onSave(step.id, {})}>
                <RotateCcw className="h-3.5 w-3.5 mr-1" /> Reset
              </Button>
            )}
          </div>
        </div>

        {step.tunable ? (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            <div className="min-w-0">
              <div className="mb-1 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                Model <SourceBadge source={r.model.source} />
                {r.model.source === 'slot' && (
                  <Link to="/projects/connectors" className="underline underline-offset-2">set on Model Connectors</Link>
                )}
                {r.model.source === 'lane' && (
                  <Link to="/projects/queue" className="underline underline-offset-2">set on Routing</Link>
                )}
              </div>
              <Select value={o.model || '__default__'} disabled={busy} onValueChange={(v) => save({ model: v === '__default__' ? null : v })}>
                <SelectTrigger className="h-11 sm:h-10 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__default__">
                    {r.model.value ? `${modelLabel(r.model.value)} (${r.model.source})` : 'Resolved default'}
                  </SelectItem>
                  {modelOptionsWith(o.model).map((m) => (
                    <SelectItem key={m.id} value={m.id}>{m.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="min-w-0">
              <div className="mb-1 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                Effort <SourceBadge source={r.effort.source} />
              </div>
              <Select value={o.effort || '__default__'} disabled={busy} onValueChange={(v) => save({ effort: v === '__default__' ? null : v })}>
                <SelectTrigger className="h-11 sm:h-10 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__default__">{`${r.effort.value || 'default'} (${r.effort.source})`}</SelectItem>
                  {(options?.efforts || []).map((e) => (
                    <SelectItem key={e} value={e}>{EFFORT_LABELS[e] || e}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="min-w-0">
              <div className="mb-1 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                Thinking <SourceBadge source={r.thinking.source} />
              </div>
              <Select value={o.thinking || '__default__'} disabled={busy} onValueChange={(v) => save({ thinking: v === '__default__' ? null : v })}>
                <SelectTrigger className="h-11 sm:h-10 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__default__">{`${r.thinking.value || 'default'} (${r.thinking.source})`}</SelectItem>
                  <SelectItem value="off">Off</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">
            {`Pinned to ${step.defaults.model || 'its shipped model'} by design — not tunable.`}
          </p>
        )}

        <p className="text-[11px] text-muted-foreground">
          Budget: {step.defaults.budgetNote} (read-only — a mis-set budget causes truncation failures that don’t look like a settings mistake)
        </p>
      </CardContent>
    </Card>
  );
}

export default function HarnessGuide() {
  const { toast } = useToast();
  // Controls tab state
  const [stepsDoc, setStepsDoc] = useState(null); // { steps, deterministic, options } | null loading
  const [savingStep, setSavingStep] = useState(null);
  const [showDeterministic, setShowDeterministic] = useState(false);
  // Guide tab state
  const [doc, setDoc] = useState(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);

  const loadSteps = useCallback(async () => {
    try {
      setStepsDoc(await api.mock2HarnessSteps());
    } catch (err) {
      if (!(err instanceof ApiError)) console.error('load harness steps failed:', err);
      setStepsDoc({ steps: [], deterministic: [], options: {}, error: true });
    }
  }, []);
  const loadGuide = useCallback(async () => {
    try {
      setDoc(await api.mock2GetHarnessGuide());
    } catch (err) {
      if (!(err instanceof ApiError)) console.error('load harness guide failed:', err);
      setDoc({ content: '', edited: false, updated_at: null, error: true });
    }
  }, []);
  useEffect(() => { loadSteps(); loadGuide(); }, [loadSteps, loadGuide]);

  const saveStep = async (id, patch) => {
    setSavingStep(id);
    try {
      await api.mock2HarnessStepSave(id, patch);
      await loadSteps();
      const cleared = !patch.model && !patch.effort && !patch.thinking;
      toast({
        title: cleared ? 'Override cleared' : 'Step override saved',
        description: cleared
          ? `${id} follows its lane/env/slot resolution again.`
          : `${id} uses the override on its next model call.`,
      });
    } catch (err) {
      toast({ variant: 'destructive', title: 'Save failed', description: err.message });
    } finally {
      setSavingStep(null);
    }
  };

  const startEdit = () => { setDraft(doc?.content || ''); setEditing(true); setConfirmReset(false); };
  const saveGuide = async () => {
    if (!draft.trim()) {
      toast({ variant: 'destructive', title: 'Empty document', description: 'Use "Reset to shipped" to drop your edit instead of saving an empty page.' });
      return;
    }
    setBusy(true);
    try {
      setDoc(await api.mock2SetHarnessGuide(draft));
      setEditing(false);
      toast({ title: 'Harness guide saved', description: 'Your copy now overrides the shipped document.' });
    } catch (err) {
      toast({ variant: 'destructive', title: 'Save failed', description: err.message });
    } finally { setBusy(false); }
  };
  const resetGuide = async () => {
    setBusy(true);
    try {
      setDoc(await api.mock2SetHarnessGuide(''));
      setEditing(false);
      setConfirmReset(false);
      toast({ title: 'Reset to shipped', description: 'The document again tracks the running code.' });
    } catch (err) {
      toast({ variant: 'destructive', title: 'Reset failed', description: err.message });
    } finally { setBusy(false); }
  };

  const stages = STAGE_ORDER.filter((st) => (stepsDoc?.steps || []).some((s) => s.stage === st));

  return (
    <div className="space-y-4">
      <div className="min-w-0">
        <Button asChild variant="ghost" size="sm" className="h-11 sm:h-9 -ml-2 mb-1">
          <Link to="/projects"><ArrowLeft className="h-4 w-4 mr-1" /> Projects</Link>
        </Button>
        <h1 className="text-xl font-bold sm:text-2xl">Harness</h1>
        <p className="text-sm text-muted-foreground">
          Per-step controls (changes apply on the next model call) and the full pipeline guide.
        </p>
      </div>

      <Tabs defaultValue="controls">
        <TabsList className="w-full sm:w-auto">
          <TabsTrigger value="controls" className="flex-1 sm:flex-none min-h-[44px] sm:min-h-0">Controls</TabsTrigger>
          <TabsTrigger value="guide" className="flex-1 sm:flex-none min-h-[44px] sm:min-h-0">Guide</TabsTrigger>
        </TabsList>

        <TabsContent value="controls" className="mt-4 space-y-6">
          {stepsDoc == null ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : stepsDoc.error ? (
            <Card><CardContent className="p-6 text-sm text-muted-foreground">
              The harness steps could not be loaded. Check that this host has the Projects module enabled and that you are an admin.
            </CardContent></Card>
          ) : (
            <>
              <p className="text-xs text-muted-foreground">
                Precedence per value: <span className="font-medium">step override → lane tuning → env override → slot / shipped default</span>.
                Slots stay owned by Model Connectors and lanes by Routing — these controls write only the step layer.
                A rejected override model falls back to the step’s default on the same call and logs it. Prompts and budgets are not editable here by design.
              </p>
              {stages.map((stage) => (
                <div key={stage} className="space-y-3">
                  <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">{stage}</h2>
                  {stepsDoc.steps.filter((s) => s.stage === stage).map((step) => (
                    <StepRow key={step.id} step={step} options={stepsDoc.options} onSave={saveStep} busy={savingStep === step.id} />
                  ))}
                </div>
              ))}
              <div>
                <Button variant="ghost" size="sm" className="h-11 sm:h-9 -ml-2" onClick={() => setShowDeterministic((v) => !v)}>
                  {showDeterministic ? <ChevronDown className="h-4 w-4 mr-1" /> : <ChevronRight className="h-4 w-4 mr-1" />}
                  Deterministic steps (free — no model, nothing to tune)
                </Button>
                {showDeterministic && (
                  <div className="mt-2 space-y-1.5">
                    {(stepsDoc.deterministic || []).map((d) => (
                      <div key={d.id} className="rounded-md border px-3 py-2">
                        <p className="text-sm font-medium">{d.title} <span className="ml-1 text-[10px] uppercase text-muted-foreground">{d.stage}</span></p>
                        <p className="text-xs text-muted-foreground">{d.description}</p>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
        </TabsContent>

        <TabsContent value="guide" className="mt-4 space-y-3">
          {doc != null && !editing && (
            <div className="flex flex-wrap items-center gap-2">
              {doc.edited ? (
                <span className="inline-flex items-center rounded-full border border-amber-500/50 bg-amber-500/10 px-2.5 py-1 text-xs font-medium text-amber-600 dark:text-amber-400">
                  Edited copy{doc.updated_at ? ` · ${new Date(doc.updated_at).toLocaleDateString()}` : ''}
                </span>
              ) : (
                <span className="inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium text-muted-foreground">
                  Shipped with this version
                </span>
              )}
              <Button variant="outline" className="h-11 sm:h-10" onClick={startEdit}>
                <Pencil className="h-4 w-4 mr-1" /> Edit
              </Button>
              {doc.edited && (confirmReset ? (
                <Button variant="destructive" className="h-11 sm:h-10" disabled={busy} onClick={resetGuide}>
                  {busy ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <RotateCcw className="h-4 w-4 mr-1" />}
                  Confirm reset
                </Button>
              ) : (
                <Button variant="outline" className="h-11 sm:h-10" onClick={() => setConfirmReset(true)}>
                  <RotateCcw className="h-4 w-4 mr-1" /> Reset to shipped
                </Button>
              ))}
            </div>
          )}
          {doc == null ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : editing ? (
            <Card>
              <CardContent className="space-y-3 p-3 sm:p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-xs text-muted-foreground">
                    Markdown. Saving stores your copy server-side; the shipped document is untouched and stays available via Reset.
                    Note: editing this text changes the documentation only — the Controls tab is what changes harness behavior.
                  </p>
                  <span className="text-xs tabular-nums text-muted-foreground">{draft.length.toLocaleString()} chars</span>
                </div>
                <textarea
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  spellCheck={false}
                  className="min-h-[60vh] w-full resize-y rounded-md border bg-background p-3 font-mono text-xs leading-relaxed focus:outline-none focus:ring-2 focus:ring-ring"
                />
                <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
                  <Button variant="outline" className="h-11 sm:h-10" disabled={busy} onClick={() => setEditing(false)}>
                    <X className="h-4 w-4 mr-1" /> Cancel
                  </Button>
                  <Button className="h-11 sm:h-10" disabled={busy} onClick={saveGuide}>
                    {busy ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Save className="h-4 w-4 mr-1" />} Save
                  </Button>
                </div>
              </CardContent>
            </Card>
          ) : doc.error ? (
            <Card>
              <CardContent className="p-6 text-sm text-muted-foreground">
                The harness guide could not be loaded. Check that this host has the Projects module enabled and that you are an admin.
              </CardContent>
            </Card>
          ) : (
            <Card>
              <CardContent className="p-4 sm:p-6">
                <ReactMarkdown remarkPlugins={[remarkGfm]} components={docComponents}>
                  {doc.content}
                </ReactMarkdown>
              </CardContent>
            </Card>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
