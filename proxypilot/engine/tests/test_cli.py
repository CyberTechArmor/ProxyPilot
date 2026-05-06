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
    # is editing a git-imported entry), we must NOT clobber it back
    # to "paste" — the original origin should be preserved.
    body = (
        "cve: CVE-2026-1101\n"
        "_proxypilot:\n  origin: git\n  git_url: https://example.com/cves.git\n"
        "state: {status: NEW}\n"
    )
    out = _capture(monkeypatch, body)
    rc = cli.main(["--inbox", str(tmp_path), "paste"])
    assert rc == 0
    text = (tmp_path / "CVE-2026-1101.yaml").read_text()
    assert "origin: git" in text
    assert "origin: paste" not in text


def test_paste_rejects_invalid_yaml(tmp_path, monkeypatch):
    out = _capture(monkeypatch, "not: valid: yaml: at all")
    rc = cli.main(["--inbox", str(tmp_path), "paste"])
    assert rc == 2
    j = _last_line_json(out)
    assert j["ok"] is False
    # No file should have been written.
    assert not list(tmp_path.iterdir())


# ── sync-git ──────────────────────────────────────────────────────────────────

def _init_fake_repo(tmp_path):
    """Build a tiny git repo containing a few CVE YAMLs + noise."""
    import subprocess
    repo = tmp_path / "fake-cves.git-src"
    repo.mkdir()
    (repo / "CVE-2026-2001.yaml").write_text(
        "cve: CVE-2026-2001\nname: from-git-1\nstate: {status: NEW}\n")
    (repo / "CVE-2026-2002.yaml").write_text(
        "cve: CVE-2026-2002\nname: from-git-2\nstate: {status: NEW}\n")
    (repo / "README.md").write_text("# noise\n")
    # A YAML whose filename doesn't match its cve field — must be skipped.
    (repo / "CVE-2026-9999.yaml").write_text(
        "cve: CVE-2026-2003\nstate: {status: NEW}\n")
    subprocess.run(["git", "init", "-q", "-b", "main"], cwd=repo, check=True)
    # Test environment may have global commit-signing turned on; the
    # fake repo doesn't need (and can't reach) a signing server.
    subprocess.run(["git", "config", "commit.gpgsign", "false"], cwd=repo, check=True)
    subprocess.run(["git", "config", "tag.gpgsign", "false"], cwd=repo, check=True)
    subprocess.run(["git", "config", "user.email", "t@e"], cwd=repo, check=True)
    subprocess.run(["git", "config", "user.name", "t"], cwd=repo, check=True)
    subprocess.run(["git", "add", "."], cwd=repo, check=True)
    subprocess.run(["git", "-c", "commit.gpgsign=false", "commit",
                    "-q", "-m", "init", "--no-gpg-sign"], cwd=repo, check=True)
    return repo


def test_sync_git_imports_new_specs(tmp_path, monkeypatch):
    import subprocess
    if subprocess.run(["git", "--version"],
                      capture_output=True).returncode != 0:
        import pytest as _pt
        _pt.skip("git not available")
    repo = _init_fake_repo(tmp_path)
    inbox = tmp_path / "inbox"
    src = tmp_path / "src"
    out = _capture(monkeypatch)
    rc = cli.main(["--inbox", str(inbox), "sync-git",
                   "--git-url", str(repo), "--source-dir", str(src)])
    assert rc == 0
    j = _last_line_json(out)
    assert j["ok"] is True
    assert sorted(j["imported"]) == ["CVE-2026-2001.yaml", "CVE-2026-2002.yaml"]
    # CVE-2026-9999.yaml had a cve field of CVE-2026-2003 — name/cve
    # mismatch is rejected.
    assert any("9999" in s for s in j["skipped_invalid"])
    # Each import got the origin stamp.
    for name in j["imported"]:
        text = (inbox / name).read_text()
        assert "_proxypilot:" in text
        assert "origin: git" in text


def test_sync_git_skips_existing_entries(tmp_path, monkeypatch):
    import subprocess
    if subprocess.run(["git", "--version"],
                      capture_output=True).returncode != 0:
        import pytest as _pt
        _pt.skip("git not available")
    repo = _init_fake_repo(tmp_path)
    inbox = tmp_path / "inbox"
    inbox.mkdir()
    # Pre-existing entry with an operator-edited state. Sync must
    # leave it alone — additive only.
    (inbox / "CVE-2026-2001.yaml").write_text(
        "cve: CVE-2026-2001\nname: operator-edited\n"
        "_proxypilot: {origin: paste}\nstate: {status: RESOLVED}\n")
    out = _capture(monkeypatch)
    rc = cli.main(["--inbox", str(inbox), "sync-git",
                   "--git-url", str(repo), "--source-dir", str(tmp_path / "src")])
    assert rc == 0
    j = _last_line_json(out)
    assert "CVE-2026-2001.yaml" not in j["imported"]
    assert "CVE-2026-2002.yaml" in j["imported"]
    # The pre-existing file's content was not overwritten.
    assert "operator-edited" in (inbox / "CVE-2026-2001.yaml").read_text()
    assert "RESOLVED" in (inbox / "CVE-2026-2001.yaml").read_text()
