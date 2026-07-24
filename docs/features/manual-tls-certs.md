# Manual (pasted) TLS certificates

Serve domains with an **admin-supplied certificate** instead of issuing via
Let's Encrypt/ACME. Purpose: some networks block outbound access to ACME
endpoints, which breaks automatic HTTPS. A pasted cert (a Cloudflare Origin CA,
a wildcard, or any PEM cert + key) removes that dependency.

This is an **added mode** — the automatic ACME path is unchanged and remains the
default.

## The one hard rule

For every hostname a pasted cert covers, Caddy must serve **that** cert and must
**not** attempt ACME. ProxyPilot drives Caddy via a **Caddyfile** (not the admin
JSON API), so the mechanism is a single per-site directive:

```
example.com {
    tls /etc/caddy/pp-manual-certs/cert-1.pem /etc/caddy/pp-manual-certs/cert-1.key
    ...
}
```

`tls <cert> <key>` both loads the pasted cert **and** disables automatic HTTPS
(ACME) for that site. One resolver decides, per hostname, which managed cert (if
any) covers it; every site builder emits the directive when it does.

## Architecture

```
paste (UI / API)
  └─ validate (lib/tls-certs)          well-formed PEM, key matches cert, passphrase
  └─ store   (lib/tls-cert-store)      key encrypted at rest; files 0600 caddy
  └─ resolve (resolveCertForHost)      host → cert, most-specific wins
  └─ emit    (3 site builders)         tls <cert> <key>  → serve + skip ACME
  └─ apply   (caddy adapt → reload)    validate-then-reload, rollback on failure
```

- **`lib/tls-certs.js`** — pure + Node-crypto only (fully unit-tested):
  `parseCertificate` (CN + DNS SANs incl. wildcards, validity, SHA-256
  fingerprint), `validateCertKeyPair` (`X509Certificate.checkPrivateKey`,
  passphrase decrypt, specific error codes), `resolveCertForHost`
  (most-specific-wins: exact beats single-label wildcard; deterministic
  tie-break), `manualTlsDirective`, `assembleServedChain`, `expiryStatus`.
- **`lib/tls-cert-store.js`** — DB CRUD, key encrypt/decrypt (`lib/secrets`,
  AES-256-GCM), 0600 key files written over stdin to a dedicated dir
  (`CADDY_MANUAL_CERT_DIR`, default `/etc/caddy/pp-manual-certs`), and
  `resolveTlsForHost` — the single decision each builder consults.
- **`routes/tls-certs.js`** — `/api/tls-certs`, admin-only (sudo on mutations).
- **Builder hooks** — `routes/services.js` `buildDomainCaddyConfig`,
  `routes/lxc.js` (inline), `mock2/caddy.js` `buildMock2SiteBlock`. The decision
  is resolved by the reconciler and passed in, so the builders stay DB-free.

## Coverage across subsystems (one resolver, thin hooks)

A cert automatically covers **Services**, **LXC containers**, and **Projects**
whose hostname it matches — no per-service config. A **wildcard** cert
(`*.example.com`) covers all current and future subdomains, including a new
Project on a covered subdomain, which previously could not get real TLS (wildcard
domains were downgraded to plain HTTP). Provisioned self-service domains keep
their own cert method.

## Global TLS mode

`app_settings.tls_mode` ∈ `{acme, manual}` (seeded from `TLS_MODE` in `.env` on
first boot; toggled on the TLS Certificates page):

- **acme** (default) — covered hosts serve their pasted cert; uncovered hosts use
  ACME (unchanged).
- **manual** — covered hosts serve their pasted cert; uncovered hosts use Caddy's
  **internal** self-signed cert instead of a failing ACME attempt. This is the
  install-time signal that ACME is blocked.

## Security (cid-security)

- Private keys **encrypted at rest** (AES-256-GCM); decrypted only server-side at
  apply time; written 0600 owned by the caddy user; **never** returned to any
  client (list/detail are metadata + public cert PEM only) and **never** logged
  (`redactKeyMaterial` masks any PEM that reaches an error).
- Endpoints **admin-only**; sudo on mutations; Zod-validated input.
- File paths derived from the integer row id only — **no traversal surface**.
- **Validate → apply → rollback**: every change runs `caddy adapt` before
  `caddy reload`; on rejection the previous cert/row/mode is restored and
  re-applied, so a bad paste can never take the proxy down. Caddy also keeps its
  last-good running config if a reload fails.
- Every create/rotate/delete and mode change is `logAudit`-ed.

## Expiry monitoring

Pasted certs do **not** auto-renew. `lib/cert-expiry-scheduler.js` runs daily
(03:15, plus once at boot), flags certs within the warning window
(`PROXYPILOT_CERT_EXPIRY_WARN_DAYS`, default 21) via a deduped notification, and
auto-resolves it on rotation. The UI shows valid / expiring-soon / expired
badges with day counts.

## Migration (Cloudflare / DNS-01 retained)

The existing Domain Provisioning page and its **Cloudflare DNS-01** credentials
are a live ACME path and are **retained** — this feature adds a separate TLS
Certificates section rather than removing them. Existing ACME domains keep
working; any domain not covered by a pasted cert follows the global mode.

## Data model

Migration **800** — `tls_certificates` (`label`, `cert_pem`, `chain_pem`,
`key_pem_enc`, `covered_names` JSON, `fingerprint`, `not_before`, `not_after`,
`created_by`). Global `tls_mode` in `app_settings`.

## What needs a live deployment to verify

The correctness core (parse / match / resolver / `tls`-emission / expiry) is
unit-tested (`__tests__/tls-certs.test.js`, `mock2-domains.test.js`). Serving
real HTTPS from a pasted cert, the fresh-install flow, and the atomic
Caddy-reload rollback require a running Caddy + real certs and are verified on a
live install.
