// Component library (migration 516) — reusable, versioned building blocks the
// build runner is offered (an LDAPS auth module, a rate limiter, …) so a
// recurring need reuses ONE audited implementation instead of a fresh AI
// rewrite. Content is immutable per version; every change is a NEW version with
// a REQUIRED annotated change_reason; revert = a new version carrying old
// content (the framework-registry idiom). Components travel between installs as
// portable JSON documents (export/import), and project members can PROPOSE code
// from their project as a component — an admin approves it into the library or
// rejects it with a reason, all through the platform.
//
// Reachable only when Mock2 is enabled (ADR-001); the page self-guards on
// GET /api/mock2/status like its siblings.
//
// MOBILE_FIRST: single-column cards, full-width 44px touch targets, dialogs
// scroll inside max-h-[90vh] and complete on a 360px screen, no fixed widths.

import { useEffect, useState, useCallback, useRef } from 'react';
import { Navigate, Link } from 'react-router-dom';
import { useAuth } from '@/context/AuthContext';
import { api, ApiError } from '@/lib/api';
import { useToast } from '@/hooks/use-toast';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
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
  ArrowLeft, Loader2, Blocks, Plus, Eye, Download, Upload, Trash2, Undo2,
  GitCommitHorizontal, Inbox, Send, FileCode2, X,
} from 'lucide-react';

const emptyFile = () => ({ path: '', content: '' });

const deriveKey = (name) => String(name || '')
  .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64).replace(/-+$/g, '');

// ---- shared files editor: one row per file (path + content) ----
function FilesEditor({ files, onChange }) {
  const update = (i, patch) => onChange(files.map((f, j) => (j === i ? { ...f, ...patch } : f)));
  const remove = (i) => onChange(files.filter((_, j) => j !== i));
  return (
    <div className="space-y-3">
      {files.map((f, i) => (
        <div key={i} className="rounded-md border p-2 space-y-2">
          <div className="flex items-center gap-2">
            <FileCode2 className="h-4 w-4 shrink-0 text-muted-foreground" />
            <Input value={f.path} onChange={(e) => update(i, { path: e.target.value })}
              placeholder="src/lib/ldaps.ts" className="font-mono text-xs" />
            <Button variant="ghost" size="icon" className="h-11 w-11 shrink-0" onClick={() => remove(i)} aria-label="Remove file">
              <X className="h-4 w-4" />
            </Button>
          </div>
          <textarea rows={6} value={f.content} onChange={(e) => update(i, { content: e.target.value })}
            placeholder="file contents" className="w-full rounded-md border bg-background p-2 font-mono text-xs" />
        </div>
      ))}
      <Button variant="outline" className="min-h-[44px] w-full" onClick={() => onChange([...files, emptyFile()])}>
        <Plus className="mr-1 h-4 w-4" /> Add file
      </Button>
    </div>
  );
}

function StatusChip({ status }) {
  const styles = {
    published: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
    draft: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
    deprecated: 'bg-muted text-muted-foreground',
  };
  return <span className={`rounded px-2 py-0.5 text-xs ${styles[status] || styles.draft}`}>{status}</span>;
}

