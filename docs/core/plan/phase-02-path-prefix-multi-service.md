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

**Commit:** `phase-02: multi-service path routing - multiple services per domain via handle_path`

---

## Function-by-Function Checklist

> Ordered backend-first: schema migration → Caddy generator refactor → call-site substitutions → uniqueness validation → frontend polish → mobile verification. One checkbox = one commit. Each item must be verified in `npm run dev` and a real browser (for frontend items) or via a backend smoke test (for backend items) before it is ticked off.

### A. Backend — Schema migration (runs first; unblocks everything else)

- [x] `initDatabase` services CREATE TABLE (admin/backend/src/db.js:111)
      — Update the fresh-install `CREATE TABLE IF NOT EXISTS services` definition so that `domain` is `TEXT NOT NULL` (not `UNIQUE`) and the table ends with `UNIQUE(domain, path_prefix)`. Leave `path_prefix TEXT NOT NULL DEFAULT '/'` in place. Existing installs still need the rebuild migration below; this change only covers clean databases. **Verified:** fresh-init smoke test confirms the new table SQL, two-row insert at `/` + `/api` succeeds, duplicate `/` tuple rejected with `UNIQUE constraint failed: services.domain, services.path_prefix`.

- [x] `migrateServicesUniqueConstraint(db)` helper (admin/backend/src/db.js, new export)
      — Inspect `SELECT sql FROM sqlite_master WHERE type='table' AND name='services'`. If the string contains `UNIQUE(domain, path_prefix)`, return early (idempotent no-op). Otherwise run a table-rebuild inside `db.transaction`: `CREATE TABLE services_new (...)` mirroring all current columns + `UNIQUE(domain, path_prefix)`, `INSERT INTO services_new SELECT id, name, domain, type, target, port, root_dir, container_name, ssl_enabled, force_https, websocket_enabled, max_upload_size, data_dir, status, is_admin, created_at, updated_at, is_favorite, COALESCE(path_prefix, '/') FROM services`, `DROP TABLE services`, `ALTER TABLE services_new RENAME TO services`, then `CREATE UNIQUE INDEX IF NOT EXISTS idx_services_domain_path ON services(domain, path_prefix)` so lookups on the new tuple stay fast. Logs `console.log('Migrated services table: UNIQUE(domain) → UNIQUE(domain, path_prefix)')`. **Verified:** seeded a pre-Phase-2 DB with old `UNIQUE(domain)` schema and two rows, ran the helper, confirmed (a) rows preserved with `path_prefix='/'`, (b) new UNIQUE tuple present, (c) old `UNIQUE(domain)` gone, (d) duplicate `/` tuple rejected, (e) `/api` sibling accepted, (f) second run is a no-op, (g) `idx_services_domain_path` index created.

- [x] Wire `migrateServicesUniqueConstraint(db)` into `initDatabase()` (admin/backend/src/db.js:154)
      — Call the helper immediately after the existing `ALTER TABLE services ADD COLUMN path_prefix` try/catch block so the column exists before the rebuild references it. Success criterion: fresh install leaves the table with `UNIQUE(domain, path_prefix)`; an existing install with pre-Phase-2 `UNIQUE(domain)` is rebuilt preserving every row; running `initDatabase()` a second time is a no-op. **Verified:** fresh DB init produces the new schema; a seeded old DB (UNIQUE(domain) + two rows) migrates during `initDatabase()` with both rows intact at `path_prefix='/'`; second `initDatabase()` call logs "Database initialized" without re-running the migration.

### B. Backend — Per-domain Caddy generator

- [x] Extract `generateServiceHandlerBody(service, indent)` helper (admin/backend/src/routes/services.js:3134, new function just above `generateCaddyConfig`)
      — Pure function returning only the per-service body lines (`reverse_proxy` for docker/proxy, `root`/`file_server`/`try_files` for static), with an `indent` arg so callers can nest the body inside a `handle_path` block (indent `'        '`) or emit it bare at the site level (indent `'    '`). Path-prefix wrapping stays in `generateCaddyConfig` (and later in `buildDomainCaddyConfig`) — this helper is just the leaves. SSL is already handled via the site address, so no SSL arg is needed. **Verified:** inline golden-snapshot test (pre-refactor monolithic generator vs refactored `generateCaddyConfig` calling the new helper) matches byte-for-byte across four representative cases: static root, docker `/api`, wildcard http fallback, and plain no-SSL.

