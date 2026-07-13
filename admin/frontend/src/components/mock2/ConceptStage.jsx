// Mock2 Stage 1 (Concept) — chat, mockup preview, design approval (Phase M7).
//
// The first user-facing stage: a Builder describes an idea in this chat panel;
// the platform generates an interactive HTML mockup (constrained to the pinned
// framework's locked design system) served at the project's preview URL, opened
// in a new tab; iteration is conversational; and the only exit is the
// design-approval gesture, which extracts a structured inventory, discards the
// mockup, and unlocks Build.
//
// Polls the chat endpoint (whole-message updates, like the rest of the app) while
// a turn or approval job is in flight. A chat write takes the checkout lock
// server-side (ADR-004); the LockBanner in ProjectDetail surfaces the holder.
//
// MOBILE_FIRST: single column, stacked composer, 44px touch targets, the stage
// indicator wraps; renders clean at 360px.

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { useToast } from '@/hooks/use-toast';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Loader2, Send, ExternalLink, CheckCircle2, Sparkles, MessageSquare, Lock, HelpCircle,
  ClipboardList,
} from 'lucide-react';

// A rule_question body carries { question, choices } as JSON (M8, ADR-002).
// Tolerant of a plain-text body (older rows).
function parseRuleQuestion(body) {
  try {
    const j = JSON.parse(body);
    if (j && typeof j === 'object' && !Array.isArray(j)) {
      return { question: String(j.question || ''), choices: Array.isArray(j.choices) ? j.choices : [] };
    }
  } catch { /* plain text */ }
  return { question: String(body || ''), choices: [] };
}

const STAGE_LABELS = { concept: 'Concept', define: 'Define', build: 'Build', run: 'Run' };

// The persistent stage indicator (Concept → Define → Build → Run). The current
// stage is highlighted; earlier stages read as done. Derived server-side from
// design_approved_at (project-logic.conceptStageInfo) — one implementation.
function StageIndicator({ stage }) {
  const stages = stage?.stages || ['concept', 'define', 'build', 'run'];
  const currentIdx = Math.max(0, stages.indexOf(stage?.current || 'concept'));
  return (
    <div className="flex flex-wrap items-center gap-1.5" aria-label="Project stage">
      {stages.map((s, i) => {
        const done = i < currentIdx;
        const current = i === currentIdx;
        return (
          <span key={s} className="flex items-center gap-1.5">
            <span
              className={`inline-flex items-center gap-1 text-[11px] font-medium px-2 py-1 rounded-full whitespace-nowrap ${
                current ? 'bg-primary/15 text-primary'
                  : done ? 'bg-emerald-500/10 text-emerald-500'
                    : 'bg-muted text-muted-foreground'
              }`}
            >
              {done ? <CheckCircle2 className="h-3 w-3" /> : null}
              {STAGE_LABELS[s] || s}
            </span>
            {i < stages.length - 1 ? <span className="text-muted-foreground/40" aria-hidden>→</span> : null}
          </span>
        );
      })}
    </div>
  );
}

