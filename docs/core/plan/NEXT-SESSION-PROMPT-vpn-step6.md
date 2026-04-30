# Next session — VPN Manager (build sequence step 6)

You are picking up the ProxyPilot Firewall + VPN + SSH CA upgrade.
Two things are already shipped — **do not** re-implement either:

- Firewall manager (steps 1–4) on `claude/firewall-manager-step1-Q3F7N`
  — see `docs/core/plan/phase-08b-firewall-manager.md`.
- VPN server (step 5) on `claude/setup-vpn-session-docs-pzqlc` (9
  commits, head `5ed861c`) — see `docs/core/plan/phase-12a-vpn-server.md`.

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
this branch and step 5 already lives on it). Do **not** cut a new
branch. Do **not** push to `main` or to the firewall branch.

## Scope of this session — step 6 only

Implement `## Build Sequence` step 6 — peer lifecycle. **Do not** start
step 7 (per-peer scope + Caddy matcher) in the same session; that's a
separate session so the commit history stays readable.

### What "done" looks like

- `proxypilot vpn peer add <name> [--scope full|admin|services <list>]`:
  1. `wg genkey` → peer private key (in memory only, never persisted
     server-side).
  2. `wg pubkey` → store the **public** key only.
  3. Allocate the next free `/32` from `10.100.0.10`–`10.100.0.254`
     using the `vpn_ip_pool` table. Released IPs (released_at set) are
     reusable.
  4. Hot-apply via `wg syncconf` after re-rendering `wg0.conf`. The
     canonical idiom is `wg syncconf wg0 <(wg-quick strip wg0)`. This
     reloads the peer set without bouncing the interface, so existing
     handshakes survive.
  5. Re-render `/etc/wireguard/wg0.conf` deterministically (peers
     sorted by id) and atomic-write it. Reuse the existing
     `renderWg0Conf()` from `cli/src/core/vpn/server.js`.
  6. Render the **client** config: peer's private key, server pubkey
     (from `vpn_config`), endpoint (from `vpn_config`), `AllowedIPs`
     based on scope (`0.0.0.0/0, ::/0` for `full`, `10.100.0.0/24`
     for `admin` and `services`), DNS from `vpn_config`.
  7. Render the QR code via `qrencode` — already installed by
     `install-vpn.sh`'s `wireguard-tools` chain. **Verify** by checking
     the package; if not present add `qrencode` to `install-vpn.sh` in
     a separate commit. PNG to disk + ANSI to stdout. **Do not add a
     new npm dep just for QR rendering.**
  8. Print client config text + QR + the file path
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
  SQLite row (status='disabled'), public key, IP allocation, scope.
  `peer enable` is the inverse.
- `proxypilot vpn peer remove <name> [--force]`: hard-removes the
  SQLite row, sets `vpn_ip_pool.released_at` so the IP returns to the
  pool. Refuses without `--force` if the peer was active in the last
  24h (consult `wg show wg0 dump`'s last-handshake column). Audit row.
  Lockout-safety: refuse to remove the **only enabled peer** without
  `--force` — match the firewall manager's `lockoutCheck` pattern.
- `proxypilot vpn peer list`: live table joining SQLite `vpn_peers`
  with `wg show wg0 dump`. Columns: name, ip, last-handshake, online
  (handshake within last 180s), rx, tx, scope, status. `--json`
  honored. Tolerate `wg show` failing (VPN not yet enabled): return
  SQLite-only data with `online: false` everywhere.
- `proxypilot vpn peer show <name> [--qr] [--rotate-first]`: refuses
  by default — the private key was only displayed once at `add` time.
  `--rotate-first` generates a new keypair and prints that.
- **Migration.** The legacy `vpn_peers` schema in
  `phase-12-wireguard-vpn.md` was never built (Phase 12 was always
  superseded by this upgrade), so there are no rows to migrate.
  Migration is a no-op; state this explicitly in your commit message.

### Smoke check (operator confirms by hand on a real host)

- VPN already enabled via step 5's `proxypilot vpn enable`.
- `proxypilot vpn peer add admin-laptop` produces a config that imports
  cleanly into the WireGuard mobile client. Operator confirms the QR
  scans.
- After `peer add` the operator runs `wg show wg0` and sees the new
  peer with `latest handshake: never` (until the client connects).
- `peer rotate admin-laptop`: old config no longer connects; new one
  does.
- `peer list` shows live handshake data after a real connection.
- `peer remove` of the only-enabled peer of an operator who is on the
  VPN refuses without `--force`.

## Hard constraints (re-read every commit)

1. **No `iptables` shell-outs anywhere.**
2. **No direct `nft` calls outside the firewall manager.** Step 6 does
   not need to touch the firewall at all — peer scope (step 7) is the
   only firewall-affecting peer concern.
3. **No private keys in SQLite or audit logs.** Only public keys, IP
   allocations, peer names, fingerprints. Audit `peer add` with name +
   IP + actor; never the private key, never even a hash of it. Audit
   `peer rotate` similarly: just name + new public key + actor.
4. **Atomic file writes.** `wg0.conf` and per-peer config files
   through `.tmp + rename(2)`, mode 0600. Reuse the `atomicWrite()`
   helper in `core/vpn/server.js` (it already does `flag: 'wx'` +
   chmodSync after write).
5. **Lockout safety.** `peer remove` of the only enabled peer prompts.
   `peer disable` of the operator's own peer prompts. `--force` is the
   only escape and requires a typed confirmation, not just a flag.
6. **Determinism.** Identical `vpn_peers` rows + `vpn_config` →
   byte-identical `wg0.conf` across runs. Sort peers by `id` before
   emitting (the SQL queries already do this; preserve it).
7. **Hot-apply, don't bounce.** `wg syncconf wg0 <(wg-quick strip
   wg0)` reloads peer set without dropping the interface. Reserve
   `systemctl restart wg-quick@wg0` for `vpn enable` (already done).

## Composition with what's already shipped

You build *on top* of the existing surface; you do not modify it.

- **`vpn_config`, `vpn_peers`, `vpn_ip_pool`** are already in
  `cli/src/db/schema.js` (commit `3f04ab1`). Don't re-add. Read
  `phase-12a-vpn-server.md` for the column list. Note `vpn_ip_pool` is
  empty until populated; you'll insert IPs as they're allocated, or
  pre-seed `10.100.0.10`–`10.100.0.254` once on first peer add.
- **Server module** at `cli/src/core/vpn/server.js` exports
  `readVpnConfig`, `validateEndpoint`, `renderWg0Conf`, `writeWg0Conf`
  (which already handles atomic-write + mode 0600), `WG_CONFIG_FILE`,
  `WG_INTERFACE`, `WG_DEFAULT_CIDR`, `WG_DEFAULT_DNS`. Reuse via
  `cli/src/core/vpn/index.js`. The peer-add flow is "insert into
  SQLite → re-render via existing renderWg0Conf → atomic-write via
  existing writeWg0Conf → wg syncconf".
- **Audit** uses `cli/src/db/audit.js`'s `audit({...})` with
  `subsystem: 'vpn'`. Every `peer add`, `peer rotate`, `peer disable`,
  `peer enable`, `peer remove` produces one row.
- **CLI wiring.** Add new files under `cli/src/commands/vpn/`:
  `peer-add.js`, `peer-rotate.js`, `peer-enable.js`,
  `peer-disable.js`, `peer-remove.js`, `peer-list.js`, `peer-show.js`.
  Re-export from `cli/src/commands/vpn/index.js`. Wire into
  `cli/bin/proxypilot.js` as a `vpn peer` subcommand group beneath the
  existing `vpn` command (which has `enable` / `disable` from step 5).
- **Core peer module.** Put non-CLI logic in
  `cli/src/core/vpn/peer.js` and add a `qr.js` for the qrencode
  wrapper plus a `status.js` for `wg show wg0 dump` parsing. Re-export
  from `cli/src/core/vpn/index.js`.

## File layout

```
cli/src/core/vpn/
  peer.js          # NEW. add/rotate/enable/disable/remove
  qr.js            # NEW. qrencode wrapper (PNG + ANSI)
  status.js        # NEW. `wg show wg0 dump` parsing
  server.js        # (already shipped — extend with a syncconf helper if needed)
  index.js         # add new exports

