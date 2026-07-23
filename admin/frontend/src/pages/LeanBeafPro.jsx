// Lean BEAF Pro ("Pro" for projects) — innovation project management for the
// Spec Ops team, organized around two ideas: business metrics decide which
// lever to pull, and projects are the things pulling the levers.
//
// Views: Dashboard (business metrics only) · Meetings (since-meeting digest +
// history) · List (pipeline + filters + dense table) · Board (kanban) ·
// Archive. The dashboard's numbers come from data sources that are not
// connected yet, so this is driven by an in-memory sample workspace
// (components/lbp/sampleData.js). Everything is interactive but in-memory.
//
// Mobile-first per MOBILE_FIRST.md.

import { Fragment, useCallback, useMemo, useRef, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import {
  Plus, CalendarCheck, Settings, ChevronRight, ChevronDown, Target, Play, Clock,
  ArrowRight, ArrowLeft, Flag, X, Sparkles, Rocket, Pencil, TrendingUp,
} from 'lucide-react';
import {
  LEVERS, LEVER_ORDER, STAGES, SAMPLE_PROJECTS, SAMPLE_ARCHIVE, SAMPLE_METRICS,
  SAMPLE_THRESHOLDS, SAMPLE_MEETING, SAMPLE_FOCUS, SAMPLE_IMPACT, IMPACT_RANGES,
} from '@/components/lbp/sampleData';
import {
  LeverDots, LeverChip, BeafTags, DeltaPill, OwnerAvatar, StatusChip, Sparkline,
  VolumeBars, RecencyStack, FocusToggle,
} from '@/components/lbp/redesignParts';

const TABS = ['Dashboard', 'Meetings', 'List', 'Board', 'Archive'];

const fmtDate = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString();
};

// ============================ top-level ============================

