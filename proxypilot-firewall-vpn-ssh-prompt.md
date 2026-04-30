# ProxyPilot Firewall, VPN & SSH Certificate Upgrade — Implementation Prompt

## Project Context

This prompt extends `proxypilot-core-infrastructure-prompt.md` and the
phased plan in `proxypilot-core-phased-plan.md`. Read those first; the
conventions, file layout, audit-log dual-write, Infisical secret paths,
SQLite state store, profile tiers (Standard / Hardened / Compliant), and
"safe transition" pattern defined there apply here unchanged.

This upgrade replaces three partially-specified subsystems with full
implementations that the operator can drive end-to-end from the CLI and
the admin dashboard:

1. **Firewall Manager** — default-deny nftables with a dedicated
   `proxypilot` chain, automatic discovery of listening services, and a
   per-rule toggle UI.
2. **VPN Manager** — full WireGuard lifecycle: ProxyPilot generates peer
   keypairs (no paste-the-pubkey workflow), renders mobile-scannable
   configs and QR codes, surfaces live status, and supports
   enable/disable + per-peer scope without deleting the peer record.
3. **SSH Certificate Authority** — replaces the `authorized_keys`-per-user
   model with a real SSH user CA: short-lived signed certs, principals as
   roles, KRL-based revocation, and signed host certs.

## Sections of the Existing Prompt That This Upgrade Supersedes

When this upgrade is implemented, the following sections of
`proxypilot-core-infrastructure-prompt.md` are **replaced** by the
corresponding section of this document. Code in the original sections
should be removed, not kept for backward compatibility.

| Original section | Replaced by |
|---|---|
| `## SSH Access Management` (key-based, per-user `authorized_keys`) | `## SSH Certificate Authority` in this prompt |
| `### Ongoing Access Management` (`proxypilot access add/remove --ssh-key`) | `## SSH Certificate Authority` — `proxypilot ssh issue/revoke/list` |
| `## WireGuard VPN` — `### Peer Management` (paste-the-public-key flow) | `## VPN Manager` in this prompt |
| Scattered `nftables` rule additions inside other sections (CrowdSec, WireGuard, Incus bridge) | `## Firewall Manager` — all rules go through the manager, never direct |
| `iptables` MASQUERADE in `wg0.conf` PostUp | nftables NAT rule emitted by the firewall manager |

The Phase 8 placeholder for `src/core/nftables.ts` in the phased plan is
expanded into the full `## Firewall Manager` specification below.

## Design Principles (specific to this upgrade)

1. **State-driven, not imperative.** Firewall rules, VPN peer list, and
   issued SSH certs are all reconciled from a JSON/SQLite source of
   truth. ProxyPilot regenerates the live config from state; it never
   edits live rules in place. This makes drift detectable and recovery
   trivial.
2. **Default deny, explicit allow.** Inbound traffic is denied unless
   either (a) on the base allowlist or (b) explicitly toggled on by the
   operator. New listeners that ProxyPilot discovers are surfaced as
   "needs review" — never auto-opened.
3. **Never lock the operator out.** Every mutation that could remove
   remote access (firewall reconcile, sshd reload, VPN config rewrite,
   peer revoke, CA rotation) follows the safe-transition pattern from
   the original prompt: stage the new state, verify the new path works,
   only then retire the old path. Every such command supports a
   `--dry-run` and the destructive form requires `--force` after a
   confirmation prompt.
4. **One chain, one manager.** ProxyPilot owns the `proxypilot` nftables
   chain and only that chain. Operator-added rules in other chains are
   left untouched. CrowdSec / fail2ban use sibling chains.
5. **Short-lived credentials over long-lived ones.** SSH certs default
   to 24h validity. VPN peer configs are renewable. Both are revocable
   without touching every host.
6. **Honest about what each layer protects.** The firewall protects the
   host's L3/L4 surface (any process binding any port). Caddy protects
   the L7 surface for HTTP(S) only. The VPN gates admin access. SSH
   certs gate shell access. None of these substitute for the others;
   the prompt below specifies how they compose.

## Firewall Manager

### Purpose

Provide a default-deny host firewall that is fully managed by ProxyPilot
and reconciled from declarative state. Every port that any
ProxyPilot-managed workload needs is opened by ProxyPilot; every port
the operator wants exposed on a discovered service is opened via an
explicit toggle. Anything not in state is denied.

This subsystem is required on all profiles (Standard, Hardened,
Compliant). It is the single backstop that catches misconfigured
listeners (e.g. a Postgres that accidentally binds `0.0.0.0`) before
they are reachable from the internet.

### Backend: nftables

ProxyPilot uses **nftables**, not ufw or iptables. The `iptables`
references in the existing WireGuard PostUp/PostDown are removed; NAT
and forwarding rules for the WireGuard interface are emitted by the
firewall manager into the `proxypilot` table.

ProxyPilot owns one table and the chains inside it:

```
table inet proxypilot {
  chains:
    base_input        # the always-on allowlist + connection state
    discovered_input  # rules added by toggles
    container_egress  # rules controlling LXC/Docker bridge → host
    nat_postrouting   # WireGuard MASQUERADE, etc.
}
```

All other tables (`filter`, `nat`, anything CrowdSec or the operator
added) are **never** modified by ProxyPilot. The host's main `input`
chain is configured once at install with a single `jump` rule into
`proxypilot.base_input` and `proxypilot.discovered_input`; that single
rule is the only mutation outside the `proxypilot` table.

### Source of Truth

`/var/lib/proxypilot/firewall.json` is the source of truth. Schema:

```jsonc
{
  "version": 1,
  "default_policy": "deny",
  "base": [
    { "port": 22,    "proto": "tcp", "scope": "public",    "reason": "ssh" },
    { "port": 80,    "proto": "tcp", "scope": "public",    "reason": "caddy-http" },
    { "port": 443,   "proto": "tcp", "scope": "public",    "reason": "caddy-https" },
    { "port": 443,   "proto": "udp", "scope": "public",    "reason": "caddy-http3", "enabled": false },
    { "port": 51820, "proto": "udp", "scope": "public",    "reason": "wireguard",   "profile": "hardened+" }
  ],
  "discovered": [
    {
      "id": "lxc-meet-livekit-rtp",
      "source": "lxc",
      "container": "meet",
      "process": "livekit-server",
      "port_start": 50000,
      "port_end": 60000,
      "proto": "udp",
      "first_seen": "2026-04-12T18:30:11Z",
      "enabled": false,
      "scope": "public",
      "source_cidrs": ["0.0.0.0/0"]
    }
  ],
  "container_egress": [
    {
      "container": "myapp",
      "allow": ["pgbouncer"],
      "reason": "--db flag set at create time"
    }
  ],
  "panic_close": false
}
```

