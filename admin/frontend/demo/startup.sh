#!/bin/sh
set -eu

if ! command -v node >/dev/null 2>&1; then
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends nodejs ca-certificates
fi

cat >/etc/systemd/system/fractionate-demo.service <<'UNIT'
[Unit]
Description=Fractionate demo website
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=www-data
WorkingDirectory=/opt/app
Environment=DEMO_HOST=0.0.0.0
Environment=DEMO_PORT=4179
Environment=DEMO_PUBLIC_ORIGIN=https://demo.fractionate.ai
ExecStart=/usr/bin/node /opt/app/demo/server.mjs
Restart=always
RestartSec=3
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable fractionate-demo.service
systemctl restart fractionate-demo.service
systemctl is-active --quiet fractionate-demo.service
