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
class SyncResult:
    git_url: str
    git_commit: str = ""
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


def clone_or_pull(git_url: str, source_dir: Path) -> str:
    """Ensure source_dir contains a clone of git_url. Returns the
    current HEAD SHA. Idempotent: re-running pulls the latest tip."""
    if not git_url.strip():
        raise ValueError("git_url is empty")

    source_dir.parent.mkdir(parents=True, exist_ok=True)
    git_dir = source_dir / ".git"

    if git_dir.is_dir():
        # Existing clone. If the configured URL changed, update the
        # remote. Then fetch + reset to origin/HEAD so a forced-push
        # upstream doesn't leave us in a divergent state.
        cur = _run(["git", "remote", "get-url", "origin"], cwd=source_dir)
        if cur.returncode == 0 and cur.stdout.strip() != git_url:
            _run(["git", "remote", "set-url", "origin", git_url], cwd=source_dir)
        fetch = _run(["git", "fetch", "--depth", "1", "origin"], cwd=source_dir)
        if fetch.returncode != 0:
            raise RuntimeError(f"git fetch failed: {fetch.stderr.strip()}")
        # Resolve the default branch (HEAD ref on origin) so we don't
        # hardcode `main` vs `master`. Falls back to FETCH_HEAD.
        head = _run(
            ["git", "symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
            cwd=source_dir,
        )
        target = head.stdout.strip() if head.returncode == 0 else "FETCH_HEAD"
        reset = _run(["git", "reset", "--hard", target], cwd=source_dir)
        if reset.returncode != 0:
            raise RuntimeError(f"git reset failed: {reset.stderr.strip()}")
    else:
        # Fresh clone. --depth 1 keeps the staging dir small; we
        # only need the current spec contents, not history.
        if source_dir.exists():
            # Non-git dir at the target — refuse to clobber.
            raise RuntimeError(
                f"{source_dir} exists and is not a git checkout; refusing to overwrite")
        clone = _run(["git", "clone", "--depth", "1", git_url, str(source_dir)],
                     timeout=180)
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
    imported, skipped, and errored."""
    result = SyncResult(git_url=git_url)

    try:
        result.git_commit = clone_or_pull(git_url, source_dir)
    except Exception as e:
        result.errors.append(str(e))
        return result

    if not source_dir.is_dir():
        result.errors.append(f"source dir not present after clone: {source_dir}")
        return result

    inbox_dir.mkdir(parents=True, exist_ok=True)
    yaml = _yaml()

    # Walk the source dir for *.yaml that match the CVE filename
    # pattern. Repos can stash READMEs, indexes, fixtures, etc. in
    # the same tree without us trying to import them.
    for src in sorted(source_dir.rglob("*.yaml")):
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
                          git_url=git_url, git_commit=result.git_commit)
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
