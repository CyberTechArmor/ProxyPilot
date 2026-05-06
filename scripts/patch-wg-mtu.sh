#!/bin/bash
# Idempotently add `MTU = <n>` to the [Interface] block of an
# existing wg0.conf, then bounce the live interface so the kernel
# picks up the new MTU on the next handshake.
#
# Designed to be re-run on every install/update without churn:
#   * Missing config file → no-op (operator hasn't run `vpn enable`).
#   * MTU line already present anywhere in the file → no-op.
#   * No [Interface] header → no-op + warning (caller's wg0.conf is
#     malformed; not our problem to repair).
#
# Exit codes: 0 on success or any benign no-op. Non-zero only when
# the patch was attempted and verifiably failed (sed couldn't
# rewrite the file). Bouncing the interface is best-effort — a
# down-then-up failure is logged but does not fail the script,
# because the on-disk config is already correct and a follow-up
# `wg-quick up wg0` (or host reboot) will pick it up.
#
# Usage:
#   patch-wg-mtu.sh [--config <path>] [--mtu <n>] [--no-restart]
#
# Defaults:
#   --config       /etc/wireguard/wg0.conf
#   --mtu          $PROXYPILOT_VPN_MTU or 1280
#   --no-restart   off (i.e. wg-quick down/up wg0 runs by default)

set -euo pipefail

CONFIG="/etc/wireguard/wg0.conf"
MTU="${PROXYPILOT_VPN_MTU:-1280}"
RESTART=1

while [[ $# -gt 0 ]]; do
    case "$1" in
        --config) CONFIG="$2"; shift 2 ;;
        --mtu)    MTU="$2";    shift 2 ;;
        --no-restart) RESTART=0; shift ;;
        -h|--help)
            sed -n '2,28p' "$0" | sed 's/^# \{0,1\}//'
            exit 0 ;;
        *)
            echo "patch-wg-mtu: unknown arg '$1'" >&2
            exit 2 ;;
    esac
done

log() { echo "[wg-mtu] $*"; }

# Validate MTU before we touch anything. 576 is the IPv4 minimum;
# 9000 covers jumbo frames. Out-of-range or non-integer ⇒ silently
# fall back to 1280 (matches the JS resolveMtu() behavior so an
# operator's stale env var can't bork wg0 on update).
if ! [[ "$MTU" =~ ^[0-9]+$ ]] || (( MTU < 576 || MTU > 9000 )); then
    log "MTU '$MTU' out of range (576-9000), falling back to 1280"
    MTU=1280
fi

if [[ ! -f "$CONFIG" ]]; then
    # No wg0.conf yet: operator hasn't run `proxypilot vpn enable`.
    # Nothing to patch — the next render via the CLI will emit the
    # default MTU.
    exit 0
fi

if ! grep -qE '^\[Interface\][[:space:]]*$' "$CONFIG"; then
    log "WARNING: $CONFIG has no [Interface] header — leaving untouched"
    exit 0
fi

# Idempotency: any existing `MTU =` line anywhere in the file is
# treated as authoritative. wg0.conf only carries one [Interface]
# block, so a global match is sufficient (and avoids fragile
# block-bounded awk).
if grep -qE '^[[:space:]]*MTU[[:space:]]*=' "$CONFIG"; then
    exit 0
fi

log "Adding MTU = $MTU to $CONFIG"

# Insert immediately after the [Interface] header. sed's `a` command
# appends after the matched line; the trailing space before $MTU is
# the literal space we want in the output. Use a tmp + atomic mv so
# a failed sed leaves the original config intact.
TMP="${CONFIG}.tmp.wgmtu.$$"
trap 'rm -f "$TMP"' EXIT
if ! sed -E "/^\\[Interface\\][[:space:]]*\$/a MTU = ${MTU}" "$CONFIG" > "$TMP"; then
    log "ERROR: sed failed to rewrite $CONFIG"
    exit 1
fi
chmod --reference="$CONFIG" "$TMP" 2>/dev/null || chmod 0600 "$TMP"
chown --reference="$CONFIG" "$TMP" 2>/dev/null || true
mv "$TMP" "$CONFIG"
trap - EXIT

# Bounce wg0 so the kernel rebinds with the new MTU. wg-quick down
# is tolerated when the interface isn't up (operator may not have
# enabled the VPN yet); wg-quick up failure is logged but does not
# fail the script — the next reboot or `systemctl restart
# wg-quick@wg0` will pick up the patched config.
if [[ "$RESTART" -eq 1 ]] && command -v wg-quick >/dev/null 2>&1; then
    if ip link show wg0 >/dev/null 2>&1; then
        log "Bouncing wg0 to apply new MTU"
        wg-quick down wg0 >/dev/null 2>&1 || log "wg-quick down wg0 failed (continuing)"
        if ! wg-quick up wg0 >/dev/null 2>&1; then
            log "WARNING: wg-quick up wg0 failed — config patched, run 'systemctl restart wg-quick@wg0' to apply"
        fi
    fi
fi
