<!-- New phase added after Phase 2 to support container-as-service modeling -->
<!-- Index: docs/core/plan/README.md -->

## Phase 2b: Container-as-Service Data Model + Multiple HTTP Routes

**Goal:** Re-shape the `services` schema so a service represents one logical workload (typically an LXC or Docker container) that can expose **multiple HTTP routes** at once. Today the operator has to create one ProxyPilot row per (domain, path_prefix) → port mapping, even when those mappings all point at different ports of the same container. After this phase, a single service holds one or more `service_http_routes` rows, the wizard supports an LXC container picker that auto-populates the target IP, and the merged Caddy generator extends to take routes (not services) as its input. This is the prerequisite for Phase 2c, which will add non-HTTP (TCP/UDP/TLS-SNI) port forwards via the `caddy-l4` plugin.

**Scope note:** Frontend + backend only. No new system dependencies, no nftables, no Postgres, no Infisical, no Caddy plugin install. The Caddy reload pipeline from Phase 2 stays. The data model is reshaped in place via an idempotent migration; existing Phase 2 services migrate transparently with zero data loss. nftables / kernel-space port forwards are explicitly out of scope and remain Phase 10 territory.

**Files to edit:**
```
admin/backend/src/db.js                          # New service_http_routes table; idempotent migration that splits existing services rows into (services, service_http_routes) pairs
admin/backend/src/routes/services.js             # Refactor every endpoint that touches (domain, path_prefix, target, port) to operate on routes; add per-service routes CRUD; extend buildDomainCaddyConfig to take a list of (service, route) pairs; LXC IP discovery on create + Refresh action
admin/backend/src/routes/lxc.js                  # Add a `GET /api/lxc/containers/with-ip` helper that returns name + IP + status, used by the Add Service wizard's LXC dropdown
admin/frontend/src/pages/Dashboard.jsx           # Add Service wizard becomes Pick kind → if container, pick LXC → add 1+ routes; service detail page gains a Routes section with add/edit/remove inline; existing Phase 2 banner/header/warning logic generalizes to "routes that share a domain"
admin/frontend/src/lib/api.js                    # Add createRoute, updateRoute, deleteRoute, getLxcContainersWithIp; document that services now nest routes
```

**Deliverables:**

- **Schema migration (`db.js`):**
  - Add `kind` column to `services`: `TEXT NOT NULL CHECK(kind IN ('static_site', 'container_service'))`. Default `'container_service'` for any pre-Phase-2b row whose `type` is not `'static'`; default `'static_site'` when `type='static'`. Backfill in the same migration.
  - Add `runtime` column to `services`: `TEXT CHECK(runtime IN ('lxc', 'docker', NULL))`. Backfill from the existing `type` column: `type='docker'` → `runtime='docker'`; the existing `'proxy'` type and any LXC-pointed services default to `NULL` and the operator can set them later via the wizard.
  - Add `target_ip` and `lxc_container_name` columns to `services`. Backfill `target_ip` from the existing `target` column for non-static services. `lxc_container_name` stays NULL until an operator explicitly picks an LXC container in the wizard (cannot be backfilled — the existing `target` is just an IP, not a container name).
  - New table `service_http_routes (id TEXT PRIMARY KEY, service_id TEXT NOT NULL, domain TEXT NOT NULL, path_prefix TEXT NOT NULL DEFAULT '/', target_port INTEGER, websocket_enabled INTEGER DEFAULT 0, ssl_enabled INTEGER DEFAULT 1, force_https INTEGER DEFAULT 1, max_upload_size TEXT DEFAULT '1G', created_at TEXT DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (service_id) REFERENCES services(id), UNIQUE(domain, path_prefix))`. The `(domain, path_prefix)` UNIQUE constraint moves from `services` to this new table.
  - Idempotent split migration: detect via `sqlite_master.sql` whether `service_http_routes` exists. If not, create it and INSERT one row per existing service carrying its `(domain, path_prefix, port AS target_port, websocket_enabled, ssl_enabled, force_https, max_upload_size)`. Then drop the now-redundant columns from `services` (`domain`, `path_prefix`, `port`, `websocket_enabled`, `ssl_enabled`, `force_https`, `max_upload_size`) via the same table-rebuild pattern Phase 2's `migrateServicesUniqueConstraint` used. Running twice is a no-op.
  - SSL flags now live on routes, not services. The Phase 2 all-or-nothing SSL check generalizes to: "all routes whose `domain` matches must agree on `ssl_enabled` and `force_https`". The merged site address still has one stance per domain, just sourced from any route on that domain.

