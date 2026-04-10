<!-- Split from proxypilot-core-infrastructure-prompt.md (lines 322-327) -->
<!-- Index: docs/core/prompt/README.md -->

## PgBouncer Architecture

Dual listener: `127.0.0.1:6432` (host services) + `10.0.100.1:6432` (LXC containers). Transaction pooling, scram-sha-256, per-database pool sizes. Userlist rendered by Infisical Agent.

Per-container nftables rules gate PgBouncer access: `--db` flag enables, no flag means no access.
