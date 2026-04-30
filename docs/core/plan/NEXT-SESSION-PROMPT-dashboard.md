# Next session — Admin dashboard panels (build sequence step 14)

You are picking up the ProxyPilot Firewall + VPN + SSH upgrade.
Six things are already shipped — do **not** re-implement any of
them:

* Firewall manager (steps 1–4).
* VPN server (step 5).
* VPN peer lifecycle (step 6).
* Per-peer scope at L4 + L7 (step 7a/7b).
* SSH access manager (step "8′") — backend, CLI, bootstrap script,
  AND its own dashboard panel. The session before this one
  shipped that panel as part of the same scope; this session does
  NOT re-do the SSH access panel, only firewall + VPN.
* The original SSH CA chain (steps 8–12 / 15) is **shelved** per
  the spec deviation note. Do not implement it.

## Spec

The complete spec lives at the repo root:
`proxypilot-firewall-vpn-ssh-prompt.md`. The relevant sections:

* `## Firewall Manager` — the L4 surface this session exposes
  through the dashboard. Read `### Toggle Surface` end to end —
  every CLI verb here gets a UI equivalent.
* `## VPN Manager` → `### Peer Lifecycle`, `### Per-Peer Scope`,
  `### Live Status` — same. The dashboard wraps every CLI verb
  in `proxypilot vpn` + `proxypilot vpn peer`.
* `## File Organization` — the spec lists
  `src/admin/components/firewall/` and `src/admin/components/vpn/`
  as the target layout. The current admin app uses
  `admin/frontend/src/pages/` (one file per page) instead, so
  treat the spec layout as a hint and follow the existing
  convention. Mirror the `LxcContainers.jsx` / `IncusManagement.jsx`
  shape.

## Branch

Harness assigns. Branch off whatever the SSH-access session
shipped (head TBD when you start). Do **not** push to main, the
firewall branch, or any step 5 / 6 / 7 branch.

## Scope of this session — firewall + VPN dashboard panels only

Implement build-sequence step 14 for the two subsystems whose CLI
already exists:

* **Firewall panel** — list / enable / disable / set-scope /
  add-manual / remove-manual / scan / reconcile / panic-close /
  panic-open, plus container-egress allow / deny.
* **VPN panel** — vpn enable/disable, peer add (with QR display
  one-shot), peer rotate, peer enable/disable, peer remove, peer
  set-scope, watch (live wg show stream).

Do **not** implement:

* The SSH access panel (already shipped in the previous session).
* The SSH CA panels (cert table, role matrix, issue dialog) — the
  CA chain is shelved.
* Any new CLI surface. This session is purely UI on top of
  shipped CLI verbs.

## What "done" looks like

### Backend routes

Two new files under `admin/backend/src/routes/`. Each wraps the
core CLI module's exported functions directly — no shell-out to
`proxypilot ...`. Auth + sudo gate via the existing `auth.js` /
`SudoModal.jsx` pattern. Mirror the `services.js` route shape.

* `firewall.js` exposes:
  ```
  GET    /api/firewall/state
  GET    /api/firewall/rules?filter=all|enabled|needs-review
  POST   /api/firewall/rules/:id/enable    { scope?, source_cidrs?, service? }
  POST   /api/firewall/rules/:id/disable
  POST   /api/firewall/rules/:id/scope     { scope, source_cidrs?, service? }
  POST   /api/firewall/manual              { port, port_end?, proto, scope, reason, service?, source_cidrs? }
  DELETE /api/firewall/manual/:id
  POST   /api/firewall/scan
  POST   /api/firewall/reconcile           { dry_run? }
  GET    /api/firewall/status
  POST   /api/firewall/panic-close
  POST   /api/firewall/panic-open
  GET    /api/firewall/egress
  POST   /api/firewall/egress              { container, service, container_ip?, reason? }
  DELETE /api/firewall/egress              { container, service }
  ```

