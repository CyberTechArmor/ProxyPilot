"""End-to-end tests for the engine CLI subcommands that need stdin
or filesystem-touching behavior. The runner / inbox modules already
have their own focused tests; this file pins the wire shape the
backend depends on.
"""

from __future__ import annotations

import io
import json
import sys
from pathlib import Path

import pytest

from proxypilot.engine import __main__ as cli


def _capture(monkeypatch, stdin_text=""):
    monkeypatch.setattr(sys, "stdin", io.StringIO(stdin_text))
    out = io.StringIO()
    monkeypatch.setattr(sys, "stdout", out)
    return out


def _last_line_json(buf):
    return json.loads(buf.getvalue().strip().split("\n")[-1])


def test_validate_accepts_minimal_entry(monkeypatch):
    body = (
        "cve: CVE-2026-12345\n"
        "name: test\n"
        "hosts:\n  vm: {action_class: AUTO_PATCH, tier: 1}\n"
        "state: {status: NEW}\n"
    )
    out = _capture(monkeypatch, body)
    rc = cli.main(["validate"])
    assert rc == 0
    j = _last_line_json(out)
    assert j["ok"] is True
    assert j["cve"] == "CVE-2026-12345"


def test_validate_rejects_missing_cve_field(monkeypatch):
    out = _capture(monkeypatch, "name: just a title\n")
    rc = cli.main(["validate"])
    assert rc == 2
    j = _last_line_json(out)
    assert j["ok"] is False
    assert "cve" in j["error"].lower()


def test_validate_rejects_bad_cve_id(monkeypatch):
    out = _capture(monkeypatch, "cve: NOT-A-CVE\n")
    rc = cli.main(["validate"])
    assert rc == 2
    j = _last_line_json(out)
    assert j["ok"] is False
    assert "cve id" in j["error"].lower()


def test_validate_rejects_unparseable_yaml(monkeypatch):
    out = _capture(monkeypatch, "cve: CVE-2026-1234\n  bad indent: x\n: : :\n")
    rc = cli.main(["validate"])
    assert rc == 2
    j = _last_line_json(out)
    assert j["ok"] is False


def test_validate_rejects_empty(monkeypatch):
    out = _capture(monkeypatch, "")
    rc = cli.main(["validate"])
    assert rc == 2
    j = _last_line_json(out)
    assert j["ok"] is False
    assert "empty" in j["error"].lower()


def test_validate_rejects_non_mapping_top_level(monkeypatch):
    out = _capture(monkeypatch, "- just a list\n- of stuff\n")
    rc = cli.main(["validate"])
    assert rc == 2
    j = _last_line_json(out)
    assert j["ok"] is False


def test_validate_rejects_bad_hosts_shape(monkeypatch):
    out = _capture(monkeypatch, "cve: CVE-2026-1234\nhosts: \"not a mapping\"\n")
    rc = cli.main(["validate"])
    assert rc == 2


def test_mark_seen_writes_operator_seen_true(tmp_path, monkeypatch):
    body = "cve: CVE-2026-9001\nstate: {status: NEW, operator_seen: false}\n"
    p = tmp_path / "CVE-2026-9001.yaml"
    p.write_text(body)
    out = _capture(monkeypatch)
    rc = cli.main(["--inbox", str(tmp_path), "mark-seen", "CVE-2026-9001"])
    assert rc == 0
    j = _last_line_json(out)
    assert j["ok"] is True
    assert "operator_seen: true" in p.read_text()


def test_dismiss_requires_reason(tmp_path):
    p = tmp_path / "CVE-2026-9002.yaml"
    p.write_text("cve: CVE-2026-9002\nstate: {status: NEW}\n")
    with pytest.raises(SystemExit):
        cli.main(["--inbox", str(tmp_path), "dismiss", "CVE-2026-9002"])


def test_dismiss_writes_status_and_history(tmp_path, monkeypatch):
    p = tmp_path / "CVE-2026-9003.yaml"
    p.write_text("cve: CVE-2026-9003\nstate: {status: NEW}\n")
    out = _capture(monkeypatch)
    rc = cli.main(["--host", "h1", "--inbox", str(tmp_path), "dismiss",
                   "CVE-2026-9003", "--reason", "not applicable", "--actor", "operator:test"])
    assert rc == 0
    j = _last_line_json(out)
    assert j["ok"] is True
    text = p.read_text()
    assert "DISMISSED" in text
    assert "not applicable" in text
    assert "operator:test" in text


# ── paste + origin stamp ──────────────────────────────────────────────────────

def test_paste_writes_file_and_stamps_origin(tmp_path, monkeypatch):
    body = (
        "cve: CVE-2026-1100\n"
        "name: paste origin test\n"
        "hosts:\n  vm: {action_class: ALERT, tier: 4}\n"
        "state: {status: NEW, operator_seen: false}\n"
    )
    out = _capture(monkeypatch, body)
    rc = cli.main(["--inbox", str(tmp_path), "paste"])
    assert rc == 0
    j = _last_line_json(out)
    assert j["ok"] is True
    assert j["cve"] == "CVE-2026-1100"
    text = (tmp_path / "CVE-2026-1100.yaml").read_text()
    assert "_proxypilot:" in text
    assert "origin: paste" in text


