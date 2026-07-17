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
import { Loader2, Zap, Hammer, HelpCircle, Rocket, RefreshCw } from 'lucide-react';
import { ChatMessageList } from './chat-messages';
import { useChatImages, ImageAttachmentBar } from './ImageAttachments';
import { toWireImages } from '@/lib/chat-images';
import { useTypingTracker } from '@/hooks/use-typing-tracker';

export default function BuildChat({ projectId, project, cycle = null, canEdit, online, active, job, needsFeedback = false, onStarted }) {
  const { toast } = useToast();
  const [data, setData] = useState(null);
  const [instruction, setInstruction] = useState('');
  const [busy, setBusy] = useState(false);
  const [answering, setAnswering] = useState(false);
  const [mode, setMode] = useState('build'); // 'build' (run a cycle) | 'ask' (question / read-and-run task, no build)
  const [deployingBase, setDeployingBase] = useState(false);
  const scrollRef = useRef(null);
  const onTyping = useTypingTracker(projectId, canEdit && online);
  const approvedAt = project?.design_approved_at || null;
  // Multi-modal: images pasted/dropped/picked ride the build instruction or the
  // ask — downscaled client-side before upload (lib/chat-images.js).
  const attach = useChatImages({ onError: (m) => toast({ variant: 'destructive', title: 'Image not attached', description: m }) });

  const load = useCallback(async () => {
    try { setData(await api.mock2GetChat(projectId)); }
    catch (err) { if (!(err instanceof ApiError)) console.error('load build chat failed:', err); }
  }, [projectId]);

  useEffect(() => { load(); }, [load]);

  // Poll while a build cycle is live, a rule question is open, or an ask is
  // being answered, so answers and transitions settle on their own. While an
  // ask is STREAMING (partial text arriving), poll faster so the live bubble
  // reads as a stream rather than paragraph jumps.
  const askJob = data?.ask_job || null;
  const askActive = !!askJob && !['done', 'failed'].includes(askJob.phase);
  const askPartial = askActive ? (askJob?.partial || null) : null;
  const openQuestionCount = (data?.open_question_ids || []).length;
  const projectOpenQuestions = Number(project?.open_editor_questions) || 0;
  const shouldPoll = active || askActive || openQuestionCount > 0 || projectOpenQuestions > 0;
  useEffect(() => {
    if (!shouldPoll) return undefined;
    const t = setInterval(load, askActive ? 900 : 2500);
    return () => clearInterval(t);
  }, [shouldPoll, askActive, load]);

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
  }, [data?.messages?.length, active, openQuestionKey, askPartial?.length]);

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

  // Base-app banner states: a deploy is RUNNING right now (base_app_deploying,
  // from the backend's in-flight guard — show progress, no button), or the app
  // never made it live and nothing is deploying (offer the one-tap retry that
  // repairs missing deps first). Hidden once anything serves.
  const baseAppDeploying = !!project?.base_app_deploying;
  const baseAppMissing = canEdit && online && !active
    && !baseAppDeploying
    && !project?.base_app_deployed_at
    && !['serving', 'deploying'].includes(project?.deploy_state);
  const deployBaseApp = async () => {
    setDeployingBase(true);
    try {
      await api.mock2DeployBaseApp(projectId);
      toast({ title: 'Deploying the base app…', description: 'Missing component dependencies are repaired first. The outcome lands in this chat.' });
      if (onStarted) onStarted();
      await load();
      // The next project refresh flips the banner to its "deploying" state
      // (base_app_deploying from the server); this local flag just bridges the
      // gap so the button can't be double-pressed meanwhile.
      setTimeout(() => setDeployingBase(false), 15000);
    } catch (err) {
      toast({ variant: 'destructive', title: 'Could not start the deploy', description: err.message });
      setDeployingBase(false);
    }
  };

  // buildMode: 'quick' is the default iteration path — one small scoped
  // change, minimal gates, straight to deploy; 'full' runs the audited build
  // (rule questions, whole gate battery); 'mvp' is the scaffold speed path.
  const startBuild = async (buildMode = 'quick') => {
    const body = instruction.trim();
    if (!body) return;
    setBusy(true);
    try {
      const res = await api.mock2StartCycle(projectId, body, toWireImages(attach.images), buildMode);
      if (res.refused) {
        toast({ variant: 'destructive', title: 'Build refused', description: res.reason || 'Quota exceeded.' });
      } else if (buildMode === 'quick') {
        toast({ title: 'Quick update started', description: 'One small scoped change — no gate battery, straight to deploy.' });
        setInstruction('');
        attach.clear();
      } else if (buildMode === 'mvp') {
        toast({ title: 'MVP build started', description: 'Skipping the rule interview — building a fast first testable version.' });
        setInstruction('');
        attach.clear();
      } else if (res.audit) {
        toast({ title: 'Auditing the build…', description: 'Checking the change against the rules and framework.' });
        setInstruction('');
        attach.clear();
      } else {
        toast({ title: 'Build started' });
        setInstruction('');
        attach.clear();
      }
      if (onStarted) onStarted();
      await load();
    } catch (err) {
      toast({ variant: 'destructive', title: 'Could not start the build', description: err.message });
    } finally { setBusy(false); }
  };

  // Ask mode: a question about the codebase or a bounded read-and-run task
  // ("run the tests", "curl the API with the stored credentials") — answered in
  // chat with NO build cycle. It takes the checkout lock while running, so it
  // waits its turn behind a live build.
  const startAsk = async () => {
    const body = instruction.trim();
    if (!body) return;
    setBusy(true);
    try {
      await api.mock2Ask(projectId, body, toWireImages(attach.images));
      setInstruction('');
      attach.clear();
      await load();
    } catch (err) {
      toast({ variant: 'destructive', title: 'Could not ask', description: err.message });
    } finally { setBusy(false); }
  };

  // When the cycle is blocked/awaiting an admin, the composer becomes the
  // resume-message input: what you type is carried into the resumed cycle as operator
  // guidance (bare resume — empty — is still allowed). Otherwise it starts a new cycle.
  const resumeMode = mode === 'build' && cycle?.status === 'awaiting_admin' && !needsFeedback;
  // Ask is deliberately NOT gated by the post-build rating (asking a question
  // shouldn't require rating the last build first) — but it does wait for a
  // running build/ask (the lock serializes writers anyway).
  const composerDisabled = mode === 'ask'
    ? (busy || askActive || active || !online)
    : (busy || (active && !resumeMode) || !online || needsFeedback);

  const sendResume = async () => {
    const body = instruction.trim();
    setBusy(true);
    try {
      await api.mock2RetryCycle(projectId, cycle.id, body ? { message: body } : null);
      toast({ title: 'Resuming the build', description: body ? 'Your message is included as guidance.' : undefined });
      setInstruction('');
      if (onStarted) onStarted();
      await load();
    } catch (err) {
      toast({ variant: 'destructive', title: 'Could not resume', description: err.message });
    } finally { setBusy(false); }
  };
  const submitComposer = () => (mode === 'ask' ? startAsk() : resumeMode ? sendResume() : startBuild());

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
          projectId={projectId}
          messages={messages}
          openIds={openIds}
          canEdit={canEdit}
          answering={answering}
          onAnswer={answerQuestion}
          working={active || askActive}
          workingLabel={askActive ? (askJob?.message || 'Answering…') : (job?.message || 'Building…')}
          partialText={askPartial}
          emptyLabel={online
            ? 'Describe a change below to run a build cycle, or switch to Ask to question the codebase / run a test. Rule questions and build events appear here.'
            : 'Bring the project online to run a build.'}
        />

        {baseAppMissing ? (
          <div className="shrink-0 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 flex flex-col sm:flex-row sm:items-center gap-2">
            <p className="text-xs text-amber-600 dark:text-amber-400 flex-1">
              The base app isn&apos;t live yet — the project URL is still serving the placeholder.
              Deploy it to get the sign-in and first-administrator pages.
            </p>
            <Button
              variant="outline" className="h-11 sm:h-10 shrink-0"
              disabled={deployingBase}
              onClick={deployBaseApp}
            >
              {deployingBase ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <RefreshCw className="h-4 w-4 mr-1" />}
              Deploy base app
            </Button>
          </div>
        ) : null}

        {canEdit ? (
          <div className="space-y-2 shrink-0">
            {needsFeedback && mode === 'build' ? (
              <p className="text-[11px] text-amber-500">Rate the last build (in the Build panel) to unlock the next change — or switch to Ask.</p>
            ) : null}
            <textarea
              className="flex min-h-[56px] w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-60"
              placeholder={online
                ? (mode === 'ask'
                  ? (askActive ? 'Answering — one ask at a time…'
                    : active ? 'A build is running — ask when it finishes…'
                      : 'Ask about the codebase or a bounded task, e.g. “Why does login 403?” or “Run the test suite” — nothing is built or changed')
                  : (needsFeedback ? 'Rate the last build to continue…'
                    : resumeMode ? 'The build is blocked — add context or an instruction for the resume (optional), then Resume…'
                      : active ? 'A build is running — wait for it to finish…'
                        : 'Describe a change to build, e.g. “Add a /health endpoint that returns 200 OK”'))
                : 'Project must be online.'}
              value={instruction}
              disabled={composerDisabled}
              onChange={(e) => { setInstruction(e.target.value); onTyping(); }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submitComposer(); }
              }}
              onPaste={attach.handlePaste}
              onDrop={attach.handleDrop}
              onDragOver={(e) => e.preventDefault()}
            />
            {/* Image attachments — paste or drop into the box above, or pick with
                "+". Not offered on a resume (the resume message carries no images). */}
            {!resumeMode ? (
              <ImageAttachmentBar
                images={attach.images} busy={attach.busy} disabled={composerDisabled}
                onPickFiles={attach.addFiles} onRemove={attach.remove}
              />
            ) : null}
            <div className="flex flex-wrap items-center justify-between gap-2">
              {/* Build ↔ Ask mode toggle: Build runs a full audited cycle; Ask
                  answers questions / runs bounded tasks with no build. */}
              <div className="inline-flex rounded-md border p-0.5" role="tablist" aria-label="Composer mode">
                <button
                  type="button" role="tab" aria-selected={mode === 'build'}
                  onClick={() => setMode('build')}
                  className={`inline-flex items-center gap-1 rounded px-2.5 py-1.5 text-xs font-medium ${mode === 'build' ? 'bg-muted text-foreground' : 'text-muted-foreground'}`}
                >
                  <Hammer className="h-3.5 w-3.5" /> Build
                </button>
                <button
                  type="button" role="tab" aria-selected={mode === 'ask'}
                  onClick={() => setMode('ask')}
                  className={`inline-flex items-center gap-1 rounded px-2.5 py-1.5 text-xs font-medium ${mode === 'ask' ? 'bg-muted text-foreground' : 'text-muted-foreground'}`}
                >
                  <HelpCircle className="h-3.5 w-3.5" /> Ask
                </button>
              </div>
              {/* Slower paths, still one tap away: MVP (scaffold) and the fully
                  audited Build. The primary action is the quick update. */}
              {mode === 'build' && !resumeMode ? (
                <>
                  <Button
                    variant="outline" className="h-11 sm:h-10 ml-auto"
                    disabled={composerDisabled || !instruction.trim()}
                    onClick={() => startBuild('mvp')}
                    title="Fast first version of a whole design: skips the rule interview and the spec/test gates"
                  >
                    <Rocket className="h-4 w-4 mr-1" /> MVP
                  </Button>
                  <Button
                    variant="outline" className="h-11 sm:h-10"
                    disabled={composerDisabled || !instruction.trim()}
                    onClick={() => startBuild('full')}
                    title="The audited build: rule questions, per-rule tests, the whole gate battery"
                  >
                    <Hammer className="h-4 w-4 mr-1" /> Full build
                  </Button>
                </>
              ) : null}
              <Button
                className={`h-11 sm:h-10 ${mode === 'build' && !resumeMode ? '' : 'ml-auto'}`}
                disabled={composerDisabled || (!resumeMode && !instruction.trim())}
                onClick={submitComposer}
                title={mode === 'build' && !resumeMode ? 'One small scoped change — no gate battery, straight to deploy' : undefined}
              >
                {busy ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : mode === 'ask' ? <HelpCircle className="h-4 w-4 mr-1" /> : <Zap className="h-4 w-4 mr-1" />}
                {mode === 'ask' ? 'Ask' : resumeMode ? 'Resume build' : 'Quick update'}
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