* `vpn.js` exposes:
  ```
  GET    /api/vpn/status
  GET    /api/vpn/config
  POST   /api/vpn/enable                   { endpoint, port?, dns? }
  POST   /api/vpn/disable
  POST   /api/vpn/endpoint                 { endpoint }
  GET    /api/vpn/peers
  GET    /api/vpn/peers/:name
  POST   /api/vpn/peers                    { name, scope, services? }
  POST   /api/vpn/peers/:name/rotate
  POST   /api/vpn/peers/:name/enable
  POST   /api/vpn/peers/:name/disable      { force? }
  POST   /api/vpn/peers/:name/set-scope    { scope, services?, force? }
  DELETE /api/vpn/peers/:name              { force? }
  GET    /api/vpn/peers/:name/qr           # PNG image, refuses unless ?rotate=1
  GET    /api/vpn/watch                    # Server-Sent Events: wg show every 2s
  ```

* The lockout-class endpoints (`peers/:name/disable`,
  `peers/:name/set-scope`, `DELETE /peers/:name`) accept a
  `force` flag in the body. The CLI's typed-confirmation phrase
  is enforced in the dashboard via a confirmation modal that
  requires the operator to type the same phrase verbatim before
  the `force: true` body is sent. The phrases are the four in
  use today plus the SSH-access one from the previous session;
  pick the right one per endpoint:
  * `peer disable` (last enabled): "I understand this locks
     everyone out"
  * `peer remove` (recently active): "remove this active peer"
  * `peer set-scope` (last admin demote): "demote the last admin
     peer"
* The `/api/vpn/peers` POST response includes the peer's private
  key + the QR code as a one-shot delivery payload. The
  frontend's "Add peer" modal displays both, the operator scans
  / saves, then closes the modal — the response is never logged
  on the server. (Same posture as the CLI.)
* The `/api/vpn/watch` endpoint streams `wg show wg0 dump`
  output every 2 seconds via SSE so the panel can show
  live handshake / rx / tx without polling. Reuse the existing
  `terminal-ws.js` SSE / WebSocket pattern if it exists; if it
  doesn't, plain SSE is fine.
* The reconcile + add-manual / enable / set-scope endpoints
  return both `firewall` and `caddy` sub-results (the same shape
  the CLI surfaces) so the frontend can display warnings inline.

### Frontend pages

Two new pages under `admin/frontend/src/pages/`, mirroring the
`LxcContainers.jsx` / `IncusManagement.jsx` structure (single
file, top-level component, hooks for data fetching, modals
inline). Use the existing `components/ui` primitives and the
shared `Layout.jsx` wrapper.

* `FirewallRules.jsx`:
  * Status banner at the top: backend (always nftables), policy
    (always deny), enabled rule count, last reconcile timestamp
    + checksum, panic-close state. Banner turns red when
    panic-close is on with a "Panic Open" button.
  * Tabs: "Needs Review" (default — shows discovered rules with
    `enabled = 0`), "Enabled", "All".
  * Rule table: id, source, container, process, port, proto,
    scope, service tag, reason, last-seen. Per-row actions:
    Enable / Disable / Set Scope (modal) / Remove (only for
    `source = 'manual'`).
  * "Add manual rule" button → modal with port / proto / scope /
    reason / service / source-cidrs fields. POSTs to
    `/api/firewall/manual` and refreshes.
  * "Scan" button → POSTs `/api/firewall/scan`, surfaces
    new "needs review" entries. "Reconcile" button → POSTs
    `/api/firewall/reconcile`, displays the warnings (e.g.
    empty-peer-set sentinel) inline.
  * "Panic Close" button at the bottom right with a typed
    confirmation modal (phrase: `panic close the firewall`).
    Distinct from the four typed phrases already in use; this
    is a sixth, NOT a CLI gate (panic-close has no CLI typed
    confirm today, but the dashboard adds one because mis-clicks
    are easier than mis-types).
  * Container egress sub-tab: list / add / remove. Mirrors the
    `proxypilot firewall egress` CLI verbs.

