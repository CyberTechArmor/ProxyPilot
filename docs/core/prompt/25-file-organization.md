<!-- Split from proxypilot-core-infrastructure-prompt.md (lines 1346-1420) -->
<!-- Index: docs/core/prompt/README.md -->

## File Organization

```
src/
├── core/
│   ├── bootstrap.ts
│   ├── postgres.ts
│   ├── pgbouncer.ts
│   ├── valkey.ts
│   ├── infisical.ts
│   ├── pgbackrest.ts
│   ├── systemd.ts
│   ├── nftables.ts
│   ├── crowdsec.ts
│   ├── hardening.ts
│   ├── dns.ts                # DNS-over-TLS config
│   ├── wireguard.ts          # WireGuard setup, peer management, IP pool
│   ├── aide.ts               # AIDE init, check, baseline update
│   └── index.ts
├── observability/
│   ├── loki.ts               # Loki config generation
│   ├── alloy.ts           # Alloy config with auto-discovered log targets
│   ├── grafana.ts            # Grafana config, datasource/dashboard provisioning
│   ├── alerts.ts             # Grafana alert rule provisioning
│   ├── dashboard.json        # Default ProxyPilot dashboard
│   └── index.ts
├── access/
│   ├── ssh.ts
│   ├── users.ts
│   ├── sessions.ts
│   ├── review.ts
│   └── index.ts
├── audit/
│   ├── logger.ts
│   ├── sync.ts
│   └── index.ts
├── certs/
│   ├── tracker.ts
│   └── index.ts
├── compliance/
│   ├── checker.ts
│   ├── controls-soc2.ts
│   ├── controls-hipaa.ts
│   ├── docs-generator.ts
│   ├── templates/
│   ├── baa.ts
│   ├── classification.ts
│   └── index.ts
├── patch/
│   ├── executor.ts
│   ├── scheduler.ts
│   ├── checker.ts
│   ├── cleanup.ts
│   └── index.ts
├── db/
│   ├── management.ts
│   ├── connections.ts
│   ├── schema.ts
│   ├── queries.ts
│   └── index.ts
├── commands/
│   ├── init.ts
│   ├── core.ts
│   ├── db.ts
│   ├── access.ts
│   ├── audit.ts
│   ├── certs.ts
│   ├── security.ts           # proxypilot security (bans, alerts, aide)
│   ├── vpn.ts                # proxypilot vpn (add-peer, remove-peer, list, status)
│   ├── observability.ts      # proxypilot observability (status, logs, dashboard-url)
│   ├── compliance.ts
│   ├── patch.ts
│   └── ... (existing)
```
