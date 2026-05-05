// CVEs section — operator UI for the inbox at
// /var/lib/proxypilot/cve-inbox/<cve>.yaml.
//
// List view: one row per inbox entry. Sortable by tier/score/last_updated.
// Filter chips for tier, action_class, host, status. Status badge per row.
//
// Detail view: rendered YAML, action buttons (Run on this host /
// Copy patch / Copy rollback / Mark dismissed), full history.
//
// All state writes go through the engine via the backend (mark seen,
// dismiss, run-one) so the YAML opaque-field preservation contract
// stays in one place.

import { useEffect, useMemo, useState, useCallback } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '@/context/AuthContext';
import { api, ApiError } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { useToast } from '@/hooks/use-toast';
import {
  ArrowLeft, BugPlay, Copy, Loader2, Pencil, Plus, RefreshCw, Save, Trash2, X, Zap,
} from 'lucide-react';

const STATUS_TONE = {
  NEW: 'bg-orange-500/15 text-orange-500 border-orange-500/30',
  QUEUED: 'bg-blue-500/15 text-blue-400 border-blue-500/30',
  'IN-PROGRESS': 'bg-blue-500/15 text-blue-400 border-blue-500/30',
  IN_PROGRESS: 'bg-blue-500/15 text-blue-400 border-blue-500/30',
  RESOLVED: 'bg-emerald-500/15 text-emerald-500 border-emerald-500/30',
  DISMISSED: 'bg-muted text-muted-foreground border-border',
  BLOCKED: 'bg-amber-500/15 text-amber-500 border-amber-500/30',
  'ALERT-AUTO-ROLLBACK': 'bg-red-500/15 text-red-500 border-red-500/40',
};

function StatusPill({ status }) {
  const tone = STATUS_TONE[status] || 'bg-muted text-muted-foreground border-border';
  return (
    <span className={`inline-flex items-center text-xs font-medium border px-2 py-0.5 rounded ${tone}`}>
      {status || 'UNKNOWN'}
    </span>
  );
}

function ActionPill({ action }) {
  const tone = action === 'AUTO_PATCH'
    ? 'bg-emerald-500/10 text-emerald-500 border-emerald-500/30'
    : action === 'ONE_CLICK'
    ? 'bg-blue-500/10 text-blue-400 border-blue-500/30'
    : 'bg-muted text-muted-foreground border-border';
  return (
    <span className={`inline-flex items-center text-xs font-mono border px-2 py-0.5 rounded ${tone}`}>
      {action || 'ALERT'}
    </span>
  );
}

