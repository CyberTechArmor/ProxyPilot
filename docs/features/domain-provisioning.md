# Domain provisioning — the "Add Domain" page

An **admin-gated** dashboard page at **`/add-domain`** provisions a domain
on the Caddy reverse proxy with an automatic Let's Encrypt certificate:
fill a short form, ProxyPilot writes the Caddy config, reloads Caddy, and
the certificate is issued and **renewed automatically forever** — no cron,
no scripts, no further action. The page requires an administrator session;
the same `/api/domains/provision/*` endpoints also accept a provisioning
API key (`X-API-Key`) for scripted/API clients.

## The two credentials (never conflated)

| | ProxyPilot access API key | Cloudflare API token |
|---|---|---|
| Purpose | Authorizes scripted/API provisioning requests (the page itself uses the admin session) | Lets Caddy write `_acme-challenge` TXT records for DNS-01 |
| Needed for | **Both** certificate methods | DNS-01 only |
| Sent as | `X-API-Key` header on every provisioning request | Never sent by the browser after submit |
| Storage | sha256 hash only (`provision_api_keys`); raw key shown once at creation | AES-256-GCM in the DB (`TOTP_ENCRYPTION_KEY`) + a `0640 root:caddy` file under `/etc/caddy/pp-secrets/` that Caddy reads |
| Exposure | Masked in UI; never logged | Never returned to any client, never logged, `{file.…}` placeholder instead of inline config |

Admins manage keys, the DNS-01 domain list, and provisioned records on the
dashboard's **Domains** page (`/domains`). Keys are scoped
`domains:provision` — they authorize nothing else.

## Certificate methods

1. **Standard Let's Encrypt (default)** — Caddy's built-in HTTP-01 /
   TLS-ALPN. Needs the domain's DNS pointing at this server and ports
   80/443 reachable **from all of Let's Encrypt's validation regions** (a
   geo-block breaks it — that's what the DNS-01 list is for). No plugin,
   no token.
2. **Let's Encrypt via Cloudflare DNS-01 (opt-in)** — for wildcards and
   geo-blocked/firewalled domains. DNS validation makes **no inbound HTTP
   request** to the origin. Requires:
   * Caddy built with the Cloudflare provider — install it with one click
     on the Domains page (Cloudflare connection → **Install plugin**; runs
     `caddy add-package github.com/caddy-dns/cloudflare` on the host and
     restarts Caddy). A marker file
     (`/var/lib/proxypilot/caddy-cloudflare-plugin.enabled`) makes
     `update.sh` RE-install the plugin automatically after caddy package
     upgrades, which replace the binary and drop add-on packages; site
     files using `dns cloudflare` also trigger the re-install (covers a
     restore onto a fresh host).
   * A Cloudflare token scoped **Zone → DNS → Edit** + **Zone → Zone →
     Read** for the relevant zone(s). Save the global token on the Domains
     page (Cloudflare connection card — stored encrypted, write-only); the
     `CLOUDFLARE_API_TOKEN` env var remains as a fallback. A per-domain
     token on the Add Domain form overrides both (for zones in other
     accounts).

### Method selection (resolved per submission, in this order)

1. **Wildcard toggle on → DNS-01**, always (wildcards only issue via DNS
   validation). Rejected with a clear message if no token is available.
2. **Explicit choice** on the form (Standard / DNS-01).
3. **DNS-01 domain list** (Domains page): exact entries
   (`internal.example.com`) or suffix patterns (`*.example.com`, matches
   subdomains — list the apex separately if it needs DNS-01 too).
4. **Default: standard Let's Encrypt.**

The form shows the resolved method live before submit, and the result
screen states which path ran.

## What a submit does

validate key → validate inputs → resolve method → conflict checks (already
provisioned, Services-managed, existing site file → 409) → *(DNS-01)*
effective token + plugin check → insert DB record → *(DNS-01)* write token
file → write `/etc/caddy/sites/pp-provision_<domain>` → `caddy adapt`
(validate) → `caddy reload` (graceful) → poll issuance status.

Any failure **rolls back every side effect** (site file, token file, DB
row) — a failed provision leaves nothing behind. The status endpoint
watches Caddy's cert storage and, when issuance stalls, classifies the
failure from the Caddy journal into an actionable message (rate limit,
bad/insufficient token scope, wrong zone, port 80 unreachable/geo-block,
CAA).

Generated site blocks (inputs are regex-validated, which doubles as the
config-injection guard):

```
example.com {                        # standard
    tls acme-email@example.com
    reverse_proxy localhost:8080
}

example.com, *.example.com {         # DNS-01 + wildcard
    tls acme-email@example.com {
        dns cloudflare {file./etc/caddy/pp-secrets/cf_example.com.token}
    }
    reverse_proxy localhost:8080
}
```

The `{file.…}` placeholder keeps the token out of the Caddyfile; the file
persists on the host, so renewals (which re-run the challenge months
later) keep working across Caddy and ProxyPilot restarts with no manual
step. Certs + the ACME account live in Caddy's data dir
(`/var/lib/caddy/.local/share/caddy`) on the host — persistent by
construction on a standard install, which also protects against
re-issuance rate limits after restarts.

## Notes

* Design deviation from the original spec: config is applied as a site
  file + graceful `caddy reload` (this repo's architecture — the backend
  owns `/etc/caddy/sites`), not the admin API `POST /load`. `caddy
  reload` is zero-downtime.
* Deprovisioning (Domains page) removes the site file, token file, and
  record, then reloads; the issued cert stays cached in Caddy's storage
  so re-adding the domain doesn't burn a rate-limited re-issue.
* `/api/domains/provision/*` is dual-auth: an admin cookie session (full
  CSRF protection) or an `X-API-Key` provisioning key. The CSRF exemption
  applies ONLY when the key header is present (no ambient cookies — the
  key is the binding token, same rationale as the mock2 git endpoints).
  `/api/domains/admin/*` uses cookie sessions, admin role, sudo for
  mutations, and full CSRF.
