# Route verification baseline — 2026-09-04

Captured live via the ProxyPilot MCP endpoint (`test_route`, read-only) BEFORE
any of this branch's code is deployed. The host is running the pre-fix code, so
these are the numbers to diff against after deployment.

Every route must still serve the same status after the change.

| Hostname | Path | Edge | Upstream probed | Upstream result | Note |
|---|---|---|---|---|---|
| git.fractionate.ai | / | **303** → /user/login | 10.185.17.224:3000 | 303 | recovered route from the incident |
| mock2.fractionate.ai | / | **200** (nginx/1.22.1) | 10.185.17.224:80 | 200 | recovered route from the incident |
| unlimited.lighting | / | **200** (nginx/1.22.1) | 10.185.17.22:80 | 200 | do not touch |
| docview.fractionate.ai | / | **200** | 10.185.17.190:8080 | 200 | |
| meet.fractionate.ai | / | **200** (nginx/1.29.8) | 10.185.17.131:3000 | 200 | |
| meet.fractionate.ai | /api | **404** | 10.185.17.131:3000 | 200 | see note 4 |
| rd.fractionate.ai | / | **200** (nginx/1.31.4) | 10.185.17.14:8080 | 200 | |
| scan.fractionate.ai | / | **200** (Caddy) | — | — | static site |
| privacy-policy.recapshare.com | / | **200** (Caddy) | — | — | static site |
| Freshcut.fractionate.ai | / | **200** (Caddy) | — | — | see note 3 |
| starter.fractionate.ai | / | **502** | 10.185.17.170:3000 | refused | see note 2 |
| mail.techmations.com | / | **TLS handshake failed** | 10.185.17.145:80 | 200 | see note 1 — do not touch |

## Pre-existing conditions found while capturing the baseline

None of these were caused by this branch — its code is not deployed. They are
recorded so the post-deploy diff is not misread.

**1. `mail.techmations.com` is not served by this edge.**
The TLS handshake fails, `get_route` reports `certificate: null` (no cert on
disk), and the access log shows 0 requests in the last hour. Its public DNS
resolves to `2600:3c02::f03c:93ff:fe1b:1ffb` — a different host entirely, while
every other hostname here resolves to `96.88.158.118`. The mail server is
evidently served from its own public interface, and ProxyPilot carries a route
record for it that this edge does not fulfil.

This corrects the severity framing in the Stage 2 report. The code defect at
`lxc.js:3826` was real — deleting the RustDesk guest would have unlinked
`/etc/caddy/sites/mail.techmations.com` on a prefix collision and orphaned its
row — but calling that "taking down the production mail server" overstated it:
this edge is not currently serving that hostname, so the practical blast radius
was a destroyed config file and an orphaned row, not a mail outage. The fix is
unchanged; only the impact statement needed correcting.

**2. `starter.fractionate.ai` returns 502.**
`cpr-starter` is at `10.185.17.170`, which is exactly what the route says, so
this is **not** drift — the binding is correct and nothing is listening on
:3000 inside the guest. An application-down case, unrelated to this work.

**3. `Freshcut.fractionate.ai` is stored with a capital F.**
`test_route` reports `routed: false` because it lowercases the hostname before
matching, yet the site serves 200. Cosmetic mismatch between the route record's
casing and the lookup; worth normalising separately, out of scope here.

**4. `meet.fractionate.ai/api` returns 404 at the edge.**
The `/api` route points at :8080 while `test_route` probes the root route's
upstream (:3000), so the two columns are not comparable for this row. A bare
`/api` 404 from the API service is plausible; recorded as-is for the diff.

## Restore commands

Run on the host before deploying (from the Stage 2 report, repeated here):

```bash
sudo tar czf /var/lib/proxypilot/backups/caddy-config-$(date +%Y%m%d-%H%M%S).tar.gz -C /etc caddy
sudo sqlite3 /opt/proxypilot/data/db/proxypilot.db \
  ".backup '/var/lib/proxypilot/backups/proxypilot-$(date +%Y%m%d-%H%M%S).db'"

# Restore Caddy
sudo tar xzf /var/lib/proxypilot/backups/caddy-config-<STAMP>.tar.gz -C /etc
sudo caddy validate --config /etc/caddy/Caddyfile \
  && sudo caddy reload --config /etc/caddy/Caddyfile --force

# Restore the route table (stop the backend first)
sudo systemctl stop proxypilot-admin
sudo cp /var/lib/proxypilot/backups/proxypilot-<STAMP>.db /opt/proxypilot/data/db/proxypilot.db
sudo systemctl start proxypilot-admin
```

Migration 106 (`service_http_routes.health_path`) is additive and idempotent.
Rolling the code back without rolling back the database is safe — the extra
column is simply unread by the old code.
