// Mock2 schema migrations — block 500, applied ONLY inside data/db/mock2.db
// (ADR-001: the Mock2 state file, including model API keys, does not exist
// on a disabled host). These reuse the main DB's runMigration() version
// guard (db.js), but against the separate Mock2 database handle, so Mock2's
// schema_migrations table is its own and never collides with the main DB.
//
// Append-only: never edit an applied migration; add a new numbered one
// (CLAUDE.md). Schemas are transcribed verbatim from docs/mock2/03-data-model.md.
//
// Reserved Mock2 version numbers (block 500):
//   500 M0 — registry, membership, routing (settings, parent domains,
//            projects, slug history, members, locks)
//   501 M0 — framework registry (versions)
//   502 M0 — chat, cycles, change records, audit questions, queue
//   503 M0 — connectors, quotas, git connectors, remotes, summaries
//   504 M2 — project provisioning cache columns (web_port, container_ip,
//            provision_error) — additive, never edits 500-503
//   505 M4 — network isolation: mock2_projects.bridge_cidr (the per-project
//            managed bridge's /24) + mock2_egress_allowlist (the per-project
//            filtering-proxy allowlist, editable, audit-logged) — additive
//   506 M6 — cycle instruction: mock2_cycles.instruction (the canned task text
//            a cycle was started with — chat is M7, so M6 stores the one-shot
//            instruction here) — additive, never edits 500-505
//   507 M7 — concept-stage exit: mock2_projects.design_approved_at (sign-off #1
//            timestamp — drives the persistent stage indicator + the Build
//            unlock), design_inventory_seq (the change-record seq of the
//            approval), current_mockup_id (the latest served mockup id, NULLed
//            on approval when the mockup code is discarded) — all additive
//   508 Run — deploy step: mock2_cycles.deploy_status (NULL/'deploying'/'serving'
//            /'deploy_failed') — whether the built app was installed, migrated,
//            built and started so the live URL serves it (Run phase) — additive
//   509 M7 — mock2_projects.mockup_archived_id (preserve the mockup after
//            approval so the design preview stays reachable) — additive
//   510 M7 — mock2_projects.chat_typing_seconds (client-measured active-typing
//            time counter for the Details time card) — additive
//   511 Run — mock2_cycles.pause_reason (why a cycle soft-paused on a token/time
//            budget: 'budget_tokens' | 'budget_time' — NULL otherwise) — additive
//   512 Run — mock2_cycle_events (durable per-cycle transcript: task, AI messages,
//            tool calls/results, gates, checkpoint, deploy — the downloadable
//            "what happened" log) — additive, new table
//
// Terminology (risk R7): the AI build component is the RUNNER. Nothing
// here uses the bare word "agent" — `proxypilot-agent` is an unrelated Go
// daemon and the collision would mislead future greps.

