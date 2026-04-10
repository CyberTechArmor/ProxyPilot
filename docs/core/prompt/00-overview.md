<!-- Split from proxypilot-core-infrastructure-prompt.md (lines 1-8) -->
<!-- Index: docs/core/prompt/README.md -->

# ProxyPilot Core Infrastructure Upgrade — Implementation Prompt

## Project Context

ProxyPilot is an infrastructure management CLI tool that manages reverse proxy routes (Caddy), static site hosting, Docker containers, and LXC containers (Incus) from a single CLI. The Caddy migration and LXC/Incus integration are complete.

This upgrade adds the **core infrastructure layer** — the native services, security hardening, compliance automation, and operational tooling that every ProxyPilot host needs to operate as a secure, auditable, secrets-managed platform. After this upgrade, `proxypilot init` bootstraps a complete infrastructure host from a fresh Debian installation — including SSH hardening, secrets management, database services, security tooling, audit logging, and compliance documentation — and `proxypilot lxc create --db myapp_db` creates a container with its own database, credentials in a secrets manager, TLS route, and firewall rules in one command.
