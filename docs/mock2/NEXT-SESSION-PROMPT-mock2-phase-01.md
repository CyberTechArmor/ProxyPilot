# Next session — Mock2 Phase M0: module skeleton + absence-by-installation

You are starting the build of the **Mock2 module** inside ProxyPilot. A
planning session already read the whole codebase and produced the plan you
are executing — do **not** re-derive the architecture, and do **not** trust
your instincts over the plan's citations; they were verified against the code.

## Read these first, in order

All in `docs/mock2/`:

1. `04-phased-plan.md` — your phase is **M0** (and only M0). Read the
   "ordering disagreements" preamble so you know why M0 looks like this.
2. `02-adrs.md` — **ADR-001** is the specification for this phase. ADR-007
   gives you the `is_superadmin` change. Skim the rest for context.
3. `03-data-model.md` — migrations 500–503 (you create the migration
   framework and all four migrations this session; later phases only *use*
   the tables).
4. `01-survey.md` §1 (module gating), §2 (migrations/encryption), §12
   (installer/update seams) — these carry the `file:line` seams you'll touch.
5. `05-risks-and-open-questions.md` — R3 (Docker/nsenter shapes), R7
   (never name anything "agent"), R9 (stub-first tests).

Background only (do not implement from it directly): `00-original-brief.md`.

## Scope of this session — Phase M0 only

- `MOCK2_ENABLED=false` + `MOCK2_DATA_DIR` in `.env.example` (it is the
  canonical key list — `update.sh sync_env_keys` retrofits from it; verify
  that behavior with a dry test rather than assuming).
- `install.sh`: fresh-install `[y/N]` prompt (default **No**), suppressed by
  the pin file, re-asked on re-run only when currently `false`. Follow the
  existing prompt idiom at `install.sh:1202-1207`.
- Pin file `/etc/proxypilot/mock2.production.pin`: hard-off that overrides
  `MOCK2_ENABLED=true` with a logged warning. Never created by code.
- `admin/backend/src/mock2/` module: separate `data/db/mock2.db`
  (better-sqlite3, WAL, 0600/0700 like `db.js:27-42`), own `runMigration`
  registry, migrations **500–503 exactly as written in `03-data-model.md`**.
- Dynamic `await import()` + conditional mount in `index.js` (around
  `index.js:411-423`): when disabled/pinned, no `/api/mock2/*` route exists
  at all. Only route this session: `GET /api/mock2/status` (admin-gated).
- Main DB: add `users.is_superadmin` (backfill the first/oldest admin);
  enforce "a non-superadmin cannot deactivate/demote a superadmin" in
  `routes/user.js`.
- Frontend: nav entry (`Layout.jsx` `navigation` array, `adminOnly: true`)
  plus an empty Projects page, both shown only when `GET /api/mock2/status`
  succeeds; hidden when it 404s.
- Tests: stub the DB at the module boundary like the 73 passing tests (see
  `docs/known-issues.md` — do NOT import real `db.js` in tests). Cover:
  flag off, flag on, pin overrides flag, status route gating, superadmin
  protection rule.

## Do NOT implement (later phases)

- Parent domains, per-slug TLS, any Caddy changes (M1).
- Projects, containers, repos, memberships beyond the schema (M2).
- Anything called a runner, cycle, chat, connector, framework editor
  (M5–M9). The tables exist after your migrations; the features do not.
- Any LDAP anything (deferred by ADR-007).

## Hard constraints

- **Naming:** the AI build component is the **runner**; `proxypilot-agent`
  is an existing, unrelated Go daemon. No new file, table, or route may use
  the bare word "agent" (risk R7).
- Any frontend change must pass `admin/frontend/MOBILE_FIRST.md` (merge
  gate): render at 360/375/768, no horizontal scroll, 44px touch targets.
- New migrations are append-only; never edit applied ones (CLAUDE.md).
- Match existing conventions: Zod on the backend routes, `{ error }` response
  shape, `requireAdmin`/`requireSudo` middleware, `logAudit` for admin
  actions (installer prompt answer changes and status flips are audit-worthy).

## What "done" looks like

The Phase M0 verification checklist in `04-phased-plan.md`, plus:

```
cd admin/backend && node --test 'src/__tests__/*.test.js'
```

no NEW failures (three pre-existing failures are documented in
`docs/known-issues.md` — leave them alone). A host with
`MOCK2_ENABLED=false` behaves byte-for-byte like today: no route, no
`mock2.db` file, no nav entry.

## Branch

Harness assigns. Commit as `mock2-M0: <description>`. Do not push to main.

## Before you finish

Write `docs/mock2/NEXT-SESSION-PROMPT-mock2-phase-02.md` for Phase M1 in this
same format: what M0 shipped (so M1 doesn't re-implement it), pointers into
the plan bundle, and M1 scope from `04-phased-plan.md`. M1 is fully
unblocked (ADR-009 accepted: per-slug HTTP-01, no DNS provider API). Also
note in that prompt that **ADR-008 must be confirmed by the operator before
Phase M2** (see `05-risks-and-open-questions.md` §Q2) unless the plan bundle
already records the confirmation.