- [x] `buildDomainCaddyConfig(servicesList, domain)` helper (admin/backend/src/routes/services.js:3127, new function)
      — Pure function: given a list of service rows for one domain (already in the wanted post-operation state) plus the domain, returns the full merged Caddy config string (or `null` for an empty list, so the caller can `unlink` the file). Internally sorts by `length(path_prefix) DESC` then lexical DESC so more-specific prefixes emit first. Normalizes snake_case/camelCase input so DB rows and in-memory objects both work. Computes site-level decisions: siteAddress is `http://${domain}` when the domain is a wildcard OR SSL is off, otherwise plain `${domain}`. `request_body max_size` takes the max of all services' `maxUploadSize` via a small `parseUploadSizeMB` comparator. Emits one `handle_path ${prefix}*` per prefixed service, then a single `handle { ... }` for the root-scoped service if present. Emits common security headers and a single `log { output file /var/log/caddy/${caddyFileName(domain)}.log }`. Throws `Duplicate (domain, path_prefix) tuple detected for ...` when two services on the list share the same normalized prefix. **Verified:** seven inline snapshot tests — (1) single root static emits `handle { ... }`, (2) root + `/api` emits `handle_path /api*` first then root, (3) `/api/v2 + /api + /` specificity ordering correct, (4) wildcard domain falls back to `http://*.example.com`, (5) duplicate tuples throw, (6) empty list returns `null`, (7) `max_size` across services = `2GB` when mixing `100M` and `2G`.

- [x] `regenerateDomainCaddyConfig(db, domain)` helper (admin/backend/src/routes/services.js:3163, new async function)
      — Queries `SELECT ... FROM services WHERE domain = ? AND is_admin = 0` (admin services are installer-owned and must not be regenerated), hands the rows to `buildDomainCaddyConfig`, and either `writeCaddyConfig`s the result or `unlink`s the on-disk file when the list is empty. Calls `ensureCaddyStructure` before writing so fresh installs don't fail on a missing sites directory. Exported as a named export so integration tests and later verification steps can invoke it directly. **Verified:** integration test with a real SQLite DB + temp `CADDY_SITES_DIR` — seeded two services on `example.com` (`/` static root, `/api` docker port 3000, different maxUploadSize), called the helper, confirmed: (a) the merged file was written, (b) `handle_path /api*` appears before `handle { ... }`, (c) `max_size 2GB` (max across services), (d) after deleting both services from the DB and calling the helper again, the file is unlinked from disk.

- [x] Call site 1: `POST /:id/obtain-certificate` (admin/backend/src/routes/services.js:277)
      — After the `UPDATE services SET ssl_enabled = 1 ...` runs, replace the `generateCaddyConfig(serviceConfig)` + `writeCaddyConfig(configPath, caddyConfig)` pair with a single `await regenerateDomainCaddyConfig(db, service.domain)`. Keep the subsequent `reloadCaddy()` call. Remove the now-unused local `serviceConfig` object. **Verified:** integration test — two services seeded with `ssl_enabled=0` produce `http://example.com {` merged config; after flipping both rows to `ssl_enabled=1` and calling `regenerateDomainCaddyConfig`, the merged file switches to plain `example.com {` (Caddy auto-TLS path).

- [x] Call site 2: `DELETE /:id/certificate` (admin/backend/src/routes/services.js:344)
      — Same substitution as call site 1, after the `UPDATE services SET ssl_enabled = 0 ...` statement. **Verified:** integration test — seed an ssl_enabled=1 service, confirm merged file uses `example.com {`, flip ssl_enabled=0 + call regenerate, confirm merged file now uses `http://example.com {`.

