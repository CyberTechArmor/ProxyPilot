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
];
