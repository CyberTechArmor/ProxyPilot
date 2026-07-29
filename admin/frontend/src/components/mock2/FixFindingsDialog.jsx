// The Fix dialog — pick which findings to fix, and say anything else first.
//
// "Please fix so the 'Fix' option shows a popup with all those points (allow
//  checkbox to deselect, and add an input box so that the user can add
//  additional (optional) information (including images))."
//
// WHY A DIALOG RATHER THAN A BUTTON. A design review returns five to eight
// findings and they are never equally welcome: one is the reason the operator
// pressed Screen check, two are real but not now, and one is a matter of taste
// they disagree with. A single "Fix these" sends all of them — which means the
// only way to fix ONE thing was to re-type it into the composer by hand, and
// the only way to skip one was not to press the button at all.
//
// So: every finding is a row with a tick, all on by default (the common case is
// "yes, all of it"), and the instruction is composed from what SURVIVES rather
// than from the message. Unticking four of seven is the operator saying
// something, and sending the original text would throw it away.
//
// The note and the images are the other half — what the operator knows that six
// screenshots cannot show. A photo of the screen on a real phone, a scribble
// over the layout they want, or one sentence about which finding matters.
//
// MOBILE_FIRST: full-screen below sm, one column throughout, 44px targets, and
// the whole thing completable at 360px — a list of seven findings with a note
// field is exactly the dialog that breaks that rule if nobody checks.

import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Loader2, Zap } from 'lucide-react';
import { KIND_LABEL, composeFixInstruction, groupFindings, severityRank } from '@/lib/findings';
import { useChatImages, ImageAttachmentBar } from './ImageAttachments';
import { toWireImages } from '@/lib/chat-images';
import { useToast } from '@/hooks/use-toast';

const SEVERITY_STYLE = {
  critical: 'bg-destructive/15 text-destructive',
  high: 'bg-destructive/15 text-destructive',
  serious: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
  medium: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
  moderate: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
};

