// Mock2 framework registry admin surface (Phase M5, ADR-003).
//
// The framework (constitution + four skills + gate scripts + design system +
// project template) is a versioned, append-only bundle. Content is immutable per
// version; a revert publishes a NEW version carrying the old content. Editing is
// admin-gated with a side-by-side diff against the current version before commit.
//
// ⚠ Version 1 is a vendored PLACEHOLDER (risk R8) — the operator's real content
// is still owed; a banner says so until a real version is published.
//
// Reachable only when Mock2 is enabled (ADR-001). MOBILE_FIRST: single column,
// the diff stacks to one column on <lg, 44px targets, full-screen editor dialog.

import { useEffect, useState, useCallback } from 'react';
import { Navigate, Link } from 'react-router-dom';
import { useAuth } from '@/context/AuthContext';
import { api, ApiError } from '@/lib/api';
import { useToast } from '@/hooks/use-toast';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import { ArrowLeft, Loader2, BookText, GitCommitHorizontal, Undo2, AlertTriangle, Eye } from 'lucide-react';

const FIELDS = [
  { key: 'constitution_md', label: 'Constitution (markdown)', rows: 8 },
  { key: 'design_system_md', label: 'Design system (markdown)', rows: 8 },
  { key: 'skills_json', label: 'Skills (JSON)', rows: 6, mono: true },
  { key: 'gates_json', label: 'Gates (JSON array)', rows: 6, mono: true },
  { key: 'project_template_ref', label: 'Project template ref', rows: 1 },
];

const emptyDraft = () => ({ constitution_md: '', design_system_md: '', skills_json: '', gates_json: '', project_template_ref: '', changelog: '' });

