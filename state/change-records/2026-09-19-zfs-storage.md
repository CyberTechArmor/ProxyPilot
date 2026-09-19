# Change record — ZFS storage management (2026-09-19)

Branch `claude/proxypilot-zfs-storage-l9szn1` · size L · author: Claude Code session for Thomas@tagarmor.com

## Ask

ProxyPilot sees every block device on the host and manages all non-OS
storage as ZFS (Incus storage, backups, exports on managed pools), with
snapshot-based fast backup and restore, a Storage page, REST + MCP, alerts,
tests on loop devices. The operator also asked whether a drives page existed:
it did not (Housekeeping → Storage is the S3 form); `/storage` is new.

## What changed

| Area | Files | Notes |
|---|---|---|
| Pure layer | `admin/backend/src/lib/storage/{parse,planner,policy,freshness}.js` | parsers for lsblk/smartctl/findmnt/zpool/zfs/incus output; eligibility + layouts + every plan + sha256 plan token; sanoid/syncoid rendering; freshness + alert classification |
| Host + service | `lib/storage/{host,service,index}.js` | agent-first discovery with nsenter fallback; inventory, plan, apply (token check, argv-only executor, `{{stamp}}`), settings (`storage.*`), replication status, freshness, GRC evidence |
| REST | `routes/storage.js`, mounted in `index.js` at `/api/storage` | overview/disks/pools/datasets/snapshots/policy/replication/freshness/alerts/ops/toolchain, `POST /plan`, `POST /apply` (sudo) |
| MCP | `lib/mcp-ext/catalog/storage.js`, `routes/mcp-tools/storage.js`, catalog + handler registration, policy JSON (`mcp.storage`, `storage` section) | 27 tools; `list_zfs_snapshots` instead of `list_snapshots` (taken by the LXC family) |
| Re-pointed tools | `routes/mcp-tools/{admin,lxc-admin}.js`, catalog/admin.js | `export_lxc`/`import_lxc`/`delete_lxc_container` → managed exports dataset; `list_host_snapshots` / `create_host_snapshot` → managed datasets; `export_grc_evidence.storage` |
| Alerts | `lib/storage-monitor.js`, hydrated in `index.js` | every 15 min → bell (deduped, auto-resolve) + email/SMS/push/webhooks (`storage.*` events) |
| DB | `db.js` migration 908 `storage_ops` | every applied plan with token, plan, outcome, per-step detail |
| Agent | `cmd/agent/methods/storage.go` (+ tests, testdata), `registry.go`, `deploy/proxypilot-agent.service` (`SupplementaryGroups=disk`), `lib/agent.js` (`maxResponseBytes`) | `storage.list_disks` / `storage.zpool_status` / `storage.zfs_list` |
| Host units / helpers | `deploy/proxypilot-zfs-scrub@.{service,timer}`, `deploy/proxypilot-syncoid@.{service,timer}`, `scripts/storage-replicate.sh`, `scripts/storage-restore-guest.sh`, `scripts/install-storage.sh` | monthly scrub per pool; per-job syncoid timer with schedule drop-in; status JSON for freshness; ZFS-snapshot → Incus backup tarball → import |
| Frontend | `pages/Storage.jsx`, `components/storage/*`, `lib/api.js` (`api.storage`), `App.jsx`, `Layout.jsx` | Devices (SMART badges, OS tag), Pools, Datasets, Snapshots, Backup & replication, History, one plan/confirm dialog showing the exact commands |
| Tests | `__tests__/storage-{parse,planner,policy,service}.test.js`, fixtures, `storage-loop.integration.test.js`, `mcp-extended.test.js` counts, `.github/workflows/storage-integration.yml` | 49 unit tests; loop-device cycle in CI |
| Docs / state | `docs/features/storage.md`, `docs/features/mcp.md`, `CLAUDE.md`, `docs/known-issues.md`, `.env.example`, `state/*` | |

## Decisions worth knowing

- Mounted filesystems are a hard refusal (unmount first) rather than a
  wipe-overridable one; the OS device has no override at all.
- `destroy_dataset` streams the fresh snapshot to the backups location first,
  since a snapshot cannot outlive its dataset.
- `zpool destroy` is not offered; `export_pool` is the reversible verb.
- Only the target string / schedule of a replication job is stored in
  ProxyPilot; the key path lives in the host config file (0600).
- The `set_backup_policy` plan's `systemctl enable --now sanoid.timer` step is
  reported, not fatal, so the policy file still lands on a host where sanoid is
  not installed yet.

## Verification

See `state/handoff.md` § Verified / § Unverified.