export default function LeanBeafPro() {
  const { setAssistant, assistantAvailable } = useOutletContext() || {};
  const [tab, setTab] = useState('Dashboard');
  const [projects, setProjects] = useState(SAMPLE_PROJECTS);
  const [archive] = useState(SAMPLE_ARCHIVE);

  // Weekly focus (shared between the dashboard strip and the List stars). The
  // dashboard loads with no category focused (all four cards at full strength,
  // like the clean default); the sample's pre-focused projects still light up
  // the List stars and the focus strip. Focusing a metric card dims the other
  // three and lights the punch-through on any breached card.
  const [focusCategory, setFocusCategory] = useState(null);
  const [focusProjects, setFocusProjects] = useState(SAMPLE_FOCUS.projects);
  const [thresholds, setThresholds] = useState(SAMPLE_THRESHOLDS);

  // List deep-link filters (lever chips / digest categories jump here).
  const [listLever, setListLever] = useState('all');
  const [listStatus, setListStatus] = useState('all');
  // A selected project opens as a whole-page detail view (replaces the tab
  // content); the header/nav stay put so any nav click leaves the detail.
  const [openId, setOpenId] = useState(null);

  const goList = (lever = 'all', status = 'all') => { setOpenId(null); setListLever(lever); setListStatus(status); setTab('List'); };
  const goTab = (t) => { setOpenId(null); setTab(t); };

  const advance = (id) => setProjects((prev) => prev.map((p) => {
    if (p.id !== id) return p;
    const i = STAGES.indexOf(p.stage);
    return i < STAGES.length - 1 ? { ...p, stage: STAGES[i + 1], status: { kind: 'moved' }, in_stage_days: 0 } : p;
  }));
  const setStage = (id, stage) => setProjects((prev) => prev.map((p) => (p.id === id ? { ...p, stage, status: { kind: 'moved' }, in_stage_days: 0 } : p)));
  const breakBarrier = (id) => setProjects((prev) => prev.map((p) => (p.id === id ? { ...p, status: { kind: 'moved' } } : p)));
  const addReading = (id, metricName, value) => setProjects((prev) => prev.map((p) => {
    if (p.id !== id) return p;
    const metrics = (p.metrics || []).map((mm) => (mm.name === metricName ? { ...mm, value, trend: [...(mm.trend || []), value].slice(-8) } : mm));
    const key_metric = p.key_metric && p.key_metric.label === metricName ? { ...p.key_metric, value } : p.key_metric;
    const trend = key_metric && p.key_metric?.label === metricName ? [...p.trend, value].slice(-8) : p.trend;
    return { ...p, metrics, key_metric, trend };
  }));
  const addLearning = (id, body) => setProjects((prev) => prev.map((p) => (p.id === id
    ? { ...p, learnings: [{ date: 'today', tag: 'During', author: 'You', body }, ...(p.learnings || [])] } : p)));

  const openProject = projects.find((p) => p.id === openId) || archive.find((p) => p.id === openId) || null;

  return (
    <div className="flex w-full flex-1 flex-col gap-4">
      {/* header */}
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
        <div className="flex items-center gap-2">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <Rocket className="h-4 w-4" />
          </span>
          <div>
            <h1 className="text-lg font-bold leading-tight">Lean BEAF Pro</h1>
            <p className="text-xs text-muted-foreground">Spec Ops · innovation projects</p>
          </div>
        </div>

        {/* nav */}
        <nav className="order-3 flex w-full gap-1 overflow-x-auto md:order-none md:w-auto">
          {TABS.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => goTab(t)}
              className={`whitespace-nowrap rounded-lg px-3 py-1.5 text-sm font-semibold transition-colors ${
                tab === t && !openId ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {t}
            </button>
          ))}
        </nav>

        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={() => goTab('Meetings')}
            className="hidden items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-semibold text-muted-foreground hover:text-foreground sm:inline-flex"
            title="Meetings"
          >
            <CalendarCheck className="h-3.5 w-3.5" /> Last meeting <b className="text-foreground">{SAMPLE_MEETING.last_ago}</b>
          </button>
          <NewProjectButton onCreate={(p) => { setProjects((prev) => [{ ...p }, ...prev]); }} />
        </div>
      </div>

      {openProject ? (
        <ProjectDetailPage
          project={openProject}
          onBack={() => setOpenId(null)}
          onAdvance={advance} onSetStage={setStage} onBreakBarrier={breakBarrier}
          onAddReading={addReading} onAddLearning={addLearning}
          focused={focusProjects.includes(openProject.id)}
          onToggleFocus={() => requestFocusProject({ id: openProject.id, focusProjects, setFocusProjects, focusCategory, projects })}
        />
      ) : (
        <>
          {tab === 'Dashboard' && (
            <DashboardView
              projects={projects}
              focusCategory={focusCategory} setFocusCategory={setFocusCategory}
              focusProjects={focusProjects} setFocusProjects={setFocusProjects}
              thresholds={thresholds} setThresholds={setThresholds}
              onOpenList={goList} onOpenProject={setOpenId}
            />
          )}
          {tab === 'Meetings' && <MeetingsView projects={projects} onOpenList={goList} onOpenProject={setOpenId} />}
          {tab === 'List' && (
            <ListView
              projects={projects} lever={listLever} status={listStatus}
              setLever={setListLever} setStatus={setListStatus}
              focusProjects={focusProjects} onToggleFocus={(id) => requestFocusProject({ id, focusProjects, setFocusProjects, focusCategory, projects })}
              onOpenProject={setOpenId} onOpenArchive={() => setTab('Archive')} onOpenStage={() => setTab('Board')}
            />
          )}
          {tab === 'Board' && <BoardView projects={projects} onAdvance={advance} onOpenProject={setOpenId} />}
          {tab === 'Archive' && <ArchiveView archive={archive} onOpenProject={setOpenId} />}
        </>
      )}

      {/* narrow-only assistant reach (the dock offers it on wide screens) */}
      {assistantAvailable && (
        <button
          type="button"
          onClick={() => setAssistant?.(true)}
          className="fixed bottom-4 right-4 z-40 inline-flex items-center gap-1.5 rounded-full bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground shadow-lg lg:hidden"
        >
          <Sparkles className="h-4 w-4" /> Ask AI
        </button>
      )}
    </div>
  );
}

// Focus a project with the two guard rails (swap when >3, confirm when outside
// the focused category). Uses window.confirm for the mockup's guard prompts.
function requestFocusProject({ id, focusProjects, setFocusProjects, focusCategory, projects }) {
  if (focusProjects.includes(id)) { setFocusProjects(focusProjects.filter((x) => x !== id)); return; }
  const project = projects.find((p) => p.id === id);
  if (focusCategory && project && !project.levers.includes(focusCategory)) {
    // eslint-disable-next-line no-alert
    if (!window.confirm(`${project.name} is not part of ${LEVERS[focusCategory].label}. Focus anyway?`)) return;
  }
  if (focusProjects.length >= 3) {
    // eslint-disable-next-line no-alert
    const drop = window.confirm(`Three projects are already focused. OK to swap out the first (${projects.find((p) => p.id === focusProjects[0])?.name})?`);
    if (!drop) return;
    setFocusProjects([...focusProjects.slice(1), id]);
    return;
  }
  setFocusProjects([...focusProjects, id]);
}

// ============================ Dashboard ============================

function DashboardView({ projects, focusCategory, setFocusCategory, focusProjects, setFocusProjects, thresholds, setThresholds, onOpenList, onOpenProject }) {
  const [gearOpen, setGearOpen] = useState(false);
  const m = SAMPLE_METRICS;

  const toggleCat = (lever) => setFocusCategory((c) => (c === lever ? null : lever));
  const chargeBreach = thresholds.charge?.change != null && Math.abs(m.charge.delta) > thresholds.charge.change;

  const dimOf = (lever) => focusCategory && focusCategory !== lever;

  return (
    <div className="flex flex-col gap-3">
      {focusCategory && (
        <WeeklyFocusStrip
          category={focusCategory} projects={projects} focusProjects={focusProjects}
          onUnfocus={(id) => setFocusProjects(focusProjects.filter((x) => x !== id))}
          onOpenProject={onOpenProject}
        />
      )}

      <div className="-mb-1 flex justify-end">
        <button type="button" onClick={() => setGearOpen(true)} className="flex h-8 w-8 items-center justify-center rounded-lg border text-muted-foreground hover:text-foreground" title="Metric thresholds">
          <Settings className="h-4 w-4" />
        </button>
      </div>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-4">
        <VolumeCard data={m.volume} dim={dimOf('volume')} focused={focusCategory === 'volume'} onFocus={() => toggleCat('volume')} onOpenList={onOpenList} onOpenProject={onOpenProject} projects={projects} />
        <ChargeCard data={m.charge} dim={dimOf('charge')} focused={focusCategory === 'charge'} breach={chargeBreach} threshold={thresholds.charge} onFocus={() => toggleCat('charge')} onOpenList={onOpenList} onOpenProject={onOpenProject} projects={projects} />
        <AttributedCard data={m.attributed} dim={dimOf('experience')} focused={focusCategory === 'experience'} onFocus={() => toggleCat('experience')} onOpenList={onOpenList} onOpenProject={onOpenProject} projects={projects} />
        <PerAppointmentCard data={m.perAppointment} dim={dimOf('efficiency')} focused={focusCategory === 'efficiency'} onFocus={() => toggleCat('efficiency')} onOpenList={onOpenList} onOpenProject={onOpenProject} projects={projects} />
      </div>

      {/* overall impact from the LBP portfolio (by lever) — at the bottom */}
      <ImpactCard onOpenList={onOpenList} />

      <ThresholdsDialog open={gearOpen} onOpenChange={setGearOpen} thresholds={thresholds} onSave={setThresholds} />
    </div>
  );
}

// Card shell: title with lever-colored underline, focus toggle, and the
// dim / focus-ring / hover-reveal attention machinery.
function MetricCard({ lever, title, source, focused, dim, breach, onFocus, span = '', children, footer }) {
  const l = LEVERS[lever];
  const rootDim = dim && !breach;
  return (
    <div
      className={`group flex flex-col rounded-xl border bg-card p-4 transition-all ${span} ${
        focused ? `ring-2 ${l.ring} ring-offset-2 ring-offset-background` : ''
      } ${rootDim ? 'opacity-45 hover:opacity-100' : ''}`}
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0">
          <h3 className="text-base font-semibold leading-tight">{title}</h3>
          <span className={`mt-1 block h-[3px] w-8 rounded-full ${l.underline}`} />
          {source && <span className={`mt-1.5 block text-[11px] text-muted-foreground ${breach && dim ? 'opacity-40' : 'opacity-60 group-hover:opacity-100'} transition-opacity`}>{source}</span>}
        </div>
        <div className="ml-auto flex items-center gap-1.5">
          {breach && (
            <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-bold text-amber-600 dark:text-amber-400" title="A configured threshold was crossed">
              ⚠ threshold
            </span>
          )}
          <FocusToggle active={focused} onClick={onFocus} />
        </div>
      </div>
      {children}
      {footer}
    </div>
  );
}

// footer chips: lever chip (jumps to List filtered) + project chips
function CardFooter({ lever, projectIds, projects, onOpenList, onOpenProject, quiet }) {
  return (
    <div className={`mt-auto flex flex-wrap items-center gap-2 border-t pt-2.5 ${quiet} transition-opacity`}>
      <LeverChip leverKey={lever} onClick={() => onOpenList(lever)} />
      <span className="text-[11px] text-muted-foreground">{projectIds.length} project{projectIds.length === 1 ? '' : 's'}:</span>
      {projectIds.map((id) => {
        const p = projects.find((x) => x.id === id);
        if (!p) return null;
        return (
          <button key={id} type="button" onClick={() => onOpenProject(id)} className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground hover:text-foreground">
            {p.name}
          </button>
        );
      })}
    </div>
  );
}

function VolumeCard({ data, dim, focused, onFocus, onOpenList, onOpenProject, projects }) {
  const quiet = 'opacity-60 group-hover:opacity-100';
  return (
    <MetricCard lever="volume" title="Volume & capacity" source="Scheduler · live" span="lg:col-span-2" focused={focused} dim={dim} onFocus={onFocus}
      footer={<CardFooter lever="volume" projectIds={data.projects} projects={projects} onOpenList={onOpenList} onOpenProject={onOpenProject} quiet={quiet} />}
    >
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <b className="text-3xl font-extrabold leading-none">{data.hero_pct}<span className="text-base">%</span></b>
        <DeltaPill delta={`${data.delta_pts} pts`} dir={data.delta_dir} good="up" prefix="" />
        <span className={`text-xs text-muted-foreground ${quiet} transition-opacity`}>{data.slots_booked} of {data.slots_total} slots this 6-day week · vs prior 4-wk avg</span>
      </div>
      <div className="mt-3"><VolumeBars days={data.days} /></div>
      <p className={`mt-2 text-xs text-muted-foreground ${quiet} transition-opacity`}>notch on each bar = that day's prior 4-wk average · {data.caption}</p>
    </MetricCard>
  );
}

function ChargeCard({ data, dim, focused, breach, onFocus, onOpenList, onOpenProject, projects }) {
  const quiet = breach && dim ? 'opacity-40' : 'opacity-60 group-hover:opacity-100';
  return (
    <MetricCard lever="charge" title="Charge per visit" focused={focused} dim={dim} breach={breach} onFocus={onFocus}
      footer={<CardFooter lever="charge" projectIds={data.projects} projects={projects} onOpenList={onOpenList} onOpenProject={onOpenProject} quiet={quiet} />}
    >
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <b className="text-3xl font-extrabold leading-none">${data.hero}</b>
        <DeltaPill delta={`$${data.delta}`} dir={data.delta_dir} good="up" className={breach ? 'ring-2 ring-amber-400/60' : ''} />
      </div>
      <div className={`mt-2 ${quiet} transition-opacity`}>
        <Sparkline points={data.spark} className="h-8 w-28" />
        <span className="mt-1 block text-[11px] text-muted-foreground">vs prior 4-wk avg (${data.prior}) · {data.source}</span>
      </div>
      <div className={`mt-3 space-y-1.5 border-t pt-3 ${quiet} transition-opacity`}>
        {data.secondary.map((s) => (
          <div key={s.label} className="flex items-center gap-2 text-xs">
            <span className="text-muted-foreground">{s.label}</span>
            <span className="ml-auto font-semibold tabular-nums">{s.value}</span>
            {s.delta && <span className={`text-[11px] ${s.bad ? 'text-red-600 dark:text-red-400' : 'text-green-600 dark:text-green-400'}`}>{s.dir === 'up' ? '↑' : '↓'} {s.delta}</span>}
          </div>
        ))}
      </div>
    </MetricCard>
  );
}

function AttributedCard({ data, dim, focused, onFocus, onOpenList, onOpenProject, projects }) {
  const quiet = 'opacity-60 group-hover:opacity-100';
  return (
    <MetricCard lever="experience" title="Attributed lives" focused={focused} dim={dim} onFocus={onFocus}
      footer={<CardFooter lever="experience" projectIds={data.projects} projects={projects} onOpenList={onOpenList} onOpenProject={onOpenProject} quiet={quiet} />}
    >
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <b className="text-3xl font-extrabold leading-none tabular-nums">{data.hero.toLocaleString()}</b>
        <DeltaPill delta={data.delta} dir={data.delta_dir} good="up" />
        <span className={`text-xs text-muted-foreground ${quiet} transition-opacity`}>{data.delta_note}</span>
      </div>
      <div className={`mt-4 ${quiet} transition-opacity`}><RecencyStack segments={data.recency} /></div>
      <div className={`mt-3 space-y-1.5 border-t pt-3 ${quiet} transition-opacity`}>
        <div className="flex items-center text-xs"><span className="text-muted-foreground">Frequency</span><span className="ml-auto font-semibold tabular-nums">{data.frequency}</span></div>
        <div className="flex items-center gap-2 text-xs">
          <span className="text-muted-foreground">Monetization</span>
          <span className="ml-auto font-semibold tabular-nums">{data.monetization}</span>
          <span className="text-[11px] text-green-600 dark:text-green-400">↑ {data.monetization_delta}</span>
        </div>
      </div>
    </MetricCard>
  );
}

function PerAppointmentCard({ data, dim, focused, onFocus, onOpenList, onOpenProject, projects }) {
  const [seg, setSeg] = useState('primary');
  const quiet = 'opacity-60 group-hover:opacity-100';
  const active = data.segments.find((s) => s.key === seg) || data.segments[0];
  return (
    <MetricCard lever="efficiency" title="Per appointment" source="all staff & all cost averaged" span="lg:col-span-4" focused={focused} dim={dim} onFocus={onFocus}
      footer={<CardFooter lever="efficiency" projectIds={data.projects} projects={projects} onOpenList={onOpenList} onOpenProject={onOpenProject} quiet={quiet} />}
    >
      {/* segmented control sits at the top-right; the three stats spread evenly
          across the full width with generous spacing (clean, airy). */}
      <div className="mt-2 flex justify-end">
        <div className="flex gap-0.5 rounded-lg border bg-muted/40 p-0.5">
          {data.segments.map((s) => (
            <button key={s.key} type="button" onClick={() => setSeg(s.key)}
              className={`rounded-md px-4 py-1.5 text-xs font-semibold transition-colors ${seg === s.key ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground'}`}>
              {s.label}
            </button>
          ))}
        </div>
      </div>
      <div className="mt-4 grid grid-cols-1 gap-6 pb-1 sm:grid-cols-3 sm:gap-4">
        {active.stats.map((s) => (
          <div key={s.label}>
            <span className={`block text-xs text-muted-foreground ${quiet} transition-opacity`}>{s.label}</span>
            <b className="mt-1 block text-2xl font-extrabold tabular-nums">{s.value}</b>
            <div className="mt-1.5 flex items-center gap-2">
              <DeltaPill delta={s.delta} dir={s.dir} good={s.good} suffix="" />
              <span className={`text-[11px] text-muted-foreground ${quiet} transition-opacity`}>vs prior qtr</span>
            </div>
          </div>
        ))}
      </div>
    </MetricCard>
  );
}

