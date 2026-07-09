# Mock2 Data Model

All tables live in **`data/db/mock2.db`** (separate SQLite file, WAL mode,
opened only when the module is enabled — ADR-001). Migrations use the same
`runMigration` framework as `db.js` but with their own registry inside the
Mock2 module, numbered in **block 500** (500, 501, …). User references are
`user_id` integers referring to the main DB's `users` table — SQLite can't
enforce cross-database FKs, so the module validates user existence at the API
layer (same as the main DB already does for several soft references).

Where state lives, by kind:

| State | Home | Why |
|---|---|---|
| Registry, memberships, locks, cycles, queue, connectors, framework, quotas, chats | `mock2.db` | Orchestrator-owned, queryable |
| `state/inventory.json`, `state/rules.md`, `mock2.yaml`, code, secrets *manifest* | Project repo | Survives archive; the repo is the recovery path (ADR-006) |
| `.env` values, dev server, project Postgres data | Project container | Disposable by design; never in repo |
| Change records | `mock2.db` (hash-chained) **and** mirrored as append-only files in the repo | Queryable + survives archive |

Conventions: `created_at`/`updated_at` are ISO-8601 TEXT like the main DB;
booleans are INTEGER 0/1; every secret column is `*_enc` via
`encryptSecret()` (`lib/secrets.js`).

---

## Migration 500 — registry, membership, routing

```sql
CREATE TABLE mock2_settings (          -- singleton key/value (lock timeout, idle-stop days, buffer pct)
  key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT, updated_by INTEGER
);

CREATE TABLE mock2_parent_domains (
  id INTEGER PRIMARY KEY,
  domain TEXT NOT NULL UNIQUE,                 -- 'dev.example.com'
  dns_provider TEXT,                           -- NULL in v1; deferred wildcard DNS-01 path (ADR-009)
  dns_credentials_enc TEXT,                    -- NULL in v1; encrypted when the wildcard path lands
  cert_path TEXT,                              -- NULL in v1; wildcard-path cert dir when it lands
  verify_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (verify_status IN ('pending','dns_ok','cert_ok','failed')),
  verified_at TEXT, last_renewal_at TEXT, renewal_error TEXT,
  enabled INTEGER NOT NULL DEFAULT 0,          -- selectable only when cert_ok AND enabled
  created_by INTEGER, created_at TEXT
);

CREATE TABLE mock2_projects (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,                          -- display only; never in URLs
  description TEXT,
  parent_domain_id INTEGER REFERENCES mock2_parent_domains(id),
  slug TEXT,                                   -- 'p-7f3a9c2e'; NULL when custom-domain project
  custom_domain TEXT,                          -- alternative to slug; admin-gated
  container_name TEXT,                         -- 'm2-<id>' (Incus name; NULL when archived)
  bridge_name TEXT,                            -- 'm2br<id>'
  repo_path TEXT NOT NULL,                     -- /var/lib/proxypilot/mock2/repos/<id>.git
  lifecycle TEXT NOT NULL DEFAULT 'provisioning'
    CHECK (lifecycle IN ('provisioning','active','stopped','archived','failed_provisioning')),
  flagged INTEGER NOT NULL DEFAULT 0,          -- the ONE manual overlay ("Flag an Admin")
  flagged_by INTEGER, flagged_reason TEXT,
  last_activity_at TEXT,                       -- drives idle-stop
  last_built_framework_version_id INTEGER,     -- drift comparison input (NOT a pin)
  framework_version_initial INTEGER,           -- point-in-time reference only
  created_by INTEGER, created_at TEXT, archived_at TEXT,
  UNIQUE (parent_domain_id, slug)              -- slug unique per parent, not globally
);
-- Everything else the UI shows as "status" (checked out / building / awaiting
-- user / awaiting admin / quota exhausted / drift / orphaned / online / idle)
-- is DERIVED from locks, cycles, open questions, queue items, quota state,
-- and membership counts. Do not add a status column for those.

CREATE TABLE mock2_slug_history (              -- never-reuse list + rotation grace
  id INTEGER PRIMARY KEY,
  parent_domain_id INTEGER NOT NULL,
  slug TEXT NOT NULL,
  project_id INTEGER NOT NULL,
  active_until TEXT,                           -- rotation grace deadline (1h); NULL = long dead
  rotated_by INTEGER, created_at TEXT,
  UNIQUE (parent_domain_id, slug)              -- reuse blocked forever by this index
);

CREATE TABLE mock2_project_members (
  project_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('editor','viewer')),
  invited_by INTEGER, created_at TEXT,
  PRIMARY KEY (project_id, user_id)
);
-- Admin/superadmin access bypasses this table; such actions carry
-- acting_as_admin=1 in chats and change records (ADR-007).

CREATE TABLE mock2_locks (
  project_id INTEGER PRIMARY KEY,
  holder_user_id INTEGER,                      -- exactly one of these two set
  holder_cycle_id INTEGER,
  acquired_at TEXT NOT NULL,
  last_write_at TEXT NOT NULL,                 -- idle timer counts from HERE (ADR-004)
  takeover_requested_by INTEGER, takeover_requested_at TEXT
);
-- Force-release / auto-release events go to logAudit (main DB) + a change record.
```

