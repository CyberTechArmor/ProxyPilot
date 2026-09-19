# Storage: host drives and ZFS pools, managed from the dashboard and over MCP

ProxyPilot sees every block device on the host and manages all non-OS
storage as ZFS: pools it creates from whole disks, the Incus storage pool on
top (`<pool>/incus`), backups and exports datasets (`<pool>/backups`,
`<pool>/exports`), sanoid snapshot retention, syncoid replication to a second
pool or a remote host, and snapshot-based restore of guests. Surface: the
**Storage** page (`/storage`), `/api/storage/*`, and the 27-tool `storage` MCP
family. Code: `admin/backend/src/lib/storage/` (parse → planner → policy /
freshness → host → service), `routes/storage.js`, `routes/mcp-tools/storage.js`,
`lib/storage-monitor.js`, the Go agent's `cmd/agent/methods/storage.go`,
the host units in `deploy/` and helpers in `scripts/storage-*.sh`.

## The one rule: plan, then confirm

Every mutating verb, on the page and over MCP, is the same two-step flow:

1. **Plan** (`dry_run: true` / `POST /api/storage/plan`): the service reads the
   live host (devices, pools, datasets, snapshots, Incus), the pure planner
   validates the request against it and returns the exact command plan —
   argv steps, warnings, the reversal — and a `plan_token`, the **sha256 of
   that plan**. Nothing is touched.
2. **Apply** (`confirm: true` + `plan_token` / `POST /api/storage/apply`,
   sudo-gated in the dashboard): the service recomputes the plan from the
   live host, compares its sha256 with the presented token, and refuses when
   they differ — a device that moved, a dataset that appeared, a changed
   parameter. Only an identical plan runs. Steps run in order, argv-only
   (no shell re-parse of caller input); the first failure stops the plan
   and is reported with the step's stderr and the reversal note.

Snapshot names inside a plan carry `{{stamp}}`; one timestamp is substituted
per run, so the token stays stable between plan and apply. A passphrase for
an encrypted pool is given only on the apply call, fed to `zpool create` on
stdin, never part of the plan, the ledger or the audit row.

Every applied plan lands in `storage_ops` (migration 908: op, subject, plan
token, plan, outcome, per-step detail) and in `audit_log`
(`STORAGE_<OP>`); MCP calls additionally get their `mcp_ledger` row.

## Device rules

Devices are addressed **only** by `/dev/disk/by-id/…` paths, whole disks only.
`list_disks` shows for every disk: model, serial, size, transport, rotational,
partitions with filesystems and mountpoints, holders (md / dm / LVM), by-id
paths, SMART (health verdict, temperature, reallocated / pending sectors,
power-on hours, NVMe wear and media errors), signatures (`zfs_member`,
`linux_raid_member`, `LVM2_member`, `crypto_LUKS`, filesystems, partition
table), the imported pool it belongs to, an importable pool found on it, and
**`os: true`** on the device(s) backing `/`, `/boot`, `/boot/efi` and swap —
resolved through `findmnt` and the lsblk holder chain (LVM, md, LUKS and
btrfs roots included; a ZFS root marks every member of the root pool).

| Condition | Result |
|---|---|
| OS device | refused, **no override exists** |
| mounted filesystem anywhere on the disk | refused — unmount first |
| member of an imported pool | refused — export or replace it first |
| active md / LVM / device-mapper holder | refused — stop it first |
| importable (exported) pool, any other signature | refused unless `wipe: true` (with the token); the plan then shows the `zpool labelclear` / `wipefs -a` steps |

mdadm is never placed under ZFS: pools are built from whole disks only.

## Pools and datasets

`create_zpool`: `single | mirror | raidz1 | raidz2 | raidz3`, one vdev from
`devices` or several from `vdevs: [[…], […]]`; defaults `ashift=12`,
`compression=zstd`, `atime=off`, `xattr=sa`, `acltype=posixacl`,
`dnodesize=auto`; optional native encryption (`keyformat: passphrase` on
stdin, or `keylocation: file:///path` for a key file the operator keeps on
the host — ProxyPilot never reads or stores it). By default the pool is
recorded as **managed** and gets `<pool>/incus`, `<pool>/backups`,
`<pool>/exports`. `set_managed_pool` adopts an existing pool the same way.

