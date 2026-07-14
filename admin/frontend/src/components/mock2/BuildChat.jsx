// BuildChat — the post-approval build/run/maintenance chat (right column in
// build mode).
//
// It reuses the project's one message stream (mock2GetChat) but shows only the
// part from design approval onward: the change requests you type, the rule
// questions a build audit raises (answered inline), and the system events a
// cycle emits. The composer starts a BUILD CYCLE (mock2StartCycle), not a design
// turn — the design conversation that preceded approval lives read-only in the
// Details tab. The live build progress itself is the task list on the left.
//
// MOBILE_FIRST: single column, stacked composer, 44px targets; clean at 360px.

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { useToast } from '@/hooks/use-toast';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Loader2, Zap, Hammer } from 'lucide-react';
import { ChatMessageList } from './chat-messages';
import { useTypingTracker } from '@/hooks/use-typing-tracker';

export default function BuildChat({ projectId, project, canEdit, online, active, job, needsFeedback = false, onStarted }) {
  const { toast } = useToast();
  const [data, setData] = useState(null);
  const [instruction, setInstruction] = useState('');
  const [busy, setBusy] = useState(false);
  const [answering, setAnswering] = useState(false);
  const scrollRef = useRef(null);
  const onTyping = useTypingTracker(projectId, canEdit && online);
  const approvedAt = project?.design_approved_at || null;

  const load = useCallback(async () => {
    try { setData(await api.mock2GetChat(projectId)); }
    catch (err) { if (!(err instanceof ApiError)) console.error('load build chat failed:', err); }
  }, [projectId]);

  useEffect(() => { load(); }, [load]);

  // Poll while a build cycle is live or a rule question is open, so answers and
  // the "starting the build" transitions settle on their own.
  const openQuestionCount = (data?.open_question_ids || []).length;
  const projectOpenQuestions = Number(project?.open_editor_questions) || 0;
  const shouldPoll = active || openQuestionCount > 0 || projectOpenQuestions > 0;
  useEffect(() => {
    if (!shouldPoll) return undefined;
    const t = setInterval(load, 2500);
    return () => clearInterval(t);
  }, [shouldPoll, load]);

  // Land on the work, not the bottom: while rule questions are open, bring the
  // first still-open one into view (answering one then lands on the next); once
  // none are open, fall back to keeping the newest message in view. Keyed on the
  // open-question set so it re-runs as each question is confirmed.
  const openQuestionKey = (data?.open_question_ids || []).join(',');
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (openQuestionKey) {
      const firstOpen = el.querySelector('[data-open-question]');
      if (firstOpen) { firstOpen.scrollIntoView({ block: 'start' }); return; }
    }
    el.scrollTop = el.scrollHeight;
  }, [data?.messages?.length, active, openQuestionKey]);

  const openIds = new Set(data?.open_question_ids || []);
  // Only the post-approval slice of the conversation belongs here (the design
  // conversation is archived in Details). created_at + design_approved_at are
  // both ISO from nowIso(), so a lexical compare is correct.
  const messages = (data?.messages || [])
    .filter((m) => !approvedAt || !m.created_at || m.created_at >= approvedAt);

  const answerQuestion = async (questionId, answer) => {
    if (!questionId || !answer) return;
    setAnswering(true);
    try {
      const res = await api.mock2AnswerQuestion(projectId, questionId, answer);
      if (res.resumed) toast({ title: 'All rules confirmed', description: 'Starting the build.' });
      else toast({ title: 'Rule confirmed' });
      if (onStarted) onStarted();
      await load();
    } catch (err) {
      toast({ variant: 'destructive', title: 'Could not confirm', description: err.message });
    } finally {
      setAnswering(false);
    }
  };

  const startBuild = async () => {
    const body = instruction.trim();
    if (!body) return;
    setBusy(true);
    try {
      const res = await api.mock2StartCycle(projectId, body);
      if (res.refused) {
        toast({ variant: 'destructive', title: 'Build refused', description: res.reason || 'Quota exceeded.' });
      } else if (res.audit) {
        toast({ title: 'Auditing the build…', description: 'Checking the change against the rules and framework.' });
        setInstruction('');
      } else {
        toast({ title: 'Build started' });
        setInstruction('');
      }
      if (onStarted) onStarted();
      await load();
    } catch (err) {
      toast({ variant: 'destructive', title: 'Could not start the build', description: err.message });
    } finally { setBusy(false); }
  };

  const composerDisabled = busy || active || !online || needsFeedback;

  return (
    <Card className="flex flex-col min-h-[26rem] lg:min-h-0 lg:flex-1">
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2">
          <Hammer className="h-4 w-4" /> Build chat
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-1 min-h-0 flex-col gap-3">
        <ChatMessageList
          scrollRef={scrollRef}
          messages={messages}
          openIds={openIds}
          canEdit={canEdit}
          answering={answering}
          onAnswer={answerQuestion}
          working={active}
          workingLabel={job?.message || 'Building…'}
          emptyLabel={online
            ? 'Describe a change below to run a build cycle. Rule questions and build events appear here.'
            : 'Bring the project online to run a build.'}
        />

        {canEdit ? (
          <div className="space-y-2 shrink-0">
            {needsFeedback ? (
              <p className="text-[11px] text-amber-500">Rate the last build (in the Build panel) to unlock the next change.</p>
            ) : null}
            <textarea
              className="flex min-h-[56px] w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-60"
              placeholder={online
                ? (needsFeedback ? 'Rate the last build to continue…' : active ? 'A build is running — wait for it to finish…' : 'Describe a change to build, e.g. “Add a /health endpoint that returns 200 OK”')
                : 'Project must be online to run a build.'}
              value={instruction}
              disabled={composerDisabled}
              onChange={(e) => { setInstruction(e.target.value); onTyping(); }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); startBuild(); }
              }}
            />
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] text-muted-foreground hidden sm:block">⌘/Ctrl+Enter to run</span>
              <Button className="h-11 sm:h-10 ml-auto" disabled={composerDisabled || !instruction.trim()} onClick={startBuild}>
                {busy ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Zap className="h-4 w-4 mr-1" />}
                Run a cycle
              </Button>
            </div>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground shrink-0">Viewers can follow the build; editors run cycles.</p>
        )}
      </CardContent>
    </Card>
  );
}
