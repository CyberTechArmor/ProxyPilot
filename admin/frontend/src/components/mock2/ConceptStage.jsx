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
  ChevronDown, ChevronUp, Rocket, X, Clock3,
} from 'lucide-react';
import { ChatBubble, RuleQuestion, StreamingBubble } from './chat-messages';
import { useChatImages, ImageAttachmentBar } from './ImageAttachments';
import { toWireImages } from '@/lib/chat-images';
import { useTypingTracker } from '@/hooks/use-typing-tracker';

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

export default function ConceptStage({ projectId, project, canEdit, onApproved, onMockupChanged, archived = false }) {
  const { toast } = useToast();
  const [data, setData] = useState(null); // { messages, job, audit_job, stage, preview_url, open_question_ids, ... }
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [answering, setAnswering] = useState(false);
  const [mode, setMode] = useState('design');
  // Design direction for design-mode turns: 'theme' keeps the project's base
  // theme (the AI may extend it complementarily); 'explore' sets it aside for a
  // fresh reference-quality look this turn (adopted only if approved). Explore
  // renders with thinking on + high effort, so it is slower but deeper.
  const [designDirection, setDesignDirection] = useState('theme'); // 'plan' | 'design' — directs the turn
  const scrollRef = useRef(null);
  const onTyping = useTypingTracker(projectId, canEdit && !archived && project?.lifecycle === 'active');
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

  // Keep the newest message in view (including the streaming reply as it grows).
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [data?.messages?.length, data?.job?.phase, data?.job?.partial?.length]);

  const stage = data?.stage || project?.stage;
  const approved = !!stage?.design_approved;
  const online = project?.lifecycle === 'active';
  const previewUrl = data?.preview_url || project?.preview_url || null;
  const hasMockup = !!(data?.current_mockup_id || project?.current_mockup_id);
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
  // client-side before upload (lib/chat-images.js).
  const attach = useChatImages({ onError: (m) => toast({ variant: 'destructive', title: 'Image not attached', description: m }) });

  const send = async () => {
    const text = message.trim();
    if (!text || sendDisabled) return; // Ctrl+Enter must respect the same gate as the button
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

  const approve = async (build = 'all') => {
    setBusy(true);
    try {
      await api.mock2ApproveDesign(projectId, build);
      toast({
        title: 'Building…',
        description: build === 'screens'
          ? 'Locking in your design — screens will build one at a time in the background; watch the chat.'
          : 'Locking in your design and unlocking the build — watch the chat for progress.',
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

  return (
    // Archived (Details tab): the card SIZES TO ITS CONTENT — the conversation
    // box below owns the height and scroll, so nothing spills into the page.
    // Live (Concept tab): the card fills the column and the conversation grows.
    <Card className={`flex flex-col ${archived ? '' : 'min-h-[26rem] lg:min-h-0 lg:flex-1'}`}>
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
                Download design
              </Button>
            ) : null}
            {editable && !approved && online ? (
              <Button variant="outline" size="sm" className="h-9" onClick={() => openImport()} disabled={jobActive || busy}>
                <FileUp className="h-3.5 w-3.5 mr-1" />
                Import design
              </Button>
            ) : null}
          </div>
        ) : null}

        {/* Plan vs Design — above the chat. Plan talks through the idea without
            touching the mockup; Design generates/iterates it. */}
        {editable && !approved ? (
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

        {/* Conversation. Live: grows to fill the column (flex-1 + min-h-0).
            Archived: a bounded, self-contained scroll box at a standard height,
            or a taller one when expanded — never overflowing its card. */}
        <div
          ref={scrollRef}
          className={`space-y-2 overflow-y-auto rounded-lg border bg-background/40 p-3 ${
            archived ? (archiveExpanded ? 'h-[40rem]' : 'h-[20rem]') : 'flex-1 min-h-0'
          }`}
        >
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
          {!archived && (jobActive || auditActive) ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground pl-1">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {data?.job?.message || auditJob?.message || 'Working…'}
            </div>
          ) : null}
        </div>

        {/* Composer (editors, online, before approval) */}
        {editable && !approved ? (
          <div className="space-y-2 shrink-0">
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
            <textarea
              className="flex min-h-[56px] w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-60"
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
            />
            <div className="flex items-center justify-between gap-2">
              {/* Build MVP — lives at the bottom of the design chat: when the
                  mockup looks right, this (after a confirm) locks the design in
                  and starts the MVP build — the speed path to a testable first
                  version (rule interview skipped, no gate battery, fast
                  model). The fully audited Build comes later, from the build
                  chat. */}
              {mode === 'design' ? (
                <div className="inline-flex rounded-md border p-0.5 shrink-0" role="radiogroup" aria-label="Design direction">
                  <button
                    type="button" role="radio" aria-checked={designDirection === 'theme'}
                    onClick={() => setDesignDirection('theme')}
                    title="Stay on the project's base theme — the AI keeps the core colors/fonts/components and may add complementary touches"
                    className={`rounded px-2.5 py-1.5 text-xs font-medium min-h-[36px] ${designDirection === 'theme' ? 'bg-muted text-foreground' : 'text-muted-foreground'}`}
                  >
                    On theme
                  </button>
                  <button
                    type="button" role="radio" aria-checked={designDirection === 'explore'}
                    onClick={() => setDesignDirection('explore')}
                    title="Explore a new look this turn — the AI designs freely at reference quality (thinking on, high effort; slower). Approving the mockup adopts its look as the project design."
                    className={`rounded px-2.5 py-1.5 text-xs font-medium min-h-[36px] ${designDirection === 'explore' ? 'bg-muted text-foreground' : 'text-muted-foreground'}`}
                  >
                    New look
                  </button>
                </div>
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
              The base app (sign-in, first-admin setup, and your chosen look) is already wired — choose how the
              screens get built. <span className="font-medium">Both options run as fast MVP builds</span> (no rule
              interview, no gate battery — validate features first). You can keep making changes afterwards, and a{' '}
              <span className="font-medium">Production check</span> later runs the full rule/test/acceptance battery
              on what proved worth keeping.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <button
              type="button"
              onClick={() => doBuild('screens')}
              className="w-full min-h-[44px] rounded-md border border-primary bg-primary/10 p-3 text-left"
            >
              <span className="flex items-center gap-2 text-sm font-medium"><Rocket className="h-4 w-4" /> Screen by screen (recommended)</span>
              <span className="block pt-1 text-xs text-muted-foreground">
                Each screen builds as its own small scoped pass, one at a time in the background — you can watch
                them land, defer the ones you don&apos;t need, and keep working meanwhile.
              </span>
            </button>
            <button
              type="button"
              onClick={() => doBuild('all')}
              className="w-full min-h-[44px] rounded-md border p-3 text-left"
            >
              <span className="text-sm font-medium">Everything at once</span>
              <span className="block pt-1 text-xs text-muted-foreground">
                One MVP build implements the whole design in a single pass — fastest to a complete first version.
              </span>
            </button>
          </div>
          <DialogFooter className="flex-col sm:flex-row gap-2">
            <Button variant="outline" onClick={() => setConfirmBuild(false)} className="h-11 sm:h-10">Not yet</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
