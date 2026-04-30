# Next session — VPN Manager (build sequence steps 5–7)

You are picking up the ProxyPilot Firewall + VPN + SSH CA upgrade. The
firewall manager (steps 1–4) is already merged on
`claude/firewall-manager-step1-Q3F7N`. **Do not** re-implement it; rely
on it.

## Spec

The complete spec lives at the repo root:

    proxypilot-firewall-vpn-ssh-prompt.md

Read it end-to-end before writing code, especially:

- `## Design Principles (specific to this upgrade)`
- `## Firewall Manager` — you build *on top* of this; you don't change
  it. Pay attention to the named-services registry in
  `cli/src/core/firewall/render.js` and the per-rule scope semantics
  (`vpn-only`, `source_cidrs` overrides scope).
- `## VPN Manager` — your scope this session.
- `## Implementation Constraints` — particularly: no `iptables`
  anywhere, no direct `nft` calls outside the firewall manager, no
  private keys in SQLite or audit logs, atomic file writes,
  determinism.

The supersession table tells you which sections of the legacy docs go
away. Code in those sections must be **removed**, not preserved.

## Branch

Cut a fresh branch from the latest `main`:

    git fetch origin main
    git checkout main
    git pull origin main
    git checkout -b claude/vpn-manager-<your-session-suffix>

Push to that branch only. Do not piggyback on
`claude/firewall-manager-step1-Q3F7N`.

## Scope of this session

Work the spec's `## Build Sequence` for steps **5, 6, and 7** only:

5. **VPN server setup** rewritten to use the firewall manager. No
   `iptables` calls anywhere. Existing peer flow keeps working — the
   point of step 5 is to retire the imperative shell-outs without
   regressing today's users.
6. **VPN peer lifecycle** — keypair generation, QR rendering,
   enable/disable, rotate. Migrate any existing peer records into the
   new schema (preserving public keys and IP allocations).
7. **VPN scope** — per-peer firewall rules + Caddy matcher updates.

VPN endpoint discovery, the bootstrap peer at init, Standard-profile
gating, and the admin dashboard UI live in later sessions. Do not
touch SSH CA work in this session.

## What "done" looks like per step

### Step 5 — VPN server setup via firewall manager

- Replace any `iptables` PostUp / PostDown lines in the existing
  `wg0.conf` template with **no** PostUp/PostDown. NAT and forwarding
  are emitted into `proxypilot.nat_postrouting` by the firewall
  manager.
- Detect the default-route interface once, store in SQLite
  (`vpn_config.default_iface`), reference from the firewall manager
  when emitting the MASQUERADE rule. The firewall manager's
  `nat_postrouting` chain currently has no body — you'll extend
  `cli/src/core/firewall/render.js` (or a helper module under
  `cli/src/core/vpn/`) to emit `oifname <iface> masquerade` when VPN
  is enabled.
- Add a `proxypilot vpn enable` and `proxypilot vpn disable` command
  pair. `enable` flips `base-wireguard` on, persists `vpn_config`,
  writes `wg0.conf`, runs `wg-quick up wg0`, and reconciles the
  firewall (which emits the MASQUERADE rule). `disable` is the inverse
  — but per spec, peer records are kept; only the interface and the
  base allowlist entry go down.
- Smoke check: `proxypilot vpn enable` brings `wg0` up, `wg show`
  reports the listening port, `nft list table inet proxypilot` shows
  the MASQUERADE rule in `nat_postrouting`, and the `base-wireguard`
  rule is enabled. `proxypilot vpn disable` reverses cleanly.

### Step 6 — Peer lifecycle

- Implement `proxypilot vpn peer add <name> [--scope ...]`:
  1. `wg genkey` → peer private key (in memory only — never persisted
     server-side).
  2. `wg pubkey` from the private key → store the **public** key only.
  3. Allocate next free IP from the pool table (`vpn_ip_pool`).
  4. Hot-apply via `wg set wg0 peer <pub> allowed-ips <ip>/32`.
  5. Persist the peer's `[Peer]` block into `wg0.conf` so it survives
     reboot.
  6. Render the **client** config with the peer's private key, the
     server pubkey, the endpoint, and the routing.
  7. Render a QR code (PNG + ANSI). Use `qrencode` (already installed
     by `install_dependencies` in `install.sh`) — do **not** add a new
     npm dep just for QR rendering.
  8. Print the client config + QR + the file path
     (`/var/lib/proxypilot/vpn-peers/<name>.conf`, mode 0600). Audit
     log entry. The private key MUST NOT appear anywhere except this
     one client config file and the operator's terminal.
