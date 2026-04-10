<!-- Split from proxypilot-core-infrastructure-prompt.md (lines 1027-1070) -->
<!-- Index: docs/core/prompt/README.md -->

## Bootstrap Sequence

```
proxypilot init
│
├─ 1. Profile selection
├─ 2. Preflight checks (all software for selected profile)
├─ 3. Generate bootstrap credentials → /root/.proxypilot-bootstrap.json (0600)
├─ 4. PostgreSQL (config, roles, databases, extensions)
├─ 5. PgBouncer (dual listener, userlist)
├─ 6. Valkey (localhost, requirepass)
├─ 7. Infisical (config, start, wait for health)
├─ 8. Credential rotation (→ Infisical → delete bootstrap file)
├─ 9. pgBackRest (stanza, initial backup, timers)
├─ 10. Caddy (verify admin API)
├─ 11. Incus (bridge, storage pool, default + hardened profiles)
├─ 12. DNS-over-TLS (write resolved.conf, restart systemd-resolved, verify)
├─ 13. nftables (proxypilot chain, default deny bridge → PgBouncer, UDP 51820 for WireGuard, logging for Hardened+)
├─ 14. SSH Hardening (Hardened+) — SAFE TRANSITION with test/confirm/test/confirm
├─ 15. WireGuard VPN (Hardened+) — key generation, config, enable, nftables rule, store key in Infisical
├─ 16. CrowdSec (Hardened+) — engine + Caddy bouncer + SSH bouncer
├─ 17. AIDE (Hardened+) — install, config, initialize database, daily timer
├─ 18. Host Hardening (Hardened+) — sysctl, unattended-upgrades, service disable
├─ 19. State initialization (SQLite, directories, audit log, logrotate, instance UUID)
├─ 20. Observability (if enabled) — Loki, Alloy, Grafana, dashboard provisioning, Caddy route (vpn-only or basic-auth)
├─ 21. Systemd timers (audit sync, health, compliance, patch, cleanup, session log, AIDE check)
└─ 22. Print summary
```

Idempotent: safe to rerun. Each step checks state before acting.

### Flags

```
--profile standard|hardened|compliant
--non-interactive
--dry-run
--skip-backup
--skip-infisical
--with-observability
--admin "<user>:<key>" (repeatable)
--config <path>
```
