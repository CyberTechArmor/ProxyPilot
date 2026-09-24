# Security follow-up and VM upgrade policy

This change addresses the September 24 follow-up review. It is a source change,
not evidence that a production host has been upgraded or migrated.

## Review disposition

| Item | Change | Remaining verification |
|---|---|---|
| R1: network shell injection | Shared-host operations default to administrator-only; mutations require sudo. Network keys and values are validated as a complete batch and dispatched as fixed argv. | Exercise approved network settings on staging. |
| R2: export authorization | Guest inventories and export lists are filtered; export metadata, creation and download check the actual guest grant before host effects. Shared queue details are admin-only. | Live backup/download acceptance. |
| R3: editor credentials | Live issuing-admin check, offboarding revocation, finite expiry, fresh local proof for issuance and activation/docroot changes. Migration 1018 retains hashes and grants a 30-day legacy rotation window. New keys default to 30 days, maximum 90. | Rotate unattributed/expired credentials; check local proof UI. |
| R4: SQL reader | User SQL uses libpq extended protocol under a separate OS/database login, with read-only transaction and timeout. No psql script or superuser fallback. Only explicitly granted curated `api_read` views are exposed. | Real PostgreSQL/peer-auth integration on supported guest images. |
| Session timestamps | SQLite UTC timestamps are parsed as UTC, independently of host timezone; malformed session timestamps fail closed. | No live clock changes needed. |
| R5 / S6: backend host authority | **Still open.** Guest VMs do not remove privileged dashboard execution, host PID namespace, Docker socket or writable host mounts. | Complete the separate host-boundary work in `security-host-boundary.md`. |

## What happens when an update arrives

1. The ordinary application/database update runs. The updater writes a private,
   names-and-status-only inventory to
   `/var/lib/proxypilot/security/guest-isolation.json`. It never stops a guest,
   changes its UID mapping, or changes a route.
2. New dashboard/MCP lifecycle launches refuse privileged/raw container
   settings and unsafe inherited profiles. Containers explicitly request
   `security.privileged=false`. Full Docker compatibility selects a VM.
   Existing privileged guests remain identifiable as requiring migration.
3. `GET /api/lxc/isolation` returns current findings. The guest detail dialog
   displays a legacy-container notice. Create an **application** migration to
   a **virtual-machine** in Migrations, or use the admin/sudo endpoint
   `POST /api/lxc/containers/:name/vm-migration` with a fresh target `name`,
   explicit `app_dirs`, and the application's database/service information.
   It creates the existing durable migration record and returns the source
   agent command; it does not run it or cut over traffic. The agent token
   from this endpoint expires after one hour.
4. Run the agent inside the source container, review its inventory, back up
   all application state, and approve the capacity/transfer plan. A fresh
   bootable VM image is provisioned. Application-mode launches now actually
   pass `--vm`; a pre-existing target is refused. Container rootfs imports
   cannot be relabeled as VM disks.
5. Install the matching runtime, database major version and services in the
   VM. Transfer application files and consistent database dumps; provision
   secrets explicitly. Validate ownership, permissions, scheduled jobs,
   dependencies, health, outbound access and the Incus guest agent privately.
6. During the maintenance window, stop **all source writers**, including
   schedulers and workers. Take the final consistent dump/file delta, restore
   it, verify the VM, then switch the existing service routes. Preserve service
   IDs, domains, access grants and certificate ownership. Verify through the
   public route before accepting writes.
7. Retain the old source stopped with autostart disabled and isolated from
   production traffic. Do not automatically delete it. Before the new VM
   accepts writes, rollback can restore the old route/source. After new writes,
   rollback needs reverse data reconciliation; switching the route alone loses
   data. Retire the old source only after the retention window and backup test.

**Automatic unattended conversion/cutover is not implemented.** The migration
record/checklist survives restarts, but completing its boxes is operator
evidence, not an atomic cutover transaction. Arbitrary applications require
workload-specific freeze, database restore, final sync and route validation.
New-launch policy is not an Incus-wide restriction against host administrators,
manual imports/restores or other software using the Incus API. Audit restored
guests before starting or publishing them.

## Resources and resizing

For the same nominal **2 vCPU / 2 GiB RAM / 100 GiB disk**:

| Resource | Unprivileged LXC | VM |
|---|---|---|
| CPU allocation | 2 CPUs as a limit; shares host kernel | 2 vCPUs; no extra dedicated core required. Hypervisor/I/O overhead depends on workload. |
| Memory | Guest processes and page cache; no separate guest kernel | The 2 GiB also contains the guest kernel/OS. Budget roughly 0.3–0.8 GiB more total host RAM for comparable application headroom, then measure. This is a planning estimate, not a ProxyPilot benchmark. |
| Disk | 100 GiB quota/volume | 100 GiB virtual disk remains possible; boot/OS consume some of it. Thin physical allocation depends on storage and snapshots. |
| Migration peak | Source remains allocated | Reserve destination RAM, application copy/dumps, VM OS, snapshots and rollback source concurrently. Do not assume only the final footprint. |

VM isolation is stronger because the workload has its own kernel. A guest
kernel compromise must still cross the hypervisor boundary to compromise the
host. LXC shares the host kernel; unprivileged UID mapping limits authority,
while privileged LXC removes that layer. Neither choice protects an application
from its own bugs or from a compromised host management backend. Avoid host
mounts and passthrough that undermine the boundary.

The resize API and dialog accept `rootSize`, for example `120GiB`. The durable
configuration operation refuses shrink and unknown current capacity. Growth
checks pool space and leaves at least 10% or 2 GiB free, whichever is larger.
This is a preflight check, not a cross-job space reservation.

For a running VM with a plain ext4/XFS root partition, the operation inspects
the guest, grows the virtual disk, runs `growpart` and the filesystem grow
utility inside that VM, and checks the resulting disk/partition/filesystem.
The guest needs Python 3, `cloud-guest-utils`, and its filesystem utility.
LVM, encrypted, multi-device, unavailable-agent and stopped-VM layouts are
refused before disk mutation. A failure after disk growth is recorded as a
partial operation; retry converges forward. It does not shrink the disk back.

Shrinking means provisioning a new smaller VM/disk and transferring data after
checking it fits. Deleting files/TRIM may reclaim thin storage; that does not
change the virtual disk's advertised capacity. CPU/RAM config changes are
read back, but guest hotplug support decides whether a full restart is needed.
No automatic utilization-triggered disk growth daemon is installed.

## Existing SQL-reader maintenance

After curated `api_read` views exist, a host administrator can run:

```sh
node scripts/provision-project-sql-reader.mjs pp-GUEST
```

This fixed provisioning step creates `pp_mcp_reader` and grants only existing
curated views. Run it again after adding approved views. Ordinary reader calls
never create a role or grant permissions. Existing guests without this setup
receive an actionable refusal. Base-table access is deliberately not restored
by a superuser fallback. New guest bootstrap attempts the same setup, but views
created later still require explicit provisioning.

## Release gates

- Security HTTP regressions and durable lifecycle/migration/configuration
  tests run with host effects simulated; they do not prove a live migration.
- Run a staging Incus VM creation, guest-agent probe, application transfer,
  final-sync/restart recovery, route cutover/rollback and supported disk-growth
  exercise before production use. Verify free capacity and a restorable backup.
- Test actual PostgreSQL role restrictions, metacommand rejection, write/DDL,
  role changes, timeout and large-result handling in the target guest image.
- Complete frontend mobile/browser acceptance before merging UI changes.
- Do not close R5/S6 until the dashboard loses host-root-equivalent privileges
  and the typed, independently authorized host operations are verified.

Primary references: [Incus security](https://linuxcontainers.org/incus/docs/main/explanation/security/),
[VM/container distinction](https://linuxcontainers.org/incus/docs/main/explanation/containers_and_vms/),
[launch-time disk options](https://linuxcontainers.org/incus/docs/main/reference/manpages/incus/launch/),
[storage resizing](https://linuxcontainers.org/incus/docs/main/howto/storage_volumes/),
[libpq command execution](https://www.postgresql.org/docs/16/libpq-exec.html).

## Validation recorded for this branch

- Node suites: 459 passing, one existing skipped test across the selected
  security, MCP, editor, lifecycle, configuration, migration and update suites.
- Nine additional Unix-socket driver tests cannot run here (`listen EPERM`);
  they must be rerun on a host that permits Unix sockets.
- Python updater checks: 14 passing. Frontend production build passes.
- Incus/KVM, real PostgreSQL and a browser executable are unavailable in this
  workspace. No live guest or production route was changed. Mobile browser
  acceptance and staging-host acceptance remain release gates.
