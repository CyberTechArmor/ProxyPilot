#!/bin/bash
# Install ProxyPilot VPN module prerequisites.
# Idempotent — safe to run on every install/update.
#
# Called from install.sh and update.sh AFTER install-firewall.sh.
# This script does NOT bring wg0 up — that is the operator's opt-in
# via `proxypilot vpn enable --endpoint <host:port>`. It only ensures
# the kernel module + userspace tooling + /etc/wireguard perms are in
# place so the opt-in succeeds when the operator runs it.

set -euo pipefail

log() { echo "[vpn] $*"; }

# ── 1. Ensure WireGuard userspace tooling is installed ──────────────
if ! command -v wg >/dev/null 2>&1 || ! command -v wg-quick >/dev/null 2>&1; then
    log "Installing WireGuard tools..."
    apt-get update -qq
    apt-get install -y wireguard wireguard-tools >/dev/null
fi

# ── 2. Verify the wireguard kernel module is loadable ──────────────
# Don't fail the install if probe fails (containers, custom kernels);
# just warn so the operator knows to address it before vpn enable.
if ! modprobe wireguard 2>/dev/null; then
    log "WARNING: kernel module 'wireguard' could not be loaded."
    log "         `proxypilot vpn enable` will fail until this is resolved."
    log "         On stock Debian/Ubuntu hosts, install the matching headers"
    log "         (apt install linux-headers-\$(uname -r)) and try again."
fi

# ── 3. Ensure /etc/wireguard exists with restrictive perms ─────────
# wg-quick reads wg0.conf from this directory; the private key lives
# in there too (see cli/src/core/vpn/server.js). 0700 root:root
# matches the WireGuard packaging defaults.
if [[ ! -d /etc/wireguard ]]; then
    install -d -m 0700 -o root -g root /etc/wireguard
else
    chmod 0700 /etc/wireguard
    chown root:root /etc/wireguard
fi

# ── 4. Ensure the per-peer config drop directory exists ────────────
# Mode 0700: each peer config (rendered by `proxypilot vpn peer add`,
# step 6) contains a private key. The directory itself must not be
# world-readable; the files inside are written 0600 by the CLI.
if [[ ! -d /var/lib/proxypilot/vpn-peers ]]; then
    install -d -m 0700 -o root -g root /var/lib/proxypilot/vpn-peers
else
    chmod 0700 /var/lib/proxypilot/vpn-peers
fi

log "VPN module installed."
log "  enable:    proxypilot vpn enable --endpoint <host:port>"
log "  status:    wg show wg0  (after enable)"
log "  config:    /etc/wireguard/wg0.conf  (managed; do not edit)"