function WeeklyFocusStrip({ category, projects, focusProjects, onUnfocus, onOpenProject }) {
  const l = category ? LEVERS[category] : null;
  const items = focusProjects.map((id) => projects.find((p) => p.id === id)).filter(Boolean);
  const hasCat = !!l; const hasProj = items.length > 0;
  return (
    <div className="rounded-xl border-l-4 border-l-primary bg-card p-4" style={{ borderLeftColor: 'hsl(var(--primary))' }}>
      <div className="mb-3 flex items-center gap-2">
        <Target className="h-4 w-4 text-primary" />
        <b className="text-sm">This week's focus</b>
        <span className="text-xs text-muted-foreground">resets Monday morning</span>
      </div>
      <div className="flex flex-col gap-4 sm:flex-row">
        {hasCat && (
          <div className={hasProj ? 'sm:w-1/3' : 'flex-1'}>
            <LeverChip leverKey={category} className="mb-2" />
            <span className="ml-1 text-xs text-muted-foreground">· category</span>
            <p className="mt-1 text-sm text-muted-foreground">{l.blurb}</p>
          </div>
        )}
        {hasProj && (
          <div className={`flex flex-1 flex-col gap-2 ${hasCat ? 'sm:border-l sm:pl-4' : ''}`}>
            {items.map((p) => (
              <div key={p.id} className="flex items-center gap-2 rounded-lg border px-3 py-2">
                <button type="button" onClick={() => onOpenProject(p.id)} className="min-w-0 flex-1 text-left text-sm font-semibold hover:underline">{p.name}</button>
                <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${LEVERS[p.levers[0]].chip}`}>{p.stage}</span>
                <button type="button" onClick={() => onUnfocus(p.id)} className="text-muted-foreground hover:text-foreground" title="Unfocus"><X className="h-4 w-4" /></button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// Overall impact from the LBP portfolio, aggregated by lever, over a chosen
// date range (default: last week). Sample numbers until a source is connected.
function ImpactCard({ onOpenList }) {
  const [range, setRange] = useState('last_week');
  const data = SAMPLE_IMPACT[range];
  return (
    <div className="rounded-xl border bg-gradient-to-br from-card to-muted/30 p-4">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <TrendingUp className="h-4 w-4" />
        </span>
        <div>
          <b className="text-base">Impact from Lean BEAF projects</b>
          <p className="text-xs text-muted-foreground">{data.headline} · {data.sub}</p>
        </div>
        <div className="ml-auto w-full sm:w-52">
          <Select value={range} onValueChange={setRange}>
            <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
            <SelectContent>
              {IMPACT_RANGES.map((r) => <SelectItem key={r.key} value={r.key}>{r.label}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {data.levers.map((l) => {
          const lv = LEVERS[l.key];
          const good = l.dir === l.good;
          return (
            <button
              key={l.key}
              type="button"
              onClick={() => onOpenList(l.key)}
              className={`rounded-xl border p-3 text-left transition-colors hover:border-primary/40 ${lv.soft}`}
              title={`View ${lv.label} projects`}
            >
              <span className="flex items-center gap-1.5">
                <i className={`h-2.5 w-2.5 rounded-full ${lv.dot}`} />
                <span className="text-xs font-bold">{lv.label}</span>
              </span>
              <b className={`mt-1.5 block text-2xl font-extrabold tabular-nums ${good ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>{l.value}</b>
              <span className="block text-[11px] text-muted-foreground">{l.note}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ============================ Meetings ============================

function MeetingsView({ projects, onOpenList, onOpenProject }) {
  const { toast } = useToast();
  const [open, setOpen] = useState(null); // expanded history id
  const [settingsOpen, setSettingsOpen] = useState(false);
  const byId = (id) => projects.find((p) => p.id === id);

  const moved = projects.filter((p) => p.status.kind === 'moved');
  const blocked = projects.filter((p) => p.status.kind === 'blocked');
  const noMove = projects.filter((p) => p.status.kind === 'idle');

  const Band = ({ tone, icon, label, items, filter }) => {
    const tones = {
      green: 'bg-green-500/8 border-l-green-500', red: 'bg-red-500/8 border-l-red-500', amber: 'bg-amber-500/8 border-l-amber-500',
    };
    const heads = { green: 'text-green-600 dark:text-green-400', red: 'text-red-600 dark:text-red-400', amber: 'text-amber-600 dark:text-amber-400' };
    return (
      <div className={`rounded-xl border border-l-4 p-4 ${tones[tone]}`}>
        <button type="button" onClick={() => onOpenList('all', filter)} className={`mb-2 flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide ${heads[tone]}`}>
          {icon} {label} <span className="text-foreground/70">{items.length}</span>
        </button>
        {items.length === 0 ? <p className="text-sm text-muted-foreground">Nothing here.</p> : (
          <div className="space-y-2">
            {items.slice(0, 5).map((p) => (
              <button key={p.id} type="button" onClick={() => onOpenProject(p.id)} className="flex w-full flex-wrap items-center gap-2 text-left">
                <span className="text-sm font-semibold">{p.name}</span>
                {p.levers.map((lv) => <LeverChip key={lv} leverKey={lv} />)}
              </button>
            ))}
            {items.length > 5 && <button type="button" onClick={() => onOpenList('all', filter)} className="text-xs font-semibold text-primary">+{items.length - 5} more →</button>}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-4">
      <div className="rounded-xl border bg-card p-5">
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <div>
            <h2 className="text-lg font-bold leading-tight">Since last meeting</h2>
            <p className="text-xs text-muted-foreground">{SAMPLE_MEETING.window_from} → {SAMPLE_MEETING.window_to} · next: {SAMPLE_MEETING.next}</p>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <button type="button" onClick={() => setSettingsOpen(true)} className="flex h-9 w-9 items-center justify-center rounded-lg border text-muted-foreground hover:text-foreground" title="Meeting settings"><Settings className="h-4 w-4" /></button>
            <Button className="h-9" onClick={() => toast({ title: 'Meeting marked', description: 'Movement now counts from this point.' })}>Mark meeting now</Button>
          </div>
        </div>
        <div className="space-y-3">
          <Band tone="green" icon={<ArrowRight className="h-3.5 w-3.5" />} label="Moved" items={moved} filter="moved" />
          <Band tone="red" icon={<Flag className="h-3.5 w-3.5" />} label="Blocked" items={blocked} filter="blocked" />
          <Band tone="amber" icon="◔" label="No movement" items={noMove} filter="idle" />
        </div>
      </div>

      <div className="rounded-xl border bg-card p-5">
        <div className="mb-3 flex items-center gap-2">
          <b className="text-xs font-bold uppercase tracking-wide text-muted-foreground">Meeting history</b>
          <span className="text-xs text-muted-foreground">each meeting keeps its digest, AI chats &amp; findings</span>
        </div>
        <div className="divide-y">
          {SAMPLE_MEETING.history.map((h) => (
            <div key={h.id}>
              <button type="button" onClick={() => setOpen(open === h.id ? null : h.id)} className="flex w-full items-center gap-2 py-2.5 text-left">
                {open === h.id ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
                <b className="text-sm">{h.ago}</b>
                <span className="text-xs text-muted-foreground">{h.at}</span>
                <span className={`ml-auto rounded-full px-2 py-0.5 text-[10px] font-semibold ${h.source === 'Manual' ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground'}`}>{h.source}</span>
              </button>
              {open === h.id && (
                <div className="pb-3 pl-6 text-sm text-muted-foreground">
                  Frozen snapshot from this meeting: {moved.length} moved, {blocked.length} blocked, {noMove.length} no-movement. AI chats &amp; findings from this window are kept here.
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      <MeetingSettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
    </div>
  );
}

// ============================ List ============================

function ListView({ projects, lever, status, setLever, setStatus, focusProjects, onToggleFocus, onOpenProject, onOpenArchive, onOpenStage }) {
  const pipeline = useMemo(() => STAGES.map((s) => ({ stage: s, count: projects.filter((p) => p.stage === s).length })), [projects]);
  const leverCounts = useMemo(() => {
    const c = { volume: 0, charge: 0, efficiency: 0, experience: 0 };
    for (const p of projects) for (const l of p.levers) c[l] += 1;
    return c;
  }, [projects]);

  const rows = projects.filter((p) => (lever === 'all' || p.levers.includes(lever)) && (status === 'all' || p.status.kind === status));

  return (
    <div className="flex flex-col gap-3">
      {/* pipeline strip */}
      <div className="rounded-xl border bg-card p-4">
        <div className="mb-2 text-[11px] font-bold uppercase tracking-wide text-muted-foreground">Rollout pipeline</div>
        <div className="flex items-stretch gap-1">
          {pipeline.map((s, i) => (
            <Fragment key={s.stage}>
              <button type="button" onClick={onOpenStage} className={`flex flex-1 basis-0 flex-col rounded-lg border px-2 py-2.5 text-left transition-colors hover:border-primary/50 ${s.count === 0 ? 'opacity-45' : ''}`}>
                <b className="text-xl leading-none tabular-nums">{s.count}</b>
                <span className="mt-1 text-[10px] font-bold tracking-wide text-muted-foreground">{s.stage}</span>
                <span className="mt-1 h-0.5 w-6 rounded-full bg-blue-500/60" />
              </button>
              {i < pipeline.length - 1 && <span className="flex items-center text-muted-foreground/40"><ChevronRight className="h-4 w-4" /></span>}
            </Fragment>
          ))}
        </div>
        <p className="mt-2 text-xs text-muted-foreground">2 finished projects — 1 rolled out, 1 abandoned · <button type="button" onClick={onOpenArchive} className="font-bold text-primary">view learnings in the Archive →</button></p>
      </div>

      {/* filters */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs font-semibold text-muted-foreground">Lever:</span>
          <FilterChip active={lever === 'all'} onClick={() => setLever('all')}>All · {projects.length}</FilterChip>
          {LEVER_ORDER.map((k) => (
            <button key={k} type="button" onClick={() => setLever(k)} className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium ${lever === k ? `${LEVERS[k].border} ${LEVERS[k].chip}` : 'border-border text-muted-foreground'}`}>
              <i className={`h-2 w-2 rounded-full ${LEVERS[k].dot}`} /> {LEVERS[k].label} · {leverCounts[k]}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs font-semibold text-muted-foreground">Status:</span>
          {[['all', 'All'], ['moved', 'Moved'], ['blocked', 'Blocked'], ['idle', 'No movement']].map(([k, lbl]) => (
            <FilterChip key={k} active={status === k} onClick={() => setStatus(k)}>{lbl}</FilterChip>
          ))}
        </div>
      </div>

      {/* dense table */}
      <div className="overflow-x-auto rounded-xl border">
        <table className="w-full min-w-[900px] border-collapse text-sm">
          <thead className="bg-muted/50">
            <tr className="text-left text-[11px] uppercase tracking-wide text-muted-foreground">
              <th className="w-8 px-2 py-2"></th>
              <th className="px-3 py-2 font-semibold">Project</th>
              <th className="px-3 py-2 font-semibold">Levers</th>
              <th className="px-3 py-2 font-semibold">Stage</th>
              <th className="px-3 py-2 font-semibold">Status</th>
              <th className="px-3 py-2 font-semibold">Owner</th>
              <th className="px-3 py-2 font-semibold">Started</th>
              <th className="px-3 py-2 font-semibold">In stage</th>
              <th className="px-3 py-2 font-semibold">Key metric</th>
              <th className="px-3 py-2 text-right font-semibold">Trend</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => (
              <tr key={p.id} className="cursor-pointer border-t transition-colors hover:bg-accent/40" onClick={() => onOpenProject(p.id)}>
                <td className="px-2 py-3">
                  <button type="button" onClick={(e) => { e.stopPropagation(); onToggleFocus(p.id); }} className={`text-lg leading-none ${focusProjects.includes(p.id) ? 'text-amber-400' : 'text-muted-foreground/40 hover:text-muted-foreground'}`} title="Focus this week">
                    {focusProjects.includes(p.id) ? '★' : '☆'}
                  </button>
                </td>
                <td className="px-3 py-3">
                  <span className="block font-semibold">{p.name}</span>
                  <BeafTags tags={p.beaf} />
                </td>
                <td className="px-3 py-3"><LeverDots levers={p.levers} /></td>
                <td className="px-3 py-3"><span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ${LEVERS[p.levers[0]].chip}`}><i className={`h-1.5 w-1.5 rounded-full ${LEVERS[p.levers[0]].dot}`} />{p.stage}</span></td>
                <td className="px-3 py-3"><StatusChip status={p.status} /></td>
                <td className="px-3 py-3"><OwnerAvatar initials={p.owner} /></td>
                <td className="whitespace-nowrap px-3 py-3 text-xs tabular-nums text-muted-foreground">{fmtDate(p.started)}</td>
                <td className="whitespace-nowrap px-3 py-3 text-xs tabular-nums text-muted-foreground">{p.in_stage_days}d</td>
                <td className="px-3 py-3">
                  {p.key_metric ? (
                    <span className="block">
                      <b className="tabular-nums">{p.key_metric.value}{p.key_metric.unit}</b>{' '}
                      <span className="text-xs text-muted-foreground">{p.key_metric.label}</span>{' '}
                      <span className={`text-[11px] ${p.key_metric.dir === p.key_metric.good ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
                        {p.key_metric.dir === 'up' ? '↑' : '↓'} {p.key_metric.delta}{p.key_metric.unit}
                      </span>
                    </span>
                  ) : <span className="text-xs text-muted-foreground">No metric yet</span>}
                </td>
                <td className="px-3 py-3"><div className="flex justify-end"><Sparkline points={p.trend} className="h-6 w-16" /></div></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function FilterChip({ active, onClick, children }) {
  return (
    <button type="button" onClick={onClick} className={`whitespace-nowrap rounded-full border px-2.5 py-1 text-xs font-medium ${active ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground'}`}>{children}</button>
  );
}

// ============================ Board ============================

function BoardView({ projects, onAdvance, onOpenProject }) {
  const scrollRef = useRef(null);
  const edgeRef = useRef({ dir: 0, speed: 0 });
  const rafRef = useRef(null);

  const step = useCallback(() => {
    const el = scrollRef.current; const { dir, speed } = edgeRef.current;
    if (el && dir !== 0) el.scrollLeft += dir * speed;
    if (edgeRef.current.dir !== 0) rafRef.current = requestAnimationFrame(step); else rafRef.current = null;
  }, []);
  const onMove = useCallback((clientX) => {
    const el = scrollRef.current; if (!el) return;
    const r = el.getBoundingClientRect(); const EDGE = 90; const MAX = 20;
    const ld = clientX - r.left; const rd = r.right - clientX;
    if (ld >= 0 && ld < EDGE) edgeRef.current = { dir: -1, speed: MAX * (1 - ld / EDGE) };
    else if (rd >= 0 && rd < EDGE) edgeRef.current = { dir: 1, speed: MAX * (1 - rd / EDGE) };
    else edgeRef.current = { dir: 0, speed: 0 };
    if (edgeRef.current.dir !== 0 && rafRef.current == null) rafRef.current = requestAnimationFrame(step);
  }, [step]);

  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">Hover near an edge to scroll. Use Advance to move a card to the next stage.</p>
      <div ref={scrollRef} className="flex gap-2.5 overflow-x-auto p-1 pb-3" onMouseMove={(e) => onMove(e.clientX)} onMouseLeave={() => { edgeRef.current = { dir: 0, speed: 0 }; }}>
        {STAGES.map((stage) => {
          const cards = projects.filter((p) => p.stage === stage);
          const empty = cards.length === 0;
          return (
            <div key={stage} className={`${empty ? 'w-14' : 'w-[250px]'} shrink-0 rounded-xl border bg-muted/30 p-2 transition-all`}>
              <div className={`mb-2 flex items-center px-1 ${empty ? 'flex-col gap-1' : 'justify-between'}`}>
                <span className={`text-xs font-bold uppercase tracking-wide text-muted-foreground ${empty ? '[writing-mode:vertical-rl]' : ''}`}>{stage}</span>
                <span className="text-xs font-bold text-primary">{cards.length}</span>
              </div>
              {!empty && (
                <div className="flex flex-col gap-2">
                  {cards.map((p) => (
                    <div key={p.id} className="rounded-lg border bg-card p-3">
                      <button type="button" onClick={() => onOpenProject(p.id)} className="block w-full text-left">
                        <span className="flex items-center gap-1.5">
                          <LeverDots levers={p.levers} size="h-2 w-2" />
                          <span className="min-w-0 flex-1 truncate text-sm font-semibold">{p.name}</span>
                        </span>
                        <span className="mt-1.5 flex flex-wrap items-center gap-1.5"><StatusChip status={p.status} /></span>
                        {p.key_metric && <span className="mt-1.5 block text-[11px] text-muted-foreground"><b className="text-foreground tabular-nums">{p.key_metric.value}{p.key_metric.unit}</b> {p.key_metric.label}</span>}
                        <span className="mt-1.5 flex items-center gap-1.5 text-[11px] text-muted-foreground"><OwnerAvatar initials={p.owner} /> · {p.in_stage_days}d in stage</span>
                      </button>
                      {stage !== 'All' && (
                        <button type="button" onClick={() => onAdvance(p.id)} className="mt-2 inline-flex h-8 items-center gap-1 rounded-md border px-2 text-xs font-semibold text-primary">Advance <ChevronRight className="h-3 w-3" /></button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ============================ Archive ============================

function ArchiveView({ archive, onOpenProject }) {
  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-3">
      <p className="text-sm text-muted-foreground">Finished projects — the corpus the AI mines for patterns.</p>
      {archive.map((p) => {
        const rolled = p.outcome === 'rolled_out';
        return (
          <button key={p.id} type="button" onClick={() => onOpenProject(p.id)} className="rounded-xl border bg-card p-4 text-left transition-colors hover:border-primary/40">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-base font-semibold">{p.name}</h3>
              <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ${rolled ? 'bg-green-500/10 text-green-600 dark:text-green-400' : 'bg-red-500/10 text-red-600 dark:text-red-400'}`}>
                {rolled ? '✓ Rolled out' : '✕ Abandoned'}
              </span>
              {p.levers.map((lv) => <LeverChip key={lv} leverKey={lv} />)}
              <span className="ml-auto text-xs text-muted-foreground">{p.span}</span>
            </div>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{p.outcome_text}</p>
            <p className="mt-2 text-xs font-semibold text-muted-foreground">Measured: {p.measured}</p>
          </button>
        );
      })}
    </div>
  );
}

// ============================ Project detail (whole-page) ============================

function ProjectDetailPage({ project, onBack, onAdvance, onSetStage, onBreakBarrier, onAddReading, onAddLearning, focused, onToggleFocus }) {
  const archived = !!project.outcome;
  const stageIdx = STAGES.indexOf(project.stage);
  const nextStage = stageIdx < STAGES.length - 1 ? STAGES[stageIdx + 1] : null;
  const metrics = project.metrics || [];
  const learnings = project.learnings || [];
  const scope = project.scope || {};
  const [metricSel, setMetricSel] = useState(metrics[0]?.name || '');
  const [reading, setReading] = useState('');
  const [learn, setLearn] = useState('');

  return (
    <div className="mx-auto w-full max-w-4xl space-y-4">
      {/* breadcrumb */}
      <button type="button" onClick={onBack} className="inline-flex items-center gap-1 text-sm font-semibold text-primary">
        <ArrowLeft className="h-4 w-4" /> Lean BEAF Pro <span className="text-muted-foreground">/ {project.name}</span>
      </button>

      {/* title + actions */}
      <div className="flex flex-wrap items-start gap-3">
        <h1 className="text-2xl font-extrabold leading-tight">{project.name}</h1>
        {!archived && (
          <div className="ml-auto flex items-center gap-2">
            <button type="button" onClick={onToggleFocus} className={`inline-flex items-center gap-1 rounded-lg border px-3 py-1.5 text-xs font-semibold ${focused ? 'border-amber-400 bg-amber-400/10 text-amber-600 dark:text-amber-400' : 'border-border text-muted-foreground hover:text-foreground'}`}>
              {focused ? '★ Focused this week' : '◎ Focus this week'}
            </button>
            <button type="button" className="flex h-9 w-9 items-center justify-center rounded-lg border text-muted-foreground" title="Edit"><Pencil className="h-4 w-4" /></button>
          </div>
        )}
      </div>

      {/* meta chips */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs text-muted-foreground"><Play className="h-3 w-3" /> {fmtDate(project.started)}</span>
        {!archived && <span className="inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs text-muted-foreground"><Clock className="h-3 w-3" /> {project.in_stage_days}d in stage</span>}
        <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold ${LEVERS[project.levers[0]].chip}`}><i className={`h-1.5 w-1.5 rounded-full ${LEVERS[project.levers[0]].dot}`} /> {archived ? project.final_stage : project.stage}</span>
        {!archived && <StatusChip status={project.status} />}
        {project.levers.map((lv) => <LeverChip key={lv} leverKey={lv} />)}
        <span className="inline-flex items-center gap-1.5"><OwnerAvatar initials={project.owner || 'ME'} /></span>
      </div>

      {/* stage stepper + actions */}
      {!archived && (
        <div className="rounded-xl border bg-card p-5">
          <div className="flex items-start">
            {STAGES.map((s, i) => (
              <button key={s} type="button" onClick={() => onSetStage(project.id, s)} className="group relative flex flex-1 flex-col items-center" title={i === stageIdx ? `Currently at ${s}` : `Move to ${s}`}>
                {i < STAGES.length - 1 && <span className={`pointer-events-none absolute left-[calc(50%+10px)] right-[calc(-50%+10px)] top-[9px] h-0.5 ${i < stageIdx ? 'bg-primary/60' : 'bg-border'}`} />}
                <span className={`z-10 h-5 w-5 rounded-full border-2 ${i < stageIdx ? 'border-primary/60 bg-primary/60' : i === stageIdx ? 'border-primary bg-primary ring-4 ring-primary/15' : 'border-border bg-muted group-hover:border-primary'}`} />
                <span className={`mt-1.5 text-[11px] font-bold ${i === stageIdx ? 'text-primary' : 'text-muted-foreground'}`}>{s}</span>
              </button>
            ))}
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            {nextStage && <Button className="h-9" onClick={() => onAdvance(project.id)}>Advance to {nextStage} ›</Button>}
            <Button variant="outline" className="h-9 border-green-500/50 text-green-600 dark:text-green-400" onClick={() => onSetStage(project.id, 'All')}>✓ Rolled out</Button>
            <Button variant="outline" className="h-9 border-red-500/50 text-red-600 dark:text-red-400">✕ Abandon</Button>
            <span className="ml-auto text-xs text-muted-foreground">Tap any stage to move there — forward or back</span>
          </div>
        </div>
      )}

      {/* blocker banner */}
      {!archived && project.status.kind === 'blocked' && (
        <div className="rounded-xl border border-red-500/40 bg-red-500/5 p-4">
          <p className="text-sm font-semibold text-red-600 dark:text-red-400"><Flag className="mr-1 inline h-3.5 w-3.5" /> Blocked · {project.status.days}d</p>
          <p className="mt-0.5 text-sm text-muted-foreground">{project.status.reason}</p>
          <Button size="sm" variant="outline" className="mt-2 h-8" onClick={() => onBreakBarrier(project.id)}>Break barrier</Button>
        </div>
      )}

      {/* what & why */}
      <div className="rounded-xl border bg-card p-5">
        <span className="text-xs font-bold uppercase tracking-wide text-muted-foreground">What &amp; why</span>
        <p className="mt-2 text-sm leading-relaxed">{project.description}</p>
        <div className="mt-3 flex flex-wrap gap-1.5">
          {project.beaf.map((b) => <span key={b} className="rounded-full bg-emerald-500/10 px-2.5 py-0.5 text-[11px] font-semibold text-emerald-600 dark:text-emerald-400">{b}</span>)}
        </div>
        {!archived && (
          <div className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-2 border-t pt-3 text-xs">
            <ScopeChip label="Testing" value={scope.testing} />
            <ScopeChip label="Site" value={scope.site} />
            <ScopeChip label="PODs" value={(scope.pods || []).join(', ')} />
            <ScopeChip label="Region" value={scope.region} />
          </div>
        )}
      </div>

      {/* archived outcome, or metrics */}
      {archived ? (
        <div className="rounded-xl border bg-card p-5">
          <span className="text-xs font-bold uppercase tracking-wide text-muted-foreground">Outcome</span>
          <p className="mt-2 text-sm leading-relaxed">{project.outcome_text}</p>
          <p className="mt-2 text-xs font-semibold text-muted-foreground">Measured: {project.measured}</p>
        </div>
      ) : (
        <div className="rounded-xl border bg-card p-5">
          <div className="mb-3 flex items-center gap-2">
            <span className="text-xs font-bold uppercase tracking-wide text-muted-foreground">Metrics</span>
            <span className="text-xs text-muted-foreground">what we measure &amp; where it comes from</span>
            <Button size="sm" variant="outline" className="ml-auto h-8"><Plus className="mr-1 h-3.5 w-3.5" /> Metric</Button>
          </div>
          {metrics.length === 0 ? <p className="text-sm text-muted-foreground">No metrics yet.</p> : (
            <div className="divide-y">
              {metrics.map((mm) => (
                <div key={mm.name} className="flex flex-wrap items-center gap-3 py-3">
                  <div className="min-w-[180px] flex-1">
                    <b className="text-sm">{mm.name}</b>
                    <div className="mt-1 flex flex-wrap gap-1.5">
                      <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">{mm.source}</span>
                      {mm.target && <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">target {mm.target}</span>}
                    </div>
                  </div>
                  <Sparkline points={mm.trend} className="h-8 w-28" />
                  <div className="text-right">
                    <b className="block text-2xl font-extrabold tabular-nums">{mm.value}{mm.unit}</b>
                    <span className={`text-[11px] font-semibold ${mm.dir === mm.good ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>{mm.dir === 'up' ? '↑' : '↓'} {mm.delta}{mm.unit} {mm.since}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
          {metrics.length > 0 && (
            <div className="mt-3 flex flex-wrap items-center gap-2 border-t pt-3">
              <span className="text-xs font-semibold text-muted-foreground">Quick entry</span>
              <Select value={metricSel} onValueChange={setMetricSel}>
                <SelectTrigger className="h-9 w-full sm:w-56"><SelectValue /></SelectTrigger>
                <SelectContent>{metrics.map((mm) => <SelectItem key={mm.name} value={mm.name}>{mm.name}</SelectItem>)}</SelectContent>
              </Select>
              <Input type="number" value={reading} onChange={(e) => setReading(e.target.value)} placeholder="value" className="h-9 w-full sm:w-28" />
              <Button className="h-9" disabled={reading === ''} onClick={() => { onAddReading(project.id, metricSel, Number(reading)); setReading(''); }}>Add today's reading</Button>
            </div>
          )}
        </div>
      )}

      {/* learnings */}
      {!archived && (
        <div className="rounded-xl border bg-card p-5">
          <div className="mb-3 flex items-center gap-2">
            <span className="text-xs font-bold uppercase tracking-wide text-muted-foreground">Learnings</span>
            <span className="text-xs text-muted-foreground">during &amp; after — feeds the archive and the AI</span>
          </div>
          <div className="mb-3 flex gap-2">
            <Input value={learn} onChange={(e) => setLearn(e.target.value)} placeholder="Capture a learning…" className="h-9" />
            <Button className="h-9" disabled={!learn.trim()} onClick={() => { onAddLearning(project.id, learn.trim()); setLearn(''); }}>Add</Button>
          </div>
          {learnings.length === 0 ? <p className="text-sm text-muted-foreground">No learnings captured yet.</p> : (
            <div className="space-y-3">
              {learnings.map((l, i) => (
                <div key={i} className="flex gap-3">
                  <span className="w-12 shrink-0 pt-0.5 text-xs tabular-nums text-muted-foreground">{l.date}</span>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm">{l.body}</p>
                    <div className="mt-1 flex items-center gap-2">
                      <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${l.tag === 'Outcome' ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground'}`}>{l.tag}</span>
                      <span className="text-[11px] text-muted-foreground">{l.author}</span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ScopeChip({ label, value }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="font-bold uppercase tracking-wide text-muted-foreground">{label}</span>
      {value ? <span className="rounded-full bg-muted px-2 py-0.5 font-medium text-foreground">{value}</span> : <span className="text-muted-foreground">—</span>}
    </span>
  );
}

// ============================ dialogs ============================

function NewProjectButton({ onCreate }) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const [levers, setLevers] = useState(['volume']); // multi-select

  const toggleLever = (k) => setLevers((prev) => (prev.includes(k) ? prev.filter((x) => x !== k) : [...prev, k]));

  const submit = () => {
    if (!name.trim() || levers.length === 0) return;
    onCreate({
      id: `p-${Date.now()}`, name: name.trim(), beaf: [], levers: [...levers], stage: 'Idea', owner: 'ME',
      started: '2026-07-23', in_stage_days: 0, status: { kind: 'idle', days: 0 },
      key_metric: null, trend: [], description: desc.trim() || 'New idea.',
      scope: { testing: null, site: null, pods: [], region: null }, metrics: [], learnings: [],
    });
    toast({ title: 'Project created', description: name.trim() });
    setName(''); setDesc(''); setLevers(['volume']); setOpen(false);
  };

  return (
    <>
      <Button className="h-9" onClick={() => setOpen(true)}><Plus className="mr-1 h-4 w-4" /> New project</Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-full h-full rounded-none sm:max-w-md sm:h-auto sm:rounded-lg overflow-y-auto">
          <DialogHeader><DialogTitle>New project</DialogTitle><DialogDescription>Starts at the Idea stage.</DialogDescription></DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5"><Label>Name</Label><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Online self-scheduling" /></div>
            <div className="space-y-1.5">
              <Label>Levers <span className="font-normal text-muted-foreground">· pick one or more</span></Label>
              <div className="flex flex-wrap gap-2">
                {LEVER_ORDER.map((k) => {
                  const on = levers.includes(k);
                  return (
                    <button key={k} type="button" onClick={() => toggleLever(k)}
                      className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm font-medium ${on ? `${LEVERS[k].border} ${LEVERS[k].chip}` : 'border-border text-muted-foreground'}`}>
                      <i className={`h-2 w-2 rounded-full ${LEVERS[k].dot}`} /> {LEVERS[k].label} {on && '✓'}
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="space-y-1.5"><Label>Description</Label><Input value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="What is it, and what should it change?" /></div>
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" className="h-10" onClick={() => setOpen(false)}>Cancel</Button>
            <Button className="h-10" onClick={submit} disabled={!name.trim() || levers.length === 0}>Create</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function ThresholdsDialog({ open, onOpenChange, thresholds, onSave }) {
  const [draft, setDraft] = useState(thresholds);
  const rows = [['volume', 'Volume & capacity'], ['charge', 'Charge per visit'], ['attributed', 'Attributed lives']];
  const set = (metric, field, v) => setDraft((d) => ({ ...d, [metric]: { ...d[metric], [field]: v === '' ? null : Number(v) } }));
  return (
    <Dialog open={open} onOpenChange={(v) => { if (v) setDraft(thresholds); onOpenChange(v); }}>
      <DialogContent className="max-w-full h-full rounded-none sm:max-w-lg sm:h-auto sm:rounded-lg overflow-y-auto">
        <DialogHeader><DialogTitle>Metric thresholds</DialogTitle><DialogDescription>Blank = disabled. When a card is dimmed by a focus, crossing a threshold makes its hero + delta punch through.</DialogDescription></DialogHeader>
        <div className="space-y-4">
          {rows.map(([k, label]) => (
            <div key={k} className="rounded-lg border p-3">
              <b className="text-sm">{label}</b>
              <div className="mt-2 grid grid-cols-3 gap-2">
                <div className="space-y-1"><Label className="text-[11px]">Standing low</Label><Input type="number" value={draft[k]?.low ?? ''} onChange={(e) => set(k, 'low', e.target.value)} className="h-9" /></div>
                <div className="space-y-1"><Label className="text-[11px]">Standing high</Label><Input type="number" value={draft[k]?.high ?? ''} onChange={(e) => set(k, 'high', e.target.value)} className="h-9" /></div>
                <div className="space-y-1"><Label className="text-[11px]">Change beyond ±</Label><Input type="number" value={draft[k]?.change ?? ''} onChange={(e) => set(k, 'change', e.target.value)} className="h-9" /></div>
              </div>
            </div>
          ))}
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" className="h-10" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button className="h-10" onClick={() => { onSave(draft); onOpenChange(false); }}>Save thresholds</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function MeetingSettingsDialog({ open, onOpenChange }) {
  const [schedules, setSchedules] = useState([{ id: 1, label: 'Weekly · Monday 9:00 AM', active: true }]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-full h-full rounded-none sm:max-w-lg sm:h-auto sm:rounded-lg overflow-y-auto">
        <DialogHeader><DialogTitle>Meeting settings</DialogTitle><DialogDescription>Recurring schedules auto-mark a meeting. Next meeting: {SAMPLE_MEETING.next}.</DialogDescription></DialogHeader>
        <div className="space-y-2">
          {schedules.map((s) => (
            <div key={s.id} className="flex items-center gap-2 rounded-lg border p-3">
              <CalendarCheck className={`h-4 w-4 ${s.active ? 'text-primary' : 'text-muted-foreground'}`} />
              <span className="text-sm font-semibold">{s.label}</span>
              {!s.active && <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">paused</span>}
              <div className="ml-auto flex gap-1">
                <Button size="sm" variant="ghost" className="h-8" onClick={() => setSchedules((p) => p.map((x) => (x.id === s.id ? { ...x, active: !x.active } : x)))}>{s.active ? 'Pause' : 'Resume'}</Button>
                <Button size="sm" variant="ghost" className="h-8 text-muted-foreground" onClick={() => setSchedules((p) => p.filter((x) => x.id !== s.id))}>Delete</Button>
              </div>
            </div>
          ))}
          <Button variant="outline" className="h-10 w-full" onClick={() => setSchedules((p) => [...p, { id: Date.now(), label: 'Weekly · Friday 9:00 AM', active: true }])}><Plus className="mr-1 h-4 w-4" /> Add a schedule</Button>
        </div>
        <DialogFooter><Button className="h-10" onClick={() => onOpenChange(false)}>Done</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
