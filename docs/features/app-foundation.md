# Application foundation (Mock2, 2026-10)

Every new Dev Studio application starts on the same foundation, provisioned in its own
guest as one Docker Compose stack. It is not optional guidance and it is never replaced
by a simpler stack by default.

| Service | Bundled default | Swappable for | Switch |
|---|---|---|---|
| `postgres` | PostgreSQL 18.6 + pgvector 0.8.7 (`pgvector/pgvector:0.8.7-pg18`) | — (system of record) | always on |
| `storage` | SeaweedFS S3 (`chrislusf/seaweedfs:4.48`), private bucket `app` | any S3-compatible endpoint (Cloudflare R2, AWS S3, B2, MinIO, …) | per deployment |
| `embeddings` | local text-embeddings-inference, `BAAI/bge-small-en-v1.5`, 384 dims — **development quality, warned** | OpenAI, or any OpenAI-compatible provider | per deployment |

The shared names, shapes and formats live in one module:
`admin/backend/src/mock2/foundation-contract.js`. Anything below that disagrees with it
is a bug in this document.

## Decisions (user, 2026-10-24)

1. Always install/provision the foundation on the guest as a stack (Docker Compose). It
   can be turned off. Embeddings start on a **local** model with a warning to switch to
   OpenAI or another provider.
2. The off switch is **per deployment**, per feature (storage, embeddings).
3. All passwords and keys are handled **encrypted in the database**, never in env files.
4. No application is built with SQLite in future unless the user explicitly asked for it.
5. The Mock2 / PRO standard is updated to say all of this.

## Guest layout

- The guest is created Docker-ready with the same five settings `create_lxc_container`'s
  `docker_ready` uses: `security.nesting=true` and the syscall intercepts `mknod`,
  `setxattr`, `bpf` and `bpf.devices`. The setup script installs Debian 13's `docker.io`,
  `docker-compose` and `postgresql-client`. For a foundation project a failed install
  fails provisioning; it is not best-effort.
- `/opt/mock2-foundation/compose.yaml` (+ Postgres `pg_hba.conf` / `pg_ident.conf`)
  is **platform-owned**, generated from the deployment's state in mock2.db. The app
  repository carries a portable copy at `foundation/compose.yaml` so the same unit runs
  outside ProxyPilot; the guest never reads the repo copy.
- All three services are always defined, and images are pinned by digest under the
  contract tags. Bring-up starts `postgres` and `storage`, plus `embeddings` only when it
  is on and local. It then `stop`s whatever is off. Storage is always started once, so its
  identities exist before it can be reached. A service that never started is created the
  first time it is turned on. The app's runtime never calls `docker compose down -v`, and the harness
  refuses it, together with `docker volume rm` and `docker system prune`.
- Postgres listens on **no TCP port**. Its socket is bind-mounted at
  `/run/mock2-foundation/postgres`; `pg_hba` allows only `local … peer` with the ident
  map `root → app` and `root → postgres`. There is no database password to store. The
  image's first-start scripts run as the container's postgres user (uid 999) through a
  temporary mapping that is deleted when initialization ends, so a guest account that
  happens to have uid 999 is refused. `DATABASE_URL = postgres:///app?host=/run/mock2-foundation/postgres&user=app`
  goes in the unit as an ordinary `Environment=` line.
- SeaweedFS S3 and the embedding server are published on `127.0.0.1` only (8333 / 8088).
  The bundled S3 has two identities: `app` (read/write/list on bucket `app`) and a
  host-only admin identity, both stored in SeaweedFS's filer and set over stdin only.
  Re-applying an identity replaces its key, and the old key stops working. Anonymous
  requests get 403, and the app key is limited to bucket `app`.
- `/etc/mock2-foundation/master.key` (0600 root) holds the deployment master key: 32
  random bytes, which is a key and not a password. It is the one root of trust in the
  guest, and mock2.db holds an encrypted escrow copy.

## Secrets

- **mock2.db is the source of truth.** `mock2_foundation_secrets` stores each value
  encrypted with `lib/secrets.js` (`TOTP_ENCRYPTION_KEY`), the same scheme as backup
  destinations.
