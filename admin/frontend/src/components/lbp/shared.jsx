// Lean BEAF Pro — shared UI pieces (badges, stage bars, project card,
// new-project + close-out dialogs). Mobile-first per MOBILE_FIRST.md:
// everything defaults to phone layout, desktop is sm:/md: overrides.
// Visual reference: docs/lean-beaf-pro-mockup-v6.html (picture, not code) —
// rendered here with the existing ProxyPilot theme tokens.

import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import { Loader2, Pin, MapPin, Play, CheckCircle2, XCircle, AlertTriangle } from 'lucide-react';

export const LBP_STAGES = ['Idea', 'MVP', 'Testing', 'Site', 'POD', 'Region', 'All'];

// ---- tiny helpers ----

export const fmtDate = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString();
};

export const timeAgo = (iso) => {
  if (!iso) return '—';
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
};

// ---- badges / chips ----

export function MovedBadge({ moved, daysIdle, archived }) {
  if (archived) return null;
  return moved ? (
    <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-xs font-semibold text-primary whitespace-nowrap">
      ● Moved
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2 py-0.5 text-xs font-semibold text-amber-600 dark:text-amber-400 whitespace-nowrap">
      ● {daysIdle != null ? `${daysIdle}d idle` : 'No movement'}
    </span>
  );
}

export function OutcomeBadge({ outcome }) {
  if (outcome === 'rolled_out') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-green-500/10 px-2 py-0.5 text-xs font-semibold text-green-600 dark:text-green-400 whitespace-nowrap">
        <CheckCircle2 className="h-3 w-3" /> Rolled out
      </span>
    );
  }
  if (outcome === 'abandoned') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-red-500/10 px-2 py-0.5 text-xs font-semibold text-red-600 dark:text-red-400 whitespace-nowrap">
        <XCircle className="h-3 w-3" /> Abandoned
      </span>
    );
  }
  return null;
}

export function LocationChip({ label }) {
  if (!label) return null;
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-blue-500/10 px-2.5 py-0.5 text-xs font-semibold text-blue-600 dark:text-blue-400 max-w-full">
      <MapPin className="h-3 w-3 shrink-0" />
      <span className="truncate">{label}</span>
    </span>
  );
}

const AVATAR_COLORS = [
  'bg-teal-500', 'bg-amber-500', 'bg-blue-500', 'bg-purple-500', 'bg-rose-500', 'bg-emerald-500',
];
const avatarColor = (name = '') => {
  let h = 0;
  for (const c of String(name)) h = (h * 31 + c.charCodeAt(0)) % AVATAR_COLORS.length;
  return AVATAR_COLORS[h];
};

export function Avatars({ assignees = [], max = 4 }) {
  const shown = assignees.slice(0, max);
  const extra = assignees.length - shown.length;
  if (assignees.length === 0) return null;
  return (
    <span className="inline-flex items-center">
      {shown.map((a, i) => (
        <span
          key={a.user_id}
          title={a.username}
          className={`inline-flex h-6 w-6 items-center justify-center rounded-full border-2 border-card text-[10px] font-bold text-white ${avatarColor(a.username)} ${i > 0 ? '-ml-1.5' : ''}`}
        >
          {String(a.username || '?').slice(0, 2).toUpperCase()}
        </span>
      ))}
      {extra > 0 && (
        <span className="-ml-1.5 inline-flex h-6 w-6 items-center justify-center rounded-full border-2 border-card bg-muted text-[10px] font-bold text-muted-foreground">
          +{extra}
        </span>
      )}
    </span>
  );
}

// 7-dot mini stage bar with "POD · 5/7" label (list cards).
export function StageDots({ stage, stageIndex }) {
  const idx = stageIndex ?? LBP_STAGES.indexOf(stage);
  return (
    <span className="flex items-center gap-2 min-w-0">
      <span className="flex flex-1 max-w-[140px] gap-1">
        {LBP_STAGES.map((s, i) => (
          <i
            key={s}
            className={`h-1.5 flex-1 rounded-full ${i < idx ? 'bg-primary/50' : i === idx ? 'bg-primary' : 'bg-muted'}`}
          />
        ))}
      </span>
      <span className="text-xs font-semibold text-primary whitespace-nowrap">{stage} · {idx + 1}/7</span>
    </span>
  );
}

