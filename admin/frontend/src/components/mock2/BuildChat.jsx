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
import {
  Loader2, Zap, Hammer, HelpCircle, Wand2, RefreshCw, StopCircle, X, Layers, Sparkles, History, Download, Eye,
  MonitorSmartphone, RotateCcw, GitCompare, ShieldAlert,
} from 'lucide-react';
import AnnotateApp from './AnnotateApp';
import BuildLogViewer from './BuildLogViewer';
import { ChatMessageList } from './chat-messages';
import { useChatImages, ImageAttachmentBar } from './ImageAttachments';
import ChangeHistory from './ChangeHistory';
import VerificationChecklist from './VerificationChecklist';
import { toWireImages } from '@/lib/chat-images';
import { parseFindings } from '@/lib/findings';
import FixFindingsDialog from './FixFindingsDialog';
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

// SpendBadge — the project's dollar spend, right next to the chat title so the
// money is visible where it is being spent. Click to rotate between the
// PROJECT TOTAL and TODAY (the current UTC day). Data is the same time-summary
// roll-up the Details spend card reads, refreshed when the live cycle's cost
// moves and on a slow heartbeat otherwise.
function SpendBadge({ projectId, cycleCostCents }) {
  const [usage, setUsage] = useState(null);
  const [mode, setMode] = useState('total'); // 'total' | 'today'

  const load = useCallback(async () => {
    try { setUsage((await api.mock2GetTimeSummary(projectId))?.usage || null); }
    catch { /* transient — keep the last figure */ }
  }, [projectId]);
  // cycleCostCents: reload as the running build spends, so the badge tracks it.
  useEffect(() => { load(); }, [load, cycleCostCents]);
  useEffect(() => { const t = setInterval(load, 30000); return () => clearInterval(t); }, [load]);

  if (!usage) return null;
  const cents = mode === 'today' ? (usage.today?.cost_cents || 0) : (usage.total_cost_cents || 0);
  return (
    <button
      type="button"
      onClick={() => setMode((m) => (m === 'total' ? 'today' : 'total'))}
      className="inline-flex h-11 sm:h-7 shrink-0 items-center gap-1 rounded-md border px-2 font-mono text-xs text-foreground hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      title="Project spend — click to switch between the project total and today"
      aria-label={`Spend ${mode === 'today' ? 'today' : 'total'}: $${(cents / 100).toFixed(2)} — click to switch`}
    >
      <span className="font-sans text-[10px] uppercase tracking-wide text-muted-foreground">{mode === 'today' ? 'Today' : 'Total'}</span>
      ${(cents / 100).toFixed(2)}
    </button>
  );
}

