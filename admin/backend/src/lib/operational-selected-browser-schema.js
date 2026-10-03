// Additive selected-browser state. Historical synthetic/API records are untouched.
export function operationalSelectedBrowserMigration1118(db) {
  db.exec(`
    CREATE TABLE ops_selected_browser_consents (
      configuration_id TEXT PRIMARY KEY REFERENCES ops_browser_agent_configurations(id),
      project_id TEXT NOT NULL REFERENCES ops_projects(id),
      configuration_revision INTEGER NOT NULL, configuration_sha256 TEXT NOT NULL,
      guide_id TEXT NOT NULL, guide_sha256 TEXT NOT NULL, owner_user_id TEXT NOT NULL,
      allowed INTEGER NOT NULL CHECK(allowed IN(0,1)), consent_sha256 TEXT NOT NULL,
      reviewed_at TEXT NOT NULL
    );
    CREATE TABLE ops_selected_browser_runs (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES ops_projects(id),
      configuration_id TEXT NOT NULL REFERENCES ops_browser_agent_configurations(id),
      idempotency_key TEXT NOT NULL, started_by TEXT NOT NULL, starter_session_id TEXT, owner_user_id TEXT NOT NULL,
      configuration_revision INTEGER NOT NULL, configuration_sha256 TEXT NOT NULL,
      configuration_json TEXT NOT NULL CHECK(json_valid(configuration_json)),
      guide_id TEXT NOT NULL, guide_sha256 TEXT NOT NULL, consent_sha256 TEXT NOT NULL,
      project_revision INTEGER NOT NULL, project_limits_revision INTEGER NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0),
      state TEXT NOT NULL CHECK(state IN('preparing','running','paused','awaiting_approval','human_control','stopping','completed','cancelled','failed','uncertain')),
      attempt_id TEXT NOT NULL UNIQUE, fence INTEGER NOT NULL DEFAULT 1 CHECK(fence>0),
      ordinal INTEGER NOT NULL DEFAULT 0, usage_json TEXT NOT NULL CHECK(json_valid(usage_json)),
      network_state_json TEXT NOT NULL DEFAULT '{"inflight_action":false,"effects_sent":0,"effects_uncertain":0}' CHECK(json_valid(network_state_json)),
      manual_auth INTEGER NOT NULL DEFAULT 0 CHECK(manual_auth IN(0,1)), controller_user_id TEXT, controller_session_id TEXT,
      started_at TEXT NOT NULL, deadline_at TEXT NOT NULL, ended_at TEXT,
      result_code TEXT, report_json TEXT CHECK(report_json IS NULL OR json_valid(report_json)),
      UNIQUE(project_id,idempotency_key)
    );
    CREATE UNIQUE INDEX ops_selected_browser_one_active ON ops_selected_browser_runs(configuration_id)
      WHERE state IN('preparing','running','paused','awaiting_approval','human_control','stopping');
    CREATE TRIGGER ops_selected_browser_run_pins BEFORE UPDATE ON ops_selected_browser_runs
      WHEN NEW.project_id IS NOT OLD.project_id OR NEW.configuration_id IS NOT OLD.configuration_id
        OR NEW.started_by IS NOT OLD.started_by OR NEW.starter_session_id IS NOT OLD.starter_session_id OR NEW.owner_user_id IS NOT OLD.owner_user_id
        OR NEW.configuration_revision IS NOT OLD.configuration_revision OR NEW.configuration_sha256 IS NOT OLD.configuration_sha256
        OR NEW.configuration_json IS NOT OLD.configuration_json OR NEW.guide_id IS NOT OLD.guide_id
        OR NEW.guide_sha256 IS NOT OLD.guide_sha256 OR NEW.consent_sha256 IS NOT OLD.consent_sha256
        OR NEW.project_revision IS NOT OLD.project_revision OR NEW.project_limits_revision IS NOT OLD.project_limits_revision
        OR NEW.attempt_id IS NOT OLD.attempt_id OR NEW.started_at IS NOT OLD.started_at OR NEW.deadline_at IS NOT OLD.deadline_at
      BEGIN SELECT RAISE(ABORT,'Selected-browser run pins are immutable'); END;
    CREATE TRIGGER ops_selected_browser_terminal_report BEFORE UPDATE OF report_json ON ops_selected_browser_runs
      WHEN OLD.state IN('completed','cancelled','failed','uncertain') AND NEW.report_json IS NOT OLD.report_json
      BEGIN SELECT RAISE(ABORT,'Selected-browser historical report is immutable'); END;
    CREATE TABLE ops_selected_browser_attempts (
      id TEXT PRIMARY KEY, run_id TEXT NOT NULL UNIQUE REFERENCES ops_selected_browser_runs(id),
      fence INTEGER NOT NULL CHECK(fence>0), state TEXT NOT NULL,
      started_at TEXT NOT NULL, ended_at TEXT, cleanup_json TEXT CHECK(cleanup_json IS NULL OR json_valid(cleanup_json))
    );
    CREATE TABLE ops_selected_browser_steps (
      id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES ops_selected_browser_runs(id),
      attempt_id TEXT NOT NULL REFERENCES ops_selected_browser_attempts(id), fence INTEGER NOT NULL,
      ordinal INTEGER NOT NULL, action_sha256 TEXT NOT NULL, action_json TEXT NOT NULL CHECK(json_valid(action_json)),
      effect TEXT NOT NULL CHECK(effect IN('read','local','external_change','unknown')),
      state TEXT NOT NULL CHECK(state IN('reserved','done','blocked','uncertain','suppressed')),
      outcome_json TEXT CHECK(outcome_json IS NULL OR json_valid(outcome_json)), created_at TEXT NOT NULL, ended_at TEXT,
      UNIQUE(run_id,ordinal)
    );
    CREATE TABLE ops_selected_browser_approvals (
      id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES ops_selected_browser_runs(id),
      attempt_id TEXT NOT NULL REFERENCES ops_selected_browser_attempts(id), fence INTEGER NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN('consequential_action','off_list_destination','network_effect','input_draft')),
      state TEXT NOT NULL CHECK(state IN('pending','approved','denied','consumed','stale','expired')),
      action_sha256 TEXT NOT NULL, payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
      created_at TEXT NOT NULL, expires_at TEXT NOT NULL, decided_by TEXT, decided_at TEXT, consumed_at TEXT
    );
    CREATE UNIQUE INDEX ops_selected_browser_one_approval ON ops_selected_browser_approvals(run_id,action_sha256,kind) WHERE state='pending';
    CREATE TRIGGER ops_selected_browser_step_pins BEFORE UPDATE ON ops_selected_browser_steps
      WHEN NEW.id IS NOT OLD.id OR NEW.run_id IS NOT OLD.run_id OR NEW.attempt_id IS NOT OLD.attempt_id
        OR NEW.fence IS NOT OLD.fence OR NEW.ordinal IS NOT OLD.ordinal OR NEW.action_sha256 IS NOT OLD.action_sha256
        OR NEW.action_json IS NOT OLD.action_json OR NEW.effect IS NOT OLD.effect OR NEW.created_at IS NOT OLD.created_at
      BEGIN SELECT RAISE(ABORT,'Selected-browser action pins are immutable'); END;
    CREATE TRIGGER ops_selected_browser_approval_pins BEFORE UPDATE ON ops_selected_browser_approvals
      WHEN NEW.id IS NOT OLD.id OR NEW.run_id IS NOT OLD.run_id OR NEW.attempt_id IS NOT OLD.attempt_id
        OR NEW.fence IS NOT OLD.fence OR NEW.kind IS NOT OLD.kind OR NEW.action_sha256 IS NOT OLD.action_sha256
        OR NEW.payload_json IS NOT OLD.payload_json OR NEW.created_at IS NOT OLD.created_at OR NEW.expires_at IS NOT OLD.expires_at
      BEGIN SELECT RAISE(ABORT,'Selected-browser approval pins are immutable'); END;
    CREATE TABLE ops_selected_browser_destination_grants (
      id TEXT PRIMARY KEY, approval_id TEXT NOT NULL UNIQUE REFERENCES ops_selected_browser_approvals(id),
      run_id TEXT NOT NULL REFERENCES ops_selected_browser_runs(id), attempt_id TEXT NOT NULL,
      fence INTEGER NOT NULL, origin TEXT NOT NULL, purpose TEXT NOT NULL, request_ref TEXT NOT NULL,
      scope_sha256 TEXT NOT NULL, grant_json TEXT NOT NULL CHECK(json_valid(grant_json)),
      expires_at TEXT NOT NULL, consumed_at TEXT
    );
    CREATE TABLE ops_selected_browser_model_reservations (
      id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES ops_selected_browser_runs(id), attempt_id TEXT NOT NULL,
      fence INTEGER NOT NULL, ordinal INTEGER NOT NULL, purpose TEXT NOT NULL CHECK(purpose IN('decision','report','draft_input')),
      state TEXT NOT NULL CHECK(state IN('reserved','settled','uncertain','suppressed')),
      reserved_tokens INTEGER NOT NULL CHECK(reserved_tokens>0), reserved_usd REAL NOT NULL CHECK(reserved_usd>=0),
      price_table_revision INTEGER NOT NULL CHECK(price_table_revision>0), request_sha256 TEXT, receipt_json TEXT,
      actual_tokens INTEGER, actual_usd REAL, created_at TEXT NOT NULL, ended_at TEXT
    );
    CREATE TABLE ops_selected_browser_uncertainties (
      id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES ops_selected_browser_runs(id),
      step_id TEXT, kind TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN('unresolved','reconciled')),
      created_at TEXT NOT NULL, decided_by TEXT, decided_at TEXT, decision TEXT,
      UNIQUE(run_id,step_id,kind)
    );
    CREATE TABLE ops_selected_browser_sources (
      id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES ops_selected_browser_runs(id),
      attempt_id TEXT NOT NULL, fence INTEGER NOT NULL, snapshot_ref_json TEXT NOT NULL CHECK(json_valid(snapshot_ref_json)),
      artifact_ref_json TEXT NOT NULL CHECK(json_valid(artifact_ref_json)), content_sha256 TEXT NOT NULL,
      configuration_sha256 TEXT NOT NULL, guide_sha256 TEXT NOT NULL, consent_sha256 TEXT NOT NULL,
      origin TEXT, url_sha256 TEXT, captured_at TEXT NOT NULL,
      worker_contract TEXT NOT NULL CHECK(worker_contract='selected-browser.v1'),
      chunker_version TEXT NOT NULL CHECK(chunker_version='browser-text.v1'), original_bytes INTEGER NOT NULL,
      truncated INTEGER NOT NULL CHECK(truncated IN(0,1)), disclosed_calls_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(disclosed_calls_json)),
      UNIQUE(run_id,snapshot_ref_json)
    );
    CREATE TRIGGER ops_selected_browser_source_pins BEFORE UPDATE ON ops_selected_browser_sources
      WHEN NEW.id IS NOT OLD.id OR NEW.run_id IS NOT OLD.run_id OR NEW.attempt_id IS NOT OLD.attempt_id
        OR NEW.fence IS NOT OLD.fence OR NEW.snapshot_ref_json IS NOT OLD.snapshot_ref_json
        OR NEW.artifact_ref_json IS NOT OLD.artifact_ref_json OR NEW.content_sha256 IS NOT OLD.content_sha256
        OR NEW.configuration_sha256 IS NOT OLD.configuration_sha256 OR NEW.guide_sha256 IS NOT OLD.guide_sha256
        OR NEW.consent_sha256 IS NOT OLD.consent_sha256 OR NEW.origin IS NOT OLD.origin OR NEW.url_sha256 IS NOT OLD.url_sha256
        OR NEW.captured_at IS NOT OLD.captured_at OR NEW.worker_contract IS NOT OLD.worker_contract
        OR NEW.chunker_version IS NOT OLD.chunker_version OR NEW.original_bytes IS NOT OLD.original_bytes OR NEW.truncated IS NOT OLD.truncated
      BEGIN SELECT RAISE(ABORT,'Selected-browser source identity is immutable'); END;
    CREATE TABLE ops_selected_browser_events (
      id INTEGER PRIMARY KEY, project_id TEXT NOT NULL REFERENCES ops_projects(id),
      run_id TEXT REFERENCES ops_selected_browser_runs(id), attempt_id TEXT,
      actor_id TEXT, kind TEXT NOT NULL, metadata_json TEXT NOT NULL CHECK(json_valid(metadata_json)), created_at TEXT NOT NULL
    );
    CREATE TRIGGER ops_selected_browser_event_no_update BEFORE UPDATE ON ops_selected_browser_events
      BEGIN SELECT RAISE(ABORT,'Selected-browser event is immutable'); END;
    CREATE TRIGGER ops_selected_browser_event_no_delete BEFORE DELETE ON ops_selected_browser_events
      BEGIN SELECT RAISE(ABORT,'Selected-browser event is immutable'); END;
  `);
}