- **The app database is the delivery path.** The host seals every `app` secret under the
  master key (`sealForApp`, AES-256-GCM, with the secret name as AAD), upserts it into
  `mock2_foundation.secrets` as the superuser over the socket, bumps the generation and
  sends `NOTIFY mock2_foundation_changed`.
- **Host-only secrets are never synced:** the master key and the bundled S3 admin
  identity.
- **Component secrets:** values minted for installed components (for example a session
  signing key) are stored as `component.<ENV_KEY>` for foundation deployments, instead of
  being written to `/etc/environment`. The app's foundation bootstrap loads first and
  places them into `process.env` in memory, so existing components keep reading
  `process.env.<KEY>`.
- **Credentials are write-only through the API.** Responses carry `has_secret` and never
  a value.

## Feature switches and their rules

Feature state, provider and config are rows in mock2.db, mirrored into
`mock2_foundation.features`. A switch that changes the provider is staged as `pending`,
tested from inside the guest, and only then promoted.

**Storage**

- **Bundled, empty → off:** allowed. The container is stopped and its volume kept.
- **Bundled, holding objects → off:** **refused** (`STORAGE_HAS_OBJECTS`). The person must
  pick an external S3 and choose either:
  - `mode: copy` — a resumable `storage_migrate` job copies every object, verifies size
    and sha256 on the target, and only then promotes the external provider and stops the
    bundled container. After each copy pass it lists the source again, until a listing
    finds nothing new (at most 5 passes; otherwise `SOURCE_STILL_CHANGING`). The host
    polls the job every 3 s and promotes as soon as it succeeds. Objects written between
    the last listing and the app's reload are not copied; they stay in the preserved
    bundled volume. Or
  - `mode: fresh` — with `acknowledge: true`, the external provider is promoted
    immediately. The existing objects stay in the preserved bundled volume, and turning
    bundled back on brings them back.
- **External → bundled:** the same choice in reverse (copy, or fresh).
- **External → off:** allowed. Nothing on the external provider is touched.
- **Off → on:** starts the same container on the same volume.

**Embeddings**

- **On → off:** stops the local container if it is in use. Vectors stay in Postgres, and
  search answers `EMBEDDINGS_OFF`.
- **Off → on:** with the same provider, model and dimensions, search is available again
  at once.
- **Provider, model or dimensions change:**
  - a `reembed` job builds a NEW index table (`mock2_foundation.vec_<id>`) from the stored
    content of the active index;
  - it validates the new index: item count, dimensions, and a self-retrieval sample;
  - it then marks it `ready`, and the host promotes it: new index `active`, old index
    `retired` and kept for rollback, `pending` provider becomes the active one;
  - if the local model is no longer used, its container is stopped.
- **Missing credentials** (for example OpenAI with no key) is reported as
  `missing_credentials`, never as `ready`.
- **Local provider:** the app's admin area and the dashboard both show
  `LOCAL_EMBEDDINGS_WARNING`.

Every switch shows the `DEPENDENT_CAPABILITIES` that become unavailable. No switch
deletes data. Writes need sudo and are audited.

## Host API (`/api/mock2/projects/:id/foundation`)

| Method | Path | Body / result |
|---|---|---|
| GET | `/foundation` | `{ foundation_version, database, storage, embeddings, jobs, warnings }`. Each feature carries `{ state, provider, config, pending, health, has_secret, dependents }`. Storage adds `object_count` / `object_count_checked_at` (bundled only: the last count the host took, never a listing per request); embeddings adds `index { id, state, provider, model, dimensions, item_count }`. |
| POST | `/foundation/storage` | `{ action: 'on'\|'off'\|'switch', provider?, config?, credentials?, mode?: 'copy'\|'fresh', acknowledge? }` → `{ ok, job? }`, or 409 `{ code, message, options }` |
| POST | `/foundation/embeddings` | `{ action: 'on'\|'off'\|'switch', provider?, config?: { model, dimensions, base_url? }, credentials? }` → `{ ok, job? }` |
| POST | `/foundation/health` | runs the real probes now → the GET shape |
| GET | `/foundation/jobs/:jobId` | job progress |
| POST | `/foundation/jobs/:jobId/cancel` | |
| GET / PUT / DELETE | `/database-exception` | the recorded explicit SQLite request (below) |

