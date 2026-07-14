# Component library (Projects / Mock2)

Reusable, versioned building blocks the AI build runner is offered so a
recurring need — the canonical example is an LDAPS connection/auth module — is
met by reusing ONE audited implementation with minimal glue, instead of a fresh
AI rewrite per project. Consistency, quality, and near-zero token cost for
anything the library already covers.

## Model

Three tables in `mock2.db` (migration 516, `admin/backend/src/mock2/migrations.js`):

- **`mock2_components`** — the registry row: a stable `key` (`ldaps-auth`),
  display name/description/category/tags, and a lifecycle `status`:
  - `draft` — visible in the library UI, not offered to builds
  - `published` — offered to every build cycle
  - `deprecated` — kept for history, no longer offered
- **`mock2_component_versions`** — append-only content: `files_json`
  (`[{path, content}]`, relative paths only, size-capped), `usage_md`
  (integration notes: env vars, exports, where the glue goes), and a
  **required `change_reason`** — every version is annotated with WHY it exists.
  Content is immutable per version; revert = a NEW version carrying the old
  content (the framework-registry idiom, ADR-003).
- **`mock2_component_submissions`** — the in-platform promotion path (below).

Code layout follows the house pattern: `component-logic.js` (pure rules —
path/size/key validation, export/import parsing, catalog prompt assembly,
unit-tested stub-first in `__tests__/mock2-components.test.js`) +
`components.js` (the thin better-sqlite3 half).

## How builds use it

- **Hand-rolled runner** (`runner.js`): the published catalog (key, name,
  description, tags, version) is appended to the system prompt
  ("Component library — reuse before you rebuild"), and a `get_component`
  tool returns a component's full files + integration notes on demand
  (published components only; result truncated to a prompt budget).
- **SDK runner** (`runner-sdk.js`, `BUILD_RUNNER=sdk`): the same catalog rides
  in the generated `.claude/CLAUDE.md`, and full sources are materialized as
  reference copies under `.claude/components/<key>/` (+ `USAGE.md`) in the
  local checkout — readable by the SDK's own tools, and excluded from the
  push-back so nothing leaks into the project's committed tree.

The runner is instructed to copy component code into the app source and adapt
only the glue — never to import from the reference location.

## HTTP surface (`/api/mock2/…`)

Reads are open to any authenticated user; writes are admin; delete is
admin + sudo. All mutations are audit-logged.

- `GET/POST /components`, `GET/PATCH/DELETE /components/:id`
- `GET /components/:id/versions`, `GET /components/:id/versions/:vid`
- `POST /components/:id/versions` (new version — `change_reason` required)
- `POST /components/:id/versions/:vid/revert`
- `GET /components/:id/export` — portable JSON document
  (`proxypilot-component@1`), downloadable
- `POST /components/import` — new key creates the component; an existing key
  appends a new version (annotated as an import)
- `POST /projects/:id/component-submissions` (project editor) — propose files
  inline, or by `paths` read server-side from the RUNNING project container
- `GET /projects/:id/component-submissions` (member) — track outcomes
- `GET /component-submissions[?status=]`, `GET /component-submissions/:id`,
  `POST /component-submissions/:id/review` (admin) — approve into the library
  (new component, or new version of the targeted one) or reject with a
  required reason

## Submission flow (promote from a project, no code deploy needed)

1. A project editor proposes code — a new component, or a new version of an
   existing one — with notes for the reviewer. Admins get a notification.
2. An admin reviews the files in the UI and approves (optionally overriding
   key/name/tags) or rejects with a reason the submitter can see.
3. Approval writes the component/version; the next build cycle on any project
   is offered it automatically. Nothing about this requires updating
   ProxyPilot itself.

## Example component

`docs/features/examples/ldaps-auth.component.json` is a complete, importable
example — the canonical LDAPS auth module (search-then-bind, bounded connection
pool, RFC 4515 escaping, group extraction) in `proxypilot-component@1` format.
Import it via **Projects → Components → Import** (paste the JSON), or:

```bash
curl -sS -X POST https://<host>/api/mock2/components/import \
  -H 'Content-Type: application/json' \
  -H "X-CSRF-Token: $CSRF" -b "$COOKIES" \
  -d "{\"doc\": $(cat docs/features/examples/ldaps-auth.component.json), \
       \"change_reason\": \"Seed the library with the LDAPS example\"}"
```

Re-importing after editing the document appends a new annotated version of the
same component (matched by `key`).

## UI

`/projects/components` (`admin/frontend/src/pages/ComponentLibrary.jsx`),
linked from the Projects landing page: browse/view (files + annotated version
history), create, publish new versions, revert, deprecate/publish, delete
(sudo), export/import JSON, propose from a project, and the admin review inbox.
