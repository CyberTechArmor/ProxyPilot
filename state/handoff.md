# Handoff — ZFS storage management

Branch `claude/proxypilot-zfs-storage-l9szn1` · 2026-09-19 · size L
Change record: `state/change-records/2026-09-19-zfs-storage.md` · doc: `docs/features/storage.md`

## Answer to the operator's question

There was **no page for managing drives**. `Housekeeping → Storage` is the
S3 destination form and the Incus page only warns when no storage pool
exists. This cycle adds **Storage** (`/storage`, sidebar after Housekeeping)
with Devices (SMART badges, OS tag, eligibility), Pools, Datasets, Snapshots,
Backup & replication, History, and one plan/confirm dialog that shows the
exact commands before anything runs — plus the 27-tool `storage` MCP family
with the same plan/confirm contract.

## Verified in this session (sandbox: no zfs kernel module, no Incus)

- `node --test` storage unit tests: parse (10), planner (10), policy /
  freshness (4), service + MCP gates (6) — 30 tests, all green, plus the
  extended-MCP catalog test updated to 160 tools (19 green). Coverage:
  OS-device refusal with no override, wipe semantics, layout minimums,
  token determinism and invalidation on parameter or host-state change,
  `{{stamp}}` substitution, failing step stops the plan, passphrase never in
  plan / ledger / results, sanoid.conf and syncoid config rendering,
  freshness statuses and alert keys, MCP ledger outcomes (`dry_run`,
  `refused`, `ok` with `confirmation_used`), feature-flag gating.
- Full backend suite: 2582 / 2594; the 6 failures are the 5 known
  native-module files (`cve-research`, `cves`, `incus`, `vpn-mtu`,
  `webauthn`) and the documented `mock2-ui-checks` parallelism flake (passes
  alone). No regression from this change.
- Go agent: see § Delegated work below.
- Frontend: `npm run build` — see § Delegated work below.
- Shell: `bash -n` on the three scripts; the Incus backup `index.yaml`
  field set was checked against Incus's `backup_info.go` (`Info` struct).

## Verified on loop devices — green in CI (run 3), not in this sandbox

`storage-loop.integration.test.js` (skips here: the sandbox cannot load the
zfs module) runs in `.github/workflows/storage-integration.yml` on
ubuntu-latest as root with `zfsutils-linux` + `sanoid`, on 4 × 512 MB loop
devices with pre-created by-id links:

1. inventory sees the loops as blank, eligible, non-OS; the runner's own OS
   disk is tagged `os: true` and refused
2. `create_zpool` mirror + managed datasets; stale token refused; members
   refused for a second pool
3. `create_dataset` / write / `zfs_snapshot` ×2 / `zfs_rollback` (newer
   refused, then `destroy_newer`) restores `v1`; `set_dataset_props` quota
4. `set_backup_policy` renders sanoid.conf (and takes a sanoid snapshot when
   the binary is present)
5. second pool + `set_replication_target` (config, timer drop-in) +
   `run_replication` through the syncoid wrapper → dataset present on pool 2,
   status JSON records success, freshness `ok`
6. `destroy_dataset` streams the pre-destroy snapshot; `zfs receive` brings
   the dataset back
7. `zpool_scrub` → freshness `ok` / `running`
8. `export_pool` → importable scan finds it by-id, `create_zpool` on that
   disk refused → `import_pool`
9. `replace_disk` onto the fourth loop, resilver completes

**What the first CI runs found** (the job is doing real ZFS work on the
runner, so it earns its keep):

| Run | Result | Cause |
|---|---|---|
| 1 | 1/9 | test bug: the pool device list picked up the test's own `-partN` symlinks, which the planner correctly refuses |
| 2 | 6/9 | one test bug (`zfs list -r` sorts by name) and **two product bugs**: the syncoid wrapper captured `rc=$?` inside `if ! cmd` (always 0, so a failed replication recorded success) and wrote invalid JSON on every success; the rollback guard ordered snapshots by `creation`, which is whole seconds, so a snapshot taken in the same second was destroyed without warning |
| 3 | **9/9 green** | after both product fixes + `createtxg` ordering in Node and the Go agent — https://github.com/CyberTechArmor/ProxyPilot/actions/runs/35449823223 |

Both product bugs now have unit coverage that runs everywhere:
`storage-replicate.test.js` (stub syncoid: success, failure, reason,
previous success preserved, config guard) and the same-second `createtxg`
case in `storage-planner.test.js`.

## Deployed (2026-09-19)

Merged to `main` as `512e6f6` and deployed to the live host with the
self-update runner (`update.sh --yes`, run id
`bc683c16-fba8-4050-bca0-23e577dfe899`, exit 0, ~1 min). Confirmed from the
run log and the agent:

- `Applied schema migration 908: storage_ops` — the ops ledger exists on the
  live database
- `[storage-monitor] registered (cron=*/15 * * * *)` — the alert monitor is
  running
