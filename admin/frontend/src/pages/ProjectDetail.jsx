// Mock2 project detail (Phase M2).
//
// A skeleton project page: derived status, the live URL, slug rotation,
// membership (editor/viewer), an admin custom-domain attach, an admin debug
// panel showing the container's bridge upstream (bridge_ip:port — NEVER a host
// port), and a sudo-gated delete. Chat, cycles, and the build view arrive in
// M7+; this proves the M2 create → live-URL loop and the role model (a viewer
// can open but not mutate).
//
// Reachable only when Mock2 is enabled; a direct visit on a disabled host or to
// a project the user can't see bounces home / 404s (handled by the API).
//
// MOBILE_FIRST: single column, stacked rows, 44px primary touch targets, a
// full-screen-on-<sm delete dialog. Renders clean at 360px.

import { useEffect, useState, useCallback, useRef } from 'react';
import { useParams, Link, Navigate, useNavigate } from 'react-router-dom';
import { useAuth } from '@/context/AuthContext';
import { api, ApiError } from '@/lib/api';
import { useToast } from '@/hooks/use-toast';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import {
  ArrowLeft, Loader2, ExternalLink, RefreshCw, Trash2, UserPlus, Flag, ShieldAlert,
  Archive, RotateCcw, Play, Lock, Download, GitBranch,
  Circle, Hammer, Unlock, Clock, Sparkles, TerminalSquare, MessageSquare,
} from 'lucide-react';
import { statusChip } from '@/lib/mock2-status.jsx';
import ConceptStage from '@/components/mock2/ConceptStage';
import ProjectTerminal from '@/components/mock2/ProjectTerminal';
import BuildMode from '@/components/mock2/BuildMode';
import { PreviewPanel, PreviewPlaceholder } from '@/components/mock2/ProjectPreview';
import { ProjectTimeCard, FrameworkDecisionsLog, EgressGrantsCard, ProjectComponentsCard } from '@/components/mock2/ProjectTimeCard';
import { fireConfetti } from '@/lib/confetti';

// Background lifecycle jobs (archive/rehydrate/wake) return 202; the page polls
// until the row reaches the job's target lifecycle (or fails). One map so the
// poll-until-done logic stays a single implementation.
const JOB_TARGET = { archive: 'archived', rehydrate: 'active', wake: 'active' };