export default function BuildChat({
  projectId, project, cycle = null, canEdit, isAdmin = false, online, active, job, needsFeedback = false,
  buildQueue = [], activity = [], onStarted,
  // `fill` — the chat OWNS its box and scrolls internally (Flightdeck's
  // single-panel phone layout). Without it the card claims an intrinsic
  // 26rem, which on a 360x640 phone pushes the composer off screen and
  // makes the whole page scroll (operator report: "please fit everything
  // in screen").
  fill = false,
}) {
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
  const [clarifyPlan, setClarifyPlan] = useState(null);
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
  // A screen check / design options run is none of the three states above — it
  // is a browser driving the app for a minute or two with no cycle and no ask
  // job. So the chat stopped polling and the findings only appeared when the
  // operator refreshed the page by hand.
  //
  // THE FIRST FIX WAS CIRCULAR and did not work: it read the job off the CHAT
  // payload, which only refreshes when the poll below is already running, which
  // only happens when the job is visible. A check that starts after mount is
  // never seen, so the operator refreshes — the same report, twice.
  //
  // So the job is watched on its OWN heartbeat, independent of the chat poll.
  // It is a cheap read of an in-memory record, it works no matter who started
  // the run (this button, the auto-review after a build, another tab), and
  // seeing an active job is what turns the fast chat poll on.
  const [screenJob, setScreenJob] = useState(null);
  const screenActive = !!screenJob && !['done', 'failed'].includes(screenJob.phase);
  useEffect(() => {
    let stopped = false;
    let timer = null;
    const tick = async () => {
      let job = null;
      try { job = (await api.mock2ScreenJob(projectId))?.job || null; } catch { job = null; }
      if (stopped) return;
      setScreenJob(job);
      // Quick while something is happening, slow otherwise: an idle project
      // must not pay a two-second poll it will never use.
      const busyNow = !!job && !['done', 'failed'].includes(job.phase);
      timer = setTimeout(tick, busyNow ? 2000 : 6000);
    };
    tick();
    return () => { stopped = true; if (timer) clearTimeout(timer); };
  }, [projectId]);

  // When a run FINISHES, load once more: the findings message is inserted just
  // before the job is closed, so the poll that sees 'done' is the one that must
  // fetch it. Without this the messages arrive on the next heartbeat at best,
  // and not at all once polling stops.
  const prevScreenActive = useRef(false);
  useEffect(() => {
    if (prevScreenActive.current && !screenActive) {
      // Re-arm the follow: a capture takes two minutes and the operator has
      // very likely scrolled around in the meantime. The findings are what they
      // were waiting for, so land on them.
      interactedRef.current = false;
      load();
    }
    prevScreenActive.current = screenActive;
  }, [screenActive, load]);

  const shouldPoll = active || askActive || screenActive || openQuestionCount > 0 || projectOpenQuestions > 0;
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
    // TOP-ANCHORING IS FOR PROSE. It exists so a long Ask answer reads from its
    // first line. A SYSTEM note is not prose: the findings card ends in six
    // thumbnails and the Fix button, and landing on its top put every one of
    // them below the fold — "please auto scroll the chat to the bottom".
    if (newestMsg && newestMsg.kind !== 'assistant') { el.scrollTop = el.scrollHeight; return; }
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
  const startBuild = async (buildMode = 'quick', { skipSplit = false, skipSuggest = false, extras = null, textOverride = null, extraImages = null, escalate = false } = {}) => {
    const body = (textOverride ?? instruction).trim();
    if (!body) return;
    setBusy(true);
    try {
      const images = [...toWireImages(attach.images), ...(extraImages || [])];
      const res = await api.mock2StartCycle(projectId, body, images, buildMode, { skipSplit, skipSuggest, extras, escalate });
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
      if (res.clarify_proposal) {
        // Nothing started. The request had no outcome anyone could check, so
        // the choice comes back before the money is spent.
        setClarifyPlan({ ...res.clarify_proposal, mode: buildMode });
        setSplitPlan(null);
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

  // ---- clarifier card ----
  //
  // Pressing an option sends THAT option's instruction, not the original: the
  // whole point is that the original had no outcome anyone could check.
  // "Build it anyway" sends the original untouched and carries the declined
  // options along as labelled guesses.
  const takeClarifyOption = async (opt) => {
    if (!clarifyPlan) return;
    const mode = clarifyPlan.mode || 'quick';
    setClarifyPlan(null);
    setInstruction(opt.instruction);
    await startBuild(mode, { skipClarify: true, textOverride: opt.instruction });
  };
  const buildAnyway = async () => {
    if (!clarifyPlan) return;
    const plan = clarifyPlan;
    setClarifyPlan(null);
    await startBuild(plan.mode || 'quick', {
      skipClarify: true,
      textOverride: plan.instruction,
      clarifyGuesses: (plan.options || []).map((o) => ({ label: o.label, instruction: o.instruction })),
    });
  };
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

  // FIXING FINDINGS is not the same action as turning a chat message into a
  // prompt, and trying to reuse that path was a bug: distill-prompt only
  // accepts genuine Ask answers (assistant rows with no cycle), so pressing Fix
  // on a system note answered "Only Ask answers can be turned into a build
  // prompt" and did nothing.
  //
  // It should not have gone through there anyway. The dialog composes the
  // instruction from the findings the operator TICKED — unticking four of seven
  // is them saying something, and a distiller reading the whole message would
  // throw that away. Nothing to distil: the review already wrote a precise fix
  // for each finding, and they are carried verbatim.
  const [fixMessage, setFixMessage] = useState(null);
  const [fixBusyId, setFixBusyId] = useState(null);
  const sendFix = async ({ text, images }) => {
    if (!fixMessage || busy) return;
    setFixBusyId(fixMessage.id);
    try {
      setInstruction(text);
      setFixMessage(null);
      toast({ title: 'Fixing the findings', description: 'Running them as one Quick update…' });
      // skipSplit/skipSuggest: a ticked list of findings is already precise
      // scope, and asking the operator to re-group what they just grouped is
      // the second decision nobody wants.
      await startBuild('quick', { skipSplit: true, skipSuggest: true, textOverride: text, extraImages: images || [] });
    } catch (err) {
      toast({ variant: 'destructive', title: 'Could not start the build', description: err.message });
    } finally { setFixBusyId(null); }
  };

  // Annotate-on-screenshot: the dialog composes the pin list + burned-in image
  // and this sends it straight as a Quick update (cards skipped — a pin list
  // is already precise scope).
  // Annotating a composer ATTACHMENT (tap its thumbnail): index into
  // attach.images; the dialog hands back the pinned image + notes.
  const [annotateAttachIdx, setAnnotateAttachIdx] = useState(null);
  // Build History's eye icon: read the transcript in place. The ROW still jumps
  // to the build in the chat — the two affordances used to do the same thing.
  const [logRequest, setLogRequest] = useState(null);
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

  // Design options: for when the screen does not look right and you cannot say
  // why. The button opens a SCREEN PICKER — all screens (every route and every
  // in-route screen view, uncapped) or a chosen set — then runs the options
  // read on exactly that coverage. Typing the complaint ("this doesn't look
  // right") into the chat still triggers the same feature through Ask.
  //
  // Available with an EMPTY composer, unlike the other send actions: this is
  // the action for someone who has a feeling rather than an instruction.
  // Anything already drafted rides along as the complaint.
  const [optionsPicker, setOptionsPicker] = useState(null); // { mode:'all'|'pick', pages:[{path,include}], screens:[], loading }
  const [optionsBusy, setOptionsBusy] = useState(false);
  const openDesignOptions = async () => {
    setOptionsPicker({ mode: 'all', pages: [], screens: [], loading: true });
    try {
      const r = await api.mock2DesignOptionsScreens(projectId);
      // Routes first, then the in-page screen views ("/#note-detail") — the
      // views are what the operator is usually LOOKING AT (P48: the notes view
      // wasn't offered, only its route), so they are selectable like any page.
      setOptionsPicker((cur) => (cur ? {
        ...cur,
        loading: false,
        pages: [
          ...(r.pages || ['/']).map((p) => ({ path: p, include: false })),
          ...(r.views || []).map((v) => ({ path: v.key, include: false, view: true })),
        ],
        screens: r.screens || [],
      } : cur));
    } catch {
      setOptionsPicker((cur) => (cur ? { ...cur, loading: false, pages: [{ path: '/', include: false }] } : cur));
    }
  };
  const runDesignOptions = async () => {
    if (!optionsPicker) return;
    const all = optionsPicker.mode === 'all';
    const chosen = optionsPicker.pages.filter((p) => p.include).map((p) => p.path);
    if (!all && !chosen.length) return;
    setOptionsBusy(true);
    try {
      await api.mock2RunDesignOptions(projectId, {
        all,
        pages: all ? [] : chosen,
        complaint: instruction.trim(),
        images: toWireImages(attach.images),
      });
      toast({
        title: 'Design options running',
        description: all
          ? 'Screenshotting every screen (and every in-page screen view) — the layouts to choose from land in this chat.'
          : `Screenshotting ${chosen.length} screen${chosen.length === 1 ? '' : 's'} — the layouts to choose from land in this chat.`,
      });
      setOptionsPicker(null);
      setInstruction('');
      attach.clear();
      await load();
    } catch (err) {
      toast({ variant: 'destructive', title: 'Could not get design options', description: err.message });
    } finally { setOptionsBusy(false); }
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
  // The composer's two jobs are in tension on a phone: reading the conversation
  // wants every pixel, writing a change wants a real writing surface. So the box
  // GROWS with what is in it — one line at rest, up to a third of the viewport
  // while you type — instead of permanently reserving the tall version.
  const textareaRef = useRef(null);
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const cap = Math.max(120, Math.round((window.visualViewport?.height || window.innerHeight || 800) * 0.35));
    el.style.height = `${Math.min(el.scrollHeight, cap)}px`;
  }, [instruction]);

  // Is there anything to send? Text, an attached/pasted image, or an annotated
  // screenshot (pins arrive as an attachment). The send buttons are HIDDEN
  // until one of these is true rather than sitting there disabled — on a phone
  // that row is the difference between three visible chat messages and five,
  // and a permanently greyed-out button teaches nothing.
  const hasDraft = instruction.trim().length > 0 || attach.images.length > 0;

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

  // Screen check — the desktop/mobile screenshot pass, run from the chat and
  // reported INTO the chat. apply:false deliberately: this answers "how does it
  // actually look right now", it does not queue fixes. To get the fixes too,
  // ask "polish the design and fix the issues" — Ask routes that to the same
  // review with apply:true. The screenshots it takes are attached to the
  // findings message, so the critique can be checked against the pixels
  // instead of taken on trust.
  // Change history — the change records for this project, opened from the chat
  // rather than only from the classic Build panel. On a phone the chat IS the
  // build surface, so "what did the last build actually change" has to be
  // reachable from here.
  const [showChanges, setShowChanges] = useState(false);

  // Continue build — soft-retry a build that stopped. It resumes from the last
  // checkpoint / the working tree still in the container, so nothing is lost.
  // Same rule as the classic Build panel: any non-successful TERMINAL cycle,
  // excluding a soft pause (its own Resume block) and a failed deploy (its own
  // Retry deploy). Flightdeck on a phone had no way to reach this at all —
  // a build that stopped could only be continued from the desktop view.
  const FAILED_TERMINAL = ['failed', 'abandoned', 'refused_quota', 'interrupted'];
  const canContinue = !!cycle && canEdit && online && !active
    && cycle.deploy_status !== 'deploy_failed'
    && cycle.status !== 'paused'
    && (FAILED_TERMINAL.includes(cycle.status) || (cycle.status === 'awaiting_admin' && cycle.error));
  const [continuing, setContinuing] = useState(false);
  const continueBuild = async () => {
    if (!cycle) return;
    setContinuing(true);
    try {
      await api.mock2RetryCycle(projectId, cycle.id);
      toast({ title: 'Continuing the build', description: 'It resumes from the last checkpoint — nothing so far is lost.' });
      if (onStarted) onStarted();
      await load();
    } catch (err) {
      toast({ variant: 'destructive', title: 'Could not continue the build', description: err.message });
    } finally { setContinuing(false); }
  };

  const [screenCheckBusy, setScreenCheckBusy] = useState(false);
  const runScreenCheck = async () => {
    setScreenCheckBusy(true);
    try {
      await api.mock2Polish(projectId, { apply: false });
      toast({
        title: 'Screen check running',
        description: 'Screenshotting the app at mobile and desktop width — the findings and the shots land here in the chat.',
      });
    } catch (err) {
      toast({ variant: 'destructive', title: 'Could not start the screen check', description: err.message });
    } finally { setScreenCheckBusy(false); }
  };

  return (
    <Card className={`flex flex-col overflow-hidden ${fill ? 'h-full min-h-0 flex-1' : 'min-h-[26rem] lg:min-h-0 lg:flex-1'}`}>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-base flex items-center gap-2 min-w-0">
            <Hammer className="h-4 w-4 shrink-0" /> <span className="truncate">Build chat</span>
            <SpendBadge projectId={projectId} cycleCostCents={cycle?.used_cost_cents} />
          </CardTitle>
          {/* Icon-only at EVERY width (the mobile presentation): with labels the
              row overflowed the ~380px Flightdeck chat pane on desktop too. The
              title/aria-label carry the words. */}
          <div className="flex items-center gap-1.5">
          {/* Continue build — first, because when it is showing it is the only
              thing the operator wants. Primary styling: a stopped build is the
              one state where the next action is unambiguous. */}
          {canContinue ? (
            <Button
              type="button" size="sm" className="h-11 w-11 sm:h-8 sm:w-8 p-0"
              onClick={continueBuild} disabled={continuing}
              title="Continue the stopped build from its last checkpoint — nothing done so far is lost"
              aria-label="Continue build"
            >
              {continuing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}
            </Button>
          ) : null}
          {canEdit && online ? (
            <Button
              type="button" variant="outline" size="sm" className="h-11 w-11 sm:h-8 sm:w-8 p-0"
              onClick={runScreenCheck} disabled={screenCheckBusy || active}
              title="Screen check — screenshot the app at mobile and desktop width and review it against the approved design; findings and shots arrive in this chat"
              aria-label="Screen check"
            >
              {screenCheckBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <MonitorSmartphone className="h-3.5 w-3.5" />}
            </Button>
          ) : null}
          {/* Change history — what the builds actually changed, and the restore
              points. Next to Screen check because they answer the two halves of
              "what happened": how it looks, and what moved. */}
          <Button
            type="button" variant="outline" size="sm" className="h-11 w-11 sm:h-8 sm:w-8 p-0"
            aria-expanded={showChanges}
            onClick={() => setShowChanges((v) => !v)}
            title="Changes — the change records for this project: what each build changed, with restore points"
            aria-label="Changes"
          >
            <GitCompare className="h-3.5 w-3.5" />
          </Button>
          {buildRequests.length > 0 ? (
            <Button
              type="button" variant="outline" size="sm" className="h-11 sm:h-8 px-2"
              aria-expanded={showHistory}
              onClick={() => setShowHistory((v) => !v)}
              title="Build History — every request you've made, with transcripts and downloads"
              aria-label={`Build History (${buildRequests.length})`}
            >
              <History className="h-3.5 w-3.5" />
              <span className="ml-1 text-[11px] text-muted-foreground">{buildRequests.length}</span>
            </Button>
          ) : null}
          </div>
        </div>
      </CardHeader>
      {/* Parsed at the mount point rather than carried on the message, so the
          dialog and the card cannot disagree about what the findings are. */}
      <FixFindingsDialog
        open={!!fixMessage}
        onOpenChange={(v) => { if (!v) setFixMessage(null); }}
        findings={fixMessage ? parseFindings(String(fixMessage.body || '')).items : []}
        busy={fixBusyId != null || busy}
        onSend={sendFix}
      />
      {showChanges ? (
        <div className="mx-4 mb-2 max-h-[60vh] overflow-y-auto rounded-lg border bg-background/60 p-2">
          <ChangeHistory projectId={projectId} canRestore={canEdit && online && !active} />
        </div>
      ) : null}
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
                  {/* Three distinct actions, which is why all three are visible:
                      the ROW jumps to this build in the chat, the EYE opens its
                      transcript/change record here, the ARROW downloads it. */}
                  {req ? (
                    <button
                      type="button" onClick={() => setLogRequest({ id: req.id, title: (m.body || '').trim() || 'Build log' })}
                      className="shrink-0 w-11 md:w-9 flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted/60"
                      title="Read this build's transcript and change record"
                      aria-label="Read this build's transcript"
                    >
                      <Eye className="h-4 w-4" />
                    </button>
                  ) : null}
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
          working={active || askActive || screenActive}
          workingLabel={screenActive ? (screenJob?.message || 'Looking at the app…')
            : askActive ? (askJob?.message || 'Answering…') : (job?.message || 'Building…')}
          partialText={askPartial}
          activity={active ? activity : []}
          onQuickUpdate={canEdit && online && !needsFeedback && !resumeMode ? quickUpdateFromMessage : null}
          quickBusyId={distillingId}
          onFix={canEdit && online && !active && !needsFeedback && !resumeMode ? setFixMessage : null}
          fixBusyId={fixBusyId}
          emptyLabel={online
            ? 'Describe a change below and send it as a Quick update, or Ask a question / request an action (run a test, add a user). Rule questions and build events appear here.'
            : 'Bring the project online to run a build.'}
        />

        {/* Blocked build — say so IN the chat, loudly. The classic Build panel
            always showed this state, but Flightdeck has no Build panel, so a
            build waiting on an admin was invisible there: the composer quietly
            became a resume box and nothing said why. */}
        {cycle?.status === 'awaiting_admin' ? (
          <div className="shrink-0 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 space-y-1.5">
            <p className="flex items-center gap-1.5 text-xs font-medium text-amber-600 dark:text-amber-400">
              <ShieldAlert className="h-3.5 w-3.5 shrink-0" />
              Build blocked — {cycle.halt_reason
                ? 'the build reported it cannot proceed'
                : cycle.error
                  ? 'it stopped on an error'
                  : 'waiting on an admin decision (e.g. a framework deviation)'}
            </p>
            {/* The reason scrolls INSIDE the banner. A halt message can be
                paragraphs long, and unbounded it filled the phone screen and
                pushed the composer — the Resume control — clean off it
                (operator report: "blocked is stuck/can't scroll"). */}
            {cycle.error ? (
              <p className="max-h-32 sm:max-h-40 overflow-y-auto break-words text-xs text-amber-700 dark:text-amber-300">{String(cycle.error)}</p>
            ) : null}
            {/* Resume lives IN the banner, not only in the composer row below
                it — the way out must never depend on scrolling past the thing
                that is blocking you. */}
            {canEdit && online ? (
              <div className="flex flex-wrap items-center gap-2 pt-0.5">
                <Button size="sm" className="h-11 sm:h-8" disabled={busy} onClick={sendResume}>
                  {busy ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <Zap className="h-3.5 w-3.5 mr-1" />}
                  Resume build
                </Button>
                <span className="text-[11px] text-muted-foreground">
                  Optionally type guidance in the box below first — it rides the resume.
                </span>
              </div>
            ) : (
              <p className="text-[11px] text-muted-foreground">An editor or admin can resume it from here or the classic Build panel.</p>
            )}
          </div>
        ) : null}

        {/* PENDING VERIFICATION (P48): a build that completes with live checks
            outstanding used to be invisible here — the checklist rendered only
            in the classic Build panel, so on a phone (Flightdeck is the whole
            UI) the operator got a notification, found no button anywhere, and
            the queued next build sat "Up next" behind a state they could not
            see. The checklist renders nothing when no check is outstanding.
            `fill` only: the classic view already shows it in the Build panel. */}
        {fill && cycle?.status === 'awaiting_user' ? (
          <div className="shrink-0 max-h-[45vh] overflow-y-auto">
            <VerificationChecklist
              projectId={projectId} canEdit={canEdit} isAdmin={isAdmin} online={online}
              cycle={cycle} onRefresh={onStarted}
            />
          </div>
        ) : null}

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
            {clarifyPlan ? (
              <div className="rounded-md border border-primary/30 bg-primary/5 p-3 space-y-2">
                <p className="flex items-center gap-1.5 text-xs font-medium">
                  <HelpCircle className="h-3.5 w-3.5" /> Nothing built yet — which of these did you mean?
                </p>
                {clarifyPlan.diagnosis ? (
                  <p className="text-[11px] text-muted-foreground break-words">{clarifyPlan.diagnosis}</p>
                ) : null}
                {clarifyPlan.question ? (
                  <p className="text-xs font-medium break-words">{clarifyPlan.question}</p>
                ) : null}
                {/* PRESSED, not answered. The interview this replaces was
                    removed for asking eight questions; every option here is a
                    complete request that runs on one tap. */}
                {(clarifyPlan.options || []).map((o, i) => (
                  <button
                    key={i} type="button" disabled={busy}
                    onClick={() => takeClarifyOption(o)}
                    className="w-full rounded border bg-background/60 p-2 text-left hover:border-primary/50 disabled:opacity-50"
                  >
                    <span className="block text-xs font-medium">{o.label}</span>
                    <span className="mt-0.5 block break-words text-[11px] text-muted-foreground">{o.instruction}</span>
                    {o.checkable ? (
                      <span className="mt-1 block break-words text-[11px] text-primary">
                        You could then check: {o.checkable}
                      </span>
                    ) : null}
                  </button>
                ))}
                <div className="flex flex-col gap-2 sm:flex-row">
                  {/* First-class, never fine print: the operator may simply be
                      right, and a helper that makes overruling it feel like a
                      mistake is a gate. */}
                  <Button variant="outline" className="min-h-[44px] flex-1" disabled={busy} onClick={buildAnyway}>
                    Build it anyway
                  </Button>
                  <Button variant="ghost" className="min-h-[44px]" disabled={busy} onClick={() => setClarifyPlan(null)}>
                    Cancel
                  </Button>
                </div>
                <p className="text-[11px] text-muted-foreground">
                  {clarifyPlan.looked
                    ? `Read from ${clarifyPlan.looked} screenshot(s) of ${(clarifyPlan.pages || []).join(', ')}.`
                    : 'Read from your words alone — name a screen (like /admin) and it will look at it.'}
                  {' '}This only ever asks once per request.
                </p>
              </div>
            ) : null}

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
            {/* Design options screen picker — which screens should it look at?
                "All screens" is genuinely all of them: every route plus every
                in-page screen view (the button-switched panels), uncapped. */}
            {optionsPicker ? (
              <div className="rounded-md border border-primary/30 bg-primary/5 p-3 space-y-2">
                <p className="flex items-center gap-1.5 text-xs font-medium">
                  <Wand2 className="h-3.5 w-3.5" /> Design options — which screens should it look at?
                </p>
                <p className="text-[11px] text-muted-foreground">
                  It screenshots the chosen screens at phone and laptop width, then posts 2–3 layouts to choose
                  between — nothing changes until you press Build on one.
                  {instruction.trim() ? ' Your drafted text rides along as the complaint.' : ''}
                </p>
                <label className="flex cursor-pointer items-start gap-2 rounded border bg-background/40 p-2">
                  <input
                    type="radio" name="dopt-scope" className="mt-0.5 h-4 w-4 shrink-0 accent-primary"
                    checked={optionsPicker.mode === 'all'}
                    onChange={() => setOptionsPicker((c) => ({ ...c, mode: 'all' }))}
                  />
                  <span className="min-w-0 flex-1 text-xs">
                    <span className="font-medium">All screens</span>
                    <span className="block text-[11px] text-muted-foreground">
                      Every page{optionsPicker.pages.length ? ` (${optionsPicker.pages.length})` : ''} and every
                      in-page screen view — including the button-switched panels — with no cap.
                    </span>
                  </span>
                </label>
                <label className="flex cursor-pointer items-start gap-2 rounded border bg-background/40 p-2">
                  <input
                    type="radio" name="dopt-scope" className="mt-0.5 h-4 w-4 shrink-0 accent-primary"
                    checked={optionsPicker.mode === 'pick'}
                    onChange={() => setOptionsPicker((c) => ({ ...c, mode: 'pick' }))}
                  />
                  <span className="min-w-0 flex-1 text-xs">
                    <span className="font-medium">Only these screens</span>
                    <span className="block text-[11px] text-muted-foreground">Their in-page screen views are included automatically.</span>
                  </span>
                </label>
                {optionsPicker.mode === 'pick' ? (
                  optionsPicker.loading ? (
                    <p className="flex items-center gap-2 pl-1 text-[11px] text-muted-foreground"><Loader2 className="h-3 w-3 animate-spin" /> Listing the app&apos;s screens…</p>
                  ) : (
                    <div className="max-h-44 space-y-1 overflow-y-auto pl-1">
                      {optionsPicker.pages.map((p, i) => (
                        <label key={p.path} className="flex min-h-[36px] cursor-pointer items-center gap-2 text-xs">
                          <input
                            type="checkbox" className="h-4 w-4 shrink-0 accent-primary" checked={p.include}
                            onChange={() => setOptionsPicker((c) => ({ ...c, pages: c.pages.map((x, j) => (j === i ? { ...x, include: !x.include } : x)) }))}
                          />
                          <span className="font-mono break-all">{p.path}</span>
                          {p.view ? <span className="shrink-0 text-[10px] text-muted-foreground">screen view</span> : null}
                        </label>
                      ))}
                    </div>
                  )
                ) : null}
                {/* Only when the app exposed no selectable views — otherwise
                    the names are IN the list above as "/#…" entries. */}
                {optionsPicker.screens?.length && !optionsPicker.pages.some((p) => p.view) ? (
                  <p className="text-[11px] text-muted-foreground break-words">
                    Screen views the design defines (captured with their page): {optionsPicker.screens.join(', ')}.
                  </p>
                ) : null}
                <div className="flex flex-col gap-2 sm:flex-row">
                  <Button
                    className="min-h-[44px] flex-1"
                    disabled={optionsBusy || optionsPicker.loading || (optionsPicker.mode === 'pick' && !optionsPicker.pages.some((p) => p.include))}
                    onClick={runDesignOptions}
                  >
                    {optionsBusy ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Wand2 className="h-4 w-4 mr-1" />}
                    Get design options
                  </Button>
                  <Button variant="ghost" className="min-h-[44px]" disabled={optionsBusy} onClick={() => setOptionsPicker(null)}>
                    Cancel
                  </Button>
                </div>
              </div>
            ) : null}
            {needsFeedback && !resumeMode ? (
              <p className="text-[11px] text-amber-500">Rate the last build (in the Build panel) to unlock the next update — Ask still works meanwhile.</p>
            ) : null}
            <textarea
              ref={textareaRef}
              rows={1}
              className="flex min-h-[44px] w-full resize-none overflow-y-auto rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-60"
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
            {/* The action row exists only when it has something in it: an empty
                flex row still costs the parent's vertical gap, and on a phone
                that is a line of chat. */}
            {/* `online` is in this condition for Design options: it is the one
                action that needs no draft, and a button that only appears once
                you have typed something is no use to the person whose whole
                problem is not knowing what to type. */}
            {(active && cycle?.id) || resumeMode || hasDraft || online ? (
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
                  {/* One drafted message, two ways to send it: Ask (question,
                      operational action, or "polish this" / "review the design"
                      — no code changes) and Quick update (the default: one
                      small scoped code change). The audited Full build is the
                      only other lane and lives in the Build panel on the left.
                      To annotate the running app, use the "Annotate" button on
                      the Preview — pins there land on the live signed-in app
                      (and resolve to components). */}
                  {/* Design options is the third action here, and the only one
                      that needs no draft: it opens the screen picker (all
                      screens, or a chosen set), looks at the real screens, and
                      posts two or three layouts to choose between. Nothing
                      changes until you press Build on one of them.
                      Outline, not ghost: as a ghost it read as inert footer
                      text on desktop and operators never found it. */}
                  {/* Redo on the bigger model — for a result that is merely
                      UNSATISFYING (automatic escalation only fires on hard
                      failure). Re-runs the last build's exact instruction on
                      the escalation model at high effort. */}
                  {canEdit && cycle?.instruction && !active
                    && ['succeeded', 'failed', 'interrupted', 'abandoned'].includes(cycle.status) ? (
                    <Button
                      variant="ghost"
                      className="h-11 sm:h-10 ml-auto"
                      disabled={quickDisabled}
                      onClick={() => startBuild('quick', { textOverride: cycle.instruction, skipSplit: true, skipSuggest: true, escalate: true })}
                      title="Not satisfied with the last build? Re-run its exact request on the escalation model at high effort."
                    >
                      <RefreshCw className="h-4 w-4 mr-1" /> Redo, bigger model
                    </Button>
                  ) : null}
                  <Button
                    variant="outline"
                    className={`h-11 sm:h-10 ${canEdit && cycle?.instruction && !active && ['succeeded', 'failed', 'interrupted', 'abandoned'].includes(cycle.status) ? '' : 'ml-auto'}`}
                    disabled={askDisabled}
                    aria-expanded={!!optionsPicker}
                    onClick={() => (optionsPicker ? setOptionsPicker(null) : openDesignOptions())}
                    title={"When a screen does not look right and you cannot say why: pick which screens to look at (or all of them), and it screenshots the live app, measures it, and posts 2–3 named layouts with what each one changes. Nothing is applied until you press Build on one."}
                  >
                    <Wand2 className="h-4 w-4 mr-1" /> Design options
                  </Button>
                  {hasDraft ? (
                    <>
                      <Button
                        variant="outline"
                        className="h-11 sm:h-10"
                        disabled={askDisabled}
                        onClick={startAsk}
                        title="Ask a question or have the AI act on the running app — query or update data (e.g. add a user), run tests, call its APIs. No code changes."
                      >
                        <HelpCircle className="h-4 w-4 mr-1" /> Ask
                      </Button>
                      <Button
                        className="h-11 sm:h-10"
                        disabled={quickDisabled}
                        onClick={() => startBuild('quick')}
                        title="One small scoped code change — no gate battery, straight to deploy (Ctrl+Enter)"
                      >
                        {busy ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Zap className="h-4 w-4 mr-1" />}
                        {active ? 'Queue update' : 'Quick update'}
                      </Button>
                    </>
                  ) : null}
                </>
              )}
            </div>
            ) : null}
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
      {logRequest ? (
        <BuildLogViewer
          projectId={projectId}
          requestId={logRequest.id}
          title={logRequest.title}
          open={!!logRequest}
          onOpenChange={(o) => { if (!o) setLogRequest(null); }}
        />
      ) : null}
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
