#!/bin/bash
# Emit ProxyPilot firewall systemd units and apply the initial ruleset.
# Idempotent — safe to run on every install/update.
#
# Called from install.sh and update.sh. The firewall manager itself
# lives in cli/src/core/firewall/; this script only handles host-level
# wiring (systemd units + first reconcile).

set -euo pipefail

PROXYPILOT_BIN="${PROXYPILOT_BIN:-/usr/local/bin/proxypilot}"

log() { echo "[firewall] $*"; }

# ── 1. Refuse to run if ufw is active. ProxyPilot is incompatible with
#       ufw running concurrently — they fight over nftables. -----------
if command -v ufw >/dev/null 2>&1; then
    if ufw status 2>/dev/null | grep -q "Status: active"; then
        echo "[firewall] ERROR: ufw is active. ProxyPilot manages the host firewall via nftables."
        echo "[firewall]        Disable ufw with: ufw disable"
        echo "[firewall]        Remove ufw with:  apt remove --purge ufw"
        exit 1
    fi
fi

# ── 2. Ensure nftables is installed --------------------------------------
if ! command -v nft >/dev/null 2>&1; then
    log "Installing nftables..."
    apt-get update -qq
    apt-get install -y nftables >/dev/null
fi

# ── 3. Emit systemd units ------------------------------------------------
# reconcile.service: oneshot, runs `proxypilot firewall reconcile` at
#   boot before network-pre.target (so the host comes up firewalled).
# reconcile.timer: every 5 min as a drift safety net.
# discover.service + .timer: every 10 min, refresh discovered listeners.

cat > /etc/systemd/system/proxypilot-firewall-reconcile.service <<EOF
[Unit]
Description=ProxyPilot firewall reconcile
Documentation=https://proxypilot.dev/firewall
Before=network-pre.target
Wants=network-pre.target

[Service]
Type=oneshot
ExecStart=${PROXYPILOT_BIN} firewall reconcile

[Install]
WantedBy=multi-user.target
EOF

cat > /etc/systemd/system/proxypilot-firewall-reconcile.timer <<'EOF'
[Unit]
Description=ProxyPilot firewall reconcile (drift safety net)
Documentation=https://proxypilot.dev/firewall

[Timer]
OnBootSec=2min
OnUnitActiveSec=5min
Unit=proxypilot-firewall-reconcile.service

[Install]
WantedBy=timers.target
EOF

cat > /etc/systemd/system/proxypilot-firewall-discover.service <<EOF
[Unit]
Description=ProxyPilot firewall listener discovery
Documentation=https://proxypilot.dev/firewall

[Service]
Type=oneshot
ExecStart=${PROXYPILOT_BIN} firewall scan
EOF

cat > /etc/systemd/system/proxypilot-firewall-discover.timer <<'EOF'
[Unit]
Description=ProxyPilot firewall listener discovery (every 10 min)
Documentation=https://proxypilot.dev/firewall

[Timer]
OnBootSec=5min
OnUnitActiveSec=10min
Unit=proxypilot-firewall-discover.service

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload

# ── 4. Apply the initial ruleset (creates default firewall.json on
#       first run via the CLI's lazy-init path). --------------------------
log "Running initial firewall reconcile..."
"${PROXYPILOT_BIN}" firewall reconcile

# ── 5. Enable the units so they survive reboot --------------------------
systemctl enable proxypilot-firewall-reconcile.service >/dev/null
systemctl enable proxypilot-firewall-reconcile.timer >/dev/null
systemctl enable proxypilot-firewall-discover.timer >/dev/null

# ── 6. Start the timers (services are oneshot triggered by timers
#       and by boot-time reconcile.service) -------------------------------
systemctl restart proxypilot-firewall-reconcile.timer
systemctl restart proxypilot-firewall-discover.timer

log "Firewall manager installed."
log "  state file:    /var/lib/proxypilot/firewall.json"
log "  reconcile:     systemctl status proxypilot-firewall-reconcile.timer"
log "  discover:      systemctl status proxypilot-firewall-discover.timer"
log "  manage:        proxypilot firewall list / enable <id> / disable <id>"
