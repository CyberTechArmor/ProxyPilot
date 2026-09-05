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

**CVE engine:** Python engine maintains an inventory and polls feeds via systemd timers; CVE entries land as YAMLs in `/var/lib/proxypilot/inbox/`, the backend reads/acts on them and can invoke `run-one`. A state machine classifies remediation as AUTO_PATCH vs. operator-driven.

## Mandatory UI rule

Any change under `admin/frontend/src/pages/` or `admin/frontend/src/components/` must comply with `admin/frontend/MOBILE_FIRST.md` — it is a merge gate, not a suggestion. Key rules: default Tailwind breakpoints only; grids collapse to one column on mobile (`grid-cols-1 sm:grid-cols-2 …`); touch targets ≥44×44px; dialogs must be completable on a 360px screen (full-screen on `<sm`); no fixed-width desktop-only layouts. Complete its pre-merge checklist (render at 360/375/768, horizontal-scroll audit). Reference implementations: `Dashboard.jsx`, `LxcContainers.jsx`, `Users.jsx`, `Profile.jsx`, `Login.jsx`.

## Gotchas

- `docs/known-issues.md` is the punch list of parked follow-ups; check it before diagnosing "broken" behavior.
- `admin/backend/src/mock2/framework-seed/` is ProxyPilot's rendering of the **Mock2 standards** (git.fractionate.ai/mock2/mock2-core, served at mock2.fractionate.ai) and **CPR v1.1** (`framework-seed/cpr/`). The site is the human-edited source; a seed edit publishes a new framework version on the next boot. Procedure and the standards ↔ platform mapping: `docs/mock2/standards-and-cpr.md`.
- `LEARNINGS.md` is the harness ratchet registry: every human-caught defect in generated output must be triaged into a template, a rule, or a machine check and recorded there (see its triage guidance). `HARNESS-INVESTIGATION.md` holds the evidence method.
- Self-update (`docs/features/self-update.md`): the dashboard's Update button and the `run_proxypilot_update` MCP tool never run `update.sh` from the backend (it dies at `docker compose down`) or the agent (unprivileged); they drop a request file for the root systemd oneshot in `deploy/proxypilot-update.{path,service}` → `scripts/update-runner.sh`, which runs `update.sh --yes`. The git checkout is NOT `/opt/proxypilot` (install.sh copies into it); the runner reads the recorded `source-dir`. Flags are allowlisted in three places (agent, runner, backend) — keep them in step; `--discard-local` is never allowed there.
- Operator scripts (`install.sh`, `update.sh`) are large and load-bearing — `update.sh` handles DB backup/restore guards and retro-fits config (e.g., WireGuard MTU via `scripts/patch-wg-mtu.sh`). Generated WireGuard configs pin MTU 1280, overridable via `PROXYPILOT_VPN_MTU`.
- `var/lib/` in the repo mirrors runtime state layout (`/var/lib/proxypilot/` on a real install: backups, inventory, CVE inbox).
- Deeper feature docs live in `docs/features/` (terminal, backups, security) and `docs/core/` (architecture, phase plans).
