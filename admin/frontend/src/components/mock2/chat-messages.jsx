// Shared chat-message rendering for the Mock2 project chats.
//
// Both the pre-approval design conversation (ConceptStage) and the post-approval
// build/run/maintenance conversation (BuildChat) render the same message stream
// (mock2GetChat): plain bubbles, system lines, rule questions with tappable
// answers, and confirmed-rule receipts. Keeping one implementation here means the
// two chats never drift.
//
// MOBILE_FIRST: bubbles cap at 85–92% width, stack vertically, 44px answer
// targets; renders clean at 360px.

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Loader2, CheckCircle2, HelpCircle, Zap, Pencil, FilePlus2, BookOpen, TerminalSquare, Search, Circle, Trash2, FolderOpen, Activity, Copy, Download } from 'lucide-react';
import ExplainThis from './ExplainThis';
import Markdown from './Markdown';
import { chatImageUrl } from '@/lib/chat-images';
import ImageLightbox from './ImageLightbox';

// A rule_question body carries { question, choices } as JSON (M8, ADR-002).
// Tolerant of a plain-text body (older rows).
export function parseRuleQuestion(body) {
  try {
    const j = JSON.parse(body);
    if (j && typeof j === 'object' && !Array.isArray(j)) {
      return { question: String(j.question || ''), choices: Array.isArray(j.choices) ? j.choices : [] };
    }
  } catch { /* plain text */ }
  return { question: String(body || ''), choices: [] };
}

// A rule_question rendered in the chat: the plain-language question + tappable
// choices (≥44px) and a free-text escape hatch (ADR-002). Editors answer; the
// answer appends to state/rules.md and, when the last one is confirmed, Build
// starts automatically. Answered questions read as a compact confirmation.
export function RuleQuestion({ m, open, canEdit, busy, onAnswer, projectId = null }) {
  const { question, choices } = parseRuleQuestion(m.body);
  const [free, setFree] = useState('');
  if (!open) {
    return (
      <div className="flex justify-start">
        <div className="max-w-[90%] rounded-xl border border-border bg-muted/40 px-3 py-2 text-sm">
          <p className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
            <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" /> Rule confirmed
          </p>
          <p className="mt-1 text-foreground/80 break-words">{question}</p>
        </div>
      </div>
    );
  }
  return (
    <div className="flex justify-start" data-open-question>
      <div className="max-w-[92%] w-full rounded-xl border border-violet-500/30 bg-violet-500/5 px-3 py-2.5 space-y-2.5">
        <div className="flex items-start justify-between gap-2">
          <p className="flex items-center gap-1.5 text-[11px] font-medium text-violet-500">
            <HelpCircle className="h-3.5 w-3.5" /> Rule question — confirm to continue building
          </p>
          {projectId ? (
            <ExplainThis
              projectId={projectId} kind="rule_question" cardId={`q-${m.question_id}`}
              status="waiting for your answer" text={question} className="-my-1 shrink-0"
            />
          ) : null}
        </div>
        <p className="text-sm text-foreground break-words">{question}</p>
        {canEdit ? (
          <>
            {choices.length ? (
              <div className="flex flex-col gap-2">
                {choices.map((c) => (
                  <Button
                    key={c} variant="outline" size="sm"
                    className="h-11 justify-start whitespace-normal text-left"
                    disabled={busy} onClick={() => onAnswer(m.question_id, c)}
                  >
                    {c}
                  </Button>
                ))}
              </div>
            ) : null}
            <div className="flex items-end gap-2 pt-0.5">
              <Input
                className="h-11" placeholder="Or type your own answer…" value={free}
                disabled={busy} onChange={(e) => setFree(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && free.trim()) { e.preventDefault(); onAnswer(m.question_id, free.trim()); } }}
              />
              <Button className="h-11 shrink-0" disabled={busy || !free.trim()} onClick={() => onAnswer(m.question_id, free.trim())}>
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Confirm'}
              </Button>
            </div>
          </>
        ) : (
          <p className="text-xs text-muted-foreground">An editor needs to confirm this rule.</p>
        )}
      </div>
    </div>
  );
}