- the host agent rebuilt at `512e6f6986`, so `storage.list_disks` /
  `storage.zpool_status` / `storage.zfs_list` are live on the socket
- container healthy, route drift clean, pre-update DB backup retained at
  `/opt/proxypilot/data/db/backups/proxypilot.db.pre-update-20260919-104916`

The operator's next step is the one-time host preparation
(`sudo bash scripts/install-storage.sh`) — until then the Storage page
renders with the toolchain badges showing zfs/sanoid/syncoid missing and
the pool tabs empty, which is the intended no-ZFS state.

## Not yet verified on real hardware / a real host

- `smartctl -j` through the nsenter root path on real SATA / NVMe devices
  (parsers tested on captured output); agent `permission_denied` → backend
  fill-in.
- Everything Incus: `set_incus_storage_pool`, `move_guest_storage`,
  `restore_guest_from_snapshot` (the `proxypilot-storage-restore-guest`
  helper clones a ZFS snapshot, builds `backup/index.yaml` + instance dir and
  runs `incus import <tar> <new> --storage <pool>`; the `instance` vs
  `container` key is preserved from the source `backup.yaml`), and
  `rollback_guest_dataset`. Guests in non-default Incus projects are named
  `<project>_<name>` on disk — the dataset mapping assumes the default
  project.
- Remote (SSH) replication end to end; `zpool status -j` on OpenZFS ≥ 2.3;
  the alert fan-out to real SMTP / webhook endpoints; the agent's `storage.*`
  methods on a live socket (the backend falls back to nsenter transparently).
- The Storage page on a real host (built, not clicked through against live
  data); walk `MOBILE_FIRST.md`'s checklist at 360 / 375 / 768 on a device.

## Commands the operator runs once by hand

```bash
# on the host, after update.sh has deployed this build
sudo bash scripts/install-storage.sh
#   apt-get install zfsutils-linux smartmontools sanoid pv mbuffer lzop
#   modprobe zfs; enables zfs-import/zfs-mount
#   installs deploy/proxypilot-zfs-scrub@.{service,timer}, deploy/proxypilot-syncoid@.{service,timer}
#   installs /usr/local/sbin/proxypilot-storage-replicate and /usr/local/sbin/proxypilot-storage-restore-guest
#   seeds /etc/sanoid/sanoid.conf, enables sanoid.timer
#   re-installs deploy/proxypilot-agent.service (SupplementaryGroups=disk) and restarts the agent

# replication over SSH: a key on the host, authorized on the target
sudo ssh-keygen -t ed25519 -f /root/.ssh/pp_replication -N ''
# on the target: authorize /root/.ssh/pp_replication.pub for a user that may run `zfs receive`
#   (root, or: zfs allow -u <user> create,mount,receive,rollback,destroy,snapshot,hold <pool>/<dataset>)
```

Paths to know: sanoid config `/etc/sanoid/sanoid.conf` (ProxyPilot-owned);
replication jobs `/etc/proxypilot/storage/replication-<name>.conf` (0600,
the only place the SSH key path lives); status
`/var/lib/proxypilot/storage/replication/<name>.json`; destroyed-dataset
streams `<backups mountpoint>/destroyed/`.

## Delegated work (reviewed)

Two self-contained parts were built by sub-tasks against written contracts
and re-verified here:

- **Go agent methods** (`cmd/agent/methods/storage.go`, 1.7k lines, 15 test
  functions with stub binaries + fixtures under `methods/testdata/storage/`):
  `go vet ./...` clean, `go test ./...` ok (re-run here). The sub-task diffed
  the Go output against `lib/storage/parse.js` over the same fixtures: zero
  differences apart from the `by_id` / `smart` fields the agent adds. Two
  follow-ups from its report were applied here: `host.js` forwards
  `include_loop` to the agent, and the Node scan regex accepts multi-day
  scrub durations (`in 1 days 02:03:04`) like the Go one.
- **Storage page** (`pages/Storage.jsx` + `components/storage/*`, 2.3k lines,
  `api.storage.*`, route + nav): `npm run build` passes (re-run here; the two
  warnings — api.js dynamic import, >2 MB main chunk — are pre-existing).
  MOBILE_FIRST walk-through is by construction (grids start at
  `grid-cols-1`, tables → cards below `md`, full-screen dialogs on `<sm`,
  44 px controls); no browser was available for the 360 px scroll-width
  audit. The alerts strip is computed client-side from the overview
  (mirrors `storageAlerts`) to avoid a second SMART scan per refresh;
  `GET /api/storage/alerts` remains for the server view. "Run now" for
  replication uses `wait: false` so the HTTP call never blocks on syncoid.

## Next steps

1. Push → watch `.github/workflows/storage-integration.yml` (first run).
2. On a real host: `sudo bash scripts/install-storage.sh`, open Storage,
   check Devices (OS tag on the right disk, SMART badges), create a pool on
   spare disks, bind Incus, move one guest, take/restore a snapshot.
3. Then tick the "not yet verified" items above in `docs/known-issues.md`.
