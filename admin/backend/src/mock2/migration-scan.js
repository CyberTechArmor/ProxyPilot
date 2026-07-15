// Mock2 MIGRATION SCAN — native half. On the first cycle under the updated
// harness (integration truthfulness), an existing project's produced source is
// scanned for suspected production stubs using the B.4 capability-based analyzer,
// bootstrapping a manifest from discovery when none exists. Suspected legacy
// stubs and analysis-incomplete findings are recorded NON-blocking; they become
// blocking when a cycle next touches the affected subsystem or at the next
// framework reconciliation (migration-scan-logic.legacyFindingBlocking).
//
// Pure decisions live in migration-scan-logic.js / integration-logic.js
// (unit-tested); this is the thin container-read + DB-write glue.
//
// Terminology (risk R7): nothing here is named "agent".

import { getMock2Db } from './db.js';
import { analyzeIntegrations, parseIntegrationManifest, INTEGRATION_MANIFEST_PATH } from './integration-logic.js';
import { migrationFindingsFromAnalysis, analysisIncompleteFinding, legacyFindingBlocking } from './migration-scan-logic.js';
import { recordIntegrationFindings } from './integration-state.js';
import { readSourceSnapshot } from './integration-enforcement.js';

// Has this project already been migration-scanned? One marker finding of origin
// 'migration' per project (idempotent — a re-scan is a no-op).
export function projectAlreadyScanned(projectId) {
  const row = getMock2Db()
    .prepare(`SELECT 1 FROM mock2_integration_findings WHERE project_id = ? AND origin = 'migration' LIMIT 1`)
    .get(Number(projectId));
  return !!row;
}

// scanProjectForLegacyStubs — run once per project on its first cycle under the
// updated harness. Reads the source snapshot, runs B.4 (referencing or
// bootstrapping the manifest), and records non-blocking migration findings. When
// the project cannot be analyzed conclusively, records an analysis_incomplete
// finding — NEVER "no stubs found". Best-effort; returns a summary.
export async function scanProjectForLegacyStubs({ project, frameworkVersionId, execInContainer, readFileInContainer, appDir = '/srv/app' }) {
  const projectId = Number(project.id);
  if (projectAlreadyScanned(projectId)) return { scanned: false, reason: 'already scanned' };

  let snapshot;
  try {
    snapshot = await readSourceSnapshot({ containerName: project.container_name, appDir, execInContainer, readFileInContainer });
  } catch (e) {
    // Could not read the tree — analysis-incomplete, not clean.
    const f = analysisIncompleteFinding({ projectId, frameworkVersionId, reason: `could not read source (${e?.message || e})`, details: [] });
    recordIntegrationFindings({ projectId, origin: 'migration', frameworkVersionId, findings: [f] });
    return { scanned: true, incomplete: true, findings: 1 };
  }

  if (!snapshot.files.length) {
    const f = analysisIncompleteFinding({ projectId, frameworkVersionId, reason: 'no analyzable source found (missing artifact or unsupported language)', details: [] });
    recordIntegrationFindings({ projectId, origin: 'migration', frameworkVersionId, findings: [f] });
    return { scanned: true, incomplete: true, findings: 1 };
  }

  const parsed = parseIntegrationManifest(snapshot.manifestText && snapshot.manifestText.trim() ? snapshot.manifestText : '{"schema_version":1,"entries":[]}');
  const manifest = parsed.ok ? parsed.manifest : { schema_version: 1, entries: [] };
  const analysis = analyzeIntegrations({ files: snapshot.files, manifest });
  const findings = migrationFindingsFromAnalysis({ analysis, projectId, frameworkVersionId });

  // Always leave at least a marker so projectAlreadyScanned is true and a clean
  // project is recorded as "scanned, nothing suspected" — never silently absent.
  const toRecord = findings.length ? findings : [{
    kind: 'migration_scan_clean', blocking: false, subsystem: null,
    detail: { message: 'first-cycle scan under the integration-truthfulness harness found no suspected production stubs' },
    severity: null,
  }];
  recordIntegrationFindings({ projectId, origin: 'migration', frameworkVersionId, findings: toRecord });
  return { scanned: true, incomplete: findings.some((f) => f.kind === 'analysis_incomplete'), findings: findings.length };
}

// blockingLegacyFindings — the migration findings that have CROSSED into blocking
// for a cycle touching `touchedSubsystems` under `currentFrameworkVersionId`.
// Used by the runner to refuse a "succeeded" on a cycle that touches a subsystem
// carrying an unresolved suspected legacy stub.
export function blockingLegacyFindings({ projectId, touchedSubsystems = [], currentFrameworkVersionId = null }) {
  const rows = getMock2Db()
    .prepare(`SELECT * FROM mock2_integration_findings WHERE project_id = ? AND origin = 'migration' AND status = 'open'`)
    .all(Number(projectId));
  return rows
    .map((r) => ({
      ...r,
      subsystem: r.subsystem,
      framework_version_id: r.framework_version_id,
    }))
    .filter((finding) => legacyFindingBlocking({ finding, touchedSubsystems, currentFrameworkVersionId }));
}
