# mock2-core 1.38.0 → 1.39.0: the application foundation stack (upstream amendment package)

*Drafted 2026-10-24 in ProxyPilot. **Not published.*** Nothing here has been sent to
git.fractionate.ai or mock2.fractionate.ai. Publishing is the user's decision; ProxyPilot's
site publish path (`/opt/app/site/.publish` on the `mock2` guest,
`docs/mock2/standards-and-cpr.md` §3) was not used.

## Why

The user decided on 2026-10-24 (`docs/features/app-foundation.md`):

1. Every new application is provisioned with the foundation on its guest as a Docker Compose
   stack: PostgreSQL 18.6 + pgvector 0.8.7, SeaweedFS S3 (any S3-compatible provider can replace
   it, for example Cloudflare R2), and a local embedding model by default, with a warning to switch
   to OpenAI or another provider. Each can be turned off.
2. The off switch is per deployment, per feature. Turning off never deletes data. Bundled storage
   that holds objects cannot be turned off until the person picks a replacement S3 and either
   copies everything (verified) or deliberately starts fresh. An embedding model or dimension
   change re-embeds into a new validated index before switching.
3. All passwords and keys are handled encrypted in the database, never in env files.
4. No application is built with SQLite unless the user explicitly asked for it, recorded by a
   person on the project; a builder cannot create the exception.
5. The Mock2 / PRO standard says all of this.

ProxyPilot now says it in its own constitution §2 (a platform contract the pinned guidance does
not supersede). The upstream text still leaves these gaps, which this package closes:

| Gap in 1.38.0 | Where | Closed by |
| --- | --- | --- |
| The stack is chosen per profile; PRO is only the "intended default"; a repository may record `Profile: none`; adoption never rewrites a stack | `core/claude/CLAUDE.md` §9, `profile-cpr.md`, PRO current §D | a new application records `cpr` with the foundation stack; `none` and stack deviations are for existing repositories only |
| Only "SQLite as the production database" is rejected | Addendum A.8, `mock2-cpr.md` | SQLite refused for any server role unless the developer's explicit request is recorded by a person (PRO current §W.6 rule 2) |
| "Generator execution itself never provisions external services"; "do not add unused services"; "declaring AI alone does not select" embeddings | PRO current §W.3, §R; `AI-Data-Standards.md`; `profile-cpr.md` | the foundation stack is the application's own deployment unit, provisioned by the host with it; generation still provisions nothing; its presence still selects no feature |
| The J.9 capability catalog has no database, object storage, embeddings or vector entries | PRO current §J.4, §J.9 | entries `database`, `object_storage`, `embeddings`, `vector_search` with all J.4 fields (§W.6) |
| Automatic sunset replacement and provider failover; a first-class mock provider | Addendum A.2 | never across embedding spaces; mock and local providers report themselves and are never production-ready |
| pgvector optional ("when used") | `stack.versions.json`, `Stack-Versions.md` | required for new PRO applications; the stack's images pinned |
| Application secrets "come from the environment"; the generated README puts the setup key in `.env` | `mock2-security.md`, `foundation/README.md.tpl` | a deployed instance reads no secret from an env file; the host delivers them sealed |
| `DATABASE_URL` is required, but any value is accepted | `foundation/server.ts.tpl` | it must be a PostgreSQL URL |
| Modules may carry their own drivers and clients | `.mock2/modules.md` (§Z) | the host adapters are the supported implementations of the four capabilities |

## What is in this folder

- `mock2-core-1.39.0.patch` — one unified diff (`a/` → `b/`, paths from the mock2-core root) for
  all 14 changed files. This is the change.
- `files/` — full replacement copies of the five files that change most, for review: identical to
  the result of the patch.

No file is added or removed upstream, so the manifest's file list does not change.

## The exact file list

Base: mock2-core **1.38.0** (2026-10-24), `release.json` sha256
`7a6afa51dd45666280033738081257d460ee98bb6f3a4e36684a15865f73cf1c`, `manifest.json` sha256
`3c42aabe54ae0d17a272f135e943e567ac8fdd324e8b48e22ff833c2ca4b9261`. Every base file below was
downloaded from https://mock2.fractionate.ai on 2026-10-24 and matched its `release.json` hash
and size before it was edited.

