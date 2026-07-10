# ADR-011 — Three-tier roles: superadmin / admin / developer (+ pending)

**Status:** Accepted
**Supersedes the two-tier model** (`admin` / `user`) established in the core
schema; builds on **ADR-007** (`users.is_superadmin` as a durable local
break-glass marker).

## Context

ProxyPilot shipped a two-tier role model: `admin` (full control) and `user`
(granular, share-based service access). Two forces made that insufficient:

1. **A support tier is needed.** Operators want staff who can run the whole
   platform — services, LXC/Incus, VPN, firewall, SSH, backups, CVEs,
   housekeeping, terminal, and the Mock2 admin surfaces — **without** the
   ability to touch the most privileged accounts or platform-defining settings.
2. **The `user` tier is really a developer tier.** The Mock2 (AI-assisted dev)
   flow re-centres the non-operator role on building projects, not on being a
   passive viewer of proxied services.

A future **LDAPS** integration will provision accounts automatically. Such an
account must be able to sign in but reach nothing until a human grants it a
role — and the role-sync must never be able to strip the platform's last
all-powerful account.

## Decision — Option B: store the split as `role` + `is_superadmin`

We model **four product roles** but store only **two orthogonal facts**:

| Effective role | `users.role` | `users.is_superadmin` |
|---|---|---|
| **superadmin** | `admin` | `1` |
| **admin** | `admin` | `0` |
| **developer** | `developer` | `0` |
| **pending** | `pending` | `0` |

We deliberately **do not** introduce a literal `superadmin` role value.

### Why Option B (and not three literal role values)

- **ADR-007 / LDAPS safety.** `is_superadmin` stays what ADR-007 made it: a
  durable *local* break-glass marker orthogonal to `role`. A future LDAPS
  role-sync can rewrite `role` all day and can never strip the last superadmin,
  because superadmin-ness does not live in `role`.
- **Minimal blast radius.** Both admin tiers keep `role='admin'`, so all **89**
  `requireAdmin` call sites and the Mock2 admin-bypass (`req.user.role ===
  'admin'`) stay correct **unchanged**. The change collapses to: a rename
  (`user` → `developer`), a new inert `pending` state, generalised superadmin
  guards, a developer-scoped Mock2 opening, and a UI/label layer.
- **One vocabulary, no drift.** A single pure helper
  `effectiveRole({ role, is_superadmin })` → `superadmin | admin | developer |
  pending` is shared by the backend responses and the frontend
  (`admin/backend/src/lib/roles.js` ↔ `admin/frontend/src/lib/roles.js`), so the
  label/gating logic can never diverge. Its inverse, `roleToColumns(token)`, is
  the single source of the write-time translation.

## The roles

### Superadmin
The current all-powerful admin. Full control of everything, including other
superadmins and platform-wide settings. **Only a superadmin can grant the
superadmin role.** A superadmin cannot be modified, demoted, deactivated, or
deleted by anyone who is not a superadmin. The bootstrap account is a
superadmin (seeded `role='admin'`, then backfilled `is_superadmin=1`).

### Admin (support)
Everything an admin can do today **except touching superadmin accounts or the
superadmin grant**: cannot edit, demote, deactivate, delete, reset, or promote a
superadmin, and cannot promote anyone (including themselves) **to** superadmin.
Admins **can** add users and assign the `admin` / `developer` / `pending` roles —
this is the normal onboarding path. Every other operator surface is fully
available.

### Developer
Today's `user`, renamed and re-centred on AI-assisted development (the Mock2
Projects flow). A developer:

- **lands straight on `/projects`** after login (not the operator Dashboard);
- sees **only what they create or what is shared with them** —
  `user_service_access` for services, `mock2_project_members` for projects;
- **can create a project** (becoming its owner/editor) and **share it** —
  add/remove collaborators and set their project role (editor/viewer) on
  projects they own;
- gets `403` / hidden nav for every operator surface.

### Pending (no role)
An authenticated account with **no role assigned yet → no access to anything**.
This is the DB column DEFAULT (`role='pending'`) so any insert path that forgets
a role yields an inert account — the future LDAPS default. A pending user can
sign in but sees only the **`/awaiting-role`** screen until a superadmin or admin
assigns a real role. Every API surface and nav item denies pending
(`requireAdmin` denies role≠admin; `requireDeveloperOrAbove` denies pending;
`getAccessibleServices` returns `[]`).

