"""Read-only git source for the CVE inbox.

The inbox is the engine's source of truth — Claude (or any other
author) writes YAML files into /var/lib/proxypilot/cve-inbox/ and the
engine acts on them. For a fleet, multiple ProxyPilot installs want
to share the same Claude-curated catalog without each operator
pasting the same YAMLs by hand.

This module clones / pulls a configured git repo into a staging dir
and copies *new* spec files into the inbox. The sync is strictly
additive:

  - An entry already present in the inbox is never overwritten.
  - A change to the git URL never removes existing entries — they
    keep whatever `_proxypilot.origin` they were imported with.
  - Engine state writes (status, history, last_updated) live ONLY
    in the inbox copy. The git source remains untouched.
  - The `_proxypilot` block is added on import so the dashboard
    can surface where each entry came from. It's preserved by the
    opaque-field round-trip in inbox.py.

Schema added on import (top-level, never touched by the engine):

    _proxypilot:
      origin: paste | git
      git_url: <url>            # only when origin=git
      git_commit: <sha>         # commit hash at sync time
      imported_at: <iso8601>

Operators set the git URL via the dashboard (POST /api/cves/git-config),
which writes app_settings.cve_git_url. The engine reads the URL from
the same setting via the dashboard backend, OR from the env var
PROXYPILOT_CVE_GIT_URL. The CLI accepts --git-url for ad-hoc syncs.
"""

from __future__ import annotations

import io
import json
import os
import re
import shutil
import subprocess
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import List, Optional

from .inbox import _yaml, now_iso

# Where the read-only git working tree lives. Kept inside
# /var/lib/proxypilot so it shares filesystem ownership + backup
# scope with the inbox. Never bind-mounted into the dashboard
# container — operators don't browse it directly.
DEFAULT_SOURCE_DIR = "/var/lib/proxypilot/cve-inbox-source"

# Per-entry import marker. Lives at top level so it round-trips
# through the engine's opaque-field preservation. The leading
# underscore signals "tooling metadata, not Claude-authored content".
ORIGIN_KEY = "_proxypilot"

# CVE-id filename pattern. Same as the inbox/backend route checks —
# anything else in the source repo is ignored.
_CVE_RE = re.compile(r"^CVE-\d{4}-\d{4,7}\.yaml$")


@dataclass
class GitSpec:
    """A parsed source URL: clone target, branch (optional), subpath
    inside the clone (optional). Equality is over the clone_url +
    branch — the subpath is a filter applied after clone, not part
    of the upstream identity."""
    clone_url: str
    branch: Optional[str] = None
    subpath: Optional[str] = None
    # The URL the operator originally typed, kept verbatim for the
    # _proxypilot.git_url stamp so they can find the entry's source
    # by searching their address bar history.
    original: str = ""


@dataclass
class SyncResult:
    git_url: str
    git_commit: str = ""
    branch: str = ""
    subpath: str = ""
    imported: List[str] = field(default_factory=list)
    skipped_existing: List[str] = field(default_factory=list)
    skipped_invalid: List[str] = field(default_factory=list)
    errors: List[str] = field(default_factory=list)


def _run(argv: List[str], cwd: Optional[Path] = None,
         timeout: int = 60) -> subprocess.CompletedProcess[str]:
    """Run a git/shell command. cwd defaults to the source dir."""
    return subprocess.run(
        argv, cwd=str(cwd) if cwd else None,
        capture_output=True, text=True, timeout=timeout, check=False,
    )


# ── URL parsing ───────────────────────────────────────────────────────────────
#
# We accept three shapes so the operator can paste whatever's in front
# of them without translating it:
#
#   1. Plain git URL — clone default branch, walk repo root.
#         https://github.com/owner/repo.git
#         git@github.com:owner/repo.git
#
#   2. Fragment syntax — explicit, works on any git host.
#         <url>#<branch>
#         <url>#<branch>:<subpath>
#         e.g.  https://gitlab.example.com/x/y.git#main:cves
#
#   3. GitHub web /tree/ URL — what the browser address bar shows.
#         https://github.com/owner/repo/tree/<ref>/<path...>
#      Refs can contain slashes (e.g. claude/great-mendel-zXSGE), so
#      we use `git ls-remote --heads` to enumerate the actual branches
#      and pick the longest prefix match. One network round-trip per
#      first sync; subsequent syncs hit the existing clone.

_GITHUB_TREE_RE = re.compile(
    r"^(?P<base>https?://github\.com/[^/]+/[^/]+?)(?:\.git)?/tree/(?P<rest>.+?)/?$"
)