// Full stepper for the detail page.
export function StageStepper({ stage }) {
  const idx = LBP_STAGES.indexOf(stage);
  return (
    <div className="flex items-start overflow-x-auto pb-1" role="list" aria-label="Rollout stages">
      {LBP_STAGES.map((s, i) => (
        <div key={s} role="listitem" className="relative flex min-w-[48px] flex-1 flex-col items-center">
          {i < LBP_STAGES.length - 1 && (
            <span className={`absolute left-[calc(50%+10px)] right-[calc(-50%+10px)] top-[7px] h-0.5 ${i < idx ? 'bg-primary/50' : 'bg-border'}`} />
          )}
          <span
            className={`z-10 h-4 w-4 rounded-full border-2 ${
              i < idx ? 'border-primary/60 bg-primary/60'
                : i === idx ? 'border-primary bg-primary ring-4 ring-primary/15'
                  : 'border-border bg-muted'
            }`}
          />
          <span className={`mt-1 whitespace-nowrap text-[10px] font-bold ${i === idx ? 'text-primary' : i < idx ? 'text-muted-foreground' : 'text-muted-foreground/60'}`}>
            {s}
          </span>
        </div>
      ))}
    </div>
  );
}

// ---- project card (List view / Archive) ----

export function ProjectCard({ project, onClick, archived = false }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full rounded-xl border bg-card p-4 text-left transition-colors hover:border-primary/50"
    >
      <div className="flex items-center gap-2 min-w-0">
        {project.pinned && <Pin className="h-3.5 w-3.5 shrink-0 text-primary" />}
        <h3 className="min-w-0 flex-1 truncate text-base font-semibold">{project.name}</h3>
        {archived ? <OutcomeBadge outcome={project.outcome} /> : (
          <MovedBadge moved={project.moved} daysIdle={project.days_idle} archived={project.archived} />
        )}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <Avatars assignees={project.assignees} />
        <LocationChip label={project.location_label} />
        <span className="inline-flex items-center gap-1 text-xs text-muted-foreground whitespace-nowrap">
          <Play className="h-3 w-3" /> {fmtDate(project.start_date)}
        </span>
      </div>
      <div className="mt-3">
        {archived ? (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span className="font-semibold">
              {project.outcome === 'abandoned' ? `died at ${project.final_stage}` : `reached ${project.final_stage}`}
            </span>
            {project.span_days != null && <span>{project.span_days} days</span>}
            {project.invested_hours > 0 && <span>{project.invested_hours}h invested</span>}
          </div>
        ) : (
          <StageDots stage={project.stage} stageIndex={project.stage_index} />
        )}
      </div>
      {archived && (project.outcome_reason || project.outcome_takeaway) && (
        <p className="mt-2 line-clamp-2 text-xs text-muted-foreground">
          {project.outcome === 'rolled_out' ? 'Delivers: ' : 'Why: '}
          {project.outcome_reason}
        </p>
      )}
    </button>
  );
}

// ---- new project dialog (with live idea checker, R10) ----