Also in the main DB, one small migration (block 500 there too, or a plain
ALTER following the `authenticated_devices` pattern): `users.is_superadmin
INTEGER NOT NULL DEFAULT 0` — the only main-schema touch Mock2 makes
(ADR-007). It is additive and harmless on hosts where Mock2 is disabled.

## Migration 501 — framework registry

```sql
CREATE TABLE mock2_framework_versions (
  id INTEGER PRIMARY KEY,
  version INTEGER NOT NULL UNIQUE,             -- monotonic across the bundle
  constitution_md TEXT NOT NULL,
  skills_json TEXT NOT NULL,                   -- the four skills, one JSON doc
  gates_json TEXT NOT NULL,                    -- gate scripts: [{name, script, order}]
  design_system_md TEXT NOT NULL,              -- the locked mockup design system
  project_template_ref TEXT NOT NULL,          -- template the container/repo is seeded from
  changelog TEXT,                              -- why this version exists
  reverted_from_version INTEGER,               -- set when this is a revert-as-new-version
  source TEXT NOT NULL DEFAULT 'in_app'
    CHECK (source IN ('in_app','git_sync')),
  source_git_commit TEXT,
  created_by INTEGER NOT NULL, created_at TEXT
);
-- Rows are immutable after insert. No UPDATE path exists in the API.
```

## Migration 502 — chat, cycles, change records, questions, queue

