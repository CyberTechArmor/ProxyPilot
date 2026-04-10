<!-- Split from proxypilot-core-infrastructure-prompt.md (lines 1439-1453) -->
<!-- Index: docs/core/prompt/README.md -->

## Implementation Constraints

1. Systemd units: template strings, `/etc/systemd/system/`, `daemon-reload`.
2. PgBouncer reload: `RELOAD` via admin console, not restart.
3. Infisical: REST API, not CLI for programmatic ops.
4. Audit writes synchronous: command fails if audit write fails.
5. All Postgres through PgBouncer (except initial bootstrap).
6. nftables persistent: config file + live commands.
7. SSH safe transition: never disable without verified alternative. Reload, not restart.
8. Credentials: `crypto.randomBytes`, never `Math.random()`.
9. Doc generation: Markdown source, Pandoc for PDF/DOCX. Print install instructions if missing.
10. Profile-aware: Standard commands never fail due to missing Compliant components.
11. Idempotent init: every step checks state first.
12. Observability-aware: If observability is not enabled, all `proxypilot observability` commands print "Observability stack not installed. Run `proxypilot init --with-observability`." and exit cleanly. All other commands work identically with or without observability.
