<!-- Companion to phase-08-dns-over-tls.md -->
<!-- Source spec: proxypilot-firewall-vpn-ssh-prompt.md `## Firewall Manager` -->
<!-- Index: docs/core/plan/README.md -->

## Phase 8b: Firewall Manager (shipped 2026-04-30)

**Status:** Implemented and merged on
`claude/firewall-manager-step1-Q3F7N`. This document is the
post-shipping reference, not a backlog item.

**Goal:** Default-deny host firewall managed entirely from declarative
state, with discovery, per-rule toggles, panic-close, container
egress, and drift safety nets.

### What shipped

- **Source of truth.** `/var/lib/proxypilot/firewall.json` is the
  declarative state. Atomic writes (`.tmp` + `rename`) with
  `firewall.json.bak` rotation on every successful reconcile. SQLite
  mirrors the state into `firewall_rules` and records every apply in
  `firewall_reconciles`. A new generic `audit_log` table captures
  every state mutation across firewall (and, in later steps, VPN +
  SSH CA).
- **Renderer.** Pure function `state -> nft ruleset`. The rendered
  table declares its own `input_hook` chain at `filter - 10` priority
  with `policy drop`, with pre-jumps for loopback / ct established /
  ICMP, then `jump base_input` and `jump discovered_input`. Default-
  deny is enforced by ProxyPilot's own table — **zero mutations to any
  other nftables table**, strictly stronger than the spec's "single
  jump rule into the host's main input chain".
