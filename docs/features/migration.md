# Migration — adopting a server, VM or container

Copy a running web application from another machine onto a
ProxyPilot-managed Incus guest, with ProxyPilot driving the process end to
end. The operator runs **one line** on the source; everything else happens
in the dashboard (or over MCP).

```
source host ──(1) curl …/install.sh | sudo sh ─────────────────────────┐
                                                                        ▼
  proxypilot-agent migrate ──(2) inventory manifest──► POST /api/migrations/agent/<token>/inventory
        │                  ──(3) progress events────►  POST …/event
        │                                              (the operator reviews and approves)
        └──(4) incus-migrate ───────────────────────►  Incus            (whole-machine)
            or  tar rootfs ────────────────────────►  PUT …/artifact   (Proxmox LXC)
            or  tar + pg_dump ─────────────────────►  PUT …/artifact   (application)
                                                     └─► incus exec → the new guest
```

## The two modes

| | whole-machine | application (adopt) |
|---|---|---|
| The source | is the thing being moved | keeps running |
| Transport | `incus-migrate` (physical, VM, LXC) or a rootfs tarball (Proxmox LXC) | tarballs through ProxyPilot + a logical database dump |
| The guest | arrives by being streamed into Incus | is created first, from a base image |
| Good for | lift-and-shift, including a stack you do not want to unpick | turning an old server into a ProxyPilot-shaped guest |

`transport` is derived and rarely set by hand: whole-machine uses
`incus-migrate`, except on a Proxmox or otherwise nested LXC, which takes
`rootfs-tar` — it tars the rootfs, streams it to ProxyPilot, and imports it as
a split image (`incus image import metadata.tar.xz rootfs.tar.zst`), with
ProxyPilot supplying the metadata the agent cannot know. Application mode uses
`file-sync`.

Everything the agent streams is compressed with the compressor ProxyPilot
names in the job (`exports.compression`, zstd by default — see
`docs/features/lxc/exports.md`), and the agent PROBES what the source can
actually do before it trusts that: a 2014 box with GNU tar 1.26 and no zstd
package is exactly the machine someone is trying to get off, so the request
is a preference and gzip is the floor. gzip is single-threaded at ~50 MB/s,
which on a LAN makes it, not the network, the reason a migration takes hours.
So the agent **installs zstd on the source** before the transfer when it is
missing (`install_tools` on the spec, default on — through `apt-get`, `dnf`,
`yum`, `apk`, `zypper` or `pacman`, whichever the source has; the outcome is
a log line, and a failed install is the gzip fallback, never a failed
migration). A source with `pigz` and no zstd gets gzip on every core. The
inventory reports the source's tools, so the review says `zstd-missing` and
what will happen about it before you approve; with `install_tools: false`
the same concern says what single-core gzip will cost. The first real
migration (249 GiB from a Debian 11 host) ran at 7 MiB/s on gzip — a
five-hour copy that zstd on the same 16 cores does in well under one.
The mysqldump is compressed too (it was going over the wire raw); the
PostgreSQL dump is not, because `--format=custom` already is. ProxyPilot
sniffs the first four bytes of what arrives rather than trusting the label,
and decompresses on the HOST before piping a plain tar into the guest — a
fresh minimal guest has tar but may not have the zstd binary tar shells out
to, and a migration is a bad moment to find that out.

Why `rootfs-tar` rather than `incus-migrate` for a container source: tar is on
every machine, `incus-migrate` is a package a Proxmox host does not have and
may not be able to install, and `incus-migrate` needs the source to reach the
Incus API *directly* while the tar goes through ProxyPilot, which the source is
already talking to. Forcing `transport: "incus-migrate"` for a container
source is allowed and works (it is how that path is tested), it just asks more
of the source.

### The agent survives the terminal

The bootstrap script starts the agent **detached**: a transient systemd
unit (`proxypilot-migrate-<id>-<epoch>`, follow it with `journalctl -u … -f`)
where the source has systemd, `setsid nohup … > /var/log/proxypilot-migrate-…log`
elsewhere. The script prints the unit or log name and returns; the SSH
session can be closed. The agent also ignores SIGHUP. Migration #12 died at
15 GiB when the session that had pasted the command dropped — the agent
ran in that session's foreground and SIGHUP took it. Set
`PROXYPILOT_MIGRATE_FOREGROUND=1` before the command to keep it in the
terminal for a debugging session.

