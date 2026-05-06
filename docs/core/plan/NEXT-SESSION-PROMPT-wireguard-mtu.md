# NEXT SESSION — WireGuard MTU = 1280 default

## Goal

Set MTU = 1280 on every ProxyPilot-generated WireGuard config (server
and client side), and apply it to the live wg0 interface.

This is a small, focused change — should land in one commit.

## Why 1280

1280 is IPv6's minimum guaranteed MTU and it sails through every
common encapsulation overhead stack (PPPoE, double-NAT, mobile
carriers, Cloudflare Tunnel, Tailscale-over-WG, etc.) without
fragmentation. The IANA WG default of "let the kernel pick" results
in 1420 on most hosts, which fails on networks with non-standard
MTUs. We've already had operators hit this in the field. 1280 is
the safe-by-default value; operators with all-Ethernet paths can
override per-peer if they want the extra throughput.

## Scope

Three files, in priority order:

### 1. CLI peer-add path — emit `MTU = 1280` in generated configs

`cli/src/incus/...` (or wherever `proxypilot vpn peer add` renders
the client config). Currently the rendered `[Interface]` block is
something like:

```ini
[Interface]
PrivateKey = <key>
Address = 10.100.0.N/32
DNS = 1.1.1.1

[Peer]
PublicKey = <server-pubkey>
AllowedIPs = 10.100.0.0/24
Endpoint = <host>:<port>
PersistentKeepalive = 25
```

Add `MTU = 1280` to the `[Interface]` block (after `DNS`). Same
change in the QR-code rendering path and any "show config" output.

### 2. Server-side wg0.conf migration

`scripts/install-vpn.sh` and/or the install.sh / update.sh compose
patches: when wg0.conf already exists, add `MTU = 1280` under
`[Interface]` if missing. Idempotent — every other in-place patch
in update.sh follows this pattern (look at the cap_drop and
context-rewrite patches for the shape).

After patching, bounce the interface:
```
wg-quick down wg0
wg-quick up wg0
```

The server's WG identity (PrivateKey) doesn't change — peers stay
connected, just with smaller MTU on subsequent packets.

### 3. Allow operator override

Optional but worth the 5 minutes: support `PROXYPILOT_VPN_MTU` env
var (or a CLI flag on `peer add`) to override 1280. Default stays
1280.

## Tests

- Unit test: rendered config string contains `MTU = 1280` after a
  fresh peer-add.
- Idempotency: running update.sh twice doesn't double-add the
  `MTU =` line.
- Override: `PROXYPILOT_VPN_MTU=1500 proxypilot vpn peer add foo`
  emits `MTU = 1500`.

## Doc

- README mention of the new default in the VPN section.
- Add a Troubleshooting page entry: "Peer connects but throughput
  is poor / fragmented" → check that both ends agree on MTU.

## Out of scope

- Per-peer MTU override (one MTU per server is the simple path).
- IPv6 prefix-discovery / PMTUd. WG runs over UDP; PMTUd is a host-
  level concern.
