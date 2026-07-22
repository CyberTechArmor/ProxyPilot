// Lean BEAF Pro — global AI assistant dock.
//
// A right-docked chat panel available on EVERY page (rendered once in Layout,
// so its conversation persists as you navigate). Collapsed it's a small
// floating "Ask AI" bubble in the corner; open it slides in from the right.
//
// Responsive by design:
//   • lg and up: a ~360px side panel; the app content reflows to the left of
//     it (Layout adds matching right padding) so both stay usable.
//   • below lg: a full-screen overlay — it's either the app or the chat, never
//     a cramped both.
//
// The chat itself is the Brief: the selected brief (Daily / Since meeting /
// Leadership, or the AI restyle) is the opening message; a persistent composer
// lets anyone ask grounded questions. Every figure stays cited (R07) and
// citations / project names deep-link into the app.

import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '@/lib/api';
import { useAuth } from '@/context/AuthContext';
import { useToast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Sparkles, Loader2, Wand2, ScrollText, Settings2, Send, X } from 'lucide-react';
import BriefText from '@/components/lbp/BriefText';

const BRIEF_MODE_LABEL = { daily: 'Daily brief', since_meeting: 'Since last meeting', leadership: 'Leadership report' };

function formatUsd(n) {
  const v = Number(n) || 0;
  if (v === 0) return '$0.00';
  if (v < 0.01) return `$${v.toFixed(4)}`;
  return `$${v.toFixed(2)}`;
}

// One assistant message row: avatar + bubble.
function ChatRow({ children }) {
  return (
    <div className="flex gap-2">
      <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-purple-500/10 text-purple-600 dark:text-purple-400">
        <Sparkles className="h-3 w-3" />
      </span>
      <div className="min-w-0 flex-1 rounded-2xl rounded-tl-sm border bg-background px-3 py-2">
        {children}
      </div>
    </div>
  );
}

