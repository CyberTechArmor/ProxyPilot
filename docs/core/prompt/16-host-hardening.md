<!-- Split from proxypilot-core-infrastructure-prompt.md (lines 871-874) -->
<!-- Index: docs/core/prompt/README.md -->

## Host Hardening (Hardened/Compliant)

sysctl (disable redirects, log martians, ASLR, etc.), unattended security updates, disable unnecessary services, Incus network ACLs (default deny ingress except via Caddy, default deny egress to host except allowed PgBouncer).
