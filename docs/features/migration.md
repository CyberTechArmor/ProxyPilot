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
`incus-migrate`, except on a Proxmox or otherwise nested LXC, where
`incus-migrate` cannot run inside the guest (it wants the block device the
rootfs lives on) — those take `rootfs-tar`, which tars the rootfs, streams it
to ProxyPilot, and imports it as a split image (`incus image import
metadata.tar.xz rootfs.tar.gz`). ProxyPilot supplies the metadata the agent
cannot know. Application mode uses `file-sync`.

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

- **One credential.** A single-use, scoped, expiring migration token. The
  first call CLAIMS it against that agent run (`X-Migration-Run`), so a token
  read off a terminal cannot be taken over; it dies with the migration and at
  its TTL (default 2 h).
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
| `egress_reviewed` | `set_lxc_egress` (or the Allow/Deny buttons, which apply a real grant) |
| `secrets_entered` | `set_project_env` — the key names came from the manifest, the values from you |
| `health_check` | `probe_lxc_port` |
| `final_delta_sync` (application mode) | `migration_cutover` |
| `dns_switched` | `set_dns_record` |
| `source_frozen` | stop the source service, so two copies never both take writes |
| `verified` | `test_route` |
| `snapshot_post_cutover` | `snapshot_lxc_container` |

## Surface

- **REST** `/api/migrations` (admin, sudo on every mutation): list, create,
  get, events, approve, cancel, checklist, egress.
- **REST** `/api/migrations/agent/:token/…` — no session, no cookies,
  CSRF-exempt by design: `install.sh`, `binary/:arch`, `job`, `inventory`,
  `event`, `artifact`, `finish`.
- **MCP** `create_migration`, `get_migration`, `list_migrations`,
  `approve_migration`, `migration_cutover`, `cancel_migration` — behind the
  `mcp.migration` feature flag (the readers stay available when it is off).
- **Page** Migrations (`pages/Migrations.jsx`): the list, the phase rail and
  live transfer rate, the inventory review, the checklist and the agent's log.
- **Tables** `migrations` + `migration_events` (migration 909). The token is
  stored as a sha256 hash only.
- **Code** `lib/migration/{manifest,plan,token,service,index}.js`,
  `routes/migrations.js`, `routes/mcp-tools/migration.js`,
  `cmd/agent/migrate/*.go`.

## Operator prerequisites

- **Whole-machine via incus-migrate** needs Incus listening on the network
  (`incus config set core.https_address :8443`) — the source connects to it
  directly. ProxyPilot mints a single-use trust token per migration and
  revokes it on cancel. Without the listener the job refuses with exactly
  that instruction rather than half-starting.
- **The source** needs `curl` and, per transport: `incus-migrate` (the
  `incus-tools` package) or `tar`, plus the database client for a dump.
- **Application mode** needs nothing in the guest: the copy arrives through
  `incus exec`. The guest does need the database engine installed if a dump
  is being restored into it (the restore says so plainly when it is missing).

## Things this deliberately does not do

- It never publishes a route or lifts the egress fence as part of an import.
- It never deletes anything on the source, and cancelling a migration never
  deletes the guest it created.
- It never reads a secret value, and will not accept one if offered.