export const MOCK2_MIGRATIONS = [
  {
    version: 500,
    name: 'mock2_registry_membership_routing',
    up: (d) => {
      d.exec(`
        CREATE TABLE mock2_settings (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at TEXT,
          updated_by INTEGER
        );

        CREATE TABLE mock2_parent_domains (
          id INTEGER PRIMARY KEY,
          domain TEXT NOT NULL UNIQUE,
          dns_provider TEXT,
          dns_credentials_enc TEXT,
          cert_path TEXT,
          verify_status TEXT NOT NULL DEFAULT 'pending'
            CHECK (verify_status IN ('pending','dns_ok','cert_ok','failed')),
          verified_at TEXT,
          last_renewal_at TEXT,
          renewal_error TEXT,
          enabled INTEGER NOT NULL DEFAULT 0,
          created_by INTEGER,
          created_at TEXT
        );

        CREATE TABLE mock2_projects (
          id INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          description TEXT,
          parent_domain_id INTEGER REFERENCES mock2_parent_domains(id),
          slug TEXT,
          custom_domain TEXT,
          container_name TEXT,
          bridge_name TEXT,
          repo_path TEXT NOT NULL,
          lifecycle TEXT NOT NULL DEFAULT 'provisioning'
            CHECK (lifecycle IN ('provisioning','active','stopped','archived','failed_provisioning')),
          flagged INTEGER NOT NULL DEFAULT 0,
          flagged_by INTEGER,
          flagged_reason TEXT,
          last_activity_at TEXT,
          last_built_framework_version_id INTEGER,
          framework_version_initial INTEGER,
          created_by INTEGER,
          created_at TEXT,
          archived_at TEXT,
          UNIQUE (parent_domain_id, slug)
        );

        CREATE TABLE mock2_slug_history (
          id INTEGER PRIMARY KEY,
          parent_domain_id INTEGER NOT NULL,
          slug TEXT NOT NULL,
          project_id INTEGER NOT NULL,
          active_until TEXT,
          rotated_by INTEGER,
          created_at TEXT,
          UNIQUE (parent_domain_id, slug)
        );

        CREATE TABLE mock2_project_members (
          project_id INTEGER NOT NULL,
          user_id INTEGER NOT NULL,
          role TEXT NOT NULL CHECK (role IN ('editor','viewer')),
          invited_by INTEGER,
          created_at TEXT,
          PRIMARY KEY (project_id, user_id)
        );

        CREATE TABLE mock2_locks (
          project_id INTEGER PRIMARY KEY,
          holder_user_id INTEGER,
          holder_cycle_id INTEGER,
          acquired_at TEXT NOT NULL,
          last_write_at TEXT NOT NULL,
          takeover_requested_by INTEGER,
          takeover_requested_at TEXT
        );
      `);
    },
  },
  {
    version: 501,
    name: 'mock2_framework_registry',
    up: (d) => {
      d.exec(`
        CREATE TABLE mock2_framework_versions (
          id INTEGER PRIMARY KEY,
          version INTEGER NOT NULL UNIQUE,
          constitution_md TEXT NOT NULL,
          skills_json TEXT NOT NULL,
          gates_json TEXT NOT NULL,
          design_system_md TEXT NOT NULL,
          project_template_ref TEXT NOT NULL,
          changelog TEXT,
          reverted_from_version INTEGER,
          source TEXT NOT NULL DEFAULT 'in_app'
            CHECK (source IN ('in_app','git_sync')),
          source_git_commit TEXT,
          created_by INTEGER NOT NULL,
          created_at TEXT
        );
      `);
    },
  },
  {
    version: 502,
    name: 'mock2_chat_cycles_changes_questions_queue',
    up: (d) => {
      d.exec(`
        CREATE TABLE mock2_chats (
          id INTEGER PRIMARY KEY,
          project_id INTEGER NOT NULL UNIQUE,
          created_at TEXT
        );

        CREATE TABLE mock2_chat_messages (
          id INTEGER PRIMARY KEY,
          chat_id INTEGER NOT NULL,
          author_user_id INTEGER,
          acting_as_admin INTEGER NOT NULL DEFAULT 0,
          kind TEXT NOT NULL CHECK (kind IN
            ('user','assistant','rule_question','rule_answer','system','gate_report')),
          body TEXT NOT NULL,
          question_id INTEGER,
          cycle_id INTEGER,
          created_at TEXT
        );

        CREATE TABLE mock2_cycles (
          id INTEGER PRIMARY KEY,
          project_id INTEGER NOT NULL,
          framework_version_id INTEGER NOT NULL,
          stage TEXT NOT NULL CHECK (stage IN ('concept','define','build','run','remediation')),
          status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN
            ('queued','estimating','refused_quota','running','awaiting_user',
             'awaiting_admin','interrupted','abandoned','failed','succeeded')),
          current_gate TEXT,
          gates_json TEXT,
          initiated_by INTEGER NOT NULL,
          acting_as_admin INTEGER NOT NULL DEFAULT 0,
          trigger_message_id INTEGER,
          classifier_outcome TEXT CHECK (classifier_outcome IN
            ('implements','contradicts','unaddressed')),
          est_tokens INTEGER,
          est_cost_cents INTEGER,
          used_tokens INTEGER DEFAULT 0,
          used_cost_cents INTEGER DEFAULT 0,
          retries INTEGER NOT NULL DEFAULT 0,
          interrupt_request TEXT CHECK (interrupt_request IN
            (NULL,'queue_after_step','stop_after_step','abandon')),
          error TEXT,
          started_at TEXT,
          finished_at TEXT,
          created_at TEXT
        );

        CREATE TABLE mock2_change_records (
          id INTEGER PRIMARY KEY,
          project_id INTEGER NOT NULL,
          cycle_id INTEGER,
          seq INTEGER NOT NULL,
          prev_hash TEXT NOT NULL,
          hash TEXT NOT NULL,
          initiated_by INTEGER NOT NULL,
          acting_as_admin INTEGER NOT NULL DEFAULT 0,
          framework_version INTEGER NOT NULL,
          framework_version_id INTEGER NOT NULL,
          rules_touched TEXT,
          gates_run TEXT,
          commit_sha TEXT,
          summary TEXT NOT NULL,
          created_at TEXT,
          UNIQUE (project_id, seq)
        );

        CREATE TABLE mock2_audit_questions (
          id INTEGER PRIMARY KEY,
          project_id INTEGER NOT NULL,
          cycle_id INTEGER NOT NULL,
          route TEXT NOT NULL CHECK (route IN ('editor','admin')),
          kind TEXT NOT NULL CHECK (kind IN
            ('domain_question','framework_deviation','rule_contradiction','rule_gap')),
          question TEXT NOT NULL,
          choices_json TEXT,
          status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','answered','dismissed')),
          answer TEXT,
          answered_by INTEGER,
          answered_at TEXT,
          rules_md_anchor TEXT,
          created_at TEXT
        );

        CREATE TABLE mock2_queue_items (
          id INTEGER PRIMARY KEY,
          project_id INTEGER NOT NULL,
          kind TEXT NOT NULL CHECK (kind IN
            ('framework_deviation','drift','retries_exhausted','flag','orphaned',
             'port_drift','quota_exhausted','provisioning_failed','renewal_failed')),
          ref_table TEXT,
          ref_id INTEGER,
          detail TEXT,
          status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','resolved','dismissed')),
          dedupe_key TEXT UNIQUE,
          raised_at TEXT,
          resolved_by INTEGER,
          resolved_at TEXT,
          resolution TEXT
        );
      `);
    },
  },
  {
    version: 503,
    name: 'mock2_connectors_quotas_summaries',
    up: (d) => {
      d.exec(`
        CREATE TABLE mock2_model_connectors (
          id INTEGER PRIMARY KEY,
          name TEXT NOT NULL UNIQUE,
          provider TEXT NOT NULL CHECK (provider IN ('anthropic','openai','gemini','ollama','openai_compatible')),
          base_url TEXT,
          api_key_enc TEXT,
          capabilities TEXT NOT NULL,
          test_status TEXT,
          test_at TEXT,
          enabled INTEGER NOT NULL DEFAULT 1,
          baa_ack_by INTEGER,
          baa_ack_at TEXT,
          created_by INTEGER,
          created_at TEXT
        );

        CREATE TABLE mock2_model_slots (
          slot TEXT PRIMARY KEY CHECK (slot IN
            ('concept_chat','mockup','audit','classifier','build_runner','summary','remediation')),
          connector_id INTEGER NOT NULL,
          model TEXT NOT NULL,
          updated_by INTEGER,
          updated_at TEXT
        );

        CREATE TABLE mock2_model_prices (
          id INTEGER PRIMARY KEY,
          connector_id INTEGER NOT NULL,
          model TEXT NOT NULL,
          input_cents_per_mtok INTEGER NOT NULL,
          output_cents_per_mtok INTEGER NOT NULL,
          effective_at TEXT NOT NULL,
          UNIQUE (connector_id, model, effective_at)
        );

        CREATE TABLE mock2_quotas (
          id INTEGER PRIMARY KEY,
          scope TEXT NOT NULL CHECK (scope IN ('global','project')),
          project_id INTEGER,
          period TEXT NOT NULL CHECK (period IN ('monthly','weekly')),
          budget_cents INTEGER,
          budget_wall_clock_min INTEGER,
          max_concurrent_cycles INTEGER,
          buffer_pct INTEGER NOT NULL DEFAULT 15,
          UNIQUE (scope, project_id, period)
        );

        CREATE TABLE mock2_quota_ledger (
          id INTEGER PRIMARY KEY,
          project_id INTEGER NOT NULL,
          cycle_id INTEGER,
          connector_id INTEGER,
          model TEXT,
          input_tokens INTEGER,
          output_tokens INTEGER,
          cost_cents INTEGER,
          wall_clock_ms INTEGER,
          created_at TEXT
        );

        CREATE TABLE mock2_git_connectors (
          id INTEGER PRIMARY KEY,
          name TEXT NOT NULL UNIQUE,
          provider TEXT NOT NULL CHECK (provider IN ('github','gitea','generic_https','generic_ssh')),
          base_url TEXT,
          auth_kind TEXT NOT NULL CHECK (auth_kind IN ('token','ssh_key')),
          credential_enc TEXT NOT NULL,
          test_status TEXT,
          test_at TEXT,
          created_by INTEGER,
          created_at TEXT
        );

        CREATE TABLE mock2_project_remotes (
          project_id INTEGER PRIMARY KEY,
          git_connector_id INTEGER NOT NULL,
          remote_repo TEXT NOT NULL,
          push_on_checkpoint INTEGER NOT NULL DEFAULT 0,
          last_push_at TEXT,
          last_push_error TEXT
        );

        CREATE TABLE mock2_summaries (
          id INTEGER PRIMARY KEY,
          project_id INTEGER NOT NULL,
          version INTEGER NOT NULL,
          body_md TEXT NOT NULL,
          derived_from_change_seq INTEGER NOT NULL,
          created_at TEXT,
          UNIQUE (project_id, version)
        );
      `);
    },
  },
  {
    // Phase M2. The Caddy upstream for a project's slug FQDN is
    // `<container_ip>:<web_port>` — the web port is DECLARED in the repo's
    // mock2.yaml (ADR-005, never discovered) and the IP is the container's
    // address on the shared bridge. Both are cached on the row so the boot
    // reconcile (reconcile.js) can re-publish the Caddy block without
    // re-reading git or shelling into Incus for every project, and so the
    // admin debug view can render `bridge_ip:port` after a page reload.
    // container_ip is refreshed from `incus list` on provision/reconcile —
    // it is a cache, not the source of truth. provision_error records why a
    // row landed in lifecycle='failed_provisioning'. All three are additive
    // and NULL on every pre-existing row, so this is harmless on a disabled
    // host that never ran M2.
    version: 504,
    name: 'mock2_project_provisioning_cache',
    up: (d) => {
      d.exec(`
        ALTER TABLE mock2_projects ADD COLUMN web_port INTEGER;
        ALTER TABLE mock2_projects ADD COLUMN container_ip TEXT;
        ALTER TABLE mock2_projects ADD COLUMN provision_error TEXT;
      `);
    },
  },
  {
    // Phase M4 — network isolation (ADR-010). Two additive changes:
    //
    //   1. mock2_projects.bridge_cidr — the /24 of the per-project MANAGED
    //      Incus bridge m2br<id> the project's container is pinned to. The
    //      bridge name already exists as a column (bridge_name, migration
    //      500); M4 fills both in at provision. The CIDR is stored (not only
    //      derived from the id) so the firewall/proxy generators and the boot
    //      reconcile have a stable per-project subnet even if the derivation
    //      function ever changes, and so the admin debug view can render it.
    //      NULL on every row a pre-M4 host created (those still ran on the
    //      shared bridge — the boot reconcile derives + backfills on wake).
    //
    //   2. mock2_egress_allowlist — the per-project filtering-proxy allowlist
    //      (ADR-010: squid CONNECT/GET only to these dstdomains, keyed by the
    //      bridge subnet). Seeded on project create with a static default set
    //      (npm/apt/pypi/model-API hosts — M5 wires the model half to
    //      connectors); editable by admins (audit-logged). One row per
    //      (project, host); the squid ACL file is regenerated from these rows.
    //
    // Both are additive and absent on a disabled host (block-500 migrations
    // only ever run inside data/db/mock2.db, which never exists there).
    version: 505,
    name: 'mock2_network_isolation',
    up: (d) => {
      d.exec(`
        ALTER TABLE mock2_projects ADD COLUMN bridge_cidr TEXT;

        CREATE TABLE mock2_egress_allowlist (
          id INTEGER PRIMARY KEY,
          project_id INTEGER NOT NULL,
          host TEXT NOT NULL,
          created_by INTEGER,
          created_at TEXT,
          UNIQUE (project_id, host)
        );
      `);
    },
  },
  {
    // Phase M6 — the cycle runner. mock2_cycles already exists (block 502); M6
    // adds one column: the canned instruction a cycle is started with. No chat
    // yet (that's M7), so the "make this targeted change" text is stored on the
    // cycle row rather than derived from a trigger message. Additive and NULL on
    // every pre-M6 row, so it is harmless on a disabled host that never ran M6.
    version: 506,
    name: 'mock2_cycle_instruction',
    up: (d) => {
      d.exec(`
        ALTER TABLE mock2_cycles ADD COLUMN instruction TEXT;
      `);
    },
  },
  {
    // Phase M7 — Stage 1 (Concept): chat, mockup, design approval. The chat +
    // cycle tables already exist (block 502); M7 needs only three additive
    // columns on mock2_projects to track the concept-stage exit:
    //
    //   1. design_approved_at — the sign-off #1 timestamp. The design-approval
    //      gesture stamps it; it drives the persistent stage indicator
    //      (Concept → Define → Build → Run) and gates the Build affordance
    //      (Build appears only once the design is approved). NULL = still in
    //      Concept. Derived status stays derived (03-data-model.md) — this is a
    //      point-in-time sign-off fact, not a status column.
    //   2. design_inventory_seq — the mock2_change_records.seq of the approval
    //      change record, so the UI can point at the sign-off in the chain.
    //   3. current_mockup_id — the id of the mockup currently served at the
    //      project's preview path (state/mockups/current.html). Set when a
    //      mockup is generated; NULLed on approval when the mockup code is
    //      discarded (the inventory, not the mockup, is the UI spec).
    //
    // All three are additive and NULL on every pre-M7 row, so this is harmless
    // on a disabled host that never ran M7.
    version: 507,
    name: 'mock2_concept_design_approval',
    up: (d) => {
      d.exec(`
        ALTER TABLE mock2_projects ADD COLUMN design_approved_at TEXT;
        ALTER TABLE mock2_projects ADD COLUMN design_inventory_seq INTEGER;
        ALTER TABLE mock2_projects ADD COLUMN current_mockup_id TEXT;
      `);
    },
  },
  {
    // Run phase — the deploy step. mock2_cycles already exists (block 502); the
    // Run phase adds one column recording whether the built app was actually
    // deployed and is serving on the live URL: NULL (no deploy — a placeholder
    // project, or a cycle that never reached deploy), 'deploying', 'serving', or
    // 'deploy_failed'. It is the input to the derived project statuses
    // deploying/serving/deploy_failed (deriveProjectStatus / deploy-logic.js).
    // Additive and NULL on every pre-existing row, so harmless on a disabled host
    // that never ran it.
    version: 508,
    name: 'mock2_cycle_deploy_status',
    up: (d) => {
      d.exec(`
        ALTER TABLE mock2_cycles ADD COLUMN deploy_status TEXT;
      `);
    },
  },
  {
    // Preserve the design mockup after approval. current_mockup_id is nulled on
    // approval so the build-mode preview shows the working app, not the mockup —
    // but we no longer physically discard the mockup HTML. This column records
    // the id of the mockup that was archived so the design preview URL
    // (/_preview/, served from the still-present state/mockups/current.html)
    // stays reachable as a record of where the design started. Additive and NULL
    // on every pre-existing row, so harmless on a disabled host that never ran it.
    version: 509,
    name: 'mock2_mockup_archived_id',
    up: (d) => {
      d.exec(`
        ALTER TABLE mock2_projects ADD COLUMN mockup_archived_id TEXT;
      `);
    },
  },
  {
    // Time tracking: accumulated seconds a user spent ACTIVELY typing in the
    // project's chats (design + build). The client measures active-typing spans
    // and flushes increments here; the rest of the time buckets (AI time, admin
    // wait) are derived from cycle + queue timestamps, so only this one needs a
    // stored counter. Additive, defaults 0, harmless on every pre-existing row.
    version: 510,
    name: 'mock2_chat_typing_seconds',
    up: (d) => {
      d.exec(`
        ALTER TABLE mock2_projects ADD COLUMN chat_typing_seconds INTEGER NOT NULL DEFAULT 0;
      `);
    },
  },
  {
    // Soft-pause reason. A build cycle that crosses a token or wall-clock budget
    // is checkpointed and PAUSED (resumable) rather than failed — stored as an
    // 'interrupted' status (an allowed value, so no CHECK-constraint rebuild)
    // tagged with WHY it paused: 'budget_tokens' | 'budget_time'. NULL for every
    // other interrupted cycle (a user stop_after_step / queue_after_step) and for
    // every pre-existing row, so today's interrupt semantics are unchanged; the UI
    // only offers one-click Resume when this reason is set. Additive.
    version: 511,
    name: 'mock2_cycle_pause_reason',
    up: (d) => {
      d.exec(`
        ALTER TABLE mock2_cycles ADD COLUMN pause_reason TEXT;
      `);
    },
  },
  {
    // Per-cycle event log — the durable transcript of what actually happened in a
    // build so it can be reviewed and downloaded ("how did it do?"). setJob only
    // carries ephemeral progress; this records every step: the task text, each AI
    // message, each tool call + (truncated) result, gate outcomes, the checkpoint,
    // and the deploy. seq orders events within a cycle. Additive; a disabled host
    // never writes it.
    version: 512,
    name: 'mock2_cycle_events',
    up: (d) => {
      d.exec(`
        CREATE TABLE mock2_cycle_events (
          id INTEGER PRIMARY KEY,
          project_id INTEGER NOT NULL,
          cycle_id INTEGER NOT NULL,
          seq INTEGER NOT NULL,
          kind TEXT NOT NULL,
          role TEXT,
          content TEXT,
          meta_json TEXT,
          created_at TEXT NOT NULL
        );
        CREATE INDEX idx_mock2_cycle_events_cycle ON mock2_cycle_events (cycle_id, seq);
        CREATE INDEX idx_mock2_cycle_events_project ON mock2_cycle_events (project_id, id);
      `);
    },
  },
];
