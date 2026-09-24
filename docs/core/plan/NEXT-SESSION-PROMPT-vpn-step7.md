# Next session — VPN per-peer scope (build sequence step 7)

You are picking up the ProxyPilot Firewall + VPN + SSH CA upgrade.
Three things are already shipped — do **not** re-implement any of them:

* Firewall manager (steps 1–4) — see
  `docs/core/plan/phase-08b-firewall-manager.md`.
* VPN server (step 5) — see `docs/core/plan/phase-12a-vpn-server.md`.
* VPN peer lifecycle (step 6) — six commits ending at `c5bef94` on
  `claude/setup-vpn-step6-prompt-OqCEZ`. The shipped record is
  `docs/core/plan/phase-12b-vpn-peers.md` if it exists; if it does
  not, read the step-6 commit log + `cli/src/core/vpn/peer.js` end
  to end before starting.

### Post-step-6 fixes also on the same branch (head `b4ca5e0`)

These shipped after step 6 in response to operator-reported issues.
Read each commit message; the changes alter the firewall renderer's
input shape and a few CLI surfaces step 7 will touch:

* `6a807dd` — `container_egress` chain's drop tail is now scoped to
  `daddr <bridge_gw>` (was unconditional drop of every saddr in the
  bridge CIDR; broke all LXC outbound traffic, including DNS and
  any backend the LXC's apps reached).
* `1b35486` / `5444369` — `input_hook` trusts the LXC bridge
  interface so containers can DHCP / DNS to the host's dnsmasq.
  Uses `iifname` (lazy string match), not `iif` (eager numeric
  index that nft rejects when the bridge isn't up at apply time).
* `84ecb73` — `state.network = { bridge_iface, bridge_cidr,
  bridge_gw }` parameterizes the renderer for hosts whose bridge
  isn't ProxyPilot's `pp-br0` default. Validated up-front via tight
  regexes in `bridgeFromState()`. Defaults preserved.
* `b4ca5e0` — `proxypilot firewall detect-bridge [--apply] [--force]`
  CLI auto-detects the host's managed Incus bridge from
  `incus network list --format json` and writes `state.network`.
  Wired into `scripts/install-firewall.sh` so install + update
  populate the field automatically; idempotent on re-runs.
* `196dc64` — service-card domain in the dashboard is now an
  `<a target="_blank">` link. Out of scope for step 7's L7 work but
  worth knowing the surface exists.

## Spec

The complete spec lives at the repo root:
`proxypilot-firewall-vpn-ssh-prompt.md`. Read it end-to-end before
writing code, especially:

* `## Design Principles (specific to this upgrade)` — state-driven,
  default deny, never lock the operator out, one chain one manager.
* `## VPN Manager` → `### Per-Peer Scope` and
  `### Admin Service Routing` — this is your scope.
* `## Firewall Manager` → `### Source of Truth` and
  `### Reconciliation` — your changes touch the renderer's **input**,
  not its output contract.
* `## Implementation Constraints` — no `iptables`, no direct `nft`
  outside the firewall manager, atomic file writes, determinism,
  lockout safety.

## Branch

The harness will assign a branch. Stay on it. Branch off
`claude/setup-vpn-step6-prompt-OqCEZ` (head `b4ca5e0`) so the
post-step-6 fixes above are present — step 7's work depends on
the parameterized `state.network` and on `bridgeFromState()`. Do
**not** push to main, the firewall branch, or the step 5 / 6
branches.

## Scope of this session — step 7 only

Implement `## Build Sequence` step 7 — per-peer scope enforcement at
both the firewall (L4) and Caddy (L7) layers. Do **not** start step 8
(SSH CA setup) in the same session.

If the Caddy work turns out larger than expected (the current
`cli/src/caddy/client.js` does not appear to have any
`remote_ip` / vpn-only matcher logic at all), it is acceptable to
split mid-session into:

* **7a** — firewall scope only (the L4 side).
* **7b** — Caddy matcher updates (the L7 side).

Default to a single session if both sides are tractable; commit to
the split early if 7a alone produces ≥ 5 commits.

### What "done" looks like

#### Firewall side (L4)

* Firewall rules (in `firewall.json` and `firewall_rules`) gain an
  optional `service` field — a stable string tag like `"infisical"`,
  `"grafana"`, `"pgbouncer-stats"`, `"meet-admin"`. Schema change is
  **additive**: a new column on `firewall_rules`. SQLite's
  `ALTER TABLE ... ADD COLUMN` runs once via a `PRAGMA table_info`
  guard (idempotent on re-run). Old rules without `service` keep
  their current semantics.

* The reconcile orchestrator (`cli/src/core/firewall/reconcile.js`)
  gains a pre-render step `resolveVpnSources(state)`: for every
  enabled rule with `scope: "vpn-only"`, compute the effective
  source-CIDR list as the union of:
  * every `full` or `admin` peer's `/32` (regardless of the rule's
    `service` tag).
  * every `services` peer's `/32` whose `scope_services_json`
    contains the rule's `service` tag (only when the rule has a
    `service` set).

  Materialize the result into the rule's `source_cidrs` field
  **before** `render(state)` runs. The renderer stays pure (it
  already honors `source_cidrs` over `scope`). Empty source set ⇒
  render the rule with an empty inline set; nft will accept it and
  the rule is effectively closed for VPN. Log the empty set, don't
  crash.

