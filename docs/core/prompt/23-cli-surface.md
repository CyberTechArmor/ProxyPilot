<!-- Split from proxypilot-core-infrastructure-prompt.md (lines 1071-1149) -->
<!-- Index: docs/core/prompt/README.md -->

## Complete CLI Surface

### Core

```
proxypilot core status
proxypilot core restart <service>
proxypilot core logs <service>
proxypilot core backup verify [--restore-test]
```

### Database

```
proxypilot db create|list|stats|tune|drop|credentials|connections|tag
```

### Access

```
proxypilot access add|remove|list|history|review
```

### Certificates

```
proxypilot certs list|history|expiring
```

### Audit

```
proxypilot audit log|sync|stats
```

### Security (Hardened+)

```
proxypilot security bans|alerts
proxypilot security aide-check
proxypilot security aide-update [--reason "<description>"]
proxypilot security aide-status
```

### VPN (Hardened+)

```
proxypilot vpn add-peer <n> --public-key "<key>" [--allowed-ips "<cidr>"]
proxypilot vpn remove-peer <n> [--force]
proxypilot vpn list
proxypilot vpn status
```

### Observability (Optional)

```
proxypilot observability status
proxypilot observability logs [--job <job>] [--since <duration>] [--query <logql>]
proxypilot observability dashboard-url
```

### Compliance (Compliant)

```
proxypilot compliance check|history|docs|baa
```

### Patch

```
proxypilot lxc patch|patch-all|outdated|patch-schedule
```

### Init

```
proxypilot init [--profile] [--non-interactive] [--dry-run] [--skip-backup] [--skip-infisical] [--with-observability] [--admin] [--config]
```
