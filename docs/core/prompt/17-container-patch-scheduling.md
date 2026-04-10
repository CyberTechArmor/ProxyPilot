<!-- Split from proxypilot-core-infrastructure-prompt.md (lines 875-910) -->
<!-- Index: docs/core/prompt/README.md -->

## Container Patch Scheduling

### Patch with Snapshot Safety Net

```
proxypilot lxc patch-schedule <n> --cron "<expr>" [--snapshot-retention <duration>]
```

Default: weekly Sunday 03:00, 3-day snapshot retention.

Sequence: snapshot → apt upgrade → health check → if healthy: mark snapshot for auto-delete in 3 days → if unhealthy: auto-rollback + alert.

```
proxypilot lxc patch <n>                 # immediate patch with snapshot
proxypilot lxc patch-all                 # batch all containers
proxypilot lxc outdated                  # list pending updates
proxypilot lxc patch-schedule list       # show schedules
```

### Snapshot Auto-Cleanup

```sql
CREATE TABLE snapshot_expiry (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  container_id INTEGER NOT NULL REFERENCES containers(id) ON DELETE CASCADE,
  snapshot_name TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('pre_patch', 'manual')),
  created_at TEXT DEFAULT (datetime('now'))
);
```

Daily timer checks for expired snapshots and deletes them.

Defaults by profile: Standard (manual only), Hardened (weekly check + alert), Compliant (weekly automated patch with snapshot/rollback).
