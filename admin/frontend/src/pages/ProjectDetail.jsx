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

import { useEffect, useState, useCallback } from 'react';
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
import {
  ArrowLeft, Loader2, ExternalLink, RefreshCw, Trash2, UserPlus, Flag, ShieldAlert,
  Archive, RotateCcw, Play, Lock, Download, GitBranch,
  Zap, Square, CheckCircle2, XCircle, Circle, Hammer, Unlock, ShieldCheck, Clock,
} from 'lucide-react';
import { statusChip } from '@/lib/mock2-status.jsx';
import ConceptStage from '@/components/mock2/ConceptStage';

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
  const [allowlist, setAllowlist] = useState(null); // null = not loaded; [] = empty
  const [newHost, setNewHost] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [pendingJob, setPendingJob] = useState(null); // 'archive' | 'rehydrate' | 'wake' | null

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

  const loadAllowlist = useCallback(async () => {
    try {
      const res = await api.mock2GetEgressAllowlist(id);
      setAllowlist(res.hosts || []);
    } catch (err) {
      // A viewer on a disabled/absent route just gets no card — don't spam.
      if (!(err instanceof ApiError && err.status === 404)) console.error('load allowlist failed:', err);
    }
  }, [id]);

  useEffect(() => {
    let cancelled = false;
    api.mock2Status()
      .then(() => {
        if (cancelled) return;
        setGate('enabled');
        load();
        loadAllowlist();
        if (isAdmin) api.getUsers().then((r) => setUsers(r.users || r || [])).catch(() => {});
      })
      .catch((err) => {
        if (!cancelled) setGate('disabled');
        if (!(err instanceof ApiError)) console.error('mock2 status check failed:', err);
      });
    return () => { cancelled = true; };
  }, [load, loadAllowlist, isAdmin]);

  // Poll while provisioning OR while a background lifecycle job is in flight so
  // the status + URL settle on their own (provisioning also covers rehydrate,
  // which flips the row to 'provisioning' server-side).
  useEffect(() => {
    if (gate !== 'enabled') return undefined;
    if (project?.lifecycle !== 'provisioning' && !pendingJob) return undefined;
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, [gate, project, pendingJob, load]);

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

  const addEgressHost = async () => {
    const host = newHost.trim().toLowerCase();
    if (!host) return;
    setBusy(true);
    try {
      const res = await api.mock2AddEgressHost(id, host);
      setAllowlist(res.hosts || []);
      setNewHost('');
      toast({ title: res.added ? 'Host allowed' : 'Host already allowed' });
    } catch (err) {
      toast({ variant: 'destructive', title: 'Could not add host', description: err.message });
    } finally {
      setBusy(false);
    }
  };

  const removeEgressHost = async (host) => {
    setBusy(true);
    try {
      const res = await api.mock2RemoveEgressHost(id, host);
      setAllowlist(res.hosts || []);
      toast({ title: 'Host removed' });
    } catch (err) {
      toast({ variant: 'destructive', title: 'Could not remove host', description: err.message });
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

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 min-w-0">
            <h1 className="text-2xl font-bold tracking-tight truncate">{project.name}</h1>
            {statusChip(project.status, project.flagged)}
          </div>
          {project.description ? (
            <p className="text-sm text-muted-foreground truncate">{project.description}</p>
          ) : null}
        </div>
        <Button asChild variant="ghost" size="sm" className="shrink-0">
          <Link to="/projects"><ArrowLeft className="h-4 w-4 mr-1" />Projects</Link>
        </Button>
      </div>

      {orphaned && !isArchived ? (
        <div className="flex items-start gap-2 p-3 rounded-lg bg-amber-500/10 text-amber-600 text-sm">
          <ShieldAlert className="h-4 w-4 mt-0.5 shrink-0" />
          <span>This project has no editors — it is orphaned. Add an editor to restore ownership.</span>
        </div>
      ) : null}

      {/* M6: checkout-lock banner (holder + time remaining + request-takeover). */}
      {!isArchived ? <LockBanner projectId={id} canEdit={canEdit} isAdmin={isAdmin} /> : null}

      {isArchived ? (
        <div className="flex items-start gap-2 p-3 rounded-lg bg-muted text-muted-foreground text-sm">
          <Lock className="h-4 w-4 mt-0.5 shrink-0" />
          <span>
            This project is <span className="font-medium">archived and read-only</span>. Its git repo, history, and
            members are kept, but nothing can change until you rehydrate it.
            {project.archived_at ? <> Archived {new Date(project.archived_at).toLocaleString()}.</> : null}
          </span>
        </div>
      ) : null}

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
              {pendingJob === 'rehydrate' ? 'Rehydrating from the bare repo…' : 'Provisioning container, repo, and route…'}
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

      {/* M7: Stage 1 (Concept) — chat, mockup preview, design approval. The
          primary surface until the design is approved; the persistent stage
          indicator lives in its header. */}
      {!isArchived ? (
        <ConceptStage projectId={id} project={project} canEdit={canEdit} onApproved={load} />
      ) : null}

      {/* M6: build cycle — run a targeted change, watch the gates go green.
          Build only appears once the Stage-1 design is approved (M7 unlock). */}
      {!isArchived && project.stage?.design_approved ? (
        <CycleCard projectId={id} canEdit={canEdit} isAdmin={isAdmin} lifecycle={project.lifecycle} />
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

      {/* Flag overlay (editors) */}
      {canEdit && !readOnly ? (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Flag for admin</CardTitle>
            <CardDescription>The one manual overlay — raise or clear an admin flag on this project.</CardDescription>
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

      {/* Admin: egress allowlist editor (M4) — the per-project filtering-proxy
          allowlist. Editing widens what the container can reach; audit-logged.
          Hidden for archived projects (read-only). */}
      {isAdmin && allowlist ? (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Egress allowlist</CardTitle>
            <CardDescription>
              The container reaches the internet only through the filtering proxy, and only these hosts.
              Everything else is blocked at the project bridge. Add npm/model/registry hosts as needed.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <ul className="space-y-1.5">
              {allowlist.length === 0 ? (
                <li className="text-sm text-muted-foreground">No hosts allowed — all egress is blocked.</li>
              ) : allowlist.map((host) => (
                <li key={host} className="flex items-center justify-between gap-2 rounded-md border px-3 py-2">
                  <span className="font-mono text-sm break-all">{host}</span>
                  {!readOnly ? (
                    <Button
                      variant="ghost" size="icon" className="h-9 w-9 shrink-0"
                      disabled={busy} onClick={() => removeEgressHost(host)} aria-label={`Remove ${host}`}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
            {!readOnly ? (
              <div className="flex flex-col sm:flex-row gap-2 sm:items-end">
                <div className="flex-1 min-w-0 space-y-1.5">
                  <Label htmlFor="egress-host">Add host</Label>
                  <Input
                    id="egress-host" placeholder="registry.npmjs.org or .npmjs.org" value={newHost}
                    onChange={(e) => setNewHost(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') addEgressHost(); }}
                    autoCapitalize="none" autoCorrect="off" spellCheck={false}
                  />
                </div>
                <Button className="h-11 sm:h-10 shrink-0" disabled={busy || !newHost.trim()} onClick={addEgressHost}>
                  Allow
                </Button>
              </div>
            ) : null}
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
        <CardDescription>Export the project&apos;s git history, or push it to an external remote (optional — the local bare repo is primary).</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <Button asChild variant="outline" size="sm" className="h-11 sm:h-10">
          <a href={api.mock2ProjectExportZipUrl(projectId)} download={`${slug || `project-${projectId}`}.zip`}>
            <Download className="h-4 w-4 mr-1" /> Export as zip
          </a>
        </Button>

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

// M6 — the build-cycle control + the "gates going green" view. A canned "run a
// cycle" instruction box starts the runner; the running cycle shows its status,
// the gate battery going green (the phase-stepper pattern from LxcContainers),
// interrupt controls, spend, and the hash-chained change history with a live
// chain-verification badge. No chat yet (M7). Polls while a cycle is live.
function CycleCard({ projectId, canEdit, isAdmin, lifecycle }) {
  const { toast } = useToast();
  const [cycle, setCycle] = useState(null);
  const [job, setJob] = useState(null);
  const [instruction, setInstruction] = useState('');
  const [busy, setBusy] = useState(false);
  const [changes, setChanges] = useState(null); // { records, verification } | null
  const [showChanges, setShowChanges] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await api.mock2GetLatestCycle(projectId);
      setCycle(r.cycle || null);
      setJob(r.job || null);
    } catch (err) {
      if (!(err instanceof ApiError)) console.error('load cycle failed:', err);
    }
  }, [projectId]);

  useEffect(() => { load(); }, [load]);

  const active = cycle && ['queued', 'estimating', 'running'].includes(cycle.status);
  // Poll while a cycle is live so the gates settle on their own.
  useEffect(() => {
    if (!active) return undefined;
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [active, load]);

  const online = lifecycle === 'active';

  const run = async () => {
    if (!instruction.trim()) return;
    setBusy(true);
    try {
      const res = await api.mock2StartCycle(projectId, instruction.trim());
      if (res.refused) {
        toast({ variant: 'destructive', title: 'Cycle refused', description: res.reason || 'Quota exceeded.' });
      } else {
        toast({ title: 'Cycle started' });
        setInstruction('');
      }
      setCycle(res.cycle || null);
    } catch (err) {
      toast({ variant: 'destructive', title: 'Could not start cycle', description: err.message });
    } finally { setBusy(false); }
  };

  const interrupt = async (action) => {
    if (!cycle) return;
    setBusy(true);
    try { await api.mock2InterruptCycle(projectId, cycle.id, action); toast({ title: `Cycle: ${action.replace(/_/g, ' ')}` }); await load(); }
    catch (err) { toast({ variant: 'destructive', title: 'Could not interrupt', description: err.message }); }
    finally { setBusy(false); }
  };

  const loadChanges = async () => {
    setShowChanges((s) => !s);
    if (changes) return;
    try { setChanges(await api.mock2GetChangeRecords(projectId)); }
    catch (err) { if (!(err instanceof ApiError)) console.error('load change records failed:', err); }
  };

  const gateIcon = (status) => {
    if (status === 'passed') return <CheckCircle2 className="h-4 w-4 text-green-500" />;
    if (status === 'failed') return <XCircle className="h-4 w-4 text-red-500" />;
    if (status === 'running') return <Loader2 className="h-4 w-4 animate-spin text-cyan-500" />;
    return <Circle className="h-4 w-4 text-muted-foreground/40" />;
  };

  const statusTone = {
    running: 'text-cyan-500', succeeded: 'text-green-500', failed: 'text-red-500',
    refused_quota: 'text-red-500', awaiting_admin: 'text-amber-500', interrupted: 'text-amber-500',
    abandoned: 'text-muted-foreground', queued: 'text-blue-500', estimating: 'text-blue-500',
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2"><Hammer className="h-4 w-4" /> Build cycle</CardTitle>
        <CardDescription>
          Run one targeted change through the runner: it edits the code in the fenced container, runs the pinned
          gate battery, and checkpoints into the repo. Chat arrives later — for now, describe the change directly.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Start control (editors, online only) */}
        {canEdit && !active ? (
          online ? (
            <div className="space-y-2">
              <Label htmlFor="cycle-instruction">Change to make</Label>
              <textarea
                id="cycle-instruction"
                className="flex min-h-[64px] w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                placeholder="e.g. Add a /health endpoint that returns 200 OK"
                value={instruction}
                onChange={(e) => setInstruction(e.target.value)}
              />
              <Button className="h-11 sm:h-10" disabled={busy || !instruction.trim()} onClick={run}>
                {busy ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Zap className="h-4 w-4 mr-1" />}
                Run a cycle
              </Button>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">Bring the project online to run a cycle.</p>
          )
        ) : null}

        {/* Live / last cycle */}
        {cycle ? (
          <div className="space-y-3 border-t pt-3">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div className="min-w-0">
                <p className="text-sm font-medium truncate">{cycle.instruction || '(cycle)'}</p>
                <p className={`text-xs font-medium ${statusTone[cycle.status] || 'text-muted-foreground'}`}>
                  {cycle.status.replace(/_/g, ' ')}{cycle.current_gate ? ` · ${cycle.current_gate}` : ''}
                </p>
              </div>
              <div className="text-xs text-muted-foreground whitespace-nowrap">
                {cycle.used_cost_cents ? `$${(cycle.used_cost_cents / 100).toFixed(2)}` : '$0.00'} · {cycle.used_tokens || 0} tok
              </div>
            </div>

            {job?.message ? <p className="text-xs text-muted-foreground">{job.message}</p> : null}
            {cycle.error ? <p className="text-xs text-red-500 break-words">{cycle.error}</p> : null}

            {/* Gate battery — the "gates going green" stepper */}
            {cycle.gates?.length ? (
              <ul className="space-y-1.5">
                {cycle.gates.map((g) => (
                  <li key={g.name} className="flex items-center gap-2 text-sm">
                    <span className="shrink-0">{gateIcon(g.status)}</span>
                    <span className="min-w-0 truncate">{g.name}</span>
                    <span className="ml-auto text-xs text-muted-foreground">{g.status}</span>
                  </li>
                ))}
              </ul>
            ) : null}

            {/* Interrupts (editors) while running */}
            {canEdit && active && cycle.status === 'running' ? (
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" size="sm" className="h-9" disabled={busy} onClick={() => interrupt('stop_after_step')}>
                  <Square className="h-4 w-4 mr-1" />Stop after step
                </Button>
                <Button variant="ghost" size="sm" className="h-9 text-red-500" disabled={busy} onClick={() => interrupt('abandon')}>
                  Abandon
                </Button>
                {isAdmin ? (
                  <Button variant="ghost" size="sm" className="h-9" disabled={busy} onClick={() => api.mock2StopAllCycles().then(() => load())}>
                    Stop all
                  </Button>
                ) : null}
              </div>
            ) : null}

            {cycle.status === 'succeeded' ? (
              <p className="text-xs text-green-600 flex items-center gap-1"><ShieldCheck className="h-3.5 w-3.5" /> Gates green — change checkpointed into the repo.</p>
            ) : null}
          </div>
        ) : (
          !canEdit ? <p className="text-sm text-muted-foreground">No cycles yet.</p> : null
        )}

        {/* Change history + chain verification */}
        <div className="border-t pt-3">
          <Button variant="ghost" size="sm" className="h-9 px-0" onClick={loadChanges}>
            <GitBranch className="h-4 w-4 mr-1" />{showChanges ? 'Hide' : 'Show'} change history
          </Button>
          {showChanges && changes ? (
            <div className="mt-2 space-y-2">
              <p className="text-xs flex items-center gap-1">
                {changes.verification?.ok
                  ? <><ShieldCheck className="h-3.5 w-3.5 text-green-500" /> <span className="text-green-600">Hash chain verified ({changes.verification.count} record{changes.verification.count === 1 ? '' : 's'})</span></>
                  : <><XCircle className="h-3.5 w-3.5 text-red-500" /> <span className="text-red-500">Chain broken at #{changes.verification?.brokenAt}</span></>}
              </p>
              {(changes.records || []).length === 0 ? (
                <p className="text-xs text-muted-foreground">No change records yet.</p>
              ) : (
                <ul className="space-y-1.5">
                  {changes.records.map((r) => (
                    <li key={r.seq} className="text-xs border rounded-md px-2 py-1.5">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-mono">#{r.seq}</span>
                        <span className="font-mono text-muted-foreground truncate">{r.commit_sha ? r.commit_sha.slice(0, 8) : '—'}</span>
                      </div>
                      <p className="truncate">{r.summary}</p>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}
