<!-- Split from proxypilot-core-infrastructure-prompt.md (lines 9-18) -->
<!-- Index: docs/core/prompt/README.md -->

## Design Principles

1. **Single control plane**: ProxyPilot manages everything on the host. No separate tools, dashboards, or manual configuration for core services.
2. **Native core services**: Services that ProxyPilot depends on to function run natively on the host via systemd — not in containers. Core services must be available before any workload.
3. **Sensible defaults with operator override**: ProxyPilot sets secure, production-ready defaults for every configuration. The operator can tune anything. ProxyPilot never silently overrides operator changes.
4. **Audit everything**: Every mutation ProxyPilot makes is recorded in an append-only audit log file and asynchronously synced to Postgres for queryability.
5. **Secrets never touch disk in plaintext** (after bootstrap): All credentials are stored in Infisical. The only exception is the initial bootstrap sequence, where temporary credentials are generated, used to stand up Infisical, rotated into Infisical, and then deleted from disk.
6. **Safe transitions**: When hardening access (SSH, firewall rules), always verify the new access path works before closing the old one. Never lock the operator out of a remote machine.
7. **Compliance from live state**: Compliance checks and documentation are generated from actual system state, not static templates. Documents are always current because they reflect what is deployed.