- Implement `peer rotate`, `peer enable`, `peer disable` (preserves
  record), `peer remove [--force]`, `peer list` (joining SQLite with
  `wg show wg0 dump`), `peer show <name> [--qr] [--rotate-first]`
  (refuses to reprint a private key by default; only `--rotate-first`
  yields a new keypair to print).
- Migrate any existing `vpn_peers` rows from the legacy schema (Phase
  12's planned schema) into the new schema. Preserve `public_key`,
  `allowed_ip`, `name`, `created_at`. If the legacy `vpn_peers` table
  doesn't exist yet, the migration is a no-op.
- Smoke check: `peer add admin-laptop` produces a working config that
  imports cleanly into the WireGuard mobile client (operator confirms
  by hand on a real device); `peer rotate` invalidates the old key
  immediately; `peer list` shows live handshake data.

### Step 7 — Per-peer scope + Caddy matcher updates

- Each peer's `scope` (`full` | `admin` | `services`) maps to firewall
  rules. Implement `cli/src/core/vpn/scope.js` that, given the current
  `vpn_peers` rows, produces:
  - For `full` / `admin` peers: no extra firewall rules (they get
    everything that has a `vpn-only` firewall rule, scoped to
    `10.100.0.0/24`).
  - For `services <list>` peers: per-`/32` allow rules into the
    firewall manager's `discovered` array, plus a per-`/32` deny rule
    for any `vpn-only` rule the peer is **not** allowed to reach.
- For HTTP services (Caddy routes flagged `--vpn-only`): extend the
  Caddy admin-API integration so a route gets a narrower
  `remote_ip <peer-ip>/32` matcher returning 403 when the peer's
  scope excludes that route. The matcher list is regenerated on every
  scope change.
- For non-HTTP services (PgBouncer stats, container SSH, anything
  exposed via `caddy-l4`): the firewall manager enforces the scope at
  L4 — no Caddy matcher exists for those, so the firewall is the only
  enforcement point.
- `proxypilot vpn peer set-scope <name> <scope> [--services <list>]`
  hot-applies via firewall reconcile.
- Smoke check: a peer with `--scope services pgbouncer-stats` can
  reach pgbouncer-stats on the VPN; the same peer cannot reach a
  vpn-only Caddy route they're not on the allow list for; an `admin`
  peer reaches everything.

## Hard constraints (re-read every commit)

1. **No `iptables` shell-outs anywhere.** This is the explicit headline
   of step 5.
2. **No direct `nft` calls outside the firewall manager.** The VPN
   module composes by mutating `firewall.json` (e.g. enabling
   `base-wireguard`, adding `discovered` rules with `source: 'vpn'`,
   recording the default iface for NAT) and calling
   `cli/src/core/firewall/index.js`'s `reconcile()`. It must never
   `spawn('nft', ...)` itself.
3. **No private keys in SQLite or audit logs.** Only public keys,
   fingerprints, and `key_id` / `serial` numbers may appear in
   persisted state. Audit `peer add` with the peer name + allocated
   IP + actor; never the private key.
4. **Atomic file writes.** `wg0.conf` writes go through `.tmp +
   rename(2)`. Same for the per-peer config files in
   `/var/lib/proxypilot/vpn-peers/`.
5. **Lockout safety.** `peer revoke` of the only enabled peer
   prompts. `peer disable` of the operator's own peer prompts. CA
   rotation is out of scope this session, so don't touch it.
6. **Determinism.** Identical `vpn_peers` rows + `vpn_config` →
   byte-identical `wg0.conf` across runs. Sort peers by `id` (or
   `created_at`, then `id`) before emitting.
7. **Profile gating.** Standard installs the VPN module but does NOT
   start `wg-quick@wg0` or open 51820/udp. The operator opts in with
   `proxypilot vpn enable`. (You don't need to wire up profile
   detection now if it's not present in the codebase yet — but the
   code path must support being not-enabled-yet without crashing.)

## Composition with the firewall manager

The firewall manager already exists. You do not modify it; you compose
with it.

- **Adding the WireGuard base allowlist entry.** It's already in
  `state.js` as `base-wireguard` (port 51820/udp, public, disabled).
  `proxypilot vpn enable` flips its `enabled` to true via the existing
  `enable({ id: 'base-wireguard', ... })` toggle and reconciles. Do
  not invent a new entry.
- **Emitting the MASQUERADE rule.** Two reasonable options:
  1. (Preferred) Extend `cli/src/core/firewall/render.js` with a
     `renderNatPostrouting(state)` helper that, given a
     `state.nat.vpn_masquerade_iface` field, emits
     `oifname <iface> ip saddr 10.100.0.0/24 masquerade`. The VPN
     module sets that field via a new `state.nat` section.
  2. Add a sibling `nat_postrouting` source array (parallel to
     `discovered`) that the firewall manager renders generically.
  Choose one and document the choice in the commit message.
- **Per-peer scope rules.** Use the firewall manager's existing
  `discovered` array with `source: 'vpn'` and `enabled: true`,
  `scope: 'vpn-only'`, `source_cidrs: ['<peer-ip>/32']`. Stable id
  format: `vpn-peer-<peer-name>-<service-name>` so toggles survive
  scope changes.
- **Audit.** Use the existing `audit({...})` helper at
  `cli/src/db/audit.js` with `subsystem: 'vpn'`. Every `peer add`,
  `peer rotate`, `peer disable`, `peer remove`, `peer set-scope`
  produces one row.

## File layout (anchored to existing project structure)

This project is **JavaScript ES modules**, not TypeScript — the spec's
`.ts` paths are illustrative. Follow the existing pattern:

```
cli/src/core/vpn/
  server.js        # init, wg0.conf rendering, enable/disable, default-iface detection
  peer.js          # add / rotate / enable / disable / remove
  qr.js            # qrencode wrapper (PNG + ANSI)
  status.js        # `wg show wg0 dump` parsing, watch loop
  scope.js         # peer scope -> firewall.discovered + caddy matchers
  index.js         # public re-exports

cli/src/commands/vpn/
  enable.js disable.js status.js watch.js endpoint.js
  peer-add.js peer-rotate.js peer-enable.js peer-disable.js
  peer-remove.js peer-list.js peer-show.js peer-set-scope.js
  index.js         # re-export aggregator

cli/src/db/schema.js            # add vpn_config, vpn_peers, vpn_ip_pool tables
cli/bin/proxypilot.js           # commander wiring for `proxypilot vpn ...`
scripts/install-vpn.sh          # NEW. WireGuard kernel module check, /etc/wireguard
                                # perms, no systemd units beyond wg-quick@wg0 itself
install.sh                      # call scripts/install-vpn.sh after install-firewall.sh
update.sh                       # same
```

## Hard segmentation rules (re-read from the previous session prompt)

These are non-negotiable. The harness hangs when one tool call does
too much.

1. **Reads ≤ 200 lines.** Use `Grep` to locate, then `Read` a tight
   window with `offset` + `limit`.
2. **Edits are targeted.** Use `Edit` with just-enough context.
3. **Long-running commands run in the background.** `npm install`,
   anything > a few seconds, goes through `run_in_background: true`.
4. **TodoWrite checkpoints between segments.** Update after every
   meaningful step.
5. **One checklist item = one commit. Push after every commit.** Do
   not batch step 5 + 6 into one commit.

## Testing notes

- Building a real WireGuard peer config and importing it on a phone is
  the only way to fully validate step 6. Plan to run the
  `peer add admin-laptop` flow on a real host with `wg-quick` available
  and confirm the QR scans cleanly.
- `wg show wg0 dump` is the source of truth for live handshake data;
  never trust just SQLite for `peer list`.
- `wg-quick up wg0` requires the kernel module. On a fresh Debian
  install that's `apt install wireguard`; the install-vpn.sh script
  should ensure that.
- Lockout test: revoke the only enabled peer of an operator who is
  themselves on the VPN. The command must refuse without `--force`.

## What NOT to do this session

- Do not implement SSH CA, `harden-vpn-only`, `access bootstrap`, or
  the admin dashboard UI for VPN. Those are later sessions.
- Do not modify the firewall manager's contracts. If you need a new
  capability (e.g. a `nat_postrouting` body), add it as an additive
  extension.
- Do not introduce a new audit_log table — use the existing one.
- Do not introduce a new SQLite `migrations` mechanism. Append to
  `cli/src/db/schema.js` with `IF NOT EXISTS` like the existing tables.
- Do not commit `node_modules/`. The `.gitignore` already excludes it.
- Do not push to `main` or to the firewall branch. New branch only.

## Begin

After reading the spec end-to-end, post a one-paragraph plan for
**step 5** specifically (the firewall-manager-driven server setup, no
`iptables`) before writing code. Wait for go.
