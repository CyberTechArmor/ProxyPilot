# Next session — VPN Manager (build sequence step 6)

You are picking up the ProxyPilot Firewall + VPN + SSH CA upgrade. The
firewall manager (steps 1–4) is merged on
`claude/firewall-manager-step1-Q3F7N`. The VPN **server** (step 5) is
shipped on `claude/setup-vpn-session-docs-pzqlc`. Read
`docs/core/plan/phase-08b-firewall-manager.md` and
`docs/core/plan/phase-12a-vpn-server.md` for what's already built —
**do not** re-implement either.

## Spec

The complete spec lives at the repo root:

    proxypilot-firewall-vpn-ssh-prompt.md

Read it end-to-end before writing code, especially:

- `## Design Principles (specific to this upgrade)`
- `## VPN Manager` → `### Peer Lifecycle` and `### SQLite Schema` —
  this is your scope.
- `## Implementation Constraints` — particularly: no `iptables`
  anywhere, no direct `nft` calls outside the firewall manager, no
  private keys in SQLite or audit logs, atomic file writes,
  determinism.

## Branch

Stay on `claude/setup-vpn-session-docs-pzqlc` (the harness assigns
this branch). Do **not** cut a new branch.

## Scope of this session — step 6 only

Implement `## Build Sequence` step 6 — peer lifecycle. **Do not** start
step 7 (per-peer scope) in the same session; that's a separate session
so the commit history stays readable.

### What "done" looks like

- `proxypilot vpn peer add <name> [--scope full|admin|services <list>]`:
  1. `wg genkey` → peer private key (in memory only, never persisted
     server-side).
  2. `wg pubkey` → store the **public** key only.
  3. Allocate the next free `/32` from `10.100.0.10`–`10.100.0.254`
     using the `vpn_ip_pool` table.
  4. Hot-apply via `wg set wg0 peer <pub> allowed-ips <ip>/32`. (Use
     `wg syncconf` after re-rendering `wg0.conf` so we don't bounce
     the interface — `wg-quick strip wg0 | wg syncconf wg0 /dev/stdin`
     is the canonical idiom.)
  5. Re-render `/etc/wireguard/wg0.conf` deterministically (peers
     sorted by id) and atomic-write it.
  6. Render the **client** config: peer's private key, server pubkey
     (from `vpn_config`), endpoint (from `vpn_config`), `AllowedIPs`
     based on scope (`0.0.0.0/0, ::/0` for `full`, `10.100.0.0/24`
     for `admin` and `services`), DNS from `vpn_config`.
  7. Render the QR code via `qrencode` (already installed by
     `install-vpn.sh`'s `wireguard-tools` chain — verify; if not, add
     `qrencode` to that script). PNG to disk + ANSI to stdout. **Do
     not add a new npm dep just for QR rendering.**
  8. Print the client config text + QR + the file path
     (`/var/lib/proxypilot/vpn-peers/<name>.conf`, mode 0600). One
     audit-log row. The peer's private key MUST appear ONLY in this
     one file and the operator's terminal — never in SQLite, never in
     the audit log, never in stderr.
- `proxypilot vpn peer rotate <name>`: new keypair, replace the
  `[Peer]` block, hot-apply (the old key is invalidated the moment
  `wg syncconf` runs), print a fresh client config + QR. Records the
  rotation timestamp in `vpn_peers.rotated_at`.
- `proxypilot vpn peer disable <name>`: removes the `[Peer]` block
  from `wg0.conf` and `wg set wg0 peer <pub> remove`. **Keeps** the
  SQLite row (status='disabled'), keypair (it never existed
  server-side), IP allocation, scope. `enable` is the inverse.
- `proxypilot vpn peer remove <name> [--force]`: hard-removes the
  SQLite row, returns the IP to the pool. Refuses without `--force`
  if the peer was active in the last 24h (consult `wg show wg0 dump`).
  Audit row. Lockout-safety: refuse to remove the **only enabled
  peer** if the operator is themselves on the VPN — match the
  firewall manager's `lockoutCheck` pattern.
- `proxypilot vpn peer list`: live table joining SQLite `vpn_peers`
  with `wg show wg0 dump`. Columns: name, ip, last-handshake, online
  (handshake within last 180s), rx, tx, scope, status. `--json`
  honored.
- `proxypilot vpn peer show <name> [--qr] [--rotate-first]`: refuses
  by default — the private key was only displayed once at `add` time.
  `--rotate-first` generates a new keypair and prints that.
- **Migration.** The legacy schema in `phase-12-wireguard-vpn.md` was
  never built, so there are no rows to migrate. Migration is a no-op;
  state this explicitly in your commit message.

### Smoke check (operator confirms by hand on a real host)

- `proxypilot vpn peer add admin-laptop` produces a config that imports
  cleanly into the WireGuard mobile client. Operator confirms QR scans.
- After `peer add` the operator runs `wg show wg0` and sees the new
  peer with `latest handshake: never` (until the client connects).
- `peer rotate admin-laptop`: old config no longer connects; new one
  does.
- `peer list` shows live handshake data after a real connection.

## Hard constraints (re-read every commit)

