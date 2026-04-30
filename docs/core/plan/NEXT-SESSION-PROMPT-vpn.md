# Next session — VPN Manager (build sequence steps 5–7)

You are picking up the ProxyPilot Firewall + VPN + SSH CA upgrade. The
Firewall Manager (build sequence steps 1–4) is already merged on
`claude/firewall-manager-step1-Q3F7N`. **Do not** re-implement it; the
VPN manager composes with it.

## Spec to follow

The complete specification lives at the repo root:

    proxypilot-firewall-vpn-ssh-prompt.md

Read it in full before writing any code, especially:

- `## Design Principles (specific to this upgrade)`
- `## Firewall Manager` — you build *on top* of it; do not change it.
  Pay attention to the named-services registry in
  `cli/src/core/firewall/render.js` and the per-rule scope semantics
  (`vpn-only`, `source_cidrs` overrides scope).
- `## VPN Manager` — your scope this session.
- `## Implementation Constraints` — particularly: no `iptables`
  anywhere, no direct `nft` calls outside the firewall manager, no
  private keys in SQLite or audit logs, atomic file writes,
  determinism.

It supersedes specific sections of the existing core infrastructure
prompt — the supersession table is in the spec's "Sections of the
Existing Prompt That This Upgrade Supersedes" section. When the
supersession table conflicts with anything in:

    proxypilot-core-infrastructure-prompt.md
    proxypilot-core-phased-plan.md
    docs/core/prompt/13-wireguard-vpn.md
    docs/core/plan/phase-12-wireguard-vpn.md

the new spec wins. Do not preserve legacy code "for compatibility" —
the spec calls out specifically that superseded code should be
removed.

## What's already shipped (read this before planning)

The firewall manager is complete and operational. Concretely:

- `cli/src/core/firewall/` exports `readState`, `writeState`,
  `render`, `reconcile`, `enable`, `disable`, `setScope`, `addManual`,
  `removeManual`, `panicClose`, `panicOpen`, `allowEgress`,
  `denyEgress`, plus `NAMED_SERVICES`.
- `cli/src/db/audit.js` exports `audit({ subsystem, action, ... })`.
  The VPN module uses it with `subsystem: 'vpn'`.
- `cli/src/db/schema.js` already runs lazily on first DB open via
  `getDb()` — append your tables there with `IF NOT EXISTS`.
- `firewall.json` already has a disabled `base-wireguard` entry
  (51820/udp, scope public). `proxypilot vpn enable` flips it on
  via the existing `enable({ id: 'base-wireguard' })` toggle.
- `scripts/install-firewall.sh` is the installer pattern. Mirror it
  for VPN as `scripts/install-vpn.sh`.
- The reference doc for the firewall manager is
  `docs/core/plan/phase-08b-firewall-manager.md`.
- The host has nftables ≥ 1.0.9 and `wg` available; install-vpn.sh
  must `apt install wireguard` if missing.

The codebase is **JavaScript ES modules**, not TypeScript. The spec's
`.ts` paths are illustrative.

## Scope of this session

Work ONLY the build sequence's steps **5, 6, 7**. Do not jump ahead.
Do not work on more than one step in a single commit. After each
step, run a smoke check (the spec describes what "working" means)
and commit + push.

5. **VPN server setup** rewritten to use the firewall manager. No
   `iptables` calls anywhere. The existing `wg0.conf` template loses
   its PostUp/PostDown lines; NAT + forwarding for `wg0` are emitted
   into `proxypilot.nat_postrouting` by the firewall manager.
6. **VPN peer lifecycle** — keypair generation (server-side, never
   persisted), QR rendering via `qrencode`, enable/disable (preserves
   record), rotate (invalidates old key immediately), remove. Migrate
   any existing `vpn_peers` rows into the new schema. (If there isn't
   a legacy table on this codebase, the migration is a no-op — note
   that explicitly.)
7. **Per-peer scope** — `full` / `admin` / `services` mapped to
   firewall rules and Caddy matchers. Scope changes hot-apply via
   firewall reconcile.

VPN endpoint discovery, the bootstrap peer at init, Standard-profile
gating, and the admin dashboard UI live in later sessions. Do not
touch SSH CA work.

## Branch

Cut a fresh branch from latest main:

    git fetch origin main
    git checkout main
    git pull origin main
    git checkout -b claude/vpn-manager-<your-session-suffix>

Push to that branch only. Do **not** piggyback on
`claude/firewall-manager-step1-Q3F7N`.

## Hard segmentation rules (the harness will hang otherwise)

These are non-negotiable.

1. **Reads ≤ 200 lines.** Use `Grep` to locate, then `Read` a tight
   window with `offset` + `limit`. Never `Read` a whole large file.
2. **Edits are targeted.** `Edit` with just-enough surrounding
   context. Never rewrite a whole file via `Write` unless it's brand
   new or under ~200 lines.
3. **Long-running commands run in the background.** `npm install`,
   anything > a few seconds, goes through `run_in_background: true`.
   Read output later via `BashOutput`. Never block a tool call on a
   slow process.
4. **TodoWrite checkpoints between segments.** Update after every
   meaningful step.
