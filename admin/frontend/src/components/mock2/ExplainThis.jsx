// ExplainThis — a reusable "Explain this" button + reading-first popup, dropped onto
// every blocker, authorization request, framework-deviation, and rule-question card.
//
// The card text is written by the build model for engineers (timestamps, hashes,
// §-references, SQL); operators need the meaning at a glance. On open, this sends the
// card's full text + minimal cycle context (task title, status) to the summary lane
// (a small/fast model) and renders the reply as five plain-language sections + a risk
// badge. Below the explanation, the operator can ask FOLLOW-UP questions — each one
// goes back to the summary lane with the original text + the explanation as context
// and renders as a Q&A thread. It is read-only: it never resumes, grants, or resolves
// anything, and the explanation is CACHED per card so re-opening is instant. If the
// explainer fails, it shows the original text with a notice — the operator is never
// blocked on it.
//
// MOBILE_FIRST: the modal fills the screen on small widths, caps the reading measure at
// ~70ch, and uses ≥17px body text with generous line height. Clean at 360px.

import { useCallback, useState } from 'react';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Loader2, Sparkles, Send, HelpCircle } from 'lucide-react';

// Risk badge tones (design tokens): low → emerald, medium → amber, high → red.
const RISK_TONE = {
  low: 'bg-emerald-500/15 text-emerald-600 border-emerald-500/30',
  medium: 'bg-amber-500/15 text-amber-600 border-amber-500/30',
  high: 'bg-red-500/15 text-red-600 border-red-500/30',
};

// The five sections, in reading order, mapped to their headings.
const SECTIONS = [
  ['what_happened', 'What happened'],
  ['why_stopped', 'Why the build stopped'],
  ['what_asking', 'What it’s asking to do'],
  ['if_approve', 'If you approve'],
  ['if_decline', 'If you decline'],
];

// Flatten a cached explanation into the plain-text "prior" context a follow-up
// question carries back to the explainer (bounded server-side too).
function explanationAsText(data) {
  if (!data) return '';
  const parts = SECTIONS
    .filter(([key]) => data[key])
    .map(([key, heading]) => `${heading}: ${data[key]}`);
  if (data.risk_level) parts.push(`Risk: ${data.risk_level}${data.risk_why ? ` — ${data.risk_why}` : ''}`);
  return parts.join('\n').slice(0, 5500);
}

