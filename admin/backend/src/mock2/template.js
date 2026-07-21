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

import { buildScaffoldFiles } from './scaffold.js';
import { buildDesignPresetSeedFiles } from './design-presets.js';
import { DEFAULT_RUN_CONTRACT, buildDevServiceUnit, execStartForServePy } from './deploy-logic.js';

// Bumped when the seed content changes so a rehydrate/diff (M3) can tell which
// template a project was born from. m7-concept-1: the dev server also serves the
// Stage-1 mockup preview at /_preview (from state/mockups/), and the seed carries
// an empty state/mockups/ so the preview path exists before the first mockup.
// run-1: the seed is now the real TS/Express/Drizzle runtime scaffold (R8,
// scaffold.js) plus a declared run contract in mock2.yaml; serve.py stays as the
// pre-build/Concept-stage placeholder and the deploy step swaps in the real app.
export const MOCK2_TEMPLATE_VERSION = 'run-1';

// The default declared web port. Overridable per project only by editing
// mock2.yaml in the repo (a commit, visible in change records — ADR-005).
export const DEFAULT_WEB_PORT = 3000;

// mock2.yaml — the port/topology manifest (ADR-005) AND the run contract
// (Run phase). `web` is the single exposed port ProxyPilot publishes; everything
// else is internal and default-denied at the project bridge in M4. The `run`
// block DECLARES how the app installs/migrates/builds/starts — the deploy step
// obeys it verbatim and NEVER sniffs the tree for a start command (declared, not
// discovered, exactly like ports).
export function defaultManifest({ webPort = DEFAULT_WEB_PORT } = {}) {
  return `# mock2.yaml — project topology manifest + run contract (ADR-005).
# Ports are DECLARED here, never discovered. ProxyPilot registers exactly one
# HTTPS route, to \`web\`; everything else stays internal to the project bridge.
version: 1
ports:
  web: ${webPort}        # exposed — the one HTTPS route ProxyPilot publishes
  postgres: 5432   # internal — Postgres runs inside this container (ADR-008)
# How the app runs. The deploy step runs these verbatim (declared, not sniffed).
run:
  runtime: ${DEFAULT_RUN_CONTRACT.runtime}
  install: ${DEFAULT_RUN_CONTRACT.install}
  migrate: ${DEFAULT_RUN_CONTRACT.migrate}
  build: ${DEFAULT_RUN_CONTRACT.build}
  start: ${DEFAULT_RUN_CONTRACT.start}
# Outbound egress the app needs to an INTERNAL host (LAN / control plane). The
# fence blocks all private-range egress by default; declare each internal host
# here and an admin must approve it before it is wired. Anything not declared and
# approved stays blocked. The public internet is always reachable (no entry
# needed). Uncomment and edit:
# egress:
#   - host: 10.0.0.5        # IPv4 or a hostname resolvable from the host
#     port: 636
#     protocol: tcp         # tcp | udp (ldaps/tls/https are tcp)
#     reason: LDAPS directory
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
// server in a later phase.
//
// Two roots (Phase M7):
//   /            -> ./public         (the placeholder app; real app in Build)
//   /_preview    -> ./state/mockups  (the Stage-1 concept mockup preview; the
//                  concept loop writes current.html + <id>.html here and the
//                  Builder opens /_preview in a new tab)
// translate_path routes by prefix and confines each request to its root so a
// model-authored mockup path can never escape the mockups dir.
function serverPy(webPort) {
  return `#!/usr/bin/env python3
"""Minimal static dev server for the Mock2 placeholder app + Stage-1 mockup
preview (Phase M7). Serves ./public at / and ./state/mockups at /_preview on
0.0.0.0:${webPort}. Replaced by the framework template's real dev server in a
later phase."""
import http.server, socketserver, os, posixpath, urllib.parse

BASE = os.path.dirname(os.path.abspath(__file__))
PUBLIC = os.path.join(BASE, "public")
MOCKUPS = os.path.join(BASE, "state", "mockups")
PREVIEW_PREFIX = "/_preview"
PORT = int(os.environ.get("PORT", "${webPort}"))

class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("X-Robots-Tag", "noindex, nofollow")
        super().end_headers()

    def translate_path(self, path):
        path = path.split("?", 1)[0].split("#", 1)[0]
        path = urllib.parse.unquote(path)
        if path == PREVIEW_PREFIX or path.startswith(PREVIEW_PREFIX + "/"):
            rel = path[len(PREVIEW_PREFIX):].lstrip("/") or "current.html"
            root = MOCKUPS
        else:
            rel = path.lstrip("/") or "index.html"
            root = PUBLIC
        # Confine to the chosen root — normpath drops any ../ traversal.
        safe = posixpath.normpath("/" + rel).lstrip("/")
        return os.path.join(root, safe)

with socketserver.TCPServer(("0.0.0.0", PORT), Handler) as httpd:
    print(f"Mock2 dev server on 0.0.0.0:{PORT} (/ -> public, /_preview -> state/mockups)")
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
// executable (the dev server + the migrate script).
//
// The tree is the real TS/Express/Drizzle runtime scaffold (scaffold.js, R8)
// composed with: the manifest (ports + run contract), the secrets manifest, and
// serve.py + public/index.html — the pre-build/Concept-stage PLACEHOLDER dev
// server. Before the first build, serve.py owns the web port (serves the
// placeholder page at / and the mockup at /_preview); the deploy step swaps in
// the scaffold's own runtime once a build succeeds.

// WORKING-COPY.md — the external-editor guide shipped in every project repo.
export function workingCopyMd(project) {
  const id = Number(project?.id) || '<project-id>';
  return `# Working copy guide (VS Code and other editors)

This repository is hosted by ProxyPilot. Clone it over authenticated smart
HTTP (the exact URL and a one-click VS Code link are on the project page
under **Connect**):

    git clone https://<your-proxypilot-domain>/api/mock2/git/${id}

Sign in with your dashboard username and a **connect token** (project page →
Connect → new token; tokens expire after 30 days). Editors can push;
viewers can only clone/pull.

## The push contract — no manual deploy

1. Commit your work. This repo ships \`.vscode/settings.json\` with
   \`"git.postCommitCommand": "push"\`, so VS Code pushes automatically after
   every commit (remove that setting if you prefer pushing by hand).
2. On every successful push the platform automatically:
   - records the change (hash-chained change record, visible in Change history),
   - syncs the project container's working tree,
   - **redeploys the app** — install → migrate → build → restart → health
     check — and posts the result in the build chat.

If the project is asleep when you push, the commits are safe in the repo;
wake the project and press "Redeploy app" once.

## Design specs — reference these, do not fight them

The approved design travels with the repo:

- \`state/design-tokens.json\` — colors, typography, radius, spacing, shadow
- \`state/design.css\` — the rendered stylesheet every page links as \`/design.css\`
- \`state/mockups/current.html\` — the approved mockup: the visual contract

Style new UI through the tokens (\`var(--app-*)\`); the platform's design
review flags colors that bypass them. The app is an installable PWA — keep
\`public/manifest.webmanifest\`, \`sw.js\`, \`install.js\`, and the manifest
link + install script in every page head.

## Ground rules

- Do not edit \`state/changes/\` (hash-chained audit trail) and avoid
  rewriting pushed history.
- \`mock2.yaml\` declares how the app installs, migrates, builds, and starts —
  keep it truthful; every deploy reads it.
- Platform builds also commit to this repo; pull before you start a session.
`;
}

export function buildSeedFiles(project, { webPort = DEFAULT_WEB_PORT } = {}) {
  return [
    { path: 'mock2.yaml', content: defaultManifest({ webPort }) },
    // The real runtime scaffold (package.json, tsconfig, src/, migrations/, …).
    ...buildScaffoldFiles(project),
    // Pre-build placeholder dev server (Concept stage) — kept as the idle/fallback
    // front door until the deploy step swaps the systemd unit to the real app.
    { path: 'public/index.html', content: placeholderIndexHtml(project) },
    { path: 'serve.py', content: serverPy(webPort), mode: 0o755 },
    { path: '.env.example', content: envExample(webPort) },
    {
      path: '.gitignore',
      content: '.env\n__pycache__/\nnode_modules/\ndist/\n*.log\n',
    },
    {
      path: 'README.md',
      content: `# ${String(project?.name || 'Project')}\n\n` +
        `ProxyPilot Mock2 project (template ${MOCK2_TEMPLATE_VERSION}). ` +
        `The declared topology and run contract are in \`mock2.yaml\`; the app is a ` +
        `TypeScript/Express/Drizzle scaffold under \`src/\` with migrations in \`migrations/\`. ` +
        `\`serve.py\` is the pre-build placeholder dev server (Concept stage).\n\n` +
        `Working on this repo from VS Code or another editor? Read \`WORKING-COPY.md\` — ` +
        `pushes auto-deploy, and the approved design specs live in \`state/\` ` +
        `(\`design-tokens.json\`, \`design.css\`, \`mockups/current.html\`).\n`,
    },
    {
      // The external-editor contract: clone → commit → push, and the platform
      // does the rest (sync + redeploy). Shipped in every project repo so the
      // workflow travels with the code.
      path: 'WORKING-COPY.md',
      content: workingCopyMd(project),
    },
    {
      // VS Code: push automatically after every commit, so the push→deploy
      // contract in WORKING-COPY.md fires without a manual sync step.
      path: '.vscode/settings.json',
      content: `${JSON.stringify({
        'git.postCommitCommand': 'push',
        'git.confirmSync': false,
        'git.autofetch': true,
      }, null, 2)}\n`,
    },
    {
      // state/ is where later phases append rules.md and change records
      // (03-data-model.md); seed an empty rules file so the path exists.
      path: 'state/rules.md',
      content: `# Project rules\n\nRule answers append here (Phase M8).\n`,
    },
    {
      // Integration manifest (B.2): the versioned declaration of every external
      // capability (API, directory, webhook). Define appends confirmed entries;
      // the integration gate + egress check + verification checklist all key off
      // it, and source discovery backstops it (an undeclared outbound integration
      // is a gate failure — omitting the manifest is not a bypass). Seeded empty
      // so the path exists and rides the hash-chained history.
      path: 'state/integrations.json',
      content: `${JSON.stringify({ schema_version: 1, entries: [] }, null, 2)}\n`,
    },
    {
      // Stub registry (B.6): every APPROVED production simulation, with its
      // severity + approval reference. Empty by default — the only legitimate way
      // an entry appears is an admin-approved deviation. Injected into every
      // cycle's work-file context so shipped stubs are never invisible.
      path: 'state/stub-registry.json',
      content: `${JSON.stringify({ schema_version: 1, stubs: [] }, null, 2)}\n`,
    },
    {
      // state/mockups/ is where the Stage-1 concept loop writes the interactive
      // HTML mockup (current.html + <id>.html), served at /_preview by the dev
      // server. Seed a .gitkeep so the directory (and the preview path) exist
      // before the first mockup, and survive archive/rehydrate.
      path: 'state/mockups/.gitkeep',
      content: '',
    },
    // Design preset chosen at creation (design-presets.js): seed the token doc
    // + rendered stylesheet up front, exactly what design approval would
    // produce — so the base app is styled before any model turn. No preset →
    // nothing seeded (the mockup model picks the look; approval extracts it).
    ...buildDesignPresetSeedFiles(project?.design_preset),
  ];
}

// buildCheckpointScript(opts) → a POSIX-sh script run INSIDE the container to
// checkpoint the working tree back into the bare repo over the ADR-011 mount.
// Used by archive (M3): `git add -A` → commit any dirty state → push to the
// bare repo's main branch (origin = /srv/repo.git). Pure string so it is
// unit-testable without Incus (stub-first, risk R9); provision.js base64-streams
// it into `incus exec`.
//
// Tolerant by design: a container with no working clone exits 0 (the bare repo
// already holds the last pushed state — ADR-006), and a clean tree skips the
// commit but still pushes so any already-made commits reach the bare repo.
export function buildCheckpointScript({ appDir = '/srv/app', message = 'checkpoint: pre-archive' } = {}) {
  const msg = String(message).replace(/["'`$\\]/g, '');
  return `set -e
APP_DIR="${appDir}"
if [ ! -d "$APP_DIR/.git" ]; then
  echo "[mock2] no working clone to checkpoint — bare repo already holds last state"
  exit 0
fi
cd "$APP_DIR"
git config --global --add safe.directory "$APP_DIR" 2>/dev/null || true
git add -A
if ! git diff --cached --quiet 2>/dev/null; then
  git -c user.name="ProxyPilot Mock2" -c user.email="mock2@proxypilot.local" \\
    commit -q -m "${msg}" || true
fi
# Push to the bare repo (origin = /srv/repo.git over the ADR-011 disk-device
# mount). This is the ONLY recovery path — no snapshot dependency (ADR-006).
git push -q origin HEAD:main
echo "[mock2] checkpoint pushed to bare repo"
`;
}

// buildContainerSetupScript(opts) → a bash script run once inside the container
// after the working clone lands. Installs the runtime + Postgres (ADR-008,
// best-effort — a failure to install Postgres does not fail provisioning of the
// placeholder app), then writes and starts a systemd unit for the dev server.
//
// repoMount:  where the bare repo is mounted read into the container
// appDir:     the working clone path
// webPort:    declared web port
// The container reaches the internet via the bridge's Incus NAT — no egress proxy
// env is written (squid was removed). The nftables fence still logs every new
// outbound connection and blocks lateral movement to private ranges.
export function buildContainerSetupScript({ appDir = '/srv/app', webPort = DEFAULT_WEB_PORT } = {}) {
  // The pre-build placeholder unit (serve.py). Same builder the deploy step uses
  // to rewrite ExecStart to the real app, so the two units differ ONLY in ExecStart.
  const devServiceUnit = buildDevServiceUnit({
    appDir, webPort, execStart: execStartForServePy(appDir),
  }).trimEnd();
  return `#!/bin/sh
set -e
APP_DIR="${appDir}"
WEB_PORT="${webPort}"

export DEBIAN_FRONTEND=noninteractive

# Bootstrap installs run BEFORE the network fence (provision.js applies it only
# after this script returns), so they use the container's DIRECT IPv4 NAT egress
# — no proxy needed. The bridge is IPv4-only (ipv6.address=none), so force apt
# onto IPv4 or it tries a non-existent v6 route and fails "Network is unreachable".
mkdir -p /etc/apt/apt.conf.d
printf 'Acquire::ForceIPv4 "true";\\n' > /etc/apt/apt.conf.d/00mock2-ipv4

# Runtime for the placeholder dev server. Postgres is installed per ADR-008 but
# is best-effort: the placeholder app does not need it to serve, and a base
# image without it must still come online.
apt-get update -y || true
apt-get install -y --no-install-recommends python3 || true
# Operator/runner toolbox baked in at bootstrap so it is on EVERY container: a
# shell into the box has an editor, git works for the runner's checkpoints, curl
# is there for health checks, and sudo exists for the rare privileged step.
# Installing here keeps a container self-contained without depending on runtime
# apt reachability.
apt-get install -y --no-install-recommends git curl nano sudo ca-certificates || echo "[mock2] toolbox install skipped/failed (non-fatal)"
# iproute2 (ss) + psmisc (fuser) + lsof: the deploy's port-freeing and the
# health check's port-holder diagnostics use them. Without them every reaper
# silently no-ops and the holders line reports "(nothing bound)" over a held
# port — the EADDRINUSE loop that was undebuggable until a /proc fallback
# existed. Best-effort like the rest of the toolbox.
apt-get install -y --no-install-recommends iproute2 psmisc lsof || echo "[mock2] port-tools install skipped/failed (non-fatal; /proc fallback applies)"
apt-get install -y --no-install-recommends postgresql || echo "[mock2] postgres install skipped/failed (non-fatal in M2)"
# Node.js + npm for the runtime scaffold (R8). Installed at BOOTSTRAP so the Node
# RUNTIME is present before first use. The npm PACKAGES the app needs (npm
# install) are fetched at DEPLOY over the bridge's NAT egress to
# registry.npmjs.org. Non-fatal: a project that never builds still comes online
# on the placeholder dev server.
apt-get install -y --no-install-recommends nodejs npm || echo "[mock2] nodejs/npm install skipped/failed (non-fatal; the app cannot deploy without it)"

# Bring the in-container Postgres up if it installed (ADR-008). Non-fatal.
if command -v pg_ctlcluster >/dev/null 2>&1; then
  (service postgresql start || pg_ctlcluster "$(ls /etc/postgresql 2>/dev/null | head -n1)" main start || true) 2>/dev/null || true
fi

# Provision the in-container app role + database (ADR-008) so the app's declared
# DATABASE_URL (postgres://app:app@127.0.0.1:5432/app in .env.example, and the
# migrate script's default) authenticates. Idempotent + best-effort: the
# placeholder dev server does not need it, but the DEPLOYED app (its migrate step)
# does. Runs locally against the just-started cluster — no egress needed.
if command -v psql >/dev/null 2>&1; then
  su - postgres -c "psql -tAc \\"SELECT 1 FROM pg_roles WHERE rolname='app'\\" | grep -q 1 || psql -c \\"CREATE ROLE app LOGIN PASSWORD 'app'\\"" 2>/dev/null || echo "[mock2] app role create skipped/failed (non-fatal)"
  su - postgres -c "psql -tAc \\"SELECT 1 FROM pg_database WHERE datname='app'\\" | grep -q 1 || psql -c \\"CREATE DATABASE app OWNER app\\"" 2>/dev/null || echo "[mock2] app database create skipped/failed (non-fatal)"
fi

# No egress proxy: the bridge NATs straight out (Incus ipv4.nat). Once the fence
# is applied (provision.js, right after this script) egress is still NAT'd — the
# fence only blocks lateral movement to private ranges and LOGS each new outbound
# connection so operators can see where traffic goes. apt/npm/pip/git at runtime
# need no proxy env.

# Dev server systemd unit — restarts on crash, starts on boot so a container
# restart (idle-stop lifecycle, M9) brings the app back automatically. This is
# the PRE-BUILD placeholder unit (serve.py); the deploy step (deploy.js) rewrites
# ExecStart to the manifest \`start\` command once a build succeeds, and that
# rewritten unit persists across restarts. Built with the shared buildDevServiceUnit
# so the deploy rewrite and this seed produce byte-identical units bar ExecStart.
cat > /etc/systemd/system/mock2-dev.service <<UNIT
${devServiceUnit}
UNIT

systemctl daemon-reload || true
systemctl enable --now mock2-dev.service || (cd "$APP_DIR" && PORT="$WEB_PORT" nohup python3 serve.py >/var/log/mock2-dev.log 2>&1 &)
echo "[mock2] dev server started on port ${webPort}"
`;
}
