# Next-session prompt — three-tier RBAC: superadmin / admin / developer

You are implementing a role-model change in ProxyPilot. A previous session read
the codebase and produced this prompt; the citations were verified against the
code — do not re-derive them. Implement exactly the model below, honour the
existing architecture (especially ADR-007's `is_superadmin` reasoning), and keep
the house conventions (append-only migrations, Zod + `{ error }` shape,
`logAudit`, stub-first tests, `admin/frontend/MOBILE_FIRST.md`).

## Goal

Replace today's two-tier model (`admin` / `user`) with **three roles**:

1. **Superadmin** — the current all-powerful admin. Full control of everything,
   including other superadmins and platform-wide settings. This is the role the
   platform owner holds. Cannot be modified, demoted, deactivated, or deleted by
   anyone who is not themselves a superadmin.
2. **Admin** — a **support** role for people who help run the platform. Can do
   everything an admin can do today **except touch superadmin accounts or the
   superadmin grant**: cannot edit, demote, deactivate, delete, reset, or
   otherwise change a superadmin, and cannot promote anyone (including
   themselves) **to** superadmin. Everything else — services, LXC/Incus, VPN,
   firewall, SSH access, backups, CVEs, housekeeping, terminal, and the Mock2
   admin surfaces — is fully available.
3. **Developer** — today's `user`, renamed and re-centred. Sees **only what they
   create or what is shared with them** (`user_service_access` for services;
   `mock2_project_members` for projects). The role's primary focus is
   **AI-assisted development**, i.e. the Mock2 **Projects** flow — a developer's
   home is their project list, not the operator dashboard.

## What exists today (do NOT re-derive)

- **`users.role`** — `TEXT DEFAULT 'user' CHECK(role IN ('admin','user'))`
  (`admin/backend/src/db.js:254`; an earlier `ALTER` at `:268` defaults `admin`).
  The JWT carries `role` (`req.user.role`) but **not** `is_superadmin`
  (`routes/user.js:768` comment).
- **`users.is_superadmin`** — `INTEGER NOT NULL DEFAULT 0`, migration **500**
  (`db.js:1382`, block 500 = Mock2/ADR-007). Backfilled onto the first admin
  (oldest by `created_at,username`) at `db.js:1385` and again defensively at
  `db.js:167-175`. **ADR-007 deliberately made this a _local_ break-glass marker
  orthogonal to `role`, so a future LDAPS role-sync can never strip your last
  superadmin.** Respect that intent (see the ADR decision below).
- **`checkSuperadminProtection({ actorIsSuperadmin, targetIsSuperadmin, action })`**
  — pure predicate in `lib/superadmin.js`; already blocks a non-superadmin from
  `demote`/`deactivate` of a superadmin. Enforced in `routes/user.js` on the
  demote path (`:767-781`) and delete path (`:855-862`). This is the seed of the
  admin-vs-superadmin split — you are generalising it, not inventing it.
- **`requireAdmin`** — `role !== 'admin' → 403` (`middleware/auth.js:212-222`),
  used at **89 call sites** across `routes/*` and `index.js`. `requireSudo`
  (`:187`) gates destructive endpoints via `sudo_until`.
- **`canViewService`/`canWriteService`/`getAccessibleServices`**
  (`middleware/auth.js:225-277`) — `role==='admin'` ⇒ all services; otherwise
  `user_service_access`. This is exactly the "developer sees only what's shared"
  mechanism; it keeps working unchanged for `role='developer'`.
- **Mock2 authz** — `requireMock2Role(minRole)` (`mock2/authz.js:19`): admins and
  superadmins bypass project membership (`req.user.role === 'admin'`), a bypass
  into a non-member project is stamped `acting_as_admin`; non-admins are resolved
  purely from `mock2_project_members`. **A `developer` is already handled
  correctly here** — no auto-bypass, membership-only. `is_superadmin` is looked
  up from the DB when needed (`authz.js:27`, `projects.js isUserSuperadmin`).
- **User CRUD** — `routes/user.js`: create (`createUserSchema`,
  `role: z.enum(['admin','user']).default('user')`, `:700`), update
  (`updateUserSchema`, `role: z.enum(['admin','user']).optional()`, `:751`),
  last-admin guard (`COUNT(*) WHERE role='admin'`, `:783-786`), `/me` and list
  responses expose `role` and `isSuperadmin` (`:205-206`, `:682-683`).
- **Seed** — `db.js:1555-1575` inserts the bootstrap account with `role='admin'`;
  the first-admin backfill then makes it `is_superadmin=1` ⇒ the bootstrap
  account is a **superadmin** under the new model. Keep that.
- **Frontend** — `role === 'admin'` ⇒ `isAdmin` everywhere
  (`context/AuthContext`, `components/Layout.jsx:142`, `pages/Users.jsx:57`, …);
  Layout user chip shows `isAdmin ? 'Administrator' : 'User'` (`Layout.jsx:296`);
  nav items are gated `adminOnly` and filtered by `isAdmin`
  (`Layout.jsx:189-208`). **Projects nav is `adminOnly` (`Layout.jsx:201`) and
  `Projects.jsx:106` / `ProjectDetail.jsx` redirect non-admins home** — this is
  the main thing blocking a developer from the Mock2 flow. `Users.jsx:37` new-user
  form defaults `role:'user'` and renders a role `Select`.

## The one architectural decision — read before writing code (write it as ADR-011)

Two ways to model three roles. **Recommended: Option B.**

- **Option B (recommended) — rename `user`→`developer`; `is_superadmin` remains
  the superadmin marker.** The stored `role` stays `admin` for both the Admin and
  Superadmin tiers; **Superadmin = `role='admin' AND is_superadmin=1`**, plain
  **Admin = `role='admin' AND is_superadmin=0`**, **Developer = `role='developer'`**.
  - Why: respects ADR-007 (durable local superadmin marker, LDAPS-safe); leaves
    all **89 `requireAdmin`** sites correct unchanged (both admin tiers keep
    `role='admin'`); the Mock2 bypass and `canViewService` logic keep working;
    the change collapses to a rename + generalising the superadmin guards + a
    UI/label layer. The API and UI still present **three first-class roles** — the
    split is just stored as `role`+`is_superadmin` rather than one enum.
  - Cost: "superadmin" is a derived label, not a literal `role` value. Add one
    helper (`effectiveRole({role, is_superadmin}) → 'superadmin'|'admin'|'developer'`)
    used by both backend responses and the frontend so the two never drift.
- **Option A — three literal `role` values** (`role IN ('superadmin','admin','developer')`),
  retire/mirror `is_superadmin`. Cleaner enum, but: SQLite can't alter a CHECK in
  place (full table rebuild), it fights ADR-007's LDAPS reasoning, and it forces
  every `role==='admin'` check (89 + the Mock2 bypass) to become "admin-tier =
  role in (superadmin,admin)". Only choose this if the team explicitly wants
  `role` to be the sole source of truth; if so, keep a `requireAdminTier` helper
  rather than open-coding the set at 89 sites.

Record the choice and the LDAPS rationale in `docs/rbac/ADR-011-three-tier-roles.md`
(or append to the Mock2 ADR file if the team prefers one ledger).

## Scope (assuming Option B)

### Backend

1. **Migration (append-only, next free number in `db.js`; do NOT edit 500 or any
   applied migration).** Widen `role` to allow `developer` and migrate data:
   `UPDATE users SET role='developer' WHERE role='user'`. SQLite CHECK can't be
   altered in place — rebuild the `users` table (new table with
   `CHECK(role IN ('admin','developer'))`, copy rows, drop, rename, recreate
   indexes/foreign keys) **or**, if the current schema has no dependent FKs that
   make a rebuild risky, drop the CHECK and rely on the Zod enum + app writes.
   Whichever you pick, verify existing rows survive and `is_superadmin` is
   untouched. Confirm `update.sh`/`sync_env_keys` needs nothing here (schema is
   code-driven, not `.env`).
2. **`effectiveRole()` helper** (pure, unit-tested) mapping `{role, is_superadmin}`
   → `'superadmin' | 'admin' | 'developer'`. Use it in every `/api/users` and
   `/me` response (`routes/user.js:205-206,682-683`) so the API speaks the
   three-role vocabulary.
3. **Generalise the superadmin guard (`lib/superadmin.js` + `routes/user.js`).**
   Today it blocks `demote`/`deactivate` of a superadmin by a non-superadmin.
   Extend so a **non-superadmin admin cannot touch a superadmin target at all**:
   role change, display-name edit, password reset, device revocation, deactivate,
   delete — every mutation path in `routes/user.js`. **Also block promotion _to_
   superadmin by a non-superadmin** (setting `is_superadmin=1`, or picking the
   `superadmin` role at the API). Keep `checkSuperadminProtection` pure; add the
   promote case as a sibling predicate (e.g. `checkSuperadminGrant`).
4. **Guard the last superadmin.** Replace / augment the "last admin" guard
   (`routes/user.js:783-786`) so the platform can never lose its last
   `is_superadmin=1` account (block demote/delete when it is the last superadmin).
   A plain admin being the last admin is fine; a superadmin being the last
   superadmin is not removable.
5. **Zod at the API boundary.** `createUserSchema`/`updateUserSchema` accept
   `role: z.enum(['superadmin','admin','developer'])` (create default
   `'developer'`). Translate on write: `superadmin → role='admin', is_superadmin=1`;
   `admin → role='admin', is_superadmin=0`; `developer → role='developer'`. Apply
   the guards from (3) before any write. `logAudit` the effective role.
6. **`requireSuperadmin` middleware** (new, `middleware/auth.js`) — `role==='admin'
   && is_superadmin`. Because the JWT lacks `is_superadmin`, it must DB-look-up
   (mirror `authz.js:27`). Mount it on superadmin-only endpoints: granting/removing
   superadmin, and any platform-wide settings you deem owner-only. Leave
   `requireAdmin` as-is (covers both admin tiers).
7. **Mock2:** no change to `requireMock2Role` — `developer` is already
   membership-only and both admin tiers already bypass. Confirm the plain **Admin**
   tier should keep the `acting_as_admin` bypass into developer projects (yes —
   they support the platform); note it in the ADR.

### Frontend

8. **Open the Mock2 Projects surface to developers.** Un-gate the project **list**
   and **detail** for `developer`:
   - `Layout.jsx` — show the **Projects** nav for developers too (not just admins);
     keep it behind the Mock2 `mock2Enabled` probe. All other operator nav
     (Incus, Host Shell, SSH, Firewall, VPN, CVEs, Troubleshooting, Housekeeping,
     Users) stays admin-tier only.
   - `Projects.jsx` / `ProjectDetail.jsx` — stop redirecting non-admins; instead
     show only the caller's member projects (the backend list already scopes by
     membership for non-admins). A developer with zero projects sees an empty
     state, not a bounce home.
   - **Keep admin-tier only:** Parent domains, Connectors, Quotas, Framework
     registry, Admin queue (`Projects.jsx:157-186` sub-cards and their routes).
     Hide those cards for developers.
