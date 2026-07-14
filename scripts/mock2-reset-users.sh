#!/usr/bin/env bash
# mock2-reset-users.sh — clear a mock2 project's app user rows for a re-test.
#
# WHY THIS IS A SCRIPT, NOT A MIGRATION (cost-truth "Also"):
# Framework guidance that RESETS DATA ("clear users for re-test") must never live in
# the schema migration chain — a migration runs once, unconditionally, on every install,
# and would wipe real user data. Data resets are OPERATIONAL and must be:
#   1. explicit (an operator runs this), and
#   2. authorization-gated — the build runner may only invoke it behind a scoped,
#      one-time operational authorization (the halt-resolution "grant_authorization"
#      mechanism), exactly as it would any other privileged, out-of-constitution op.
# The ADP migration is NOT retro-edited to add this; that history stays as shipped.
#
# Usage:
#   scripts/mock2-reset-users.sh <container-name> [--table users] [--yes]
#
# It runs INSIDE the project's fenced container against the app's own database. It does
# NOT touch mock2.db (the control-plane DB) and it refuses to run without an explicit
# confirmation (or the scoped authorization token the runner passes as --yes).

set -euo pipefail

CONTAINER="${1:-}"
TABLE="users"
CONFIRMED="no"

shift || true
while [ "$#" -gt 0 ]; do
  case "$1" in
    --table) TABLE="${2:-users}"; shift 2 ;;
    --yes) CONFIRMED="yes"; shift ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

if [ -z "$CONTAINER" ]; then
  echo "usage: scripts/mock2-reset-users.sh <container-name> [--table users] [--yes]" >&2
  exit 2
fi

if [ "$CONFIRMED" != "yes" ]; then
  cat >&2 <<'MSG'
Refusing to reset user data without confirmation.

This DELETES all rows from the app's user table for a re-test. It is destructive and
must be run behind a scoped operational authorization. Re-run with --yes only when an
operator (or a granted one-time authorization) has approved it.
MSG
  exit 1
fi

echo "[mock2-reset-users] clearing table '${TABLE}' in container '${CONTAINER}' for re-test…"

# The app declares how to reach its DB in mock2.yaml (run:). This helper uses the
# app's own migration/seed tooling where present; the exact command is intentionally
# left to the project's run contract rather than hardcoding a DB driver here.
incus exec "$CONTAINER" -- sh -lc "
  set -e
  cd /srv/app
  if [ -f mock2.yaml ] && grep -q 'reset_users' mock2.yaml; then
    # Preferred: the app exposes an explicit, reviewed reset command.
    sh -lc \"\$(grep -A1 'reset_users:' mock2.yaml | tail -1 | sed 's/^[[:space:]]*//')\"
  else
    echo 'No reset_users command declared in mock2.yaml — nothing run. Declare one, or clear the ${TABLE} table via the app tooling.' >&2
    exit 3
  fi
"

echo "[mock2-reset-users] done."
