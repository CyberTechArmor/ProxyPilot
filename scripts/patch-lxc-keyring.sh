#!/bin/bash
# Raise the kernel keyring limits that Docker-inside-LXC needs.
#
# Why this exists (observed on the production host, 2026-08-25):
#
#   OCI runtime create failed: runc create failed: unable to start container
#   process: error during container init: unable to join session keyring:
#   unable to create session key: disk quota exceeded
#
# runc calls keyctl_join_session_keyring() for every container it creates.
# The kernel caps keys per UID at kernel.keys.maxkeys — 200 by default.
# Unprivileged Incus guests map container-root to a NON-root host UID, so
# they get that 200 rather than root's kernel.keys.root_maxkeys (1,000,000),
# and because ProxyPilot's guests share one idmap they all draw on the SAME
# 200-key budget. Once existing guests have spent it, a brand-new guest fails
# on its very first `docker compose up` — and EDQUOT's errno string is
# "Disk quota exceeded", which sends everyone looking at disk space instead.
#
# The fix is a host-level sysctl drop-in. Idempotent and safe to re-run on
# every install/update:
#   * Drop-in already present with the same values → no-op.
#   * Different values (an operator raised them further) → left alone.
#   * No /etc/sysctl.d (non-systemd host) → no-op + warning.
#
# Usage:
#   patch-lxc-keyring.sh [--maxkeys <n>] [--maxbytes <n>] [--no-apply]
#
# Defaults:
#   --maxkeys    $PROXYPILOT_KEYS_MAXKEYS  or 20000
#   --maxbytes   $PROXYPILOT_KEYS_MAXBYTES or 2000000
#   --no-apply   write the drop-in but skip `sysctl --system`

set -euo pipefail

MAXKEYS="${PROXYPILOT_KEYS_MAXKEYS:-20000}"
MAXBYTES="${PROXYPILOT_KEYS_MAXBYTES:-2000000}"
APPLY=1
DROPIN="/etc/sysctl.d/99-lxc-keyring.conf"

while [[ $# -gt 0 ]]; do
    case "$1" in
        --maxkeys)  MAXKEYS="$2";  shift 2 ;;
        --maxbytes) MAXBYTES="$2"; shift 2 ;;
        --no-apply) APPLY=0; shift ;;
        -h|--help)
            sed -n '2,31p' "$0" | sed 's/^# \{0,1\}//'
            exit 0 ;;
        *) echo "Unknown argument: $1" >&2; exit 2 ;;
    esac
done

if [ ! -d /etc/sysctl.d ]; then
    echo "patch-lxc-keyring: /etc/sysctl.d does not exist — skipping (set kernel.keys.maxkeys by hand on this host)." >&2
    exit 0
fi

# An operator who already raised the limits higher than our floor keeps them.
current_maxkeys="$(sysctl -n kernel.keys.maxkeys 2>/dev/null || echo 0)"
if [ -f "$DROPIN" ] && [ "${current_maxkeys:-0}" -ge "$MAXKEYS" ] 2>/dev/null; then
    echo "patch-lxc-keyring: kernel.keys.maxkeys is already ${current_maxkeys} (>= ${MAXKEYS}) — nothing to do."
    exit 0
fi

umask 022
cat > "$DROPIN" <<SYSCTL
# Managed by ProxyPilot (scripts/patch-lxc-keyring.sh).
#
# Docker inside an unprivileged Incus guest needs more than the kernel's
# default 200 keys per UID: runc joins a session keyring per container, and
# every guest shares one idmapped host UID. Exhaustion surfaces as
# "unable to join session keyring: disk quota exceeded" (EDQUOT), which has
# nothing to do with disk space.
kernel.keys.maxkeys=${MAXKEYS}
kernel.keys.maxbytes=${MAXBYTES}
SYSCTL

echo "patch-lxc-keyring: wrote ${DROPIN} (maxkeys=${MAXKEYS}, maxbytes=${MAXBYTES})."

if [ "$APPLY" -eq 1 ]; then
    if sysctl --system >/dev/null 2>&1; then
        echo "patch-lxc-keyring: applied — kernel.keys.maxkeys is now $(sysctl -n kernel.keys.maxkeys 2>/dev/null || echo '?')."
    else
        echo "patch-lxc-keyring: drop-in written but 'sysctl --system' failed — it will take effect on the next boot." >&2
    fi
fi

# Containers CREATED before the fix keep the runtime they were created with,
# so an already-broken container needs recreating (docker compose up --force-recreate)
# rather than just a daemon restart. Say so once, here, where it is cheap to read.
echo "patch-lxc-keyring: note — containers created while the budget was exhausted must be recreated, not just restarted."
