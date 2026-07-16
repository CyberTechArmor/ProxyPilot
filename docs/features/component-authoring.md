# Authoring a component (`proxypilot-component@1`)

The complete schema and requirements for producing a component upload file —
one JSON document that Projects → Components → Import accepts (file upload or
paste), and that `POST /api/mock2/components/import` accepts as `{ doc,
change_reason? }`. Every rule below is enforced by
`admin/backend/src/mock2/component-logic.js` (`parseComponentImport`), so a
document that follows this spec imports cleanly; one that doesn't is rejected
with the specific error quoted.

A component is a set of SOURCE files plus integration notes. It is not an
installable package: the build runner copies the files into a project's source
and writes only the glue. Package it accordingly (see "Packaging rules").

## Document shape

One JSON object, conventionally saved as `<key>.component.json`:

```json
{
  "format": "proxypilot-component@1",
  "key": "ldaps-auth",
  "name": "LDAPS Auth",
  "description": "Search-then-bind LDAPS authentication with a bounded connection pool.",
  "category": "auth",
  "tags": ["ldap", "ldaps", "auth"],
  "version": 1,
  "usage_md": "# Integration notes\n\nnpm install ldapts\n\nEnv vars: LDAP_URL, ...",
  "files": [
    { "path": "src/lib/ldaps/config.ts", "content": "import { z } from 'zod';\n..." },
    { "path": "src/lib/ldaps/client.ts", "content": "..." }
  ]
}
```

## Field requirements

