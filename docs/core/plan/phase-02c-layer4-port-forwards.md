<!-- New phase added after Phase 2b to support non-HTTP entry points via caddy-l4 -->
<!-- Index: docs/core/plan/README.md -->

## Phase 2c: Layer 4 (TCP / UDP / TLS-SNI) Port Forwards via `caddy-l4`

**Goal:** Let a container service expose **non-HTTP entry points** alongside its HTTP routes — TCP, UDP, and TLS-SNI passthrough — by extending the merged Caddyfile with a `layer4 { ... }` block generated from a new `service_port_forwards` table. After this phase, an LXC container running, e.g., a mail server can register HTTPS webmail (Phase 2b HTTP routes) plus SMTP/SMTPS/IMAP/IMAPS (Phase 2c port forwards) as one ProxyPilot service, the dashboard shows everything in one place, and host-port conflicts are detected before they reach Caddy.

**Scope note:** Frontend + backend + a runtime dependency on the [`caddy-l4`](https://github.com/mholt/caddy-l4) plugin (not in stock Caddy). The plugin is detected at runtime via `caddy build-info` parsing; if it is missing, port-forward endpoints return `412 Precondition Failed` with a clear install message instead of crashing. **No nftables, no iptables, no host firewall mutation, no kernel-space packet forwarding.** All traffic flows through Caddy's userspace forwarder. nftables-based forwards remain Phase 10 territory and may later be added as an alternative engine for the same `service_port_forwards` rows.

**Files to edit:**
```
admin/backend/src/db.js                          # New service_port_forwards table; new host_port_allocations view (or query helper) for conflict detection
admin/backend/src/routes/services.js             # New port-forwards CRUD; extend the merged Caddy generator with a buildLayer4Block helper that emits the global layer4 directive; conflict detection on (host_port, protocol)
admin/backend/src/routes/lxc.js                  # No change expected — existing LXC IP path from Phase 2b is reused
admin/backend/src/routes/system.js  (NEW)        # GET /api/system/listening-ports endpoint that parses ss/lsof output, used by the conflict detector to spot ports already bound by other processes
admin/backend/src/routes/network-map.js  (NEW)   # GET /api/services/network-map JSON endpoint summarizing every service, route, and port-forward in one payload (the dashboard panel + the future CLI both consume this)
admin/frontend/src/pages/Dashboard.jsx           # Service detail page gains a Port Forwards section parallel to the Routes section; new wizard step for port forwards
admin/frontend/src/pages/NetworkMap.jsx  (NEW)   # New top-level page rendering the network map, mobile-first, accessible from the sidebar
admin/frontend/src/components/Layout.jsx         # Add Network Map sidebar entry
admin/frontend/src/lib/api.js                    # Add createPortForward, updatePortForward, deletePortForward, getNetworkMap, getListeningPorts
```

**Deliverables:**

- **Schema (`db.js`):**
  - New table `service_port_forwards (id TEXT PRIMARY KEY, service_id TEXT NOT NULL, host_port INTEGER NOT NULL, target_port INTEGER NOT NULL, protocol TEXT NOT NULL CHECK(protocol IN ('tcp', 'udp', 'tls')), sni_hostname TEXT, description TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (service_id) REFERENCES services(id), UNIQUE(host_port, protocol))`. The UNIQUE constraint prevents two ProxyPilot-managed forwards from claiming the same `(host_port, protocol)` tuple. `sni_hostname` is only meaningful when `protocol='tls'` — otherwise NULL.
  - The migration is purely additive (CREATE TABLE IF NOT EXISTS) — no existing data to reshape from Phase 2b.

- **Plugin preflight (`services.js`):**
  - New helper `async caddyHasLayer4()` that runs `caddy list-modules` (or `caddy build-info`) once at startup and caches the result. Detects whether `layer4` appears in the module list.
  - Every port-forward CRUD endpoint calls this helper first. On a missing plugin, returns `412 Precondition Failed` with `{error: "caddy-l4 plugin is required for port forwards. Install with: xcaddy build --with github.com/mholt/caddy-l4 ..."}`.
  - The plugin detection result is exposed via `GET /api/system/caddy-modules` so the dashboard can surface a "Plugin missing" banner before the operator even tries to add a forward.
  - Document the install procedure in the spec body and in the dashboard's missing-plugin banner: a one-liner `xcaddy build` invocation, plus a note that the operator can use a pre-built ProxyPilot Caddy binary if/when one ships.

- **Conflict detection (`services.js` + `system.js`):**
  - Before INSERTing a port forward, run two checks:
    1. **DB-level**: query `service_port_forwards` for any existing row with the same `(host_port, protocol)`. The UNIQUE constraint enforces this at the SQL layer; this query exists to surface a helpful error message naming the conflicting service.
    2. **System-level**: parse `ss -tulnp` (preferred) or fall back to `lsof -i -P -n` to discover host ports already bound by other processes. If `host_port` is in that list AND not already owned by the Caddy process, reject with `400 Bad Request` and the conflicting process name + PID.
  - The system-level check runs in `routes/system.js` and exposes `GET /api/system/listening-ports` returning `[{port, protocol, process, pid}]`. The dashboard panel uses it to show "system-bound ports" in the network map.
  - Conflicts on host ports owned by Caddy itself are *not* errors — those are existing port forwards.

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
  - `GET /api/services/network-map` returns one JSON payload summarizing every managed service: `[{service: {...}, routes: [...], port_forwards: [...], status: 'active'|'inactive'}]`. The dashboard panel and a future `proxypilot status` CLI both consume this.
  - The endpoint also includes a top-level `system_listening_ports` array (from the system port detector) so the dashboard can flag ports bound by non-ProxyPilot processes.

- **Frontend network map page (`NetworkMap.jsx`, new):**
  - New top-level route `/network-map` accessible from the sidebar (mobile-first sidebar entry following Phase 1 patterns).
  - Renders the network map as a card-per-service list, each card showing the service name, kind, runtime, target IP, every HTTP route (with its domain + path + target port), every port forward (with its host port + protocol + target port + SNI hostname). System-bound ports are flagged in their own section.
  - Mobile-first: card stack on `<sm`, grid on `sm+`. No fixed-width columns. Touch targets ≥44×44px on the card actions (refresh, view in service detail).

- **Wizard + service detail (`Dashboard.jsx`):**
  - The Phase 2b wizard's container_service path adds a new optional Port Forwards step after the Routes step. Operator can skip if their service is HTTP-only.
  - Service detail page gains a **Port Forwards** section parallel to the Routes section, with add/edit/remove inline. Conflict errors surface inline with the conflicting process name + suggested resolution.
  - "Plugin missing" banner appears at the top of the Port Forwards section if `caddy-l4` is not detected. Banner includes the `xcaddy build` one-liner.

- **Audit log:** new actions `PORT_FORWARD_CREATED`, `PORT_FORWARD_UPDATED`, `PORT_FORWARD_DELETED`. Existing `SERVICE_*` payloads add a `port_forwards` array.

- **Export/import:** `serviceExport` nests `port_forwards` under each service alongside the routes. The import endpoint accepts both the new format and the Phase 2b format (auto-defaulting `port_forwards: []`).

- **api.js:** Add `getServicePortForwards`, `createPortForward`, `updatePortForward`, `deletePortForward`, `getNetworkMap`, `getListeningPorts`, `getCaddyModules`.

**Spec references:** Phase 2b's `phase-02b-container-service-model.md` (the container-as-service data model this phase extends), Phase 1's `admin/frontend/MOBILE_FIRST.md` (sidebar entry, network map page mobile patterns). [`caddy-l4` README](https://github.com/mholt/caddy-l4) for the layer4 directive syntax. The `xcaddy` documentation at [github.com/caddyserver/xcaddy](https://github.com/caddyserver/xcaddy) for the plugin install procedure. No core infrastructure prompts apply yet.

**Verification:**
- [ ] Fresh install: `service_port_forwards` table exists with the `UNIQUE(host_port, protocol)` constraint; existing Phase 2b services are unaffected.
- [ ] Plugin preflight: with stock Caddy installed (no `caddy-l4`), `POST /api/services/:id/port-forwards` returns 412 with the install message; the dashboard surfaces the missing-plugin banner; no port forward is persisted.
- [ ] With `caddy-l4` installed: create a `container_service` with two HTTP routes (Phase 2b unchanged) AND one TCP forward (host:25565 → container:25565) AND one UDP forward (host:19132 → container:19132) AND one TLS-SNI forward (host:993 SNI mail.example.com → container:993). All four succeed, the global layer4 file at `/etc/caddy/sites/_layer4.conf` contains all three forwards, the per-domain merged files contain the HTTP routes, and `caddy adapt` validates the entire chain.
- [ ] Conflict detection (DB): attempt a duplicate `(host_port=25565, protocol=tcp)` — rejected with the new error naming the existing service.
- [ ] Conflict detection (system): bind port 25566 with a `nc -l` process, attempt to add a forward at `(25566, tcp)` — rejected with a 400 naming the conflicting process and PID.
- [ ] Edit a port forward's target port — the global layer4 file rewrites with the new target, all other forwards are preserved.
- [ ] Delete a port forward — the global layer4 file shrinks, all other forwards stay.
- [ ] Delete the parent service — every route AND every port forward under it cascades, the global layer4 file updates accordingly.
- [ ] Network map page (`/network-map`) renders every service, every route, every port forward, and lists system-bound ports separately. Refreshes via the existing fetch hooks.
- [ ] `GET /api/services/network-map` returns the expected JSON shape; piping to `jq` gives a usable inventory.
- [ ] Audit log: every CRUD action on a port forward has a corresponding `PORT_FORWARD_*` row in `audit_log` carrying the parent `service_id` and the forward's `(host_port, protocol)`.
- [ ] **Mobile: 360px Network Map page** — renders all services + routes + port forwards as a card stack at 360×640 with no horizontal scroll, every action button ≥44×44px.
- [ ] **Mobile: 360px Add Port Forward dialog** — operator can add/edit/remove a forward on a 360px viewport; conflict errors wrap cleanly inside the dialog.
- [ ] **Mobile: 1280px desktop regression** — the new sidebar entry, network map page, and port forwards section don't introduce horizontal scroll on the existing Phase 1/2/2b pages.
- [ ] Caddy `adapt` validates the merged Caddyfile (per-domain files + global layer4 file together) without errors.
- [ ] Plugin install documentation: the `xcaddy build --with github.com/mholt/caddy-l4` one-liner appears in the missing-plugin banner AND in the phase spec, with a fallback note pointing operators at any pre-built ProxyPilot Caddy binary that may exist.

**Commit:** `phase-02c: layer 4 port forwards via caddy-l4 plugin`

---

## Function-by-Function Checklist (to be populated)

> This section is a placeholder. The next planning session will decompose the phase deliverables into a per-function checklist: one function → implement → test → check off → move on. Each function gets its own line with a checkbox, the file it lives in, and a one-line success criterion. Do not populate this now — leave the placeholder in place.

- [ ] _pending_
