// Lean BEAF Pro — project detail. Header (name, 📍, start, avatars, pin),
// outcome banner for archived projects (read-only, R09), stage card
// (stepper + Advance / Rolled out / Abandon + rollout-scope rows),
// related-project link chips (R11), LXC build-project card (Mock2
// integration: linked status or "Build LXC"), and the evidence tabs:
// Overview, Metrics, Feedback, Learnings, Files, Tasks, Activity.
// Mobile-first per MOBILE_FIRST.md.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '@/lib/api';
import { useAuth } from '@/context/AuthContext';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useToast } from '@/hooks/use-toast';
import {
  Loader2, ArrowLeft, Pin, PinOff, ChevronRight, CheckCircle2, XCircle, Play,
  Link2, Trash2, Plus, Boxes, FileText, Download, Send, Pencil, Flag, ShieldOff, Clock,
} from 'lucide-react';
import {
  LBP_STAGES, StageStepper, ScopeEditor, CloseOutDialog, OutcomeBadge,
  MovedBadge, BlockedBadge, LocationChip, Avatars, fmtDate, timeAgo,
} from '@/components/lbp/shared';

export default function LbpProjectDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const { toast } = useToast();
  const isAdmin = user?.role === 'admin';

  const [project, setProject] = useState(null);
  const [err, setErr] = useState('');
  const [locations, setLocations] = useState([]);
  const [closeOpen, setCloseOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [assigneesOpen, setAssigneesOpen] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);
  const [buildOpen, setBuildOpen] = useState(false);
  const [blockOpen, setBlockOpen] = useState(false);
  const [breakOpen, setBreakOpen] = useState(false);

  const load = useCallback(() => {
    api.lbpProject(id).then((d) => setProject(d.project)).catch((e) => setErr(e.message));
  }, [id]);
  useEffect(() => {
    load();
    api.lbpLocations().then((d) => setLocations(d.locations || [])).catch(() => {});
  }, [load]);

  if (err) return <p className="text-sm text-destructive">{err}</p>;
  if (!project) return <div className="flex justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>;

  const archived = project.archived;

  const togglePin = async () => {
    try {
      await api.lbpUpdateProject(project.id, { pinned: !project.pinned });
      load();
    } catch (e) {
      toast({ variant: 'destructive', title: 'Could not update pin', description: e.message });
    }
  };

  const advance = async () => {
    const next = LBP_STAGES[LBP_STAGES.indexOf(project.stage) + 1];
    if (!next) return;
    changeStage(next);
  };

  // Jump to any stage — forward or backward — by clicking a stepper node.
  const changeStage = async (stage) => {
    if (stage === project.stage) return;
    const back = LBP_STAGES.indexOf(stage) < LBP_STAGES.indexOf(project.stage);
    try {
      await api.lbpSetStage(project.id, stage);
      toast({
        title: `${back ? 'Moved back to' : 'Moved to'} ${stage}`,
        description: back ? 'Stage change logged.' : 'Set the rollout scope below for the new stage.',
      });
      load();
    } catch (e) {
      toast({ variant: 'destructive', title: 'Stage change failed', description: e.message });
    }
  };

  return (
    // Cap the detail page to the same centered measure as the list views.
    <div className="mx-auto w-full max-w-5xl space-y-4">
      {/* header */}
      <div>
        <button type="button" onClick={() => navigate('/lean-beaf')} className="mb-2 inline-flex items-center gap-1 text-sm font-semibold text-muted-foreground">
          <ArrowLeft className="h-4 w-4" /> Lean BEAF Pro
        </button>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="min-w-0 flex-1 truncate text-xl font-bold">{project.name}</h1>
          {!archived && (
            <>
              <Button variant="ghost" size="icon" className="h-11 w-11 sm:h-10 sm:w-10" onClick={togglePin} title={project.pinned ? 'Unpin' : 'Pin'}>
                {project.pinned ? <PinOff className="h-4 w-4" /> : <Pin className="h-4 w-4" />}
              </Button>
              <Button variant="ghost" size="icon" className="h-11 w-11 sm:h-10 sm:w-10" onClick={() => setEditOpen(true)} title="Edit name / description / start date">
                <Pencil className="h-4 w-4" />
              </Button>
            </>
          )}
        </div>
        {/* Meta order: start date → days-since counter → rollout stage →
            assignees (status flags sit just before the avatars). */}
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground whitespace-nowrap">
            <Play className="h-3 w-3" /> {fmtDate(project.start_date)}
          </span>
          <span
            className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs font-bold text-muted-foreground whitespace-nowrap"
            title="Days since it started"
          >
            <Clock className="h-3 w-3" />{project.span_days ?? 0}d
          </span>
          <LocationChip label={project.location_label} />
          {project.blocked && <BlockedBadge days={project.blocked_days} reason={project.blocked_reason} />}
          <MovedBadge moved={project.moved} daysIdle={project.days_idle} archived={archived} />
          <button type="button" onClick={() => !archived && setAssigneesOpen(true)} className="inline-flex items-center">
            <Avatars assignees={project.assignees} />
            {!archived && <span className="ml-1 text-xs font-semibold text-primary">edit</span>}
          </button>
        </div>
      </div>

      {/* outcome banner (archived) */}
      {archived && (
        <div className={`rounded-xl border p-4 ${project.outcome === 'rolled_out' ? 'border-green-500/40 bg-green-500/5' : 'border-red-500/40 bg-red-500/5'}`}>
          <div className="flex flex-wrap items-center gap-2">
            <OutcomeBadge outcome={project.outcome} />
            <span className="text-xs text-muted-foreground">
              {fmtDate(project.outcome_at)} · final stage {project.stage} · {project.span_days} days
            </span>
          </div>
          {project.outcome_reason && <p className="mt-2 text-sm">{project.outcome_reason}</p>}
          {project.outcome_takeaway && (
            <p className="mt-1 text-sm text-muted-foreground"><b>Takeaway:</b> {project.outcome_takeaway}</p>
          )}
          <p className="mt-2 text-xs text-muted-foreground">
            This project is archived and read-only. To revive the idea, create a new project and link it to this one.
          </p>
        </div>
      )}

      {/* stage + scope */}
      <div className="rounded-xl border bg-card p-4">
        {/* Clicking any node jumps to that stage (forward or backward). */}
        <StageStepper stage={project.stage} onStageClick={archived ? undefined : changeStage} />
        {!archived && (
          <p className="mt-1 text-center text-[11px] text-muted-foreground">Tap any stage to move there — forward or back.</p>
        )}
        {!archived && (
          <div className="mt-3 flex flex-wrap gap-2">
            {project.stage !== 'All' && (
              <Button size="sm" className="h-10" onClick={advance}>
                Advance <ChevronRight className="ml-1 h-4 w-4" />
              </Button>
            )}
            <Button size="sm" variant="outline" className="h-10 text-green-600 dark:text-green-400" onClick={() => setCloseOpen(true)}>
              <CheckCircle2 className="mr-1.5 h-4 w-4" /> Rolled out
            </Button>
            <Button size="sm" variant="outline" className="h-10 text-red-600 dark:text-red-400" onClick={() => setCloseOpen(true)}>
              <XCircle className="mr-1.5 h-4 w-4" /> Abandon
            </Button>
            {!project.blocked && (
              <Button size="sm" variant="outline" className="h-10 text-red-600 dark:text-red-400" onClick={() => setBlockOpen(true)}>
                <Flag className="mr-1.5 h-4 w-4" /> Blocked
              </Button>
            )}
          </div>
        )}
        {/* Blocked banner: reason + since-date + Break barrier action. */}
        {!archived && project.blocked && (
          <div className="mt-3 rounded-lg border border-red-500/40 bg-red-500/5 p-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="inline-flex items-center gap-1 text-sm font-bold text-red-600 dark:text-red-400">
                <Flag className="h-4 w-4" /> Blocked
              </span>
              <span className="text-xs text-muted-foreground">
                since {fmtDate(project.blocked_at)} · {project.blocked_days ?? 0}d
              </span>
              <Button size="sm" className="ml-auto h-9" onClick={() => setBreakOpen(true)}>
                <ShieldOff className="mr-1.5 h-4 w-4" /> Break barrier
              </Button>
            </div>
            {project.blocked_reason && <p className="mt-1.5 text-sm">{project.blocked_reason}</p>}
          </div>
        )}
        {!archived && (
          <div className="mt-4 border-t pt-4">
            <h3 className="mb-3 text-xs font-bold uppercase tracking-wide text-muted-foreground">Rollout scope</h3>
            <ScopeEditor project={project} locations={locations} onSaved={load} />
          </div>
        )}
      </div>

      {/* blocker audit trail */}
      {(project.blockers || []).length > 0 && (
        <BlockerHistory blockers={project.blockers} />
      )}

      {/* LXC build project (Mock2 integration) */}
      <div className="rounded-xl border bg-card p-4">
        <div className="flex flex-wrap items-center gap-3">
          <Boxes className="h-5 w-5 text-primary" />
          <div className="min-w-[160px] flex-1">
            <b className="block text-sm">LXC build project</b>
            {project.lxc ? (
              <span className="text-xs text-muted-foreground">
                {project.lxc.name || `#${project.lxc.id}`} · {project.lxc.lifecycle}
                {project.lxc.container_name ? ` · ${project.lxc.container_name}` : ''}
              </span>
            ) : (
              <span className="text-xs text-muted-foreground">No LXC development container linked to this project yet.</span>
            )}
          </div>
          {project.lxc ? (
            <Button size="sm" variant="outline" className="h-10" onClick={() => navigate(`/projects/${project.lxc.id}`)}>
              Open build project
            </Button>
          ) : (!archived && isAdmin && (
            <Button size="sm" className="h-10" onClick={() => setBuildOpen(true)}>
              <Plus className="mr-1.5 h-4 w-4" /> Build LXC
            </Button>
          ))}
        </div>
      </div>

      {/* related links */}
      <div className="rounded-xl border bg-card p-4">
        <div className="mb-2 flex items-center gap-2">
          <h3 className="text-xs font-bold uppercase tracking-wide text-muted-foreground">Related / affects</h3>
          <Button variant="ghost" size="sm" className="ml-auto h-9" onClick={() => setLinkOpen(true)}>
            <Link2 className="mr-1 h-3.5 w-3.5" /> Link
          </Button>
        </div>
        {(project.links || []).length === 0 && <p className="text-sm text-muted-foreground">No linked projects.</p>}
        <div className="flex flex-wrap gap-2">
          {(project.links || []).map((l) => (
            <span key={l.id} className="inline-flex max-w-full items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm">
              <span className={l.other_outcome === 'rolled_out' ? 'text-green-500' : l.other_outcome === 'abandoned' ? 'text-red-500' : 'text-primary'}>
                {l.other_outcome === 'rolled_out' ? '✓' : l.other_outcome === 'abandoned' ? '✕' : '●'}
              </span>
              <button type="button" className="truncate font-medium" onClick={() => navigate(`/lean-beaf/${l.other_id}`)} title={l.note || ''}>
                {l.other_name}
              </button>
              <button
                type="button"
                className="text-muted-foreground"
                title="Remove link"
                onClick={() => api.lbpDeleteLink(l.id).then(load).catch((e) => toast({ variant: 'destructive', title: 'Could not remove link', description: e.message }))}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </span>
          ))}
        </div>
      </div>

      {/* evidence tabs */}
      <Tabs defaultValue="overview">
        <div className="overflow-x-auto">
          <TabsList className="w-max">
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="metrics">Metrics</TabsTrigger>
            <TabsTrigger value="feedback">Feedback</TabsTrigger>
            <TabsTrigger value="learnings">Learnings</TabsTrigger>
            <TabsTrigger value="files">Files</TabsTrigger>
            <TabsTrigger value="tasks">Tasks</TabsTrigger>
            <TabsTrigger value="activity">Activity</TabsTrigger>
          </TabsList>
        </div>
        <TabsContent value="overview"><OverviewTab project={project} /></TabsContent>
        <TabsContent value="metrics"><MetricsTab project={project} archived={archived} locations={locations} /></TabsContent>
        <TabsContent value="feedback"><FeedbackTab project={project} archived={archived} /></TabsContent>
        <TabsContent value="learnings"><LearningsTab project={project} archived={archived} /></TabsContent>
        <TabsContent value="files"><FilesTab project={project} archived={archived} /></TabsContent>
        <TabsContent value="tasks"><TasksTab project={project} archived={archived} /></TabsContent>
        <TabsContent value="activity"><ActivityTab project={project} archived={archived} /></TabsContent>
      </Tabs>

      <CloseOutDialog open={closeOpen} onOpenChange={setCloseOpen} project={project} onClosed={load} />
      <EditProjectDialog open={editOpen} onOpenChange={setEditOpen} project={project} onSaved={load} />
      <AssigneesDialog open={assigneesOpen} onOpenChange={setAssigneesOpen} project={project} onSaved={load} />
      <AddLinkDialog open={linkOpen} onOpenChange={setLinkOpen} project={project} onSaved={load} />
      <BuildLxcDialog open={buildOpen} onOpenChange={setBuildOpen} project={project} onLinked={load} />
      <BlockDialog open={blockOpen} onOpenChange={setBlockOpen} project={project} onSaved={load} />
      <BreakBarrierDialog open={breakOpen} onOpenChange={setBreakOpen} project={project} onSaved={load} />
    </div>
  );
}

