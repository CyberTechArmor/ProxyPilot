#!/usr/bin/env bash
# mock2-egress-cleanup.sh — retire the legacy Mock2 filtering egress proxy (squid).
#
# Mock2 no longer uses a host-side squid proxy for container egress. Each project
# bridge now reaches the internet directly through its own Incus NAT, and the
# backend's nftables fence logs every new outbound connection (so operators still
# see where traffic goes) while blocking lateral movement to private ranges.
#
# squid was unreliable (a single bad squid.conf line failed every provision) and
# is no longer a dependency. This script tidies up an older install: it removes
# the ProxyPilot-generated squid drop-in and stops + disables the squid unit so a
# broken/leftover squid can't sit in a failed state. It does NOT uninstall the
# squid package (an operator may use it for other things) and it never touches a
# host that has no squid — it's a safe, idempotent no-op there.
#
# Root required (edits /etc/squid, manages the unit). On a host where the backend
# runs in Docker, run this on the HOST, not inside the container.
set -euo pipefail

CONF_DIR="${MOCK2_EGRESS_PROXY_CONF_DIR:-/etc/squid/conf.d}"
ACL_FILE="${CONF_DIR}/mock2.conf"
PORT_FILE="${CONF_DIR}/00-mock2-port.conf"

log() { printf '[mock2-egress-cleanup] %s\n' "$*"; }

if [ "$(id -u)" -ne 0 ]; then
  echo "[mock2-egress-cleanup] must run as root" >&2
  exit 1
fi

# Remove the ProxyPilot-generated squid drop-ins (per-project ACLs + the old
# port pin). Leave the operator's own squid.conf alone.
removed=0
for f in "$ACL_FILE" "$PORT_FILE"; do
  if [ -f "$f" ]; then rm -f "$f" && removed=1; fi
done
[ "$removed" -eq 1 ] && log "removed the Mock2 squid drop-in(s)" || true

# Stop + disable squid if it's present, so a leftover/broken unit doesn't linger.
if command -v squid >/dev/null 2>&1; then
  if command -v systemctl >/dev/null 2>&1; then
    systemctl disable --now squid >/dev/null 2>&1 || true
  else
    service squid stop >/dev/null 2>&1 || true
  fi
  log "squid stopped + disabled (mock2 no longer uses it; remove the package if nothing else needs it)"
else
  log "no squid on this host — nothing to clean up"
fi

log "done — Mock2 egress is now the bridge NAT + nftables logging (no proxy)"