export default function ProjectDetail() {
  const { id } = useParams();
  const { user } = useAuth();
  const storedUser = JSON.parse(localStorage.getItem('user') || '{}');
  const isAdmin = user?.role === 'admin' || storedUser?.role === 'admin';
  const { toast } = useToast();
  const navigate = useNavigate();

  const [gate, setGate] = useState('checking'); // 'checking' | 'enabled' | 'disabled'
  const [project, setProject] = useState(null);
  const [notFound, setNotFound] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [users, setUsers] = useState([]);
  const [newMember, setNewMember] = useState({ user_id: '', role: 'editor' });
  const [customDomain, setCustomDomain] = useState('');
  const [egressLog, setEgressLog] = useState(null);   // null = not loaded; [] = empty
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [pendingJob, setPendingJob] = useState(null); // 'archive' | 'rehydrate' | 'wake' | null
  const [provStatus, setProvStatus] = useState(null); // live provisioning progress + step log
  const [tab, setTab] = useState('chat'); // 'chat' | 'terminal' | 'details'
  // Once the Terminal tab has been opened we keep it mounted (forceMount below)
  // so its shell session survives switching to other tabs — the PTY only starts
  // on the first visit, not on page load.
  const [terminalVisited, setTerminalVisited] = useState(false);
  const [previewReloadNonce, setPreviewReloadNonce] = useState(0); // bump to remount the preview iframe
  const archivedDefaulted = useRef(false);
  const prevLifecycle = useRef(null);      // last-seen lifecycle, to detect the provisioning→active transition
  const confettiFired = useRef(false);     // guard the one-time online confetti within this mount

  // An archived project has no chat/terminal — land on Details once we know it's
  // archived (only the first time, so a manual tab switch still sticks).
  useEffect(() => {
    if (project?.lifecycle === 'archived' && !archivedDefaulted.current) {
      archivedDefaulted.current = true;
      setTab('details');
    }
  }, [project?.lifecycle]);

  // Remember once the Terminal tab has been opened so we keep its session mounted.
  useEffect(() => { if (tab === 'terminal') setTerminalVisited(true); }, [tab]);

  const load = useCallback(async () => {
    try {
      const res = await api.mock2GetProject(id);
      setProject(res.project);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) setNotFound(true);
      else console.error('load project failed:', err);
    } finally {
      setLoading(false);
    }
  }, [id]);

  // The concept chat (which polls) tells us when the mockup changed — a new one
  // was rendered, or it was discarded on approval. Reload the project so
  // preview_url appears (or falls back to the built app), and bump the nonce so
  // the preview iframe remounts: the mockup URL is stable, so the same src would
  // otherwise show stale content until a manual refresh.
  const handleMockupChanged = useCallback(() => {
    setPreviewReloadNonce((n) => n + 1);
    load();
  }, [load]);

  useEffect(() => {
    let cancelled = false;
    api.mock2Status()
      .then(() => {
        if (cancelled) return;
        setGate('enabled');
        load();
        if (isAdmin) {
          api.getUsers().then((r) => setUsers(r.users || r || [])).catch(() => {});
        }
      })
      .catch((err) => {
        if (!cancelled) setGate('disabled');
        if (!(err instanceof ApiError)) console.error('mock2 status check failed:', err);
      });
    return () => { cancelled = true; };
  }, [load, isAdmin]);

  // Keep the project row live so EVERY server-side transition surfaces on its own
  // — no manual refresh. Fast (4s) while provisioning or a lifecycle job is in
  // flight (status + URL are actively changing); gentler (6s) while the project
  // is simply active, which is what makes the stage switches automatic: design
  // approval unlocking Build, a newly raised rule question, a framework-drift
  // banner, or the container being idled to 'stopped' all reflect within seconds.
  // A terminal/stopped/archived project changes only by user action, so we idle.
  useEffect(() => {
    if (gate !== 'enabled') return undefined;
    const transitioning = project?.lifecycle === 'provisioning' || !!pendingJob;
    const live = project?.lifecycle === 'active';
    if (!transitioning && !live) return undefined;
    const t = setInterval(load, transitioning ? 4000 : 6000);
    return () => clearInterval(t);
  }, [gate, project, pendingJob, load]);

  // Poll the granular provisioning progress + step log so the UI can show what's
  // actually happening (and the failing step's error). Fetch once on load too, so
  // a just-failed project still shows its log while it's in memory (~2 min).
  useEffect(() => {
    if (gate !== 'enabled') return undefined;
    let cancelled = false;
    const poll = async () => {
      try {
        const s = await api.mock2ProjectProvisionStatus(id);
        if (!cancelled && s?.progress) setProvStatus(s);
      } catch { /* ignore */ }
    };
    poll();
    if (project?.lifecycle !== 'provisioning' && !pendingJob) return undefined;
    const t = setInterval(poll, 4000);
    return () => { cancelled = true; clearInterval(t); };
  }, [gate, project, pendingJob, id]);

  // Celebrate the project first coming online: fire a one-time confetti burst on
  // the provisioning → active transition. Guarded twice — a per-mount ref (so a
  // re-render can't repeat it) and a per-project localStorage key (so it only
  // ever fires the FIRST time this project comes online, not on later
  // stop→start or rehydrate cycles).
  useEffect(() => {
    const lc = project?.lifecycle || null;
    const prev = prevLifecycle.current;
    prevLifecycle.current = lc;
    if (prev === 'provisioning' && lc === 'active' && !confettiFired.current) {
      const key = `mock2:onlined:${id}`;
      let already = false;
      try { already = localStorage.getItem(key) === '1'; } catch { /* storage blocked */ }
      if (!already) {
        confettiFired.current = true;
        try { localStorage.setItem(key, '1'); } catch { /* storage blocked */ }
        fireConfetti();
      }
    }
  }, [project?.lifecycle, id]);

  // Clear the pending job once the row reaches its target (or fails).
  useEffect(() => {
    if (!pendingJob || !project) return;
    if (project.lifecycle === JOB_TARGET[pendingJob] || project.lifecycle === 'failed_provisioning') {
      setPendingJob(null);
    }
  }, [pendingJob, project]);

  const run = async (fn, okMsg) => {
    setBusy(true);
    try {
      await fn();
      if (okMsg) toast({ title: okMsg });
      await load();
    } catch (err) {
      toast({ variant: 'destructive', title: 'Action failed', description: err.message });
    } finally {
      setBusy(false);
    }
  };

  const addMember = () => {
    if (!newMember.user_id) return;
    run(
      () => api.mock2SetProjectMember(id, { user_id: Number(newMember.user_id), role: newMember.role }),
      'Member added',
    ).then(() => setNewMember({ user_id: '', role: 'editor' }));
  };

  const attachCustomDomain = () => {
    if (!customDomain.trim()) return;
    run(() => api.mock2SetProjectCustomDomain(id, customDomain.trim()), 'Custom domain attached')
      .then(() => setCustomDomain(''));
  };

  const loadEgressLog = async () => {
    setBusy(true);
    try {
      const res = await api.mock2GetEgressLog(id, 200);
      setEgressLog(res.entries || []);
    } catch (err) {
      setEgressLog([]);
      toast({ variant: 'destructive', title: 'Could not load traffic log', description: err.message });
    } finally {
      setBusy(false);
    }
  };

  // Kick off a background lifecycle job (archive/rehydrate/wake): fire the 202,
  // then let the poll drive the row to its target lifecycle. On a failed 202
  // (e.g. a 409 because the state changed under us) clear the pending flag so
  // the poll doesn't run forever.
  const startJob = async (job, apiCall, okMsg) => {
    setPendingJob(job);
    setBusy(true);
    try {
      await apiCall();
      if (okMsg) toast({ title: okMsg });
    } catch (err) {
      setPendingJob(null);
      toast({ variant: 'destructive', title: 'Action failed', description: err.message });
    } finally {
      setBusy(false);
      await load();
    }
  };
  const doArchive = () => {
    setConfirmArchive(false);
    startJob('archive', () => api.mock2ArchiveProject(id), 'Archiving project');
  };
  const doRehydrate = () => startJob('rehydrate', () => api.mock2RehydrateProject(id), 'Rehydrating project');
  const doWake = () => startJob('wake', () => api.mock2WakeProject(id), 'Starting container');

  const doDelete = async () => {
    setConfirmDelete(false);
    setBusy(true);
    try {
      await api.mock2DeleteProject(id); // api.request handles the sudo modal + replay
      toast({ title: 'Project deleted' });
      navigate('/projects');
    } catch (err) {
      toast({ variant: 'destructive', title: 'Delete failed', description: err.message });
      setBusy(false);
    }
  };

  if (!isAdmin && gate === 'disabled') return <Navigate to="/" replace />;
  if (gate === 'disabled') return <Navigate to="/" replace />;
  if (notFound) return <Navigate to="/projects" replace />;
  if (gate === 'checking' || loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (!project) return <Navigate to="/projects" replace />;

  // Hide mutating controls from a pure viewer (the server still enforces every
  // mutation via requireMock2Role). Admins and project editors may edit.
  const canEdit = isAdmin || project.my_role === 'admin' || project.my_role === 'editor';
  const isProvisioning = project.lifecycle === 'provisioning';
  const isArchived = project.lifecycle === 'archived';
  const isStopped = project.lifecycle === 'stopped';
  const orphaned = project.status === 'orphaned';
  // An archived project is frozen (Q4): every mutating control is hidden and
  // the server refuses the route regardless. Only view + rehydrate remain.
  const readOnly = isArchived;
  const jobBusy = busy || !!pendingJob;
  const designApproved = !!project.stage?.design_approved;

  // The Chat tab's centerpiece: the live preview iframe. While online, prefer the
  // current mockup's /_preview; once the design is approved (mockup discarded)
  // fall back to the built app at the project URL. Null ⇒ show a placeholder and
  // center the chat instead (matches "if the iframe can display, center the chat").
  const previewSrc = project.lifecycle === 'active'
    ? (project.preview_url || (designApproved && project.url ? project.url : null))
    : null;
  const terminalAvailable = !isArchived && canEdit && project.lifecycle === 'active';

  return (
    <div className="flex flex-col h-full min-h-0 gap-3">
      <div className="flex items-center gap-3 shrink-0">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 min-w-0">
            <h1 className="text-2xl font-bold tracking-tight truncate">{project.name}</h1>
            {statusChip(project.status, project.flagged)}
          </div>
        </div>
        <Button asChild variant="ghost" size="sm" className="shrink-0">
          <Link to="/projects"><ArrowLeft className="h-4 w-4 mr-1" />Projects</Link>
        </Button>
      </div>

      {orphaned && !isArchived ? (
        <div className="flex items-start gap-2 p-3 rounded-lg bg-amber-500/10 text-amber-600 text-sm shrink-0">
          <ShieldAlert className="h-4 w-4 mt-0.5 shrink-0" />
          <span>This project has no editors — it is orphaned. Add an editor to restore ownership.</span>
        </div>
      ) : null}

      {/* The checkout-lock banner moved into the Chat tab (above the preview) to
          reclaim vertical space; only the archived notice stays up here. */}
      {isArchived ? (
        <div className="flex items-start gap-2 p-3 rounded-lg bg-muted text-muted-foreground text-sm shrink-0">
          <Lock className="h-4 w-4 mt-0.5 shrink-0" />
          <span>
            This project is <span className="font-medium">archived and read-only</span>. Its git repo, history, and
            members are kept, but nothing can change until you rehydrate it.
            {project.archived_at ? <> Archived {new Date(project.archived_at).toLocaleString()}.</> : null}
          </span>
        </div>
      ) : null}

      {/* The stage flow (Chat to App → Build → Run) header was retired: the Build
          action lives at the bottom of the design chat (ConceptStage), and the
          Mockup/Build stage is shown on the project tiles. */}
      <Tabs value={tab} onValueChange={setTab} className="w-full flex-1 min-h-0 flex flex-col">
        <TabsList className="grid w-full grid-cols-3 h-auto shrink-0">
          <TabsTrigger value="chat" className="py-2"><MessageSquare className="h-4 w-4 mr-1.5" />Chat</TabsTrigger>
          <TabsTrigger value="terminal" className="py-2"><TerminalSquare className="h-4 w-4 mr-1.5" />Terminal</TabsTrigger>
          <TabsTrigger value="details" className="py-2"><Circle className="h-4 w-4 mr-1.5" />Details</TabsTrigger>
        </TabsList>

        {/* CHAT — the design-assistant conversation with the live mockup/app
            preview as the centerpiece, sized to fill the viewport. With a preview
            it's the large left pane and the chat sits beside it; with no preview
            yet the chat is centered on its own so it stays the focus. The
            checkout-lock banner rides at the top of this tab. */}
        <TabsContent value="chat" className="mt-3 flex-1 min-h-0 overflow-hidden">
          {isArchived ? (
            <p className="text-sm text-muted-foreground">
              This project is archived — the chat and preview are read-only history. Rehydrate it to continue building.
            </p>
          ) : (
            <div className="flex h-full min-h-0 flex-col gap-3">
              <LockBanner projectId={id} canEdit={canEdit} isAdmin={isAdmin} />
              {designApproved ? (
                // Build mode — build information on the left, the build/run/
                // maintenance chat on the right (the design conversation is
                // archived read-only in the Details tab).
                <BuildMode
                  projectId={id}
                  project={project}
                  canEdit={canEdit}
                  isAdmin={isAdmin}
                  previewSrc={previewSrc}
                  previewReloadNonce={previewReloadNonce}
                  provLog={provStatus?.progress?.log || null}
                  provMessage={provStatus?.progress?.message || null}
                  onChanged={load}
                  onBuilt={handleMockupChanged}
                />
              ) : previewSrc ? (
                // Design mode — the live mockup preview on the left, the design
                // conversation on the right.
                <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto lg:flex-row lg:overflow-hidden">
                  <div className="min-w-0 h-[55vh] lg:h-auto lg:flex-[1.55] lg:min-h-0">
                    <PreviewPanel src={previewSrc} title={project.name} approved={designApproved} reloadKey={previewReloadNonce} />
                  </div>
                  <div className="min-w-0 flex flex-col gap-4 lg:flex-1 lg:min-h-0">
                    <ConceptStage projectId={id} project={project} canEdit={canEdit} onApproved={load} onMockupChanged={handleMockupChanged} />
                  </div>
                </div>
              ) : (
                <div className="min-h-0 flex-1 overflow-y-auto">
                  <div className="mx-auto w-full max-w-3xl space-y-4">
                    <PreviewPlaceholder
                      project={project}
                      provLog={provStatus?.progress?.log || null}
                      provMessage={provStatus?.progress?.message || null}
                    />
                    <ConceptStage projectId={id} project={project} canEdit={canEdit} onApproved={load} onMockupChanged={handleMockupChanged} />
                  </div>
                </div>
              )}
            </div>
          )}
        </TabsContent>

        {/* TERMINAL — a shell into the project container (m2-<id>), filling the
            tab. forceMount keeps it in the DOM when another tab is active (Radix
            just sets `hidden`), so the WS + PTY session stays alive across tab
            switches; it only mounts after the first visit (terminalVisited), so
            the page never opens a shell it isn't asked for. */}
        <TabsContent value="terminal" forceMount className="mt-3 flex-1 min-h-0 overflow-hidden data-[state=inactive]:hidden">
          {terminalAvailable ? (
            terminalVisited ? (
              <ProjectTerminal projectId={id} containerName={project.container_name} defaultOpen fill />
            ) : null
          ) : (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center gap-2"><TerminalSquare className="h-4 w-4" /> Terminal</CardTitle>
                <CardDescription>
                  {isArchived
                    ? 'The container is archived — rehydrate the project to open a shell.'
                    : project.lifecycle !== 'active'
                      ? 'The container is not online. Start it to open a shell.'
                      : 'A shell into this project is available to editors and admins.'}
                </CardDescription>
              </CardHeader>
            </Card>
          )}
        </TabsContent>

        {/* DETAILS — the live URL, members, and all project administration. */}
        <TabsContent value="details" className="mt-3 space-y-6 flex-1 min-h-0 overflow-y-auto">
      {/* Live URL + provisioning progress */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Live URL</CardTitle>
          <CardDescription>Per-slug HTTPS via Let&apos;s Encrypt. The slug is opaque; rotate to mint a new one.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {isProvisioning ? (
            <div className="flex items-center gap-2 text-sm text-blue-500">
              <Loader2 className="h-4 w-4 animate-spin" />
              {provStatus?.progress?.message
                || (pendingJob === 'rehydrate' ? 'Rehydrating from the bare repo…' : 'Provisioning container, repo, and route…')}
            </div>
          ) : isArchived ? (
            <p className="text-sm text-muted-foreground">
              No live URL while archived. The slug <span className="font-mono break-all">{project.slug || '—'}</span> is
              still reserved — rehydrate to bring the same URL back.
            </p>
          ) : isStopped ? (
            <p className="text-sm text-muted-foreground">Container stopped to save resources. Start it to serve again.</p>
          ) : project.url ? (
            <a
              href={project.url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-sm text-primary hover:underline break-all"
            >
              {project.url}
              <ExternalLink className="h-3.5 w-3.5 shrink-0" />
            </a>
          ) : (
            <span className="text-sm text-muted-foreground">No URL yet.</span>
          )}
          {project.provision_error ? (
            <p className="text-xs text-red-500 break-all">{project.provision_error}</p>
          ) : null}
          {provStatus?.progress?.log?.length ? (
            <details className="rounded-md border bg-muted/30 text-xs">
              <summary className="cursor-pointer select-none px-3 py-2 font-medium text-muted-foreground">
                Provisioning log ({provStatus.progress.log.length} step{provStatus.progress.log.length === 1 ? '' : 's'})
              </summary>
              <ol className="max-h-64 overflow-auto border-t px-3 py-2 space-y-1 font-mono text-[11px] leading-relaxed">
                {provStatus.progress.log.map((entry, i) => (
                  <li key={i} className="break-all">
                    <span className="text-muted-foreground">
                      {entry.phase ? `[${entry.phase}] ` : ''}
                    </span>
                    <span className={/failed|error|not found|unreachable/i.test(entry.message) ? 'text-red-500' : 'text-foreground'}>
                      {entry.message}
                    </span>
                  </li>
                ))}
              </ol>
            </details>
          ) : null}
          <div className="flex flex-wrap gap-2">
            {canEdit && !isProvisioning && !isArchived && !isStopped && project.slug ? (
              <Button
                variant="outline" size="sm" className="h-9" disabled={jobBusy}
                onClick={() => run(() => api.mock2RotateProjectSlug(id), 'Slug rotated')}
              >
                <RefreshCw className={`h-4 w-4 mr-1 ${busy ? 'animate-spin' : ''}`} />Rotate slug
              </Button>
            ) : null}
            {isStopped ? (
              <Button
                variant="outline" size="sm" className="h-9" disabled={jobBusy}
                onClick={doWake}
              >
                {pendingJob === 'wake' ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Play className="h-4 w-4 mr-1" />}
                Start container
              </Button>
            ) : null}
            {canEdit && isArchived ? (
              <Button
                size="sm" className="h-9" disabled={jobBusy}
                onClick={doRehydrate}
              >
                {pendingJob === 'rehydrate' ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <RotateCcw className="h-4 w-4 mr-1" />}
                Rehydrate
              </Button>
            ) : null}
          </div>
        </CardContent>
      </Card>

      {/* Time tracking — project start + where the time went (live). */}
      <ProjectTimeCard projectId={id} />

      {/* Framework decisions log (admin) — every deviation request + how it was decided. */}
      {isAdmin ? <FrameworkDecisionsLog projectId={id} /> : null}

      {/* Declared outbound egress — the internal hosts the app must reach, each
          admin-approved; anything not declared+approved stays blocked. */}
      <EgressGrantsCard projectId={id} isAdmin={isAdmin} />

      {/* Standard components — what this app uses (suggested at define time or
          picked here), installed by the platform with zero build credits. */}
      <ProjectComponentsCard projectId={id} canEdit={canEdit} isActive={project.lifecycle === 'active'} />

      {/* (build cycle + build chat now live in the Chat tab above) */}

      {/* Design archive — where the design started. Once the design is approved
          the Chat tab becomes the build/run/maintenance chat, so the original
          design conversation + the mockup that kicked it all off are preserved
          here, read-only, so anyone can revisit them. */}
      {designApproved ? (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2"><Sparkles className="h-4 w-4" /> Design archive</CardTitle>
            <CardDescription>
              The original design mockup and the conversation that shaped it — kept read-only so you can always see
              where the design started.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {project.mockup_archive_url ? (
              <a
                href={project.mockup_archive_url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-sm text-primary hover:underline break-all"
              >
                Open the original design mockup
                <ExternalLink className="h-3.5 w-3.5 shrink-0" />
              </a>
            ) : (
              <p className="text-sm text-muted-foreground">The archived mockup preview is available once the project is online.</p>
            )}
            {/* The archived ConceptStage self-bounds its conversation (fixed
                scroll height + collapse/expand), so it stays inside this card. */}
            <ConceptStage projectId={id} project={project} canEdit={false} archived />
          </CardContent>
        </Card>
      ) : null}

      {/* Members */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Members</CardTitle>
          <CardDescription>Editors can build and manage; viewers can only look. Admins bypass membership.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {(project.members || []).length === 0 ? (
            <p className="text-sm text-muted-foreground">No members.</p>
          ) : (
            (project.members || []).map((m) => (
              <div key={m.user_id} className="flex items-center justify-between gap-3 p-3 border rounded-lg">
                <div className="min-w-0">
                  <span className="font-medium truncate">{m.username || `user ${m.user_id}`}</span>
                  <span className="ml-2 text-[11px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">{m.role}</span>
                </div>
                {canEdit && !readOnly ? (
                  <Button
                    variant="ghost" size="icon" className="h-9 w-9 text-red-500 shrink-0" disabled={busy}
                    onClick={() => run(() => api.mock2RemoveProjectMember(id, m.user_id), 'Member removed')}
                    aria-label={`Remove ${m.username || m.user_id}`}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                ) : null}
              </div>
            ))
          )}

          {canEdit && isAdmin && !readOnly ? (
            <div className="flex flex-col sm:flex-row gap-2 sm:items-end pt-1">
              <div className="flex-1 min-w-0 space-y-1.5">
                <Label htmlFor="member-user">Add member</Label>
                <Select value={newMember.user_id} onValueChange={(v) => setNewMember((s) => ({ ...s, user_id: v }))}>
                  <SelectTrigger id="member-user" className="h-11 sm:h-10"><SelectValue placeholder="Choose a user" /></SelectTrigger>
                  <SelectContent>
                    {users.map((u) => (
                      <SelectItem key={u.id} value={String(u.id)}>{u.username || u.display_name || `user ${u.id}`}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <Select value={newMember.role} onValueChange={(v) => setNewMember((s) => ({ ...s, role: v }))}>
                <SelectTrigger className="h-11 sm:h-10 sm:w-32"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="editor">editor</SelectItem>
                  <SelectItem value="viewer">viewer</SelectItem>
                </SelectContent>
              </Select>
              <Button className="h-11 sm:h-10 shrink-0" disabled={busy || !newMember.user_id} onClick={addMember}>
                <UserPlus className="h-4 w-4 mr-1" />Add
              </Button>
            </div>
          ) : null}
        </CardContent>
      </Card>

      {/* Flag overlay (any member — editors AND viewers, M8). A viewer who spots
          something wrong raises the `!` overlay + a queue item, same as an editor. */}
      {!readOnly ? (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Flag for admin</CardTitle>
            <CardDescription>The one manual overlay — raise or clear an admin flag on this project. Any member can flag.</CardDescription>
          </CardHeader>
          <CardContent>
            <Button
              variant={project.flagged ? 'outline' : 'secondary'} size="sm" className="h-9" disabled={busy}
              onClick={() => run(
                () => api.mock2FlagProject(id, { flagged: !project.flagged, reason: project.flagged ? undefined : 'Flagged from project page' }),
                project.flagged ? 'Flag cleared' : 'Project flagged',
              )}
            >
              <Flag className="h-4 w-4 mr-1" />{project.flagged ? 'Clear flag' : 'Flag an admin'}
            </Button>
          </CardContent>
        </Card>
      ) : null}

      {/* Admin: custom domain + debug */}
      {isAdmin && !readOnly ? (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Custom domain</CardTitle>
            <CardDescription>Point an A record at this host, then attach. Caddy issues an HTTP-01 cert for it.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {project.custom_domain ? (
              <p className="text-sm">Current: <span className="font-medium break-all">{project.custom_domain}</span></p>
            ) : null}
            <div className="flex flex-col sm:flex-row gap-2 sm:items-end">
              <div className="flex-1 min-w-0 space-y-1.5">
                <Label htmlFor="custom-domain">Domain</Label>
                <Input
                  id="custom-domain" placeholder="app.customer.com" value={customDomain}
                  onChange={(e) => setCustomDomain(e.target.value)}
                  autoCapitalize="none" autoCorrect="off" spellCheck={false}
                />
              </div>
              <Button className="h-11 sm:h-10 shrink-0" disabled={busy || !customDomain.trim()} onClick={attachCustomDomain}>
                Attach
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {/* Admin: egress traffic log. The container reaches the internet via its
          bridge's NAT; the firewall (nftables) logs every new outbound connection
          so you can see where traffic goes. It records destination IP:port (the
          firewall has no hostname visibility). BLOCK rows are lateral-movement
          attempts to private ranges the fence denied. */}
      {isAdmin ? (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Egress traffic</CardTitle>
            <CardDescription>
              Where this container&apos;s traffic goes, as the firewall recorded it. Egress is the bridge&apos;s NAT;
              the fence logs each new outbound connection and blocks lateral movement to private ranges.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <Label>Firewall log</Label>
              <Button variant="ghost" size="sm" className="h-9" disabled={busy} onClick={loadEgressLog}>
                {egressLog === null ? 'Load' : 'Refresh'}
              </Button>
            </div>
            {egressLog === null ? (
              <p className="text-xs text-muted-foreground">Recent outbound connections the container made, by destination IP:port.</p>
            ) : egressLog.length === 0 ? (
              <p className="text-xs text-muted-foreground">No traffic logged yet (or the host&apos;s kernel log isn&apos;t readable here).</p>
            ) : (
              <div className="max-h-64 overflow-auto rounded-md border">
                <ul className="divide-y text-xs">
                  {egressLog.slice().reverse().map((e, i) => (
                    <li key={i} className="flex items-center gap-2 px-2 py-1.5">
                      <span className={`shrink-0 font-mono font-medium ${
                        e.denied ? 'text-destructive' : e.action === 'GRANT' ? 'text-sky-600' : 'text-emerald-600'
                      }`}>
                        {e.action === 'GRANT' ? 'GRANT' : e.denied ? 'BLOCK' : 'OUT'}
                      </span>
                      <span className="shrink-0 font-mono text-muted-foreground">{e.method}</span>
                      <span className="min-w-0 break-all font-mono">{e.url}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </CardContent>
        </Card>
      ) : null}

      {/* M5: repository export (any member) + git push remote (admin). */}
      <RepoRemoteCard projectId={id} isAdmin={isAdmin} slug={project.slug} />

      {isAdmin ? (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Debug</CardTitle>
            <CardDescription>Container upstream on its per-project bridge — never a host port.</CardDescription>
          </CardHeader>
          <CardContent className="text-sm space-y-1 text-muted-foreground">
            <div className="flex justify-between gap-3"><span>Container</span><span className="font-mono break-all">{project.container_name || '—'}</span></div>
            <div className="flex justify-between gap-3"><span>Upstream</span><span className="font-mono break-all">{project.upstream || '—'}</span></div>
            <div className="flex justify-between gap-3"><span>Bridge</span><span className="font-mono break-all">{project.bridge_name || '—'}</span></div>
            <div className="flex justify-between gap-3"><span>Bridge subnet</span><span className="font-mono break-all">{project.bridge_cidr || '—'}</span></div>
            <div className="flex justify-between gap-3"><span>Bridge IP</span><span className="font-mono break-all">{project.bridge_ip || '—'}</span></div>
            <div className="flex justify-between gap-3"><span>Web port</span><span className="font-mono">{project.web_port || '—'}</span></div>
            <div className="flex justify-between gap-3"><span>Repo</span><span className="font-mono break-all">{project.repo_path || '—'}</span></div>
          </CardContent>
        </Card>
      ) : null}

      {/* Archive (admin or editor) — checkpoint into the bare repo, destroy the
          container, freeze the project read-only. Rehydrate rebuilds it later. */}
      {canEdit && !isArchived && !isProvisioning ? (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Archive</CardTitle>
            <CardDescription>
              Checkpoint the working tree into the bare repo, then destroy the container. The repo, history, and
              members are kept — rehydrate rebuilds the same URL from the repo alone (no snapshot).
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button
              variant="outline" size="sm" className="h-10" disabled={jobBusy}
              onClick={() => setConfirmArchive(true)}
            >
              {pendingJob === 'archive' ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Archive className="h-4 w-4 mr-1" />}
              Archive project
            </Button>
          </CardContent>
        </Card>
      ) : null}

      {/* Danger zone (admin + sudo). Hidden for archived projects — they are
          read-only and cannot be deleted, only rehydrated (Q4). */}
      {isAdmin && !isArchived ? (
        <Card className="border-red-500/30">
          <CardHeader className="pb-3">
            <CardTitle className="text-base text-red-500">Danger zone</CardTitle>
            <CardDescription>Destroys the container and route. The git repo and the slug reservation are kept (the slug is never reusable).</CardDescription>
          </CardHeader>
          <CardContent>
            <Button variant="destructive" size="sm" className="h-10" disabled={busy} onClick={() => setConfirmDelete(true)}>
              <Trash2 className="h-4 w-4 mr-1" />Delete project
            </Button>
          </CardContent>
        </Card>
      ) : null}
        </TabsContent>
      </Tabs>

      <Dialog open={confirmArchive} onOpenChange={(o) => !o && setConfirmArchive(false)}>
        <DialogContent className="max-w-full h-full rounded-none sm:max-w-md sm:h-auto sm:rounded-lg">
          <DialogHeader>
            <DialogTitle>Archive project?</DialogTitle>
            <DialogDescription>
              The working tree of <span className="font-medium">{project.name}</span> is committed and pushed into
              the bare repo, then the container is destroyed. The project becomes read-only. You can rehydrate it
              later to the same URL. Nothing is lost.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="flex-col sm:flex-row gap-2">
            <Button variant="outline" onClick={() => setConfirmArchive(false)} className="h-11 sm:h-10">Cancel</Button>
            <Button onClick={doArchive} className="h-11 sm:h-10">Archive</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={confirmDelete} onOpenChange={(o) => !o && setConfirmDelete(false)}>
        <DialogContent className="max-w-full h-full rounded-none sm:max-w-md sm:h-auto sm:rounded-lg">
          <DialogHeader>
            <DialogTitle>Delete project?</DialogTitle>
            <DialogDescription>
              This destroys <span className="font-medium">{project.name}</span>&apos;s container and removes its URL.
              The bare git repo and the slug reservation are retained. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="flex-col sm:flex-row gap-2">
            <Button variant="outline" onClick={() => setConfirmDelete(false)} className="h-11 sm:h-10">Cancel</Button>
            <Button variant="destructive" onClick={doDelete} className="h-11 sm:h-10">Delete</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// M5 — repository export (any member) + git push remote config (admin, ADR-006).
// Export as zip is `git archive` of the bare repo; credentials for a remote never
// enter a container. Self-contained so ProjectDetail's main loader stays lean.
function RepoRemoteCard({ projectId, isAdmin, slug }) {
  const { toast } = useToast();
  const [remote, setRemote] = useState(null); // { git_connector_id, remote_repo, push_on_checkpoint } | null
  const [connectors, setConnectors] = useState([]);
  const [form, setForm] = useState({ git_connector_id: '', remote_repo: '', push_on_checkpoint: false });
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await api.mock2GetProjectRemote(projectId);
      setRemote(r.remote || null);
      if (r.remote) setForm({ git_connector_id: String(r.remote.git_connector_id), remote_repo: r.remote.remote_repo, push_on_checkpoint: !!r.remote.push_on_checkpoint });
      if (isAdmin) {
        const g = await api.mock2ListGitConnectors().catch(() => ({ connectors: [] }));
        setConnectors(g.connectors || []);
      }
    } catch (err) {
      if (!(err instanceof ApiError)) console.error('load remote failed:', err);
    }
  }, [projectId, isAdmin]);

  useEffect(() => { load(); }, [load]);

  const saveRemote = async () => {
    if (!form.git_connector_id || !form.remote_repo.trim()) { toast({ variant: 'destructive', title: 'Pick a connector and enter a remote repo' }); return; }
    setBusy(true);
    try {
      await api.mock2SetProjectRemote(projectId, { git_connector_id: Number(form.git_connector_id), remote_repo: form.remote_repo.trim(), push_on_checkpoint: form.push_on_checkpoint });
      await load(); toast({ title: 'Remote saved' });
    } catch (err) { toast({ variant: 'destructive', title: 'Could not save remote', description: err.message }); }
    finally { setBusy(false); }
  };

  const clearRemote = async () => {
    setBusy(true);
    try { await api.mock2ClearProjectRemote(projectId); setRemote(null); setForm({ git_connector_id: '', remote_repo: '', push_on_checkpoint: false }); await load(); toast({ title: 'Remote cleared' }); }
    catch (err) { toast({ variant: 'destructive', title: 'Could not clear remote', description: err.message }); }
    finally { setBusy(false); }
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Repository</CardTitle>
        <CardDescription>Download the project&apos;s files or its full git history, or push it to an external remote (optional — the local bare repo is primary).</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap gap-2">
          <Button asChild variant="outline" size="sm" className="h-11 sm:h-10">
            <a href={api.mock2ProjectRepoBundleUrl(projectId)} download={`${slug || `project-${projectId}`}.bundle`}>
              <GitBranch className="h-4 w-4 mr-1" /> Download git repo
            </a>
          </Button>
          <Button asChild variant="outline" size="sm" className="h-11 sm:h-10">
            <a href={api.mock2ProjectExportZipUrl(projectId)} download={`${slug || `project-${projectId}`}.zip`}>
              <Download className="h-4 w-4 mr-1" /> Download project (.zip)
            </a>
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          <span className="font-medium">Git repo</span> is a bundle with full history (the checkpoints and change records) —
          reconstruct it with <code>git clone &lt;file&gt;.bundle</code>. <span className="font-medium">Project</span> is a zip
          of the current files only.
        </p>

        {isAdmin ? (
          <div className="space-y-2 border-t pt-4">
            <Label className="flex items-center gap-2"><GitBranch className="h-4 w-4" /> Git push remote</Label>
            {connectors.length === 0 ? (
              <p className="text-sm text-muted-foreground">No git connectors configured. <Link to="/projects/connectors" className="underline">Add one</Link> to push to GitHub/Gitea.</p>
            ) : (
              <div className="space-y-2">
                <Select value={form.git_connector_id} onValueChange={(v) => setForm({ ...form, git_connector_id: v })}>
                  <SelectTrigger className="h-11 sm:h-10"><SelectValue placeholder="Git connector" /></SelectTrigger>
                  <SelectContent>{connectors.map((c) => <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>)}</SelectContent>
                </Select>
                <Input className="h-11 sm:h-10" placeholder="org/name or full URL" value={form.remote_repo} onChange={(e) => setForm({ ...form, remote_repo: e.target.value })} />
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={form.push_on_checkpoint} onChange={(e) => setForm({ ...form, push_on_checkpoint: e.target.checked })} />
                  Push after each checkpoint
                </label>
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" className="h-11 sm:h-10" disabled={busy} onClick={saveRemote}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Save remote'}</Button>
                  {remote && <Button size="sm" variant="ghost" className="h-11 sm:h-10" disabled={busy} onClick={clearRemote}>Clear</Button>}
                </div>
                {remote?.last_push_error && <p className="text-xs text-red-500">Last push error: {remote.last_push_error}</p>}
              </div>
            )}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

// M6 — the checkout-lock banner (ADR-004). Shows the holder, time remaining, a
// warn state near expiry, and — for a lock held by someone else — a
// request-takeover (editor) / force-release (admin) control. Polls every 5s so
// the countdown stays live. Renders nothing when the project is not checked out.
function LockBanner({ projectId, canEdit, isAdmin }) {
  const { toast } = useToast();
  const [lock, setLock] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await api.mock2GetLock(projectId);
      setLock(r.lock?.held ? r.lock : null);
    } catch (err) {
      if (!(err instanceof ApiError)) console.error('load lock failed:', err);
    }
  }, [projectId]);

  useEffect(() => { load(); const t = setInterval(load, 5000); return () => clearInterval(t); }, [load]);

  if (!lock) return null;

  const mins = lock.remaining_seconds == null ? null : Math.max(0, Math.floor(lock.remaining_seconds / 60));
  const secs = lock.remaining_seconds == null ? null : Math.max(0, lock.remaining_seconds % 60);
  const remaining = lock.remaining_seconds == null ? '—' : `${mins}m ${secs}s`;
  const isCycle = lock.holder_type === 'cycle';

  const requestTakeover = async () => {
    setBusy(true);
    try { await api.mock2RequestTakeover(projectId); toast({ title: 'Takeover requested', description: 'The current holder has been pinged.' }); await load(); }
    catch (err) { toast({ variant: 'destructive', title: 'Could not request takeover', description: err.message }); }
    finally { setBusy(false); }
  };
  const forceRelease = async () => {
    setBusy(true);
    try { await api.mock2ForceReleaseLock(projectId); toast({ title: 'Lock released' }); await load(); }
    catch (err) { toast({ variant: 'destructive', title: 'Could not release lock', description: err.message }); }
    finally { setBusy(false); }
  };

  return (
    <div className={`flex flex-col sm:flex-row sm:items-center gap-2 p-3 rounded-lg text-sm ${lock.warn ? 'bg-amber-500/10 text-amber-600' : 'bg-blue-500/10 text-blue-600'}`}>
      <div className="flex items-start gap-2 min-w-0 flex-1">
        <Lock className="h-4 w-4 mt-0.5 shrink-0" />
        <span className="min-w-0">
          {isCycle ? 'A build cycle holds this project' : `Checked out by ${lock.holder_name || 'another user'}`}
          {' · '}<span className="whitespace-nowrap"><Clock className="inline h-3 w-3 mb-0.5" /> {remaining} left</span>
          {lock.takeover_requested_by ? ' · takeover requested' : ''}
        </span>
      </div>
      <div className="flex gap-2 shrink-0">
        {canEdit && !isCycle ? (
          <Button variant="outline" size="sm" className="h-9" disabled={busy} onClick={requestTakeover}>
            <Hammer className="h-4 w-4 mr-1" />Request takeover
          </Button>
        ) : null}
        {isAdmin ? (
          <Button variant="ghost" size="sm" className="h-9" disabled={busy} onClick={forceRelease}>
            <Unlock className="h-4 w-4 mr-1" />Force release
          </Button>
        ) : null}
      </div>
    </div>
  );
}

