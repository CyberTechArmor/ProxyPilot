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
} from 'lucide-react';
import { statusChip } from '@/lib/mock2-status.jsx';

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
  const [confirmDelete, setConfirmDelete] = useState(false);

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

  useEffect(() => {
    let cancelled = false;
    api.mock2Status()
      .then(() => {
        if (cancelled) return;
        setGate('enabled');
        load();
        if (isAdmin) api.getUsers().then((r) => setUsers(r.users || r || [])).catch(() => {});
      })
      .catch((err) => {
        if (!cancelled) setGate('disabled');
        if (!(err instanceof ApiError)) console.error('mock2 status check failed:', err);
      });
    return () => { cancelled = true; };
  }, [load, isAdmin]);

  // Poll while provisioning so the status + URL settle on their own.
  useEffect(() => {
    if (gate !== 'enabled' || project?.lifecycle !== 'provisioning') return undefined;
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, [gate, project, load]);

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
  const orphaned = project.status === 'orphaned';

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

      {orphaned ? (
        <div className="flex items-start gap-2 p-3 rounded-lg bg-amber-500/10 text-amber-600 text-sm">
          <ShieldAlert className="h-4 w-4 mt-0.5 shrink-0" />
          <span>This project has no editors — it is orphaned. Add an editor to restore ownership.</span>
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
              Provisioning container, repo, and route…
            </div>
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
          {canEdit && !isProvisioning && project.slug ? (
            <Button
              variant="outline" size="sm" className="h-9" disabled={busy}
              onClick={() => run(() => api.mock2RotateProjectSlug(id), 'Slug rotated')}
            >
              <RefreshCw className={`h-4 w-4 mr-1 ${busy ? 'animate-spin' : ''}`} />Rotate slug
            </Button>
          ) : null}
        </CardContent>
      </Card>

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
                {canEdit ? (
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

          {canEdit && isAdmin ? (
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
      {canEdit ? (
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
      {isAdmin ? (
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

      {isAdmin ? (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Debug</CardTitle>
            <CardDescription>Container upstream on the shared bridge — never a host port.</CardDescription>
          </CardHeader>
          <CardContent className="text-sm space-y-1 text-muted-foreground">
            <div className="flex justify-between gap-3"><span>Container</span><span className="font-mono break-all">{project.container_name || '—'}</span></div>
            <div className="flex justify-between gap-3"><span>Upstream</span><span className="font-mono break-all">{project.upstream || '—'}</span></div>
            <div className="flex justify-between gap-3"><span>Bridge IP</span><span className="font-mono break-all">{project.bridge_ip || '—'}</span></div>
            <div className="flex justify-between gap-3"><span>Web port</span><span className="font-mono">{project.web_port || '—'}</span></div>
            <div className="flex justify-between gap-3"><span>Repo</span><span className="font-mono break-all">{project.repo_path || '—'}</span></div>
          </CardContent>
        </Card>
      ) : null}

      {/* Danger zone (admin + sudo) */}
      {isAdmin ? (
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
