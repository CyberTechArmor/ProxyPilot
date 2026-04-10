<!-- New phase added after Phase 2b to support non-HTTP entry points via caddy-l4 -->
<!-- Index: docs/core/plan/README.md -->

## Phase 2c: Layer 4 (TCP / UDP / TLS-SNI) Port Forwards via `caddy-l4`

**Goal:** Let a container service expose **non-HTTP entry points** alongside its HTTP routes — TCP, UDP, and TLS-SNI passthrough — by extending the merged Caddyfile with a `layer4 { ... }` block generated from a new `service_port_forwards` table. After this phase, an LXC container running, e.g., a mail server can register HTTPS webmail (Phase 2b HTTP routes) plus SMTP/SMTPS/IMAP/IMAPS (Phase 2c port forwards) as one ProxyPilot service, the dashboard shows everything in one place, and host-port conflicts are detected before they reach Caddy.

**Scope note:** Frontend + backend + a runtime dependency on the [`caddy-l4`](https://github.com/mholt/caddy-l4) plugin (not in stock Caddy). The plugin is detected at runtime via `caddy list-modules` parsing; if it is missing, port-forward endpoints return `412 Precondition Failed` with a clear install message instead of crashing. Port forwards apply only to `kind='container_service'` services (both `runtime='lxc'` and `runtime='docker'` are first-class equal peers); `kind='static_site'` services do not get the Port Forwards UI at all. **No nftables, no iptables, no host firewall mutation, no kernel-space packet forwarding.** All traffic flows through Caddy's userspace forwarder. nftables-based forwards remain Phase 10 territory and may later be added as an alternative engine for the same `service_port_forwards` rows.

**Step 1 research task (blocking, runs before the function-by-function checklist is populated):** the executing session must verify experimentally whether `caddy-l4` supports UDP port ranges natively (e.g., `udp/:16384-32768 { route { proxy udp/10.0.0.42:16384-32768 } }`). Build Caddy locally via `xcaddy build --with github.com/mholt/caddy-l4`, stand up a minimal test config with the range listener + a toy UDP echo backend, and confirm (a) Caddy binds the whole range, (b) UDP packets forward correctly, (c) the range syntax survives a `caddy adapt` round-trip. Document the finding in the phase spec before populating the checklist. If ranges work, the schema below includes `host_port_range` / `target_port_range` text columns. If they do not, the schema caps at single-port rows, the wizard surfaces a "port ranges need nftables — see Phase 10" notice, and BBB-style dynamic-port services are explicitly out of scope until Phase 10 lands. **Do not populate the function-by-function checklist until this research is done.**

**Files to edit:**
```
admin/backend/src/db.js                          # New service_port_forwards table; columns depend on Step 1 research result (single port vs range-capable)
admin/backend/src/routes/services.js             # Port-forwards CRUD + bulk add; host port auto-allocation helper; port discovery via incus/docker exec; extend the merged Caddy generator with a buildLayer4Block helper; conflict detection on (host_port, protocol) catching Docker-published ports via docker-proxy
admin/backend/src/routes/lxc.js                  # Minor: a helper that execs `ss -tulnp -H` inside a given container and returns listening ports (used by the port discovery endpoint)
admin/backend/src/routes/system.js  (NEW)        # GET /api/system/listening-ports endpoint that parses ss/lsof output; cross-references docker-proxy processes to Docker container names via docker ps
admin/backend/src/routes/network-map.js  (NEW)   # GET /api/services/network-map JSON endpoint summarizing every service, route, port-forward, and "detected but not forwarded" entries per container
admin/frontend/src/pages/Dashboard.jsx           # Service detail page gains a Port Forwards section parallel to the Routes section (only for container_service kind); new wizard step for port forwards; "Detect listening ports" button with bulk-add modal
admin/frontend/src/pages/NetworkMap.jsx  (NEW)   # New top-level page rendering the network map, mobile-first, accessible from the sidebar
admin/frontend/src/components/Layout.jsx         # Add Network Map sidebar entry
admin/frontend/src/lib/api.js                    # Add createPortForward, updatePortForward, deletePortForward, bulkAddPortForwards, detectPorts, getNetworkMap, getListeningPorts, getCaddyModules
```

**Deliverables:**

- **Schema (`db.js`):**
  - New table `service_port_forwards`. The exact columns depend on the Step 1 research result — the session drafting the function-by-function checklist chooses one of two shapes based on whether `caddy-l4` supports UDP port ranges natively.
  - **Shape A (ranges work):** `(id TEXT PRIMARY KEY, service_id TEXT NOT NULL, host_port_start INTEGER NOT NULL, host_port_end INTEGER NOT NULL, target_port_start INTEGER NOT NULL, target_port_end INTEGER NOT NULL, protocol TEXT NOT NULL CHECK(protocol IN ('tcp', 'udp', 'tls')), sni_hostname TEXT, description TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (service_id) REFERENCES services(id))`. A single port is represented as `host_port_start = host_port_end`. Conflict detection walks the DB rows per `(port, protocol)` in the requested range rather than relying on a simple UNIQUE constraint.
  - **Shape B (ranges do not work):** `(id TEXT PRIMARY KEY, service_id TEXT NOT NULL, host_port INTEGER NOT NULL, target_port INTEGER NOT NULL, protocol TEXT NOT NULL CHECK(protocol IN ('tcp', 'udp', 'tls')), sni_hostname TEXT, description TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (service_id) REFERENCES services(id), UNIQUE(host_port, protocol))`. A port range must be exploded into N rows; the wizard surfaces a warning once N exceeds a threshold (default 50) and points the operator at Phase 10 as the eventual solution.
  - In either shape, `sni_hostname` is only meaningful when `protocol='tls'` — otherwise NULL.
  - The migration is purely additive (CREATE TABLE IF NOT EXISTS) — no existing data to reshape from Phase 2b.

- **Plugin preflight (`services.js`):**
  - New helper `async caddyHasLayer4()` that runs `caddy list-modules` (or `caddy build-info`) once at startup and caches the result. Detects whether `layer4` appears in the module list.
  - Every port-forward CRUD endpoint calls this helper first. On a missing plugin, returns `412 Precondition Failed` with `{error: "caddy-l4 plugin is required for port forwards. Install with: xcaddy build --with github.com/mholt/caddy-l4 ..."}`.
  - The plugin detection result is exposed via `GET /api/system/caddy-modules` so the dashboard can surface a "Plugin missing" banner before the operator even tries to add a forward.
  - Document the install procedure in the spec body and in the dashboard's missing-plugin banner: a one-liner `xcaddy build` invocation, plus a note that the operator can use a pre-built ProxyPilot Caddy binary if/when one ships.

- **Conflict detection (`services.js` + `system.js`):**
  - Before INSERTing a port forward, run two checks:
    1. **DB-level**: query `service_port_forwards` for any existing row with the same `(host_port, protocol)` (or overlapping range if Shape A). Surfaces a helpful error naming the conflicting service.
    2. **System-level**: parse `ss -tulnp` (preferred) or fall back to `lsof -i -P -n` to discover host ports already bound by other processes. If `host_port` is in that list AND not already owned by the Caddy process, reject with `400 Bad Request` naming the conflicting process + PID.
  - **Docker awareness**: Docker publishes container ports to the host by spawning a `docker-proxy` process per published port. `ss -tulnp` naturally sees these. When the conflicting process name matches `docker-proxy`, the conflict detector cross-references the port against `docker ps --format '{{.Names}} {{.Ports}}'` and surfaces `"host port <X>/<proto> is already published by Docker container <name>"` — so the operator understands the conflict is another container they own, not an unknown process. If the container belongs to a Docker-runtime ProxyPilot service, the error additionally names the ProxyPilot service so the operator can reconcile via the dashboard instead of hunting through `docker ps`.
  - **LXC awareness**: Incus containers do not have an equivalent host-side proxy. If an LXC-runtime ProxyPilot service has port forwards, those are visible via the DB-level check. If something else on the host binds the port (including an Incus-configured nat rule or a service the operator started manually), `ss` catches it.
  - The system-level check runs in `routes/system.js` and exposes `GET /api/system/listening-ports` returning `[{port, protocol, process, pid, docker_container}]` — `docker_container` is populated when the process is `docker-proxy` and a matching container is found. The dashboard panel uses it to show "system-bound ports" in the network map.
  - Conflicts on host ports owned by Caddy itself are *not* errors — those are existing ProxyPilot port forwards.

- **Host port auto-allocation (`services.js`, new helper):**
  - New helper `allocateHostPort(db, targetPort, protocol)` that:
    1. Tries `host_port = target_port` first (the common case — operator wants the same port on host and container).
    2. If the tuple `(target_port, protocol)` is taken (DB or system), walks upward: `target_port + 1`, `+2`, ..., checking each candidate against both the DB-level and system-level conflict detectors.
    3. Caps the search at 100 attempts by default (tunable via `APP_PORT_ALLOC_MAX_ATTEMPTS` env var). If the search exhausts without finding a free port, throws an error that names the original target port so the operator knows to pick a different starting point manually.
    4. Returns the allocated host port.
  - This helper is used by the port discovery flow (below) to pre-fill the "auto host port" column in the detection modal. Manual port-forward creation (operator typing a host port directly in the form) does NOT use the allocator — the operator's explicit value is respected, with an immediate conflict error on submit if it's taken.
  - The 100-attempt cap is a safety valve to prevent a runaway scan when an operator detects a container with hundreds of listening ports on a crowded host. The error message includes "try running Detect listening ports again, or free up ports near <N>".

- **Port discovery via container exec (`services.js` + `lxc.js`, new):**
  - New endpoint `GET /api/services/:id/detect-ports` that shells into the target container and returns the list of listening `(port, protocol, process_name)` tuples. Implementation branches on the parent service's runtime:
    - **LXC** (`runtime='lxc'`): `incus exec <lxc_container_name> -- ss -tulnp -H` through the existing LXC exec path. Parses the tab-separated output into structured rows.
    - **Docker** (`runtime='docker'`): `docker exec <container_name> ss -tulnp -H` (or `docker exec <container_name> netstat -tulnp` as a fallback if `ss` is missing — Alpine containers have `ss` in `iproute2`, Debian/Ubuntu usually do by default).
    - **Static site** (`kind='static_site'`): returns `[]` with a 400 and an explanation — static sites have no listening ports to detect.
    - **Container not running**: returns 503 with a clear "container is stopped, start it first" message.
  - Response shape: `{detected: [{port, protocol, process_name, auto_host_port, host_port_taken}]}`. `auto_host_port` is the port `allocateHostPort` would pick for that entry; `host_port_taken` is `true` when `auto_host_port !== port` (signals the operator that ProxyPilot had to remap to avoid a conflict).
  - The endpoint runs each `allocateHostPort` call sequentially within a single request so the returned auto-allocations are internally consistent (e.g., detecting ports `3000, 3001, 3002` on the container — if host:3000 is free, auto = 3000; if host:3001 is taken, auto = 3003, not 3001).
  - Audited as `PORTS_DETECTED` with the detected count in the payload (so post-hoc inspection can confirm what the operator was shown).

- **Bulk port-forwards add (`services.js`, new endpoint):**
  - `POST /api/services/:id/port-forwards/bulk` accepts `{forwards: [{host_port, target_port, protocol, sni_hostname, description}]}` and inserts each entry in one DB transaction. Re-runs both conflict checks per entry (race mitigation — a port that was free at Detect time might now be taken). Returns a per-entry result list `[{forward, status: 'created'|'conflict'|'error', reason?}]` so partial success is visible to the operator.
  - Regenerates the global layer4 config **once** at the end of the bulk operation (not per entry) so Caddy reloads once.
  - On a whole-batch validation failure from `caddy adapt`, rolls every row back in the same transaction and restores the previous layer4 file from the backup (same backup-then-revert pattern as Phase 2's update endpoint).
  - Audited as `PORT_FORWARDS_BULK_ADDED` with the `{created_count, conflict_count, error_count}` breakdown in the payload.

- **Merged Caddy generator (`services.js`):**
  - New helper `buildLayer4Block(forwards)` that takes a list of port-forward rows and emits the global `layer4 { ... }` directive. For each forward:
    - `protocol='tcp'`: `:<host_port> { route { proxy <target_ip>:<target_port> } }`.
    - `protocol='udp'`: `udp/:<host_port> { route { proxy udp/<target_ip>:<target_port> } }`.
    - `protocol='tls'`: `:<host_port> { @sni tls sni <sni_hostname>; route @sni { proxy <target_ip>:<target_port> } }` so the forward is matched by SNI hostname *without* terminating TLS — the backend container holds its own cert.
  - `regenerateDomainCaddyConfig(db, domain)` from Phase 2 stays unchanged for per-domain merged HTTP files. A new top-level helper `regenerateGlobalLayer4Config(db)` builds the layer4 block once per Caddy reload and writes it to `/etc/caddy/sites/_layer4.conf` (or similar — the file lives in the same `import` directory the main Caddyfile already pulls from).
  - Phase 2's `caddy adapt` validation gate stays. If the layer4 block fails to validate, the rollback logic reverts both the per-domain files AND the layer4 file.

- **Port-forwards CRUD (`services.js`, new endpoints):**
  - `GET /api/services/:id/port-forwards` — list every forward for one service.
  - `POST /api/services/:id/port-forwards` — add a forward. Runs the plugin preflight + conflict detection, regenerates the global layer4 config, validates + reloads, rolls back on failure.
  - `PUT /api/services/:id/port-forwards/:forwardId` — edit. Same checks; if `host_port` or `protocol` changes, re-runs conflict detection against the new tuple.
  - `DELETE /api/services/:id/port-forwards/:forwardId` — remove. Regenerates the global layer4 config (which may have shrunk).
  - The existing service-level DELETE cascades to all forwards in addition to all routes.

- **Network map endpoint (`network-map.js`, new):**
  - `GET /api/services/network-map` returns one JSON payload summarizing every managed service: `[{service: {...}, routes: [...], port_forwards: [...], detected_but_not_forwarded: [...], status: 'active'|'inactive'}]`. The dashboard panel and a future `proxypilot status` CLI both consume this.
  - `detected_but_not_forwarded` is populated by running the port discovery helper against each container service and subtracting any ports that already have a matching `service_port_forwards` row. This gives the operator a "hey, your container is listening on port X but you haven't exposed it" signal on the network map page and on the service detail card. The scan is best-effort — failures (stopped container, missing `ss` binary, exec permission denied) populate `detected_scan_error` per service instead of blocking the endpoint.
  - The endpoint also includes a top-level `system_listening_ports` array (from the system port detector) so the dashboard can flag ports bound by non-ProxyPilot processes. Each entry includes `docker_container` when the binding process is a `docker-proxy` tied to a named container.

- **Frontend network map page (`NetworkMap.jsx`, new):**
  - New top-level route `/network-map` accessible from the sidebar (mobile-first sidebar entry following Phase 1 patterns).
  - Renders the network map as a card-per-service list, each card showing the service name, kind, runtime, target IP, every HTTP route (with its domain + path + target port), every port forward (with its host port + protocol + target port + SNI hostname), and a "Detected but not forwarded" badge when `detected_but_not_forwarded` is non-empty. Clicking the badge opens the service detail page's Port Forwards section with the detection modal pre-populated.
  - A separate "System-bound ports" section at the bottom of the page lists every port bound by a non-ProxyPilot process, with the process name + PID + (when applicable) the owning Docker container. Read-only; surfaces conflicts the operator may not have realized exist.
  - Mobile-first: card stack on `<sm`, grid on `sm+`. No fixed-width columns. Touch targets ≥44×44px on the card actions (refresh, view in service detail).

- **Wizard + service detail (`Dashboard.jsx`):**
  - The Phase 2b wizard's `container_service` path adds a new optional Port Forwards step after the Routes step. `static_site` services skip this step entirely — the wizard never shows it.
  - The Port Forwards step has two entry points: **Add manually** (type a host port + target port + protocol, same as the existing Route form) and **Detect listening ports** (hits `/api/services/:id/detect-ports`, opens a modal with the detected list). The manual form and the detection modal both accept the same shape and both go through the bulk-add endpoint on save.
  - Detection modal: table with columns `Port | Protocol | Process | Host port (editable) | ✓`. The Host port column pre-fills from the `auto_host_port` field of the detection response; rows where `host_port_taken` is true are highlighted amber with a tooltip explaining that the port was auto-remapped. Operator ticks the rows they want exposed, optionally edits any host port, and clicks "Add selected" → bulk-add endpoint → modal closes with a per-entry success/conflict summary toast.
  - Service detail page gains a **Port Forwards** section parallel to the Routes section (only rendered when `kind === 'container_service'`), with add/edit/remove inline and a persistent **Detect listening ports** button. Conflict errors surface inline with the conflicting process name + suggested resolution ("port 5432/tcp is published by Docker container `my-postgres` — pick a different host port or stop that container first").
  - A "Detected but not forwarded" count appears next to the Port Forwards section header when the latest scan found un-exposed ports. The count links to the detection modal, pre-scoped to the unforwarded rows so the operator can add them in one click.
  - "Plugin missing" banner appears at the top of the Port Forwards section if `caddy-l4` is not detected at runtime. Banner includes the `xcaddy build --with github.com/mholt/caddy-l4` one-liner, a link to the caddy-l4 README, and a note that the operator can roll back to the old Caddy binary if the rebuild breaks anything.

- **Audit log:** new actions `PORT_FORWARD_CREATED`, `PORT_FORWARD_UPDATED`, `PORT_FORWARD_DELETED`, `PORT_FORWARDS_BULK_ADDED`, `PORTS_DETECTED`. Existing `SERVICE_*` payloads add a `port_forwards` array.

- **Export/import:** `serviceExport` nests `port_forwards` under each service alongside the routes. The import endpoint accepts both the new format and the Phase 2b format (auto-defaulting `port_forwards: []`). On import, the host-port conflict detector runs the same way it does on manual add — if an imported forward collides with something on the target host, the import marks that entry as skipped with the conflict reason instead of failing the whole import.

- **api.js:** Add `getServicePortForwards`, `createPortForward`, `updatePortForward`, `deletePortForward`, `bulkAddPortForwards`, `detectPorts`, `getNetworkMap`, `getListeningPorts`, `getCaddyModules`.

**Spec references:** Phase 2b's `phase-02b-container-service-model.md` (the container-as-service data model this phase extends), Phase 1's `admin/frontend/MOBILE_FIRST.md` (sidebar entry, network map page mobile patterns). [`caddy-l4` README](https://github.com/mholt/caddy-l4) for the layer4 directive syntax. The `xcaddy` documentation at [github.com/caddyserver/xcaddy](https://github.com/caddyserver/xcaddy) for the plugin install procedure. No core infrastructure prompts apply yet.

**Verification:**
- [ ] Step 1 research completed: `caddy-l4` UDP port range support (or lack thereof) verified experimentally and documented in the phase spec before the function-by-function checklist is populated. The schema shape (A vs B) is chosen based on the result.
- [ ] Fresh install: `service_port_forwards` table exists with the chosen schema shape; existing Phase 2b services are unaffected.
- [ ] Plugin preflight: with stock Caddy installed (no `caddy-l4`), `POST /api/services/:id/port-forwards` returns 412 with the install message; the dashboard surfaces the missing-plugin banner; no port forward is persisted.
- [ ] With `caddy-l4` installed: create an LXC `container_service` with two HTTP routes (Phase 2b unchanged) AND one TCP forward (host:25565 → container:25565) AND one UDP forward (host:19132 → container:19132) AND one TLS-SNI forward (host:993 SNI mail.example.com → container:993). All four succeed, the global layer4 file at `/etc/caddy/sites/_layer4.conf` contains all three forwards, the per-domain merged files contain the HTTP routes, and `caddy adapt` validates the entire chain.
- [ ] Same test, repeated for a Docker `container_service`: confirms Docker and LXC are interchangeable targets for port forwards.
- [ ] **Port discovery (LXC)**: create an LXC service backed by a container that listens on three ports, click Detect listening ports, confirm all three appear in the modal with `auto_host_port === port` for all of them (no host conflicts). Tick all three, click Add selected, confirm three `service_port_forwards` rows inserted and the layer4 file has all three.
- [ ] **Port discovery (Docker)**: same test against a Docker container — confirm `docker exec ... ss -tulnp -H` returns the expected listing and the bulk-add flow works identically.
- [ ] **Host port auto-remap**: pre-bind host port 8080 with `nc -l 8080`, detect a container that listens on 8080, confirm the detection modal surfaces `auto_host_port = 8081` (or the next free port) with the row highlighted as "remapped" and an explanatory tooltip. Confirm the bulk-add commits at 8081.
- [ ] **Host port auto-remap exhaustion**: configure `APP_PORT_ALLOC_MAX_ATTEMPTS=5`, pre-bind host ports 8080-8085, detect a container listening on 8080, confirm the detection modal surfaces a clear "could not auto-allocate a free host port near 8080 after 5 attempts" error for that row.
- [ ] **Docker conflict awareness**: publish Docker container `foo` with `-p 5432:5432/tcp`, attempt to create a ProxyPilot port forward at `(host_port=5432, protocol=tcp)` for a different service, confirm the error message names `foo` (not just `docker-proxy`).
- [ ] **Static site exclusion**: create a `static_site` service, confirm the service detail page does NOT show the Port Forwards section, confirm `GET /api/services/:id/detect-ports` returns 400 with the "static sites have no listening ports" message.
- [ ] **Bulk add partial success**: prepare a bulk-add payload with 3 entries where one conflicts with an existing port forward. Confirm the 2 non-conflicting entries commit, the 1 conflict is reported in the per-entry result, the layer4 file reflects only the successful adds, and Caddy reloads once (not three times).
- [ ] **Bulk add rollback**: prepare a bulk-add payload that produces a merged layer4 config that fails `caddy adapt`. Confirm every entry is rolled back, the previous layer4 file is restored, and the error response names the failure reason.
- [ ] Conflict detection (DB): attempt a duplicate `(host_port=25565, protocol=tcp)` — rejected with the new error naming the existing service.
- [ ] Conflict detection (system): bind port 25566 with a `nc -l` process, attempt to add a forward at `(25566, tcp)` — rejected with a 400 naming the conflicting process and PID.
- [ ] Edit a port forward's target port — the global layer4 file rewrites with the new target, all other forwards are preserved.
- [ ] Delete a port forward — the global layer4 file shrinks, all other forwards stay.
- [ ] Delete the parent service — every route AND every port forward under it cascades, the global layer4 file updates accordingly.
- [ ] Network map page (`/network-map`) renders every service, every route, every port forward, and lists system-bound ports separately. The "Detected but not forwarded" badge appears for a service whose container has an un-exposed listening port.
- [ ] `GET /api/services/network-map` returns the expected JSON shape including `detected_but_not_forwarded` and the `docker_container` annotation on applicable `system_listening_ports` entries. Piping to `jq` gives a usable inventory.
- [ ] Audit log: every CRUD action on a port forward has a corresponding `PORT_FORWARD_*` row in `audit_log` carrying the parent `service_id` and the forward's `(host_port, protocol)`. Bulk adds produce a single `PORT_FORWARDS_BULK_ADDED` row with the created/conflict/error breakdown; detections produce a `PORTS_DETECTED` row with the detected count.
- [ ] **Mobile: 360px Network Map page** — renders all services + routes + port forwards as a card stack at 360×640 with no horizontal scroll, every action button ≥44×44px. The "Detected but not forwarded" badge wraps cleanly.
- [ ] **Mobile: 360px Add Port Forward dialog** — operator can add/edit/remove a forward on a 360px viewport; conflict errors wrap cleanly inside the dialog.
- [ ] **Mobile: 360px Port discovery modal** — detection results table is scrollable inside the dialog, host port input cells are reachable with a finger, the "Add selected" button is ≥44×44px and is never clipped.
- [ ] **Mobile: 1280px desktop regression** — the new sidebar entry, network map page, port forwards section, and detection modal don't introduce horizontal scroll on the existing Phase 1/2/2b pages.
- [ ] Caddy `adapt` validates the merged Caddyfile (per-domain files + global layer4 file together) without errors.
- [ ] Plugin install documentation: the `xcaddy build --with github.com/mholt/caddy-l4` one-liner appears in the missing-plugin banner AND in the phase spec, with a fallback note pointing operators at any pre-built ProxyPilot Caddy binary that may exist.

**Commit:** `phase-02c: layer 4 port forwards via caddy-l4 plugin`

---

## Function-by-Function Checklist (to be populated)

> This section is a placeholder. The next planning session will decompose the phase deliverables into a per-function checklist: one function → implement → test → check off → move on. Each function gets its own line with a checkbox, the file it lives in, and a one-line success criterion. Do not populate this now — leave the placeholder in place.

- [ ] _pending_