export default function FixFindingsDialog({ open, onOpenChange, findings = [], busy = false, onSend }) {
  const { toast } = useToast();
  const attach = useChatImages({
    onError: (m) => toast({ variant: 'destructive', title: 'Image not attached', description: m }),
  });
  // All on by default: the common case is "yes, all of it", and a dialog that
  // opens with nothing ticked makes the operator do the work twice.
  const [off, setOff] = useState(() => new Set());
  const [note, setNote] = useState('');

  // Severity order, then the order the review wrote them. A list a person is
  // about to tick through should put the thing they came for at the top.
  const ordered = useMemo(
    () => [...findings].sort((a, b) => severityRank(a.severity) - severityRank(b.severity)),
    [findings],
  );
  const picked = ordered.filter((f) => !off.has(f.id));

  const toggle = (id) => setOff((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  // Small related groups by screen (redesign 6.c): the fix request is composed
  // per group in the short, referent-anchored P34 style, and the group header
  // lets an operator take or leave a whole screen in one tap.
  const groups = useMemo(() => groupFindings(ordered), [ordered]);
  const toggleGroup = (g) => setOff((prev) => {
    const next = new Set(prev);
    const allOn = g.findings.every((f) => !prev.has(f.id));
    for (const f of g.findings) { if (allOn) next.add(f.id); else next.delete(f.id); }
    return next;
  });

  const send = () => {
    const text = composeFixInstruction(picked, note);
    if (!text) return;
    onSend({ text, images: toWireImages(attach.images) });
  };

  return (
    <Dialog open={open} onOpenChange={busy ? undefined : onOpenChange}>
      {/* Full-screen below sm, matching every other dialog in this folder:
          seven findings, a note box and an image bar do not fit in a centred
          card on a phone, and a dialog that scrolls its own page instead of its
          own body puts the Send button somewhere nobody can reach. */}
      <DialogContent className="flex h-full max-w-full flex-col gap-0 overflow-hidden rounded-none p-0 sm:h-[85vh] sm:max-w-2xl sm:rounded-lg">
        <DialogHeader className="shrink-0 border-b px-4 py-3 text-left">
          <DialogTitle className="text-base">Fix the findings</DialogTitle>
          <p className="text-xs text-muted-foreground">
            Untick anything you do not want changed. Everything ticked goes into one build.
          </p>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          <ul className="space-y-3">
            {groups.map((g) => (
              <li key={g.screen}>
                {/* Group header: the screen the review named. One tap takes or
                    leaves the whole group; ≥44px target on touch. */}
                <div className="mb-1.5 flex items-center justify-between gap-2">
                  <code className="min-w-0 break-all font-mono text-[11px] font-medium text-muted-foreground">{g.screen}</code>
                  <button
                    type="button" disabled={busy} onClick={() => toggleGroup(g)}
                    className="min-h-[44px] shrink-0 px-2 text-[11px] text-muted-foreground underline underline-offset-2 sm:min-h-0"
                  >
                    {g.findings.every((f) => !off.has(f.id)) ? 'Untick group' : 'Tick group'}
                  </button>
                </div>
                <ul className="space-y-2">
                  {g.findings.map((f) => {
                    const on = !off.has(f.id);
                    return (
                      <li key={f.id}>
                  {/* The whole row is the target, not a 16px checkbox — this is
                      a list somebody ticks through on a phone. */}
                  <label
                    className={`flex cursor-pointer gap-3 rounded-md border p-2.5 ${on ? 'bg-muted/40' : 'opacity-55'}`}
                  >
                    <input
                      type="checkbox" checked={on} onChange={() => toggle(f.id)} disabled={busy}
                      className="mt-0.5 h-5 w-5 shrink-0 accent-current"
                    />
                    <span className="min-w-0 flex-1 space-y-1">
                      <span className="flex flex-wrap items-center gap-1.5">
                        <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium uppercase ${SEVERITY_STYLE[f.severity] || 'bg-muted text-muted-foreground'}`}>
                          {f.severity}
                        </span>
                        {f.kind !== 'design' ? (
                          <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase text-muted-foreground">
                            {KIND_LABEL[f.kind] || f.kind}
                          </span>
                        ) : null}
                        <code className="min-w-0 break-all font-mono text-[11px] text-muted-foreground">{f.scope}</code>
                      </span>
                      <span className="block break-words text-xs">{f.issue}</span>
                      {f.fix ? (
                        <span className="block break-words text-[11px] text-muted-foreground">
                          <span className="font-medium">Fix:</span> {f.fix}
                        </span>
                      ) : null}
                    </span>
                  </label>
                      </li>
                    );
                  })}
                </ul>
              </li>
            ))}
          </ul>

          <div className="mt-4 space-y-2">
            <label className="text-xs font-medium" htmlFor="fix-note">
              Anything else <span className="font-normal text-muted-foreground">(optional)</span>
            </label>
            <textarea
              id="fix-note" rows={3} value={note} disabled={busy}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Which finding matters most, what to leave alone, or something the screenshots cannot show…"
              className="w-full resize-y rounded-md border bg-background px-2.5 py-2 text-xs"
            />
            <p className="text-[11px] text-muted-foreground">
              This wins wherever it disagrees with the list above — you are looking at the running app, the
              review is looking at six pictures of it.
            </p>
            {/* Images are part of "anything else": a photo of the screen on a
                real phone, or a scribble over the layout they want, says what a
                paragraph cannot. */}
            <ImageAttachmentBar
              images={attach.images} busy={attach.busy} disabled={busy}
              onPickFiles={attach.addFiles} onRemove={attach.remove}
            />
          </div>
        </div>

        <DialogFooter className="shrink-0 flex-col gap-2 border-t px-4 py-3 sm:flex-row sm:justify-between">
          <span className="text-xs text-muted-foreground">
            {picked.length} of {ordered.length} finding{ordered.length === 1 ? '' : 's'} selected
          </span>
          <span className="flex flex-col gap-2 sm:flex-row">
            <Button variant="outline" className="min-h-[44px] sm:min-h-0" disabled={busy} onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button className="min-h-[44px] sm:min-h-0" disabled={busy || !picked.length} onClick={send}>
              {busy ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Zap className="mr-1 h-4 w-4" />}
              {picked.length === ordered.length ? 'Fix all of these' : `Fix ${picked.length} of these`}
            </Button>
          </span>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
