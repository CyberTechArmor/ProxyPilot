// Migration 1103: definitions only. No media, live database or runtime imports.
export function operationalEvidenceMigration1103(db) {
  db.exec(`
    CREATE TABLE ops_demonstrations (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES ops_projects(id),
      created_by TEXT NOT NULL, created_at TEXT NOT NULL,
      title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 200),
      purpose TEXT NOT NULL CHECK(length(purpose)<=2000), context_version_id TEXT,
      revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0), archived_at TEXT,
      UNIQUE(project_id,id),
      FOREIGN KEY(project_id,context_version_id) REFERENCES ops_guide_versions(project_id,id)
    );
    CREATE TABLE ops_evidence_objects (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, demonstration_id TEXT NOT NULL,
      uploader_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('raw','derivative')),
      parent_raw_id TEXT, sha256 TEXT NOT NULL CHECK(length(sha256)=64),
      mime TEXT NOT NULL CHECK(mime IN ('image/png','image/jpeg')),
      byte_count INTEGER NOT NULL CHECK(byte_count BETWEEN 1 AND 8388608),
      width INTEGER NOT NULL CHECK(width BETWEEN 1 AND 8192),
      height INTEGER NOT NULL CHECK(height BETWEEN 1 AND 8192 AND width*height<=16000000),
      received_at TEXT NOT NULL, expires_at TEXT NOT NULL,
      source_kind TEXT NOT NULL CHECK(source_kind IN ('manual','recapshare_still')),
      UNIQUE(project_id,demonstration_id,id),
      CHECK((kind='raw' AND parent_raw_id IS NULL) OR (kind='derivative' AND parent_raw_id IS NOT NULL)),
      FOREIGN KEY(project_id,demonstration_id) REFERENCES ops_demonstrations(project_id,id),
      FOREIGN KEY(project_id,demonstration_id,parent_raw_id) REFERENCES ops_evidence_objects(project_id,demonstration_id,id)
    );
    CREATE TRIGGER ops_evidence_parent BEFORE INSERT ON ops_evidence_objects
      WHEN NEW.kind='derivative' AND NOT EXISTS(SELECT 1 FROM ops_evidence_objects
        WHERE id=NEW.parent_raw_id AND kind='raw' AND uploader_id=NEW.uploader_id)
      BEGIN SELECT RAISE(ABORT,'Invalid derivative parent'); END;
    CREATE TRIGGER ops_evidence_author BEFORE INSERT ON ops_evidence_objects
      WHEN NOT EXISTS(SELECT 1 FROM ops_demonstrations WHERE id=NEW.demonstration_id AND created_by=NEW.uploader_id)
      BEGIN SELECT RAISE(ABORT,'Invalid evidence author'); END;
    CREATE TRIGGER ops_evidence_count BEFORE INSERT ON ops_evidence_objects
      WHEN (NEW.kind='raw' AND (SELECT count(*) FROM ops_evidence_objects WHERE demonstration_id=NEW.demonstration_id AND kind='raw')>=20)
        OR (NEW.kind='derivative' AND (SELECT count(*) FROM ops_evidence_objects WHERE parent_raw_id=NEW.parent_raw_id)>=3)
      BEGIN SELECT RAISE(ABORT,'Evidence image limit'); END;
    CREATE TABLE ops_evidence_annotations (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, demonstration_id TEXT NOT NULL,
      object_id TEXT NOT NULL, predecessor_id TEXT UNIQUE, actor_id TEXT NOT NULL,
      created_at TEXT NOT NULL, content_hash TEXT NOT NULL,
      UNIQUE(project_id,demonstration_id,object_id,id),
      FOREIGN KEY(project_id,demonstration_id,object_id) REFERENCES ops_evidence_objects(project_id,demonstration_id,id),
      FOREIGN KEY(project_id,demonstration_id,object_id,predecessor_id)
        REFERENCES ops_evidence_annotations(project_id,demonstration_id,object_id,id)
    );
    CREATE TABLE ops_evidence_annotation_payloads (
      annotation_id TEXT PRIMARY KEY REFERENCES ops_evidence_annotations(id),
      label TEXT NOT NULL CHECK(length(label) BETWEEN 1 AND 200),
      text TEXT NOT NULL CHECK(length(text) BETWEEN 1 AND 2000), rectangle_json TEXT
    );
    CREATE TABLE ops_demonstration_revisions (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, demonstration_id TEXT NOT NULL,
      publisher_id TEXT NOT NULL, published_at TEXT NOT NULL, summary_hash TEXT NOT NULL,
      manifest_hash TEXT NOT NULL, provenance_json TEXT NOT NULL,
      UNIQUE(project_id,demonstration_id,id),
      FOREIGN KEY(project_id,demonstration_id) REFERENCES ops_demonstrations(project_id,id)
    );
    CREATE TABLE ops_demonstration_revision_payloads (
      revision_id TEXT PRIMARY KEY REFERENCES ops_demonstration_revisions(id),
      summary TEXT NOT NULL CHECK(length(summary)<=2000)
    );
    CREATE TABLE ops_demonstration_revision_items (
      project_id TEXT NOT NULL, demonstration_id TEXT NOT NULL, revision_id TEXT NOT NULL,
      position INTEGER NOT NULL CHECK(position BETWEEN 0 AND 49), object_id TEXT NOT NULL,
      annotation_id TEXT NOT NULL, PRIMARY KEY(revision_id,position), UNIQUE(revision_id,annotation_id),
      FOREIGN KEY(project_id,demonstration_id,revision_id)
        REFERENCES ops_demonstration_revisions(project_id,demonstration_id,id) DEFERRABLE INITIALLY DEFERRED,
      FOREIGN KEY(project_id,demonstration_id,object_id,annotation_id)
        REFERENCES ops_evidence_annotations(project_id,demonstration_id,object_id,id)
    );
    CREATE TRIGGER ops_revision_items_sealed BEFORE INSERT ON ops_demonstration_revision_items
      WHEN EXISTS(SELECT 1 FROM ops_demonstration_revisions WHERE id=NEW.revision_id)
        OR NOT EXISTS(SELECT 1 FROM ops_evidence_objects WHERE id=NEW.object_id AND kind='derivative')
      BEGIN SELECT RAISE(ABORT,'Revision is sealed or object is private'); END;
    CREATE TABLE ops_evidence_dispositions (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, demonstration_id TEXT NOT NULL,
      object_id TEXT, revision_id TEXT, actor_id TEXT NOT NULL, created_at TEXT NOT NULL,
      action TEXT NOT NULL CHECK(action IN ('restrict','delete_requested')),
      reason TEXT NOT NULL CHECK(reason IN ('privacy','incorrect','retention','other')),
      delete_after TEXT, CHECK((object_id IS NULL)<>(revision_id IS NULL)),
      FOREIGN KEY(project_id,demonstration_id,object_id) REFERENCES ops_evidence_objects(project_id,demonstration_id,id),
      FOREIGN KEY(project_id,demonstration_id,revision_id) REFERENCES ops_demonstration_revisions(project_id,demonstration_id,id)
    );
    CREATE TABLE ops_evidence_holds (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
      project_id TEXT NOT NULL, demonstration_id TEXT NOT NULL, object_id TEXT NOT NULL,
      actor_id TEXT NOT NULL, created_at TEXT NOT NULL, held INTEGER NOT NULL CHECK(held IN (0,1)),
      reason TEXT NOT NULL CHECK(reason IN ('privacy','incorrect','retention','other')),
      FOREIGN KEY(project_id,demonstration_id,object_id) REFERENCES ops_evidence_objects(project_id,demonstration_id,id)
    );
    CREATE TABLE ops_evidence_receipts (
      project_id TEXT NOT NULL REFERENCES ops_projects(id), actor_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL, action TEXT NOT NULL, payload_hash TEXT NOT NULL,
      result_json TEXT NOT NULL, PRIMARY KEY(project_id,actor_id,idempotency_key)
    );
    CREATE TRIGGER ops_demo_identity BEFORE UPDATE ON ops_demonstrations
      WHEN NEW.id IS NOT OLD.id OR NEW.project_id IS NOT OLD.project_id
        OR NEW.created_by IS NOT OLD.created_by OR NEW.created_at IS NOT OLD.created_at
        OR NEW.revision<>OLD.revision+1
      BEGIN SELECT RAISE(ABORT,'Demonstration identity is immutable'); END;
    CREATE TRIGGER ops_demo_no_delete BEFORE DELETE ON ops_demonstrations
      BEGIN SELECT RAISE(ABORT,'Evidence history is immutable'); END;
    CREATE TRIGGER ops_annotation_payload_erasure BEFORE DELETE ON ops_evidence_annotation_payloads
      WHEN NOT EXISTS(SELECT 1 FROM ops_evidence_annotations a JOIN ops_evidence_dispositions d
        ON d.object_id=a.object_id WHERE a.id=OLD.annotation_id)
      BEGIN SELECT RAISE(ABORT,'Restrict the object before text erasure'); END;
    CREATE TRIGGER ops_annotation_payload_no_restore BEFORE INSERT ON ops_evidence_annotation_payloads
      WHEN EXISTS(SELECT 1 FROM ops_evidence_annotations a JOIN ops_evidence_dispositions d
        ON d.object_id=a.object_id WHERE a.id=NEW.annotation_id)
      BEGIN SELECT RAISE(ABORT,'Restricted text cannot be restored'); END;
    CREATE TRIGGER ops_revision_payload_erasure BEFORE DELETE ON ops_demonstration_revision_payloads
      WHEN NOT EXISTS(SELECT 1 FROM ops_evidence_dispositions d WHERE d.revision_id=OLD.revision_id
        OR d.object_id IN (SELECT object_id FROM ops_demonstration_revision_items WHERE revision_id=OLD.revision_id))
      BEGIN SELECT RAISE(ABORT,'Restrict evidence before summary erasure'); END;
    CREATE TRIGGER ops_revision_payload_no_restore BEFORE INSERT ON ops_demonstration_revision_payloads
      WHEN EXISTS(SELECT 1 FROM ops_evidence_dispositions d WHERE d.revision_id=NEW.revision_id
        OR d.object_id IN (SELECT object_id FROM ops_demonstration_revision_items WHERE revision_id=NEW.revision_id))
      BEGIN SELECT RAISE(ABORT,'Restricted summary cannot be restored'); END;
  `);
  for (const table of ['ops_evidence_objects','ops_evidence_annotations','ops_demonstration_revisions',
    'ops_demonstration_revision_items','ops_evidence_dispositions','ops_evidence_holds','ops_evidence_receipts']) {
    for (const action of ['UPDATE','DELETE']) db.exec(`CREATE TRIGGER ${table}_no_${action.toLowerCase()}
      BEFORE ${action} ON ${table} BEGIN SELECT RAISE(ABORT,'Evidence history is immutable'); END;`);
  }
  for (const table of ['ops_evidence_annotation_payloads','ops_demonstration_revision_payloads']) {
    db.exec(`CREATE TRIGGER ${table}_no_update BEFORE UPDATE ON ${table}
      BEGIN SELECT RAISE(ABORT,'Append a new text revision'); END;`);
  }
}