export function NewProjectDialog({ open, onOpenChange, onCreated }) {
  const { toast } = useToast();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [stage, setStage] = useState('Idea');
  const [startDate, setStartDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [users, setUsers] = useState([]);
  const [assignees, setAssignees] = useState([]);
  const [matches, setMatches] = useState([]);
  const [relatedIds, setRelatedIds] = useState([]);
  const [saving, setSaving] = useState(false);
  const checkTimer = useRef(null);

  useEffect(() => {
    if (!open) return;
    setName(''); setDescription(''); setStage('Idea');
    setStartDate(new Date().toISOString().slice(0, 10));
    setMatches([]); setRelatedIds([]);
    api.lbpUsers().then((d) => setUsers(d.users || [])).catch(() => {});
  }, [open]);

  // Live idea checker: fires at ≥3 typed chars, searches all projects ever.
  useEffect(() => {
    if (!open) return undefined;
    clearTimeout(checkTimer.current);
    if (name.trim().length < 3) { setMatches([]); return undefined; }
    checkTimer.current = setTimeout(() => {
      api.lbpIdeaCheck(name.trim())
        .then((d) => setMatches(d.matches || []))
        .catch(() => {});
    }, 250);
    return () => clearTimeout(checkTimer.current);
  }, [name, open]);

  const toggleRelated = (id) => {
    setRelatedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };
  const toggleAssignee = (id) => {
    setAssignees((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  const submit = async () => {
    if (!name.trim()) return;
    setSaving(true);
    try {
      const data = await api.lbpCreateProject({
        name: name.trim(),
        description: description.trim() || null,
        stage,
        start_date: startDate,
        assignee_ids: assignees.length ? assignees : undefined,
        related_ids: relatedIds.length ? relatedIds : undefined,
      });
      toast({ title: 'Project created', description: data.project.name });
      onOpenChange(false);
      onCreated?.(data.project);
    } catch (e) {
      toast({ variant: 'destructive', title: 'Could not create project', description: e.message });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-full h-full rounded-none sm:max-w-lg sm:h-auto sm:max-h-[90vh] sm:rounded-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>New project</DialogTitle>
          <DialogDescription>
            The idea checker searches every project ever — including abandoned ones — as you type.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="lbp-new-name">Name</Label>
            <Input id="lbp-new-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. AI Appointment Reminders" />
          </div>
          {matches.length > 0 && (
            <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 space-y-2">
              <p className="flex items-center gap-1.5 text-xs font-semibold text-amber-600 dark:text-amber-400">
                <AlertTriangle className="h-3.5 w-3.5" /> This has been tried (or is running) — check before duplicating:
              </p>
              {matches.map((m) => (
                <label key={m.id} className="flex items-start gap-2 text-sm cursor-pointer">
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={relatedIds.includes(m.id)}
                    onChange={() => toggleRelated(m.id)}
                  />
                  <span className="min-w-0">
                    <span className="font-semibold">{m.name}</span>{' '}
                    <OutcomeBadge outcome={m.outcome} />
                    <span className="block text-xs text-muted-foreground">{m.how_it_went}</span>
                    <span className="block text-[11px] text-muted-foreground/70">tick to link as related</span>
                  </span>
                </label>
              ))}
            </div>
          )}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label>Stage</Label>
              <Select value={stage} onValueChange={setStage}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {LBP_STAGES.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="lbp-new-start">Start date</Label>
              <Input id="lbp-new-start" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
            </div>
          </div>
          <div className="space-y-2">
            <Label>Assignees</Label>
            <div className="flex flex-wrap gap-2">
              {users.map((u) => (
                <button
                  key={u.id}
                  type="button"
                  onClick={() => toggleAssignee(String(u.id))}
                  className={`rounded-full border px-3 py-1.5 text-sm font-medium ${
                    assignees.includes(String(u.id))
                      ? 'border-primary bg-primary/10 text-primary'
                      : 'border-border text-muted-foreground'
                  }`}
                >
                  {u.username}
                </button>
              ))}
              {users.length === 0 && <p className="text-xs text-muted-foreground">Defaults to you.</p>}
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="lbp-new-desc">Description</Label>
            <textarea
              id="lbp-new-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={4}
              placeholder="What is it, and what should it change? (markdown ok)"
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            />
          </div>
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" className="h-11 sm:h-10" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button className="h-11 sm:h-10" onClick={submit} disabled={saving || !name.trim()}>
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Create project
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---- close-out dialog (R08) ----

export function CloseOutDialog({ open, onOpenChange, project, onClosed }) {
  const { toast } = useToast();
  const [outcome, setOutcome] = useState('rolled_out');
  const [reason, setReason] = useState('');
  const [takeaway, setTakeaway] = useState('');
  const [hasMetrics, setHasMetrics] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open || !project) return;
    setOutcome('rolled_out'); setReason(''); setTakeaway('');
    api.lbpMetricReports(project.id)
      .then((d) => setHasMetrics((d.reports || []).length > 0))
      .catch(() => setHasMetrics(true));
  }, [open, project]);

  const submit = async () => {
    setSaving(true);
    try {
      await api.lbpCloseProject(project.id, { outcome, reason: reason.trim(), takeaway: takeaway.trim() });
      toast({ title: outcome === 'rolled_out' ? 'Rolled out ✓' : 'Abandoned ✕', description: project.name });
      onOpenChange(false);
      onClosed?.();
    } catch (e) {
      toast({ variant: 'destructive', title: 'Could not close project', description: e.message });
    } finally {
      setSaving(false);
    }
  };

  if (!project) return null;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-full h-full rounded-none sm:max-w-md sm:h-auto sm:rounded-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Close out “{project.name}”</DialogTitle>
          <DialogDescription>
            Every project ends as exactly one of Rolled Out or Abandoned. The archive keeps everything.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <button
              type="button"
              onClick={() => setOutcome('rolled_out')}
              className={`rounded-lg border p-3 text-left ${outcome === 'rolled_out' ? 'border-green-500 bg-green-500/10' : 'border-border'}`}
            >
              <span className="flex items-center gap-1.5 font-semibold text-green-600 dark:text-green-400">
                <CheckCircle2 className="h-4 w-4" /> Rolled out
              </span>
              <span className="text-xs text-muted-foreground">It works and it's live.</span>
            </button>
            <button
              type="button"
              onClick={() => setOutcome('abandoned')}
              className={`rounded-lg border p-3 text-left ${outcome === 'abandoned' ? 'border-red-500 bg-red-500/10' : 'border-border'}`}
            >
              <span className="flex items-center gap-1.5 font-semibold text-red-600 dark:text-red-400">
                <XCircle className="h-4 w-4" /> Abandoned
              </span>
              <span className="text-xs text-muted-foreground">Didn't pan out — that's data too.</span>
            </button>
          </div>
          {outcome === 'rolled_out' && !hasMetrics && (
            <p className="flex items-start gap-1.5 rounded-md bg-amber-500/10 p-2 text-xs text-amber-600 dark:text-amber-400">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              No metric reports on record for this project. You can still roll out, but the impact story will be empty.
            </p>
          )}
          <div className="space-y-2">
            <Label htmlFor="lbp-close-reason">{outcome === 'rolled_out' ? 'What does it deliver?' : 'Why didn\'t it pan out?'} (required)</Label>
            <textarea
              id="lbp-close-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="lbp-close-takeaway">Key takeaway (required)</Label>
            <textarea
              id="lbp-close-takeaway"
              value={takeaway}
              onChange={(e) => setTakeaway(e.target.value)}
              rows={2}
              placeholder="What should the next team know?"
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            />
          </div>
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" className="h-11 sm:h-10" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            className="h-11 sm:h-10"
            variant={outcome === 'abandoned' ? 'destructive' : 'default'}
            onClick={submit}
            disabled={saving || !reason.trim() || !takeaway.trim()}
          >
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {outcome === 'rolled_out' ? 'Mark rolled out' : 'Mark abandoned'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---- rollout scope editor (R03) ----

export function ScopeEditor({ project, locations, onSaved }) {
  const { toast } = useToast();
  const [scope, setScope] = useState(project.scope || {});
  const [saving, setSaving] = useState(false);
  useEffect(() => { setScope(project.scope || {}); }, [project.id, project.scope]);

  const sites = useMemo(() => locations.filter((l) => l.kind === 'site'), [locations]);
  const pods = useMemo(() => locations.filter((l) => l.kind === 'pod'), [locations]);
  const regions = useMemo(() => locations.filter((l) => l.kind === 'region'), [locations]);

  const togglePod = (field, id) => {
    setScope((s) => {
      const arr = s[field] || [];
      return { ...s, [field]: arr.includes(id) ? arr.filter((x) => x !== id) : [...arr, id] };
    });
  };

  const save = async () => {
    setSaving(true);
    try {
      const data = await api.lbpSetScope(project.id, {
        testers_text: scope.testers_text ?? null,
        site_id: scope.site_id ?? null,
        region_id: scope.region_id ?? null,
        pod_ids: scope.pod_ids || [],
        planned_pod_ids: scope.planned_pod_ids || [],
      });
      toast({ title: 'Rollout scope saved' });
      onSaved?.(data.scope);
    } catch (e) {
      toast({ variant: 'destructive', title: 'Could not save scope', description: e.message });
    } finally {
      setSaving(false);
    }
  };

  const row = 'flex flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-3';
  const labelCls = 'w-full text-xs font-bold uppercase tracking-wide text-muted-foreground sm:w-24 shrink-0';

  return (
    <div className="space-y-3">
      <div className={row}>
        <span className={labelCls}>Testing</span>
        <Input
          value={scope.testers_text || ''}
          onChange={(e) => setScope((s) => ({ ...s, testers_text: e.target.value }))}
          placeholder="Who is testing? (free text)"
        />
      </div>
      <div className={row}>
        <span className={labelCls}>Site</span>
        <Select
          value={scope.site_id ? String(scope.site_id) : 'none'}
          onValueChange={(v) => setScope((s) => ({ ...s, site_id: v === 'none' ? null : Number(v) }))}
        >
          <SelectTrigger className="w-full sm:w-64"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="none">— not set —</SelectItem>
            {sites.map((l) => <SelectItem key={l.id} value={String(l.id)}>{l.name}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
      <div className={row}>
        <span className={labelCls}>POD(s)</span>
        <div className="flex flex-wrap gap-2">
          {pods.map((l) => {
            const active = (scope.pod_ids || []).includes(l.id);
            const planned = (scope.planned_pod_ids || []).includes(l.id);
            return (
              <button
                key={l.id}
                type="button"
                onClick={() => {
                  // cycle: unset → active → planned → unset
                  if (active) { togglePod('pod_ids', l.id); togglePod('planned_pod_ids', l.id); }
                  else if (planned) togglePod('planned_pod_ids', l.id);
                  else togglePod('pod_ids', l.id);
                }}
                className={`rounded-full border px-3 py-1.5 text-sm font-medium ${
                  active ? 'border-primary bg-primary/10 text-primary'
                    : planned ? 'border-dashed border-primary/60 text-primary/80'
                      : 'border-border text-muted-foreground'
                }`}
                title={active ? 'Live — tap for planned' : planned ? 'Planned — tap to unset' : 'Tap to set live'}
              >
                {l.name}{planned && !active ? ' (planned)' : ''}
              </button>
            );
          })}
          {pods.length === 0 && <span className="text-xs text-muted-foreground">No PODs in the catalog yet.</span>}
        </div>
      </div>
      <div className={row}>
        <span className={labelCls}>Region</span>
        <Select
          value={scope.region_id ? String(scope.region_id) : 'none'}
          onValueChange={(v) => setScope((s) => ({ ...s, region_id: v === 'none' ? null : Number(v) }))}
        >
          <SelectTrigger className="w-full sm:w-64"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="none">— not set —</SelectItem>
            {regions.map((l) => <SelectItem key={l.id} value={String(l.id)}>{l.name}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
      <div className="flex justify-end">
        <Button size="sm" className="h-10" onClick={save} disabled={saving}>
          {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Save scope
        </Button>
      </div>
    </div>
  );
}
