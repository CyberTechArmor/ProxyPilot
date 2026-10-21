// Application storage → the cleanup review (DESIGN §3.1, §7). Lists the exact
// selection by category, each with a remove control; the estimate and its
// notes; the snapshot warning and acknowledgement when snapshots are
// included; and ONE button, "Clean up N items". That POST is the approval:
// the sudo prompt from api.js may ask who you are, and nothing asks again
// after it. Once the server accepts, the same dialog follows the cleanup
// (CleanupResult). Full screen below sm (MOBILE_FIRST.md §3).

import { useState } from 'react';
import { AlertTriangle, Loader2, Sparkles, X } from 'lucide-react';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { BTN, Checkbox, DIALOG_BODY, DIALOG_LG, Notice } from '@/components/storage/shared';
import {
  acknowledgeSnapshots, cleanupRequest, deselectItem, estimateSelection, estimateText, formatSize,
  needsAcknowledgement, reviewGroups, selectedCount, selectionFor, setSelected,
} from './app-storage-model.mjs';
import { NOTHING_SELECTED, SNAPSHOT_ACK, SNAPSHOT_WARNING, TEXT } from './app-storage-text.js';
import CleanupResult from './CleanupResult.jsx';

function ReviewBody({ check, selection, onSelectionChange, blocked }) {
  const groups = reviewGroups(check, selection);
  const est = estimateSelection(check, selection);
  const n = selectedCount(selection);
  if (!n) return <Notice level="info"><p>{TEXT.reviewEmpty}</p></Notice>;
  return (
    <>
      <div className="space-y-3">
        {groups.map((g) => (
          <section key={g.key} aria-label={g.label} className="border rounded-lg">
            <h3 className="px-3 pt-3 text-sm font-medium">{g.label} <span className="text-muted-foreground font-normal">({g.items.length})</span></h3>
            <ul className="divide-y">
              {g.items.map((item) => (
                <li key={item.id} className={`flex items-start gap-2 p-3 ${blocked.has(item.id) ? 'bg-red-500/10' : ''}`} data-review-item={item.id}>
                  <div className="min-w-0 flex-1 space-y-0.5">
                    <p className="text-sm break-words">{item.label}</p>
                    {item.path && item.path !== item.label && <p className="font-mono text-xs text-muted-foreground break-all">{item.path}</p>}
                    <p className="text-xs text-muted-foreground">{formatSize(item.recoverableBytes ?? item.allocatedBytes, item.recoverableBytes != null ? 'estimate' : item.precision)}{item.memoryBacked ? ` · ${TEXT.usesMemory}` : ''}</p>
                    {blocked.get(item.id) && <p className="text-xs text-red-500 break-words">{blocked.get(item.id)}</p>}
                  </div>
                  <Button type="button" variant="ghost" size="icon" className="h-11 w-11 shrink-0" aria-label={TEXT.removeFromCleanup(item.label)} onClick={() => onSelectionChange(deselectItem(check, selection, item.id))}>
                    <X className="h-4 w-4" />
                  </Button>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
      <div className="rounded-lg border p-3 space-y-1" aria-live="polite">
        <p className="text-xs text-muted-foreground">{TEXT.estimateTitle}</p>
        <p className="text-base font-semibold" data-testid="review-estimate">{estimateText(est)}</p>
        {est.notes.length > 0 && <ul className="list-disc pl-4 text-xs text-muted-foreground space-y-0.5">{est.notes.map((note) => <li key={note} className="break-words">{note}</li>)}</ul>}
      </div>
      {needsAcknowledgement(selection) && (
        <div className="space-y-2">
          <Notice level="warn"><p>{SNAPSHOT_WARNING}</p></Notice>
          <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3">
            <Checkbox checked={selection.acknowledged} onChange={(v) => onSelectionChange(acknowledgeSnapshots(selection, v))} label={SNAPSHOT_ACK} />
          </div>
        </div>
      )}
    </>
  );
}

/** Offending items of a NOT_ELIGIBLE refusal: { id, reason }[] (shape noted in contract-changes.md). */
function refusedItems(err) {
  const d = err?.details || {};
  const list = Array.isArray(d.items) ? d.items : Array.isArray(d.offending) ? d.offending : Array.isArray(d.ids) ? d.ids.map((id) => ({ id })) : [];
  return list.filter((x) => x && typeof x.id === 'string');
}

export default function CleanupReview({
  open, onClose, target, check, selection: rawSelection, onSelectionChange, cleanupId, onStarted, onRunCheck, client = api,
}) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [message, setMessage] = useState('');
  const [blocked, setBlocked] = useState(new Map());
  const selection = selectionFor(check, rawSelection);
  const n = selectedCount(selection);
  const req = cleanupRequest(check, selection);

  const reset = () => { setError(null); setMessage(''); setBlocked(new Map()); };
  const close = (v) => { if (!v && !submitting) { reset(); onClose(); } };
  const change = (next) => { setError(null); setMessage(''); onSelectionChange(next); };

  const submit = async () => {
    reset();
    if (!req.send) { setMessage(req.message || NOTHING_SELECTED); return; }
    setSubmitting(true);
    try {
      const res = await client.appStorage.requestCleanup(target.kind, target.id, req.body);
      if (res?.changed === false || !res?.cleanupId) { setMessage(res?.message || NOTHING_SELECTED); return; }
      onStarted(res);
    } catch (err) {
      if (err?.code === 'NOT_ELIGIBLE') {
        const bad = refusedItems(err);
        setBlocked(new Map(bad.map((b) => [b.id, b.reason || ''])));
      }
      setError(err);
    } finally {
      setSubmitting(false);
    }
  };

  const errorBox = error && (
    <Notice level="error">
      <p className="font-medium">{error.code === 'NOT_ELIGIBLE' ? TEXT.notEligibleTitle : TEXT.cleanupRefused}</p>
      <p>{error.status === 401 && /cancel/i.test(error.message || '') ? TEXT.approvalCancelled : error.message}</p>
      {error.code === 'CHECK_STALE' && <Button type="button" variant="outline" className={`${BTN} mt-1`} onClick={() => { reset(); onRunCheck(); }}>{TEXT.runNewCheck}</Button>}
      {error.code === 'NOT_ELIGIBLE' && blocked.size > 0 && (
        <Button type="button" variant="outline" className={`${BTN} mt-1`} onClick={() => { change(setSelected(check, selection, [...blocked.keys()], false)); setBlocked(new Map()); }}>{TEXT.removeRefused}</Button>
      )}
    </Notice>
  );

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className={DIALOG_LG} aria-describedby={cleanupId ? undefined : 'cleanup-review-description'}>
        {cleanupId ? (
          <CleanupResult cleanupId={cleanupId} client={client} onRunCheck={onRunCheck} onClose={() => close(false)} />
        ) : (
          <>
            <DialogHeader className="pr-8">
              <DialogTitle className="flex items-center gap-2"><Sparkles className="h-5 w-5 text-primary shrink-0" />{TEXT.reviewTitle}</DialogTitle>
              <DialogDescription id="cleanup-review-description">{TEXT.reviewDescription}</DialogDescription>
            </DialogHeader>
            <div className={DIALOG_BODY}>
              <ReviewBody check={check} selection={selection} onSelectionChange={change} blocked={blocked} />
              {message && <Notice level="info"><p role="status">{message}</p></Notice>}
              {errorBox}
            </div>
            <DialogFooter className="gap-2 sm:gap-0">
              <Button type="button" variant="outline" className={BTN} onClick={() => close(false)} disabled={submitting}>{TEXT.cancel}</Button>
              <Button type="button" className={BTN} onClick={submit} disabled={submitting || !req.send}>
                {submitting ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : req.reason === 'acknowledgement-required' ? <AlertTriangle className="h-4 w-4 mr-1.5" /> : <Sparkles className="h-4 w-4 mr-1.5" />}
                {submitting ? TEXT.starting : TEXT.cleanUp(n)}
              </Button>
            </DialogFooter>
            {req.reason === 'acknowledgement-required' && <p className="text-xs text-amber-600 dark:text-amber-400 sm:text-right -mt-2">{TEXT.ackPending}</p>}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