def _ls_remote_branches(repo_url: str, *, timeout: int = 15) -> List[str]:
    """Return the list of branch names on the remote, or an empty
    list if ls-remote fails (no network, auth required, etc)."""
    out = _run(["git", "ls-remote", "--heads", repo_url], timeout=timeout)
    if out.returncode != 0:
        return []
    heads: List[str] = []
    for line in out.stdout.splitlines():
        parts = line.split()
        if len(parts) == 2 and parts[1].startswith("refs/heads/"):
            heads.append(parts[1][len("refs/heads/"):])
    return heads


def parse_git_source(url: str) -> GitSpec:
    """Normalise an operator-pasted URL into a GitSpec. Pure for
    fragment syntax; performs one ls-remote for GitHub /tree/ URLs
    when the ref is ambiguous (refs with slashes)."""
    raw = (url or "").strip()
    if not raw:
        raise ValueError("git_url is empty")

    # Form 2: explicit fragment. Operator-controlled, trumps anything
    # we'd otherwise infer.
    if "#" in raw:
        base, _, frag = raw.partition("#")
        branch: Optional[str] = frag
        subpath: Optional[str] = None
        if ":" in frag:
            branch, _, subpath = frag.partition(":")
        return GitSpec(
            clone_url=base.strip(),
            branch=(branch.strip() or None),
            subpath=(subpath.strip().strip("/") or None) if subpath else None,
            original=raw,
        )

    # Form 3: GitHub /tree/ URL. Try to disambiguate ref vs. path via
    # ls-remote; fall back to the simple "first segment is the branch"
    # if the network lookup fails.
    m = _GITHUB_TREE_RE.match(raw)
    if m:
        clone_url = m.group("base") + ".git"
        rest = m.group("rest")
        parts = rest.split("/")
        # Try longest-prefix-match against the remote's branch list.
        heads = set(_ls_remote_branches(clone_url))
        if heads:
            for i in range(len(parts), 0, -1):
                cand = "/".join(parts[:i])
                if cand in heads:
                    return GitSpec(
                        clone_url=clone_url, branch=cand,
                        subpath=("/".join(parts[i:]).strip("/") or None),
                        original=raw,
                    )
        # No ls-remote / no match — assume single-segment branch.
        branch = parts[0]
        subpath = "/".join(parts[1:]).strip("/") or None
        return GitSpec(clone_url=clone_url, branch=branch,
                       subpath=subpath, original=raw)

    # Form 1: plain URL.
    return GitSpec(clone_url=raw, original=raw)


