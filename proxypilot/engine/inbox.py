"""YAML read/write for CVE inbox entries with opaque-field preservation.

Schema is owned by Claude and evolves freely. The engine is deliberately
permissive: it reads what it needs (action_class for routing, playbook
for execution, state for write-back) and preserves every other field
on disk untouched. Unknown action_class / status values route safely
(ALERT for action_class, IN_PROGRESS for status).

Write-back contract — the engine only mutates:
  - state.status
  - state.last_updated
  - state.history (append)

Everything else is Claude's territory and round-trips verbatim. ruamel.yaml's
RoundTripLoader preserves key order and comments, which matters because
operators and Claude both read these files by hand.
"""

from __future__ import annotations

import datetime as _dt
import os
import socket
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional

from ruamel.yaml import YAML
from ruamel.yaml.comments import CommentedMap, CommentedSeq

from . import ENGINE_ACTOR, INBOX_DIR

# Action-class enum. Anything we don't recognise is treated as ALERT —
# safer to surface in the UI than to attempt execution against a spec
# we don't understand.
ACTION_AUTO_PATCH = "AUTO_PATCH"
ACTION_ONE_CLICK = "ONE_CLICK"
ACTION_ALERT = "ALERT"
KNOWN_ACTION_CLASSES = {ACTION_AUTO_PATCH, ACTION_ONE_CLICK, ACTION_ALERT}

# Status enum. Unknown values fall through to IN_PROGRESS so an
# in-flight (or future) state never gets clobbered to NEW or RESOLVED.
STATUS_NEW = "NEW"
STATUS_QUEUED = "QUEUED"
STATUS_IN_PROGRESS = "IN_PROGRESS"
STATUS_RESOLVED = "RESOLVED"
STATUS_DISMISSED = "DISMISSED"
STATUS_BLOCKED = "BLOCKED"
STATUS_ALERT_AUTO_ROLLBACK = "ALERT-AUTO-ROLLBACK"
KNOWN_STATUSES = {
    STATUS_NEW, STATUS_QUEUED, STATUS_IN_PROGRESS, STATUS_RESOLVED,
    STATUS_DISMISSED, STATUS_BLOCKED, STATUS_ALERT_AUTO_ROLLBACK,
}


def _yaml() -> YAML:
    y = YAML(typ="rt")
    y.preserve_quotes = True
    y.width = 4096
    return y


def now_iso() -> str:
    return _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def this_hostname() -> str:
    h = os.environ.get("PROXYPILOT_HOSTNAME") or socket.gethostname()
    return (h or "unknown").strip()


@dataclass
class Entry:
    """A loaded inbox entry. The raw round-trip object is the source
    of truth for write-back; the convenience accessors below are
    derived views that route safely on unknown shapes."""
    path: Path
    raw: CommentedMap

    @property
    def cve(self) -> str:
        return str(self.raw.get("cve") or self.path.stem)

    @property
    def name(self) -> str:
        return str(self.raw.get("name") or "")

    def host_block(self, hostname: str) -> Optional[Dict[str, Any]]:
        """Return this host's hosts block, normalising both spec
        forms: dict-keyed-by-hostname (current schema) and the older
        list-of-objects form. Returns None if the host is not listed."""
        hosts = self.raw.get("hosts")
        if isinstance(hosts, dict):
            block = hosts.get(hostname)
            return dict(block) if isinstance(block, dict) else None
        if isinstance(hosts, list):
            for h in hosts:
                if isinstance(h, dict) and str(h.get("host") or "") == hostname:
                    return dict(h)
        return None

    def action_class(self, hostname: str) -> str:
        block = self.host_block(hostname) or {}
        ac = str(block.get("action_class") or "").strip()
        return ac if ac in KNOWN_ACTION_CLASSES else ACTION_ALERT

    def tier(self, hostname: str) -> Any:
        block = self.host_block(hostname) or {}
        return block.get("tier")

    @property
    def state(self) -> CommentedMap:
        s = self.raw.get("state")
        if not isinstance(s, CommentedMap):
            s = CommentedMap()
            self.raw["state"] = s
        return s

    @property
    def status(self) -> str:
        s = str(self.state.get("status") or "").strip()
        if not s:
            return STATUS_NEW
        # Allow case-insensitive matches for legacy lower-case entries
        # in the bootstrap inbox; canonical writes are upper-case.
        upper = s.upper().replace("_", "-") if s.upper() not in KNOWN_STATUSES else s.upper()
        return upper if upper in KNOWN_STATUSES else STATUS_IN_PROGRESS

    @property
    def operator_seen(self) -> bool:
        return bool(self.state.get("operator_seen") or False)

    @property
    def playbook(self) -> Dict[str, Any]:
        p = self.raw.get("playbook")
        return dict(p) if isinstance(p, dict) else {}

    def detect_probe(self) -> Optional[str]:
        d = self.playbook.get("detect")
        if isinstance(d, dict):
            probe = d.get("probe")
            if isinstance(probe, str) and probe.strip():
                return probe
        return None

    def patch_steps(self) -> List[str]:
        p = self.playbook.get("patch")
        if isinstance(p, dict):
            steps = p.get("steps")
            if isinstance(steps, list):
                return [str(s) for s in steps]
        return []

    def rollback_restore(self) -> Optional[str]:
        p = self.playbook.get("patch")
        if isinstance(p, dict):
            rb = p.get("rollback")
            if isinstance(rb, dict):
                r = rb.get("restore")
                if isinstance(r, str) and r.strip():
                    return r
        return None

    def snapshot_supported(self) -> bool:
        p = self.playbook.get("patch")
        if isinstance(p, dict):
            rb = p.get("rollback")
            if isinstance(rb, dict):
                return bool(rb.get("snapshot_supported") or False)
        return False

    def mentions_container_image(self) -> bool:
        """Heuristic: container image swaps are ALWAYS ONE_CLICK
        per spec §4. If a playbook step looks like a `docker pull`,
        `docker compose up -d`, or an Incus image refresh, we refuse
        AUTO_PATCH dispatch and treat it as ONE_CLICK so the operator
        confirms the swap."""
        for step in self.patch_steps():
            s = step.lower()
            if "docker" in s and ("pull" in s or "compose" in s or "run " in s):
                return True
            if "incus" in s and ("image" in s or "launch" in s):
                return True
            if "podman" in s and "pull" in s:
                return True
        return False


