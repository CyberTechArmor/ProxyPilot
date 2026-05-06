"""URL-parsing + sync tests for source_git.

Covers the three URL shapes the dashboard accepts:
  - plain git URL → defaults
  - fragment syntax (#branch[:subpath]) → explicit branch + subpath
  - GitHub /tree/ URL → branch + subpath inferred from the URL path

The fragment-syntax cases are pure (no network); the GitHub /tree/
case is exercised against a local file:// repo with branches that
mimic the real shape (slash in the branch name, files under a
subdirectory).
"""

from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

from proxypilot.engine.source_git import GitSpec, parse_git_source, sync


def _git(args, cwd=None, check=True):
    """Tiny helper for fixture setup. Disables GPG signing because
    the test env may have global commit-signing turned on."""
    env_args = ["-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false"]
    return subprocess.run(["git"] + env_args + list(args),
                          cwd=cwd, capture_output=True, text=True, check=check)


def _init_repo(repo_dir: Path, *, default_branch="main"):
    repo_dir.mkdir(parents=True, exist_ok=True)
    _git(["init", "-q", "-b", default_branch], cwd=repo_dir)
    _git(["config", "user.email", "t@e"], cwd=repo_dir)
    _git(["config", "user.name", "t"], cwd=repo_dir)
    _git(["config", "commit.gpgsign", "false"], cwd=repo_dir)


def _commit_all(repo_dir: Path, msg: str):
    _git(["add", "."], cwd=repo_dir)
    _git(["commit", "-q", "--no-gpg-sign", "-m", msg], cwd=repo_dir)


# ── parse_git_source: pure URL parsing ────────────────────────────────────────

def test_parse_plain_url():
    spec = parse_git_source("https://example.com/x/y.git")
    assert spec.clone_url == "https://example.com/x/y.git"
    assert spec.branch is None
    assert spec.subpath is None


def test_parse_fragment_branch_only():
    spec = parse_git_source("https://example.com/x/y.git#main")
    assert spec.clone_url == "https://example.com/x/y.git"
    assert spec.branch == "main"
    assert spec.subpath is None


def test_parse_fragment_branch_and_subpath():
    spec = parse_git_source(
        "https://example.com/x/y.git#release/v2:cves/2026")
    assert spec.clone_url == "https://example.com/x/y.git"
    assert spec.branch == "release/v2"
    assert spec.subpath == "cves/2026"


def test_parse_fragment_strips_leading_trailing_slashes_in_subpath():
    spec = parse_git_source("https://x/y.git#main:/cves/")
    assert spec.subpath == "cves"


def test_parse_empty_url_raises():
    with pytest.raises(ValueError):
        parse_git_source("   ")


def test_parse_github_tree_url_simple_branch():
    # Without ls-remote (no network), falls back to "first segment is
    # the branch", everything after is the subpath. Operator can use
    # fragment syntax to be explicit when the branch contains slashes
    # and we can't reach the remote.
    spec = parse_git_source(
        "https://github.com/owner/repo/tree/main/var/lib/proxypilot")
    assert spec.clone_url == "https://github.com/owner/repo.git"
    assert spec.branch == "main"
    assert spec.subpath == "var/lib/proxypilot"


def test_parse_github_tree_url_disambiguates_via_ls_remote(tmp_path, monkeypatch):
    # Build a fake repo with a branch whose name contains a slash —
    # exactly the shape the user hit (claude/great-mendel-zXSGE).
    repo = tmp_path / "fake.git"
    _init_repo(repo, default_branch="main")
    (repo / "README").write_text("init\n")
    _commit_all(repo, "init")
    _git(["checkout", "-b", "claude/great-mendel-zXSGE"], cwd=repo)
    (repo / "marker").write_text("x\n")
    _commit_all(repo, "branch")

    # Stub _ls_remote_branches to return what `git ls-remote` of our
    # fake repo would have. Avoids relying on the test env being able
    # to talk file:// from the engine module (it can; this is just
    # cleaner and faster).
    from proxypilot.engine import source_git as sg
    monkeypatch.setattr(sg, "_ls_remote_branches",
                        lambda url, timeout=15: ["main", "claude/great-mendel-zXSGE"])

    spec = parse_git_source(
        "https://github.com/owner/repo/tree/claude/great-mendel-zXSGE/var/lib/proxypilot")
    assert spec.clone_url == "https://github.com/owner/repo.git"
    assert spec.branch == "claude/great-mendel-zXSGE"
    assert spec.subpath == "var/lib/proxypilot"