export default function ExplainThis({
  projectId, kind = 'blocker', title = '', status = '', text = '', cardId = null,
  size = 'sm', className = '',
}) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState(null);   // cached explanation (per this card instance)
  const [failed, setFailed] = useState(false);
  const [followups, setFollowups] = useState([]); // [{ question, answer|null, failed }]
  const [question, setQuestion] = useState('');
  const [asking, setAsking] = useState(false);

  const fetchExplanation = useCallback(async () => {
    if (data || loading) return; // cache: don't refetch once we have it (or are fetching)
    setLoading(true);
    setFailed(false);
    try {
      const res = await api.mock2ExplainCard(projectId, {
        text, kind, ...(title ? { title } : {}), ...(status ? { status } : {}), ...(cardId ? { card_id: String(cardId) } : {}),
      });
      if (res?.ok && res.explanation) setData(res.explanation);
      else setFailed(true);
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, [projectId, text, kind, title, status, cardId, data, loading]);

  const onOpenChange = (v) => {
    setOpen(v);
    if (v) fetchExplanation();
  };

  // Ask a follow-up: same endpoint, with the operator's question + the explanation
  // (and earlier answers) as context. Answers append to the Q&A thread.
  const askFollowup = async () => {
    const q = question.trim();
    if (!q || asking) return;
    setAsking(true);
    setQuestion('');
    setFollowups((list) => [...list, { question: q, answer: null, failed: false }]);
    const prior = [
      explanationAsText(data),
      ...followups.filter((f) => f.answer).map((f) => `Q: ${f.question}\nA: ${f.answer}`),
    ].filter(Boolean).join('\n\n').slice(0, 5900);
    let answer = null;
    let ok = false;
    try {
      const res = await api.mock2ExplainCard(projectId, {
        text, kind, question: q, prior,
        ...(title ? { title } : {}), ...(status ? { status } : {}), ...(cardId ? { card_id: String(cardId) } : {}),
      });
      if (res?.ok && res.answer) { ok = true; answer = res.answer; }
    } catch { /* falls through to the failed marker */ }
    setFollowups((list) => list.map((f, i) => (
      i === list.length - 1 ? { ...f, answer, failed: !ok } : f
    )));
    setAsking(false);
  };

  if (!text) return null;

  return (
    <>
      <Button
        type="button" variant="ghost" size={size}
        className={`h-8 px-2 text-xs text-muted-foreground hover:text-foreground ${className}`}
        onClick={() => onOpenChange(true)}
      >
        <Sparkles className="h-3.5 w-3.5 mr-1" /> Explain this
      </Button>

      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-full h-full rounded-none flex flex-col sm:max-w-4xl sm:h-auto sm:max-h-[90vh] sm:rounded-lg">
          <DialogHeader className="shrink-0">
            <DialogTitle className="flex items-center gap-2 text-lg sm:text-xl">
              <Sparkles className="h-5 w-5 shrink-0" /> In plain language
            </DialogTitle>
          </DialogHeader>

          <div className="mx-auto w-full max-w-[70ch] flex-1 min-h-0 overflow-y-auto">
            {loading ? (
              <div className="flex items-center justify-center gap-2 py-10 text-base text-muted-foreground">
                <Loader2 className="h-5 w-5 animate-spin" /> Putting this in plain words…
              </div>
            ) : data ? (
              <div className="space-y-6 text-[17px] leading-relaxed text-foreground sm:text-lg">
                {data.risk_level ? (
                  <div className="flex flex-col gap-1.5">
                    <span className={`inline-flex w-fit items-center rounded-full border px-3 py-1 text-sm font-semibold uppercase tracking-wide ${RISK_TONE[data.risk_level] || RISK_TONE.medium}`}>
                      {data.risk_level} risk
                    </span>
                    {data.risk_why ? <p className="text-base text-muted-foreground">{data.risk_why}</p> : null}
                  </div>
                ) : null}
                {SECTIONS.map(([key, heading]) => (data[key] ? (
                  <section key={key} className="space-y-1.5">
                    <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">{heading}</h3>
                    <p className="whitespace-pre-wrap">{data[key]}</p>
                  </section>
                ) : null))}

                {/* Follow-up Q&A thread — every question the operator asked about
                    this card, answered by the same plain-language lane. */}
                {followups.length ? (
                  <div className="space-y-4 border-t pt-4">
                    {followups.map((f, i) => (
                      <div key={i} className="space-y-1.5">
                        <p className="flex items-start gap-2 font-medium">
                          <HelpCircle className="h-5 w-5 mt-1 shrink-0 text-muted-foreground" />
                          <span className="whitespace-pre-wrap">{f.question}</span>
                        </p>
                        {f.answer ? (
                          <p className="whitespace-pre-wrap pl-7">{f.answer}</p>
                        ) : f.failed ? (
                          <p className="pl-7 text-base text-amber-600">An answer isn’t available right now — try asking again.</p>
                        ) : (
                          <p className="flex items-center gap-2 pl-7 text-base text-muted-foreground">
                            <Loader2 className="h-4 w-4 animate-spin" /> Thinking…
                          </p>
                        )}
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : failed ? (
              <div className="space-y-2">
                <p className="text-base text-amber-600">
                  A plain-language explanation isn’t available right now. Here’s the original message:
                </p>
                <pre className="max-h-[50vh] overflow-y-auto whitespace-pre-wrap break-words rounded-md border bg-muted/40 p-3 text-sm text-foreground/90">
                  {text}
                </pre>
              </div>
            ) : null}
          </div>

          {/* Follow-up composer — always at the bottom once an explanation is up.
              44px touch targets; Enter sends (Shift+Enter for a new line). */}
          {data ? (
            <div className="mx-auto w-full max-w-[70ch] shrink-0 border-t pt-3">
              <div className="flex items-end gap-2">
                <textarea
                  className="flex min-h-[48px] flex-1 rounded-md border border-input bg-transparent px-3 py-2.5 text-base shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-60"
                  placeholder="Ask a follow-up question about this…"
                  rows={1}
                  value={question}
                  disabled={asking}
                  onChange={(e) => setQuestion(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); askFollowup(); }
                  }}
                />
                <Button className="h-12 shrink-0 px-4" disabled={asking || !question.trim()} onClick={askFollowup}>
                  {asking ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                  <span className="ml-1.5 hidden sm:inline">Ask</span>
                </Button>
              </div>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}
