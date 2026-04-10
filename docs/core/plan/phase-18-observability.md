<!-- Split from proxypilot-core-phased-plan.md (lines 625-665) -->
<!-- Index: docs/core/plan/README.md -->

## Phase 18: Observability Stack

**Goal:** Optional Grafana + Loki + Alloy for dashboards, log search, and alerting.

**Files to create:**
```
src/observability/loki.ts        # Loki config generation
src/observability/alloy.ts       # Alloy config with auto-discovered log targets
src/observability/grafana.ts     # Grafana config, datasource/dashboard provisioning
src/observability/alerts.ts      # Grafana alert rule provisioning
src/observability/dashboard.json # Default ProxyPilot dashboard
src/observability/index.ts
src/commands/observability.ts    # CLI command definitions
```

**Deliverables:**
- Loki: config with tsdb_shipper, filesystem storage, profile-aware retention (30 days default, 365 days Compliant). Localhost only.
- Alloy: auto-configured to tail all ProxyPilot log sources (audit, Caddy, sshd, CrowdSec, PgBouncer, PostgreSQL, nftables, AIDE, Infisical) with structured labels.
- Grafana: config, Loki datasource provisioning, default dashboard (6 panels: overview, security, access, traffic, audit, database), alert rules (10 pre-configured alerts).
- Caddy route for Grafana: `--vpn-only` if WireGuard enabled, `--middleware basic-auth` otherwise. Never exposed without access control.
- Grafana admin password in Infisical.
- `proxypilot observability status/logs/dashboard-url` commands.
- All services managed via systemd. All commands gracefully handle "not installed" state.

**Spec references:** "Observability Stack" section (all subsections), Loki config, Alloy label strategy, Grafana dashboard panels, alert rules table.

**Verification:**
- [ ] Loki starts, ready endpoint returns 200
- [ ] Alloy starts, all targets showing active
- [ ] Grafana starts, health endpoint returns ok
- [ ] Grafana accessible via VPN (or basic auth) — not publicly
- [ ] Default dashboard renders with real data
- [ ] `proxypilot observability logs --job caddy_access --since 1h` returns results
- [ ] Alert rules present in Grafana
- [ ] `proxypilot observability status` shows all three services
- [ ] Without observability installed: `proxypilot observability status` prints install suggestion, does not error

**Commit:** `phase-18: observability - grafana, loki, alloy dashboards and alerting`

---

## Function-by-Function Checklist (to be populated)

> This section is a placeholder. The next planning session will decompose the phase deliverables into a per-function checklist: one function → implement → test → check off → move on. Each function gets its own line with a checkbox, the file it lives in, and a one-line success criterion. Do not populate this now — leave the placeholder in place.

- [ ] _pending_