export default function AiAssistant({ open, onOpen, onClose }) {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { toast } = useToast();
  const isAdmin = user?.role === 'admin';

  const [brief, setBrief] = useState(null);
  const [briefMode, setBriefMode] = useState('since_meeting');
  const [briefLoading, setBriefLoading] = useState(false);
  const [refs, setRefs] = useState(null);
  const [aiResult, setAiResult] = useState(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiSettings, setAiSettings] = useState(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [askText, setAskText] = useState('');
  const [asking, setAsking] = useState(false);
  const [turns, setTurns] = useState([]);
  const threadRef = useRef(null);
  const loadedRef = useRef(false);

  const openArea = (id, tab) => {
    navigate(`/lean-beaf/${id}${tab ? `?tab=${tab}` : ''}`);
    // On a narrow overlay the panel covers the page — close it so they land on
    // the project. On desktop keep it open (both are visible).
    if (typeof window !== 'undefined' && window.matchMedia('(max-width: 1023px)').matches) onClose?.();
  };

  const loadSettings = useCallback(() => {
    api.lbpBriefSettings().then((d) => setAiSettings(d.settings)).catch(() => {});
  }, []);

  const loadBrief = useCallback((mode) => {
    setBriefMode(mode);
    setBriefLoading(true);
    setAiResult(null);
    api.lbpBrief(mode)
      .then((d) => { setBrief(d.brief); setRefs(d.refs); })
      .catch((e) => toast({ variant: 'destructive', title: 'Brief failed', description: e.message }))
      .finally(() => setBriefLoading(false));
  }, [toast]);

  // Load lazily the first time the panel is opened (no spend, one cheap GET —
  // but don't fetch on every app load for a panel nobody opened).
  useEffect(() => {
    if (open && !loadedRef.current) {
      loadedRef.current = true;
      loadBrief('since_meeting');
      loadSettings();
    }
  }, [open, loadBrief, loadSettings]);

  useEffect(() => {
    const el = threadRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns, asking, brief, briefLoading, aiLoading, open]);

  const generateAi = async () => {
    setAiLoading(true);
    try {
      const d = await api.lbpBriefAi(briefMode);
      setBrief(d.brief);
      setRefs(d.refs);
      setAiResult(d.ai);
      if (d.ai?.error === 'not_configured') {
        toast({ variant: 'destructive', title: 'No model connected', description: isAdmin ? 'Add a model + API key under AI settings.' : 'Ask an admin to connect a model in AI settings.' });
      } else if (d.ai?.fell_back) {
        toast({ variant: 'destructive', title: 'Used the grounded brief', description: 'The AI rewrite was rejected; showing the deterministic version.' });
      }
    } catch (e) {
      toast({ variant: 'destructive', title: 'AI brief failed', description: e.message });
    } finally {
      setAiLoading(false);
    }
  };

  const ask = async () => {
    const q = askText.trim();
    if (!q || asking) return;
    setAskText('');
    setTurns((t) => [...t, { role: 'user', text: q }]);
    setAsking(true);
    try {
      const d = await api.lbpBriefAsk(q);
      setRefs(d.refs);
      const a = d.answer || {};
      setTurns((t) => [...t, { role: 'assistant', ...a }]);
      if (a.error === 'not_configured') {
        toast({ variant: 'destructive', title: 'No model connected', description: isAdmin ? 'Add a model + API key under AI settings.' : 'Ask an admin to connect a model in AI settings.' });
      } else if (a.error === 'ungrounded_output') {
        toast({ variant: 'destructive', title: 'Answer withheld', description: 'The model referenced a record not in the grounded facts.' });
      } else if (a.error) {
        toast({ variant: 'destructive', title: 'Question failed', description: a.error });
      }
    } catch (e) {
      setTurns((t) => [...t, { role: 'assistant', error: e.message }]);
      toast({ variant: 'destructive', title: 'Question failed', description: e.message });
    } finally {
      setAsking(false);
    }
  };

  const aiOn = aiResult && !aiResult.fell_back;

  return (
    <>
      {/* collapsed: floating "Ask AI" bubble, present on every page */}
      {!open && (
        <button
          type="button"
          onClick={onOpen}
          className="fixed bottom-5 right-5 z-30 inline-flex items-center gap-2 rounded-full bg-gradient-to-r from-purple-600 to-indigo-600 px-4 py-3 text-sm font-semibold text-white shadow-lg transition-transform hover:scale-[1.03] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          title="Ask the Lean BEAF Pro assistant"
        >
          <Sparkles className="h-4 w-4" /> <span className="hidden sm:inline">Ask AI</span>
        </button>
      )}

      {/* backdrop on narrow screens (full-screen overlay = either app or chat) */}
      {open && <div className="fixed inset-0 z-40 bg-black/40 lg:hidden" onClick={onClose} aria-hidden="true" />}

      <aside
        className={cn(
          // Below lg it's a full-content overlay (either the app or the chat):
          // full width under md, and to the right of the pinned sidebar on md.
          // At lg+ it docks as a ~360px side panel (content reflows via Layout).
          'fixed inset-y-0 left-0 right-0 z-40 flex flex-col border-l bg-card shadow-2xl transition-transform duration-200 ease-out md:left-64 lg:left-auto lg:w-[360px]',
          open ? 'translate-x-0' : 'translate-x-full',
        )}
        aria-hidden={!open}
      >
        {/* header — title + all brief/AI actions inline */}
        <div className="flex items-center gap-1.5 border-b px-3 py-2.5">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-purple-500/10 text-purple-600 dark:text-purple-400">
            <Sparkles className="h-4 w-4" />
          </span>
          <b className="text-sm">Assistant</b>
          <div className="ml-auto flex items-center gap-1">
            <Button
              size="sm"
              className="h-8 bg-gradient-to-r from-purple-600 to-indigo-600 px-2.5 text-white hover:from-purple-600/90 hover:to-indigo-600/90"
              onClick={generateAi}
              disabled={aiLoading || briefLoading}
              title="Restyle the current brief with the model"
            >
              {aiLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Wand2 className="h-3.5 w-3.5" />}
              <span className="ml-1 hidden text-xs sm:inline">AI</span>
            </Button>
            <button type="button" onClick={() => navigate('/lean-beaf/briefs')} title="All briefs + run log" className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground">
              <ScrollText className="h-4 w-4" />
            </button>
            {isAdmin && (
              <button type="button" onClick={() => setSettingsOpen(true)} title="AI model settings" className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground">
                <Settings2 className="h-4 w-4" />
              </button>
            )}
            <button type="button" onClick={onClose} title="Close" className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground">
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* thread */}
        <div ref={threadRef} className="flex flex-1 flex-col gap-3 overflow-y-auto p-3">
          {/* in-chat suggestions — which brief to open */}
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] font-semibold text-muted-foreground">Briefs:</span>
            {[['daily', 'Daily'], ['since_meeting', 'Since meeting'], ['leadership', 'Leadership']].map(([mode, label]) => (
              <button
                key={mode}
                type="button"
                onClick={() => loadBrief(mode)}
                disabled={briefLoading || aiLoading}
                className={cn(
                  'rounded-full border px-2.5 py-1 text-xs font-semibold transition-colors disabled:opacity-60',
                  briefMode === mode ? 'border-primary bg-primary/10 text-primary' : 'border-border bg-background text-muted-foreground hover:border-primary/40 hover:text-primary',
                )}
              >
                {label}
              </button>
            ))}
          </div>

          {/* head: the brief itself */}
          <ChatRow>
            {(briefLoading || aiLoading) ? (
              <div className="flex items-center gap-2 py-1 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Preparing the brief…</div>
            ) : brief ? (
              <>
                <div className="mb-1 flex items-center gap-2">
                  <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{BRIEF_MODE_LABEL[briefMode] || 'Brief'}</span>
                  {aiOn && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-purple-500/10 px-2 py-0.5 text-[10px] font-semibold text-purple-600 dark:text-purple-400" title={`Model: ${aiResult.model}`}>
                      <Sparkles className="h-3 w-3" /> AI
                    </span>
                  )}
                </div>
                <BriefText text={brief.text} refs={refs} onOpen={openArea} />
                <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
                  {aiResult ? (
                    aiResult.error === 'not_configured' ? (
                      <span className="text-amber-600 dark:text-amber-400">No model connected — {isAdmin ? 'set one in AI settings.' : 'ask an admin.'}</span>
                    ) : (
                      <>
                        <span className="inline-flex items-center gap-1"><Wand2 className="h-3 w-3" /> {aiResult.model}</span>
                        <span>· {formatUsd(aiResult.cost_usd)}</span>
                        {aiResult.fell_back && <span className="text-amber-600 dark:text-amber-400">· grounded fallback</span>}
                      </>
                    )
                  ) : (
                    <span>Record-grounded{aiSettings ? ` · AI: ${aiSettings.model}` : ''}</span>
                  )}
                </div>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">Pick a brief above — or just ask a question below.</p>
            )}
          </ChatRow>

          {turns.map((t, i) => (
            t.role === 'user' ? (
              <div key={i} className="flex justify-end">
                <div className="max-w-[85%] rounded-2xl rounded-tr-sm bg-primary px-3 py-2 text-sm text-primary-foreground">{t.text}</div>
              </div>
            ) : (
              <ChatRow key={i}>
                {t.error ? (
                  <p className="text-sm text-amber-600 dark:text-amber-400">
                    {t.error === 'not_configured' ? 'No model connected — an admin can set one in AI settings.'
                      : t.error === 'ungrounded_output' ? 'The answer referenced a record not in the grounded facts, so it was withheld.'
                        : `Could not answer: ${t.error}`}
                  </p>
                ) : (
                  <>
                    <BriefText text={t.text} refs={refs} onOpen={openArea} />
                    <div className="mt-2 flex flex-wrap items-center gap-x-2 text-[11px] text-muted-foreground">
                      <span className="inline-flex items-center gap-1"><Wand2 className="h-3 w-3" /> {t.model}</span>
                      <span>· {formatUsd(t.cost_usd)}</span>
                    </div>
                  </>
                )}
              </ChatRow>
            )
          ))}

          {asking && (
            <ChatRow>
              <div className="flex items-center gap-2 py-1 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Thinking…</div>
            </ChatRow>
          )}
        </div>

        {/* composer — always ready, clears on send */}
        <div className="border-t p-3">
          <div className="flex items-end gap-2">
            <Input
              value={askText}
              onChange={(e) => setAskText(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask(); } }}
              placeholder="Ask about your projects…"
              maxLength={500}
              className="h-10 bg-background"
            />
            <Button className="h-10 px-3.5" onClick={ask} disabled={asking || !askText.trim()} title="Ask (grounded in the records)">
              {asking ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            </Button>
          </div>
          <p className="mt-1.5 text-[10px] text-muted-foreground">Grounded in your records · every figure cited · saved to the Briefs log.</p>
        </div>
      </aside>

      <BriefAiSettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} onSaved={loadSettings} />
    </>
  );
}

