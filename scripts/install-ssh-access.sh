#!/bin/bash
# Emit ProxyPilot SSH access systemd units and run an initial reconcile.
# Idempotent — safe to run on every install/update.
#
# Called from install.sh and update.sh AFTER install-vpn.sh. The
# access manager itself lives in cli/src/core/ssh-access/; this
# script only handles host-level wiring (state-dir perms + systemd
# units + first reconcile).

set -euo pipefail

PROXYPILOT_BIN="${PROXYPILOT_BIN:-/usr/local/bin/proxypilot}"

log() { echo "[ssh-access] $*"; }

# ── 1. Ensure /var/lib/proxypilot exists ────────────────────────────────
# The CLI's atomicWrite() helper will create it lazily on first
# `ssh access add`, but reconcile-on-boot needs it to pass the
# ConditionPathExists guard on the systemd unit. Mode 0750 root:root
# matches firewall.json's parent dir.
if [[ ! -d /var/lib/proxypilot ]]; then
    install -d -m 0750 -o root -g root /var/lib/proxypilot
fi

# ── 2. Emit the touch-last-seen service + timer ─────────────────────────
# The scanner parses `last -F -i -n 200` and updates last_seen_at for
# active rows. Best-effort — exits 0 even when wtmp is empty so the
# timer never enters a failure state.
cat > /etc/systemd/system/proxypilot-ssh-access-touch.service <<EOF
[Unit]
Description=ProxyPilot SSH access last-seen scanner
Documentation=https://proxypilot.dev/ssh-access
After=network.target
ConditionPathExists=/var/lib/proxypilot

[Service]
Type=oneshot
ExecStart=${PROXYPILOT_BIN} ssh access reconcile --dry-run
# Touch invocation runs through the standalone bin so we can keep the
# user-facing CLI surface to the seven documented subcommands.
ExecStart=/usr/bin/env node ${PROXYPILOT_INSTALL_DIR:-/opt/proxypilot}/cli/bin/proxypilot-ssh-access-touch.js
SuccessExitStatus=0 1
EOF

cat > /etc/systemd/system/proxypilot-ssh-access-touch.timer <<'EOF'
[Unit]
Description=ProxyPilot SSH access last-seen scanner (every 5 min)
Documentation=https://proxypilot.dev/ssh-access

[Timer]
OnBootSec=2min
OnUnitActiveSec=5min
AccuracySec=30s
Unit=proxypilot-ssh-access-touch.service

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload

# ── 3. Run an initial dry-run reconcile so the operator immediately
#       sees that authorized_keys is in sync (or learns which users
#       have drift). Failure is non-fatal: a fresh install has no
#       ssh_access rows yet, so the dry-run is a no-op. -----------------
log "Running initial ssh-access reconcile (dry-run)..."
"${PROXYPILOT_BIN}" ssh access reconcile --dry-run >/dev/null 2>&1 || \
    log "  (no ssh_access rows yet — first add will reconcile)"

# ── 4. Enable the timer so it survives reboot ───────────────────────────
systemctl enable proxypilot-ssh-access-touch.timer >/dev/null
systemctl restart proxypilot-ssh-access-touch.timer

log "SSH access manager installed."
log "  state file:    /var/lib/proxypilot/ssh-access.json"
log "  last-seen:     systemctl status proxypilot-ssh-access-touch.timer"
log "  add device:    proxypilot ssh access bootstrap-script <id> --user <u> --server <host>"
log "  list:          proxypilot ssh access list"