- **Reconciler.** Lockout-safety check (refuses to apply unless at
  least one enabled TCP rule covers port 22 from a plausibly
  reachable source). Atomic apply via `nft -f /tmp/...` (the streaming
  `nft -f -` form is rejected by the host's nft build with "Not a
  regular file"). Post-apply verify, audit-log write, `.bak`
  rotation.
- **Discovery sources.** `ss -H -tulnp` on the host;
  `incus exec -- ss` inside every running LXC container;
  `docker ps --format '{{json .}}'` parsed for host-side mappings;
  Caddy admin API walked for `apps.layer4.servers[*].listen[]`. Each
  failing scanner returns `[]` so an absent upstream never breaks the
  whole scan. Stable rule ids
  (`{source}-{container_or_host}-{process}-{port[-portEnd]}-{proto}`)
  keep operator toggles sticky across container restarts. New entries
  always insert disabled — discovery never opens a port. 7-day GC,
  scoped to the source(s) actually scanned.
- **Toggle CLI.** `proxypilot firewall list / scan / enable <id> /
  disable <id> / set-scope <id> <scope> / add-manual /
  remove-manual / reconcile / status`. Public-internet enables
  prompt for confirmation unless `--yes`. Manual rules support port
  ranges via `--port-end` (LiveKit-style WebRTC).
- **Panic-close + open.** `proxypilot firewall panic-close [--yes]`
  drops every discovered/manual rule, force-disables most base entries
  (keeps `base-ssh` always; keeps `base-wireguard` only if it was
  already on), sets `state.panic_close = true`. While the flag is set
  `enable / set-scope / add-manual` refuse with a clear remediation
  message. `panic-open` clears the flag but does **not** auto-restore
  rules — the operator re-toggles each one deliberately.
- **Container egress.** Per-container allow rules expressed in
  `firewall.json.container_egress`, rendered into a
  `forward`-hooked `container_egress` chain. Allow rules reference
  named services (currently `pgbouncer` →
  `10.0.100.1:6432/tcp`) — operators never type raw addresses. The
  default-deny tail (`ip saddr 10.0.100.0/24 drop`) catches anything
  from the LXC bridge that wasn't explicitly allowed.
- **systemd units** (emitted by `scripts/install-firewall.sh`):
  - `proxypilot-firewall-reconcile.service` — oneshot,
    `Before=network-pre.target` so the host comes up firewalled.
  - `proxypilot-firewall-reconcile.timer` — every 5 min, drift
    safety net.
  - `proxypilot-firewall-discover.service` — oneshot, runs
    `proxypilot firewall scan`.
  - `proxypilot-firewall-discover.timer` — every 10 min.
- **Installer.** `install.sh` and `update.sh` both copy `cli/` into
  `$INSTALL_DIR`, run `npm install --omit=dev`, drop a
  `/usr/local/bin/proxypilot` wrapper, and call
  `scripts/install-firewall.sh` (which is idempotent — overwrites
  units, daemon-reload, restarts timers, runs reconcile). The
  installer refuses to run if `ufw` is active.

### File map

```
cli/src/core/firewall/
  state.js       # JSON state I/O, SQLite mirror, default base allowlist
  render.js      # state -> nft ruleset (pure)
  reconcile.js   # lockout check, nft apply via tmp file, audit + reconcile log
  discover.js    # host / lxc / docker / caddy-l4 scanners + reconcileDiscovery
  toggle.js      # enable / disable / set-scope / add-manual / remove-manual
  panic.js       # panic-close / panic-open
  egress.js      # container egress allow / deny / list
  index.js       # public re-exports

cli/src/commands/firewall/
  reconcile.js status.js list.js scan.js toggle.js panic.js egress.js index.js

cli/src/db/
  schema.js      # adds firewall_rules, firewall_reconciles, audit_log
  audit.js       # audit() helper used by every state-mutating subsystem

scripts/
  install-firewall.sh   # systemd unit emitter, idempotent

cli/bin/proxypilot.js   # commander wiring for the firewall command group
install.sh              # CLI install + scripts/install-firewall.sh hook
update.sh               # in-place CLI refresh + idempotent firewall reinstall
```

### Verification (operator-facing)

- [x] Fresh install: SSH 22/tcp, Caddy 80+443/tcp open by default;
      everything else denied.
- [x] `proxypilot firewall scan` surfaces every host listener as
      `needs-review` with `enabled=no`.
- [x] `proxypilot firewall enable <id> --scope vpn-only --yes`
      writes state, reconciles, and the live ruleset shows the
      `ip saddr 10.100.0.0/24` source match.
- [x] `proxypilot firewall reconcile` is idempotent: same input
      → identical checksum.
- [x] Lockout check refuses to apply when no enabled TCP rule covers
      port 22 from a plausibly reachable source (`localhost-only`
      doesn't count; `--source-cidrs` overrides scope).
- [x] `proxypilot firewall panic-close` reduces the live table to
      just `base-ssh`; subsequent `enable` calls refuse until
      `panic-open`.
- [x] `proxypilot firewall egress allow myapp pgbouncer` adds the
      named-service translation;
      `proxypilot firewall egress allow myapp redis` rejects with
      "unknown service 'redis'. Known: pgbouncer".
- [x] systemd timers emit `daemon-reload`-clean unit files
      (`systemd-analyze verify` passes).
- [x] `audit_log` rows for every reconcile, discover, enable,
      disable, set-scope, add-manual, remove-manual, panic-close,
      panic-open, egress-allow, egress-deny.

### Out of scope this phase

- VPN peer flow (Phase 12 superseded — see steps 5–7 of
  `proxypilot-firewall-vpn-ssh-prompt.md`).
- SSH user CA (Phase 11 superseded — see steps 8–12).
- Admin dashboard UI for firewall rules (step 14 of the upgrade).
- `harden-vpn-only` SSH transition (step 15).

### Commit trail on `claude/firewall-manager-step1-Q3F7N`

1. `feat(firewall): default-deny core` — schema, state, render,
   reconcile, base allowlist.
2. `feat(firewall): host listener discovery + per-rule toggle CLI`.
3. `feat(firewall): discover lxc + docker + caddy-l4 listeners; port
   ranges`.
4. `feat(firewall): panic-close, container egress, drift timer +
   installer`.
5. `chore(install): update.sh refreshes CLI + firewall units in place`.
