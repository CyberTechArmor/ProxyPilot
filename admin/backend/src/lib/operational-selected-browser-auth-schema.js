// Human authentication readback is separate from action/request approvals.
export function operationalSelectedBrowserAuthMigration1122(db) {
  db.exec(`
    CREATE TABLE ops_selected_browser_auth_confirmations (
      id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES ops_selected_browser_runs(id),
      attempt_id TEXT NOT NULL REFERENCES ops_selected_browser_attempts(id), fence INTEGER NOT NULL CHECK(fence>0),
      controller_user_id TEXT NOT NULL, controller_session_id TEXT NOT NULL,
      configuration_sha256 TEXT NOT NULL, guide_sha256 TEXT NOT NULL, consent_sha256 TEXT NOT NULL,
      inventory_sha256 TEXT NOT NULL, request_sha256 TEXT NOT NULL UNIQUE,
      packet_json TEXT NOT NULL CHECK(json_valid(packet_json)),
      state TEXT NOT NULL CHECK(state IN('authorized','accepted','uncertain')),
      acknowledged_count INTEGER CHECK(acknowledged_count IS NULL OR acknowledged_count>=0),
      receipt_json TEXT CHECK(receipt_json IS NULL OR json_valid(receipt_json)),
      created_at TEXT NOT NULL, expires_at TEXT NOT NULL, accepted_at TEXT
    );
    CREATE TABLE ops_selected_browser_auth_confirmed_requests (
      confirmation_id TEXT NOT NULL REFERENCES ops_selected_browser_auth_confirmations(id),
      run_id TEXT NOT NULL REFERENCES ops_selected_browser_runs(id), attempt_id TEXT NOT NULL, fence INTEGER NOT NULL,
      request_ref TEXT NOT NULL, binding_sha256 TEXT NOT NULL, approval_id TEXT NOT NULL REFERENCES ops_selected_browser_approvals(id),
      request_json TEXT NOT NULL CHECK(json_valid(request_json)),
      PRIMARY KEY(run_id,attempt_id,fence,request_ref), UNIQUE(run_id,attempt_id,fence,binding_sha256)
    );
    CREATE TRIGGER ops_selected_browser_auth_confirmation_pins BEFORE UPDATE ON ops_selected_browser_auth_confirmations
      WHEN NEW.id IS NOT OLD.id OR NEW.run_id IS NOT OLD.run_id OR NEW.attempt_id IS NOT OLD.attempt_id
        OR NEW.fence IS NOT OLD.fence OR NEW.controller_user_id IS NOT OLD.controller_user_id
        OR NEW.controller_session_id IS NOT OLD.controller_session_id OR NEW.configuration_sha256 IS NOT OLD.configuration_sha256
        OR NEW.guide_sha256 IS NOT OLD.guide_sha256 OR NEW.consent_sha256 IS NOT OLD.consent_sha256
        OR NEW.inventory_sha256 IS NOT OLD.inventory_sha256 OR NEW.request_sha256 IS NOT OLD.request_sha256
        OR NEW.packet_json IS NOT OLD.packet_json OR NEW.created_at IS NOT OLD.created_at OR NEW.expires_at IS NOT OLD.expires_at
        OR OLD.state!='authorized'
      BEGIN SELECT RAISE(ABORT,'Authentication confirmation pins and receipts are immutable'); END;
    CREATE TRIGGER ops_selected_browser_auth_confirmation_no_delete BEFORE DELETE ON ops_selected_browser_auth_confirmations
      BEGIN SELECT RAISE(ABORT,'Authentication confirmation history is immutable'); END;
    CREATE TRIGGER ops_selected_browser_auth_request_no_update BEFORE UPDATE ON ops_selected_browser_auth_confirmed_requests
      BEGIN SELECT RAISE(ABORT,'Authentication readback request is immutable'); END;
    CREATE TRIGGER ops_selected_browser_auth_request_no_delete BEFORE DELETE ON ops_selected_browser_auth_confirmed_requests
      BEGIN SELECT RAISE(ABORT,'Authentication readback request is immutable'); END;
  `);
}