export default function FrameworkVersions() {
  const { user } = useAuth();
  const storedUser = JSON.parse(localStorage.getItem('user') || '{}');
  const isAdmin = user?.role === 'admin' || storedUser?.role === 'admin';
  const { toast } = useToast();

  const [gate, setGate] = useState('checking');
  const [versions, setVersions] = useState([]);
  const [current, setCurrent] = useState(null);
  const [viewing, setViewing] = useState(null); // a full version being viewed
  const [busyId, setBusyId] = useState(null);

  const load = useCallback(async () => {
    try {
      const [v, c] = await Promise.all([api.mock2ListFrameworkVersions(), api.mock2GetCurrentFramework()]);
      setVersions(v.versions || []);
      setCurrent(c.version || null);
    } catch (err) { if (!(err instanceof ApiError)) console.error('load framework failed:', err); }
  }, []);

  useEffect(() => {
    let cancelled = false;
    api.mock2Status()
      .then(() => { if (!cancelled) { setGate('enabled'); load(); } })
      .catch((err) => { if (!cancelled) setGate('disabled'); if (!(err instanceof ApiError)) console.error(err); });
    return () => { cancelled = true; };
  }, [load]);

  // ---- editor ----
  const [editOpen, setEditOpen] = useState(false);
  const [draft, setDraft] = useState(emptyDraft());
  const [showDiff, setShowDiff] = useState(false);
  const [saving, setSaving] = useState(false);

  const openEditor = () => {
    // Prefill from the current version so an edit is a diff, not a rewrite.
    if (current) {
      setDraft({
        constitution_md: current.constitution_md || '', design_system_md: current.design_system_md || '',
        skills_json: current.skills_json || '', gates_json: current.gates_json || '',
        project_template_ref: current.project_template_ref || '', changelog: '',
      });
    } else setDraft(emptyDraft());
    setShowDiff(false); setEditOpen(true);
  };

  const publish = async () => {
    setSaving(true);
    try {
      const res = await api.mock2PublishFramework(draft);
      setEditOpen(false); await load(); toast({ title: `Published v${res.version.version}` });
    } catch (err) { toast({ variant: 'destructive', title: 'Publish failed', description: err.message }); }
    finally { setSaving(false); }
  };

  const revert = async (id) => {
    setBusyId(id);
    try { const res = await api.mock2RevertFramework(id, null); await load(); toast({ title: `Reverted → v${res.version.version}` }); }
    catch (err) { toast({ variant: 'destructive', title: 'Revert failed', description: err.message }); }
    finally { setBusyId(null); }
  };

  const viewVersion = async (id) => {
    try { const r = await api.mock2GetFrameworkVersion(id); setViewing(r.version); }
    catch (err) { toast({ variant: 'destructive', title: 'Load failed', description: err.message }); }
  };

  if (gate === 'checking') return <div className="flex items-center justify-center p-12"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>;
  if (gate === 'disabled' || !isAdmin) return <Navigate to="/" replace />;

  const isPlaceholder = current && /placeholder/i.test(current.changelog || '');

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-4 sm:p-6">
      <div className="space-y-1">
        <Link to="/projects" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="h-4 w-4" /> Projects</Link>
        <h1 className="flex items-center gap-2 text-2xl font-semibold"><BookText className="h-6 w-6" /> Framework versions</h1>
        <p className="text-sm text-muted-foreground">The versioned bundle a build cycle pins. Content is immutable per version; a revert publishes a new version carrying the old content.</p>
      </div>

      {isPlaceholder && (
        <Card className="border-amber-500/50">
          <CardContent className="flex items-start gap-2 p-4 text-sm">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
            <span>The current version is a <strong>vendored placeholder</strong> (risk R8). The operator&apos;s real framework content — constitution, four skills, gate scripts, design system — is still owed. Publish a new version once it&apos;s supplied.</span>
          </CardContent>
        </Card>
      )}

      <div className="flex justify-end">
        <Button onClick={openEditor} className="min-h-[44px]"><GitCommitHorizontal className="mr-1 h-4 w-4" /> {current ? 'Edit → publish new version' : 'Publish version 1'}</Button>
      </div>

      {versions.map((v) => (
        <Card key={v.id} className={current && v.id === current.id ? 'border-primary/50' : ''}>
          <CardHeader className="pb-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <CardTitle className="text-base">v{v.version}{current && v.id === current.id && <span className="ml-2 rounded bg-primary/10 px-2 py-0.5 text-xs text-primary">current</span>}</CardTitle>
              <span className="text-xs text-muted-foreground">{v.created_at?.slice(0, 10)} · {v.source}</span>
            </div>
          </CardHeader>
          <CardContent className="space-y-2">
            {v.changelog && <p className="text-sm text-muted-foreground">{v.changelog}</p>}
            {v.reverted_from_version && <p className="text-xs text-muted-foreground">reverted from v{v.reverted_from_version}</p>}
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" className="min-h-[44px]" onClick={() => viewVersion(v.id)}><Eye className="mr-1 h-4 w-4" /> View</Button>
              {!(current && v.id === current.id) && (
                <Button variant="outline" size="sm" className="min-h-[44px]" disabled={busyId === v.id} onClick={() => revert(v.id)}>
                  {busyId === v.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <><Undo2 className="mr-1 h-4 w-4" /> Revert to this</>}
                </Button>
              )}
            </div>
          </CardContent>
        </Card>
      ))}

      {/* ---- editor dialog with diff ---- */}
      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{current ? `New version (v${current.version} → v${current.version + 1})` : 'Publish version 1'}</DialogTitle>
            <DialogDescription>Content is immutable once published. Review the diff before committing.</DialogDescription>
          </DialogHeader>

          {!showDiff ? (
            <div className="space-y-3">
              {FIELDS.map((f) => (
                <div key={f.key}>
                  <Label htmlFor={f.key}>{f.label}</Label>
                  {f.rows === 1 ? (
                    <input id={f.key} value={draft[f.key]} onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })}
                      className="w-full rounded-md border bg-background p-2 text-sm" />
                  ) : (
                    <textarea id={f.key} rows={f.rows} value={draft[f.key]} onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })}
                      className={`w-full rounded-md border bg-background p-2 text-sm ${f.mono ? 'font-mono' : ''}`} />
                  )}
                </div>
              ))}
              <div><Label htmlFor="cl">Changelog</Label>
                <input id="cl" value={draft.changelog} onChange={(e) => setDraft({ ...draft, changelog: e.target.value })}
                  className="w-full rounded-md border bg-background p-2 text-sm" placeholder="why this version exists" />
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              {FIELDS.map((f) => (
                <div key={f.key}>
                  <div className="mb-1 text-sm font-medium">{f.label}</div>
                  <div className="grid grid-cols-1 gap-2 lg:grid-cols-2">
                    <div>
                      <div className="mb-1 text-xs text-muted-foreground">current (v{current?.version ?? '—'})</div>
                      <pre className="max-h-40 overflow-auto rounded border bg-muted/40 p-2 text-xs whitespace-pre-wrap">{current?.[f.key] || '(none)'}</pre>
                    </div>
                    <div>
                      <div className="mb-1 text-xs text-muted-foreground">new</div>
                      <pre className={`max-h-40 overflow-auto rounded border p-2 text-xs whitespace-pre-wrap ${draft[f.key] !== (current?.[f.key] || '') ? 'border-primary/60 bg-primary/5' : 'bg-muted/40'}`}>{draft[f.key] || '(none)'}</pre>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}

          <DialogFooter className="flex-col gap-2 sm:flex-row">
            <Button variant="ghost" onClick={() => setEditOpen(false)}>Cancel</Button>
            {current && <Button variant="outline" onClick={() => setShowDiff((s) => !s)}>{showDiff ? 'Back to edit' : 'Show diff'}</Button>}
            <Button onClick={publish} disabled={saving}>{saving && <Loader2 className="mr-1 h-4 w-4 animate-spin" />} Publish</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ---- view dialog ---- */}
      <Dialog open={!!viewing} onOpenChange={(o) => { if (!o) setViewing(null); }}>
        <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
          <DialogHeader><DialogTitle>v{viewing?.version}</DialogTitle>{viewing?.changelog && <DialogDescription>{viewing.changelog}</DialogDescription>}</DialogHeader>
          <div className="space-y-3">
            {FIELDS.map((f) => (
              <div key={f.key}>
                <div className="mb-1 text-sm font-medium">{f.label}</div>
                <pre className="max-h-52 overflow-auto rounded border bg-muted/40 p-2 text-xs whitespace-pre-wrap">{viewing?.[f.key] || '(none)'}</pre>
              </div>
            ))}
          </div>
          <DialogFooter><Button variant="ghost" onClick={() => setViewing(null)}>Close</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
