<!-- Companion to phase-12-wireguard-vpn.md (superseded). -->
<!-- Source spec: proxypilot-firewall-vpn-ssh-prompt.md `## VPN Manager` -->
<!-- Index: docs/core/plan/README.md -->

## Phase 12a: VPN Server (shipped 2026-04-30)

**Status:** Step 5 of the firewall + VPN + SSH CA upgrade. Implemented
and pushed on `claude/setup-vpn-session-docs-pzqlc`. Steps 6 (peer
lifecycle) and 7 (per-peer scope + Caddy matcher) are the next session.

**Goal:** Bring a WireGuard server up entirely through the firewall
manager — no `iptables`, no direct `nft` calls outside the firewall
manager — so the operator's existing toggle / reconcile / panic
surface keeps working unchanged.

### What shipped

- **SQLite schema.** `vpn_config` (singleton, CHECK id=1; row only
  exists once `vpn enable` runs), `vpn_peers` (public keys + IP
  allocations + scope; private keys never persisted), `vpn_ip_pool`
  (per-`/32` allocation tracking). All `IF NOT EXISTS`, additive,
  no migration mechanism — matches the existing schema convention.
- **Firewall composition (option 1 of two reasonable designs).** The
  firewall renderer learned one new optional field:
  `state.nat.vpn_masquerade_iface`. When set, `render.js` emits a
  single line into the existing `nat_postrouting` chain:
  `oifname "<iface>" ip saddr 10.100.0.0/24 masquerade`. The source
  CIDR is hard-coded so the field can only widen NAT for VPN clients;
  the iface is regex-validated (`^[A-Za-z0-9_.-]{1,15}$`) so a junk
  value can't reach nft. Field absent ⇒ chain body empty (byte-identical
  to pre-VPN behavior). The VPN module never spawns `nft`; it mutates
  state and calls the firewall manager's existing `reconcile()`.
- **Server module** (`cli/src/core/vpn/server.js`).
  - `detectDefaultIface()` parses `ip -j route show default` (with text
    fallback) and validates against the same iface regex.
  - `generateServerKeypair()` shells out to `wg genkey` + `wg pubkey`.
  - `validateEndpoint()` accepts host:port for DNS / IPv4 / bracketed
    IPv6, port 1-65535. Exported so step 6's `endpoint set` can reuse.
  - `renderWg0Conf()` is deterministic — peers are SQL-sorted by id,
    fixed banner, single trailing newline. **No PostUp/PostDown** —
    NAT lives in the firewall manager.
  - Atomic writes for `wg0.conf` and `server_private.key` (tmp +
    rename, mode 0600). `/etc/wireguard` created mode 0700 if missing.
  - `enable({ endpoint, listenPort?, dns?, actor })`: idempotent;
    reuses keypair if `vpn_config` + the on-disk key are both present;
    **refuses to silently rotate the server key** if vpn_config exists
    but the key file is missing. Order is config-write → wg-quick up
    → firewall toggle so a wg-quick failure leaves the operator in
    their prior firewall state. `systemctl enable` + `systemctl
    restart` (rather than `enable --now`) so a `--port` change
    actually bounces the live socket.
  - `disable({ actor })`: preserves SQLite peer rows, IP allocations,
    keypair, and the `vpn_config` row — only the live interface, the
    `base-wireguard` toggle, and `state.nat.vpn_masquerade_iface` go
    down. Tolerates "unit not loaded" so a re-disable is a noop.
- **CLI.** `proxypilot vpn enable --endpoint <host:port> [--port <p>]
  [--dns <ip>]` and `proxypilot vpn disable`. Both honour the global
  `--json` flag.
- **Installer.** `scripts/install-vpn.sh` ensures the WireGuard
  userspace is installed, probes `modprobe wireguard` (warn-only for
  containers / custom kernels), enforces 0700 on `/etc/wireguard` and
  `/var/lib/proxypilot/vpn-peers/`. Wired into `install.sh` and
  `update.sh` after `install-firewall.sh`. Does NOT enable
  `wg-quick@wg0` and does NOT open 51820/udp — the VPN is fully
  opt-in via `proxypilot vpn enable`.

### Production readiness

Server side is production-ready in isolation: input validated, atomic
writes, no silent server-key rotation, narrow firewall composition
surface (one regex-validated string), idempotent enable/disable, full
audit trail.

**Not end-to-end usable until step 6 ships.** `vpn enable` brings wg0
up listening on 51820/udp with no `[Peer]` blocks — there is no peer
flow yet, so no client can dial in. This is by design (the build
sequence is 5 → 6 → 7).

### Hard constraints satisfied

- No `iptables` shell-outs anywhere.
- No direct `nft` calls outside the firewall manager.
- No private keys in SQLite or audit logs (only `server_public_key`
  lands in `vpn_config`; private key lives only in
  `/etc/wireguard/server_private.key` mode 0600 and inside the same
  `wg0.conf` mode 0600 that wg-quick reads).
- Atomic file writes for `wg0.conf` and `server_private.key`.
- Determinism: identical `vpn_config` + `vpn_peers` rows ⇒
  byte-identical `wg0.conf`.
- Profile gating: Standard installs ship the module but do not start
  `wg-quick@wg0` and do not open 51820/udp. Operator opts in.

### Commits

| sha | what |
|---|---|
| `3f04ab1` | schema: `vpn_config` + `vpn_peers` + `vpn_ip_pool` |
| `aced937` | firewall render: `nat_postrouting` MASQUERADE from `state.nat.vpn_masquerade_iface` |
| `3393235` | core/vpn: `server.js` + `index.js` (keygen, render, enable/disable) |
| `273d61a` | CLI: `proxypilot vpn enable` + `vpn disable` |
| `f7c1509` | `scripts/install-vpn.sh` + installer wiring |
| `bfa70a5` | fix: input validation, refuse silent server-key rotation, restart wg0 |
| `cf9a93f` | fix: backticks in install-vpn.sh warning text |

### Files

```
cli/src/core/vpn/
  server.js        # detect iface, keygen, wg0.conf render, enable/disable
  index.js         # public re-exports
cli/src/commands/vpn/
  enable.js disable.js index.js
cli/src/db/schema.js          # +vpn_config, +vpn_peers, +vpn_ip_pool
cli/src/core/firewall/render.js  # +renderNatPostrouting()
cli/bin/proxypilot.js         # +vpn enable / vpn disable wiring
scripts/install-vpn.sh        # NEW. WireGuard prereqs.
install.sh                    # +calls install-vpn.sh after install-firewall.sh
update.sh                     # same
```
