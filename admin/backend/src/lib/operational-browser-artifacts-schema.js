// Additive, independent metadata. Browser lifecycle supplies current attempt
// authorization; these receipts never grant worker or model authority.
export function operationalBrowserArtifactsMigration1119(db) {
  db.exec(`
    CREATE TABLE ops_browser_artifacts (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES ops_projects(id),
      actor_id TEXT NOT NULL, run_id TEXT, attempt_id TEXT, fence INTEGER,
      kind TEXT NOT NULL CHECK(kind IN ('upload_asset','download','screenshot','screenshot_derivative','clipboard','input_draft','observation')),
      write_intent TEXT NOT NULL CHECK(write_intent IN ('asset','artifact_capture','artifact_transform','clipboard_import','clipboard_worker','input_draft','observation')),
      parent_id TEXT REFERENCES ops_browser_artifacts(id),
      idempotency_key TEXT NOT NULL, payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64),
      sha256 TEXT NOT NULL CHECK(length(sha256)=64), byte_count INTEGER NOT NULL CHECK(byte_count BETWEEN 1 AND 16777216),
      mime TEXT NOT NULL CHECK(mime IN ('application/pdf','text/plain','text/csv','image/png','image/jpeg')),
      created_at TEXT NOT NULL, reservation_until TEXT NOT NULL, expires_at TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('reserved','staged','approved','rejected','cancelled','expired')),
      charged_bytes INTEGER NOT NULL CHECK(charged_bytes BETWEEN 0 AND 16777216),
      file_state TEXT NOT NULL CHECK(file_state IN ('allocated','sealed','deleted','missing')),
      busy_token TEXT, busy_until TEXT,
      CHECK((kind='upload_asset' AND run_id IS NULL AND attempt_id IS NULL AND fence IS NULL AND parent_id IS NULL)
        OR (kind!='upload_asset' AND run_id IS NOT NULL AND attempt_id IS NOT NULL AND fence>=1)),
      CHECK((kind='screenshot_derivative' AND parent_id IS NOT NULL) OR (kind!='screenshot_derivative' AND parent_id IS NULL)),
      CHECK((kind='upload_asset' AND write_intent='asset') OR (kind='clipboard' AND write_intent IN ('clipboard_import','clipboard_worker'))
        OR (kind IN ('download','screenshot','screenshot_derivative') AND write_intent='artifact_capture')
        OR (kind='screenshot_derivative' AND write_intent='artifact_transform') OR (kind='input_draft' AND write_intent='input_draft')
        OR (kind='observation' AND write_intent='observation')),
      UNIQUE(project_id,actor_id,idempotency_key), UNIQUE(project_id,id)
    );
    CREATE INDEX ops_browser_artifacts_attempt ON ops_browser_artifacts(project_id,run_id,attempt_id,fence,id);
    CREATE INDEX ops_browser_artifacts_charge ON ops_browser_artifacts(project_id,actor_id,file_state);
    CREATE TABLE ops_browser_artifact_reviews (
      id TEXT PRIMARY KEY, artifact_id TEXT NOT NULL REFERENCES ops_browser_artifacts(id),
      sha256 TEXT NOT NULL CHECK(length(sha256)=64), purpose TEXT NOT NULL CHECK(purpose IN ('asset_use','human_download','model_input','browser_input')),
      decision TEXT NOT NULL CHECK(decision IN ('approve','reject')), actor_id TEXT NOT NULL,
      reviewed_at TEXT NOT NULL, UNIQUE(artifact_id,purpose)
    );
    CREATE TABLE ops_browser_artifact_read_leases (
      id TEXT PRIMARY KEY, artifact_id TEXT NOT NULL REFERENCES ops_browser_artifacts(id),
      actor_id TEXT NOT NULL, purpose TEXT NOT NULL CHECK(purpose IN ('review','download','upload','model','clipboard','clipboard_worker','input')),
      created_at TEXT NOT NULL, expires_at TEXT NOT NULL
    );
    CREATE TABLE ops_browser_artifact_deletions (
      artifact_id TEXT PRIMARY KEY REFERENCES ops_browser_artifacts(id), completed_at TEXT NOT NULL,
      outcome TEXT NOT NULL CHECK(outcome IN ('deleted','missing'))
    );
    CREATE TABLE ops_browser_input_drafts (
      artifact_id TEXT PRIMARY KEY REFERENCES ops_browser_artifacts(id),
      target_ref_json TEXT NOT NULL CHECK(json_valid(target_ref_json)),
      snapshot_ref_json TEXT NOT NULL CHECK(json_valid(snapshot_ref_json)),
      purpose_sha256 TEXT NOT NULL CHECK(length(purpose_sha256)=64)
    );
    CREATE TABLE ops_browser_input_draft_approvals (
      artifact_id TEXT PRIMARY KEY REFERENCES ops_browser_input_drafts(artifact_id),
      approval_ref_json TEXT NOT NULL CHECK(json_valid(approval_ref_json)),
      actor_id TEXT NOT NULL, approved_at TEXT NOT NULL
    );
    CREATE TABLE ops_browser_observation_sources (
      artifact_id TEXT PRIMARY KEY REFERENCES ops_browser_artifacts(id),
      snapshot_ref_json TEXT NOT NULL CHECK(json_valid(snapshot_ref_json)),
      origin TEXT, url_sha256 TEXT CHECK(url_sha256 IS NULL OR length(url_sha256)=64),
      captured_at TEXT NOT NULL,
      worker_contract TEXT NOT NULL CHECK(worker_contract='selected-browser.v1'),
      chunker_version TEXT NOT NULL CHECK(chunker_version='browser-text.v1'),
      CHECK((origin IS NULL AND url_sha256 IS NULL) OR (origin IS NOT NULL AND url_sha256 IS NOT NULL))
    );
    CREATE TRIGGER ops_browser_artifact_identity BEFORE UPDATE ON ops_browser_artifacts
      WHEN NEW.id IS NOT OLD.id OR NEW.project_id IS NOT OLD.project_id OR NEW.actor_id IS NOT OLD.actor_id
        OR NEW.run_id IS NOT OLD.run_id OR NEW.attempt_id IS NOT OLD.attempt_id OR NEW.fence IS NOT OLD.fence
        OR NEW.kind IS NOT OLD.kind OR NEW.write_intent IS NOT OLD.write_intent OR NEW.parent_id IS NOT OLD.parent_id
        OR NEW.idempotency_key IS NOT OLD.idempotency_key OR NEW.payload_hash IS NOT OLD.payload_hash
        OR NEW.sha256 IS NOT OLD.sha256 OR NEW.byte_count IS NOT OLD.byte_count OR NEW.mime IS NOT OLD.mime
        OR NEW.created_at IS NOT OLD.created_at OR NEW.reservation_until IS NOT OLD.reservation_until OR NEW.expires_at IS NOT OLD.expires_at
        OR (OLD.file_state IN ('deleted','missing') AND NEW.file_state IS NOT OLD.file_state)
        OR (OLD.state IN ('rejected','cancelled','expired') AND NEW.state IS NOT OLD.state)
        OR (OLD.file_state='sealed' AND NEW.file_state='allocated')
      BEGIN SELECT RAISE(ABORT,'Browser artifact identity is immutable'); END;
    CREATE TRIGGER ops_browser_artifact_no_delete BEFORE DELETE ON ops_browser_artifacts
      BEGIN SELECT RAISE(ABORT,'Browser artifact receipt is durable'); END;
    CREATE TRIGGER ops_browser_observation_source_scope BEFORE INSERT ON ops_browser_observation_sources
      WHEN NOT EXISTS(SELECT 1 FROM ops_browser_artifacts a WHERE a.id=NEW.artifact_id
        AND a.kind='observation' AND a.write_intent='observation' AND a.mime='text/plain' AND a.byte_count<=4000)
      BEGIN SELECT RAISE(ABORT,'Invalid private page source'); END;
    CREATE TRIGGER ops_browser_artifact_review_scope BEFORE INSERT ON ops_browser_artifact_reviews
      WHEN NOT EXISTS(SELECT 1 FROM ops_browser_artifacts a WHERE a.id=NEW.artifact_id
        AND a.sha256=NEW.sha256 AND a.file_state='sealed' AND a.state IN ('staged','approved')
        AND ((NEW.purpose='asset_use' AND a.kind='upload_asset')
          OR (NEW.purpose='human_download' AND a.kind IN ('download','screenshot_derivative'))
          OR (NEW.purpose='browser_input' AND a.kind='input_draft')
          OR (NEW.purpose='model_input' AND a.kind IN ('upload_asset','screenshot_derivative','download'))))
      BEGIN SELECT RAISE(ABORT,'Invalid browser artifact review'); END;
  `);
  for (const table of ['ops_browser_artifact_reviews','ops_browser_artifact_deletions','ops_browser_input_drafts','ops_browser_input_draft_approvals','ops_browser_observation_sources']) {
    for (const action of ['UPDATE','DELETE']) db.exec(`CREATE TRIGGER ${table}_no_${action.toLowerCase()}
      BEFORE ${action} ON ${table} BEGIN SELECT RAISE(ABORT,'Browser artifact receipt is immutable'); END;`);
  }
}