def test_paste_does_not_overwrite_existing_origin(tmp_path, monkeypatch):
    # If the body already carries a _proxypilot block (e.g. operator
    # is editing an AI-filed entry), we must NOT clobber it back to
    # "paste" — the original origin should be preserved.
    body = (
        "cve: CVE-2026-1101\n"
        "_proxypilot:\n  origin: ai\n  imported_at: \"2026-01-01T00:00:00Z\"\n"
        "state: {status: NEW}\n"
    )
    out = _capture(monkeypatch, body)
    rc = cli.main(["--inbox", str(tmp_path), "paste"])
    assert rc == 0
    text = (tmp_path / "CVE-2026-1101.yaml").read_text()
    assert "origin: ai" in text
    assert "origin: paste" not in text


def test_paste_origin_ai_stamps_ai(tmp_path, monkeypatch):
    # The backend's AI research routine writes through the same paste
    # path with --origin ai so its entries are provenance-distinct
    # from hand-pasted ones.
    body = (
        "cve: CVE-2026-1102\n"
        "name: ai origin test\n"
        "state: {status: NEW}\n"
    )
    out = _capture(monkeypatch, body)
    rc = cli.main(["--inbox", str(tmp_path), "paste", "--origin", "ai"])
    assert rc == 0
    j = _last_line_json(out)
    assert j["ok"] is True
    text = (tmp_path / "CVE-2026-1102.yaml").read_text()
    assert "_proxypilot:" in text
    assert "origin: ai" in text


def test_paste_update_preserves_state_and_origin(tmp_path, monkeypatch):
    # Updating an existing entry with a body that omits state/_proxypilot
    # (the AI research routine's update shape) must carry both over from
    # the file on disk — status/history/provenance survive a spec revision.
    (tmp_path / "CVE-2026-1103.yaml").write_text(
        "cve: CVE-2026-1103\n"
        "name: original\n"
        "_proxypilot: {origin: paste, imported_at: \"2026-01-01T00:00:00Z\"}\n"
        "state:\n"
        "  status: RESOLVED\n"
        "  history:\n"
        "    - {ts: \"2026-01-02T00:00:00Z\", actor: engine, change: patched}\n"
    )
    body = "cve: CVE-2026-1103\nname: revised by research\ncvss: 9.8\n"
    _capture(monkeypatch, body)
    rc = cli.main(["--inbox", str(tmp_path), "paste", "--origin", "ai"])
    assert rc == 0
    text = (tmp_path / "CVE-2026-1103.yaml").read_text()
    assert "revised by research" in text
    assert "status: RESOLVED" in text
    assert "change: patched" in text
    # Provenance stays with the FIRST import — not restamped to ai.
    assert "origin: paste" in text
    assert "origin: ai" not in text


def test_paste_rejects_invalid_yaml(tmp_path, monkeypatch):
    out = _capture(monkeypatch, "not: valid: yaml: at all")
    rc = cli.main(["--inbox", str(tmp_path), "paste"])
    assert rc == 2
    j = _last_line_json(out)
    assert j["ok"] is False
    # No file should have been written.
    assert not list(tmp_path.iterdir())


# ── purge-git-origin ─────────────────────────────────────────────────────────

def test_purge_git_origin_removes_only_git_entries(tmp_path, monkeypatch):
    inbox = tmp_path / "inbox"
    inbox.mkdir()
    (inbox / "CVE-2026-3001.yaml").write_text(
        "cve: CVE-2026-3001\n"
        "_proxypilot: {origin: git, git_url: https://example.com/cves.git}\n"
        "state: {status: NEW}\n")
    (inbox / "CVE-2026-3002.yaml").write_text(
        "cve: CVE-2026-3002\n_proxypilot: {origin: paste}\nstate: {status: NEW}\n")
    (inbox / "CVE-2026-3003.yaml").write_text(
        "cve: CVE-2026-3003\n_proxypilot: {origin: ai}\nstate: {status: NEW}\n")
    # Pre-origin-tracking entry with no _proxypilot block at all —
    # must be kept (we only delete what we know came from git).
    (inbox / "CVE-2026-3004.yaml").write_text(
        "cve: CVE-2026-3004\nstate: {status: NEW}\n")
    staging = tmp_path / "staging"
    staging.mkdir()
    (staging / "leftover.yaml").write_text("cve: CVE-2026-0000\n")
    out = _capture(monkeypatch)
    rc = cli.main(["--inbox", str(inbox), "purge-git-origin",
                   "--source-dir", str(staging)])
    assert rc == 0
    j = _last_line_json(out)
    assert j["ok"] is True
    assert j["removed"] == ["CVE-2026-3001.yaml"]
    assert j["staging_removed"] is True
    assert not (inbox / "CVE-2026-3001.yaml").exists()
    assert (inbox / "CVE-2026-3002.yaml").exists()
    assert (inbox / "CVE-2026-3003.yaml").exists()
    assert (inbox / "CVE-2026-3004.yaml").exists()
    assert not staging.exists()


def test_purge_git_origin_is_a_noop_on_clean_inbox(tmp_path, monkeypatch):
    inbox = tmp_path / "inbox"
    inbox.mkdir()
    (inbox / "CVE-2026-3005.yaml").write_text(
        "cve: CVE-2026-3005\n_proxypilot: {origin: paste}\nstate: {status: NEW}\n")
    out = _capture(monkeypatch)
    rc = cli.main(["--inbox", str(inbox), "purge-git-origin",
                   "--source-dir", str(tmp_path / "no-such-staging")])
    assert rc == 0
    j = _last_line_json(out)
    assert j["ok"] is True
    assert j["removed"] == []
    assert j["staging_removed"] is False
    assert (inbox / "CVE-2026-3005.yaml").exists()
