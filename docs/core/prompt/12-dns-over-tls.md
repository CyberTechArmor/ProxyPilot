<!-- Split from proxypilot-core-infrastructure-prompt.md (lines 377-394) -->
<!-- Index: docs/core/prompt/README.md -->

## DNS-over-TLS (All Profiles)

Configured during init for every profile. No downside to encrypted DNS — it should be default on every infrastructure host.

ProxyPilot writes `/etc/systemd/resolved.conf`:

```ini
[Resolve]
DNS=1.1.1.1#cloudflare-dns.com 9.9.9.9#dns.quad9.net
FallbackDNS=8.8.8.8#dns.google
DNSSEC=yes
DNSOverTLS=yes
```

Then restarts `systemd-resolved` and verifies with `resolvectl status` (checks for `DNSOverTLS: yes` in output).

No ongoing management needed. No CLI commands. If the operator wants custom DNS servers, they edit `resolved.conf` directly — ProxyPilot does not overwrite operator changes on subsequent `init` runs (checks if already configured).
