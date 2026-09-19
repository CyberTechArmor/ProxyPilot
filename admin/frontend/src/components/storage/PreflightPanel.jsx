// Storage → Devices: preflight & install.
//
//   GET  /api/storage/preflight?devices=1   readiness checks + per-disk safety
//   POST /api/storage/install { force? }    sudo-gated, 202 { started, id } or
//                                          409 { refused, error, already_installed }
//   GET  /api/storage/install/status?id=    the self-update runner's state, polled
//                                          every 2s until { terminal: true }
//
// Field names come from admin/backend/src/lib/storage/preflight.js
// (installPreflight + deviceRisks) and lib/self-update-logic.js parseState.
// Nothing here touches a block device: the installer only adds packages,
// systemd units and the two helper scripts.

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, Download,
  HelpCircle, Loader2, RefreshCw, ShieldCheck, XCircle,
} from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { useToast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';
import { BTN, Checkbox, Chip, DIALOG_BODY, DIALOG_LG, Notice, SectionHeader, fmtBytes, fmtDate } from './shared';

const POLL_MS = 2000;
// The runner has TimeoutStartSec=3600, but an apt install of zfs (with a DKMS
// build) is minutes, not an hour. Stop watching at 5 minutes and tell the
// operator to look again rather than spinning forever.
const POLL_CEILING_MS = 5 * 60 * 1000;
const LOG_LINES = 18;

/* The units and helpers scripts/install-storage.sh puts in place. The flags
   come from host.toolchain(); the names are fixed by deploy/ and host.js. */
const UNITS = [
  { key: 'scrub_timer_installed', name: 'proxypilot-zfs-scrub@.timer', what: 'monthly pool scrub' },
  { key: 'syncoid_unit_installed', name: 'proxypilot-syncoid@.service', what: 'scheduled replication' },
];
const HELPERS = [
  { key: 'replicate_helper', name: '/usr/local/sbin/proxypilot-storage-replicate', what: 'replication jobs' },
  { key: 'restore_helper', name: '/usr/local/sbin/proxypilot-storage-restore-guest', what: 'restore a guest from a snapshot' },
];

const CHECK_LEVEL = { pass: 'ok', warn: 'warn', fail: 'fail', unknown: 'muted' };
const CHECK_ICON = { pass: CheckCircle2, warn: AlertTriangle, fail: XCircle, unknown: HelpCircle };
const CHECK_ICON_CLASS = {
  pass: 'text-emerald-500', warn: 'text-amber-500', fail: 'text-red-500', unknown: 'text-muted-foreground',
};
const CHECK_ORDER = { fail: 0, warn: 1, unknown: 2, pass: 3 };

function errMessage(err) {
  return err instanceof ApiError ? err.message : (err?.message || 'unknown error');
}

/** One line of plain English about the host, from the server's own flags. */
function readiness(pf) {
  if (!pf) return null;
  if (pf.ready) {
    return { level: 'ok', text: 'This host is ready. The ZFS tools, the ProxyPilot units and the helper scripts are all in place.' };
  }
  if (!pf.can_install) {
    return { level: 'fail', text: 'The dashboard cannot install the storage toolchain on this host yet. Clear the blocking checks below first.' };
  }
  if (pf.install_needed) {
    const missing = (pf.missing_packages || []).join(', ');
    return {
      level: 'warn',
      text: pf.reinstall_only
        ? 'The packages are installed, but ProxyPilot\'s units or helper scripts are missing. Run the installer to add them.'
        : `An install is needed${missing ? `: ${missing}` : ''}. The dashboard can run it for you.`,
    };
  }
  return { level: 'warn', text: 'Everything the installer adds is present, but the host is not fully ready. See the checks below.' };
}

/* --------------------------------- checks -------------------------------- */

function CheckRow({ c }) {
  const status = CHECK_LEVEL[c.status] ? c.status : 'unknown';
  const Icon = CHECK_ICON[status];
  return (
    <div className="flex items-start gap-2 py-2 border-t first:border-t-0">
      <Icon className={cn('h-4 w-4 mt-0.5 shrink-0', CHECK_ICON_CLASS[status])} />
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-sm font-medium break-words">{c.label || c.id}</span>
          <Chip level={CHECK_LEVEL[status]}>{status}</Chip>
          {c.blocking && status === 'fail' && <Chip level="fail" title="the install request is refused while this fails">blocks install</Chip>}
        </div>
        {c.detail && <p className="text-xs text-muted-foreground break-words">{c.detail}</p>}
        {status !== 'pass' && c.remedy && <p className="text-xs break-words">{c.remedy}</p>}
      </div>
    </div>
  );
}

function CheckList({ checks }) {
  const [showPasses, setShowPasses] = useState(false);
  const rows = [...(checks || [])].sort((a, b) => (CHECK_ORDER[a.status] ?? 2) - (CHECK_ORDER[b.status] ?? 2));
  const passes = rows.filter((c) => c.status === 'pass');
  const attention = rows.filter((c) => c.status !== 'pass');
  const visible = showPasses ? rows : attention;
  return (
    <div className="space-y-2">
      {visible.length === 0 ? (
        <p className="text-sm text-emerald-500 flex items-center gap-2"><CheckCircle2 className="h-4 w-4 shrink-0" />Every check passes.</p>
      ) : (
        <div>{visible.map((c) => <CheckRow key={c.id} c={c} />)}</div>
      )}
      {passes.length > 0 && (
        <Button type="button" variant="ghost" className="h-11 sm:h-9 px-2 -ml-2" onClick={() => setShowPasses((v) => !v)}>
          {showPasses ? <ChevronDown className="h-4 w-4 mr-1.5" /> : <ChevronRight className="h-4 w-4 mr-1.5" />}
          {showPasses ? 'Hide passing checks' : `Show passing checks (${passes.length})`}
        </Button>
      )}
    </div>
  );
}

/* ----------------------------- device safety ----------------------------- */

function deviceVerdict(d) {
  const e = d.eligibility || {};
  if (e.eligible) return { level: 'ok', label: 'Takeable now', note: 'A new pool can use this disk as it is.' };
  if (d.eligibility_with_wipe) return { level: 'warn', label: 'Needs wipe', note: `Only with wipe: true, which clears ${(e.soft || []).join('; ') || 'the signatures found on it'}.` };
  return { level: 'fail', label: 'Cannot be taken', note: 'No plan can use this disk until the reasons below are resolved on the host.' };
}

function Evidence({ label, items }) {
  if (!items || items.length === 0) return null;
  return (
    <p className="text-xs break-words">
      <span className="text-muted-foreground">{label}: </span>
      <span className="font-mono break-all">{items.join(' · ')}</span>
    </p>
  );
}

function DeviceRow({ d }) {
  const risk = d.risk || {};
  const hard = risk.hard || [];
  const warnings = risk.warnings || [];
  const md = risk.md;
  const v = deviceVerdict(d);
  const eligHard = (d.eligibility?.hard || []).filter((r) => !hard.includes(r));
  return (
    <div className="py-3 border-t first:border-t-0 space-y-1.5">
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium break-words">{d.model || d.name || d.path}</p>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span className="font-mono break-all">{d.path || d.name}</span>
            <span>{fmtBytes(d.size_bytes)}</span>
            {d.serial && <span className="font-mono break-all">{d.serial}</span>}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {d.os && <Chip level="fail" title={d.os_reason || 'backs the operating system'}>OS</Chip>}
          <Chip level={v.level}>{v.label}</Chip>
        </div>
      </div>
      <p className="text-xs text-muted-foreground break-words">{v.note}</p>
      {hard.length > 0 && (
        <Notice level="error" className="text-xs">
          <p className="font-medium">Blocks a pool</p>
          {hard.map((r, i) => <p key={i} className="break-words">{r}</p>)}
        </Notice>
      )}
      {eligHard.length > 0 && (
        <ul className="text-xs text-muted-foreground list-disc pl-5 space-y-0.5">
          {eligHard.map((r, i) => <li key={i} className="break-words">{r}</li>)}
        </ul>
      )}
      {warnings.map((w, i) => <p key={i} className="text-xs text-amber-500 break-words">{w}</p>)}
      <Evidence label="fstab" items={(risk.fstab || []).map((f) => `${f.spec} → ${f.target}`)} />
      <Evidence label="EFI boot" items={(risk.efi || []).map((e) => `Boot${e.id} ${e.name || ''}`.trim())} />
      <Evidence label="md array" items={md ? [`${md.name} (${md.level || '?'}, ${md.state || '?'})`] : []} />
      <Evidence label="RAID superblock" items={risk.raid_superblock || []} />
      <Evidence label="Active swap" items={risk.active_swap || []} />
    </div>
  );
}

function DeviceSafety({ pf }) {
  const devices = pf?.devices;
  if (!Array.isArray(devices)) {
    return (
      <div className="border-t pt-3 space-y-2">
        <p className="text-sm font-medium">Disk safety</p>
        <p className="text-xs text-muted-foreground">Per-disk safety was not returned by the preflight. Re-check to collect it.</p>
      </div>
    );
  }
  const takeable = devices.filter((d) => d.eligibility?.eligible).length;
  const needsWipe = devices.filter((d) => !d.eligibility?.eligible && d.eligibility_with_wipe).length;
  const never = devices.length - takeable - needsWipe;
  return (
    <div className="border-t pt-3 space-y-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <p className="text-sm font-medium flex items-center gap-1.5"><ShieldCheck className="h-4 w-4 text-muted-foreground" />Disk safety</p>
        <Chip level="ok">{takeable} takeable now</Chip>
        <Chip level="warn">{needsWipe} need wipe: true</Chip>
        <Chip level="fail">{never} cannot be taken</Chip>
      </div>
      <p className="text-xs text-muted-foreground">
        The checks lsblk cannot answer: an fstab line, an EFI boot entry, an mdadm superblock on a stopped array, active swap.
        Anything listed as blocking is refused by the planner, with or without wipe.
      </p>
      {pf.safety_checked == null && (
        <Notice level="warn" className="text-xs"><p>The host safety facts (fstab, mdstat, EFI entries, swap) were not collected, so the evidence below may be incomplete.</p></Notice>
      )}
      {devices.length === 0
        ? <p className="text-sm text-muted-foreground">No whole disks were reported by the host.</p>
        : <div>{devices.map((d) => <DeviceRow key={d.path || d.name} d={d} />)}</div>}
    </div>
  );
}

/* ------------------------------ confirm dialog --------------------------- */

function ConfirmDialog({ open, onClose, pf, force, onConfirm, busy }) {
  const [ack, setAck] = useState(false);
  useEffect(() => { if (open) setAck(false); }, [open]);
  const tc = pf?.toolchain || {};
  const missing = pf?.missing_packages || [];
  const scriptPath = `${pf?.runner?.source_dir || '<recorded checkout>'}/${pf?.script || 'scripts/install-storage.sh'}`;
  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v && !busy) onClose(); }}>
      <DialogContent className={DIALOG_LG}>
        <DialogHeader>
          <DialogTitle>{force ? 'Re-install storage toolchain' : 'Install storage toolchain'}</DialogTitle>
          <DialogDescription>
            The root update runner executes <span className="font-mono break-all">{scriptPath}</span> on the host.
          </DialogDescription>
        </DialogHeader>

        <div className={DIALOG_BODY}>
          <Notice level="info">
            <p className="font-medium">No disk is touched.</p>
            <p>
              The installer adds packages, systemd units and two helper scripts. It does not create, import, wipe or
              partition anything. Creating a pool stays a separate plan and confirm step on this page.
            </p>
          </Notice>

          <div>
            <p className="text-sm font-medium">Packages</p>
            {missing.length > 0 ? (
              <ul className="text-xs list-disc pl-5 space-y-0.5 mt-1">
                {missing.map((p) => <li key={p} className="font-mono break-all">{p}</li>)}
              </ul>
            ) : (
              <p className="text-xs text-muted-foreground mt-1">Nothing is missing. apt re-runs over the installed packages and leaves them as they are.</p>
            )}
          </div>

          <div>
            <p className="text-sm font-medium">Systemd units</p>
            <ul className="mt-1 space-y-1">
              {UNITS.map((u) => (
                <li key={u.key} className="flex flex-wrap items-center gap-2 text-xs">
                  <Chip level={tc[u.key] ? 'ok' : 'warn'}>{tc[u.key] ? 'installed' : 'missing'}</Chip>
                  <span className="font-mono break-all">{u.name}</span>
                  <span className="text-muted-foreground">{u.what}</span>
                </li>
              ))}
            </ul>
          </div>

          <div>
            <p className="text-sm font-medium">Helper scripts</p>
            <ul className="mt-1 space-y-1">
              {HELPERS.map((h) => (
                <li key={h.key} className="flex flex-wrap items-center gap-2 text-xs">
                  <Chip level={tc[h.key] ? 'ok' : 'warn'}>{tc[h.key] ? 'installed' : 'missing'}</Chip>
                  <span className="font-mono break-all">{h.name}</span>
                  <span className="text-muted-foreground">{h.what}</span>
                </li>
              ))}
            </ul>
          </div>

          {force && (
            <Notice level="warn"><p>Nothing is reported as missing, so this run is a re-install. It is sent with <span className="font-mono">force: true</span>.</p></Notice>
          )}
          <p className="text-xs text-muted-foreground">
            A distribution kernel that needs a DKMS build takes a few minutes, and the ZFS module may only appear after a reboot.
          </p>

          <Checkbox
            checked={ack}
            onChange={setAck}
            disabled={busy}
            label="Run the installer on the host now."
            hint="You will be asked to re-authenticate, as with every privileged action."
          />
        </div>

        <DialogFooter className="gap-2 pt-2 border-t">
          <Button type="button" variant="ghost" className={BTN} onClick={onClose} disabled={busy}>Cancel</Button>
          <Button type="button" className={BTN} onClick={onConfirm} disabled={!ack || busy}>
            {busy ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <Download className="h-4 w-4 mr-1.5" />}
            {busy ? 'Requesting…' : force ? 'Re-install' : 'Install'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* --------------------------------- the hook ------------------------------ */

/**
 * One preflight fetch shared by the panel and the page-header banner, so
 * landing on Storage does not run the readiness probe twice.
 */
export function usePreflight({ enabled = true } = {}) {
  const [pf, setPf] = useState(null);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState(null);

  const reload = useCallback(async ({ quiet = false } = {}) => {
    if (!quiet) setLoading(true);
    try {
      const next = await api.storage.preflight({ devices: true });
      setPf(next);
      setError(null);
    } catch (err) {
      setError(errMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { if (enabled) reload(); }, [enabled, reload]);
  return { pf, loading, error, reload };
}

/** Compact header banner: shown only when an install is both needed and possible. */
export function PreflightBanner({ state, onGoDevices }) {
  const pf = state?.pf;
  if (!pf || !pf.can_install || !pf.install_needed) return null;
  const missing = (pf.missing_packages || []).join(', ');
  return (
    <Notice level="warn">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
        <div className="min-w-0">
          <p className="font-medium">The storage toolchain is not installed</p>
          <p className="break-words">
            {pf.reinstall_only
              ? 'ProxyPilot\'s units or helper scripts are missing.'
              : `Missing: ${missing || 'part of the toolchain'}.`}{' '}
            The dashboard can install it for you. No disk is touched.
          </p>
        </div>
        {onGoDevices && (
          <Button className={cn(BTN, 'shrink-0')} onClick={onGoDevices}>
            <Download className="h-4 w-4 mr-1.5" />Preflight &amp; install
          </Button>
        )}
      </div>
    </Notice>
  );
}

/* --------------------------------- the panel ----------------------------- */

export default function PreflightPanel({ state, onInstalled }) {
  const { toast } = useToast();
  const { pf, loading, error, reload } = state;
  const [confirm, setConfirm] = useState(false);
  const [requesting, setRequesting] = useState(false);
  const [startError, setStartError] = useState(null);
  const [run, setRun] = useState(null);       // latest install/status payload
  const [watching, setWatching] = useState(false);
  const [stalled, setStalled] = useState(false);
  const [pollError, setPollError] = useState(null);
  const pollToken = useRef(0);

  // Stop polling when the panel goes away (tab switch, navigation).
  useEffect(() => () => { pollToken.current += 1; }, []);

  const finish = useCallback((st) => {
    setWatching(false);
    if (st.status === 'success') {
      toast({ title: 'Storage toolchain installed', description: 'Refreshing the host inventory.' });
      reload({ quiet: true });
      onInstalled?.();
    } else {
      toast({ title: `Install ${st.status || 'failed'}`, description: st.reason || `exit code ${st.exit_code ?? 'unknown'}`, variant: 'destructive' });
      reload({ quiet: true });
    }
  }, [onInstalled, reload, toast]);

  const watch = useCallback((id) => {
    pollToken.current += 1;
    const token = pollToken.current;
    const deadline = Date.now() + POLL_CEILING_MS;
    setWatching(true);
    setStalled(false);
    setPollError(null);
    const tick = async () => {
      if (pollToken.current !== token) return;
      let st = null;
      try {
        st = await api.storage.installStatus({ id, log_tail_bytes: 16384 });
        setPollError(null);
      } catch (err) {
        // The backend restarts, the host is busy, the agent is reloading: a
        // failed poll means "still running", never "failed".
        setPollError(errMessage(err));
      }
      if (pollToken.current !== token) return;
      if (st) {
        setRun(st);
        const mine = !id || st.id === id || (st.id == null && st.is_storage_install === true);
        if (mine && st.terminal) { finish(st); return; }
      }
      if (Date.now() > deadline) { setStalled(true); setWatching(false); return; }
      setTimeout(tick, POLL_MS);
    };
    setTimeout(tick, 1200);
  }, [finish]);

  // Re-attach to an install already in flight: the panel unmounts when the
  // operator leaves the Devices tab, and a page reload loses the run entirely.
  const attached = useRef(false);
  useEffect(() => {
    if (attached.current) return;
    attached.current = true;
    let live = true;
    (async () => {
      try {
        const st = await api.storage.installStatus({ log_tail_bytes: 16384 });
        if (!live || !st?.is_storage_install || st.terminal) return;
        setRun(st);
        watch(st.id || null);
      } catch { /* nothing in flight that we can see */ }
    })();
    return () => { live = false; };
  }, [watch]);

  const force = !!pf && pf.install_needed === false;

  const start = useCallback(async () => {
    setRequesting(true);
    setStartError(null);
    try {
      const r = await api.storage.install(force ? { force: true } : {});
      setConfirm(false);
      setRun({ id: r.id || null, status: 'queued', phase: 'waiting for the root runner', terminal: false, log_tail: '' });
      watch(r.id || null);
    } catch (err) {
      // 409 carries { refused, error, already_installed, preflight } on the
      // ApiError itself (lib/api.js copies the body onto it).
      setStartError(errMessage(err));
      if (err?.already_installed) reload({ quiet: true });
    } finally {
      setRequesting(false);
    }
  }, [force, reload, watch]);

  const r = readiness(pf);
  const blockedBy = pf?.blocked_by || [];
  const disabledReason = !pf ? 'The preflight has not been read yet.'
    : !pf.can_install ? 'Blocked by the checks below.'
      : watching ? 'An install is already running.' : null;
  const logLines = String(run?.log_tail || '').split('\n').filter((l) => l.length > 0).slice(-LOG_LINES);

  return (
    <Card>
      <CardContent className="p-4 space-y-3">
        <SectionHeader
          title="Preflight & install"
          description="Every readiness check the host would otherwise be inspected for over SSH, and the one button that installs the toolchain."
        >
          <Button variant="outline" className={BTN} onClick={() => reload()} disabled={loading}>
            <RefreshCw className={cn('h-4 w-4 mr-1.5', loading && 'animate-spin')} />Re-check
          </Button>
          <Button
            variant={force ? 'outline' : 'default'}
            className={BTN}
            onClick={() => setConfirm(true)}
            disabled={!pf || !pf.can_install || watching}
            title={disabledReason || undefined}
          >
            <Download className="h-4 w-4 mr-1.5" />
            {force ? 'Re-install' : 'Install storage toolchain'}
          </Button>
        </SectionHeader>

        {error && (
          <Notice level="error">
            <p className="font-medium">The preflight could not be read</p>
            <p className="break-words">{error}</p>
            <p>Nothing below is current. Re-check once the API answers again.</p>
          </Notice>
        )}

        {loading && !pf && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground py-6"><Loader2 className="h-4 w-4 animate-spin" />Running the readiness checks…</div>
        )}

        {pf && (
          <>
            {r && (
              <Notice level={r.level === 'ok' ? 'info' : r.level === 'fail' ? 'error' : 'warn'}>
                <p className="font-medium break-words">{r.text}</p>
                <p className="text-xs">
                  {pf.summary ? `${pf.summary.pass ?? 0} pass, ${pf.summary.warn ?? 0} warn, ${pf.summary.fail ?? 0} fail` : 'no summary'}
                  {pf.at ? ` · checked ${fmtDate(pf.at)}` : ''}
                  {pf.os?.pretty_name ? ` · ${pf.os.pretty_name}` : ''}
                </p>
              </Notice>
            )}

            {!pf.can_install && blockedBy.length > 0 && (
              <Notice level="error">
                <p className="font-medium">Install is blocked</p>
                {blockedBy.map((b) => (
                  <p key={b.id} className="break-words">{b.detail}{b.remedy ? ` ${b.remedy}` : ''}</p>
                ))}
              </Notice>
            )}

            <CheckList checks={pf.checks} />

            {startError && (
              <Notice level="error">
                <p className="font-medium">The install was not started</p>
                <p className="break-words">{startError}</p>
              </Notice>
            )}

            {run && (
              <div className="border-t pt-3 space-y-2">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  {watching
                    ? <Loader2 className="h-4 w-4 animate-spin text-primary shrink-0" />
                    : run.status === 'success'
                      ? <CheckCircle2 className="h-4 w-4 text-emerald-500 shrink-0" />
                      : <XCircle className="h-4 w-4 text-red-500 shrink-0" />}
                  <span className="text-sm font-medium break-words">
                    {run.phase || run.status || 'running'}
                  </span>
                  <Chip level={run.status === 'success' ? 'ok' : run.terminal ? 'fail' : 'info'}>{run.status || 'running'}</Chip>
                  {run.phase_total ? <span className="text-xs text-muted-foreground font-mono">{run.phase_index ?? 0}/{run.phase_total}</span> : null}
                  {run.id && <span className="text-xs text-muted-foreground font-mono break-all">{run.id}</span>}
                </div>

                {pollError && watching && (
                  <p className="text-xs text-muted-foreground break-words">The status could not be read just now ({pollError}). Treating the run as still in progress.</p>
                )}

                {stalled && (
                  <Notice level="warn">
                    <p className="font-medium">Still running after 5 minutes</p>
                    <p>The dashboard stopped watching. The installer keeps going on the host. Re-check in a minute to see the result.</p>
                  </Notice>
                )}

                {run.terminal && run.status !== 'success' && (
                  <Notice level="error">
                    <p className="font-medium">Install {run.status}</p>
                    {run.reason && <p className="break-words">{run.reason}</p>}
                    <p className="font-mono text-xs">exit code {run.exit_code ?? 'unknown'}</p>
                    <p>Read the log below, fix the cause on the host, then run the installer again.</p>
                  </Notice>
                )}

                {logLines.length > 0 && (
                  <pre className="text-xs font-mono bg-muted rounded p-2 max-h-56 max-w-full overflow-y-auto whitespace-pre-wrap break-all">{logLines.join('\n')}</pre>
                )}
              </div>
            )}

            <DeviceSafety pf={pf} />
          </>
        )}

        <ConfirmDialog
          open={confirm}
          onClose={() => setConfirm(false)}
          pf={pf}
          force={force}
          busy={requesting}
          onConfirm={start}
        />
      </CardContent>
    </Card>
  );
}