* Rules with `scope: "vpn-only"` and **no** `service` tag default to
  "all `full`/`admin` peers, no `services` peers" — the spec's
  "Other vpn-only rules deny this peer's /32" sentence drives this.
  Document the choice next to `resolveVpnSources()`.

* Every peer mutation (`peer add`, `peer rotate`, `peer enable`,
  `peer disable`, `peer remove`, the new `peer set-scope`) triggers
  a firewall reconcile so per-`/32` source lists stay current. Reuse
  the import path step 5 already wired (`fwReconcile` from
  `cli/src/core/firewall/index.js`). Do **not** introduce a second
  reconcile path.

* New CLI: `proxypilot vpn peer set-scope <name> <scope> [--services <list>]`.
  Updates `vpn_peers.scope` + `scope_services_json` in one tx, then
  reconciles. Audit action: `peer.set-scope`, before+after carrying
  the old/new scope and services. Lockout: refuse to demote the only
  `full`/`admin` peer to `services` if any vpn-only rule lacks a
  `service` tag — would silently kill admin reachability. `--force`
  + typed confirmation is the only escape, matching step 6's
  `peer disable` / `peer remove` pattern.

* `proxypilot firewall add-manual` / `enable` / `set-scope` gain an
  optional `--service <name>` flag. The flag is only meaningful on
  vpn-only rules; warn (do not error) if used on a rule with a
  different scope.

#### Caddy side (L7)

* **Investigate first.** Read `cli/src/caddy/client.js` and any
  Caddyfile templates end to end before designing. Determine whether
  routes already carry a `vpn-only` flag. If not, this is where the
  flag lands: an additive `routes.vpn_only INTEGER` column, an
  `--vpn-only` flag on `proxypilot route create`, and a route-level
  `service` field paralleling the firewall rule field.