```sql
CREATE TABLE mock2_chats (                     -- one per project, but keep the id for exports
  id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL UNIQUE, created_at TEXT
);

CREATE TABLE mock2_chat_messages (
  id INTEGER PRIMARY KEY,
  chat_id INTEGER NOT NULL,
  author_user_id INTEGER,                      -- NULL = system/model
  acting_as_admin INTEGER NOT NULL DEFAULT 0,  -- admin inside someone else's project
  kind TEXT NOT NULL CHECK (kind IN
    ('user','assistant','rule_question','rule_answer','system','gate_report')),
  body TEXT NOT NULL,                          -- rule_question bodies carry choices JSON
  question_id INTEGER,                         -- links rule_question/rule_answer rows
  cycle_id INTEGER, created_at TEXT
);

CREATE TABLE mock2_cycles (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL,
  framework_version_id INTEGER NOT NULL,       -- THE PIN (ADR-003), stamped at start
  stage TEXT NOT NULL CHECK (stage IN ('concept','define','build','run','remediation')),
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN
    ('queued','estimating','refused_quota','running','awaiting_user',
     'awaiting_admin','interrupted','abandoned','failed','succeeded')),
  current_gate TEXT,                           -- for the "gates going green" view
  gates_json TEXT,                             -- [{name, status, started_at, report}]
  initiated_by INTEGER NOT NULL,
  acting_as_admin INTEGER NOT NULL DEFAULT 0,
  trigger_message_id INTEGER,
  classifier_outcome TEXT CHECK (classifier_outcome IN
    ('implements','contradicts','unaddressed')),
  est_tokens INTEGER, est_cost_cents INTEGER,  -- reservation (quota ADR in brief)
  used_tokens INTEGER DEFAULT 0, used_cost_cents INTEGER DEFAULT 0,
  retries INTEGER NOT NULL DEFAULT 0,
  interrupt_request TEXT CHECK (interrupt_request IN
    (NULL,'queue_after_step','stop_after_step','abandon')),
  error TEXT, started_at TEXT, finished_at TEXT, created_at TEXT
);
-- Boot sweep: any 'running'/'estimating' cycle at startup -> 'failed' with
-- error='orphaned by restart', branch reset to last checkpoint (index.js
-- boot-sweep pattern).

CREATE TABLE mock2_change_records (            -- append-only, hash-chained
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL,
  cycle_id INTEGER,
  seq INTEGER NOT NULL,                        -- per-project sequence
  prev_hash TEXT NOT NULL,                     -- '' for seq 1
  hash TEXT NOT NULL,                          -- sha256(prev_hash + canonical_json(payload))
  initiated_by INTEGER NOT NULL,
  acting_as_admin INTEGER NOT NULL DEFAULT 0,
  framework_version INTEGER NOT NULL,          -- denormalized version number for display
  framework_version_id INTEGER NOT NULL,
  rules_touched TEXT,                          -- JSON array of rule ids/headings
  gates_run TEXT,                              -- JSON [{name, result}]
  commit_sha TEXT,                             -- checkpoint this record describes
  summary TEXT NOT NULL,                       -- human-readable "what changed"
  created_at TEXT,
  UNIQUE (project_id, seq)
);
-- Also mirrored to the repo as state/changes/<seq>.json on each checkpoint,
-- so rehydrate restores the readable history even if mock2.db is lost.

CREATE TABLE mock2_audit_questions (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL, cycle_id INTEGER NOT NULL,
  route TEXT NOT NULL CHECK (route IN ('editor','admin')),   -- ADR-002
  kind TEXT NOT NULL CHECK (kind IN
    ('domain_question','framework_deviation','rule_contradiction','rule_gap')),
  question TEXT NOT NULL,                      -- plain language
  choices_json TEXT,                           -- tappable options; free text always allowed
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','answered','dismissed')),
  answer TEXT, answered_by INTEGER, answered_at TEXT,
  rules_md_anchor TEXT,                        -- where the answer landed in rules.md
  created_at TEXT
);

CREATE TABLE mock2_queue_items (               -- the admin's real object (brief §admin view)
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN
    ('framework_deviation','drift','retries_exhausted','flag','orphaned',
     'port_drift','quota_exhausted','provisioning_failed','renewal_failed')),
  ref_table TEXT, ref_id INTEGER,              -- e.g. audit question, cycle
  detail TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','resolved','dismissed')),
  dedupe_key TEXT UNIQUE,                      -- notifications-style UPSERT for recurring kinds
  raised_at TEXT, resolved_by INTEGER, resolved_at TEXT, resolution TEXT
);
```

## Migration 503 — connectors, quotas, summaries

