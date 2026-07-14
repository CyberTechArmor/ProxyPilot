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
import { Loader2, CheckCircle2, HelpCircle } from 'lucide-react';
import ExplainThis from './ExplainThis';

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

export function ChatBubble({ m }) {
  if (m.kind === 'system') {
    return (
      <div className="flex justify-center">
        <p className="text-[11px] text-muted-foreground bg-muted/60 rounded-full px-3 py-1 max-w-[90%] text-center">
          {m.body}
        </p>
      </div>
    );
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
    <div className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[85%] rounded-2xl px-3 py-2 text-sm whitespace-pre-wrap break-words ${
          mine ? 'bg-primary text-primary-foreground rounded-br-sm' : 'bg-muted text-foreground rounded-bl-sm'
        }`}
      >
        {m.body}
        {m.acting_as_admin ? (
          <span className={`block mt-1 text-[10px] ${mine ? 'text-primary-foreground/70' : 'text-muted-foreground'}`}>
            (admin)
          </span>
        ) : null}
      </div>
    </div>
  );
}

// The scrollable message list shared by both chats: renders bubbles + inline
// rule questions, an optional working indicator, and an empty-state line. The
// caller owns fetching/polling and passes the scroll ref so it can keep the
// newest message in view.
export function ChatMessageList({
  scrollRef, messages = [], openIds, canEdit, answering, onAnswer,
  working = false, workingLabel = 'Working…', emptyLabel, projectId = null,
}) {
  const open = openIds instanceof Set ? openIds : new Set(openIds || []);
  return (
    <div
      ref={scrollRef}
      className="flex-1 min-h-0 space-y-2 overflow-y-auto rounded-lg border bg-background/40 p-3"
    >
      {messages.length === 0 ? (
        <p className="text-sm text-muted-foreground text-center py-6">{emptyLabel}</p>
      ) : (
        messages.map((m) => (
          m.kind === 'rule_question'
            ? <RuleQuestion key={m.id} m={m} open={open.has(m.question_id)} canEdit={canEdit} busy={answering} onAnswer={onAnswer} projectId={projectId} />
            : <ChatBubble key={m.id} m={m} />
        ))
      )}
      {working ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground pl-1">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          {workingLabel}
        </div>
      ) : null}
    </div>
  );
}