* `VpnPeers.jsx`:
  * Status banner: interface up/down, listen port, peer count,
    online peer count (handshake within 180s), total rx / tx,
    last reconcile of dependent firewall rules.
  * If VPN is disabled: a single "Enable VPN" button with an
    endpoint input.
  * Peer table: name, ip, scope (with services chips when
    `scope = 'services'`), status (enabled / disabled), online
    (green dot if handshake within 180s), last-handshake
    (relative), rx / tx, endpoint. Per-row actions: Rotate /
    Enable / Disable / Set Scope (modal) / Remove. Each
    lockout-class action opens its typed-confirmation modal as
    described above.
  * "Add peer" button → modal with name / scope / services
    fields. On success the response is parsed for the QR PNG
    (base64 data URL) + the private key + the config text. The
    modal then displays:
    * The QR code as a large `<img>` for phone scanning.
    * The config text in a `<pre>` block with copy-to-clipboard.
    * A clearly-marked "save this private key — we cannot
      reprint it" warning.
    * A "Done — saved and delivered" button that closes the
      modal. The displayed payload is NOT persisted to any
      browser storage; closing the modal drops the in-memory
      copy.
  * "Watch" toggle in the status banner → opens an EventSource
    against `/api/vpn/watch` and live-updates the rx / tx /
    last-handshake columns every 2 seconds. Closes the
    EventSource when toggled off or when the page unmounts.
  * "Disable VPN" button at the bottom right with a typed-
    confirmation modal (phrase: `disable the entire vpn`).
    Sixth phrase (firewall panic close adds the fifth) — keep
    the list distinct.

* Both pages share a small `useSudo()` hook for the privilege
  prompt + a `useApi()` hook for fetch + error handling, both
  modeled on the existing `LxcContainers.jsx` patterns.

* Sidebar entries in `admin/frontend/src/components/Layout.jsx`:
  "Firewall" (between LXC Containers and SSH Access), "VPN"
  (between Firewall and SSH Access).

### Smoke check (operator confirms by hand)

* `/firewall` page loads, shows the base allowlist + any
  discovered rules. Toggling `base-ssh` to `vpn-only` triggers
  the firewall reconcile and the operator sees the new
  checksum + warning banner if SSH would otherwise be locked out.
* Adding a manual vpn-only rule with `--service infisical`
  through the UI lands a row, reconciles, and the table shows
  the service-tag chip.
* Container egress sub-tab: adding `myapp -> pgbouncer` lands
  the rule, removing it re-reconciles. Verify against the
  rendered nft ruleset on the host.
