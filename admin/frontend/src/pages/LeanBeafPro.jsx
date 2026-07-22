// Lean BEAF Pro ("Pro" for projects) — innovation project management for
// the Spec Ops team. Four views: Dashboard (tiles, meeting rhythm, moved /
// no-movement, grounded brief, pipeline), List (filter chips + cards),
// Board (7 stage columns, drag-to-advance), Archive (meta tiles +
// meta-analysis + rolled-out / abandoned).
//
// Team-shared: every non-pending user sees and edits everything (R01).
// Mobile-first per MOBILE_FIRST.md — the team drives this from phones.

import { useCallback, useEffect, useState } from 'react';
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
  Loader2, Plus, Sparkles, CalendarCheck, CalendarClock, ChevronRight, Rocket, Archive as ArchiveIcon,
} from 'lucide-react';
import {
  LBP_STAGES, ProjectCard, MovedBadge, ScopeEditor,
  NewProjectDialog, timeAgo,
} from '@/components/lbp/shared';

const VIEWS = ['dashboard', 'list', 'board', 'archive'];

export default function LeanBeafPro() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const view = VIEWS.includes(searchParams.get('view')) ? searchParams.get('view') : 'dashboard';
  const setView = (v) => setSearchParams(v === 'dashboard' ? {} : { view: v });
  const [newOpen, setNewOpen] = useState(false);

  return (
    // Desktop readability: cap the content to a centered ~1024px "measure"
    // (matching the approved 980px mockup) so wide monitors don't stretch
    // rows edge-to-edge. See docs note on line length / content well.
    <div className="mx-auto w-full max-w-5xl space-y-4">
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

      {view === 'dashboard' && <DashboardView onOpenArchive={() => setView('archive')} onOpenProject={(id) => navigate(`/lean-beaf/${id}`)} />}
      {view === 'list' && <ListView onOpenProject={(id) => navigate(`/lean-beaf/${id}`)} />}
      {view === 'board' && <BoardView onOpenProject={(id) => navigate(`/lean-beaf/${id}`)} />}
      {view === 'archive' && <ArchiveView onOpenProject={(id) => navigate(`/lean-beaf/${id}`)} />}

      <NewProjectDialog open={newOpen} onOpenChange={setNewOpen} onCreated={(p) => navigate(`/lean-beaf/${p.id}`)} />
    </div>
  );
}

// ---- Dashboard ----

