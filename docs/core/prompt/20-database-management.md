<!-- Split from proxypilot-core-infrastructure-prompt.md (lines 999-1022) -->
<!-- Index: docs/core/prompt/README.md -->

## Database Management

### `proxypilot db create <n> [--container <c>] [--pool-size <n>] [--work-mem <v>] [--temp-file-limit <v>]`

1. Validate name
2. Generate role `<n>_app`, generate password (`crypto.randomBytes`)
3. Create role + database + grants + per-role settings in Postgres
4. Store password in Infisical
5. Add pool to PgBouncer, add to userlist, reload
6. If `--container`: nftables rule + container link + credential injection
7. Record in SQLite + audit log

### Other Commands

```
proxypilot db list                       # table with sizes from live Postgres
proxypilot db stats <n>                  # pg_stat_statements + pg_stat_activity
proxypilot db tune <n> [flags]           # ALTER ROLE + PgBouncer reload
proxypilot db drop <n> [--force]         # refuse if linked containers exist
proxypilot db credentials <n> [--show]   # retrieve from Infisical
proxypilot db connections [n] [--since]  # PgBouncer connection history
proxypilot db tag <n> --classification   # data classification
```
