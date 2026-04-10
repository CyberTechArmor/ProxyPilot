<!-- Split from proxypilot-core-infrastructure-prompt.md (lines 332-335) -->
<!-- Index: docs/core/prompt/README.md -->

## Infisical

Project structure: core (service passwords), databases (workload credentials), workloads (operator-defined). Agent templates render PgBouncer userlist and Valkey config. Container secrets injected via ProxyPilot-mediated tmpfs (containers never access Infisical directly).