// Admin-only AI model settings for the brief writer. Model picker + optional
// API key (blank keeps the stored one) + optional base URL.
function BriefAiSettingsDialog({ open, onOpenChange, onSaved }) {
  const { toast } = useToast();
  const [settings, setSettings] = useState(null);
  const [model, setModel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setApiKey('');
    api.lbpBriefSettings()
      .then((d) => { setSettings(d.settings); setModel(d.settings.model); })
      .catch((e) => toast({ variant: 'destructive', title: 'Could not load settings', description: e.message }));
  }, [open, toast]);

  const save = async () => {
    setSaving(true);
    try {
      const d = await api.lbpSaveBriefSettings({ model, api_key: apiKey || undefined });
      setSettings(d.settings);
      setApiKey('');
      toast({ title: 'AI settings saved' });
      onSaved?.();
      onOpenChange(false);
    } catch (e) {
      toast({ variant: 'destructive', title: 'Could not save', description: e.message });
    } finally {
      setSaving(false);
    }
  };

  const choices = settings?.choices || [];
  const price = settings?.pricing?.[model];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-full h-full rounded-none sm:max-w-lg sm:h-auto sm:max-h-[90vh] sm:rounded-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>AI assistant settings</DialogTitle>
          <DialogDescription>
            The assistant restyles + answers from the grounded facts — it never invents numbers. Pick the model and
            connect an Anthropic API key. The cheap, fast model (Haiku) is the default.
          </DialogDescription>
        </DialogHeader>

        {!settings ? (
          <div className="py-6"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
        ) : (
          <div className="space-y-4">
            <div className="space-y-1">
              <Label className="text-xs">Model</Label>
              <Select value={model} onValueChange={setModel}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {choices.map((c) => <SelectItem key={c.id} value={c.id}>{c.label}</SelectItem>)}
                  {!choices.some((c) => c.id === model) && model && (
                    <SelectItem value={model}>{model}</SelectItem>
                  )}
                </SelectContent>
              </Select>
              {price && (
                <p className="text-[11px] text-muted-foreground">
                  ${price.in.toFixed(2)} / 1M input · ${price.out.toFixed(2)} / 1M output tokens
                </p>
              )}
            </div>

            <div className="space-y-1">
              <Label className="text-xs">Anthropic API key</Label>
              <Input
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={settings.has_api_key ? (settings.key_source === 'env' ? 'Using ANTHROPIC_API_KEY from the environment' : '•••••• stored — leave blank to keep') : 'sk-ant-…'}
                className="font-mono"
              />
              <p className="text-[11px] text-muted-foreground">
                Stored encrypted at rest. Leave blank to keep the current key.
                {settings.key_source === 'env' && ' Currently falling back to the ANTHROPIC_API_KEY environment variable.'}
              </p>
            </div>

            <div className="flex justify-end gap-2">
              <Button variant="ghost" className="h-11 sm:h-10" onClick={() => onOpenChange(false)}>Cancel</Button>
              <Button className="h-11 sm:h-10" onClick={save} disabled={saving || !model}>
                {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />} Save
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