9. **Role vocabulary in the UI.** Add a frontend `effectiveRole`/label helper and
   use it wherever role is shown or chosen: Layout user chip (`Superadmin`/`Admin`/
   `Developer` instead of `Administrator`/`User`, `Layout.jsx:296`), the Users
   page role `Select` (three options; selecting Superadmin is itself gated to
   superadmins), the new-user form default (`developer`, `Users.jsx:37`), Profile,
   and any "User"/"Administrator" copy. The `/me` object already carries
   `isSuperadmin`, so the client can derive the label without a new call.
10. **MOBILE_FIRST** for every touched page/component (`Users.jsx`, `Layout.jsx`,
    `Projects.jsx`, `ProjectDetail.jsx`): 44px targets, single-column at 360px,
    dialogs completable on a 360px screen. Run the pre-merge checklist.

### Tests (stub-first — import the pure modules, never `db.js`)

11. Extend `superadmin` coverage: admin cannot edit/reset/delete a superadmin;
    admin cannot promote to superadmin; superadmin can do all of the above;
    last-superadmin cannot be removed. Cover `effectiveRole` mapping and the Zod
    translation. Add a Mock2 authz case asserting a `developer` reaches only their
    member projects and an `admin` still bypasses with `acting_as_admin`. No NEW
    failures beyond the known native-module ones in `docs/known-issues.md`
    (`cves`, `incus`, `webauthn`, `vpn-mtu`).

