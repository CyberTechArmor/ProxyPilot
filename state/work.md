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

## Follow-up round (operator review, 2026-09-19)

| # | Task | Status |
|---|---|---|
| 8 | Incus binding pins instances that inherit the default profile's root disk before repointing it (LEARNINGS 171) | done |
| 9 | `zpool status -j` `error_count: 0` is not a fault; the page renders the backend's alert set instead of its own copy (LEARNINGS 169) | done |
| 10 | Snapshot staleness gated on a policy actually being applied and sanoid running; Incus structural datasets never alert (LEARNINGS 170) | done |
| 11 | The header banner's install button opens the install dialog instead of re-selecting the tab it is already on; wording distinguishes units from toolchain (LEARNINGS 172) | done |
| 12 | The recovered `zpool import` scan no longer leaves the agent's warning on the page (LEARNINGS 173) | done |
| 13 | Template units are detected by file, not by `systemctl show` — an installed host said the toolchain was missing forever (LEARNINGS 174) | done |