// Pull a single top-level scalar out of a YAML body. Robust to
// trailing comments and quoted values; intentionally not a full YAML
// parser — the engine round-trips through ruamel.yaml on the host.
function yamlScalar(body, key) {
  if (!body) return null;
  const m = body.match(new RegExp(`(?:^|\\n)${key}:\\s*([^\\n]+)`));
  if (!m) return null;
  return m[1].replace(/\s+#.*$/, '').replace(/^["']|["']$/g, '').trim();
}

// Pull the patch.steps array as a flat list of strings. Best-effort
// shallow scan; multi-line block scalars are returned verbatim.
function extractPatchSteps(body) {
  if (!body) return [];
  const lines = body.split('\n');
  let inSteps = false;
  let baseIndent = -1;
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!inSteps) {
      if (/^\s+steps:\s*$/.test(line)) {
        inSteps = true;
        baseIndent = line.match(/^(\s+)/)[1].length;
      }
      continue;
    }
    const indentMatch = line.match(/^(\s*)(.*)$/);
    const indent = indentMatch[1].length;
    const rest = indentMatch[2];
    if (rest === '' ) continue;
    if (indent <= baseIndent) break;
    if (rest.startsWith('- ')) {
      const value = rest.slice(2).trim().replace(/^["']|["']$/g, '');
      out.push(value);
    }
  }
  return out;
}

// Extract the rollback restore string (single scalar under
// playbook.patch.rollback.restore).
function extractRollbackRestore(body) {
  if (!body) return null;
  const m = body.match(/restore:\s*(?:\|[+-]?\s*\n((?:\s+[^\n]*\n?)+)|"([^"]+)"|'([^']+)'|([^\n#]+))/);
  if (!m) return null;
  if (m[1]) {
    return m[1]
      .split('\n')
      .map(l => l.replace(/^\s{2,}/, ''))
      .join('\n')
      .trim();
  }
  return (m[2] || m[3] || m[4] || '').trim();
}

// History list under state.history. Entries are yaml mapping nodes
// with ts, actor, change. Returns array of {ts, actor, change, host}.
function extractHistory(body) {
  if (!body) return [];
  const idx = body.search(/\n\s*history:\s*\n/);
  if (idx < 0) return [];
  const tail = body.slice(idx + 1);
  const items = [];
  let cur = null;
  for (const line of tail.split('\n')) {
    if (!/^\s/.test(line) && line.trim() !== '') break;
    const dash = line.match(/^\s*-\s*(.*)$/);
    if (dash) {
      if (cur) items.push(cur);
      cur = {};
      const inline = dash[1].match(/^(\w+):\s*(.*)$/);
      if (inline) cur[inline[1]] = inline[2].replace(/^["']|["']$/g, '');
      continue;
    }
    const kv = line.match(/^\s+(\w+):\s*(.*)$/);
    if (kv && cur) cur[kv[1]] = kv[2].replace(/^["']|["']$/g, '');
  }
  if (cur) items.push(cur);
  return items;
}

function CveListRow({ entry, onOpen }) {
  return (
    <button
      type="button"
      onClick={() => onOpen(entry.cve)}
      className="w-full text-left grid grid-cols-12 gap-3 items-center px-3 py-2 border-b hover:bg-accent/40"
    >
      <div className="col-span-12 sm:col-span-3 font-mono text-sm flex items-center gap-2">
        {!entry.operator_seen && (
          <span className="h-2 w-2 rounded-full bg-orange-500" aria-label="unread" />
        )}
        {entry.cve}
      </div>
      <div className="col-span-7 sm:col-span-4 text-sm text-muted-foreground truncate">
        {entry.name || '—'}
      </div>
      <div className="col-span-2 sm:col-span-1 text-xs">
        {entry.tier ? `T${entry.tier}` : ''}
      </div>
      <div className="col-span-3 sm:col-span-2"><ActionPill action={entry.action_class} /></div>
      <div className="col-span-12 sm:col-span-2 flex justify-start sm:justify-end">
        <StatusPill status={entry.status} />
      </div>
    </button>
  );
}

function CveDetail({ cveId, onBack, onChanged, onDeleted }) {
  const { toast } = useToast();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [running, setRunning] = useState(false);
  const [dismissOpen, setDismissOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const result = await api.getCve(cveId);
      setData(result);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : (err?.message || 'failed to load'));
    } finally {
      setLoading(false);
    }
  }, [cveId]);

  useEffect(() => {
    refresh();
    // Mark as seen on open — fire-and-forget; failure doesn't block
    // the read view, the badge will retry on next poll.
    api.markCveSeen(cveId).then(() => onChanged?.()).catch(() => {});
  }, [cveId, refresh, onChanged]);

  const yamlBody = data?.yaml || '';
  const patchSteps = useMemo(() => extractPatchSteps(yamlBody), [yamlBody]);
  const rollbackBody = useMemo(() => extractRollbackRestore(yamlBody), [yamlBody]);
  const history = useMemo(() => extractHistory(yamlBody), [yamlBody]);

  const copyText = async (text, label) => {
    try {
      await navigator.clipboard.writeText(text);
      toast({ title: `${label} copied`, description: 'Pasted into clipboard.' });
    } catch (err) {
      toast({ title: 'Copy failed', description: err?.message || 'clipboard unavailable', variant: 'destructive' });
    }
  };

  const onRun = async () => {
    setRunning(true);
    try {
      const out = await api.runCve(cveId, { force_action: 'ONE_CLICK' });
      const r = out?.result || {};
      toast({
        title: `Run finished: ${r.final_status || 'unknown'}`,
        description: r.skipped_reason
          || (r.operator_action_required && r.operator_action_required !== 'none'
              ? `Operator action: ${r.operator_action_required}`
              : 'No further operator action required.'),
      });
      await refresh();
      onChanged?.();
    } catch (err) {
      toast({
        title: 'Run failed',
        description: err instanceof ApiError ? err.message : (err?.message || 'unknown error'),
        variant: 'destructive',
      });
    } finally {
      setRunning(false);
    }
  };

  const onDismiss = async () => {
    if (!reason.trim()) return;
    try {
      await api.dismissCve(cveId, reason.trim());
      toast({ title: 'Dismissed', description: 'Status set to DISMISSED.' });
      setDismissOpen(false);
      setReason('');
      await refresh();
      onChanged?.();
    } catch (err) {
      toast({
        title: 'Dismiss failed',
        description: err instanceof ApiError ? err.message : (err?.message || 'unknown error'),
        variant: 'destructive',
      });
    }
  };

  const onStartEdit = () => {
    setDraft(yamlBody);
    setEditing(true);
  };

  const onSaveEdit = async () => {
    setSaving(true);
    try {
      await api.saveCveEdit(cveId, draft);
      toast({ title: 'Saved', description: 'Spec updated; engine picks it up on next poll.' });
      setEditing(false);
      await refresh();
      onChanged?.();
    } catch (err) {
      toast({
        title: 'Save failed',
        description: err instanceof ApiError ? err.message : (err?.message || 'unknown error'),
        variant: 'destructive',
      });
    } finally {
      setSaving(false);
    }
  };

  const onDelete = async () => {
    try {
      await api.deleteCve(cveId);
      toast({ title: 'Deleted', description: `${cveId} removed from inbox.` });
      setDeleteOpen(false);
      onDeleted?.();
    } catch (err) {
      toast({
        title: 'Delete failed',
        description: err instanceof ApiError ? err.message : (err?.message || 'unknown error'),
        variant: 'destructive',
      });
    }
  };

  const action = data?.action_class || 'ALERT';
  const status = data?.status || 'NEW';
  const isOneClick = action === 'ONE_CLICK';
  const isAutoPatch = action === 'AUTO_PATCH';

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeft className="h-4 w-4 mr-1" /> Back
        </Button>
        <h1 className="text-lg font-semibold font-mono">{cveId}</h1>
        <div className="ml-auto flex items-center gap-2">
          <ActionPill action={action} />
          <StatusPill status={status} />
          <Button variant="outline" size="sm" onClick={refresh} disabled={loading}>
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          </Button>
        </div>
      </div>

      {error && (
        <div className="text-sm text-red-500 border border-red-500/30 bg-red-500/10 rounded px-3 py-2">
          {error}
        </div>
      )}

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </div>
      ) : (
        <>
          <Card>
            <CardHeader><CardTitle className="text-base">Actions</CardTitle></CardHeader>
            <CardContent className="flex flex-wrap gap-2">
              <Button
                size="sm"
                onClick={onRun}
                disabled={running || action === 'ALERT' || status === 'DISMISSED'}
                title={action === 'ALERT' ? 'ALERT entries are read-only' : undefined}
              >
                {running ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <BugPlay className="h-4 w-4 mr-1.5" />}
                Run on this host
              </Button>
              <Button
                variant="outline" size="sm"
                onClick={() => copyText(patchSteps.join('\n'), 'Patch')}
                disabled={patchSteps.length === 0}
              >
                <Copy className="h-4 w-4 mr-1.5" /> Copy patch
              </Button>
              <Button
                variant="outline" size="sm"
                onClick={() => copyText(rollbackBody || '', 'Rollback')}
                disabled={!rollbackBody}
              >
                <Copy className="h-4 w-4 mr-1.5" /> Copy rollback
              </Button>
              <Button
                variant="ghost" size="sm"
                onClick={() => setDismissOpen(true)}
                disabled={status === 'DISMISSED'}
                className="ml-auto text-muted-foreground"
              >
                <X className="h-4 w-4 mr-1.5" /> Mark dismissed
              </Button>
              <Button
                variant="ghost" size="sm"
                onClick={() => setDeleteOpen(true)}
                className="text-red-500/80 hover:text-red-500"
              >
                <Trash2 className="h-4 w-4 mr-1.5" /> Delete
              </Button>
            </CardContent>
          </Card>

          {history.length > 0 && (
            <Card>
              <CardHeader><CardTitle className="text-base">History</CardTitle></CardHeader>
              <CardContent>
                <ol className="space-y-2 text-xs">
                  {history.map((h, i) => (
                    <li key={i} className="flex flex-col sm:flex-row sm:gap-3 border-l-2 border-border pl-3">
                      <span className="font-mono text-muted-foreground sm:w-44 shrink-0">{h.ts || '—'}</span>
                      <span className="font-mono text-muted-foreground sm:w-44 shrink-0">{h.actor || '—'}</span>
                      <span className="break-words">{h.change || ''}</span>
                    </li>
                  ))}
                </ol>
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0">
              <CardTitle className="text-base">Spec (YAML)</CardTitle>
              {!editing ? (
                <Button variant="outline" size="sm" onClick={onStartEdit}>
                  <Pencil className="h-4 w-4 mr-1.5" /> Edit
                </Button>
              ) : (
                <div className="flex items-center gap-2">
                  <Button variant="ghost" size="sm" onClick={() => setEditing(false)}>
                    Cancel
                  </Button>
                  <Button size="sm" onClick={onSaveEdit} disabled={saving || !draft.trim()}>
                    {saving ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <Save className="h-4 w-4 mr-1.5" />}
                    Save
                  </Button>
                </div>
              )}
            </CardHeader>
            <CardContent>
              {editing ? (
                <textarea
                  className="w-full text-xs font-mono bg-muted/30 rounded p-3 border min-h-[24rem]"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  spellCheck={false}
                />
              ) : (
                <pre className="text-xs font-mono whitespace-pre-wrap break-words bg-muted/30 rounded p-3 overflow-x-auto">
                  {yamlBody}
                </pre>
              )}
              {editing && (
                <p className="text-xs text-muted-foreground mt-2">
                  Embedded <code className="font-mono">cve:</code> field must remain{' '}
                  <code className="font-mono">{cveId}</code>. Server validates before writing.
                </p>
              )}
            </CardContent>
          </Card>
        </>
      )}

      <Dialog open={dismissOpen} onOpenChange={setDismissOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>Dismiss {cveId}</DialogTitle></DialogHeader>
          <div className="space-y-2 text-sm">
            <p className="text-muted-foreground">
              Status will be set to <code className="font-mono">DISMISSED</code> with this reason
              recorded in history.
            </p>
            <Input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Reason (required)"
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDismissOpen(false)}>Cancel</Button>
            <Button onClick={onDismiss} disabled={!reason.trim()}>Dismiss</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>Delete {cveId}?</DialogTitle></DialogHeader>
          <div className="text-sm text-muted-foreground">
            Removes the YAML file from the inbox entirely. Use{' '}
            <strong className="text-foreground">Mark dismissed</strong> instead if you want to
            keep the record. This cannot be undone.
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDeleteOpen(false)}>Cancel</Button>
            <Button variant="destructive" onClick={onDelete}>Delete</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function CveList({ onOpen, refreshKey }) {
  const { toast } = useToast();
  const [data, setData] = useState({ entries: [], host: '', unread: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [filterAction, setFilterAction] = useState('all');
  const [filterStatus, setFilterStatus] = useState('all');
  const [sortBy, setSortBy] = useState('tier');
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteContent, setPasteContent] = useState('');
  const [pasting, setPasting] = useState(false);
  const [polling, setPolling] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const result = await api.listCves();
      setData(result);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : (err?.message || 'failed to load'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh, refreshKey]);

  const onPaste = async () => {
    if (!pasteContent.trim()) return;
    setPasting(true);
    try {
      const out = await api.pasteCve(pasteContent);
      toast({ title: 'Saved', description: `${out.cve} added to inbox.` });
      setPasteOpen(false);
      setPasteContent('');
      await refresh();
    } catch (err) {
      toast({
        title: 'Save failed',
        description: err instanceof ApiError ? err.message : (err?.message || 'unknown error'),
        variant: 'destructive',
      });
    } finally {
      setPasting(false);
    }
  };

  const onPollNow = async () => {
    setPolling(true);
    try {
      const out = await api.pollCves();
      const ran = (out?.entries || []).filter(e => e.executed).length;
      toast({
        title: 'Poll done',
        description: ran > 0
          ? `Engine executed ${ran} AUTO_PATCH ${ran === 1 ? 'entry' : 'entries'}.`
          : 'Nothing to do — no AUTO_PATCH entries affected this host.',
      });
      await refresh();
    } catch (err) {
      toast({
        title: 'Poll failed',
        description: err instanceof ApiError ? err.message : (err?.message || 'unknown error'),
        variant: 'destructive',
      });
    } finally {
      setPolling(false);
    }
  };

  const visible = useMemo(() => {
    let rows = data.entries.slice();
    if (filterAction !== 'all') rows = rows.filter(r => r.action_class === filterAction);
    if (filterStatus !== 'all') rows = rows.filter(r => r.status === filterStatus);
    rows.sort((a, b) => {
      if (sortBy === 'tier') {
        const at = parseInt(a.tier, 10) || 99;
        const bt = parseInt(b.tier, 10) || 99;
        if (at !== bt) return at - bt;
        return (b.last_updated || '').localeCompare(a.last_updated || '');
      }
      if (sortBy === 'last_updated') {
        return (b.last_updated || '').localeCompare(a.last_updated || '');
      }
      return a.cve.localeCompare(b.cve);
    });
    return rows;
  }, [data.entries, filterAction, filterStatus, sortBy]);

  const FilterChip = ({ active, onClick, children }) => (
    <button
      type="button"
      onClick={onClick}
      className={`text-xs px-2 py-1 rounded border transition-colors ${
        active ? 'bg-primary text-primary-foreground border-primary'
               : 'bg-transparent text-muted-foreground border-border hover:bg-accent'
      }`}
    >{children}</button>
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 flex-wrap">
        <BugPlay className="h-5 w-5 text-orange-500" />
        <h1 className="text-lg font-semibold">CVEs</h1>
        <span className="text-xs text-muted-foreground ml-2">
          {data.host ? `host: ${data.host}` : null}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <span className="text-xs text-muted-foreground hidden sm:inline">
            {data.entries.length} total · {data.unread} unread
          </span>
          <Button variant="outline" size="sm" onClick={() => setPasteOpen(true)}>
            <Plus className="h-4 w-4 mr-1.5" /> Paste YAML
          </Button>
          <Button variant="outline" size="sm" onClick={onPollNow} disabled={polling}>
            {polling ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <Zap className="h-4 w-4 mr-1.5" />}
            Poll now
          </Button>
          <Button variant="ghost" size="icon" onClick={refresh} disabled={loading} title="Refresh list">
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          </Button>
        </div>
      </div>
      <p className="text-xs text-muted-foreground max-w-2xl">
        Each row is one entry from <code className="font-mono">/var/lib/proxypilot/cve-inbox/</code>.
        Claude writes specs into the inbox; the engine acts on AUTO_PATCH entries automatically and
        surfaces ONE_CLICK + ALERT here for operator review.
      </p>

      {error && (
        <div className="text-sm text-red-500 border border-red-500/30 bg-red-500/10 rounded px-3 py-2">
          {error}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 border rounded p-2">
        <span className="text-xs text-muted-foreground">Action:</span>
        {['all', 'AUTO_PATCH', 'ONE_CLICK', 'ALERT'].map(v => (
          <FilterChip key={v} active={filterAction === v} onClick={() => setFilterAction(v)}>
            {v}
          </FilterChip>
        ))}
        <span className="text-xs text-muted-foreground ml-3">Status:</span>
        {['all', 'NEW', 'QUEUED', 'IN-PROGRESS', 'RESOLVED', 'BLOCKED', 'DISMISSED', 'ALERT-AUTO-ROLLBACK'].map(v => (
          <FilterChip key={v} active={filterStatus === v} onClick={() => setFilterStatus(v)}>
            {v}
          </FilterChip>
        ))}
        <span className="text-xs text-muted-foreground ml-3">Sort:</span>
        {[['tier', 'tier'], ['last_updated', 'updated'], ['cve', 'CVE id']].map(([v, label]) => (
          <FilterChip key={v} active={sortBy === v} onClick={() => setSortBy(v)}>
            {label}
          </FilterChip>
        ))}
      </div>

      <div className="border rounded">
        <div className="grid grid-cols-12 gap-3 px-3 py-2 text-xs text-muted-foreground border-b bg-muted/20">
          <div className="col-span-12 sm:col-span-3">CVE</div>
          <div className="col-span-7 sm:col-span-4">Name</div>
          <div className="col-span-2 sm:col-span-1">Tier</div>
          <div className="col-span-3 sm:col-span-2">Action</div>
          <div className="col-span-12 sm:col-span-2 sm:text-right">Status</div>
        </div>
        {visible.length === 0 ? (
          <div className="text-sm text-muted-foreground text-center py-8">
            {loading ? 'Loading…' : 'No entries match the current filters.'}
          </div>
        ) : (
          visible.map(entry => (
            <CveListRow key={entry.cve} entry={entry} onOpen={onOpen} />
          ))
        )}
      </div>

      <Dialog open={pasteOpen} onOpenChange={setPasteOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader><DialogTitle>Paste CVE YAML</DialogTitle></DialogHeader>
          <div className="space-y-2 text-sm">
            <p className="text-muted-foreground">
              Filename is derived from the embedded <code className="font-mono">cve:</code>{' '}
              field. An entry with the same id is overwritten. The server validates the YAML
              before writing; nothing lands on disk if validation fails.
            </p>
            <textarea
              className="w-full text-xs font-mono bg-muted/30 rounded p-3 border min-h-[20rem]"
              value={pasteContent}
              onChange={(e) => setPasteContent(e.target.value)}
              placeholder={`cve: CVE-2026-12345\nname: "Short title"\nhosts:\n  ${data.host || '<hostname>'}: {action_class: ALERT, tier: 3}\nplaybook:\n  detect: {probe: "exit 0"}\n  patch: {steps: ["true"]}\nstate: {status: NEW, operator_seen: false}\n`}
              spellCheck={false}
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setPasteOpen(false)}>Cancel</Button>
            <Button onClick={onPaste} disabled={pasting || !pasteContent.trim()}>
              {pasting ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <Save className="h-4 w-4 mr-1.5" />}
              Save to inbox
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default function CVEs() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin'
    || JSON.parse(localStorage.getItem('user') || '{}').role === 'admin';
  const [openCve, setOpenCve] = useState(null);
  const [refreshKey, setRefreshKey] = useState(0);

  if (!isAdmin) return <Navigate to="/" replace />;

  if (openCve) {
    return (
      <CveDetail
        cveId={openCve}
        onBack={() => setOpenCve(null)}
        onChanged={() => setRefreshKey(k => k + 1)}
        onDeleted={() => { setOpenCve(null); setRefreshKey(k => k + 1); }}
      />
    );
  }
  return <CveList onOpen={setOpenCve} refreshKey={refreshKey} />;
}