- [x] Call site 3: `POST /:id/regenerate-config` (admin/backend/src/routes/services.js:385)
      — Replace the `generateCaddyConfig(serviceConfig)` + write with `await regenerateDomainCaddyConfig(db, service.domain)`. **Verified:** integration test — seeded two services on `ex.test` (`/` static, `/api` docker) and called the helper; confirmed merged file contains both a `handle_path /api*` block and a `handle {` root block inside a single `ex.test {` site block.

- [x] Call site 4: `POST /caddy/regenerate-all` loop (admin/backend/src/routes/services.js:419)
      — Replace the per-service Caddy write inside `for (const service of services) { ... }` with a dedupe pass: collect `uniqueDomains = new Set(services.filter(s => !s.is_admin).map(s => s.domain))`, then `for (const domain of uniqueDomains) await regenerateDomainCaddyConfig(db, domain)`. Keep the backup/revert logic unchanged (it already keys on filenames, which still line up with domains). Update `results.success` to record each domain once instead of each service. Admin domains are reported as skipped in the results list. **Verified:** integration test — seeded 4 services across 3 domains (2 on `ex1.com`, 1 on `ex2.com`, 1 admin on `admin.com`); confirmed `uniqueDomains = ['ex1.com', 'ex2.com']`, only those two files are written, `ex1.com` has exactly one `ex1.com {` site block containing both `handle_path /api*` and root `handle {`, `admin.com` file is not created.

- [x] Call site 5: `POST /` create (admin/backend/src/routes/services.js:656)
      — Reordered so the DB insert happens *before* the Caddy write: backup the current merged file (if any), INSERT the row, call `regenerateDomainCaddyConfig(db, data.domain)`, run `caddy adapt`, then `reloadCaddy()`. On any failure the new `rollbackCreate()` local helper deletes the inserted row and restores the backed-up merged file (or unlinks it if the file did not exist before). Keeps the data-directory + initial file creation as-is. **Verified:** end-to-end Express integration test with stub caddy binary on PATH — POSTed `{name, domain: 'fresh.test', pathPrefix: '/', type: 'static'}`, got 201 Created, confirmed the DB row exists and the merged file at `CADDY_SITES_DIR/fresh.test` contains the expected `fresh.test {` site block with a root `handle {`.

- [x] Call site 6: `PUT /:id` update (admin/backend/src/routes/services.js:893)
      — Backup the merged file for the new domain (and the old domain if it changed), snapshot the pre-update row, update the DB row first, call `regenerateDomainCaddyConfig(db, updatedData.domain)` (and for the old domain when the domain changed), adapt + reload, and on any failure `rollbackUpdate()` restores both the DB row and both merged files. The now-dead `unlink(caddyFilePath(service.domain))` at the top of the old update flow is gone — the regenerate call handles old-domain shrinking naturally. **Verified:** Express integration test — seeded two services on `mul.test` (`/` and `/api`), PUT `/api/services/s2 { port: 3001 }` returned 200 with the merged `mul.test` file swapping 3000→3001 and the DB row updated; PUT `/api/services/s2 { domain: 'other.test' }` returned 200, the new `other.test` file contains the `/api` handler, and the old `mul.test` file shrank to just the root handle.

- [x] Call site 7: `POST /:id/revert-config/:versionId` (admin/backend/src/routes/services.js:1142)
      — Moved the `UPDATE services SET ...` that applies the reverted row *before* the Caddy regeneration, then replaced the `generateCaddyConfig(config)` + write with `await regenerateDomainCaddyConfig(db, config.domain)`. Kept the `caddy adapt` + `reloadCaddy()` sequence. **Verified:** integration test — seeded s2 at port 3000 on `rev.test/api`, saved as version v1, changed live port to 9999, called `POST /api/services/s2/revert-config/v1`, got 200, confirmed DB row port flipped back to 3000 AND merged file contains 3000, not 9999, with the sibling root service still on port 4000.