The backend's HTTP server has **no clock on a request body**
(`lib/http-server-timeouts.js`, applied in `index.js`): Node 20 defaults
`requestTimeout` to 300 s, and migrations #12 and #14 — the same 249 GiB
rootfs, 15 GiB in at 85 MiB/s — were both cut off 5 min 17 s and 5 min 24 s
into the upload by that clock plus its 30 s check interval, with a failure
line that blamed the agent. The headers clock (60 s) stays.

Two things make a dead source visible instead of leaving the migration at
"running" for someone to notice. A broken upload — the socket closes before
the body ended — fails the migration with the byte count and the reason,
and removes the partial tarball (an upload is one stream with one hash at
the end, so it cannot be resumed; the remedy is a new migration). A source
that leaves nothing to observe (power loss, an agent killed between two
polls) is caught by the watchdog `sweepStalled`, run every minute from
`index.js`: a running transfer whose agent has not been heard from for 15
minutes is failed with the last-contact time. Progress lines arrive every
5 s while bytes move and the agent polls every 5–15 s while it waits, so
that silence is never a slow disk.

### When the source has no `incus-migrate`

A physical host or a VM defaults to `incus-migrate`, and the package is often
not there (the first real whole-machine migration, a Debian 11 host into a
container, died on exactly that: "neither incus-migrate nor lxd-migrate is
installed on this source … re-create the migration with transport:
rootfs-tar" — a new token, a new paste on the source, a new inventory and a
new approval, for the guest the rootfs-tar path would have built from a tar
the source already had). Two things now happen instead:

- **The inventory says so before you approve.** The agent reports the
  transfer tools it found (`manifest.tools`: `incus_migrate`, `lxd_migrate`,
  `tar`, `zstd`), and the review carries the concern `incus-migrate-missing`:
  a *warning* for a container target, naming the fallback below and how to
  avoid it (`apt install incus-extra` on the source before approving); a
  *block* for a virtual-machine target, because a tarball has no disk image
  in it — install the tool, then approve (the agent looks again when the
  transfer starts, so no new migration is needed; the override is for an
  operator who has just installed it). An agent older than the field reports
  nothing, and silence raises no concern.
- **An approved transfer falls back by itself.** When the transfer starts and
  the tool is still missing, the agent asks ProxyPilot to switch the
  migration to `rootfs-tar` (`POST /api/migrations/agent/:token/transport`,
  service `switchTransport`) and carries on with the job it gets back — the
  rootfs streams to ProxyPilot as a tarball and is imported as a container,
  exactly the Proxmox-LXC path. ProxyPilot decides: the migration must be
  whole-machine, approved, in the transfer phase, `incus-migrate` → `rootfs-tar`
  (nothing else has a fallback), the target a container, and the tarball must
  **fit on ProxyPilot's own disk** — a place the approval never checked,
  because `incus-migrate` stages nothing — so capacity is re-measured for the
  new transport and a "will not fit" is a refusal with the numbers in it. On a
  switch the row's transport and the stored capacity verdict change, the
  Incus trust token minted for a client that will never connect is revoked,
  and the log says `transport switched from incus-migrate to rootfs-tar by the
  agent: …`. A refusal fails the migration with the reason and the install
  hint, as before.

### Why application mode is not rsync

The brief asked for rsync. rsync needs a reachable `sshd` and an authorized
key inside the target guest — a package and an open port ProxyPilot would be
**adding** to a guest that asked for neither, when `incus exec` already
reaches it from the host. So each application directory is tarred on the
source, PUT to the same artifact endpoint the rootfs path uses, and unpacked
into the guest by ProxyPilot; the database dump travels the same way and is
restored by the guest's own engine. The agent ends up talking to exactly one
place, and the guest needs nothing installed in it.

The **final delta sync** keeps its meaning: on the second pass the server
sets `since`, and tar carries only what changed after it
(`--newer-mtime`).

## The one line

`create_migration` (MCP) or **Migrations → New migration** returns:

```
curl -fsSL https://<your-proxypilot>/api/migrations/agent/<token>/install.sh | sudo sh
```

The bootstrap script is small on purpose — an operator pasting a command
onto their production web server is entitled to read it in one screen. It:

1. refuses to run as anything but root,
2. picks amd64 or arm64 from `uname -m`,
3. downloads the agent from the same tokened URL,
4. **verifies its sha256 against the hash baked into the script** and refuses
   on a mismatch,
