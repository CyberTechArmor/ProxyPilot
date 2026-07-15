// Mock2 integration-truthfulness ENFORCEMENT — the composite decision the runner
// consults at finish, and the thin container/DB glue around it. The DECISION
// (evaluateIntegrationTruthfulness) is pure and unit-tested against in-memory
// source snapshots; readSourceSnapshot + persistIntegrationGate are the native
// halves (container reads / mock2.db writes) that the tests do not touch, mirroring
// the module split the rest of the harness uses (risk R9).
//
// This is the load-bearing wiring for the AUDIT's root cause: at finish, BEFORE a
// cycle can reach `succeeded`, the runner runs the integration gate (B.4) + egress
// completeness (B.7) over the produced source, screens the finish disclosures
// (B.3), and either BLOCKS (a simulation/undeclared-egress deviation), routes to
// pending-operator-verification (B.5, real integrations awaiting live checks), or
// clears to succeeded (no external integrations in scope).
//
// Terminology (risk R7): nothing here is named "agent".

import { createHash } from 'crypto';
import {
  analyzeIntegrations, parseIntegrationManifest, INTEGRATION_MANIFEST_PATH,
  bootstrapManifestFromDiscovery, manifestEntryHash,
} from './integration-logic.js';
import { egressCompleteness, discoverDialedHosts } from './egress-check-logic.js';
import {
  disclosureFieldsFromFinish, screenDisclosureText, screeningVerdict,
} from './screening-logic.js';
import { deriveVerificationChecklist } from './verification-logic.js';
import { touchedSubsystems } from './stub-logic.js';

const EMPTY_MANIFEST = '{"schema_version":1,"entries":[]}';
// Bound the snapshot so a runaway tree can't blow the analyzer or the record.
const MAX_SNAPSHOT_FILES = 400;
const MAX_FILE_CHARS = 200000;

export function contentHash(obj) {
  return createHash('sha256').update(typeof obj === 'string' ? obj : JSON.stringify(obj)).digest('hex');
}

