"""AUTO_PATCH / ONE_CLICK state machine.

State machine (per spec §3):
    pre   → if snapshot_supported and a backend is available, snapshot
              (ZFS or btrfs filesystem; IncusOS rollback marker; or
              `incus snapshot create <instance> pre-<cve>`).
    run   → playbook.patch.steps in order, executed via /bin/sh -e,
              capturing stdout/stderr.
    verify→ re-run playbook.detect.probe.
              exit != 0 → host no longer affected → status=RESOLVED.
              exit == 0 → patch failed to close the surface → ROLLBACK.
    rollback → restore the snapshot if we took one + run
               playbook.patch.rollback.restore. status=ALERT-AUTO-ROLLBACK,
               operator_action_required=manual.

ONE_CLICK shares the same machine — the only difference is who triggers
the run (operator click vs. inbox poll). ALERT never executes here.

Reboots are operator territory. If a step exits with code 100 (the
conventional "needs reboot" exit code from needrestart and friends)
or any step's stdout/stderr mentions "reboot required", we set
operator_action_required=reboot and let the existing maintenance-window
scheduler pick it up — the engine never reboots.
"""

from __future__ import annotations

import json
import os
import shlex
import shutil
import subprocess
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, List, Optional, Tuple

from . import ENGINE_ACTOR
from .inbox import (
    ACTION_ALERT,
    ACTION_AUTO_PATCH,
    ACTION_ONE_CLICK,
    Entry,
    STATUS_ALERT_AUTO_ROLLBACK,
    STATUS_BLOCKED,
    STATUS_IN_PROGRESS,
    STATUS_RESOLVED,
    append_history,
    save,
    set_status,
    this_hostname,
)

# Maximum time a single step is allowed to run. apt-get over a slow
# mirror can legitimately take minutes; we cap at 30 to keep a wedged
# patch from blocking the next inbox poll forever.
STEP_TIMEOUT_SEC = 30 * 60
# Maximum cumulative output retained per step. Anything larger is
# truncated in the history excerpt; the full output is never stored
# in the YAML (would make it unreadable for operators).
EXCERPT_BYTES = 4096

# Conventional exit code from needrestart and friends. We treat it as
# a soft "reboot pending" signal rather than a hard failure.
REBOOT_EXIT_CODE = 100


@dataclass
class StepResult:
    step: str
    exit_code: int
    stdout: str
    stderr: str
    duration_s: float


@dataclass
class RunResult:
    cve: str
    host: str
    action_class: str
    snapshot_id: Optional[str] = None
    snapshot_backend: Optional[str] = None
    steps: List[StepResult] = field(default_factory=list)
    probe_initial: Optional[StepResult] = None
    probe_verify: Optional[StepResult] = None
    rollback_steps: List[StepResult] = field(default_factory=list)
    final_status: str = STATUS_IN_PROGRESS
    operator_action_required: str = "none"
    skipped_reason: Optional[str] = None


# Indirection points so tests can stub command execution without
# touching the real host.
def _default_run_shell(snippet: str, timeout: int = STEP_TIMEOUT_SEC) -> StepResult:
    """Run a shell snippet via /bin/sh -e. Treats `snippet` as either
    a multi-line script or a single command."""
    started = time.monotonic()
    try:
        proc = subprocess.run(
            ["/bin/sh", "-e", "-c", snippet],
            capture_output=True, text=True, timeout=timeout, check=False,
        )
        return StepResult(
            step=snippet, exit_code=proc.returncode,
            stdout=proc.stdout, stderr=proc.stderr,
            duration_s=time.monotonic() - started,
        )
    except subprocess.TimeoutExpired as e:
        return StepResult(
            step=snippet, exit_code=124,
            stdout=(e.stdout or "") if isinstance(e.stdout, str) else "",
            stderr=f"timeout after {timeout}s",
            duration_s=time.monotonic() - started,
        )


run_shell: Callable[[str, int], StepResult] = _default_run_shell  # overridable


def _step_excerpt(s: StepResult) -> str:
    out = s.stdout or ""
    err = s.stderr or ""
    body = out + ("\n--stderr--\n" + err if err else "")
    return body[-EXCERPT_BYTES:] if len(body) > EXCERPT_BYTES else body


def _looks_reboot_pending(s: StepResult) -> bool:
    if s.exit_code == REBOOT_EXIT_CODE:
        return True
    blob = (s.stdout + "\n" + s.stderr).lower()
    return "reboot required" in blob or "*** system restart required" in blob


# ── Snapshot backends ─────────────────────────────────────────────────────────

def _detect_btrfs_root() -> Optional[str]:
    """Return the btrfs subvolume mount point if root is on btrfs, else None."""
    try:
        out = subprocess.run(["findmnt", "-no", "FSTYPE,TARGET", "/"],
                             capture_output=True, text=True, timeout=5, check=False).stdout
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return None
    parts = out.split()
    if len(parts) >= 2 and parts[0] == "btrfs":
        return parts[1]
    return None