// Run with disableFks in the migration wrapper, outside its transaction. Child
// foreign keys retain the original name; every existing row/pin is copied.
export function operationalPublicNavigationMigration1123(db){
  const table=db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='ops_selected_browser_runs'").get();
  if(db.prepare('PRAGMA table_info(ops_selected_browser_runs)').all().some(c=>c.name==='execution_mode'))return;
  const objects=db.prepare("SELECT sql FROM sqlite_master WHERE tbl_name='ops_selected_browser_runs' AND type IN('index','trigger') AND sql IS NOT NULL").all();
  const columns=db.prepare('PRAGMA table_info(ops_selected_browser_runs)').all().map(c=>c.name);
  let sql=table.sql.replace('ops_selected_browser_runs','ops_selected_browser_runs_expanded')
    .replace('guide_id TEXT NOT NULL','guide_id TEXT').replace('guide_sha256 TEXT NOT NULL','guide_sha256 TEXT').replace('consent_sha256 TEXT NOT NULL','consent_sha256 TEXT');
  sql=sql.replace('id TEXT PRIMARY KEY',"execution_mode TEXT NOT NULL DEFAULT 'agent' CHECK(execution_mode IN('agent','public_navigation')), id TEXT PRIMARY KEY");
  sql=sql.slice(0,sql.lastIndexOf(')'))+", CHECK((execution_mode='agent' AND guide_id IS NOT NULL AND guide_sha256 IS NOT NULL AND consent_sha256 IS NOT NULL) OR (execution_mode='public_navigation' AND guide_id IS NULL AND guide_sha256 IS NULL AND consent_sha256 IS NULL)))";
  db.exec(sql);
  db.exec(`INSERT INTO ops_selected_browser_runs_expanded(${columns.join(',')}) SELECT ${columns.join(',')} FROM ops_selected_browser_runs`);
  db.exec('DROP TABLE ops_selected_browser_runs; ALTER TABLE ops_selected_browser_runs_expanded RENAME TO ops_selected_browser_runs');
  for(const object of objects)db.exec(object.sql);
  db.exec(`CREATE TRIGGER ops_selected_browser_mode_pin BEFORE UPDATE OF execution_mode ON ops_selected_browser_runs WHEN NEW.execution_mode IS NOT OLD.execution_mode BEGIN SELECT RAISE(ABORT,'Selected browser mode is immutable'); END;`);
  if(db.prepare('PRAGMA foreign_key_check').all().length)throw new Error('Public-navigation migration foreign key integrity failure');
}
