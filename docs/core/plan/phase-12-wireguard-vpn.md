<!-- Split from proxypilot-core-phased-plan.md (lines 339-374) -->
<!-- Index: docs/core/plan/README.md -->

> **⚠ Superseded (2026-04-30):** This phase as originally written
> (paste-the-public-key peer flow, `iptables`-based NAT in PostUp/
> PostDown, `proxypilot vpn add-peer/remove-peer/list/status`) is
> **replaced** by the VPN Manager upgrade. See
> `proxypilot-firewall-vpn-ssh-prompt.md` (`## VPN Manager`) for the
> new design: ProxyPilot generates peer keypairs (no operator paste),
> renders QR codes + ready-to-import configs, supports
> enable/disable/rotate without losing peer records, and enforces
> per-peer scope via firewall rules. NAT and forwarding are emitted by
> the firewall manager (`nat_postrouting` chain in the
> `inet/proxypilot` table), not by `iptables`. This work happens in
> steps 5–7 of that upgrade and depends on the firewall manager
> (steps 1–4) being live first.

## Phase 12: WireGuard VPN

**Goal:** Admin VPN access with peer management.

**Files to create:**
```
src/core/wireguard.ts        # Key generation, config, peer management, IP pool
src/commands/vpn.ts          # CLI command definitions
```

**Deliverables:**
- Server key generation, wg0.conf with dynamic interface detection (never hardcode interface name).
- nftables rule for UDP 51820.
- Store server key in Infisical.
- `proxypilot vpn add-peer/remove-peer/list/status`.
- VPN IP pool allocation (10.100.0.10-254) tracked in SQLite.
- Route `--vpn-only` flag: adds Caddy matcher restricting to 10.100.0.0/24.
- All commands write audit log entries.

**Spec references:** "WireGuard VPN" section, vpn_peers schema, PostUp/PostDown with dynamic interface detection.

**Verification:**
- [ ] WireGuard interface up, `wg show` reports listening
- [ ] Server key stored in Infisical
- [ ] `proxypilot vpn add-peer` adds peer, assigns IP, updates wg0.conf
- [ ] Client can connect and reach 10.100.0.1
- [ ] `proxypilot route add x --vpn-only` restricts route to VPN subnet
- [ ] Route returns 403 from public internet, 200 from VPN
- [ ] `proxypilot vpn remove-peer` removes peer, releases IP
- [ ] `proxypilot vpn list` shows peers with live handshake data
- [ ] All operations produce audit log entries

**Commit:** `phase-12: wireguard-vpn - admin access with peer management`

---

## Function-by-Function Checklist (to be populated)

> This section is a placeholder. The next planning session will decompose the phase deliverables into a per-function checklist: one function → implement → test → check off → move on. Each function gets its own line with a checkbox, the file it lives in, and a one-line success criterion. Do not populate this now — leave the placeholder in place.

- [ ] _pending_
