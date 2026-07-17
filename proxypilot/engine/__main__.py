"""Engine CLI.

Subcommands:
  inventory          Refresh /var/lib/proxypilot/inventory.json.
                     Run hourly via systemd timer.
  poll               Walk the inbox, dispatch each entry by this host's
                     action_class. AUTO_PATCH runs the state machine;
                     ALERT and ONE_CLICK are skipped (operator-driven).
                     Run every 5 minutes via systemd timer.
  run-one <CVE-ID>   Manual trigger for a single entry. Used by the
                     ONE_CLICK "Run on this host" button via the backend.
  show <CVE-ID>      Print the parsed entry summary as JSON. Read-only.
  mark-seen <CVE-ID> Set state.operator_seen=true. Used when the
                     dashboard opens an entry's detail view.
  dismiss <CVE-ID>   Set state.status=DISMISSED with a required reason.
  validate           Read YAML from stdin, return {ok, cve, error}. Used
                     by the dashboard to validate a paste before saving
                     it to the inbox.
  paste              Validate stdin YAML and write it to the inbox with
                     a `_proxypilot.origin` provenance stamp (`paste` by
                     default; the AI research routine passes --origin ai).
  purge-git-origin   One-shot cleanup for the retired git feed: delete
                     inbox entries stamped origin=git and remove the
                     staging clone dir. Manual/AI entries are untouched.

Each subcommand writes a one-line JSON result to stdout so a parent
shell or the Node backend can capture the run summary without having
to scrape free-text logs.
"""

from __future__ import annotations

import argparse
import io
import json
import re
import sys
from pathlib import Path
from typing import Optional

from . import INBOX_DIR
from . import inbox as inbox_mod
from .inbox import (
    ACTION_ALERT,
    ACTION_AUTO_PATCH,
    Entry,
    list_entries,
    load_entry,
    this_hostname,
)
from .inventory import write as write_inventory
from .runner import RunResult, execute


def _result_to_dict(r: RunResult) -> dict:
    return {
        "cve": r.cve,
        "host": r.host,
        "action_class": r.action_class,
        "final_status": r.final_status,
        "operator_action_required": r.operator_action_required,
        "skipped_reason": r.skipped_reason,
        "snapshot": ({"id": r.snapshot_id, "backend": r.snapshot_backend}
                     if r.snapshot_id else None),
        "steps_run": len(r.steps),
        "rollback_steps_run": len(r.rollback_steps),
        "probe_initial_exit": r.probe_initial.exit_code if r.probe_initial else None,
        "probe_verify_exit": r.probe_verify.exit_code if r.probe_verify else None,
    }


def cmd_inventory(_args: argparse.Namespace) -> int:
    p = write_inventory()
    print(json.dumps({"ok": True, "path": str(p)}))
    return 0


def cmd_poll(args: argparse.Namespace) -> int:
    host = args.host or this_hostname()
    inbox = Path(args.inbox or INBOX_DIR)
    summary = []
    for entry in list_entries(inbox):
        action = entry.action_class(host)
        if action != ACTION_AUTO_PATCH:
            # ONE_CLICK / ALERT / unknown all surface in the UI; the
            # poll never executes them. We still emit a summary line
            # so a watcher can see the entry was considered.
            summary.append({
                "cve": entry.cve, "host": host,
                "action_class": action, "executed": False,
            })
            continue
        result = execute(entry, hostname=host)
        d = _result_to_dict(result)
        d["executed"] = True
        summary.append(d)
    print(json.dumps({"ok": True, "host": host, "entries": summary}))
    return 0


def cmd_run_one(args: argparse.Namespace) -> int:
    inbox = Path(args.inbox or INBOX_DIR)
    path = inbox / f"{args.cve}.yaml"
    if not path.is_file():
        print(json.dumps({"ok": False, "error": f"no entry at {path}"}))
        return 2
    entry = load_entry(path)
    forced = args.force_action  # may be None
    result = execute(entry, hostname=args.host, forced_action=forced)
    print(json.dumps({"ok": True, "result": _result_to_dict(result)}))
    return 0


