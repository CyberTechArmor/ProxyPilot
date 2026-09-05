// Projects — the Mock2 dev/build module landing page (Phase M2).
//
// M0 shipped this as a placeholder; M1 added the parent-domains card. M2 turns
// it into the real project list: tiles showing each project's derived status +
// live URL, and a create flow that only offers SELECTABLE parent domains (the
// M1 gate: verified cert_ok AND enabled). Creating a project provisions a
// container + bare repo + slug route asynchronously (202 → poll), so a freshly
// created tile shows `provisioning` and flips to `online` on its own.
//
// The page is now the project list and nothing else: the parent-domains card
// and the seven admin tiles moved behind the gear (Projects → Settings), and
// create asks for a name and a domain only — no description, no design picker
// (the base look is the built-in default; the design chat's On theme / New look
// toggle decides how far the AI strays from it). The one extra choice create
// offers is the base-domain toggle: serve on the parent domain itself rather
// than only its minted subdomain, shown only while nothing else on the host
// answers there (base_domain_available off the parent-domains API).
//
// The list itself carries search, sort, per-user pins, and a grid/list toggle;
// each card shows team, age, spend, and last activity so the grid is scannable
// without opening anything.
//
// Reachable only when the backend reports Mock2 enabled (GET /api/mock2/status
// → 200); a direct visit on a disabled/pinned host bounces home (ADR-001).
//
// MOBILE_FIRST: single-column cards that grow to two at sm and three at xl, a
// toolbar that stacks on <sm, a create dialog that is full-screen on <sm, 44px
// primary touch targets. Renders clean at 360px with no horizontal scroll.

import { useEffect, useMemo, useState, useCallback } from 'react';
import { Navigate, Link, useNavigate } from 'react-router-dom';
import { useAuth } from '@/context/AuthContext';
import GitRemoteCardImport from '@/components/mock2/GitRemoteCard';
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
import { Switch } from '@/components/ui/switch';
import {
  FolderGit2, Loader2, Plus, ExternalLink, Sparkles, Hammer, Settings, Search, Star,
  LayoutGrid, List, Users, CalendarDays, Wallet, X, Copy, Database,
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

// ---- card metrics ----

const DAY_MS = 24 * 60 * 60 * 1000;

// Whole days between an ISO timestamp and now; null when the stamp is missing
// or unparseable (a card renders "—" rather than "NaN days").
function daysSince(iso) {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((Date.now() - t) / DAY_MS));
}

// "12 days" / "1 day" / "today" — the age readout under a card's title.
function ageLabel(iso) {
  const d = daysSince(iso);
  if (d === null) return '—';
  if (d === 0) return 'today';
  return `${d} day${d === 1 ? '' : 's'}`;
}