`scope` values: `public` (any source), `lan-only` (RFC1918 only),
`vpn-only` (10.100.0.0/24 only — the WireGuard subnet),
`localhost-only` (127.0.0.0/8 only). `source_cidrs` overrides `scope`
when set, allowing per-rule custom source restriction.

A second file `/var/lib/proxypilot/firewall.json.bak` holds the
last-known-good state and is rotated on every successful reconcile.

### Discovery

A scanner runs:

- **On every CLI mutation** that creates/destroys containers, routes,
  or services.
- **On a systemd timer** (`proxypilot-firewall-discover.timer`, every
  10 minutes) to catch listeners that appeared without going through
  ProxyPilot.
- **On `proxypilot firewall scan`** for the operator to invoke manually.

The scanner produces the `discovered` array by union of:

1. `ss -H -tulnp` on the host, filtered to listeners not bound to
   `127.0.0.0/8` or `::1`.
2. `incus list --format json` + `ss -H -tulnp` inside each running
   container (via `incus exec`), with each result tagged
   `source: "lxc"` and the container name.
3. `docker ps --format json` + port mappings, tagged `source: "docker"`.
4. Caddy admin API (`localhost:2019/config/`) walked for any
   `caddy-l4` listeners; tagged `source: "caddy-l4"`.