def cmd_mark_seen(args: argparse.Namespace) -> int:
    inbox = Path(args.inbox or INBOX_DIR)
    path = inbox / f"{args.cve}.yaml"
    if not path.is_file():
        print(json.dumps({"ok": False, "error": f"no entry at {path}"}))
        return 2
    from .inbox import save, append_history
    entry = load_entry(path)
    if entry.operator_seen:
        print(json.dumps({"ok": True, "already_seen": True}))
        return 0
    entry.state["operator_seen"] = True
    # operator_seen is a UI badge clear, not a status change — we
    # bump last_updated but don't append to history (it's noisy and
    # the engine state contract is status/last_updated/history-only).
    entry.state["last_updated"] = inbox_mod.now_iso()
    save(entry)
    print(json.dumps({"ok": True, "already_seen": False}))
    return 0


def cmd_dismiss(args: argparse.Namespace) -> int:
    inbox = Path(args.inbox or INBOX_DIR)
    path = inbox / f"{args.cve}.yaml"
    if not path.is_file():
        print(json.dumps({"ok": False, "error": f"no entry at {path}"}))
        return 2
    if not args.reason or not args.reason.strip():
        print(json.dumps({"ok": False, "error": "reason is required"}))
        return 2
    from .inbox import append_history, save, set_status, STATUS_DISMISSED
    entry = load_entry(path)
    set_status(entry, STATUS_DISMISSED)
    append_history(entry, host=args.host or this_hostname(), actor=args.actor or "operator",
                   change=f"dismissed: {args.reason.strip()}")
    save(entry)
    print(json.dumps({"ok": True}))
    return 0


# Filename / cve-id format. The same shape the backend enforces on
# the URL — kept in lock-step so a paste that round-trips through
# /api/cves can never produce a name the listing endpoint then
# refuses to read.
_CVE_RE = re.compile(r"^CVE-\d{4}-\d{4,7}$")


def _parse_yaml_body(body: str):
    """Shared parser for validate / paste. Returns (raw, error). On
    success raw is a CommentedMap and error is None; on failure raw
    is None and error is the user-facing message."""
    if not body.strip():
        return None, "empty body"
    try:
        from .inbox import _yaml
        raw = _yaml().load(io.StringIO(body))
    except Exception as e:
        return None, f"YAML parse error: {e}"
    from ruamel.yaml.comments import CommentedMap
    if not isinstance(raw, (dict, CommentedMap)):
        return None, "top-level YAML must be a mapping"
    cve = raw.get("cve")
    if not isinstance(cve, str) or not cve.strip():
        return None, "missing required `cve:` field"
    cve = cve.strip()
    if not _CVE_RE.match(cve):
        return None, f"invalid CVE id: {cve!r}; expected CVE-YYYY-NNNN[N..]"
    raw["cve"] = cve  # normalise
    if "hosts" in raw and not isinstance(raw.get("hosts"), (dict, list)):
        return None, "`hosts` must be a mapping or list"
    if "playbook" in raw and not isinstance(raw.get("playbook"),
                                            (dict, CommentedMap)):
        return None, "`playbook` must be a mapping"
    return raw, None


def cmd_validate(_args: argparse.Namespace) -> int:
    """Validate a YAML body from stdin without touching the inbox.
    Returns {ok: true, cve: "<id>"} on success, {ok: false, error: "..."}
    otherwise. The dashboard's "Save" path calls this before writing.
    """
    body = sys.stdin.read()
    raw, err = _parse_yaml_body(body)
    if err:
        print(json.dumps({"ok": False, "error": err}))
        return 2
    print(json.dumps({"ok": True, "cve": raw["cve"]}))
    return 0


