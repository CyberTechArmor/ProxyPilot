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
  bootstrapManifestFromDiscovery, manifestEntryHash, appendManifestEntry,
  repairManifestPlan,
} from './integration-logic.js';
import { egressCompleteness, discoverDialedHosts } from './egress-check-logic.js';
import {
  disclosureFieldsFromFinish, screenDisclosureText, screeningVerdict,
} from './screening-logic.js';
import { deriveVerificationChecklist } from './verification-logic.js';
import { touchedSubsystems } from './stub-logic.js';
import {
  resolutionOptionsFor, findingSetSignature, loopBreakerVerdict,
  resolutionIneffectiveSummary, collectFindings,
} from './resolution-logic.js';

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
  finish = {}, changedFiles = null, fixtureToolingPresent = true,
} = {}) {
  const parsed = parseIntegrationManifest(manifestText && manifestText.trim() ? manifestText : EMPTY_MANIFEST);
  const manifest = parsed.ok ? parsed.manifest : { schema_version: 1, entries: [] };

  // B.4 source analysis (fails closed) + undeclared-integration discovery.
  const gate = analyzeIntegrations({ files, manifest });
  // The gate's own findings, plus (B.3) a fixture-tooling-missing finding when the
  // project has integrations to verify but cannot stand up an in-fence contract
  // fixture server — so the honest path is provably walkable rather than silently
  // forcing a stub. Emitted as its own class with its own resolving option.
  const gateFindings = [...gate.findings];
  if (!fixtureToolingPresent) {
    const needsFixtures = (manifest.entries || []).some((e) => e.live_verification?.required || e.contract_test)
      || gate.findings.some((f) => f.kind === 'undeclared_integration');
    if (needsFixtures) {
      gateFindings.push({
        kind: 'fixture_tooling_missing', file: null, function: null, severity: 'high',
        schema_version: 1,
        message: 'This project has external integrations to verify but provides no in-fence contract-fixture server (real local TLS socket, test-only injection). The honest path — real transport code verified against a local fixture — cannot be walked, so the gate must not let the build silently stub. Provision the fixture tooling.',
      });
    }
  }
  const gateVerdict = gateFindings.length ? 'fail' : 'pass';

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

  const blocking = gateVerdict === 'fail' || !egress.ok || screen.blocking || manifestBad;

  // When clean AND real integrations that require live verification are in scope,
  // the cycle routes to pending-operator-verification with this checklist.
  const checklist = (!blocking)
    ? deriveVerificationChecklist({ manifest, subsystems })
    : [];

  const outcome = blocking
    ? 'blocked-deviation'
    : (checklist.length ? 'pending-operator-verification' : 'succeeded');

  const reasons = [];
  if (gateVerdict === 'fail') {
    for (const f of gateFindings) reasons.push(`[integration:${f.kind}] ${f.file || ''}${f.function ? `#${f.function}` : ''}: ${f.message}`);
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
    gate: { verdict: gateVerdict, findings: gateFindings, limits: gate.limits },
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
  // The finding-set signature is persisted with the gate result so the B.4 loop
  // breaker can compare THIS block against prior blocks of the same request.
  record.finding_signature = findingSetSignature(record);
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

// A concise admin-visible reason + the CLASS-MATCHED resolution options for a
// blocking decision (PATCH B.1): every finding class present is offered at least
// one option that can actually resolve it — the deadlock fix. When the SAME
// finding set has survived N consecutive resolutions (B.4 loop breaker), the
// blocker is marked resolution-ineffective, the full finding list is surfaced
// inline, the repeated options are suppressed, and a free-text / admin resolution
// is required. priorSignatures are the earlier blocked-deviation finding-set
// signatures for THIS request (chronological). Every blocking path carries an
// explicit reason — no silent halt.
export function blockingSummary(record, { priorSignatures = [] } = {}) {
  const { options, classes, uncovered } = resolutionOptionsFor(record);
  const signature = findingSetSignature(record);
  const loop = loopBreakerVerdict({ priorSignatures, currentSignature: signature });

  if (loop.ineffective) {
    const s = resolutionIneffectiveSummary(record, loop);
    return {
      state: 'resolution-ineffective',
      reason: s.reason,
      findings: s.findings,
      classes,
      signature,
      loop,
      // Stop auto-offering the same options; require an explicit human resolution.
      options: [{
        id: 'record_resolution', kind: 'free_text_or_admin_override',
        label: 'Record a free-text resolution or admin override',
        detail: s.requires,
      }],
      requires_resolution: s.requires,
      // A class with NO resolving option is itself a harness defect — surface it.
      uncovered,
    };
  }

  const n = record.reasons.length;
  const head = record.screening?.blocking && record.gate?.verdict !== 'fail'
    ? 'Finish disclosed a production simulation'
    : record.gate?.verdict === 'fail'
      ? 'The integration gate found a simulated/undeclared external capability'
      : !record.egress?.ok
        ? 'Egress for a built external capability is undeclared'
        : 'The integration truthfulness gate is blocking';
  return {
    reason: `${head} — ${n} finding${n === 1 ? '' : 's'} across ${classes.length} class${classes.length === 1 ? '' : 'es'} (${classes.join(', ')}). The request cannot report "succeeded" until resolved.`,
    findings: record.reasons,
    classes,
    signature,
    loop,
    options,
    uncovered,
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

// backfillManifestEntryInContainer — PATCH B.1: write an operator-confirmed
// manifest entry into the project's state/integrations.json in the fenced
// container and return the committed entry + its hash. The resume then re-runs
// the gate against it (an `undeclared` capability becomes one the gate checks for
// real provenance — the loop is broken because the finding class changes). io is
// injected from runner.js (execInContainer/readFileInContainer/writeFileInContainer)
// so this stays a thin, mockable seam. { ok, entry, hash } or { ok:false, error }.
// repairManifestInContainer — the self-healing path for a MALFORMED
// state/integrations.json (the manifest-invalid dead end): archive the broken
// text (never destroyed), rewrite a valid scaffold salvaging every entry that
// individually validates, and commit. The pure decision is
// integration-logic.repairManifestPlan; this is the thin container glue.
// Returns { ok, repaired, salvaged, dropped } or { ok:false, error }.
export async function repairManifestInContainer({ containerName, execInContainer, readFileInContainer, writeFileInContainer }) {
  const cur = await readFileInContainer(containerName, INTEGRATION_MANIFEST_PATH);
  const plan = repairManifestPlan(cur.ok ? cur.content : '');
  if (!plan.needed) return { ok: true, repaired: false, reason: plan.reason, salvaged: [], dropped: [] };
  const archived = await writeFileInContainer(containerName, plan.archive, cur.content || '');
  if (!archived.ok) return { ok: false, error: `could not archive the broken manifest to ${plan.archive}: ${archived.error}` };
  const w = await writeFileInContainer(containerName, INTEGRATION_MANIFEST_PATH, plan.text);
  if (!w.ok) return { ok: false, error: `could not write the repaired ${INTEGRATION_MANIFEST_PATH}: ${w.error}` };
  try {
    await execInContainer(containerName, `git add ${INTEGRATION_MANIFEST_PATH} ${plan.archive} && git -c user.name=ProxyPilot -c user.email=mock2@proxypilot.local commit -q -m 'mock2: repair invalid integration manifest' || true`);
  } catch { /* best effort — the write is the load-bearing part */ }
  return { ok: true, repaired: true, salvaged: plan.salvaged, migrated: plan.migrated || [], dropped: plan.dropped, archive: plan.archive };
}

export async function backfillManifestEntryInContainer({ containerName, entry, execInContainer, readFileInContainer, writeFileInContainer }) {
  const cur = await readFileInContainer(containerName, INTEGRATION_MANIFEST_PATH);
  const appended = appendManifestEntry(cur.ok ? cur.content : '', entry);
  if (!appended.ok) return { ok: false, error: appended.error };
  const w = await writeFileInContainer(containerName, INTEGRATION_MANIFEST_PATH, appended.text);
  if (!w.ok) return { ok: false, error: `could not write ${INTEGRATION_MANIFEST_PATH}: ${w.error}` };
  // Commit the declaration so it rides the hash-chained history (best-effort).
  try {
    await execInContainer(containerName, `git add ${INTEGRATION_MANIFEST_PATH} && git -c user.name=ProxyPilot -c user.email=mock2@proxypilot.local commit -q -m 'mock2: declare integration ${String(appended.entry.id).replace(/[^a-zA-Z0-9_.-]/g, '')}' || true`);
  } catch { /* best effort — the write is the load-bearing part */ }
  return { ok: true, entry: appended.entry, hash: manifestEntryHash(appended.entry) };
}