5. execs it with the URL, the token and the TLS pin.

The two-step form (`command_steps`) downloads the script, pauses so you can
read it, and then runs it.

## What the agent is, and what it is allowed to do

The same Go binary as the host agent (`cmd/agent`), run as
`proxypilot-agent migrate`. It is cross-built for linux/amd64 and
linux/arm64 by `scripts/build-migration-agent.sh` (install.sh and update.sh
call it) into `/var/lib/proxypilot/agent/`, and served from the tokened URL
with its hash.

- **One credential.** A single-use, scoped migration token. The first call
  CLAIMS it against that agent run (`X-Migration-Run`), so a token read off a
  terminal cannot be taken over. It **ends by use, not by a clock**: it dies
  when the migration reaches a terminal state, and an operator can revoke it
  at any moment (see **Agent tokens**). A wall-clock TTL is available
  (`ttl_seconds`, 5 min – 30 days) and off by default.
- **TLS pinned.** The agent holds ProxyPilot to the certificate fingerprint
  in the bootstrap script. A token is never presented to a server we have not
  identified.
- **Two destinations only.** The ProxyPilot API and, in whole-machine mode,
  the Incus endpoint ProxyPilot named.
- **It removes itself** when the migration ends, unless `keep_agent` was set.
- `proxypilot-agent migrate --print` collects the inventory and prints it,
  sending nothing and needing no token: a source owner can see exactly what
  would be sent before agreeing to anything.

## The inventory manifest

Collected before a byte is copied, and the operator's decision surface: OS
and version, disks and mounts (the `findmnt` tree, so a data volume under
`/var` is not missed), systemd units with the ports their processes listen
on, nginx/apache/caddy vhosts with their server names and upstreams,
docker and compose, databases (postgres/mysql with sizes, sqlite files),
cron from all three locations, where TLS material lives, `.env` files, and
the outbound hosts observed in the connection table, unit files, compose
files and cron.

**Secrets are never carried.** `.env` files appear as a PATH and a list of
KEY NAMES. The agent discards the value half at the source, before anything
is serialized, and `lib/migration/manifest.js` **refuses** a manifest that
carries a value anywhere in it — a `value`, `values`, `secret`, `password`
or `contents` key at any depth, an unexpected property on an `env_files`
entry, or a "key" that is really a `KEY=value` line. A tampered agent cannot
put a secret in ProxyPilot's database. The operator types the values in
themselves at the `secrets_entered` cutover step.

From the manifest ProxyPilot derives the routes worth offering, the outbound
hosts worth an egress grant (RFC1918 peers and the source's own addresses are
marked internal and not proposed), the database dump/restore plan, and the
**concerns** — a blocking concern refuses the approval until it is overridden
deliberately.

## Readiness

Four things decide whether the command you are about to paste can work, and
**Migrations → Readiness** reports all four before you paste it:

| Check | Why it blocks |
|---|---|
| `agent_builds` | a source host has nothing to download (run `scripts/build-migration-agent.sh`; install.sh and update.sh do) |
| `public_url` | the pasted command would point nowhere |
| `tls_pin` | a warning, not a block: without a readable certificate the agent falls back to the system trust store |
| `incus_listener` | a warning, not a block: only `incus-migrate` needs it — a container source uses `rootfs-tar` |

`ready_for` turns those into the answer an operator actually wants: which of
the three transports can run right now. The listener is the one check with a
fix the product can perform, so it has a button (see **Operator
prerequisites**).

## Where it lands, and whether it fits

`pool` on the migration spec (the dialog's **Storage pool** picker, which
lists every pool with its free space) chooses the Incus storage pool. Leave it
alone and the guest lands wherever new guests land — the default profile's
root disk, which **Storage → Incus storage pools → Make default** repoints
(`set_default_storage_pool`; it moves nothing, only changes where new things
go). `disk_gb` sets the guest's root size; ZFS enforces that as a quota.

All three transports honour both. `incus-migrate` creates the instance itself,
so the answer rules take the extra trip through its overrides menu — option 4,
the pool, the size, then 1 to begin. (Before 2026-09-20 they did not, and a
whole-machine migration silently landed on the default pool whatever you
asked for.)

**Two different places have to have room**, and the review says so before you
approve:

