// BuildLogViewer — read one build's transcript without leaving Build History.
//
// The eye icon used to do exactly what tapping the row did (jump to the message
// in the chat), so of the two visible affordances one was redundant and the
// actual build record — what the model did, which files changed, what it cost —
// was only reachable by downloading a JSON file and opening it elsewhere.
//
// Now the two actions are genuinely different:
//   row / card  → go to that build in the chat (unchanged)
//   eye         → open this: the transcript, events and change records
//
// Data is the same artifact the Download button produces
// (GET /requests/:id/log), so the two can never disagree.
//
// MOBILE_FIRST: full-screen below sm, 44px targets, one column, the transcript
// is the only scrolling region.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/api';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Loader2, Download, FileText, Terminal, GitCommit, MessageSquare, AlertTriangle } from 'lucide-react';

const TABS = [
  { key: 'transcript', label: 'Transcript', icon: Terminal },
  { key: 'messages', label: 'Chat', icon: MessageSquare },
  { key: 'changes', label: 'Changes', icon: GitCommit },
];

function fmtWhen(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString();
}

function money(cents) {
  const n = Number(cents || 0);
  return n >= 100 ? `$${(n / 100).toFixed(2)}` : `${n}¢`;
}

// Events carry a `kind` plus role/content/meta. Render each as one compact line
// so a long build reads like a log rather than a wall of JSON — but keep the
// raw payload one tap away, because the reason to open this is usually that
// something went wrong and the summary is exactly what you cannot trust.
function EventRow({ ev }) {
  const [open, setOpen] = useState(false);
  const kind = ev.kind || 'event';
  const bad = /error|fail|halt|refus|blocked/i.test(kind);
  const text = (ev.content || '').trim();
  const meta = ev.meta && typeof ev.meta === 'object' ? ev.meta : null;
  const preview = text.length > 400 && !open ? `${text.slice(0, 400)}…` : text;
  return (
    <div className={`rounded border px-2 py-1.5 ${bad ? 'border-destructive/40 bg-destructive/5' : 'bg-card'}`}>
      <div className="flex items-center gap-2 flex-wrap">
        <span className={`text-[10px] font-mono uppercase tracking-wide ${bad ? 'text-destructive' : 'text-muted-foreground'}`}>{kind}</span>
        {ev.role ? <span className="text-[10px] text-muted-foreground">{ev.role}</span> : null}
        {ev.created_at ? <span className="text-[10px] text-muted-foreground ml-auto">{fmtWhen(ev.created_at)}</span> : null}
      </div>
      {preview ? (
        <pre className="mt-1 whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed">{preview}</pre>
      ) : null}
      {(text.length > 400 || meta) ? (
        <button type="button" onClick={() => setOpen((v) => !v)}
          className="mt-1 min-h-[32px] text-[11px] text-primary hover:underline">
          {open ? 'Show less' : 'Show detail'}
        </button>
      ) : null}
      {open && meta ? (
        <pre className="mt-1 overflow-x-auto rounded bg-muted/50 p-2 font-mono text-[10.5px]">{JSON.stringify(meta, null, 2)}</pre>
      ) : null}
    </div>
  );
}

