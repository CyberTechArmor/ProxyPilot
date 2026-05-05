"""State-machine tests for runner.execute.

run_shell is monkey-patched to a deterministic stub so we exercise
each branch without touching the host. Snapshot helpers are stubbed
to (None, None) by default — snapshot tests pass an explicit override.
"""

from __future__ import annotations

import textwrap
from pathlib import Path
from typing import Callable, List

import pytest

from proxypilot.engine import inbox as inbox_mod
from proxypilot.engine import runner as runner_mod
from proxypilot.engine.inbox import (
    STATUS_ALERT_AUTO_ROLLBACK,
    STATUS_IN_PROGRESS,
    STATUS_RESOLVED,
    load_entry,
)
from proxypilot.engine.runner import StepResult, execute


def _write(tmp_path: Path, name: str, body: str) -> Path:
    p = tmp_path / name
    p.write_text(textwrap.dedent(body).lstrip(), encoding="utf-8")
    return p


def _scripted(script: List[StepResult]) -> Callable[[str, int], StepResult]:
    """Return a run_shell stub that returns each StepResult in order.

    The stub's `step` field is overwritten to the actual snippet so
    the assertion target is the script's exit codes, not the snippets."""
    it = iter(script)

    def fn(snippet: str, _timeout: int = 0) -> StepResult:
        sr = next(it)
        return StepResult(step=snippet, exit_code=sr.exit_code,
                          stdout=sr.stdout, stderr=sr.stderr,
                          duration_s=0.0)
    return fn


def _ok(stdout: str = "") -> StepResult:
    return StepResult(step="", exit_code=0, stdout=stdout, stderr="", duration_s=0.0)


def _fail(code: int = 1, stderr: str = "boom") -> StepResult:
    return StepResult(step="", exit_code=code, stdout="", stderr=stderr, duration_s=0.0)


def _disable_snapshots(monkeypatch):
    monkeypatch.setattr(runner_mod, "take_snapshot", lambda cve: (None, None))


def _spec(action="AUTO_PATCH", *, snapshot_supported=False, steps=None,
          rollback_restore=None):
    """Build a flat (column-0) YAML spec; no dedent gymnastics."""
    rb = ""
    if rollback_restore:
        rb = (f"    rollback:\n"
              f"      snapshot_supported: {str(snapshot_supported).lower()}\n"
              f"      restore: \"{rollback_restore}\"\n")
    elif snapshot_supported:
        rb = "    rollback: {snapshot_supported: true}\n"
    steps = steps or ["echo apply"]
    step_lines = "\n".join(f"      - \"{s}\"" for s in steps)
    return (
        "cve: CVE-2099-9999\n"
        "name: test\n"
        "hosts:\n"
        "  h1:\n"
        f"    action_class: {action}\n"
        "    tier: 1\n"
        "playbook:\n"
        "  detect:\n"
        "    probe: \"exit 0\"\n"
        "  patch:\n"
        "    steps:\n"
        f"{step_lines}\n"
        f"{rb}"
        "state: {status: NEW}\n"
    )


# ── happy paths ───────────────────────────────────────────────────────────────

def test_alert_action_class_short_circuits(tmp_path, monkeypatch):
    _disable_snapshots(monkeypatch)
    p = _write(tmp_path, "CVE-2099-9999.yaml", _spec(action="ALERT"))
    e = load_entry(p)
    monkeypatch.setattr(runner_mod, "run_shell", _scripted([]))
    r = execute(e, hostname="h1")
    assert r.skipped_reason and "ALERT" in r.skipped_reason
    # ALERT must not write state — operator-only.
    assert e.status == "NEW"


