// Mock2 project template (Phase M2) — the seed a new project's bare repo and
// container are built from.
//
// ADR-005: the repo carries `mock2.yaml` declaring its topology; ProxyPilot
// READS the declared web port at provision (never scans for it) and registers
// exactly one HTTPS route to it. ADR-008: PostgreSQL runs INSIDE the project
// container, installed by the template — ProxyPilot stores nothing in it.
// ADR-006: the bare repo is the recovery path, so the seed is a real git
// commit, not a snapshot.
//
// This module is PURE (stub-first, risk R9): it returns file contents and the
// container setup script as strings. provision.js does the host-side git and
// Incus work. The framework's real project template (constitution, skills,
// gates, design system) is an M5 prerequisite (risk R8); M2 ships a minimal
// placeholder app so the create → live-URL loop is provable now.
//
// Terminology (risk R7): the dev server here is a plain static server; nothing
// is named "agent".

// Bumped when the seed content changes so a rehydrate/diff (M3) can tell which
// template a project was born from.
export const MOCK2_TEMPLATE_VERSION = 'm2-placeholder-1';

// The default declared web port. Overridable per project only by editing
// mock2.yaml in the repo (a commit, visible in change records — ADR-005).
export const DEFAULT_WEB_PORT = 3000;

// mock2.yaml — the port/topology manifest. `web` is the single exposed port
// ProxyPilot publishes; everything else is internal and default-denied at the
// project bridge in M4.
export function defaultManifest({ webPort = DEFAULT_WEB_PORT } = {}) {
  return `# mock2.yaml — project topology manifest (ADR-005).
# Ports are DECLARED here, never discovered. ProxyPilot registers exactly one
# HTTPS route, to \`web\`; everything else stays internal to the project bridge.
version: 1
ports:
  web: ${webPort}        # exposed — the one HTTPS route ProxyPilot publishes
  postgres: 5432   # internal — Postgres runs inside this container (ADR-008)
`;
}

