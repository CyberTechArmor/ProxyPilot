<!-- New phase added after the initial split -->
<!-- Index: docs/core/plan/README.md -->

## Phase 2: Multi-Service Path-Prefix Routing

**Goal:** Allow multiple services to share the same domain on different URL path prefixes. This is the natural follow-up to the wildcard/path-prefix groundwork in commit `be3f81d`. Today a service can own `example.com` with an optional path scope, but the `services.domain` UNIQUE constraint prevents a second service from claiming a different prefix on the same domain. After this phase, the operator can run `example.com/` on a static frontend, `example.com/api` on a reverse-proxied backend, and `example.com/admin` on a Docker container — all three managed as independent services with their own certs, settings, and audit history.

**Scope note:** Frontend + backend only. No core infrastructure scope (Postgres, Infisical, SSH, etc.) is touched here. This phase depends on Phase 1 only for the Add Service wizard UI polish — the backend work is independent.

**Files to edit:**
```
admin/backend/src/db.js                          # Table rebuild: drop UNIQUE(domain), add UNIQUE(domain, path_prefix)
admin/backend/src/routes/services.js             # Refactor Caddy generator to merge all services on a domain into one site block
admin/frontend/src/pages/Dashboard.jsx           # Loosen uniqueness validation, show existing prefixes, allow "Add service to existing domain"
admin/frontend/src/lib/api.js                    # (if the client caches by domain — audit and fix)
```

**Deliverables:**

- **Schema migration (`db.js`):**
  - Detect whether the current `services` table still has `domain TEXT UNIQUE NOT NULL` by inspecting `sqlite_master.sql`.
  - If yes, run a table-rebuild inside a transaction: create `services_new` with `UNIQUE(domain, path_prefix)` and all existing columns preserved, copy every row (path_prefix defaulting to `/` for any NULLs), `DROP TABLE services`, `ALTER TABLE services_new RENAME TO services`.
  - Foreign keys referencing `services.id` (user_service_access, file_versions, service_config_versions) survive the rebuild because SQLite FKs are not enforced (no `PRAGMA foreign_keys = ON`) — but the migration must regenerate those indexes after the rename so lookups stay fast.
  - Idempotent: running twice is a no-op.
- **Per-domain Caddy config generator (`services.js`):**
  - New helper `regenerateDomainCaddyConfig(db, domain)` that:
    1. Queries every service where `domain = ?` ordered by `path_prefix` length DESC (more specific paths first).
    2. Generates a single site block: one `handle_path ${prefix}*` per prefixed service, and one `handle { ... }` (unprefixed) for the root-scoped service, if any.
    3. Writes the merged config to `caddyFilePath(domain)`. If no services remain, `unlink` the file.
    4. Merges site-level settings: `request_body max_size` takes the maximum of all services, `log` filename stays keyed on domain, security headers stay common.
  - New helper `caddyFilePath(domain)` already exists from commit `be3f81d`. No rename.
  - Retire the current per-service `generateCaddyConfig(service)` call sites — they become `regenerateDomainCaddyConfig(db, service.domain)` invocations. There are 9 call sites today (create, update, update with domain change, SSL enable, SSL disable, regenerate all, revert config, import services, import discovered site). Each one gets a single-line substitution.
  - Delete endpoint: after `DELETE FROM services WHERE id = ?`, call `regenerateDomainCaddyConfig(db, service.domain)` so the remaining services on that domain survive with their own file.
- **Uniqueness validation (`services.js`):**
  - Create endpoint: replace `SELECT id FROM services WHERE domain = ?` with `SELECT id FROM services WHERE domain = ? AND path_prefix = ?`. Error message becomes "Domain + path prefix combination already exists".
  - Update endpoint: same substitution, plus ensure the update does not create a (domain, path_prefix) collision with a different service id.
- **Caddyfile ordering:**
  - Caddy matches `handle_path` blocks in source order, so the generator must emit them from most-specific to least-specific. A service with `/api/v2` comes before `/api`, which comes before the root handler.
  - If two services have the same path prefix (which should be blocked by the unique constraint), the generator must refuse to emit and log an error.
- **Frontend (`Dashboard.jsx`):**
  - Add Service wizard: after the operator types a domain that already exists, surface a blue info banner: "Domain already in use. Existing path prefixes: /, /api. Choose a different prefix to add a second service to this domain."
  - Client-side validation: accept a create that reuses the domain as long as the path prefix differs from every existing entry for that domain.
  - Service list rendering: group services by domain in the sort-by-favorite view, so operators can see "3 services on example.com" together.
  - Delete confirmation: warn "This will leave N other services running on example.com" when applicable.
