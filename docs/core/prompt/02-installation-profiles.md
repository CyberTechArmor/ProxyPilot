<!-- Split from proxypilot-core-infrastructure-prompt.md (lines 19-103) -->
<!-- Index: docs/core/prompt/README.md -->

## Installation Profiles

`proxypilot init` presents an interactive profile selection. Each profile is additive — higher profiles include everything from lower ones.

```
proxypilot init

Welcome to ProxyPilot.

Select installation profile:

  1. Standard
     Core services: Postgres, PgBouncer, Valkey, Infisical, Caddy, Incus.
     DNS-over-TLS. Basic audit logging. No additional hardening.

  2. Hardened
     Standard + CrowdSec (Caddy + SSH bouncers), WireGuard VPN for admin
     access, AIDE filesystem integrity monitoring, nftables bridge logging,
     SSH hardening with per-person access, unattended security updates,
     Incus network ACLs, host hardening baseline.

  3. Compliant (SOC 2 Type 2 + HIPAA)
     Hardened + full audit trail with Postgres sync, pgAudit, certificate
     history tracking, connection history logging, per-person SSH with
     quarterly access review enforcement, compliance checker with scheduled
     checks, documentation generator, data classification tagging, BAA
     tracker, enhanced encryption requirements, breach notification
     workflow template.

  4. Custom
     Choose individual components.
```

Non-interactive mode: `proxypilot init --profile standard|hardened|compliant`

### Component Matrix

| Component | Standard | Hardened | Compliant |
|---|---|---|---|
| PostgreSQL 16 + PgBouncer + Valkey | ✓ | ✓ | ✓ |
| Infisical (secrets management) | ✓ | ✓ | ✓ |
| Caddy (reverse proxy + TLS) | ✓ | ✓ | ✓ |
| Incus (LXC container runtime) | ✓ | ✓ | ✓ |
| pgBackRest (Postgres backup) | ✓ | ✓ | ✓ |
| Basic audit log (file only) | ✓ | ✓ | ✓ |
| SQLite state store | ✓ | ✓ | ✓ |
| DNS-over-TLS (systemd-resolved) | ✓ | ✓ | ✓ |
| CrowdSec (Caddy bouncer) | — | ✓ | ✓ |
| CrowdSec (SSH bouncer) | — | ✓ | ✓ |
| WireGuard VPN (admin access) | — | ✓ | ✓ |
| AIDE (filesystem integrity monitoring) | — | ✓ | ✓ |
| nftables bridge logging | — | ✓ | ✓ |
| SSH hardening + per-person access | — | ✓ | ✓ |
| Unattended security updates (host) | — | ✓ | ✓ |
| Incus network ACLs | — | ✓ | ✓ |
| Host hardening baseline (sysctl, disabled services) | — | ✓ | ✓ |
| Full audit trail (file + Postgres sync) | — | — | ✓ |
| pgAudit (DDL + role logging) | — | — | ✓ |
| Certificate history tracking | — | — | ✓ |
| Connection history logging (SSH + PgBouncer) | — | — | ✓ |
| Compliance checker | — | — | ✓ |
| Scheduled compliance checks (weekly) | — | — | ✓ |
| Documentation generator | — | — | ✓ |
| Quarterly access review enforcement | — | — | ✓ |
| Data classification tagging | — | — | ✓ |
| BAA tracker | — | — | ✓ |
| Breach notification workflow template | — | — | ✓ |

### Optional Components

These are offered as yes/no choices during `proxypilot init` regardless of profile. They are independent of the profile tier — a Standard install can enable observability, a Compliant install can skip it.

```
Optional components:
  Observability stack (Grafana + Loki + Alloy)?
  Provides dashboards, log search, and alerting for all
  ProxyPilot-managed services. [y/N]
```

Non-interactive: `proxypilot init --profile hardened --with-observability`

| Optional Component | What It Adds |
|---|---|
| Observability (Grafana + Loki + Alloy) | Log aggregation, dashboards, alerting for all ProxyPilot data |