* For routes flagged `vpn-only`, generate a Caddy matcher that lists
  exactly the `/32`s of peers allowed to reach the route, computed
  from the same join as the firewall side (route's optional
  `service` tag + each peer's scope/services). Matcher shape:

  ```
  @vpn-<routeid> remote_ip 10.100.0.10/32 10.100.0.42/32 ...
  handle @vpn-<routeid> { reverse_proxy ... }
  handle { respond 403 }
  ```

  Caddy returns 403 for sources outside the matcher. Sort the
  `/32`s numerically (by trailing octet) so the rendered Caddyfile
  is byte-identical across runs.

* Empty matcher ⇒ render an explicit `@vpn-<routeid>` with no IPs
  plus a `respond 403` for everyone. Do **not** omit the matcher;
  "no allowed peers" is meaningful state, not a render-time skip.

* Atomic-write the Caddyfile through `.tmp` + rename, same pattern
  as `wg0.conf` and the firewall ruleset. Reuse the `atomicWrite()`
  helper now exported from `cli/src/core/vpn/server.js`.

* Caddy reload via the existing path (`systemctl reload caddy` /
  `caddy reload --config`). Sequencing: firewall reconcile **first**
  (atomic, bails on lockout check), Caddy reload **second**. If
  Caddy reload fails, surface the error but do not roll back the
  firewall — L4 is the security boundary; L7 stale matchers are
  recoverable.

### Smoke check (operator confirms by hand on a real host)

* VPN enabled (step 5) and three peers exist (step 6): one `full`,
  one `admin`, one `services` with services `["infisical"]`.
* `proxypilot firewall add-manual --port 5432 --proto tcp --scope vpn-only --reason "postgres for ops" --service infisical`.
* `proxypilot firewall reconcile` succeeds; `nft list table inet proxypilot`
  shows the rule with all three peers' `/32`s in `ip saddr { ... }`.
* Add another manual rule with `--service grafana`. Reconcile. The
  `services`-scope peer is **not** in that rule's source set.
* Caddy: create a vpn-only route flagged
  `--vpn-only --service infisical`. Curl from the `services` peer
  succeeds. Curl from a `services` peer whose list does not include
  `infisical` returns `403`.
* `proxypilot vpn peer set-scope <name> services --services "infisical,grafana"`
  reconciles both layers; the same `services` peer now reaches both
  rules / routes.
* Disabling a peer drops their `/32` from every matcher within one
  reconcile cycle (sub-second) without bouncing wg0 or Caddy.
* `peer set-scope` of the only `admin` peer to `services` while a
  vpn-only rule lacks a `service` tag is refused without `--force`.

### Hard constraints (re-read every commit)

1. **No `iptables` shell-outs anywhere.**
2. **No direct `nft` calls outside the firewall manager.** Step 7
   extends the firewall manager's *input* (state pre-render). The
   renderer + apply path stay unchanged.
3. **No private keys in SQLite or audit logs.** Same as step 6.
4. **Atomic file writes** for the Caddyfile and any per-site
   config — `.tmp` + rename, mode-set explicitly post-write.
5. **Lockout safety.** `peer set-scope` demoting the last admin peer
   refuses without `--force` + a typed phrase. Use
   `output.confirmTyped()` from step 6 with a phrase distinct from
   the existing two (`I understand this locks everyone out` /
   `remove this active peer`) so muscle memory can't approve the
   wrong gate.
6. **Determinism.** Identical `vpn_peers` + `firewall_rules` +
   `routes` rows → byte-identical Caddyfile and byte-identical nft
   ruleset across runs. Sort peer `/32`s numerically (matches the
   step-6 IP-pool picker).
7. **Reconcile is the single mutation point at L4.** Peer mutations
   call `reconcile({ actor })`. Do not bypass.
8. **Audit completeness.** One audit row per mutation. The only new
   action is `peer.set-scope`; everything else reuses step-6 actions.
9. **`iifname` not `iif` for any iface-based input rule.** Eager
   `iif` resolution fails when the bridge isn't up at apply time
   (boot order, stopped containers). The post-step-6 fix
   established this; don't regress it.
10. **Network values come from `state.network` via `bridgeFromState()`,
    not hardcoded constants.** The post-step-6 fix removed
    `LXC_BRIDGE_CIDR` / `LXC_BRIDGE_GW` / `LXC_BRIDGE_IFACE` as
    consumer-facing constants. If step 7 needs the bridge GW (e.g.
    to compute "from VPN /32 → bridge service" rules), call
    `bridgeFromState(state)` so a host whose bridge isn't `pp-br0`
    still gets correct rules.

### Composition with what's already shipped

You build on top of these surfaces; you do not modify their
contracts:

* `cli/src/core/firewall/reconcile.js` — extend with
  `resolveVpnSources(state)` pre-render hook. Keep `reconcile()`
  signature stable. The post-step-6 fix already establishes the
  pattern: reconcile reads `state`, calls a pre-render resolver,
  hands richer state to `render()`. Mirror that.
* `cli/src/core/firewall/render.js` — already honors
  `source_cidrs`. **Do not edit the renderer.** Read the existing
  `bridgeFromState(state)` helper as a model — short, total, throws
  on invalid input — and add `resolveVpnSources(state)` next to it
  with the same shape.
* `cli/src/core/firewall/state.js` — extend rule schema (new optional
  `service` field). Schema migration in `cli/src/db/schema.js` adds
  the column under a `PRAGMA table_info` guard — append, don't
  introduce a migration framework.
* `cli/src/core/firewall/detect.js` — exists from the post-step-6
  fix; out of scope for step 7. Don't extend it for service
  detection.
* `cli/src/core/vpn/peer.js` — every mutation calls `fwReconcile`.
  Imports already exist for the base-toggle path; reuse them.
* `cli/src/caddy/` — extend to support per-route vpn-only matchers.
  Add `render.js` (pure render of route → site block) if the
  existing `client.js` is too tightly coupled to the imperative
  path.

### Known inconsistency you may want to fix in passing

`cli/src/core/firewall/render.js` still hardcodes
`NAMED_SERVICES.pgbouncer.dst = '10.0.100.1'`. After the post-
step-6 parameterization, this is wrong on hosts where the bridge
GW differs (e.g. the operator-reported `incusbr0` / `10.64.250.1`).
Step 7 touches the renderer's input shape; if you're adding a
service-tag pre-resolver anyway, plumbing the bridge GW through
`bridgeFromState()` so `NAMED_SERVICES` rewrites `dst` to the
actual gateway is a small additive fix. **Optional** — call it out
in the audit pass and ship as a separate commit if you have time;
skip if scope is already heavy.

### File layout

```
cli/src/core/firewall/
  reconcile.js     # +resolveVpnSources()
  state.js         # +service field on rule schema
cli/src/db/schema.js  # +ALTER TABLE firewall_rules ADD COLUMN service

cli/src/core/vpn/
  peer.js          # +setPeerScope(); every mutation calls fwReconcile
  index.js         # +export

cli/src/commands/vpn/
  peer-set-scope.js   # NEW
  index.js            # +export

cli/src/caddy/
  client.js           # +vpn-only matcher path + reload trigger
  render.js           # NEW if existing client.js is too imperative

cli/bin/proxypilot.js
  +`vpn peer set-scope` subcommand
  +`firewall add-manual --service`, `firewall enable --service`,
   `firewall set-scope --service`
```

### Hard segmentation rules (non-negotiable)

Same as step 6:

1. Reads ≤ 200 lines. Grep first, then `Read` with offset + limit.
2. Edits are targeted.
3. Long-running commands run in the background.
4. `TodoWrite` checkpoints between segments.
5. **One checklist item = one commit.** Push after every commit.
   Suggested split:
   1. Schema migration: `service` column on `firewall_rules`,
      optional field in `firewall.json` rule shape.
   2. `resolveVpnSources()` in `reconcile.js` (pure function,
      unit-testable).
   3. `peer set-scope` CLI + audit + lockout gate.
   4. Wire every peer mutation → `fwReconcile` (no behavior change
      for `full`/`admin`-only setups; `services` peers now actually
      get gated).
   5. Caddy renderer extension (vpn-only matcher per route).
   6. Caddy reload trigger from peer mutations + `firewall reconcile`.

   If 7a / 7b split: items 1–4 land as 7a, items 5–6 as 7b.

### Audit pass requirement

After the commits above land, do an audit pass like steps 5 and 6
had: re-read each commit against the hard constraints. Look for:

* `resolveVpnSources()` race conditions — `vpn_peers` is read
  outside any explicit tx; fine if reconcile is the single L4
  writer, flag otherwise.
* Missing reconcile triggers on any peer-mutation path (especially
  the error / partial-failure branches in step 6's `peer.js`).
* Caddy reload that races with firewall reconcile — the smoke check
  depends on the order.
* `atomicWrite` stale-`.tmp` inheritance (existing helper handles it
  via `flag: 'wx'`; verify any new file path uses it).
* Determinism breaks — `Object.entries` / `Map.values()` ordering
  used instead of an explicit sort.
* Empty-matcher path emits a sensible Caddyfile (don't drop the
  whole route block silently; render an explicit 403).

Fix what's worth fixing in a separate commit so the history makes
the fix obvious. Skip nice-to-have refactors.

### What NOT to do this session

* Do not implement step 8 (SSH CA setup). Separate session.
* Do not modify the firewall renderer's contract
  (`render(state) → ruleset string`). Only feed it richer state.
* Do not modify step 5 / 6 contracts (`enable`, `disable`,
  `addPeer`, `rotatePeer`, etc.) or the post-step-6 fix's
  contracts (`bridgeFromState()`, `detectBridge()`,
  `firewall detect-bridge` CLI). Add new exports additively.
* Do not re-introduce hardcoded `LXC_BRIDGE_*` constants. The
  post-step-6 fix removed them on purpose; new code reads from
  `state.network` via `bridgeFromState()`.
* Do not regress `iifname` to `iif` for any iface-based rule.
* Do not introduce a new `audit_log` table or migration framework.
* Do not commit `node_modules/`. The `.gitignore` already excludes it.
* Do not push to main, the firewall branch, or the step 5 / 6
  branches.

### Begin

After reading the spec end-to-end and the three phase docs (12b may
not exist yet — fall back to the step-6 commit log + `peer.js`),
post a one-paragraph plan for step 7 specifically:

* Firewall side — `service` column + `resolveVpnSources` join +
  `peer set-scope` CLI + reconcile triggers from every peer
  mutation.
* Caddy side — per-route `vpn-only` flag (verify whether it already
  exists) + per-peer matcher generation + reload sequencing after
  firewall reconcile.
* Whether you intend to ship as a single session or split into
  7a / 7b.

Wait for go.