- [x] Call site 8: `POST /import` loop (admin/backend/src/routes/services.js:2011)
      — Flipped the existence check to match on `(domain, path_prefix)` so siblings on the same domain can be imported together (previously all but the first row on a domain were rejected). Overwrite now deletes only the matching `(domain, prefix)` row — the old `unlink(caddyFilePath(serviceData.domain))` that wiped the entire domain file is gone, siblings survive. Inside the loop we only INSERT; after the loop we iterate `touchedDomains` (a Set collected during the loop) and call `regenerateDomainCaddyConfig(db, domain)` once per distinct domain so the merged file reflects the final post-import state. Loop-level `reloadCaddy()` at the end is unchanged. **Verified:** Express integration test — imported two services on `imp.test` (`/` port 8000 + `/api` port 8001) in one request, got 200 with `imported: 2`, confirmed merged file contains both; then imported `{ /api port 9000 }` with `overwrite: true`, got 200, confirmed `/api` flipped to 9000 and the root `/` service on port 8000 survived.

- [x] Call site 9: `POST /discover/import` (admin/backend/src/routes/services.js:3038)
      — After the `INSERT INTO services` for the discovered site, replaced `generateCaddyConfig(serviceConfig)` + write with `await regenerateDomainCaddyConfig(db, domain)`. Kept the surrounding try/catch, `caddy adapt`, and `reloadCaddy()`. **Verified:** `grep generateCaddyConfig admin/backend/src/routes/services.js` now shows only the function definition at line 3459 — zero call sites remain — and the module loads cleanly with named exports `{ buildDomainCaddyConfig, generateServiceHandlerBody, regenerateDomainCaddyConfig, servicesRouter }`.

- [x] `DELETE /:id` endpoint (admin/backend/src/routes/services.js:1326)
      — Reordered so `DELETE FROM services WHERE id = ?` runs first, then `regenerateDomainCaddyConfig(db, service.domain)` writes or unlinks the merged file based on the new DB state. The old bare `unlink(caddyFilePath(service.domain))` is gone so sibling services on the same domain survive a delete. **Verified:** Express integration test — seeded two services on `del.test` (`/` port 4000, `/api` port 3000), DELETEd the `/api` row, got 200 with the merged file still present, containing the root `handle {` at port 4000 and no trace of `/api` or port 3000; DELETEd the last remaining row, got 200, confirmed the merged file at `CADDY_SITES_DIR/del.test` was unlinked.

- [ ] Retire `generateCaddyConfig(service)` (admin/backend/src/routes/services.js:3127)
      — Once all nine call sites have been flipped, delete the old single-service function definition. `grep generateCaddyConfig admin/backend/src/routes/services.js` returns zero matches. `generateServiceHandlerLines` + `buildDomainCaddyConfig` are the only path.

### C. Backend — Uniqueness validation

- [ ] Create endpoint uniqueness check (admin/backend/src/routes/services.js:718)
      — Replace `SELECT id FROM services WHERE domain = ?` with `SELECT id FROM services WHERE domain = ? AND path_prefix = ?`, binding the normalized `data.pathPrefix`. Error message becomes `'Domain + path prefix combination already exists'`. Normalization already happens on line 714 via `normalizePathPrefix`.

- [ ] Update endpoint uniqueness check (admin/backend/src/routes/services.js:909)
      — The existing check only fires when `data.domain !== service.domain`. Broaden it so the check also fires when `data.pathPrefix !== service.path_prefix`. Replace the `SELECT id FROM services WHERE domain = ? AND id != ?` query with `SELECT id FROM services WHERE domain = ? AND path_prefix = ? AND id != ?`, binding the final normalized `updatedData.domain` and `updatedData.pathPrefix`. Same error message. Success criterion: editing the `/api` service to use prefix `/` on the same domain fails when a `/` sibling already exists.

- [ ] SSL-consistency validation on create + update (admin/backend/src/routes/services.js:709 and :894)
      — Per design decision 2 (all-or-nothing per domain), a new service cannot be created on a domain whose existing siblings disagree on `sslEnabled` (and `forceHttps`). In the create endpoint, after the uniqueness check: `SELECT ssl_enabled, force_https FROM services WHERE domain = ? LIMIT 1` — if a sibling exists and `!!row.ssl_enabled !== data.sslEnabled` (or `!!row.force_https !== data.forceHttps`), reject with 400 and `'All services on this domain must share the same SSL settings (sslEnabled, forceHttps). Existing siblings use sslEnabled=<X>, forceHttps=<Y>.'`. In the update endpoint, perform the same check against `WHERE domain = ? AND id != ?`. Ensures the merged site block has one unambiguous SSL decision.