| | the pool | ProxyPilot's own disk |
|---|---|---|
| `incus-migrate` | the whole guest | nothing — it streams straight into Incus |
| `rootfs-tar` | the unpacked guest | the compressed rootfs, deleted after the import |
| `file-sync` | the guest | each directory tarball and the database dump |

The check is measured, not guessed: `capacityNeeds` reads what the manifest
says is coming (the source's used bytes, or the app directories plus the
database counted twice — a dump is restored beside itself), and the pool's
free space comes from Incus's own `/1.0/storage-pools/<name>/resources`, so it
answers for zfs, dir, btrfs and lvm alike. A separate data mount is **named
and not counted**: `--one-file-system` leaves it on the source.

- **It will not fit** → a *blocking* concern. The approval is refused, by the
  dashboard and by `approve_migration` alike (the gate is in the service, not
  in each surface), and the refusal carries the numbers. Tick **Approve over
  the blocking concern** (`override_blocking: true`) when you know better — a
  mostly-sparse disk, say; the override is recorded on the migration.
- **It fits with under 10% of the free space left** → a warning.
- **The free space could not be read** → a warning. Not knowing never blocks,
  and never silently passes either.

Capacity is measured when the inventory lands and **again at approval**,
because "the pool had room an hour ago" is not an answer. `migration_preflight`
shows every pool, its free space, which one is the default and how much room
the staging disk has, before you create anything.

## The gate

Nothing is copied until a human approves. The agent posts the manifest and
then polls; the migration sits in `awaiting_review`; **Approve the transfer**
(or `approve_migration`) is the step that lets bytes leave the source. In
application mode that is also when the target guest is created — stopped
where it can be, with **the default-deny egress fence up and no route**.

`auto_transfer: true` skips the wait. It exists for a lab; the default is
false and false is the right answer for production.

## The cutover checklist

The post-import work is state, not prose: each step records who completed it
and when, so a cutover survives a page reload, a shift change and an audit.
The migration is `completed` when every required step is marked.

| Step | Done with |
|---|---|
| `snapshot_pre_cutover` | `snapshot_lxc_container` |
| `inventory_reviewed` | the Inventory tab |
| `route_created` | `set_route` |
| `egress_reviewed` | the Allow/Deny buttons (see below), or `set_lxc_egress` |
| `secrets_entered` | `set_project_env` — the key names came from the manifest, the values from you |
| `health_check` | `probe_lxc_port` |
| `final_delta_sync` (application mode) | `migration_cutover` |
| `dns_switched` | `set_dns_record` |
| `source_frozen` | stop the source service, so two copies never both take writes |
| `verified` | `test_route` |
| `snapshot_post_cutover` | `snapshot_lxc_container` |

### What "egress" means here

ProxyPilot's guest fence governs **bridge → host** traffic: the firewall's
`NAMED_SERVICES` is a short, code-owned list of host-side endpoints, and
everything not on it is denied. It does **not** govern a guest's access to
the internet.

So the observed-outbound list is, above all, a description of what the
application talks to — the thing an operator needs before they publish it.
Approving an entry does one of two things, and the row says which:

- **applied** — the destination matches one of the firewall's named host
  services, and a real allow was written for this guest.
- **acknowledged** — it is an internet destination: reviewed and recorded,
  with nothing claimed about a fence that does not cover it.