def cmd_paste(args: argparse.Namespace) -> int:
    """Validate stdin YAML, stamp `_proxypilot.origin` (`paste` by
    default, `ai` when the backend's research routine writes), and
    write to <inbox>/<cve>.yaml atomically. Replaces the dashboard's
    Node-side write path so origin tracking lives in one place.

    When overwriting an existing entry, the existing file's `state`
    and `_proxypilot` blocks are carried over if the incoming body
    omits them — the AI research routine (and any other spec-focused
    writer) deliberately leaves `state` out on updates, and losing
    the status/history/provenance on every revision would break the
    engine's state contract.

    Also runs an automatic check_only after the write (unless
    --no-auto-check) so the entry lands with a verdict already in
    history — the operator doesn't have to click Check on every
    fresh paste."""
    body = sys.stdin.read()
    raw, err = _parse_yaml_body(body)
    if err:
        print(json.dumps({"ok": False, "error": err}))
        return 2
    from . import INBOX_DIR
    from .inbox import _yaml
    from .origin import ORIGIN_KEY, stamp_origin
    inbox = Path(args.inbox or INBOX_DIR)
    inbox.mkdir(parents=True, exist_ok=True)
    target = inbox / f"{raw['cve']}.yaml"
    if target.is_file():
        try:
            with target.open("r", encoding="utf-8") as f:
                existing = _yaml().load(f)
            if hasattr(existing, "get"):
                for key in ("state", ORIGIN_KEY):
                    if key not in raw and existing.get(key) is not None:
                        raw[key] = existing[key]
        except Exception:
            # Unreadable existing file — treat as a fresh write.
            pass
    stamp_origin(raw, args.origin or "paste")
    try:
        from .inbox import _yaml
        tmp = target.with_suffix(target.suffix + ".tmp")
        with tmp.open("w", encoding="utf-8") as f:
            _yaml().dump(raw, f)
        import os as _os
        _os.replace(tmp, target)
    except Exception as e:
        print(json.dumps({"ok": False, "error": f"write failed: {e}"}))
        return 2

    out = {"ok": True, "cve": raw["cve"], "path": str(target)}
    if not args.no_auto_check:
        out["auto_check"] = _auto_check(target, args.host)
    print(json.dumps(out))
    return 0


def _auto_check(path: Path, host: Optional[str]) -> dict:
    """Run check_only against a freshly-imported entry and return a
    summary {verdict, exit_code} for the JSON output. Failures are
    swallowed to a {ok: false, error} sub-dict so a broken probe
    doesn't fail the import that already succeeded on disk."""
    try:
        from .inbox import load_entry
        from .runner import check_only
        e = load_entry(path)
        r = check_only(e, hostname=host, record_history=True,
                       actor="post-import-auto-check")
        return {"verdict": r.verdict, "exit_code": r.exit_code}
    except Exception as ex:
        return {"ok": False, "error": str(ex)}


def cmd_check(args: argparse.Namespace) -> int:
    """Run only playbook.detect.probe on a single entry. No snapshot,
    no patch, no state.status mutation. Optionally appends a history
    line so the timeline records that someone checked + what verdict
    they got."""
    from .runner import check_only
    inbox = Path(args.inbox or INBOX_DIR)
    path = inbox / f"{args.cve}.yaml"
    if not path.is_file():
        print(json.dumps({"ok": False, "error": f"no entry at {path}"}))
        return 2
    entry = load_entry(path)
    result = check_only(
        entry, hostname=args.host,
        record_history=not args.no_history,
        actor=args.actor or "proxypilot-engine",
    )
    out = {
        "ok": True,
        "cve": result.cve,
        "host": result.host,
        "verdict": result.verdict,
        "exit_code": result.exit_code,
        "stdout": result.stdout[-4096:] if result.stdout else "",
        "stderr": result.stderr[-4096:] if result.stderr else "",
        "duration_s": result.duration_s,
    }
    print(json.dumps(out))
    return 0


# Staging dir the retired git source cloned into. Only referenced by
# purge-git-origin, which removes it if the old feature left one behind.
LEGACY_GIT_SOURCE_DIR = "/var/lib/proxypilot/cve-inbox-source"


def cmd_purge_git_origin(args: argparse.Namespace) -> int:
    """One-shot cleanup for the retired git CVE feed. Deletes every
    inbox entry whose `_proxypilot.origin` is `git` (entries pulled
    from the old read-only git source) and removes the staging clone
    dir. Entries with origin paste/ai — and entries with no origin
    block at all — are never touched."""
    import shutil
    from .inbox import _yaml
    from .origin import ORIGIN_KEY
    inbox = Path(args.inbox or INBOX_DIR)
    removed: list[str] = []
    errors: list[str] = []
    if inbox.is_dir():
        yaml = _yaml()
        for path in sorted(inbox.glob("CVE-*.yaml")):
            try:
                with path.open("r", encoding="utf-8") as f:
                    raw = yaml.load(f)
                block = raw.get(ORIGIN_KEY) if hasattr(raw, "get") else None
                origin = block.get("origin") if hasattr(block, "get") else None
                if origin == "git":
                    path.unlink()
                    removed.append(path.name)
            except Exception as e:
                errors.append(f"{path.name}: {e}")
    staging = Path(args.source_dir or LEGACY_GIT_SOURCE_DIR)
    staging_removed = False
    if staging.is_dir():
        try:
            shutil.rmtree(staging)
            staging_removed = True
        except Exception as e:
            errors.append(f"staging dir {staging}: {e}")
    print(json.dumps({
        "ok": not errors,
        "removed": removed,
        "staging_removed": staging_removed,
        "errors": errors,
    }))
    return 0 if not errors else 2