`create_dataset`, `set_dataset_props` (allowlisted properties only),
`zfs_snapshot`, `zfs_rollback` (refuses when newer snapshots exist unless
`destroy_newer`), `destroy_zfs_snapshot`, and `destroy_dataset` — which takes
a fresh recursive snapshot **and streams it** (`zfs send -R`) into
`<backups mountpoint>/destroyed/` before `zfs destroy -r`, because the
snapshot alone would die with the dataset; the plan names the stream file and
the `zfs receive` that brings it back. Guest storage, Incus pool sources and
pools themselves are refused.

`replace_disk` (`zpool replace`, resilver progress in `zpool_status`),
`zpool_scrub` (start / stop / pause; `timer: true` enables
`proxypilot-zfs-scrub@<pool>.timer`, monthly), `import_pool` (always through
`/dev/disk/by-id`; non-ONLINE needs `force`), `export_pool` (refused while
guests run on it; Incus pools on it need `force`; exporting the managed pool
clears the setting). `zpool destroy` is deliberately not offered.

## The Incus binding

`set_incus_storage_pool` runs `incus storage create <name> zfs
source=<pool>/incus` (skipped when it already exists on that dataset) and
points the default profile's root disk at it (or adds one). The plan lists
the existing Incus pools. `move_guest_storage` moves one guest or a batch:
stop (only with `stop: true`), `incus snapshot create <guest>
pp-premove-<stamp>`, `incus move <guest> --storage <pool>`, start, and a
verification step that the guest is `Running`.

Once a managed pool exists, `export_lxc` / `import_lxc` /
`delete_lxc_container` write their tarballs to the exports dataset's
mountpoint, `list_host_snapshots` lists the managed datasets' snapshots and
`create_host_snapshot` takes a recursive snapshot of the backups dataset (or
a named dataset under the pool). `export_grc_evidence` carries a `storage`
section: pool health and last scrub, per-guest snapshot age, replication
state, SMART verdicts, and the storage ops ledger.

## Backup: sanoid

`scripts/install-storage.sh` installs sanoid (its own `sanoid.timer` runs every
15 minutes). ProxyPilot owns `/etc/sanoid/sanoid.conf`: three templates
(`pp_guests`, `pp_backups`, `pp_exports`) with retention per class, and a
section per managed dataset (`<pool>/incus` recursive over the guests,
backups, exports) plus per-dataset and per-guest overrides.

| Class | frequent (15 min) | hourly | daily | monthly |
|---|---|---|---|---|
| guests (`<pool>/incus/…`) | 4 | 24 | 14 | 3 |
| backups | 0 | 0 | 30 | 6 |
| exports | 0 | 0 | 7 | 1 |

`get_backup_policy` shows the policy, the effective retention of every dataset
and the rendered file; `set_backup_policy` changes a class, a dataset or a
guest and rewrites the file through the plan/confirm flow (the file content is
in the plan, so the token covers it).

## Replication: syncoid

`set_replication_target` defines a job: source datasets, a target
(`pool2/dataset` on a second local pool, or `[user@]host:pool/dataset` over
SSH with the key path on the host), schedule (`hourly`, `daily`, `weekly` or
a systemd `OnCalendar`). The plan writes
`/etc/proxypilot/storage/replication-<name>.conf` (0600; the only place the
key path lives), a schedule drop-in for `proxypilot-syncoid@<name>.timer`, and
enables the timer. ProxyPilot stores **only** name, sources, target string,
schedule, kind and enabled. `run_replication` runs the job now through
`/usr/local/sbin/proxypilot-storage-replicate` (waits; `wait: false` starts
the unit in the background); the wrapper writes
`/var/lib/proxypilot/storage/replication/<name>.json` (started / finished /
ok / error / last success / log tail), which `replication_status` and the
freshness monitor read.

## Restore

Two different tools, both plan/confirm:

- `restore_guest_from_snapshot` creates a **new** guest from a snapshot of an
  existing guest's dataset. An Incus snapshot (`snapshot-<name>`) becomes
  `incus copy <guest>/<name> <new>`; a sanoid / syncoid / manual ZFS snapshot
  goes through `proxypilot-storage-restore-guest`, which clones the snapshot,
  packages it as an Incus backup tarball (`backup/index.yaml` + the instance
  directory) and `incus import`s it under the new name. The original guest is
  untouched.
- `rollback_guest_dataset` rolls the guest's own dataset back in place: stop
  (`stop: true`), `zfs rollback`, start, verify `Running`. Refused when newer
  Incus snapshots exist (they would be destroyed behind Incus's back — delete
  them with `delete_snapshot` first); newer ZFS snapshots need `destroy_newer`.

## Freshness and alerts

`storage_freshness` / `GET /api/storage/freshness` reports, per pool: health,
capacity, last scrub and its age and errors; per guest and dataset: last
snapshot age against the policy's window (frequent → 1 h, hourly → 3 h,
daily → 30 h, monthly → 35 d); per replication job: last success against its
schedule. `lib/storage-monitor.js` evaluates the alert conditions every 15
minutes and posts them to the bell (deduped per subject, auto-resolved when
the condition clears) and, once per new condition, to every out-of-band
channel — email, SMS, push and the signed webhooks (events `storage.*`):
pool `DEGRADED` / `FAULTED` / `UNAVAIL`, scrub or device errors, scrub overdue
(> 45 days), capacity ≥ 90 %, SMART failure or warning, snapshot older than
policy, replication failed or stale.

## Discovery: the agent and the fallback

`storage.list_disks`, `storage.zpool_status` and `storage.zfs_list` are Go
methods in the host agent (`cmd/agent/methods/storage.go`), producing the
same JSON the Node parsers in `lib/storage/parse.js` produce. The backend
asks the agent first and falls back to the same commands through the
existing nsenter path when the agent is unreachable, predates the methods,
or lacks privilege: the agent unit is unprivileged (it gained
`SupplementaryGroups=disk` so lsblk and `zpool import` label scanning can
read devices), so `smartctl` results it reports as `permission_denied` are
filled in by the backend as root. Mutations always run through the backend's
root path.

## Preflight, and installing the toolchain from the dashboard

`storage_preflight` and `GET /api/storage/preflight` answer two questions
before anything is changed.

**Can this host install and run the stack?** Every check carries a status and
a remedy: apt present, a Debian-like distribution, the host agent reachable,
the root update runner installed and enabled, `scripts/install-storage.sh`
present in the recorded checkout, the ZFS tools and kernel module, smartctl,
sanoid, syncoid, the ProxyPilot units and the two helpers. Only the first five
block an install, because without them nothing can run; the rest are what the
install fixes.

**Is a given disk safe to take?** The block layer cannot answer this, so the
preflight reads what it cannot see: `/proc/mdstat` for assembled arrays,
`mdadm --examine` per disk and partition for a superblock belonging to an
array that is merely stopped, `/etc/fstab` for a reference by device path,
UUID, PARTUUID or LABEL, `efibootmgr -v` for a boot entry whose PARTUUID
lives on the disk, and `swapon` for active swap. An fstab reference, a RAID
superblock and active swap are **hard refusals** that `wipe: true` does not
override, because wiping any of them breaks the next boot. An EFI boot entry
is a warning carried into the plan. These become `device.risk` on the
inventory, which `deviceEligibility` folds into its hard and warning lists,
so no plan can ever take such a disk.

`install_storage_toolchain` and `POST /api/storage/install` then run the
installer. The backend is in a container and the agent is unprivileged, so
neither can install anything; the request goes through the **root update
runner**, the same privilege path as a self-update. The agent writes a
request with `action: "storage-install"`, the runner validates owner, nonce,
freshness and action exactly as it does for an update, **refuses any flags**,
resolves the script from its own recorded `source-dir` rather than from the
request, and runs it with no arguments. Progress is the ordinary self-update
status, since one runner writes one state file for every action:
`get_storage_install_status` or `GET /api/storage/install/status`. Nothing in
this path touches a block device.

