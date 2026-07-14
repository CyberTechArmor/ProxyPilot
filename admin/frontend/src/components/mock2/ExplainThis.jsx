// ExplainThis — a reusable "Explain this" button + reading-first popup, dropped onto
// every blocker, authorization request, framework-deviation, and rule-question card.
//
// The card text is written by the build model for engineers (timestamps, hashes,
// §-references, SQL); operators need the meaning at a glance. On open, this sends the
// card's full text + minimal cycle context (task title, status) to the summary lane
// (a small/fast model) and renders the reply as five plain-language sections + a risk
// badge. It is read-only: it never resumes, grants, or resolves anything, and the
// explanation is CACHED per card so re-opening is instant. If the explainer fails, it
// shows the original text with a notice — the operator is never blocked on it.
//
// MOBILE_FIRST: the modal fills the screen on small widths, caps the reading measure at
// ~65ch, and uses ≥16px body text with generous line height. Clean at 360px.

import { useCallback, useState } from 'react';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Loader2, Sparkles } from 'lucide-react';

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

export default function ExplainThis({
  projectId, kind = 'blocker', title = '', status = '', text = '', cardId = null,
  size = 'sm', className = '',
}) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState(null);   // cached explanation (per this card instance)
  const [failed, setFailed] = useState(false);

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
        <DialogContent className="max-w-full h-full rounded-none overflow-y-auto sm:max-w-2xl sm:h-auto sm:max-h-[85vh] sm:rounded-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-base">
              <Sparkles className="h-4 w-4 shrink-0" /> In plain language
            </DialogTitle>
          </DialogHeader>

          <div className="mx-auto w-full max-w-[65ch]">
            {loading ? (
              <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Putting this in plain words…
              </div>
            ) : data ? (
              <div className="space-y-5 text-[16px] leading-relaxed text-foreground">
                {data.risk_level ? (
                  <div className="flex flex-col gap-1.5">
                    <span className={`inline-flex w-fit items-center rounded-full border px-2.5 py-1 text-xs font-semibold uppercase tracking-wide ${RISK_TONE[data.risk_level] || RISK_TONE.medium}`}>
                      {data.risk_level} risk
                    </span>
                    {data.risk_why ? <p className="text-sm text-muted-foreground">{data.risk_why}</p> : null}
                  </div>
                ) : null}
                {SECTIONS.map(([key, heading]) => (data[key] ? (
                  <section key={key} className="space-y-1">
                    <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{heading}</h3>
                    <p className="whitespace-pre-wrap">{data[key]}</p>
                  </section>
                ) : null))}
              </div>
            ) : failed ? (
              <div className="space-y-2">
                <p className="text-sm text-amber-600">
                  A plain-language explanation isn’t available right now. Here’s the original message:
                </p>
                <pre className="max-h-[50vh] overflow-y-auto whitespace-pre-wrap break-words rounded-md border bg-muted/40 p-3 text-xs text-foreground/90">
                  {text}
                </pre>
              </div>
            ) : null}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