- **Access:** GET needs viewer; writes need editor plus sudo and refuse archived projects.
- **Credentials:** stored credentials are reused only for the same endpoint.
- **Staging:** a switch stays staged until it tests successfully from inside the guest.
  Cancelling abandons it.
- **Refusal codes:**
  - 409: `STORAGE_HAS_OBJECTS`, `STORAGE_OBJECTS_UNKNOWN`, `SWITCH_MODE_REQUIRED`,
    `ACKNOWLEDGE_REQUIRED`, `MISSING_CREDENTIALS`, `PROVIDER_TEST_FAILED`,
    `FOUNDATION_JOB_RUNNING`, `FOUNDATION_BUSY`, `FOUNDATION_UNAVAILABLE`,
    `NOT_A_FOUNDATION_PROJECT`;
  - 400: `INVALID_REQUEST`, `INVALID_CONFIG`;
  - 404: `JOB_NOT_FOUND`.
- **Refusal extras:** `FOUNDATION_JOB_RUNNING` carries `job_id`; `STORAGE_HAS_OBJECTS`
  carries `object_count`.
- **Promotion:** runs under the same per-deployment lock as a cancel. A cancel during a
  promotion is refused busy, and a cancelled job is never promoted. Before promoting, the
  host re-checks the result itself:
  - a copy is tested again against the target, and the target's object count is
    compared with the job's;
  - a re-embed's target index is read back as superuser.

  On a mismatch nothing is switched; the job stays `running` with the reason and is
  re-checked every minute.
- **Index repair:** when the active index was built with another provider, model or
  dimensions (after a clone or a restore), GET warns `INDEX_PROVIDER_MISMATCH`, and a
  switch to the configured provider re-embeds.
- **Archive:** archiving a foundation project from the dashboard deletes its guest, so it
  is refused (409) while bundled storage holds objects or cannot be counted. Copy the
  objects to an external provider or export them first. Archiving over MCP stops and keeps
  the guest, so its volumes survive.
- **Clones:** a clone mints its own component secrets. Only a full clone keeps the keys
  that protect the data it copied, and it takes the source's non-secret embeddings
  settings, never its key.

## Generated app side

The scaffold gains a platform-owned `foundation/` module: plain ESM with type
declarations, so the app's TypeScript and the CLI share one implementation. It provides:

- a bootstrap: reads the master key and the features and secrets from the socket DB,
  retries for up to 60 s after a guest restart, then fails loudly;
- a `storage` adapter (`@aws-sdk/client-s3`, any S3-compatible endpoint);
- an `embeddings` adapter (OpenAI-compatible HTTP: local, OpenAI and others);
- `vector` helpers: upsert/search/delete in the active index, plus the index registry;
- health probes, and the CLI `node foundation/bin/foundation.mjs` (commands in
  `FOUNDATION_CLI_COMMANDS`).

Feature code uses these adapters only. A direct S3 client or embedding HTTP call in
feature code is a deviation.

**Load order.** The app's `start` and `dev` scripts run
`node --import=./foundation/runtime/bootstrap.mjs …`. An `import` line at the top of the
entry is not enough: ESM runs sibling imports while an earlier one is still awaiting.

**Missing master key.** If the key file is missing, the app still starts and the
database works. Storage and keyed embedding providers report `MISSING_MASTER_KEY`; the
local model needs no key.

**Health route.** The admin-only `GET /api/foundation/health` returns the statuses and
the local-model warning, and the platform admin area shows them.

**Re-embed validation.** A sample of up to 50 items is checked, and at least 90% must
come back in the new index's top 5.

**Repository copy.** The repository's `foundation/compose.yaml` ships with its
`foundation/postgres/` files, so the same unit runs outside ProxyPilot.

## Dashboard