cli/src/commands/vpn/
  peer-add.js peer-rotate.js peer-enable.js peer-disable.js
  peer-remove.js peer-list.js peer-show.js
  index.js         # add new exports

cli/bin/proxypilot.js  # add `vpn peer ...` subcommand group
```

## Hard segmentation rules (non-negotiable; the harness hangs on big tool calls)

1. **Reads ≤ 200 lines.** Use `Grep` to locate, then `Read` a tight
   window with `offset` + `limit`.
2. **Edits are targeted.** `Edit` with just-enough context.
3. **Long-running commands run in the background.** `npm install` and
   anything > a few seconds, via `run_in_background: true`.
4. **TodoWrite checkpoints between segments.** Update after every
   meaningful step.
5. **One checklist item = one commit. Push after every commit.**
   Suggested split:
   1. `core/vpn/qr.js` + `core/vpn/status.js` (read-side helpers).
   2. `core/vpn/peer.js` core lifecycle (add / rotate / enable /
      disable / remove). One commit; the spec for these is cohesive.
   3. CLI command files + `bin/proxypilot.js` wiring for mutations
      (peer-add / rotate / enable / disable / remove).
   4. CLI command files for `peer list` + `peer show` (read-only).
   5. `install-vpn.sh`: confirm or add `qrencode` to the apt-get line.

## Audit pass requirement

After the five commits above land, do an audit pass like step 5 had:
re-read each commit against the hard constraints, look for spawnSync
ENOENT crashes (status null + stderr undefined), missing input
validation, race windows, atomicWrite stale-tmp inheritance, and noisy
audit rows on no-op paths. Fix what's worth fixing in a separate
commit so the history makes the fix obvious. Skip "nice to have"
sweeping refactors.

## What NOT to do this session

- Do not implement step 7 (per-peer scope + Caddy matcher updates).
  That's a separate session with its own prompt.
- Do not implement SSH CA work, `harden-vpn-only`, `access bootstrap`,
  or the admin dashboard UI.
- Do not modify the firewall manager's contracts or the VPN server
  module's contracts (`enable`, `disable`, `validateEndpoint`,
  `renderWg0Conf`, `writeWg0Conf`, `atomicWrite`). If you need a new
  capability, add it as an additive extension.
- Do not introduce a new audit_log table — use the existing one.
- Do not introduce a new SQLite migration mechanism. Append to
  `cli/src/db/schema.js` with `IF NOT EXISTS` like the existing
  tables.
- Do not commit `node_modules/`. The `.gitignore` already excludes it.
- Do not push to `main` or to the firewall branch.

## Begin

After reading the spec end-to-end and `phase-12a-vpn-server.md`, post
a one-paragraph plan for **step 6** specifically (peer add / rotate /
enable / disable / remove / list / show, hot-applied via `wg syncconf`,
QR rendering through `qrencode`, IP-pool allocation strategy) before
writing code. Wait for go.
