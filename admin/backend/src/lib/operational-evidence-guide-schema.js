// Migration 1105: definitions only. Historical migrations remain unchanged.
export function operationalEvidenceMigration1105(db) {
  db.exec(`
    CREATE UNIQUE INDEX ops_evidence_exact_item ON ops_demonstration_revision_items
      (project_id,demonstration_id,revision_id,position,object_id,annotation_id);
    CREATE TABLE ops_draft_evidence (
      project_id TEXT NOT NULL REFERENCES ops_guide_drafts(project_id),
      position INTEGER NOT NULL CHECK(position BETWEEN 0 AND 19),
      demonstration_id TEXT NOT NULL, revision_id TEXT NOT NULL, item_position INTEGER NOT NULL,
      object_id TEXT NOT NULL, annotation_id TEXT NOT NULL, selector_id TEXT NOT NULL,
      PRIMARY KEY(project_id,position), UNIQUE(project_id,revision_id,item_position),
      FOREIGN KEY(project_id,demonstration_id,revision_id,item_position,object_id,annotation_id)
        REFERENCES ops_demonstration_revision_items(project_id,demonstration_id,revision_id,position,object_id,annotation_id)
    );
    CREATE TABLE ops_submission_evidence_sets (
      project_id TEXT NOT NULL, submission_id TEXT NOT NULL,
      reference_count INTEGER NOT NULL CHECK(reference_count BETWEEN 0 AND 20),
      manifest_hash TEXT NOT NULL CHECK(length(manifest_hash)=64),
      PRIMARY KEY(project_id,submission_id),
      FOREIGN KEY(project_id,submission_id) REFERENCES ops_guide_submissions(project_id,id) DEFERRABLE INITIALLY DEFERRED
    );
    CREATE TABLE ops_submission_evidence_refs (
      project_id TEXT NOT NULL, submission_id TEXT NOT NULL,
      position INTEGER NOT NULL CHECK(position BETWEEN 0 AND 19),
      demonstration_id TEXT NOT NULL, revision_id TEXT NOT NULL, item_position INTEGER NOT NULL,
      object_id TEXT NOT NULL, annotation_id TEXT NOT NULL, selector_id TEXT NOT NULL,
      sha256 TEXT NOT NULL CHECK(length(sha256)=64), annotation_hash TEXT NOT NULL CHECK(length(annotation_hash)=64),
      publication_hash TEXT NOT NULL CHECK(length(publication_hash)=64), provenance_json TEXT NOT NULL,
      PRIMARY KEY(submission_id,position), UNIQUE(submission_id,revision_id,item_position),
      FOREIGN KEY(project_id,submission_id) REFERENCES ops_submission_evidence_sets(project_id,submission_id) DEFERRABLE INITIALLY DEFERRED,
      FOREIGN KEY(project_id,demonstration_id,revision_id,item_position,object_id,annotation_id)
        REFERENCES ops_demonstration_revision_items(project_id,demonstration_id,revision_id,position,object_id,annotation_id)
    );
    CREATE TRIGGER ops_submission_evidence_refs_sealed BEFORE INSERT ON ops_submission_evidence_refs
      WHEN EXISTS(SELECT 1 FROM ops_submission_evidence_sets WHERE submission_id=NEW.submission_id)
        OR EXISTS(SELECT 1 FROM ops_guide_submissions WHERE id=NEW.submission_id)
      BEGIN SELECT RAISE(ABORT,'Evidence manifest is sealed'); END;
    CREATE TRIGGER ops_submission_evidence_sets_sealed BEFORE INSERT ON ops_submission_evidence_sets
      WHEN EXISTS(SELECT 1 FROM ops_guide_submissions WHERE id=NEW.submission_id)
        OR NEW.reference_count<>(SELECT count(*) FROM ops_submission_evidence_refs WHERE submission_id=NEW.submission_id AND project_id=NEW.project_id)
        OR (NEW.reference_count>0 AND NEW.reference_count-1<>(SELECT max(position) FROM ops_submission_evidence_refs WHERE submission_id=NEW.submission_id))
      BEGIN SELECT RAISE(ABORT,'Invalid evidence seal'); END;
    CREATE TRIGGER ops_submission_requires_evidence_seal BEFORE INSERT ON ops_guide_submissions
      WHEN NOT EXISTS(SELECT 1 FROM ops_submission_evidence_sets
        WHERE project_id=NEW.project_id AND submission_id=NEW.id)
      BEGIN SELECT RAISE(ABORT,'Evidence-aware writer required'); END;
  `);
  for (const table of ['ops_submission_evidence_sets','ops_submission_evidence_refs']) {
    for (const action of ['UPDATE','DELETE']) db.exec(`CREATE TRIGGER ${table}_no_${action.toLowerCase()}
      BEFORE ${action} ON ${table} BEGIN SELECT RAISE(ABORT,'Evidence manifest is immutable'); END;`);
  }
  // Actor IDs deliberately have no users FK: provenance survives account deletion.
}
