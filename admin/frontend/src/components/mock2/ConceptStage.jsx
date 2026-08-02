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
import { Label } from '@/components/ui/label';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  Loader2, Send, CheckCircle2, Sparkles, Lock, ClipboardList, Download, FileUp, FolderGit2,
  ChevronDown, ChevronUp, Rocket, X, Clock3, Library, ImagePlus,
} from 'lucide-react';
import { SetupProgress } from './ProjectPreview';
import ProjectAssets from './ProjectAssets';
import ChatModeToggle from './ChatModeToggle';
import { ChatBubble, RuleQuestion, StreamingBubble, ActivityStream } from './chat-messages';
import { useChatImages, ImageAttachmentBar } from './ImageAttachments';
import { toWireImages } from '@/lib/chat-images';
import { uploadReferenceFiles } from '@/lib/reference-uploads';
import { useTypingTracker } from '@/hooks/use-typing-tracker';

const STAGE_LABELS = { concept: 'Concept', define: 'Define', build: 'Build', run: 'Run' };

// What "Accept plan" sends, as a design turn: the plan conversation is already
// in the same message stream, so the prompt only needs to say "go".
const ACCEPT_PLAN_PROMPT = 'I accept the plan we worked out above. Turn it into the design: '
  + 'generate the first mockup that implements the plan.';

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

// `fill` — render as a panel that takes exactly its parent's height (the phone
// workspace) instead of sizing to its content. Off everywhere else, so the
// stacked desktop/tablet layouts keep the growth behaviour they were tuned for.
// Two narration lines are "the same step" when they differ only in their
// numbers — the elapsed seconds and character counts that tick during a render
// ("(29k characters)", "(18s — …)"). Those refresh their row in place; every
// OTHER wording is its own step and gets its own persisted row, so the design
// chat builds the same step-by-step timeline the build chat shows instead of
// one line that keeps rewriting itself (operator request).
function narrationStem(t) {
  return String(t || '').replace(/\d+/g, '#').trim().toLowerCase();
}

