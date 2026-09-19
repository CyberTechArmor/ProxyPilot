# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

ProxyPilot is a reverse-proxy management system built on Caddy. It is a multi-runtime monorepo:

- `admin/backend/` — Express API server (Node, port 3001), the core of the product
- `admin/frontend/` — React 18 + Vite + Tailwind + shadcn/ui dashboard
- `cli/` — Node.js CLI (Commander), entry `cli/bin/proxypilot.js` (Incus/LXC + Caddy commands)
- `cmd/agent/` — Go 1.21 module (`proxypilot-agent`), JSON-over-newline RPC on a Unix socket. Phase A scaffold: only `agent.ping` is wired; production code paths still use `nsenter`
- `proxypilot/engine/` — Python CVE automation engine (`python3 -m engine` style CLI: inventory, poll, run-one, …), driven by systemd timers in `deploy/`
- `install.sh` / `update.sh` / `reset.sh` / `restart.sh` / `cleanup.sh` — operator scripts at repo root; install target is `/opt/proxypilot`
- `index.html` — standalone Caddy script generator, deployed to GitHub Pages by `.github/workflows/static.yml` (the only CI workflow)

The three large `proxypilot-*-prompt.md` / `*-phased-plan.md` files at repo root are development planning artifacts, not product docs. Don't delete them.

## Commands

Backend (run from `admin/backend/`):

```bash
npm run dev        # node --watch src/index.js
npm test           # node --test 'src/__tests__/*.test.js'
node --test src/__tests__/backup-pack.test.js   # single test file
```

Frontend (run from `admin/frontend/`):

```bash
npm run dev        # Vite dev server, proxies /api to http://localhost:3001
npm run build      # production build (parallelism deliberately limited for low-memory VPS)
```

**Known failing tests:** 6 test files fail in a fresh checkout, all `ERR_MODULE_NOT_FOUND` on packages absent from the sandbox: `cve-research.test.js`, `cves.test.js`, `incus.test.js`, `webauthn.test.js` (import the real `admin/backend/src/db.js` → native `better-sqlite3`), `vpn-mtu.test.js` (imports `cli/src/db/index.js` → `better-sqlite3`), and `ldap.test.js` (imports `ldapts`). Everything else passes (943/954 as of 2026-07). This is pre-existing on `main` — see `docs/known-issues.md` before "fixing" it in an unrelated PR. Other tests pass because they stub the DB at the module boundary; follow that pattern for new tests.

## Architecture

**Request flow:** Frontend (`admin/frontend/src/lib/api.js`) → cookie-sessioned Express API → SQLite. The API client centralizes CSRF (`pp_csrf` cookie echoed as `X-CSRF-Token`), the sudo-elevation modal flow on 403, and retries — go through it rather than raw `fetch`.

**Backend layout:** `src/index.js` (entry) → `src/routes/*.js` (auth, services, lxc, vpn, firewall, ssh-access, backups, cves, security, housekeeping, notifications, terminal-ws, user, lean-beaf) → `src/lib/*` (Caddy driver, L4/L7 reconcilers, backup pack/unpack, cert-mount reconciler, S3, WebAuthn, etc.). Validation uses Zod on both backend and frontend.

**Caddy integration:** the backend owns `/etc/caddy/sites/*.caddy` (regenerated from DB state, then `caddy reload`); operator-managed `/etc/caddy/custom/*.caddy` is never clobbered. HTTP/S routes go through Caddy; raw TCP/UDP forwards (`service_l4_forwards`) are reconciled as Incus proxy devices. When the backend runs inside Docker (detected via `/.dockerenv` or `DOCKER_CONTAINER=true`), host-level commands run through `nsenter -t 1`.

**Database:** SQLite (better-sqlite3, WAL mode) at `$DATABASE_PATH` (default `data/db/proxypilot.db`). Migrations are numbered and registered in `admin/backend/src/db.js` — version ranges are reserved per feature area (1–8 core, 100s/200s/300/400 for later features); add new migrations there, never edit applied ones. Secrets (TOTP, S3 credentials) are encrypted at rest with `TOTP_ENCRYPTION_KEY`. `.env.example` is the canonical list of env vars; the backend searches for `.env` in install root, project root, then backend dir.