// A rule_question rendered in the chat: the plain-language question + tappable
// choices (≥44px) and a free-text escape hatch (ADR-002). Editors answer; the
// answer appends to state/rules.md and, when the last one is confirmed, Build
// starts automatically. Answered questions read as a compact confirmation.
function RuleQuestion({ m, open, canEdit, busy, onAnswer }) {
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
    <div className="flex justify-start">
      <div className="max-w-[92%] w-full rounded-xl border border-violet-500/30 bg-violet-500/5 px-3 py-2.5 space-y-2.5">
        <p className="flex items-center gap-1.5 text-[11px] font-medium text-violet-500">
          <HelpCircle className="h-3.5 w-3.5" /> Rule question — confirm to continue building
        </p>
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

function ChatBubble({ m }) {
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

export default function ConceptStage({ projectId, project, canEdit, onApproved, onMockupChanged }) {
  const { toast } = useToast();
  const [data, setData] = useState(null); // { messages, job, audit_job, stage, preview_url, open_question_ids, ... }
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [answering, setAnswering] = useState(false);
  const [mode, setMode] = useState('design'); // 'plan' | 'design' — directs the turn
  const scrollRef = useRef(null);
  const wasApproved = useRef(!!project?.design_approved_at);
  const lastMockupId = useRef(project?.current_mockup_id || null);

  const load = useCallback(async () => {
    try {
      const r = await api.mock2GetChat(projectId);
      setData(r);
      // When approval completes on the background job, refresh the parent project
      // so Build unlocks + the stage indicator advances everywhere.
      if (r?.stage?.design_approved && !wasApproved.current) {
        wasApproved.current = true;
        if (onApproved) onApproved();
      }
    } catch (err) {
      if (!(err instanceof ApiError)) console.error('load chat failed:', err);
    }
  }, [projectId, onApproved]);

  useEffect(() => { load(); }, [load]);

  // Poll while a background turn/approval job is running, while the M8 audit is
  // in flight, or while any rule question is open (so answers + the "starting the
  // build" transition settle on their own).
  const jobActive = data?.job && !['done', 'approved', 'failed'].includes(data.job.phase);
  const auditJob = data?.audit_job || null;
  const auditActive = !!auditJob && !['building', 'awaiting_user', 'awaiting_admin', 'failed', 'done'].includes(auditJob.phase);
  const openQuestionCount = (data?.open_question_ids || []).length;
  // A build cycle started AFTER design approval (from the Build-cycle panel, or
  // auto-started on approval) runs its audit outside this component. We stop
  // polling once the concept turn settles, so without this we'd never re-fetch
  // to surface the rule questions it raises — the parent's project count is the
  // durable signal that pulls us back in (it refreshes from the cycle's own poll)
  // so the questions appear here with their inline answer controls.
  const projectOpenQuestions = Number(project?.open_editor_questions) || 0;
  const shouldPoll = jobActive || auditActive || openQuestionCount > 0 || projectOpenQuestions > 0;
  useEffect(() => {
    if (!shouldPoll) return undefined;
    const t = setInterval(load, 2500);
    return () => clearInterval(t);
  }, [shouldPoll, load]);

  const openIds = new Set(data?.open_question_ids || []);

  const answerQuestion = async (questionId, answer) => {
    if (!questionId || !answer) return;
    setAnswering(true);
    try {
      const res = await api.mock2AnswerQuestion(projectId, questionId, answer);
      if (res.resumed) toast({ title: 'All rules confirmed', description: 'Starting the build.' });
      else toast({ title: 'Rule confirmed' });
      await load();
    } catch (err) {
      toast({ variant: 'destructive', title: 'Could not confirm', description: err.message });
    } finally {
      setAnswering(false);
    }
  };

  // Keep the newest message in view.
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [data?.messages?.length, data?.job?.phase]);

  const stage = data?.stage || project?.stage;
  const approved = !!stage?.design_approved;
  const online = project?.lifecycle === 'active';
  const previewUrl = data?.preview_url || project?.preview_url || null;
  const hasMockup = !!(data?.current_mockup_id || project?.current_mockup_id);

  // The mockup preview is owned by the parent (ProjectDetail), but WE are the
  // one polling the chat, so we're the first to learn a new mockup was rendered
  // (or discarded on approval). The preview URL is a stable path — same URL, new
  // content — so tell the parent to reload the project (surfacing preview_url the
  // first time) and remount the iframe. Fires only on an actual id transition.
  useEffect(() => {
    if (!data) return; // wait for the first chat load before comparing
    const mockupId = data.current_mockup_id ?? null;
    if (mockupId !== lastMockupId.current) {
      lastMockupId.current = mockupId;
      if (onMockupChanged) onMockupChanged(mockupId);
    }
  }, [data, onMockupChanged]);

  const send = async () => {
    const text = message.trim();
    if (!text) return;
    setBusy(true);
    try {
      const res = await api.mock2SendChatMessage(projectId, text, mode);
      if (res.refused) {
        toast({ variant: 'destructive', title: 'Message not processed', description: res.reason || 'Quota exceeded.' });
      } else {
        setMessage('');
      }
      await load();
    } catch (err) {
      toast({ variant: 'destructive', title: 'Could not send', description: err.message });
    } finally {
      setBusy(false);
    }
  };

  const approve = async () => {
    setBusy(true);
    try {
      await api.mock2ApproveDesign(projectId);
      toast({ title: 'Approving design…', description: 'Extracting the design inventory and unlocking Build.' });
      await load();
    } catch (err) {
      toast({ variant: 'destructive', title: 'Could not approve', description: err.message });
    } finally {
      setBusy(false);
    }
  };

  const composerDisabled = busy || jobActive || !online || approved;

  return (
    <Card className="flex flex-col min-h-[26rem] lg:min-h-0 lg:flex-1">
      <CardContent className="flex flex-1 min-h-0 flex-col gap-3 pt-6">
        {/* Model-slot readiness (concept needs the concept_chat + mockup slots). */}
        {data && !data.concept_ready && !approved ? (
          <div className="flex items-start gap-2 p-3 rounded-lg bg-amber-500/10 text-amber-600 text-sm shrink-0">
            <Lock className="h-4 w-4 mt-0.5 shrink-0" />
            <span>{data.concept_ready_reason || 'Concept model slots are not configured yet.'}</span>
          </div>
        ) : null}

        {/* Plan vs Design — above the chat. Plan talks through the idea without
            touching the mockup; Design generates/iterates it. */}
        {canEdit && !approved ? (
          <div className="inline-flex self-start rounded-md border p-0.5 shrink-0" role="tablist" aria-label="Conversation mode">
            <button
              type="button" role="tab" aria-selected={mode === 'plan'} title="Plan — think through the idea without changing the mockup"
              onClick={() => setMode('plan')}
              className={`inline-flex items-center gap-1 rounded px-2.5 py-1.5 text-xs font-medium ${mode === 'plan' ? 'bg-muted text-foreground' : 'text-muted-foreground'}`}
            >
              <ClipboardList className="h-3.5 w-3.5" /> Plan
            </button>
            <button
              type="button" role="tab" aria-selected={mode === 'design'} title="Design — generate and iterate the mockup"
              onClick={() => setMode('design')}
              className={`inline-flex items-center gap-1 rounded px-2.5 py-1.5 text-xs font-medium ${mode === 'design' ? 'bg-muted text-foreground' : 'text-muted-foreground'}`}
            >
              <Sparkles className="h-3.5 w-3.5" /> Design
            </button>
          </div>
        ) : null}

        {/* Conversation — grows to fill the available height */}
        <div
          ref={scrollRef}
          className="flex-1 min-h-0 space-y-2 overflow-y-auto rounded-lg border bg-background/40 p-3"
        >
          {(data?.messages || []).length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-6">
              {online
                ? 'No messages yet. Tell the design partner what you want to build.'
                : 'Bring the project online to start the conversation.'}
            </p>
          ) : (
            (data.messages || []).map((m) => (
              m.kind === 'rule_question'
                ? <RuleQuestion key={m.id} m={m} open={openIds.has(m.question_id)} canEdit={canEdit} busy={answering} onAnswer={answerQuestion} />
                : <ChatBubble key={m.id} m={m} />
            ))
          )}
          {jobActive || auditActive ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground pl-1">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {data?.job?.message || auditJob?.message || 'Working…'}
            </div>
          ) : null}
        </div>

        {/* Composer (editors, online, before approval) */}
        {canEdit && !approved ? (
          <div className="space-y-2 shrink-0">
            <textarea
              className="flex min-h-[56px] w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-60"
              placeholder={online
                ? (mode === 'plan' ? 'Think through what you want to build…' : 'Describe a screen, a change, or ask a question…')
                : 'Project must be online to chat.'}
              value={message}
              disabled={composerDisabled}
              onChange={(e) => setMessage(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); }
              }}
            />
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] text-muted-foreground hidden sm:block">⌘/Ctrl+Enter to send</span>
              <Button className="h-11 sm:h-10 ml-auto" disabled={composerDisabled || !message.trim()} onClick={send}>
                {busy ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Send className="h-4 w-4 mr-1" />}
                Send
              </Button>
            </div>
          </div>
        ) : !canEdit && !approved ? (
          <p className="text-sm text-muted-foreground flex items-center gap-1 shrink-0">
            <Sparkles className="h-4 w-4" /> Viewers can follow the conversation; editors drive the design.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
