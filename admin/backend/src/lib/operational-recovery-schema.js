// A7 practice and recovery. Additive, typed and append-only, like 1111:
// - how a run came to be (a practice run and its demo fixture mode, or a resume
//   of an earlier run), fixed when the run is pinned;
// - a person's typed decision about an uncertain step, model call or help
//   request (never free text; nothing is re-sent on their behalf);
// - the dashboard session's once-per-session agent-control verification (TOTP
//   or a passkey). It is not sudo and grants nothing on its own;
// - who took over a run, when, for how long, and the count and kind of their
//   inputs (never what they typed);
// - the demo fixture mode the dashboard last set for practice runs;
// - the automatic model summary of a finished run (bounded model text, stored
//   as untrusted text that changes nothing), and the owner's consent for it.
// Frames and video are never stored.
export const FIXTURE_MODES = Object.freeze(['normal', 'expired', 'locked', 'challenge', 'redirect', 'slow']);
const modes = FIXTURE_MODES.map(m => `'${m}'`).join(',');

export function operationalRecoveryMigration1112(d) {
  d.exec(`
    ALTER TABLE ops_agent_profiles ADD COLUMN model_summary_consent INTEGER NOT NULL DEFAULT 0
      CHECK(model_summary_consent IN (0,1));
    CREATE TABLE ops_agent_run_origins (
      run_id TEXT PRIMARY KEY REFERENCES ops_agent_runs(id) ON DELETE RESTRICT,
      practice INTEGER NOT NULL CHECK(practice IN (0,1)),
      fixture_mode TEXT CHECK(fixture_mode IS NULL OR fixture_mode IN (${modes})),
      resumed_from_run_id TEXT REFERENCES ops_agent_runs(id) ON DELETE RESTRICT,
      created_at TEXT NOT NULL,
      CHECK(practice = 1 OR fixture_mode IS NULL),
      CHECK(practice = 0 OR fixture_mode IS NOT NULL),
      CHECK(resumed_from_run_id IS NULL OR resumed_from_run_id != run_id)
    );
    CREATE UNIQUE INDEX ops_agent_one_resume ON ops_agent_run_origins(resumed_from_run_id)
      WHERE resumed_from_run_id IS NOT NULL;
    CREATE TRIGGER ops_agent_run_origins_no_update BEFORE UPDATE ON ops_agent_run_origins
      BEGIN SELECT RAISE(ABORT,'Run origin is immutable'); END;
    CREATE TRIGGER ops_agent_run_origins_no_delete BEFORE DELETE ON ops_agent_run_origins
      BEGIN SELECT RAISE(ABORT,'Run origin is immutable'); END;

    CREATE TABLE ops_agent_reconciliations (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES ops_agent_runs(id) ON DELETE RESTRICT,
      subject TEXT NOT NULL CHECK(length(subject) BETWEEN 3 AND 48),
      kind TEXT NOT NULL CHECK(kind IN ('write','read','model_call','run')),
      decision TEXT NOT NULL CHECK(decision IN ('happened','did_not_happen','unknown','acknowledged')),
      decided_by TEXT NOT NULL,
      decided_at TEXT NOT NULL,
      CHECK((kind = 'run') = (decision = 'acknowledged'))
    );
    CREATE INDEX ops_agent_reconciliations_run ON ops_agent_reconciliations(run_id, subject, decided_at);
    CREATE TRIGGER ops_agent_reconciliations_no_update BEFORE UPDATE ON ops_agent_reconciliations
      BEGIN SELECT RAISE(ABORT,'Reconciliation history is immutable'); END;
    CREATE TRIGGER ops_agent_reconciliations_no_delete BEFORE DELETE ON ops_agent_reconciliations
      BEGIN SELECT RAISE(ABORT,'Reconciliation history is immutable'); END;

    CREATE TABLE ops_agent_control_grants (
      session_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      factor TEXT NOT NULL CHECK(factor IN ('totp','passkey')),
      verified_at TEXT NOT NULL
    );

    CREATE TABLE ops_agent_takeovers (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES ops_agent_runs(id) ON DELETE RESTRICT,
      attempt_id TEXT NOT NULL,
      fence INTEGER NOT NULL CHECK(fence > 0),
      user_id TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('taking','holding','ended')),
      started_at TEXT NOT NULL,
      control_at TEXT,
      ended_at TEXT,
      end_reason TEXT CHECK(end_reason IS NULL OR length(end_reason) <= 64),
      inputs_json TEXT NOT NULL DEFAULT '{}' CHECK(length(inputs_json) <= 256)
    );
    CREATE UNIQUE INDEX ops_agent_one_controller ON ops_agent_takeovers(run_id)
      WHERE state IN ('taking','holding');
    CREATE TRIGGER ops_agent_takeovers_forward BEFORE UPDATE ON ops_agent_takeovers
      WHEN OLD.state = 'ended' OR NEW.run_id IS NOT OLD.run_id OR NEW.user_id IS NOT OLD.user_id
        OR NEW.attempt_id IS NOT OLD.attempt_id OR NEW.fence IS NOT OLD.fence
        OR NEW.started_at IS NOT OLD.started_at OR (OLD.state = 'holding' AND NEW.state = 'taking')
      BEGIN SELECT RAISE(ABORT,'Takeover history is immutable'); END;
    CREATE TRIGGER ops_agent_takeovers_no_delete BEFORE DELETE ON ops_agent_takeovers
      BEGIN SELECT RAISE(ABORT,'Takeover history is immutable'); END;

    CREATE TABLE ops_agent_fixture_state (
      id INTEGER PRIMARY KEY CHECK(id = 1),
      mode TEXT NOT NULL CHECK(mode IN (${modes})),
      run_id TEXT,
      set_by TEXT,
      set_at TEXT NOT NULL,
      applied INTEGER NOT NULL CHECK(applied IN (0,1))
    );

    CREATE TABLE ops_agent_run_summaries (
      run_id TEXT PRIMARY KEY REFERENCES ops_agent_runs(id) ON DELETE RESTRICT,
      call_id TEXT NOT NULL UNIQUE,
      state TEXT NOT NULL CHECK(state IN ('reserved','written','refused','uncertain')),
      summary_text TEXT CHECK(summary_text IS NULL OR length(summary_text) <= 800),
      refusal_code TEXT CHECK(refusal_code IS NULL OR length(refusal_code) <= 64),
      prompt_tokens INTEGER,
      completion_tokens INTEGER,
      settled_usd TEXT CHECK(settled_usd IS NULL OR length(settled_usd) <= 32),
      price_table_revision INTEGER,
      created_at TEXT NOT NULL,
      finished_at TEXT,
      CHECK((state = 'written') = (summary_text IS NOT NULL))
    );
    CREATE TRIGGER ops_agent_run_summaries_final BEFORE UPDATE ON ops_agent_run_summaries
      WHEN OLD.state != 'reserved' OR NEW.run_id IS NOT OLD.run_id OR NEW.call_id IS NOT OLD.call_id
      BEGIN SELECT RAISE(ABORT,'Run summary is immutable'); END;
    CREATE TRIGGER ops_agent_run_summaries_no_delete BEFORE DELETE ON ops_agent_run_summaries
      BEGIN SELECT RAISE(ABORT,'Run summary is immutable'); END;
  `);
}