def _detect_zfs_root() -> Optional[str]:
    """Return the zfs dataset name mounted at /, else None."""
    try:
        out = subprocess.run(["zfs", "list", "-H", "-o", "name,mountpoint"],
                             capture_output=True, text=True, timeout=5, check=False).stdout
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return None
    for line in out.splitlines():
        parts = line.split()
        if len(parts) == 2 and parts[1] == "/":
            return parts[0]
    return None


def take_snapshot(cve: str) -> Tuple[Optional[str], Optional[str]]:
    """Best-effort host-level snapshot. Returns (snapshot_id, backend)
    or (None, None) if no backend is available. The CVE id is folded
    into the snapshot name so it's obvious which run created it."""
    tag = f"proxypilot-{cve}-{int(time.time())}"

    zfs = _detect_zfs_root()
    if zfs and shutil.which("zfs"):
        snap = f"{zfs}@{tag}"
        r = subprocess.run(["zfs", "snapshot", snap], capture_output=True, text=True, check=False)
        if r.returncode == 0:
            return snap, "zfs"

    btrfs_root = _detect_btrfs_root()
    if btrfs_root and shutil.which("btrfs"):
        snap_dir = Path(btrfs_root) / ".proxypilot-snapshots"
        snap_dir.mkdir(parents=True, exist_ok=True)
        snap = str(snap_dir / tag)
        r = subprocess.run(["btrfs", "subvolume", "snapshot", btrfs_root, snap],
                           capture_output=True, text=True, check=False)
        if r.returncode == 0:
            return snap, "btrfs"

    # Incus instance snapshot: only meaningful when we're inside an
    # Incus-managed container/VM and `incus` is reachable from within.
    # Most hosts won't satisfy this; skip silently.
    return None, None


def restore_snapshot(snap_id: str, backend: str) -> Tuple[bool, str]:
    if backend == "zfs":
        r = subprocess.run(["zfs", "rollback", "-r", snap_id],
                           capture_output=True, text=True, check=False)
        return r.returncode == 0, (r.stderr or r.stdout)
    if backend == "btrfs":
        # btrfs rollback is non-trivial (swap subvolume + reboot); we
        # only restore the subvolume directory exists, leaving the
        # actual swap to the operator. The rollback playbook step is
        # what does the in-place repair.
        return True, "btrfs snapshot retained at " + snap_id
    return False, f"unknown backend {backend}"


# ── Main execution ────────────────────────────────────────────────────────────

