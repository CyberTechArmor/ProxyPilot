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

Each subcommand writes a one-line JSON result to stdout so a parent
shell or the Node backend can capture the run summary without having
to scrape free-text logs.
"""

from __future__ import annotations

import argparse
import json
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
    p.error(f"unknown command {args.cmd!r}")
    return 2


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
