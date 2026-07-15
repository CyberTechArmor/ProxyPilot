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
} from 'lucide-react';
import { ChatBubble, RuleQuestion } from './chat-messages';
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
  const [mode, setMode] = useState('design'); // 'plan' | 'design' — directs the turn
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
  const shouldPoll = !archived && (jobActive || auditActive || openQuestionCount > 0 || projectOpenQuestions > 0);
  useEffect(() => {
    if (!shouldPoll) return undefined;
    const t = setInterval(load, 2500);
    return () => clearInterval(t);
  }, [shouldPoll, load]);

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

  // Keep the newest message in view.
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [data?.messages?.length, data?.job?.phase]);

  const stage = data?.stage || project?.stage;
  const approved = !!stage?.design_approved;
  const online = project?.lifecycle === 'active';
  const previewUrl = data?.preview_url || project?.preview_url || null;
  const hasMockup = !!(data?.current_mockup_id || project?.current_mockup_id);
  // A design exists to export pre-approval (live mockup) AND post-approval
  // (the archived mockup is kept — the template reads it from the repo).
  const hasDesign = hasMockup || !!project?.design_approved_at || !!project?.mockup_archive_url;

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
        {/* Read-only archive header (Details tab, post-approval). */}
        {archived ? (
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground shrink-0">
            <ClipboardList className="h-3.5 w-3.5" /> Design conversation — read-only history of how the design was decided.
          </p>
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

        {/* Conversation — grows to fill the available height */}
        <div
          ref={scrollRef}
          className="flex-1 min-h-0 space-y-2 overflow-y-auto rounded-lg border bg-background/40 p-3"
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
                : <ChatBubble key={m.id} m={m} />
            ))
          )}
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
            <textarea
              className="flex min-h-[56px] w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-60"
              placeholder={online
                ? (mode === 'plan' ? 'Think through what you want to build…' : 'Describe a screen, a change, or ask a question…')
                : 'Project must be online to chat.'}
              value={message}
              disabled={composerDisabled}
              onChange={(e) => { setMessage(e.target.value); onTyping(); }}
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
    </Card>
  );
}
