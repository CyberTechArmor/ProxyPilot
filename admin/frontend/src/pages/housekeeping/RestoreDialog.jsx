// Restore dialog — operator picks one of two paths:
//   * Dry run (sandbox extract + manifest verify, no production
//     side effects).  This is target='sandbox' on the wire.
//   * Restore production (in_place; config tier only).  Auto-
//     creates a safety backup before any production write so
//     the operator can roll back from disk if anything goes
//     wrong.  This is target='in_place' on the wire.
// POST returns 202 + run_id; the caller switches into a 'tail
// logs' panel that polls GET /restores/:id.

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { AlertTriangle, Loader2, Play, Sparkles, Shield } from 'lucide-react';

const MODES = {
  sandbox: {
    label: 'Dry run',
    short: 'Dry run',
    body:
      'Decrypt + extract every file under a per-run sandbox dir on this host. ' +
      'Production state is untouched. Use this to verify the backup is structurally sound ' +
      'or to inspect its contents before committing.',
  },
  in_place: {
    label: 'Restore production',
    short: 'Restore production',
    body:
      'Apply the backup to the live host: replace .env, the cve-inbox tree, and import ' +
      'the SQLite DB from the dump.  ALWAYS takes a safety-fallback config backup of ' +
      'the current state first; the safety file path is recorded in the run notes so ' +
      'you can roll back manually if the restore goes sideways.',
  },
};

// What each tier captures (and therefore what gets restored
// when target=in_place).  Surfaced verbatim in the production-
// restore callout so the operator knows exactly which files are
// about to be overwritten.
const TIER_CONTENTS = {
  config: [
    'SQLite DB (proxypilot.db) — services, routes, L4 forwards, users, schedules, audit log, etc.',
    '.env — encryption key, admin domain, and any other env-driven config',
    '/var/lib/proxypilot/cve-inbox — security inbox state',
  ],
  config_plus_data: [
    'Everything in the config tier (DB + .env + cve-inbox), PLUS:',
    '/etc/caddy — Caddyfile + per-site fragments',
    '/etc/wireguard — wg-quick configs',
    '/var/lib/caddy/.local/share/caddy — Caddy ACME state (issued certs + private keys)',
    '/opt/proxypilot/data/services — per-service data directories',
  ],
  full: [
    'Everything in config_plus_data, PLUS:',
    'Per-volume Docker volume tarballs',
    'Per-instance Incus exports',
    '(In-place restore not yet supported for this tier — use Dry run + manual restore.)',
  ],
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
  const inPlaceAllowed = backup.tier === 'config' || backup.tier === 'config_plus_data';
  const inPlaceBlocked = target === 'in_place' && !inPlaceAllowed;
  const canSubmit = !busy && matchesId && passphraseOk && !!target && hasAnyCopy && !inPlaceBlocked;

  const submit = async () => {
    setBusy(true); setError(null);
    try {
      const { api } = await import('@/lib/api');
      const out = await api.backupsRestore(backup.id, {
        // Server's restore mode enum is 'dry_run' | 'apply'.
        // target='in_place' actually writes; everything else is a
        // dry-run regardless of the mode field.
        mode: target === 'in_place' ? 'apply' : 'dry_run',
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

  const desc = MODES[target];

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {target === 'in_place' ? 'Restore production' : 'Restore (dry run)'}
          </DialogTitle>
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
            <Label>Mode</Label>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setTarget('sandbox')}
                className={`text-left rounded border px-3 py-2 transition-colors ${
                  target === 'sandbox'
                    ? 'border-primary bg-primary/10'
                    : 'border-border hover:border-primary/50'
                }`}
              >
                <div className="flex items-center gap-2 font-medium">
                  <Sparkles className="h-3 w-3" /> Dry run
                </div>
                <p className="text-[11px] text-muted-foreground mt-1">
                  Sandbox extract; production untouched.
                </p>
              </button>
              <button
                type="button"
                onClick={() => setTarget('in_place')}
                disabled={!inPlaceAllowed}
                className={`text-left rounded border px-3 py-2 transition-colors ${
                  target === 'in_place'
                    ? 'border-red-500 bg-red-500/10'
                    : inPlaceAllowed
                      ? 'border-border hover:border-red-500/50'
                      : 'border-border opacity-50 cursor-not-allowed'
                }`}
                title={inPlaceAllowed
                  ? 'Apply to production with safety fallback'
                  : `In-place restore supports config / config_plus_data tiers only (this backup is ${backup.tier}).`}
              >
                <div className="flex items-center gap-2 font-medium">
                  <Shield className="h-3 w-3" /> Restore production
                </div>
                <p className="text-[11px] text-muted-foreground mt-1">
                  {inPlaceAllowed
                    ? 'Live restore; safety backup auto-taken first.'
                    : `Config / config+data only (this is ${backup.tier}).`}
                </p>
              </button>
            </div>
            {desc && (
              <p className="text-[11px] text-muted-foreground border-l-2 pl-2 mt-1">
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

          {target === 'sandbox' ? (
            <div className="text-xs text-amber-700 dark:text-amber-400 border border-amber-500/30 bg-amber-500/10 rounded px-3 py-2 flex gap-2">
              <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
              <span>
                <strong>Dry run.</strong> Production data on disk is not touched. After the run
                completes, the sandbox dir path lives in the restore-runs panel for your
                inspection.
              </span>
            </div>
          ) : (
            <div className="text-xs text-red-700 dark:text-red-400 border border-red-500/30 bg-red-500/10 rounded px-3 py-2 space-y-2">
              <div className="flex gap-2">
                <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
                <span>
                  <strong>Production restore.</strong> A safety-fallback backup of the
                  current state lands at{' '}
                  <code className="font-mono text-[10px]">/var/lib/proxypilot/backups/safety-pre-restore-&lt;id&gt;.ppbackup</code>
                  {' '}before anything is overwritten.  If a write fails, the SQLite
                  transaction rolls back automatically; file-system writes that
                  already landed need a manual rollback from the safety file.
                </span>
              </div>
              {TIER_CONTENTS[backup.tier] && (
                <div className="border-t border-red-500/30 pt-2">
                  <p className="font-medium mb-1">This will overwrite:</p>
                  <ul className="list-disc pl-5 space-y-0.5">
                    {TIER_CONTENTS[backup.tier].map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                  <p className="mt-1.5 text-[11px] text-red-600 dark:text-red-300/90">
                    After: run <code className="font-mono">docker compose restart admin</code>
                    {' '}so the new .env / DB take effect
                    {backup.tier === 'config_plus_data'
                      ? '; reload Caddy and restart WireGuard if you changed those configs.'
                      : '.'}
                  </p>
                </div>
              )}
            </div>
          )}

          {error && (
            <div className="text-xs text-red-500 border border-red-500/30 bg-red-500/10 rounded px-3 py-2">
              {error}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
          <Button
            onClick={submit}
            disabled={!canSubmit}
            className={target === 'in_place' ? 'bg-red-600 hover:bg-red-700' : undefined}
          >
            {busy ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
              : target === 'in_place' ? <Shield className="h-4 w-4 mr-1.5" />
              : <Sparkles className="h-4 w-4 mr-1.5" />}
            {target === 'in_place' ? 'Restore production' : 'Start dry run'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
