# Dependency & Security Review — 2026-07-17

Full dependency audit across all runtimes in the monorepo. **Result: 12 known
vulnerabilities fixed (4 high, 8 moderate); all three npm trees now report 0
vulnerabilities. No breaking changes** — verified by the backend test suite
(889 tests, 0 failures), a frontend production build, and CLI smoke tests.

## Scope

| Component | Manifest | Before | After |
|---|---|---|---|
| `admin/backend` | package.json | 9 vulns (3 high, 6 moderate) + nodemailer advisories surfaced on re-audit | **0 vulns** |
| `admin/frontend` | package.json | 3 vulns (1 high, 2 moderate) | **0 vulns** |
| `cli` | package.json | 0 vulns | **0 vulns** |
| `cmd/agent` (Go) | go.mod | zero third-party dependencies (stdlib only) | n/a |
| `proxypilot/engine` (Python) | none | stdlib + system `ruamel.yaml` / `pytest`; no pinned manifest to audit | n/a |

## Vulnerabilities fixed

### Backend (`admin/backend`)

| Package | From → To | Severity | Advisories |
|---|---|---|---|
| `ws` | 8.20.0 → 8.21.1 | **High** | GHSA-58qx-3vcg-4xpx (uninitialized memory disclosure), GHSA-96hv-2xvq-fx4p (memory-exhaustion DoS). Used by the terminal WebSocket server. |
| `nodemailer` | 6.10.1 → 9.0.3 | **High** | 8 advisories incl. GHSA-c7w3-x93f-qmm8 / GHSA-vvjj-xcjg-gr5g (SMTP command injection), GHSA-mm7p-fcc7-pg87 (mail routed to unintended domain), GHSA-p6gq-j5cr-w38f (file read / SSRF via `raw`), GHSA-r7g4-qg5f-qqm2 (TLS validation in OAuth2 fetch). |
| `qs` (via `express`/`body-parser`) | express 4.22.1 → 4.22.2, qs → 6.15.3 | Moderate | GHSA-q8mj-m7cp-5q26 (remotely triggerable `qs.stringify` DoS). |
| `uuid` (transitive, under `ldapts` and `node-cron`) | 11.1.0 / 8.3.2 → 11.1.1 | Moderate | GHSA-w5hq-g745-h8pq (buffer bounds in v3/v5/v6). Fixed via scoped `overrides` in package.json rather than the breaking `node-cron@4` / `ldapts@9` majors npm suggested. |

Non-security in-range updates: `@aws-sdk/client-s3` + `lib-storage`
3.1087.0 → 3.1089.0, `@simplewebauthn/server` 13.3.0 → 13.3.2, `multer`
2.1.1 → 2.2.0, `otpauth` 9.5.0 → 9.5.1, `uuid` (direct) 14.0.0 → 14.0.1.

**Why the nodemailer 6→9 major is safe here:** the only call sites
(`src/lib/notification-dispatch.js`) use `createTransport({host, port, secure,
auth, …timeouts})` + `sendMail({from, to, subject, text})` — an API surface
unchanged across 6→9. nodemailer 9 declares `engines: node >=6`. The import is
lazy with a clean error path, and several of the fixed advisories (SMTP command
injection via config, CRLF header injection) matter specifically because SMTP
channel settings are admin-supplied.

**Why `overrides` instead of `node-cron@4` / `ldapts@9`:** both packages call
only `uuid.v4()`; the advisory affects v3/v5/v6 buffer handling. Forcing the
nested `uuid` to ≥11.1.1 clears the advisory with zero API change, whereas the
majors have real breaking changes (node-cron 4 reworked the scheduling API).

### Frontend (`admin/frontend`)

| Package | From → To | Severity | Advisories |
|---|---|---|---|
| `vite` | 6.4.2 → 6.4.3 | **High** | GHSA-v6wh-96g9-6wx3 (launch-editor NTLMv2 hash disclosure), GHSA-fx2h-pf6j-xcff (`server.fs.deny` bypass) — both Windows-dev-server scoped; dev-only exposure. |
| `react-router-dom` / `react-router` | 6.30.3 → 6.30.4 | Moderate | GHSA-2j2x-hqr9-3h42 (open redirect via protocol-relative `//` path). |

Plus in-range updates to Radix UI packages, CodeMirror language packages,
`@uiw/react-codemirror`, `postcss` 8.5.19, `autoprefixer` 10.5.4.

### CLI (`cli`)

No vulnerabilities before or after. `yaml` 2.8.3 → 2.9.0 (in-range).

## Deliberately NOT updated (breaking majors, no security need)

These have newer majors but are semver-breaking and carry no open advisories at
their current versions. Listed for future planning, oldest-gap first:

- **Backend:** `express` 5.x, `zod` 4.x, `helmet` 8.x, `better-sqlite3` 12.x,
  `ldapts` 9.x, `node-cron` 4.x, `dotenv` 17.x, `express-rate-limit` 8.x,
  `argon2` 0.44, `bcryptjs` 3.x
- **Frontend:** `react`/`react-dom` 19, `react-router-dom` 7, `vite` 8,
  `tailwindcss` 4, `tailwind-merge` 3, `lucide-react` 1.x,
  `@vitejs/plugin-react-swc` 4
- **CLI:** `commander` 15.x, `better-sqlite3` 12.x

`better-sqlite3` is pinned at 9.x in both backend and CLI; a coordinated bump
(with a DB-file compatibility check) would be the highest-value future upgrade.

## Verification (no breaking changes)

- **Backend tests:** `npm test` — 889 tests, **882 pass, 0 fail**, 7 skipped
  (includes the notification/webauthn/cves suites).
- **Frontend:** `npm run build` — production build succeeds (vite 6.4.3,
  1875 modules; only the pre-existing dynamic-import chunk warning).
- **CLI:** `node bin/proxypilot.js --help` runs clean.
- **nodemailer 9 smoke test:** `createTransport`/`sendMail` API confirmed
  present with the exact options object used in `notification-dispatch.js`.

## Non-npm surfaces reviewed

- **Go agent (`cmd/agent`):** `go.mod` declares no dependencies — nothing to
  audit or update.
- **Python engine (`proxypilot/engine`):** imports are stdlib plus
  `ruamel.yaml` (runtime) and `pytest` (tests), installed at the system level
  by the operator scripts; there is no `requirements.txt`/lockfile in-repo to
  pin or audit. Consider adding one if supply-chain pinning is wanted here.
