# NEXT SESSION — Backups + S3-compatible storage + restore dry-run

Single focused session, ~3–5 days of work depending on how far you
take the dry-run piece. Suggested split into two PRs noted at the
end so the foundation can land first.

## Outcome

The dashboard's existing single-page **Housekeeping** route becomes
a tabbed interface:

```
Housekeeping
├── Backups   ← new, default tab. Create / schedule / restore.
├── Cleanup   ← the existing housekeeping page (docker prune, DB backup prune, etc.)
└── Storage   ← new. S3-compatible destination configuration.
```

Operators can:
- Configure one or more S3-compatible destinations (MinIO, R2, B2,
  AWS S3, Wasabi, etc.).
- Create on-demand backups (config-only or full, per the existing
  backup tier doc at `docs/features/backups/master-prompt.md`).
- Schedule automated backups via cron.
- See per-service storage usage so they understand what's eating
  the bucket.
- Auto-cleanup old backups by age + count policy.
- Restore a backup, with a **dry-run** mode that validates without
  touching production.

## Inventory of state

ProxyPilot already knows about:
- SQLite at `/opt/proxypilot/data/db/proxypilot.db`
- `/opt/proxypilot/.env` (secrets)
- `/opt/proxypilot/data/services/` (per-service Caddy file roots)
- `/var/lib/proxypilot/cve-inbox/` (CVE specs)
- `/etc/caddy/{Caddyfile,sites/,custom/}`
- `/etc/wireguard/*.conf`
- `/var/lib/caddy/.local/share/caddy/` (ACME certs)
- Docker volumes referenced by registered services
- Incus instances (containers + VMs)

The backup system needs to enumerate, package, and restore subsets
of this state.

## Tab 1: Storage (S3 settings)

### DB schema

```sql
CREATE TABLE IF NOT EXISTS backup_destinations (
  id              TEXT PRIMARY KEY,
  name            TEXT UNIQUE NOT NULL,        -- operator-chosen label
  endpoint_url    TEXT NOT NULL,               -- e.g. https://s3.us-east-1.amazonaws.com
  bucket          TEXT NOT NULL,
  region          TEXT,
  path_prefix     TEXT,                        -- optional; e.g. prod/proxypilot/
  access_key_id   TEXT NOT NULL,
  secret_key_enc  TEXT NOT NULL,               -- AES-GCM with TOTP_ENCRYPTION_KEY
  use_ssl         INTEGER NOT NULL DEFAULT 1,
  path_style      INTEGER NOT NULL DEFAULT 0,  -- MinIO needs this; AWS doesn't
  storage_class   TEXT,                        -- STANDARD | STANDARD_IA | GLACIER | …
  is_default      INTEGER NOT NULL DEFAULT 0,  -- the destination newly-scheduled backups go to
  test_status     TEXT,                        -- "ok" | "error: <msg>"
  test_at         TEXT,                        -- ISO8601 of last test
  created_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

### Routes

- `GET  /api/backups/storage`              — list destinations.
- `POST /api/backups/storage`              — create. Sudo. Returns id.
- `PUT  /api/backups/storage/:id`          — update fields. Sudo.
- `DELETE /api/backups/storage/:id`        — remove. Sudo. Refuses if
                                             a backup_schedule still
                                             references it.
- `POST /api/backups/storage/:id/test`     — connect + HEAD bucket.
                                             Returns {ok, latency_ms,
                                             error?}. Updates
                                             test_status/test_at.
- `POST /api/backups/storage/:id/default`  — mark as default.

### UI

Form with the fields above. Test Connection button shows live
result. Multiple destinations supported (one is "default"). All
mutating actions sudo-gated (passkey-default).

### Dependencies

- AWS SDK v3 client for Node (`@aws-sdk/client-s3`) — works with
  every S3-compatible vendor we care about. Don't add a vendor-
  specific dep.
- Encryption key for the secret_key field — reuse
  TOTP_ENCRYPTION_KEY (already in .env, already covered by the
  install.sh secret-rotation flow).

## Tab 2: Backups (main)

### DB schema

```sql
CREATE TABLE IF NOT EXISTS backups (
  id              TEXT PRIMARY KEY,
  destination_id  TEXT NOT NULL REFERENCES backup_destinations(id),
  tier            TEXT NOT NULL,               -- "config" | "config_plus_data" | "full"
  scope           TEXT,                        -- "all" | "<service-name>" | JSON list
  s3_key          TEXT NOT NULL,               -- prefix/<id>.ppbackup
  size_bytes      INTEGER NOT NULL,
  encrypted       INTEGER NOT NULL DEFAULT 1,
  created_by      TEXT,                        -- user id, or "schedule:<id>" for cron-driven
  created_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  manifest_json   TEXT NOT NULL,               -- list of paths + sizes + sha256
  parent_backup   TEXT REFERENCES backups(id), -- incremental chain (future)
  status          TEXT NOT NULL,               -- "in_progress" | "ok" | "failed"
  error           TEXT
);