export default function ComponentLibrary() {
  const { user } = useAuth();
  const storedUser = JSON.parse(localStorage.getItem('user') || '{}');
  const isAdmin = user?.role === 'admin' || storedUser?.role === 'admin';
  const { toast } = useToast();

  const [gate, setGate] = useState('checking');
  const [components, setComponents] = useState([]);
  const [submissions, setSubmissions] = useState([]);
  const [projects, setProjects] = useState([]);
  const [busyId, setBusyId] = useState(null);

  const load = useCallback(async () => {
    try {
      const c = await api.mock2ListComponents();
      setComponents(c.components || []);
      if (isAdmin) {
        const [s, p] = await Promise.all([
          api.mock2ListComponentSubmissions('pending'),
          api.mock2ListProjects().catch(() => ({ projects: [] })),
        ]);
        setSubmissions(s.submissions || []);
        setProjects(p.projects || []);
      } else {
        const p = await api.mock2ListProjects().catch(() => ({ projects: [] }));
        setProjects(p.projects || []);
      }
    } catch (err) { if (!(err instanceof ApiError)) console.error('load components failed:', err); }
  }, [isAdmin]);

  useEffect(() => {
    let cancelled = false;
    api.mock2Status()
      .then(() => { if (!cancelled) { setGate('enabled'); load(); } })
      .catch((err) => { if (!cancelled) setGate('disabled'); if (!(err instanceof ApiError)) console.error(err); });
    return () => { cancelled = true; };
  }, [load]);

  // ---- view (detail + version history) ----
  const [viewing, setViewing] = useState(null);       // full component with files
  const [viewVersions, setViewVersions] = useState([]);
  const openView = async (id) => {
    try {
      const [c, v] = await Promise.all([api.mock2GetComponent(id), api.mock2ListComponentVersions(id)]);
      setViewing(c.component); setViewVersions(v.versions || []);
    } catch (err) { toast({ variant: 'destructive', title: 'Load failed', description: err.message }); }
  };
  const revert = async (vid) => {
    setBusyId(vid);
    try {
      const r = await api.mock2RevertComponentVersion(viewing.id, vid, null);
      toast({ title: `Reverted → v${r.version.version}` });
      await openView(viewing.id); await load();
    } catch (err) { toast({ variant: 'destructive', title: 'Revert failed', description: err.message }); }
    finally { setBusyId(null); }
  };

  // ---- create ----
  const emptyDraft = () => ({ name: '', key: '', description: '', category: '', tags: '', usage_md: '', change_reason: '', files: [emptyFile()] });
  const [createOpen, setCreateOpen] = useState(false);
  const [draft, setDraft] = useState(emptyDraft());
  const [saving, setSaving] = useState(false);
  const create = async () => {
    setSaving(true);
    try {
      const body = {
        name: draft.name, key: draft.key || undefined,
        description: draft.description || undefined, category: draft.category || undefined,
        tags: draft.tags ? draft.tags.split(',').map((t) => t.trim()).filter(Boolean) : undefined,
        usage_md: draft.usage_md || undefined, change_reason: draft.change_reason || undefined,
        files: draft.files.filter((f) => f.path.trim()),
      };
      const r = await api.mock2CreateComponent(body);
      setCreateOpen(false); setDraft(emptyDraft()); await load();
      toast({ title: `Component "${r.component.key}" created` });
    } catch (err) { toast({ variant: 'destructive', title: 'Create failed', description: err.message }); }
    finally { setSaving(false); }
  };

  // ---- new version ----
  const [versionFor, setVersionFor] = useState(null); // component being versioned
  const [versionDraft, setVersionDraft] = useState({ files: [], usage_md: '', change_reason: '' });
  const openNewVersion = async (c) => {
    try {
      const r = await api.mock2GetComponent(c.id);
      setVersionDraft({ files: r.component.files || [emptyFile()], usage_md: r.component.usage_md || '', change_reason: '' });
      setVersionFor(r.component);
    } catch (err) { toast({ variant: 'destructive', title: 'Load failed', description: err.message }); }
  };
  const publishVersion = async () => {
    setSaving(true);
    try {
      const r = await api.mock2PublishComponentVersion(versionFor.id, {
        files: versionDraft.files.filter((f) => f.path.trim()),
        usage_md: versionDraft.usage_md || undefined,
        change_reason: versionDraft.change_reason,
      });
      setVersionFor(null); await load();
      toast({ title: `Published ${versionFor.key} v${r.version.version}` });
    } catch (err) { toast({ variant: 'destructive', title: 'Publish failed', description: err.message }); }
    finally { setSaving(false); }
  };

  // ---- export / import ----
  const exportComponent = async (c) => {
    try {
      const doc = await api.mock2ExportComponent(c.id);
      const blob = new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `${c.key}-v${c.current_version}.component.json`;
      a.click(); URL.revokeObjectURL(url);
    } catch (err) { toast({ variant: 'destructive', title: 'Export failed', description: err.message }); }
  };
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState('');
  const [importReason, setImportReason] = useState('');
  // File-upload path: reads the picked .component.json into the same importText
  // the paste path uses, so one runImport serves both. Zip archives are NOT
  // accepted — the portable format is a single JSON document.
  const [importFileName, setImportFileName] = useState('');
  const importFileRef = useRef(null);
  const onImportFile = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-picking the same file after an edit
    if (!file) return;
    try {
      const text = await file.text();
      JSON.parse(text); // fail fast on non-JSON; the server validates the shape
      setImportText(text); setImportFileName(file.name);
    } catch {
      toast({ variant: 'destructive', title: 'Not a JSON file', description: `"${file.name}" could not be parsed — upload an exported .component.json document.` });
    }
  };
  const runImport = async () => {
    setSaving(true);
    try {
      let doc;
      try { doc = JSON.parse(importText); } catch { throw new Error('Not valid JSON — upload or paste an exported .component.json document'); }
      const r = await api.mock2ImportComponent(doc, importReason || undefined);
      setImportOpen(false); setImportText(''); setImportReason(''); setImportFileName(''); await load();
      toast({ title: r.created ? `Imported new component "${r.component.key}"` : `Imported as ${r.component.key} v${r.component.current_version}` });
    } catch (err) { toast({ variant: 'destructive', title: 'Import failed', description: err.message }); }
    finally { setSaving(false); }
  };

  // ---- status toggle + delete ----
  const setStatus = async (c, status) => {
    setBusyId(c.id);
    try { await api.mock2UpdateComponent(c.id, { status }); await load(); toast({ title: `${c.key} → ${status}` }); }
    catch (err) { toast({ variant: 'destructive', title: 'Update failed', description: err.message }); }
    finally { setBusyId(null); }
  };
  const remove = async (c) => {
    if (!window.confirm(`Delete component "${c.key}" and its whole version history? Prefer "deprecate" unless this was a mistake.`)) return;
    setBusyId(c.id);
    try { await api.mock2DeleteComponent(c.id); await load(); toast({ title: `Deleted ${c.key}` }); }
    catch (err) { toast({ variant: 'destructive', title: 'Delete failed', description: err.message }); }
    finally { setBusyId(null); }
  };

  // ---- propose (submission from a project) ----
  const emptyProposal = () => ({ project_id: '', component_id: '', proposed_name: '', proposed_key: '', description: '', notes: '', usage_md: '', files: [emptyFile()] });
  const [proposeOpen, setProposeOpen] = useState(false);
  const [proposal, setProposal] = useState(emptyProposal());
  const propose = async () => {
    setSaving(true);
    try {
      const body = {
        component_id: proposal.component_id || undefined,
        proposed_name: proposal.proposed_name,
        proposed_key: proposal.proposed_key || undefined,
        description: proposal.description || undefined,
        notes: proposal.notes || undefined,
        usage_md: proposal.usage_md || undefined,
        files: proposal.files.filter((f) => f.path.trim()),
      };
      await api.mock2CreateComponentSubmission(proposal.project_id, body);
      setProposeOpen(false); setProposal(emptyProposal()); await load();
      toast({ title: 'Submitted for review', description: 'An admin will approve it into the library or reject it with a reason.' });
    } catch (err) { toast({ variant: 'destructive', title: 'Submission failed', description: err.message }); }
    finally { setSaving(false); }
  };

  // ---- review submissions (admin) ----
  const [reviewing, setReviewing] = useState(null); // full submission with files
  const [reviewReason, setReviewReason] = useState('');
  const openReview = async (id) => {
    try { const r = await api.mock2GetComponentSubmission(id); setReviewing(r.submission); setReviewReason(''); }
    catch (err) { toast({ variant: 'destructive', title: 'Load failed', description: err.message }); }
  };
  const review = async (approved) => {
    if (!approved && !reviewReason.trim()) {
      toast({ variant: 'destructive', title: 'A reason is required to reject' });
      return;
    }
    setSaving(true);
    try {
      await api.mock2ReviewComponentSubmission(reviewing.id, { approved, reason: reviewReason || undefined });
      setReviewing(null); await load();
      toast({ title: approved ? 'Approved into the library' : 'Rejected' });
    } catch (err) { toast({ variant: 'destructive', title: 'Review failed', description: err.message }); }
    finally { setSaving(false); }
  };

  if (gate === 'checking') return <div className="flex items-center justify-center p-12"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>;
  if (gate === 'disabled') return <Navigate to="/" replace />;

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-4 sm:p-6">
      <div className="space-y-1">
        <Link to="/projects" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="h-4 w-4" /> Projects</Link>
        <h1 className="flex items-center gap-2 text-2xl font-semibold"><Blocks className="h-6 w-6" /> Component library</h1>
        <p className="text-sm text-muted-foreground">
          Reusable, versioned building blocks the build runner is offered — a repeated need (LDAPS auth, rate limiting, …)
          reuses one audited implementation instead of being rewritten per project. Every change is a new version with an
          annotated reason; components travel between installs as JSON documents.
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        {isAdmin && (
          <>
            <Button className="min-h-[44px]" onClick={() => { setDraft(emptyDraft()); setCreateOpen(true); }}>
              <Plus className="mr-1 h-4 w-4" /> New component
            </Button>
            <Button variant="outline" className="min-h-[44px]" onClick={() => setImportOpen(true)}>
              <Upload className="mr-1 h-4 w-4" /> Import
            </Button>
          </>
        )}
        {projects.length > 0 && (
          <Button variant="outline" className="min-h-[44px]" onClick={() => { setProposal(emptyProposal()); setProposeOpen(true); }}>
            <Send className="mr-1 h-4 w-4" /> Propose from a project
          </Button>
        )}
      </div>

      {/* ---- pending submissions (admin review inbox) ---- */}
      {isAdmin && submissions.length > 0 && (
        <Card className="border-amber-500/50">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base"><Inbox className="h-4 w-4" /> Pending submissions ({submissions.length})</CardTitle>
            <CardDescription>Proposed from projects — approve into the library or reject with a reason.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {submissions.map((s) => (
              <div key={s.id} className="flex flex-col gap-2 rounded-md border p-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <div className="font-medium">{s.proposed_name}</div>
                  <div className="text-xs text-muted-foreground">
                    {s.component_id ? 'new version of an existing component' : `new component · ${s.proposed_key || '(key on approve)'}`} · {s.file_count} file{s.file_count === 1 ? '' : 's'} · {s.created_at?.slice(0, 10)}
                  </div>
                  {s.notes && <div className="mt-1 text-sm text-muted-foreground">{s.notes}</div>}
                </div>
                <Button variant="outline" className="min-h-[44px] shrink-0" onClick={() => openReview(s.id)}><Eye className="mr-1 h-4 w-4" /> Review</Button>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* ---- component list ---- */}
      {components.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>No components yet</CardTitle>
            <CardDescription>
              Create one from proven code (an LDAPS connection module is the canonical example), import an exported
              component document, or promote code from a project via a submission. Published components are offered to
              every build automatically.
            </CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <div className="space-y-3">
          {components.map((c) => (
            <Card key={c.id} className={c.status === 'deprecated' ? 'opacity-60' : ''}>
              <CardHeader className="pb-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <CardTitle className="flex flex-wrap items-center gap-2 text-base">
                    {c.name}
                    <span className="rounded bg-muted px-2 py-0.5 font-mono text-xs">{c.key}</span>
                    <StatusChip status={c.status} />
                  </CardTitle>
                  <span className="text-xs text-muted-foreground">v{c.current_version ?? '—'}</span>
                </div>
              </CardHeader>
              <CardContent className="space-y-2">
                {c.description && <p className="text-sm text-muted-foreground">{c.description}</p>}
                {c.tags?.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {c.tags.map((t) => <span key={t} className="rounded bg-primary/10 px-2 py-0.5 text-xs text-primary">{t}</span>)}
                  </div>
                )}
                <div className="flex flex-wrap gap-2">
                  <Button variant="outline" size="sm" className="min-h-[44px]" onClick={() => openView(c.id)}><Eye className="mr-1 h-4 w-4" /> View</Button>
                  <Button variant="outline" size="sm" className="min-h-[44px]" onClick={() => exportComponent(c)}><Download className="mr-1 h-4 w-4" /> Export</Button>
                  {isAdmin && (
                    <>
                      <Button variant="outline" size="sm" className="min-h-[44px]" onClick={() => openNewVersion(c)}><GitCommitHorizontal className="mr-1 h-4 w-4" /> New version</Button>
                      {c.status === 'published'
                        ? <Button variant="outline" size="sm" className="min-h-[44px]" disabled={busyId === c.id} onClick={() => setStatus(c, 'deprecated')}>Deprecate</Button>
                        : <Button variant="outline" size="sm" className="min-h-[44px]" disabled={busyId === c.id} onClick={() => setStatus(c, 'published')}>Publish</Button>}
                      <Button variant="outline" size="sm" className="min-h-[44px] text-destructive" disabled={busyId === c.id} onClick={() => remove(c)}><Trash2 className="mr-1 h-4 w-4" /> Delete</Button>
                    </>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* ---- view dialog: files + annotated version history ---- */}
      <Dialog open={!!viewing} onOpenChange={(o) => { if (!o) setViewing(null); }}>
        <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex flex-wrap items-center gap-2">{viewing?.name} <span className="rounded bg-muted px-2 py-0.5 font-mono text-xs">{viewing?.key}</span></DialogTitle>
            {viewing?.description && <DialogDescription>{viewing.description}</DialogDescription>}
          </DialogHeader>
          {viewing?.usage_md && (
            <div>
              <div className="mb-1 text-sm font-medium">Integration notes</div>
              <pre className="max-h-40 overflow-auto rounded border bg-muted/40 p-2 text-xs whitespace-pre-wrap">{viewing.usage_md}</pre>
            </div>
          )}
          <div className="space-y-3">
            <div className="text-sm font-medium">Files (v{viewing?.current_version})</div>
            {(viewing?.files || []).map((f) => (
              <div key={f.path}>
                <div className="mb-1 font-mono text-xs text-muted-foreground">{f.path}</div>
                <pre className="max-h-52 overflow-auto rounded border bg-muted/40 p-2 text-xs">{f.content}</pre>
              </div>
            ))}
          </div>
          <div className="space-y-2">
            <div className="text-sm font-medium">Version history</div>
            {viewVersions.map((v) => (
              <div key={v.id} className="flex flex-col gap-2 rounded-md border p-2 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0 text-sm">
                  <span className="font-medium">v{v.version}</span>
                  <span className="ml-2 text-xs text-muted-foreground">{v.created_at?.slice(0, 10)} · {v.source}{v.reverted_from_version ? ` · reverted from v${v.reverted_from_version}` : ''}</span>
                  <div className="text-muted-foreground">{v.change_reason}</div>
                </div>
                {isAdmin && v.id !== viewing?.current_version_id && (
                  <Button variant="outline" size="sm" className="min-h-[44px] shrink-0" disabled={busyId === v.id} onClick={() => revert(v.id)}>
                    {busyId === v.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <><Undo2 className="mr-1 h-4 w-4" /> Revert to this</>}
                  </Button>
                )}
              </div>
            ))}
          </div>
          <DialogFooter><Button variant="ghost" onClick={() => setViewing(null)}>Close</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ---- create dialog ---- */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>New component</DialogTitle>
            <DialogDescription>Version 1 of a reusable building block. Published components are offered to every build.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div><Label htmlFor="c-name">Name</Label>
                <Input id="c-name" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="LDAPS Connection" /></div>
              <div><Label htmlFor="c-key">Key</Label>
                <Input id="c-key" value={draft.key} onChange={(e) => setDraft({ ...draft, key: e.target.value })} placeholder={deriveKey(draft.name) || 'ldaps-connection'} className="font-mono" /></div>
            </div>
            <div><Label htmlFor="c-desc">Description (what it does — shown to the runner)</Label>
              <Input id="c-desc" value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} placeholder="LDAPS bind + user/group lookup with connection pooling" /></div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div><Label htmlFor="c-cat">Category</Label>
                <Input id="c-cat" value={draft.category} onChange={(e) => setDraft({ ...draft, category: e.target.value })} placeholder="auth" /></div>
              <div><Label htmlFor="c-tags">Tags (comma-separated)</Label>
                <Input id="c-tags" value={draft.tags} onChange={(e) => setDraft({ ...draft, tags: e.target.value })} placeholder="ldap, auth, sso" /></div>
            </div>
            <div><Label htmlFor="c-usage">Integration notes (how to wire it in)</Label>
              <textarea id="c-usage" rows={4} value={draft.usage_md} onChange={(e) => setDraft({ ...draft, usage_md: e.target.value })}
                className="w-full rounded-md border bg-background p-2 text-sm" placeholder="Env vars, the exported functions, where the glue goes…" /></div>
            <div><Label>Files</Label><FilesEditor files={draft.files} onChange={(files) => setDraft({ ...draft, files })} /></div>
            <div><Label htmlFor="c-reason">Reason (why this component exists)</Label>
              <Input id="c-reason" value={draft.change_reason} onChange={(e) => setDraft({ ...draft, change_reason: e.target.value })} placeholder="Initial version" /></div>
          </div>
          <DialogFooter className="flex-col gap-2 sm:flex-row">
            <Button variant="ghost" onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button onClick={create} disabled={saving || !draft.name.trim() || !draft.files.some((f) => f.path.trim())}>
              {saving && <Loader2 className="mr-1 h-4 w-4 animate-spin" />} Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ---- new version dialog ---- */}
      <Dialog open={!!versionFor} onOpenChange={(o) => { if (!o) setVersionFor(null); }}>
        <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>New version of {versionFor?.key}</DialogTitle>
            <DialogDescription>Content is immutable per version — this publishes v{(versionFor?.current_version ?? 0) + 1}. The reason is recorded in the history.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div><Label>Files (prefilled from v{versionFor?.current_version})</Label>
              <FilesEditor files={versionDraft.files} onChange={(files) => setVersionDraft({ ...versionDraft, files })} /></div>
            <div><Label htmlFor="v-usage">Integration notes</Label>
              <textarea id="v-usage" rows={4} value={versionDraft.usage_md} onChange={(e) => setVersionDraft({ ...versionDraft, usage_md: e.target.value })}
                className="w-full rounded-md border bg-background p-2 text-sm" /></div>
            <div><Label htmlFor="v-reason">Change reason (required — why this version exists)</Label>
              <Input id="v-reason" value={versionDraft.change_reason} onChange={(e) => setVersionDraft({ ...versionDraft, change_reason: e.target.value })}
                placeholder="e.g. switch to pooled connections after the prod timeout incident" /></div>
          </div>
          <DialogFooter className="flex-col gap-2 sm:flex-row">
            <Button variant="ghost" onClick={() => setVersionFor(null)}>Cancel</Button>
            <Button onClick={publishVersion} disabled={saving || !versionDraft.change_reason.trim() || !versionDraft.files.some((f) => f.path.trim())}>
              {saving && <Loader2 className="mr-1 h-4 w-4 animate-spin" />} Publish version
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ---- import dialog ---- */}
      <Dialog open={importOpen} onOpenChange={setImportOpen}>
        <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Import a component</DialogTitle>
            <DialogDescription>Upload or paste an exported .component.json document. A new key creates the component; an existing key gets a new version.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <input ref={importFileRef} type="file" accept=".json,application/json" className="hidden" onChange={onImportFile} aria-hidden="true" tabIndex={-1} />
              <Button type="button" variant="outline" className="min-h-[44px]" onClick={() => importFileRef.current?.click()}>
                <Upload className="mr-1 h-4 w-4" /> Upload file
              </Button>
              {importFileName ? (
                <span className="flex min-w-0 items-center gap-1 text-sm text-muted-foreground">
                  <FileCode2 className="h-4 w-4 shrink-0" /><span className="truncate">{importFileName}</span>
                </span>
              ) : (
                <span className="text-sm text-muted-foreground">…or paste the document below</span>
              )}
            </div>
            <textarea rows={10} value={importText} onChange={(e) => { setImportText(e.target.value); setImportFileName(''); }}
              className="w-full rounded-md border bg-background p-2 font-mono text-xs" placeholder='{"format":"proxypilot-component@1", …}' />
            <div><Label htmlFor="i-reason">Reason (recorded in the history)</Label>
              <Input id="i-reason" value={importReason} onChange={(e) => setImportReason(e.target.value)} placeholder="Imported from the staging install" /></div>
          </div>
          <DialogFooter className="flex-col gap-2 sm:flex-row">
            <Button variant="ghost" onClick={() => setImportOpen(false)}>Cancel</Button>
            <Button onClick={runImport} disabled={saving || !importText.trim()}>{saving && <Loader2 className="mr-1 h-4 w-4 animate-spin" />} Import</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ---- propose dialog (submission from a project) ---- */}
      <Dialog open={proposeOpen} onOpenChange={setProposeOpen}>
        <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Propose a component</DialogTitle>
            <DialogDescription>Promote code from one of your projects into the library. An admin reviews it — approved submissions become a component (or a new version of one).</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div><Label>From project</Label>
              <Select value={String(proposal.project_id)} onValueChange={(v) => setProposal({ ...proposal, project_id: v })}>
                <SelectTrigger className="min-h-[44px]"><SelectValue placeholder="Select a project" /></SelectTrigger>
                <SelectContent>
                  {projects.map((p) => <SelectItem key={p.id} value={String(p.id)}>{p.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div><Label>Target</Label>
              <Select value={proposal.component_id ? String(proposal.component_id) : 'new'} onValueChange={(v) => setProposal({ ...proposal, component_id: v === 'new' ? '' : v })}>
                <SelectTrigger className="min-h-[44px]"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="new">A brand-new component</SelectItem>
                  {components.map((c) => <SelectItem key={c.id} value={String(c.id)}>New version of: {c.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div><Label htmlFor="p-name">Name</Label>
                <Input id="p-name" value={proposal.proposed_name} onChange={(e) => setProposal({ ...proposal, proposed_name: e.target.value })} placeholder="LDAPS Connection" /></div>
              {!proposal.component_id && (
                <div><Label htmlFor="p-key">Key</Label>
                  <Input id="p-key" value={proposal.proposed_key} onChange={(e) => setProposal({ ...proposal, proposed_key: e.target.value })} placeholder={deriveKey(proposal.proposed_name) || 'ldaps-connection'} className="font-mono" /></div>
              )}
            </div>
            <div><Label htmlFor="p-desc">Description</Label>
              <Input id="p-desc" value={proposal.description} onChange={(e) => setProposal({ ...proposal, description: e.target.value })} /></div>
            <div><Label htmlFor="p-notes">Notes for the reviewer (why this belongs in the library)</Label>
              <textarea id="p-notes" rows={3} value={proposal.notes} onChange={(e) => setProposal({ ...proposal, notes: e.target.value })}
                className="w-full rounded-md border bg-background p-2 text-sm" /></div>
            <div><Label htmlFor="p-usage">Integration notes</Label>
              <textarea id="p-usage" rows={3} value={proposal.usage_md} onChange={(e) => setProposal({ ...proposal, usage_md: e.target.value })}
                className="w-full rounded-md border bg-background p-2 text-sm" /></div>
            <div><Label>Files</Label><FilesEditor files={proposal.files} onChange={(files) => setProposal({ ...proposal, files })} /></div>
          </div>
          <DialogFooter className="flex-col gap-2 sm:flex-row">
            <Button variant="ghost" onClick={() => setProposeOpen(false)}>Cancel</Button>
            <Button onClick={propose} disabled={saving || !proposal.project_id || !proposal.proposed_name.trim() || !proposal.files.some((f) => f.path.trim())}>
              {saving && <Loader2 className="mr-1 h-4 w-4 animate-spin" />} Submit for review
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ---- review dialog (admin) ---- */}
      <Dialog open={!!reviewing} onOpenChange={(o) => { if (!o) setReviewing(null); }}>
        <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Review: {reviewing?.proposed_name}</DialogTitle>
            <DialogDescription>
              {reviewing?.component_id ? 'Proposes a NEW VERSION of an existing component.' : `Proposes a NEW component (key: ${reviewing?.proposed_key || '—'}).`}
              {reviewing?.notes ? ` Submitter: ${reviewing.notes}` : ''}
            </DialogDescription>
          </DialogHeader>
          {reviewing?.usage_md && (
            <div><div className="mb-1 text-sm font-medium">Integration notes</div>
              <pre className="max-h-32 overflow-auto rounded border bg-muted/40 p-2 text-xs whitespace-pre-wrap">{reviewing.usage_md}</pre></div>
          )}
          <div className="space-y-3">
            {(reviewing?.files || []).map((f) => (
              <div key={f.path}>
                <div className="mb-1 font-mono text-xs text-muted-foreground">{f.path}</div>
                <pre className="max-h-52 overflow-auto rounded border bg-muted/40 p-2 text-xs">{f.content}</pre>
              </div>
            ))}
          </div>
          <div><Label htmlFor="r-reason">Reason (required to reject; recorded either way)</Label>
            <Input id="r-reason" value={reviewReason} onChange={(e) => setReviewReason(e.target.value)} placeholder="e.g. solid, but rename the env vars to match the library convention" /></div>
          <DialogFooter className="flex-col gap-2 sm:flex-row">
            <Button variant="ghost" onClick={() => setReviewing(null)}>Close</Button>
            <Button variant="outline" className="text-destructive" onClick={() => review(false)} disabled={saving}>Reject</Button>
            <Button onClick={() => review(true)} disabled={saving}>{saving && <Loader2 className="mr-1 h-4 w-4 animate-spin" />} Approve into library</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
