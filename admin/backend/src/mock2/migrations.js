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
//   513 Run — mock2_cycles.halt_reason (why a cycle halted without success) — additive
//   514 Run — human feedback channels: mock2_cycles.halt_options_json +
//            resume_context_json, and mock2_authorizations (scoped one-time
//            operational grants) — additive, two columns + new table
//   515 Cost — cost-truth: mock2_requests (umbrella), mock2_cycles gains the four
//            canonical token classes + usage_schema_version + request_id/segment,
//            and mock2_consults (advisory second opinion) — strictly additive,
//            nullable columns + new tables, reversible, no row rewrites
//   516 Lib — component library: mock2_components (reusable, named building
//            blocks — e.g. an LDAPS auth module), mock2_component_versions
//            (append-only content with a REQUIRED annotated change_reason;
//            revert = new version, same idiom as the framework registry), and
//            mock2_component_submissions (a project member proposes code from
//            their project; an admin approves it into the library or rejects
//            it with a reason — all through the platform) — additive, new tables
//   517 Egress — declared, admin-approved outbound egress: mock2_egress_grants
//            (an app declares internal hosts it must reach in mock2.yaml
//            `egress:`; each is a pending grant an admin approves before it is
//            wired into the project fence) + rebuilds mock2_queue_items to add
//            the `egress_grant` kind to the CHECK
//   518 Acc — acceptance discipline (cycle-94 lesson): mock2_cycles gains
//            acceptance_json — the machine-readable acceptance state (task
//            kind, defect tag, red-test-observed, required live checks,
//            demonstrated) so "gates green" and "acceptance demonstrated" are
//            distinguishable states in the record — additive, one nullable column
//   519 Tpl — design-template import: mock2_projects.design_import_json — the
//            imported design's provenance + original design brief + Builder
//            notes, carried into the initial build instruction — additive,
//            one nullable column
//   520 Int — integration truthfulness: mock2_cycles.verification_state +
//            integration_gate_json, and the mock2_integration_verifications +
//            mock2_integration_findings append-only tables (AUDIT.md; B.4/B.5)
//   521 Fw  — framework export/import: widen mock2_framework_versions.source
//            CHECK to include 'import' (table rebuild — an imported framework
//            version records honest provenance)
//   522 Res — blocked-deviation resolution records (PATCH): mock2_integration_
//            resolutions (append-only, hash-linked) for manifest backfills (B.1)
//            and analysis-limitation waivers (B.2)
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
  {
    // Halt reason. A build cycle that CANNOT honestly finish — the model called
    // halt(reason) because it is blocked, or the no-progress circuit breaker tripped
    // (repeated no-tool-call / near-identical / no-state-change turns) — ends as a
    // needs-attention terminal rather than 'succeeded'. Stored on the allowed
    // 'awaiting_admin' status (no CHECK-constraint rebuild, same idiom as 511's
    // pause_reason) tagged with WHY it halted: 'model_halt' | 'no_tool_calls' |
    // 'repeated_output' | 'no_state_change'. NULL for every retries-exhausted
    // awaiting_admin and every pre-existing row, so today's semantics are unchanged;
    // the UI shows a distinct "Blocked — needs attention" when this reason is set.
    // Additive; a disabled host never writes it.
    version: 513,
    name: 'mock2_cycle_halt_reason',
    up: (d) => {
      d.exec(`
        ALTER TABLE mock2_cycles ADD COLUMN halt_reason TEXT;
      `);
    },
  },
  {
    // Human feedback channels for blocked/awaiting states. Two additive cycle
    // columns + one new table:
    //  - halt_options_json: when the model halts it can PROPOSE resolution choices
    //    ([{id,label,detail}]) alongside its reason; the operator picks one (rendered
    //    with the rule-question card UI) and the choice is injected on resume.
    //  - resume_context_json: the operator guidance carried into a resumed cycle — a
    //    free-text message, the selected halt option, and the ids of the one-time
    //    authorizations granted for this resume — injected as a labeled user turn
    //    AFTER the original task. NULL on a bare resume and every pre-existing row.
    //  - mock2_authorizations: SCOPED ONE-TIME operational authorizations, distinct
    //    from constitutional deviations. A cycle's model may request one (exact scope,
    //    e.g. a specific SQL statement); an admin grants/denies (optionally appending
    //    conditions); it is single-use (→ 'used' when injected) and expires with the
    //    cycle. Fully audit-logged. A disabled host never writes any of this.
    version: 514,
    name: 'mock2_human_feedback_channels',
    up: (d) => {
      d.exec(`
        ALTER TABLE mock2_cycles ADD COLUMN halt_options_json TEXT;
        ALTER TABLE mock2_cycles ADD COLUMN resume_context_json TEXT;

        CREATE TABLE mock2_authorizations (
          id INTEGER PRIMARY KEY,
          project_id INTEGER NOT NULL,
          cycle_id INTEGER NOT NULL,
          scope TEXT NOT NULL,
          reason TEXT,
          status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','granted','denied','used','expired')),
          conditions TEXT,
          granted_by INTEGER,
          granted_at TEXT,
          used_at TEXT,
          created_at TEXT NOT NULL
        );
        CREATE INDEX idx_mock2_authorizations_project ON mock2_authorizations (project_id, status);
        CREATE INDEX idx_mock2_authorizations_cycle ON mock2_authorizations (cycle_id);
      `);
    },
  },
  {
    // Cost-truth (docs/agent-sdk-migration.md § "Cost-truth"). STRICTLY ADDITIVE and
    // reversible: only NEW tables + NULLABLE columns — no existing row is rewritten and
    // no existing column/type changes, so behavior is byte-identical until code opts in.
    //   - mock2_requests: the umbrella "one build ask = one record" entity. Cycles
    //     become segments of a request. NULL request_id on every pre-existing cycle
    //     (legacy / new-requests-only backfill, per the doc) — nothing is regrouped.
    //   - mock2_cycles gains the FOUR canonical token classes + a usage_schema_version
    //     stamp + request_id + segment. used_tokens/used_cost_cents stay untouched (the
    //     old "billable in+out" number); the four new columns are the honest basis.
    //     Every column is NULLable so existing rows read exactly as before (pre-v3,
    //     flagged non-comparable by usage-logic.isComparable).
    //   - mock2_consults: the bounded advisory "second opinion" (Fable 5), one row per
    //     consult, its own cost segment in the request roll-up.
    // A disabled host never runs any of this.
    version: 515,
    name: 'mock2_cost_truth_request_usage_consults',
    up: (d) => {
      d.exec(`
        CREATE TABLE mock2_requests (
          id INTEGER PRIMARY KEY,
          project_id INTEGER NOT NULL,
          instruction TEXT,
          status TEXT NOT NULL DEFAULT 'open',
          initiated_by INTEGER,
          acting_as_admin INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          finished_at TEXT
        );
        CREATE INDEX idx_mock2_requests_project ON mock2_requests (project_id, id);

        ALTER TABLE mock2_cycles ADD COLUMN request_id INTEGER;
        ALTER TABLE mock2_cycles ADD COLUMN segment TEXT;
        ALTER TABLE mock2_cycles ADD COLUMN input_tokens INTEGER;
        ALTER TABLE mock2_cycles ADD COLUMN output_tokens INTEGER;
        ALTER TABLE mock2_cycles ADD COLUMN cache_read_tokens INTEGER;
        ALTER TABLE mock2_cycles ADD COLUMN cache_write_tokens INTEGER;
        ALTER TABLE mock2_cycles ADD COLUMN usage_schema_version INTEGER;
        CREATE INDEX idx_mock2_cycles_request ON mock2_cycles (request_id);

        CREATE TABLE mock2_consults (
          id INTEGER PRIMARY KEY,
          project_id INTEGER NOT NULL,
          request_id INTEGER,
          cycle_id INTEGER,
          trigger TEXT NOT NULL,
          model TEXT,
          input_tokens INTEGER NOT NULL DEFAULT 0,
          output_tokens INTEGER NOT NULL DEFAULT 0,
          cost_cents REAL NOT NULL DEFAULT 0,
          diagnosis TEXT,
          paths_json TEXT,
          suggested_resume TEXT,
          requested_by INTEGER,
          created_at TEXT NOT NULL
        );
        CREATE INDEX idx_mock2_consults_request ON mock2_consults (request_id);
        CREATE INDEX idx_mock2_consults_cycle ON mock2_consults (cycle_id);
      `);
    },
  },
  {
    // Component library (docs/features/component-library.md). Reusable, versioned
    // building blocks (an LDAPS connection module, a rate limiter, …) the build
    // runner is told about and can pull verbatim, so repeated needs are met with
    // ONE audited implementation instead of a fresh AI rewrite each time.
    //   - mock2_components: the registry row — a stable key, display metadata, and
    //     a lifecycle status (draft = admin-only WIP, published = offered to every
    //     build, deprecated = kept for history but no longer offered).
    //   - mock2_component_versions: append-only content ([{path, content}] files +
    //     integration notes). change_reason is NOT NULL by design: every version
    //     carries WHY it exists (the annotated swap/upgrade record). Revert = a
    //     NEW version carrying old content, same idiom as mock2_framework_versions.
    //   - mock2_component_submissions: the in-platform promotion path — a project
    //     editor proposes files from their project as a new component (or a new
    //     version of an existing one); an admin approves/rejects with a reason.
    // Additive; a disabled host never writes any of this.
    version: 516,
    name: 'mock2_component_library',
    up: (d) => {
      d.exec(`
        CREATE TABLE mock2_components (
          id INTEGER PRIMARY KEY,
          key TEXT NOT NULL UNIQUE,
          name TEXT NOT NULL,
          description TEXT,
          category TEXT,
          tags TEXT,
          status TEXT NOT NULL DEFAULT 'published'
            CHECK (status IN ('draft','published','deprecated')),
          current_version_id INTEGER,
          created_by INTEGER NOT NULL,
          created_at TEXT,
          updated_at TEXT
        );

        CREATE TABLE mock2_component_versions (
          id INTEGER PRIMARY KEY,
          component_id INTEGER NOT NULL,
          version INTEGER NOT NULL,
          files_json TEXT NOT NULL,
          usage_md TEXT,
          change_reason TEXT NOT NULL,
          reverted_from_version INTEGER,
          source TEXT NOT NULL DEFAULT 'in_app'
            CHECK (source IN ('in_app','import','submission','revert')),
          source_project_id INTEGER,
          submission_id INTEGER,
          created_by INTEGER NOT NULL,
          created_at TEXT,
          UNIQUE (component_id, version)
        );
        CREATE INDEX idx_mock2_component_versions_component
          ON mock2_component_versions (component_id, version);

        CREATE TABLE mock2_component_submissions (
          id INTEGER PRIMARY KEY,
          project_id INTEGER NOT NULL,
          component_id INTEGER,
          proposed_key TEXT,
          proposed_name TEXT NOT NULL,
          description TEXT,
          category TEXT,
          tags TEXT,
          files_json TEXT NOT NULL,
          usage_md TEXT,
          notes TEXT,
          status TEXT NOT NULL DEFAULT 'pending'
            CHECK (status IN ('pending','approved','rejected','withdrawn')),
          review_reason TEXT,
          reviewed_by INTEGER,
          reviewed_at TEXT,
          result_component_id INTEGER,
          result_version_id INTEGER,
          created_by INTEGER NOT NULL,
          created_at TEXT
        );
        CREATE INDEX idx_mock2_component_submissions_status
          ON mock2_component_submissions (status, id);
        CREATE INDEX idx_mock2_component_submissions_project
          ON mock2_component_submissions (project_id, id);
      `);
    },
  },
  {
    // Declared, admin-approved outbound egress grants. Same "declared, never
    // discovered" discipline as ports: an app declares the internal hosts it must
    // reach in mock2.yaml `egress:`, each becomes a PENDING grant + an admin-queue
    // item (kind egress_grant), and only APPROVED grants are wired into the
    // project's nftables fence at deploy/reconcile (scoped to that project's
    // bridge). Adding the egress_grant queue kind needs the queue CHECK rebuilt
    // (SQLite can't ALTER a CHECK) — a plain table rebuild, dedupe_key UNIQUE is
    // re-declared inline.
    version: 517,
    name: 'mock2_egress_grants',
    up: (d) => {
      d.exec(`
        CREATE TABLE mock2_queue_items_new (
          id INTEGER PRIMARY KEY,
          project_id INTEGER NOT NULL,
          kind TEXT NOT NULL CHECK (kind IN
            ('framework_deviation','drift','retries_exhausted','flag','orphaned',
             'port_drift','quota_exhausted','provisioning_failed','renewal_failed','egress_grant')),
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
        INSERT INTO mock2_queue_items_new
          (id, project_id, kind, ref_table, ref_id, detail, status, dedupe_key, raised_at, resolved_by, resolved_at, resolution)
          SELECT id, project_id, kind, ref_table, ref_id, detail, status, dedupe_key, raised_at, resolved_by, resolved_at, resolution
          FROM mock2_queue_items;
        DROP TABLE mock2_queue_items;
        ALTER TABLE mock2_queue_items_new RENAME TO mock2_queue_items;

        CREATE TABLE mock2_egress_grants (
          id INTEGER PRIMARY KEY,
          project_id INTEGER NOT NULL,
          host TEXT NOT NULL,
          port INTEGER NOT NULL,
          protocol TEXT NOT NULL DEFAULT 'tcp',
          reason TEXT,
          status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','denied','revoked')),
          reachable TEXT,
          requested_at TEXT NOT NULL DEFAULT (datetime('now')),
          decided_by INTEGER,
          decided_at TEXT,
          UNIQUE(project_id, host, port, protocol)
        );
        CREATE INDEX idx_mock2_egress_grants_project ON mock2_egress_grants(project_id, status);
      `);
    },
  },
  {
    // Acceptance discipline (cycle-94 lesson — a bug-fix cycle "succeeded" with
    // green gates while the defect was never reproduced). acceptance_json stores
    // the machine-readable acceptance state stamped at finish: {kind, defect_tag,
    // red_test_observed, tests, ui_required, demonstrated}. NULLable — every
    // pre-existing row reads as before; a disabled host never writes it.
    // (Renumbered 517→518 in the merge: main's egress grants took 517.)
    version: 518,
    name: 'mock2_cycle_acceptance_state',
    up: (d) => {
      d.exec(`
        ALTER TABLE mock2_cycles ADD COLUMN acceptance_json TEXT;
      `);
    },
  },
  {
    // Design-template import (design-template-logic.js). When a project's
    // Concept stage is seeded from an exported design template (or another
    // project's design), this records the provenance, the ORIGINAL design
    // brief, and the Builder's changes/context notes — the initial build after
    // approval quotes them so the built app references the original design
    // intent even when the imported mockup is approved untouched. NULLable —
    // every home-grown project reads as before; a disabled host never writes it.
    version: 519,
    name: 'mock2_design_import',
    up: (d) => {
      d.exec(`
        ALTER TABLE mock2_projects ADD COLUMN design_import_json TEXT;
      `);
    },
  },
  {
    // Integration truthfulness (AUDIT.md; B.4/B.5). Strictly additive + nullable,
    // reversible, no row rewrites — behavior is byte-identical until code opts in.
    //   - mock2_cycles.verification_state: NULL (no external integrations in scope,
    //     the pre-existing behavior) | 'pending' (all in-fence gates green, live
    //     verification outstanding — the new pending-operator-verification outcome)
    //     | 'verified' (all checklist items confirmed/waived). It is the ONLY
    //     signal that distinguishes "succeeded" from "pending-operator-verification"
    //     for a cycle that touched a manifest-declared integration.
    //   - mock2_cycles.integration_gate_json: the B.4 integration-gate result
    //     (verdict + findings + analyzer limits + the manifest hash it ran against),
    //     stamped at finish so the record is accountable to what the gate saw.
    //   - mock2_integration_verifications: append-only operator-verification
    //     evidence (checklist item + manifest id/hash + operator identity +
    //     observed result / waiver + supersession chain). Historical rows are
    //     NEVER mutated; a superseding reverification inserts a NEW row referencing
    //     the one it supersedes (supersedes_id).
    //   - mock2_integration_findings: append-only integration-gate / screening /
    //     migration findings, hash-referenced to the change record or framework
    //     audit that produced them (source_ref), with a blocking flag and the
    //     touched-subsystem/reconciliation escalation state.
    // A disabled host never runs any of this.
    version: 520,
    name: 'mock2_integration_truthfulness',
    up: (d) => {
      d.exec(`
        ALTER TABLE mock2_cycles ADD COLUMN verification_state TEXT;
        ALTER TABLE mock2_cycles ADD COLUMN integration_gate_json TEXT;

        CREATE TABLE mock2_integration_verifications (
          id INTEGER PRIMARY KEY,
          project_id INTEGER NOT NULL,
          cycle_id INTEGER,
          item_id TEXT NOT NULL,
          manifest_id TEXT NOT NULL,
          manifest_hash TEXT NOT NULL,
          subsystem TEXT,
          operator_id INTEGER NOT NULL,
          role TEXT NOT NULL DEFAULT 'operator',
          environment TEXT NOT NULL,
          endpoint_classification TEXT NOT NULL,
          observed_result TEXT,
          waived INTEGER NOT NULL DEFAULT 0,
          waiver_reason TEXT,
          evidence_ref TEXT,
          expires_at TEXT,
          supersedes_id INTEGER,
          superseded_at TEXT,
          content_hash TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE INDEX idx_mock2_int_verif_project ON mock2_integration_verifications (project_id, item_id);
        CREATE INDEX idx_mock2_int_verif_cycle ON mock2_integration_verifications (cycle_id);

        CREATE TABLE mock2_integration_findings (
          id INTEGER PRIMARY KEY,
          project_id INTEGER NOT NULL,
          cycle_id INTEGER,
          origin TEXT NOT NULL,
          kind TEXT NOT NULL,
          subsystem TEXT,
          file TEXT,
          detail TEXT,
          severity TEXT,
          blocking INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL DEFAULT 'open',
          framework_version_id INTEGER,
          source_ref TEXT,
          content_hash TEXT NOT NULL,
          resolved_by INTEGER,
          resolved_reason TEXT,
          resolved_at TEXT,
          created_at TEXT NOT NULL
        );
        CREATE INDEX idx_mock2_int_findings_project ON mock2_integration_findings (project_id, status);
        CREATE INDEX idx_mock2_int_findings_subsystem ON mock2_integration_findings (project_id, subsystem);
      `);
    },
  },
  {
    // Portable framework export/import ("download the harness"). An imported
    // framework version records source='import' so its provenance is honest —
    // but mock2_framework_versions' source CHECK (migration 501) only allowed
    // ('in_app','git_sync'). SQLite can't ALTER a CHECK, so rebuild the table
    // widening it to add 'import' (same idiom as migration 517's queue rebuild).
    // Every column, row, index-worthy UNIQUE, and value is preserved verbatim;
    // this is purely a constraint widening. Additive in effect (no existing row
    // changes); a disabled host never runs it.
    version: 521,
    name: 'mock2_framework_import_source',
    up: (d) => {
      d.exec(`
        CREATE TABLE mock2_framework_versions_new (
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
            CHECK (source IN ('in_app','git_sync','import')),
          source_git_commit TEXT,
          created_by INTEGER NOT NULL,
          created_at TEXT
        );
        INSERT INTO mock2_framework_versions_new
          (id, version, constitution_md, skills_json, gates_json, design_system_md,
           project_template_ref, changelog, reverted_from_version, source, source_git_commit,
           created_by, created_at)
          SELECT id, version, constitution_md, skills_json, gates_json, design_system_md,
                 project_template_ref, changelog, reverted_from_version, source, source_git_commit,
                 created_by, created_at
          FROM mock2_framework_versions;
        DROP TABLE mock2_framework_versions;
        ALTER TABLE mock2_framework_versions_new RENAME TO mock2_framework_versions;
      `);
    },
  },
  {
    // PATCH — the blocked-deviation resolution records (B.1 manifest backfill +
    // B.2 analysis-limitation waiver). Both are APPEND-ONLY + content-hashed,
    // hash-referencing the cycle they resolved, consistent with the migration-520
    // integration records (never rewritten). Additive; a disabled host never runs it.
    //   - mock2_integration_resolutions: one row per operator/admin resolution
    //     action on a blocked-deviation finding — the manifest-backfill entry that
    //     was committed, or the analysis-limitation waiver (with the inspected
    //     file/function, the analyzer's stated limitation, and the manifest hash
    //     that will re-open it). kind distinguishes them; routed_to records the
    //     lifecycle target (building for backfill, pending-operator-verification
    //     for a waiver — a waiver NEVER routes to succeeded).
    version: 522,
    name: 'mock2_integration_resolutions',
    up: (d) => {
      d.exec(`
        CREATE TABLE mock2_integration_resolutions (
          id INTEGER PRIMARY KEY,
          project_id INTEGER NOT NULL,
          cycle_id INTEGER,
          kind TEXT NOT NULL,
          finding_class TEXT,
          finding_kind TEXT,
          subsystem TEXT,
          file TEXT,
          inspected TEXT,
          analyzer_limitation TEXT,
          manifest_id TEXT,
          manifest_hash TEXT,
          manifest_entry_json TEXT,
          reason TEXT,
          routed_to TEXT,
          decided_by INTEGER NOT NULL,
          role TEXT NOT NULL DEFAULT 'operator',
          content_hash TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE INDEX idx_mock2_int_resolutions_project ON mock2_integration_resolutions (project_id, kind);
        CREATE INDEX idx_mock2_int_resolutions_cycle ON mock2_integration_resolutions (cycle_id);
      `);
    },
  },
  {
    // Operator-initiated egress grants. An egress grant used to originate ONLY
    // from the app's mock2.yaml `egress:` declaration, so an operator who knew a
    // build needed to reach a LAN host (a directory server, an ADP endpoint) had
    // no lever until the app declared it. This adds an `origin` column so an admin
    // can add an APPROVED grant directly ('operator'), wired through the same
    // fence-reconcile path as declared grants. syncDeclaredEgress reconciles ONLY
    // 'declared' rows, so an operator grant is never revoked by a mock2.yaml sweep.
    // Additive + NULLable-safe: every pre-existing row defaults to 'declared', so
    // behavior is unchanged until an operator adds one.
    version: 523,
    name: 'mock2_egress_grant_origin',
    up: (d) => {
      d.exec(`ALTER TABLE mock2_egress_grants ADD COLUMN origin TEXT NOT NULL DEFAULT 'declared';`);
    },
  },
  {
    // API-driven components: (1) a version-pinned machine-readable CONTRACT on
    // each component version (contract_json — provides/api/config/connections/
    // dependencies/migrations, validated by component-logic.validateComponentContract;
    // immutable like files_json); (2) per-project component SELECTION — which
    // components a project uses, decided at define time (suggested → confirmed/
    // declined) or by an operator, and installed deterministically by the
    // platform (no model tokens) before the build runner starts. question_id
    // links a 'suggested' row to its component_suggestion audit question so the
    // answer handler can find it; install_manifest_json records exactly what
    // landed (paths/bytes/sha256 — never contents). (3) the audit-question kind
    // CHECK gains 'component_suggestion' — SQLite can't ALTER a CHECK, so the
    // table is rebuilt (same idiom as the 517 queue rebuild); data is copied
    // verbatim.
    version: 524,
    name: 'mock2_component_contracts_and_selection',
    up: (d) => {
      d.exec(`
        ALTER TABLE mock2_component_versions ADD COLUMN contract_json TEXT;

        CREATE TABLE mock2_project_components (
          id INTEGER PRIMARY KEY,
          project_id INTEGER NOT NULL,
          component_id INTEGER NOT NULL,
          version_id INTEGER,
          status TEXT NOT NULL DEFAULT 'suggested'
            CHECK (status IN ('suggested','confirmed','declined','installed','install_failed')),
          origin TEXT NOT NULL DEFAULT 'define'
            CHECK (origin IN ('concept','define','operator')),
          options_json TEXT,
          question_id INTEGER,
          selected_by INTEGER,
          decided_at TEXT,
          installed_at TEXT,
          install_manifest_json TEXT,
          install_error TEXT,
          created_at TEXT,
          updated_at TEXT,
          UNIQUE (project_id, component_id)
        );
        CREATE INDEX idx_mock2_project_components_project
          ON mock2_project_components (project_id, status);

        CREATE TABLE mock2_audit_questions_new (
          id INTEGER PRIMARY KEY,
          project_id INTEGER NOT NULL,
          cycle_id INTEGER NOT NULL,
          route TEXT NOT NULL CHECK (route IN ('editor','admin')),
          kind TEXT NOT NULL CHECK (kind IN
            ('domain_question','framework_deviation','rule_contradiction','rule_gap','component_suggestion')),
          question TEXT NOT NULL,
          choices_json TEXT,
          status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','answered','dismissed')),
          answer TEXT,
          answered_by INTEGER,
          answered_at TEXT,
          rules_md_anchor TEXT,
          created_at TEXT
        );
        INSERT INTO mock2_audit_questions_new
          SELECT id, project_id, cycle_id, route, kind, question, choices_json,
                 status, answer, answered_by, answered_at, rules_md_anchor, created_at
            FROM mock2_audit_questions;
        DROP TABLE mock2_audit_questions;
        ALTER TABLE mock2_audit_questions_new RENAME TO mock2_audit_questions;
      `);
    },
  },
  {
    // Model routing (reviewable + tunable). (1) routing_json on mock2_cycles —
    // the decision the cycle ran under (task kind, difficulty, model, effort,
    // rung, reason), stamped at start so every build's routing is reviewable in
    // the logs. (2) mock2_routing_rules — the KNOWLEDGE BASE / reference
    // dictionary: one admin-editable row per task kind mapping to a model
    // override, an escalation model, and an effort level (all nullable — a
    // fresh install behaves exactly as before; routing.js seeds the default
    // kinds). (3) mock2_routing_outcomes — append-only evidence: one row per
    // terminal routed build cycle (model/effort/rung/status/cost/tokens), the
    // data an operator reviews to fine-tune the dictionary. All additive.
    version: 525,
    name: 'mock2_model_routing',
    up: (d) => {
      d.exec(`
        ALTER TABLE mock2_cycles ADD COLUMN routing_json TEXT;

        CREATE TABLE mock2_routing_rules (
          id INTEGER PRIMARY KEY,
          task_kind TEXT NOT NULL UNIQUE,
          label TEXT,
          model TEXT,
          escalate_model TEXT,
          effort TEXT CHECK (effort IN ('low','medium','high','xhigh','max') OR effort IS NULL),
          enabled INTEGER NOT NULL DEFAULT 1,
          notes TEXT,
          updated_by INTEGER,
          created_at TEXT,
          updated_at TEXT
        );

        CREATE TABLE mock2_routing_outcomes (
          id INTEGER PRIMARY KEY,
          project_id INTEGER NOT NULL,
          cycle_id INTEGER NOT NULL,
          request_id INTEGER,
          task_kind TEXT NOT NULL DEFAULT 'default',
          difficulty INTEGER,
          model TEXT,
          effort TEXT,
          rung INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL,
          cost_cents INTEGER NOT NULL DEFAULT 0,
          tokens INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL
        );
        CREATE INDEX idx_mock2_routing_outcomes_kind ON mock2_routing_outcomes (task_kind, id);
        CREATE UNIQUE INDEX idx_mock2_routing_outcomes_cycle ON mock2_routing_outcomes (cycle_id);
      `);
    },
  },
  {
    // Multi-modal chat: image attachments on chat messages (concept chat + ask
    // lane) and on requests (the build umbrella — images attached to a Build
    // press ride every segment of that request: audit + build + resumes).
    // The column holds small descriptors ([{id, bytes, name}]); bytes live on
    // disk at MOCK2_DATA_DIR/chat-images/<projectId>/<sha256>.<ext>.
    version: 526,
    name: 'mock2_chat_image_attachments',
    up: (d) => {
      d.exec(`
        ALTER TABLE mock2_chat_messages ADD COLUMN attachments_json TEXT;
        ALTER TABLE mock2_requests ADD COLUMN attachments_json TEXT;
      `);
    },
  },
  {
    // Per-response spend: assistant chat messages carry what they cost (the ask
    // lane's whole tool loop; a concept turn's chat + mockup calls), so the
    // price of an answer is visible ON the answer. cost_cents is REAL —
    // fractional cents accumulate exactly like used_cost_cents on cycles.
    version: 527,
    name: 'mock2_chat_message_spend',
    up: (d) => {
      d.exec(`
        ALTER TABLE mock2_chat_messages ADD COLUMN cost_cents REAL;
        ALTER TABLE mock2_chat_messages ADD COLUMN tokens INTEGER;
      `);
    },
  },
  {
    // Component auto-apply: selection rows the PLATFORM confirms (the
    // component_auto_apply setting — every published component on every build)
    // carry origin 'auto', distinct from a human confirm. SQLite can't ALTER a
    // CHECK, so the table is rebuilt (same idiom as 524); data copies verbatim.
    version: 528,
    name: 'mock2_project_component_origin_auto',
    up: (d) => {
      d.exec(`
        CREATE TABLE mock2_project_components_new (
          id INTEGER PRIMARY KEY,
          project_id INTEGER NOT NULL,
          component_id INTEGER NOT NULL,
          version_id INTEGER,
          status TEXT NOT NULL DEFAULT 'suggested'
            CHECK (status IN ('suggested','confirmed','declined','installed','install_failed')),
          origin TEXT NOT NULL DEFAULT 'define'
            CHECK (origin IN ('concept','define','operator','auto')),
          options_json TEXT,
          question_id INTEGER,
          selected_by INTEGER,
          decided_at TEXT,
          installed_at TEXT,
          install_manifest_json TEXT,
          install_error TEXT,
          created_at TEXT,
          updated_at TEXT,
          UNIQUE (project_id, component_id)
        );
        INSERT INTO mock2_project_components_new
          SELECT id, project_id, component_id, version_id, status, origin, options_json,
                 question_id, selected_by, decided_at, installed_at, install_manifest_json,
                 install_error, created_at, updated_at
            FROM mock2_project_components;
        DROP TABLE mock2_project_components;
        ALTER TABLE mock2_project_components_new RENAME TO mock2_project_components;
        CREATE INDEX idx_mock2_project_components_project
          ON mock2_project_components (project_id, status);
      `);
    },
  },
  {
    // Build modes (full vs MVP): the request — the umbrella one-ask record —
    // remembers which mode it was started in, so every segment (the build and
    // any resume) runs with the same mode. Additive; every pre-existing request
    // defaults to 'full' (unchanged behavior).
    version: 529,
    name: 'mock2_request_build_mode',
    up: (d) => {
      d.exec(`ALTER TABLE mock2_requests ADD COLUMN build_mode TEXT NOT NULL DEFAULT 'full';`);
    },
  },
  {
    // Design presets (base look chosen at project creation): the project
    // remembers which preset seeded its design tokens, so the Concept prompts
    // stay bound to it. NULL/'ai' = no preset (the mockup model picks the look
    // — pre-existing behavior, unchanged).
    version: 530,
    name: 'mock2_project_design_preset',
    up: (d) => {
      d.exec(`ALTER TABLE mock2_projects ADD COLUMN design_preset TEXT;`);
    },
  },
  {
    // The screen plan (per-screen apply): design approval breaks the extracted
    // inventory into one row per screen so the Builder can approve/defer
    // screens individually and apply them as SMALL scoped background builds
    // (one MVP build request per screen, drained sequentially) instead of one
    // monolithic initial build. status: planned → queued → building →
    // built | failed; deferred is parked. request_id ties a screen to the
    // build request that implemented it.
    version: 531,
    name: 'mock2_screen_plan',
    up: (d) => {
      d.exec(`
        CREATE TABLE mock2_screen_plan (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          project_id INTEGER NOT NULL,
          name TEXT NOT NULL,
          purpose TEXT,
          sort INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL DEFAULT 'planned',
          request_id INTEGER,
          queued_by INTEGER,
          error TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE (project_id, name)
        );
        CREATE INDEX idx_mock2_screen_plan_project ON mock2_screen_plan (project_id, status);
      `);
    },
  },
  {
    // Base-app deploy marker: the provision-time (or skip-triggered) deploy of
    // the scaffold has no build cycle, so projectHasBeenDeployed (which scans
    // cycle deploy_status) can't see it. Stamp it on the project row so the
    // skip self-heal doesn't redeploy needlessly and rehydrate restores the
    // base app instead of the placeholder.
    version: 532,
    name: 'mock2_project_base_app_deployed',
    up: (d) => {
      d.exec(`ALTER TABLE mock2_projects ADD COLUMN base_app_deployed_at TEXT;`);
    },
  },
  {
    // Per-project agent harness ('proxypilot' | 'claude'). NULL (every existing
    // row, and any project that never touches the toggle) means "no explicit
    // choice": the runner keeps its pre-existing selection — the hand-rolled
    // loop, or the SDK loop when the legacy global BUILD_RUNNER=sdk flag is set
    // — so nothing changes behavior until a person flips the toggle. The value
    // vocabulary is enforced in code (normalizeHarness), not a CHECK, so a
    // future harness doesn't need a schema migration.
    version: 533,
    name: 'mock2_project_harness',
    up: (d) => {
      d.exec(`ALTER TABLE mock2_projects ADD COLUMN harness TEXT;`);
    },
  },
  {
    // Custom design presets: operator-uploaded (proxypilot-design@1 documents)
    // or AI-adjusted variants, merged with the built-in presets at read time
    // (design-presets.js setCustomPresets overlay). 534 — 533 was taken by the
    // harness column on main while this shipped on the feature branch.
    version: 534,
    name: 'mock2_custom_design_presets',
    up: (d) => {
      d.exec(`
        CREATE TABLE IF NOT EXISTS mock2_design_presets (
          key         TEXT PRIMARY KEY,
          name        TEXT NOT NULL,
          description TEXT,
          tokens_json TEXT NOT NULL,
          created_by  INTEGER,
          created_at  TEXT NOT NULL,
          updated_at  TEXT NOT NULL
        );
      `);
    },
  },
];
