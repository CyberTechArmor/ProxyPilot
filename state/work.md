# Work file — ZFS storage management (size L)

Branch: `claude/proxypilot-zfs-storage-l9szn1` · started 2026-09-19

## Ask

ProxyPilot sees every block device on the host and manages all non-OS
storage as ZFS: Incus storage (containers, VMs, images, backups, exports)
on pools it manages, snapshot-based backup/restore (sanoid/syncoid), a
Storage page, REST endpoints, MCP tools, alerts, tests on loop devices.

Operator question answered up front: **there was no drives/storage page** —
`Housekeeping → Storage` is the S3 destination form, the Incus page only
warns when no storage pool exists. This cycle adds `/storage`.

## Plan (build order from the brief)

| # | Item | Status |
|---|------|--------|
| 1 | Agent discovery: `storage.list_disks` / `storage.zpool_status` / `storage.zfs_list` (Go) + Node parsers for the nsenter fallback | done |
| 2 | Planner: eligibility, OS-device refusal, layouts, plan → sha256 token, every mutating op | done |
| 3 | Incus binding: `set_incus_storage_pool`, `move_guest_storage` (batch), re-point `export_lxc` / `list_host_snapshots` / `create_host_snapshot` | done |
| 4 | sanoid policy + syncoid replication + freshness + restore/rollback tools | done |
| 5 | REST `/api/storage`, MCP `storage` family, Storage page, alerts via notifications + webhooks | done |
| 6 | Unit tests (planner, parsers, freshness, MCP gates) + loop-device integration test + CI workflow | done |
| 7 | Docs, handoff.md, change record, run-ledger row | done |

## Decisions

- Tool named `list_zfs_snapshots` (the brief says `list_snapshots`, which the
  LXC family already owns).
- Mounted filesystems are refused outright (unmount first); `wipe: true` +
  token clears every other signature. The OS device has no override.
- `destroy_dataset` takes a fresh snapshot AND streams it (`zfs send -R`) into
  the backups dataset before `zfs destroy -r`, otherwise the snapshot would die
  with the dataset.
- Agent unit stays unprivileged: `lsblk`, `zfs list`, `zpool status` work as
  is; `smartctl` and `zpool import` scanning need root, so the backend fills
  those in through the existing nsenter path when the agent reports
  `permission_denied`. Listed in handoff.md as a hand step (SupplementaryGroups=disk).

## Verification log

See handoff.md § Verified / § Verified on loop devices / § Not yet verified. Delegated parts (Go agent, Storage page) re-verified here: go vet/test ok, npm run build ok.