1. **No `iptables` shell-outs anywhere.**
2. **No direct `nft` calls outside the firewall manager.** Step 6 does
   not need to touch the firewall at all — peer scope (step 7) is the
   only firewall-affecting peer concern.
3. **No private keys in SQLite or audit logs.** Only public keys, IP
   allocations, peer names. Audit `peer add` with name + IP + actor;
   never the private key.
4. **Atomic file writes.** `wg0.conf` and per-peer config files
   through `.tmp + rename(2)`, mode 0600.
5. **Lockout safety.** `peer remove` of the only enabled peer prompts.
   `peer disable` of the operator's own peer prompts.
6. **Determinism.** Identical `vpn_peers` rows + `vpn_config` →
   byte-identical `wg0.conf` across runs. Sort peers by `id` before
   emitting (the SQL queries already do this; preserve it).
7. **Hot-apply, don't bounce.** `wg syncconf wg0 <(wg-quick strip
   wg0)` reloads peer set without dropping the interface. Reserve
   `systemctl restart wg-quick@wg0` for `vpn enable` (already done).

## Composition with what's already shipped

- **`vpn_peers`, `vpn_ip_pool`** are already in
  `cli/src/db/schema.js` (commit `3f04ab1`). Don't re-add. Read
  `phase-12a-vpn-server.md` for the column list.
- **Server module** at `cli/src/core/vpn/server.js` exposes
  `readVpnConfig()`, `validateEndpoint()`, `WG_CONFIG_FILE`,
  `WG_INTERFACE`, etc. Reuse via `cli/src/core/vpn/index.js`. The
  existing `renderWg0Conf({ privateKey, listenPort, serverIp,
  peers })` already takes the peer set, so peer add is "insert into
  SQLite → re-render → atomic-write → wg syncconf".
- **Audit** uses `cli/src/db/audit.js`'s `audit({...})` with
  `subsystem: 'vpn'`.
- **CLI wiring.** Add new files under `cli/src/commands/vpn/`:
  `peer-add.js`, `peer-rotate.js`, `peer-enable.js`,
  `peer-disable.js`, `peer-remove.js`, `peer-list.js`, `peer-show.js`.
  Re-export from `cli/src/commands/vpn/index.js`. Wire into
  `cli/bin/proxypilot.js` as a `vpn peer` subcommand group.
- **Core peer module.** Put non-CLI logic in
  `cli/src/core/vpn/peer.js` and add a `qr.js` for the qrencode
  wrapper. Re-export from `cli/src/core/vpn/index.js`.

## File layout

```
cli/src/core/vpn/
  peer.js          # NEW. add/rotate/enable/disable/remove/list/show
  qr.js            # NEW. qrencode wrapper (PNG + ANSI)
  status.js        # NEW. `wg show wg0 dump` parsing
  server.js        # (already shipped — extend if needed for syncconf helper)
  index.js         # add new exports

cli/src/commands/vpn/
  peer-add.js peer-rotate.js peer-enable.js peer-disable.js
  peer-remove.js peer-list.js peer-show.js
  index.js         # add new exports

cli/bin/proxypilot.js  # add `vpn peer ...` subcommand group
```

## Hard segmentation rules (non-negotiable)

1. **Reads ≤ 200 lines.** Use `Grep` to locate, then `Read` a tight
   window with `offset` + `limit`.
2. **Edits are targeted.** `Edit` with just-enough context.
3. **Long-running commands run in the background.** `npm install` etc.
4. **TodoWrite checkpoints between segments.** Update after every
   meaningful step.
5. **One checklist item = one commit. Push after every commit.**
   Suggested split:
   1. `core/vpn/qr.js` + `core/vpn/status.js`
   2. `core/vpn/peer.js` (add/rotate/enable/disable/remove)
   3. CLI command files + `bin/proxypilot.js` wiring
   4. `peer list` + `peer show` (read-side, no mutations)
   5. install-vpn.sh: confirm `qrencode` is installed (or add it)

## Testing notes

- The only way to fully validate `peer add` is to import the rendered
  config into a real WireGuard client (mobile app or `wg-quick up <peer.conf>`)
  and confirm a handshake. Plan to run this on a real host with the
  VPN already enabled.
- `wg show wg0 dump` is the source of truth for live handshake data;
  never trust just SQLite for `peer list`.
- For lockout test: revoke the only enabled peer of an operator who is
  themselves on the VPN. Command must refuse without `--force`.

## What NOT to do this session

- Do not implement step 7 (per-peer scope + Caddy matcher updates).
  That's a separate session.
- Do not implement SSH CA work, `harden-vpn-only`, `access bootstrap`,
  or the admin dashboard UI.
- Do not modify the firewall manager's contracts or the VPN server
  module's contracts (`enable`, `disable`, `validateEndpoint`,
  `renderWg0Conf`). If you need a new capability, add it as an
  additive extension.
- Do not introduce a new audit_log table — use the existing one.
- Do not introduce a new SQLite migration mechanism.
- Do not commit `node_modules/`.
- Do not push to `main` or to the firewall branch.

## Begin

After reading the spec end-to-end, post a one-paragraph plan for
**step 6** specifically (peer add/rotate/disable/enable/remove/list/show
hot-applied via `wg syncconf`, with QR rendering through `qrencode`)
before writing code. Wait for go.