5. **One checklist item = one commit. Push after every commit.** Do
   not batch step 5 + 6 into one commit.

## What to deliver per step

For each step:

- Code under `cli/src/core/vpn/` per the spec's File Organization,
  adapted to JS:

      cli/src/core/vpn/
        server.js   # init, wg0.conf rendering, enable/disable, default-iface detect
        peer.js     # add / rotate / enable / disable / remove
        qr.js       # qrencode wrapper (PNG + ANSI for terminal)
        status.js   # `wg show wg0 dump` parse, watch loop
        scope.js    # peer scope -> firewall.discovered + Caddy matchers
        index.js    # public re-exports

- CLI subcommand wiring under `cli/src/commands/vpn/` (one file per
  subcommand, mirroring `cli/src/commands/firewall/`'s pattern), then
  registered in `cli/bin/proxypilot.js`.
- `cli/src/db/schema.js` additions: `vpn_config`, `vpn_peers`,
  `vpn_ip_pool` per the spec's SQLite Schema section. Use
  `IF NOT EXISTS`.
- `scripts/install-vpn.sh` — kernel module check (`wireguard`),
  `/etc/wireguard` perms, idempotent. No new systemd units beyond
  `wg-quick@wg0` itself; `proxypilot vpn enable` is the operator-
  facing command.
- Wire `install-vpn.sh` into both `install.sh` and `update.sh` after
  the firewall install hook.
- An `audit()` entry for every state mutation
  (`subsystem: 'vpn'`).
- A short manual-test note in each commit message describing how
  "working" was verified for that step.

## Composition rules (read carefully)

You compose with the firewall manager. You **do not** modify its
contracts.

- **WireGuard base allowlist entry.** Already exists as
  `base-wireguard` in `state.js`. Toggle via the existing
  `enable({ id: 'base-wireguard' })`.
- **MASQUERADE rule.** Two acceptable approaches. Pick one and
  document the choice in the commit message:
  1. (Preferred) Extend `cli/src/core/firewall/render.js` with a
     `renderNatPostrouting(state)` helper that, given a
     `state.nat.vpn_masquerade_iface` field, emits
     `oifname <iface> ip saddr 10.100.0.0/24 masquerade`. The VPN
     module sets that field via a new `state.nat` section.
  2. Add a sibling array (parallel to `discovered`) the firewall
     manager renders generically.
- **Per-peer scope rules.** Add into the firewall manager's
  `discovered` array with `source: 'vpn'`, `enabled: true`,
  `scope: 'vpn-only'`, `source_cidrs: ['<peer-ip>/32']`. Stable id
  format: `vpn-peer-<peer-name>-<service-name>` so toggles survive
  scope changes.
- **Reconcile.** After any state mutation, call the firewall
  manager's `reconcile()` to apply. The VPN module never invokes
  `nft` directly.

## What NOT to do this session

- Do not implement SSH CA, `harden-vpn-only`, `access bootstrap`, or
  the dashboard UI. Those are later sessions.
- Do not modify the firewall manager's external behavior. Additive
  extensions only.
- Do not introduce a separate audit-log table; use the existing one.
- Do not introduce a new SQLite migration mechanism. Append to
  `cli/src/db/schema.js`.
- Do not commit `node_modules/` (it's gitignored).
- Do not push to `main` or to the firewall branch.
- Do not call `iptables`, ever. The previous PostUp/PostDown lines
  must be **removed**, not commented out.
- Do not write peer private keys to SQLite, audit logs, or any file
  except the one-shot client config the operator carries away.

## Lockout safety

The VPN can lock the operator out two different ways:

1. Revoking the only enabled peer of an operator who is themselves on
   the VPN — `peer remove --force` is the only way to do this; the
   default form refuses if the peer was active in the last 24h (per
   spec).
2. Disabling the VPN while it's the only path to admin services —
   `proxypilot vpn disable` must warn (and refuse without `--yes`)
   if any Caddy route or firewall rule is currently `vpn-only`.

If during testing you accidentally lock yourself out of a remote test
host, do not try to fix it via the harness. Stop, document the
lockout, and ask the operator how to recover (typically: console /
out-of-band access, restore `firewall.json.bak`, run reconcile).

## Testing notes

- Building a real WireGuard peer config and importing it on a phone
  is the only way to fully validate step 6. Plan to run
  `peer add admin-laptop` on a real host with `wg-quick` available
  and confirm the QR scans cleanly.
- `wg show wg0 dump` is the source of truth for live handshake data;
  never rely on SQLite alone for `peer list`.
- `wg-quick up wg0` requires the `wireguard` kernel module. Fresh
  Debian: `apt install wireguard`. install-vpn.sh ensures this.
- Lockout test: revoke the only enabled peer of an operator who is
  themselves on the VPN. The command must refuse without `--force`.
- Determinism: identical `vpn_peers` + `vpn_config` → byte-identical
  `wg0.conf` and identical reconcile checksum across runs. Sort
  peers by id (or `created_at`, then `id`) before emitting.

## Begin

Read the spec end-to-end, then post a one-paragraph plan for **step 5
specifically** (the firewall-manager-driven server setup, no
`iptables`, MASQUERADE rule emitted via the firewall renderer) before
writing code.
