"""Per-entry provenance stamping for the CVE inbox.

Every entry that lands in /var/lib/proxypilot/cve-inbox/ gets a
top-level `_proxypilot` block recording where it came from, so the
dashboard can surface provenance per row. The block is written once
on first import and round-trips untouched afterwards via inbox.py's
opaque-field preservation.

Schema (top-level, never touched by the engine after import):

    _proxypilot:
      origin: paste | ai
      imported_at: <iso8601>

  - `paste` — operator pasted / edited the YAML through the dashboard
    (or piped it into `python3 -m proxypilot.engine paste`).
  - `ai`    — filed by the backend's native AI research routine
    (lib/cve-research.js), which writes through the same engine
    `paste` subcommand with `--origin ai`.

Historical note: a third origin, `git`, was written by the retired
read-only git source (source_git.py). That feed was replaced by the
built-in AI research routine; `purge-git-origin` in __main__.py
removes any entries it left behind. Nothing writes `git` anymore.
"""

from __future__ import annotations

from .inbox import now_iso

# Per-entry import marker. Lives at top level so it round-trips
# through the engine's opaque-field preservation. The leading
# underscore signals "tooling metadata, not Claude-authored content".
ORIGIN_KEY = "_proxypilot"

# Origins the paste path may stamp. `git` is intentionally absent —
# it exists only in legacy entries pending purge.
VALID_ORIGINS = ("paste", "ai")


def stamp_origin(raw: dict, origin: str) -> None:
    """Add the _proxypilot block to a freshly imported entry, in
    place. Idempotent — never overwrites an existing block, since
    operators may have edited it post-import."""
    if origin not in VALID_ORIGINS:
        raise ValueError(f"invalid origin {origin!r}; expected one of {VALID_ORIGINS}")
    if ORIGIN_KEY in raw:
        return
    raw[ORIGIN_KEY] = {"origin": origin, "imported_at": now_iso()}


def stamp_paste_origin(raw: dict) -> None:
    """Back-compat wrapper for the plain paste path."""
    stamp_origin(raw, "paste")