// Image attachments on a message ([{id, media_type, name}]) — thumbnails that
// open the full image in a new tab. The URL is content-addressed and served
// immutable, so the browser caches each image once.
function AttachmentThumbs({ m, projectId, mine }) {
  const [lightbox, setLightbox] = useState(null);
  if (!projectId || !m.attachments?.length) return null;
  // Opening in a new tab threw the reader out of the conversation; a 96px
  // cropped thumbnail of a screenshot is unreadable. Tapping now opens the
  // lightbox, with every image on the message arrow-able from there — which is
  // what a desktop+mobile screenshot review needs.
  const images = m.attachments.map((a) => ({
    url: chatImageUrl(projectId, a.id),
    name: a.name || 'attached image',
    label: a.label || null,
  }));
  return (
    <>
      <div className={`flex flex-wrap gap-1.5 ${m.body ? 'mb-1.5' : ''}`}>
        {m.attachments.map((a, i) => (
          <button
            key={a.id}
            type="button"
            onClick={() => setLightbox(i)}
            title={`${a.name || 'attached image'} — tap to enlarge`}
            aria-label={`Enlarge ${a.name || 'attached image'}`}
            className={`block overflow-hidden rounded-lg border ${mine ? 'border-primary-foreground/30' : 'border-border'}`}
          >
            <img
              src={chatImageUrl(projectId, a.id)}
              alt={a.name || 'attached image'}
              loading="lazy"
              className="h-24 max-w-[9rem] object-cover"
            />
          </button>
        ))}
      </div>
      {lightbox != null ? (
        <ImageLightbox images={images} index={lightbox} onClose={() => setLightbox(null)} />
      ) : null}
    </>
  );
}

// The "turn this message into a build" chip: distills the message into a
// well-formed prompt server-side and runs it through the normal quick lane.
function QuickUpdateChip({ m, onQuickUpdate, busyId }) {
  if (!onQuickUpdate) return null;
  const thisBusy = busyId === m.id;
  return (
    <button
      type="button"
      className="mt-1.5 inline-flex h-9 items-center gap-1 rounded-md border border-primary/40 px-2.5 text-[11px] font-medium text-primary hover:bg-primary/10 disabled:opacity-50"
      disabled={busyId != null}
      onClick={() => onQuickUpdate(m)}
      title="Turn this message into a well-formed prompt and run it as a Quick update"
    >
      {thisBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Zap className="h-3 w-3" />}
      {thisBusy ? 'Composing the prompt…' : 'Build this as a Quick update'}
    </button>
  );
}

const LONG_SYSTEM_NOTE_CHARS = 400;