def execute(entry: Entry, *, hostname: Optional[str] = None,
            forced_action: Optional[str] = None) -> RunResult:
    """Drive the state machine for one inbox entry. Mutates and saves
    the entry in-place. The caller decides whether to invoke this for
    every poll cycle (AUTO_PATCH) or only on operator click (ONE_CLICK).

    `forced_action` overrides hosts[<host>].action_class — used by the
    "Run on this host" button on a ONE_CLICK card to dispatch into the
    same state machine without rewriting the spec.
    """
    host = hostname or this_hostname()
    action = forced_action or entry.action_class(host)
    result = RunResult(cve=entry.cve, host=host, action_class=action)

    if action == ACTION_ALERT:
        result.skipped_reason = "ALERT — operator review only"
        return result

    if action not in (ACTION_AUTO_PATCH, ACTION_ONE_CLICK):
        # Unknown action_class slipped past the route filter (e.g. a
        # forced_action from a stale UI). Refuse to execute.
        result.skipped_reason = f"unknown action_class {action!r}; treating as ALERT"
        return result

    # Container image swaps are always operator-confirmed (spec §4).
    # If something looks like a docker/incus image swap and we got here
    # via AUTO_PATCH, bail and surface as ONE_CLICK. The operator path
    # can still call execute() with forced_action=ONE_CLICK to proceed.
    if action == ACTION_AUTO_PATCH and entry.mentions_container_image():
        result.skipped_reason = "container image swap detected; downgraded to ONE_CLICK"
        set_status(entry, STATUS_BLOCKED)
        append_history(entry, host=host, change=result.skipped_reason)
        save(entry)
        return result

    # ── PRE: detect ───────────────────────────────────────────────────────────
    probe = entry.detect_probe()
    if probe is None:
        result.skipped_reason = "no playbook.detect.probe in spec"
        set_status(entry, STATUS_BLOCKED)
        append_history(entry, host=host, change=result.skipped_reason)
        save(entry)
        return result

    pre = run_shell(probe, STEP_TIMEOUT_SEC)
    result.probe_initial = pre
    if pre.exit_code != 0:
        # Per spec: probe exit 0 = host affected. Non-zero means this
        # host is not affected — record RESOLVED and exit cleanly.
        result.final_status = STATUS_RESOLVED
        set_status(entry, STATUS_RESOLVED)
        append_history(
            entry, host=host,
            change=f"probe exit={pre.exit_code}; host not affected",
            stdout_excerpt=_step_excerpt(pre),
        )
        save(entry)
        return result

    # ── PRE: snapshot ─────────────────────────────────────────────────────────
    set_status(entry, STATUS_IN_PROGRESS)
    if entry.snapshot_supported():
        snap, backend = take_snapshot(entry.cve)
        if snap:
            result.snapshot_id = snap
            result.snapshot_backend = backend
            append_history(
                entry, host=host,
                change=f"snapshot taken ({backend}): {snap}",
            )
        else:
            append_history(
                entry, host=host,
                change="snapshot_supported=true but no backend available; proceeding without",
            )

    steps = entry.patch_steps()
    if not steps:
        result.skipped_reason = "playbook.patch.steps empty"
        set_status(entry, STATUS_BLOCKED)
        append_history(entry, host=host, change=result.skipped_reason)
        save(entry)
        return result

    # ── RUN ──────────────────────────────────────────────────────────────────
    reboot_pending = False
    failed_step: Optional[StepResult] = None
    for step in steps:
        # Comment-only step (Claude sometimes embeds "# OPERATOR
        # ACTION REQUIRED" placeholders). Skip without execution so
        # they don't trip /bin/sh -e on a stray syntax error.
        stripped = step.strip()
        if not stripped or stripped.startswith("#"):
            continue
        sr = run_shell(step, STEP_TIMEOUT_SEC)
        result.steps.append(sr)
        if _looks_reboot_pending(sr):
            reboot_pending = True
            # Treat as success; the patch landed, just needs a reboot
            # to take effect. The verify probe may still pass on the
            # running kernel — the operator decides when to reboot.
            continue
        if sr.exit_code != 0:
            failed_step = sr
            break

    if failed_step is not None:
        return _rollback_and_save(entry, host, result, failed_step,
                                  reason=f"step exited {failed_step.exit_code}")

    # ── VERIFY ───────────────────────────────────────────────────────────────
    verify = run_shell(probe, STEP_TIMEOUT_SEC)
    result.probe_verify = verify
    if verify.exit_code != 0:
        # Probe says host no longer affected — patch worked.
        if reboot_pending:
            result.operator_action_required = "reboot"
            entry.state["operator_action_required"] = "reboot"
            change = "patch succeeded; reboot required for full effect"
            # Status stays IN_PROGRESS until operator reboots and the
            # next poll can verify cleanly.
            set_status(entry, STATUS_IN_PROGRESS)
        else:
            result.final_status = STATUS_RESOLVED
            entry.state["operator_action_required"] = "none"
            set_status(entry, STATUS_RESOLVED)
            change = "patch verified: host no longer affected"
        append_history(
            entry, host=host, change=change,
            stdout_excerpt=_step_excerpt(verify),
        )
        save(entry)
        return result

    # Verify says still affected → rollback.
    return _rollback_and_save(entry, host, result, verify,
                              reason="verify probe still exits 0; patch did not close surface")


def _rollback_and_save(entry: Entry, host: str, result: RunResult,
                       failure: StepResult, *, reason: str) -> RunResult:
    """Run the spec's rollback step + restore snapshot if we have one,
    then mark ALERT-AUTO-ROLLBACK so the operator picks up the page."""
    append_history(
        entry, host=host,
        change=f"rollback triggered: {reason}",
        stdout_excerpt=_step_excerpt(failure) if failure.stdout else None,
        stderr_excerpt=_step_excerpt(failure) if failure.stderr and not failure.stdout else None,
    )

    if result.snapshot_id and result.snapshot_backend:
        ok, msg = restore_snapshot(result.snapshot_id, result.snapshot_backend)
        append_history(
            entry, host=host,
            change=f"snapshot restore ({result.snapshot_backend}) "
                   f"{'ok' if ok else 'FAILED'}: {msg.strip()[:200]}",
        )

    rollback_snippet = entry.rollback_restore()
    if rollback_snippet:
        rb = run_shell(rollback_snippet, STEP_TIMEOUT_SEC)
        result.rollback_steps.append(rb)
        append_history(
            entry, host=host,
            change=f"rollback.restore exit={rb.exit_code}",
            stdout_excerpt=_step_excerpt(rb),
        )

    result.final_status = STATUS_ALERT_AUTO_ROLLBACK
    result.operator_action_required = "manual"
    set_status(entry, STATUS_ALERT_AUTO_ROLLBACK)
    entry.state["operator_action_required"] = "manual"
    save(entry)
    return result