CREATE TABLE IF NOT EXISTS backup_schedules (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  destination_id  TEXT NOT NULL REFERENCES backup_destinations(id),
  cron_expr       TEXT NOT NULL,               -- "0 3 * * *" for nightly 3am
  tier            TEXT NOT NULL,
  scope           TEXT,
  retention_keep  INTEGER NOT NULL DEFAULT 30, -- keep this many backups
  retention_days  INTEGER,                     -- AND/OR delete older than N days
  enabled         INTEGER NOT NULL DEFAULT 1,
  last_run_at     TEXT,
  last_run_status TEXT,
  next_run_at     TEXT,
  created_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS restore_runs (
  id              TEXT PRIMARY KEY,
  backup_id       TEXT NOT NULL REFERENCES backups(id),
  mode            TEXT NOT NULL,               -- "dry_run" | "apply"
  target          TEXT NOT NULL,               -- "in_place" | "new_lxc:<name>" | "new_host:<addr>"
  started_at      TEXT NOT NULL,
  finished_at     TEXT,
  status          TEXT NOT NULL,               -- "running" | "ok" | "failed"
  steps_json      TEXT,                        -- per-step status array
  initiated_by    TEXT NOT NULL,
  notes           TEXT
);
```

### Routes

- `GET  /api/backups`                      — list, filterable.
- `POST /api/backups`                      — create on-demand. Sudo.
                                             Body: {tier, scope?,
                                             destination_id?,
                                             passphrase}.
- `GET  /api/backups/:id`                  — manifest + metadata.
- `GET  /api/backups/:id/download`         — stream from S3 to operator
                                             (admin-gated, audit-logged).
- `DELETE /api/backups/:id`                — delete from S3 + row. Sudo.
- `POST /api/backups/:id/restore`          — kick off a restore.
                                             Body: {mode, target,
                                             passphrase}.
                                             Sudo + confirm dialog.
- `GET  /api/backups/schedules`            — list schedules.
- `POST /api/backups/schedules`            — create. Sudo.
- `PUT  /api/backups/schedules/:id`        — update. Sudo.
- `DELETE /api/backups/schedules/:id`      — remove. Sudo.
- `POST /api/backups/schedules/:id/run-now` — trigger out-of-cycle.
                                             Sudo.
- `GET  /api/backups/usage`                — per-service / per-tier
                                             size breakdown across all
                                             destinations.
- `GET  /api/backups/restores`             — list past restore_runs.
- `GET  /api/backups/restores/:id`         — detailed step log.

### Cron / scheduler

Use a single in-process scheduler in the dashboard backend (e.g.
`node-cron` — small, no extra services). On startup, hydrate from
backup_schedules; on every CRUD mutation, re-register. The
scheduler enqueues jobs onto a small worker that runs serially
(one backup at a time — most ops can't run two parallel
`incus export`s without disk thrashing).

### Backup creation flow

Per the prior layered backup spec:
- **Tier "config"**: SQLite dump → JSON, plus .env, plus the inbox
  YAMLs. Encrypted with the operator's passphrase. Small, ~50 KB.
- **Tier "config_plus_data"**: above + service-data dirs +
  /var/lib/caddy/ certs + /etc/wireguard/. Larger, includes
  secrets — encryption mandatory.
- **Tier "full"**: everything in config_plus_data + per-service
  docker volume tarballs + per-instance `incus export` outputs.
  Multi-GB.

### Manifest

Each `.ppbackup` is a tar.gz with at the root:
```
manifest.json                # list of files + sizes + sha256
proxypilot.db.json           # config tier
.env                         # config tier
cve-inbox/                   # config tier
caddy/                       # config_plus_data tier
wireguard/                   # config_plus_data tier
caddy-acme/                  # config_plus_data tier
services/                    # config_plus_data tier
docker-volumes/<name>.tar.gz # full tier
incus-exports/<name>.tar.gz  # full tier
```

`manifest.json` is what the dry-run runs its checksum verification
against.

### UI

Top-of-tab quick actions: **Create backup now**, **Schedule a
backup**. Below: a sortable table of past backups (tier, scope,
size, age, destination, status, restore button per row).

Sticky header (matches the CVEs page pattern). Storage usage card
at the top showing total size + per-service breakdown.

"Last restore" panel surfaces the most recent `restore_run` so
operators see at a glance whether the last test passed.

## Tab 3: Cleanup

Existing Housekeeping page content, moved verbatim. No new
features here — just the relocation under the new tab structure.

## Restore dry-run — the hard part

The user-facing experience:

1. Operator clicks **Restore** on a backup row.
2. Dialog asks: dry-run or apply?  Target = "new sandbox" or
   "in place"?  Passphrase to decrypt.
3. Engine spins up a `restore_run` row, starts streaming logs.
4. Per-step outcomes shown live; final pass/fail at the end.

### Dry-run targets

Three viable modes, in increasing realism:

#### Mode A: Same host, sandbox

- Restore Incus instances under a new name suffix
  `<original>-restore-<short-id>`.
- Create them on a private bridge with no public ports — the
  staging copy isn't reachable from outside.
- Restore docker volumes into a sandbox docker network: spin a
  new container off the same image, mount the restored volume,
  exercise health checks (HTTP 200, postgres `SELECT 1`, etc.).
- Don't touch /etc/caddy / /etc/wireguard / .env / proxypilot.db
  on disk. Read-only verify only: parse the YAML, verify the
  cert chain validates, verify the WG config schema, etc.
- After verification: dialog asks "Keep sandbox for inspection?"
  — keep deletes nothing; discard tears down the sandbox.

**Pros**: simple, fast, no second host needed. **Cons**: stateful
services (Postgres, n8n) can't fully exercise their listeners
without port conflicts. The dry-run validates "the data is intact
+ the container starts" but not "the network path works."

#### Mode B: Different host

- Operator configures a "staging host" — another ProxyPilot install
  the dashboard knows about (SSH credentials saved in the DB,
  encrypted). Could be a literal second box or an Incus VM running
  inside the prod host.
- Engine pushes the backup to the staging host and runs the apply
  there. Health checks run against the staging host's URLs.
- Optional: apply a "demo" public URL via Caddy on the staging host
  so the operator can interact with the restored copy in a browser.

**Pros**: full restore path exercised, including network. Stateful
services bind their real ports. Real DNS-driven Caddy cert issuance
can be tested against a staging cert (operator points a subdomain
at the staging host first).  **Cons**: needs a staging host;
operator overhead.

#### Mode C: Manifest-only

- Doesn't actually restore. Decrypts the manifest, verifies every
  file's sha256 matches the tarball entry, verifies the manifest
  schema, surfaces "this backup is structurally sound."
- Useful as a quick sanity check that runs in seconds even on a
  multi-GB full backup.

### Per-service health checks

The dashboard already knows what services exist (services table).
For each restored service in dry-run mode, run a service-class-
specific health check:

| Service class | Health check |
|---|---|
| Static site (Caddy file root) | HTTP 200 on `/` of the demo URL |
| Generic web container | HTTP 200 on `/` (configurable path) |
| **Postgres** | psql `SELECT 1`; **then** for each table in the live DB, COUNT(*) inside the staging copy and report drift |
| **n8n** | HTTP 200 on `/healthz`; workflow count via the n8n API matches the live install |
| **MEET (Jitsi)** | Container starts (stateless — no data check needed; the user's note about MEET is correct) |
| **Generic stateful** | HTTP 200 + drift report on a configurable list of "key tables / files" |

The service classes ship as a small declarative table in the
backend; new classes added by editing one file. Operators with
unusual stacks fall through to "generic web" + can supply their own
check command in the service config.

### Where to test — recommendation

For most operators: **Mode A (same host, sandbox)** is the right
default. Cheap, fast, catches the 90% of "is this backup actually
usable" without operator overhead. Surface a checkbox "validate
network path on staging host" that flips to Mode B for operators
who want it; Mode C is the always-available "is this thing even
intact" pre-flight.

## UI patterns to follow

The CVEs page is the reference for the layout:
- Sticky chrome (search + table header).
- Top-level tabs (Active / Not affected / Dismissed in CVEs becomes
  Backups / Cleanup / Storage here).
- Per-row actions hidden in the row + revealed on click into a
  detail view rather than crowding the row.
- Operator confirmations for destructive actions (sudo-gated +
  passkey-default modal).

## Security

- Passphrase NEVER persisted. The operator types it on backup
  creation; never written to disk; the encrypted backup carries
  the argon2id KDF parameters in its header so the same passphrase
  works for restore.
- S3 secret_key encrypted at rest with TOTP_ENCRYPTION_KEY (same
  as TOTP secrets today).
- Audit log row for every backup, every schedule edit, every
  restore (dry-run AND apply).
- Restore apply mode requires a **second** confirmation in the
  dialog (operator types the backup id, like dismiss-with-reason).

## Tests

- Mock S3 server — MinIO container is the obvious choice; add it to
  CI as a service container.
- Round-trip: create a backup at each tier; restore in dry-run; verify
  manifest integrity.
- Schedule: register a 1-second cron, wait, verify a backup ran.
- Retention: create N+1 backups with retention_keep=N; verify the
  oldest got pruned.
- Concurrency: kick off two backups at once; verify the second
  queues rather than thrashing.

## Suggested PR split

**PR 1 — Foundation (smaller, ships the tab restructure + S3
config):**
- DB migrations for backup_destinations.
- Storage tab UI + routes.
- Tab restructure (move Cleanup content under its tab).
- Manual on-demand backup at config tier only, downloadable.

**PR 2 — Schedules + Restore + Dry-run (the bigger piece):**
- backup_schedules + cron worker.
- All three backup tiers.
- restore_runs + Mode A (sandbox same host).
- Per-service health-check table.
- Mode C (manifest-only) bonus.

**Mode B (different host)** as a follow-up after operator feedback —
it's the most useful but the most operator-overhead.

## Out of scope

- Incremental backups (parent_backup column is reserved for future
  use, not implemented in this round).
- Cross-region replication / multi-destination redundancy (set up
  vendor-side lifecycle rules instead — out of scope for the
  dashboard).
- Backup-of-backups / DR runbooks beyond the per-restore log.
- LDAP / SSO for the destination credentials — they're per-install,
  not per-operator.