| File | 1.38.0 sha256 | Result sha256 | Form here |
| --- | --- | --- | --- |
| `core/claude/CLAUDE.md` | `a7142615332e9314f26b292663569f1f257dc8b1d6d994e085fa33b46f318d5e` | `cd226a78a77d465ca28e7cdf379c83dd728b9864f49a68f045df3a138f4d38af` | diff |
| `core/claude/rules/mock2-cpr.md` | `504f3b8131dd925ce357dcb9b189f604f028bf49584e15b5fc0d6fcfad68094e` | `4ff6d14b39f1d0c03c71dba1b3a626e0348ad696ea8324a641d63bff45a99fee` | diff |
| `core/claude/rules/mock2-security.md` | `0f76c659872f6e475ad96cabf982d896218ef4ee154b42e007491f59a5bb1fc6` | `79b5ec47284112aec126f10c3fd912024004de321b384d8efd118a00f5a7a218` | diff |
| `core/claude/rules/mock2-stack-ai.md` | `85bf220fef868973abeb2f657a3df291c031e41d7a694bcb32adfc2a1b0b1d51` | `fe58b71e6df7ade5b0809caf55612225c8f7af144f05e3465e128bde1ef0e12d` | diff |
| `core/cpr/AI-Data-Standards.md` | `b916f3c9a2d093ab0f19391c2234cdbd20457317b12f03aa6fc9a6327fcd76c6` | `40cc61f1ae23203b333b2cff02509a55acc2bfef41d97ecdbe929b285d9ff42e` | diff + full |
| `core/cpr/CPR-v1.1-addendum-A.md` | `bb7dfb4b7fcfffe862e9dbc1c5828aebc92eda2a45d9e6bdd61a6fd1d014203f` | `d1ea0e1602a1c28b01d3b369bbd1c0f55f7cc88bb0f5d7ff4441be4b4cedc62c` | diff |
| `core/cpr/CPR-v1.1-current.md` | `cfa32d3f6a4b07eb9fc86a05d60b7f1bd405a53fd0ee3dfdf7dd18654c10a0b6` | `af2b5bdd7d1269000cae939a6e9886393b7e000ca00271166e12f5af337c1ec7` | diff |
| `core/cpr/Stack-Version-Table.md` | `d62905897c8b2ddd181c0ea0cb4ebe9bdbbfd533876bedd5be08d1b33b1074f0` | `75aee4f15479ea3c0476b63af7fb8603c2c96fb4d0043284a40c80021d5e0123` | diff + full (generated) |
| `core/cpr/Stack-Versions.md` | `84d6243c5fd2f0f6aa42afbd9128f9768ed52c631606a35b57c570e9ab9ceb92` | `d70313c72fe9130fa00742e6e77306a9b6ee3e120557f70e9edb4a9ed6809a3b` | diff + full |
| `core/cpr/stack.versions.json` | `830ccdc1fd64e986bf0e4e67811849456d7307006fd63601b82e806a32585066` | `f3d01e08d656bb005488c8b5b7f3d11fbcaf4ccf7d3516d3ed54d9054fd2e41d` | diff + full |
| `core/mock2/profiles/profile-cpr.md` | `91113d06344838b765b93b9f00c44445d99afaf154e6c8ae8de6cb981191c281` | `1799511f246a04d7f48715862428696b5f9e9ac4a66875e33c71fcd0cd3f397d` | diff + full |
| `core/mock2/templates/repo/.mock2/foundation/README.md.tpl` | `25e33513cbe7a0dd69d21dfdd77c791645abadc2923696a01886b7804b9e69b3` | `d7a032dc73808de5eb0a0a712a1e89562100dd3b3fa62eceb770960feecf3167` | diff |
| `core/mock2/templates/repo/.mock2/foundation/server.ts.tpl` | `e5c3aaebeb28f14cac5d2c17b53a1744ea6e5c1abb1af8ab76c807eb10f4927d` | `64fec0772dd36505ea659358f9eb0d6d6554ec41a21dd50198db6c25960dd728` | diff |
| `core/mock2/templates/repo/.mock2/modules.md` | `bcfc8062bd6aee9020e705a8a60b0d2f1803aca9ee4e33f81063e0e783127d15` | `cae86a270f102fb8ae97750703ea57446c2079078f606861ef1e20d8c784f3fc` | diff |

