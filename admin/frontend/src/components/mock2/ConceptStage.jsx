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
import {
  Loader2, Send, ExternalLink, CheckCircle2, Sparkles, MessageSquare, Lock,
} from 'lucide-react';

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

export default function ConceptStage({ projectId, project, canEdit, onApproved }) {
  const { toast } = useToast();
  const [data, setData] = useState(null); // { messages, job, stage, preview_url, current_mockup_id, concept_ready, ... }
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef(null);
  const wasApproved = useRef(!!project?.design_approved_at);

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

  // Poll while a background turn/approval job is running so replies + mockup
  // updates settle on their own.
  const jobActive = data?.job && !['done', 'approved', 'failed'].includes(data.job.phase);
  useEffect(() => {
    if (!jobActive) return undefined;
    const t = setInterval(load, 2500);
    return () => clearInterval(t);
  }, [jobActive, load]);

  // Keep the newest message in view.
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [data?.messages?.length, data?.job?.phase]);

  const stage = data?.stage || project?.stage;
  const approved = !!stage?.design_approved;
  const online = project?.lifecycle === 'active';
  const previewUrl = data?.preview_url || project?.preview_url || null;
  const hasMockup = !!(data?.current_mockup_id || project?.current_mockup_id);

  const send = async () => {
    const text = message.trim();
    if (!text) return;
    setBusy(true);
    try {
      const res = await api.mock2SendChatMessage(projectId, text);
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
    <Card>
      <CardHeader className="pb-3 space-y-3">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <CardTitle className="text-base flex items-center gap-2">
            <MessageSquare className="h-4 w-4" /> Concept
          </CardTitle>
          <StageIndicator stage={stage} />
        </div>
        <CardDescription>
          {approved
            ? 'The design is approved — the inventory is saved to the repository and Build is unlocked. This chat is the record of how you got here.'
            : 'Describe your app. A live, interactive mockup appears at the preview URL (new tab). Iterate here, then approve the design to lock it in and unlock Build.'}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Model-slot readiness (concept needs the concept_chat + mockup slots). */}
        {data && !data.concept_ready && !approved ? (
          <div className="flex items-start gap-2 p-3 rounded-lg bg-amber-500/10 text-amber-600 text-sm">
            <Lock className="h-4 w-4 mt-0.5 shrink-0" />
            <span>{data.concept_ready_reason || 'Concept model slots are not configured yet.'}</span>
          </div>
        ) : null}

        {/* Preview + approve controls */}
        <div className="flex flex-wrap gap-2">
          {previewUrl && hasMockup ? (
            <Button asChild variant="outline" size="sm" className="h-10">
              <a href={previewUrl} target="_blank" rel="noreferrer">
                <ExternalLink className="h-4 w-4 mr-1" /> Open mockup preview
              </a>
            </Button>
          ) : null}
          {canEdit && !approved && hasMockup && online ? (
            <Button size="sm" className="h-10" disabled={busy || jobActive} onClick={approve}>
              {jobActive && data?.job?.kind === 'approval'
                ? <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                : <CheckCircle2 className="h-4 w-4 mr-1" />}
              Approve design
            </Button>
          ) : null}
          {approved ? (
            <span className="inline-flex items-center gap-1 text-sm text-emerald-500">
              <CheckCircle2 className="h-4 w-4" /> Design approved
            </span>
          ) : null}
        </div>

        {/* Conversation */}
        <div
          ref={scrollRef}
          className="space-y-2 max-h-[24rem] overflow-y-auto rounded-lg border bg-background/40 p-3"
        >
          {(data?.messages || []).length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-6">
              {online
                ? 'No messages yet. Tell the design partner what you want to build.'
                : 'Bring the project online to start the conversation.'}
            </p>
          ) : (
            (data.messages || []).map((m) => <ChatBubble key={m.id} m={m} />)
          )}
          {jobActive ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground pl-1">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {data?.job?.message || 'Working…'}
            </div>
          ) : null}
        </div>

        {/* Composer (editors, online, before approval) */}
        {canEdit && !approved ? (
          <div className="space-y-2">
            <textarea
              className="flex min-h-[56px] w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-60"
              placeholder={online ? 'Describe a screen, a change, or ask a question…' : 'Project must be online to chat.'}
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
          <p className="text-sm text-muted-foreground flex items-center gap-1">
            <Sparkles className="h-4 w-4" /> Viewers can follow the conversation; editors drive the design.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