The install is refused when a blocking check fails, when an update or install
is already running, and when nothing is missing unless `force` is set.
`dry_run: true` reports what would be installed without requesting anything.

### What the installer has to work around

Neither distribution ships ZFS in a component that is enabled by default:
Debian keeps it in `contrib`, Ubuntu in `universe`. On a stock host
`apt-cache policy zfsutils-linux` reports no installation candidate and an
install would die at the first `apt-get` with *"Package 'zfsutils-linux' has
no installation candidate"*. The preflight checks the candidate up front and
says which component is missing; the installer then enables it by adding the
component to the **existing** apt stanza, keeping a `.proxypilot.bak` beside
it, so the archive URI and signing key stay exactly as the operator has them.
`deb-src` lines are left alone and a second run changes nothing.

On Debian there is also no in-tree module: `zfs-dkms` builds it with DKMS. Two
things make that fragile, and the installer handles both.

The headers go in their **own apt transaction first**. `zfs-dkms`'s postinst
skips the build when the headers are not configured yet, and apt does not
order two unrelated packages, so installing them together can silently produce
no module at all. The build is then forced with `dkms autoinstall` rather than
trusted to postinst.

Debian's archive carries only the **current** kernel build, so the running
kernel's headers are frequently gone and DKMS builds against the current
kernel instead. The result is a module that exists but cannot load, because a
module only loads into the kernel it was built for. The installer and the
preflight tell these apart by listing which kernels actually have a
`zfs.ko` on disk:

| Situation | What is reported |
|---|---|
| built for the running kernel | loaded, green |
| built for another kernel | reboot into that kernel, which is already installed. Re-installing changes nothing, so `install_storage_toolchain` refuses without `force` |
| built for nothing, Secure Boot on | the kernel refuses an unsigned DKMS module: enrol a MOK key or disable Secure Boot |
| built for nothing, Secure Boot off | the build failed, with the path to `make.log` |

Exit codes: 3 installed but the module is not loaded, 4 a package that cannot
be made available, 5 a failed `apt-get`.

## Host preparation by hand

The dashboard path above is the normal route. The same script can be run
directly:

```bash
sudo bash scripts/install-storage.sh
```

installs `zfsutils-linux smartmontools sanoid pv mbuffer lzop`, loads the
module, installs `proxypilot-zfs-scrub@.{service,timer}`,
`proxypilot-syncoid@.{service,timer}`, the two helpers under
`/usr/local/sbin/`, seeds `/etc/sanoid/sanoid.conf`, enables `sanoid.timer`
and restarts the agent. For SSH replication, create a key on the host
(`ssh-keygen -t ed25519 -f /root/.ssh/pp_replication -N ''`) and authorize it
on the target for a user allowed to `zfs receive`.

## Tests

`storage-parse`, `storage-planner`, `storage-policy`, `storage-service` (the
MCP family against a scripted host) are native-free unit tests.
`storage-loop.integration.test.js` runs the whole cycle — create (mirror),
snapshot, rollback, policy, replicate to a second pool with syncoid,
destroy + stream + receive back, scrub, export/import, replace/resilver — on
four 512 MB loop devices; it skips unless `PROXYPILOT_STORAGE_INTEGRATION=1`
as root with ZFS available, and `.github/workflows/storage-integration.yml`
runs it on every change to the storage code. The Go methods have their own
`go test` with fixtures.

## Environment

`PROXYPILOT_STORAGE_USE_AGENT=0` (skip the agent), `PROXYPILOT_STORAGE_MONITOR_CRON`
(default `*/15 * * * *`), `PROXYPILOT_STORAGE_CONF_DIR`, `PROXYPILOT_STORAGE_STATE_DIR`,
`PROXYPILOT_SANOID_CONF`, `PROXYPILOT_STORAGE_REPLICATE_BIN`,
`PROXYPILOT_STORAGE_RESTORE_BIN`, `PROXYPILOT_STORAGE_INCLUDE_LOOP=1` (treat loop
devices as disks — tests and dev VMs only).