## The admin-cannot-touch-superadmin rule

Generalised from ADR-007's single demote/deactivate guard into two pure
predicates in `lib/superadmin.js`, enforced on **every** mutation path in
`routes/user.js`:

- **`checkSuperadminProtection`** — a non-superadmin actor may not perform *any*
  mutation (role change, display-name edit, password reset, deactivate, delete)
  on a superadmin target.
- **`checkSuperadminGrant`** — only a superadmin may grant the superadmin role
  (set `is_superadmin=1`), whether creating or updating a user.

Plus a **last-superadmin guard**: the platform can never lose its last
`is_superadmin=1` account — demote and delete of the last superadmin are
refused, even to a superadmin actor. (A plain admin being the last *admin* is
fine; only the last break-glass account is protected.) The old "last admin"
count guard is removed in favour of this.

New middleware:

- **`requireSuperadmin`** — `role='admin' AND is_superadmin=1`, DB-looked-up
  (the JWT deliberately does **not** carry `is_superadmin`, per ADR-007; it
  mirrors `mock2/authz.js`'s lookup). Mounted where superadmin-only endpoints
  are needed. `requireAdmin` is left untouched.
- **`requireDeveloperOrAbove`** — allows `admin`/`developer`, denies `pending`.
  Gates the developer-facing Mock2 surfaces.

## Developer create / collaborate scope (Mock2)

- **Project create** (`POST /api/mock2/projects`) is re-gated from `requireAdmin`
  to `requireDeveloperOrAbove`. Creation makes the developer the owner-member
  (first editor, so the project isn't born orphaned). It still requires an
  admin-enabled parent domain to exist — a developer with no selectable domain
  sees an "ask an admin to register a domain" empty state.
- **Member management** (`POST`/`DELETE /api/mock2/projects/:id/members`) already
  runs behind `requireMock2Role('editor')`; a developer who owns a project is an
  editor and can add/remove collaborators and set their project role. Admins keep
  their `acting_as_admin` bypass into any project.
- Two developer-scoped read endpoints support the flow without exposing admin
  data: `GET /api/mock2/selectable-domains` (`{ id, domain }` of verified+enabled
  domains) and `GET /api/user/users/pickable` (`{ id, username, displayName }` for
  the share picker). Both are `requireDeveloperOrAbove`; pending is denied.
- The Mock2 status probe (`GET /api/mock2/status`) is opened to
  `requireDeveloperOrAbove` so the developer Projects nav/pages can gate on it.
- Admin-tier only, hidden from developers: parent-domain management, model/git
  connectors, quotas, the framework registry, and the admin queue.

## Developer landing route + pending onboarding

- **Landing by effective role** is centralised in the frontend auth/redirect
  layer (`App.jsx` `RoleLanding` at the index route), never per page:
  superadmin/admin → `/` (operator Dashboard); developer → `/projects`;
  pending → `/awaiting-role`.
- **Pending / LDAP onboarding flow:** a pending account (the future LDAPS
  default) can authenticate but only sees the awaiting-role screen. A superadmin
  or admin reassigns it to `superadmin` (superadmin actor only), `admin`, or
  `developer` from the Users page — the normal onboarding path. On the next
  verify the account lands on its role's home.

## Data migration

Main-DB migration **501** (`rbac_three_tier_roles`, `db.js`) widens
`users.role` from `CHECK(role IN ('admin','user'))` to
`CHECK(role IN ('admin','developer','pending'))`. SQLite cannot alter a CHECK in
place, so the `users` table is rebuilt (new table → copy rows → drop → rename)
with foreign keys disabled during the swap (`{ disableFks: true }`) so child
`ON DELETE CASCADE`s don't fire on the DROP. Data is remapped `user →
developer`; `is_superadmin` and every other column are preserved verbatim. The
new column DEFAULT is `'pending'` (inert; future LDAP safety) while the API
create path defaults to `'developer'`. Applied migrations (including 500) are
never edited.