# ── sync: end-to-end with a real local file:// repo ──────────────────────────

def _make_source_repo(tmp_path: Path, *, branch="main", subpath="cves"):
    repo = tmp_path / "src.git-src"
    _init_repo(repo, default_branch=branch)
    (repo / subpath).mkdir(parents=True)
    for cve, name in [("CVE-2026-1001", "alpha"), ("CVE-2026-1002", "bravo")]:
        (repo / subpath / f"{cve}.yaml").write_text(
            f"cve: {cve}\nname: {name}\nstate: {{status: NEW}}\n")
    # Noise that should be ignored by the import filter.
    (repo / subpath / "README.md").write_text("nope")
    (repo / "inventory.json").write_text("{}")  # outside subpath
    _commit_all(repo, "init")
    return repo


def test_sync_with_subpath_only_walks_that_subdir(tmp_path):
    repo = _make_source_repo(tmp_path, subpath="cves/2026")
    inbox = tmp_path / "inbox"
    src = tmp_path / "src"

    result = sync(f"file://{repo}#main:cves/2026",
                  inbox_dir=inbox, source_dir=src)

    assert not result.errors
    assert result.branch == "main"
    assert result.subpath == "cves/2026"
    assert sorted(result.imported) == ["CVE-2026-1001.yaml", "CVE-2026-1002.yaml"]
    # Both stamped with the original URL (the operator-typed string).
    body = (inbox / "CVE-2026-1001.yaml").read_text()
    assert "_proxypilot:" in body
    assert "origin: git" in body
    assert "branch:" not in body  # branch only in result, not the YAML stamp


def test_sync_with_branch_checks_out_that_branch(tmp_path):
    repo = _make_source_repo(tmp_path)
    # Create a feature branch with an extra spec.
    _git(["checkout", "-b", "feature/extra"], cwd=repo)
    (repo / "cves" / "CVE-2026-2001.yaml").write_text(
        "cve: CVE-2026-2001\nname: feature-only\nstate: {status: NEW}\n")
    _commit_all(repo, "feature commit")

    inbox = tmp_path / "inbox"
    src = tmp_path / "src"

    result = sync(f"file://{repo}#feature/extra:cves",
                  inbox_dir=inbox, source_dir=src)

    assert not result.errors
    assert result.branch == "feature/extra"
    # All three files (two from main + one feature-only) come through
    # because shallow clone of feature/extra includes both.
    assert "CVE-2026-2001.yaml" in result.imported


def test_sync_subpath_traversal_rejected(tmp_path):
    repo = _make_source_repo(tmp_path)
    inbox = tmp_path / "inbox"
    src = tmp_path / "src"

    result = sync(f"file://{repo}#main:../../../etc",
                  inbox_dir=inbox, source_dir=src)

    assert any("escapes clone root" in e for e in result.errors)
    assert result.imported == []


def test_sync_subpath_missing_in_repo_errors(tmp_path):
    repo = _make_source_repo(tmp_path, subpath="cves")
    inbox = tmp_path / "inbox"
    src = tmp_path / "src"

    result = sync(f"file://{repo}#main:no-such-dir",
                  inbox_dir=inbox, source_dir=src)

    assert any("does not exist in repo" in e for e in result.errors)
    assert result.imported == []


def test_sync_uses_default_branch_when_unspecified(tmp_path):
    repo = _make_source_repo(tmp_path)
    inbox = tmp_path / "inbox"
    src = tmp_path / "src"

    result = sync(f"file://{repo}", inbox_dir=inbox, source_dir=src)

    assert not result.errors
    assert result.branch == ""  # not requested → empty in result
    assert sorted(result.imported) == ["CVE-2026-1001.yaml", "CVE-2026-1002.yaml"]