* `/vpn` page loads. Enabling VPN with an endpoint succeeds
  (assuming step 5's prerequisites are met). The status banner
  populates. "Watch" updates rx / tx live without page refresh.
* Adding a peer through the modal shows the QR + private key +
  config. Scanning the QR with the WireGuard mobile app
  successfully connects. Closing the modal drops the payload
  (re-opening the peer's row offers only Rotate / Enable /
  Disable / Set Scope / Remove — no reprint).
* Set-scope from `admin` → `services` with `infisical` works;
  the warnings panel shows any vpn-only rules whose source set
  emptied (firewall side) and any vpn-only routes whose matcher
  emptied (caddy side). Both layers reconcile.
* Disabling the only enabled peer triggers the typed-confirmation
  modal. Typing the wrong phrase blocks the action; typing the
  right phrase proceeds. The peer's `/32` drops from every
  matcher within one reconcile cycle.
* Panic close: the firewall page's Panic Close modal requires
  the typed phrase, then closes everything except SSH +
  WireGuard (per panic-close semantics). Panic Open restores.

## Hard constraints (re-read every commit)

1. **No new CLI surface.** This session is purely UI on top of
   the CLI verbs that shipped in steps 1–7 + step "8′". If you
   reach for a CLI verb that doesn't exist, stop and surface
   the gap — don't invent one mid-session.
2. **No shell-out from the backend.** The new route files import
   the core modules directly (`cli/src/core/firewall/index.js`,
   `cli/src/core/vpn/index.js`). Same import path the CLI
   commands use. Spawning `proxypilot ...` from Node would
   double the audit chain and double the actor resolution.
3. **No private keys in any persistent surface.** The peer-add
   response carries the private key + QR, displayed once, never
   stored in browser localStorage / sessionStorage / IndexedDB.
   Backend never logs the response body for this endpoint.
4. **Lockout safety: typed-confirmation modals match CLI gates.**
   Six phrases total now in use across CLI + dashboard:
   * `I understand this locks everyone out` — peer disable (last)
   * `remove this active peer` — peer remove (recently active)
   * `demote the last admin peer` — peer set-scope (last admin)
   * `i have another way into this account` — ssh-access revoke
     (last managed key)
   * `panic close the firewall` — dashboard-only, firewall panic
   * `disable the entire vpn` — dashboard-only, vpn disable
   Use these exact strings — operators learn them once.
5. **SSE / WebSocket cleanup.** The `vpn watch` EventSource MUST
   close when the panel unmounts or the toggle flips off. Leaked
   EventSources accumulate on the backend and leak `wg show`
   subprocesses.
6. **Reconcile + Caddy results displayed verbatim.** Every
   mutation that triggers `fwReconcile` + `reconcileVpnRoutes`
   surfaces both `firewall` and `caddy` sub-objects in the UI.
   Don't hide warnings; the empty-peer-set sentinel + caddy
   reload failure are the two most common operator surprises.
7. **Determinism at the data layer is unchanged.** The frontend
   sorts by what the API returns; the API returns what the core
   modules return; the core modules already sort deterministically
   (per step 7's audit pass). Don't add client-side re-sort
   that breaks the contract.
8. **Audit completeness.** No new audit actions in this session.
   Every mutation already has an audit row from the CLI core;
   the backend route just wraps the core call.
9. **Auth gate.** Every mutation route MUST go through the
   existing `auth.js` middleware + the `SudoModal.jsx`
   privilege prompt on the frontend. Read-only routes (`/state`,
   `/peers`, `/status`) are allowed for any authed user; the
   write routes require sudo.

## Composition with what's already shipped

* `cli/src/core/firewall/index.js` — re-exports `enable`,
  `disable`, `setScope`, `addManual`, `removeManual`, `list`,
  `reconcile`, `panicClose`, `panicOpen`, `allowEgress`,
  `denyEgress`, `listEgress`, `scan`, `readState`. Plus
  `resolveVpnSources` from step 7a.
* `cli/src/core/vpn/index.js` — re-exports `enable`, `disable`,
  `addPeer`, `rotatePeer`, `enablePeer`, `disablePeer`,
  `removePeer`, `setPeerScope`, `listPeers`, `showPeer`,
  `dumpPeers`, `validateEndpoint`, `renderQrPng`, `renderQrAnsi`.
* `cli/src/caddy/reconcile.js` — `reconcileVpnRoutes`. Already
  triggered as part of every peer mutation, so the dashboard
  doesn't need to call it directly.
* `cli/src/db/audit.js` — already wires every core mutation. No
  new audit actions; the backend wraps without re-auditing.
* `admin/backend/src/routes/services.js` — model for the new
  route files (auth middleware, error shape, sudo check).
* `admin/frontend/src/pages/LxcContainers.jsx` — model for the
  new pages (table layout, modal pattern, useApi hook).

Do **not** modify any existing core module. The dashboard is a
pure consumer.

## File layout

```
admin/backend/src/routes/
  firewall.js                      # NEW
  vpn.js                           # NEW

admin/frontend/src/pages/
  FirewallRules.jsx                # NEW
  VpnPeers.jsx                     # NEW

admin/frontend/src/components/
  Layout.jsx                       # +"Firewall", +"VPN" sidebar entries
  # plus any small modal / table components extracted while building
```

## Hard segmentation rules (non-negotiable)

Same as previous sessions:

1. Reads ≤ 200 lines.
2. Edits are targeted.
3. Long-running commands run in the background.
4. `TodoWrite` checkpoints between segments.
5. **One checklist item = one commit.** Push after every commit.
   Suggested split:
   1. Backend: `admin/backend/src/routes/firewall.js` (read +
      mutate routes, no panic-close yet).
   2. Backend: panic-close + container-egress routes.
   3. Backend: `admin/backend/src/routes/vpn.js` (read + mutate
      + add-peer with QR).
   4. Backend: `vpn watch` SSE endpoint.
   5. Frontend: `pages/FirewallRules.jsx` skeleton + table +
      enable/disable/set-scope.
   6. Frontend: add-manual modal + reconcile button + warnings
      surface + container egress sub-tab + panic close.
   7. Frontend: `pages/VpnPeers.jsx` skeleton + table +
      lifecycle actions.
   8. Frontend: add-peer modal with QR + private-key one-shot
      delivery + watch-toggle SSE wiring.
   9. Sidebar entries + small layout polish.
   10. Audit pass.

   That's ~10 commits — at the upper limit. If commits 1–4
   land in this session and the frontend balloons, split early
   into 14a (backend) + 14b (frontend) and finish in a follow-up.

## Audit pass requirement

After the commits land, re-read each against the constraints and
look specifically for:

* **Backend route writing to nft / wg0.conf / Caddyfile
  directly.** Every mutation MUST go through the core module's
  exported function. `spawnSync('nft', ...)` or
  `fs.writeFileSync('/etc/wireguard/wg0.conf', ...)` outside the
  core is a regression.
* **`peer add` response logged.** Search the backend logger for
  body interpolation on the add-peer route. The response carries
  the private key — body MUST NOT be logged.
* **EventSource cleanup.** Verify `useEffect` cleanup in the
  watch panel closes the SSE. Verify the backend SSE handler
  kills the `wg show` interval on `req.on('close')`.
* **Typed-confirmation modal phrase mismatches.** All six
  phrases verbatim. Easy to typo.
* **Sidebar entry duplicates.** `Layout.jsx` renders entries in
  a list — make sure SSH Access (from the previous session) +
  the new Firewall + VPN entries are all distinct and ordered
  predictably.
* **Sudo-gate bypass.** Read-only routes don't require sudo;
  every mutation route does. Verify by attempting a mutation
  without the sudo modal — it must reject.
* **Reconcile warnings hidden.** The empty-peer-set sentinel +
  caddy reload failure must surface in the UI's warnings
  banner. Easy to filter out by accident.

Fix what's worth fixing in a separate commit so the history
makes the fix obvious. Skip nice-to-have refactors.

## What NOT to do this session

* Do not implement the SSH access panel — already shipped in
  the previous session.
* Do not implement the SSH CA chain. Shelved.
* Do not add new CLI verbs. If a verb is missing for a UI action
  you want, surface the gap and stop — adding it requires
  re-opening the relevant CLI session.
* Do not store the peer's private key in any browser-side
  persistent storage.
* Do not auto-flip `PasswordAuthentication no` from the SSH
  access panel (still an operator manual step).
* Do not commit `node_modules/`. The `.gitignore` already
  excludes it.
* Do not push to main, the firewall branch, or any step 5 / 6 /
  7 / "8′" branch.

## Begin

After reading the spec sections referenced above + the route +
page files in `admin/`, post a one-paragraph plan covering:

* The two backend route files and their endpoint shapes.
* The two frontend pages and how each modal / table / banner
  composes from existing UI primitives.
* The SSE `/api/vpn/watch` shape (interval, payload, cleanup).
* How the typed-confirmation modal reuses the six existing
  phrases.
* Whether you intend to ship as a single session (~10 commits)
  or split into 14a (backend) + 14b (frontend) early.

Wait for go.