## Open product decisions to resolve in the ADR (don't guess silently)

- **Can a developer self-create a project** ("what they make"), or do admins
  provision and add them as members? Self-create needs an admin-provisioned
  parent domain + connectors + quota to already exist. Recommended v1: admins
  provision; developers create projects **on an already-enabled parent domain**
  and are the owner-member — but confirm, since it affects `Projects.jsx` create
  gating and the Mock2 project-create route's `requireAdmin` vs `requireMock2Role`.
- **Developer Dashboard scope.** The dashboard shows host CPU/mem/disk and service
  counts. Decide whether a developer sees a scoped dashboard (their projects/
  services only) or is sent straight to Projects. Recommended: land developers on
  Projects; if the dashboard stays reachable, scope its numbers to their access.
- **Who may create Admins vs Developers.** Admins may create/manage admins and
  developers; only superadmins may create/grant superadmins (enforced by 3/5/6).

## Do NOT

- Do not edit any applied migration (500 or earlier) or the seeded Mock2 v1 row.
- Do not put `is_superadmin` in the JWT (keep the DB-lookup pattern).
- Do not weaken ADR-001 (Mock2 absence) — none of this mounts on a disabled host.
- Do not open the operator surfaces (Firewall/VPN/SSH/Incus/Housekeeping/Users)
  to developers; developer = own/shared resources + the Projects flow only.

## What "done" looks like

Bootstrap account is a **Superadmin**. Create a plain **Admin**: they can manage
services/LXC/VPN/etc. and other admins/developers, but the Users page refuses to
edit, reset, demote, or delete the superadmin and offers no "Superadmin" option
to grant. Create a **Developer**: they log in to their **Projects**, see only
projects they own or are a member of and only services shared with them, and get
403/hidden nav for every operator surface. A superadmin can do all of it,
including grant/revoke superadmin, and the last superadmin cannot be removed.
`cd admin/backend && node --test 'src/__tests__/*.test.js'` shows no new failures;
`cd admin/frontend && npm run build` passes; the MOBILE_FIRST checklist is green.

Commit as `rbac: three-tier roles (superadmin/admin/developer)`. Before finishing,
write `docs/rbac/ADR-011-three-tier-roles.md` recording the Option A/B choice, the
LDAPS/ADR-007 rationale, the admin-cannot-touch-superadmin rule, the developer =
membership-only scoping, and the resolved product decisions above.
