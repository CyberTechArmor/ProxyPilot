<!-- Split from proxypilot-core-phased-plan.md (lines 706-737), updated for 21-phase plan -->
<!-- Index: docs/core/plan/README.md -->

## Recommended Execution Order

Phases are ordered by dependency and value delivery. Phases 1 and 2 come
first because the operator asked for them — they unblock mobile use of
the dashboard and multi-service-per-domain routing, and they have no
core-infrastructure dependencies.

```
Phase 1:  Mobile-Friendly Admin Dashboard
          ─── At this point: the dashboard is usable on phones and tablets ───
Phase 2:  Multi-Service Path-Prefix Routing
          ─── At this point: multiple services can share a domain on different paths ───
Phase 3:  Foundation (everything else depends on this)
Phase 4:  PostgreSQL + PgBouncer
Phase 5:  Valkey
Phase 6:  Infisical + Bootstrap
Phase 7:  pgBackRest
Phase 8:  DNS-over-TLS
          ─── At this point: core services running, secrets managed, backups active ───
Phase 9:  Audit Logging
Phase 10: Database Management
          ─── At this point: proxypilot db create works, full workload lifecycle ───
Phase 11: SSH Hardening
Phase 12: WireGuard VPN
Phase 13: CrowdSec
Phase 14: AIDE
Phase 15: Host Hardening
          ─── At this point: Hardened profile fully functional ───
Phase 16: Audit Sync + History
Phase 17: Patch Management
Phase 18: Compliance Checker
Phase 19: Documentation Generator
          ─── At this point: Compliant profile fully functional ───
Phase 20: Observability
Phase 21: Init Orchestrator
          ─── At this point: proxypilot init works end-to-end ───
```

Phase 8 can be done any time after Phase 3 (no dependencies beyond the
foundation). Phases 13-15 can be done in any order relative to each
other. Phases 18-19 must be sequential (docs depend on checker). Phase 21
is last because it orchestrates everything. Phases 1 and 2 can be
done independently of every other phase — they only touch the admin
dashboard and the Caddy generator.
