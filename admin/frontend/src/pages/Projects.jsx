// Projects — the Mock2 dev/build module landing page (Phase M2).
//
// M0 shipped this as a placeholder; M1 added the parent-domains card. M2 turns
// it into the real project list: tiles showing each project's derived status +
// live URL, and a create flow that only offers SELECTABLE parent domains (the
// M1 gate: verified cert_ok AND enabled). Creating a project provisions a
// container + bare repo + slug route asynchronously (202 → poll), so a freshly
// created tile shows `provisioning` and flips to `online` on its own.
//
// Reachable only when the backend reports Mock2 enabled (GET /api/mock2/status
// → 200); a direct visit on a disabled/pinned host bounces home (ADR-001).
//
// MOBILE_FIRST: single-column tiles that grow to two columns at sm, a create
// dialog that is full-screen on <sm, 44px primary touch targets. Renders clean
// at 360px with no horizontal scroll.

import { useEffect, useState, useCallback } from 'react';
import { Navigate, Link, useNavigate } from 'react-router-dom';
import { useAuth } from '@/context/AuthContext';
import { api, ApiError } from '@/lib/api';
import { useToast } from '@/hooks/use-toast';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  FolderGit2, Loader2, Globe, Plus, ExternalLink, Cpu, Wallet, BookText, Inbox, Blocks,
  Sparkles, Hammer,
} from 'lucide-react';
import { statusChip } from '@/lib/mock2-status.jsx';

// Preview the subdomain the backend will derive from a project name (mirrors
// slugifyName in admin/backend/src/mock2/slug.js — this is display-only; the
// backend remains authoritative and rejects duplicates/reserved names).
function previewSlug(name) {
  return String(name || '')
    .toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50)
    .replace(/-+$/g, '');
}

