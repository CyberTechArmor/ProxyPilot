// Restore dialog — operator picks a target (sandbox vs manifest-
// only), passphrase, and (when applicable) whether to re-import
// Incus instances.  POST returns 202 + run_id; the caller switches
// into a 'tail logs' panel that polls GET /restores/:id.

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { AlertTriangle, Loader2, Play, Sparkles } from 'lucide-react';

const TARGET_DESCRIPTIONS = {
  manifest_only: {
    label: 'Mode C — manifest only',
    body:
      'Decrypt the artifact + verify every file\'s sha256 against the manifest. ' +
      'No disk side effects. Use this as a quick sanity check that a backup is structurally sound.',
  },
  sandbox: {
    label: 'Mode A — sandbox same host',
    body:
      'Decrypt + extract every file under a per-run sandbox directory on the local host. ' +
      'Optionally re-import any Incus instances under a -restore-<short-id> suffix on a private bridge ' +
      '(no public ports). Production state is untouched.',
  },
};

export default function RestoreDialog({ open, onOpenChange, backup, onStarted }) {
  const [target, setTarget] = useState('sandbox');
  const [passphrase, setPassphrase] = useState('');
  const [importIncus, setImportIncus] = useState(false);
  const [confirmId, setConfirmId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!open) return;
    setTarget('sandbox');
    setPassphrase('');
    setImportIncus(false);
    setConfirmId('');
    setError(null);
  }, [open]);

  if (!backup) return null;

  const idShort = backup.id.slice(0, 8);
  const matchesId = confirmId.trim() === backup.id || confirmId.trim() === idShort;
  const passphraseOk = passphrase.length >= 8;
  const hasAnyCopy = !!backup?.has_local || !!backup?.s3_uploaded;
  const canSubmit = !busy && matchesId && passphraseOk && !!target && hasAnyCopy;

  const submit = async () => {
    setBusy(true); setError(null);
    try {
      // Imported lazily so this file stays focused on UI.
      const { api, ApiError } = await import('@/lib/api');
      const out = await api.backupsRestore(backup.id, {
        mode: 'dry_run',
        target,
        passphrase,
        import_incus: target === 'sandbox' ? !!importIncus : undefined,
      });
      onOpenChange(false);
      onStarted?.(out.run_id);
    } catch (err) {
      const { ApiError } = await import('@/lib/api');
      setError(err instanceof ApiError ? err.message : (err?.message || 'restore failed to start'));
    } finally {
      setBusy(false);
    }
  };

  const desc = TARGET_DESCRIPTIONS[target];

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Restore dry-run</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 text-sm">
          <div className="text-xs text-muted-foreground border rounded px-3 py-2 space-y-0.5">
            <div><span className="text-muted-foreground">Backup:</span> <code className="font-mono text-foreground">{backup.id}</code></div>
            <div><span className="text-muted-foreground">Tier:</span> <span className="font-mono">{backup.tier}</span></div>
            <div><span className="text-muted-foreground">Created:</span> {new Date(backup.created_at).toLocaleString()}</div>
            <div className="flex items-center gap-2 pt-1">
              <span className="text-muted-foreground">Source:</span>
              {backup.has_local && (
                <span
                  className="inline-flex items-center text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/30"
                  title="Local copy on this host's disk; will be read from local"
                >
                  local (instant)
                </span>
              )}
              {!backup.has_local && backup.s3_uploaded && (
                <span
                  className="inline-flex items-center text-[10px] px-1.5 py-0.5 rounded bg-sky-500/10 text-sky-600 dark:text-sky-400 border border-sky-500/30"
                  title="No local copy; will be streamed from S3 first"
                >
                  S3 only
                </span>
              )}
              {!backup.has_local && !backup.s3_uploaded && (
                <span className="inline-flex items-center text-[10px] px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/30">
                  no copy available
                </span>
              )}
            </div>
          </div>

          {!backup.has_local && !backup.s3_uploaded && (
            <div className="text-xs text-amber-700 dark:text-amber-400 border border-amber-500/30 bg-amber-500/10 rounded px-3 py-2 flex gap-2">
              <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
              <span>
                Neither a local copy nor an S3 copy of this backup is available — it
                may have been pruned by retention while local-only.  Restore can't
                proceed.
              </span>
            </div>
          )}

          <div className="space-y-1">
            <Label htmlFor="r-target">Target</Label>
            <select id="r-target"
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              value={target} onChange={(e) => setTarget(e.target.value)}
            >
              <option value="sandbox">Sandbox same host (Mode A)</option>
              <option value="manifest_only">Manifest only (Mode C)</option>
            </select>
            {desc && (
              <p className="text-[11px] text-muted-foreground border-l-2 pl-2">
                <strong className="font-semibold">{desc.label}.</strong> {desc.body}
              </p>
            )}
          </div>

          {target === 'sandbox' && (
            <div className="flex items-center gap-3">
              <Switch id="r-import" checked={importIncus} onCheckedChange={setImportIncus} />
              <Label htmlFor="r-import" className="cursor-pointer">
                Re-import Incus instances under -restore-{idShort}
              </Label>
            </div>
          )}

          <div className="space-y-1">
            <Label htmlFor="r-pass">Passphrase</Label>
            <Input id="r-pass" type="password" autoComplete="off"
              value={passphrase} onChange={(e) => setPassphrase(e.target.value)} />
          </div>

          <div className="space-y-1">
            <Label htmlFor="r-confirm">
              Confirm: type the backup id (full or first 8 chars) — <code className="font-mono text-xs">{idShort}</code>
            </Label>
            <Input id="r-confirm" autoComplete="off"
              value={confirmId} onChange={(e) => setConfirmId(e.target.value)}
              placeholder={idShort} />
          </div>

          <div className="text-xs text-amber-700 dark:text-amber-400 border border-amber-500/30 bg-amber-500/10 rounded px-3 py-2 flex gap-2">
            <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
            <span>
              <strong>Dry-run only.</strong> Production data on disk is not touched (Mode A extracts to a
              throwaway sandbox dir; Mode C never touches disk at all). After the run completes, the
              sandbox dir path lives in the restore-runs panel for your inspection.
            </span>
          </div>

          {error && (
            <div className="text-xs text-red-500 border border-red-500/30 bg-red-500/10 rounded px-3 py-2">
              {error}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
          <Button onClick={submit} disabled={!canSubmit}>
            {busy ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <Sparkles className="h-4 w-4 mr-1.5" />}
            Start dry-run
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