What each change says, in short:

- **PRO current** — new **§W.6 The application foundation stack**: the stack (the database over a
  local socket with peer authentication; its one loopback listener admits only the read-only
  reporting role, with SCRAM, and refuses every other role), eight numbered rules (one database
  with no fallback; no SQLite or other engine without a recorded request; adapters are the only
  path; secrets encrypted by the host; switches never delete data; one vector space per index;
  readiness is a real operation; scope, and what moving an existing application onto the stack
  guarantees: a confirmed plan with blockers first, a restorable snapshot before any change,
  stated downtime, the database dumped, restored and verified table by table, secrets into the
  host's encrypted store, the foundation module installed, deploy and health check, rollback to
  the snapshot on failure or on request, nothing deleted) and the four catalog entries with every
  J.4 field. Dated amendments in the preamble and in §D, §J.4, §J.9, §Q, §R and §W.3.
- **Addendum A** — A.2's automatic replacement and failover never cross embedding spaces; mock and
  local providers report themselves; A.8 refuses SQLite for any server role. Marked "Narrowed in
  1.39.0"; the rest is kept as published.
- **`profile-cpr.md`** — the profile of every new PRO application, on the foundation stack; the
  database, storage, embeddings and secret rules in *Server*; fakes and real-database testing in
  *Tests*; `foundation/` in the layout.
- **`AI-Data-Standards.md`** — pgvector from creation; index validation before a switch; explicit
  model and dimensions; storage provider switches with verified copy or deliberate fresh start;
  a new *Readiness is a real operation* section.
- **`stack.versions.json`** (+ the generated table and `Stack-Versions.md`) — `pgvector`,
  `docker-engine` and `docker-compose` selected (not optional); new systems `seaweedfs` 4.48,
  `text-embeddings-inference` 1.9.4, `local-embedding-model` `BAAI/bge-small-en-v1.5` (384) and
  optional `openai-embeddings` `text-embedding-3-small` (1536), each with its image where it has
  one; compatibility entry `foundation-stack-2026-10-24` marked `pending-evidence`;
  `Stack-Versions.md` states the move's core guarantees and points to §W.6 rule 8.
- **`core/claude/CLAUDE.md` §9** and the rules `mock2-stack-ai.md`, `mock2-cpr.md`,
  `mock2-security.md` — the same rules in the always-loaded text.
- **Generator templates** — `server.ts.tpl` refuses a non-PostgreSQL `DATABASE_URL`;
  `README.md.tpl` keeps `.env` for a local development run only and names the foundation stack.
- **`.mock2/modules.md`** — a new *Host adapters for data, objects and embeddings* section.

Every new rule is checkable: a file path, a package name, a listed command, a status value, a
field in `stack.versions.json` or a probe operation.

## 1.39.0 manifest and changelog entry

Set `"version": "1.39.0"` and `"updated"` to the publish date in `manifest.json`, and put this
entry at the front of `changelog` (followed by a space and the existing `1.38.0: …` text):

> 1.39.0: The application foundation stack. Every new PRO application is provisioned by its host
> with PostgreSQL 18 + pgvector, S3-compatible object storage (SeaweedFS by default; any
> S3-compatible provider such as Cloudflare R2 instead) and a local embedding service (development
> quality, with a warning to switch to OpenAI or another provider), as one Compose unit in its own
> deployment. The database is reached over a local socket with peer authentication; its only network
> listener, on loopback, admits just the read-only reporting role, with SCRAM. Storage and
> embeddings switch off per deployment and no switch deletes data; bundled storage that holds
> objects stays on until a person picks a replacement and either copies everything, verified, or
> deliberately starts fresh. An embedding model or dimension change
> re-embeds into a new validated index; vector spaces are never mixed and failover never crosses
> them. Feature code reaches objects, embeddings and vector search only through the host's
> adapters. Secrets are held encrypted by the host, never in env files. Readiness is reported
> only after a real operation, and mock and local providers say what they are. SQLite and other
> engines are refused for any server role unless the developer explicitly asked and a person
> recorded the request on the project; DATABASE_URL is required and a missing database fails
> start-up, never a fallback. A new application records Profile: cpr; none is for existing
> repositories. pgvector is required for new applications and the stack's images are pinned.
> Existing applications are not changed; moving one onto the stack is a migration a person
> confirms, from a restorable snapshot, with the database verified table by table, rollback on
> failure or on request, and nothing deleted (PRO current §W.6; §D, §J.4, §J.9, §Q, §R, §W.3;
> Addendum A.2, A.8).