### D. Backend — Audit log disambiguation

- [ ] `SERVICE_DELETED` audit detail payload (admin/backend/src/routes/services.js:1303)
      — Change `{ domain: service.domain }` to `{ domain: service.domain, pathPrefix: service.path_prefix }`. `SERVICE_CREATED` already passes the full `data` object (includes `pathPrefix`); `SERVICE_UPDATED` already passes `updatedData` (includes `pathPrefix`). Verify both by re-reading the log after one create + one update in dev.

### E. Frontend — Dashboard wizard UX (mobile-first)

- [ ] `existingPrefixesForDomain` memo in Dashboard (admin/frontend/src/pages/Dashboard.jsx, near line 470 with the other memos)
      — Add `const existingPrefixesForDomain = useMemo(() => { const d = (formData.domain || '').toLowerCase().trim(); if (!d) return []; return services.filter(s => s.domain.toLowerCase() === d).map(s => s.pathPrefix || '/'); }, [services, formData.domain]);`. Used by the info banner and the submit validation below.

- [ ] Info banner in Add Service wizard (admin/frontend/src/pages/Dashboard.jsx:2865, directly under the Path Prefix Input)
      — When `existingPrefixesForDomain.length > 0`, render a mobile-friendly banner: `<div className="rounded-md border border-blue-500/30 bg-blue-500/10 p-3 text-sm text-blue-600 dark:text-blue-300">Domain already in use. Existing path prefixes: <code className="font-mono">{existingPrefixesForDomain.join(', ')}</code>. Choose a different prefix to add a second service to this domain.</div>`. Full width, wraps cleanly at 360px. No fixed width.

- [ ] Client-side collision guard in `handleAddService` (admin/frontend/src/pages/Dashboard.jsx:767)
      — Before the `api.createService(submitData)` call, compute `const normalized = (formData.pathPrefix || '/').trim().replace(/\/+$/, '') || '/';` (mirrors backend `normalizePathPrefix`) and if `existingPrefixesForDomain.map(p => p.trim().replace(/\/+$/, '') || '/').includes(normalized)`, toast an error matching the backend message and bail. Keeps the UI honest if the user types a colliding prefix without leaving the field.

- [ ] Domain-grouped header row in the services grid (admin/frontend/src/pages/Dashboard.jsx:3386)
      — When `sortBy === 'favorite'` (the default), pre-compute `const serviceGroups = useMemo(...)` that groups `filteredServices` by `domain`, preserving the inherited favorite/newest ordering inside each group. Render the grid as a flat list but inject a mobile-first header row above each group with 2+ services: `<div className="col-span-1 sm:col-span-2 lg:col-span-3 text-xs font-medium text-muted-foreground flex items-center gap-2 mt-2 first:mt-0"><Globe className="h-3 w-3" />{group.length} services on <span className="font-mono">{group.domain}</span></div>`. Single-service domains render with no header. Must pass the 360px horizontal-scroll audit.

- [ ] Delete confirmation sibling warning (admin/frontend/src/pages/Dashboard.jsx:3790)
      — In the Delete Service `DialogDescription`, compute `const siblingsCount = serviceToDelete ? services.filter(s => s.domain === serviceToDelete.domain && s.id !== serviceToDelete.id).length : 0;` and when `> 0`, append `This will leave {siblingsCount} other service{siblingsCount === 1 ? '' : 's'} running on <code>{serviceToDelete.domain}</code>.` on a new line inside the description. Must render inside the mobile full-screen dialog without overflow.

### F. Frontend — api.js audit

