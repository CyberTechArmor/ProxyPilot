// Zip upload dialog — shared by the static-site File Editor
// (Dashboard.jsx) and the LXC container Files tab
// (LxcContainers.jsx). Drives the backend's two-phase flow:
//
//   1. pick      choose the .zip (LXC: plus the target directory)
//   2. uploading multipart upload with progress (XHR)
//   3. review    server-reported contents + conflicts; nothing has
//                been written yet — confirming here is the explicit
//                "replace these files" consent, cancelling discards
//                the staged upload untouched
//   4. applying  extraction on the server / inside the container
//   5. done      result summary (LXC: startup script output + exit)
//
// Props:
//   mode          'service' | 'lxc'
//   open, onOpenChange
//   subjectName   service or container name (title only)
//   upload(file, targetDir, onProgress) → inspect response
//   apply(uploadId, options) → apply response
//   cancel(uploadId)         → discard staged upload (best-effort)
//   onApplied(result)        → refresh caller state
//   defaultTargetDir         (lxc) initial target directory

import { useState, useCallback } from 'react';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  FileArchive, Loader2, AlertTriangle, CheckCircle2, FolderInput,
} from 'lucide-react';

function formatBytes(n) {
  if (!Number.isFinite(n)) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

const NO_SCRIPT = '__none__';

export default function ZipUploadDialog({
  mode, open, onOpenChange, subjectName,
  upload, apply, cancel, onApplied,
  defaultTargetDir = '/opt/app',
}) {
  const isLxc = mode === 'lxc';
  const [phase, setPhase] = useState('pick');
  const [file, setFile] = useState(null);
  const [targetDir, setTargetDir] = useState(defaultTargetDir);
  const [progress, setProgress] = useState(null); // { loaded, total, phase }
  const [inspect, setInspect] = useState(null);   // inspect response
  const [stripWrapper, setStripWrapper] = useState(true);
  // Conflicts reported by a 409 on apply (site changed since
  // inspect) override the inspect-time list until options change.
  const [conflictOverride, setConflictOverride] = useState(null);
  const [startupScript, setStartupScript] = useState(NO_SCRIPT);
  const [runStartup, setRunStartup] = useState(true);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  const reset = useCallback(() => {
    setPhase('pick');
    setFile(null);
    setTargetDir(defaultTargetDir);
    setProgress(null);
    setInspect(null);
    setStripWrapper(true);
    setConflictOverride(null);
    setStartupScript(NO_SCRIPT);
    setRunStartup(true);
    setResult(null);
    setError(null);
  }, [defaultTargetDir]);

  // The variant matching the current wrapper toggle.
  const variant = inspect
    ? (stripWrapper && inspect.wrapperDir && inspect.variants.stripped
      ? inspect.variants.stripped
      : inspect.variants.raw)
    : null;
  const conflicts = conflictOverride ?? variant?.conflicts ?? [];
  const selectedScript = startupScript === NO_SCRIPT ? null : startupScript;
  const scriptAbs = selectedScript && inspect ? `${inspect.targetDir}/${selectedScript}` : null;
  const replacesStartup = Boolean(
    isLxc && inspect?.existingStartup && scriptAbs
    && inspect.existingStartup.scriptPath !== scriptAbs,
  );

  const close = (openState) => {
    if (openState) return;
    // Leaving mid-flow with a staged upload = cancel: nothing has
    // been written server-side; discard the parked archive.
    if (inspect?.uploadId && phase !== 'done') {
      cancel(inspect.uploadId).catch(() => {});
    }
    onOpenChange(false);
    reset();
  };

  const startUpload = async () => {
    if (!file) return;
    setError(null);
    setPhase('uploading');
    setProgress({ loaded: 0, total: file.size, phase: 'uploading' });
    try {
      const res = await upload(file, isLxc ? targetDir : undefined, setProgress);
      setInspect(res);
      // Default the startup selection to the server's suggestion
      // (startup.sh at the zip root) for the initial variant.
      if (isLxc) {
        const v = res.wrapperDir && res.variants.stripped ? res.variants.stripped : res.variants.raw;
        setStartupScript(v.defaultScript || NO_SCRIPT);
      }
      setPhase('review');
    } catch (err) {
      setError(err.message || 'Upload failed');
      setPhase('pick');
    }
  };

  const doApply = async () => {
    setError(null);
    setPhase('applying');
    try {
      const options = {
        stripWrapper: Boolean(stripWrapper && inspect.wrapperDir),
        // Reaching this button with conflicts on screen is the
        // explicit confirmation; with none there is nothing to confirm.
        confirmOverwrite: conflicts.length > 0,
      };
      if (isLxc) {
        options.startupScript = selectedScript;
        options.runStartup = runStartup;
        options.confirmReplaceStartup = replacesStartup;
      }
      const res = await apply(inspect.uploadId, options);
      setResult(res);
      setPhase('done');
      onApplied?.(res);
    } catch (err) {
      if (err.status === 409 && Array.isArray(err.conflicts)) {
        // Contents changed since inspect — show the fresh list and
        // ask again.
        setConflictOverride(err.conflicts);
        setError('The target changed since inspection — please review the updated list and confirm again.');
        setPhase('review');
      } else if (err.status === 409 && err.startupConflict) {
        setError(`A startup script is already registered (${err.startupConflict.scriptPath}). Confirm again to replace it (the old script is kept as .old).`);
        setPhase('review');
      } else if (err.status === 404) {
        setError('The staged upload expired — please upload the zip again.');
        setPhase('pick');
        setInspect(null);
      } else {
        setError(err.message || 'Extraction failed');
        setPhase('review');
      }
    }
  };

  const pct = progress?.total
    ? Math.min(100, Math.round((progress.loaded / progress.total) * 100))
    : 0;

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-w-full h-full rounded-none sm:max-w-lg sm:h-auto sm:max-h-[90vh] sm:rounded-lg flex flex-col overflow-y-auto">
        <DialogHeader className="shrink-0">
          <DialogTitle className="flex items-center gap-2">
            <FileArchive className="h-5 w-5 text-cyan-500" />
            Upload ZIP{subjectName ? ` — ${subjectName}` : ''}
          </DialogTitle>
          <DialogDescription>
            {isLxc
              ? 'Extract a zip into a directory inside the container, with an optional startup script.'
              : 'Extract a zip (e.g. a built dist/ folder) into this site. Existing files are never replaced without confirmation.'}
          </DialogDescription>
        </DialogHeader>

        {error && (
          <div className="rounded-md border border-red-500/40 bg-red-500/10 text-red-600 dark:text-red-400 text-sm p-3 break-words">
            {error}
          </div>
        )}

        {phase === 'pick' && (
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label>Zip file *</Label>
              <Input
                type="file"
                accept=".zip,application/zip"
                onChange={(e) => setFile(e.target.files?.[0] || null)}
              />
            </div>
            {isLxc && (
              <div className="space-y-2">
                <Label>Target directory in container</Label>
                <Input
                  value={targetDir}
                  onChange={(e) => setTargetDir(e.target.value)}
                  placeholder="/opt/app"
                />
                <p className="text-xs text-muted-foreground">
                  Absolute path; created if it doesn't exist.
                </p>
              </div>
            )}
          </div>
        )}

        {phase === 'uploading' && (
          <div className="space-y-3 py-4">
            <div className="flex items-center gap-2 text-sm">
              <Loader2 className="h-4 w-4 animate-spin" />
              {progress?.phase === 'processing' ? 'Inspecting archive…' : `Uploading… ${pct}%`}
            </div>
            <div className="h-2 w-full rounded bg-muted overflow-hidden">
              <div className="h-full bg-cyan-500 transition-all" style={{ width: `${pct}%` }} />
            </div>
            <p className="text-xs text-muted-foreground">
              {formatBytes(progress?.loaded ?? 0)} of {formatBytes(progress?.total ?? 0)}
            </p>
          </div>
        )}

        {phase === 'review' && inspect && (
          <div className="space-y-4 py-2">
            <div className="text-sm text-muted-foreground">
              <span className="text-foreground font-medium">{inspect.filename}</span>
              {' — '}{variant.fileCount} file{variant.fileCount === 1 ? '' : 's'},{' '}
              {formatBytes(inspect.totalUncompressedBytes)} extracted
              {isLxc && <> → <code className="text-foreground">{inspect.targetDir}</code></>}
            </div>

            {inspect.wrapperDir && (
              <div className="flex items-start justify-between gap-3 rounded-md border p-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium">Strip wrapper folder "{inspect.wrapperDir}/"</p>
                  <p className="text-xs text-muted-foreground">
                    Everything in the zip sits inside "{inspect.wrapperDir}/". Strip it so files land
                    at the {isLxc ? 'target directory' : 'site root'} instead of under /{inspect.wrapperDir}/.
                  </p>
                </div>
                <Switch
                  checked={stripWrapper}
                  onCheckedChange={(v) => {
                    setStripWrapper(v);
                    setConflictOverride(null);
                    // The entry paths change with the wrapper option —
                    // re-derive the startup default for the new variant.
                    if (isLxc) {
                      const next = v && inspect.variants.stripped ? inspect.variants.stripped : inspect.variants.raw;
                      setStartupScript(next.defaultScript || NO_SCRIPT);
                    }
                  }}
                />
              </div>
            )}

            {conflicts.length > 0 ? (
              <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 space-y-2">
                <div className="flex items-center gap-2 text-sm font-medium text-amber-600 dark:text-amber-400">
                  <AlertTriangle className="h-4 w-4 shrink-0" />
                  {conflicts.length} file{conflicts.length === 1 ? '' : 's'} already exist and will be
                  replaced — originals will be kept as *.old
                </div>
                <ul className="max-h-40 overflow-y-auto text-xs font-mono space-y-0.5">
                  {conflicts.map((c) => (
                    <li key={c} className="truncate" title={c}>{c}</li>
                  ))}
                </ul>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                No conflicts — nothing in the target will be overwritten.
              </p>
            )}

            {isLxc && (
              <div className="space-y-3 rounded-md border p-3">
                <div className="space-y-2">
                  <Label>Startup script</Label>
                  <Select
                    value={startupScript}
                    onValueChange={(v) => setStartupScript(v)}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="None" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NO_SCRIPT}>None</SelectItem>
                      {variant.scripts.map((s) => (
                        <SelectItem key={s} value={s}>{s}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    Runs after extraction and is registered to run on container boot
                    (systemd). Convention: startup.sh at the zip root.
                  </p>
                </div>
                {selectedScript && (
                  <div className="flex items-center justify-between gap-3">
                    <Label className="text-sm font-normal">Run it now and show the output</Label>
                    <Switch checked={runStartup} onCheckedChange={setRunStartup} />
                  </div>
                )}
                {replacesStartup && (
                  <div className="flex items-start gap-2 text-xs text-amber-600 dark:text-amber-400">
                    <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
                    <span>
                      This container already has a registered startup script
                      ({inspect.existingStartup.scriptPath}). Extracting will replace the
                      registration; the old script is kept as .old.
                    </span>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {phase === 'applying' && (
          <div className="flex items-center gap-2 py-6 text-sm">
            <Loader2 className="h-4 w-4 animate-spin" />
            Extracting{isLxc ? ' into container' : ''}…
            {isLxc && selectedScript ? ' Then running the startup script.' : ''}
          </div>
        )}

        {phase === 'done' && result && (
          <div className="space-y-4 py-2">
            <div className="flex items-center gap-2 text-sm font-medium text-green-600 dark:text-green-400">
              <CheckCircle2 className="h-4 w-4" />
              Extracted {result.filesWritten} file{result.filesWritten === 1 ? '' : 's'}
              {result.replaced?.length ? ` (${result.replaced.length} replaced, originals kept as .old)` : ''}
              {result.caddyReloaded ? ' — Caddy reloaded' : ''}
            </div>
            {result.startup && (
              <div className="space-y-2 rounded-md border p-3">
                <div className="flex items-center gap-2 text-sm font-medium">
                  <FolderInput className="h-4 w-4" />
                  Startup script
                </div>
                {result.startup.noSystemd && (
                  <p className="text-xs text-amber-600 dark:text-amber-400">
                    This container doesn't run systemd — the script was made executable but
                    could not be registered to run on boot.
                  </p>
                )}
                {result.startup.registered && (
                  <p className="text-xs text-muted-foreground">
                    Registered as proxypilot-startup.service — it will run on every container boot.
                  </p>
                )}
                {result.startup.run && (
                  <>
                    <p className={`text-xs font-medium ${result.startup.run.exitCode === 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
                      {result.startup.run.timedOut
                        ? 'Timed out'
                        : `Exit code ${result.startup.run.exitCode}`}
                    </p>
                    <pre className="max-h-48 overflow-auto rounded bg-muted p-2 text-xs whitespace-pre-wrap break-words">
                      {[result.startup.run.stdout, result.startup.run.stderr].filter(Boolean).join('\n') || '(no output)'}
                    </pre>
                  </>
                )}
              </div>
            )}
          </div>
        )}

        <DialogFooter className="shrink-0 gap-2 sm:gap-0">
          {phase === 'pick' && (
            <>
              <Button variant="outline" className="min-h-[44px]" onClick={() => close(false)}>Cancel</Button>
              <Button className="min-h-[44px]" disabled={!file || (isLxc && !targetDir.startsWith('/'))} onClick={startUpload}>
                Upload & Inspect
              </Button>
            </>
          )}
          {phase === 'review' && (
            <>
              <Button variant="outline" className="min-h-[44px]" onClick={() => close(false)}>
                Cancel — write nothing
              </Button>
              <Button
                className="min-h-[44px]"
                variant={conflicts.length > 0 ? 'destructive' : 'default'}
                onClick={doApply}
              >
                {conflicts.length > 0
                  ? `Replace ${conflicts.length} file${conflicts.length === 1 ? '' : 's'} & extract`
                  : 'Extract'}
              </Button>
            </>
          )}
          {phase === 'done' && (
            <Button className="min-h-[44px]" onClick={() => close(false)}>Close</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
