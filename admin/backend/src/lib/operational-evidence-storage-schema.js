// Additive D2 schema. Historical 1103 identities remain unchanged.
export function operationalEvidenceMigration1104(db) {
  db.exec(`
    CREATE TABLE ops_evidence_uploads (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, demonstration_id TEXT NOT NULL,
      actor_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, payload_hash TEXT NOT NULL,
      expected_bytes INTEGER NOT NULL CHECK(expected_bytes BETWEEN 1 AND 8388608),
      expected_mime TEXT NOT NULL CHECK(expected_mime IN ('image/png','image/jpeg')),
      expected_sha256 TEXT NOT NULL CHECK(length(expected_sha256)=64),
      kind TEXT NOT NULL CHECK(kind IN ('raw','derivative')), parent_raw_id TEXT,
      source_kind TEXT NOT NULL CHECK(source_kind IN ('manual','recapshare_still')),
      created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('reserved','received','finalized','cancelled','expired')),
      busy_token TEXT, busy_until TEXT, object_id TEXT,
      UNIQUE(project_id,actor_id,idempotency_key), UNIQUE(project_id,demonstration_id,id),
      CHECK((kind='raw' AND parent_raw_id IS NULL) OR (kind='derivative' AND parent_raw_id IS NOT NULL)),
      FOREIGN KEY(project_id,demonstration_id) REFERENCES ops_demonstrations(project_id,id),
      FOREIGN KEY(project_id,demonstration_id,parent_raw_id) REFERENCES ops_evidence_objects(project_id,demonstration_id,id),
      FOREIGN KEY(project_id,demonstration_id,object_id) REFERENCES ops_evidence_objects(project_id,demonstration_id,id)
    );
    CREATE TABLE ops_evidence_files (
      id TEXT PRIMARY KEY, upload_id TEXT NOT NULL REFERENCES ops_evidence_uploads(id),
      slot TEXT NOT NULL CHECK(slot IN ('input','output')),
      charged_bytes INTEGER NOT NULL CHECK(charged_bytes BETWEEN 0 AND 8388608),
      state TEXT NOT NULL CHECK(state IN ('allocated','sealed','deleted','missing')),
      sha256 TEXT, byte_count INTEGER, deleted_at TEXT, UNIQUE(upload_id,slot)
    );
    CREATE TABLE ops_evidence_validations (
      object_id TEXT PRIMARY KEY REFERENCES ops_evidence_objects(id),
      upload_id TEXT NOT NULL UNIQUE REFERENCES ops_evidence_uploads(id),
      file_id TEXT NOT NULL UNIQUE REFERENCES ops_evidence_files(id),
      validator TEXT NOT NULL, validated_at TEXT NOT NULL
    );
    CREATE TABLE ops_evidence_deletions (
      file_id TEXT PRIMARY KEY REFERENCES ops_evidence_files(id),
      completed_at TEXT NOT NULL, outcome TEXT NOT NULL CHECK(outcome IN ('deleted','missing'))
    );
    CREATE TABLE ops_evidence_read_leases (
      id TEXT PRIMARY KEY, file_id TEXT NOT NULL REFERENCES ops_evidence_files(id), expires_at TEXT NOT NULL
    );
    CREATE INDEX ops_evidence_upload_scope ON ops_evidence_uploads(project_id,demonstration_id,actor_id,state);
    CREATE TRIGGER ops_evidence_upload_identity BEFORE UPDATE ON ops_evidence_uploads
      WHEN NEW.id IS NOT OLD.id OR NEW.project_id IS NOT OLD.project_id
        OR NEW.demonstration_id IS NOT OLD.demonstration_id OR NEW.actor_id IS NOT OLD.actor_id
        OR NEW.idempotency_key IS NOT OLD.idempotency_key OR NEW.payload_hash IS NOT OLD.payload_hash
        OR NEW.expected_bytes IS NOT OLD.expected_bytes OR NEW.expected_mime IS NOT OLD.expected_mime
        OR NEW.expected_sha256 IS NOT OLD.expected_sha256 OR NEW.kind IS NOT OLD.kind
        OR NEW.parent_raw_id IS NOT OLD.parent_raw_id OR NEW.source_kind IS NOT OLD.source_kind
        OR NEW.created_at IS NOT OLD.created_at OR NEW.expires_at IS NOT OLD.expires_at
        OR (OLD.object_id IS NOT NULL AND NEW.object_id IS NOT OLD.object_id)
        OR (OLD.state IN ('cancelled','expired') AND NEW.state IS NOT OLD.state)
        OR (OLD.state='finalized' AND NEW.state IS NOT OLD.state)
      BEGIN SELECT RAISE(ABORT,'Upload identity is immutable'); END;
    CREATE TRIGGER ops_evidence_file_identity BEFORE UPDATE ON ops_evidence_files
      WHEN NEW.id IS NOT OLD.id OR NEW.upload_id IS NOT OLD.upload_id OR NEW.slot IS NOT OLD.slot
        OR (OLD.state IN ('deleted','missing') AND NEW.state IS NOT OLD.state)
        OR (OLD.state='sealed' AND (NEW.sha256 IS NOT OLD.sha256 OR NEW.byte_count IS NOT OLD.byte_count))
      BEGIN SELECT RAISE(ABORT,'File identity is immutable'); END;
    CREATE TRIGGER ops_evidence_file_no_delete BEFORE DELETE ON ops_evidence_files
      BEGIN SELECT RAISE(ABORT,'File receipt is durable'); END;
    CREATE TRIGGER ops_evidence_validation_scope BEFORE INSERT ON ops_evidence_validations
      WHEN NOT EXISTS(SELECT 1 FROM ops_evidence_uploads u JOIN ops_evidence_objects o
        ON o.project_id=u.project_id AND o.demonstration_id=u.demonstration_id AND o.uploader_id=u.actor_id
        JOIN ops_evidence_files f ON f.upload_id=u.id
        WHERE u.id=NEW.upload_id AND o.id=NEW.object_id AND f.id=NEW.file_id
          AND f.state='sealed' AND f.sha256=o.sha256 AND f.byte_count=o.byte_count)
      BEGIN SELECT RAISE(ABORT,'Invalid validation receipt'); END;
  `);
  for (const table of ['ops_evidence_validations','ops_evidence_deletions']) {
    for (const action of ['UPDATE','DELETE']) db.exec(`CREATE TRIGGER ${table}_no_${action.toLowerCase()}
      BEFORE ${action} ON ${table} BEGIN SELECT RAISE(ABORT,'Receipt is immutable'); END;`);
  }
  db.exec(`CREATE TRIGGER ops_evidence_upload_no_delete BEFORE DELETE ON ops_evidence_uploads
    BEGIN SELECT RAISE(ABORT,'Receipt is durable'); END;`);
}