| Field | Required | Rules |
| --- | --- | --- |
| `format` | yes | Exactly the string `proxypilot-component@1`. Anything else is rejected. |
| `name` | yes | Non-empty display name, max 120 chars. |
| `key` | no | Stable handle: lowercase slug, 2–64 chars, `[a-z0-9-]`, no leading/trailing or doubled meaning beyond `^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$`. Omitted → derived from `name` ("LDAPS Connection" → `ldaps-connection`). **Import matches on key**: a new key creates a component, an existing key appends a new version to it. |
| `files` | yes | Non-empty array of `{ path, content }` — see limits below. |
| `description` | no | Plain text; truncated to 2000 chars. |
| `category` | no | Short label (e.g. `auth`, `networking`); truncated to 80 chars. |
| `tags` | no | Array or comma-separated string; lowercased, deduped, each tag capped at 40 chars, max 12 tags kept. |
| `usage_md` | no (strongly recommended) | Markdown integration notes; truncated to 20 000 chars. This is what the build runner reads to wire the component in — see "What usage_md must cover". |
| `contract` | no (strongly recommended) | Machine-readable contract object — see "The contract" below. A document with an invalid contract is rejected; an absent one is fine (the component just isn't suggested or auto-installed). |
| `version` | ignored | Informational in exports. The receiving install assigns its own version number (1 for a new key, current+1 for an existing one). |

Unknown extra fields are ignored. Install-specific data (ids, authors,
timestamps) must not be included — the document is portable by design.

## File entries and limits

Each element of `files` is `{ "path": string, "content": string }`.

- **Path**: relative only, `/`-separated, max 400 chars. Rejected: absolute
  paths, backslashes, `..` segments, empty segments, duplicates (after
  normalization — a leading `./` is stripped). Use the path the file should
  have in a consuming project (e.g. `src/lib/auth/rbac.ts`).
- **Content**: must be a string — i.e. **text files only**. Binary assets
  can't ride in the document; if one is unavoidable, embed it base64 in a text
  file and note the decode step in `usage_md`.
- **Limits** (constants in `component-logic.js`):
  - max **40 files** per component,
  - max **200 000 chars** per file,
  - max **600 000 chars** total.

Large components are delivered to builds **in full**: the runner's
`materialize_component` tool writes every file verbatim into the project
source server-side (byte-exact, sha256-verified — contents never pass through
the model's context), so the 600k import ceiling is the only size limit.
`get_component` returns sources inline only while the render fits its 60 000
char budget; past that it returns the integration notes plus a complete file
manifest (path, bytes, sha256) and defers the contents to
`materialize_component` — never a silent mid-file cutoff. Small, focused
components are still preferable: the notes and manifest are what the model
actually reasons over.

## Packaging rules (what goes in `files`)

Include:
- source files (`src/…`) at the paths a consuming project should use,
- runtime assets that are text (templates, `public/*.html`, shared JS),
- tests if the target projects can run them (say so in `usage_md`).

Exclude:
- **build output** (`dist/`, `*.d.ts` generated from sources, minified
  bundles) — it's regenerable, wastes the file budget, and drifts from source,
- `node_modules/`, lockfiles, `.git/`, editor/CI config,
- `package.json` as a manifest (dependencies belong in `usage_md` as an
  explicit `npm install …` line; there is no automatic dependency install),
- secrets of any kind — documents are stored and offered to builds verbatim.

## The contract (`contract` — automation reads this, not `usage_md`)

The contract is what makes a component API-driven: the define stage suggests it
from `requires_when`, the platform installs it deterministically (no model
tokens) from `dependencies`/`migrations`/`config`/`connections`, and the build
runner wires the mockup to `api`. Every field is optional; every field is
validated (`component-logic.validateComponentContract`) and the error names the
offending entry.

| Field | Shape | Purpose |
| --- | --- | --- |
| `provides` | `["auth", "auth.bootstrap-superadmin", …]` | Capability slugs (lowercase, dot-separated) this component supplies. Max 64. |
| `requires_when` | `{ "capabilities_any": ["users","login"], "suggest_prompt": "…" }` | When the define stage should SUGGEST this component: any listed capability appearing in the inventory's `required_capabilities` triggers a tappable confirmation. `suggest_prompt` is the question shown (≤500 chars). |
| `api` | `[{ "method": "GET", "path": "/api/auth/login", "summary": "…", "auth": "public\|user\|role:admin" }]` | The HTTP surface the build wires the approved design to. Max 64 entries; paths must start with `/`. |
| `exports` | `["initAuth", "requireRole"]` | Code exports the glue may use. Names only. |
| `config` | `[{ "key": "AUTH_JWT_SECRET", "secret": true, "required": true, "default": null, "description": "…" }]` | Structured env vars. Non-secret defaults are merged into the project `.env` at install; **secrets are never written** — they surface on the operator verification checklist. Max 48. |
| `connections` | `[{ "id": "ldaps-directory", "transport": "ldaps", "optional": true, "egress": { "classification": "private", "port": 636, "protocol": "tcp" }, "config_keys": ["…"], "live_verification": { "required": true } }]` | External connections. Each is pre-declared in `state/integrations.json` at install so the truthfulness gate sees an honest manifest from cycle start. Max 8. |
| `dependencies` | `{ "runtime": ["cookie"], "peers": ["express"], "dev": ["vitest"] }` | Deterministic npm installs at pre-install time (runtime+peers regular, dev with `-D`). Keep the same lines in `usage_md` for human readers. |
| `migrations` | `{ "dir": "migrations", "renumber": "append" }` | Files under `dir` ending in `.sql` are SQL migrations: at install they are renumbered to APPEND after the project's existing `migrations/*.sql` (a same-suffix migration already present is skipped — idempotent re-install). `"renumber": "none"` writes them as-is. |

`docs/features/examples/proxypilot-auth.component.json` carries a complete,
validated contract to copy from.

## What `usage_md` must cover

The runner gets `usage_md` alongside the files and is instructed to copy the
code and adapt only the glue. Write it for that reader:

1. **Dependencies** — exact `npm install …` (or equivalent) lines, split
   runtime vs dev.
2. **Mount/wiring example** — the minimal host-side code to integrate
   (imports, init call, router mounts, schema registration).
3. **Configuration** — every env var / config key with defaults, and which are
   secrets that production must inject.
4. **Layout notes** — what each top-level directory is, which files are tests,
   anything that must be kept in sync.
5. **Security caveats** — default-off switches, trust assumptions, anything an
   integrator can get dangerously wrong.

## Import semantics (what happens on upload)

- `POST /api/mock2/components/import`, body `{ "doc": <document>,
  "change_reason": "why" }` — admin-only, CSRF-protected. The UI's Import
  dialog (upload the file or paste it) posts the same shape.
- `change_reason` is optional here; it defaults to `Imported component
  document (<key>)`. Everywhere else a version is created it is REQUIRED —
  give a real one.
- New key → new component, **status `published`** (immediately offered to
  every build cycle), version 1. Existing key → new version of that component,
  annotated as an import.
- Versions are immutable and append-only: to change anything, re-import the
  edited document (same key) or publish a new version in the UI. Revert = a
  new version carrying the old content.

## Pre-upload checklist

- [ ] `format` is exactly `proxypilot-component@1`
- [ ] `key` is a valid slug (or omitted) and — deliberately — either new
      (create) or existing (new version)
- [ ] ≤ 40 files, ≤ 200k chars each, ≤ 600k total; ideally well under
- [ ] no `dist/`, `node_modules/`, lockfiles, binaries, or secrets
- [ ] all paths relative, forward slashes, no `..`
- [ ] `usage_md` covers dependencies, mount example, config/env vars, caveats
- [ ] valid JSON (`python3 -m json.tool doc.component.json` or equivalent)

## Converting an existing module (zip/directory) into a document

Zip archives are not accepted anywhere — convert to the JSON document first.
The mechanical recipe:

1. Choose the file set per the packaging rules (typically `src/` + text
   assets, drop `dist/` etc.).
2. For each file, add `{ "path": "<relative path>", "content": "<full text>" }`
   to `files` (JSON-escape the content; any JSON library does this for you).
3. Write `usage_md` (start from the module's README if it has one).
4. Fill in `format`/`key`/`name`/`description`/`category`/`tags`.
5. Validate against the checklist, then import.
