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

import { useEffect, useState, useCallback, useRef, lazy, Suspense } from 'react';
import { useParams, Link, Navigate, useNavigate, useSearchParams, useOutletContext } from 'react-router-dom';
import { useIsMobile } from '@/hooks/use-media-query';
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
  Circle, Hammer, Unlock, Clock, Sparkles, TerminalSquare, MessageSquare, LayoutPanelLeft, Eye,
  Library, Cpu,
} from 'lucide-react';
import { statusChip } from '@/lib/mock2-status.jsx';
import ConceptStage from '@/components/mock2/ConceptStage';
// The asset library belongs to the DESIGN stage too, not only the build phase:
// a logo, a screenshot of the thing being replaced, or the copy a screen should
// carry is exactly the context the mockup should be made from — and it has to
// be collectable BEFORE the mockup exists, or it arrives too late to shape it.
import ProjectAssets from '@/components/mock2/ProjectAssets';
import ProjectTerminal from '@/components/mock2/ProjectTerminal';
import BuildMode from '@/components/mock2/BuildMode';
import { flightdeckPrefKey, readPref, writePref } from '@/lib/flightdeck';

// The Flightdeck IDE pulls in CodeMirror + xterm — heavy, and CodeMirror has
// internal circular deps that TDZ-crash if bundled into the eager page chunk.
// Load it on demand (only when a project's build phase renders it).
const Flightdeck = lazy(() => import('@/components/mock2/Flightdeck'));
import ConnectVsCode from '@/components/mock2/ConnectVsCode';
import { PreviewPanel, PreviewPlaceholder } from '@/components/mock2/ProjectPreview';
import { ProjectTimeCard, FrameworkDecisionsLog, EgressGrantsCard, ProjectComponentsCard } from '@/components/mock2/ProjectTimeCard';
import ProjectApiKeys from '@/components/mock2/ProjectApiKeys';
import ProjectAppAccess from '@/components/mock2/ProjectAppAccess';
import ProjectDesignElements from '@/components/mock2/ProjectDesignElements';
import ProjectRules from '@/components/mock2/ProjectRules';
import ProjectSetup from '@/components/mock2/ProjectSetup';
import ChatModeToggle from '@/components/mock2/ChatModeToggle';
import MobilePanelBar from '@/components/mock2/MobilePanelBar';
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
  // The Chat tab's conversation mode — Plan / Design / Build, one toggle across
  // both stages. null = "auto": Build once the design is approved, otherwise
  // Design if a mockup already exists, otherwise Plan (a fresh project starts
  // by talking the idea through). The user's explicit pick overrides auto, and
  // Build stays selectable for the life of the project once it unlocks — so
  // stepping back into Plan/Design always has a way back.
  const [chatMode, setChatMode] = useState(null);
  const chatModeResolved = chatMode
    ?? (project?.stage?.design_approved ? 'build' : (project?.current_mockup_id ? 'design' : 'plan'));
  // The design-stage exits (mockup accepted → MVP built, or mockup skipped) all
  // flip design_approved — land in the build chat the moment that happens, even
  // if the user had parked the toggle on Plan or Design.
  const prevApprovedRef = useRef(null);
  useEffect(() => {
    if (!project) return;
    const approvedNow = !!project.stage?.design_approved;
    if (prevApprovedRef.current === false && approvedNow) setChatMode('build');
    prevApprovedRef.current = approvedNow;
  }, [project]);
  // Details sub-tab — the card list grew past scannable, so it is grouped into
  // categories. Spend is the default (the most-asked question).
  const [detailsTab, setDetailsTab] = useState('spend');
  // Build-phase view: Flightdeck (IDE, default) vs the classic build view. The
  // URL (?view=) wins for deep-links, else the per-project remembered choice,
  // else Flightdeck. Persisted per project.
  const [searchParams, setSearchParams] = useSearchParams();
  const [buildView, setBuildViewState] = useState(() => {
    const q = searchParams.get('view');
    if (q === 'classic' || q === 'flightdeck') return q;
    return readPref(flightdeckPrefKey(id), 'flightdeck') === 'classic' ? 'classic' : 'flightdeck';
  });
  const setBuildView = useCallback((v) => {
    setBuildViewState(v);
    writePref(flightdeckPrefKey(id), v);
    const next = new URLSearchParams(searchParams);
    if (v === 'flightdeck') next.delete('view'); else next.set('view', v);
    setSearchParams(next, { replace: true });
  }, [id, searchParams, setSearchParams]);
  // In Flightdeck mode the tab strip is hidden, so only 'chat' (the workspace)
  // and 'details' are reachable — coerce a stale 'terminal' selection back. This
  // hook lives ABOVE the early returns below so hook order stays stable; the
  // Flightdeck condition is inlined (project may still be loading here).
  useEffect(() => {
    const fdActive = !!project?.stage?.design_approved && chatModeResolved === 'build'
      && buildView === 'flightdeck' && project?.lifecycle !== 'archived';
    if (fdActive && tab === 'terminal') setTab('chat');
  }, [project, buildView, tab, chatModeResolved]);
  // On a phone the studio takes the WHOLE screen — BOTH stages, mockup and
  // build: ask the shell to drop its mobile top bar and content padding, and
  // drive the nav drawer from the workspace's own bottom bar instead. Reset on
  // unmount (and on any state that leaves the studio) so every other page keeps
  // its chrome. The classic build view is excluded — it is a stacked, scrolling
  // page, not a panelled workspace.
  const { openNav, setChromeless } = useOutletContext() || {};
  const isMobile = useIsMobile();
  // Is this project driven as a phone STUDIO at all (panelled workspace + its
  // own bottom bar), regardless of which tab is showing? Details is one of the
  // bar's destinations, so it must be chromeless for the same reason the
  // workspace is: otherwise tapping Details stacks the shell's top bar and the
  // tab strip on top of a bar that already offers both.
  const phoneStudio = isMobile
    && !!project
    && project.lifecycle !== 'archived'
    && (project.stage?.design_approved
      // Post-approval with Plan/Design selected the chat is a stacked read-only
      // review page, not a panelled workspace — keep the shell's chrome there.
      ? chatModeResolved === 'build' && buildView === 'flightdeck'
      : true);
  const mobileStudio = phoneStudio && tab === 'chat';
  useEffect(() => {
    if (!setChromeless) return undefined;
    setChromeless(phoneStudio && (tab === 'chat' || tab === 'details'));
    return () => setChromeless(false);
  }, [setChromeless, phoneStudio, tab]);
  // Once the Terminal tab has been opened we keep it mounted (forceMount below)
  // so its shell session survives switching to other tabs — the PTY only starts
  // on the first visit, not on page load.
  const [terminalVisited, setTerminalVisited] = useState(false);
  const [previewReloadNonce, setPreviewReloadNonce] = useState(0); // bump to remount the preview iframe
  // Design stage's left column: the mockup, or the asset library it should
  // be made from. 'preview' by default — assets are opt-in context.
  const [designPane, setDesignPane] = useState('preview');
  // The phone workspaces' current panel, lifted out of MockupWorkspace and
  // Flightdeck so the Details page can carry the SAME bottom bar and hand the
  // operator straight back to the panel they pick. null means "whatever the
  // workspace's own default is" — it only becomes controlled once something
  // (an auto-switch, a tap) actually chooses.
  const [studioPanel, setStudioPanel] = useState(null);
  const assetsRef = useRef(null);   // the stacked design layout's asset library
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
      // users.id is a UUID string — Number() coercion turned it into NaN→null
      // and the server rejected the add ("user_id and role are required").
      () => api.mock2SetProjectMember(id, { user_id: String(newMember.user_id), role: newMember.role }),
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
  // Removing members is owner/admin-only (server-enforced too); anyone may
  // remove THEMSELVES (leave the project).
  const myId = String(user?.id ?? storedUser?.id ?? '');
  const isOwner = project.created_by != null && String(project.created_by) === myId;
  const canRemoveMember = (m) => isAdmin || isOwner || String(m.user_id) === myId;
  const isProvisioning = project.lifecycle === 'provisioning';
  const isArchived = project.lifecycle === 'archived';
  const isStopped = project.lifecycle === 'stopped';
  const orphaned = project.status === 'orphaned';
  // An archived project is frozen (Q4): every mutating control is hidden and
  // the server refuses the route regardless. Only view + rehydrate remain.
  const readOnly = isArchived;
  const jobBusy = busy || !!pendingJob;
  const designApproved = !!project.stage?.design_approved;
  // The Details "Manage" sub-tab holds only admin/editor levers (debug, archive,
  // delete) — hidden entirely for roles that would find it empty.
  const showManage = isAdmin || (canEdit && !isArchived && !isProvisioning);

  // The Chat tab's centerpiece: the live preview iframe. While online, prefer
  // the current mockup (served same-origin by the dashboard's /mockup-preview
  // route, so it works even while the project app is down or gated); once the
  // design is approved (mockup discarded) fall back to the built app at the
  // project URL. Null ⇒ show a placeholder and center the chat instead.
  const previewSrc = project.lifecycle === 'active'
    ? (project.preview_url || (designApproved && project.url ? project.url : null))
    : null;
  const terminalAvailable = !isArchived && canEdit && project.lifecycle === 'active';
  // Flightdeck fills the whole build area: when active we hide the
  // Chat/Terminal/Details tab strip (the terminal is built in; chat is the
  // right pane) and toggle its own center between the workspace and Details.
  // Only while the conversation mode is Build — stepping back to Plan/Design
  // swaps the workspace for the read-only design review.
  const flightdeckActive = designApproved && chatModeResolved === 'build' && buildView === 'flightdeck' && !isArchived;
  // The bottom bar the phone workspaces use, carried onto the Details page.
  // Same panel set as whichever stage the project is in, so tapping Details and
  // tapping back is one gesture each way rather than a dead end. Nothing on a
  // tablet or desktop (they still have their top bars) and nothing on an
  // archived project (it has no workspace to return to).
  const studioBarOnDetails = phoneStudio && tab === 'details'
    ? { panels: flightdeckActive ? FLIGHTDECK_PHONE_PANELS : MOCKUP_PANELS }
    : null;

  return (
    <div className="flex flex-col h-full min-h-0 gap-3">
      {/* On a phone in Flightdeck the title row goes away with the rest of the
          chrome — the project name is in the chat header and "Projects" is one
          tap away in the nav drawer, so this row was pure vertical cost. */}
      <div className={`${mobileStudio ? 'hidden' : 'flex'} items-center gap-3 shrink-0`}>
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
        {/* The tab strip is hidden in Flightdeck mode — it has its own chat and
            terminal, and a Details toggle in its top bar reclaims this height.
            Same on a phone in the mockup stage: the workspace's bottom bar
            carries Details, so this row would be a duplicate control. */}
        {!flightdeckActive && !mobileStudio && !studioBarOnDetails && (
          <TabsList className="grid w-full grid-cols-3 h-auto shrink-0">
            <TabsTrigger value="chat" className="py-2"><MessageSquare className="h-4 w-4 mr-1.5" />Chat</TabsTrigger>
            <TabsTrigger value="terminal" className="py-2"><TerminalSquare className="h-4 w-4 mr-1.5" />Terminal</TabsTrigger>
            <TabsTrigger value="details" className="py-2"><Circle className="h-4 w-4 mr-1.5" />Details</TabsTrigger>
          </TabsList>
        )}

        {/* CHAT — the design-assistant conversation with the live mockup/app
            preview as the centerpiece, sized to fill the viewport. With a preview
            it's the large left pane and the chat sits beside it; with no preview
            yet the chat is centered on its own so it stays the focus. The
            checkout-lock banner rides at the top of this tab. */}
        <TabsContent value="chat" className={`${mobileStudio ? 'mt-0' : 'mt-3'} flex-1 min-h-0 overflow-hidden`}>
          {isArchived ? (
            <p className="text-sm text-muted-foreground">
              This project is archived — the chat and preview are read-only history. Rehydrate it to continue building.
            </p>
          ) : (
            <div className={`flex h-full min-h-0 flex-col ${mobileStudio ? 'gap-0' : 'gap-3'}`}>
              {/* Not on a phone: the studio is chromeless there and this bar
                  took a third of the screen away from the conversation, which
                  is the whole reason to open ProxyPilot on a phone. It moves to
                  Details (one tap on the bottom bar), where it is still one
                  gesture away when someone actually needs to release a lock. */}
              <div className="hidden sm:block">
                <LockBanner projectId={id} canEdit={canEdit} isAdmin={isAdmin} />
              </div>
              {designApproved && chatModeResolved !== 'build' ? (
                // Build is unlocked but the toggle is parked on Plan/Design —
                // the design-stage conversation, read-only (the design is
                // locked in), with the toggle as the way back to Build.
                <div className="min-h-0 flex-1 overflow-y-auto">
                  <div className="mx-auto w-full max-w-3xl space-y-3">
                    <ChatModeToggle mode={chatModeResolved} onMode={setChatMode} buildUnlocked />
                    <p className="text-sm text-muted-foreground">
                      The design is locked in, so the plan and design conversation is read-only history now —
                      switch to Build to keep changing the app.
                    </p>
                    <ConceptStage projectId={id} project={project} canEdit={false} archived />
                  </div>
                </div>
              ) : designApproved ? (
                // Build phase — Flightdeck IDE workspace by default (files +
                // editor + agent chat + terminal + preview, one shared sandbox),
                // with a toggle back to the classic build view. Both drive the
                // same harness; the design conversation is archived read-only in
                // the Details tab.
                buildView === 'flightdeck' ? (
                  <Suspense fallback={<div className="flex items-center justify-center flex-1 min-h-0 py-16"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>}>
                    <Flightdeck
                      projectId={id}
                      project={project}
                      canEdit={canEdit}
                      isAdmin={isAdmin}
                      previewSrc={previewSrc}
                      provLog={provStatus?.progress?.log || null}
                      provMessage={provStatus?.progress?.message || null}
                      onChanged={load}
                      onBuilt={handleMockupChanged}
                      onSwitchView={() => setBuildView('classic')}
                      onShowDetails={() => setTab('details')}
                      panel={studioPanel} onPanel={setStudioPanel}
                      onOpenNav={openNav || null}
                      onChatMode={setChatMode}
                    />
                  </Suspense>
                ) : (
                  // A min-h-0 flex column, NOT a plain block: the Chat tab is
                  // overflow-hidden, so a block wrapper here let BuildMode grow
                  // past it and get clipped — the classic view could not scroll.
                  <div className="flex min-h-0 flex-1 flex-col gap-2">
                    <div className="flex justify-end shrink-0">
                      <Button variant="outline" size="sm" className="min-h-[36px]" onClick={() => setBuildView('flightdeck')}>
                        Open Flightdeck
                      </Button>
                    </div>
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
                      onChatMode={setChatMode}
                    />
                  </div>
                )
              ) : mobileStudio ? (
                // Design mode on a phone — the same panelled workspace
                // Flightdeck uses in the build phase, so the two stages feel
                // like one app: full screen, one panel at a time, the shared
                // bottom bar as the only chrome.
                <MockupWorkspace
                  projectId={id}
                  project={project}
                  canEdit={canEdit}
                  previewSrc={previewSrc}
                  previewReloadNonce={previewReloadNonce}
                  provLog={provStatus?.progress?.log || null}
                  provMessage={provStatus?.progress?.message || null}
                  onApproved={load}
                  onMockupChanged={handleMockupChanged}
                  onOpenNav={openNav || null}
                  onShowDetails={() => setTab('details')}
                  panel={studioPanel} onPanel={setStudioPanel}
                  chatMode={chatModeResolved} onChatMode={setChatMode}
                />
              ) : previewSrc ? (
                // Design mode — the live mockup preview on the left, the design
                // conversation on the right.
                <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto lg:flex-row lg:overflow-hidden">
                  {/* Preview / Assets — the same strip Flightdeck's clean view
                      uses. Collecting a logo or the copy a screen should carry
                      is design work, so it belongs beside the mockup rather
                      than only in the build phase. */}
                  <div className="min-w-0 h-[55vh] lg:h-auto lg:flex-[1.55] lg:min-h-0 flex flex-col">
                    <DesignLeftPane
                      tab={designPane} onTab={setDesignPane}
                      projectId={id} canEdit={canEdit}
                      preview={<PreviewPanel src={previewSrc} title={project.name} approved={designApproved} reloadKey={previewReloadNonce} projectId={designApproved ? null : id} watchProjectId={id} />}
                    />
                  </div>
                  <div className="min-w-0 flex flex-col gap-4 lg:flex-1 lg:min-h-0">
                    <ConceptStage
                      projectId={id} project={project} canEdit={canEdit}
                      onApproved={load} onMockupChanged={handleMockupChanged}
                      provLog={provStatus?.progress?.log || null}
                      provMessage={provStatus?.progress?.message || null}
                      onOpenAssets={() => setDesignPane('assets')}
                      mode={chatModeResolved} onModeChange={setChatMode}
                    />
                  </div>
                </div>
              ) : (
                <div className="min-h-0 flex-1 overflow-y-auto">
                  <div className="mx-auto w-full max-w-3xl space-y-4">
                    {/* While provisioning, the CHAT carries the step list — this
                        placeholder would print the same spinner and the same
                        four steps directly above it. Once the project is up it
                        earns its place again: it is what explains where the
                        preview will appear. */}
                    {isProvisioning ? null : (
                      <PreviewPlaceholder
                        project={project}
                        provLog={provStatus?.progress?.log || null}
                        provMessage={provStatus?.progress?.message || null}
                      />
                    )}
                    <ConceptStage
                      projectId={id} project={project} canEdit={canEdit}
                      onApproved={load} onMockupChanged={handleMockupChanged}
                      provLog={provStatus?.progress?.log || null}
                      provMessage={provStatus?.progress?.message || null}
                      // This layout already has the library on screen below, so
                      // "Add assets" scrolls to it rather than switching panes.
                      onOpenAssets={() => assetsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
                      mode={chatModeResolved} onModeChange={setChatMode}
                    />
                    {/* Before the first mockup exists is the MOST useful moment
                        to hand over a logo or a reference shot — it is what the
                        mockup gets made from. */}
                    <div ref={assetsRef}>
                      <ProjectAssets projectId={id} canEdit={canEdit} />
                    </div>
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
        {/* A flex column, not a scroll box: the phone's bottom bar rides
            below the scrolling detail, so tapping Details never strands
            someone on a page with no way back to Preview or Assets. */}
        <TabsContent value="details" className={`${studioBarOnDetails ? 'mt-0' : 'mt-3'} flex-1 min-h-0 overflow-hidden`}>
        <div className="flex h-full min-h-0 flex-col">
        <div className="space-y-6 flex-1 min-h-0 overflow-y-auto">
      {/* The checkout state lives here on a phone (it is hidden from the studio
          view above); harmless duplication on desktop is avoided by showing it
          only where the studio does not. */}
      <div className="sm:hidden">
        <LockBanner projectId={id} canEdit={canEdit} isAdmin={isAdmin} />
      </div>
      {/* In Flightdeck mode this Details view replaces the workspace in the
          center; a slim bar returns to Flightdeck (or drops to the classic view). */}
      {flightdeckActive ? (
        <div className="flex items-center justify-end gap-2 sticky top-0 z-10 -mt-1 pb-2 bg-background/95 backdrop-blur">
          {/* Classic view is a desktop choice — a phone only ever gets the
              clean Flightdeck, so the switch would be a dead end there. */}
          <Button variant="outline" size="sm" className="hidden md:inline-flex h-8" onClick={() => setBuildView('classic')}>Classic view</Button>
          <Button size="sm" className="h-11 md:h-8" onClick={() => setTab('chat')}><LayoutPanelLeft className="h-3.5 w-3.5 mr-1" />Flightdeck</Button>
        </div>
      ) : null}
      {/* The card list outgrew one scroll — grouped into categories, spend
          first. MOBILE_FIRST: the strip wraps at 360px, 44px triggers. */}
      <Tabs value={detailsTab} onValueChange={setDetailsTab} className="w-full">
        <TabsList className={`grid w-full h-auto gap-1 ${showManage ? 'grid-cols-3 sm:grid-cols-5' : 'grid-cols-2 sm:grid-cols-4'}`}>
          <TabsTrigger value="spend" className="min-h-[44px]">Spend</TabsTrigger>
          <TabsTrigger value="overview" className="min-h-[44px]">Overview</TabsTrigger>
          <TabsTrigger value="build" className="min-h-[44px]">Build</TabsTrigger>
          <TabsTrigger value="access" className="min-h-[44px]">Access</TabsTrigger>
          {showManage ? (
            <TabsTrigger value="manage" className="min-h-[44px]">Manage</TabsTrigger>
          ) : null}
        </TabsList>

        {/* SPEND (default) — the breakdown first, then everything else that
            decides where the money goes. */}
        <TabsContent value="spend" className="mt-4 space-y-6">
          {/* Time tracking + model spend (tokens & cost by stage) — live. */}
          <ProjectTimeCard projectId={id} />
          {/* Provider API keys ride with spend: they decide whose bill the
              model calls land on (personal key → project key → global). */}
          <ProjectApiKeys projectId={id} canEdit={canEdit && !isArchived} isAdmin={isAdmin} />
        </TabsContent>

        {/* OVERVIEW — the URL, the setup guide, the people. */}
        <TabsContent value="overview" className="mt-4 space-y-6">
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

      {/* Setup guide — the first-run checklist. This Overview card is its ONE
          home (operator request: not also above the tabs). */}
      <ProjectSetup projectId={id} canEdit={canEdit && !isArchived} onJump={() => setTab('chat')} />

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
            <div className="flex flex-wrap items-center gap-3">
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
              {/* The visual reference for the design standards this project is
                  built on — its preset is highlighted on the page. */}
              <Button asChild variant="outline" size="sm" className="h-11 sm:h-9">
                <Link to={`/projects/design${project.design_preset ? `?preset=${encodeURIComponent(project.design_preset)}` : ''}`}>
                  Design specs
                </Link>
              </Button>
            </div>
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
                {canEdit && !readOnly && canRemoveMember(m) ? (
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
        </TabsContent>

        {/* BUILD — how this project's builds run: the engine, the app's own
            accounts, the design vocabulary, the rules, and the components. */}
        <TabsContent value="build" className="mt-4 space-y-6">
      {/* Build harness — ProxyPilot's runner or the Claude Agent SDK, per project. */}
      <HarnessCard projectId={id} canEdit={canEdit && !isArchived} />

      {/* AI provider — with multiple global providers configured, THIS project
          must declare which one drives its phase-routed builds. */}
      <ProviderCard project={project} canEdit={canEdit && !isArchived} onChanged={load} />

      {/* The app's own accounts (first admin, screen accounts, demo content). */}
      <ProjectAppAccess projectId={id} canEdit={canEdit && !isArchived} />

      {/* New elements — what the builds designed that the approved mockup does
          not have. Promotion is the only way the design vocabulary grows past
          the one mockup it was frozen at. */}
      <ProjectDesignElements projectId={id} canEdit={canEdit && !isArchived} />

      {/* The rules every build honours — confirmed (sign-off #2) and the
          baseline floor. Read-only: this is the read side state/rules.md
          never had, not a second place to edit it. */}
      <ProjectRules projectId={id} />

      {/* Standard components — what this app uses (suggested at define time or
          picked here), installed by the platform with zero build credits. */}
      <ProjectComponentsCard projectId={id} canEdit={canEdit} isActive={project.lifecycle === 'active'} />

      {/* Quick connect — clone/push the project repo from VS Code or any git
          client; pushes are recorded, synced into the container, and deployed. */}
      {!isArchived ? <ConnectVsCode projectId={id} canEdit={canEdit} /> : null}

      {/* Framework decisions log (admin) — every deviation request + how it was decided. */}
      {isAdmin ? <FrameworkDecisionsLog projectId={id} /> : null}
        </TabsContent>

        {/* ACCESS — domains, network, and the repository. */}
        <TabsContent value="access" className="mt-4 space-y-6">
      {/* Declared outbound egress — the internal hosts the app must reach, each
          admin-approved; anything not declared+approved stays blocked. */}
      <EgressGrantsCard projectId={id} isAdmin={isAdmin} />

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
        </TabsContent>

        {/* MANAGE — the admin/editor levers: debug, archive, delete. */}
        {showManage ? (
        <TabsContent value="manage" className="mt-4 space-y-6">
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
        ) : null}
      </Tabs>
        </div>
        {studioBarOnDetails ? (
          <MobilePanelBar
            panels={studioBarOnDetails.panels}
            current={null}
            onSelect={(key) => { setStudioPanel(key); setTab('chat'); }}
            onOpenNav={openNav || null}
            onShowDetails={() => undefined}
            detailsActive
          />
        ) : null}
        </div>
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

// Which agent harness drives this project's builds — Copilot (the default,
// Copilot-grade editing), ProxyPilot's original built-in runner, or the Claude
// Agent SDK (with its `search` and `pull-website` subagents). Exactly one
// harness per project; the choice persists immediately and applies from the
// next build cycle. The Claude option stays disabled, with
// the server's reason shown, until an Anthropic API key is configured
// server-side — the key itself never reaches the browser (the API returns only
// a configured boolean + source label). Self-contained loader, like the other
// detail cards. MOBILE_FIRST: the segmented pair collapses to one column on
// mobile and both targets are ≥44px tall.
function HarnessCard({ projectId, canEdit }) {
  const { toast } = useToast();
  const [info, setInfo] = useState(null); // { harness, claude: { configured, source, reason } }
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try { setInfo(await api.mock2GetProjectHarness(projectId)); }
    catch (err) { if (!(err instanceof ApiError)) console.error('load harness failed:', err); }
  }, [projectId]);
  useEffect(() => { load(); }, [load]);

  const choose = async (harness) => {
    if (!info || busy || harness === info.harness) return;
    setBusy(true);
    try {
      const r = await api.mock2SetProjectHarness(projectId, harness);
      setInfo((cur) => ({ ...cur, harness: r.harness, claude: r.claude ?? cur?.claude }));
      const label = harness === 'claude' ? 'Claude' : harness === 'proxypilot' ? 'ProxyPilot' : 'Copilot';
      toast({ title: `Build harness: ${label}`, description: 'Saved. Applies from the next build cycle.' });
    } catch (err) {
      toast({ variant: 'destructive', title: 'Could not switch harness', description: err.message });
    } finally { setBusy(false); }
  };

  const active = info?.harness || 'copilot';
  const claudeReady = !!info?.claude?.configured;
  const seg = (value, label, caption, disabled) => (
    <Button
      type="button"
      role="radio"
      aria-checked={active === value}
      variant={active === value ? 'default' : 'outline'}
      disabled={disabled}
      onClick={() => choose(value)}
      className="min-h-[44px] h-auto w-full flex-col items-start gap-0.5 py-2"
    >
      <span className="font-medium">{label}{active === value ? ' · active' : ''}</span>
      <span className="text-xs font-normal opacity-80">{caption}</span>
    </Button>
  );

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2"><Hammer className="h-4 w-4" /> Build harness</CardTitle>
        <CardDescription>
          Which engine drives this project&apos;s builds. Exactly one at a time; switching applies from the next build cycle.
          Gates, checkpoints, and change records are identical on both.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2" role="radiogroup" aria-label="Build harness">
          {seg('copilot', 'Copilot', 'Copilot-grade editing (default)', !info || busy || !canEdit)}
          {seg('proxypilot', 'ProxyPilot', 'Original built-in runner', !info || busy || !canEdit)}
          {seg('claude', 'Claude', 'Claude Agent SDK + web search/fetch subagents', !info || busy || !canEdit || !claudeReady)}
        </div>
        {info && !claudeReady ? (
          <div className="flex items-start gap-2 p-3 rounded-lg text-sm bg-amber-500/10 text-amber-600">
            <ShieldAlert className="h-4 w-4 mt-0.5 shrink-0" />
            <span className="min-w-0">{info.claude?.reason || 'The Claude harness is not configured on this server.'}</span>
          </div>
        ) : null}
        {!canEdit ? (
          <p className="text-xs text-muted-foreground">Only editors can change the harness.</p>
        ) : null}
      </CardContent>
    </Card>
  );
}

// Which AI providers drive this project's phase-routed builds. Multi-select:
// pick one provider to pin the project to it (the choice BINDS — a broken
// credential fails the build loudly instead of silently flipping), pick both
// for Hybrid (cheap/mid on OpenAI, top tier on Anthropic), or pick none to
// follow the global settings — every provider with a usable credential, which
// with multiple providers configured IS hybrid. The project setting only ever
// narrows what the platform has; it never adds a provider. Stored as
// 'anthropic' | 'openai' | 'hybrid' (both) | null (default). MOBILE_FIRST:
// one column on phones, ≥44px targets.
function ProviderCard({ project, canEdit, onChanged }) {
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const pref = project?.provider_preference || null;
  const selected = pref === 'hybrid' ? ['anthropic', 'openai'] : pref ? [pref] : [];

  const save = async (nextSelected) => {
    const preference = nextSelected.length === 2 ? 'hybrid' : (nextSelected[0] || '');
    if (!project || busy) return;
    setBusy(true);
    try {
      await api.mock2SetProviderPreference(project.id, preference);
      const label = preference === 'hybrid' ? 'Hybrid (all providers)'
        : preference === 'openai' ? 'OpenAI only'
          : preference === 'anthropic' ? 'Anthropic only'
            : 'Default — follow the global settings';
      toast({ title: `AI providers: ${label}`, description: 'Saved. Applies from the next build cycle.' });
      if (onChanged) onChanged();
    } catch (err) {
      toast({ variant: 'destructive', title: 'Could not set the providers', description: err.message });
    } finally { setBusy(false); }
  };

  const toggle = (value) => {
    const next = selected.includes(value) ? selected.filter((v) => v !== value) : [...selected, value];
    save(next);
  };

  const seg = (value, label, caption) => {
    const on = selected.includes(value);
    return (
      <Button
        type="button"
        role="checkbox"
        aria-checked={on}
        variant={on ? 'default' : 'outline'}
        disabled={!project || busy || !canEdit}
        onClick={() => toggle(value)}
        className="min-h-[44px] h-auto w-full flex-col items-start gap-0.5 py-2"
      >
        <span className="font-medium">{label}{on ? ' · selected' : ''}</span>
        <span className="text-xs font-normal opacity-80">{caption}</span>
      </Button>
    );
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2"><Cpu className="h-4 w-4" /> AI providers</CardTitle>
        <CardDescription>
          Which providers&apos; models drive this project&apos;s builds. Select one to pin the project to it,
          both for Hybrid (cheap/mid tiers on OpenAI, top tier on Anthropic), or none to follow the
          global settings — with multiple providers configured, that default is Hybrid.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2" role="group" aria-label="AI providers">
          {seg('anthropic', 'Anthropic', 'Claude models (Opus / Sonnet / Haiku)')}
          {seg('openai', 'OpenAI', 'GPT-5.6 (Sol / Terra / Luna)')}
        </div>
        <p className="text-xs text-muted-foreground">
          {selected.length === 0
            ? 'Default — following the global settings: every provider with a usable credential (Hybrid when more than one).'
            : selected.length === 2
              ? 'Hybrid — cheap/mid phases on OpenAI, top-tier phases (plan, review) on Anthropic.'
              : `Pinned to ${selected[0] === 'openai' ? 'OpenAI' : 'Anthropic'} — if its credential breaks, builds fail loudly rather than switching providers on their own.`}
        </p>
        {!canEdit ? (
          <p className="text-xs text-muted-foreground">Only editors can change the providers.</p>
        ) : null}
      </CardContent>
    </Card>
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

// MockupWorkspace — the design (pre-approval) stage on a phone.
//
// Desktop shows the mockup preview and the design conversation side by side;
// stacking those on a phone put the chat under a half-height preview under a
// lock banner under two page headers, so the conversation you actually type
// into got a sliver of the screen. This is the same shape Flightdeck uses in
// the build phase — one full-height panel at a time under the shared bottom
// bar — so moving from design to build doesn't change how the app is driven.
//
// MOBILE_FIRST: phone-only by construction (the caller renders it under
// mobileStudio); every bar item is a ≥44px target and nothing scrolls sideways.
// DesignLeftPane — Preview | Assets, the design stage's left column.
//
// Deliberately the same two-button strip as Flightdeck's clean view rather than
// a new pattern: the design and build stages are one workflow, and an operator
// who learned where assets live in one should find them in the same place in
// the other. MOBILE_FIRST: 44px targets, wraps, no fixed widths.
function DesignLeftPane({ tab, onTab, projectId, canEdit, preview }) {
  return (
    <>
      <div className="flex items-center gap-1 px-1 pb-2 shrink-0">
        <button
          type="button" onClick={() => onTab('preview')}
          className={`min-h-[44px] rounded px-3 py-1 text-xs ${tab === 'preview' ? 'bg-background border' : 'text-muted-foreground'}`}
        >
          <Eye className="mr-1 inline h-3.5 w-3.5" />Preview
        </button>
        <button
          type="button" onClick={() => onTab('assets')}
          className={`min-h-[44px] rounded px-3 py-1 text-xs ${tab === 'assets' ? 'bg-background border' : 'text-muted-foreground'}`}
        >
          <Library className="mr-1 inline h-3.5 w-3.5" />Assets
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {tab === 'assets' ? <ProjectAssets projectId={projectId} canEdit={canEdit} /> : preview}
      </div>
    </>
  );
}

// The build stage's phone panels — the same three keys Flightdeck offers on a
// phone (PHONE_PANEL_KEYS there). Duplicated rather than imported because this
// is the DETAILS page's copy of the bar; Flightdeck is lazy-loaded and must not
// be pulled in just to draw five buttons.
const FLIGHTDECK_PHONE_PANELS = [
  { key: 'chat', label: 'Chat', icon: MessageSquare },
  { key: 'preview', label: 'Preview', icon: Eye },
  { key: 'assets', label: 'Assets', icon: Library },
];

const MOCKUP_PANELS = [
  { key: 'chat', label: 'Chat', icon: MessageSquare },
  { key: 'preview', label: 'Preview', icon: Eye },
  // Same three panels the build phase offers, so the two stages feel like one
  // app — and so assets can be gathered before the first mockup render.
  { key: 'assets', label: 'Assets', icon: Library },
];

function MockupWorkspace({
  projectId, project, canEdit, previewSrc, previewReloadNonce, provLog, provMessage,
  onApproved, onMockupChanged, onOpenNav, onShowDetails, panel: panelProp, onPanel,
  chatMode = null, onChatMode = null,
}) {
  // Start where the work is: the chat until a mockup exists, the mockup once
  // one does. The panel is MIRRORED to the parent (onPanel) rather than owned
  // here, so the Details page's copy of the bottom bar shows the same state and
  // can return to it.
  const [ownPanel, setOwnPanel] = useState(previewSrc ? 'preview' : 'chat');
  const panel = panelProp || ownPanel;
  const setPanel = useCallback((key) => {
    setOwnPanel(key);
    if (onPanel) onPanel(key);
  }, [onPanel]);
  // The FIRST mockup appearing is the moment worth interrupting for — the user
  // asked for a screen and it just rendered. Later re-renders reuse the same
  // URL and don't yank the panel out from under someone mid-sentence.
  const hadPreview = useRef(!!previewSrc);
  useEffect(() => {
    if (previewSrc && !hadPreview.current) { hadPreview.current = true; setPanel('preview'); }
  }, [previewSrc]);

  return (
    <div className="flex flex-1 min-h-0 flex-col">
      {/* A flex column, not a scroll box: each panel owns the exact height and
          scrolls INSIDE itself, so the chat composer and the preview toolbar
          stay on screen instead of sliding under the bottom bar. */}
      <div className="flex flex-1 min-h-0 flex-col">
        {panel === 'chat' ? (
          <ConceptStage
            projectId={projectId} project={project} canEdit={canEdit} fill
            onApproved={onApproved} onMockupChanged={onMockupChanged}
            provLog={provLog} provMessage={provMessage}
            onOpenAssets={() => setPanel('assets')}
            mode={chatMode} onModeChange={onChatMode}
          />
        ) : panel === 'assets' ? (
          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            <ProjectAssets projectId={projectId} canEdit={canEdit} />
          </div>
        ) : previewSrc ? (
          <PreviewPanel
            src={previewSrc} title={project.name} approved={false} reloadKey={previewReloadNonce}
            projectId={projectId} watchProjectId={projectId}
          />
        ) : (
          // No mockup yet — the placeholder is content-sized, so center it
          // rather than leaving it stranded at the top of an empty screen.
          <div className="flex h-full items-center justify-center p-4">
            <PreviewPlaceholder project={project} provLog={provLog} provMessage={provMessage} />
          </div>
        )}
      </div>
      <MobilePanelBar
        panels={MOCKUP_PANELS} current={panel} onSelect={setPanel}
        onOpenNav={onOpenNav} onShowDetails={onShowDetails}
      />
    </div>
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
  // A BUILD CYCLE holding the lock is normal operation, not a conflict — the
  // build UI already shows the running build with Stop, and the stall watchdog
  // + Restart own the stuck case. Showing a lock/Force-release banner for it
  // read as a warning about routine work (operator report). The banner exists
  // for HUMAN checkouts: another editor holding the project is something you
  // may genuinely need to see and act on.
  if (lock.holder_type === 'cycle') return null;

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