// parseManifestWebPort(yamlText) — read the declared web port back out of a
// mock2.yaml (ADR-005: declared, not discovered). Deliberately a narrow regex
// rather than a YAML dependency: the manifest shape is fixed by this template,
// and the value is interpolated into a Caddy upstream, so a strict parse is a
// feature. Returns the port number, or null if absent/out of range.
export function parseManifestWebPort(yamlText) {
  const m = String(yamlText || '').match(/^\s*web:\s*(\d{1,5})\b/m);
  if (!m) return null;
  const port = Number(m[1]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return port;
}

// The placeholder web app served over the live URL. Static HTML plus a tiny
// stdlib-only Python server so the container needs no npm install to serve on
// first boot. The page is intentionally minimal — the real framework template
// replaces it in M5.
function placeholderIndexHtml(project) {
  const name = String(project?.name || 'Project').replace(/[<>&]/g, '');
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex, nofollow">
  <title>${name} — ProxyPilot dev preview</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 40rem; margin: 12vh auto; padding: 0 1rem; color: #334155; }
    h1 { font-size: 1.4rem; }
    code { background: #f1f5f9; padding: .1rem .3rem; border-radius: .25rem; }
    .muted { color: #94a3b8; font-size: .85rem; }
  </style>
</head>
<body>
  <h1>${name} is live</h1>
  <p>This is the ProxyPilot Mock2 placeholder app, served from the project
  container over a per-slug Let's Encrypt certificate.</p>
  <p>The build workflow — chat, mockups, and the runner — arrives in later
  phases. For now this proves the create → container → bare repo → live URL
  loop end to end.</p>
  <p class="muted">Served by the project's declared <code>web</code> port.</p>
</body>
</html>
`;
}

// A stdlib-only static server bound to 0.0.0.0:<web>. No third-party deps so a
// fresh container serves immediately; the real template swaps in its own dev
// server in M5.
function serverPy(webPort) {
  return `#!/usr/bin/env python3
"""Minimal static dev server for the Mock2 placeholder app (Phase M2).
Serves ./public on 0.0.0.0:${webPort}. Replaced by the framework template's
real dev server in a later phase."""
import http.server, socketserver, os

PORT = int(os.environ.get("PORT", "${webPort}"))
os.chdir(os.path.join(os.path.dirname(os.path.abspath(__file__)), "public"))

class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("X-Robots-Tag", "noindex, nofollow")
        super().end_headers()

with socketserver.TCPServer(("0.0.0.0", PORT), Handler) as httpd:
    print(f"Mock2 placeholder serving on 0.0.0.0:{PORT}")
    httpd.serve_forever()
`;
}

// The secrets MANIFEST (required keys, no values). The real .env is gitignored
// and lives only in the container (03-data-model.md: .env values never enter
// the repo). DATABASE_URL points at the in-container Postgres (ADR-008).
function envExample(webPort) {
  return `# Secrets manifest — required keys, NO values. Copy to .env in the
# container and fill in. .env is gitignored and never committed (ADR-006/008).
PORT=${webPort}
# In-container Postgres (ADR-008) — ProxyPilot stores nothing here.
DATABASE_URL=postgres://app:app@127.0.0.1:5432/app
`;
}

// buildSeedFiles(project, opts) → [{ path, content, mode }]. The exact tree the
// first (seed) commit contains. `mode` is octal for the entries that must be
// executable (the dev server).
export function buildSeedFiles(project, { webPort = DEFAULT_WEB_PORT } = {}) {
  return [
    { path: 'mock2.yaml', content: defaultManifest({ webPort }) },
    { path: 'public/index.html', content: placeholderIndexHtml(project) },
    { path: 'serve.py', content: serverPy(webPort), mode: 0o755 },
    { path: '.env.example', content: envExample(webPort) },
    {
      path: '.gitignore',
      content: '.env\n__pycache__/\nnode_modules/\n',
    },
    {
      path: 'README.md',
      content: `# ${String(project?.name || 'Project')}\n\n` +
        `ProxyPilot Mock2 project (template ${MOCK2_TEMPLATE_VERSION}). ` +
        `The declared topology is in \`mock2.yaml\`; the dev server is \`serve.py\`.\n`,
    },
    {
      // state/ is where later phases append rules.md and change records
      // (03-data-model.md); seed an empty rules file so the path exists.
      path: 'state/rules.md',
      content: `# Project rules\n\nRule answers append here (Phase M8).\n`,
    },
  ];
}

// buildContainerSetupScript(opts) → a bash script run once inside the container
// after the working clone lands. Installs the runtime + Postgres (ADR-008,
// best-effort — a failure to install Postgres does not fail provisioning of the
// placeholder app), then writes and starts a systemd unit for the dev server.
//
// repoMount:  where the bare repo is mounted read into the container
// appDir:     the working clone path
// webPort:    declared web port
export function buildContainerSetupScript({ appDir = '/srv/app', webPort = DEFAULT_WEB_PORT } = {}) {
  return `#!/bin/sh
set -e
APP_DIR="${appDir}"
WEB_PORT="${webPort}"

export DEBIAN_FRONTEND=noninteractive

# Runtime for the placeholder dev server. Postgres is installed per ADR-008 but
# is best-effort: the placeholder app does not need it to serve, and a base
# image without it must still come online.
apt-get update -y || true
apt-get install -y --no-install-recommends python3 || true
apt-get install -y --no-install-recommends postgresql || echo "[mock2] postgres install skipped/failed (non-fatal in M2)"

# Bring the in-container Postgres up if it installed (ADR-008). Non-fatal.
if command -v pg_ctlcluster >/dev/null 2>&1; then
  (service postgresql start || pg_ctlcluster "$(ls /etc/postgresql 2>/dev/null | head -n1)" main start || true) 2>/dev/null || true
fi

# Dev server systemd unit — restarts on crash, starts on boot so a container
# restart (idle-stop lifecycle, M9) brings the app back automatically.
cat > /etc/systemd/system/mock2-dev.service <<UNIT
[Unit]
Description=Mock2 project dev server
After=network.target

[Service]
Type=simple
WorkingDirectory=${appDir}
Environment=PORT=${webPort}
ExecStart=/usr/bin/python3 ${appDir}/serve.py
Restart=on-failure
RestartSec=2

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload || true
systemctl enable --now mock2-dev.service || (cd "$APP_DIR" && PORT="$WEB_PORT" nohup python3 serve.py >/var/log/mock2-dev.log 2>&1 &)
echo "[mock2] dev server started on port ${webPort}"
`;
}