def load_entry(path: Path | str) -> Entry:
    p = Path(path)
    with p.open("r", encoding="utf-8") as f:
        raw = _yaml().load(f)
    if not isinstance(raw, CommentedMap):
        raise ValueError(f"{p}: top-level YAML is not a mapping")
    return Entry(path=p, raw=raw)


def list_entries(inbox_dir: Path | str = INBOX_DIR) -> Iterable[Entry]:
    d = Path(inbox_dir)
    if not d.is_dir():
        return []
    out: List[Entry] = []
    for child in sorted(d.iterdir()):
        if not child.is_file() or not child.name.endswith(".yaml"):
            continue
        if child.name.startswith("_"):
            # _last_run.yaml et al are bookkeeping, not entries.
            continue
        try:
            out.append(load_entry(child))
        except Exception:
            # Malformed YAML is Claude's bug — log via stderr in the
            # caller; here we just skip so one bad file doesn't take
            # down the whole poll.
            continue
    return out


def append_history(
    entry: Entry,
    *,
    change: str,
    host: Optional[str] = None,
    actor: str = ENGINE_ACTOR,
    stdout_excerpt: Optional[str] = None,
    stderr_excerpt: Optional[str] = None,
) -> CommentedMap:
    """Build and append a history record. Returns the record."""
    rec = CommentedMap()
    rec["ts"] = now_iso()
    rec["actor"] = actor
    rec["change"] = change
    if host:
        rec["host"] = host
    if stdout_excerpt:
        rec["stdout_excerpt"] = _truncate(stdout_excerpt)
    if stderr_excerpt:
        rec["stderr_excerpt"] = _truncate(stderr_excerpt)

    state = entry.state
    hist = state.get("history")
    if not isinstance(hist, list):
        hist = CommentedSeq()
        state["history"] = hist
    hist.append(rec)
    return rec


def set_status(entry: Entry, status: str) -> None:
    """Set state.status and bump state.last_updated. The status string
    is written verbatim so Claude can introduce new values without an
    engine release; routing of unknown values is the reader's concern."""
    state = entry.state
    state["status"] = status
    state["last_updated"] = now_iso()


def save(entry: Entry) -> None:
    """Atomic write: tmpfile + rename so a crash mid-write can't leave
    half a YAML on disk for the next poll to choke on."""
    p = entry.path
    p.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".cve-tmp-", dir=str(p.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            _yaml().dump(entry.raw, f)
        os.replace(tmp, p)
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def _truncate(s: str, limit: int = 4096) -> str:
    if len(s) <= limit:
        return s
    return s[: limit - 80] + f"\n…[truncated, {len(s) - limit} more bytes]"
