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
    """Validate stdin YAML, stamp `_proxypilot.origin: paste`, and
    write to <inbox>/<cve>.yaml atomically. Replaces the dashboard's
    Node-side write path so origin tracking lives in one place."""
    body = sys.stdin.read()
    raw, err = _parse_yaml_body(body)
    if err:
        print(json.dumps({"ok": False, "error": err}))
        return 2
    from . import INBOX_DIR
    from .source_git import stamp_paste_origin
    inbox = Path(args.inbox or INBOX_DIR)
    inbox.mkdir(parents=True, exist_ok=True)
    target = inbox / f"{raw['cve']}.yaml"
    stamp_paste_origin(raw)
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
    print(json.dumps({"ok": True, "cve": raw["cve"], "path": str(target)}))
    return 0


def cmd_sync_git(args: argparse.Namespace) -> int:
    """Read-only pull from a git source. Imports any new <CVE>.yaml
    files into the inbox; never overwrites or deletes existing
    entries. Stamps each import with origin=git + commit SHA."""
    from . import INBOX_DIR
    from .source_git import DEFAULT_SOURCE_DIR, sync
    if not args.git_url:
        print(json.dumps({"ok": False, "error": "git_url is required"}))
        return 2
    inbox = Path(args.inbox or INBOX_DIR)
    src = Path(args.source_dir or DEFAULT_SOURCE_DIR)
    result = sync(args.git_url, inbox_dir=inbox, source_dir=src)
    out = {
        "ok": not result.errors,
        "git_url": result.git_url,
        "git_commit": result.git_commit,
        "imported": result.imported,
        "skipped_existing_count": len(result.skipped_existing),
        "skipped_invalid": result.skipped_invalid,
        "errors": result.errors,
    }
    print(json.dumps(out))
    return 0 if out["ok"] else 2


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

    sub.add_parser("paste", help="validate + write a pasted YAML to <inbox>/<cve>.yaml")

    psg = sub.add_parser("sync-git", help="read-only pull of inbox specs from a git URL")
    psg.add_argument("--git-url", required=True)
    psg.add_argument("--source-dir", help="staging dir (default /var/lib/proxypilot/cve-inbox-source)")

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
    if args.cmd == "sync-git":
        return cmd_sync_git(args)
    p.error(f"unknown command {args.cmd!r}")
    return 2


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
