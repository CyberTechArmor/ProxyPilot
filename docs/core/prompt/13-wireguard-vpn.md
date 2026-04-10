<!-- Split from proxypilot-core-infrastructure-prompt.md (lines 395-495) -->
<!-- Index: docs/core/prompt/README.md -->

## WireGuard VPN (Hardened/Compliant)

### Purpose

Provides encrypted tunnel for operator access to admin-only services (Infisical UI, Grafana, n8n, PgBouncer stats, any management interface) without exposing them to the public internet. Admin services are bound to the WireGuard interface or localhost — Caddy only routes them for requests arriving via the VPN.

This also serves as the foundation for multi-ProxyPilot federation networking in the future.

### Setup During Init

```
1. Generate server key pair
   - wg genkey → /etc/wireguard/server_private.key (mode 0600)
   - derive public key → stored in ProxyPilot state + printed for operator

2. Write /etc/wireguard/wg0.conf
   [Interface]
   Address = 10.100.0.1/24
   ListenPort = 51820
   PrivateKey = <server_private_key>
   PostUp = iptables -A FORWARD -i wg0 -j ACCEPT; iptables -t nat -A POSTROUTING -o $(ip route list default | awk '{print $5}') -j MASQUERADE
   PostDown = iptables -D FORWARD -i wg0 -j ACCEPT; iptables -t nat -D POSTROUTING -o $(ip route list default | awk '{print $5}') -j MASQUERADE

3. Add nftables rule: allow UDP 51820 inbound

4. Enable + start wg-quick@wg0

5. Verify: wg show reports interface up

6. Store server private key in Infisical (core/WIREGUARD_SERVER_KEY)

7. Print server public key + endpoint for operator to configure clients
```

**Important:** Debian 13 uses predictable network interface names (e.g., `enp3s0`, not `eth0`). The PostUp/PostDown commands use dynamic detection via `$(ip route list default | awk '{print $5}')` to find the default route interface. Never hardcode an interface name.

### Peer Management

```
proxypilot vpn add-peer <name> --public-key "<key>" [--allowed-ips "10.100.0.10/32"]
```
- Assigns next available IP from VPN CIDR (10.100.0.0/24, starting at .10)
- Adds `[Peer]` block to wg0.conf
- Applies live: `wg set wg0 peer <key> allowed-ips <ip>`
- Records in SQLite + audit log
- Prints client config snippet the operator can give to the peer

```
proxypilot vpn remove-peer <name> [--force]
```
- Removes `[Peer]` block from wg0.conf
- Applies live: `wg set wg0 peer <key> remove`
- Releases IP back to pool
- Records in SQLite + audit log

```
proxypilot vpn list
```
- Table: peer name, public key (truncated), allowed IPs, last handshake, transfer stats
- Pulls live data from `wg show wg0`

```
proxypilot vpn status
```
- Interface status, listening port, peer count, transfer stats

### Admin Service Routing

Services that should only be accessible via VPN are configured in Caddy with a bind or matcher that restricts to the WireGuard subnet:

- Infisical UI → `10.100.0.1:8080` or Caddy route with `remote_ip 10.100.0.0/24` matcher
- Grafana → same pattern
- n8n → same pattern (unless explicitly published to the internet)

ProxyPilot manages this via a route flag:

```
proxypilot route add infisical.admin.example.com --upstream 127.0.0.1:8080 --vpn-only
```

`--vpn-only` adds a Caddy matcher restricting the route to requests from `10.100.0.0/24`. The route is accessible from the VPN but returns 403 from the public internet.

### SQLite Schema

```sql
CREATE TABLE vpn_peers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  public_key TEXT NOT NULL UNIQUE,
  allowed_ips TEXT NOT NULL,
  endpoint TEXT,                    -- optional: for site-to-site
  created_at TEXT DEFAULT (datetime('now')),
  last_handshake_at TEXT,
  status TEXT DEFAULT 'active' CHECK (status IN ('active', 'revoked'))
);
```

### VPN IP Pool

ProxyPilot tracks VPN IP assignments in SQLite (similar to bridge IP allocation). Pool: `10.100.0.10` through `10.100.0.254`. Server is `10.100.0.1`. IPs released on peer removal.