def clone_or_pull(spec: GitSpec, source_dir: Path) -> str:
    """Ensure source_dir contains a clone of spec at spec.branch.
    Returns the current HEAD SHA. Idempotent: re-running pulls the
    latest tip of the configured branch."""
    if not spec.clone_url.strip():
        raise ValueError("clone_url is empty")

    source_dir.parent.mkdir(parents=True, exist_ok=True)
    git_dir = source_dir / ".git"

    if git_dir.is_dir():
        # Existing clone. If the configured URL or branch changed,
        # update the remote + switch refs. Then fetch + reset.
        cur = _run(["git", "remote", "get-url", "origin"], cwd=source_dir)
        if cur.returncode == 0 and cur.stdout.strip() != spec.clone_url:
            _run(["git", "remote", "set-url", "origin", spec.clone_url],
                 cwd=source_dir)
        fetch_args = ["git", "fetch", "--depth", "1", "origin"]
        if spec.branch:
            fetch_args.append(spec.branch)
        fetch = _run(fetch_args, cwd=source_dir)
        if fetch.returncode != 0:
            raise RuntimeError(f"git fetch failed: {fetch.stderr.strip()}")
        if spec.branch:
            target = "FETCH_HEAD"
        else:
            head = _run(
                ["git", "symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
                cwd=source_dir,
            )
            target = head.stdout.strip() if head.returncode == 0 else "FETCH_HEAD"
        reset = _run(["git", "reset", "--hard", target], cwd=source_dir)
        if reset.returncode != 0:
            raise RuntimeError(f"git reset failed: {reset.stderr.strip()}")
    else:
        # Fresh clone. --depth 1 keeps the staging dir small; -b adds
        # branch selection when the operator specified one (or we
        # parsed it out of a /tree/ URL).
        if source_dir.exists():
            raise RuntimeError(
                f"{source_dir} exists and is not a git checkout; refusing to overwrite")
        clone_args = ["git", "clone", "--depth", "1"]
        if spec.branch:
            clone_args += ["-b", spec.branch]
        clone_args += [spec.clone_url, str(source_dir)]
        clone = _run(clone_args, timeout=180)
        if clone.returncode != 0:
            raise RuntimeError(f"git clone failed: {clone.stderr.strip()}")

    sha = _run(["git", "rev-parse", "HEAD"], cwd=source_dir)
    return sha.stdout.strip() if sha.returncode == 0 else ""


def _stamp_origin(raw: dict, *, origin: str, git_url: str = "",
                  git_commit: str = "") -> None:
    """Add the _proxypilot block to a freshly imported entry, in
    place. Idempotent — never overwrites an existing block, since
    operators may have edited it post-import."""
    if ORIGIN_KEY in raw:
        return
    block = {"origin": origin, "imported_at": now_iso()}
    if git_url:
        block["git_url"] = git_url
    if git_commit:
        block["git_commit"] = git_commit
    raw[ORIGIN_KEY] = block


def stamp_paste_origin(raw: dict) -> None:
    """Public wrapper for the paste path — backend calls this before
    handing the body to writeYamlAtomic. No-op if already stamped."""
    _stamp_origin(raw, origin="paste")


def sync(git_url: str, *, inbox_dir: Path, source_dir: Path = Path(DEFAULT_SOURCE_DIR)
         ) -> SyncResult:
    """Pull the source repo and copy any spec files that aren't
    already in the inbox. Returns a SyncResult summarising what was
    imported, skipped, and errored.

    Accepts the same URL shapes as parse_git_source: plain URL,
    fragment-syntax (#branch[:subpath]), or GitHub /tree/ URL."""
    spec = parse_git_source(git_url)
    result = SyncResult(
        git_url=spec.original or spec.clone_url,
        branch=spec.branch or "",
        subpath=spec.subpath or "",
    )

    try:
        result.git_commit = clone_or_pull(spec, source_dir)
    except Exception as e:
        result.errors.append(str(e))
        return result

    if not source_dir.is_dir():
        result.errors.append(f"source dir not present after clone: {source_dir}")
        return result

    # Constrain the walk to the configured subpath so we don't scan
    # the whole repo (and don't accidentally import stray YAMLs from
    # unrelated subdirectories). Path traversal out of the clone via
    # `..` is rejected — we resolve and check is_relative_to.
    walk_root = source_dir
    if spec.subpath:
        candidate = (source_dir / spec.subpath).resolve()
        clone_root = source_dir.resolve()
        # is_relative_to landed in 3.9; explicit check keeps us safe
        # if the operator pastes "../etc/passwd" or similar.
        try:
            candidate.relative_to(clone_root)
        except ValueError:
            result.errors.append(
                f"subpath escapes clone root: {spec.subpath!r}")
            return result
        if not candidate.is_dir():
            result.errors.append(
                f"subpath does not exist in repo: {spec.subpath!r} "
                f"(branch={spec.branch or 'default'})")
            return result
        walk_root = candidate

    inbox_dir.mkdir(parents=True, exist_ok=True)
    yaml = _yaml()

    # Walk the source (sub)dir for *.yaml that match the CVE filename
    # pattern. Repos can stash READMEs, indexes, fixtures, etc. in
    # the same tree without us trying to import them.
    for src in sorted(walk_root.rglob("*.yaml")):
        if not _CVE_RE.match(src.name):
            continue
        target = inbox_dir / src.name
        if target.exists():
            result.skipped_existing.append(src.name)
            continue
        try:
            with src.open("r", encoding="utf-8") as f:
                raw = yaml.load(f)
            if not isinstance(raw, dict) and not hasattr(raw, "items"):
                result.skipped_invalid.append(src.name)
                continue
            cve_field = raw.get("cve")
            if not isinstance(cve_field, str) or src.stem != cve_field:
                # Filename / cve disagree — refuse the import. The
                # operator pastes via the dashboard if they want a
                # rename or override.
                result.skipped_invalid.append(
                    f"{src.name} (cve mismatch: file={src.stem!r} body={cve_field!r})")
                continue
            _stamp_origin(raw, origin="git",
                          git_url=spec.original or spec.clone_url,
                          git_commit=result.git_commit)
            # Atomic write so a crash mid-copy doesn't leave half a
            # YAML in the inbox for the next poll to choke on.
            tmp = target.with_suffix(target.suffix + ".tmp")
            with tmp.open("w", encoding="utf-8") as f:
                yaml.dump(raw, f)
            os.replace(tmp, target)
            result.imported.append(src.name)
        except Exception as e:
            result.errors.append(f"{src.name}: {e}")

    return result
