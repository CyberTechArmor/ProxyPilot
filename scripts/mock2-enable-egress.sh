#!/usr/bin/env bash
# mock2-enable-egress.sh — install and wire the Mock2 filtering egress proxy.
#
# Phase M4 (ADR-010). The Mock2 network fence is two layers: a default-deny
# nftables bridge (managed by the backend) and this host-side filtering proxy
# that is the ONLY egress path a project container has. squid is installed ONLY
# when Mock2 is enabled (ADR-001: absence-by-installation) — this script is the
# enable path, invoked by install.sh when the operator turns Mock2 on, and safe
# to re-run.
#
# The guardrail (ADR-010, operator: "squid is only fine if it doesn't add that
# much complexity") is honored exactly: ONE package (squid), ONE service (the
# stock unit), and the backend generates ONE ACL file
# (/etc/squid/conf.d/mock2.conf, regenerated per project). This script does not
# write per-project rules — it only guarantees squid is present, listening on
# the expected port, and reloadable. If squid is NOT installed, the backend's
# egress reconcile no-ops and the bridge default-deny still blocks all egress
# (fail-safe: no proxy => no egress, never unfiltered egress).
#
# Idempotent. Root required (installs a package, edits /etc/squid). On a host
# where the backend runs in Docker, run this on the HOST (it manages host squid),
# not inside the container.
set -euo pipefail

PROXY_PORT="${MOCK2_EGRESS_PROXY_PORT:-3128}"
CONF_DIR="${MOCK2_EGRESS_PROXY_CONF_DIR:-/etc/squid/conf.d}"
ACL_FILE="${CONF_DIR}/mock2.conf"
PORT_FILE="${CONF_DIR}/00-mock2-port.conf"

log() { printf '[mock2-egress] %s\n' "$*"; }

if [ "$(id -u)" -ne 0 ]; then
  echo "[mock2-egress] must run as root" >&2
  exit 1
fi

# 1. Install squid (one package). Support the common package managers.
if ! command -v squid >/dev/null 2>&1; then
  log "installing squid…"
  if command -v apt-get >/dev/null 2>&1; then
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -y || true
    apt-get install -y --no-install-recommends squid
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y squid
  elif command -v yum >/dev/null 2>&1; then
    yum install -y squid
  else
    echo "[mock2-egress] no supported package manager (apt/dnf/yum) — install squid manually" >&2
    exit 1
  fi
else
  log "squid already installed"
fi

# 2. Ensure the conf.d dir exists and squid's main config includes it. Debian's
#    stock squid.conf already has `include /etc/squid/conf.d/*.conf`; add it only
#    if missing (some distros don't ship the include).
mkdir -p "$CONF_DIR"
SQUID_CONF="/etc/squid/squid.conf"
if [ -f "$SQUID_CONF" ] && ! grep -qE '^\s*include\s+/etc/squid/conf\.d/' "$SQUID_CONF"; then
  log "adding conf.d include to squid.conf"
  printf '\n# Added by ProxyPilot Mock2 (M4)\ninclude /etc/squid/conf.d/*.conf\n' >> "$SQUID_CONF"
fi

