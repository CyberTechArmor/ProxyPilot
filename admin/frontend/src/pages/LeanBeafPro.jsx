// Lean BEAF Pro ("Pro" for projects) — innovation project management for
// the Spec Ops team. Four views: Dashboard (tiles, meeting rhythm, moved /
// no-movement, grounded brief, pipeline), List (filter chips + cards),
// Board (7 stage columns, drag-to-advance), Archive (meta tiles +
// meta-analysis + rolled-out / abandoned).
//
// Team-shared: every non-pending user sees and edits everything (R01).
// Mobile-first per MOBILE_FIRST.md — the team drives this from phones.

import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '@/lib/api';
import { useAuth } from '@/context/AuthContext';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import {
  Loader2, Plus, Sparkles, CalendarCheck, CalendarClock, ChevronRight, Rocket, Archive as ArchiveIcon, Pin, ScrollText, Trash2, Wand2, Settings2, ArrowRight, Send, MessageSquare,
} from 'lucide-react';
import {
  LBP_STAGES, ProjectCard, MovedBadge, CardFlags, ScopeEditor,
  NewProjectDialog, timeAgo,
} from '@/components/lbp/shared';
import BriefText from '@/components/lbp/BriefText';

const VIEWS = ['dashboard', 'list', 'board', 'archive'];

export default function LeanBeafPro() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const view = VIEWS.includes(searchParams.get('view')) ? searchParams.get('view') : 'dashboard';
  // List filter + Board focus-stage live in the URL so the dashboard tiles
  // and movement rows can deep-link into a filtered list / a specific
  // Kanban column (and so those views are shareable / back-button friendly).
  const listFilter = searchParams.get('filter') || 'all';
  const boardStage = searchParams.get('stage') || null;
  // Switching views via the tabs resets any tile-driven filter/stage.
  const setView = (v) => setSearchParams(v === 'dashboard' ? {} : { view: v });
  const goToList = (filter) => setSearchParams({ view: 'list', filter });
  const goToBoardStage = (stage) => setSearchParams(stage ? { view: 'board', stage } : { view: 'board' });
  const [newOpen, setNewOpen] = useState(false);

  // The Board uses the FULL content width (all 7 columns reachable); the other
  // views cap to a centered ~1024px "measure" (readability / content well) so
  // wide monitors don't stretch rows edge-to-edge. Header + tabs follow the
  // active view's width so the chrome lines up with the content below.
  const wide = view === 'board';
  const measure = wide ? 'w-full' : 'mx-auto w-full max-w-5xl';

  return (
    <div className="w-full space-y-4">
      <div className={`${measure} space-y-4`}>
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <Rocket className="h-4 w-4" />
          </span>
          <div>
            <h1 className="text-xl font-bold leading-tight">Lean BEAF Pro</h1>
            <p className="text-xs text-muted-foreground">Spec Ops · innovation projects</p>
          </div>
        </div>
        <div className="ml-auto">
          <Button className="h-11 sm:h-10" onClick={() => setNewOpen(true)}>
            <Plus className="mr-1.5 h-4 w-4" /> New project
          </Button>
        </div>
      </div>

      {/* view tabs — sticky segmented control, 4 equal columns */}
      <div className="sticky top-14 z-30 grid grid-cols-4 gap-1 rounded-xl border bg-card p-1 md:top-0">
        {VIEWS.map((v) => (
          <button
            key={v}
            type="button"
            onClick={() => setView(v)}
            className={`rounded-lg px-1 py-2 text-sm font-semibold capitalize ${
              view === v ? 'bg-primary/10 text-primary shadow-[inset_0_-2px_0] shadow-primary' : 'text-muted-foreground'
            }`}
          >
            {v}
          </button>
        ))}
      </div>
      </div>

      {view === 'board' ? (
        <BoardView focusStage={boardStage} onOpenProject={(id) => navigate(`/lean-beaf/${id}`)} />
      ) : (
        <div className="mx-auto w-full max-w-5xl">
          {view === 'dashboard' && (
            <DashboardView
              onOpenArchive={() => setView('archive')}
              onOpenProject={(id, tab) => navigate(`/lean-beaf/${id}${tab ? `?tab=${tab}` : ''}`)}
              onOpenBriefs={() => navigate('/lean-beaf/briefs')}
              onDrillTile={goToList}
              onDrillStage={goToBoardStage}
            />
          )}
          {view === 'list' && (
            <ListView filter={listFilter} onFilterChange={goToList} onOpenProject={(id) => navigate(`/lean-beaf/${id}`)} />
          )}
          {view === 'archive' && <ArchiveView onOpenProject={(id) => navigate(`/lean-beaf/${id}`)} />}
        </div>
      )}

      <NewProjectDialog open={newOpen} onOpenChange={setNewOpen} onCreated={(p) => navigate(`/lean-beaf/${p.id}`)} />
    </div>
  );
}

// ---- Dashboard ----