Dev Studio → project → Details → Build → *Application foundation*
(`components/mock2/ProjectFoundation.jsx`, with its rules in `foundation-panel-logic.js`).
It shows:

- health per feature;
- Turn off, which lists what becomes unavailable and deletes nothing;
- Switch provider: storage asks for copy or fresh plus an acknowledgement, and embeddings
  re-embed into a new index;
- job progress with Cancel;
- 409 options offered as next steps;
- the collapsed SQLite exception.

Proof: `tests/foundation-panel.browser.mjs`, against a mocked API.

## No SQLite without an explicit request

- PostgreSQL is the only application database.
- The `constitution-lint` check runs in **every** build tier. It reads source and
  `package.json` and refuses `sqlite3`, `better-sqlite3`, `node:sqlite`, `bun:sqlite`,
  `@libsql/*`, `libsql`, `sql.js`, `drizzle-orm/*sqlite*`, PGlite as a server database,
  and other engines.
- A build that introduces one cannot finish.
- **Exception:** the person records, on the project, that they explicitly asked for
  SQLite, with their own words (`/database-exception`, sudo, audited). The prompts then
  quote that request. Nothing the builder writes into the repository can create it.
- **What the gate also catches:** `DATABASE_URL` literals starting `sqlite:` or `file:`,
  and a `src/` with no `package.json`. In foundation apps it also refuses (rule 5)
  source outside `foundation/` that imports an S3 SDK or `minio`, or that calls an
  embeddings API directly.
- **How the host runs it:** the host sets `MOCK2_DATABASE_EXCEPTION` and `MOCK2_FOUNDATION`
  (from `projects.foundation_version`) from mock2.db only.
  - On a foundation project the check refuses these engines in every tier.
  - In an app created before the foundation, an engine already in the repository is
    reported as an advisory, and the full build still refuses the `src/` imports it
    refused before.
  - An engine a build adds blocks in every tier and at finish.
- **Finish guard:** compares against the commit the cycle started from. The command policy (`harness-safety.js`)
  refuses installs of these packages, and anything that tears down the foundation stack
  or deletes its volumes.
- **`foundation/` is platform-owned.** A foundation-project build that changes it cannot
  finish, and the platform puts the files back, also before every checkpoint. Files that
  hold exactly the base-app upgrade's bytes are exempt.
- **Standards:** constitution §2 is the binding text for builders, and the appended pinned
  guidance does not supersede it. The mock2-core 1.39.0 amendment is drafted in
  `docs/mock2/upstream/2026-10-foundation/`.

## Existing projects

This applies to projects created after the revision (`projects.foundation_version` is
set). Existing projects keep their native in-guest Postgres and are never rewritten.
Their adoption path is an explicit, separate step (see Known gaps).

On foundation projects, `restore_project_db`, snapshot restores and the deploy's
pre-migration dump all go through the stack. After a restore, the platform-held rows
are re-synced from mock2.db. Build checkpoint snapshots leave out the platform tables
of `mock2_foundation`.

## Verification

- **Unit tests:** contract, logic and generators in `admin/backend/src/__tests__/`.
- **Real-stack test:** `FOUNDATION_E2E=1` runs a real Docker stack covering:
  - pgvector operations;
  - private upload and retrieval;
  - storage off/on and a provider switch with a verified copy;
  - an embeddings provider switch with index replacement;
  - missing credentials, and failure then recovery.
- **Local embedding model:** the local text-embeddings-inference image and model need
  `ghcr.io` / `huggingface.co`. Where they are unreachable, the test substitutes an
  OpenAI-compatible fake and says so. The real local model is proven on a host.

## Known gaps

- Adoption for existing projects.
- Cloning a project copies its database (vectors included) but not its stored objects.
- On foundation deploys, the stored-credential check after the deploy is skipped,
  because the keys live in mock2.db. It needs a host-side probe.
- The generated app's read-only SQL role (Admin → Integration) cannot connect: the
  foundation Postgres has no TCP listener and allows peer authentication only.
- Restoring a checkpoint taken before a re-embed can bring back an index that does not
  match the current embeddings provider.
- The local embedding model is proven only where its image and model can be fetched.