- **Per-domain Caddy generator (`services.js`):**
  - Refactor `buildDomainCaddyConfig(servicesList, domain)` to `buildDomainCaddyConfig(routesList, domain)` where each entry in `routesList` is the joined `(service, route)` pair. The pure function still emits one merged site block, sorted by `length(path_prefix) DESC`, with `handle_path /prefix*` blocks per prefixed route and one `handle { ... }` for the root-scoped route. Each route's `target_port` combines with its parent service's `target_ip` to form the `reverse_proxy` target.
  - `regenerateDomainCaddyConfig(db, domain)` now SELECTs from `service_http_routes` JOINed to `services` (excluding `is_admin = 1` services) and hands the joined rows to `buildDomainCaddyConfig`. All nine Phase 2 call sites continue to call this helper — only the SQL inside it changes.
  - Static-site routes (`kind='static_site'`) still emit `root * <local path>` + `file_server` + `try_files`, with the path coming from the parent service's `data_dir` instead of `target_ip` + `target_port`.
  - Per-route validation: refuse to emit if any sibling routes for the same domain disagree on `ssl_enabled` or `force_https` (defense-in-depth, matches Phase 2's posture).

- **Routes CRUD (`services.js`, new endpoints):**
  - `GET /api/services/:id/routes` — list every route for one service.
  - `POST /api/services/:id/routes` — add a route. Validates `(domain, path_prefix)` uniqueness, validates SSL consistency against any pre-existing routes on the same domain (across all services), regenerates the merged Caddy config for the affected domain, validates + reloads, rolls back on failure (same backup-then-revert pattern as Phase 2's update endpoint).
  - `PUT /api/services/:id/routes/:routeId` — edit a route. If `domain` changes, regenerate both old and new domain's merged files.
  - `DELETE /api/services/:id/routes/:routeId` — remove one route. Regenerates the merged file for the route's domain (which may shrink or unlink). The parent service stays even if its last route is removed — the operator can add routes back without recreating the service. The existing service-level DELETE still cascades to all routes.

- **LXC integration (`lxc.js` + `services.js`):**
  - Add `GET /api/lxc/containers/with-ip` returning `[{name, status, ipv4, ipv6}]` for every Incus container the dashboard already manages. The wizard's LXC dropdown calls this on open.
  - On service create, when the operator picks an LXC container, ProxyPilot reads the IP from the dropdown selection and stores it in `services.target_ip` + `services.lxc_container_name`. **No live re-resolution at config-generation time** — the cached IP is used.
  - New endpoint `POST /api/services/:id/refresh-ip` — re-queries Incus for the cached `lxc_container_name`, updates `services.target_ip` if it changed, regenerates the merged Caddy config for every domain that has routes for this service, reloads. Audit-logged.
  - The phase spec recommends operators give LXC containers static IPs via Incus profiles to avoid having to use Refresh IP after every container restart. Document in the dashboard.

- **Frontend wizard (`Dashboard.jsx`):**
  - Step 0 (kind picker): Static Site / Container Service. The existing Static Site / Proxy Container / Docker Compose / LXC Container tile grid collapses into the two top-level kinds, with runtime (LXC vs Docker) being a sub-choice inside Container Service.
  - Step 1 (container picker, only for container_service kind): if `runtime='lxc'`, dropdown of LXC containers from `/api/lxc/containers/with-ip`; if `runtime='docker'`, the existing Docker container/port picker. The selected container's IP populates `target_ip` and is shown read-only.
  - Step 2 (routes builder): list of `(domain, path_prefix, target_port)` rows the operator can add/remove inline. Minimum one route. Each row has its own SSL toggle. The Phase 2 banner (existing prefixes for typed domain) and the client-side collision guard generalize to operate against all routes across all services, not just the in-progress one.
  - Service detail page gains a **Routes** section: card with all routes, add-route button, edit/remove icons per row.
  - All new UI uses Phase 1's mobile-first patterns (full-screen wizard at `<sm`, grid `grid-cols-1 sm:grid-cols-2 lg:grid-cols-3` everywhere, 44×44px primary action buttons).

- **Audit log:** existing `SERVICE_CREATED` / `SERVICE_UPDATED` / `SERVICE_DELETED` payloads add a `routes` array. New actions: `ROUTE_CREATED`, `ROUTE_UPDATED`, `ROUTE_DELETED`, `LXC_IP_REFRESHED`. Every action carries the parent `service_id` and the affected route's full `(domain, path_prefix)` tuple.

- **Export/import:** `serviceExport` nests routes under each service. The import endpoint accepts both the new nested format AND the Phase 2 flat format (one route per service auto-derived from the legacy `(domain, path_prefix, port)` fields) so existing exports keep importing cleanly.

- **api.js:** Add `getLxcContainersWithIp`, `getServiceRoutes(serviceId)`, `createRoute(serviceId, route)`, `updateRoute(serviceId, routeId, route)`, `deleteRoute(serviceId, routeId)`, `refreshLxcIp(serviceId)`. Update the existing comment to note that services now nest routes and Phase 2's per-domain caching remains absent.

**Spec references:** Phase 2's `phase-02-path-prefix-multi-service.md` (the merged Caddy generator this phase extends), Phase 1's `admin/frontend/MOBILE_FIRST.md` (the wizard's mobile patterns). The existing `admin/backend/src/routes/lxc.js` code for the Incus container query path. No core infrastructure prompts apply yet.

**Verification:**
- [ ] Fresh install: `services` table has `kind`, `runtime`, `target_ip`, `lxc_container_name` columns; `service_http_routes` table exists with the `UNIQUE(domain, path_prefix)` constraint; the old `domain`/`path_prefix`/`port`/`ssl_enabled`/`force_https`/`websocket_enabled`/`max_upload_size` columns are gone from `services`.
- [ ] Existing-install migration: a seeded Phase 2 DB with two services on `mul.test` (`/` static + `/api` docker) migrates without data loss — both rows now appear in `service_http_routes` with their original prefixes, both belong to a `services` row whose `kind` and `runtime` were inferred from the legacy `type`.
- [ ] Migration is idempotent: running `initDatabase()` a second time logs nothing and changes nothing.
- [ ] Create a `container_service` with `runtime='lxc'`, pick an LXC container from the dropdown, add two routes (`example.com/` to port 8000 + `example.com/api` to port 8001) — both succeed, the merged Caddy file at `/etc/caddy/sites/example.com` contains both `handle_path /api*` and root `handle { reverse_proxy <lxc_ip>:8000 }` blocks, both proxying to the same `target_ip`.
- [ ] Add a third route at `example.com/api/v2` pointing at port 8002 — the merged file now has `handle_path /api/v2*` before `handle_path /api*` (length-DESC ordering preserved from Phase 2).
- [ ] Edit the `/api` route's port to 8003 — the merged file's `handle_path /api*` body updates, the others are unchanged.
- [ ] Delete the `/api/v2` route — only that handle_path block is removed, the other two remain. The parent service still exists with two routes.
- [ ] Delete the parent service — every route under it is removed in one cascade, the merged file collapses or unlinks accordingly.
- [ ] SSL-consistency: attempt to add a route on an existing domain with a mismatched `ssl_enabled` — rejected with the same all-or-nothing error message Phase 2 surfaces, but now naming the conflicting route(s) instead of the conflicting service.
- [ ] LXC IP refresh: stop the picked LXC container in Incus, change its assigned IP, restart, click Refresh IP on the service detail page — `target_ip` updates and the merged Caddy config rewrites.
- [ ] Export the new-shape DB, wipe, import → all services + routes restore.
- [ ] Import a Phase-2-format export file → each Phase 2 service becomes one new service with one route, no data loss.
- [ ] Audit log: every CRUD action on a route has a corresponding `ROUTE_*` row in `audit_log` carrying the parent `service_id` and the route's `(domain, path_prefix)`.
- [ ] Dashboard service list groups routes by their parent service in the favorite-sort view (Phase 2's domain grouping generalizes to service grouping).
- [ ] **Mobile: 360px Add Service wizard with multi-route step** — typing a new domain, adding two routes with different ports, picking an LXC container, all without horizontal scroll at 360×640.
- [ ] **Mobile: 360px Service detail Routes section** — add/edit/remove a route from the detail page on a 360px viewport without horizontal scroll, all touch targets ≥44×44px.
- [ ] **Mobile: 360px Delete confirmation generalizes** — deleting a route still surfaces the "this will leave N other routes on this domain" warning when applicable.
- [ ] **Mobile: 1280px desktop regression** — none of the Phase 1 baseline layouts regress.
- [ ] Caddy `adapt` validates every generated merged config — same defense-in-depth check as Phase 2.

**Commit:** `phase-02b: container-as-service model with multiple HTTP routes per service`

---

## Function-by-Function Checklist (to be populated)

> This section is a placeholder. The next planning session will decompose the phase deliverables into a per-function checklist: one function → implement → test → check off → move on. Each function gets its own line with a checkbox, the file it lives in, and a one-line success criterion. Do not populate this now — leave the placeholder in place.

- [ ] _pending_
