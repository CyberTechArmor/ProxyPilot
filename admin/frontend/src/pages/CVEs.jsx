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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { useToast } from '@/hooks/use-toast';
import {
  ArrowLeft, Bot, BugPlay, ChevronDown, ChevronRight, Copy, FileCode, Loader2,
  Pencil, Pin, PinOff, Play, Plus, RefreshCw, Save, ShieldAlert, ShieldCheck,
  ShieldQuestion, Star, Stethoscope, Trash2, X,
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

// Model dropdown presets — Anthropic only, mirroring ModelConnectors.jsx's
// own MODEL_OPTIONS precedent (that page leaves every other provider as
// free text too, since OpenAI/Gemini/Ollama model ids vary too much to
// pin a reliable short list). "Custom…" drops to a free-text input so an
// operator can still type any id — including a newer Anthropic model this
// list hasn't been updated for yet.
const ANTHROPIC_MODEL_PRESETS = [
  { id: 'claude-opus-4-8', label: 'Claude Opus 4.8 — highest quality' },
  { id: 'claude-sonnet-5', label: 'Claude Sonnet 5 — balanced (recommended)' },
  { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5 — fast & cheap' },
];
const MODEL_CUSTOM = '__custom__';

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

// Provenance badge: `ai` = filed by the built-in research routine,
// `paste` = an operator pasted/edited it by hand ("manual"). Legacy
// `git` entries (from the retired git feed, pending purge) render as
// plain text so old inboxes still display sanely.
function OriginPill({ origin }) {
  if (origin === 'ai') {
    return (
      <span title="Filed by the AI research routine"
            className="inline-flex items-center gap-1 text-[10px] font-mono text-muted-foreground border border-border rounded px-1.5 py-0.5">
        <Bot className="h-3 w-3" /> ai
      </span>
    );
  }
  if (origin === 'paste') {
    return (
      <span title="Pasted or edited by an operator"
            className="inline-flex items-center gap-1 text-[10px] font-mono text-muted-foreground border border-border rounded px-1.5 py-0.5">
        manual
      </span>
    );
  }
  if (origin === 'git') {
    return (
      <span title="Imported by the retired git feed"
            className="inline-flex items-center gap-1 text-[10px] font-mono text-muted-foreground border border-border rounded px-1.5 py-0.5">
        git
      </span>
    );
  }
  return null;
}

// Compact "x time ago" formatter for the Added / Updated columns.
// We don't pull a date library for one helper.
function relTime(iso) {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '';
  const diffSec = (Date.now() - t) / 1000;
  if (diffSec < 60) return 'just now';
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  if (diffSec < 86400 * 30) return `${Math.floor(diffSec / 86400)}d ago`;
  if (diffSec < 86400 * 365) return `${Math.floor(diffSec / 86400 / 30)}mo ago`;
  return `${Math.floor(diffSec / 86400 / 365)}y ago`;
}

// Visual encoding for the four verdicts the engine produces. The
// Applicability block on the detail page and the row badge both
// read this so they agree on colour + icon.
const VERDICT_VISUAL = {
  affected:     { Icon: ShieldAlert,    cls: 'text-red-500',     label: 'Host IS affected' },
  not_affected: { Icon: ShieldCheck,    cls: 'text-emerald-500', label: 'Host is NOT affected' },
  probe_error:  { Icon: ShieldQuestion, cls: 'text-amber-500',   label: 'Probe error — verdict not conclusive' },
  no_probe:     { Icon: ShieldQuestion, cls: 'text-amber-500',   label: 'No probe in spec' },
  unknown:      { Icon: ShieldQuestion, cls: 'text-muted-foreground/60', label: 'Unknown — run Check applicability' },
};

// Compact shield icon used on each list row so the operator sees
// affected/not at a glance without opening the detail page. Tooltip
// shows the verdict label + when it was last checked.
function VerdictShield({ verdict, ts, size = 'sm' }) {
  const v = (verdict && VERDICT_VISUAL[verdict]) || VERDICT_VISUAL.unknown;
  const Icon = v.Icon;
  const dim = size === 'sm' ? 'h-4 w-4' : 'h-5 w-5';
  const title = ts
    ? `${v.label} · checked ${new Date(ts).toLocaleString()}`
    : v.label;
  return (
    <span className={`shrink-0 ${v.cls}`} title={title} aria-label={v.label}>
      <Icon className={dim} />
    </span>
  );
}

// Star toggle. Stops row click propagation so clicking the star
// pins/unpins without also navigating into the detail view.
function PinButton({ pinned, onToggle, size = 'sm', stopPropagation = false, className = '' }) {
  const cls = pinned ? 'text-amber-400' : 'text-muted-foreground/50 hover:text-amber-400';
  const dim = size === 'sm' ? 'h-4 w-4' : 'h-5 w-5';
  return (
    <button
      type="button"
      onClick={(e) => {
        if (stopPropagation) e.stopPropagation();
        onToggle();
      }}
      aria-label={pinned ? 'Unpin' : 'Pin'}
      title={pinned ? 'Unpin (click to remove)' : 'Pin to come back to this'}
      className={`shrink-0 transition-colors ${cls} ${className}`}
    >
      <Star className={dim} fill={pinned ? 'currentColor' : 'none'} strokeWidth={pinned ? 0 : 1.75} />
    </button>
  );
}

// Names follow `<package> — <description>` (em-dash). Bold the
// `<package>` part so the operator can scan by component
// (systemd / curl / Redis / …) at a glance.
function FormattedName({ name }) {
  if (!name) return <span>—</span>;
  const sep = name.indexOf(' — ');
  if (sep < 0) return <span className="truncate">{name}</span>;
  return (
    <span className="truncate">
      <span className="font-semibold text-foreground">{name.slice(0, sep)}</span>
      <span className="text-muted-foreground"> — {name.slice(sep + 3)}</span>
    </span>
  );
}

// Width of the per-row quick-action cluster (3 × 36px buttons + gaps +
// padding). The table header renders a spacer of the same width so the
// data columns stay aligned with their labels.
const ROW_ACTIONS_W = 'w-[8.5rem]';

// Compact per-row icon button. h-9 w-9 (36px) is the MOBILE_FIRST
// "dense-list secondary action" size. Stops propagation so a tap acts
// without also opening the row's detail view.
function RowActionButton({ title, onClick, disabled, busy, danger = false, Icon }) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      disabled={disabled || busy}
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      className={`h-9 w-9 inline-flex items-center justify-center rounded border border-transparent transition-colors
        ${danger ? 'text-muted-foreground hover:text-red-500 hover:border-red-500/40'
                 : 'text-muted-foreground hover:text-foreground hover:border-border'}
        hover:bg-accent disabled:opacity-40 disabled:pointer-events-none`}
    >
      {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Icon className="h-4 w-4" />}
    </button>
  );
}