(For a Mock2 project guest, internet egress *is* governed, through the
project's own egress grants — `list_egress_requests` / `approve_egress`.)

## Agent tokens

One token per migration, for the whole of its life, listed on the page under
**Agent tokens** (`list_migration_tokens`, `GET /api/migrations/tokens`):

| State | What it means |
|---|---|
| `unclaimed` | minted, never used — the command is still out there and still works |
| `active` | claimed by the agent run doing this migration |
| `spent` | the migration finished; the token is dead |
| `revoked` | somebody killed it |
| `expired` | a `ttl_seconds` was asked for and has passed |

A token is not on a clock because a migration is planned work: one that dies
while the operator is still reading the inventory buys nothing, and the claim
binding is what actually stops a leaked token being used by somebody else.
What replaces the clock is **Revoke** (`revoke_migration_token`) — the undo
for a command pasted somewhere it should not have been. It kills the token and
leaves the migration alone; cancel the migration as well if the run should
stop. The listing never carries a secret: the plaintext token exists once, in
the answer to `create_migration`.

## Cleaning up

**Clean up** on a finished migration (`cleanup_migration`) throws away what it
left behind: the guest it created, the migration record and its event log, or
both. The dialog asks the server what each choice would do before the button
does anything, so a refusal is read rather than discovered.

It is deliberately narrow, because deleting a guest is the most destructive
thing in this feature:

- a migration that is still running is refused — cancel it first;
- a guest this migration **adopted** rather than created is refused: somebody
  else's guest is not ProxyPilot's to delete;
- a guest serving a route is refused, and points at `delete_lxc_container`,
  which knows how to unpublish as it goes;
- if the route tables cannot be read at all, it refuses rather than guesses;
- a running guest is stopped cleanly first (`force` stops it hard);
- **no export is taken unless you ask** (`export: true`): a migration guest
  that failed never ran, and the source it came from is still standing.

Removing the record also revokes the token and the Incus trust certificate,
and deletes the transfer's working directory. None of it can be undone.

## Surface

- **REST** `/api/migrations` (admin, sudo on every mutation): list, create,
  get, events, approve, cancel, checklist, egress.
- **REST** `/api/migrations/agent/:token/…` — no session, no cookies,
  CSRF-exempt by design: `install.sh`, `binary/:arch`, `job`, `inventory`,
  `event`, `artifact`, `finish`.
- **REST** `GET /api/migrations/preflight` (readiness) and
  `POST /api/migrations/incus-listener` (sudo).
- **REST** `GET /api/migrations/tokens`, `POST /api/migrations/:id/token/revoke`,
  `POST /api/migrations/:id/cleanup` (all sudo except the listing).
- **MCP** `create_migration`, `get_migration`, `list_migrations`,
  `approve_migration`, `migration_cutover`, `cancel_migration`,
  `migration_preflight`, `enable_incus_listener`, `list_migration_tokens`,
  `revoke_migration_token`, `cleanup_migration` — behind the `mcp.migration`
  feature flag (the readers stay available when it is off; `cleanup_migration`
  additionally needs `mcp.destructive`).
- **Page** Migrations (`pages/Migrations.jsx`): readiness, the list, the phase
  rail and live transfer rate, the inventory review, the checklist and the
  agent's log.
- **Tables** `migrations` + `migration_events` (migrations 909–911). The
  token is stored as a sha256 hash only; the capacity verdict is recorded on
  the row so the page, the MCP reader and the approval gate quote the same
  numbers.
- **Code** `lib/migration/{manifest,plan,token,service,index}.js`,
  `routes/migrations.js`, `routes/mcp-tools/migration.js`,
  `cmd/agent/migrate/*.go`.

## Operator prerequisites

- **Whole-machine via incus-migrate** needs Incus listening on the network —
  the source connects to it *directly*, not through ProxyPilot. **Migrations →
  Readiness** says whether it does and turns it on for you
  (`enable_incus_listener` over MCP, `POST /api/migrations/incus-listener`
  under sudo). The address it proposes is the **Incus bridge gateway**, which
  guests and LAN hosts can reach and the internet cannot; a bind on every
  interface (`:8443`, `0.0.0.0:8443`) is **refused** unless `allow_public`
  says the source really is out there, and the answer carries the one-line
  command that reverses it. By hand it is
  `incus config set core.https_address <addr>:8443`. ProxyPilot mints a
  single-use trust token per migration and revokes it on cancel. Without the
  listener the job refuses and says how to fix it rather than half-starting.
- **The source** needs `curl` and, per transport: `incus-migrate` — on
  Debian/Ubuntu that is **`apt install incus-extra`**, not `incus-tools`
  (the Zabbly packages use that name) — or `tar`, plus the database client for
  a dump. A container-bound whole-machine migration no longer needs
  `incus-migrate` at all: without it the transfer falls back to the rootfs
  tarball (see **When the source has no `incus-migrate`**). A VM-bound one
  does, and the review blocks until it is there.
- **Application mode** needs nothing in the guest: the copy arrives through
  `incus exec`. The guest does need the database engine installed if a dump
  is being restored into it (the restore says so plainly when it is missing).

## Things this deliberately does not do

- It never publishes a route or lifts the guest fence as part of an import.
- It never deletes anything on the source, and cancelling a migration never
  deletes the guest it created — deleting one is a separate, explicit
  **Clean up**.
- It never reads a secret value, and will not accept one if offered.
