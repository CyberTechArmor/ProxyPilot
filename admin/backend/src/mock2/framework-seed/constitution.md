# Mock2 Organizational Constitution — v1

The constitution is the single, versioned, machine-readable statement of **how**
every Mock2 project is built. It is set once at the platform level and inherited
by every project; end users never see or edit it. A project contributes only its
*name*, a *compliance-mode* flag, and a list of *approved integrations* — nothing
about architecture. This document governs the runner, the generated application,
and every gate; it is independent of any single project's `state/rules.md`.

> Source: *The Mock2 Framework*, v1.1 (Fractionate LLC, July 2026), §3, §6, §9.
> This is the operator's real v1 content (closing risk R8 for the constitution).

## 1. Design principles (non-negotiable)

1. **Restriction is the feature.** Removing technical choices is what makes
   non-coder development possible and outputs consistent. One stack, one
   scaffold, one path. The user's freedom lives entirely in *what* the software
   does; the framework owns every decision about *how* it is built.
2. **The spec is the source of truth.** Code is generated from the approved
   design inventory (`state/inventory.json`) and the confirmed plain-language
   rules (`state/rules.md`) — never the reverse, and never from mockup code.
3. **Deterministic before intelligent.** Wherever a static check, lint rule, or
   test can enforce something, no AI is used to enforce it. AI review is reserved
   for judgment calls machines cannot make.
4. **Nothing self-approves.** The building runner cannot pass its own gates, and
   no AI can deploy. A human Reviewer holds the only path to production.
5. **The record writes itself.** Every decision, change, test result, and
   sign-off is captured automatically as audit evidence (the hash-chained change
   records), surfaced to humans only when it matters.
6. **Development can never touch production.** Builds happen in sealed, disposable
   containers; production servers *pull* signed, approved releases. No inbound
   path exists from the build platform to production.

## 2. The stack (the only stack)

Every generated application uses exactly this stack. A gate rejects deviations.

- **Language:** TypeScript (strict).
- **HTTP:** Express.
- **Data access:** Drizzle ORM — the *only* way the app reads or writes the
  database. No raw SQL clients, no other ORM.
- **Validation:** Zod — every route validates its input with a Zod schema.
- **Testing:** Vitest.
- **Database:** PostgreSQL — the *only* database. No MySQL, SQLite, Mongo, etc.
  A genuine additional datastore is a one-line constitution amendment by the
  platform admin, never a per-project decision.
- **Reverse proxy / TLS:** Caddy.

## 3. Scaffold conventions

Every application starts from the standard scaffold (`project_template_ref`) and
keeps its shape:

- **Module layout:** feature modules under `src/`, each exposing `routes`,
  `service`, `schema` (Drizzle + Zod), and `*.test.ts`.
- **Route → service → data:** routes validate (Zod) and delegate; services hold
  business logic; all persistence goes through Drizzle schema modules.
- **Migrations:** numbered, ordered, and reversible; a migration must never lose
  data without an explicit, reviewed waiver.
- **Config:** environment-driven; no hardcoded hosts, ports, or credentials.
- **Manifest:** the repo declares its topology in `mock2.yaml` (the one exposed
  `web` port; everything else internal). Ports are *declared, not discovered*.

## 4. Auth pattern (one implementation, applied identically)

- Single sign-on with multi-factor authentication for human access.
- Role-based access control enforced **server-side on every path** — never in the
  client, never advisory. A Tier-2 review pass confirms RBAC is enforced on every
  route that touches protected data.
- Per-tenant isolation (row-level scoping) in the application database.

## 5. Security posture

- **Secrets** live in a dedicated secrets manager and are referenced by name;
  they are **never** committed to a repository. A gate scans every tracked file
  for embedded private keys, cloud credentials, and tokens and fails the build.
- **Required headers** on every response: `Content-Security-Policy`,
  `X-Content-Type-Options: nosniff`, `Referrer-Policy`, and HSTS in production.
- **Encryption:** TLS in transit (Caddy); sensitive columns encrypted at rest.
- **Logging:** structured and PII-aware; no secrets or full payloads in logs.
- **Supply chain:** dependency and image scanning in the deterministic gate tier;
  releases are signed tags, signing keys held outside the platform.

## 6. The four stages (the only path)

Every project — and every change to a live project — follows the same four
stages. The change router sends live-app requests back to Stage 1 (appearance)
or Stage 2 (behavior); the full gate battery and Reviewer approval apply to every
release, however small.

1. **Concept** — chat produces a disposable interactive HTML mockup, constrained
   by the locked design system. Sign-off #1 (design approval) extracts the design
   inventory; the mockup code is then discarded.
2. **Define** — a templated plain-language interview (Data / Who-can-do-what /
   Connections / What-happens-when) restates answers as confirmed rules. Sign-off
   #2 (rules confirmation) is the final human gate before code exists.
3. **Build** — the runner derives an internal work file from exactly three
   inputs — this constitution, the design inventory, and the confirmed rules —
   generates the application on a branch inside a sealed fenced container, and
   drives it to *every gate green*. The runner never receives mockup code, never
   merges to main, and can never reach production.
4. **Run** — a Reviewer confirms every gate is green and reads the surfaced change
   descriptions (never code diffs); approval tags a signed release that production
   pulls.

## 7. Definition of production-ready

Production-ready has exactly one meaning: **every gate is green.** The Reviewer
confirms gate results and reads surfaced change descriptions — the role is a
realistic bar for an operational IT lead, not a senior engineer.

## 8. What is deliberately removed

Relative to standard spec-driven development, the framework removes per-project
constitutions, Architecture Decision Records as user artifacts, the
clarify/tasks/analyze phases as user-facing steps, prose UI specifications,
coverage-percentage targets, multi-agent orchestration, and per-change AI review.
Each removal survives one test: *does the exact production result survive without
it?*