```sql
CREATE TABLE mock2_model_connectors (          -- clone of backup_destinations pattern
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  provider TEXT NOT NULL CHECK (provider IN ('anthropic','openai','gemini','ollama','openai_compatible')),
  base_url TEXT,                               -- required for ollama/openai_compatible
  api_key_enc TEXT,                            -- NULL allowed for local ollama
  capabilities TEXT NOT NULL,                  -- JSON: ['agentic_build','chat','summarize','classify']
  test_status TEXT, test_at TEXT,              -- cached healthcheck verdict
  enabled INTEGER NOT NULL DEFAULT 1,
  baa_ack_by INTEGER, baa_ack_at TEXT,         -- BAA acknowledgement (cloud providers;
  created_by INTEGER, created_at TEXT          --  operator decision 2026-07-09: ack, not blocker)
);

CREATE TABLE mock2_model_slots (               -- per-stage AND per-capability (brief)
  slot TEXT PRIMARY KEY CHECK (slot IN
    ('concept_chat','mockup','audit','classifier','build_runner','summary','remediation')),
  connector_id INTEGER NOT NULL,
  model TEXT NOT NULL,                         -- provider model id
  updated_by INTEGER, updated_at TEXT
);
-- API refuses to assign a connector to a slot its capabilities don't cover
-- (the "be honest in the UI" rule becomes a constraint).

CREATE TABLE mock2_model_prices (
  id INTEGER PRIMARY KEY,
  connector_id INTEGER NOT NULL, model TEXT NOT NULL,
  input_cents_per_mtok INTEGER NOT NULL, output_cents_per_mtok INTEGER NOT NULL,
  effective_at TEXT NOT NULL,
  UNIQUE (connector_id, model, effective_at)
);
-- Self-hosted models: price rows are 0; caps enforced via mock2_quotas limits below.

CREATE TABLE mock2_quotas (
  id INTEGER PRIMARY KEY,
  scope TEXT NOT NULL CHECK (scope IN ('global','project')),
  project_id INTEGER,                          -- NULL for global
  period TEXT NOT NULL CHECK (period IN ('monthly','weekly')),
  budget_cents INTEGER,                        -- $ quota (metered models)
  budget_wall_clock_min INTEGER,               -- self-hosted cap: runner wall-clock
  max_concurrent_cycles INTEGER,               -- self-hosted cap: GPU contention
  buffer_pct INTEGER NOT NULL DEFAULT 15,      -- reservation buffer
  UNIQUE (scope, project_id, period)
);

CREATE TABLE mock2_quota_ledger (              -- spend events; remaining = budget - sum(period)
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL, cycle_id INTEGER,
  connector_id INTEGER, model TEXT,
  input_tokens INTEGER, output_tokens INTEGER, cost_cents INTEGER,
  wall_clock_ms INTEGER, created_at TEXT
);

CREATE TABLE mock2_git_connectors (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  provider TEXT NOT NULL CHECK (provider IN ('github','gitea','generic_https','generic_ssh')),
  base_url TEXT,
  auth_kind TEXT NOT NULL CHECK (auth_kind IN ('token','ssh_key')),
  credential_enc TEXT NOT NULL,                -- token or private key, encrypted (ADR-006:
  test_status TEXT, test_at TEXT,              --  used by orchestrator only, never a container)
  created_by INTEGER, created_at TEXT
);

CREATE TABLE mock2_project_remotes (
  project_id INTEGER PRIMARY KEY,
  git_connector_id INTEGER NOT NULL,
  remote_repo TEXT NOT NULL,                   -- 'org/name' or full URL
  push_on_checkpoint INTEGER NOT NULL DEFAULT 0,
  last_push_at TEXT, last_push_error TEXT
);

CREATE TABLE mock2_summaries (                 -- adaptive summary, versioned for diffing
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL,
  version INTEGER NOT NULL,
  body_md TEXT NOT NULL,
  derived_from_change_seq INTEGER NOT NULL,    -- change-record high-water mark, NOT chat
  created_at TEXT,
  UNIQUE (project_id, version)
);
```

## In-repo files (the other half of the model)

| Path | Owner | Notes |
|---|---|---|
| `mock2.yaml` | template + editor-approved edits | Port/topology manifest (ADR-005) |
| `state/inventory.json` | design-approval gesture | Concept-stage exit artifact |
| `state/rules.md` | rule answers only | Appended by answered editor questions |
| `state/changes/<seq>.json` | orchestrator on checkpoint | Mirror of `mock2_change_records` |
| `.env.example`-style secrets manifest | template | Required keys, no values; `.env` gitignored |

## Derived status (single source of truth for the UI)

`provisioning` ← lifecycle · `archived` ← lifecycle · `failed` ← lifecycle or
last cycle failed · `building` ← cycle running (stage, current_gate) ·
`awaiting user` ← open editor question · `awaiting admin` ← open admin
question/queue item or retries exhausted · `checked out` ← lock row (holder,
time remaining) · `quota exhausted` ← ledger vs budget · `drift` ← open drift
queue item · `orphaned` ← zero editor members · `online`/`idle`/`stopped` ←
Incus state + last_activity_at · `!` overlay ← `flagged`. Implement as one
SQL view / one JS function used by both the tile list and the detail page —
never two implementations.