# 3. Pin squid's listen socket to the IPv4 wildcard for PROXY_PORT. squid's stock
#    `http_port 3128` can end up bound to localhost only, or IPv6-only when the
#    host has net.ipv6.bindv6only=1 — and the project bridges (10.200.x.0/24) are
#    IPv4-only, so they then CANNOT reach the proxy on their gateway and every
#    container fails "Unable to connect to <gateway>:3128". Rewrite the http_port
#    in squid.conf to an explicit 0.0.0.0 bind. This is safe: the host firewall
#    (table inet proxypilot, input policy drop) only admits the m2br* bridges to
#    this port, so 0.0.0.0 does NOT expose an open proxy on the public interface.
#
#    SANITIZE any existing http_port line for our port to the clean form. This
#    matches ANY value token that contains PROXY_PORT — a bare port, a
#    localhost/v6/0.0.0.0 bind, AND a token with trailing junk stuck to it (e.g.
#    a hand-edit that left `http_port 0.0.0.0:3128#TODO:review`, which squid
#    parses as the port "3128#TODO:review" and FATALs on: "Bungled … http_port …
#    is supposed to be a number"). We rewrite the whole token, dropping the junk,
#    then de-duplicate so exactly one clean directive remains. Idempotent — a line
#    already `http_port 0.0.0.0:PORT` rewrites to itself.
rm -f "$PORT_FILE" 2>/dev/null || true   # retire the old port-only drop-in
if [ -f "$SQUID_CONF" ]; then
  if grep -qE "^[[:space:]]*http_port[[:space:]]+([^[:space:]]*:)?${PROXY_PORT}([^[:space:]]|[[:space:]]|\$)" "$SQUID_CONF"; then
    log "normalizing squid http_port to 0.0.0.0:${PROXY_PORT}"
    # Rewrite: value token = optional "addr:" + PROXY_PORT + optional trailing junk.
    sed -i -E "s|^([[:space:]]*)http_port[[:space:]]+([^[:space:]]*:)?${PROXY_PORT}([^[:space:]]*)?([[:space:]].*)?\$|\1http_port 0.0.0.0:${PROXY_PORT}|" "$SQUID_CONF"
    # De-dupe: keep the first clean line, drop any further identical http_port lines.
    awk -v seen=0 "/^[[:space:]]*http_port[[:space:]]+0\\.0\\.0\\.0:${PROXY_PORT}([[:space:]]|\$)/{ if (seen) next; seen=1 } { print }" "$SQUID_CONF" > "${SQUID_CONF}.pp.tmp" \
      && mv "${SQUID_CONF}.pp.tmp" "$SQUID_CONF"
  else
    log "adding http_port 0.0.0.0:${PROXY_PORT} to squid.conf"
    printf '\n# Added by ProxyPilot Mock2 (M4)\nhttp_port 0.0.0.0:%s\n' "$PROXY_PORT" >> "$SQUID_CONF"
  fi
fi

# 4. Seed an empty ACL file if the backend hasn't generated one yet, so a
#    `squid -k parse` before the first project succeeds. The backend overwrites
#    it on its next egress reconcile.
if [ ! -f "$ACL_FILE" ]; then
  cat > "$ACL_FILE" <<'EOF'
# Generated by ProxyPilot Mock2 (Phase M4, ADR-010). Do not edit by hand.
# (no project bridges yet — the backend regenerates this on egress reconcile)
EOF
fi

# 5. Validate the config BEFORE touching the running daemon. A broken squid.conf
#    (e.g. the bungled http_port we just sanitized, or an unrelated hand-edit)
#    makes `systemctl restart` fail with a FATAL that only shows in the journal —
#    surface it here instead. `squid -k parse` exits non-zero and prints the exact
#    offending line on any error.
if ! parse_out="$(squid -k parse 2>&1)"; then
  echo "[mock2-egress] squid rejected its configuration — NOT (re)starting:" >&2
  printf '%s\n' "$parse_out" | tail -n 20 >&2
  echo "[mock2-egress] fix /etc/squid/squid.conf (see the 'Bungled …' line above) and re-run this script." >&2
  exit 1
fi

# 6. Enable + (re)start squid. `reconfigure` if already running, else start.
if command -v systemctl >/dev/null 2>&1; then
  systemctl enable squid >/dev/null 2>&1 || true
  if systemctl is-active --quiet squid; then
    squid -k reconfigure || systemctl reload-or-restart squid || systemctl restart squid
  else
    systemctl restart squid
  fi
else
  service squid restart || squid -z || true
fi

# 7. Confirm squid is actually listening on the port — a started-but-not-listening
#    daemon is the failure the backend preflight guards against. Best-effort.
if command -v ss >/dev/null 2>&1; then
  if ss -ltnH "sport = :${PROXY_PORT}" 2>/dev/null | grep -q .; then
    log "squid is listening on :${PROXY_PORT}"
  else
    echo "[mock2-egress] WARNING: squid is not listening on :${PROXY_PORT} yet — check 'systemctl status squid'" >&2
  fi
fi

log "egress proxy ready on port ${PROXY_PORT} (ACL file ${ACL_FILE})"
