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
import { Loader2, Zap, Hammer, HelpCircle, RefreshCw, StopCircle, X, Layers, Sparkles, History, Download, Eye } from 'lucide-react';
import AnnotateApp from './AnnotateApp';
import { ChatMessageList } from './chat-messages';
import { useChatImages, ImageAttachmentBar } from './ImageAttachments';
import { toWireImages } from '@/lib/chat-images';
import { useTypingTracker } from '@/hooks/use-typing-tracker';

// Client-side JSON download (no server round-trip), same pattern as the classic
// Change history. Used by Build History to save a build's full context.
function downloadJson(filename, obj) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function BuildChat({ projectId, project, cycle = null, canEdit, online, active, job, needsFeedback = false, buildQueue = [], activity = [], onStarted }) {
  const { toast } = useToast();
  const [data, setData] = useState(null);
  const [instruction, setInstruction] = useState('');
  const [busy, setBusy] = useState(false);
  const [answering, setAnswering] = useState(false);
  const [interrupting, setInterrupting] = useState(false);
  // The split-proposal card (route-time pre-pass): { instruction, parts } with
  // per-part include + group assignment edited locally before submit.
  const [splitPlan, setSplitPlan] = useState(null);
  const [splitBusy, setSplitBusy] = useState(false);
  // The suggestions card (project suggest_mode 'ask'): domain expectations the
  // pre-pass surfaced beyond the literal request — tick to include as binding
  // additions. { instruction, items: [{ text, include }] }.
  const [suggestPlan, setSuggestPlan] = useState(null);
  // 'off' | 'ask' | 'auto' — the project's suggestion handling, editable here.
  const [suggestMode, setSuggestMode] = useState(project?.suggest_mode || 'ask');
  useEffect(() => { if (project?.suggest_mode) setSuggestMode(project.suggest_mode); }, [project?.suggest_mode]);
  const [deployingBase, setDeployingBase] = useState(false);
  const scrollRef = useRef(null);
  // Auto-scroll cadence (item: land on the last message, but never fight the
  // user). interactedRef = the user scrolled up to read → pause auto-scroll
  // until they return to the bottom. lastUserMsgIdRef tracks the newest of
  // THEIR messages so a send re-arms auto-scroll and jumps to its bottom.
  const interactedRef = useRef(false);
  const lastUserMsgIdRef = useRef(null);
  const wasActiveRef = useRef(false);
  const [showHistory, setShowHistory] = useState(false);
  const [requests, setRequests] = useState([]);
  const [downloadingAll, setDownloadingAll] = useState(false);
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

  // The build requests (for Build History downloads). Refetched when the message
  // count changes (a new build/ask adds a request) so the list stays current.
  useEffect(() => {
    api.mock2ListRequests(projectId).then((r) => setRequests(r.requests || [])).catch(() => {});
  }, [projectId, data?.messages?.length]);

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

  // Track the user taking control of the scroll: a wheel/touch gesture pauses
  // auto-scroll; returning to the bottom re-arms it. A plain 'scroll' event is
  // NOT treated as intent (our own programmatic scroll fires it too) — only the
  // near-bottom check re-arms.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return undefined;
    const took = () => { interactedRef.current = true; };
    const onScroll = () => {
      const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
      if (nearBottom) interactedRef.current = false;
    };
    el.addEventListener('wheel', took, { passive: true });
    el.addEventListener('touchmove', took, { passive: true });
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      el.removeEventListener('wheel', took);
      el.removeEventListener('touchmove', took);
      el.removeEventListener('scroll', onScroll);
    };
  }, []);

  // Follow-the-build: while a cycle streams, stay pinned to the newest content
  // as it grows. A MutationObserver catches EVERY content change (activity rows,
  // narration, the streaming answer) — not just React deps — so a fast build is
  // followed smoothly. It disengages the moment the user scrolls up (interactedRef
  // via the wheel/touch listener above) and re-engages when they scroll back to
  // the bottom (the scroll listener clears interactedRef near the bottom).
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !(active || askActive)) return undefined;
    const follow = () => { if (!interactedRef.current) el.scrollTop = el.scrollHeight; };
    follow(); // snap on (re)engage
    const mo = new MutationObserver(follow);
    mo.observe(el, { childList: true, subtree: true, characterData: true });
    return () => mo.disconnect();
  }, [active, askActive]);

  // A new build starting re-engages follow — the operator wants to watch it,
  // even if they'd scrolled up to read during a previous cycle.
  useEffect(() => {
    if (active && !wasActiveRef.current) interactedRef.current = false;
    wasActiveRef.current = active;
  }, [active]);

  // Only the post-approval slice of the conversation belongs here (the design
  // conversation is archived in Details). Declared BEFORE the scroll effect
  // below, which reads the newest message — a forward reference here would TDZ.
  // created_at + design_approved_at are both ISO, so a lexical compare is correct.
  const messages = (data?.messages || [])
    .filter((m) => !approvedAt || !m.created_at || m.created_at >= approvedAt);

  // Scroll cadence: (1) open rule questions win — land on the first one. (2) When
  // the user just SENT a message, re-arm and scroll to the BOTTOM of their
  // message. (3) Otherwise, unless the user has scrolled up to read, land on the
  // TOP of the newest message so a long answer reads from its first line.
  const openQuestionKey = (data?.open_question_ids || []).join(',');
  const newestMsg = messages[messages.length - 1] || null;
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (openQuestionKey) {
      const firstOpen = el.querySelector('[data-open-question]');
      if (firstOpen) { firstOpen.scrollIntoView({ block: 'start' }); return; }
    }
    // The user sent a new message → follow it to the bottom and re-arm.
    if (newestMsg && newestMsg.kind === 'user' && newestMsg.id !== lastUserMsgIdRef.current) {
      lastUserMsgIdRef.current = newestMsg.id;
      interactedRef.current = false;
      el.scrollTop = el.scrollHeight;
      return;
    }
    // New assistant/build content: land on the top of the last message, unless
    // the user has scrolled up — then leave their view untouched.
    if (interactedRef.current) return;
    // While a build is live, the activity stream + narration grow at the bottom;
    // follow the BOTTOM so the newest line stays in view (VS Code / Claude-Code
    // feel), instead of pinning to the top of the last message.
    if (active) { el.scrollTop = el.scrollHeight; return; }
    const kids = [...el.children].filter((k) => !k.hasAttribute('data-scroll-skip'));
    const last = kids[kids.length - 1];
    if (last) el.scrollTop = Math.max(0, last.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop - 8);
  }, [data?.messages?.length, active, openQuestionKey, askPartial?.length, newestMsg?.id, newestMsg?.kind, activity.length, activity[activity.length - 1]?.seq]);

  const openIds = new Set(data?.open_question_ids || []);

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
  const startBuild = async (buildMode = 'quick', { skipSplit = false, skipSuggest = false, extras = null, textOverride = null, extraImages = null } = {}) => {
    const body = (textOverride ?? instruction).trim();
    if (!body) return;
    setBusy(true);
    try {
      const images = [...toWireImages(attach.images), ...(extraImages || [])];
      const res = await api.mock2StartCycle(projectId, body, images, buildMode, { skipSplit, skipSuggest, extras });
      if (res.split_proposal) {
        // Feature-scale ask that decomposes — show the grouping card; nothing
        // has started yet. Default: every part included, one group per part.
        setSplitPlan({
          instruction: res.split_proposal.instruction,
          parts: res.split_proposal.parts.map((pt, i) => ({ ...pt, include: true, group: i + 1 })),
        });
        setSuggestPlan(null);
        return;
      }
      if (res.suggest_proposal) {
        // Domain expectations beyond the literal ask (suggest_mode 'ask') —
        // show the additions card; nothing has started yet.
        setSuggestPlan({
          instruction: res.suggest_proposal.instruction,
          items: res.suggest_proposal.items.map((text) => ({ text, include: true })),
        });
        setSplitPlan(null);
        return;
      }
      if (res.queued) {
        toast({ title: 'Queued', description: 'A build is running — this update runs automatically when it finishes.' });
        setInstruction('');
        attach.clear();
        if (onStarted) onStarted();
        await load();
        return;
      }
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

  // ---- split-proposal card + build queue ----
  const submitSplitGroups = async () => {
    if (!splitPlan) return;
    const included = splitPlan.parts.filter((p) => p.include);
    if (!included.length) { setSplitPlan(null); return; }
    const byGroup = new Map();
    for (const p of included) {
      const g = Number(p.group) || 1;
      if (!byGroup.has(g)) byGroup.set(g, []);
      byGroup.get(g).push(p);
    }
    const groups = [...byGroup.entries()].sort((a, b) => a[0] - b[0]).map(([, parts]) => ({
      title: parts.map((p) => p.title).join(' + '),
      items: parts.flatMap((p) => p.items),
    }));
    setSplitBusy(true);
    try {
      await api.mock2BuildGroups(projectId, splitPlan.instruction, groups);
      toast({
        title: `Queued ${groups.length} build group${groups.length === 1 ? '' : 's'}`,
        description: 'They run back-to-back in the background — each deploys when it finishes, so you can check group 1 while group 2 builds.',
      });
      setSplitPlan(null);
      setInstruction('');
      attach.clear();
      if (onStarted) onStarted();
      await load();
    } catch (err) {
      toast({ variant: 'destructive', title: 'Could not queue the groups', description: err.message });
    } finally { setSplitBusy(false); }
  };
  const buildAsOne = async () => { setSplitPlan(null); await startBuild('quick', { skipSplit: true }); };

  // ---- suggestions card + mode toggle ----
  const submitSuggestions = async () => {
    if (!suggestPlan) return;
    const extras = suggestPlan.items.filter((i) => i.include).map((i) => i.text);
    setSuggestPlan(null);
    await startBuild('quick', { skipSuggest: true, extras: extras.length ? extras : null });
  };
  const buildAsAsked = async () => { setSuggestPlan(null); await startBuild('quick', { skipSuggest: true }); };
  // "Build this as a Quick update" on a chat bubble: the backend distills the
  // message into a well-formed prompt, the composer shows it, and it runs
  // through the NORMAL quick lane — split/suggestion cards and the queue all
  // apply to the composed prompt exactly as if the user typed it.
  const [distillingId, setDistillingId] = useState(null);
  const quickUpdateFromMessage = async (m) => {
    if (busy || distillingId) return;
    setDistillingId(m.id);
    try {
      const r = await api.mock2DistillPrompt(projectId, m.id);
      setInstruction(r.instruction);
      toast({ title: 'Prompt composed from the chat', description: 'Sending it as a Quick update…' });
      await startBuild('quick', { textOverride: r.instruction });
    } catch (err) {
      toast({ variant: 'destructive', title: 'Could not turn the message into a prompt', description: err.message });
    } finally { setDistillingId(null); }
  };

  // Annotate-on-screenshot: the dialog composes the pin list + burned-in image
  // and this sends it straight as a Quick update (cards skipped — a pin list
  // is already precise scope).
  // Annotating a composer ATTACHMENT (tap its thumbnail): index into
  // attach.images; the dialog hands back the pinned image + notes.
  const [annotateAttachIdx, setAnnotateAttachIdx] = useState(null);
  const applyAnnotation = ({ text, image, images }) => {
    const idx = annotateAttachIdx;
    setAnnotateAttachIdx(null);
    if (idx == null) return;
    const list = images?.length ? images : (image ? [image] : []);
    try {
      const files = list.map((im) => {
        const bytes = Uint8Array.from(atob(im.data), (c) => c.charCodeAt(0));
        return new File([bytes], im.name || 'annotated.png', { type: im.media_type || 'image/png' });
      });
      if (!files.length) return;
      // The first annotated image REPLACES the attachment it came from; any
      // further screens are additions, not replacements.
      if (typeof attach.replaceAt === 'function') attach.replaceAt(idx, files[0]);
      else { attach.remove(idx); attach.addFiles([files[0]]); }
      if (files.length > 1) attach.addFiles(files.slice(1));
    } catch { /* keep the original attachment on a decode failure */ }
    setInstruction((cur) => (cur && cur.trim() ? `${cur}\n${text}` : text));
  };
  // One annotated image per pinned screen — a multi-page annotation must not
  // arrive with only the first screen's picture attached to its instructions.
  const sendAnnotation = async ({ text, image, images }) => {
    const list = images?.length ? images : (image ? [image] : []);
    await startBuild('quick', { skipSplit: true, skipSuggest: true, textOverride: text, extraImages: list });
  };

  const saveSuggestMode = async (m) => {
    if (m === suggestMode) return;
    const prev = suggestMode;
    setSuggestMode(m);
    if (m !== 'ask') setSuggestPlan(null);
    try { await api.mock2SetSuggestMode(projectId, m); }
    catch (err) {
      setSuggestMode(prev);
      toast({ variant: 'destructive', title: 'Could not save the suggestion setting', description: err.message });
    }
  };
  const cancelQueued = async (qid) => {
    try { await api.mock2CancelQueuedBuild(projectId, qid); if (onStarted) onStarted(); }
    catch (err) { toast({ variant: 'destructive', title: 'Could not cancel', description: err.message }); }
  };

  // Ask: a question about the codebase or a bounded operational task ("run the
  // tests", "add user bob@example.com to the database", "curl the API with the
  // stored credentials") — answered in chat with NO build cycle and NO code
  // changes. It takes the checkout lock while running, so it waits its turn
  // behind a live build.
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
  const resumeMode = cycle?.status === 'awaiting_admin' && !needsFeedback;
  // The composer submits ONE drafted message two ways: Quick update (the
  // default — a small scoped code change) or Ask (question / operational
  // action, no code change). Ask is deliberately NOT gated by the post-build
  // rating (asking shouldn't require rating the last build first) — but both
  // wait for a running build/ask (the lock serializes writers anyway). Only
  // SENDING is gated; typing never is — draft the next instruction while a
  // build runs or the project comes online, and send when it unlocks.
  const askDisabled = busy || askActive || active || !online;
  // Quick sends are allowed WHILE a build runs — the server queues them and
  // they run back-to-back (build-queue). Only the post-build rating still
  // gates new work.
  const quickDisabled = busy || !online || needsFeedback;

  // Interrupt a running build: honored at the next step boundary — progress is
  // checkpointed, and the cycle can be resumed/continued from the Build panel.
  const interruptRequested = !!cycle?.interrupt_request;
  const interruptBuild = async () => {
    if (!cycle?.id) return;
    setInterrupting(true);
    try {
      await api.mock2InterruptCycle(projectId, cycle.id, 'stop_after_step');
      toast({ title: 'Interrupting the build', description: 'It stops at the next safe step — progress is checkpointed and can be continued.' });
      if (onStarted) onStarted();
      await load();
    } catch (err) {
      toast({ variant: 'destructive', title: 'Could not interrupt', description: err.message });
    } finally { setInterrupting(false); }
  };

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
  // Ctrl+Enter = the default action (Resume when blocked, else Quick update),
  // respecting the same gate as the buttons.
  const submitComposer = () => {
    if (quickDisabled) return;
    return resumeMode ? sendResume() : startBuild('quick');
  };

  // Build History — every request you've made (your instruction messages),
  // newest first. Clicking a card jumps the chat to that message.
  const buildRequests = messages.filter((m) => m.kind === 'user').slice().reverse();
  const scrollToMessage = (mid) => {
    const el = scrollRef.current;
    const target = el?.querySelector(`[id="bcmsg-${mid}"]`);
    if (target) { interactedRef.current = true; target.scrollIntoView({ block: 'start', behavior: 'smooth' }); }
    setShowHistory(false);
  };
  // The build REQUESTS (each a full build with its own context log). Matched to a
  // history message by instruction text so each card can download that build's
  // whole context (task + cycles + change records + events), like the classic
  // Change history download.
  const requestForMessage = (m) => requests.find((r) => (r.instruction || '').trim() === (m.body || '').trim()) || null;
  const downloadBuild = async (req) => {
    try {
      const log = await api.mock2GetRequestLog(projectId, req.id);
      downloadJson(`build-${req.id}.json`, log);
    } catch (err) { toast({ variant: 'destructive', title: 'Download failed', description: err.message }); }
  };
  const downloadAllBuilds = async () => {
    if (!requests.length) return;
    setDownloadingAll(true);
    try {
      const builds = [];
      for (const req of requests) {
        try { builds.push(await api.mock2GetRequestLog(projectId, req.id)); } catch { /* skip a failed one */ }
      }
      downloadJson(`build-history-project-${projectId}.json`, { project_id: projectId, count: builds.length, builds });
    } finally { setDownloadingAll(false); }
  };

  return (
    <Card className="flex flex-col min-h-[26rem] lg:min-h-0 lg:flex-1">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-base flex items-center gap-2">
            <Hammer className="h-4 w-4" /> Build chat
          </CardTitle>
          {buildRequests.length > 0 ? (
            <Button
              type="button" variant="outline" size="sm" className="h-8"
              aria-expanded={showHistory}
              onClick={() => setShowHistory((v) => !v)}
            >
              <History className="h-3.5 w-3.5 mr-1" /> Build History
              <span className="ml-1 text-[11px] text-muted-foreground">({buildRequests.length})</span>
            </Button>
          ) : null}
        </div>
      </CardHeader>
      {showHistory ? (
        <div className="mx-4 mb-2 rounded-lg border bg-background/60">
          <div className="flex items-center justify-between px-3 py-1.5 border-b">
            <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Build History</span>
            {requests.length > 0 ? (
              <button
                type="button" onClick={downloadAllBuilds} disabled={downloadingAll}
                className="inline-flex items-center gap-1 text-[11px] text-primary hover:underline disabled:opacity-50"
                title="Download the full context of every build as one file"
              >
                {downloadingAll ? <Loader2 className="h-3 w-3 animate-spin" /> : <Download className="h-3 w-3" />} Download all
              </button>
            ) : null}
          </div>
          <div className="max-h-56 overflow-y-auto divide-y">
            {buildRequests.map((m) => {
              const req = requestForMessage(m);
              return (
                <div key={m.id} className="flex items-stretch">
                  <button
                    type="button" onClick={() => scrollToMessage(m.id)}
                    className="flex-1 min-w-0 text-left px-3 py-2 hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:outline-none"
                  >
                    <span className="block text-xs font-medium truncate">{(m.body || '').trim() || '(no text)'}</span>
                    {m.created_at ? (
                      <span className="block text-[10px] text-muted-foreground mt-0.5">{new Date(m.created_at).toLocaleString()}</span>
                    ) : null}
                  </button>
                  {/* View — the same jump the row does, as an explicit icon.
                      On a phone "tap the row" is invisible next to the download
                      icon that IS visible, so the two actions now read as a
                      pair: eye = look at it here, arrow = take it away. */}
                  <button
                    type="button" onClick={() => scrollToMessage(m.id)}
                    className="shrink-0 w-11 md:w-9 flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted/60"
                    title="View this build in the chat"
                    aria-label="View this build in the chat"
                  >
                    <Eye className="h-4 w-4" />
                  </button>
                  {req ? (
                    <button
                      type="button" onClick={() => downloadBuild(req)}
                      className="shrink-0 w-11 md:w-9 flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted/60"
                      title="Download this build's full context (task, cycles, change records, events)"
                      aria-label="Download this build's context"
                    >
                      <Download className="h-4 w-4" />
                    </button>
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>
      ) : null}
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
          activity={active ? activity : []}
          onQuickUpdate={canEdit && online && !needsFeedback && !resumeMode ? quickUpdateFromMessage : null}
          quickBusyId={distillingId}
          emptyLabel={online
            ? 'Describe a change below and send it as a Quick update, or Ask a question / request an action (run a test, add a user). Rule questions and build events appear here.'
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
            {/* Split-proposal card — a feature-scale ask that decomposes: pick
                which parts to build, combine/reorder via group numbers, or run
                it all as one build. Nothing starts until you choose. */}
            {splitPlan ? (
              <div className="rounded-md border border-primary/30 bg-primary/5 p-3 space-y-2">
                <p className="flex items-center gap-1.5 text-xs font-medium">
                  <Layers className="h-3.5 w-3.5" /> This request has several deliverables — build in groups?
                </p>
                <p className="text-[11px] text-muted-foreground">
                  Groups build and deploy in order, in the background — check group 1 while group 2 builds.
                  Untick a part to skip it for now; change group numbers to combine or reorder.
                </p>
                {splitPlan.parts.map((pt, i) => (
                  <div key={i} className="flex items-start gap-2 rounded border bg-background/40 p-2">
                    <input
                      type="checkbox" className="mt-1 h-4 w-4 shrink-0 accent-primary" checked={pt.include}
                      onChange={() => setSplitPlan((cur) => ({ ...cur, parts: cur.parts.map((x, j) => (j === i ? { ...x, include: !x.include } : x)) }))}
                      aria-label={`Include "${pt.title}"`}
                    />
                    <div className="min-w-0 flex-1">
                      <p className="text-xs font-medium break-words">{pt.title}</p>
                      <p className="text-[11px] text-muted-foreground break-words">{pt.items.join('; ')}</p>
                    </div>
                    <select
                      className="h-9 shrink-0 rounded border bg-background px-1 text-xs"
                      value={pt.group} disabled={!pt.include}
                      onChange={(e) => setSplitPlan((cur) => ({ ...cur, parts: cur.parts.map((x, j) => (j === i ? { ...x, group: Number(e.target.value) } : x)) }))}
                      aria-label={`Build group for ${pt.title}`}
                    >
                      {splitPlan.parts.map((_, g) => <option key={g} value={g + 1}>Group {g + 1}</option>)}
                    </select>
                  </div>
                ))}
                <div className="flex flex-col gap-2 sm:flex-row">
                  <Button
                    className="min-h-[44px] flex-1"
                    disabled={splitBusy || !splitPlan.parts.some((p) => p.include)}
                    onClick={submitSplitGroups}
                  >
                    {splitBusy ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Layers className="h-4 w-4 mr-1" />}
                    Build {new Set(splitPlan.parts.filter((p) => p.include).map((p) => p.group)).size} group{new Set(splitPlan.parts.filter((p) => p.include).map((p) => p.group)).size === 1 ? '' : 's'} in background
                  </Button>
                  <Button variant="outline" className="min-h-[44px]" disabled={splitBusy} onClick={buildAsOne}>
                    Build as one
                  </Button>
                  <Button variant="ghost" className="min-h-[44px]" disabled={splitBusy} onClick={() => setSplitPlan(null)}>
                    Cancel
                  </Button>
                </div>
              </div>
            ) : null}
            {/* Suggestions card (suggest_mode 'ask') — domain expectations the
                pre-pass surfaced beyond the literal request. Ticked items become
                binding additions; untick to leave them out entirely. */}
            {suggestPlan ? (
              <div className="rounded-md border border-primary/30 bg-primary/5 p-3 space-y-2">
                <p className="flex items-center gap-1.5 text-xs font-medium">
                  <Sparkles className="h-3.5 w-3.5" /> An expert would probably expect these too — include any?
                </p>
                <p className="text-[11px] text-muted-foreground">
                  Ticked items are built as part of this update; unticked ones are simply left out.
                  The Suggestions toggle below switches this card off (build exactly what you type) or to Auto (always include everything).
                </p>
                {suggestPlan.items.map((it, i) => (
                  <label key={i} className="flex cursor-pointer items-start gap-2 rounded border bg-background/40 p-2">
                    <input
                      type="checkbox" className="mt-0.5 h-4 w-4 shrink-0 accent-primary" checked={it.include}
                      onChange={() => setSuggestPlan((cur) => ({ ...cur, items: cur.items.map((x, j) => (j === i ? { ...x, include: !x.include } : x)) }))}
                    />
                    <span className="min-w-0 flex-1 text-xs break-words">{it.text}</span>
                  </label>
                ))}
                <div className="flex flex-col gap-2 sm:flex-row">
                  <Button
                    className="min-h-[44px] flex-1"
                    disabled={busy || !suggestPlan.items.some((i) => i.include)}
                    onClick={submitSuggestions}
                  >
                    {busy ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Sparkles className="h-4 w-4 mr-1" />}
                    Build with {suggestPlan.items.filter((i) => i.include).length} addition{suggestPlan.items.filter((i) => i.include).length === 1 ? '' : 's'}
                  </Button>
                  <Button variant="outline" className="min-h-[44px]" disabled={busy} onClick={buildAsAsked}>
                    Build as asked
                  </Button>
                  <Button variant="ghost" className="min-h-[44px]" disabled={busy} onClick={() => setSuggestPlan(null)}>
                    Cancel
                  </Button>
                </div>
              </div>
            ) : null}
            {needsFeedback && !resumeMode ? (
              <p className="text-[11px] text-amber-500">Rate the last build (in the Build panel) to unlock the next update — Ask still works meanwhile.</p>
            ) : null}
            <textarea
              className="flex min-h-[56px] w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-60"
              placeholder={online
                ? (askActive ? 'Answering — draft your next message; send when this finishes…'
                  : resumeMode ? 'The build is blocked — add context or an instruction for the resume (optional), then Resume…'
                    : active ? 'A build is running — draft the next change or question; send when it finishes (or Interrupt it)…'
                      : needsFeedback ? 'Rate the last build (Build panel) to run the next update — Ask still works…'
                        : 'Describe a change (Quick update), or ask a question / request an action (Ask) — e.g. “Add a stats card” or “Add user bob@example.com as admin”')
                : 'Draft your instruction while the project comes online — sending unlocks when it’s ready.'}
              value={instruction}
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
                images={attach.images} busy={attach.busy} disabled={busy}
                onPickFiles={attach.addFiles} onRemove={attach.remove}
                onAnnotate={(i) => setAnnotateAttachIdx(i)}
              />
            ) : null}
            <div className="flex flex-wrap items-center justify-between gap-2">
              {/* Interrupt — visible while a build is running: stops it at the
                  next safe step (checkpointed, resumable from the Build panel). */}
              {active && cycle?.id ? (
                <Button
                  variant="outline"
                  className="h-11 sm:h-10 text-red-500 border-red-500/40 hover:text-red-500"
                  disabled={interrupting || interruptRequested}
                  onClick={interruptBuild}
                  title="Stop the running build at the next safe step — progress is checkpointed and can be continued"
                >
                  {interrupting ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <StopCircle className="h-4 w-4 mr-1" />}
                  {interruptRequested ? 'Interrupting…' : 'Interrupt'}
                </Button>
              ) : null}
              {resumeMode ? (
                <Button
                  className="h-11 sm:h-10 ml-auto"
                  disabled={quickDisabled}
                  onClick={sendResume}
                >
                  {busy ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Zap className="h-4 w-4 mr-1" />}
                  Resume build
                </Button>
              ) : (
                <>
                  {/* One drafted message, two ways to send it: Ask (question or
                      operational action — no code changes) and Quick update
                      (the default: one small scoped code change). The audited
                      Full build and the Production check live in the Build
                      panel on the left. To annotate the running app, use the
                      "Annotate" button on the Preview — pins there land on the
                      live signed-in app (and resolve to components). */}
                  <Button
                    variant="outline"
                    className="h-11 sm:h-10 ml-auto"
                    disabled={askDisabled || !instruction.trim()}
                    onClick={startAsk}
                    title="Ask a question or have the AI act on the running app — query or update data (e.g. add a user), run tests, call its APIs. No code changes."
                  >
                    <HelpCircle className="h-4 w-4 mr-1" /> Ask
                  </Button>
                  <Button
                    className="h-11 sm:h-10"
                    disabled={quickDisabled || !instruction.trim()}
                    onClick={() => startBuild('quick')}
                    title="One small scoped code change — no gate battery, straight to deploy (Ctrl+Enter)"
                  >
                    {busy ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Zap className="h-4 w-4 mr-1" />}
                    {active ? 'Queue update' : 'Quick update'}
                  </Button>
                </>
              )}
            </div>
            {/* The build queue — "building now / up next", each queued entry
                cancellable. Submissions while a build runs land here and run
                back-to-back automatically. */}
            {buildQueue.length ? (
              <div className="space-y-1">
                <p className="text-[11px] font-medium text-muted-foreground">Build queue</p>
                {buildQueue.map((q) => (
                  <div key={q.id} className="flex items-center gap-2 rounded border p-1.5 text-[11px]">
                    {q.status === 'started'
                      ? <Loader2 className="h-3 w-3 shrink-0 animate-spin text-sky-500" />
                      : <span className="h-2 w-2 shrink-0 rounded-full bg-muted-foreground/40" />}
                    <span className="min-w-0 flex-1 break-words">
                      {q.status === 'started' ? 'Building now: ' : 'Up next: '}
                      {q.label || q.instruction.slice(0, 120)}
                    </span>
                    {q.status === 'queued' ? (
                      <Button
                        variant="ghost" size="icon" className="h-8 w-8 shrink-0 text-red-500"
                        onClick={() => cancelQueued(q.id)} aria-label="Cancel this queued build"
                      >
                        <X className="h-3.5 w-3.5" />
                      </Button>
                    ) : null}
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground shrink-0">Viewers can follow the build; editors run cycles.</p>
        )}
      </CardContent>
      {/* Tap-to-pin feedback on a composer ATTACHMENT → a precise Quick update.
          Annotating the LIVE app now happens on the Preview ("Annotate"), which
          pins on the running signed-in app and resolves pins to components. */}
      {canEdit ? (
        <AnnotateApp
          projectId={projectId}
          open={annotateAttachIdx != null}
          onOpenChange={(o) => { if (!o) { setAnnotateAttachIdx(null); } }}
          onSend={sendAnnotation}
          attachImage={annotateAttachIdx != null && attach.images[annotateAttachIdx]
            ? { url: attach.images[annotateAttachIdx].previewUrl, name: attach.images[annotateAttachIdx].name, index: annotateAttachIdx }
            : null}
          onApply={applyAnnotation}
        />
      ) : null}
    </Card>
  );
}