**Storage (ZFS, 2026-09):** `lib/storage/` (parse → planner → policy/freshness → host → service) manages host disks and ZFS pools; every mutation is plan/confirm (dry run returns the exact argv plan + a sha256 `plan_token`, apply recomputes and compares). Surface: `routes/storage.js` (`/api/storage`), the MCP `storage` family (`routes/mcp-tools/storage.js`, 27 tools), `pages/Storage.jsx`, `lib/storage-monitor.js` (alerts → bell + webhooks), the Go agent's `storage.*` methods with an nsenter fallback, host units/helpers in `deploy/` + `scripts/storage-*.sh` (`scripts/install-storage.sh` is the one-time host step). Preflight and self-install: `lib/storage/preflight.js` reads what lsblk cannot (mdstat, `mdadm --examine`, `/etc/fstab`, `efibootmgr`, active swap) and attaches `device.risk`, which `deviceEligibility` treats as hard refusals; `install_storage_toolchain` / `POST /api/storage/install` run `scripts/install-storage.sh` through the ROOT update runner (`action: "storage-install"`, no caller arguments, script resolved from the runner's own `source-dir`). Migration 908. Doc: `docs/features/storage.md`; loop-device integration test + CI in `.github/workflows/storage-integration.yml`.

**Migration (2026-09):** `lib/migration/` (manifest → plan → token → service) adopts a running application from another server, VM or container onto an Incus guest. Two modes in one Go binary (`cmd/agent/migrate/`, the same binary as the host agent): whole-machine wraps the official `incus-migrate` — or tars the rootfs for a Proxmox LXC, which ProxyPilot imports as a split image — and application mode streams the app directories plus a logical DB dump into a fresh guest as tarballs through ProxyPilot (`incus exec` unpacks them, so no sshd or key is added to the guest). The operator runs ONE line on the source; the agent sends an inventory manifest (env PATHS and KEY NAMES, never values — the service refuses a manifest carrying one) and then WAITS for `approve_migration`. The imported guest comes up with the default-deny egress fence and no route; the cutover is a stateful checklist. Surface: `routes/migrations.js` (operator REST + the token-authenticated agent router), the MCP `migration` family (11 tools), `pages/Migrations.jsx`, migrations 909–910. The agent token ends by USE, not by a clock: it dies when the migration reaches a terminal state and `revoke_migration_token` kills it sooner (`list_migration_tokens` and the page's Agent tokens panel show every token's state). `cleanup_migration` deletes the guest a finished migration created and/or its record — never one it merely adopted, and never one serving a route. Doc: `docs/features/migration.md`.

**CVE engine:** Python engine maintains an inventory and polls feeds via systemd timers; CVE entries land as YAMLs in `/var/lib/proxypilot/inbox/`, the backend reads/acts on them and can invoke `run-one`. A state machine classifies remediation as AUTO_PATCH vs. operator-driven.

**Sidebar naming (2026-09):** the sidebar entry **"Projects"** is Lean BEAF Pro (`/lean-beaf`, `pages/LeanBeafPro.jsx`, `routes/lean-beaf.js`); the Mock2 dev/build module (`/projects`, `pages/Projects.jsx`, `src/mock2/`) is labelled **"Flightdeck"** in the UI. Routes, file names, and API paths kept their old names — only user-facing labels changed. Older docs under `docs/` that say "Projects → Components" or "Projects → Connectors" mean Flightdeck.

**LXC Workspace (2026-09):** the container dialog's **Workspace** tab (it replaced the Terminal and Files tabs) is Flightdeck's explorer/editor/preview/terminal over one container: `components/lxc/LxcWorkspace.jsx` reuses `FlightdeckFileTree`/`FlightdeckEditor` through the `fs` adapter in `lib/flightdeck.js` (`mock2FlightdeckFs` / `lxcWorkspaceFs`), backed by `routes/lxc-workspace.js` (`/api/lxc/containers/:name/workspace/*`, operator-chosen absolute root). Doc: `docs/features/lxc/workspace.md`.

**PWA:** the dashboard is installable (`public/manifest.webmanifest`, `src/sw-template.js` emitted as `/sw.js` by `vite.config.js`, helpers in `src/lib/pwa.js`). The install prompt is captured at startup in `main.jsx` and offered from Profile → Install app (`components/InstallApp.jsx`). The app icon is `public/logo.svg` (the sidebar rocket, primary green on navy); the `icon-*.png` set is rasterised from it, so change the SVG and re-render the PNGs together. Under custom branding the backend rewrites `/manifest.webmanifest` (name + icons → `/api/branding/icon`) so an installed app carries the operator's mark.

