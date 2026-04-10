<!-- Split from proxypilot-core-infrastructure-prompt.md (lines 496-584) -->
<!-- Index: docs/core/prompt/README.md -->

## AIDE — Filesystem Integrity Monitoring (Hardened/Compliant)

### Purpose

Detects unauthorized modifications to system binaries, config files, libraries, and systemd units. Catches rootkits, supply chain tampering, and manual changes that bypassed ProxyPilot. Complements ProxyPilot's application-level audit trail — AIDE covers the entire host filesystem.

### Setup During Init

```
1. Install AIDE (apt install aide)

2. Write AIDE config (/etc/aide/aide.conf) with monitored paths:
   - /usr/bin, /usr/sbin, /usr/lib — system binaries
   - /etc — all configuration files
   - /boot — kernel and bootloader
   - /lib/systemd — systemd unit files
   - Exclude: /var/log, /var/lib/postgresql (data, not binaries),
     /var/lib/proxypilot (managed data), /tmp, /proc, /sys

3. Initialize database: aideinit
   (This takes 2-5 minutes — scans entire monitored filesystem)

4. Move database: cp /var/lib/aide/aide.db.new /var/lib/aide/aide.db

5. Generate proxypilot-aide-check.timer (daily at 06:00)
   and proxypilot-aide-check.service (runs aide --check)

6. Enable timer

7. Verify: aide --check returns 0 (no changes since init)
```

### AIDE Database Re-initialization

AIDE will report false positives after any legitimate system change (package updates, kernel upgrades, ProxyPilot config changes). The database must be updated after approved changes.

```
proxypilot security aide-update [--reason "<description>"]
```
- Runs `aideinit` to regenerate the baseline
- Moves new database into place
- Logs the update in audit trail with reason
- Prints what changed since the last baseline (so the operator can verify the changes are expected before accepting)

**Automatic re-init triggers:** ProxyPilot should automatically offer AIDE database update after:
- `proxypilot init` (any re-run that changes configs)
- Host unattended-upgrades run (detected via apt log)
- `proxypilot core restart` that regenerates config files

### Daily Check Integration

The `proxypilot-aide-check.timer` runs daily. Results are captured:

- **No changes:** logged as success, no action needed
- **Changes detected:** logged as alert in ProxyPilot audit trail. If Compliant profile, included in next compliance check results.

```
proxypilot security aide-check
```
- Runs AIDE check immediately (outside the daily timer)
- Prints results: files added, removed, modified
- If changes found: prints each changed file with what changed (permissions, size, checksum)

```
proxypilot security aide-status
```
- Last check time, result, database age, next scheduled check

### SQLite Schema

```sql
CREATE TABLE aide_checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  result TEXT NOT NULL CHECK (result IN ('clean', 'changes_detected', 'error')),
  files_added INTEGER DEFAULT 0,
  files_removed INTEGER DEFAULT 0,
  files_modified INTEGER DEFAULT 0,
  details_json TEXT,               -- changed file list with details
  checked_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE aide_baselines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reason TEXT NOT NULL,
  updated_by TEXT NOT NULL,        -- actor
  created_at TEXT DEFAULT (datetime('now'))
);
```
