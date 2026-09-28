// A5 supervised execution loop. Additive: the run policy pin, typed steps, model
// calls, human approvals and durable results. Nothing here holds page text, a
// credential value, a cookie, a session token or a prompt: steps keep the
// typed claims the runner reduces a page to, model calls keep IDs, usage and
// cost, and approvals keep a digest. A profile records whether its guide may be
// sent to the model provider (default no). History is append-only; a row
// changes only out of its open state, and results never change. A result's
// receipt is NULL only for a run that never reserved an attempt (so no worker
// was ever asked for).
export function operationalRunMigration1111(d) {
  d.exec(`
    ALTER TABLE ops_agent_profiles ADD COLUMN model_guide_consent INTEGER NOT NULL DEFAULT 0
      CHECK(model_guide_consent IN (0,1));
    CREATE TABLE ops_agent_run_pins (
      run_id TEXT PRIMARY KEY REFERENCES ops_agent_runs(id) ON DELETE RESTRICT,
      started_by TEXT NOT NULL,
      policy_json TEXT NOT NULL CHECK(length(policy_json) BETWEEN 2 AND 16384),
      policy_digest TEXT NOT NULL CHECK(length(policy_digest) = 64),
      rules_version INTEGER NOT NULL CHECK(rules_version = 1),
      model_guide_consent INTEGER NOT NULL CHECK(model_guide_consent IN (0,1)),
      created_at TEXT NOT NULL
    );
    CREATE TRIGGER ops_agent_run_pins_no_update BEFORE UPDATE ON ops_agent_run_pins
      BEGIN SELECT RAISE(ABORT,'Run policy pin is immutable'); END;
    CREATE TRIGGER ops_agent_run_pins_no_delete BEFORE DELETE ON ops_agent_run_pins
      BEGIN SELECT RAISE(ABORT,'Run policy pin is immutable'); END;
    CREATE TABLE ops_agent_run_steps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL REFERENCES ops_agent_runs(id) ON DELETE RESTRICT,
      attempt_id TEXT NOT NULL,
      fence INTEGER NOT NULL CHECK(fence > 0),
      ordinal INTEGER NOT NULL CHECK(ordinal > 0),
      action TEXT NOT NULL CHECK(action IN ('open_landing','open_login','submit_bound_fixture',
        'read_workspace','read_session','read_files','sign_out')),
      decided_by TEXT NOT NULL CHECK(decided_by IN ('rule','model')),
      rule TEXT CHECK(rule IS NULL OR rule IN ('start','finish','verify_account','single_choice')),
      model_call_id TEXT,
      approval_id TEXT,
      state TEXT NOT NULL CHECK(state IN ('reserved','done','failed','uncertain')),
      claims_json TEXT NOT NULL DEFAULT '{}' CHECK(length(claims_json) <= 512),
      error_code TEXT CHECK(error_code IS NULL OR length(error_code) <= 64),
      created_at TEXT NOT NULL,
      finished_at TEXT,
      UNIQUE(run_id,ordinal),
      CHECK((decided_by = 'rule') = (rule IS NOT NULL)),
      CHECK((decided_by = 'model') = (model_call_id IS NOT NULL))
    );
    CREATE TRIGGER ops_agent_run_steps_final BEFORE UPDATE ON ops_agent_run_steps
      WHEN OLD.state != 'reserved' OR NEW.run_id IS NOT OLD.run_id OR NEW.ordinal IS NOT OLD.ordinal
        OR NEW.action IS NOT OLD.action OR NEW.decided_by IS NOT OLD.decided_by
        OR NEW.model_call_id IS NOT OLD.model_call_id OR NEW.approval_id IS NOT OLD.approval_id
      BEGIN SELECT RAISE(ABORT,'Run step history is immutable'); END;
    CREATE TRIGGER ops_agent_run_steps_no_delete BEFORE DELETE ON ops_agent_run_steps
      BEGIN SELECT RAISE(ABORT,'Run step history is immutable'); END;
    CREATE TABLE ops_agent_model_calls (
      call_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES ops_agent_runs(id) ON DELETE RESTRICT,
      attempt_id TEXT NOT NULL,
      fence INTEGER NOT NULL CHECK(fence > 0),
      step_ordinal INTEGER NOT NULL CHECK(step_ordinal > 0),
      allowed_json TEXT NOT NULL CHECK(length(allowed_json) <= 512),
      state TEXT NOT NULL CHECK(state IN ('reserved','chosen','refused','uncertain')),
      choice TEXT,
      refusal_code TEXT CHECK(refusal_code IS NULL OR length(refusal_code) <= 64),
      settled_usd TEXT,
      prompt_tokens INTEGER,
      completion_tokens INTEGER,
      price_table_revision INTEGER,
      provider_response_id TEXT CHECK(provider_response_id IS NULL OR length(provider_response_id) <= 200),
      replayed INTEGER CHECK(replayed IS NULL OR replayed IN (0,1)),
      created_at TEXT NOT NULL,
      finished_at TEXT
    );
    CREATE TRIGGER ops_agent_model_calls_final BEFORE UPDATE ON ops_agent_model_calls
      WHEN OLD.state != 'reserved' OR NEW.call_id IS NOT OLD.call_id OR NEW.run_id IS NOT OLD.run_id
        OR NEW.allowed_json IS NOT OLD.allowed_json
      BEGIN SELECT RAISE(ABORT,'Model call history is immutable'); END;
    CREATE TRIGGER ops_agent_model_calls_no_delete BEFORE DELETE ON ops_agent_model_calls
      BEGIN SELECT RAISE(ABORT,'Model call history is immutable'); END;
    CREATE TABLE ops_agent_run_approvals (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES ops_agent_runs(id) ON DELETE RESTRICT,
      attempt_id TEXT NOT NULL,
      fence INTEGER NOT NULL CHECK(fence > 0),
      action TEXT NOT NULL CHECK(action IN ('open_landing','open_login','submit_bound_fixture',
        'read_workspace','read_session','read_files','sign_out')),
      binding_id TEXT,
      binding_revision INTEGER,
      guide_hash TEXT NOT NULL CHECK(length(guide_hash) = 64),
      policy_digest TEXT NOT NULL CHECK(length(policy_digest) = 64),
      origin TEXT NOT NULL,
      digest TEXT NOT NULL CHECK(length(digest) = 64),
      state TEXT NOT NULL CHECK(state IN ('requested','approved','consumed','stale','expired')),
      requested_at TEXT NOT NULL,
      decided_by TEXT,
      decided_at TEXT,
      closed_at TEXT,
      stale_reason TEXT CHECK(stale_reason IS NULL OR length(stale_reason) <= 64)
    );
    CREATE UNIQUE INDEX ops_agent_one_open_approval ON ops_agent_run_approvals(run_id)
      WHERE state IN ('requested','approved');
    CREATE TRIGGER ops_agent_run_approvals_final BEFORE UPDATE ON ops_agent_run_approvals
      WHEN OLD.state IN ('consumed','stale','expired') OR NEW.digest IS NOT OLD.digest
        OR NEW.run_id IS NOT OLD.run_id OR NEW.fence IS NOT OLD.fence OR NEW.action IS NOT OLD.action
        OR (OLD.state = 'approved' AND NEW.state = 'requested')
      BEGIN SELECT RAISE(ABORT,'Run approval history is immutable'); END;
    CREATE TRIGGER ops_agent_run_approvals_no_delete BEFORE DELETE ON ops_agent_run_approvals
      BEGIN SELECT RAISE(ABORT,'Run approval history is immutable'); END;
    CREATE TABLE ops_agent_run_results (
      run_id TEXT PRIMARY KEY REFERENCES ops_agent_runs(id) ON DELETE RESTRICT,
      final_state TEXT NOT NULL CHECK(final_state IN ('completed','cancelled','blocked','failed')),
      result_class TEXT NOT NULL CHECK(length(result_class) BETWEEN 1 AND 64),
      verified_account INTEGER NOT NULL CHECK(verified_account IN (0,1)),
      needs_human INTEGER NOT NULL CHECK(needs_human IN (0,1)),
      steps INTEGER NOT NULL CHECK(steps >= 0),
      rule_steps INTEGER NOT NULL CHECK(rule_steps >= 0),
      model_steps INTEGER NOT NULL CHECK(model_steps >= 0),
      model_calls INTEGER NOT NULL CHECK(model_calls >= 0),
      uncertain_steps INTEGER NOT NULL CHECK(uncertain_steps >= 0),
      binding_id TEXT,
      binding_revision INTEGER,
      submit_outcome TEXT,
      logout TEXT CHECK(logout IS NULL OR logout IN ('done','failed','not_run')),
      receipt_attestation TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TRIGGER ops_agent_run_results_no_update BEFORE UPDATE ON ops_agent_run_results
      BEGIN SELECT RAISE(ABORT,'Run result is immutable'); END;
    CREATE TRIGGER ops_agent_run_results_no_delete BEFORE DELETE ON ops_agent_run_results
      BEGIN SELECT RAISE(ABORT,'Run result is immutable'); END;
  `);
}