- **Mobile-first UI (per the cross-cutting rule in [`README.md`](README.md#cross-cutting-rule-mobile-first-ui)):**
  - Follow [`admin/frontend/MOBILE_FIRST.md`](../../../admin/frontend/MOBILE_FIRST.md) for every Dashboard change above.
  - The "Domain already in use" info banner must wrap (`flex-wrap` or block) and remain readable at 360px — no fixed width, no `whitespace-nowrap` on the prefix list.
  - The domain-grouped service list must still stack to one card per row at `<sm` (respect the existing `grid-cols-1 sm:grid-cols-2 lg:grid-cols-3` pattern on the services grid); the group header row must wrap so "3 services on example.com" does not overflow.
  - The delete confirmation "This will leave N other services running on example.com" warning must render inside the existing full-screen-on-`<sm` delete dialog without adding fixed widths.
  - Do not introduce any new `grid-cols-N` without a `grid-cols-1` base, any new `max-w-md`/`max-w-lg`/`max-w-4xl` on a `DialogContent` without the `max-w-full h-full rounded-none sm:…` prefix, or any new primary action `Button size="icon"` under 44px on mobile.
  - Before marking the phase complete, run `npm run dev` and load the Dashboard at 360px in Chrome DevTools — confirm the Add Service wizard's info banner wraps, the grouped service list stacks, and the delete dialog fits. `vite build` passing is not sufficient evidence; the Phase 1 cn-import regression proved that.
- **Export/import:** `serviceExport` already includes `pathPrefix` from commit `be3f81d`. Verify the import path now accepts multiple services per domain without the old uniqueness check.
- **Audit log:** no schema change — existing `SERVICE_CREATED` / `SERVICE_UPDATED` / `SERVICE_DELETED` entries already include the domain in `details`. Add `pathPrefix` to the details payload for disambiguation.

**Spec references:** Primarily [`../prompt/20-database-management.md`](../prompt/20-database-management.md) (not directly related but read for SQLite-migration patterns). The wildcard/path-prefix groundwork in `admin/backend/src/routes/services.js` lines 119–147 (DOMAIN_REGEX, PATH_PREFIX_REGEX, normalizePathPrefix, caddyFileName, caddyFilePath) is the foundation this phase builds on.

**Verification:**
- [ ] Fresh install: schema rebuild runs cleanly, table now has `UNIQUE(domain, path_prefix)` and not `UNIQUE(domain)`
- [ ] Existing install: migration preserves every existing service row with `path_prefix = '/'` and does not lose data
- [ ] Create `frontend` service at `example.com` path `/`, then create `backend` service at `example.com` path `/api` — both succeed
- [ ] `curl https://example.com/` hits the frontend service, `curl https://example.com/api/users` hits the backend service
- [ ] `curl https://example.com/unknown` returns 404 (not crashes, not a misrouted handler)
- [ ] Delete the `backend` service: Caddy file for `example.com` is rewritten with only the frontend, backend is unreachable, frontend still works
- [ ] Delete the last service on `example.com`: Caddy file is unlinked, reload succeeds
- [ ] Attempt to create a second service at `example.com` path `/`: rejected with "Domain + path prefix combination already exists"
- [ ] Attempt to create at `example.com` path `/api/v2` after `example.com` path `/api` exists: succeeds, and `/api/v2/foo` routes to the more-specific service (not the `/api` one)
- [ ] Export both services, wipe the DB, import: both restore with correct prefixes
- [ ] Wildcard domains from Phase 0 groundwork still work: `*.example.com` continues to serve on `http://` with the existing single-service behavior
- [ ] Service list UI groups services by domain
- [ ] Add Service wizard shows existing path prefixes when the typed domain is in use
- [ ] Audit log entries include `pathPrefix` in the details JSON
- [ ] Caddy `adapt` validates every generated merged config — no syntax errors, no duplicate site addresses
- [ ] **Mobile:** Add Service wizard + "Domain already in use" info banner render at 360px with zero horizontal scroll; the new wizard flow is completable end-to-end on a 375px viewport
- [ ] **Mobile:** Service list grouping by domain still stacks to one card per row at `<sm` — no regression from Phase 1's `grid-cols-1 sm:grid-cols-2 lg:grid-cols-3`
- [ ] **Mobile:** Delete confirmation "This will leave N other services running" warning fits inside the full-screen-on-`<sm` delete dialog without overflow
- [ ] **Mobile:** `npm run dev` load of `/` at 360px shows no runtime errors in the console (not just a clean `vite build`)

**Commit:** `phase-02: multi-service path routing - multiple services per domain via handle_path`

---

## Function-by-Function Checklist (to be populated)

> This section is a placeholder. The next planning session will decompose the phase deliverables into a per-function checklist: one function → implement → test → check off → move on. Each function gets its own line with a checkbox, the file it lives in, and a one-line success criterion. Do not populate this now — leave the placeholder in place.

- [ ] _pending_