function CveListRow({ entry, onOpen, onTogglePin, onQuickCheck, onQuickRun, onQuickDismiss, busy }) {
  // Layout: a keyboard-accessible clickable area (12-col grid, aligned
  // to the column header) + a trailing quick-action cluster. The outer
  // element is a div (not a button) so the nested pin/action buttons
  // are valid HTML.
  //   3   CVE
  //   3   Name
  //   1   Tier
  //   1   Action
  //   2   Status
  //   1   Added
  //   1   Updated
  const runnable = entry.action_class !== 'ALERT' && entry.status !== 'DISMISSED';
  return (
    <div className="flex items-center border-b border-border/50 hover:bg-accent/40">
      <div
        role="button"
        tabIndex={0}
        onClick={() => onOpen(entry.cve)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(entry.cve); }
        }}
        className="flex-1 min-w-0 cursor-pointer text-left grid grid-cols-12 gap-3 items-center px-3 py-2 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/50"
      >
        <div className="col-span-12 sm:col-span-3 font-mono text-sm flex items-center gap-2">
          <PinButton
            pinned={!!entry.pin}
            stopPropagation
            onToggle={() => onTogglePin?.(entry)}
          />
          <VerdictShield
            verdict={entry.latest_verdict?.verdict}
            ts={entry.latest_verdict?.ts}
          />
          {!entry.operator_seen && (
            <span className="h-2 w-2 rounded-full bg-orange-500 shrink-0" aria-label="unread" />
          )}
          <span className="truncate">{entry.cve}</span>
          <OriginPill origin={entry.origin} />
        </div>
        <div className="col-span-12 sm:col-span-3 text-sm truncate">
          <FormattedName name={entry.name} />
        </div>
        <div className="col-span-2 sm:col-span-1 text-xs">
          {entry.tier ? `T${entry.tier}` : ''}
        </div>
        <div className="col-span-3 sm:col-span-1"><ActionPill action={entry.action_class} /></div>
        <div className="col-span-3 sm:col-span-2"><StatusPill status={entry.status} /></div>
        <div className="col-span-2 sm:col-span-1 text-xs text-muted-foreground"
             title={entry.added ? new Date(entry.added).toLocaleString() : ''}>
          {relTime(entry.added)}
        </div>
        <div className="col-span-2 sm:col-span-1 text-xs text-muted-foreground"
             title={entry.last_updated ? new Date(entry.last_updated).toLocaleString() : ''}>
          {relTime(entry.last_updated)}
        </div>
      </div>
      {/* Quick actions — the reflex moves an operator makes from the
          list without opening the detail view. Check is read-only;
          Run and Dismiss go through the same confirm/reason dialogs
          the detail view uses. */}
      <div className={`${ROW_ACTIONS_W} shrink-0 flex items-center justify-end gap-1 px-2`}>
        <RowActionButton
          title="Check applicability (probe only — no changes)"
          Icon={Stethoscope}
          busy={busy === 'check'}
          disabled={!!busy}
          onClick={() => onQuickCheck?.(entry)}
        />
        <RowActionButton
          title={entry.action_class === 'ALERT'
            ? 'ALERT entries are read-only — open the row for the playbook'
            : entry.status === 'DISMISSED'
              ? 'Entry is dismissed'
              : 'Run on this host'}
          Icon={Play}
          busy={busy === 'run'}
          disabled={!!busy || !runnable}
          onClick={() => onQuickRun?.(entry)}
        />
        <RowActionButton
          title={entry.status === 'DISMISSED' ? 'Already dismissed' : 'Dismiss with a reason'}
          Icon={X}
          danger
          disabled={!!busy || entry.status === 'DISMISSED'}
          onClick={() => onQuickDismiss?.(entry)}
        />
      </div>
    </div>
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
// Visible, copyable code block for a shell script (patch steps,
// rollback command, …). The operator running these by hand — e.g.
// from a terminal outside the dashboard — needs to see exactly what
// they're about to paste before copying it, not just trigger a blind
// clipboard write from a toolbar button.
function CodeBlock({ code, onCopy, emptyMessage }) {
  if (!code) {
    return <p className="text-xs text-muted-foreground">{emptyMessage}</p>;
  }
  return (
    <div className="relative rounded border border-border bg-black/20">
      <button
        type="button"
        onClick={onCopy}
        title="Copy to clipboard"
        aria-label="Copy code"
        className="absolute top-2 right-2 h-8 w-8 inline-flex items-center justify-center rounded border border-border/60 bg-background/80 text-muted-foreground hover:text-foreground hover:bg-background"
      >
        <Copy className="h-3.5 w-3.5" />
      </button>
      <pre className="text-xs font-mono whitespace-pre-wrap break-words p-3 pr-12 overflow-x-auto">
        {code}
      </pre>
    </div>
  );
}

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
function ApplicabilityBlock({ cveId, lastCheck, latestVerdict, operatorAction,
                              affectsBlock }) {
  // Verdict source priority:
  //   1. Just-clicked check (lastCheck) — freshest, includes stdout
  //   2. Backend's latest_verdict — derived from the most recent
  //      history entry that had a structured verdict field
  // No text-matching on history change strings — that was the bug
  // behind "verdict disappears on revisit" (#9).
  const verdict = lastCheck?.verdict || latestVerdict?.verdict || 'unknown';
  const exitCode = lastCheck?.exit_code ?? latestVerdict?.exit_code ?? null;
  const when = lastCheck ? 'now' : latestVerdict?.ts || null;
  const source = lastCheck ? 'just-checked'
              : latestVerdict?.actor || null;
  const probeStdout = lastCheck?.stdout || '';
  const probeStderr = lastCheck?.stderr || '';

  const v = VERDICT_VISUAL[verdict] || VERDICT_VISUAL.unknown;
  const Icon = v.Icon;
  const tone = verdict === 'not_affected'
    ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
    : verdict === 'affected'
    ? 'border-red-500/40 bg-red-500/10 text-red-300'
    : verdict === 'probe_error'
    ? 'border-amber-500/40 bg-amber-500/10 text-amber-300'
    : 'border-border bg-muted/30 text-muted-foreground';

  return (
    <div className={`rounded-lg border-2 px-4 py-3 ${tone}`}>
      <div className="flex items-center gap-2 mb-1">
        <Icon className="h-5 w-5" />
        <span className="font-semibold">{v.label}</span>
      </div>

      {/* Detail line + (source, when). Always render exit code when
          we have one — operators want to know the probe actually ran. */}
      {(exitCode != null || when || source) && (
        <div className="text-xs space-y-0.5 mt-2 opacity-90">
          {exitCode != null && (
            <div>
              <span className="opacity-70">Probe: </span>
              <span className="font-mono">exit={exitCode}</span>
              {lastCheck?.duration_s != null && (
                <span className="font-mono"> · {lastCheck.duration_s.toFixed(2)}s</span>
              )}
            </div>
          )}
          {(source || when) && (
            <div className="opacity-70">
              {source && <span>from <span className="font-mono">{source}</span></span>}
              {source && when && when !== 'now' ? ' · ' : ''}
              {when && when !== 'now' && <span className="font-mono">{when}</span>}
            </div>
          )}
        </div>
      )}

      {/* Probe output — only available when we just clicked Check
          (the engine's run-output isn't persisted in the YAML).
          Captures Claude's `echo "AFFECTED: liblzma5 5.6.1"` so the
          operator sees the probe's reasoning, not just the exit
          code. */}
      {(probeStdout || probeStderr) && (
        <details className="text-xs mt-2 opacity-90">
          <summary className="cursor-pointer opacity-70 hover:opacity-100 select-none">
            Probe output
          </summary>
          {probeStdout && (
            <pre className="font-mono text-[11px] mt-1 p-2 bg-black/20 rounded whitespace-pre-wrap break-words">
              {probeStdout}
            </pre>
          )}
          {probeStderr && (
            <pre className="font-mono text-[11px] mt-1 p-2 bg-black/20 rounded whitespace-pre-wrap break-words">
              <span className="opacity-60">--stderr--</span>{'\n'}{probeStderr}
            </pre>
          )}
        </details>
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

  const onTogglePin = async () => {
    const wasPinned = !!data?.pin;
    // Optimistic update.
    setData(d => d ? { ...d, pin: wasPinned ? null : { note: null } } : d);
    try {
      if (wasPinned) await api.unpinCve(cveId);
      else await api.pinCve(cveId);
      onChangedRef.current?.();
    } catch (err) {
      setData(d => d ? { ...d, pin: wasPinned ? data.pin : null } : d);
      toast({
        title: 'Pin failed',
        description: err instanceof ApiError ? err.message : (err?.message || 'unknown error'),
        variant: 'destructive',
      });
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
    imported_at: extractNestedScalar(yamlBody, '_proxypilot', 'imported_at'),
  }), [yamlBody]);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeft className="h-4 w-4 mr-1" /> Back
        </Button>
        <PinButton
          pinned={!!data?.pin}
          size="md"
          onToggle={onTogglePin}
          className="ml-1"
        />
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
                    latestVerdict={data?.latest_verdict}
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

                  {/* Visible patch script — same commands "Run on this host" would
                      execute, plus any restart steps the entry authored (e.g.
                      `systemctl restart docker`). For operators who'd rather run
                      it by hand from a terminal than trigger it through the
                      engine. */}
                  <div>
                    <div className="text-xs font-medium text-muted-foreground mb-1">
                      Patch script {patchSteps.length > 0 ? `(${patchSteps.length} step${patchSteps.length === 1 ? '' : 's'})` : ''}
                    </div>
                    <CodeBlock
                      code={patchSteps.join('\n')}
                      onCopy={() => copyText(patchSteps.join('\n'), 'Patch')}
                      emptyMessage="No patch steps authored — this entry is ALERT-only."
                    />
                  </div>

                  {rollbackBody && (
                    <div>
                      <div className="text-xs font-medium text-muted-foreground mb-1">Rollback</div>
                      <CodeBlock
                        code={rollbackBody}
                        onCopy={() => copyText(rollbackBody, 'Rollback')}
                      />
                    </div>
                  )}

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

                  {meta.origin && (
                    <div>
                      <div className="text-xs font-medium text-muted-foreground mb-1">Provenance</div>
                      <FactGrid items={[
                        ['Origin',   <OriginPill origin={meta.origin} />],
                        ['Imported', meta.imported_at && <span className="font-mono text-xs">{meta.imported_at}</span>],
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

// One AI-research run report. Header line carries the at-a-glance
// facts; the model's own run summary renders underneath in full.
function ResearchRunReport({ run }) {
  return (
    <div className="rounded border border-border/60 bg-muted/10 p-2.5 text-xs space-y-1.5">
      <div className="flex items-center gap-x-3 gap-y-1 flex-wrap">
        <span className={`inline-flex items-center font-medium border px-1.5 py-0.5 rounded ${
          run.ok
            ? 'bg-emerald-500/10 text-emerald-500 border-emerald-500/30'
            : 'bg-red-500/10 text-red-500 border-red-500/30'
        }`}>
          {run.ok ? 'ok' : 'failed'}
        </span>
        <span className="font-mono text-muted-foreground" title={run.at}>
          {run.at ? new Date(run.at).toLocaleString() : '—'}
        </span>
        <span className="text-muted-foreground">{run.trigger === 'scheduled' ? 'scheduled' : 'manual'}</span>
        <span className="text-foreground/90">
          {run.created ?? 0} created · {run.updated ?? 0} updated
        </span>
        <span className="text-muted-foreground/80 font-mono">
          {run.turns != null ? `${run.turns} turn${run.turns === 1 ? '' : 's'} · ` : ''}
          {run.fetches ?? 0} fetch(es) · ~{run.tokens ?? 0} tokens
          {run.duration_s != null ? ` · ${run.duration_s}s` : ''}
        </span>
      </div>
      {run.error && (
        <div className="text-red-400 break-words">{run.error}</div>
      )}
      {run.summary && (
        <div className="whitespace-pre-wrap break-words text-muted-foreground">
          {run.summary}
        </div>
      )}
    </div>
  );
}

// Pagination threshold — below this we show all rows and skip the
// pagination controls entirely. 100 keeps single-host installs
// uncluttered while taming fleets where the inbox grows.
const PAGINATE_AT = 100;
const DEFAULT_PAGE_SIZE = 25;

function CveList({ onOpen, refreshKey }) {
  const { toast } = useToast();
  const [data, setData] = useState({ entries: [], host: '', unread: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  // Top-level tab. Routes entries by combined criteria (verdict +
  // status):
  //   active        — needs attention. verdict ∈ {affected, unknown,
  //                   probe_error}, status NOT in {DISMISSED, RESOLVED}
  //   not_affected  — verdict says not_affected (regardless of status)
  //   dismissed     — status = DISMISSED
  // Per-column filters and search apply WITHIN the chosen tab.
  const [tab, setTab] = useState('active');
  // Per-column filter state. Tier is sort-only (operator request);
  // Action + Status get dropdown filters.
  const [filterAction, setFilterAction] = useState('all');
  const [filterStatus, setFilterStatus] = useState('all');
  // Pinned-only toggle. When on, only entries the current operator
  // has starred render. Pinned entries always sort to the top
  // regardless — this filter is the inverse: hide everything else.
  const [pinnedOnly, setPinnedOnly] = useState(false);
  // Sort by clicking the column header. `dir` toggles asc/desc on
  // re-click of the same column. Default: tier asc (most-critical first).
  const [sort, setSort] = useState({ key: 'tier', dir: 'asc' });
  // Free-text search across CVE id + name + sources (sources match
  // is best-effort against the listing's `name` since the listing
  // doesn't ship sources to keep payload small — sources are matched
  // when the operator types something like "openssl" by checking
  // the CVE id and name).
  const [search, setSearch] = useState('');
  // Pagination — only kicks in above PAGINATE_AT entries.
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [page, setPage] = useState(1);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteContent, setPasteContent] = useState('');
  const [pasting, setPasting] = useState(false);
  // Per-row quick-action state. rowBusy maps cve → 'check' | 'run'
  // while that row's action is in flight; runTarget / dismissTarget
  // hold the entry a confirm dialog is open for (null = closed).
  const [rowBusy, setRowBusy] = useState({});
  const [runTarget, setRunTarget] = useState(null);
  const [dismissTarget, setDismissTarget] = useState(null);
  const [dismissReason, setDismissReason] = useState('');

  // AI research routine — native replacement for a manual external
  // research session. `research` is the last-fetched settings snapshot
  // (never carries the plaintext key, only has_api_key); `draft` is the
  // dialog's editable copy. api_key stays blank in the draft unless the
  // operator types a new one — saving with it blank keeps whatever key
  // is already stored server-side.
  //
  // `draft.connectorSource` is either 'new' (provider/base_url/api_key
  // fields drive the save) or an existing mock2 connector's id as a
  // string (the save instead sends import_connector_id and the backend
  // resolves provider/base_url/key server-side from that connector's
  // own stored key — never round-tripped through the browser).
  const [researchOpen, setResearchOpen] = useState(false);
  const [research, setResearch] = useState(null);
  const [researchDraft, setResearchDraft] = useState(null);
  const [researchConnectors, setResearchConnectors] = useState({ mock2_enabled: false, connectors: [] });
  const [researchSaving, setResearchSaving] = useState(false);
  const [researchTesting, setResearchTesting] = useState(false);
  const [researchRunning, setResearchRunning] = useState(false);
  // Run reports shown on the page itself (the dialog only holds
  // settings). newest-first; reportsOpen expands the history list.
  const [researchRuns, setResearchRuns] = useState([]);
  const [reportsOpen, setReportsOpen] = useState(false);

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

  // Research config + run reports load once on mount: the config
  // drives the toolbar Run button's enabled state, the reports feed
  // the panel above the table. Both refresh after a run completes.
  const refreshResearchMeta = useCallback(async () => {
    try {
      const [cfg, runs] = await Promise.all([
        api.getCveResearchConfig(),
        api.getCveResearchRuns(),
      ]);
      setResearch(cfg);
      setResearchRuns(runs?.runs || []);
    } catch { /* panel just stays empty */ }
  }, []);

  useEffect(() => { refreshResearchMeta(); }, [refreshResearchMeta]);

  const setBusyFor = (cve, action) => setRowBusy(m => {
    const next = { ...m };
    if (action) next[cve] = action;
    else delete next[cve];
    return next;
  });

  // Quick Check — read-only probe straight from the list. Same
  // endpoint the detail view's "Check applicability" uses; the row's
  // verdict shield updates on the refresh that follows.
  const onQuickCheck = async (entry) => {
    setBusyFor(entry.cve, 'check');
    try {
      const out = await api.checkCve(entry.cve);
      const titleByVerdict = {
        affected: `${entry.cve}: host IS affected`,
        not_affected: `${entry.cve}: host is NOT affected`,
        no_probe: `${entry.cve}: no probe in spec`,
      };
      toast({
        title: titleByVerdict[out?.verdict] || `${entry.cve}: check finished`,
        description: out?.verdict === 'no_probe'
          ? 'The spec is missing playbook.detect.probe.'
          : `probe exit=${out?.exit_code} · ${out?.duration_s?.toFixed?.(2) || '?'}s`,
        variant: out?.verdict === 'affected' || out?.verdict === 'no_probe'
          ? 'destructive' : undefined,
      });
      await refresh();
    } catch (err) {
      toast({
        title: 'Check failed',
        description: err instanceof ApiError ? err.message : (err?.message || 'unknown error'),
        variant: 'destructive',
      });
    } finally {
      setBusyFor(entry.cve, null);
    }
  };

  // Quick Run — confirmed via the runTarget dialog first; this fires
  // after the operator clicks through. Same full state machine as the
  // detail view's "Run on this host".
  const onConfirmQuickRun = async () => {
    const entry = runTarget;
    if (!entry) return;
    setRunTarget(null);
    setBusyFor(entry.cve, 'run');
    try {
      const out = await api.runCve(entry.cve, { force_action: 'ONE_CLICK' });
      const r = out?.result || {};
      toast({
        title: `${entry.cve} run finished: ${r.final_status || 'unknown'}`,
        description: r.skipped_reason
          || (r.operator_action_required && r.operator_action_required !== 'none'
              ? `Operator action: ${r.operator_action_required}`
              : 'No further operator action required.'),
      });
      await refresh();
    } catch (err) {
      toast({
        title: 'Run failed',
        description: err instanceof ApiError ? err.message : (err?.message || 'unknown error'),
        variant: 'destructive',
      });
    } finally {
      setBusyFor(entry.cve, null);
    }
  };

  const onConfirmQuickDismiss = async () => {
    const entry = dismissTarget;
    if (!entry || !dismissReason.trim()) return;
    try {
      await api.dismissCve(entry.cve, dismissReason.trim());
      toast({ title: 'Dismissed', description: `${entry.cve} set to DISMISSED.` });
      setDismissTarget(null);
      setDismissReason('');
      await refresh();
    } catch (err) {
      toast({
        title: 'Dismiss failed',
        description: err instanceof ApiError ? err.message : (err?.message || 'unknown error'),
        variant: 'destructive',
      });
    }
  };

  const onOpenResearch = async () => {
    setResearchOpen(true);
    try {
      const [cfg, connectors] = await Promise.all([
        api.getCveResearchConfig(),
        api.getCveResearchConnectors(),
      ]);
      setResearch(cfg);
      setResearchConnectors(connectors || { mock2_enabled: false, connectors: [] });
      // If this config was previously imported from a still-listed
      // connector, default back to that selection rather than 'new' —
      // saves re-picking it just to change the model or interval.
      const stillListed = cfg.source_connector_name
        && (connectors?.connectors || []).find((c) => c.name === cfg.source_connector_name);
      setResearchDraft({
        connectorSource: stillListed ? String(stillListed.id) : 'new',
        provider: cfg.provider || 'anthropic',
        base_url: cfg.base_url || '',
        model: cfg.model || '',
        modelCustom: false,
        api_key: '',
        enabled: cfg.enabled || false,
        interval_hours: cfg.interval_hours || 12,
      });
    } catch (err) {
      toast({
        title: 'Failed to load research settings',
        description: err instanceof ApiError ? err.message : (err?.message || 'unknown error'),
        variant: 'destructive',
      });
    }
  };

  const onSaveResearchConfig = async () => {
    if (!researchDraft) return;
    setResearchSaving(true);
    try {
      const usingExisting = researchDraft.connectorSource !== 'new';
      const body = {
        model: researchDraft.model,
        enabled: researchDraft.enabled,
        interval_hours: Number(researchDraft.interval_hours) || 12,
      };
      if (usingExisting) {
        body.import_connector_id = Number(researchDraft.connectorSource);
      } else {
        body.provider = researchDraft.provider;
        body.base_url = researchDraft.base_url;
        if (researchDraft.api_key) body.api_key = researchDraft.api_key; // blank = keep the stored key
      }
      const saved = await api.updateCveResearchConfig(body);
      setResearch(saved);
      setResearchDraft((d) => ({ ...d, api_key: '' }));
      toast({ title: 'Saved', description: saved.enabled ? 'Scheduled research is enabled.' : 'Saved (disabled).' });
    } catch (err) {
      toast({
        title: 'Save failed',
        description: err instanceof ApiError ? err.message : (err?.message || 'unknown error'),
        variant: 'destructive',
      });
    } finally {
      setResearchSaving(false);
    }
  };

  const onTestResearchConnector = async () => {
    setResearchTesting(true);
    try {
      const out = await api.testCveResearchConnector();
      toast({
        title: out.ok ? 'Connected' : 'Test failed',
        description: out.ok ? `Model replied: "${out.reply}"` : out.error,
        variant: out.ok ? undefined : 'destructive',
      });
    } catch (err) {
      toast({
        title: 'Test failed',
        description: err instanceof ApiError ? err.message : (err?.message || 'unknown error'),
        variant: 'destructive',
      });
    } finally {
      setResearchTesting(false);
    }
  };

  const onRunResearchNow = async () => {
    setResearchRunning(true);
    try {
      const out = await api.runCveResearchNow();
      toast({
        title: out.ok ? 'Research run complete' : 'Research run failed',
        description: out.ok
          ? `${out.entries_created ?? 0} created, ${out.entries_updated ?? 0} updated`
          : out.error,
        variant: out.ok ? undefined : 'destructive',
      });
      await refreshResearchMeta();
      await refresh();
    } catch (err) {
      toast({
        title: 'Run failed',
        description: err instanceof ApiError ? err.message : (err?.message || 'unknown error'),
        variant: 'destructive',
      });
    } finally {
      setResearchRunning(false);
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

  // Filtered + sorted rows. Search applies first (cheap client-side
  // substring), then column filters, then sort. Pagination is
  // applied in the render block since it needs the total count.
  // Helper: which tab does a given entry belong to?
  // Used both by the filtering pass and to compute the per-tab
  // counts shown in the tab bar.
  const entryTab = (e) => {
    if (e.status === 'DISMISSED') return 'dismissed';
    const v = e.latest_verdict?.verdict;
    if (v === 'not_affected') return 'not_affected';
    return 'active';  // affected / probe_error / unknown / no verdict yet
  };

  const tabCounts = useMemo(() => {
    const c = { active: 0, not_affected: 0, dismissed: 0 };
    for (const e of data.entries) c[entryTab(e)] += 1;
    return c;
  }, [data.entries]);

  const filtered = useMemo(() => {
    let rows = data.entries.slice();
    rows = rows.filter(r => entryTab(r) === tab);
    const q = search.trim().toLowerCase();
    if (q) {
      rows = rows.filter(r =>
        r.cve.toLowerCase().includes(q)
        || (r.name || '').toLowerCase().includes(q)
      );
    }
    if (filterAction !== 'all') rows = rows.filter(r => r.action_class === filterAction);
    if (filterStatus !== 'all') rows = rows.filter(r => r.status === filterStatus);
    if (pinnedOnly)             rows = rows.filter(r => !!r.pin);

    const cmp = (a, b) => {
      // Pinned entries always sort to the top, regardless of the
      // active sort column. The active sort still orders within the
      // pinned + unpinned groups.
      const ap = a.pin ? 0 : 1;
      const bp = b.pin ? 0 : 1;
      if (ap !== bp) return ap - bp;
      const dir = sort.dir === 'desc' ? -1 : 1;
      switch (sort.key) {
        case 'cve':
          return dir * a.cve.localeCompare(b.cve);
        case 'name':
          return dir * (a.name || '').localeCompare(b.name || '');
        case 'tier': {
          const at = parseInt(a.tier, 10);
          const bt = parseInt(b.tier, 10);
          // Missing tiers sort to the bottom regardless of direction.
          if (Number.isNaN(at) && Number.isNaN(bt)) return 0;
          if (Number.isNaN(at)) return 1;
          if (Number.isNaN(bt)) return -1;
          if (at !== bt) return dir * (at - bt);
          return -1 * (a.last_updated || '').localeCompare(b.last_updated || '');
        }
        case 'action':
          return dir * (a.action_class || '').localeCompare(b.action_class || '');
        case 'status':
          return dir * (a.status || '').localeCompare(b.status || '');
        case 'added':
          return dir * (a.added || '').localeCompare(b.added || '');
        case 'updated':
          return dir * (a.last_updated || '').localeCompare(b.last_updated || '');
        default:
          return 0;
      }
    };
    rows.sort(cmp);
    return rows;
  }, [data.entries, tab, search, filterAction, filterStatus, pinnedOnly, sort]);

  // Reset to page 1 when filters / search / tab / data change
  // (otherwise operator gets a confusing "page 5 of 1" after narrowing).
  useEffect(() => { setPage(1); },
    [tab, search, filterAction, filterStatus, pinnedOnly, data.entries.length]);

  // Optimistic pin toggle — flip locally first, then call the API.
  // Revert on error so the UI doesn't lie.
  const togglePin = useCallback(async (entry) => {
    const wasPinned = !!entry.pin;
    setData(d => ({
      ...d,
      entries: d.entries.map(e => e.cve === entry.cve
        ? { ...e, pin: wasPinned ? null : { note: null, pinned_at: new Date().toISOString() } }
        : e),
    }));
    try {
      if (wasPinned) await api.unpinCve(entry.cve);
      else await api.pinCve(entry.cve);
    } catch (err) {
      // Revert + toast.
      setData(d => ({
        ...d,
        entries: d.entries.map(e => e.cve === entry.cve
          ? { ...e, pin: wasPinned ? entry.pin : null }
          : e),
      }));
      toast({
        title: 'Pin failed',
        description: err instanceof ApiError ? err.message : (err?.message || 'unknown error'),
        variant: 'destructive',
      });
    }
  }, [toast]);

  const pinnedCount = data.entries.filter(e => e.pin).length;

  const paginate = filtered.length > PAGINATE_AT;
  const totalPages = paginate ? Math.max(1, Math.ceil(filtered.length / pageSize)) : 1;
  const visible = paginate
    ? filtered.slice((page - 1) * pageSize, page * pageSize)
    : filtered;

  const toggleSort = (key) => {
    setSort(s => s.key === key
      ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' }
      : { key, dir: 'asc' });
  };

  const SortHeader = ({ k, children, className = '' }) => (
    <button
      type="button"
      onClick={() => toggleSort(k)}
      className={`text-left flex items-center gap-1 hover:text-foreground transition-colors ${className}`}
      title={`Sort by ${k}`}
    >
      {children}
      {sort.key === k && (
        <span className="text-foreground" aria-label={sort.dir}>
          {sort.dir === 'asc' ? '↑' : '↓'}
        </span>
      )}
    </button>
  );

  const FilterChip = ({ active, onClick, children, size = 'sm' }) => (
    <button
      type="button"
      onClick={onClick}
      className={`${size === 'xs' ? 'text-[10px] px-1.5 py-0.5' : 'text-xs px-2 py-1'} rounded border transition-colors ${
        active ? 'bg-primary text-primary-foreground border-primary'
               : 'bg-transparent text-muted-foreground border-border hover:bg-accent'
      }`}
    >{children}</button>
  );

  return (
    <div className="space-y-4">
      {/* AI research reports — on the page, not buried in the settings
          dialog. Collapsed: a one-line latest-run status. Expanded:
          the recent run history (newest first). Scrolls away under
          the sticky chrome when browsing rows. */}
      {researchRuns.length > 0 && (() => {
        const latest = researchRuns[0];
        return (
          <div className="border rounded-lg bg-card">
            <button
              type="button"
              onClick={() => setReportsOpen(v => !v)}
              aria-expanded={reportsOpen}
              className="w-full min-h-[44px] flex items-center gap-2 px-3 py-2 text-left text-sm hover:bg-accent/40 rounded-lg"
            >
              {reportsOpen
                ? <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
                : <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />}
              <Bot className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="font-medium shrink-0">Research reports</span>
              <span className="text-xs text-muted-foreground truncate">
                latest: <span className={latest.ok ? 'text-emerald-500' : 'text-red-500'}>
                  {latest.ok ? 'ok' : 'failed'}
                </span>
                {' · '}{relTime(latest.at)}
                {' · '}{latest.created ?? 0} created, {latest.updated ?? 0} updated
              </span>
              <span className="ml-auto text-xs text-muted-foreground shrink-0">
                {researchRuns.length} run{researchRuns.length === 1 ? '' : 's'}
              </span>
            </button>
            {reportsOpen && (
              <div className="border-t px-3 py-2 space-y-2 max-h-80 overflow-y-auto">
                {researchRuns.map((run, i) => (
                  <ResearchRunReport key={run.at || i} run={run} />
                ))}
              </div>
            )}
          </div>
        );
      })()}

      {/* Sticky chrome: everything from page title down to and
          including the table header stays pinned at the top of the
          scroll container while only the row list scrolls below.
          The parent <main> in Layout.jsx is the scroll context
          (overflow-y-auto on the inner div); top: 0 sticks relative
          to its top edge.
          The negative margin + padding pair lets the sticky band
          extend to the page gutter so scrolled rows don't peek
          through the corners. */}
      <div className="sticky top-0 z-20 bg-background -mx-4 md:-mx-8 px-4 md:px-8 py-2 -mt-2 space-y-3">
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
          <Button variant="outline" size="sm" onClick={onOpenResearch}
                  title="Configure the native AI CVE-research routine">
            <Bot className="h-4 w-4 mr-1.5" /> AI Research
          </Button>
          <Button size="sm" onClick={onRunResearchNow}
                  disabled={researchRunning || !research?.configured}
                  title={research?.configured
                    ? 'Run one AI research pass now'
                    : 'Configure AI Research (provider, model, key) first'}>
            {researchRunning ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <Play className="h-4 w-4 mr-1.5" />}
            {researchRunning ? 'Researching…' : 'Run research'}
          </Button>
          <Button variant="ghost" size="icon" onClick={refresh} disabled={loading} title="Refresh list">
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          </Button>
        </div>
      </div>
      <p className="text-xs text-muted-foreground max-w-2xl">
        Each row is one entry from <code className="font-mono">/var/lib/proxypilot/cve-inbox/</code>.
        The AI research routine (and Paste YAML) writes specs into the inbox; the engine acts on
        AUTO_PATCH entries automatically and surfaces ONE_CLICK + ALERT here for operator review.
      </p>

      {/* Top-level tabs. Entries auto-route by their latest verdict
          + status; per-column filters and search work WITHIN the
          chosen tab. */}
      <div className="flex items-center gap-1 border-b border-border">
        {[
          { k: 'active',       label: 'Active',       hint: 'Affected, unknown, or probe-error — not dismissed' },
          { k: 'not_affected', label: 'Not affected', hint: 'Verdict says this host is not affected' },
          { k: 'dismissed',    label: 'Dismissed',    hint: 'Operator marked DISMISSED' },
        ].map(({ k, label, hint }) => (
          <button
            key={k}
            type="button"
            onClick={() => setTab(k)}
            title={hint}
            className={`relative px-4 py-2 text-sm font-medium transition-colors ${
              tab === k
                ? 'text-foreground border-b-2 border-primary -mb-px'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {label}
            <span className={`ml-2 text-xs font-mono ${tab === k ? 'opacity-90' : 'opacity-60'}`}>
              {tabCounts[k]}
            </span>
          </button>
        ))}
      </div>

      {error && (
        <div className="text-sm text-red-500 border border-red-500/30 bg-red-500/10 rounded px-3 py-2">
          {error}
        </div>
      )}

      {/* Search bar — full-width, instant client-side filter across
          CVE id + name. Pinned-only toggle sits
          next to it so the two main filters share a row. */}
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search CVE id or name…"
            className="w-full text-sm bg-muted/30 border border-border rounded px-3 py-2 pr-9 placeholder:text-muted-foreground/60 focus:outline-none focus:ring-1 focus:ring-primary/50"
          />
          {search && (
            <button
              type="button"
              onClick={() => setSearch('')}
              aria-label="Clear search"
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
        <button
          type="button"
          onClick={() => setPinnedOnly(v => !v)}
          className={`shrink-0 inline-flex items-center gap-1.5 text-xs px-3 py-2 rounded border transition-colors ${
            pinnedOnly
              ? 'bg-amber-400/15 text-amber-300 border-amber-500/40'
              : 'bg-transparent text-muted-foreground border-border hover:bg-accent'
          }`}
          title="Show only entries you've pinned"
        >
          <Star className="h-3.5 w-3.5" fill={pinnedOnly ? 'currentColor' : 'none'} />
          Pinned only{pinnedCount > 0 ? ` (${pinnedCount})` : ''}
        </button>
      </div>

      {/* Table — header is sticky; rows scroll under it. The header
          contains TWO rows per column: the click-to-sort label, and
          the per-column filter chips beneath. */}
      {/* Table header rendered inside the outer sticky band so the
          column labels + filter dropdowns travel with the chrome.
          Rows render in a separate container below. */}
      <div className="border border-b-0 rounded-t bg-card">
        <div className="border-b shadow-sm">
          {/* Row 1 — column labels with sort indicators. Tier is
              sort-only per operator request; Action + Status got
              dropdown filters in the row below. */}
          <div className="flex items-center bg-muted/30 text-xs text-muted-foreground">
            <div className="flex-1 min-w-0 grid grid-cols-12 gap-3 px-3 py-2">
              <SortHeader k="cve"     className="col-span-12 sm:col-span-3">CVE</SortHeader>
              <SortHeader k="name"    className="col-span-12 sm:col-span-3">Name</SortHeader>
              <SortHeader k="tier"    className="col-span-2 sm:col-span-1">Tier</SortHeader>
              <SortHeader k="action"  className="col-span-3 sm:col-span-1">Action</SortHeader>
              <SortHeader k="status"  className="col-span-3 sm:col-span-2">Status</SortHeader>
              <SortHeader k="added"   className="col-span-2 sm:col-span-1">Added</SortHeader>
              <SortHeader k="updated" className="col-span-2 sm:col-span-1">Updated</SortHeader>
            </div>
            {/* Spacer matching each row's quick-action cluster so the
                data columns line up under their labels. */}
            <div className={`${ROW_ACTIONS_W} shrink-0 px-2 py-2 text-right`} aria-hidden="true" />
          </div>
          {/* Row 2 — filter dropdowns under Action + Status. Tier no
              longer has chips (sort-only); CVE / Name / Added /
              Updated have no filters (search handles them). */}
          <div className="flex items-center bg-card border-t border-border/40">
            <div className="flex-1 min-w-0 grid grid-cols-12 gap-3 px-3 py-1.5">
              <div className="col-span-12 sm:col-span-3" />
              <div className="col-span-12 sm:col-span-3" />
              <div className="col-span-2 sm:col-span-1" />
              <div className="col-span-3 sm:col-span-1">
                <select
                  value={filterAction}
                  onChange={(e) => setFilterAction(e.target.value)}
                  aria-label="Filter by action"
                  className="w-full text-[11px] bg-muted/40 border border-border rounded px-1.5 py-1 focus:outline-none focus:ring-1 focus:ring-primary/50"
                >
                  <option value="all">All</option>
                  <option value="AUTO_PATCH">AUTO_PATCH</option>
                  <option value="ONE_CLICK">ONE_CLICK</option>
                  <option value="ALERT">ALERT</option>
                </select>
              </div>
              <div className="col-span-3 sm:col-span-2">
                <select
                  value={filterStatus}
                  onChange={(e) => setFilterStatus(e.target.value)}
                  aria-label="Filter by status"
                  className="w-full text-[11px] bg-muted/40 border border-border rounded px-1.5 py-1 focus:outline-none focus:ring-1 focus:ring-primary/50"
                >
                  <option value="all">All</option>
                  <option value="NEW">NEW</option>
                  <option value="QUEUED">QUEUED</option>
                  <option value="IN-PROGRESS">IN-PROGRESS</option>
                  <option value="RESOLVED">RESOLVED</option>
                  <option value="BLOCKED">BLOCKED</option>
                  <option value="DISMISSED">DISMISSED</option>
                  <option value="ALERT-AUTO-ROLLBACK">ALERT-AUTO-ROLLBACK</option>
                </select>
              </div>
              <div className="col-span-2 sm:col-span-1" />
              <div className="col-span-2 sm:col-span-1" />
            </div>
            <div className={`${ROW_ACTIONS_W} shrink-0 px-2`} aria-hidden="true" />
          </div>
        </div>
      </div>
      </div>{/* /sticky chrome */}

      {/* Rows — scroll beneath the sticky chrome. */}
      <div className="border border-t-0 rounded-b -mt-4">
        {visible.length === 0 ? (
          <div className="text-sm text-muted-foreground text-center py-8">
            {loading
              ? 'Loading…'
              : (search || filterAction !== 'all' || filterStatus !== 'all' || pinnedOnly)
                ? 'No entries match the current filters.'
                : tab === 'active'
                  ? data.entries.length === 0
                    ? 'Inbox is empty. Run AI Research or paste a CVE YAML to get started.'
                    : 'Nothing active — every entry is either Not affected or Dismissed.'
                  : tab === 'not_affected'
                    ? 'No entries with a "not affected" verdict yet. Run Check applicability on a row to verify.'
                    : 'No dismissed entries.'}
          </div>
        ) : (
          visible.map(entry => (
            <CveListRow
              key={entry.cve}
              entry={entry}
              onOpen={onOpen}
              onTogglePin={togglePin}
              onQuickCheck={onQuickCheck}
              onQuickRun={setRunTarget}
              onQuickDismiss={setDismissTarget}
              busy={rowBusy[entry.cve] || null}
            />
          ))
        )}
      </div>

      {/* Pagination footer — only when total exceeds PAGINATE_AT.
          Smaller inboxes render all rows; the threshold makes the
          common single-host case uncluttered. */}
      {paginate && (
        <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
          <div className="flex items-center gap-2">
            <span>Page size:</span>
            {[25, 50, 100].map(n => (
              <FilterChip key={n} size="xs" active={pageSize === n} onClick={() => setPageSize(n)}>
                {n}
              </FilterChip>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page <= 1}>
              Prev
            </Button>
            <span className="font-mono">page {page} of {totalPages}</span>
            <Button variant="outline" size="sm" onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page >= totalPages}>
              Next
            </Button>
          </div>
          <div>
            {filtered.length} match{filtered.length === 1 ? '' : 'es'}
            {filtered.length !== data.entries.length && ` (of ${data.entries.length})`}
          </div>
        </div>
      )}

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

      {/* Quick-run confirm — the list-row Play button lands here so a
          stray tap can't start patching the host. Same engine machine
          as the detail view's "Run on this host". */}
      <Dialog open={!!runTarget} onOpenChange={(open) => { if (!open) setRunTarget(null); }}>
        <DialogContent className="max-w-full h-full rounded-none sm:max-w-md sm:h-auto sm:rounded-lg">
          <DialogHeader><DialogTitle>Run {runTarget?.cve} on this host?</DialogTitle></DialogHeader>
          <div className="text-sm text-muted-foreground space-y-2">
            {runTarget?.name && <p className="text-foreground">{runTarget.name}</p>}
            <p>
              The engine probes the host, snapshots first if a backend is available, runs the
              patch steps, re-runs the probe to verify, and rolls back if verify still says
              affected.
            </p>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setRunTarget(null)}>Cancel</Button>
            <Button onClick={onConfirmQuickRun}>
              <Play className="h-4 w-4 mr-1.5" /> Run now
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Quick-dismiss — same required-reason contract as the detail
          view's Mark dismissed. */}
      <Dialog open={!!dismissTarget}
              onOpenChange={(open) => { if (!open) { setDismissTarget(null); setDismissReason(''); } }}>
        <DialogContent className="max-w-full h-full rounded-none sm:max-w-md sm:h-auto sm:rounded-lg">
          <DialogHeader><DialogTitle>Dismiss {dismissTarget?.cve}</DialogTitle></DialogHeader>
          <div className="space-y-2 text-sm">
            <p className="text-muted-foreground">
              Status will be set to <code className="font-mono">DISMISSED</code> with this reason
              recorded in history.
            </p>
            <Input
              value={dismissReason}
              onChange={(e) => setDismissReason(e.target.value)}
              placeholder="Reason (required)"
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button variant="ghost"
                    onClick={() => { setDismissTarget(null); setDismissReason(''); }}>
              Cancel
            </Button>
            <Button onClick={onConfirmQuickDismiss} disabled={!dismissReason.trim()}>Dismiss</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={researchOpen} onOpenChange={setResearchOpen}>
        <DialogContent className="max-w-full h-full rounded-none sm:max-w-lg sm:h-auto sm:rounded-lg flex flex-col">
          <DialogHeader><DialogTitle>AI CVE research</DialogTitle></DialogHeader>
          <div className="space-y-4 text-sm overflow-y-auto">
            <p className="text-muted-foreground text-xs">
              Runs natively in the backend, on this host's own network — research CVEs against
              this host's inventory using a connected AI model, and file/update inbox entries the
              same way "Paste YAML" does. Off by default; nothing runs until you enable it below.
            </p>

            {!researchDraft ? (
              <div className="flex items-center gap-2 text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading…
              </div>
            ) : (
              <>
                <div className="flex items-center justify-between gap-3 p-3 border rounded-lg">
                  <div className="min-w-0">
                    <div className="font-medium">Scheduled runs</div>
                    <div className="text-xs text-muted-foreground">
                      {researchDraft.enabled ? 'Runs automatically on the interval below.' : 'Disabled — configure and save, or use Run now.'}
                    </div>
                  </div>
                  <Switch
                    checked={researchDraft.enabled}
                    onCheckedChange={(v) => setResearchDraft((d) => ({ ...d, enabled: v }))}
                  />
                </div>

                {(() => {
                  const hasReusableConnectors = researchConnectors.mock2_enabled && researchConnectors.connectors.length > 0;
                  const usingExisting = researchDraft.connectorSource !== 'new';
                  const selectedConnector = usingExisting
                    ? researchConnectors.connectors.find((c) => String(c.id) === researchDraft.connectorSource)
                    : null;
                  // The provider that actually drives the model-preset list:
                  // the draft's own choice when configuring a new connector,
                  // or the picked existing connector's provider otherwise.
                  const effectiveProvider = usingExisting ? (selectedConnector?.provider || '') : researchDraft.provider;
                  const modelPresets = effectiveProvider === 'anthropic' ? ANTHROPIC_MODEL_PRESETS : [];
                  const modelIsPreset = modelPresets.some((p) => p.id === researchDraft.model);
                  const showCustomModelInput = modelPresets.length === 0
                    || researchDraft.modelCustom || (researchDraft.model && !modelIsPreset);

                  return (
                    <>
                      {hasReusableConnectors && (
                        <div className="space-y-1">
                          <label className="text-xs font-medium text-muted-foreground">Connector</label>
                          <Select
                            value={researchDraft.connectorSource}
                            onValueChange={(v) => setResearchDraft((d) => ({ ...d, connectorSource: v }))}
                          >
                            <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                            <SelectContent>
                              <SelectItem value="new">New connector…</SelectItem>
                              {researchConnectors.connectors.map((c) => (
                                <SelectItem key={c.id} value={String(c.id)}>
                                  {c.name} ({c.provider})
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                      )}

                      {usingExisting ? (
                        <div className="text-xs rounded border border-border bg-muted/20 p-2 text-muted-foreground">
                          Using <span className="text-foreground font-medium">{selectedConnector?.name || '(connector)'}</span>{' '}
                          ({selectedConnector?.provider}) from <span className="text-foreground">Projects</span> — its
                          stored key is copied in on save, not re-entered here.
                        </div>
                      ) : (
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                          <div className="space-y-1">
                            <label className="text-xs font-medium text-muted-foreground">Provider</label>
                            <Select
                              value={researchDraft.provider}
                              onValueChange={(v) => setResearchDraft((d) => ({ ...d, provider: v, model: '', modelCustom: false }))}
                            >
                              <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                              <SelectContent>
                                <SelectItem value="anthropic">Anthropic</SelectItem>
                                <SelectItem value="openai">OpenAI</SelectItem>
                                <SelectItem value="gemini">Gemini</SelectItem>
                                <SelectItem value="openai_compatible">OpenAI-compatible</SelectItem>
                                <SelectItem value="ollama">Ollama (local)</SelectItem>
                              </SelectContent>
                            </Select>
                          </div>
                          <div className="space-y-1">
                            <label className="text-xs font-medium text-muted-foreground">
                              API key {research?.has_api_key && !usingExisting && <span className="text-emerald-500">· configured</span>}
                            </label>
                            <Input
                              type="password"
                              value={researchDraft.api_key}
                              onChange={(e) => setResearchDraft((d) => ({ ...d, api_key: e.target.value }))}
                              placeholder={research?.has_api_key ? 'Leave blank to keep the stored key' : 'sk-…'}
                              autoComplete="off"
                            />
                          </div>
                        </div>
                      )}

                      {!usingExisting && (researchDraft.provider === 'openai_compatible' || researchDraft.provider === 'ollama') && (
                        <div className="space-y-1">
                          <label className="text-xs font-medium text-muted-foreground">Base URL</label>
                          <Input
                            value={researchDraft.base_url}
                            onChange={(e) => setResearchDraft((d) => ({ ...d, base_url: e.target.value }))}
                            placeholder="http://localhost:11434"
                          />
                        </div>
                      )}

                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <div className="space-y-1">
                          <label className="text-xs font-medium text-muted-foreground">Model</label>
                          {modelPresets.length > 0 ? (
                            <Select
                              value={showCustomModelInput ? MODEL_CUSTOM : researchDraft.model}
                              onValueChange={(v) => {
                                if (v === MODEL_CUSTOM) setResearchDraft((d) => ({ ...d, modelCustom: true, model: '' }));
                                else setResearchDraft((d) => ({ ...d, modelCustom: false, model: v }));
                              }}
                            >
                              <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                              <SelectContent>
                                {modelPresets.map((p) => (
                                  <SelectItem key={p.id} value={p.id}>{p.label}</SelectItem>
                                ))}
                                <SelectItem value={MODEL_CUSTOM}>Custom…</SelectItem>
                              </SelectContent>
                            </Select>
                          ) : (
                            <Input
                              value={researchDraft.model}
                              onChange={(e) => setResearchDraft((d) => ({ ...d, model: e.target.value }))}
                              placeholder="e.g. gpt-5"
                            />
                          )}
                        </div>
                        <div className="space-y-1">
                          <label className="text-xs font-medium text-muted-foreground">Interval</label>
                          <Select
                            value={String(researchDraft.interval_hours)}
                            onValueChange={(v) => setResearchDraft((d) => ({ ...d, interval_hours: Number(v) }))}
                          >
                            <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                            <SelectContent>
                              <SelectItem value="6">Every 6 hours</SelectItem>
                              <SelectItem value="12">Every 12 hours</SelectItem>
                              <SelectItem value="24">Daily</SelectItem>
                              <SelectItem value="48">Every 2 days</SelectItem>
                              <SelectItem value="168">Weekly</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                      </div>

                      {modelPresets.length > 0 && showCustomModelInput && (
                        <div className="space-y-1">
                          <label className="text-xs font-medium text-muted-foreground">Custom model id</label>
                          <Input
                            value={researchDraft.model}
                            onChange={(e) => setResearchDraft((d) => ({ ...d, model: e.target.value }))}
                            placeholder="claude-sonnet-5"
                            autoFocus
                          />
                        </div>
                      )}
                    </>
                  );
                })()}

                <div className="flex flex-wrap gap-2">
                  <Button variant="outline" size="sm" onClick={onTestResearchConnector} disabled={researchTesting}>
                    {researchTesting ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <Stethoscope className="h-4 w-4 mr-1.5" />}
                    Test connection
                  </Button>
                </div>

                <p className="text-xs text-muted-foreground">
                  Run passes with the <strong className="text-foreground/80">Run research</strong>{' '}
                  button on the CVEs page; run reports show there too.
                </p>
              </>
            )}
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setResearchOpen(false)}>Close</Button>
            <Button onClick={onSaveResearchConfig} disabled={researchSaving || !researchDraft}>
              {researchSaving ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <Save className="h-4 w-4 mr-1.5" />}
              Save
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