export default function BuildLogViewer({ projectId, requestId, open, onOpenChange, title }) {
  const [artifact, setArtifact] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [tab, setTab] = useState('transcript');

  useEffect(() => {
    if (!open || !requestId) return undefined;
    let alive = true;
    setLoading(true); setError(''); setArtifact(null); setTab('transcript');
    api.mock2GetRequestLog(projectId, requestId)
      .then((a) => { if (alive) setArtifact(a); })
      .catch((e) => { if (alive) setError(e?.message || 'Could not load this build.'); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [open, projectId, requestId]);

  const log = artifact?.log || null;
  const events = useMemo(() => log?.events || [], [log]);
  const messages = useMemo(() => log?.messages || [], [log]);
  const changes = useMemo(() => log?.change_records || [], [log]);

  const download = useCallback(() => {
    if (!artifact) return;
    const blob = new Blob([JSON.stringify(artifact, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = artifact.filename || `build-${requestId}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [artifact, requestId]);

  const counts = { transcript: events.length, messages: messages.length, changes: changes.length };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-full h-full rounded-none flex flex-col sm:max-w-3xl sm:h-[85vh] sm:rounded-lg">
        <DialogHeader className="shrink-0">
          <DialogTitle className="flex items-center gap-2 text-base">
            <FileText className="h-4 w-4 shrink-0" />
            <span className="truncate">{title || 'Build log'}</span>
          </DialogTitle>
        </DialogHeader>

        {loading ? (
          <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading the build record…
          </div>
        ) : error ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center text-sm text-muted-foreground">
            <AlertTriangle className="h-5 w-5 text-destructive" />
            <span>{error}</span>
          </div>
        ) : log ? (
          <>
            {/* What this build was and what it cost — the two facts you open a
                build record to check, above the fold on every screen size. */}
            <div className="shrink-0 rounded-lg border bg-muted/30 p-2.5 text-xs">
              {log.request?.instruction ? (
                <p className="whitespace-pre-wrap break-words">{log.request.instruction}</p>
              ) : null}
              <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                {log.final_status ? <span>Status: <b className="text-foreground">{log.final_status}</b></span> : null}
                {log.cost ? <span>Cost: <b className="text-foreground">{money(log.cost.cents)}</b></span> : null}
                {log.segments?.length ? <span>{log.segments.length} segment{log.segments.length === 1 ? '' : 's'}</span> : null}
                {log.request?.created_at ? <span>{fmtWhen(log.request.created_at)}</span> : null}
              </div>
              {/* The roll-up is only comparable across builds when every segment
                  used the current usage schema. Saying so beats a number that
                  quietly means something different from the one beside it. */}
              {log.cost && log.cost.comparable === false ? (
                <p className="mt-1 text-[10.5px] text-amber-500">
                  Part of this build predates the current usage accounting — the cost is not directly comparable to newer builds.
                </p>
              ) : null}
            </div>

            <div className="shrink-0 flex gap-1 border-b pb-1">
              {TABS.map((t) => (
                <button
                  key={t.key} type="button" onClick={() => setTab(t.key)}
                  className={`min-h-[44px] rounded px-2.5 text-xs ${tab === t.key ? 'bg-muted font-medium' : 'text-muted-foreground'}`}
                >
                  <t.icon className="h-3.5 w-3.5 inline mr-1" />{t.label}
                  <span className="ml-1 text-[10px] text-muted-foreground">{counts[t.key]}</span>
                </button>
              ))}
              <div className="flex-1" />
              <Button variant="ghost" size="sm" className="min-h-[44px]" onClick={download} title="Download this build's full context">
                <Download className="h-3.5 w-3.5 sm:mr-1" /><span className="hidden sm:inline">Download</span>
              </Button>
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto space-y-1.5 pt-2">
              {tab === 'transcript' ? (
                events.length
                  ? events.map((ev, i) => <EventRow key={ev.id ?? i} ev={ev} />)
                  : <p className="text-xs text-muted-foreground">No transcript was recorded for this build.</p>
              ) : null}

              {tab === 'messages' ? (
                messages.length
                  ? messages.map((m, i) => (
                    <div key={m.id ?? i} className="rounded border bg-card px-2 py-1.5">
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] font-mono uppercase tracking-wide text-muted-foreground">{m.kind || 'message'}</span>
                        {m.created_at ? <span className="ml-auto text-[10px] text-muted-foreground">{fmtWhen(m.created_at)}</span> : null}
                      </div>
                      <p className="mt-1 whitespace-pre-wrap break-words text-[12px] leading-relaxed">{m.body}</p>
                    </div>
                  ))
                  : <p className="text-xs text-muted-foreground">No chat messages are attached to this build.</p>
              ) : null}

              {tab === 'changes' ? (
                changes.length
                  ? changes.map((c, i) => (
                    <div key={c.seq ?? i} className="rounded border bg-card px-2 py-1.5">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-[10px] font-mono text-muted-foreground">#{c.seq}</span>
                        {c.commit_sha ? <code className="text-[10px] font-mono">{String(c.commit_sha).slice(0, 10)}</code> : null}
                        {c.created_at ? <span className="ml-auto text-[10px] text-muted-foreground">{fmtWhen(c.created_at)}</span> : null}
                      </div>
                      {c.summary ? <p className="mt-1 whitespace-pre-wrap break-words text-[12px] leading-relaxed">{c.summary}</p> : null}
                    </div>
                  ))
                  : <p className="text-xs text-muted-foreground">This build produced no change record — nothing was committed.</p>
              ) : null}
            </div>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
