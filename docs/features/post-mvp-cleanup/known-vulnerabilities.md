<!-- Audit residuals from the post-MVP package security audit -->
<!-- Last reviewed: 2026-04-28 -->

# Known package vulnerabilities — residuals

This file tracks `npm audit` findings that we have evaluated but not
fixed. Each row records the reachability assessment and the operator
decision so the next audit can pick up where this one left off.

When a new finding lands, prefer fixing it over documenting it. Use
this file only for the cases where:

1. There is no fix available, OR
2. The only fix is a breaking change we have explicitly chosen to
   defer, OR
3. The advisory is reachable only in code paths we don't run.

## Audit run — 2026-04-28

`npm audit` after this PR's bumps reports **0 vulnerabilities** on
both `admin/backend` and `admin/frontend`. There are no current
residuals.

Reference state for the next audit:

| Tree              | prod deps | dev deps | high | critical |
|-------------------|-----------|----------|------|----------|
| `admin/backend`   | 140       | 0        | 0    | 0        |
| `admin/frontend`  | 220       | 76       | 0    | 0        |

## Findings resolved this PR

The following findings were present before this audit and were closed
by per-package upgrades on the cleanup branch:

| Package    | Tree     | Severity | Advisory                  | Resolution                        |
|------------|----------|----------|---------------------------|-----------------------------------|
| `uuid`     | backend  | moderate | GHSA-w5hq-g745-h8pq       | bumped `^9.0.1` → `^14.0.0`       |
| `postcss`  | frontend | moderate | GHSA-qx2v-qp2m-jg93       | `npm audit fix` (8.5.6 → 8.5.12)  |
| `vite`     | frontend | moderate | GHSA-4w7w-66w2-5vf9       | bumped `^5.0.8` → `^6.4.2`        |
| `esbuild`  | frontend | moderate | GHSA-67mh-4wv8-2f99       | transitively fixed by vite v6.4.2 |

Reachability notes for the resolved set:

- `uuid` v3/v5/v6 buffer-bounds advisory: not reachable in our code —
  every call site uses `uuidv4()`. Bumped anyway because v14 keeps the
  v4 API stable and a clean audit is worth the major version pin.
- `vite` + `esbuild`: dev-server-only path-traversal / CORS issues.
  Production builds via `vite build` are not affected, and the dev
  server should never run on a deployed host. Bumped to vite v6.4.2
  (within the same major as the latest fix line we accept) to keep
  `npm audit` clean for operators who run the dev server locally.
  `@vitejs/plugin-react-swc@3.7.2` declares `vite: ^4 || ^5 || ^6` so
  the bump did not require a plugin upgrade. `vite build` smoke-tested
  green (1564 modules, dist generated, no console output beyond the
  build summary).

## How to refresh this file

After any PR that touches package.json:

    cd admin/backend  && npm audit --json > /tmp/backend-audit.json
    cd admin/frontend && npm audit --json > /tmp/frontend-audit.json

If either reports vulnerabilities, walk each one:

1. Identify the offending package and the advisory ID.
2. Decide: per-package upgrade, transitive fix, or document residual.
3. Never run `npm audit fix --force` blindly — it freely upgrades
   transitive deps across major boundaries and has historically
   broken our build.
4. Land per-package or per-logical-group commits prefixed
   `audit(deps):` or `chore(deps):` per the kickoff convention.
