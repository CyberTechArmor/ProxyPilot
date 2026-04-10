<!-- Split from proxypilot-core-infrastructure-prompt.md (lines 290-321) -->
<!-- Index: docs/core/prompt/README.md -->

## PostgreSQL Architecture

### Single Instance, Multiple Databases

One Postgres instance hosts all databases. SOC 2 Type 2 and HIPAA satisfied through logical access controls.

### Core Databases

| Database | Owner Role | Purpose |
|---|---|---|
| `infisical` | `infisical_app` | Infisical backend |
| `proxypilot_audit` | `proxypilot_audit` | Audit log sync target |
| `proxypilot` | `proxypilot_app` | Reserved for future use |

### Role Isolation

Every role: `LOGIN`, `NOSUPERUSER`, `NOCREATEDB`, `NOCREATEROLE`. Grants only to own database. `REVOKE PUBLIC`. Per-role `work_mem` (default 32MB) and `temp_file_limit` (default 1GB).

### No statement_timeout

Not set by ProxyPilot. Causes more problems than it solves. Protection from PgBouncer limits, `work_mem`, `temp_file_limit`, monitoring.

### Postgres Configuration

RAM-tuned: `shared_buffers` 25% (cap 8GB), `effective_cache_size` 75%, `wal_level` replica, `archive_mode` on, `shared_preload_libraries` pg_stat_statements (+ pgaudit for Compliant).

`pg_hba.conf`: local scram-sha-256, localhost TCP scram-sha-256, bridge deny, all else reject.

### pgAudit (Compliant)

`pgaudit.log = 'ddl, role'` — logs DDL and role changes to Postgres log.
