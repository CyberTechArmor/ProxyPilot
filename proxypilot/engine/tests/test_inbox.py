"""Inbox round-trip + routing tests.

The contract is strict: state.status / state.last_updated / state.history
are the only fields the engine writes. Everything else — including
unknown top-level fields — must round-trip verbatim. The routing
helpers must downgrade unknown action_class / status to the safe
defaults specified in the engine doc.
"""

from __future__ import annotations

import textwrap
from pathlib import Path

import pytest

from proxypilot.engine.inbox import (
    ACTION_ALERT,
    ACTION_AUTO_PATCH,
    ACTION_ONE_CLICK,
    STATUS_IN_PROGRESS,
    STATUS_NEW,
    STATUS_RESOLVED,
    append_history,
    load_entry,
    save,
    set_status,
)


def _write(tmp_path: Path, name: str, body: str) -> Path:
    p = tmp_path / name
    p.write_text(textwrap.dedent(body).lstrip(), encoding="utf-8")
    return p


def test_known_action_class_routes_through(tmp_path: Path):
    p = _write(tmp_path, "CVE-2026-0001.yaml", """
        cve: CVE-2026-0001
        name: test
        hosts:
          alpha:
            action_class: AUTO_PATCH
            tier: 1
        playbook:
          detect: {probe: "exit 0"}
          patch: {steps: ["true"]}
        state:
          status: NEW
    """)
    e = load_entry(p)
    assert e.action_class("alpha") == ACTION_AUTO_PATCH
    assert e.action_class("missing") == ACTION_ALERT


def test_unknown_action_class_routes_to_alert(tmp_path: Path):
    p = _write(tmp_path, "CVE-2026-0002.yaml", """
        cve: CVE-2026-0002
        hosts:
          alpha:
            action_class: SUPER_FAST_PATCH
            tier: 1
        state: {status: NEW}
    """)
    e = load_entry(p)
    assert e.action_class("alpha") == ACTION_ALERT


def test_unknown_status_routes_to_in_progress(tmp_path: Path):
    p = _write(tmp_path, "CVE-2026-0003.yaml", """
        cve: CVE-2026-0003
        state: {status: HALF_BAKED}
    """)
    e = load_entry(p)
    assert e.status == STATUS_IN_PROGRESS


def test_legacy_list_form_hosts_resolves(tmp_path: Path):
    p = _write(tmp_path, "CVE-2026-0004.yaml", """
        cve: CVE-2026-0004
        hosts:
          - host: vm
            action_class: ONE_CLICK
            tier: 2
        state: {status: NEW}
    """)
    e = load_entry(p)
    assert e.action_class("vm") == ACTION_ONE_CLICK
    # A host not in the legacy list still safely defaults to ALERT.
    assert e.action_class("other") == ACTION_ALERT


def test_writeback_preserves_unknown_fields(tmp_path: Path):
    body = """
        cve: CVE-2026-0099
        name: test
        # operator-authored comment that must survive a write-back
        custom_top_level:
          a: 1
          b: [2, 3]
        unicorn_field: "claude wrote me"
        hosts:
          alpha:
            action_class: AUTO_PATCH
            tier: 1
            custom_host_field: yes
        playbook:
          detect: {probe: "exit 0"}
          patch: {steps: ["true"]}
        state:
          status: NEW
          operator_seen: false
    """
    p = _write(tmp_path, "CVE-2026-0099.yaml", body)
    e = load_entry(p)
    set_status(e, STATUS_RESOLVED)
    append_history(e, host="alpha", change="resolved by test")
    save(e)

    text = p.read_text(encoding="utf-8")
    # Unknown top-level fields and host-level fields survive.
    assert "custom_top_level" in text
    assert "unicorn_field" in text
    assert "custom_host_field" in text
    # Comment survives via ruamel round-trip.
    assert "operator-authored comment" in text
    # The fields the engine owns reflect the change.
    assert "RESOLVED" in text
    assert "resolved by test" in text


def test_history_append_does_not_clobber_existing(tmp_path: Path):
    p = _write(tmp_path, "CVE-2026-0100.yaml", """
        cve: CVE-2026-0100
        state:
          status: IN_PROGRESS
          history:
            - {ts: "2026-01-01T00:00:00Z", actor: claude, change: created}
    """)
    e = load_entry(p)
    append_history(e, host="alpha", change="engine touched")
    save(e)
    e2 = load_entry(p)
    hist = list(e2.state["history"])
    assert len(hist) == 2
    assert hist[0]["actor"] == "claude"
    assert hist[1]["actor"] == "proxypilot-engine"


def test_status_default_is_new_when_missing(tmp_path: Path):
    p = _write(tmp_path, "CVE-2026-0101.yaml", """
        cve: CVE-2026-0101
        state: {}
    """)
    assert load_entry(p).status == STATUS_NEW


def test_lower_case_legacy_status_normalizes(tmp_path: Path):
    p = _write(tmp_path, "CVE-2026-0102.yaml", """
        cve: CVE-2026-0102
        state: {status: new}
    """)
    assert load_entry(p).status == STATUS_NEW


def test_underscore_form_status_normalizes(tmp_path: Path):
    # Legacy entries used `alert_auto_rollback` instead of the
    # canonical hyphenated form; treat them as equivalent.
    p = _write(tmp_path, "CVE-2026-0103.yaml", """
        cve: CVE-2026-0103
        state: {status: alert_auto_rollback}
    """)
    assert load_entry(p).status == "ALERT-AUTO-ROLLBACK"
