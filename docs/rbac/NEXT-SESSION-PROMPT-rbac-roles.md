# Next-session prompt — three-tier RBAC: superadmin / admin / developer (+ pending)

You are implementing a role-model change in ProxyPilot. A previous session read
the codebase and produced this prompt; the citations were verified against the
code — do not re-derive them. Implement exactly the model below, honour the
existing architecture (especially ADR-007's `is_superadmin` reasoning), and keep
the house conventions (append-only migrations, Zod + `{ error }` shape,
`logAudit`, stub-first tests, `admin/frontend/MOBILE_FIRST.md`).

## Goal

Replace today's two-tier model (`admin` / `user`) with **three functional roles
plus a no-access "pending" state**:

1. **Superadmin** — the current all-powerful admin. Full control of everything,
   including other superadmins and platform-wide settings. Cannot be modified,
   demoted, deactivated, or deleted by anyone who is not a superadmin, and only a
   superadmin can grant the superadmin role. The bootstrap account is a superadmin.
2. **Admin** — a **support** role. Can do everything an admin can do today **except
   touch superadmin accounts or the superadmin grant**: cannot edit, demote,
   deactivate, delete, reset, or otherwise change a superadmin, and cannot promote
   anyone (including themselves) **to** superadmin. Admins **can add users and
   assign the admin/developer roles** (see LDAP note below). Everything else —
   services, LXC/Incus, VPN, firewall, SSH, backups, CVEs, housekeeping, terminal,
   and the Mock2 admin surfaces — is fully available.
3. **Developer** — today's `user`, renamed and re-centred on **AI-assisted
   development** (the Mock2 Projects flow). A developer:
   - **lands straight on their Projects** after login (not the operator dashboard);
   - sees **only what they create or what is shared with them** (`user_service_access`
     for services; `mock2_project_members` for projects);
   - **can create projects**, and **can share / add other users to a project they
     own** and manage their project roles (editor/viewer) so collaborators can see
     and work on it. No operator surfaces.
4. **Pending (no role)** — an authenticated account with **no role assigned yet →
   no access to anything**. This is the default for a future LDAPS-provisioned user:
   they can sign in, but see only an "awaiting role assignment" screen until a
   superadmin or admin assigns them superadmin/admin/developer. Every API surface
   and nav item denies a pending user.

## What exists today (do NOT re-derive)

- **`users.role`** — `TEXT DEFAULT 'user' CHECK(role IN ('admin','user'))`
  (`admin/backend/src/db.js:254`; an earlier `ALTER` at `:268` defaults `admin`).
  The JWT carries `role` (`req.user.role`) but **not** `is_superadmin`
  (`routes/user.js:768` comment).
- **`users.is_superadmin`** — `INTEGER NOT NULL DEFAULT 0`, migration **500**
  (`db.js:1382`, block 500 = Mock2/ADR-007). Backfilled onto the first admin
  (oldest by `created_at,username`) at `db.js:1385` and defensively at
  `db.js:167-175`. **ADR-007 deliberately made this a _local_ break-glass marker
  orthogonal to `role`, so a future LDAPS role-sync can never strip your last
  superadmin.** This is exactly why we keep Option B (below).
- **`checkSuperadminProtection({ actorIsSuperadmin, targetIsSuperadmin, action })`**
  — pure predicate in `lib/superadmin.js`; already blocks a non-superadmin from
  `demote`/`deactivate` of a superadmin. Enforced in `routes/user.js` on the
  demote path (`:767-781`) and delete path (`:855-862`). You are **generalising**
  this, not inventing it.
- **`requireAdmin`** — `role !== 'admin' → 403` (`middleware/auth.js:212-222`),
  used at **89 call sites** across `routes/*` and `index.js`. `requireSudo`
  (`:187`) gates destructive endpoints via `sudo_until`.
- **`canViewService`/`canWriteService`/`getAccessibleServices`**
  (`middleware/auth.js:225-277`) — `role==='admin'` ⇒ all services; otherwise
  `user_service_access`. This is the "developer sees only what's shared"
  mechanism; it keeps working unchanged for `role='developer'` and yields nothing
  for `pending`.
- **Mock2 authz** — `requireMock2Role(minRole)` (`mock2/authz.js:19`): admins and
  superadmins bypass project membership (`req.user.role === 'admin'`), a bypass
  into a non-member project is stamped `acting_as_admin`; non-admins are resolved
  purely from `mock2_project_members`. A `developer` is already membership-only
  here; `is_superadmin` is DB-looked-up when needed (`authz.js:27`,
  `projects.js isUserSuperadmin`). **Project create + membership-management routes
  are the ones to re-gate** so a developer owner (not just an admin) can use them.
- **User CRUD** — `routes/user.js`: create (`createUserSchema`,
  `role: z.enum(['admin','user']).default('user')`, `:700`), update
  (`updateUserSchema`, `role: z.enum(['admin','user']).optional()`, `:751`),
  last-admin guard (`COUNT(*) WHERE role='admin'`, `:783-786`), `/me` and list
  responses expose `role` and `isSuperadmin` (`:205-206`, `:682-683`).
- **Seed** — `db.js:1555-1575` inserts the bootstrap account with `role='admin'`;
  the first-admin backfill then makes it `is_superadmin=1` ⇒ the bootstrap account
  is a **superadmin** under the new model. Keep that.
- **Frontend** — `role === 'admin'` ⇒ `isAdmin` everywhere (`context/AuthContext`,
  `components/Layout.jsx:142`, `pages/Users.jsx:57`, …); Layout user chip shows
  `isAdmin ? 'Administrator' : 'User'` (`Layout.jsx:296`); nav items are gated
  `adminOnly` and filtered by `isAdmin` (`Layout.jsx:189-208`); **Projects nav is
  `adminOnly` (`Layout.jsx:201`) and `Projects.jsx:106` / `ProjectDetail.jsx`
  redirect non-admins home**. `Users.jsx:37` new-user form defaults `role:'user'`
  and renders a role `Select`. Login currently lands everyone on `/`.

## Architectural decision — CHOSEN: Option B (write it up as ADR-011)

**Store the split as `role` + `is_superadmin`; do NOT introduce a literal
`superadmin` role value.**

- **Superadmin** = `role='admin' AND is_superadmin=1`
- **Admin** = `role='admin' AND is_superadmin=0`
- **Developer** = `role='developer'`
- **Pending** = `role='pending'`

Why B (and not three literal role values): it respects ADR-007 (durable local
superadmin marker, LDAPS-safe); it leaves all **89 `requireAdmin`** sites and the
Mock2 admin bypass correct unchanged (both admin tiers keep `role='admin'`); the
change collapses to a rename + a `pending` state + generalised superadmin guards +
a UI/label layer. Add one shared helper
`effectiveRole({ role, is_superadmin }) → 'superadmin'|'admin'|'developer'|'pending'`
used by **both** backend responses and the frontend so the label logic never
drifts. Record the choice, the LDAPS/ADR-007 rationale, and the resolved product
rules below in `docs/rbac/ADR-011-three-tier-roles.md`.

## Scope

### Backend

1. **Migration (append-only; next free number in `db.js` — never edit 500 or any
   applied migration).** Allow the new role values and migrate data:
   `UPDATE users SET role='developer' WHERE role='user'`. SQLite can't alter a
   CHECK in place — rebuild the `users` table with
   `CHECK(role IN ('admin','developer','pending'))` (new table → copy rows → drop →
   rename → recreate indexes/FKs), preserving `is_superadmin`. **Set the column
   DEFAULT to `'pending'`** so any insert path that forgets to specify a role
   yields an inert account (future LDAP safety), while the API create path defaults
   to `developer` (step 5). Verify existing rows survive and superadmin flags are
   intact.
2. **`effectiveRole()` helper** (pure, unit-tested) mapping `{ role, is_superadmin }`
   → the four tokens. Use it in every `/api/users` and `/me` response
   (`routes/user.js:205-206,682-683`) so the API speaks the role vocabulary.
3. **Generalise the superadmin guard (`lib/superadmin.js` + `routes/user.js`).**
   A **non-superadmin cannot touch a superadmin target at all** — role change,
   display-name edit, password reset, device revocation, deactivate, delete: every
   mutation path in `routes/user.js`. **Also block promotion _to_ superadmin by a
   non-superadmin** (setting `is_superadmin=1` / choosing the `superadmin` role).
   Keep the predicates pure (add e.g. `checkSuperadminGrant` alongside
   `checkSuperadminProtection`).
4. **Guard the last superadmin.** Replace/augment the "last admin" guard
   (`routes/user.js:783-786`) so the platform can never lose its last
   `is_superadmin=1` account (block demote/delete of the last superadmin). A plain
   admin being the last admin is fine; the last superadmin is not removable.
5. **Role assignment API (superadmin + admin can add users / assign roles).**
   `createUserSchema`/`updateUserSchema` accept
   `role: z.enum(['superadmin','admin','developer','pending'])` (create default
   `'developer'`). Translate on write: `superadmin → role='admin', is_superadmin=1`;
   `admin → role='admin', is_superadmin=0`; `developer → role='developer'`;
   `pending → role='pending'`. **Authorisation:** `requireAdmin` may create/manage
   users and assign `admin`/`developer`/`pending`; **only a superadmin may assign or
   revoke `superadmin`** (step 3). Reassigning a pending (e.g. LDAP-provisioned)
   user to a real role is the normal admin onboarding path. `logAudit` the effective
   role on every change.
6. **`requireSuperadmin` middleware** (new, `middleware/auth.js`) —
   `role==='admin' && is_superadmin`, DB-looked-up (JWT lacks `is_superadmin`;
   mirror `authz.js:27`). Mount on superadmin-only endpoints (granting/removing
   superadmin, owner-only platform settings). Leave `requireAdmin` unchanged.
7. **Deny pending everywhere.** A `pending` user passes authentication but must get
   nothing: `requireAdmin` already denies (role≠admin); ensure the developer/Mock2
   surfaces also deny (project create + membership + any `requireMock2Role` route
   require an effective role of **developer or above**, never pending), and
   `getAccessibleServices` returns `[]`. No memberships/shares are ever auto-created
   for pending.
8. **Developer project ownership + collaboration (Mock2 routes).** Re-gate so a
   developer can:
   - **create a project** (project-create route → allow `developer`+; today it is
     admin-gated). Creation makes the developer the **owner-member**. Requires an
     admin-enabled parent domain to already exist (unchanged prerequisite) — a
     developer with no selectable domain sees the same "ask an admin to register a
     domain" empty state.
   - **manage members of a project they own** — add/remove collaborators and set
     their project role (editor/viewer) via `requireMock2Role('owner')` (or the
     existing owner/editor gate), **not** `requireAdmin`. Admins keep their
     `acting_as_admin` bypass into any project.

### Frontend

9. **Landing route by effective role.** After login (and on root visit): superadmin
   & admin → `/` (operator Dashboard); **developer → `/projects`**; pending →
   a new minimal **`/awaiting-role`** page ("Your account is awaiting a role — an
   administrator will grant access"). Centralise this in the auth/redirect layer,
   not per-page.
10. **Nav by effective role (`Layout.jsx`).** Superadmin/admin: full operator nav
    as today. Developer: **Projects + Profile only** (hide Dashboard and every
    operator entry). Pending: **Profile only** (plus the awaiting-role screen).
    Keep the Projects nav behind the Mock2 `mock2Enabled` probe.
11. **Open the Mock2 Projects surface to developers.** Stop `Projects.jsx:106` /
    `ProjectDetail.jsx` from redirecting non-admins; show the caller's member/owned
    projects (the backend list already scopes by membership for non-admins), a
    "New project" action for developers, and the **share/add-members** UI on
    projects they own. **Keep admin-tier only:** Parent domains, Connectors, Quotas,
    Framework registry, Admin queue (`Projects.jsx:157-186` sub-cards + routes) —
    hide them for developers.
12. **Role vocabulary in the UI.** Add a frontend `effectiveRole`/label helper
    (mirrors backend step 2) and use it wherever role is shown or chosen: Layout
    user chip (`Superadmin`/`Admin`/`Developer`/`Awaiting role` instead of
    `Administrator`/`User`, `Layout.jsx:296`), the Users page role `Select` (offer
    Superadmin **only to a superadmin actor**; Admin/Developer to admins; a Pending
    badge for un-assigned users), the new-user form default (`developer`,
    `Users.jsx:37`), and Profile.
13. **MOBILE_FIRST** for every touched page/component (`Users.jsx`, `Layout.jsx`,
    `Projects.jsx`, `ProjectDetail.jsx`, the new `/awaiting-role` page, the
    share-members dialog): 44px targets, single-column at 360px, dialogs completable
    on a 360px screen. Run the pre-merge checklist.

### Tests (stub-first — import the pure modules, never `db.js`)

14. Cover: `effectiveRole` mapping (all four states); admin cannot edit/reset/
    delete/promote a superadmin; only a superadmin grants superadmin; last
    superadmin is not removable; the Zod → `{role, is_superadmin}` translation;
    pending gets 403 on admin, developer, and Mock2 project routes and `[]` from
    `getAccessibleServices`; a developer can create a project and add a member; an
    admin still bypasses with `acting_as_admin`. No NEW failures beyond the known
    native-module ones in `docs/known-issues.md` (`cves`, `incus`, `webauthn`,
    `vpn-mtu`).

## Do NOT

- Do not edit any applied migration (500 or earlier) or the seeded Mock2 v1 row.
- Do not put `is_superadmin` in the JWT (keep the DB-lookup pattern).
- Do not introduce a literal `superadmin` role value (Option B keeps it as the
  `is_superadmin` flag).
- Do not open the operator surfaces (Firewall/VPN/SSH/Incus/Housekeeping/Users/
  Dashboard) to developers or pending users.
- Do not weaken ADR-001 (Mock2 absence) — none of this mounts on a disabled host.

## What "done" looks like

Bootstrap account is a **Superadmin**. A **Superadmin** can create users and assign
any role including superadmin, and cannot be removed while last. An **Admin** can
manage services/LXC/VPN/etc. and can create users and assign admin/developer/
pending, but the Users page refuses to edit, reset, demote, delete, or promote a
superadmin and offers no "Superadmin" option. A **Developer** logs in **straight to
Projects**, sees only projects they own or are a member of and services shared with
them, can **create a project and add/share collaborators** on it, and gets 403/
hidden nav for every operator surface. A **Pending** user can sign in but sees only
the awaiting-role screen until an admin assigns a role. `cd admin/backend &&
node --test 'src/__tests__/*.test.js'` shows no new failures; `cd admin/frontend &&
npm run build` passes; the MOBILE_FIRST checklist is green.

Commit as `rbac: three-tier roles (superadmin/admin/developer) + pending`. Before
finishing, write `docs/rbac/ADR-011-three-tier-roles.md` recording the Option B
choice + LDAPS/ADR-007 rationale, the admin-cannot-touch-superadmin rule, the
developer create/collaborate scope, the developer landing route, and the pending/
LDAP onboarding flow.