- [ ] `admin/frontend/src/lib/api.js` per-domain caching audit
      — Re-read the file end-to-end and confirm nothing keys a cache by `domain`: the only domain reference today is `checkSslStatus(domain)`, which is a fire-and-forget request with no cache. No code change needed — the audit completion is a one-line comment above the `getServices` function: `// Services are identified by (id, domain+pathPrefix); api.js holds no per-domain state.` This item exists so there is a traceable commit confirming the file was audited.

### G. Verification (run in this order, one commit per fix if anything breaks)

- [ ] Fresh-install migration smoke test — delete the dev DB, run `npm run dev` on `admin/backend`, inspect `sqlite_master.sql` for `UNIQUE(domain, path_prefix)`; confirm no `UNIQUE(domain)`.

- [ ] Existing-install migration smoke test — seed a dev DB with the old schema and two rows (path_prefix NULL + '/'), run `initDatabase()`, confirm both rows survive with `path_prefix = '/'` and the new UNIQUE constraint is in place.

- [ ] Create two services on one domain — `POST /api/services` with `example.com` `/`, then with `example.com` `/api`. Both succeed. Inspect `/etc/caddy/sites/example.com`: contains `handle_path /api*` first, then the root handler, inside one site block.

- [ ] Routing check — `curl -s http://example.com/` hits the frontend handler; `curl -s http://example.com/api/users` hits the `/api` handler with the prefix stripped; `curl -s -o /dev/null -w "%{http_code}" http://example.com/unknown` returns 404.

- [ ] Duplicate rejection — attempt a second `example.com` `/` POST, confirm 400 with `"Domain + path prefix combination already exists"`.

- [ ] Prefix specificity — with `/api` in place, POST `/api/v2`, confirm `curl http://example.com/api/v2/foo` hits the `/api/v2` service. Inspect the merged config; `handle_path /api/v2*` comes before `handle_path /api*`.

- [ ] Sibling delete — delete the `/api` service, confirm the merged file rewrites to only `/` + `/api/v2`, both still reachable.

- [ ] Last-service delete — delete the remaining two, confirm `/etc/caddy/sites/example.com` is unlinked.

- [ ] Export/import round-trip — create two services on one domain, export, delete both, import, confirm both restore at their original prefixes and the merged Caddy file is regenerated.

- [ ] Wildcard regression — create a `*.example.com` service and a sibling on plain `example.com`. Confirm both files exist, the wildcard uses `http://` fallback, and the plain domain's merged file includes its services normally.

- [ ] Audit log payload — after one create, one update, one delete, inspect the audit table: `pathPrefix` is present in all three `details` JSON payloads.

- [ ] Caddy adapt validation — `caddy adapt --config /etc/caddy/Caddyfile` exits 0 with no syntax errors against every generated merged file. No duplicate site addresses.

- [ ] **Mobile: 360px horizontal-scroll audit on `/` (Dashboard)** — Chrome DevTools → 360×640, open the Add Service wizard, type an existing domain, confirm the blue info banner wraps cleanly and `document.documentElement.scrollWidth === document.documentElement.clientWidth`. Confirm the grouped-domain header row spans the full grid width without overflow.

- [ ] **Mobile: 360px Add Service wizard end-to-end** — at 360px, type a new domain, tap every field, submit via the footer Create button. The form must submit without the create button clipping, and the dialog must be closeable via the header X.

- [ ] **Mobile: 360px Delete Service confirmation** — open the delete dialog on a service whose domain has a sibling; confirm the `"This will leave N other services running on ..."` text wraps cleanly.

- [ ] **Mobile: 1280px desktop regression** — re-run the create/list/delete flow at 1280px, confirm the grouped-domain headers align with the grid, the info banner sits inside the dialog, and the Phase 1 baseline layout is unchanged (no new horizontal scroll, no squished cards).

- [ ] Mark Phase 2 ✅ in `docs/core/plan/README.md` Status section. Commit with `phase-02: mark phase complete`. Push.

- [ ] Update `docs/core/plan/NEXT-SESSION-PROMPT.md` to point at Phase 3 (Foundation — SQLite schema, config loader, systemd generator). Commit. Push. Stop.