`release.json` and the generated copies under `core/mock2/templates/repo/.mock2/standards/` are
produced by the publish flow ("Generated; do not hand-edit"), so they are not in this package.

## Order to apply

1. In a clean mock2-core checkout at 1.38.0, check the base hashes in the table above
   (`sha256sum <file>`). Stop if one differs: the package was drafted against other bytes.
2. From the repository root: `patch -p1 < mock2-core-1.39.0.patch` (or `git apply`).
3. Check the result hashes in the table. `files/` holds the same bytes for the five full copies.
4. Regenerate `core/cpr/Stack-Version-Table.md` with the project's own generator and confirm it
   matches the copy here (this one was rendered by a generator that reproduces the 1.38.0 table
   byte for byte).
5. Edit `manifest.json` as above and run the normal publish flow, which regenerates
   `release.json` and the repo-template copies. Review the published site.
6. In ProxyPilot, adopt the new release with
   `node scripts/sync-mock2-guidance.mjs <release-directory>` and bump the seed records as
   `docs/mock2/standards-and-cpr.md` §3 says. Constitution §2 sits above the pinned marker and the
   header line comes from `pinnedGuidanceHeader()`, so both survive the re-pin. Then move the
   `local_amendments` entry in `framework-seed/standards-version.json` to `adopted`.

## Verified here, and not

- Verified: each base file matched `release.json`; the patch applies cleanly to those bytes and
  reproduces the result hashes; the table generator reproduces the 1.38.0 table exactly; the image
  tags `pgvector/pgvector:0.8.7-pg18`, `chrislusf/seaweedfs:4.48` and
  `ghcr.io/huggingface/text-embeddings-inference:cpu-1.9.4` exist (registry lookups,
  2026-10-24; `cpu-1.9.4` resolves to the index digest
  `sha256:2538ea1c9640d3763b15af668039d24172d063b42337b0c27796fc2be180c78d`, and there is no
  `cpu-1.9.5`). The package was regenerated on 2026-10-24 with `diff -u` against the
  hash-verified 1.38.0 bytes after the TEI pin moved from 1.9.0 to 1.9.4, and again on 2026-10-25
  (the base re-downloaded and matched against the same `release.json`) after §W.6 gained the
  read-only reporting role's loopback listener and the guarantees of moving an existing
  application (rule 8, echoed in `Stack-Versions.md`); `stack.versions.json` parses and its pins match ProxyPilot's
  `admin/backend/src/mock2/foundation-contract.js` (`mock2-upstream-foundation-package.test.js`).
- Not verified: the model page for `BAAI/bge-small-en-v1.5` (huggingface.co was not reachable from
  the drafting session); any run of the stack (`foundation-stack-2026-10-24` stays
  `pending-evidence`); upstream's own tests and publish flow; the site rendering.

## Decisions for the owner

- **Baseline id.** The package keeps `cpr-2026-10-03`, as 1.23.0 did when it added `drizzle-zod`.
  Making `pgvector` and the Compose runtime required may instead deserve a new dated baseline
  (`cpr-2026-10-24`).
- **Local development secrets.** The package lets a local development run keep throwaway values in
  a private `.env` and forbids env-file secrets on every deployed instance. Decide whether local
  runs must also avoid `.env`.
- **Generator follow-ups, not in this package:** `.mock2/bin/base-app.mjs` still writes
  `BOOTSTRAP_TOKEN=` into `.env.example`; `modules.mjs plan` does not yet report direct clients;
  the rule-2 check is a host follow-up upstream (ProxyPilot's is `constitution-lint`, per
  `docs/features/app-foundation.md`); an
  `@aws-sdk/client-s3` pin should be added from ProxyPilot's scaffold once that is merged.