export default function Projects() {
  const { user } = useAuth();
  const storedUser = JSON.parse(localStorage.getItem('user') || '{}');
  const isAdmin = user?.role === 'admin' || storedUser?.role === 'admin';
  const { toast } = useToast();
  const navigate = useNavigate();

  const [gate, setGate] = useState('checking'); // 'checking' | 'enabled' | 'disabled'
  const [projects, setProjects] = useState([]);
  const [domains, setDomains] = useState([]);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState({ name: '', description: '', parent_domain_id: '' });
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    try {
      const [pRes, dRes] = await Promise.all([
        api.mock2ListProjects(),
        api.mock2ListParentDomains().catch(() => ({ domains: [] })),
      ]);
      setProjects(pRes.projects || []);
      setDomains((dRes.domains || []).filter((d) => d.selectable));
    } catch (err) {
      if (!(err instanceof ApiError)) console.error('load projects failed:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    api.mock2Status()
      .then(() => { if (!cancelled) { setGate('enabled'); load(); } })
      .catch((err) => {
        if (!cancelled) setGate('disabled');
        if (!(err instanceof ApiError)) console.error('mock2 status check failed:', err);
      });
    return () => { cancelled = true; };
  }, [load]);

  // Poll while any project is provisioning so its tile flips without a refresh.
  useEffect(() => {
    if (gate !== 'enabled') return undefined;
    const anyProvisioning = projects.some((p) => p.lifecycle === 'provisioning');
    if (!anyProvisioning) return undefined;
    const id = setInterval(load, 4000);
    return () => clearInterval(id);
  }, [gate, projects, load]);

  const submitCreate = async () => {
    if (!form.name.trim() || !form.parent_domain_id) return;
    setCreating(true);
    try {
      const res = await api.mock2CreateProject({
        name: form.name.trim(),
        description: form.description.trim() || undefined,
        parent_domain_id: Number(form.parent_domain_id),
      });
      setCreateOpen(false);
      setForm({ name: '', description: '', parent_domain_id: '' });
      toast({ title: 'Project creating', description: 'Provisioning the container and repo — this takes a minute.' });
      if (res.project?.id) navigate(`/projects/${res.project.id}`);
      else load();
    } catch (err) {
      toast({ variant: 'destructive', title: 'Could not create project', description: err.message });
    } finally {
      setCreating(false);
    }
  };

  if (!isAdmin) return <Navigate to="/" replace />;
  if (gate === 'disabled') return <Navigate to="/" replace />;
  if (gate === 'checking') {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const canCreate = domains.length > 0;
  const activeProjects = projects.filter((p) => p.lifecycle !== 'archived');
  const archivedProjects = projects.filter((p) => p.lifecycle === 'archived');

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <FolderGit2 className="h-6 w-6 shrink-0 text-primary" />
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-bold tracking-tight truncate">Projects</h1>
          <p className="text-sm text-muted-foreground">Mock2 dev/build module</p>
        </div>
        <Button
          className="h-11 sm:h-10 shrink-0"
          onClick={() => setCreateOpen(true)}
          disabled={!canCreate}
          title={canCreate ? undefined : 'Register and enable a parent domain first'}
        >
          <Plus className="h-4 w-4 mr-1" />New project
        </Button>
      </div>

      <Card>
        <CardHeader>
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <div className="min-w-0">
              <CardTitle className="flex items-center gap-2">
                <Globe className="h-5 w-5 shrink-0 text-primary" />
                Parent domains
              </CardTitle>
              <CardDescription>
                Register dev domains and issue per-slug TLS so projects get live HTTPS URLs.
              </CardDescription>
            </div>
            <Button asChild variant="outline" className="h-11 sm:h-10 shrink-0">
              <Link to="/projects/domains">Manage domains</Link>
            </Button>
          </div>
        </CardHeader>
      </Card>

      {/* M5 admin tooling: model/git connectors, quotas, framework registry.
          Admin-only, reachable only on an enabled host (each page self-guards). */}
      {isAdmin && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <Button asChild variant="outline" className="h-auto justify-start gap-3 py-3">
            <Link to="/projects/connectors">
              <Cpu className="h-5 w-5 shrink-0 text-primary" />
              <span className="flex flex-col items-start text-left"><span className="font-medium">Connectors</span><span className="text-xs text-muted-foreground">Models · slots · git</span></span>
            </Link>
          </Button>
          <Button asChild variant="outline" className="h-auto justify-start gap-3 py-3">
            <Link to="/projects/quotas">
              <Wallet className="h-5 w-5 shrink-0 text-primary" />
              <span className="flex flex-col items-start text-left"><span className="font-medium">Quotas</span><span className="text-xs text-muted-foreground">Budgets · caps · buffer</span></span>
            </Link>
          </Button>
          <Button asChild variant="outline" className="h-auto justify-start gap-3 py-3">
            <Link to="/projects/framework">
              <BookText className="h-5 w-5 shrink-0 text-primary" />
              <span className="flex flex-col items-start text-left"><span className="font-medium">Framework</span><span className="text-xs text-muted-foreground">Versions · edit · revert</span></span>
            </Link>
          </Button>
          <Button asChild variant="outline" className="h-auto justify-start gap-3 py-3">
            <Link to="/projects/queue">
              <Inbox className="h-5 w-5 shrink-0 text-primary" />
              <span className="flex flex-col items-start text-left"><span className="font-medium">Admin queue</span><span className="text-xs text-muted-foreground">Deviations · drift · flags</span></span>
            </Link>
          </Button>
          <Button asChild variant="outline" className="h-auto justify-start gap-3 py-3">
            <Link to="/projects/components">
              <Blocks className="h-5 w-5 shrink-0 text-primary" />
              <span className="flex flex-col items-start text-left"><span className="font-medium">Components</span><span className="text-xs text-muted-foreground">Reusable blocks · versions · submissions</span></span>
            </Link>
          </Button>
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : projects.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>No projects yet</CardTitle>
            <CardDescription>
              {canCreate
                ? 'Create your first project — it gets a container, a bare git repo, and a live HTTPS URL on a selectable parent domain.'
                : 'Register and enable a parent domain first, then create a project on it.'}
            </CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <>
          {activeProjects.length > 0 ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {activeProjects.map((p) => <ProjectTile key={p.id} p={p} />)}
            </div>
          ) : null}

          {archivedProjects.length > 0 ? (
            <div className="space-y-3">
              <h2 className="text-sm font-medium text-muted-foreground">
                Archived ({archivedProjects.length})
              </h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {archivedProjects.map((p) => <ProjectTile key={p.id} p={p} archived />)}
              </div>
            </div>
          ) : null}
        </>
      )}

      <Dialog open={createOpen} onOpenChange={(o) => { if (!creating) setCreateOpen(o); }}>
        <DialogContent className="max-w-full h-full rounded-none overflow-y-auto sm:max-w-md sm:h-auto sm:rounded-lg">
          <DialogHeader>
            <DialogTitle>New project</DialogTitle>
            <DialogDescription>
              A container, bare git repo, and a per-slug HTTPS URL are provisioned on the
              chosen parent domain. The project name is display-only — the URL uses a minted slug.
            </DialogDescription>
          </DialogHeader>
          <form
            onSubmit={(e) => { e.preventDefault(); submitCreate(); }}
            className="space-y-4"
          >
            <div className="space-y-1.5">
              <Label htmlFor="proj-name">Name</Label>
              <Input
                id="proj-name"
                placeholder="My prototype"
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                autoFocus
              />
              {form.name.trim() && form.parent_domain_id ? (
                previewSlug(form.name) ? (
                  <p className="text-xs text-muted-foreground break-all">
                    URL:{' '}
                    <code className="text-foreground">
                      {previewSlug(form.name)}.{domains.find((d) => String(d.id) === form.parent_domain_id)?.domain}
                    </code>
                  </p>
                ) : (
                  <p className="text-xs text-amber-500">
                    Add a letter or number to the name to form a URL.
                  </p>
                )
              ) : null}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="proj-desc">Description <span className="text-muted-foreground">(optional)</span></Label>
              <Input
                id="proj-desc"
                placeholder="What is this?"
                value={form.description}
                onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="proj-domain">Parent domain</Label>
              <Select
                value={form.parent_domain_id}
                onValueChange={(v) => setForm((f) => ({ ...f, parent_domain_id: v }))}
              >
                <SelectTrigger id="proj-domain" className="h-11 sm:h-10">
                  <SelectValue placeholder="Choose a verified domain" />
                </SelectTrigger>
                <SelectContent>
                  {domains.map((d) => (
                    <SelectItem key={d.id} value={String(d.id)}>{d.domain}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">Only verified &amp; enabled domains appear here.</p>
            </div>
            <DialogFooter className="flex-col sm:flex-row gap-2">
              <Button type="button" variant="outline" onClick={() => setCreateOpen(false)} disabled={creating} className="h-11 sm:h-10">
                Cancel
              </Button>
              <Button type="submit" disabled={creating || !form.name.trim() || !form.parent_domain_id} className="h-11 sm:h-10">
                {creating ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
                Create project
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// The tile's Mockup/Build stage chip — where the project is in the flow.
// Pre-approval it's in the Mockup (design) stage, with or without a mockup yet;
// once the design is approved it's in the Build stage (and "app live" once the
// latest build is serving). Reads the same derived fields as the detail page.
function stageChip(p) {
  const approved = !!p.stage?.design_approved;
  if (approved) {
    const live = p.deploy_state === 'serving';
    return (
      <span className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full bg-primary/10 text-primary whitespace-nowrap">
        <Hammer className="h-3 w-3" /> Build{live ? ' · app live' : ''}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full bg-violet-500/10 text-violet-500 whitespace-nowrap">
      <Sparkles className="h-3 w-3" /> Mockup{p.current_mockup_id ? '' : ' · not started'}
    </span>
  );
}

// One project tile — used by both the active grid and the archived section. An
// archived tile is dimmed and shows a rehydrate hint instead of a live URL (its
// slug is retained but currently 404s).
function ProjectTile({ p, archived = false }) {
  return (
    <Card className={`min-w-0${archived ? ' opacity-75' : ''}`}>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-2 min-w-0">
          <CardTitle className="truncate text-base">{p.name}</CardTitle>
          <span className="flex flex-wrap items-center justify-end gap-1 shrink-0">
            {!archived ? stageChip(p) : null}
            {statusChip(p.status, p.flagged)}
          </span>
        </div>
        {p.description ? (
          <CardDescription className="line-clamp-2">{p.description}</CardDescription>
        ) : null}
      </CardHeader>
      <CardContent className="space-y-3">
        {archived ? (
          <span className="text-sm text-muted-foreground">Archived — open to rehydrate the same URL.</span>
        ) : p.url ? (
          <a
            href={p.url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-sm text-primary hover:underline break-all"
          >
            {p.url.replace(/^https:\/\//, '')}
            <ExternalLink className="h-3.5 w-3.5 shrink-0" />
          </a>
        ) : (
          <span className="text-sm text-muted-foreground">URL pending…</span>
        )}
        <div>
          <Button asChild variant="outline" size="sm" className="h-9">
            <Link to={`/projects/${p.id}`}>Open</Link>
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
