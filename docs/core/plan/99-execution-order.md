<!-- Split from proxypilot-core-phased-plan.md (lines 706-737) -->
<!-- Index: docs/core/plan/README.md -->

## Recommended Execution Order

Phases are ordered by dependency and value delivery:

```
Phase 1:  Foundation (everything depends on this)
Phase 2:  PostgreSQL + PgBouncer
Phase 3:  Valkey
Phase 4:  Infisical + Bootstrap
Phase 5:  pgBackRest
Phase 6:  DNS-over-TLS
          ─── At this point: core services running, secrets managed, backups active ───
Phase 7:  Audit Logging
Phase 8:  Database Management
          ─── At this point: proxypilot db create works, full workload lifecycle ───
Phase 9:  SSH Hardening
Phase 10: WireGuard VPN
Phase 11: CrowdSec
Phase 12: AIDE
Phase 13: Host Hardening
          ─── At this point: Hardened profile fully functional ───
Phase 14: Audit Sync + History
Phase 15: Patch Management
Phase 16: Compliance Checker
Phase 17: Documentation Generator
          ─── At this point: Compliant profile fully functional ───
Phase 18: Observability
Phase 19: Init Orchestrator
          ─── At this point: proxypilot init works end-to-end ───
```

Phases 6 can be done any time after Phase 1 (no dependencies). Phases 11-13 can be done in any order relative to each other. Phases 16-17 must be sequential (docs depend on checker). Phase 19 is last because it orchestrates everything.