def test_resolved_when_probe_initially_negative(tmp_path, monkeypatch):
    _disable_snapshots(monkeypatch)
    p = _write(tmp_path, "CVE-2099-9999.yaml", _spec())
    e = load_entry(p)
    # Probe exit != 0 means host is not affected per spec §3 step pre.
    monkeypatch.setattr(runner_mod, "run_shell",
                        _scripted([_fail(code=1, stderr="not vulnerable")]))
    r = execute(e, hostname="h1")
    assert r.final_status == STATUS_RESOLVED
    e2 = load_entry(p)
    assert e2.status == STATUS_RESOLVED


def test_full_patch_verify_flow(tmp_path, monkeypatch):
    _disable_snapshots(monkeypatch)
    p = _write(tmp_path, "CVE-2099-9999.yaml", _spec(steps=["apt-get install foo"]))
    e = load_entry(p)
    # probe(yes) → step(ok) → verify(no) = RESOLVED.
    monkeypatch.setattr(runner_mod, "run_shell",
                        _scripted([_ok("affected"), _ok("done"), _fail(1, "fixed")]))
    r = execute(e, hostname="h1")
    assert r.final_status == STATUS_RESOLVED
    assert load_entry(p).status == STATUS_RESOLVED


def test_step_comments_are_skipped(tmp_path, monkeypatch):
    _disable_snapshots(monkeypatch)
    p = _write(tmp_path, "CVE-2099-9999.yaml",
               _spec(steps=["# operator note", "echo applied"]))
    e = load_entry(p)
    # Only one real step → only one shell call between probe and verify.
    monkeypatch.setattr(runner_mod, "run_shell",
                        _scripted([_ok("vuln"), _ok("applied"), _fail(1)]))
    r = execute(e, hostname="h1")
    assert r.final_status == STATUS_RESOLVED
    assert len(r.steps) == 1


# ── rollback paths ────────────────────────────────────────────────────────────

def test_step_failure_triggers_rollback(tmp_path, monkeypatch):
    _disable_snapshots(monkeypatch)
    p = _write(tmp_path, "CVE-2099-9999.yaml",
               _spec(steps=["apt-get install foo"], rollback_restore="apt-get install foo=1.0"))
    e = load_entry(p)
    # probe(yes) → step(fail) → rollback(ok). No verify probe runs.
    monkeypatch.setattr(runner_mod, "run_shell",
                        _scripted([_ok("vuln"), _fail(2, "dpkg locked"),
                                   _ok("rolled back")]))
    r = execute(e, hostname="h1")
    assert r.final_status == STATUS_ALERT_AUTO_ROLLBACK
    assert r.operator_action_required == "manual"
    e2 = load_entry(p)
    assert e2.status == STATUS_ALERT_AUTO_ROLLBACK
    assert e2.state["operator_action_required"] == "manual"


def test_verify_still_affected_triggers_rollback(tmp_path, monkeypatch):
    _disable_snapshots(monkeypatch)
    p = _write(tmp_path, "CVE-2099-9999.yaml",
               _spec(steps=["echo no-op"], rollback_restore="echo back"))
    e = load_entry(p)
    # probe(yes) → step(ok) → verify(yes) = patch did not close surface.
    monkeypatch.setattr(runner_mod, "run_shell",
                        _scripted([_ok("vuln"), _ok("did nothing"),
                                   _ok("still vuln"), _ok("rolled back")]))
    r = execute(e, hostname="h1")
    assert r.final_status == STATUS_ALERT_AUTO_ROLLBACK


# ── reboot soft-signal ────────────────────────────────────────────────────────

def test_reboot_pending_sets_operator_action(tmp_path, monkeypatch):
    _disable_snapshots(monkeypatch)
    p = _write(tmp_path, "CVE-2099-9999.yaml", _spec(steps=["needrestart -r a"]))
    e = load_entry(p)
    # probe(yes) → step(stdout: reboot required) → verify(no).
    reboot_step = StepResult(step="", exit_code=0,
                             stdout="*** System restart required ***",
                             stderr="", duration_s=0.0)
    monkeypatch.setattr(runner_mod, "run_shell",
                        _scripted([_ok("vuln"), reboot_step, _fail(1)]))
    r = execute(e, hostname="h1")
    assert r.operator_action_required == "reboot"
    e2 = load_entry(p)
    # Status stays IN_PROGRESS until the reboot lands and the next
    # poll can verify cleanly.
    assert e2.status == STATUS_IN_PROGRESS
    assert e2.state["operator_action_required"] == "reboot"