function DashboardView({ onOpenArchive, onOpenProject, onOpenBriefs, onDrillTile, onDrillStage }) {
  const { toast } = useToast();
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [brief, setBrief] = useState(null);
  const [briefMode, setBriefMode] = useState('since_meeting');
  const [briefLoading, setBriefLoading] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // AI restyle: explicit (a real model call costs money) — never auto-run.
  const [aiResult, setAiResult] = useState(null); // { fell_back, cost_usd, model, error, ... }
  const [aiLoading, setAiLoading] = useState(false);
  const [aiSettings, setAiSettings] = useState(null);
  const [refs, setRefs] = useState(null); // link metadata for the brief text
  // Ask (grounded Q&A over the portfolio).
  const [askOpen, setAskOpen] = useState(false);
  const [askText, setAskText] = useState('');
  const [asking, setAsking] = useState(false);
  const [answer, setAnswer] = useState(null); // { text, cost_usd, model, error, ... }

  // Open a project, optionally at a specific tab/area (deep-link from the brief).
  const openArea = (id, tab) => onOpenProject(id, tab);

  const load = useCallback(() => {
    api.lbpOverview().then(setData).catch((e) => setErr(e.message));
  }, []);
  useEffect(() => { load(); }, [load]);

  const loadSettings = useCallback(() => {
    api.lbpBriefSettings().then((d) => setAiSettings(d.settings)).catch(() => {});
  }, []);
  useEffect(() => { loadSettings(); }, [loadSettings]);

  // Deterministic, record-grounded brief — free, no model call. Auto-loads so
  // the section is never empty; the AI restyle is a separate, explicit action.
  const loadBrief = useCallback((mode) => {
    setBriefMode(mode);
    setBriefLoading(true);
    setAiResult(null);
    api.lbpBrief(mode)
      .then((d) => { setBrief(d.brief); setRefs(d.refs); })
      .catch((e) => toast({ variant: 'destructive', title: 'Brief failed', description: e.message }))
      .finally(() => setBriefLoading(false));
  }, [toast]);

  useEffect(() => { loadBrief('since_meeting'); }, [loadBrief]);

  // Restyle the current grounded brief with the model (records a run + cost).
  const generateAi = async () => {
    setAiLoading(true);
    try {
      const d = await api.lbpBriefAi(briefMode);
      setBrief(d.brief);
      setRefs(d.refs);
      setAiResult(d.ai);
      if (d.ai?.error === 'not_configured') {
        toast({
          variant: 'destructive',
          title: 'No model connected',
          description: isAdmin ? 'Add a model + API key under AI settings.' : 'Ask an admin to connect a model in AI settings.',
        });
      } else if (d.ai?.fell_back) {
        toast({ variant: 'destructive', title: 'Used the grounded brief', description: 'The AI rewrite was rejected; showing the deterministic version.' });
      }
    } catch (e) {
      toast({ variant: 'destructive', title: 'AI brief failed', description: e.message });
    } finally {
      setAiLoading(false);
    }
  };

  // Ask a grounded question about the portfolio.
  const ask = async () => {
    const q = askText.trim();
    if (!q || asking) return;
    setAsking(true);
    setAnswer(null);
    try {
      const d = await api.lbpBriefAsk(q);
      setRefs(d.refs);
      setAnswer(d.answer);
      if (d.answer?.error === 'not_configured') {
        toast({ variant: 'destructive', title: 'No model connected', description: isAdmin ? 'Add a model + API key under AI settings.' : 'Ask an admin to connect a model in AI settings.' });
      } else if (d.answer?.error === 'ungrounded_output') {
        toast({ variant: 'destructive', title: 'Answer withheld', description: 'The model referenced a record not in the grounded facts.' });
      } else if (d.answer?.error) {
        toast({ variant: 'destructive', title: 'Question failed', description: d.answer.error });
      }
    } catch (e) {
      toast({ variant: 'destructive', title: 'Question failed', description: e.message });
    } finally {
      setAsking(false);
    }
  };

  const markMeeting = async () => {
    try {
      await api.lbpMarkMeeting();
      toast({ title: 'Meeting marked', description: 'Movement now counts from this point.' });
      load();
      loadBrief(briefMode);
    } catch (e) {
      toast({ variant: 'destructive', title: 'Could not mark meeting', description: e.message });
    }
  };

  if (err) return <p className="text-sm text-destructive">{err}</p>;
  if (!data) return <div className="flex justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>;

  // Each tile drills into the List view with the matching filter. "Locations
  // live" has no dedicated filter, so it lands on the full (unfiltered) list.
  const tiles = [
    { label: 'Active projects', value: data.tiles.active_projects, cls: '', filter: 'all' },
    { label: 'Moved since meeting', value: data.tiles.moved_since_meeting, cls: 'text-primary', filter: 'moved' },
    { label: 'No movement', value: data.tiles.no_movement, cls: data.tiles.no_movement > 0 ? 'text-amber-600 dark:text-amber-400' : '', filter: 'stalled' },
    { label: 'Locations live', value: data.tiles.locations_live, cls: 'text-green-600 dark:text-green-400', filter: 'all' },
  ];

  const aiOn = aiResult && !aiResult.fell_back;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
        {tiles.map((t) => (
          <button
            key={t.label}
            type="button"
            onClick={() => onDrillTile(t.filter)}
            className="rounded-xl border bg-card p-4 text-left transition-colors hover:border-primary/50 focus-visible:border-primary/50 focus-visible:outline-none"
            title={`View ${t.label.toLowerCase()} in the list`}
          >
            <span className="text-xs font-semibold text-muted-foreground">{t.label}</span>
            <b className={`block text-2xl font-extrabold ${t.cls}`}>{t.value}</b>
          </button>
        ))}
      </div>

      {/* AI brief — the dashboard centerpiece. The meeting rhythm now lives in
          its header (a brief IS the meeting-to-meeting summary, so this is
          where marking a meeting belongs). Grounded (R07): numbers cite their
          records; the AI only restyles those grounded facts. */}
      <div className="flex min-h-[420px] flex-col rounded-xl border bg-gradient-to-br from-card to-muted/30 p-5">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-purple-500/10 text-purple-600 dark:text-purple-400">
            <Sparkles className="h-5 w-5" />
          </span>
          <b className="text-base">Brief</b>
          <span className="text-[11px] text-muted-foreground">every number cites its record · tap a citation to open it</span>
        </div>

        {/* meeting rhythm — kept right above the AI/brief buttons. Marking a
            meeting resets the "since meeting" window this brief summarizes. */}
        <div className="mb-2.5 flex flex-wrap items-center gap-2.5 rounded-lg border border-border/60 bg-background/40 px-3 py-2.5">
          <CalendarCheck className="h-4 w-4 shrink-0 text-primary" />
          <div className="min-w-[150px] flex-1">
            <b className="block text-xs">
              {data.meeting.current ? `Last meeting ${timeAgo(data.meeting.current.marked_at)}` : 'No meeting marked yet'}
            </b>
            <span className="text-[11px] text-muted-foreground">
              {data.meeting.schedules_summary
                ? `Auto-marks: ${data.meeting.schedules_summary}`
                : 'Movement is measured meeting-to-meeting'}
            </span>
          </div>
          <div className="flex gap-2">
            <Button size="sm" className="h-9" onClick={markMeeting}>Mark meeting</Button>
            <Button size="sm" variant="outline" className="h-9" onClick={() => setScheduleOpen(true)}>
              <CalendarClock className="mr-1.5 h-4 w-4" /> Schedule
            </Button>
          </div>
        </div>

        {/* one row: all AI / brief controls inline — mode chips on the left,
            actions (Ask, Generate, Briefs, settings) on the right. */}
        <div className="mb-3 flex flex-wrap items-center gap-2">
          {[['daily', 'Daily'], ['since_meeting', 'Since meeting'], ['leadership', 'Leadership report']].map(([mode, label]) => (
            <button
              key={mode}
              type="button"
              onClick={() => loadBrief(mode)}
              className={`rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors ${
                briefMode === mode ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:border-primary/40'
              }`}
            >
              {label}
            </button>
          ))}
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              className={`h-9 ${askOpen ? 'border-primary text-primary' : ''}`}
              onClick={() => setAskOpen((v) => !v)}
              title="Ask a grounded question about these projects"
            >
              <MessageSquare className="mr-1.5 h-4 w-4" /> Ask
            </Button>
            <Button
              size="sm"
              className="h-9 bg-gradient-to-r from-purple-600 to-indigo-600 text-white hover:from-purple-600/90 hover:to-indigo-600/90"
              onClick={generateAi}
              disabled={aiLoading || briefLoading}
              title="Restyle this grounded brief with the model"
            >
              {aiLoading ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Wand2 className="mr-1.5 h-4 w-4" />}
              Generate with AI
            </Button>
            <Button size="sm" variant="outline" className="h-9" onClick={onOpenBriefs} title="See all briefs + the AI run log">
              <ScrollText className="mr-1.5 h-4 w-4" /> Briefs
            </Button>
            {isAdmin && (
              <Button size="sm" variant="ghost" className="h-9 w-9 p-0 text-muted-foreground" onClick={() => setSettingsOpen(true)} title="AI model settings">
                <Settings2 className="h-4 w-4" />
              </Button>
            )}
          </div>
        </div>

        {/* Ask box — grounded Q&A, appears inline when "Ask" is toggled. */}
        {askOpen && (
          <div className="mb-3 rounded-lg border border-primary/30 bg-primary/5 p-3">
            <div className="flex items-end gap-2">
              <div className="flex-1">
                <Label className="mb-1 block text-xs font-semibold text-primary">Ask about these projects</Label>
                <Input
                  value={askText}
                  onChange={(e) => setAskText(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') ask(); }}
                  placeholder="e.g. What's blocked right now? Which projects moved this week?"
                  maxLength={500}
                  className="h-10 bg-background"
                />
              </div>
              <Button className="h-10" onClick={ask} disabled={asking || !askText.trim()}>
                {asking ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              </Button>
            </div>
            <p className="mt-1.5 text-[11px] text-muted-foreground">Answers use only the recorded facts — every figure stays cited.</p>
            {(asking || answer) && (
              <div className="mt-3 rounded-lg border border-border/60 bg-background p-3">
                {asking ? (
                  <div className="flex items-center justify-center py-4"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
                ) : answer?.error ? (
                  <p className="text-sm text-amber-600 dark:text-amber-400">
                    {answer.error === 'not_configured' ? 'No model connected — an admin can set one in AI settings.'
                      : answer.error === 'ungrounded_output' ? 'The answer referenced a record not in the grounded facts, so it was withheld.'
                        : `Could not answer: ${answer.error}`}
                  </p>
                ) : (
                  <>
                    <BriefText text={answer.text} refs={refs} onOpen={openArea} />
                    <div className="mt-2 flex flex-wrap items-center gap-x-3 text-[11px] text-muted-foreground">
                      <span className="inline-flex items-center gap-1"><Wand2 className="h-3 w-3" /> {answer.model}</span>
                      <span>·</span>
                      <span>{formatUsd(answer.cost_usd)} · {answer.input_tokens.toLocaleString()} in / {answer.output_tokens.toLocaleString()} out</span>
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        )}

        <div className="relative flex-1 rounded-lg border border-border/60 bg-background/40 p-4">
          {(briefLoading || aiLoading) ? (
            <div className="flex h-full items-center justify-center py-8"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
          ) : brief ? (
            <BriefText text={brief.text} refs={refs} onOpen={openArea} />
          ) : (
            <p className="text-sm text-muted-foreground">Pick a mode to generate a brief from the activity + metric records.</p>
          )}
          {aiOn && (
            <span className="absolute right-2 top-2 inline-flex items-center gap-1 rounded-full bg-purple-500/10 px-2 py-0.5 text-[10px] font-semibold text-purple-600 dark:text-purple-400" title={`Model: ${aiResult.model}`}>
              <Sparkles className="h-3 w-3" /> AI
            </span>
          )}
        </div>

        {/* cost + model line — shown after an AI run (spend transparency). */}
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
          {aiResult ? (
            aiResult.error === 'not_configured' ? (
              <span className="text-amber-600 dark:text-amber-400">No model connected — {isAdmin ? 'set one in AI settings.' : 'ask an admin to connect one.'}</span>
            ) : (
              <>
                <span className="inline-flex items-center gap-1"><Wand2 className="h-3 w-3" /> {aiResult.model}</span>
                <span>·</span>
                <span>{formatUsd(aiResult.cost_usd)} this run</span>
                <span>·</span>
                <span>{aiResult.input_tokens.toLocaleString()} in / {aiResult.output_tokens.toLocaleString()} out</span>
                {aiResult.fell_back && <span className="text-amber-600 dark:text-amber-400">· grounded fallback shown</span>}
              </>
            )
          ) : (
            <span>
              Deterministic &amp; record-grounded. “Generate with AI” restyles it
              {aiSettings ? ` with ${aiSettings.model}` : ''}.
            </span>
          )}
        </div>

        {/* rollout process-map — the innovation pipeline as a flow. Each stage
            jumps to its Kanban column. Grounded: counts come from the records. */}
        <div className="mt-4">
          <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide text-muted-foreground">
            <ArrowRight className="h-3.5 w-3.5" /> Rollout pipeline
          </div>
          <div className="flex items-stretch gap-1 overflow-x-auto pb-1">
            {data.pipeline.map((s, i) => (
              <div key={s.stage} className="flex items-center">
                <button
                  type="button"
                  onClick={() => onDrillStage(s.stage)}
                  className={`flex min-w-[64px] flex-col items-center rounded-lg border px-2 py-2 text-center transition-colors hover:border-primary/60 focus-visible:border-primary/60 focus-visible:outline-none ${
                    s.count === 0 ? 'border-border/60 bg-background/40' : 'border-primary/30 bg-primary/5'
                  }`}
                  title={`Open the ${s.stage} column on the board`}
                >
                  <b className={`text-lg leading-none ${s.count === 0 ? 'text-muted-foreground/50' : 'text-primary'}`}>{s.count}</b>
                  <span className="mt-1 text-[10px] font-bold tracking-wide text-muted-foreground">{s.stage}</span>
                </button>
                {i < data.pipeline.length - 1 && (
                  <ChevronRight className="mx-0.5 h-4 w-4 shrink-0 text-muted-foreground/40" />
                )}
              </div>
            ))}
          </div>
          <p className="mt-1.5 text-xs text-muted-foreground">
            {data.archived_count} finished project{data.archived_count === 1 ? '' : 's'} in the{' '}
            <button type="button" className="font-bold text-primary" onClick={onOpenArchive}>Archive →</button>
          </p>
        </div>
      </div>

      <MeetingScheduleDialog open={scheduleOpen} onOpenChange={setScheduleOpen} onSaved={load} />
      <BriefAiSettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} onSaved={loadSettings} />
    </div>
  );
}

// USD formatter for tiny per-run costs (fractions of a cent are common with
// Haiku). Shows enough precision to be meaningful without scientific notation.
function formatUsd(n) {
  const v = Number(n) || 0;
  if (v === 0) return '$0.00';
  if (v < 0.01) return `$${v.toFixed(4)}`;
  return `$${v.toFixed(2)}`;
}

// Admin-only AI model settings for the brief writer. Model picker + optional
// API key (blank keeps the stored one) + optional base URL. Non-admins never
// see the trigger; the backend also gates the PUT.
function BriefAiSettingsDialog({ open, onOpenChange, onSaved }) {
  const { toast } = useToast();
  const [settings, setSettings] = useState(null);
  const [model, setModel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setApiKey('');
    api.lbpBriefSettings()
      .then((d) => { setSettings(d.settings); setModel(d.settings.model); })
      .catch((e) => toast({ variant: 'destructive', title: 'Could not load settings', description: e.message }));
  }, [open, toast]);

  const save = async () => {
    setSaving(true);
    try {
      const d = await api.lbpSaveBriefSettings({ model, api_key: apiKey || undefined });
      setSettings(d.settings);
      setApiKey('');
      toast({ title: 'AI settings saved' });
      onSaved?.();
      onOpenChange(false);
    } catch (e) {
      toast({ variant: 'destructive', title: 'Could not save', description: e.message });
    } finally {
      setSaving(false);
    }
  };

  const choices = settings?.choices || [];
  const price = settings?.pricing?.[model];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-full h-full rounded-none sm:max-w-lg sm:h-auto sm:max-h-[90vh] sm:rounded-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>AI brief settings</DialogTitle>
          <DialogDescription>
            The brief writer restyles the grounded facts — it never invents numbers. Pick the model and connect an
            Anthropic API key. The cheap, fast model (Haiku) is the default.
          </DialogDescription>
        </DialogHeader>

        {!settings ? (
          <div className="py-6"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
        ) : (
          <div className="space-y-4">
            <div className="space-y-1">
              <Label className="text-xs">Model</Label>
              <Select value={model} onValueChange={setModel}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {choices.map((c) => <SelectItem key={c.id} value={c.id}>{c.label}</SelectItem>)}
                  {!choices.some((c) => c.id === model) && model && (
                    <SelectItem value={model}>{model}</SelectItem>
                  )}
                </SelectContent>
              </Select>
              {price && (
                <p className="text-[11px] text-muted-foreground">
                  ${price.in.toFixed(2)} / 1M input · ${price.out.toFixed(2)} / 1M output tokens
                </p>
              )}
            </div>

            <div className="space-y-1">
              <Label className="text-xs">Anthropic API key</Label>
              <Input
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={settings.has_api_key ? (settings.key_source === 'env' ? 'Using ANTHROPIC_API_KEY from the environment' : '•••••• stored — leave blank to keep') : 'sk-ant-…'}
                className="font-mono"
              />
              <p className="text-[11px] text-muted-foreground">
                Stored encrypted at rest. Leave blank to keep the current key.
                {settings.key_source === 'env' && ' Currently falling back to the ANTHROPIC_API_KEY environment variable.'}
              </p>
            </div>

            <div className="flex justify-end gap-2">
              <Button variant="ghost" className="h-11 sm:h-10" onClick={() => onOpenChange(false)}>Cancel</Button>
              <Button className="h-11 sm:h-10" onClick={save} disabled={saving || !model}>
                {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />} Save
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

const DOW_LABELS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DOW_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// Manage MANY recurring schedules (daily or weekly). Each auto-marks a meeting
// at its occurrences; ad-hoc / different-time meetings use "Mark meeting now".
function MeetingScheduleDialog({ open, onOpenChange, onSaved }) {
  const { toast } = useToast();
  const [schedules, setSchedules] = useState([]);
  const [loading, setLoading] = useState(false);
  // Draft for the "add" row.
  const [freq, setFreq] = useState('weekly');
  const [dow, setDow] = useState('1');
  const [time, setTime] = useState('09:00');
  const [adding, setAdding] = useState(false);

  const reload = useCallback(() => {
    setLoading(true);
    api.lbpSchedules()
      .then((d) => setSchedules(d.schedules || []))
      .catch((e) => toast({ variant: 'destructive', title: 'Could not load schedules', description: e.message }))
      .finally(() => setLoading(false));
  }, [toast]);

  useEffect(() => {
    if (!open) return;
    setFreq('weekly'); setDow('1'); setTime('09:00');
    reload();
  }, [open, reload]);

  const changed = () => { reload(); onSaved?.(); };

  const add = async () => {
    setAdding(true);
    try {
      await api.lbpCreateSchedule({
        frequency: freq,
        day_of_week: freq === 'weekly' ? Number(dow) : null,
        time_hhmm: time,
        active: true,
      });
      changed();
    } catch (e) {
      toast({ variant: 'destructive', title: 'Could not add schedule', description: e.message });
    } finally {
      setAdding(false);
    }
  };

  const toggle = (s) => api.lbpUpdateSchedule(s.id, { active: !s.active }).then(changed)
    .catch((e) => toast({ variant: 'destructive', title: 'Could not update', description: e.message }));
  const remove = (s) => api.lbpDeleteSchedule(s.id).then(changed)
    .catch((e) => toast({ variant: 'destructive', title: 'Could not delete', description: e.message }));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-full h-full rounded-none sm:max-w-2xl sm:h-auto sm:max-h-[90vh] sm:rounded-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Meeting schedules</DialogTitle>
          <DialogDescription>
            Add as many recurring meetings as you need — a daily stand-up, a weekly review, etc. Each occurrence
            auto-marks a meeting. For a one-off or different-time meeting, use “Mark meeting now”.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {loading && schedules.length === 0 && <div className="py-4"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>}
          {!loading && schedules.length === 0 && <p className="text-sm text-muted-foreground">No recurring schedules yet — add one below.</p>}
          {schedules.map((s) => (
            <div key={s.id} className="flex flex-wrap items-center gap-2 rounded-lg border p-3">
              <span className="inline-flex items-center gap-1.5 text-sm font-semibold">
                <CalendarClock className={`h-4 w-4 ${s.active ? 'text-primary' : 'text-muted-foreground'}`} />
                {s.frequency === 'daily' ? 'Daily' : DOW_SHORT[s.day_of_week] ?? '?'} · {s.time_hhmm}
              </span>
              {!s.active && <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-semibold text-muted-foreground">paused</span>}
              <div className="ml-auto flex items-center gap-1">
                <Button variant="ghost" size="sm" className="h-9" onClick={() => toggle(s)}>
                  {s.active ? 'Pause' : 'Resume'}
                </Button>
                <Button variant="ghost" size="icon" className="h-9 w-9 text-muted-foreground" title="Delete" onClick={() => remove(s)}>
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </div>
          ))}
        </div>

        <div className="mt-2 rounded-lg border border-dashed p-3">
          <p className="mb-2 text-xs font-bold uppercase tracking-wide text-muted-foreground">Add a schedule</p>
          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-end">
            <div className="space-y-1">
              <Label className="text-xs">Repeats</Label>
              <Select value={freq} onValueChange={setFreq}>
                <SelectTrigger className="w-full sm:w-28"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="daily">Daily</SelectItem>
                  <SelectItem value="weekly">Weekly</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {freq === 'weekly' && (
              <div className="space-y-1">
                <Label className="text-xs">Day</Label>
                <Select value={dow} onValueChange={setDow}>
                  <SelectTrigger className="w-full sm:w-36"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {DOW_LABELS.map((d, i) => <SelectItem key={d} value={String(i)}>{d}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            )}
            <div className="space-y-1">
              <Label className="text-xs">Time</Label>
              <Input type="time" value={time} onChange={(e) => setTime(e.target.value)} className="w-full sm:w-32" />
            </div>
            <Button className="h-10 sm:ml-auto" onClick={add} disabled={adding}>
              {adding ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Plus className="mr-1.5 h-4 w-4" />} Add
            </Button>
          </div>
        </div>

        <div className="flex justify-end">
          <Button variant="outline" className="h-11 sm:h-10" onClick={() => onOpenChange(false)}>Done</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ---- List ----

function ListView({ filter = 'all', onFilterChange, onOpenProject }) {
  const [projects, setProjects] = useState(null);
  const [err, setErr] = useState('');
  // `filter` is owned by the URL (so dashboard tiles can deep-link here);
  // changing a chip updates the URL via onFilterChange, which re-renders
  // this view with the new filter.
  const setFilter = (f) => onFilterChange?.(f);

  useEffect(() => {
    setProjects(null);
    const f = filter === 'all' ? undefined : filter;
    api.lbpProjects({ filter: f })
      .then((d) => setProjects(d.projects))
      .catch((e) => setErr(e.message));
  }, [filter]);

  const chips = [
    ['all', 'All'], ['moved', 'Moved since meeting'], ['stalled', 'No movement'], ['mine', 'Mine'],
  ];

  return (
    <div className="space-y-3">
      <div className="flex gap-2 overflow-x-auto pb-1">
        {chips.map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => setFilter(key)}
            className={`whitespace-nowrap rounded-full border px-3.5 py-1.5 text-sm font-medium ${
              filter === key ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground'
            }`}
          >
            {label}
          </button>
        ))}
      </div>
      {err && <p className="text-sm text-destructive">{err}</p>}
      {!projects && !err && <div className="flex justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>}
      {projects && projects.length === 0 && (
        <p className="py-8 text-center text-sm text-muted-foreground">No projects match this filter.</p>
      )}
      <div className="flex flex-col gap-2.5">
        {(projects || []).map((p) => (
          <ProjectCard key={p.id} project={p} onClick={() => onOpenProject(p.id)} />
        ))}
      </div>
    </div>
  );
}

// ---- Board (drag card → next column advances stage + prompts scope) ----

function BoardView({ focusStage, onOpenProject }) {
  const { toast } = useToast();
  const [projects, setProjects] = useState(null);
  const [err, setErr] = useState('');
  const [dragId, setDragId] = useState(null);
  const [dragOver, setDragOver] = useState(null); // { stage, id } insertion target
  const [scopePrompt, setScopePrompt] = useState(null); // {project} after a stage move
  const [locations, setLocations] = useState([]);
  // Column focus: when the dashboard deep-links here (?stage=MVP), scroll that
  // column into view and pulse a highlight so the eye lands on it.
  const colRefs = useRef({});
  const [highlight, setHighlight] = useState(null);

  // Edge auto-scroll: hovering (or dragging a card) near the left/right edge
  // of the board scrolls it horizontally, so off-screen columns are reachable
  // without touching the scrollbar — essential during drag, when the native
  // drag interaction blocks manual scrolling. Speed ramps up nearer the edge.
  const scrollRef = useRef(null);
  const edgeRef = useRef({ dir: 0, speed: 0 });
  const rafRef = useRef(null);

  const stepScroll = useCallback(() => {
    const el = scrollRef.current;
    const { dir, speed } = edgeRef.current;
    if (el && dir !== 0) el.scrollLeft += dir * speed;
    if (edgeRef.current.dir !== 0) {
      rafRef.current = requestAnimationFrame(stepScroll);
    } else {
      rafRef.current = null;
    }
  }, []);

  const onEdgeMove = useCallback((clientX) => {
    const el = scrollRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const EDGE = 96;   // px hot-zone at each side
    const MAX = 22;    // max px/frame at the very edge
    const leftDist = clientX - rect.left;
    const rightDist = rect.right - clientX;
    if (leftDist >= 0 && leftDist < EDGE) {
      edgeRef.current = { dir: -1, speed: MAX * (1 - leftDist / EDGE) };
    } else if (rightDist >= 0 && rightDist < EDGE) {
      edgeRef.current = { dir: 1, speed: MAX * (1 - rightDist / EDGE) };
    } else {
      edgeRef.current = { dir: 0, speed: 0 };
    }
    if (edgeRef.current.dir !== 0 && rafRef.current == null) {
      rafRef.current = requestAnimationFrame(stepScroll);
    }
  }, [stepScroll]);

  const stopEdge = useCallback(() => { edgeRef.current = { dir: 0, speed: 0 }; }, []);

  useEffect(() => () => { if (rafRef.current != null) cancelAnimationFrame(rafRef.current); }, []);

  const load = useCallback(() => {
    api.lbpProjects().then((d) => setProjects(d.projects)).catch((e) => setErr(e.message));
  }, []);
  useEffect(() => {
    load();
    api.lbpLocations().then((d) => setLocations(d.locations || [])).catch(() => {});
  }, [load]);

  useEffect(() => {
    if (!focusStage || !projects) return undefined;
    const el = colRefs.current[focusStage];
    if (!el) return undefined;
    el.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
    setHighlight(focusStage);
    const t = setTimeout(() => setHighlight(null), 2200);
    return () => clearTimeout(t);
  }, [focusStage, projects]);

  const moveTo = async (projectId, stage) => {
    const project = projects.find((p) => p.id === projectId);
    if (!project || project.stage === stage) return;
    try {
      const data = await api.lbpSetStage(projectId, stage);
      toast({ title: `${project.name} → ${stage}` });
      load();
      // Advancing prompts for the new stage's scope (skippable, R03).
      if (['Testing', 'Site', 'POD', 'Region'].includes(stage)) {
        setScopePrompt({ project: { ...project, ...data.project, scope: project.scope } });
      }
    } catch (e) {
      toast({ variant: 'destructive', title: 'Stage change failed', description: e.message });
    }
  };

  // Cards in a column, in their manual (board_pos) order.
  const columnCards = (stage) =>
    projects.filter((p) => p.stage === stage).sort((a, b) => (a.board_pos ?? 0) - (b.board_pos ?? 0));

  // Reorder within a column: move the dragged card to just before `targetId`
  // (or to the end when targetId is null). Optimistic, then persisted.
  const reorderWithin = async (stage, draggedId, targetId) => {
    const ids = columnCards(stage).map((p) => p.id).filter((id) => id !== draggedId);
    const at = targetId == null ? ids.length : ids.indexOf(targetId);
    const next = [...ids.slice(0, at), draggedId, ...ids.slice(at)];
    setProjects((prev) => prev.map((p) => (p.stage === stage ? { ...p, board_pos: next.indexOf(p.id) } : p)));
    try {
      await api.lbpReorder(stage, next);
    } catch (e) {
      toast({ variant: 'destructive', title: 'Could not reorder', description: e.message });
      load();
    }
  };

  // Drop the dragged card onto another card: same column → reorder above it;
  // different column → change stage.
  const onCardDrop = (targetCard) => {
    const draggedId = dragId;
    setDragOver(null);
    setDragId(null);
    if (draggedId == null || draggedId === targetCard.id) return;
    const dragged = projects.find((p) => p.id === draggedId);
    if (!dragged) return;
    if (dragged.stage === targetCard.stage) reorderWithin(targetCard.stage, draggedId, targetCard.id);
    else moveTo(draggedId, targetCard.stage);
  };

  // Drop on empty column space: same column → send to end; else change stage.
  const onColumnDrop = (stage) => {
    const draggedId = dragId;
    setDragOver(null);
    setDragId(null);
    if (draggedId == null) return;
    const dragged = projects.find((p) => p.id === draggedId);
    if (dragged && dragged.stage === stage) reorderWithin(stage, draggedId, null);
    else moveTo(draggedId, stage);
  };

  if (err) return <p className="text-sm text-destructive">{err}</p>;
  if (!projects) return <div className="flex justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>;

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">Drag a card between columns to change its stage, or up/down within a column to reorder. Use › to advance. Hover near an edge to scroll.</p>
      {/* p-1.5 so the focus ring (ring + offset) on a column isn't clipped by
          the scroll container's overflow. */}
      <div
        ref={scrollRef}
        className="flex gap-2.5 overflow-x-auto p-1.5 pb-3"
        onMouseMove={(e) => onEdgeMove(e.clientX)}
        onMouseLeave={stopEdge}
        onDragOver={(e) => { e.preventDefault(); onEdgeMove(e.clientX); }}
        onDrop={stopEdge}
        onDragEnd={() => { stopEdge(); setDragOver(null); setDragId(null); }}
      >
        {LBP_STAGES.map((stage) => {
          const cards = columnCards(stage);
          return (
            <div
              key={stage}
              ref={(el) => { colRefs.current[stage] = el; }}
              className={`w-[240px] shrink-0 rounded-xl border bg-muted/30 p-2 transition-shadow ${
                highlight === stage ? 'ring-2 ring-primary ring-offset-2 ring-offset-background' : ''
              }`}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => { e.preventDefault(); e.stopPropagation(); onColumnDrop(stage); }}
            >
              <div className="mb-2 flex items-center justify-between px-1">
                <span className={`text-xs font-bold uppercase tracking-wide ${highlight === stage ? 'text-primary' : 'text-muted-foreground'}`}>{stage}</span>
                <span className="text-xs font-bold text-primary">{cards.length}</span>
              </div>
              <div className="flex min-h-[60px] flex-col gap-2">
                {cards.map((p) => (
                  <div
                    key={p.id}
                    draggable
                    onDragStart={() => setDragId(p.id)}
                    onDragEnd={() => { setDragOver(null); setDragId(null); }}
                    onDragOver={(e) => {
                      e.preventDefault();
                      if (dragId != null && dragId !== p.id) setDragOver({ stage, id: p.id });
                    }}
                    onDrop={(e) => { e.preventDefault(); e.stopPropagation(); onCardDrop(p); }}
                    className={`cursor-grab rounded-lg border bg-card p-3 transition-shadow active:cursor-grabbing ${
                      dragId === p.id ? 'opacity-50' : ''
                    } ${dragOver && dragOver.stage === stage && dragOver.id === p.id ? 'shadow-[inset_0_2px_0] shadow-primary' : ''}`}
                  >
                    <button type="button" onClick={() => onOpenProject(p.id)} className="block w-full text-left">
                      <span className="flex items-center gap-1.5">
                        {p.pinned && <Pin className="h-3 w-3 shrink-0 text-primary" />}
                        <span className="min-w-0 flex-1 truncate text-sm font-semibold">{p.name}</span>
                      </span>
                      <span className="mt-1 flex flex-wrap items-center gap-1.5">
                        <CardFlags project={p} />
                      </span>
                    </button>
                    {stage !== 'All' && (
                      <button
                        type="button"
                        onClick={() => moveTo(p.id, LBP_STAGES[LBP_STAGES.indexOf(stage) + 1])}
                        className="mt-2 inline-flex h-8 items-center gap-1 rounded-md border px-2 text-xs font-semibold text-primary"
                        title={`Advance to ${LBP_STAGES[LBP_STAGES.indexOf(stage) + 1]}`}
                      >
                        Advance <ChevronRight className="h-3 w-3" />
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>

      <Dialog open={!!scopePrompt} onOpenChange={(v) => !v && setScopePrompt(null)}>
        <DialogContent className="max-w-full h-full rounded-none sm:max-w-lg sm:h-auto sm:max-h-[90vh] sm:rounded-lg overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Set the rollout scope</DialogTitle>
            <DialogDescription>
              {scopePrompt?.project?.name} just changed stage — where is it now? (You can skip; scope can be set later.)
            </DialogDescription>
          </DialogHeader>
          {scopePrompt && (
            <ScopeEditor
              project={scopePrompt.project}
              locations={locations}
              onSaved={() => { setScopePrompt(null); load(); }}
            />
          )}
          <div className="flex justify-end">
            <Button variant="ghost" className="h-11 sm:h-10" onClick={() => setScopePrompt(null)}>Skip for now</Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ---- Archive ----

function ArchiveView({ onOpenProject }) {
  const { user } = useAuth();
  const { toast } = useToast();
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');

  const load = useCallback(() => {
    api.lbpArchive().then(setData).catch((e) => setErr(e.message));
  }, []);
  useEffect(() => { load(); }, [load]);

  if (err) return <p className="text-sm text-destructive">{err}</p>;
  if (!data) return <div className="flex justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>;

  const tiles = [
    { label: 'Ideas attempted', value: data.meta.ideas_attempted },
    { label: 'Rolled out', value: data.meta.rolled_out, cls: 'text-green-600 dark:text-green-400' },
    { label: 'Abandoned', value: data.meta.abandoned, cls: 'text-red-600 dark:text-red-400' },
    { label: 'Hours invested', value: data.meta.hours_invested, cls: 'text-primary' },
  ];

  const empty = data.rolled_out.length === 0 && data.abandoned.length === 0;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
        {tiles.map((t) => (
          <div key={t.label} className="rounded-xl border bg-card p-4">
            <span className="text-xs font-semibold text-muted-foreground">{t.label}</span>
            <b className={`block text-2xl font-extrabold ${t.cls || ''}`}>{t.value}</b>
          </div>
        ))}
      </div>

      <div className="rounded-xl border bg-gradient-to-br from-card to-muted/30 p-4">
        <div className="mb-1.5 flex items-center gap-2">
          <ArchiveIcon className="h-4 w-4 text-purple-600 dark:text-purple-400" />
          <b className="text-sm">Meta-analysis</b>
          <span className="ml-auto text-[11px] text-muted-foreground">computed from stored records only</span>
        </div>
        <p className="text-sm leading-relaxed">{data.analysis}</p>
      </div>

      {empty && user?.role === 'admin' && (
        <div className="rounded-xl border border-dashed p-6 text-center">
          <p className="text-sm text-muted-foreground">The archive is empty. Want the concept's sample portfolio to explore every state of the UI?</p>
          <Button
            variant="outline"
            className="mt-3 h-11 sm:h-10"
            onClick={() => api.lbpSeedDemo()
              .then(() => { toast({ title: 'Sample portfolio seeded' }); load(); })
              .catch((e) => toast({ variant: 'destructive', title: 'Seed failed', description: e.message }))}
          >
            Seed sample portfolio
          </Button>
        </div>
      )}

      <section>
        <h2 className="mb-2 text-sm font-bold uppercase tracking-wide text-green-600 dark:text-green-400">✓ Rolled out — successful</h2>
        <div className="flex flex-col gap-2.5">
          {data.rolled_out.length === 0 && <p className="text-sm text-muted-foreground">Nothing rolled out yet.</p>}
          {data.rolled_out.map((p) => (
            <ProjectCard key={p.id} project={p} archived onClick={() => onOpenProject(p.id)} />
          ))}
        </div>
      </section>

      <section>
        <h2 className="mb-2 text-sm font-bold uppercase tracking-wide text-red-600 dark:text-red-400">✕ Abandoned — didn't pan out</h2>
        <div className="flex flex-col gap-2.5">
          {data.abandoned.length === 0 && <p className="text-sm text-muted-foreground">Nothing abandoned yet.</p>}
          {data.abandoned.map((p) => (
            <ProjectCard key={p.id} project={p} archived onClick={() => onOpenProject(p.id)} />
          ))}
        </div>
      </section>
    </div>
  );
}