## Mandatory UI rule

Any change under `admin/frontend/src/pages/` or `admin/frontend/src/components/` must comply with `admin/frontend/MOBILE_FIRST.md` — it is a merge gate, not a suggestion. Key rules: default Tailwind breakpoints only; grids collapse to one column on mobile (`grid-cols-1 sm:grid-cols-2 …`); touch targets ≥44×44px; dialogs must be completable on a 360px screen (full-screen on `<sm`); no fixed-width desktop-only layouts. Complete its pre-merge checklist (render at 360/375/768, horizontal-scroll audit). Reference implementations: `Dashboard.jsx`, `LxcContainers.jsx`, `Users.jsx`, `Profile.jsx`, `Login.jsx`.

## Gotchas

- `docs/known-issues.md` is the punch list of parked follow-ups; check it before diagnosing "broken" behavior.
- **Storage tools never touch a device outside a confirmed plan.** Devices are `/dev/disk/by-id` whole disks only; the OS device (backing `/`, `/boot`, swap — resolved through findmnt + lsblk holders) is refused with no override; mounted / in-pool / md-LVM-held disks are refused; other signatures need `wipe: true`. Don't add a storage verb that bypasses `lib/storage/planner.js` + `service.apply`.
- **Extended MCP surface (2026-09):** the 174 tools beyond the original 72 live in `admin/backend/src/routes/mcp-tools/*.js` (one file per family: builds, project-config, lxc-admin, edge, static-admin, admin, self-edit, storage, migration), get their private helpers from `routes/mcp.js` through a `ctx` object (never by importing it), and are catalogued in `lib/mcp-ext/catalog/`. `lib/mcp-ext/logic.js` is the pure layer (confirmation tokens, key scopes, redaction, validators); `lib/mcp-policy/mcp-extended-policy.json` is the enforcement source (feature flags, host-unit and apt allowlists, device roots, writable settings). Every write goes through `kit.mutation(...)`, which writes the `mcp_ledger` row (migration 904), the audit entry and the project change record itself. Migrations 903–907 belong to it. Doc: `docs/features/mcp.md` § "The extended surface"; tests: `mcp-extended.test.js`.
- `admin/backend/src/mock2/framework-seed/` is ProxyPilot's rendering of the **Mock2 standards** (git.fractionate.ai/mock2/mock2-core, served at mock2.fractionate.ai) and **CPR v1.1** (`framework-seed/cpr/`). The site is the human-edited source; a seed edit publishes a new framework version on the next boot. Procedure and the standards ↔ platform mapping: `docs/mock2/standards-and-cpr.md`.
- `LEARNINGS.md` is the harness ratchet registry: every human-caught defect in generated output must be triaged into a template, a rule, or a machine check and recorded there (see its triage guidance). `HARNESS-INVESTIGATION.md` holds the evidence method.
- Self-update (`docs/features/self-update.md`): the dashboard's Update button and the `run_proxypilot_update` MCP tool never run `update.sh` from the backend (it dies at `docker compose down`) or the agent (unprivileged); they drop a request file for the root systemd oneshot in `deploy/proxypilot-update.{path,service}` → `scripts/update-runner.sh`, which runs `update.sh --yes`. The git checkout is NOT `/opt/proxypilot` (install.sh copies into it); the runner reads the recorded `source-dir`. Flags are allowlisted in three places (agent, runner, backend) — keep them in step; `--discard-local` is never allowed there.
- Operator scripts (`install.sh`, `update.sh`) are large and load-bearing — `update.sh` handles DB backup/restore guards and retro-fits config (e.g., WireGuard MTU via `scripts/patch-wg-mtu.sh`). Generated WireGuard configs pin MTU 1280, overridable via `PROXYPILOT_VPN_MTU`.
- `var/lib/` in the repo mirrors runtime state layout (`/var/lib/proxypilot/` on a real install: backups, inventory, CVE inbox).
- Deeper feature docs live in `docs/features/` (terminal, backups, security) and `docs/core/` (architecture, phase plans).