function DashboardView({ onOpenArchive, onOpenProject }) {
  const { toast } = useToast();
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [brief, setBrief] = useState(null);
  const [briefMode, setBriefMode] = useState('since_meeting');
  const [briefLoading, setBriefLoading] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(false);

  const load = useCallback(() => {
    api.lbpOverview().then(setData).catch((e) => setErr(e.message));
  }, []);
  useEffect(() => { load(); }, [load]);

  const loadBrief = useCallback((mode) => {
    setBriefMode(mode);
    setBriefLoading(true);
    api.lbpBrief(mode)
      .then((d) => setBrief(d.brief))
      .catch((e) => toast({ variant: 'destructive', title: 'Brief failed', description: e.message }))
      .finally(() => setBriefLoading(false));
  }, [toast]);

  const markMeeting = async () => {
    try {
      await api.lbpMarkMeeting();
      toast({ title: 'Meeting marked', description: 'Movement now counts from this point.' });
      load();
      setBrief(null);
    } catch (e) {
      toast({ variant: 'destructive', title: 'Could not mark meeting', description: e.message });
    }
  };

  if (err) return <p className="text-sm text-destructive">{err}</p>;
  if (!data) return <div className="flex justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>;

  const tiles = [
    { label: 'Active projects', value: data.tiles.active_projects, cls: '' },
    { label: 'Moved since meeting', value: data.tiles.moved_since_meeting, cls: 'text-primary' },
    { label: 'No movement', value: data.tiles.no_movement, cls: data.tiles.no_movement > 0 ? 'text-amber-600 dark:text-amber-400' : '' },
    { label: 'Locations live', value: data.tiles.locations_live, cls: 'text-green-600 dark:text-green-400' },
  ];

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
        {tiles.map((t) => (
          <div key={t.label} className="rounded-xl border bg-card p-4">
            <span className="text-xs font-semibold text-muted-foreground">{t.label}</span>
            <b className={`block text-2xl font-extrabold ${t.cls}`}>{t.value}</b>
          </div>
        ))}
      </div>

      {/* meeting bar */}
      <div className="flex flex-wrap items-center gap-3 rounded-xl border bg-card p-4">
        <CalendarCheck className="h-5 w-5 text-primary" />
        <div className="min-w-[180px] flex-1">
          <b className="block text-sm">
            {data.meeting.current ? `Last meeting ${timeAgo(data.meeting.current.marked_at)}` : 'No meeting marked yet'}
          </b>
          <span className="text-xs text-muted-foreground">
            {data.meeting.schedule?.active
              ? `Auto-marks weekly (${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][data.meeting.schedule.day_of_week]} ${data.meeting.schedule.time_hhmm})`
              : 'Movement is measured meeting-to-meeting'}
          </span>
        </div>
        <div className="flex gap-2">
          <Button size="sm" className="h-10" onClick={markMeeting}>Mark meeting now</Button>
          <Button size="sm" variant="outline" className="h-10" onClick={() => setScheduleOpen(true)}>
            <CalendarClock className="mr-1.5 h-4 w-4" /> Schedule
          </Button>
        </div>
      </div>

      {/* since last meeting: moved */}
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-sm uppercase tracking-wide text-muted-foreground">Since last meeting · moved</CardTitle></CardHeader>
        <CardContent className="divide-y">
          {data.moved.length === 0 && <p className="py-2 text-sm text-muted-foreground">Nothing has moved yet.</p>}
          {data.moved.map((p) => (
            <button key={p.id} type="button" onClick={() => onOpenProject(p.id)} className="flex w-full items-start gap-2 py-2.5 text-left">
              <div className="min-w-0 flex-1">
                <span className="block truncate text-sm font-semibold">{p.name}</span>
                <span className="block text-xs text-muted-foreground">
                  {p.changes.length ? p.changes.join(' · ') : 'Updated'}
                </span>
              </div>
              <ChevronRight className="mt-1 h-4 w-4 shrink-0 text-muted-foreground" />
            </button>
          ))}
        </CardContent>
      </Card>

      {/* no movement */}
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-sm uppercase tracking-wide text-muted-foreground">No movement</CardTitle></CardHeader>
        <CardContent className="divide-y">
          {data.stalled.length === 0 && <p className="py-2 text-sm text-muted-foreground">Everything has moved. 🎉</p>}
          {data.stalled.map((p) => (
            <button key={p.id} type="button" onClick={() => onOpenProject(p.id)} className="flex w-full items-center gap-2 py-2.5 text-left">
              <span className="min-w-0 flex-1 truncate text-sm font-semibold">{p.name}</span>
              <span className="text-xs font-bold text-amber-600 dark:text-amber-400 whitespace-nowrap">
                {p.days_idle != null ? `${p.days_idle}d idle` : 'idle'}
              </span>
            </button>
          ))}
        </CardContent>
      </Card>

      {/* AI brief — grounded (R07): numbers cite their records */}
      <div className="rounded-xl border bg-gradient-to-br from-card to-muted/30 p-4">
        <div className="mb-2 flex items-center gap-2">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-purple-500/10 text-purple-600 dark:text-purple-400">
            <Sparkles className="h-4 w-4" />
          </span>
          <b className="text-sm">Brief</b>
          <span className="ml-auto text-[11px] text-muted-foreground">every number cites its record</span>
        </div>
        {briefLoading ? (
          <div className="py-4"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
        ) : brief ? (
          <p className="whitespace-pre-wrap text-sm leading-relaxed">{brief.text}</p>
        ) : (
          <p className="text-sm text-muted-foreground">Pick a mode to generate a brief from the activity + metric records.</p>
        )}
        <div className="mt-3 flex flex-wrap gap-2">
          {[['daily', 'Daily'], ['since_meeting', 'Since meeting'], ['leadership', 'Leadership report']].map(([mode, label]) => (
            <button
              key={mode}
              type="button"
              onClick={() => loadBrief(mode)}
              className={`rounded-full border px-3 py-1.5 text-xs font-semibold ${
                brief && briefMode === mode ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* pipeline strip */}
      <div>
        <div className="flex gap-1.5 overflow-x-auto pb-1">
          {data.pipeline.map((s) => (
            <div key={s.stage} className="min-w-[60px] flex-1 rounded-lg border bg-card px-1.5 py-2 text-center">
              <b className={`block text-lg ${s.count === 0 ? 'text-muted-foreground/50' : 'text-primary'}`}>{s.count}</b>
              <span className="text-[10px] font-bold tracking-wide text-muted-foreground">{s.stage}</span>
            </div>
          ))}
        </div>
        <p className="mt-1.5 text-xs text-muted-foreground">
          {data.archived_count} finished project{data.archived_count === 1 ? '' : 's'} in the{' '}
          <button type="button" className="font-bold text-primary" onClick={onOpenArchive}>Archive →</button>
        </p>
      </div>

      <MeetingScheduleDialog open={scheduleOpen} onOpenChange={setScheduleOpen} schedule={data.meeting.schedule} onSaved={load} />
    </div>
  );
}

function MeetingScheduleDialog({ open, onOpenChange, schedule, onSaved }) {
  const { toast } = useToast();
  const [active, setActive] = useState(false);
  const [dow, setDow] = useState('1');
  const [time, setTime] = useState('09:00');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setActive(!!schedule?.active);
    setDow(String(schedule?.day_of_week ?? 1));
    setTime(schedule?.time_hhmm || '09:00');
  }, [open, schedule]);

  const save = async () => {
    setSaving(true);
    try {
      await api.lbpSetMeetingSchedule({ active, day_of_week: Number(dow), time_hhmm: time });
      toast({ title: 'Meeting schedule saved' });
      onOpenChange(false);
      onSaved?.();
    } catch (e) {
      toast({ variant: 'destructive', title: 'Could not save schedule', description: e.message });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-full h-full rounded-none sm:max-w-md sm:h-auto sm:rounded-lg">
        <DialogHeader>
          <DialogTitle>Meeting schedule</DialogTitle>
          <DialogDescription>Each occurrence automatically marks a meeting. Manual marks still work any time.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <label className="flex items-center gap-2 text-sm font-medium">
            <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
            Weekly auto-mark enabled
          </label>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label>Day</Label>
              <Select value={dow} onValueChange={setDow}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].map((d, i) => (
                    <SelectItem key={d} value={String(i)}>{d}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="lbp-sched-time">Time</Label>
              <Input id="lbp-sched-time" type="time" value={time} onChange={(e) => setTime(e.target.value)} />
            </div>
          </div>
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="outline" className="h-11 sm:h-10" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button className="h-11 sm:h-10" onClick={save} disabled={saving}>
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />} Save
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ---- List ----

function ListView({ onOpenProject }) {
  const [projects, setProjects] = useState(null);
  const [filter, setFilter] = useState('all');
  const [err, setErr] = useState('');

  useEffect(() => {
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

function BoardView({ onOpenProject }) {
  const { toast } = useToast();
  const [projects, setProjects] = useState(null);
  const [err, setErr] = useState('');
  const [dragId, setDragId] = useState(null);
  const [scopePrompt, setScopePrompt] = useState(null); // {project} after a stage move
  const [locations, setLocations] = useState([]);

  const load = useCallback(() => {
    api.lbpProjects().then((d) => setProjects(d.projects)).catch((e) => setErr(e.message));
  }, []);
  useEffect(() => {
    load();
    api.lbpLocations().then((d) => setLocations(d.locations || [])).catch(() => {});
  }, [load]);

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

  if (err) return <p className="text-sm text-destructive">{err}</p>;
  if (!projects) return <div className="flex justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>;

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">Drag a card to a column (or use ›) to change its stage — the move is logged and you'll be asked for the new stage's scope.</p>
      <div className="flex gap-2.5 overflow-x-auto pb-3">
        {LBP_STAGES.map((stage) => {
          const cards = projects.filter((p) => p.stage === stage);
          return (
            <div
              key={stage}
              className="w-[240px] shrink-0 rounded-xl border bg-muted/30 p-2"
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                if (dragId != null) moveTo(dragId, stage);
                setDragId(null);
              }}
            >
              <div className="mb-2 flex items-center justify-between px-1">
                <span className="text-xs font-bold uppercase tracking-wide text-muted-foreground">{stage}</span>
                <span className="text-xs font-bold text-primary">{cards.length}</span>
              </div>
              <div className="flex min-h-[60px] flex-col gap-2">
                {cards.map((p) => (
                  <div
                    key={p.id}
                    draggable
                    onDragStart={() => setDragId(p.id)}
                    className="cursor-grab rounded-lg border bg-card p-3 active:cursor-grabbing"
                  >
                    <button type="button" onClick={() => onOpenProject(p.id)} className="block w-full text-left">
                      <span className="block truncate text-sm font-semibold">{p.name}</span>
                      <span className="mt-1 flex items-center gap-2">
                        <MovedBadge moved={p.moved} daysIdle={p.days_idle} archived={p.archived} />
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
