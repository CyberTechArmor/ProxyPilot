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
