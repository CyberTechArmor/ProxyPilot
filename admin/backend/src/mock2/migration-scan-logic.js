// Mock2 MIGRATION SCAN — pure decision layer for existing projects under the
// updated harness. Native-free, unit-tested stub-first (risk R9). On the first
// cycle under the updated harness, an existing project is scanned for suspected
// production stubs using the B.4 capability-based analyzer (referencing or
// bootstrapping manifests). Suspected legacy stubs are NON-blocking at migration
// time and become blocking when a cycle next touches the affected subsystem or
// at the next framework-version reconciliation — whichever comes first. Analysis
// that cannot conclude produces a versioned analysis_incomplete finding and is
// NEVER reported as "no stubs found".
//
// Terminology (risk R7): nothing here is named "agent".

export const MIGRATION_SCHEMA_VERSION = 1;

// migrationFindingsFromAnalysis({ analysis, projectId, frameworkVersionId }) —
// convert B.4 gate findings into non-blocking migration findings recorded at
// scan time. provenance_not_established / unsupported-language findings become
// analysis_incomplete (handled by analysisIncompleteFinding); the rest become
// suspected_legacy_stub.
export function migrationFindingsFromAnalysis({ analysis = { findings: [] }, projectId, frameworkVersionId } = {}) {
  const out = [];
  for (const f of analysis.findings || []) {
    if (f.kind === 'provenance_not_established') {
      out.push(analysisIncompleteFinding({
        projectId, frameworkVersionId,
        reason: 'provenance not established', details: [f.file].filter(Boolean),
      }));
      continue;
    }
    if (f.kind === 'undeclared_integration') {
      // Discovery gap, not a stub — recorded so a manifest is bootstrapped, but
      // it is not itself a suspected stub.
      out.push({
        schema_version: MIGRATION_SCHEMA_VERSION,
        kind: 'undeclared_integration',
        blocking: false,
        project_id: projectId ?? null,
        framework_version_id: frameworkVersionId ?? null,
        subsystem: subsystemOf(f.file),
        detail: { file: f.file, message: f.message, gate_kind: f.kind },
      });
      continue;
    }
    out.push({
      schema_version: MIGRATION_SCHEMA_VERSION,
      kind: 'suspected_legacy_stub',
      blocking: false, // non-blocking at migration time
      project_id: projectId ?? null,
      framework_version_id: frameworkVersionId ?? null,
      subsystem: subsystemOf(f.file) || f.subsystem || null,
      detail: { file: f.file, function: f.function || null, message: f.message, gate_kind: f.kind },
    });
  }
  return out;
}

function subsystemOf(path) {
  const m = String(path || '').match(/^src\/([^/]+)\//);
  return m ? m[1] : null;
}

// analysisIncompleteFinding(...) — a versioned finding stating exactly what could
// not be analyzed. Non-blocking initially; escalates under the same rules as a
// suspected stub. Analysis failure must NEVER be reported as "no stubs found".
export function analysisIncompleteFinding({ projectId, frameworkVersionId, reason, details = [] } = {}) {
  const detailList = (details || []).filter(Boolean);
  return {
    schema_version: MIGRATION_SCHEMA_VERSION,
    kind: 'analysis_incomplete',
    blocking: false,
    project_id: projectId ?? null,
    framework_version_id: frameworkVersionId ?? null,
    subsystem: detailList.length ? subsystemOf(detailList[0]) : null,
    message: `Migration analysis could not conclude: ${reason}${detailList.length ? ` — ${detailList.join(', ')}` : ''}. Recorded as analysis-incomplete (not "no stubs found"); becomes blocking when a cycle touches the affected subsystem or at the next framework reconciliation.`,
    detail: { reason, items: detailList },
  };
}

// legacyFindingBlocking({ finding, touchedSubsystems, currentFrameworkVersionId })
// — has a recorded (non-blocking) legacy finding CROSSED into blocking? True when
// a cycle touches the affected subsystem, OR the framework version has advanced
// past the version the finding was recorded under (reconciliation audit).
export function legacyFindingBlocking({ finding = {}, touchedSubsystems = [], currentFrameworkVersionId = null } = {}) {
  if (!finding || (finding.kind !== 'suspected_legacy_stub' && finding.kind !== 'analysis_incomplete')) return false;
  const touched = finding.subsystem && (touchedSubsystems || []).includes(finding.subsystem);
  const reconciled = finding.framework_version_id != null && currentFrameworkVersionId != null
    && Number(currentFrameworkVersionId) !== Number(finding.framework_version_id);
  return !!(touched || reconciled);
}