export default function ConceptStage({
  projectId, project, canEdit, onApproved, onMockupChanged, archived = false, fill = false,
  provLog = null, provMessage = null, onOpenAssets = null,
  // Conversation mode (Plan/Design/Build) — controlled by the parent when it
  // owns the toggle across stages (ProjectDetail), self-owned otherwise (the
  // phone MockupWorkspace, the read-only archive).
  mode: modeProp = null, onModeChange = null,
}) {
  const { toast } = useToast();
  const [data, setData] = useState(null); // { messages, job, audit_job, stage, preview_url, open_question_ids, ... }
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [answering, setAnswering] = useState(false);
  // A fresh project starts in Plan — talk the idea through first; Design is one
  // tap away. A project that already has a mockup is mid-design, so it opens
  // there instead.
  const [ownMode, setOwnMode] = useState(project?.current_mockup_id ? 'design' : 'plan');
  const mode = modeProp === 'plan' || modeProp === 'design' ? modeProp : ownMode;
  const setMode = useCallback((m) => {
    setOwnMode(m);
    if (onModeChange) onModeChange(m);
  }, [onModeChange]);
  // Design direction for design-mode turns: 'theme' binds the project's chosen
  // preset; 'explore' lets the AI design freely ("let the AI decide" — thinking
  // on, high effort; adopted only if approved). No longer a per-turn toggle:
  // the direction FOLLOWS the project's mandatory design choice (the popup) —
  // a chosen preset → 'theme', the AI option → 'explore'.
  const [designDirection, setDesignDirection] = useState(
    project?.design_preset === 'ai' ? 'explore' : 'theme',
  );
  // The mandatory design choice: before anything is submitted in the design
  // chat (Skip mockup excepted), the Builder picks one of the saved design
  // presets or "Let the AI decide" from a popup. Persisted on the project
  // (design_choice_at), so a project that chose is never re-asked.
  const [designChosen, setDesignChosen] = useState(!!project?.design_choice_at);
  const [designChoiceOpen, setDesignChoiceOpen] = useState(false);
  const [designPresets, setDesignPresets] = useState(null); // null = not loaded
  const [choosingDesign, setChoosingDesign] = useState(false);
  useEffect(() => {
    if (project?.design_choice_at) {
      setDesignChosen(true);
      setDesignDirection(project?.design_preset === 'ai' ? 'explore' : 'theme');
    }
  }, [project?.design_choice_at, project?.design_preset]);
  const openDesignChoice = useCallback(() => {
    setDesignChoiceOpen(true);
    if (designPresets == null) {
      api.mock2DesignPresets()
        .then((r) => setDesignPresets(r.presets || []))
        .catch(() => setDesignPresets([]));
    }
  }, [designPresets]);
  const chooseDesign = async (presetKey) => {
    setChoosingDesign(true);
    try {
      await api.mock2SetProjectDesignPreset(projectId, presetKey);
      setDesignChosen(true);
      setDesignDirection(presetKey === 'ai' ? 'explore' : 'theme');
      setDesignChoiceOpen(false);
      const name = presetKey === 'ai'
        ? 'Let the AI decide'
        : (designPresets || []).find((p) => p.key === presetKey)?.name || presetKey;
      toast({ title: `Design: ${name}`, description: presetKey === 'ai' ? 'The AI designs freely — approving the mockup adopts its look.' : 'Mockups stay on this design; you can change it anytime from the Design button.' });
      // An "Accept plan" waiting on this choice continues on its own — the
      // direction is passed explicitly because the state set just above hasn't
      // re-rendered into this closure yet.
      if (pendingAcceptPlanRef.current) {
        pendingAcceptPlanRef.current = false;
        startDesignFromPlan(presetKey === 'ai' ? 'explore' : 'theme');
      }
    } catch (err) {
      pendingAcceptPlanRef.current = false;
      toast({ variant: 'destructive', title: 'Could not save the design choice', description: err.message });
    } finally { setChoosingDesign(false); }
  };
  const scrollRef = useRef(null);
  const composerRef = useRef(null);   // focused when the assets modal hands back
  // Auto-scroll cadence, the same one the build chat uses: follow the newest
  // content while something is running, and never fight the reader.
  // interactedRef — the user scrolled up to read, so following pauses until
  // they come back to the bottom. lastUserMsgIdRef — their own send re-arms it.
  const interactedRef = useRef(false);
  const lastUserMsgIdRef = useRef(null);
  const wasActiveRef = useRef(false);
  // WHAT IT IS DOING, accumulated rather than replaced. The design stage showed
  // one muted line that each new phase overwrote, so the only thing on screen
  // during a two-to-five minute render was whatever it happened to be doing at
  // that instant — with no sense of progress and nothing to read. The build
  // chat keeps a timeline; this keeps the same one.
  const [designActivity, setDesignActivity] = useState([]);
  const activityCycleRef = useRef(null);
  const onTyping = useTypingTracker(projectId, canEdit && !archived && project?.lifecycle === 'active');
  const wasApproved = useRef(!!project?.design_approved_at);
  // The "bring your logo" question, asked as a modal BEFORE the chat can be
  // used. Deliberately NOT persisted: the operator asked for it on every page
  // load while the conversation is still empty, because the moment it matters is
  // the moment before the first mockup is described — and that moment comes back
  // every time someone opens a project they have not started yet.
  const [assetPromptOff, setAssetPromptOff] = useState(false);
  const [assetCount, setAssetCount] = useState(null);   // null = not yet known
  // The asset LIBRARY, opened over the chat. Saying yes to the question should
  // put the operator straight into the thing they said yes to, rather than
  // pointing at a panel behind them.
  const [assetsOpen, setAssetsOpen] = useState(false);
  const [assetsAdded, setAssetsAdded] = useState(0);   // shown once, above the composer
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

  // How many assets this project has. Asked once per mount (and again after the
  // Assets panel is opened) purely to decide whether the invitation still has a
  // point — a project that already has a logo should not be asked for one.
  const refreshAssetCount = useCallback(async () => {
    try {
      const r = await api.mock2ProjectAssets(projectId);
      setAssetCount(r?.summary?.total ?? (r?.assets?.length || 0));
    } catch { setAssetCount(0); }   // never let this block the chat
  }, [projectId]);
  useEffect(() => { if (!archived) refreshAssetCount(); }, [archived, refreshAssetCount]);

  const dismissAssetPrompt = useCallback(() => setAssetPromptOff(true), []);
  // Stable identity: ProjectAssets calls this from its load(), and an inline
  // arrow here would change every render and re-run that load forever.
  const onAssetsSummary = useCallback((sum) => {
    setAssetCount(sum?.total ?? 0);
  }, []);

  // Poll while a background turn/approval job is running, while the M8 audit is
  // in flight, or while any rule question is open (so answers + the "starting the
  // build" transition settle on their own).
  const jobActive = data?.job && !['done', 'approved', 'failed'].includes(data.job.phase);
  // The approval (mockup → Build) job specifically — surfaced as a prominent
  // "Unlocking Build…" loader so the stage handoff never looks stuck.
  const approvalActive = jobActive && data?.job?.kind === 'approval';
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
  // In the read-only Details archive nothing is live and nothing is editable —
  // it's pure history of how the design was decided, no polling, no composer.
  const editable = canEdit && !archived;
  // The streamed reply (Anthropic connectors): partial text on the turn job —
  // rendered as a live assistant bubble; poll faster while it's arriving.
  const jobPartial = jobActive ? (data?.job?.partial || null) : null;

  // Accumulate the job's narration into a timeline of PERSISTED steps, the way
  // the build chat's activity feed works: every distinct wording is its own
  // row, forever. A message that differs only in its ticking numbers (elapsed
  // seconds, character counts) refreshes ITS OWN row in place — wherever that
  // row sits — so the interleaved heartbeat + streaming-count narrations each
  // keep one row instead of overwriting each other or printing thirty
  // near-identical lines. A new cycle starts a fresh timeline.
  const jobMessage = data?.job?.message || null;
  const jobCycleId = data?.job?.cycleId ?? data?.job?.cycle_id ?? null;
  useEffect(() => {
    if (!jobActive) return;
    if (activityCycleRef.current !== jobCycleId) {
      activityCycleRef.current = jobCycleId;
      setDesignActivity(jobMessage
        ? [{ type: 'message', text: jobMessage, stem: narrationStem(jobMessage), seq: 0 }]
        : []);
      return;
    }
    if (!jobMessage) return;
    setDesignActivity((prev) => {
      const stem = narrationStem(jobMessage);
      const idx = prev.findIndex((r) => r.stem === stem);
      if (idx >= 0) {
        if (prev[idx].text === jobMessage) return prev;
        const next = [...prev];
        next[idx] = { ...next[idx], text: jobMessage };
        return next;
      }
      return [...prev, { type: 'message', text: jobMessage, stem, seq: prev.length }];
    });
  }, [jobActive, jobMessage, jobCycleId]);

  // Clear the timeline once the work is done — the durable reply is the record
  // from then on, and leaving the narration up under it reads as still running.
  useEffect(() => {
    if (!jobActive && designActivity.length) {
      const t = setTimeout(() => setDesignActivity([]), 400);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [jobActive, designActivity.length]);
  const shouldPoll = !archived && (jobActive || auditActive || openQuestionCount > 0 || projectOpenQuestions > 0);
  useEffect(() => {
    if (!shouldPoll) return undefined;
    const t = setInterval(load, jobActive ? 900 : 2500);
    return () => clearInterval(t);
  }, [shouldPoll, jobActive, load]);

  const openIds = new Set(data?.open_question_ids || []);
  // In the read-only Details archive, show only the design conversation — the
  // part up to approval. The post-approval build/run chat lives in BuildChat.
  // created_at + design_approved_at are both ISO from nowIso(), so a lexical
  // compare is correct.
  const approvedAt = project?.design_approved_at || null;
  const shownMessages = (archived && approvedAt)
    ? (data?.messages || []).filter((m) => !m.created_at || m.created_at < approvedAt)
    : (data?.messages || []);

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

  // The build chat's auto-scroll, ported wholesale — the design stage had a
  // one-shot "land on the newest message" and nothing that FOLLOWED growing
  // content, so a streaming reply and a growing timeline scrolled out from
  // under the reader.
  //
  // 1) Taking control. A wheel or touch gesture means the reader is reading;
  //    following pauses until they come back to the bottom. A plain 'scroll'
  //    event is NOT intent — our own programmatic scroll fires one too — so
  //    only the near-bottom check re-arms.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return undefined;
    const took = () => { interactedRef.current = true; };
    const onScroll = () => {
      if (el.scrollHeight - el.scrollTop - el.clientHeight < 60) interactedRef.current = false;
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

  // 2) Follow-the-work. While a turn runs, stay pinned to the newest content as
  //    it grows. A MutationObserver catches EVERY change — the streamed reply
  //    growing by a word, a new timeline row — not just the React deps, which is
  //    what makes it feel smooth rather than jumpy.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !(jobActive || auditActive)) return undefined;
    const follow = () => { if (!interactedRef.current) el.scrollTop = el.scrollHeight; };
    follow();
    const mo = new MutationObserver(follow);
    mo.observe(el, { childList: true, subtree: true, characterData: true });
    return () => mo.disconnect();
  }, [jobActive, auditActive]);

  // 3) A new turn starting re-engages following: the operator asked for it and
  //    wants to watch it, even if they had scrolled up during the last one.
  useEffect(() => {
    const active = jobActive || auditActive;
    if (active && !wasActiveRef.current) interactedRef.current = false;
    wasActiveRef.current = active;
  }, [jobActive, auditActive]);

  // 4) Where to land when content arrives. Their own send goes to the bottom.
  //    While work runs, the bottom (the timeline grows there). Otherwise the TOP
  //    of the newest message, so a long reply reads from its first line instead
  //    of making them scroll back up to find the start.
  const newestMsg = shownMessages[shownMessages.length - 1] || null;
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (newestMsg && newestMsg.kind === 'user' && newestMsg.id !== lastUserMsgIdRef.current) {
      lastUserMsgIdRef.current = newestMsg.id;
      interactedRef.current = false;
      el.scrollTop = el.scrollHeight;
      return;
    }
    if (interactedRef.current) return;
    if (jobActive || auditActive) { el.scrollTop = el.scrollHeight; return; }
    const kids = [...el.children].filter((k) => !k.hasAttribute('data-scroll-skip'));
    const last = kids[kids.length - 1];
    if (!last) return;
    el.scrollTop = Math.max(0, last.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop - 8);
  }, [
    data?.messages?.length, jobActive, auditActive,
    data?.job?.phase, data?.job?.partial?.length,
    newestMsg?.id, newestMsg?.kind, designActivity.length,
  ]);

  const stage = data?.stage || project?.stage;
  const approved = !!stage?.design_approved;
  const online = project?.lifecycle === 'active';
  const provisioning = project?.lifecycle === 'provisioning';
  const previewUrl = data?.preview_url || project?.preview_url || null;
  const hasMockup = !!(data?.current_mockup_id || project?.current_mockup_id);
  // The mandatory design choice pops up ONCE, unprompted, when an editable
  // un-designed project opens its design chat — the Builder sees the four
  // saved designs + "Let the AI decide" before typing anything. Send re-opens
  // it if they dismissed without choosing; Skip mockup never requires it.
  const designChoiceAutoOpenedRef = useRef(false);
  useEffect(() => {
    if (designChoiceAutoOpenedRef.current) return;
    if (!editable || approved || designChosen || hasMockup || mode !== 'design') return;
    designChoiceAutoOpenedRef.current = true;
    openDesignChoice();
  }, [editable, approved, designChosen, hasMockup, mode, openDesignChoice]);
  // Ask at PAGE LAUNCH, while the answer can still change the first mockup: an
  // editable, unapproved project whose conversation has not started.
  //
  // Deliberately NOT gated on the project being online. Provisioning takes
  // minutes, the asset library is ProxyPilot-side (nothing is uploaded INTO the
  // container), and waiting for a container is exactly the dead time in which
  // finding your logo is free. assetCount stays null until the request lands, so
  // the modal never flashes in before we can say what is already there.
  //
  // "The conversation has not started" means the operator has not SUBMITTED a
  // prompt — a USER message. System messages do not count: a provisioning note
  // or a queued-action note is the platform talking, not the operator, and
  // gating on the raw message list made the modal appear the moment the asset
  // count landed and then vanish half a second later when the chat loaded and
  // turned out to contain one. (Reported on mobile, where provisioning notes
  // are the norm; the same bug was on desktop and simply had nothing to trip
  // it.)
  //
  // Both `data` and `assetCount` must have loaded before it shows at all —
  // otherwise it appears on the initial null state and then re-decides, which
  // is the flash itself.
  const conversationStarted = shownMessages.some((m) => m?.kind === 'user');
  const showAssetPrompt = editable && !approved && !hasMockup
    && !assetPromptOff && !assetsOpen
    && assetCount !== null && data !== null
    && !conversationStarted;
  // A design exists to export pre-approval (live mockup) AND post-approval
  // (the archived mockup is kept — the template reads it from the repo).
  const hasDesign = hasMockup || !!project?.design_approved_at || !!project?.mockup_archive_url;

  // In the read-only Details archive the conversation is bounded and scrolls
  // inside its own box (self-contained — it must not overflow into the page);
  // a collapse/expand toggle grows it from the standard height to a taller one.
  const [archiveExpanded, setArchiveExpanded] = useState(false);

  // ---- design template: download + import (design/mockup only, never code) ----
  const [downloading, setDownloading] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [importBusy, setImportBusy] = useState(false);
  const [importSource, setImportSource] = useState('file'); // 'file' | 'project'
  const [importFileText, setImportFileText] = useState('');
  const [importFileName, setImportFileName] = useState('');
  const [importProjects, setImportProjects] = useState(null); // null = not loaded yet
  const [importProjectId, setImportProjectId] = useState('');
  const [importNotes, setImportNotes] = useState('');

  const downloadTemplate = async () => {
    setDownloading(true);
    try {
      const doc = await api.mock2ExportDesignTemplate(projectId);
      const blob = new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${project?.slug || `project-${projectId}`}.design-template.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      toast({ variant: 'destructive', title: 'Could not download the design', description: err.message });
    } finally {
      setDownloading(false);
    }
  };

  // Open the import dialog, optionally landing on a specific source tab (the
  // empty-state shortcut preselects the project picker).
  const openImport = async (source = null) => {
    if (source) setImportSource(source);
    setImportOpen(true);
    if (importProjects === null) {
      try {
        const r = await api.mock2ListProjects();
        // Only projects that actually have a design, and not this one.
        setImportProjects((r.projects || []).filter(
          (p) => p.id !== Number(projectId) && (p.current_mockup_id || p.design_approved_at),
        ));
      } catch {
        setImportProjects([]);
      }
    }
  };

  const onImportFile = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      setImportFileText(await file.text());
      setImportFileName(file.name);
    } catch {
      toast({ variant: 'destructive', title: 'Could not read the file' });
    }
  };

  const runImport = async () => {
    setImportBusy(true);
    try {
      const body = {};
      if (importNotes.trim()) body.notes = importNotes.trim();
      if (importSource === 'file') {
        let doc;
        try { doc = JSON.parse(importFileText); } catch { throw new Error('Not valid JSON — choose a downloaded .design-template.json file'); }
        body.doc = doc;
      } else {
        if (!importProjectId) throw new Error('Choose a project to copy the design from');
        body.source_project_id = Number(importProjectId);
      }
      await api.mock2ImportDesignTemplate(projectId, body);
      setImportOpen(false);
      setImportFileText(''); setImportFileName(''); setImportProjectId(''); setImportNotes('');
      toast({ title: 'Design imported', description: 'The mockup is live at the preview — iterate it in chat, or approve the design when it feels right.' });
      await load();
    } catch (err) {
      toast({ variant: 'destructive', title: 'Import failed', description: err.message });
    } finally {
      setImportBusy(false);
    }
  };

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

  // Auto-refresh on turn completion: the moment a design turn's background job
  // finishes, reload the preview — the mockup URL is stable (same src, new
  // content), so without this a re-render under an unchanged URL would sit stale
  // until a manual reload. The id-transition effect above covers new mockups;
  // this covers the completed turn itself. Fires only on the active→done edge.
  const prevJobActive = useRef(false);
  useEffect(() => {
    if (!data) return;
    const activeNow = !!(data.job && !['done', 'approved', 'failed'].includes(data.job.phase));
    const finished = prevJobActive.current && !activeNow && data.job?.phase === 'done';
    prevJobActive.current = activeNow;
    if (finished && data.current_mockup_id && onMockupChanged) {
      onMockupChanged(data.current_mockup_id);
    }
  }, [data, onMockupChanged]);

  // Multi-modal: design references / screenshots pasted, dropped, or picked
  // into the composer ride the turn (and the mockup render) — downscaled
  // client-side before upload (lib/chat-images.js). Non-image files (a spec,
  // a .ts, a zip of a site) dropped into the same composer go to the project
  // asset library instead, where the build references them.
  const onDocumentFiles = useCallback(
    (files) => { uploadReferenceFiles(projectId, files, { toast }); },
    [projectId, toast],
  );
  const attach = useChatImages({
    onError: (m) => toast({ variant: 'destructive', title: 'Image not attached', description: m }),
    onDocumentFiles,
  });

  const send = async () => {
    const text = message.trim();
    if (!text || sendDisabled) return; // Ctrl+Enter must respect the same gate as the button
    // The design choice is mandatory before anything is submitted in the
    // design chat (Skip mockup excepted): no choice yet → the popup, not a send.
    if (mode === 'design' && !designChosen) { openDesignChoice(); return; }
    setBusy(true);
    try {
      const res = await api.mock2SendChatMessage(projectId, text, mode, toWireImages(attach.images), mode === 'design' ? designDirection : null);
      if (res.refused) {
        toast({ variant: 'destructive', title: 'Message not processed', description: res.reason || 'Quota exceeded.' });
      } else {
        setMessage('');
        attach.clear();
      }
      await load();
    } catch (err) {
      toast({ variant: 'destructive', title: 'Could not send', description: err.message });
    } finally {
      setBusy(false);
    }
  };

  // 'all' is the only strategy now: one MVP build implements the approved
  // design. The screen-by-screen option queued a separate background build per
  // screen — a second way to start builds, on top of MVP / Quick / Full, and
  // the slowest path to a first version.
  const approve = async (build = 'all') => {
    setBusy(true);
    try {
      await api.mock2ApproveDesign(projectId, build);
      toast({
        title: 'Building…',
        description: 'Locking in your design and building the MVP — watch the chat for progress.',
      });
      await load();
    } catch (err) {
      toast({ variant: 'destructive', title: 'Could not start the build', description: err.message });
    } finally {
      setBusy(false);
    }
  };

  // The "are you ready to build?" confirm — the Build button at the bottom of
  // the chat opens it; confirming approves the design (sign-off #1), which locks
  // the mockup in and unlocks the build runner.
  const [confirmBuild, setConfirmBuild] = useState(false);
  const doBuild = (build = 'all') => { setConfirmBuild(false); approve(build); };

  // Skip the mockup entirely: the base app is already live — lock the design
  // stage empty (zero tokens) and go straight to quick updates.
  const skipMockup = async () => {
    setBusy(true);
    try {
      await api.mock2SkipDesign(projectId);
      toast({ title: 'Mockup skipped', description: 'Build unlocked — describe changes to the running base app as Quick updates.' });
      await load();
      if (onApproved) onApproved();
    } catch (err) {
      toast({ variant: 'destructive', title: 'Could not skip the mockup', description: err.message });
    } finally {
      setBusy(false);
    }
  };

  // Only SENDING is gated (project offline / a turn already running /
  // design approved) — typing never is: draft the prompt while the project
  // provisions or the model works, and press Send once it unlocks.
  const sendDisabled = busy || jobActive || !online || approved;

  // ---- Accept plan → Design handoff ----
  // The Plan chat's exit: one button that accepts the plan, flips the toggle
  // to Design, and starts the first mockup automatically — the plan
  // conversation is already in the design partner's context, so the prompt
  // just says "go". It respects the mandatory design choice: with none made
  // yet the choice popup opens first and the handoff continues right after
  // choosing (pendingAcceptPlanRef bridges the two).
  const planHasReply = shownMessages.some((m) => m.kind === 'assistant');
  const pendingAcceptPlanRef = useRef(false);
  const startDesignFromPlan = async (direction = designDirection) => {
    setBusy(true);
    try {
      const res = await api.mock2SendChatMessage(projectId, ACCEPT_PLAN_PROMPT, 'design', [], direction);
      if (res.refused) {
        toast({ variant: 'destructive', title: 'Message not processed', description: res.reason || 'Quota exceeded.' });
      } else {
        toast({ title: 'Plan accepted', description: 'Turning the plan into the first mockup — watch the preview.' });
      }
      await load();
    } catch (err) {
      toast({ variant: 'destructive', title: 'Could not start the design', description: err.message });
    } finally { setBusy(false); }
  };
  const acceptPlan = () => {
    setMode('design');
    if (!designChosen) { pendingAcceptPlanRef.current = true; openDesignChoice(); return; }
    startDesignFromPlan();
  };

  // ---- fire-and-forget while provisioning ----
  // Offline pre-approval, both actions QUEUE instead of being dead: the queued
  // action runs server-side the moment provisioning completes (design_send →
  // the first concept turn; skip_mockup → design locked + the typed brief runs
  // as the first quick build). queuedLocal gives instant feedback; the parent's
  // project poll replaces it with the server's pending_design.
  const canQueue = editable && !online && !approved;
  const [queuedLocal, setQueuedLocal] = useState(null);
  const pendingDesign = project?.pending_design || queuedLocal;
  const queueAction = async (kind) => {
    const text = message.trim();
    if (kind === 'design_send' && !text) return;
    // Same mandatory-choice gate as send() — queueing a design message IS a
    // submission. skip_mockup queues freely.
    if (kind === 'design_send' && mode === 'design' && !designChosen) { openDesignChoice(); return; }
    setBusy(true);
    try {
      const res = await api.mock2QueueDesign(projectId, {
        kind, message: text,
        mode: kind === 'design_send' ? mode : null,
        design: kind === 'design_send' && mode === 'design' ? designDirection : null,
        images: toWireImages(attach.images),
      });
      setQueuedLocal(res.pending || { kind, text_preview: text.slice(0, 140) });
      setMessage('');
      attach.clear();
      toast({
        title: 'Queued — fire and forget',
        description: kind === 'skip_mockup'
          ? (text ? 'When provisioning finishes: the mockup is skipped and your request builds as the first Quick update. You can leave.' : 'When provisioning finishes, the mockup is skipped — the base app is yours. You can leave.')
          : 'Your design message sends itself the moment provisioning finishes — you can leave.',
      });
    } catch (err) {
      toast({ variant: 'destructive', title: 'Could not queue', description: err.message });
    } finally { setBusy(false); }
  };
  const cancelQueuedDesign = async () => {
    try {
      await api.mock2CancelQueuedDesign(projectId);
      setQueuedLocal(null);
      toast({ title: 'Queued action cancelled' });
    } catch (err) {
      toast({ variant: 'destructive', title: 'Could not cancel', description: err.message });
    }
  };
  // Once online the server has consumed (run) the pending action — drop the
  // local echo so the strip doesn't linger.
  useEffect(() => { if (online) setQueuedLocal(null); }, [online]);

  // LIVE PREVIEW while a mockup renders: the SERVED document reloads itself
  // (the preview route injects a reload snippet during the render), so no
  // outer iframe remounting is needed — remounting flashed the whole frame
  // every 10s (user report). One nudge when the render STARTS makes sure the
  // iframe is pointed at the self-refreshing placeholder.
  const designing = jobActive && data?.job?.phase === 'designing';
  const wasDesigning = useRef(false);
  useEffect(() => {
    if (designing && !wasDesigning.current && onMockupChanged) onMockupChanged('render-start');
    wasDesigning.current = designing;
  }, [designing, onMockupChanged]);

  return (
    // Archived (Details tab): the card SIZES TO ITS CONTENT — the conversation
    // box below owns the height and scroll, so nothing spills into the page.
    // Live (Concept tab): the card fills the column and the conversation grows.
    <Card className={`flex flex-col ${archived ? '' : (fill ? 'min-h-0 flex-1' : 'min-h-[26rem] lg:min-h-0 lg:flex-1')}`}>
      <CardContent className="flex flex-1 min-h-0 flex-col gap-3 pt-6">
        {/* Read-only archive header (Details tab, post-approval) + collapse/expand. */}
        {archived ? (
          <div className="flex items-center justify-between gap-2 shrink-0">
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground min-w-0">
              <ClipboardList className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate">Design conversation — read-only history of how the design was decided.</span>
            </p>
            <Button
              variant="ghost" size="sm" className="h-8 shrink-0 text-xs"
              onClick={() => setArchiveExpanded((v) => !v)}
              aria-expanded={archiveExpanded}
            >
              {archiveExpanded ? <><ChevronUp className="h-3.5 w-3.5 mr-1" /> Collapse</> : <><ChevronDown className="h-3.5 w-3.5 mr-1" /> Expand</>}
            </Button>
          </div>
        ) : null}

        {/* Mockup → Build handoff. Approval extracts the design inventory and
            unlocks Build in the background; this makes the wait visible so the
            user knows the next screen is coming (it switches on its own once the
            parent's project poll sees design_approved flip — no refresh). */}
        {!archived && approvalActive ? (
          <div className="flex items-center gap-3 rounded-lg border border-primary/30 bg-primary/5 p-3 shrink-0">
            <Loader2 className="h-5 w-5 animate-spin text-primary shrink-0" />
            <div className="min-w-0">
              <p className="text-sm font-medium">Unlocking Build…</p>
              <p className="text-xs text-muted-foreground">
                {data?.job?.message || 'Extracting the design inventory'} — this switches to the build view automatically.
              </p>
            </div>
          </div>
        ) : null}

        {/* Model-slot readiness (concept needs the concept_chat + mockup slots). */}
        {!archived && data && !data.concept_ready && !approved ? (
          <div className="flex items-start gap-2 p-3 rounded-lg bg-amber-500/10 text-amber-600 text-sm shrink-0">
            <Lock className="h-4 w-4 mt-0.5 shrink-0" />
            <span>{data.concept_ready_reason || 'Concept model slots are not configured yet.'}</span>
          </div>
        ) : null}

        {/* Design template actions: download this design (mockup + brief, no
            code), or seed this project from a downloaded template / another
            project's design. Download works pre- and post-approval (the
            archived mockup is kept); import only while still in Concept. */}
        {(hasDesign || (editable && !approved && online)) ? (
          <div className="flex flex-wrap items-center gap-2 shrink-0">
            {hasDesign ? (
              <Button variant="outline" size="sm" className="h-9" onClick={downloadTemplate} disabled={downloading}>
                {downloading ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <Download className="h-3.5 w-3.5 mr-1" />}
                {/* Short label on a phone: the two full labels wrap onto separate
                    rows at 360px, spending a third of the screen before the chat. */}
                Download<span className="hidden sm:inline">&nbsp;design</span>
              </Button>
            ) : null}
            {editable && !approved && online ? (
              <Button variant="outline" size="sm" className="h-9" onClick={() => openImport()} disabled={jobActive || busy}>
                <FileUp className="h-3.5 w-3.5 mr-1" />
                Import<span className="hidden sm:inline">&nbsp;design</span>
              </Button>
            ) : null}
          </div>
        ) : null}

        {/* Plan / Design / Build — above the chat. Plan talks through the idea
            without touching the mockup; Design generates/iterates it; Build is
            greyed out here until the design stage completes (accept the mockup,
            build the MVP, or skip the mockup) — at which point the parent
            switches to the build chat, which carries the same toggle back. */}
        {editable && !approved ? (
          <ChatModeToggle mode={mode} onMode={setMode} buildUnlocked={false} />
        ) : null}

        {/* Conversation. Live: grows to fill the column (flex-1 + min-h-0).
            Archived: a bounded, self-contained scroll box at a standard height,
            or a taller one when expanded — never overflowing its card. */}
        <div
          ref={scrollRef}
          className={`space-y-2 overflow-y-auto rounded-lg border bg-background/40 p-3 ${
            archived
              ? (archiveExpanded ? 'h-[40rem]' : 'h-[20rem]')
              // Filling a fixed-height panel (the phone workspace): take exactly
              // what's left after the composer, no floor and no 60vh ceiling —
              // those would push the composer off a 640px screen.
              : fill
                ? 'flex-1 min-h-0'
                // ONE size: the box fills its column but never grows past ~60vh —
                // long conversations scroll INSIDE it instead of stretching the
                // page (user report: the chat kept resizing as replies landed).
                : 'flex-1 min-h-[16rem] max-h-[60vh]'
          }`}
        >
          {/* SETUP STEPS — the same live provisioning list the Preview panel
              shows, in the CHAT. Someone waiting for their project to come up is
              sitting in the conversation (it is where they were told to start),
              and on a phone Preview is a different panel entirely — so the
              progress was on a screen they were not looking at. */}
          {!archived && provisioning ? (
            <div data-scroll-skip className="rounded-lg border bg-muted/20 p-3">
              <p className="flex items-center gap-2 text-sm font-medium">
                <Loader2 className="h-4 w-4 shrink-0 animate-spin text-blue-500" />
                <span className="min-w-0 break-words">{provMessage || 'Setting up your project…'}</span>
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                The container, repository, and URL are being provisioned. You can type below while it finishes —
                anything you send runs the moment it is ready.
              </p>
              {Array.isArray(provLog) && provLog.length ? <SetupProgress log={provLog} /> : null}
            </div>
          ) : null}

          {shownMessages.length === 0 ? (
            <div className="text-center py-6 space-y-3">
              <p className="text-sm text-muted-foreground">
                {archived
                  ? 'No design conversation was recorded.'
                  : online
                    ? 'No messages yet. Tell the design partner what you want to build.'
                    : 'Bring the project online to start the conversation.'}
              </p>
              {/* Fresh-project shortcut: start from a design you already have —
                  copy another project's mockup or upload a downloaded design
                  template — instead of describing the app from scratch. */}
              {editable && !approved && online && !hasMockup ? (
                <div className="space-y-2">
                  <p className="text-xs text-muted-foreground">
                    Already have a mockup? Start from an existing design instead:
                  </p>
                  <div className="flex flex-col sm:flex-row items-center justify-center gap-2">
                    <Button variant="outline" size="sm" className="h-11 sm:h-9 w-full sm:w-auto" onClick={() => openImport('project')} disabled={jobActive || busy}>
                      <FolderGit2 className="h-3.5 w-3.5 mr-1" />
                      Use another project's design
                    </Button>
                    <Button variant="outline" size="sm" className="h-11 sm:h-9 w-full sm:w-auto" onClick={() => openImport('file')} disabled={jobActive || busy}>
                      <FileUp className="h-3.5 w-3.5 mr-1" />
                      Upload a design template
                    </Button>
                  </div>
                </div>
              ) : null}
            </div>
          ) : (
            shownMessages.map((m) => (
              m.kind === 'rule_question'
                ? <RuleQuestion key={m.id} m={m} open={openIds.has(m.question_id)} canEdit={editable} busy={answering} onAnswer={answerQuestion} />
                : <ChatBubble key={m.id} m={m} projectId={projectId} />
            ))
          )}
          {/* The streamed reply, if any, with the working line kept underneath —
              during a mockup render the heartbeat narration ("rendering the
              design…") still matters even while the reply text is visible. */}
          {!archived && jobPartial ? <StreamingBubble text={jobPartial} /> : null}
          {/* WHAT IT IS DOING — the same timeline the build chat shows, rather
              than one muted line that each phase overwrote. A mockup render runs
              for two to five minutes; a single line that changes every so often
              gives no sense of progress and nothing to read while waiting. */}
          {!archived && (jobActive || auditActive) ? (
            designActivity.length ? (
              <ActivityStream items={designActivity} working />
            ) : (
              <div data-scroll-skip className="flex items-center gap-2 text-xs text-muted-foreground pl-1">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                {data?.job?.message || auditJob?.message || 'Working…'}
              </div>
            )
          ) : null}
        </div>

        {/* Composer (editors, online, before approval) */}
        {editable && !approved ? (
          <div className="space-y-2 shrink-0">
            {/* Empty chat: draw the eye to the composer so a new Builder knows
                to just start typing. The highlight drops the moment they do. */}
            {shownMessages.length === 0 && !message ? (
              <p className="flex items-center gap-1.5 text-xs font-medium text-primary">
                <Sparkles className="h-3.5 w-3.5 animate-pulse" />
                Start here — describe what you want to build, in your own words.
              </p>
            ) : null}
            {/* Fire-and-forget strip: the action queued while provisioning. */}
            {!online && pendingDesign ? (
              <div className="flex items-center gap-2 rounded-md border border-primary/30 bg-primary/5 p-2.5 text-xs">
                <Clock3 className="h-4 w-4 shrink-0 text-primary" />
                <span className="min-w-0 flex-1 break-words">
                  Runs the moment provisioning finishes:{' '}
                  {pendingDesign.kind === 'skip_mockup'
                    ? (pendingDesign.text_preview ? <>skip the mockup, then build “{pendingDesign.text_preview}” as the first Quick update</> : 'skip the mockup')
                    : <>send “{pendingDesign.text_preview}” to the design partner</>}
                  {' '}— you can close this page.
                </span>
                <Button variant="ghost" size="icon" className="h-9 w-9 shrink-0 text-red-500" onClick={cancelQueuedDesign} aria-label="Cancel the queued action">
                  <X className="h-4 w-4" />
                </Button>
              </div>
            ) : null}
            {/* What "Add to chat" leaves behind: a one-line confirmation that
                the assets are in, right where the prompt is about to be typed.
                It clears the moment they start typing. */}
            {assetsAdded > 0 && !message ? (
              <p className="flex items-center gap-1.5 text-xs text-primary">
                <Library className="h-3.5 w-3.5" />
                {assetsAdded} asset{assetsAdded === 1 ? '' : 's'} ready — now describe what you want built and the design will use {assetsAdded === 1 ? 'it' : 'them'}.
              </p>
            ) : null}
            <textarea
              ref={composerRef}
              className={`flex min-h-[56px] w-full rounded-md border bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-60 ${
                shownMessages.length === 0 && !message
                  ? 'border-primary/70 ring-2 ring-primary/30 shadow-primary/20 shadow-lg'
                  : 'border-input'
              }`}
              placeholder={online
                ? (mode === 'plan' ? 'Think through what you want to build…' : 'Describe a screen, a change, or ask a question…')
                : 'Draft your prompt while the project comes online — Send unlocks when it’s ready.'}
              value={message}
              onChange={(e) => { setMessage(e.target.value); onTyping(); }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  if (canQueue) queueAction('design_send'); else send();
                }
              }}
              onPaste={attach.handlePaste}
              onDrop={attach.handleDrop}
              onDragOver={(e) => e.preventDefault()}
            />
            {/* Image attachments — paste/drop into the box above or pick with "+".
                Design references and screenshots reach both the design partner
                and the mockup render. */}
            {/* Attaching is client-side (downscale + base64) — allowed while
                drafting too; only blocked mid-send. */}
            <ImageAttachmentBar
              images={attach.images} busy={attach.busy} disabled={busy}
              onPickFiles={attach.addFiles} onRemove={attach.remove}
              allowDocuments
            />
            {/* flex-wrap, not a single row: at 360px the direction toggle +
                Build MVP + Send are wider than the screen, and without it Send
                was clipped off the right edge with no way to scroll to it. */}
            <div className="flex flex-wrap items-center justify-between gap-2">
              {/* Build MVP — lives at the bottom of the design chat: when the
                  mockup looks right, this (after a confirm) locks the design in
                  and starts the MVP build — the speed path to a testable first
                  version (rule interview skipped, no gate battery, fast
                  model). The fully audited Build comes later, from the build
                  chat. */}
              {mode === 'design' ? (
                <Button
                  type="button"
                  variant="outline"
                  className="h-11 sm:h-10 shrink-0"
                  onClick={openDesignChoice}
                  title={designChosen
                    ? 'Change the design this project renders on'
                    : 'Choose a design before sending — one of the saved designs, or let the AI decide'}
                >
                  <Sparkles className="h-4 w-4 mr-1" />
                  {designChosen
                    ? `Design: ${project?.design_preset === 'ai' || designDirection === 'explore' ? 'AI decides' : (designPresets || []).find((p) => p.key === project?.design_preset)?.name || project?.design_preset || 'chosen'}`
                    : 'Choose design'}
                </Button>
              ) : null}
              {/* Accept plan — the Plan chat's exit: switches to Design and
                  turns the plan into the first mockup automatically. Unlocks
                  once the plan partner has replied (there is a plan to accept). */}
              {mode === 'plan' && online ? (
                <Button
                  variant="outline"
                  className="h-11 sm:h-10 shrink-0"
                  disabled={sendDisabled || !planHasReply}
                  title={planHasReply
                    ? 'Accept the plan — switch to Design and turn the plan into the first mockup automatically'
                    : 'Talk the idea through first — Accept unlocks once the plan partner has replied'}
                  onClick={acceptPlan}
                >
                  <CheckCircle2 className="h-4 w-4 mr-1" /> Accept plan
                </Button>
              ) : null}
              {hasMockup && online ? (
                <Button
                  variant="outline"
                  className="h-11 sm:h-10 shrink-0"
                  disabled={sendDisabled}
                  title="Build the MVP — lock in the design and build it as fast MVP passes (screen by screen, or all at once); no rule interview, no gate battery"
                  onClick={() => setConfirmBuild(true)}
                >
                  <Rocket className="h-4 w-4 mr-1" /> Build MVP
                </Button>
              ) : null}
              {!hasMockup && online ? (
                <Button
                  variant="outline"
                  className="h-11 sm:h-10 shrink-0"
                  disabled={busy}
                  title="The base app is already live — skip the mockup and start making quick updates to it"
                  onClick={skipMockup}
                >
                  <Rocket className="h-4 w-4 mr-1" /> Skip mockup
                </Button>
              ) : null}
              {canQueue ? (
                <Button
                  variant="outline"
                  className="h-11 sm:h-10 shrink-0"
                  disabled={busy}
                  title="Fire and forget: when provisioning finishes, the mockup is skipped — and anything typed above builds as the first Quick update"
                  onClick={() => queueAction('skip_mockup')}
                >
                  <Rocket className="h-4 w-4 mr-1" /> Queue skip
                </Button>
              ) : null}
              <span className="text-[11px] text-muted-foreground hidden sm:block ml-auto">⌘/Ctrl+Enter to send</span>
              <Button
                className="h-11 sm:h-10 ml-auto sm:ml-0"
                disabled={(canQueue ? busy : sendDisabled) || !message.trim()}
                title={!online
                  ? (canQueue ? 'Queues now, sends itself the moment provisioning finishes — fire and forget' : 'Sending unlocks when the project is online')
                  : undefined}
                onClick={canQueue ? () => queueAction('design_send') : send}
              >
                {busy ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : (canQueue ? <Clock3 className="h-4 w-4 mr-1" /> : <Send className="h-4 w-4 mr-1" />)}
                {canQueue ? 'Queue send' : 'Send'}
              </Button>
            </div>
          </div>
        ) : !canEdit && !approved && !archived ? (
          <p className="text-sm text-muted-foreground flex items-center gap-1 shrink-0">
            <Sparkles className="h-4 w-4" /> Viewers can follow the conversation; editors drive the design.
          </p>
        ) : null}
      </CardContent>

      {/* Import-design dialog — a downloaded template file OR another project's
          design (design/mockup only, never code), plus optional changes/context
          for the build. Full-screen on <sm (MOBILE_FIRST). */}
      {/* THE LIBRARY ITSELF, over the chat. Saying yes to the question above
          should put the operator into the thing they said yes to — pointing at
          a panel behind the modal makes them find it, and on a phone that panel
          is a different screen entirely.

          "Add to chat" is the way out: it closes, confirms what is now in the
          library, and puts the cursor in the composer, so the next thing they
          do is write the prompt those assets are for. Closing any other way is
          the same thing minus the confirmation — nothing is lost either way,
          because uploads save as they happen.

          MOBILE_FIRST: full-screen under sm, the library scrolls INSIDE the
          dialog, and the footer action stays reachable. */}
      <Dialog open={assetsOpen} onOpenChange={setAssetsOpen}>
        <DialogContent className="flex max-w-full h-full flex-col gap-3 rounded-none sm:h-[85vh] sm:max-w-3xl sm:rounded-lg">
          <DialogHeader className="shrink-0">
            <DialogTitle className="flex items-center gap-2">
              <Library className="h-5 w-5 shrink-0 text-primary" />
              Logos, assets and context
            </DialogTitle>
            <DialogDescription>
              Drop in a logo, a screenshot of what you are replacing, or the wording a screen should carry.
              The mockup is shown your images and given your notes to build from — and every build after it
              is too.
            </DialogDescription>
          </DialogHeader>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <ProjectAssets projectId={projectId} canEdit={editable} onSummary={onAssetsSummary} />
          </div>
          <DialogFooter className="shrink-0 flex-col gap-2 sm:flex-row">
            <Button
              className="h-11 w-full sm:h-9 sm:w-auto"
              onClick={() => {
                setAssetsOpen(false);
                setAssetsAdded(assetCount || 0);
                // Land the cursor where the prompt goes: the whole point of
                // coming back is to write the request these assets are for.
                setTimeout(() => composerRef.current?.focus(), 50);
              }}
            >
              <Send className="mr-1 h-4 w-4" />
              Add to chat
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* BRING YOUR OWN — asked as a MODAL, before the chat can be used.
          The moment a logo, the real wording or a design reference is worth
          having is the moment BEFORE the first mockup is described, because the
          mockup is what gets made from them; an inline card next to the composer
          was read past. Deliberately not persisted — it returns on every page
          load while the conversation is still empty, and stops the moment there
          is a first message.

          Blocking on purpose: no outside-click and no Escape, so it is answered
          rather than dismissed by accident. Both answers are one tap.
          MOBILE_FIRST: full-screen under sm, 44px targets, stacked actions — it
          renders in a portal, so it appears over the phone workspace exactly as
          it does on desktop. */}
      <Dialog open={showAssetPrompt} onOpenChange={(o) => { if (!o) dismissAssetPrompt(); }}>
        <DialogContent
          className="max-w-full h-full rounded-none overflow-y-auto sm:max-w-md sm:h-auto sm:rounded-lg"
          onInteractOutside={(e) => e.preventDefault()}
          onEscapeKeyDown={(e) => e.preventDefault()}
        >
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ImagePlus className="h-5 w-5 shrink-0 text-primary" />
              <span className="min-w-0">Do you want to load logos, assets, or context before your app build request?</span>
            </DialogTitle>
            <DialogDescription>
              Anything you add is used by the design — the mockup is shown your logo and design
              references, and is given your wording and brand notes to build from. You can add
              them later too, but they shape the design best before the first mockup.
            </DialogDescription>
          </DialogHeader>
          {assetCount > 0 ? (
            <p className="rounded-md border bg-muted/30 p-2.5 text-xs text-muted-foreground">
              This project already has {assetCount} item{assetCount === 1 ? '' : 's'} in its library — they
              will be used. You can add more, or carry on.
            </p>
          ) : null}
          <DialogFooter className="flex-col gap-2 sm:flex-row">
            <Button
              variant="outline" className="h-11 w-full sm:h-9 sm:w-auto"
              onClick={dismissAssetPrompt}
            >
              Not now — start describing
            </Button>
            <Button
              className="h-11 w-full sm:h-9 sm:w-auto"
              onClick={() => { dismissAssetPrompt(); setAssetsOpen(true); }}
            >
              <Library className="mr-1 h-4 w-4" />
              {assetCount > 0 ? 'Add more' : 'Add assets'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={importOpen} onOpenChange={(o) => { if (!importBusy) setImportOpen(o); }}>
        <DialogContent className="max-w-full h-full rounded-none overflow-y-auto sm:max-w-md sm:h-auto sm:rounded-lg">
          <DialogHeader>
            <DialogTitle>Import a design</DialogTitle>
            <DialogDescription>
              Start this project from an existing mockup — a downloaded design template or another
              project's design. Only the design is imported, never any code.
              {hasMockup ? ' The current mockup will be replaced.' : ''}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="inline-flex rounded-md border p-0.5" role="tablist" aria-label="Design source">
              <button
                type="button" role="tab" aria-selected={importSource === 'file'}
                onClick={() => setImportSource('file')}
                className={`inline-flex items-center gap-1 rounded px-2.5 py-2 text-xs font-medium min-h-[44px] sm:min-h-0 ${importSource === 'file' ? 'bg-muted text-foreground' : 'text-muted-foreground'}`}
              >
                <FileUp className="h-3.5 w-3.5" /> From a file
              </button>
              <button
                type="button" role="tab" aria-selected={importSource === 'project'}
                onClick={() => setImportSource('project')}
                className={`inline-flex items-center gap-1 rounded px-2.5 py-2 text-xs font-medium min-h-[44px] sm:min-h-0 ${importSource === 'project' ? 'bg-muted text-foreground' : 'text-muted-foreground'}`}
              >
                <FolderGit2 className="h-3.5 w-3.5" /> From a project
              </button>
            </div>

            {importSource === 'file' ? (
              <div className="space-y-1.5">
                <Label htmlFor="design-template-file">Design template file</Label>
                <input
                  id="design-template-file"
                  type="file"
                  accept="application/json,.json"
                  onChange={onImportFile}
                  className="block w-full text-sm text-muted-foreground file:mr-3 file:h-9 file:rounded-md file:border file:border-input file:bg-transparent file:px-3 file:text-sm file:font-medium file:text-foreground"
                />
                <p className="text-xs text-muted-foreground break-all">
                  {importFileName
                    ? `Selected: ${importFileName}`
                    : 'A .design-template.json downloaded from a project’s "Download design".'}
                </p>
              </div>
            ) : (
              <div className="space-y-1.5">
                <Label htmlFor="design-template-source">Copy the design from</Label>
                {importProjects === null ? (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground py-2">
                    <Loader2 className="h-4 w-4 animate-spin" /> Loading projects…
                  </div>
                ) : importProjects.length === 0 ? (
                  <p className="text-sm text-muted-foreground py-2">No other project has a design to copy yet.</p>
                ) : (
                  <Select value={importProjectId} onValueChange={setImportProjectId}>
                    <SelectTrigger id="design-template-source" className="h-11 sm:h-10">
                      <SelectValue placeholder="Choose a project" />
                    </SelectTrigger>
                    <SelectContent>
                      {importProjects.map((p) => (
                        <SelectItem key={p.id} value={String(p.id)}>{p.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </div>
            )}

            <div className="space-y-1.5">
              <Label htmlFor="design-import-notes">Changes or context <span className="text-muted-foreground">(optional)</span></Label>
              <textarea
                id="design-import-notes"
                className="flex min-h-[72px] w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                placeholder="Anything to change or add for this project…"
                value={importNotes}
                onChange={(e) => setImportNotes(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Left empty, the template's original design brief is used as the reference when building.
              </p>
            </div>
          </div>
          <DialogFooter className="flex-col sm:flex-row gap-2">
            <Button type="button" variant="outline" className="h-11 sm:h-10" onClick={() => setImportOpen(false)} disabled={importBusy}>
              Cancel
            </Button>
            <Button
              type="button" className="h-11 sm:h-10" onClick={runImport}
              disabled={importBusy || (importSource === 'file' ? !importFileText : !importProjectId)}
            >
              {importBusy ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <FileUp className="h-4 w-4 mr-1" />}
              Import design
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Build confirm — locking in the design is sign-off #1 and can't be
          un-approved, so it always asks first. Full-screen on <sm (MOBILE_FIRST). */}
      <Dialog open={confirmBuild} onOpenChange={(o) => !o && setConfirmBuild(false)}>
        <DialogContent className="max-w-full h-full rounded-none sm:max-w-md sm:h-auto sm:rounded-lg">
          <DialogHeader>
            <DialogTitle>Ready to build?</DialogTitle>
            <DialogDescription>
              This locks in your current design{project?.name ? <> for <span className="font-medium">{project.name}</span></> : null}.
              The base app (sign-in, first-admin setup, theme, branding, legal pages and your chosen look) is
              already wired; the MVP build implements the whole design on top of it in one pass.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <div className="rounded-md border p-3 text-xs text-muted-foreground space-y-1.5">
              <p className="text-sm font-medium text-foreground flex items-center gap-2">
                <Rocket className="h-4 w-4" /> What the MVP build does
              </p>
              <p>
                Reproduces the approved mockup as a working app: every screen, field and action, on the base
                app&apos;s shell and design tokens.
              </p>
              <p>
                It runs the <span className="font-medium">look-and-act</span> gates — the design actually matches
                the mockup, nothing scrolls sideways on a phone, no button does nothing, and the base app&apos;s
                own features survive. It skips the slow half: security scan, per-rule tests and acceptance.
              </p>
              <p>
                Keep changing it afterwards with <span className="font-medium">Quick updates</span>. When it is
                worth keeping, a <span className="font-medium">Full build</span> runs the whole battery.
              </p>
            </div>
            <Button type="button" className="w-full min-h-[44px]" onClick={() => doBuild('all')}>
              <Rocket className="h-4 w-4 mr-1" /> Lock the design and build the MVP
            </Button>
          </div>
          <DialogFooter className="flex-col sm:flex-row gap-2">
            <Button variant="outline" onClick={() => setConfirmBuild(false)} className="h-11 sm:h-10">Not yet</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* The mandatory design choice: the saved designs + "Let the AI decide".
          Opens unprompted on a fresh design chat and again on any send attempt
          until a choice is made; Skip mockup never requires it. Full-screen on
          phones (MOBILE_FIRST), one column of ≥44px cards. */}
      <Dialog
        open={designChoiceOpen}
        onOpenChange={(o) => {
          if (choosingDesign) return;
          setDesignChoiceOpen(o);
          // Dismissing without choosing abandons a pending "Accept plan"
          // handoff — nothing should auto-send later off a stale flag.
          if (!o) pendingAcceptPlanRef.current = false;
        }}
      >
        <DialogContent className="max-w-full h-full rounded-none overflow-y-auto sm:max-w-lg sm:h-auto sm:max-h-[85vh] sm:rounded-lg">
          <DialogHeader>
            <DialogTitle>Choose your design</DialogTitle>
            <DialogDescription>
              Pick one of the saved designs, or let the AI design freely. Mockups render on your choice;
              you can change it here anytime. A choice is needed before the first design message —
              only “Skip mockup” goes ahead without one.
            </DialogDescription>
          </DialogHeader>
          {designPresets == null ? (
            <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading designs…
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-2">
              {designPresets.map((p) => (
                <button
                  key={p.key}
                  type="button"
                  disabled={choosingDesign}
                  onClick={() => chooseDesign(p.key)}
                  className={`w-full rounded-md border p-3 text-left min-h-[44px] hover:border-primary/60 hover:bg-muted/50 disabled:opacity-60 ${project?.design_preset === p.key && designChosen ? 'border-primary ring-1 ring-primary/40' : ''}`}
                >
                  <span className="flex items-start justify-between gap-3">
                    <span className="min-w-0">
                      <span className="block text-sm font-medium">
                        {p.name}
                        {project?.design_preset === p.key && designChosen ? ' · current' : ''}
                      </span>
                      <span className="mt-0.5 block text-xs text-muted-foreground">{p.description}</span>
                    </span>
                    {/* Palette swatches straight from the preset tokens. */}
                    <span className="flex shrink-0 gap-1 pt-0.5" aria-hidden="true">
                      {[p.tokens?.colors?.primary, p.tokens?.colors?.accent, p.tokens?.colors?.background, p.tokens?.colors?.text]
                        .filter(Boolean).slice(0, 4)
                        .map((hex, i) => (
                          <span key={i} className="h-4 w-4 rounded-full border" style={{ backgroundColor: hex }} />
                        ))}
                    </span>
                  </span>
                </button>
              ))}
              <button
                type="button"
                disabled={choosingDesign}
                onClick={() => chooseDesign('ai')}
                className={`w-full rounded-md border border-dashed p-3 text-left min-h-[44px] hover:border-primary/60 hover:bg-muted/50 disabled:opacity-60 ${(project?.design_preset === 'ai' || designDirection === 'explore') && designChosen ? 'border-primary ring-1 ring-primary/40' : ''}`}
              >
                <span className="flex items-center gap-2 text-sm font-medium">
                  <Sparkles className="h-4 w-4" /> Let the AI decide
                  {project?.design_preset === 'ai' && designChosen ? ' · current' : ''}
                </span>
                <span className="mt-0.5 block text-xs text-muted-foreground">
                  The AI designs a fresh, reference-quality look from your description (slower, deeper render).
                  Approving the mockup adopts it as the project design.
                </span>
              </button>
            </div>
          )}
          {choosingDesign ? (
            <p className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Saving…
            </p>
          ) : null}
        </DialogContent>
      </Dialog>
    </Card>
  );
}