def cmd_show(args: argparse.Namespace) -> int:
    inbox = Path(args.inbox or INBOX_DIR)
    path = inbox / f"{args.cve}.yaml"
    if not path.is_file():
        print(json.dumps({"ok": False, "error": f"no entry at {path}"}))
        return 2
    entry = load_entry(path)
    host = args.host or this_hostname()
    print(json.dumps({
        "ok": True,
        "cve": entry.cve,
        "name": entry.name,
        "host": host,
        "action_class": entry.action_class(host),
        "tier": entry.tier(host),
        "status": entry.status,
        "operator_seen": entry.operator_seen,
        "has_probe": entry.detect_probe() is not None,
        "patch_steps": len(entry.patch_steps()),
        "snapshot_supported": entry.snapshot_supported(),
    }))
    return 0


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="proxypilot.engine")
    p.add_argument("--host", help="hostname override (defaults to socket.gethostname)")
    p.add_argument("--inbox", help="inbox directory override")
    sub = p.add_subparsers(dest="cmd", required=True)

    sub.add_parser("inventory", help="refresh inventory.json")
    sub.add_parser("poll", help="dispatch inbox entries")

    pr = sub.add_parser("run-one", help="execute a single entry")
    pr.add_argument("cve")
    pr.add_argument("--force-action",
                    choices=["AUTO_PATCH", "ONE_CLICK"],
                    help="override the spec's action_class for this run")

    ps = sub.add_parser("show", help="print parsed entry summary")
    ps.add_argument("cve")

    pms = sub.add_parser("mark-seen", help="set state.operator_seen=true")
    pms.add_argument("cve")

    pd = sub.add_parser("dismiss", help="set status=DISMISSED with a reason")
    pd.add_argument("cve")
    pd.add_argument("--reason", required=True)
    pd.add_argument("--actor", help="history actor (defaults to 'operator')")

    sub.add_parser("validate", help="validate YAML on stdin; print JSON result")

    pp = sub.add_parser("paste", help="validate + write a pasted YAML to <inbox>/<cve>.yaml")
    pp.add_argument("--no-auto-check", action="store_true",
                    help="skip the post-import probe (entry lands without a verdict)")
    pp.add_argument("--origin", choices=["paste", "ai"], default="paste",
                    help="provenance stamp for a new entry (the AI research routine passes ai)")

    pc = sub.add_parser("check", help="run probe only; no patch, no snapshot, no status change")
    pc.add_argument("cve")
    pc.add_argument("--no-history", action="store_true",
                    help="do not append a history entry (silent check)")
    pc.add_argument("--actor", help="history actor (defaults to 'proxypilot-engine')")

    ppg = sub.add_parser("purge-git-origin",
                         help="delete inbox entries imported by the retired git feed (origin=git)")
    ppg.add_argument("--source-dir",
                     help="legacy staging clone dir to remove (default /var/lib/proxypilot/cve-inbox-source)")

    args = p.parse_args(argv)
    if args.cmd == "inventory":
        return cmd_inventory(args)
    if args.cmd == "poll":
        return cmd_poll(args)
    if args.cmd == "run-one":
        return cmd_run_one(args)
    if args.cmd == "show":
        return cmd_show(args)
    if args.cmd == "mark-seen":
        return cmd_mark_seen(args)
    if args.cmd == "dismiss":
        return cmd_dismiss(args)
    if args.cmd == "validate":
        return cmd_validate(args)
    if args.cmd == "paste":
        return cmd_paste(args)
    if args.cmd == "check":
        return cmd_check(args)
    if args.cmd == "purge-git-origin":
        return cmd_purge_git_origin(args)
    p.error(f"unknown command {args.cmd!r}")
    return 2


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
