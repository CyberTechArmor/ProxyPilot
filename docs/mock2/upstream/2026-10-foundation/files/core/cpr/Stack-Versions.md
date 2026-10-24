# Stack versions and compatibility

`stack.versions.json` is the canonical release baseline. `Stack-Version-Table.md` is generated from
it. Every baseline is immutable within a published Mock2 release; a regular review produces a new
dated baseline. Review at least monthly and on an upstream security advisory or support change.
This is a review obligation, not a new release approval gate. Check official release metadata,
support status, engine/peer requirements and migration notes before changing a pin. Never resolve
`latest`, a floating image tag, or an old remembered default during an application build.

For **new PRO applications**, select `cpr-2026-10-03`: Node 24 LTS, PostgreSQL 18 with pgvector, the
application foundation stack's services and the exact selected packages in the registry. The selected package combination has a reproducible compatibility
fixture; its evidence names the actual runtime, commands and scope. Package compatibility does not
prove a particular application's authorization, migrations, browser behavior, object provider or
production performance. Validate those affected contracts during implementation. Optional tools
are selected only when used; a pin is not permission to add a capability outside the task.

`drizzle-zod` 0.8.3 was added to the registry in Mock2 1.23.0 as an optional system, checked on
2026-10-17; the rest of the `cpr-2026-10-03` selection is unchanged. The contracts
`node .mock2/bin/gen.mjs` writes import it to derive their Zod schemas from the Drizzle table (PRO
current §K.7), so it is selected when a project uses those contracts or derives its own the same way.
Its evidence, `drizzle-zod-0.8.3-generated`, covers the generated code with the selected packages
and with one newer patch set: `tsc` clean, the generated request tests passing on their fakes,
`vite build`, and the states catalog captured by Playwright. It does not cover a PostgreSQL server,
a generated or applied migration, Node 24 (the runs used Node 22), Zod 3, other browsers or an
application's own tables; validate those where the application relies on them. Keep it on a line
whose peer range admits the project's Drizzle and Zod versions.

**The application foundation stack (added in Mock2 1.39.0, PRO current §W.6).** Every new PRO
application is provisioned with one Compose unit holding its database, object storage and embedding
service, so these are selected systems for new applications, not optional tools. `pgvector` is now
required: the database is PostgreSQL 18.6 with pgvector 0.8.7 from the image
`pgvector/pgvector:0.8.7-pg18`. Object storage defaults to SeaweedFS 4.48
(`chrislusf/seaweedfs:4.48`), replaceable per deployment by any S3-compatible provider through the
host storage adapter. Embeddings default to text-embeddings-inference 1.9.0
(`ghcr.io/huggingface/text-embeddings-inference:cpu-1.9.0`) serving `BAAI/bge-small-en-v1.5` with 384
dimensions; this local model is development quality and is reported as such. The production
provider is OpenAI through the host embeddings adapter, with the model and dimensions always explicit
(`text-embedding-3-small`, 1536), or any OpenAI-compatible provider through the same adapter.
`docker-engine` and `docker-compose` are selected because they run the unit. A model change is a
re-embedding into a new validated index (`AI-Data-Standards.md`), never a floating substitution.
The image tags were checked to exist on 2026-10-24; pin each by digest for the target architecture
at deployment. The `foundation-stack-2026-10-24` compatibility entry is `pending-evidence`: no
run of the stack is recorded in this release, so the pins are a selection, not proof that the stack
works on a given host. Existing applications are not given the foundation stack by an upgrade; moving
one onto it is an explicit migration.

For **existing applications**, capture their actual stack in project-owned `state/stack.json` and
retain its major/minor lines. Default to maintenance patches unless the developer asks to upgrade
or migrate. PostgreSQL 16 → 16.15 is maintenance; 16 → 18 is a migration. Semver 5.7.3 → 5.7.4 is
a patch; 5.7 → 5.8 and 5 → 7 need upgrade scope. For 0.x packages preserve the minor as well.
Unsupported lines and fixes available only in a newer line are explicit upgrade recommendations,
not silent migrations and not reasons to stop unrelated authorized work. If no fixed patch exists
on the retained line, say so; don't claim its vulnerability is fixed. An explicit migration request
can change the selected lines and includes the necessary compatibility/data/recovery work.

Exact versions go in package manifests and locks, runtime version files and deployment definitions.
Pin production images by digest after resolving the chosen tag for the target architecture. Record
base OS, image digest, actual database server version, enabled extension versions, migration owner,
object-store implementation, browser binaries, copied component source provenance and model/index
identities. A registry tag is not a digest and a local development version is not a deployed version.
Do not invent unknown identities. Distribution security backports retain the vendor package identity.

Use `node .mock2/bin/stack.mjs init --new` for the selected new-project inventory, or
`node .mock2/bin/stack.mjs init --existing` to capture resolved npm dependencies from a lockfile
without changing any dependency. Existing non-npm stacks record their actual versions in the same
inventory manually. Initialization refuses to overwrite an existing inventory. `stack.mjs` reports
observed lockfile drift and policy; it never installs, upgrades or changes the project's toolchain.
`stack.mjs catalog` prints the selected baseline. Add this read-only report to the existing dependency
review/check workflow where useful; do not put a new gate in front of builds or releases.

Validate a dependency update as a combination, including generated schema/migrations, route and
schema behavior, types, production build, affected browser tests and deployment/runtime images.
Update React/React DOM/types together; keep Node types on the chosen runtime line. TypeScript 7
uses the native compiler and does not supply the older programmatic compiler API: tools requiring
that API need an explicit compatible bridge/version, tested separately. Pair Playwright with its
own browser binaries. Tailwind 4 requires the documented modern browser baseline. A shadcn CLI pin
alone does not pin copied UI components: record their registry/source and content hashes.

The existing Relay reference adapter retains React 18 / Express 4 / Zod 3. Its tested package pin
is separate from the new application baseline. New React 19 / Express 5 / Zod 4 applications need a
tested compatible Relay host adapter/port; never broaden its peer ranges to conceal incompatibility.
PGlite fixtures are not proof of PostgreSQL server extension installation or a backup/restore path.

Every baseline review records source URLs, checked date, selected lines, support deadlines where
published, compatibility evidence and unresolved limits. Existing project patches update their
inventory/lock/image identities and affected evidence; installing newer standards does not migrate
their application stack. Source and generated standards are published together.
