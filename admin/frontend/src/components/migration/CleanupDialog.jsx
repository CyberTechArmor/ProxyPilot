// Throw away what a finished migration left behind.
//
// The dialog leads with the PLAN, not with the checkboxes: it asks the server
// what each choice would do (dry run) and shows the answer — which guest, in
// what state, and whether ProxyPilot created it — before the destructive
// button is enabled. A refusal (a guest that was adopted rather than created,
// a guest serving a route, a migration still running) arrives the same way,
// so the operator reads it here instead of after clicking.

import { useCallback, useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Loader2, Trash2 } from 'lucide-react';
import { ApiError, api } from '@/lib/api';
import { BTN, DIALOG_BODY, DIALOG_SM, Checkbox, KV, Notice } from './shared';

export default function CleanupDialog({ open, migration, onClose, onDone }) {
  const [deleteGuest, setDeleteGuest] = useState(true);
  const [removeRecord, setRemoveRecord] = useState(false);
  const [exportFirst, setExportFirst] = useState(false);
  const [force, setForce] = useState(false);
  const [plan, setPlan] = useState(null);
  const [refusal, setRefusal] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const id = migration?.id;
  const target = migration?.target?.incus_name || migration?.target;

  // Ask the server what this would do, every time the choice changes.
  const preview = useCallback(async () => {
    if (!open || !id || (!deleteGuest && !removeRecord)) { setPlan(null); setRefusal(null); return; }
    try {
      const r = await api.migrations.cleanup(id, { deleteGuest, removeRecord, exportFirst, force, dryRun: true });
      setPlan(r.would || null); setRefusal(null);
    } catch (e) {
      setPlan(null);
      setRefusal(e instanceof ApiError ? (e.body?.error || e.message) : e.message);
    }
  }, [open, id, deleteGuest, removeRecord, exportFirst, force]);

  useEffect(() => { preview(); }, [preview]);
  useEffect(() => { if (open) { setError(null); setBusy(false); } }, [open]);

  const apply = async () => {
    setBusy(true); setError(null);
    try {
      const r = await api.migrations.cleanup(id, { deleteGuest, removeRecord, exportFirst, force });
      onDone?.(r);
    } catch (e) {
      setError(e instanceof ApiError ? (e.body?.error || e.message) : e.message);
    } finally { setBusy(false); }
  };

  const nothingChosen = !deleteGuest && !removeRecord;

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose?.(); }}>
      <DialogContent className={DIALOG_SM}>
        <DialogHeader>
          <DialogTitle>Clean up migration #{id}</DialogTitle>
          <DialogDescription className="break-words">
            This removes things permanently. Nothing here touches the source host.
          </DialogDescription>
        </DialogHeader>

        <div className={DIALOG_BODY}>
          <Checkbox
            checked={deleteGuest}
            onChange={setDeleteGuest}
            label={`Delete the guest ${target || ''}`}
            hint="Only a guest this migration created, and only when no route points at it."
          />
          <Checkbox
            checked={removeRecord}
            onChange={setRemoveRecord}
            label="Remove the migration record"
            hint="The row and its event log — the evidence of what this run did."
          />
          {deleteGuest && (
            <>
              <Checkbox
                checked={exportFirst}
                onChange={setExportFirst}
                label="Export the guest to a tarball first"
                hint="Slow, and usually pointless for a migration that failed: the source it came from is still standing."
              />
              <Checkbox
                checked={force}
                onChange={setForce}
                label="Stop it hard if it will not stop cleanly"
              />
            </>
          )}

          {refusal && <Notice level="error"><p className="break-words">{refusal}</p></Notice>}

          {plan && (
            <div className="rounded border p-3 space-y-1">
              <p className="text-xs text-muted-foreground">What will happen</p>
              {plan.delete_guest
                ? <KV label="Guest">{plan.target} — {plan.guest?.status || 'unknown'}, deleted</KV>
                : <KV label="Guest">left alone</KV>}
              <KV label="Record">{plan.remove_record ? `migration #${plan.migration} and its log, deleted` : 'kept'}</KV>
              {plan.export && <KV label="Export">{plan.export}</KV>}
            </div>
          )}

          {error && <Notice level="error"><p className="break-words">{error}</p></Notice>}
        </div>

        <DialogFooter className="flex-col sm:flex-row gap-2">
          <Button variant="outline" className={BTN} onClick={onClose} disabled={busy}>Cancel</Button>
          <Button
            variant="destructive"
            className={BTN}
            disabled={busy || nothingChosen || !!refusal || !plan}
            onClick={apply}
          >
            {busy ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <Trash2 className="h-4 w-4 mr-1.5" />}
            {plan?.delete_guest && plan?.remove_record ? 'Delete both' : plan?.delete_guest ? 'Delete the guest' : 'Remove the record'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