// ---- blocker audit trail ----

function BlockerHistory({ blockers }) {
  return (
    <div className="rounded-xl border bg-card p-4">
      <h3 className="mb-3 text-xs font-bold uppercase tracking-wide text-muted-foreground">Blocker history</h3>
      <div className="divide-y">
        {blockers.map((b) => (
          <div key={b.id} className="py-2.5">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              {b.resolved_at ? (
                <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] font-bold text-muted-foreground">
                  <ShieldOff className="h-3 w-3" /> Resolved
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 rounded-full bg-red-500/10 px-2 py-0.5 text-[11px] font-bold text-red-600 dark:text-red-400">
                  <Flag className="h-3 w-3" /> Open
                </span>
              )}
              <span className="text-xs text-muted-foreground">
                {fmtDate(b.blocked_at)}
                {b.resolved_at ? ` → ${fmtDate(b.resolved_at)}` : ' → now'} · {b.duration_days ?? 0}d
              </span>
            </div>
            <p className="mt-1 text-sm">{b.reason}</p>
            {b.resolved_note && <p className="mt-0.5 text-xs text-muted-foreground">Break note: {b.resolved_note}</p>}
          </div>
        ))}
      </div>
    </div>
  );
}

function BlockDialog({ open, onOpenChange, project, onSaved }) {
  const { toast } = useToast();
  const [reason, setReason] = useState('');
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setReason('');
    setDate(new Date().toISOString().slice(0, 10));
  }, [open]);

  const submit = async () => {
    if (!reason.trim()) return;
    setSaving(true);
    try {
      await api.lbpBlock(project.id, { reason: reason.trim(), date });
      toast({ title: 'Blocker flagged', description: project.name });
      onOpenChange(false);
      onSaved?.();
    } catch (e) {
      toast({ variant: 'destructive', title: 'Could not flag blocker', description: e.message });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-full h-full rounded-none sm:max-w-md sm:h-auto sm:rounded-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Flag className="h-4 w-4 text-red-600 dark:text-red-400" /> Flag a blocker</DialogTitle>
          <DialogDescription>Raise a barrier on this project. It stays flagged until someone breaks the barrier.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="lbp-block-reason">Reason (required)</Label>
            <textarea
              id="lbp-block-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              placeholder="What's blocking this?"
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="lbp-block-date">Blocked since</Label>
            <Input id="lbp-block-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            <p className="text-xs text-muted-foreground">Defaults to today — change it if the blocker started earlier.</p>
          </div>
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" className="h-11 sm:h-10" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button className="h-11 sm:h-10" variant="destructive" onClick={submit} disabled={saving || !reason.trim()}>
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />} Flag blocker
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function BreakBarrierDialog({ open, onOpenChange, project, onSaved }) {
  const { toast } = useToast();
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setDate(new Date().toISOString().slice(0, 10));
    setNote('');
  }, [open]);

  const submit = async () => {
    setSaving(true);
    try {
      await api.lbpUnblock(project.id, { date, note: note.trim() || undefined });
      toast({ title: 'Barrier broken', description: project.name });
      onOpenChange(false);
      onSaved?.();
    } catch (e) {
      toast({ variant: 'destructive', title: 'Could not break barrier', description: e.message });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-full h-full rounded-none sm:max-w-md sm:h-auto sm:rounded-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><ShieldOff className="h-4 w-4" /> Break the barrier</DialogTitle>
          <DialogDescription>Clears the blocked flag and records when it was resolved (kept in the blocker history).</DialogDescription>
        </DialogHeader>
        {project.blocked_reason && (
          <p className="rounded-md bg-muted/50 p-2 text-sm text-muted-foreground">Blocker: {project.blocked_reason}</p>
        )}
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="lbp-break-date">Resolved on</Label>
            <Input id="lbp-break-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="lbp-break-note">Note (optional)</Label>
            <Input id="lbp-break-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="How was it unblocked?" />
          </div>
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" className="h-11 sm:h-10" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button className="h-11 sm:h-10" onClick={submit} disabled={saving}>
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />} Break barrier
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---- small dialogs ----

function EditProjectDialog({ open, onOpenChange, project, onSaved }) {
  const { toast } = useToast();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [startDate, setStartDate] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName(project.name || '');
    setDescription(project.description || '');
    setStartDate(project.start_date || '');
  }, [open, project]);

  const save = async () => {
    setSaving(true);
    try {
      await api.lbpUpdateProject(project.id, {
        name: name.trim(), description: description.trim() || null, start_date: startDate || undefined,
      });
      onOpenChange(false);
      onSaved?.();
    } catch (e) {
      toast({ variant: 'destructive', title: 'Could not save', description: e.message });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-full h-full rounded-none sm:max-w-lg sm:h-auto sm:rounded-lg overflow-y-auto">
        <DialogHeader><DialogTitle>Edit project</DialogTitle></DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2"><Label>Name</Label><Input value={name} onChange={(e) => setName(e.target.value)} /></div>
          <div className="space-y-2"><Label>Start date</Label><Input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} /></div>
          <div className="space-y-2">
            <Label>Description</Label>
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={5} className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm" />
          </div>
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" className="h-11 sm:h-10" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button className="h-11 sm:h-10" onClick={save} disabled={saving || !name.trim()}>
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />} Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AssigneesDialog({ open, onOpenChange, project, onSaved }) {
  const { toast } = useToast();
  const [users, setUsers] = useState([]);
  const [selected, setSelected] = useState([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setSelected((project.assignees || []).map((a) => String(a.user_id)));
    api.lbpUsers().then((d) => setUsers(d.users || [])).catch(() => {});
  }, [open, project]);

  const toggle = (uid) => setSelected((prev) => (prev.includes(uid) ? prev.filter((x) => x !== uid) : [...prev, uid]));

  const save = async () => {
    setSaving(true);
    try {
      await api.lbpSetAssignees(project.id, selected);
      onOpenChange(false);
      onSaved?.();
    } catch (e) {
      toast({ variant: 'destructive', title: 'Could not save assignees', description: e.message });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-full h-full rounded-none sm:max-w-md sm:h-auto sm:rounded-lg overflow-y-auto">
        <DialogHeader><DialogTitle>Assignees</DialogTitle></DialogHeader>
        <div className="flex flex-wrap gap-2">
          {users.map((u) => (
            <button
              key={u.id}
              type="button"
              onClick={() => toggle(String(u.id))}
              className={`rounded-full border px-3 py-1.5 text-sm font-medium ${
                selected.includes(String(u.id)) ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground'
              }`}
            >
              {u.username}
            </button>
          ))}
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" className="h-11 sm:h-10" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button className="h-11 sm:h-10" onClick={save} disabled={saving}>
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />} Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AddLinkDialog({ open, onOpenChange, project, onSaved }) {
  const { toast } = useToast();
  const [candidates, setCandidates] = useState([]);
  const [otherId, setOtherId] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setOtherId(''); setNote('');
    api.lbpProjects({ includeArchived: true })
      .then((d) => setCandidates((d.projects || []).filter((p) => p.id !== project.id)))
      .catch(() => {});
  }, [open, project]);

  const save = async () => {
    setSaving(true);
    try {
      await api.lbpAddLink(project.id, Number(otherId), note.trim() || null);
      onOpenChange(false);
      onSaved?.();
    } catch (e) {
      toast({ variant: 'destructive', title: 'Could not link', description: e.message });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-full h-full rounded-none sm:max-w-md sm:h-auto sm:rounded-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Link a related project</DialogTitle>
          <DialogDescription>Links are bidirectional and may point at archived projects.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label>Project</Label>
            <Select value={otherId} onValueChange={setOtherId}>
              <SelectTrigger><SelectValue placeholder="Pick a project…" /></SelectTrigger>
              <SelectContent>
                {candidates.map((p) => (
                  <SelectItem key={p.id} value={String(p.id)}>
                    {p.name}{p.outcome ? ` (${p.outcome === 'rolled_out' ? 'rolled out' : 'abandoned'})` : ''}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>Note</Label>
            <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. supersedes / shares the intake flow" />
          </div>
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" className="h-11 sm:h-10" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button className="h-11 sm:h-10" onClick={save} disabled={saving || !otherId}>
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />} Link
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// "Build LXC": creates a Mock2 (LXC AI-dev) project pre-linked to this card.
// Admin-only (Mock2 project creation is admin-gated) and only offered when
// the Projects module is enabled on this host.
function BuildLxcDialog({ open, onOpenChange, project, onLinked }) {
  const { toast } = useToast();
  const [available, setAvailable] = useState(null); // null=probing, false=disabled
  const [domains, setDomains] = useState([]);
  const [domainId, setDomainId] = useState('');
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName(project.name);
    setAvailable(null);
    api.mock2Status()
      .then(() => {
        setAvailable(true);
        return api.mock2ListParentDomains().then((d) => {
          const selectable = (d.domains || []).filter((x) => x.selectable);
          setDomains(selectable);
          if (selectable.length === 1) setDomainId(String(selectable[0].id));
        });
      })
      .catch(() => setAvailable(false));
  }, [open, project]);

  const build = async () => {
    setSaving(true);
    try {
      await api.mock2CreateProject({
        name: name.trim(),
        description: project.description || undefined,
        parent_domain_id: Number(domainId),
        lbp_project_id: project.id,
      });
      toast({ title: 'LXC build project started', description: 'The container is provisioning; this card is now linked to it.' });
      onOpenChange(false);
      onLinked?.();
    } catch (e) {
      toast({ variant: 'destructive', title: 'Could not build the LXC project', description: e.message });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-full h-full rounded-none sm:max-w-md sm:h-auto sm:rounded-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Build LXC</DialogTitle>
          <DialogDescription>
            Creates an AI-development build project (with its own LXC container) and links it to this card.
          </DialogDescription>
        </DialogHeader>
        {available === null && <div className="py-4"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>}
        {available === false && (
          <p className="text-sm text-muted-foreground">
            The Projects (AI dev) module is not enabled on this host, so an LXC build project can't be created from here.
          </p>
        )}
        {available && (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Build project name</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} />
              <p className="text-xs text-muted-foreground">The name becomes the project's subdomain slug.</p>
            </div>
            <div className="space-y-2">
              <Label>Parent domain</Label>
              <Select value={domainId} onValueChange={setDomainId}>
                <SelectTrigger><SelectValue placeholder={domains.length ? 'Pick a domain…' : 'No verified domains available'} /></SelectTrigger>
                <SelectContent>
                  {domains.map((d) => <SelectItem key={d.id} value={String(d.id)}>{d.domain}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>
        )}
        <DialogFooter className="gap-2">
          <Button variant="outline" className="h-11 sm:h-10" onClick={() => onOpenChange(false)}>Cancel</Button>
          {available && (
            <Button className="h-11 sm:h-10" onClick={build} disabled={saving || !name.trim() || !domainId}>
              {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />} Build LXC
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---- tabs ----

function OverviewTab({ project }) {
  return (
    <div className="space-y-3 rounded-xl border bg-card p-4">
      {project.description
        ? <p className="whitespace-pre-wrap text-sm leading-relaxed">{project.description}</p>
        : <p className="text-sm text-muted-foreground">No description yet.</p>}
      <div className="grid grid-cols-1 gap-2 border-t pt-3 text-xs text-muted-foreground sm:grid-cols-2">
        <span>Started {fmtDate(project.start_date)} · {project.span_days} days {project.archived ? 'total' : 'so far'}</span>
        <span>Last activity {timeAgo(project.last_activity_at)}</span>
        <span>Tasks: {project.task_counts?.done ?? 0}/{project.task_counts?.total ?? 0} done (informational)</span>
        <span>Stage {project.stage} · {project.stage_index + 1}/7</span>
      </div>
    </div>
  );
}

function MetricsTab({ project, archived, locations }) {
  const { toast } = useToast();
  const [reports, setReports] = useState([]);
  const [events, setEvents] = useState([]);
  const [metricOpen, setMetricOpen] = useState(false);
  const [timeOpen, setTimeOpen] = useState(false);

  const load = useCallback(() => {
    api.lbpMetricReports(project.id).then((d) => setReports(d.reports || [])).catch(() => {});
    api.lbpTimeEvents(project.id).then((d) => setEvents(d.events || [])).catch(() => {});
  }, [project.id]);
  useEffect(() => { load(); }, [load]);

  const fmtVal = (r) => {
    if (r.unit === 'currency') return `$${Number(r.value).toLocaleString()}`;
    if (r.unit === 'percent') return `${r.value}%`;
    if (r.unit === 'hours') return `${r.value}h`;
    return String(r.value);
  };

  return (
    <div className="space-y-4">
      <div className="rounded-xl border bg-card p-4">
        <div className="mb-2 flex items-center">
          <h3 className="text-xs font-bold uppercase tracking-wide text-muted-foreground">Metric reports</h3>
          {!archived && (
            <Button size="sm" className="ml-auto h-10" onClick={() => setMetricOpen(true)}>
              <Plus className="mr-1 h-3.5 w-3.5" /> Report a metric
            </Button>
          )}
        </div>
        {reports.length === 0 && <p className="text-sm text-muted-foreground">No reports yet. Reports are immutable and always cite a source.</p>}
        <div className="divide-y">
          {reports.map((r) => (
            <div key={r.id} className="py-2.5">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <b className="text-sm">{r.metric_name}</b>
                <span className="text-sm font-bold text-primary">{fmtVal(r)}</span>
                {r.period_label && <span className="text-xs text-muted-foreground">({r.period_label})</span>}
                {r.corrects_report_id && <span className="text-[10px] font-bold text-amber-600">corrects #{r.corrects_report_id}</span>}
                <span className="ml-auto text-xs text-muted-foreground">#{r.id} · {fmtDate(r.reported_at)}</span>
              </div>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Source: {r.source_text || ''}{r.source_url ? <> <a className="text-primary underline" href={r.source_url} target="_blank" rel="noreferrer">{r.source_url}</a></> : null}
                {r.file_id ? <> <a className="text-primary underline" href={api.lbpFileUrl(r.file_id)} target="_blank" rel="noreferrer">attached file</a></> : null}
              </p>
            </div>
          ))}
        </div>
      </div>

      <div className="rounded-xl border bg-card p-4">
        <div className="mb-2 flex items-center">
          <h3 className="text-xs font-bold uppercase tracking-wide text-muted-foreground">Time & events</h3>
          {!archived && (
            <Button size="sm" variant="outline" className="ml-auto h-10" onClick={() => setTimeOpen(true)}>
              <Plus className="mr-1 h-3.5 w-3.5" /> Log time / event
            </Button>
          )}
        </div>
        {events.length === 0 && <p className="text-sm text-muted-foreground">Nothing logged yet.</p>}
        <div className="divide-y">
          {events.map((ev) => (
            <div key={ev.id} className="flex flex-wrap items-center gap-x-2 gap-y-1 py-2 text-sm">
              <b>{ev.type}</b>
              {ev.hours != null && <span className="text-primary font-semibold">{ev.hours}h</span>}
              {ev.note && <span className="min-w-0 flex-1 truncate text-muted-foreground">{ev.note}</span>}
              <span className="ml-auto text-xs text-muted-foreground">{fmtDate(ev.date)}</span>
            </div>
          ))}
        </div>
      </div>

      <ReportMetricDialog open={metricOpen} onOpenChange={setMetricOpen} project={project} locations={locations} onSaved={load} />
      <TimeEventDialog open={timeOpen} onOpenChange={setTimeOpen} project={project} locations={locations} onSaved={load} />
    </div>
  );
}

function ReportMetricDialog({ open, onOpenChange, project, locations, onSaved }) {
  const { toast } = useToast();
  const { user } = useAuth();
  const [metrics, setMetrics] = useState([]);
  const [metricId, setMetricId] = useState('');
  const [value, setValue] = useState('');
  const [period, setPeriod] = useState('');
  const [sourceText, setSourceText] = useState('');
  const [sourceUrl, setSourceUrl] = useState('');
  const [locationId, setLocationId] = useState('none');
  const [proposing, setProposing] = useState(false);
  const [newName, setNewName] = useState('');
  const [newUnit, setNewUnit] = useState('count');
  const [saving, setSaving] = useState(false);

  const loadMetrics = useCallback(() => {
    api.lbpMetrics().then((d) => setMetrics(d.metrics || [])).catch(() => {});
  }, []);
  useEffect(() => {
    if (!open) return;
    setMetricId(''); setValue(''); setPeriod(''); setSourceText(''); setSourceUrl('');
    setLocationId('none'); setProposing(false); setNewName('');
    loadMetrics();
  }, [open, loadMetrics]);

  const propose = async () => {
    try {
      const d = await api.lbpProposeMetric({ name: newName.trim(), unit: newUnit });
      loadMetrics();
      setProposing(false);
      if (d.metric.status === 'active') {
        setMetricId(String(d.metric.id));
        toast({ title: 'Metric added to the catalog' });
      } else {
        toast({ title: 'Metric proposed', description: 'A workspace admin must approve it before first use.' });
      }
    } catch (e) {
      toast({ variant: 'destructive', title: 'Could not propose metric', description: e.message });
    }
  };

  const save = async () => {
    setSaving(true);
    try {
      await api.lbpAddMetricReport(project.id, {
        metric_definition_id: Number(metricId),
        value: Number(value),
        period_label: period.trim() || null,
        source_text: sourceText.trim() || null,
        source_url: sourceUrl.trim() || null,
        location_id: locationId === 'none' ? null : Number(locationId),
      });
      onOpenChange(false);
      onSaved?.();
    } catch (e) {
      toast({ variant: 'destructive', title: 'Could not save report', description: e.message });
    } finally {
      setSaving(false);
    }
  };

  const activeMetrics = metrics.filter((m) => m.status === 'active');
  const pending = metrics.filter((m) => m.status === 'proposed');

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-full h-full rounded-none sm:max-w-lg sm:h-auto sm:max-h-[90vh] sm:rounded-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Report a metric</DialogTitle>
          <DialogDescription>Reports are immutable and require a source. Corrections are new reports.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label>Metric</Label>
            <Select value={metricId} onValueChange={setMetricId}>
              <SelectTrigger><SelectValue placeholder="Pick from the catalog…" /></SelectTrigger>
              <SelectContent>
                {activeMetrics.map((m) => <SelectItem key={m.id} value={String(m.id)}>{m.name} ({m.unit})</SelectItem>)}
              </SelectContent>
            </Select>
            {pending.length > 0 && (
              <p className="text-xs text-muted-foreground">
                Awaiting approval: {pending.map((m) => m.name).join(', ')}
                {user?.role === 'admin' && (
                  <>
                    {' — '}
                    {pending.map((m) => (
                      <button key={m.id} type="button" className="mr-2 font-semibold text-primary underline"
                        onClick={() => api.lbpApproveMetric(m.id).then(loadMetrics)}>
                        approve {m.name}
                      </button>
                    ))}
                  </>
                )}
              </p>
            )}
            {!proposing ? (
              <button type="button" className="text-xs font-semibold text-primary" onClick={() => setProposing(true)}>
                + Propose a new metric
              </button>
            ) : (
              <div className="flex flex-col gap-2 rounded-md border p-2 sm:flex-row">
                <Input placeholder="Metric name" value={newName} onChange={(e) => setNewName(e.target.value)} />
                <Select value={newUnit} onValueChange={setNewUnit}>
                  <SelectTrigger className="w-full sm:w-32"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {['count', 'hours', 'currency', 'percent'].map((u) => <SelectItem key={u} value={u}>{u}</SelectItem>)}
                  </SelectContent>
                </Select>
                <Button size="sm" className="h-10" onClick={propose} disabled={!newName.trim()}>Propose</Button>
              </div>
            )}
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label>Value</Label>
              <Input type="number" inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label>Period</Label>
              <Input placeholder="e.g. June, Q2, week 28" value={period} onChange={(e) => setPeriod(e.target.value)} />
            </div>
          </div>
          <div className="space-y-2">
            <Label>Source (at least one required)</Label>
            <Input placeholder="Where does this number come from?" value={sourceText} onChange={(e) => setSourceText(e.target.value)} />
            <Input placeholder="https://… (optional link)" value={sourceUrl} onChange={(e) => setSourceUrl(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label>Location (optional)</Label>
            <Select value={locationId} onValueChange={setLocationId}>
              <SelectTrigger className="w-full sm:w-64"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none">— none —</SelectItem>
                {locations.map((l) => <SelectItem key={l.id} value={String(l.id)}>{l.name} ({l.kind})</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" className="h-11 sm:h-10" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button className="h-11 sm:h-10" onClick={save}
            disabled={saving || !metricId || value === '' || (!sourceText.trim() && !sourceUrl.trim())}>
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />} Save report
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function TimeEventDialog({ open, onOpenChange, project, locations, onSaved }) {
  const { toast } = useToast();
  const [type, setType] = useState('Work session');
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [hours, setHours] = useState('');
  const [note, setNote] = useState('');
  const [locationId, setLocationId] = useState('none');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setType('Work session'); setDate(new Date().toISOString().slice(0, 10));
    setHours(''); setNote(''); setLocationId('none');
  }, [open]);

  const save = async () => {
    setSaving(true);
    try {
      await api.lbpAddTimeEvent(project.id, {
        type, date,
        hours: hours === '' ? null : Number(hours),
        note: note.trim() || null,
        location_id: locationId === 'none' ? null : Number(locationId),
      });
      onOpenChange(false);
      onSaved?.();
    } catch (e) {
      toast({ variant: 'destructive', title: 'Could not log event', description: e.message });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-full h-full rounded-none sm:max-w-md sm:h-auto sm:rounded-lg overflow-y-auto">
        <DialogHeader><DialogTitle>Log time / event</DialogTitle></DialogHeader>
        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label>Type</Label>
              <Select value={type} onValueChange={setType}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {['Work session', 'Training', 'Site visit', 'Go-live', 'Meeting'].map((t) => (
                    <SelectItem key={t} value={t}>{t}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Date</Label>
              <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </div>
          </div>
          <div className="space-y-2">
            <Label>Hours (optional)</Label>
            <Input type="number" inputMode="decimal" min="0" step="0.5" value={hours} onChange={(e) => setHours(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label>Note</Label>
            <Input value={note} onChange={(e) => setNote(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label>Location (optional)</Label>
            <Select value={locationId} onValueChange={setLocationId}>
              <SelectTrigger className="w-full sm:w-64"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none">— none —</SelectItem>
                {locations.map((l) => <SelectItem key={l.id} value={String(l.id)}>{l.name} ({l.kind})</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" className="h-11 sm:h-10" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button className="h-11 sm:h-10" onClick={save} disabled={saving}>
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />} Log
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function FeedbackTab({ project, archived }) {
  const { toast } = useToast();
  const [items, setItems] = useState([]);
  const [addOpen, setAddOpen] = useState(false);
  const [form, setForm] = useState({ source_name: '', source_role: '', sentiment: 'positive', body: '' });
  const [editing, setEditing] = useState(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(() => {
    api.lbpFeedback(project.id).then((d) => setItems(d.feedback || [])).catch(() => {});
  }, [project.id]);
  useEffect(() => { load(); }, [load]);

  const sentimentBadge = (s) => (
    s === 'positive'
      ? <span className="rounded-full bg-green-500/10 px-2 py-0.5 text-xs font-bold text-green-600 dark:text-green-400">positive</span>
      : s === 'needs_work'
        ? <span className="rounded-full bg-red-500/10 px-2 py-0.5 text-xs font-bold text-red-600 dark:text-red-400">needs work</span>
        : <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-bold text-muted-foreground">neutral</span>
  );

  const openAdd = () => {
    setForm({ source_name: '', source_role: '', sentiment: 'positive', body: '' });
    setEditing(null);
    setAddOpen(true);
  };
  const openEdit = (f) => {
    setForm({ source_name: f.source_name || '', source_role: f.source_role || '', sentiment: f.sentiment, body: f.body });
    setEditing(f);
    setAddOpen(true);
  };

  const save = async () => {
    setSaving(true);
    try {
      const payload = {
        source_name: form.source_name.trim() || null,
        source_role: form.source_role.trim() || null,
        sentiment: form.sentiment,
        body: form.body.trim(),
      };
      if (editing) await api.lbpUpdateFeedback(editing.id, payload);
      else await api.lbpAddFeedback(project.id, payload);
      setAddOpen(false);
      load();
    } catch (e) {
      toast({ variant: 'destructive', title: 'Could not save feedback', description: e.message });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-xl border bg-card p-4">
      <div className="mb-2 flex items-center">
        <h3 className="text-xs font-bold uppercase tracking-wide text-muted-foreground">Feedback</h3>
        {!archived && (
          <Button size="sm" className="ml-auto h-10" onClick={openAdd}>
            <Plus className="mr-1 h-3.5 w-3.5" /> Capture feedback
          </Button>
        )}
      </div>
      {items.length === 0 && <p className="text-sm text-muted-foreground">No feedback captured yet.</p>}
      <div className="divide-y">
        {items.map((f) => (
          <div key={f.id} className="py-3">
            <div className="flex flex-wrap items-center gap-2">
              {sentimentBadge(f.sentiment)}
              <b className="text-sm">{f.source_name || 'Anonymous'}</b>
              {f.source_role && <span className="text-xs text-muted-foreground">{f.source_role}</span>}
              <span className="ml-auto text-xs text-muted-foreground">{fmtDate(f.captured_at)}</span>
              {f.editable && !archived && (
                <button type="button" className="text-primary" title="Edit (24h author window)" onClick={() => openEdit(f)}>
                  <Pencil className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
            <p className="mt-1 text-sm">{f.body}</p>
          </div>
        ))}
      </div>

      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="max-w-full h-full rounded-none sm:max-w-md sm:h-auto sm:rounded-lg overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editing ? 'Edit feedback' : 'Capture feedback'}</DialogTitle>
            <DialogDescription>Editable by you for 24 hours, then locked.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label>Who said it</Label>
                <Input value={form.source_name} onChange={(e) => setForm((s) => ({ ...s, source_name: e.target.value }))} />
              </div>
              <div className="space-y-2">
                <Label>Role</Label>
                <Input placeholder="e.g. Front desk, Site manager" value={form.source_role} onChange={(e) => setForm((s) => ({ ...s, source_role: e.target.value }))} />
              </div>
            </div>
            <div className="space-y-2">
              <Label>Sentiment</Label>
              <div className="flex gap-2">
                {[['positive', 'Positive'], ['neutral', 'Neutral'], ['needs_work', 'Needs work']].map(([v, l]) => (
                  <button key={v} type="button" onClick={() => setForm((s) => ({ ...s, sentiment: v }))}
                    className={`rounded-full border px-3 py-1.5 text-sm font-medium ${form.sentiment === v ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground'}`}>
                    {l}
                  </button>
                ))}
              </div>
            </div>
            <div className="space-y-2">
              <Label>What they said</Label>
              <textarea value={form.body} onChange={(e) => setForm((s) => ({ ...s, body: e.target.value }))} rows={3}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm" />
            </div>
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" className="h-11 sm:h-10" onClick={() => setAddOpen(false)}>Cancel</Button>
            <Button className="h-11 sm:h-10" onClick={save} disabled={saving || !form.body.trim()}>
              {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />} Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function LearningsTab({ project, archived }) {
  const { toast } = useToast();
  const [items, setItems] = useState([]);
  const [body, setBody] = useState('');

  const load = useCallback(() => {
    api.lbpLearnings(project.id).then((d) => setItems(d.learnings || [])).catch(() => {});
  }, [project.id]);
  useEffect(() => { load(); }, [load]);

  const add = async () => {
    if (!body.trim()) return;
    try {
      await api.lbpAddLearning(project.id, body.trim());
      setBody('');
      load();
    } catch (e) {
      toast({ variant: 'destructive', title: 'Could not add learning', description: e.message });
    }
  };

  return (
    <div className="rounded-xl border bg-card p-4">
      <h3 className="mb-2 text-xs font-bold uppercase tracking-wide text-muted-foreground">Learnings</h3>
      {!archived && (
        <div className="mb-3 flex flex-col gap-2 sm:flex-row">
          <Input value={body} onChange={(e) => setBody(e.target.value)} placeholder="What did we learn?"
            onKeyDown={(e) => e.key === 'Enter' && add()} />
          <Button className="h-11 sm:h-10" onClick={add} disabled={!body.trim()}>Add</Button>
        </div>
      )}
      {items.length === 0 && <p className="text-sm text-muted-foreground">No learnings yet. These feed the idea checker forever.</p>}
      <ul className="space-y-2">
        {items.map((l) => (
          <li key={l.id} className="rounded-lg bg-muted/40 p-3 text-sm">
            {l.body}
            <span className="mt-1 block text-xs text-muted-foreground">{fmtDate(l.created_at)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function FilesTab({ project, archived }) {
  const { toast } = useToast();
  const [files, setFiles] = useState([]);
  const [uploading, setUploading] = useState(false);

  const load = useCallback(() => {
    api.lbpFiles(project.id).then((d) => setFiles(d.files || [])).catch(() => {});
  }, [project.id]);
  useEffect(() => { load(); }, [load]);

  const onPick = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setUploading(true);
    try {
      await api.lbpUploadFile(project.id, file);
      load();
    } catch (err) {
      toast({ variant: 'destructive', title: 'Upload failed', description: err.message });
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="rounded-xl border bg-card p-4">
      <div className="mb-3 flex items-center">
        <h3 className="text-xs font-bold uppercase tracking-wide text-muted-foreground">Files</h3>
        {!archived && (
          <label className="ml-auto">
            <span className={`inline-flex h-11 cursor-pointer items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground sm:h-10 ${uploading ? 'opacity-60' : ''}`}>
              {uploading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Plus className="mr-1.5 h-4 w-4" />}
              Upload
            </span>
            <input type="file" className="hidden" onChange={onPick} disabled={uploading} />
          </label>
        )}
      </div>
      {files.length === 0 && <p className="text-sm text-muted-foreground">No files yet.</p>}
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 md:grid-cols-4">
        {files.map((f) => (
          <div key={f.id} className="overflow-hidden rounded-lg border">
            <a href={api.lbpFileUrl(f.id)} target="_blank" rel="noreferrer" className="block">
              {String(f.mime || '').startsWith('image/') ? (
                <img src={api.lbpFileUrl(f.id)} alt={f.original_name} className="h-24 w-full max-w-full object-cover" loading="lazy" />
              ) : (
                <div className="flex h-24 items-center justify-center bg-muted/40">
                  <FileText className="h-8 w-8 text-muted-foreground" />
                </div>
              )}
            </a>
            <div className="flex items-center gap-1 p-2">
              <span className="min-w-0 flex-1 truncate text-xs font-medium" title={f.original_name}>{f.original_name}</span>
              <a href={api.lbpFileUrl(f.id, true)} className="text-muted-foreground" title="Download">
                <Download className="h-3.5 w-3.5" />
              </a>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function TasksTab({ project, archived }) {
  const { toast } = useToast();
  const [tasks, setTasks] = useState([]);
  const [title, setTitle] = useState('');
  const [subFor, setSubFor] = useState(null);
  const [subTitle, setSubTitle] = useState('');

  const load = useCallback(() => {
    api.lbpTasks(project.id).then((d) => setTasks(d.tasks || [])).catch(() => {});
  }, [project.id]);
  useEffect(() => { load(); }, [load]);

  const roots = useMemo(() => tasks.filter((t) => !t.parent_id), [tasks]);
  const subsOf = useCallback((id) => tasks.filter((t) => t.parent_id === id), [tasks]);

  const add = async (parentId = null, text) => {
    const t = String(text || '').trim();
    if (!t) return;
    try {
      await api.lbpAddTask(project.id, { title: t, parent_id: parentId });
      if (parentId) { setSubTitle(''); setSubFor(null); } else setTitle('');
      load();
    } catch (e) {
      toast({ variant: 'destructive', title: 'Could not add task', description: e.message });
    }
  };

  const toggle = (task) => {
    api.lbpUpdateTask(task.id, { done: !task.done }).then(load)
      .catch((e) => toast({ variant: 'destructive', title: 'Could not update task', description: e.message }));
  };

  const remove = (task) => {
    api.lbpDeleteTask(task.id).then(load)
      .catch((e) => toast({ variant: 'destructive', title: 'Could not delete task', description: e.message }));
  };

  const TaskRow = ({ task, depth = 0 }) => (
    <div className={`flex items-center gap-2 py-1.5 ${depth ? 'pl-7' : ''}`}>
      <input type="checkbox" checked={!!task.done} disabled={archived} onChange={() => toggle(task)} className="h-4 w-4" />
      <span className={`min-w-0 flex-1 truncate text-sm ${task.done ? 'text-muted-foreground line-through' : ''}`}>{task.title}</span>
      {!archived && depth === 0 && (
        <button type="button" className="text-xs font-semibold text-primary" onClick={() => { setSubFor(task.id); setSubTitle(''); }}>
          + sub
        </button>
      )}
      {!archived && (
        <button type="button" className="text-muted-foreground" onClick={() => remove(task)} title="Delete">
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );

  return (
    <div className="rounded-xl border bg-card p-4">
      <h3 className="mb-1 text-xs font-bold uppercase tracking-wide text-muted-foreground">Tasks</h3>
      <p className="mb-3 text-xs text-muted-foreground">Task counts are informational — the rollout stage is the only progress axis.</p>
      {!archived && (
        <div className="mb-3 flex flex-col gap-2 sm:flex-row">
          <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Add a task…"
            onKeyDown={(e) => e.key === 'Enter' && add(null, title)} />
          <Button className="h-11 sm:h-10" onClick={() => add(null, title)} disabled={!title.trim()}>Add</Button>
        </div>
      )}
      {roots.length === 0 && <p className="text-sm text-muted-foreground">No tasks yet.</p>}
      <div className="divide-y">
        {roots.map((t) => (
          <div key={t.id}>
            <TaskRow task={t} />
            {subsOf(t.id).map((s) => <TaskRow key={s.id} task={s} depth={1} />)}
            {subFor === t.id && (
              <div className="flex gap-2 py-1.5 pl-7">
                <Input autoFocus value={subTitle} onChange={(e) => setSubTitle(e.target.value)} placeholder="Subtask…"
                  onKeyDown={(e) => e.key === 'Enter' && add(t.id, subTitle)} className="h-9" />
                <Button size="sm" className="h-9" onClick={() => add(t.id, subTitle)} disabled={!subTitle.trim()}>Add</Button>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function ActivityTab({ project, archived }) {
  const { toast } = useToast();
  const [entries, setEntries] = useState([]);
  const [comment, setComment] = useState('');

  const load = useCallback(() => {
    api.lbpActivity(project.id).then((d) => setEntries(d.activity || [])).catch(() => {});
  }, [project.id]);
  useEffect(() => { load(); }, [load]);

  const send = async () => {
    if (!comment.trim()) return;
    try {
      await api.lbpAddComment(project.id, comment.trim());
      setComment('');
      load();
    } catch (e) {
      toast({ variant: 'destructive', title: 'Could not post comment', description: e.message });
    }
  };

  const describe = (e) => {
    const p = e.payload || {};
    switch (e.type) {
      case 'comment': return e.body;
      case 'created': return `created the project (stage ${p.stage || 'Idea'})`;
      case 'stage_change': return `moved the stage ${p.from} → ${p.to}${p.skipped ? ' (skipped steps)' : ''}`;
      case 'scope_change': return p.summary || 'updated the rollout scope';
      case 'task_done': return `completed task “${p.title}”`;
      case 'metric_report': return `reported ${p.metric}: ${p.value} (${p.unit}) [report #${p.report_id}]`;
      case 'time_event': return `logged ${p.event_type}${p.hours ? ` (${p.hours}h)` : ''}`;
      case 'file_added': return `added file ${p.name}`;
      case 'feedback_added': return `captured ${String(p.sentiment || '').replace('_', ' ')} feedback`;
      case 'learning_added': return 'recorded a learning';
      case 'blocked': return `flagged a blocker${p.reason ? `: ${p.reason}` : ''}`;
      case 'unblocked': return 'broke the barrier (unblocked)';
      case 'link_added': return 'linked a related project';
      case 'lxc_linked': return 'linked an LXC build project';
      case 'outcome_set': return p.outcome === 'rolled_out' ? 'closed the project — rolled out ✓' : 'closed the project — abandoned ✕';
      default: return e.type;
    }
  };

  return (
    <div className="rounded-xl border bg-card p-4">
      {!archived && (
        <div className="mb-3 flex gap-2">
          <Input value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Add a comment (blockers go here)…"
            onKeyDown={(e) => e.key === 'Enter' && send()} />
          <Button size="icon" className="h-11 w-11 shrink-0 sm:h-10 sm:w-10" onClick={send} disabled={!comment.trim()} title="Post comment">
            <Send className="h-4 w-4" />
          </Button>
        </div>
      )}
      {entries.length === 0 && <p className="text-sm text-muted-foreground">No activity yet.</p>}
      <div className="divide-y">
        {entries.map((e) => (
          <div key={e.id} className="py-2.5">
            <div className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
              <b className={e.type === 'comment' ? 'text-foreground' : ''}>{e.author_name || 'system'}</b>
              <span>{timeAgo(e.created_at)}</span>
              <span className="ml-auto font-mono text-[10px]">#{e.id}</span>
            </div>
            <p className={`mt-0.5 text-sm ${e.type === 'comment' ? '' : 'text-muted-foreground'}`}>{describe(e)}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