// TAKE IT WITH YOU. A screen check posts five kilobytes of findings — every one
// an instruction somebody has to act on, in a scrolling pane, on a phone.
// Builds have had a download since the beginning; the review that says what is
// WRONG with the app had no way out of the chat at all: "there is no way for me
// to download like the builds, in order to get feedback from it".
//
// Plain text, not JSON: the thing being carried is prose meant to be read and
// pasted somewhere else. Copy first because it is what most people want, and
// the download is the fallback for when it is too long to hold.
function NoteActions({ body, name = 'note' }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(body);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* the text is selectable — nothing is lost */ }
  };
  const download = () => {
    const url = URL.createObjectURL(new Blob([body], { type: 'text/plain;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${name}.txt`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Revoking synchronously cancels the download in some browsers.
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  };
  return (
    <span className="ml-auto flex shrink-0 items-center gap-1">
      <button
        type="button" onClick={copy}
        className="inline-flex min-h-[32px] items-center gap-1 rounded px-1.5 text-[11px] font-medium text-muted-foreground hover:text-foreground"
        title="Copy this note"
      >
        {copied ? <CheckCircle2 className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
        {copied ? 'Copied' : 'Copy'}
      </button>
      <button
        type="button" onClick={download}
        className="inline-flex min-h-[32px] items-center gap-1 rounded px-1.5 text-[11px] font-medium text-muted-foreground hover:text-foreground"
        title="Download this note as a text file"
      >
        <Download className="h-3 w-3" /> Save
      </button>
    </span>
  );
}

// System notes can carry images — the screen check posts its mobile/desktop
// screenshots with its findings. A note WITH attachments always uses the boxed
// layout: the centred pill has nowhere to put a thumbnail, and a critique whose
// evidence is invisible is exactly the thing the operator has to take on trust.
function SystemNote({ body, m, projectId }) {
  const [expanded, setExpanded] = useState(false);
  const hasShots = !!(projectId && m?.attachments?.length);
  if (body.length <= LONG_SYSTEM_NOTE_CHARS && !hasShots) {
    return (
      <div className="flex flex-col items-center">
        <p className="text-[11px] text-muted-foreground bg-muted/60 rounded-full px-3 py-1 max-w-[90%] text-center">
          {body}
        </p>
      </div>
    );
  }
  const long = body.length > LONG_SYSTEM_NOTE_CHARS;
  return (
    <div className="flex justify-center">
      <div className="w-full max-w-[95%] rounded-md border bg-muted/40 px-3 py-2">
        <div className={long && !expanded ? 'max-h-32 overflow-hidden relative' : ''}>
          <p className="text-xs text-muted-foreground whitespace-pre-wrap break-words">{body}</p>
          {long && !expanded && <div className="pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-gradient-to-t from-background/90 to-transparent" />}
        </div>
        {/* The expander and the take-it-with-you actions share a row: a long
            note is exactly the one somebody wants out of the chat, and putting
            Save next to "Show all" means they never have to expand it first. */}
        <div className="mt-1 flex flex-wrap items-center gap-1">
          {long ? (
            <button
              type="button"
              className="min-h-[32px] text-[11px] font-medium text-primary underline underline-offset-2"
              onClick={() => setExpanded((v) => !v)}
            >
              {expanded ? 'Show less' : `Show all (${Math.round(body.length / 100) / 10}k chars)`}
            </button>
          ) : null}
          <NoteActions body={body} name={`note-${m?.id || 'chat'}`} />
        </div>
        {hasShots ? (
          <div className="mt-2 border-t border-border/60 pt-2">
            <p className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">
              {m.attachments.length} screenshot{m.attachments.length === 1 ? '' : 's'} — tap to enlarge
            </p>
            <AttachmentThumbs m={m} projectId={projectId} mine={false} />
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function ChatBubble({ m, projectId = null, onQuickUpdate = null, quickBusyId = null }) {
  if (m.kind === 'system') {
    // System messages are status, never asks — no build chip (operator
    // decision: the chip belongs to genuine Ask answers only). Long notes
    // (a design review's findings) render as a collapsible left-aligned
    // card — a giant centered pill was unreadable (user report).
    return <SystemNote body={String(m.body || '')} m={m} projectId={projectId} />;
  }
  if (m.kind === 'rule_answer') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-emerald-500/15 text-foreground px-3 py-2 text-sm break-words">
          <span className="flex items-center gap-1 text-[11px] font-medium text-emerald-600">
            <CheckCircle2 className="h-3.5 w-3.5" /> Rule confirmed{m.acting_as_admin ? ' (admin)' : ''}
          </span>
          <span className="block mt-0.5 whitespace-pre-wrap">{m.body}</span>
        </div>
      </div>
    );
  }
  const mine = m.kind === 'user';
  return (
    <div className={`flex flex-col ${mine ? 'items-end' : 'items-start'}`}>
      <div
        className={`max-w-[85%] rounded-2xl px-3 py-2 text-sm break-words ${
          mine ? 'whitespace-pre-wrap bg-primary text-primary-foreground rounded-br-sm' : 'bg-muted text-foreground rounded-bl-sm'
        }`}
      >
        <AttachmentThumbs m={m} projectId={projectId} mine={mine} />
        {/* Assistant replies are markdown (headers, lists, code); the user's
            own text stays verbatim pre-wrap. */}
        {mine ? m.body : <Markdown>{m.body}</Markdown>}
        {/* What this response cost (assistant messages carry their spend). */}
        {!mine && m.cost_cents != null ? (
          <span className="block mt-1.5 text-[10px] text-muted-foreground border-t border-border/50 pt-1">
            {Number(m.tokens) > 0 ? `${Math.round(Number(m.tokens)).toLocaleString()} tok · ` : ''}
            {Number(m.cost_cents) >= 1 ? `$${(Number(m.cost_cents) / 100).toFixed(2)}` : '<$0.01'}
          </span>
        ) : null}
        {m.acting_as_admin ? (
          <span className={`block mt-1 text-[10px] ${mine ? 'text-primary-foreground/70' : 'text-muted-foreground'}`}>
            (admin)
          </span>
        ) : null}
      </div>
      {/* Ask answers (improvement lists, plans, specs) can become builds in
          one tap — the distiller writes the prompt the user was composing by
          hand. Ask-only: an Ask answer is an assistant row with no cycle_id;
          build completion summaries (assistant + cycle_id) are status. */}
      {!mine && m.kind === 'assistant' && m.cycle_id == null ? (
        <QuickUpdateChip m={m} onQuickUpdate={onQuickUpdate} busyId={quickBusyId} />
      ) : null}
    </div>
  );
}

// The scrollable message list shared by both chats: renders bubbles + inline
// rule questions, an optional working indicator, and an empty-state line. The
// caller owns fetching/polling and passes the scroll ref so it can keep the
// newest message in view.
// A live streaming reply — the model's answer arriving progressively (via the
// job's `partial` text). Rendered as an assistant bubble with a pulsing caret;
// the durable message replaces it when the turn completes.
export function StreamingBubble({ text }) {
  if (!text) return null;
  return (
    <div className="flex justify-start">
      <div className="max-w-[85%] rounded-2xl rounded-bl-sm bg-muted px-3 py-2 text-sm break-words">
        <Markdown>{text}</Markdown>
        <span className="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse rounded-sm bg-foreground/60 align-text-bottom" aria-hidden />
      </div>
    </div>
  );
}

// Live build activity — the "what's being worked on" stream (VS Code / Claude
// Code style): the model's narration interleaved with the file operations it
// runs, rendered as a timeline with a coloured action glyph, a file chip and
// +adds/-dels. Fed from the cycle poll's `activity` (backend normalises every
// harness's tool vocabulary to a canonical `action`).
const ACTION_META = {
  read: { Icon: BookOpen, cls: 'text-sky-500', ring: 'ring-sky-500/30' },
  edit: { Icon: Pencil, cls: 'text-amber-500', ring: 'ring-amber-500/30' },
  write: { Icon: FilePlus2, cls: 'text-emerald-500', ring: 'ring-emerald-500/30' },
  create: { Icon: FilePlus2, cls: 'text-emerald-500', ring: 'ring-emerald-500/30' },
  delete: { Icon: Trash2, cls: 'text-red-500', ring: 'ring-red-500/30' },
  search: { Icon: Search, cls: 'text-violet-500', ring: 'ring-violet-500/30' },
  run: { Icon: TerminalSquare, cls: 'text-slate-400', ring: 'ring-slate-400/30' },
  list: { Icon: FolderOpen, cls: 'text-cyan-500', ring: 'ring-cyan-500/30' },
  check: { Icon: Activity, cls: 'text-teal-500', ring: 'ring-teal-500/30' },
  other: { Icon: Circle, cls: 'text-muted-foreground', ring: 'ring-border' },
};

// One timeline cell (the coloured glyph on the rail). The rail is the cell's
// own absolute vertical line, so consecutive cells join into a continuous
// thread without any pixel-offset math.
function Rail({ children }) {
  return (
    <span className="relative flex w-5 shrink-0 justify-center">
      <span className="absolute inset-y-0 w-px bg-border" aria-hidden />
      {children}
    </span>
  );
}

function ActivityRow({ it }) {
  const meta = ACTION_META[it.action] || ACTION_META.other;
  const { Icon } = meta;
  return (
    <li className="flex gap-2">
      <Rail>
        <span className={`relative z-10 mt-0.5 flex h-5 w-5 items-center justify-center rounded-full bg-background ring-1 ${meta.ring}`}>
          <Icon className={`h-3 w-3 ${meta.cls}`} />
        </span>
      </Rail>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-1.5 gap-y-0.5 pt-1 text-xs">
        <span className="shrink-0 font-medium text-foreground/70">{it.verb}</span>
        {it.file ? (
          <span className="inline-flex min-w-0 max-w-full items-center rounded-md border bg-muted/60 px-1.5 py-0.5 font-mono text-[11px] text-foreground/90 truncate" title={it.path || it.file}>{it.file}</span>
        ) : null}
        {it.detail ? <span className="min-w-0 truncate text-muted-foreground">{it.detail}</span> : null}
        {typeof it.adds === 'number' && it.adds > 0 ? <span className="shrink-0 font-mono text-[11px] font-medium text-emerald-500">+{it.adds}</span> : null}
        {typeof it.dels === 'number' && it.dels > 0 ? <span className="shrink-0 font-mono text-[11px] font-medium text-red-500">−{it.dels}</span> : null}
      </div>
    </li>
  );
}

function ActivityMessage({ text }) {
  return (
    <li className="flex gap-2">
      <Rail />
      <p className="min-w-0 flex-1 whitespace-pre-wrap break-words py-0.5 text-xs leading-relaxed text-foreground/80">{text}</p>
    </li>
  );
}

// Exported: the DESIGN chat uses the same presentation. Two chats narrating the
// same kind of work in two different ways is two things to learn, and the one
// with the poorer version reads as the poorer product — the design stage had a
// single muted line where the build stage had a timeline.
export function ActivityStream({ items = [], working = false }) {
  if (!items.length && !working) return null;
  return (
    <div className="overflow-hidden rounded-xl border bg-gradient-to-b from-muted/40 to-muted/10">
      <div className="flex items-center gap-1.5 border-b bg-muted/40 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin text-primary" /> Working
      </div>
      <ol className="m-0 list-none space-y-0.5 p-2">
        {items.map((it, i) => (
          it.type === 'message'
            ? <ActivityMessage key={`m${it.seq ?? i}`} text={it.text} />
            : <ActivityRow key={`t${it.seq ?? i}`} it={it} />
        ))}
        {working ? (
          <li className="flex gap-2">
            <Rail>
              <span className="relative z-10 mt-0.5 flex h-5 w-5 items-center justify-center rounded-full bg-background ring-1 ring-primary/40">
                <Loader2 className="h-3 w-3 animate-spin text-primary" />
              </span>
            </Rail>
            <span className="pt-1 text-xs text-muted-foreground">Working…</span>
          </li>
        ) : null}
      </ol>
    </div>
  );
}

export function ChatMessageList({
  scrollRef, messages = [], openIds, canEdit, answering, onAnswer,
  working = false, workingLabel = 'Working…', emptyLabel, projectId = null,
  partialText = null, onQuickUpdate = null, quickBusyId = null, activity = [],
}) {
  const open = openIds instanceof Set ? openIds : new Set(openIds || []);
  return (
    <div
      ref={scrollRef}
      // ONE size: fills its column but never grows past ~60vh on small screens
      // (the lg build layout is already height-constrained) — long chats
      // scroll inside the box, not the page.
      className="flex-1 min-h-[16rem] max-h-[60vh] lg:max-h-none space-y-2 overflow-y-auto rounded-lg border bg-background/40 p-3"
    >
      {messages.length === 0 && !partialText ? (
        <p className="text-sm text-muted-foreground text-center py-6">{emptyLabel}</p>
      ) : (
        messages.map((m) => (
          // id + kind stamped on each row so Build History can scroll to a
          // specific request, and the auto-scroll can target the last message.
          <div key={m.id} id={`bcmsg-${m.id}`} data-msg-kind={m.kind}>
            {m.kind === 'rule_question'
              ? <RuleQuestion m={m} open={open.has(m.question_id)} canEdit={canEdit} busy={answering} onAnswer={onAnswer} projectId={projectId} />
              : <ChatBubble m={m} projectId={projectId} onQuickUpdate={onQuickUpdate} quickBusyId={quickBusyId} />}
          </div>
        ))
      )}
      {working && partialText ? <StreamingBubble text={partialText} /> : null}
      {working && !partialText ? (
        activity.length ? (
          // Rich "what's being worked on" stream (file ops + narration).
          <ActivityStream items={activity} working />
        ) : (
          <div data-scroll-skip className="flex items-center gap-2 text-xs text-muted-foreground pl-1">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            {workingLabel}
          </div>
        )
      ) : null}
    </div>
  );
}