// evaluateIntegrationTruthfulness — the PURE composite. Inputs:
//   files: [{ path, content }]  — the produced source snapshot (src/** + tests/**)
//   manifestText: the raw state/integrations.json (may be empty/absent)
//   declaredEgress / approvedGrants: from mock2.yaml + the grant store
//   finish: { summary, acceptance, assumptions } from the finish call
//   changedFiles: paths changed THIS cycle (scopes the verification checklist +
//                 the touched subsystems); defaults to every source path.
// Returns a structured, schema-versioned decision. NEVER throws.
export function evaluateIntegrationTruthfulness({
  files = [], manifestText = '', declaredEgress = [], approvedGrants = [],
  finish = {}, changedFiles = null,
} = {}) {
  const parsed = parseIntegrationManifest(manifestText && manifestText.trim() ? manifestText : EMPTY_MANIFEST);
  const manifest = parsed.ok ? parsed.manifest : { schema_version: 1, entries: [] };

  // B.4 source analysis (fails closed) + undeclared-integration discovery.
  const gate = analyzeIntegrations({ files, manifest });

  // B.7 egress completeness over dialed hosts.
  const dialed = discoverDialedHosts(files);
  const egress = egressCompleteness({ discovered: dialed, declaredEgress, manifest, approvedGrants });

  // B.3 finish-payload screening (safety net).
  const screenFindings = screenDisclosureText(disclosureFieldsFromFinish(finish)).findings;
  const screen = screeningVerdict(screenFindings);

  // A malformed manifest is a hard failure (undeclared integrations can hide
  // behind an unparseable file — omitting the manifest is not a bypass).
  const manifestBad = !!(manifestText && manifestText.trim()) && !parsed.ok;

  const subsystems = touchedSubsystems((changedFiles || files.map((f) => f.path)) || []);

  const blocking = gate.verdict === 'fail' || !egress.ok || screen.blocking || manifestBad;

  // When clean AND real integrations that require live verification are in scope,
  // the cycle routes to pending-operator-verification with this checklist.
  const checklist = (!blocking)
    ? deriveVerificationChecklist({ manifest, subsystems })
    : [];

  const outcome = blocking
    ? 'blocked-deviation'
    : (checklist.length ? 'pending-operator-verification' : 'succeeded');

  const reasons = [];
  if (gate.verdict === 'fail') {
    for (const f of gate.findings) reasons.push(`[integration:${f.kind}] ${f.file || ''}${f.function ? `#${f.function}` : ''}: ${f.message}`);
  }
  if (!egress.ok) {
    for (const f of egress.findings) reasons.push(`[egress:${f.kind}] ${f.message}`);
  }
  if (screen.blocking) {
    for (const c of screen.candidates) reasons.push(`[disclosure:${c.tier}] ${c.source}: "${c.excerpt}"`);
  }
  if (manifestBad) reasons.push(`[manifest] ${INTEGRATION_MANIFEST_PATH} is present but invalid: ${parsed.error}`);

  const record = {
    schema_version: 1,
    outcome,
    blocking,
    gate: { verdict: gate.verdict, findings: gate.findings, limits: gate.limits },
    egress: { ok: egress.ok, findings: egress.findings, notes: egress.notes },
    screening: { blocking: screen.blocking, candidates: screen.candidates, recorded: screen.recorded },
    manifest: {
      ok: parsed.ok, error: parsed.ok ? null : parsed.error,
      entry_hashes: (manifest.entries || []).map((e) => ({ id: e.id, hash: manifestEntryHash(e) })),
      bootstrapped_from_discovery: gate.findings.some((f) => f.kind === 'undeclared_integration')
        ? bootstrapManifestFromDiscovery(gate).entries : [],
    },
    checklist,
    touched_subsystems: subsystems,
    reasons,
  };
  record.content_hash = contentHash({ outcome, reasons, gate: record.gate, egress: record.egress, screening: record.screening });
  return record;
}

// The halt_reason a blocking decision maps to (drives reportedCycleOutcome).
export function haltReasonForDecision(record) {
  if (!record || !record.blocking) return null;
  if (record.screening?.blocking && record.gate?.verdict !== 'fail' && record.egress?.ok) {
    return 'simulation_disclosure';
  }
  return 'integration_gate';
}

// A concise admin-visible reason + the resolution options for a blocking decision
// (every blocking path must carry an explicit reason + options — no silent halt).
export function blockingSummary(record) {
  const n = record.reasons.length;
  const head = record.screening?.blocking && record.gate?.verdict !== 'fail'
    ? 'Finish disclosed a production simulation'
    : record.gate?.verdict === 'fail'
      ? 'The integration gate found a simulated/undeclared external capability'
      : 'Egress for a built external capability is undeclared';
  return {
    reason: `${head} — ${n} finding${n === 1 ? '' : 's'}. The request cannot report "succeeded" until resolved.`,
    findings: record.reasons,
    options: [
      { id: 'implement_real', label: 'Implement the real integration', kind: 'run_dependency_first', detail: 'Replace the simulation with real transport code + in-fence contract fixtures; the integration gate must pass and the capability moves to pending-operator-verification.' },
      { id: 'approve_simulation', label: 'Approve as a recorded simulation', kind: 'grant_authorization', detail: 'An admin approves the simulation, records it in state/deviations/, registers it in the stub registry with a severity, and it must be visibly labeled in the running UI.', recommended: false },
      { id: 'declare_egress', label: 'Declare + approve the egress', kind: 'expand_scope', detail: 'Add the mock2.yaml egress entry and approve the grant (private hosts) so the capability can reach its destination.' },
    ],
  };
}

// ---- native halves (container reads / DB writes) ----

// readSourceSnapshot — gather the produced source (src/** + tests/**), the
// integration manifest, and the declared egress from the fenced container.
// Bounded. `execInContainer`/`readFileInContainer` are injected from runner.js so
// this stays a thin, testable seam.
export async function readSourceSnapshot({ containerName, appDir = '/srv/app', execInContainer, readFileInContainer }) {
  const listing = await execInContainer(containerName,
    `{ git -C ${appDir} ls-files 2>/dev/null; git -C ${appDir} ls-files --others --exclude-standard 2>/dev/null; } | sort -u | grep -E '^(src/|tests/).*\\.(ts|tsx|js|jsx|mjs|cjs|json)$' | head -${MAX_SNAPSHOT_FILES}`);
  const paths = (listing.stdout || '').split('\n').map((s) => s.trim()).filter(Boolean);
  const files = [];
  for (const p of paths) {
    const r = await readFileInContainer(containerName, p);
    if (r.ok) files.push({ path: p, content: String(r.content || '').slice(0, MAX_FILE_CHARS) });
  }
  const man = await readFileInContainer(containerName, INTEGRATION_MANIFEST_PATH);
  return { files, manifestText: man.ok ? man.content : '' };
}
