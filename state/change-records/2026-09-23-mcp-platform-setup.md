# Change record — Platform Setup (Full Platform) over MCP, and reset (2026-09-23)

Branch `claude/mcp-platform-setup-tools-sny7bk` · size L · against the release installed from PR #620 · author: Claude Code session for Thomas@tagarmor.com

## Ask

Make Platform Setup reachable over MCP: read the full setup state and the next
required action, save and apply the plan, continue after a failure, repair /
reinstall / remove owned services, and reset the setup (new capability, also on
the dashboard). Every human step named with where to do it; revealing
credentials, password entry, bootstrap retirement, SSO activation and secret
input stay dashboard-only.

## What changed

| Area | Files | Notes |
|---|---|---|
| Read model | `lib/setup-engine/full-platform-mcp.js` (new) | `platformSetupView` (steps 1–6, operation + service jobs, failures with job / `reason_code` / plain reason / classified remedy, observer status, ordered `next_actions`, `human_only`), `platformServiceView`, jobs with redacted event tail, `evaluatePreflight`, the apply/continue/retry refusals, and `scrubKnownSecrets` (every protected value the install holds is scrubbed from every platform tool result) |
| Reset | `lib/setup-engine/full-platform-reset.js` (new), `full-platform-op.js`, `full-platform-store.js`, `logic.js`, `setup-logic.js`, `backend-steps.js`, `mock2/ops.js` | `resetReview` (preview + digest over the exact inventory), `queueReset` (a `full_platform_apply` job, operation `reset`), `runReset` (runner: ownership of every container/volume/network/marker established first; purge = stop → backup set → verify → delete), `removeResetRoutes` (new backend step kind `remove_platform_routes`, app `pp-platform-reset-routes`) |
| Shared helper | `lib/setup-engine/full-platform-lifecycle.js` | container removal factored into `removeOwnedContainers` / `readOwnedMarker` / `ownedRoot`, used by both runtime actions and reset. `queueLifecycle` and `applyFullPlatform` take `{ via }` |
| MCP | `routes/mcp-tools/platform.js` (new), `routes/mcp-tools/index.js`, `lib/mcp-ext/catalog/platform.js` (new), `catalog/index.js`, `lib/mcp-policy/mcp-extended-policy.json` | 10 tools; flags `mcp.platform` (all), `mcp.destructive` (manage/reset), `mcp.platform.purge` (default OFF). 177 → 187 extended tools |
| Dashboard | `routes/full-platform.js`, `components/PlatformReset.jsx` (new), `pages/PlatformSetup.jsx`, `lib/api.js` | `POST /api/setup/platform/full/reset/review` (inert) and `/reset` (sudo + fresh local proof); Custom / Advanced → Reset Full Platform |
| Tests | `__tests__/full-platform-mcp.test.js` (new, 13 cases), `mcp-extended.test.js` | |
| Docs / state | `docs/features/full-platform-setup.md` (reset section replaces "There is no data-delete/reset"; "Over MCP"), `docs/features/mcp.md`, `docs/known-issues.md`, `CLAUDE.md`, `state/work.md` | |

## Defects found on the way

- **IN SCOPE, fixed:** the PR #620 runtime-action code resolved the service root as
  `roots[service] || { keycloak: join(KEYCLOAK_ROOT, row.id || ''), … }[service]`.
  The object literal is built eagerly; for every non-Keycloak row `id` is the
  integer `1`, so `join` throws `ERR_INVALID_ARG_TYPE`. Repair / Reinstall /
  Remove of Pomerium, Infisical, OpenBao and Vaultwarden could not run on a real
  host (the tests always passed a `roots` override). Reproduced against the base
  expression, fixed in `ownedRoot`, pinned by a regression test.
- **IN SCOPE, fixed before merge:** the first reset draft checked container
  ownership labels service by service, so a foreign container in a later service
  was found after earlier services were already removed. All labels are now
  checked before the first stop (test: "reset refuses foreign ownership").
- **IN SCOPE, fixed before merge:** importing `full-platform-store.js` from
  `backend-steps.js` added a `backend.js ↔ backend-steps.js` import cycle and
  broke 7 `guided-sso.test.js` cases through module evaluation order; the step
  reads the row directly instead.
- **FOLLOW-UP:** the two Full Platform items added to `docs/known-issues.md`
  (Custom plan save wedges the coordinator; service records exist before the
  observer).

## What ran where

- **Scripted only (this repository, `node --test`):** every tool against the
  production stores on real SQLite; the coordinator against the scripted
  Keycloak wire; reset default and purge against an in-memory Docker inventory
  with **real** `tar` archives and sha256 verification in a temp dir; the
  backend route step with a stub Caddy renderer; the dashboard endpoints over
  real HTTP/auth/CSRF/sudo/local-proof; the Reset control rendered in Chromium at
  360/375/768 px on the built frontend (no horizontal overflow, no button under
  44 px).
- **Real host (read-only, through the installed ProxyPilot MCP):** audit log and
  route inventory used for the observer finding (see `state/work.md`). The new
  tools are **not** deployed there yet; nothing was changed on the host.
