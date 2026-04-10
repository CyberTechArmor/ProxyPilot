<!-- Split from proxypilot-core-infrastructure-prompt.md (lines 336-372) -->
<!-- Index: docs/core/prompt/README.md -->

## Audit Logging

### Dual-Write

1. Append-only `/var/log/proxypilot/audit.log` (JSON Lines, synchronous)
2. Postgres `proxypilot_audit.audit_log` (async sync, Compliant profile)

### Postgres Schema

```sql
CREATE TABLE audit_log (
  id BIGSERIAL PRIMARY KEY,
  timestamp TIMESTAMPTZ NOT NULL,
  action TEXT NOT NULL,
  actor TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_name TEXT,
  details JSONB,
  result TEXT NOT NULL CHECK (result IN ('success', 'failure', 'partial')),
  duration_ms INTEGER,
  synced_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_audit_log_timestamp ON audit_log (timestamp);
CREATE INDEX idx_audit_log_action ON audit_log (action);
CREATE INDEX idx_audit_log_resource ON audit_log (resource_type, resource_name);
CREATE INDEX idx_audit_log_actor ON audit_log (actor);
```

### Audited Actions

Container (create, start, stop, restart, destroy, resize, snapshot, restore), route (add, remove, update), database (create, drop, tune), static (deploy, rollback), backup (export, restore), template (create, delete), access (user.add, user.remove, access.review), core (init, credential.rotate, service.restart), compliance (check.run, docs.generate), patch (run, rollback, schedule.create).

### Log Rotation

365 days (Compliant) or 90 days (Standard/Hardened). `copytruncate` for uninterrupted writes. Sync tracks inode for truncation handling.
