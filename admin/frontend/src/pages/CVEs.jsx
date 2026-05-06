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

import { Fragment, useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '@/context/AuthContext';
import { api, ApiError } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { useToast } from '@/hooks/use-toast';
import {
  ArrowLeft, BugPlay, Copy, FileCode, GitBranch, Loader2, Pencil, Plus,
  RefreshCw, Save, ShieldCheck, ShieldQuestion, Stethoscope, Trash2, X, Zap,
} from 'lucide-react';

// A real, working CVE inbox spec — round-trips through the engine's
// validate subcommand. Loaded into the Paste dialog when the operator
// clicks "Load example" so they have a known-good shape to start from.
// Mirrors docs/cve-engine/example-cve.yaml verbatim; if you edit one,
// edit the other.
const EXAMPLE_YAML = `cve: CVE-2024-3094
name: "xz-utils backdoor in liblzma (5.6.0 / 5.6.1)"
disclosed: "2024-03-29"
cvss: 10.0
impact: REMOTE_RCE_ROOT
blast_radius: HOST_FULL
sources:
  - https://nvd.nist.gov/vuln/detail/CVE-2024-3094
  - https://www.openwall.com/lists/oss-security/2024/03/29/4
  - https://security-tracker.debian.org/tracker/CVE-2024-3094
hosts:
  __HOSTNAME__:
    action_class: AUTO_PATCH
    tier: 1
playbook:
  detect:
    probe: |
      #!/bin/sh
      ver=$(dpkg-query -W -f='\${Version}' liblzma5 2>/dev/null || true)
      case "$ver" in
        5.6.0*|5.6.1-1|5.6.1-2)
          echo "AFFECTED: liblzma5 $ver"
          exit 0
          ;;
        "")
          echo "liblzma5 not installed; not affected"
          exit 1
          ;;
        *)
          echo "liblzma5 $ver — not in vulnerable range"
          exit 1
          ;;
      esac
  patch:
    steps:
      - "apt-get update"
      - "apt-get install -y --reinstall xz-utils liblzma5 liblzma-dev"
      - "systemctl try-restart sshd 2>/dev/null || true"
      - "systemctl try-restart systemd-logind 2>/dev/null || true"
    rollback:
      snapshot_supported: true
      restore: |
        #!/bin/sh
        prev=$(ls -1 /var/cache/apt/archives/liblzma5_*.deb 2>/dev/null | tail -n1)
        [ -n "$prev" ] && dpkg -i "$prev"
  mitigate:
    steps:
      - "# Restrict sshd to public-key auth only; xz exploit triggers"
      - "# during early sshd auth path."
      - "systemctl reload sshd"
state:
  status: NEW
  operator_seen: false
`;

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
// Pull a YAML list under a top-level key. Handles block form
//   sources:
//     - https://example.com/a
//     - https://example.com/b
// and flow form
//   sources: ["https://example.com/a", "https://example.com/b"]
function extractListItems(body, key) {
  if (!body) return [];
  // Flow form first.
  const flow = body.match(new RegExp(`(?:^|\\n)${key}:\\s*\\[([^\\]]*)\\]`));
  if (flow) {
    return flow[1]
      .split(',')
      .map(s => s.trim().replace(/^["']|["']$/g, ''))
      .filter(Boolean);
  }
  const lines = body.split('\n');
  const out = [];
  let inBlock = false;
  for (const line of lines) {
    if (!inBlock) {
      if (new RegExp(`^${key}:\\s*$`).test(line)) inBlock = true;
      continue;
    }
    if (/^\S/.test(line)) break;
    const dash = line.match(/^\s*-\s*(.+)$/);
    if (dash) {
      const v = dash[1].replace(/\s+#.*$/, '').replace(/^["']|["']$/g, '').trim();
      if (v) out.push(v);
    }
  }
  return out;
}

// Pull a single key from a nested top-level block (e.g. _proxypilot.origin).
// Block form only — engine writes block form, that's what we'll see here.
function extractNestedScalar(body, parent, child) {
  if (!body) return null;
  const lines = body.split('\n');
  let inBlock = false;
  for (const line of lines) {
    if (!inBlock) {
      if (new RegExp(`^${parent}:\\s*$`).test(line)) inBlock = true;
      continue;
    }
    if (/^\S/.test(line)) break;
    const m = line.match(new RegExp(`^\\s+${child}:\\s*([^\\n#]+)`));
    if (m) return m[1].replace(/^["']|["']$/g, '').trim();
  }
  return null;
}

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

function OriginPill({ origin, gitUrl }) {
  if (origin === 'git') {
    return (
      <span title={gitUrl || ''}
            className="inline-flex items-center gap-1 text-[10px] font-mono text-muted-foreground border border-border rounded px-1.5 py-0.5">
        <GitBranch className="h-3 w-3" /> git
      </span>
    );
  }
  if (origin === 'paste') {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] font-mono text-muted-foreground border border-border rounded px-1.5 py-0.5">
        paste
      </span>
    );
  }
  return null;
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
        <OriginPill origin={entry.origin} gitUrl={entry.origin_git_url} />
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

// Two-column key/value grid used by the About tab. Rows with falsy
// values are hidden so we don't render "Disclosed: —" noise.
function FactGrid({ items }) {
  const rows = items.filter(([, v]) => v !== null && v !== undefined && v !== '' && v !== false);
  if (rows.length === 0) return null;
  return (
    <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
      {rows.map(([k, v], i) => (
        <Fragment key={i}>
          <dt className="text-muted-foreground">{k}</dt>
          <dd className="break-words">{v}</dd>
        </Fragment>
      ))}
    </dl>
  );
}

// "What does this CVE entry actually do" — context-aware blurb under
// the metadata. The text changes by action_class so the operator
// reads the right mental model: AUTO_PATCH runs without you,
// ONE_CLICK waits for your click, ALERT is read-only.
function ExplainerBlock({ action, patchSteps, rollbackBody, hasMitigate }) {
  const lane = action === 'AUTO_PATCH' ? (
    <p>
      The engine runs this on the next 5-minute poll without operator
      input. It probes the host, snapshots first if a backend is
      available, runs the patch steps, re-runs the probe to verify,
      and rolls back if verify still says affected.
    </p>
  ) : action === 'ONE_CLICK' ? (
    <p>
      The engine waits for your <strong>Run on this host</strong>{' '}
      click. Same state machine as AUTO_PATCH (probe → snapshot →
      patch → verify → rollback), just operator-triggered. Use this
      lane for image swaps, service restarts, anything you want a
      human gate on.
    </p>
  ) : (
    <p>
      The engine never executes this entry. It surfaces the playbook
      so you can run the steps by hand. Use{' '}
      <strong>Copy patch</strong> to grab the commands and{' '}
      <strong>Mark dismissed</strong> with a reason once you've acted.
    </p>
  );
  return (
    <div className="rounded border border-border bg-muted/20 p-3 text-xs text-muted-foreground space-y-2">
      <div className="text-foreground/80 font-medium text-sm">What this entry does</div>
      {lane}
      <ul className="list-disc list-inside space-y-0.5">
        <li>{patchSteps.length} patch step{patchSteps.length === 1 ? '' : 's'} authored.</li>
        <li>Rollback step {rollbackBody ? 'present' : 'NOT present — the engine has no automatic recovery if a step fails'}.</li>
        {hasMitigate && <li>Mitigation block present (operator-only — engine never runs it).</li>}
      </ul>
    </div>
  );
}

// Pull the `affects:` block from the YAML body as a flat key→value
// dict. Block-form, two levels deep, no recursion — that's all the
// schema needs and all the dashboard wants to render.
function extractAffectsBlock(body) {
  if (!body) return null;
  const lines = body.split('\n');
  const out = {};
  let inBlock = false;
  let baseIndent = -1;
  for (const line of lines) {
    if (!inBlock) {
      if (/^affects:\s*$/.test(line)) inBlock = true;
      continue;
    }
    if (/^\S/.test(line)) break;
    const m = line.match(/^( +)(\w[\w_]*):\s*([^\n]*)$/);
    if (!m) continue;
    const indent = m[1].length;
    if (baseIndent === -1) baseIndent = indent;
    if (indent !== baseIndent) continue;
    const v = m[3].replace(/\s+#.*$/, '').replace(/^["']|["']$/g, '').trim();
    if (v) out[m[2]] = v;
  }
  return Object.keys(out).length ? out : null;
}

// "Am I affected?" — the question the operator wants answered first.
// Verdict comes from (in priority order):
//   1. lastCheck (operator just clicked Check applicability)
//   2. latest_note from state.history (engine's most recent event)
// Falls back to "unknown — no probe run yet" with a hint to click
// Check applicability.
function ApplicabilityBlock({ cveId, lastCheck, latestNote, added, lastUpdated,
                             operatorAction, affectsBlock }) {
  // Priority 1: just-clicked check.
  let verdict = null;     // "affected" | "not_affected" | "unknown"
  let detail = null;
  let source = null;
  let when = null;

  if (lastCheck?.verdict) {
    verdict = lastCheck.verdict === 'affected' ? 'affected'
            : lastCheck.verdict === 'not_affected' ? 'not_affected'
            : 'unknown';
    detail = `probe exit=${lastCheck.exit_code}` +
             (lastCheck.duration_s != null ? ` · ${lastCheck.duration_s.toFixed(2)}s` : '');
    source = 'just-checked';
    when = 'now';
  } else if (latestNote?.change) {
    const c = String(latestNote.change).toLowerCase();
    if (/host not affected|not_affected|exit=[1-9]/.test(c)) {
      verdict = 'not_affected';
    } else if (/affected|exit=0|verify probe still exits 0/.test(c)) {
      verdict = 'affected';
    } else if (/resolved|patch verified/.test(c)) {
      verdict = 'not_affected';
    }
    detail = latestNote.change;
    source = `${latestNote.actor || 'engine'}`;
    when = latestNote.ts;
  }

  const tone = verdict === 'not_affected'
    ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
    : verdict === 'affected'
    ? 'border-red-500/40 bg-red-500/10 text-red-300'
    : 'border-border bg-muted/30 text-muted-foreground';
  const Icon = verdict === 'not_affected' ? ShieldCheck
             : verdict === 'affected'     ? ShieldQuestion
             : ShieldQuestion;
  const label = verdict === 'not_affected' ? 'Host is NOT affected'
              : verdict === 'affected'     ? 'Host IS affected'
              : 'Unknown — run Check applicability for a current verdict';

  return (
    <div className={`rounded-lg border-2 px-4 py-3 ${tone}`}>
      <div className="flex items-center gap-2 mb-1">
        <Icon className="h-5 w-5" />
        <span className="font-semibold">{label}</span>
      </div>
      {detail && (
        <div className="text-xs space-y-0.5 mt-2 opacity-90">
          <div><span className="opacity-70">Last signal: </span><span className="font-mono break-words">{detail}</span></div>
          {(source || when) && (
            <div className="opacity-70">
              {source && <span>from <span className="font-mono">{source}</span></span>}
              {source && when && when !== 'now' ? ' · ' : ''}
              {when && when !== 'now' && <span className="font-mono">{when}</span>}
            </div>
          )}
        </div>
      )}
      {operatorAction && operatorAction !== 'none' && (
        <div className="text-xs mt-2 opacity-90">
          <span className="opacity-70">Operator action required: </span>
          <span className="font-mono">{operatorAction}</span>
        </div>
      )}
      {affectsBlock && (
        <div className="text-xs mt-3 pt-2 border-t border-current/20 opacity-90">
          <div className="opacity-70 mb-1">Affects (per spec)</div>
          <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-0.5">
            {Object.entries(affectsBlock).map(([k, v]) => (
              <Fragment key={k}>
                <dt className="opacity-70">{k.replace(/_/g, ' ')}</dt>
                <dd className="font-mono break-words">{v}</dd>
              </Fragment>
            ))}
          </dl>
        </div>
      )}
    </div>
  );
}

function CveDetail({ cveId, onBack, onChanged, onDeleted }) {
  const { toast } = useToast();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [running, setRunning] = useState(false);
  const [checking, setChecking] = useState(false);
  // Last probe-only result so the Applicability section can show it
  // immediately after the operator clicks Check, without waiting for
  // the next refresh round-trip. Cleared on cveId change.
  const [lastCheck, setLastCheck] = useState(null);
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

  // Capture the latest onChanged in a ref so the open-mark-as-seen
  // effect below can reach it without depending on its identity.
  // Without this, the parent re-renders on every refreshKey bump,
  // hands a fresh onChanged closure down, the effect re-runs because
  // its deps changed, calls onChanged again, and we're in a render
  // loop that pegs the page at "fresh load every half second".
  const onChangedRef = useRef(onChanged);
  useEffect(() => { onChangedRef.current = onChanged; }, [onChanged]);

  useEffect(() => {
    setLastCheck(null);  // discard stale check verdict from prior CVE
    refresh();
    // Mark as seen on open — fire-and-forget; failure doesn't block
    // the read view, the badge will retry on next poll.
    api.markCveSeen(cveId).then(() => onChangedRef.current?.()).catch(() => {});
  }, [cveId, refresh]);

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

  const onCheck = async () => {
    setChecking(true);
    try {
      const out = await api.checkCve(cveId);
      setLastCheck(out);
      const variantByVerdict = {
        affected: 'destructive',
        not_affected: undefined,
        no_probe: 'destructive',
      };
      const titleByVerdict = {
        affected: 'Host IS affected',
        not_affected: 'Host is NOT affected',
        no_probe: 'No probe in spec',
      };
      toast({
        title: titleByVerdict[out?.verdict] || 'Check finished',
        description: out?.verdict === 'no_probe'
          ? 'The spec is missing playbook.detect.probe.'
          : `probe exit=${out?.exit_code} · ${out?.duration_s?.toFixed?.(2) || '?'}s`,
        variant: variantByVerdict[out?.verdict],
      });
      await refresh();
    } catch (err) {
      toast({
        title: 'Check failed',
        description: err instanceof ApiError ? err.message : (err?.message || 'unknown error'),
        variant: 'destructive',
      });
    } finally {
      setChecking(false);
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

  // About-tab metadata pulled out of the YAML. Cheap; runs only when
  // the tab renders (memoized off yamlBody which only changes on
  // refresh / edit-save). Block-form extraction matches what the
  // engine writes via ruamel; flow form is supported for paste users.
  const meta = useMemo(() => ({
    name: yamlScalar(yamlBody, 'name'),
    disclosed: yamlScalar(yamlBody, 'disclosed'),
    cvss: yamlScalar(yamlBody, 'cvss'),
    impact: yamlScalar(yamlBody, 'impact'),
    blast_radius: yamlScalar(yamlBody, 'blast_radius'),
    sources: extractListItems(yamlBody, 'sources'),
    origin: extractNestedScalar(yamlBody, '_proxypilot', 'origin'),
    git_url: extractNestedScalar(yamlBody, '_proxypilot', 'git_url'),
    git_commit: extractNestedScalar(yamlBody, '_proxypilot', 'git_commit'),
    imported_at: extractNestedScalar(yamlBody, '_proxypilot', 'imported_at'),
  }), [yamlBody]);

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
          {/* Actions card stays above the tabs — they're always
              relevant regardless of which tab the operator is on. */}
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
              {/* Check applicability — read-only probe (no patch, no
                  snapshot, no status change). Available for ALL
                  action_classes including ALERT, since the answer
                  ("am I actually affected?") is useful regardless of
                  whether the engine can auto-patch the answer. */}
              <Button
                variant="outline" size="sm"
                onClick={onCheck}
                disabled={checking}
                title="Run only the detection probe — no patch, no snapshot, no state change."
              >
                {checking
                  ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
                  : <Stethoscope className="h-4 w-4 mr-1.5" />}
                Check applicability
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

          <Tabs defaultValue="about" className="w-full">
            <TabsList>
              <TabsTrigger value="about">About</TabsTrigger>
              <TabsTrigger value="history">
                History {history.length > 0 ? <span className="ml-1.5 text-[10px] opacity-70">({history.length})</span> : null}
              </TabsTrigger>
              <TabsTrigger value="spec">Spec (YAML)</TabsTrigger>
            </TabsList>

            <TabsContent value="about">
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">{meta.name || cveId}</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4 text-sm">
                  {/* Applicability — the "am I affected?" answer.
                      Reads from (in priority order):
                        1. lastCheck (just-clicked Check result)
                        2. data.latest_note (last engine timeline event)
                      Verdict colour + explainer adapt to each source. */}
                  <ApplicabilityBlock
                    cveId={cveId}
                    lastCheck={lastCheck}
                    latestNote={data?.latest_note}
                    added={data?.added}
                    lastUpdated={data?.last_updated}
                    operatorAction={data?.operator_action_required}
                    affectsBlock={extractAffectsBlock(yamlBody)}
                  />

                  <FactGrid items={[
                    ['CVE id',       <span className="font-mono">{cveId}</span>],
                    ['Disclosed',    meta.disclosed],
                    ['CVSS',         meta.cvss],
                    ['Impact',       meta.impact && <span className="font-mono">{meta.impact}</span>],
                    ['Blast radius', meta.blast_radius && <span className="font-mono">{meta.blast_radius}</span>],
                    ['Action class', <ActionPill action={action} />],
                    ['Status',       <StatusPill status={status} />],
                    ['Added',        data?.added && <span className="font-mono text-xs">{new Date(data.added).toLocaleString()}</span>],
                    ['Last updated', data?.last_updated && <span className="font-mono text-xs">{new Date(data.last_updated).toLocaleString()}</span>],
                  ]} />

                  <ExplainerBlock
                    action={action}
                    patchSteps={patchSteps}
                    rollbackBody={rollbackBody}
                    hasMitigate={/\n\s*mitigate:/.test(yamlBody)}
                  />

                  {meta.sources.length > 0 && (
                    <div>
                      <div className="text-xs font-medium text-muted-foreground mb-1">Sources</div>
                      <ul className="space-y-1 text-xs">
                        {meta.sources.map((s, i) => (
                          <li key={i}>
                            {/^https?:\/\//.test(s)
                              ? <a href={s} target="_blank" rel="noreferrer"
                                   className="font-mono text-blue-400 underline-offset-2 hover:underline break-all">{s}</a>
                              : <span className="font-mono break-all">{s}</span>}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {(meta.origin || meta.git_url) && (
                    <div>
                      <div className="text-xs font-medium text-muted-foreground mb-1">Provenance</div>
                      <FactGrid items={[
                        ['Origin',       meta.origin && <OriginPill origin={meta.origin} gitUrl={meta.git_url} />],
                        ['Git URL',      meta.git_url && <span className="font-mono text-xs break-all">{meta.git_url}</span>],
                        ['Git commit',   meta.git_commit && <span className="font-mono text-xs">{String(meta.git_commit).slice(0, 12)}</span>],
                        ['Imported',     meta.imported_at && <span className="font-mono text-xs">{meta.imported_at}</span>],
                      ]} />
                    </div>
                  )}
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="history">
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">History &amp; audit log</CardTitle>
                </CardHeader>
                <CardContent>
                  {history.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      No history yet. The engine appends an entry every time it runs the
                      probe, takes a snapshot, fires a patch step, or rolls back; the
                      operator's mark-dismissed / save-edit / delete actions show up here too.
                    </p>
                  ) : (
                    <ol className="space-y-2 text-xs">
                      {history.map((h, i) => (
                        <li key={i} className="flex flex-col sm:flex-row sm:gap-3 border-l-2 border-border pl-3">
                          <span className="font-mono text-muted-foreground sm:w-44 shrink-0">{h.ts || '—'}</span>
                          <span className="font-mono text-muted-foreground sm:w-44 shrink-0">{h.actor || '—'}</span>
                          <span className="break-words">{h.change || ''}</span>
                        </li>
                      ))}
                    </ol>
                  )}
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="spec">
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
            </TabsContent>
          </Tabs>
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
  const [gitConfigOpen, setGitConfigOpen] = useState(false);
  const [gitUrl, setGitUrl] = useState('');
  const [gitDraft, setGitDraft] = useState('');
  const [gitSaving, setGitSaving] = useState(false);
  const [gitSyncing, setGitSyncing] = useState(false);
  // The most recent sync result so the source caption can show the
  // parsed branch + subpath alongside the URL.
  const [lastSync, setLastSync] = useState(null);

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

  // Pull the saved git source URL once on mount; cheap settings read.
  useEffect(() => {
    api.getCveGitConfig()
      .then(c => setGitUrl(c.url || ''))
      .catch(() => {});
  }, []);

  const onSaveGitConfig = async () => {
    setGitSaving(true);
    try {
      await api.setCveGitConfig(gitDraft);
      setGitUrl(gitDraft);
      toast({ title: 'Git source saved',
              description: gitDraft ? 'Click Sync now to pull.' : 'Cleared.' });
      setGitConfigOpen(false);
    } catch (err) {
      toast({
        title: 'Save failed',
        description: err instanceof ApiError ? err.message : (err?.message || 'unknown error'),
        variant: 'destructive',
      });
    } finally {
      setGitSaving(false);
    }
  };

  const onSyncGit = async () => {
    if (!gitUrl) {
      setGitDraft('');
      setGitConfigOpen(true);
      return;
    }
    setGitSyncing(true);
    try {
      const out = await api.syncCveGit();
      const imported = (out?.imported || []).length;
      const skipped = out?.skipped_existing_count || 0;
      const errors = (out?.errors || []).length;
      const branchPart = out?.branch ? ` · branch ${out.branch}` : '';
      const subPart = out?.subpath ? ` · ${out.subpath}/` : '';
      const commitPart = out?.git_commit ? ` · ${out.git_commit.slice(0, 7)}` : '';
      const errorTail = errors && (out?.errors || []).length
        ? '\n' + (out.errors || []).slice(0, 3).join('\n') : '';
      toast({
        title: errors ? `Synced with ${errors} error(s)` : 'Synced',
        description: `Imported ${imported}, kept ${skipped} existing${branchPart}${subPart}${commitPart}${errorTail}`,
        variant: errors ? 'destructive' : undefined,
      });
      // Cache the parsed branch/subpath so the source caption can
      // show what the engine actually walked, not just the URL.
      setLastSync(out || null);
      await refresh();
    } catch (err) {
      toast({
        title: 'Sync failed',
        description: err instanceof ApiError ? err.message : (err?.message || 'unknown error'),
        variant: 'destructive',
      });
    } finally {
      setGitSyncing(false);
    }
  };

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
          <Button variant="outline" size="sm"
                  onClick={onSyncGit} disabled={gitSyncing}
                  title={gitUrl ? `Pull from ${gitUrl}` : 'Click to configure a git source'}>
            {gitSyncing ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <GitBranch className="h-4 w-4 mr-1.5" />}
            {gitUrl ? 'Sync git' : 'Add git source'}
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

      {gitUrl && (
        <div className="text-xs text-muted-foreground space-y-1">
          <div className="flex items-center gap-2 flex-wrap">
            <GitBranch className="h-3.5 w-3.5" />
            <span>Source:</span>
            <button
              type="button"
              onClick={() => { setGitDraft(gitUrl); setGitConfigOpen(true); }}
              className="font-mono break-all underline-offset-2 hover:underline hover:text-foreground"
              title="Click to change or clear"
            >
              {gitUrl}
            </button>
          </div>
          {(lastSync?.branch || lastSync?.subpath || lastSync?.git_commit) && (
            <div className="flex items-center gap-3 flex-wrap pl-5 text-[11px] font-mono opacity-80">
              {lastSync?.branch && <span>branch: <span className="text-foreground/80">{lastSync.branch}</span></span>}
              {lastSync?.subpath && <span>path: <span className="text-foreground/80">{lastSync.subpath}/</span></span>}
              {lastSync?.git_commit && <span>commit: <span className="text-foreground/80">{lastSync.git_commit.slice(0, 7)}</span></span>}
            </div>
          )}
          <div className="pl-5 text-[10px] opacity-70">
            read-only · sync is additive · changing URL never deletes existing entries
          </div>
        </div>
      )}

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
            <div className="flex items-center gap-2 text-xs">
              <button
                type="button"
                onClick={() => setPasteContent(
                  EXAMPLE_YAML.replace(/__HOSTNAME__/g, data.host || 'vm'))}
                className="inline-flex items-center gap-1 underline-offset-2 hover:underline text-muted-foreground hover:text-foreground"
              >
                <FileCode className="h-3.5 w-3.5" /> Load example (CVE-2024-3094 — xz-utils backdoor)
              </button>
              <span className="text-muted-foreground/60">·</span>
              <a
                href="https://github.com/cybertecharmor/proxypilot/blob/main/docs/cve-engine/claude-prompt.md"
                target="_blank" rel="noreferrer"
                className="underline-offset-2 hover:underline text-muted-foreground hover:text-foreground"
              >
                Claude prompt
              </a>
            </div>
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

      <Dialog open={gitConfigOpen} onOpenChange={setGitConfigOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader><DialogTitle>Git source for CVE specs</DialogTitle></DialogHeader>
          <div className="space-y-3 text-sm">
            <p className="text-muted-foreground">
              Read-only pull. The engine clones / pulls into a staging dir on the host and
              copies any new <code className="font-mono">CVE-*.yaml</code> files into the
              inbox. Existing entries — including those from a previous URL or from paste —
              are never overwritten or deleted. Each git-imported entry is stamped with its
              source URL and commit SHA.
            </p>
            <Input
              value={gitDraft}
              onChange={(e) => setGitDraft(e.target.value)}
              placeholder="https://github.com/your-org/cve-specs.git"
              autoFocus
            />
            <div className="text-xs text-muted-foreground space-y-2 border-l-2 border-border pl-3">
              <p className="font-medium text-foreground/80">Accepted URL shapes</p>
              <ul className="space-y-2 list-disc list-inside">
                <li>
                  <span className="font-medium">Plain git URL</span> — clones the default
                  branch, walks the whole repo for <code className="font-mono">CVE-*.yaml</code>.
                  <div className="mt-1 ml-5 font-mono text-[11px] text-foreground/80 break-all">
                    https://github.com/owner/repo.git
                  </div>
                </li>
                <li>
                  <span className="font-medium">Fragment syntax</span> — explicit branch
                  (and optional sub-directory). Works on any git host.
                  <div className="mt-1 ml-5 font-mono text-[11px] text-foreground/80 break-all">
                    https://github.com/owner/repo.git<span className="text-amber-400">#branch</span>
                    <br />
                    https://github.com/owner/repo.git<span className="text-amber-400">#branch:path/to/cves</span>
                  </div>
                </li>
                <li>
                  <span className="font-medium">GitHub /tree/ URL</span> — the address bar
                  URL when you're browsing a branch on GitHub. The engine parses the branch
                  + path automatically (resolves slash-containing branches like{' '}
                  <code className="font-mono">claude/great-mendel-zXSGE</code> via
                  ls-remote).
                  <div className="mt-1 ml-5 font-mono text-[11px] text-foreground/80 break-all">
                    https://github.com/owner/repo/tree/branch/path/to/cves
                  </div>
                </li>
              </ul>
            </div>
            <p className="text-xs text-muted-foreground">
              Leave empty to disable. Changes apply on next "Sync git". Both paste and git
              sources can coexist.
            </p>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setGitConfigOpen(false)}>Cancel</Button>
            <Button onClick={onSaveGitConfig} disabled={gitSaving}>
              {gitSaving ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <Save className="h-4 w-4 mr-1.5" />}
              Save URL
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