Each discovered listener is matched to existing entries by stable id
`{source}-{container_or_host}-{process_or_service}-{port}-{proto}`.
New entries are inserted with `enabled: false` and surfaced in the
admin dashboard as "needs review". Removed listeners are kept in state
for 7 days (so toggles aren't lost on a brief container restart) and
then garbage-collected.

The scanner never opens a port. It only updates state.

### Reconciliation

`proxypilot firewall reconcile` is the single function that takes
`firewall.json` and produces the live nftables ruleset. It:

1. Reads `firewall.json`.
2. Builds the desired ruleset in memory.
3. Validates: at least one rule allows SSH from at least one source
   the operator could plausibly reach (refuses to apply otherwise
   unless `--force-lockout-ok` is given).
4. Applies atomically via `nft -f -` with a single transaction.
5. Verifies (`nft list table inet proxypilot`) and logs a checksum.
6. Rotates `firewall.json.bak`.
7. Writes an audit log entry.

If step 4 fails, the previous ruleset is unchanged because the
transaction is atomic. If step 3's lockout check fails, the operator
gets a diagnostic listing every SSH-reaching rule that was about to be
removed.

Reconcile is triggered:

- On every state mutation (toggle, panic-close, base change).
- After discovery if any new entry was inserted (so the operator sees
  the new "needs review" entry but it stays denied).
- On `proxypilot-firewall-reconcile.timer` every 5 minutes as a safety
  net for drift.
- On boot (`proxypilot-firewall-reconcile.service`,
  `Before=network-pre.target`).

### Base Allowlist

The base allowlist is profile-dependent and ProxyPilot-owned. Operators
can disable individual base entries (e.g. close port 22 on a host that
only takes SSH via WireGuard) but not edit them; to add a permanent
custom always-on rule, use a discovered/manual entry pinned with
`scope` and a `reason`.

| Port | Proto | Scope | Profile | Reason |
|---|---|---|---|---|
| 22 | tcp | public | all | SSH |
| 80 | tcp | public | all | Caddy HTTP / ACME HTTP-01 |
| 443 | tcp | public | all | Caddy HTTPS |
| 443 | udp | public | all (off by default) | Caddy HTTP/3 (toggle on if HTTP/3 enabled) |
| 51820 | udp | public | Hardened+ | WireGuard |

ICMP echo (ping) is allowed by default with a 5/sec rate limit. Loopback
is allowed unconditionally. Established/related connections are allowed
unconditionally (`ct state established,related accept`).

### Toggle Surface

```
proxypilot firewall list [--all|--enabled|--needs-review]
```

Tabular: id, source, container, process, port, proto, scope, enabled,
last-seen, reason. Default view is `--needs-review` first, then
`--enabled`.

```
proxypilot firewall enable <id> [--scope public|lan-only|vpn-only|localhost-only] [--source-cidr <cidr>...]
proxypilot firewall disable <id>
proxypilot firewall set-scope <id> <scope>
```

Each writes state, then reconciles. `enable` requires the operator to
acknowledge the scope ("Open `meet/livekit-rtp 50000-60000/udp` to the
public internet? [y/N]") unless `--yes` is passed.

```
proxypilot firewall add-manual --port 25 --proto tcp --scope public --reason "outbound smtp relay"
proxypilot firewall remove-manual <id>
```

For listeners ProxyPilot can't auto-discover (e.g. a service that
binds only when triggered).

```
proxypilot firewall scan
proxypilot firewall reconcile [--dry-run]
proxypilot firewall status
```

`status` shows: backend (nftables), policy (deny), enabled rule count,
last reconcile time + checksum, last discovery time, panic-close state.

`reconcile --dry-run` prints the diff between the current live ruleset
and what state says, without applying.

### Panic Close

```
proxypilot firewall panic-close
proxypilot firewall panic-open
```

Panic-close drops every discovered rule and reduces the base allowlist
to SSH (22/tcp from any source) + WireGuard (if Hardened+). It sets
`panic_close: true` in state so the next discovery cycle doesn't
silently re-enable anything; the operator must explicitly
`panic-open` to resume normal toggle behavior.

This is a "stop the bleeding" command for incident response, not a
hardening default.

### Container Egress

Per-container egress rules (the existing "only `--db`-flagged
containers can reach PgBouncer" requirement from Phase 8) are
expressed in `firewall.json.container_egress` and emitted into the
`container_egress` chain. The default is **deny** for the
`10.0.100.0/24` bridge to host services; allow rules are added when
`proxypilot lxc create --db <name>` runs.

Allowed targets are named services, not raw addresses:

- `pgbouncer` → `10.0.100.1:6432/tcp`
- `valkey` → `127.0.0.1:6379/tcp` (only allowed if a future
  `--cache` flag is added)
- `infisical-agent` → unix-socket only, no firewall rule needed

When a container is destroyed, its egress rules are removed.

### CrowdSec / fail2ban Coexistence

Both push bans into nftables. ProxyPilot reserves the `proxypilot`
table; CrowdSec uses its own table (`crowdsec`), and fail2ban uses
`filter`/`nat` chains. The host's `input` chain is configured to jump
into CrowdSec's chain *before* `proxypilot.base_input`, so a ban from
CrowdSec wins over a ProxyPilot allow.

The install script emits the host's main chain layout once and never
touches it again. ProxyPilot only owns its own table.

### SQLite Schema

```sql
CREATE TABLE firewall_rules (
  id TEXT PRIMARY KEY,                       -- stable id from discovery
  source TEXT NOT NULL CHECK (source IN ('base','manual','lxc','docker','caddy-l4','host')),
  container TEXT,
  process TEXT,
  port_start INTEGER NOT NULL,
  port_end INTEGER,                          -- null = single port
  proto TEXT NOT NULL CHECK (proto IN ('tcp','udp')),
  scope TEXT NOT NULL CHECK (scope IN ('public','lan-only','vpn-only','localhost-only')),
  source_cidrs_json TEXT,                    -- json array, overrides scope
  enabled INTEGER NOT NULL DEFAULT 0,
  reason TEXT,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  enabled_at TEXT,
  enabled_by TEXT,                           -- actor
  disabled_at TEXT,
  disabled_by TEXT
);

CREATE TABLE firewall_reconciles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ruleset_checksum TEXT NOT NULL,
  rule_count INTEGER NOT NULL,
  applied INTEGER NOT NULL,                  -- 0 if dry-run or rejected
  rejection_reason TEXT,                     -- e.g. "would lock out ssh"
  reconciled_at TEXT DEFAULT (datetime('now')),
  reconciled_by TEXT
);
```

State JSON and SQLite are kept in sync: the JSON is the source of
truth for reconcile, SQLite mirrors it for queryability and audit.

## VPN Manager

### Purpose

Replaces the existing WireGuard peer flow (which required the operator
to paste the peer's public key) with a full-lifecycle manager:
ProxyPilot generates the peer's keypair, renders a ready-to-import
config + QR code, surfaces live status, supports enable/disable
without deleting the peer record, and enforces per-peer scope at the
firewall layer.

Profile: Hardened and Compliant. (On Standard, the manager is present
but not enabled.)

### Server Setup (replaces the existing `### Setup During Init` block)

Unchanged steps from the original prompt:

1. Generate server keypair (`wg genkey`), store private key in
   Infisical at `core/WIREGUARD_SERVER_KEY`, write to
   `/etc/wireguard/server_private.key` mode 0600.
2. Render `/etc/wireguard/wg0.conf` from template — no
   `iptables` PostUp/PostDown lines. NAT and forwarding are emitted
   into `proxypilot.nat_postrouting` by the firewall manager.
3. Enable + start `wg-quick@wg0`.
4. Verify `wg show` reports interface up.

What's new:

5. Firewall manager opens 51820/udp via the base allowlist when the
   profile is Hardened+. No direct `nft` calls from the VPN module.
6. The default route interface is detected once and stored in
   SQLite (`vpn_config.default_iface`); it's referenced by the
   firewall manager when emitting the MASQUERADE rule.
7. The very first peer ("admin bootstrap") is created automatically
   during init unless `--no-bootstrap-peer` is passed. The config is
   printed to the operator's terminal once and never written to disk.

### Peer Lifecycle

ProxyPilot generates the keypair. Operators do not paste public keys.

```
proxypilot vpn peer add <name> [--scope full|admin|services <list>] [--allowed-host-services <list>]
```

What it does:

1. `wg genkey` → peer private key (kept in memory, never written to
   disk on the server).
2. `wg pubkey` → peer public key, stored in SQLite.
3. Allocate next free IP from `10.100.0.10`–`10.100.0.254`.
4. Insert `[Peer]` block into `wg0.conf`, hot-apply with
   `wg set wg0 peer <pub> allowed-ips <ip>/32`.
5. Render the **client** config (containing the peer's private key,
   the server's public key, the server endpoint, and DNS).
6. Render a QR code (PNG + ANSI for terminal display) of the client
   config.
7. Print: client config text, QR code, file path
   `/var/lib/proxypilot/vpn-peers/<name>.conf` (mode 0600, owned by
   the operator who ran the command).
8. Audit log entry. The peer's private key is **never** written to
   ProxyPilot state — only the client config file holds it, and that
   file is the operator's responsibility to deliver and then delete.

Re-running `peer add` for an existing name returns an error; use
`peer rotate`.

```
proxypilot vpn peer rotate <name>
```

Generates a new keypair for an existing peer, replaces the `[Peer]`
block, hot-applies, prints a new client config + QR code. The old key
is invalid the moment `wg set` runs. Used when a device is lost.

```
proxypilot vpn peer disable <name>
proxypilot vpn peer enable <name>
```

`disable` removes the peer's `[Peer]` block from `wg0.conf` and runs
`wg set wg0 peer <pub> remove`, but **keeps the SQLite record** with
its key, IP allocation, and scope intact. `enable` re-adds the block
and re-applies. Use for "this contractor is on PTO" without losing
their config.

```
proxypilot vpn peer remove <name> [--force]
```

Hard-removes the peer record. IP returns to the pool. Audit log entry.
Without `--force` the command refuses if the peer was active in the
last 24h.

```
proxypilot vpn peer list
```

Live table joining SQLite with `wg show wg0 dump`:

| name | ip | last-handshake | online | rx | tx | scope | status |

`online` is computed: handshake within last 180 seconds.

```
proxypilot vpn peer show <name> [--qr] [--config]
```

Reprints the QR code or config. **Refuses by default** because the
private key was only displayed once at `add` time; reprint is only
possible if the operator passes `--rotate-first` (which generates a
new keypair and prints that). This is intentional — there is no
"recover the original key" path because ProxyPilot never persisted it.

### Per-Peer Scope

Each peer has a `scope` that determines what they can reach **inside**
the VPN, enforced by the firewall manager via `vpn-only` rules with
per-source-CIDR matching on the peer's `/32`:

- `full` — can reach anything that has a `vpn-only` firewall rule.
- `admin` — same as `full` but the dashboard tags them for audit.
- `services <list>` — can only reach the named services
  (`infisical`, `grafana`, `pgbouncer-stats`, `meet-admin`, etc.).
  Other `vpn-only` rules deny this peer's `/32`.

Scope changes hot-apply via firewall reconcile.

### Live Status

```
proxypilot vpn status
```

Interface up/down, listening port, peer count, online peer count,
total rx/tx, last reconcile of firewall rules that depend on VPN
state.

```
proxypilot vpn watch
```

Streaming view of `wg show` updated every 2 seconds (useful for
debugging "is the handshake completing?").

### Admin Service Routing

Caddy routes flagged `--vpn-only` get a `remote_ip 10.100.0.0/24`
matcher (unchanged from the original prompt). The new piece: when a
peer's scope is restricted to specific services, Caddy gets a
narrower `remote_ip <peer-ip>/32` matcher on routes the peer is
**not** allowed to reach, returning 403. The matcher list is
regenerated by ProxyPilot on every scope change.

For non-HTTP services (PgBouncer stats, Postgres direct, container
SSH if exposed), the firewall manager enforces the scope at L4 — no
L7 matcher exists for those.

### Endpoint Discovery

`proxypilot vpn endpoint set <hostname-or-ip>:<port>` records the
public endpoint that peer configs are rendered with. Defaults to the
host's primary public IPv4 detected at install (via
`curl https://api.ipify.org`). The operator overrides this when the
host is behind a NAT/load-balancer or has a stable DNS name.

`endpoint set` does not touch existing peer configs — they keep the
old endpoint until re-rendered. Use `peer rotate` or
`peer regenerate-config <name>` (which keeps the keypair but re-emits
the config file with the new endpoint) to update.

### SQLite Schema (replaces the existing `vpn_peers` table)

```sql
CREATE TABLE vpn_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  server_public_key TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  listen_port INTEGER NOT NULL DEFAULT 51820,
  cidr TEXT NOT NULL DEFAULT '10.100.0.0/24',
  default_iface TEXT NOT NULL,
  dns TEXT NOT NULL DEFAULT '10.100.0.1',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE vpn_peers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  public_key TEXT NOT NULL UNIQUE,
  preshared_key_hash TEXT,                   -- only the hash, for audit
  allowed_ip TEXT NOT NULL UNIQUE,           -- single /32
  scope TEXT NOT NULL DEFAULT 'admin'
        CHECK (scope IN ('full','admin','services')),
  scope_services_json TEXT,                  -- json array when scope='services'
  status TEXT NOT NULL DEFAULT 'enabled'
        CHECK (status IN ('enabled','disabled','revoked')),
  created_at TEXT DEFAULT (datetime('now')),
  created_by TEXT,
  last_handshake_at TEXT,
  last_endpoint TEXT,
  rotated_at TEXT,
  disabled_at TEXT,
  revoked_at TEXT
);

CREATE TABLE vpn_ip_pool (
  ip TEXT PRIMARY KEY,
  peer_id INTEGER REFERENCES vpn_peers(id),
  released_at TEXT
);
```

## SSH Certificate Authority

> **Spec deviation (2026-04-30):** The SSH CA chain (build sequence
> steps 8 through 12, plus step 15's `harden-vpn-only` transition)
> is **shelved indefinitely**. For ProxyPilot's current scale
> (single-admin hosts, no fleet, no Infisical integration), the
> CA's wins — short-lived credentials, federated trust, centralized
> revocation across many hosts — don't justify its complexity.
>
> The replacement spec lives in
> `## SSH Access Management (per-device authorized_keys)` below.
> ProxyPilot manages a SQLite ledger of per-device public keys,
> writes / removes them from `~/.ssh/authorized_keys` atomically,
> ships a copy-pasteable bootstrap script for adding a new device,
> and exposes a "revoke" surface through the CLI and the admin
> dashboard.
>
> The SSH CA spec below is preserved for historical reference and
> can be revisited when the operational surface changes (multiple
> admins, fleet of hosts, or Infisical lands as a first-class
> dependency). Do **not** implement steps 8 through 12 or step 15
> until that spec deviation is reversed.

### Purpose

Replaces the per-user `authorized_keys` model with an SSH user CA.
sshd trusts a single CA public key; ProxyPilot issues short-lived
certs signed by that CA. Revocation is centralized via a Key
Revocation List (KRL). Principals act as roles: a cert with
principal `ops` can log in as any account that lists `ops` in its
`AuthorizedPrincipalsFile`.

This applies to all profiles. Standard gets the CA with default
24-hour cert validity. Hardened+ adds host certs, KRL enforcement,
and per-principal source-IP restriction in cert options.

### CA Setup During Init

```
1. Generate user CA keypair
   - ssh-keygen -t ed25519 -f /etc/ssh/proxypilot_user_ca -N ""
   - Mode 0600 on private key, 0644 on public key
   - Store private key in Infisical at core/SSH_USER_CA_PRIVATE_KEY
   - Public key stays on disk for sshd

2. Generate host CA keypair
   - ssh-keygen -t ed25519 -f /etc/ssh/proxypilot_host_ca -N ""
   - Same Infisical storage at core/SSH_HOST_CA_PRIVATE_KEY

3. Sign the host's own SSH host keys
   - For each /etc/ssh/ssh_host_*_key.pub:
     ssh-keygen -s /etc/ssh/proxypilot_host_ca -h \
       -I "host:$(hostname -f)" -n "$(hostname -f),$(hostname -s)" \
       -V +52w <key.pub>
   - Produces /etc/ssh/ssh_host_*_key-cert.pub

4. Initialize empty KRL
   - ssh-keygen -k -f /etc/ssh/proxypilot_revoked_keys
   - Mode 0644

5. Render sshd config additions (drop-in /etc/ssh/sshd_config.d/proxypilot-ca.conf)
   - TrustedUserCAKeys /etc/ssh/proxypilot_user_ca.pub
   - HostCertificate /etc/ssh/ssh_host_ed25519_key-cert.pub
   - HostCertificate /etc/ssh/ssh_host_rsa_key-cert.pub
   - RevokedKeys /etc/ssh/proxypilot_revoked_keys
   - AuthorizedPrincipalsFile /etc/ssh/auth_principals/%u

6. Validate sshd config (sshd -t) before reloading

7. Safe-transition reload
   - Old authorized_keys files are LEFT IN PLACE during transition.
   - Operator confirms they can log in via cert before authorized_keys
     entries are migrated/removed.

8. Bootstrap admin cert
   - For each admin specified at init time, issue a 7-day cert and
     print it to the operator (same one-shot delivery as VPN configs).
   - Admins can re-issue themselves indefinitely after that.
```

The CA private keys live in Infisical and are pulled to a tmpfs path
only at signing time. They are never written to persistent disk after
init.

### Issuing Certs

```
proxypilot ssh issue <username> [--principals <list>] [--valid-for <duration>]
                                [--source-address <cidr>...] [--public-key <path-or-stdin>]
                                [--force-command <cmd>]
```

What it does:

1. Reads the user's SSH **public** key (from `--public-key`, stdin,
   or, if neither, generates a fresh ed25519 keypair and prints the
   private key to the terminal once).
2. Pulls the user CA private key from Infisical into a tmpfs scratch
   dir (`/run/proxypilot/ca/`, mode 0700).
3. Signs:
   ```
   ssh-keygen -s /run/proxypilot/ca/user_ca \
     -I "<username>@<hostname>-<unix-ts>" \
     -n "<principals>" \
     -V +<valid-for> \
     [-O source-address=<cidr>,...] \
     [-O force-command=<cmd>] \
     [-O no-port-forwarding] \
     [-O no-x11-forwarding] \
     [-O no-agent-forwarding] \
     [-O no-pty] (only with --force-command, for non-interactive)
     <pubkey>
   ```
4. Wipes the tmpfs scratch dir.
5. Writes a record to `ssh_certs` (serial = the unix-ts in the cert
   ID, key-id, principals, valid-from, valid-to, issuer, requester).
6. Prints the cert to the operator with delivery instructions ("save
   alongside your private key as `<keyname>-cert.pub`").

Defaults:

- `--valid-for`: `24h` (Standard), `8h` (Hardened), `4h` (Compliant).
- `--principals`: defaults to the username only.
- `--source-address`: empty (no IP restriction). Hardened+ may default
  to the WireGuard CIDR for non-`full`-scope users.
- Standard cert options: `no-port-forwarding`, `no-x11-forwarding`,
  `no-agent-forwarding` are **not** set by default — the operator can
  add them per-issue or set host defaults.

### Revocation

```
proxypilot ssh revoke --serial <id>
proxypilot ssh revoke --key-id <key-id>
proxypilot ssh revoke --principal <name> [--reason <text>]
proxypilot ssh revoke --user-pubkey <path>
```

Revocation appends to the KRL and atomically replaces
`/etc/ssh/proxypilot_revoked_keys`. Reload of sshd is **not**
required — sshd reads the KRL on each connection. Revocation is
effective on the next attempted login.

`--principal` revokes every cert that contains the named principal
(useful for "lock out the `ops` role across the board").

### Principals as Roles

`/etc/ssh/auth_principals/<username>` is a file owned by ProxyPilot
that lists which principals may authenticate as `<username>`. Example:

```
# /etc/ssh/auth_principals/root
ops
emergency
```

```
# /etc/ssh/auth_principals/deploy
ops
ci
```

ProxyPilot's `proxypilot ssh role` commands manage these:

```
proxypilot ssh role grant <principal> <unix-user>
proxypilot ssh role revoke <principal> <unix-user>
proxypilot ssh role list [--user <unix-user>]
```

When a role grant changes, the auth_principals file is rewritten
atomically. No sshd reload needed (re-read per connection).

### Host Certs

The host CA signs the host's own keys at install (step 3 above) and
re-signs them on a quarterly timer (`proxypilot-ssh-host-renew.timer`,
weekly schedule, renews when validity drops below 8 weeks).

Operators distribute the host CA public key once via:

```
proxypilot ssh export-ca [--user|--host]
```

Output is a line suitable for `~/.ssh/known_hosts`:

```
@cert-authority *.example.com,example.com ssh-ed25519 AAAA...
```

Once a client adds that line, every host that ProxyPilot has signed
validates without TOFU prompts. New hosts joining the fleet only need
to be signed by the same host CA (federation is out of scope here but
the format anticipates it).

### Migrating Off authorized_keys

`proxypilot ssh migrate-from-authorized-keys` runs the safe-transition
sequence:

1. For each system user with an `~/.ssh/authorized_keys`:
   - Issue a 7-day cert keyed to that user's existing public key,
     with principal `<username>`.
   - Print the cert and a one-line install instruction.
2. Wait for operator confirmation per user ("Did <user> log in
   successfully via cert? [y/N]").
3. On confirmation: rename `~/.ssh/authorized_keys` to
   `authorized_keys.preca-<date>` (preserved for audit, sshd no longer
   reads it because `AuthorizedKeysFile` is unset by the drop-in
   config).
4. On any "no": stop. Old file remains active.

This is the only command that mutates user home directories; it's
opt-in.

### CA Rotation

```
proxypilot ssh rotate-ca [--user|--host] [--overlap <duration>]
```

1. Generate the new CA keypair.
2. sshd config is rewritten to trust **both** old and new CA pubkeys
   for the overlap period (default 7 days).
3. New cert issuance uses the new CA immediately.
4. After overlap, the old CA pubkey is removed from sshd config and
   its private key is deleted from Infisical.
5. Existing certs signed by the old CA continue to work until the
   overlap ends or they expire, whichever is sooner.

KRL is preserved across rotation (the KRL is keyed by serial/key-id,
not by CA).

### SQLite Schema

```sql
CREATE TABLE ssh_ca (
  kind TEXT PRIMARY KEY CHECK (kind IN ('user','host')),
  public_key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  created_at TEXT NOT NULL,
  rotated_from_fingerprint TEXT,
  rotated_at TEXT
);

CREATE TABLE ssh_certs (
  serial TEXT PRIMARY KEY,                   -- the timestamp portion of the cert id
  key_id TEXT NOT NULL,
  ca_kind TEXT NOT NULL CHECK (ca_kind IN ('user','host')),
  username TEXT,                             -- null for host certs
  principals_json TEXT NOT NULL,
  source_address_json TEXT,
  force_command TEXT,
  valid_from TEXT NOT NULL,
  valid_to TEXT NOT NULL,
  issued_by TEXT NOT NULL,                   -- actor
  issued_at TEXT NOT NULL,
  revoked_at TEXT,
  revoked_by TEXT,
  revoked_reason TEXT
);

CREATE TABLE ssh_principals (
  principal TEXT NOT NULL,
  unix_user TEXT NOT NULL,
  granted_at TEXT NOT NULL,
  granted_by TEXT NOT NULL,
  PRIMARY KEY (principal, unix_user)
);
```

## SSH Access Management (per-device authorized_keys)

> Replaces the SSH Certificate Authority section above (which is
> shelved per the deviation note). This is the per-device access
> manager ProxyPilot ships *today*, designed for single-admin /
> few-device scale.

### Purpose

Wrap `~/.ssh/authorized_keys` with a SQLite ledger so the operator
can:

* Add a new device's public key in one CLI call (or one paste from
  the dashboard) and have it land in the right user's
  `authorized_keys` atomically.
* Revoke a device's key in one call — the line is removed from
  `authorized_keys`, the SQLite row is marked revoked, and audit
  carries the actor + reason.
* See every device that currently has SSH access, when each was
  added, when each was last seen handshaking (best-effort, parsed
  from `last` / `lastlog`), and who added it.
* Generate a copy-pasteable bootstrap script the operator runs on
  the new device — the script mints an ed25519 keypair locally,
  prints the public key, and prints the exact `proxypilot ssh
  access add` command to run on the server. The private key never
  leaves the device.

This ships on all profiles. The dashboard exposes an explicit
**operator-driven** toggle for `PasswordAuthentication` via
`proxypilot ssh password-auth status|enable|disable` (and the SSH
Access panel's Switch). The toggle is **never** flipped
automatically — the disable path refuses unless at least one active
ssh-access row exists, and even then requires a typed-phrase
confirmation through the dashboard's gate (same posture as the
revoke flow). Workflow when disabling:
  1. CLI lockout check refuses with `code: NO_ACTIVE_KEYS` when no
     managed key exists. Backend re-raises as 409 +
     `requires_force: true`.
  2. Candidate config is written to a sibling tempfile, validated
     with `sshd -t -f <tmp>`, and only renamed over `sshd_config`
     if validation passes.
  3. Live config is backed up to
     `/var/lib/proxypilot/sshd_config.bak` before swap.
  4. `systemctl reload ssh` (with fallback to `sshd` / `kill -HUP`)
     applies the new config without dropping live sessions. Reload
     failure auto-rolls-back from the backup.
  5. Audit log records the before/after, the actor, and whether
     the disable was forced past the lockout gate.

Match-block overrides in `sshd_config` are surfaced (in `status`)
but never modified — the toggle only touches the global
unconditional directive.

### Source of Truth

`/var/lib/proxypilot/ssh-access.json` mirrors the SQLite table for
the same dual-write reasons firewall.json does: JSON is
human-readable / git-restorable, SQLite is queryable. Schema:

```jsonc
{
  "version": 1,
  "entries": [
    {
      "id": "alice-laptop",
      "unix_user": "root",
      "public_key": "ssh-ed25519 AAAAC3Nza... alice@laptop",
      "fingerprint": "SHA256:abcd...",
      "device_label": "Alice's MacBook Pro",
      "added_at": "2026-04-30T14:21:00Z",
      "added_by": "alice",
      "revoked_at": null,
      "revoked_by": null,
      "revoked_reason": null,
      "last_seen_at": "2026-04-30T15:02:11Z"
    }
  ]
}
```

`id` is operator-supplied, must be unique, and is what the
revoke / list commands key on. `device_label` is a free-text
description shown in the dashboard.

### SQLite Schema

```sql
CREATE TABLE ssh_access (
  id TEXT PRIMARY KEY,
  unix_user TEXT NOT NULL,
  public_key TEXT NOT NULL,                  -- the full pubkey line
  fingerprint TEXT NOT NULL UNIQUE,          -- ssh-keygen -lf output
  device_label TEXT,
  added_at TEXT NOT NULL,
  added_by TEXT,
  revoked_at TEXT,
  revoked_by TEXT,
  revoked_reason TEXT,
  last_seen_at TEXT
);
```

Active rows have `revoked_at IS NULL`. Revoked rows are kept for
audit (so historical "who had access in March" queries still
work); they're not re-pushed to `authorized_keys` on reconcile.

### Reconciliation

`proxypilot ssh access reconcile` is the single function that
rewrites `~/<unix_user>/.ssh/authorized_keys` for every distinct
unix_user that has at least one active row in `ssh_access`. It:

1. Reads `ssh_access.json`.
2. For each active row, groups by `unix_user`.
3. For each unix_user, reads the existing `authorized_keys`,
   preserves any line that does **not** match a ProxyPilot
   fingerprint (so operator-added keys outside ProxyPilot stay
   put), then appends one line per active row in `id`-sorted
   order. Each ProxyPilot-managed line carries a stable trailing
   comment `# proxypilot:<id>` so the next reconcile can
   identify and replace it.
4. Atomic-writes the new file (`.tmp` + chmod 0600 + rename) and
   chowns to the unix user's uid:gid.
5. Writes an audit row per affected user with
   `before_count` / `after_count`.

Reconcile is triggered on every `add` / `remove` / `revoke`
mutation. A timer-driven safety reconcile runs every 10 minutes
to catch drift if the operator manually edited `authorized_keys`.

### CLI Surface

```
proxypilot ssh access add <id> --user <unix-user>
                               --pubkey <path-or-stdin-or-->
                               [--label <text>]
proxypilot ssh access revoke <id> [--reason <text>]
proxypilot ssh access remove <id>            # hard delete (audit kept)
proxypilot ssh access list [--all|--active|--revoked]
proxypilot ssh access show <id>
proxypilot ssh access reconcile [--dry-run]
proxypilot ssh access bootstrap-script <id> [--user <unix-user>]
                                            [--server <host>]
```

`add`:

* Validates the public key by piping through `ssh-keygen -l -f -`;
  rejects on parse failure or a fingerprint that already exists
  in `ssh_access` (active or revoked).
* Inserts the SQLite row, mirrors to JSON, reconciles. Audit
  action `ssh.access.add`.

`revoke`:

* Marks the row revoked with timestamp + actor + optional reason.
  Reconcile drops the line from `authorized_keys`. Audit action
  `ssh.access.revoke`.
* The unix user keeps existing SSH sessions — `authorized_keys`
  is consulted at connection time only. Operator can `kill` the
  session manually if they need an immediate eviction.

`remove`:

* Hard-deletes the SQLite row. Audit row references the deleted
  fingerprint so the trail is recoverable. Reconcile re-renders.
  Used when an entry was added by accident; revoke is the normal
  path for a working entry.

`bootstrap-script`:

* Emits a self-contained shell snippet the operator copies to the
  new device. The snippet:

  ```sh
  #!/usr/bin/env bash
  set -euo pipefail

  KEY_PATH="$HOME/.ssh/proxypilot_<id>_ed25519"
  mkdir -p "$HOME/.ssh" && chmod 700 "$HOME/.ssh"
  if [ -f "$KEY_PATH" ]; then
    echo "Key already exists at $KEY_PATH — refusing to overwrite." >&2
    exit 1
  fi
  ssh-keygen -t ed25519 -f "$KEY_PATH" -N "" \
    -C "proxypilot:<id>@$(hostname -s)"

  PUBKEY="$(cat "${KEY_PATH}.pub")"
  cat <<EOF

  ==== Public key generated. Run this command on the ProxyPilot host: ====

  proxypilot ssh access add <id> --user <unix-user> \\
    --label "$(hostname -s) ($(uname -s))" \\
    --pubkey - <<KEY
  ${PUBKEY}
  KEY

  ==== Then connect with: ====

  ssh -i ${KEY_PATH} <unix-user>@<server>

  EOF
  ```

* `--server` is optional; when set, the printed `ssh -i ...` line
  uses the operator's hostname instead of `<server>`. Same for
  `--user`.
* The script never sends anything to the server. The operator
  reads the printed pubkey and runs the printed command on the
  server themselves — same trust model as `ssh-copy-id`, no
  privileged channel required.

### Dashboard

A new "SSH Access" panel under the existing admin dashboard:

* Table of active devices (id, user, label, added_at, last_seen).
* "Add device" button → modal showing the bootstrap script with
  a copy-to-clipboard button. The operator pastes the resulting
  `proxypilot ssh access add` command into a server shell.
* Per-row "Revoke" button with confirmation prompt; reason is
  optional.
* Filter / sort by user, label, added_at, last_seen.
* Revoked devices view (separate tab) for audit.

### Composition with the Firewall + VPN

* The operator's typical "lock SSH down to VPN-only" flow is two
  commands: `proxypilot vpn peer add my-laptop --scope admin`
  followed by `proxypilot firewall set-scope base-ssh vpn-only`.
  After both, port 22 is only reachable from inside the VPN
  subnet. This composes the existing firewall manager + VPN
  manager — no new code beyond what's shipped by step 7.
* `ssh access` is layered on top: even with the firewall closed
  to public, sshd still wants a key to authenticate. The access
  manager makes the per-device key registration the operator
  workflow.

### What this DOES NOT do

* No CA, no signed certs, no KRL. Revocation is per-pubkey via
  `authorized_keys` line removal.
* No `force-command`, no `source-address` cert options. If the
  operator wants to restrict a key to a CIDR, they edit the
  `authorized_keys` line by hand in the operator-managed section
  (above the `# proxypilot-managed:` marker the reconcile
  preserves).
* No *automatic* `PasswordAuthentication no` flip. There is an
  explicit operator-driven toggle (`proxypilot ssh password-auth`
  + dashboard Switch) that goes through atomic write +
  `sshd -t` validation + reload-with-rollback + lockout gate
  (refuses to disable when zero active managed keys exist; typed
  phrase to override). Auto-flipping at install time remains
  forbidden — the operator chooses the moment after verifying
  their first device works.
* No principals / role mapping. Each row binds one pubkey to one
  unix user. If the operator wants `alice` to log in as both
  `root` and `deploy`, that's two `add` calls.

## Cross-Subsystem Integration

The three subsystems compose, and the composition is part of the spec:

- **Firewall + VPN.** WireGuard's UDP 51820 base allowlist entry is
  toggled on/off by `proxypilot vpn enable/disable`. Per-peer scope
  restrictions are enforced as `vpn-only` rules with per-`/32`
  source-CIDR pinning emitted by the firewall manager.
- **Firewall + SSH.** SSH's TCP 22 base allowlist entry is always on
  by default, but the operator can switch its scope to `vpn-only` once
  enough admins have working VPN peers — closing public SSH entirely.
  The `proxypilot ssh harden-vpn-only` command runs this transition
  with a safety check: it refuses unless at least two enabled VPN
  peers have completed a handshake in the last 24h.
- **VPN + SSH.** A VPN peer config can be bundled with a freshly
  issued SSH cert for the same operator: `proxypilot access bootstrap
  <name>` runs `vpn peer add` + `ssh issue` + `ssh role grant` in one
  transaction and prints both artifacts together. Used for onboarding.
- **All three + audit.** Every mutation in any of these subsystems
  writes to the same audit log + Postgres sync defined in the
  original prompt. Actor, before-state, after-state, and a stable
  resource id are required for every entry.

## CLI Surface (additions to `### Complete CLI Surface`)

```
### Firewall
proxypilot firewall list [--all|--enabled|--needs-review]
proxypilot firewall enable <id> [--scope <scope>] [--source-cidr <cidr>...] [--yes]
proxypilot firewall disable <id>
proxypilot firewall set-scope <id> <scope>
proxypilot firewall add-manual --port <p> --proto <tcp|udp> --scope <scope> --reason <text>
proxypilot firewall remove-manual <id>
proxypilot firewall scan
proxypilot firewall reconcile [--dry-run]
proxypilot firewall status
proxypilot firewall panic-close
proxypilot firewall panic-open

### VPN (replaces the prior add-peer/remove-peer/list/status set)
proxypilot vpn enable
proxypilot vpn disable
proxypilot vpn status
proxypilot vpn watch
proxypilot vpn endpoint set <hostname-or-ip>:<port>
proxypilot vpn peer add <name> [--scope full|admin|services] [--services <list>]
proxypilot vpn peer rotate <name>
proxypilot vpn peer enable <name>
proxypilot vpn peer disable <name>
proxypilot vpn peer remove <name> [--force]
proxypilot vpn peer list
proxypilot vpn peer show <name> [--qr] [--rotate-first]

### SSH CA (replaces `proxypilot access add/remove --ssh-key`)
proxypilot ssh issue <username> [--principals <list>] [--valid-for <duration>]
                                 [--source-address <cidr>...] [--public-key <path>]
                                 [--force-command <cmd>]
proxypilot ssh revoke --serial <id> | --key-id <id> | --principal <name> | --user-pubkey <path>
                      [--reason <text>]
proxypilot ssh list [--active|--expired|--revoked]
proxypilot ssh role grant <principal> <unix-user>
proxypilot ssh role revoke <principal> <unix-user>
proxypilot ssh role list [--user <unix-user>]
proxypilot ssh export-ca [--user|--host]
proxypilot ssh rotate-ca [--user|--host] [--overlap <duration>]
proxypilot ssh migrate-from-authorized-keys
proxypilot ssh harden-vpn-only

### Bundled bootstrap
proxypilot access bootstrap <name> [--ssh-principals <list>] [--vpn-scope <scope>]
```

The pre-existing `proxypilot access list/history/review` commands are
retained as-is — they query the same data, just with the cert-based
backend instead of authorized_keys.

## File Organization

New / changed files under `src/`:

```
src/core/
  firewall/
    state.ts          # read/write firewall.json + SQLite mirror
    discover.ts       # listener discovery (host, lxc, docker, caddy-l4)
    render.ts         # state → nft ruleset string
    reconcile.ts      # apply, verify, lockout-check
    panic.ts          # panic-close / panic-open
    index.ts          # public API
  vpn/
    server.ts         # init, wg0.conf rendering
    peer.ts           # add/rotate/enable/disable/remove
    qr.ts             # QR rendering (PNG + ANSI)
    status.ts         # wg show parsing, watch loop
    scope.ts          # peer scope → firewall rules + caddy matchers
    index.ts
  ssh/
    ca.ts             # generate, sign, rotate
    cert.ts           # issue, parse, list
    krl.ts            # revoke, KRL append/replace
    principals.ts     # auth_principals/<user> management
    sshd.ts           # drop-in config rendering, sshd -t, reload
    migrate.ts        # authorized_keys → cert migration
    index.ts

src/cli/
  firewall/*.ts       # one file per subcommand
  vpn/*.ts
  ssh/*.ts
  access.ts           # bootstrap subcommand updated

src/admin/components/
  firewall/RuleTable.tsx
  firewall/ToggleDialog.tsx
  firewall/PanicCloseBanner.tsx
  vpn/PeerTable.tsx
  vpn/PeerAddDialog.tsx        # shows QR after add
  vpn/StatusCard.tsx
  ssh/CertTable.tsx
  ssh/IssueDialog.tsx
  ssh/RoleMatrix.tsx
```

systemd units emitted by the installer:

```
proxypilot-firewall-reconcile.service        # oneshot, on boot
proxypilot-firewall-reconcile.timer          # every 5 min
proxypilot-firewall-discover.timer           # every 10 min
proxypilot-ssh-host-renew.timer              # weekly
```

Files on the host:

```
/etc/wireguard/wg0.conf
/etc/wireguard/server_private.key
/etc/ssh/proxypilot_user_ca.pub
/etc/ssh/proxypilot_host_ca.pub
/etc/ssh/proxypilot_revoked_keys
/etc/ssh/sshd_config.d/proxypilot-ca.conf
/etc/ssh/auth_principals/<unix-user>
/var/lib/proxypilot/firewall.json
/var/lib/proxypilot/firewall.json.bak
/var/lib/proxypilot/vpn-peers/<name>.conf    (created at peer add, operator removes)
/run/proxypilot/ca/                          (tmpfs, only present during signing)
```

Infisical secret paths:

```
core/SSH_USER_CA_PRIVATE_KEY
core/SSH_HOST_CA_PRIVATE_KEY
core/WIREGUARD_SERVER_KEY     (already exists, unchanged)
```

## Build Sequence

Implement and ship in this order — each step is independently
testable and leaves the system in a working state:

1. **Firewall core** — schema, state file, render, reconcile (no
   discovery yet). Base allowlist only. Verify every existing
   ProxyPilot install still works with default-deny + base rules.
2. **Firewall discovery** — host listeners only. Surface "needs
   review" entries, do not auto-enable anything. Toggle CLI works.
3. **Firewall discovery: lxc, docker, caddy-l4** — broaden discovery
   sources. Add port-range support (for LiveKit-style services).
4. **Firewall: panic-close, container egress, drift timer.**
5. **VPN server setup** rewritten to use the firewall manager (no
   `iptables` calls). Existing peer flow keeps working.
6. **VPN peer lifecycle** — keypair generation, QR rendering,
   enable/disable, rotate. Migrate any existing peer records into the
   new schema (preserving public keys and IP allocations).
7. **VPN scope** — per-peer firewall rules + Caddy matcher updates.
8. **SSH CA setup** — generate CAs, sign host keys, render sshd
   drop-in, do **not** disable authorized_keys yet. Both auth methods
   work simultaneously.
9. **SSH cert issuance + KRL.** Bootstrap admin certs at init.
10. **SSH principals/roles** + `auth_principals/` management.
11. **SSH migration** — `migrate-from-authorized-keys` with safe
    transition. Once an operator runs this, authorized_keys is
    retired on that host.
12. **SSH host CA renewal timer** + `export-ca` command.
13. **`access bootstrap`** unified onboarding command.
14. **Admin dashboard UI** for all three subsystems.
15. **`harden-vpn-only`** SSH transition with handshake-count safety
    check.

## Implementation Constraints

- **No `iptables` shell-outs anywhere.** All packet-filter mutations
  go through the firewall manager, which uses `nft`. The pre-existing
  `iptables` lines in WireGuard PostUp/PostDown are removed in step 5.
- **No `ufw`.** ProxyPilot is incompatible with ufw running
  concurrently; `proxypilot init` detects an active ufw and refuses
  with a clear remediation message.
- **No direct edits to `/etc/ssh/sshd_config`.** All sshd settings go
  through `/etc/ssh/sshd_config.d/proxypilot-ca.conf`. The main file
  is left untouched for operator overrides.
- **No private keys in SQLite or audit logs.** Only public keys,
  fingerprints, key-ids, and serial numbers. Audit log entries
  reference certs by serial; the cert body itself is delivered to the
  operator and never re-stored.
- **Atomic file writes everywhere.** `firewall.json`, KRL,
  `wg0.conf`, `sshd_config.d/proxypilot-ca.conf`,
  `auth_principals/*` are written to a sibling `.tmp` file and
  `rename(2)`d into place.
- **Lockout safety on every relevant command.** Firewall reconcile,
  `harden-vpn-only`, `migrate-from-authorized-keys`, peer revoke (if
  the peer is the only enabled one), and CA rotation all run the
  safe-transition pattern. `--force-lockout-ok` is the only escape
  hatch and it requires a typed confirmation, not just a flag.
- **Discovery never opens ports.** It only writes state with
  `enabled: false`. The toggle is the only path to open.
- **No background mutations.** Timers (`reconcile`, `discover`,
  `host-renew`) run reconcile/discovery/renewal logic, but never
  enable rules, never issue certs to anyone, never add peers. They
  refresh state and apply already-approved state.
- **Profile gating.** On Standard, the VPN module is installed but
  `wg-quick@wg0` is not enabled and 51820/udp is not in the base
  allowlist; the operator opts in with `proxypilot vpn enable`. The
  SSH CA is enabled on all profiles. The firewall manager is enabled
  on all profiles.
- **Determinism.** Given identical `firewall.json`, `vpn_peers`, and
  `ssh_principals` content, the rendered nftables ruleset, the
  `wg0.conf`, and the `auth_principals/*` files are byte-identical
  across runs. Reconcile is a pure function of state.

## Notes

- The Phase 8 `src/core/nftables.ts` placeholder in
  `proxypilot-core-phased-plan.md` is replaced by `src/core/firewall/`
  as laid out above. Update the phased plan to reference this prompt
  in Phase 8 and to move the SSH CA work from Phase 9 into a new
  Phase 9a (CA setup) and 9b (migration), which depend on the
  firewall manager being live.
- HTTP/3 (UDP 443) remains opt-in. Toggling Caddy's HTTP/3 directive
  on automatically enables the `caddy-http3` base entry; toggling it
  off disables and reconciles.
- LiveKit / Meet and similar WebRTC services are first-class
  examples for the port-range discovery path. Validate the discovery
  + toggle flow against a deployed LiveKit container before declaring
  step 3 done.
- Federation (multiple ProxyPilot hosts trusting each other's host
  CA, sharing VPN peers) is out of scope for this upgrade but the
  schemas and CA structure anticipate it. Do not add federation
  hooks; do not preclude them either.