// Coarse relative time for last activity. Deliberately low-resolution: the
// card is a scanning surface, the detail page has the exact timestamps.
function agoLabel(iso) {
  if (!iso) return 'no activity yet';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return 'no activity yet';
  const mins = Math.max(0, Math.floor((Date.now() - t) / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

// Lifetime AI spend, in cents off the quota ledger. Sub-cent spend still reads
// as $0.00 rather than "free" — the ledger row exists, it just rounds down.
function costLabel(cents) {
  const c = Number(cents) || 0;
  if (c >= 100000) return `$${Math.round(c / 100000)}k`;
  return `$${(c / 100).toFixed(2)}`;
}

// ---- base-domain option (create + clone) ----

// "Serve on the parent domain itself" — example.com rather than only
// p-7f3a9c2e.example.com. Renders nothing until a domain is chosen or when the
// backend didn't compute a verdict (base_domain_available === null, i.e. an
// older API); renders disabled, naming the claimant, when something else on the
// host already answers on the apex. Shared so create and clone can never drift.
function BaseDomainOption({ id, domain, checked, onChange }) {
  if (!domain || domain.base_domain_available == null) return null;
  const free = !!domain.base_domain_available;
  return (
    <div className="rounded-md border p-3 space-y-2">
      <label
        htmlFor={id}
        className={`flex min-h-11 items-center justify-between gap-3 ${free ? 'cursor-pointer' : ''}`}
      >
        <span className="min-w-0 space-y-1">
          <span className="block text-sm font-medium leading-none">Use the base domain</span>
          <span className="block text-xs text-muted-foreground break-all">
            Serve on <code className="text-foreground">{domain.domain}</code> itself,
            not just a subdomain.
          </span>
        </span>
        <Switch
          id={id}
          className="shrink-0"
          checked={free && checked}
          disabled={!free}
          onCheckedChange={(v) => onChange(!!v)}
        />
      </label>
      {!free ? (
        <p className="text-xs text-amber-500">
          Not available — {domain.base_domain_claimed_by?.label || 'another service'}{' '}
          already serves <code>{domain.domain}</code>.
        </p>
      ) : checked ? (
        <p className="text-xs text-muted-foreground">
          Point an A record for <code>{domain.domain}</code> at this host — the wildcard
          that covers subdomains does not cover the base domain.
        </p>
      ) : null}
    </div>
  );
}

// The URL a dialog is about to mint: the base domain when that option is on,
// otherwise `<name-slug>.<parent>`. Returns null when the name yields no slug.
function previewUrl(name, domain, baseDomainOn) {
  const slug = previewSlug(name);
  if (!slug || !domain) return null;
  return {
    primary: baseDomainOn ? domain.domain : `${slug}.${domain.domain}`,
    also: baseDomainOn ? `${slug}.${domain.domain}` : null,
  };
}

// ---- sorting ----

const SORTS = {
  activity: { label: 'Most recent', cmp: (a, b) => stamp(b.last_activity_at) - stamp(a.last_activity_at) },
  newest: { label: 'Newest first', cmp: (a, b) => stamp(b.created_at) - stamp(a.created_at) },
  oldest: { label: 'Oldest first', cmp: (a, b) => stamp(a.created_at) - stamp(b.created_at) },
  name: { label: 'Name (A–Z)', cmp: (a, b) => String(a.name || '').localeCompare(String(b.name || '')) },
  cost: { label: 'Highest cost', cmp: (a, b) => (Number(b.cost_cents) || 0) - (Number(a.cost_cents) || 0) },
};

const stamp = (iso) => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(t) ? 0 : t;
};

// Search matches the things an operator actually remembers: the project name,
// its URL/slug, and who is on it.
function matchesQuery(p, q) {
  if (!q) return true;
  const hay = [
    p.name, p.slug, p.url, p.custom_domain, p.parent_domain,
    ...(p.members || []).map((m) => m.username),
  ].filter(Boolean).join(' ').toLowerCase();
  return hay.includes(q);
}

export default function Projects() {
  const { user } = useAuth();
  const storedUser = JSON.parse(localStorage.getItem('user') || '{}');
  const isAdmin = user?.role === 'admin' || storedUser?.role === 'admin';
  // Regular users with the 'developer' feature permission also get in.
  const canDevelop = isAdmin ||
    (user?.permissions ?? storedUser?.permissions ?? []).includes('developer');
  const { toast } = useToast();
  const navigate = useNavigate();

  const [gate, setGate] = useState('checking'); // 'checking' | 'enabled' | 'disabled'
  const [projects, setProjects] = useState([]);
  const [domains, setDomains] = useState([]);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState({ name: '', parent_domain_id: '', use_base_domain: false });
  // Optional git remote chosen at creation ("submit to Gitea from the start").
  // Connectors load when the dialog opens; with none configured the section is
  // a one-line pointer to Projects → Connectors.
  const [gitConnectors, setGitConnectors] = useState([]);
  const [remoteOn, setRemoteOn] = useState(false);
  const [remoteDraft, setRemoteDraft] = useState({ git_connector_id: '', remote_repo: '', push_mode: 'auto', source_dir: '', create_repo: true });
  useEffect(() => {
    if (!createOpen) return;
    api.mock2ListGitConnectors().then((g) => setGitConnectors(g.connectors || [])).catch(() => setGitConnectors([]));
  }, [createOpen]);
  useEffect(() => {
    if (!remoteOn || remoteDraft.remote_repo || !form.name.trim()) return;
    // Suggest a repo name from the project name; the operator can change it.
    const slug = form.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    if (slug) setRemoteDraft((d) => ({ ...d, remote_repo: d.remote_repo || slug }));
  }, [remoteOn, form.name, remoteDraft.remote_repo]);
  const [creating, setCreating] = useState(false);
  const [cloneTarget, setCloneTarget] = useState(null); // project being cloned, or null

  // View preferences are per-browser, not per-account — they are a display
  // habit, not project state, so localStorage is the right home for them.
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState(() => localStorage.getItem('pp_projects_sort') || 'activity');
  const [view, setView] = useState(() => localStorage.getItem('pp_projects_view') || 'grid');
  useEffect(() => { localStorage.setItem('pp_projects_sort', sort); }, [sort]);
  useEffect(() => { localStorage.setItem('pp_projects_view', view); }, [view]);

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

  // The parent domain chosen in the create dialog. base_domain_available comes
  // from the backend (null on an older API ⇒ the option stays hidden), and
  // base_domain_claimed_by names whatever already answers on the apex.
  const selectedDomain = useMemo(
    () => domains.find((d) => String(d.id) === form.parent_domain_id) || null,
    [domains, form.parent_domain_id],
  );
  // The toggle only counts when the apex is actually on offer, so a list that
  // went stale between load and submit can't ask for a taken hostname.
  const baseDomainOn = !!form.use_base_domain && !!selectedDomain?.base_domain_available;
  const createUrl = previewUrl(form.name, selectedDomain, baseDomainOn);

  const submitCreate = async () => {
    if (!form.name.trim() || !form.parent_domain_id) return;
    setCreating(true);
    try {
      const wantRemote = remoteOn && remoteDraft.git_connector_id && remoteDraft.remote_repo.trim();
      const res = await api.mock2CreateProject({
        name: form.name.trim(),
        parent_domain_id: Number(form.parent_domain_id),
        // Only ever sent when the chosen domain's apex is actually free — the
        // backend re-checks, so a stale flag is refused rather than obeyed.
        use_base_domain: baseDomainOn,
        ...(wantRemote ? {
          remote: {
            git_connector_id: Number(remoteDraft.git_connector_id),
            remote_repo: remoteDraft.remote_repo.trim(),
            push_on_checkpoint: remoteDraft.push_mode === 'auto',
            create_repo: !!remoteDraft.create_repo,
          },
        } : {}),
      });
      if (res.remote && res.remote.ok === false) {
        toast({ variant: 'destructive', title: 'Project created, remote not set', description: res.remote.error });
      }
      setCreateOpen(false);
      setForm({ name: '', parent_domain_id: '', use_base_domain: false });
      setRemoteOn(false);
      setRemoteDraft({ git_connector_id: '', remote_repo: '', push_mode: 'auto', source_dir: '', create_repo: true });
      toast({ title: 'Project creating', description: 'Provisioning the container and repo — this takes a minute.' });
      if (res.project?.id) navigate(`/projects/${res.project.id}`);
      else load();
    } catch (err) {
      toast({ variant: 'destructive', title: 'Could not create project', description: err.message });
    } finally {
      setCreating(false);
    }
  };

  // Pin/unpin is optimistic: the star flips immediately and reverts (with a
  // toast) if the server refuses — a favourite is not worth a spinner.
  const togglePin = async (project) => {
    const next = !project.pinned;
    setProjects((prev) => prev.map((p) => (p.id === project.id ? { ...p, pinned: next } : p)));
    try {
      await api.mock2PinProject(project.id, next);
    } catch (err) {
      setProjects((prev) => prev.map((p) => (p.id === project.id ? { ...p, pinned: !next } : p)));
      toast({ variant: 'destructive', title: 'Could not update the pin', description: err.message });
    }
  };

  const q = query.trim().toLowerCase();
  const cmp = (SORTS[sort] || SORTS.activity).cmp;

  const { pinned, active, archived, matched } = useMemo(() => {
    const hits = projects.filter((p) => matchesQuery(p, q));
    const live = hits.filter((p) => p.lifecycle !== 'archived');
    return {
      matched: hits.length,
      pinned: live.filter((p) => p.pinned).sort(cmp),
      active: live.filter((p) => !p.pinned).sort(cmp),
      archived: hits.filter((p) => p.lifecycle === 'archived').sort(cmp),
    };
  }, [projects, q, cmp]);

  // Header stats — computed off the FULL list, not the filtered one: they
  // describe the module, not the current search.
  const stats = useMemo(() => {
    const live = projects.filter((p) => p.lifecycle !== 'archived');
    return {
      total: live.length,
      serving: live.filter((p) => p.deploy_state === 'serving').length,
      designing: live.filter((p) => !p.stage?.design_approved).length,
      cents: projects.reduce((sum, p) => sum + (Number(p.cost_cents) || 0), 0),
    };
  }, [projects]);

  if (!canDevelop) return <Navigate to="/" replace />;
  if (gate === 'disabled') return <Navigate to="/" replace />;
  if (gate === 'checking') {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const canCreate = domains.length > 0;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <FolderGit2 className="h-6 w-6 shrink-0 text-primary" />
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-bold tracking-tight truncate">Projects</h1>
          <p className="text-sm text-muted-foreground">Mock2 dev/build module</p>
        </div>
        {isAdmin ? (
          <Button asChild variant="outline" size="icon" className="h-11 w-11 sm:h-10 sm:w-10 shrink-0" title="Project settings">
            <Link to="/projects/settings" aria-label="Project settings"><Settings className="h-5 w-5" /></Link>
          </Button>
        ) : null}
        <Button
          className="h-11 sm:h-10 shrink-0"
          onClick={() => setCreateOpen(true)}
          disabled={!canCreate}
          title={canCreate ? undefined : 'Register and enable a parent domain first'}
        >
          <Plus className="h-4 w-4 mr-1" />
          <span className="hidden sm:inline">New project</span>
          <span className="sm:hidden">New</span>
        </Button>
      </div>

      {/* At-a-glance module totals. Four across from sm — narrow enough that
          they read as a strip rather than competing with the project cards. */}
      {projects.length > 0 ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatTile label="Projects" value={String(stats.total)} />
          <StatTile label="Live" value={String(stats.serving)} />
          <StatTile label="In design" value={String(stats.designing)} />
          <StatTile label="Total spend" value={costLabel(stats.cents)} />
        </div>
      ) : null}

      {/* Toolbar: search, sort, view. Stacks on <sm; the search box takes the
          remaining width from sm so long project names stay findable. */}
      {projects.length > 0 ? (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search projects, URLs, people…"
              aria-label="Search projects"
              className="h-11 pl-9 pr-9 sm:h-10"
            />
            {query ? (
              <button
                type="button"
                onClick={() => setQuery('')}
                aria-label="Clear search"
                className="absolute right-1 top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground hover:text-foreground"
              >
                <X className="h-4 w-4" />
              </button>
            ) : null}
          </div>
          <div className="flex items-center gap-2">
            <Select value={sort} onValueChange={setSort}>
              <SelectTrigger className="h-11 w-full min-w-0 sm:h-10 sm:w-44" aria-label="Sort projects">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(SORTS).map(([key, s]) => (
                  <SelectItem key={key} value={key}>{s.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <div className="flex shrink-0 rounded-md border p-0.5" role="radiogroup" aria-label="View">
              <button
                type="button" role="radio" aria-checked={view === 'grid'} aria-label="Grid view"
                onClick={() => setView('grid')}
                className={`flex h-10 w-10 items-center justify-center rounded ${view === 'grid' ? 'bg-muted text-foreground' : 'text-muted-foreground'}`}
              >
                <LayoutGrid className="h-4 w-4" />
              </button>
              <button
                type="button" role="radio" aria-checked={view === 'list'} aria-label="List view"
                onClick={() => setView('list')}
                className={`flex h-10 w-10 items-center justify-center rounded ${view === 'list' ? 'bg-muted text-foreground' : 'text-muted-foreground'}`}
              >
                <List className="h-4 w-4" />
              </button>
            </div>
          </div>
        </div>
      ) : null}

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
          {!canCreate && isAdmin ? (
            <CardContent>
              <Button asChild variant="outline" className="h-11 sm:h-10">
                <Link to="/projects/domains">Manage domains</Link>
              </Button>
            </CardContent>
          ) : null}
        </Card>
      ) : matched === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">No matches</CardTitle>
            <CardDescription>Nothing matches “{query.trim()}”. Try a different name, URL, or person.</CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <div className="space-y-6">
          <Section
            title="Pinned"
            count={pinned.length}
            items={pinned}
            view={view}
            onTogglePin={togglePin}
            onClone={isAdmin ? setCloneTarget : null}
          />
          <Section
            title={pinned.length > 0 ? 'All projects' : null}
            count={active.length}
            items={active}
            view={view}
            onTogglePin={togglePin}
            onClone={isAdmin ? setCloneTarget : null}
          />
          <Section
            title="Archived"
            count={archived.length}
            items={archived}
            view={view}
            archived
            onTogglePin={togglePin}
          />
        </div>
      )}

      <CloneDialog
        project={cloneTarget}
        domains={domains}
        onOpenChange={(o) => { if (!o) setCloneTarget(null); }}
        onCloned={(res) => {
          setCloneTarget(null);
          toast({ title: 'Clone starting', description: 'Provisioning the copy — this takes a minute.' });
          if (res.project?.id) navigate(`/projects/${res.project.id}`);
          else load();
        }}
      />

      <Dialog open={createOpen} onOpenChange={(o) => { if (!creating) setCreateOpen(o); }}>
        <DialogContent className="max-w-full h-full rounded-none overflow-y-auto sm:max-w-md sm:h-auto sm:rounded-lg">
          <DialogHeader>
            <DialogTitle>New project</DialogTitle>
            <DialogDescription>
              A container, bare git repo, and a per-slug HTTPS URL are provisioned on the
              chosen parent domain. The project name is display-only — the URL uses a minted slug,
              or the base domain itself when nothing else is using it.
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
                className="h-11 sm:h-10"
                placeholder="My prototype"
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                autoFocus
              />
              {form.name.trim() && selectedDomain ? (
                createUrl ? (
                  <p className="text-xs text-muted-foreground break-all">
                    URL: <code className="text-foreground">{createUrl.primary}</code>
                    {createUrl.also ? <> (also <code>{createUrl.also}</code>)</> : null}
                  </p>
                ) : (
                  <p className="text-xs text-amber-500">
                    Add a letter or number to the name to form a URL.
                  </p>
                )
              ) : null}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="proj-domain">Parent domain</Label>
              <Select
                value={form.parent_domain_id}
                onValueChange={(v) => setForm((f) => ({ ...f, parent_domain_id: v, use_base_domain: false }))}
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

            <BaseDomainOption
              id="proj-base-domain"
              domain={selectedDomain}
              checked={baseDomainOn}
              onChange={(v) => setForm((f) => ({ ...f, use_base_domain: v }))}
            />

            {/* Optional: submit the project to a git remote from the start. */}
            {gitConnectors.length > 0 ? (
              <div className="space-y-2 rounded-md border p-3">
                <label className="flex items-center gap-2 text-sm min-h-[44px] sm:min-h-0">
                  <input type="checkbox" className="h-4 w-4" checked={remoteOn} onChange={(e) => setRemoteOn(e.target.checked)} />
                  Also push this project to a git remote (Gitea / GitHub)
                </label>
                {remoteOn && (
                  <GitRemoteCardImport.Fields kind="project" value={remoteDraft} onChange={setRemoteDraft} connectors={gitConnectors} idPrefix="proj-remote" />
                )}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">
                To push projects to Gitea or GitHub, add a git connector under <Link to="/projects/connectors" className="underline">Projects → Connectors</Link>.
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              The project starts on the built-in base design. In the design chat you can keep
              that look or let the AI explore a new one per message.
            </p>
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

// One labelled number in the header strip.
function StatTile({ label, value }) {
  return (
    <div className="rounded-lg border bg-card px-3 py-2.5 min-w-0">
      <div className="text-xs text-muted-foreground truncate">{label}</div>
      <div className="text-lg font-semibold tabular-nums truncate">{value}</div>
    </div>
  );
}

// A titled block of projects in whichever view is active. Renders nothing when
// empty so an unpinned install shows one plain grid with no headings at all.
function Section({ title, count, items, view, archived = false, onTogglePin, onClone = null }) {
  if (items.length === 0) return null;
  return (
    <div className="space-y-3">
      {title ? (
        <h2 className="text-sm font-medium text-muted-foreground">
          {title} ({count})
        </h2>
      ) : null}
      {view === 'list' ? (
        <div className="divide-y rounded-lg border">
          {items.map((p) => (
            <ProjectRow key={p.id} p={p} archived={archived || p.lifecycle === 'archived'} onTogglePin={onTogglePin} onClone={onClone} />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {items.map((p) => (
            <ProjectTile key={p.id} p={p} archived={archived || p.lifecycle === 'archived'} onTogglePin={onTogglePin} onClone={onClone} />
          ))}
        </div>
      )}
    </div>
  );
}

// The clone button next to the pin — admin-only (the callback is null
// otherwise) and hidden while the source is still provisioning.
function CloneButton({ p, onClone }) {
  if (!onClone || p.lifecycle === 'provisioning') return null;
  return (
    <button
      type="button"
      onClick={() => onClone(p)}
      aria-label={`Clone ${p.name}`}
      title="Clone this project under a new name"
      className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:text-foreground sm:h-9 sm:w-9"
    >
      <Copy className="h-4 w-4" />
    </button>
  );
}

// Clone dialog — name + domain (+ the base-domain option, same as create) +
// what to bring. 'fresh' copies the app, its full git history, and the asset
// library (fresh database); 'full' also dumps and restores the source's
// database, which needs the source online.
function CloneDialog({ project, domains, onOpenChange, onCloned }) {
  const { toast } = useToast();
  const [name, setName] = useState('');
  const [domainId, setDomainId] = useState('');
  const [mode, setMode] = useState('fresh');
  const [useBaseDomain, setUseBaseDomain] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (project) {
      setName(`${project.name} copy`);
      setDomainId(String(project.parent_domain_id || domains[0]?.id || ''));
      setMode('fresh');
      // Never inherited from the source: two projects cannot both hold the
      // apex, so the copy has to ask for it on its own.
      setUseBaseDomain(false);
    }
  }, [project, domains]);

  const selectedDomain = domains.find((d) => String(d.id) === domainId) || null;
  const baseDomainOn = useBaseDomain && !!selectedDomain?.base_domain_available;
  const url = previewUrl(name, selectedDomain, baseDomainOn);

  if (!project) return null;
  const fullAvailable = project.lifecycle === 'active';

  const submit = async () => {
    if (!name.trim() || !domainId) return;
    setBusy(true);
    try {
      const res = await api.mock2CloneProject(project.id, {
        name: name.trim(),
        parent_domain_id: Number(domainId),
        mode,
        use_base_domain: baseDomainOn,
      });
      onCloned(res);
    } catch (err) {
      toast({ variant: 'destructive', title: 'Could not clone', description: err.message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => { if (!busy) onOpenChange(o); }}>
      <DialogContent className="max-w-full h-full rounded-none overflow-y-auto sm:max-w-md sm:h-auto sm:rounded-lg">
        <DialogHeader>
          <DialogTitle>Clone “{project.name}”</DialogTitle>
          <DialogDescription>
            The copy gets the app, its full build history, and the asset library, on its own
            container and URL.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={(e) => { e.preventDefault(); submit(); }} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="clone-name">New name</Label>
            <Input
              id="clone-name" className="h-11 sm:h-10" value={name}
              onChange={(e) => setName(e.target.value)} autoFocus
            />
            {name.trim() && url ? (
              <p className="text-xs text-muted-foreground break-all">
                URL: <code className="text-foreground">{url.primary}</code>
                {url.also ? <> (also <code>{url.also}</code>)</> : null}
              </p>
            ) : null}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="clone-domain">Parent domain</Label>
            <Select
              value={domainId}
              onValueChange={(v) => { setDomainId(v); setUseBaseDomain(false); }}
            >
              <SelectTrigger id="clone-domain" className="h-11 sm:h-10">
                <SelectValue placeholder="Choose a verified domain" />
              </SelectTrigger>
              <SelectContent>
                {domains.map((d) => (
                  <SelectItem key={d.id} value={String(d.id)}>{d.domain}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <BaseDomainOption
            id="clone-base-domain"
            domain={selectedDomain}
            checked={baseDomainOn}
            onChange={setUseBaseDomain}
          />
          <div className="space-y-2" role="radiogroup" aria-label="What to bring">
            <Label>What to bring</Label>
            <button
              type="button" role="radio" aria-checked={mode === 'fresh'}
              onClick={() => setMode('fresh')}
              className={`w-full rounded-lg border p-3 text-left min-h-[44px] ${mode === 'fresh' ? 'border-primary ring-1 ring-primary' : ''}`}
            >
              <span className="flex items-center gap-2 text-sm font-medium"><Copy className="h-4 w-4" />Fresh start</span>
              <span className="mt-0.5 block text-xs text-muted-foreground">
                App + git history + assets. The database starts empty (the app’s own setup runs).
              </span>
            </button>
            <button
              type="button" role="radio" aria-checked={mode === 'full'}
              onClick={() => fullAvailable && setMode('full')}
              disabled={!fullAvailable}
              className={`w-full rounded-lg border p-3 text-left min-h-[44px] ${mode === 'full' ? 'border-primary ring-1 ring-primary' : ''} ${fullAvailable ? '' : 'opacity-50'}`}
            >
              <span className="flex items-center gap-2 text-sm font-medium"><Database className="h-4 w-4" />Bring the database too</span>
              <span className="mt-0.5 block text-xs text-muted-foreground">
                {fullAvailable
                  ? 'Everything above, plus a copy of the source project’s database (users, records, content).'
                  : 'Needs the source project online — wake it first.'}
              </span>
            </button>
          </div>
          <DialogFooter className="flex-col sm:flex-row gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={busy} className="h-11 sm:h-10">
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !name.trim() || !domainId} className="h-11 sm:h-10">
              {busy ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
              Clone project
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
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

// The star that pins a project for THIS user. 44px tap target, filled when set.
function PinButton({ p, onTogglePin }) {
  return (
    <button
      type="button"
      onClick={() => onTogglePin(p)}
      aria-pressed={!!p.pinned}
      aria-label={p.pinned ? `Unpin ${p.name}` : `Pin ${p.name}`}
      title={p.pinned ? 'Unpin' : 'Pin to the top'}
      className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-md sm:h-9 sm:w-9 ${p.pinned ? 'text-amber-500' : 'text-muted-foreground hover:text-foreground'}`}
    >
      <Star className={`h-4 w-4 ${p.pinned ? 'fill-current' : ''}`} />
    </button>
  );
}

// Team, age and spend — the three numbers that make a card worth scanning.
// Wraps rather than overflows; every value degrades to "—" when unknown.
function ProjectMeta({ p }) {
  const members = p.members || [];
  const names = members.map((m) => m.username).filter(Boolean);
  const teamTitle = names.length > 0 ? names.join(', ') : 'No members yet';
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
      <span className="inline-flex items-center gap-1 min-w-0" title={teamTitle}>
        <Users className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate">
          {members.length === 0
            ? 'No members'
            : `${members.length} member${members.length === 1 ? '' : 's'}${names.length > 0 ? ` · ${names.slice(0, 2).join(', ')}${names.length > 2 ? ` +${names.length - 2}` : ''}` : ''}`}
        </span>
      </span>
      <span className="inline-flex items-center gap-1" title={p.created_at ? `Started ${new Date(p.created_at).toLocaleString()}` : undefined}>
        <CalendarDays className="h-3.5 w-3.5 shrink-0" />
        {ageLabel(p.created_at)}
      </span>
      <span className="inline-flex items-center gap-1" title="Lifetime AI spend on this project">
        <Wallet className="h-3.5 w-3.5 shrink-0" />
        {costLabel(p.cost_cents)}
      </span>
    </div>
  );
}

// One project card — used by both the active grid and the archived section. An
// archived card is dimmed and shows a rehydrate hint instead of a live URL (its
// slug is retained but currently 404s).
function ProjectTile({ p, archived = false, onTogglePin, onClone = null }) {
  return (
    <Card className={`flex h-full flex-col min-w-0${archived ? ' opacity-75' : ''}`}>
      <CardHeader className="pb-3">
        <div className="flex items-start gap-2 min-w-0">
          <div className="min-w-0 flex-1">
            <CardTitle className="truncate text-base">
              <Link to={`/projects/${p.id}`} className="hover:underline">{p.name}</Link>
            </CardTitle>
            <span className="mt-1.5 flex flex-wrap items-center gap-1">
              {!archived ? stageChip(p) : null}
              {statusChip(p.status, p.flagged)}
            </span>
          </div>
          <CloneButton p={p} onClone={onClone} />
          <PinButton p={p} onTogglePin={onTogglePin} />
        </div>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col gap-3">
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
        <ProjectMeta p={p} />
        <div className="mt-auto flex items-center justify-between gap-2 pt-1">
          <span className="truncate text-xs text-muted-foreground">{agoLabel(p.last_activity_at)}</span>
          <Button asChild variant="outline" size="sm" className="h-9 shrink-0">
            <Link to={`/projects/${p.id}`}>Open</Link>
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// The same project as a dense row — the list view, for installs with enough
// projects that a grid becomes a scroll. Stacks on <sm like every other row.
function ProjectRow({ p, archived = false, onTogglePin, onClone = null }) {
  return (
    <div className={`flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between${archived ? ' opacity-75' : ''}`}>
      <div className="flex min-w-0 flex-1 items-start gap-2">
        <PinButton p={p} onTogglePin={onTogglePin} />
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-2 min-w-0">
            <Link to={`/projects/${p.id}`} className="truncate font-medium hover:underline">{p.name}</Link>
            {!archived ? stageChip(p) : null}
            {statusChip(p.status, p.flagged)}
          </div>
          {archived ? (
            <span className="block text-xs text-muted-foreground">Archived — open to rehydrate the same URL.</span>
          ) : p.url ? (
            <a
              href={p.url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-xs text-primary hover:underline break-all"
            >
              {p.url.replace(/^https:\/\//, '')}
              <ExternalLink className="h-3 w-3 shrink-0" />
            </a>
          ) : (
            <span className="block text-xs text-muted-foreground">URL pending…</span>
          )}
          <ProjectMeta p={p} />
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-3">
        <span className="hidden text-xs text-muted-foreground md:inline">{agoLabel(p.last_activity_at)}</span>
        <CloneButton p={p} onClone={onClone} />
        <Button asChild variant="outline" size="sm" className="h-9">
          <Link to={`/projects/${p.id}`}>Open</Link>
        </Button>
      </div>
    </div>
  );
}