# ── safety: container image swaps must be ONE_CLICK ──────────────────────────

def test_auto_patch_refuses_container_image_swap(tmp_path, monkeypatch):
    _disable_snapshots(monkeypatch)
    body = _spec(steps=["docker compose pull web", "docker compose up -d"])
    p = _write(tmp_path, "CVE-2099-9999.yaml", body)
    e = load_entry(p)
    # No shell calls expected — execute must short-circuit before
    # running the probe.
    monkeypatch.setattr(runner_mod, "run_shell",
                        lambda *a, **kw: pytest.fail("execute should not run shell"))
    r = execute(e, hostname="h1")
    assert r.skipped_reason and "container image" in r.skipped_reason


def test_one_click_force_runs_image_swap(tmp_path, monkeypatch):
    _disable_snapshots(monkeypatch)
    body = _spec(action="ONE_CLICK", steps=["docker compose pull web"])
    p = _write(tmp_path, "CVE-2099-9999.yaml", body)
    e = load_entry(p)
    monkeypatch.setattr(runner_mod, "run_shell",
                        _scripted([_ok("vuln"), _ok("pulled"), _fail(1)]))
    r = execute(e, hostname="h1", forced_action="ONE_CLICK")
    assert r.final_status == STATUS_RESOLVED


# ── snapshot integration ──────────────────────────────────────────────────────

def test_snapshot_taken_when_supported(tmp_path, monkeypatch):
    p = _write(tmp_path, "CVE-2099-9999.yaml",
               _spec(steps=["echo apply"], snapshot_supported=True,
                     rollback_restore="echo back"))
    e = load_entry(p)
    monkeypatch.setattr(runner_mod, "take_snapshot",
                        lambda cve: (f"tank/root@{cve}", "zfs"))
    monkeypatch.setattr(runner_mod, "run_shell",
                        _scripted([_ok("vuln"), _ok("done"), _fail(1, "fixed")]))
    r = execute(e, hostname="h1")
    assert r.snapshot_id and r.snapshot_backend == "zfs"
    assert r.final_status == STATUS_RESOLVED


# ── safety: missing playbook bits ─────────────────────────────────────────────

def test_missing_probe_blocks(tmp_path, monkeypatch):
    p = _write(tmp_path, "CVE-2099-9999.yaml", """
        cve: CVE-2099-9999
        hosts: {h1: {action_class: AUTO_PATCH, tier: 1}}
        playbook:
          patch: {steps: ["echo apply"]}
        state: {status: NEW}
    """)
    e = load_entry(p)
    monkeypatch.setattr(runner_mod, "run_shell",
                        lambda *a, **kw: pytest.fail("must not run shell"))
    r = execute(e, hostname="h1")
    assert r.skipped_reason == "no playbook.detect.probe in spec"
    assert load_entry(p).status == "BLOCKED"


def test_missing_patch_steps_blocks(tmp_path, monkeypatch):
    _disable_snapshots(monkeypatch)
    p = _write(tmp_path, "CVE-2099-9999.yaml", """
        cve: CVE-2099-9999
        hosts: {h1: {action_class: AUTO_PATCH, tier: 1}}
        playbook:
          detect: {probe: "exit 0"}
          patch: {}
        state: {status: NEW}
    """)
    e = load_entry(p)
    monkeypatch.setattr(runner_mod, "run_shell", _scripted([_ok("vuln")]))
    r = execute(e, hostname="h1")
    assert r.skipped_reason == "playbook.patch.steps empty"
    assert load_entry(p).status == "BLOCKED"
