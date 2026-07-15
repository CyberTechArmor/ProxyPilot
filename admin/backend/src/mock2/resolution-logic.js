// Mock2 blocked-deviation RESOLUTION — pure decision layer (PATCH B.1/B.2/B.4).
// Native-free, unit-tested stub-first (risk R9). The integration gate detects
// correctly; this module fixes the DEADLOCK the operator hit on ADP3 — every
// offered resolution re-produced the identical blocker. Three responsibilities:
//
//   B.1  Map every gate/egress/screening finding to a CLASS, and offer resolution
//        options such that every class present has at least one option that can
//        actually transition it to resolved. A class with no resolving option is
//        a harness defect (invariantHolds() fails the suite).
//   B.2  Decide which findings are WAIVER-ELIGIBLE — only provenance-not-established
//        (the analyzer failed closed on code it could not prove). Positively
//        fabricated findings (canned success, literal/bundled provenance) are NOT
//        waivable and keep only the implement/approve-simulation paths.
//   B.4  Loop breaker: an identical finding set that survives N=2 consecutive
//        resolutions is marked resolution-ineffective so a deadlock stops
//        presenting as fresh progress.
//
// Terminology (risk R7): nothing here is named "agent".

export const RESOLUTION_SCHEMA_VERSION = 1;

// Every finding class the gate can emit. The invariant: each of these has a
// resolving option in RESOLUTION_OPTIONS (checked by invariantHolds()).
export const FINDING_CLASSES = Object.freeze([
  'undeclared',                 // outbound integration with no manifest entry
  'simulated',                  // positively fabricated / no-I/O / error→success / prod-selectable fixture / disclosed
  'provenance-not-established', // analyzer failed closed (unsupported lang / untraceable dataflow) — MAY be real
  'contract-missing',           // a declared contract test file is absent
  'fixture-tooling-missing',    // the project cannot stand up an in-fence contract fixture server
  'egress-missing',             // a dialed host has no declared/approved egress
  'manifest-invalid',           // state/integrations.json present but unparseable
]);

// finding kind → class. The single source of truth for classification.
const KIND_TO_CLASS = Object.freeze({
  undeclared_integration: 'undeclared',
  // Positively-identified simulation (never waiver-eligible).
  fabricated_output: 'simulated',
  execution_without_transport: 'simulated',
  error_converted_to_success: 'simulated',
  fixture_reachable_in_production: 'simulated',
  // Analyzer failed closed — MAY be real (waiver-eligible under B.2).
  provenance_not_established: 'provenance-not-established',
  contract_test_missing: 'contract-missing',
  fixture_tooling_missing: 'fixture-tooling-missing',
  // Egress completeness (B.7).
  undeclared_private_egress: 'egress-missing',
  egress_grant_not_approved: 'egress-missing',
  undeclared_dynamic_destination: 'egress-missing',
  // Finish-screening disclosures (lexical safety net) — treated as simulation.
  disclosure_high: 'simulated',
  disclosure_ambiguous: 'simulated',
  // Manifest itself is broken.
  manifest_invalid: 'manifest-invalid',
});

// classifyFinding — a finding's class from its kind (findings) or tier
// (screening candidates carry tier, not kind). Unknown → null (surfaced by the
// invariant as an unresolvable class, never silently dropped).
export function classifyFinding(finding = {}) {
  if (finding.kind && KIND_TO_CLASS[finding.kind]) return KIND_TO_CLASS[finding.kind];
  if (finding.tier === 'high') return 'simulated';
  if (finding.tier === 'ambiguous') return 'simulated';
  return null;
}

// waiverEligible — B.2: only a provenance-not-established finding (the analyzer
// failed closed on code it could not prove) may be waived as "confirmed real —
// analysis limitation." A positively-fabricated finding is never waivable.
export function waiverEligible(finding = {}) {
  return classifyFinding(finding) === 'provenance-not-established';
}

// ---- resolution option registry ----
// Each option declares the classes it RESOLVES. adminOnly options are gated in
// the route. The registry is the invariant's coverage set.
export const RESOLUTION_OPTIONS = Object.freeze([
  {
    id: 'backfill_manifest', kind: 'declare_integration', resolves: ['undeclared'],
    label: 'Declare it — backfill the integration manifest entry',
    detail: 'Create the versioned state/integrations.json entry for this capability (operator-confirmed: destination source/key, transport, provenance requirement, live-verification requirement, egress classification), then re-run the gate against it. Declaring turns an undeclared capability into one the gate checks for real provenance.',
  },
  {
    id: 'implement_real', kind: 'run_dependency_first', resolves: ['simulated', 'contract-missing'],
    label: 'Implement the real integration',
    detail: 'Replace the simulation with real transport code + an in-fence contract test/fixtures; the integration gate must pass and the capability moves to pending-operator-verification.',
  },
  {
    id: 'approve_simulation', kind: 'grant_authorization', resolves: ['simulated'], adminOnly: true,
    label: 'Approve as a recorded simulation',
    detail: 'An admin approves the simulation, records it in state/deviations/, registers it in the stub registry with a severity, and it is visibly labeled in the running UI.',
  },
  {
    id: 'waive_provenance', kind: 'analysis_limitation_waiver', resolves: ['provenance-not-established'], adminOnly: true,
    label: 'Confirmed real — analysis limitation (waiver)',
    detail: 'Admin-only. Record that this code was manually inspected and is genuinely real, with the file/function inspected and the analyzer’s stated limitation. Creates a hash-linked waiver and routes the capability to pending-operator-verification (the live checklist is the backstop). NEVER routes straight to succeeded; never available for positively-fabricated findings.',
  },
  {
    id: 'declare_egress', kind: 'expand_scope', resolves: ['egress-missing'],
    label: 'Declare + approve the egress',
    detail: 'Add the mock2.yaml egress entry and approve the grant (private hosts) so the capability can reach its destination.',
  },
  {
    id: 'provision_fixture_tooling', kind: 'provision_tooling', resolves: ['fixture-tooling-missing'],
    label: 'Provision in-fence contract-fixture tooling',
    detail: 'Add the local TLS contract-fixture server to the project (test-only injection, real local socket) so the honest path — real transport code verified against a local fixture — is walkable inside the fence. Stubbing is never an acceptable fallback.',
  },
  {
    id: 'fix_manifest', kind: 'fix_manifest', resolves: ['manifest-invalid'],
    label: 'Repair the integration manifest',
    detail: 'state/integrations.json is present but does not parse/validate. Use "Repair manifest" (POST /integrations/repair-manifest): the broken text is archived to state/integrations.invalid.json, every entry that still validates is salvaged, and a valid schema_version + entries[] scaffold is written — then the build resumes and the gate re-reads the declared capabilities.',
  },
]);

// resolvingOptionsForClass(cls) — the options that can resolve a class.
export function resolvingOptionsForClass(cls) {
  return RESOLUTION_OPTIONS.filter((o) => o.resolves.includes(cls));
}

// resolvingOptionExistsForClass(cls) — the invariant primitive.
export function resolvingOptionExistsForClass(cls) {
  return resolvingOptionsForClass(cls).length > 0;
}

// invariantHolds(classes) — B.1 invariant: EVERY finding class the gate can emit
// has at least one resolving option. Returns { ok, uncovered }. A class with no
// resolving option is a harness defect and must fail the suite.
export function invariantHolds(classes = FINDING_CLASSES) {
  const uncovered = (classes || []).filter((c) => !resolvingOptionExistsForClass(c));
  return { ok: uncovered.length === 0, uncovered };
}

// ---- collecting a decision's findings + classes ----

// collectFindings(record) — a unified, classified finding list from a decision
// record (gate + egress + screening + manifest-invalid). Each carries a class.
export function collectFindings(record = {}) {
  const out = [];
  for (const f of record.gate?.findings || []) {
    out.push({ kind: f.kind, class: classifyFinding(f), file: f.file || null, function: f.function || null, message: f.message || '', source: 'integration' });
  }
  for (const f of record.egress?.findings || []) {
    out.push({ kind: f.kind, class: classifyFinding(f), file: null, function: null, message: f.message || '', source: 'egress' });
  }
  for (const c of record.screening?.candidates || []) {
    out.push({ kind: `disclosure_${c.tier}`, class: classifyFinding(c), file: null, function: null, message: c.excerpt || '', source: 'screening' });
  }
  if (record.manifest && record.manifest.ok === false) {
    out.push({ kind: 'manifest_invalid', class: 'manifest-invalid', file: 'state/integrations.json', function: null, message: record.manifest.error || 'manifest invalid', source: 'manifest' });
  }
  return out;
}

// classesInRecord(record) — the distinct classes present, order-stable.
export function classesInRecord(record = {}) {
  const seen = [];
  for (const f of collectFindings(record)) {
    const c = f.class || 'unknown';
    if (!seen.includes(c)) seen.push(c);
  }
  return seen;
}

// resolutionOptionsFor(record) — B.1 core: the options offered for a blocking
// decision. Returns EVERY option that resolves at least one class present, plus a
// coverage report so a class with no resolving option surfaces as a defect rather
// than a silent deadlock. Options carry `resolves` so callers/tests can verify the
// class→option mapping directly.
export function resolutionOptionsFor(record = {}) {
  const classes = classesInRecord(record);
  const options = [];
  for (const opt of RESOLUTION_OPTIONS) {
    if (opt.resolves.some((c) => classes.includes(c))) {
      // Trim `resolves` to the classes actually present (clearer for the operator).
      options.push({ ...opt, resolves: opt.resolves.filter((c) => classes.includes(c)) });
    }
  }
  const covered = new Set(options.flatMap((o) => o.resolves));
  const uncovered = classes.filter((c) => c !== 'unknown' && !covered.has(c));
  return { classes, options, uncovered };
}

// ---- B.4 loop breaker ----

// findingSetSignature(record) — a stable signature of the finding SET (kind + file
// + function), order-independent, so an identical set across resumes hashes equal.
export function findingSetSignature(record = {}) {
  const keys = collectFindings(record)
    .map((f) => `${f.kind}|${f.file || ''}|${f.function || ''}`)
    .sort();
  return keys.join(';;');
}

// loopBreakerVerdict({ priorSignatures, currentSignature, threshold }) — has the
// SAME finding set now survived `threshold` (default 2) consecutive blocks? prior
// signatures are the earlier blocked-deviation signatures for THIS request in
// chronological order. Counts the trailing run of priors equal to current, +1 for
// the current block. ineffective when the run reaches the threshold.
export function loopBreakerVerdict({ priorSignatures = [], currentSignature = '', threshold = 2 } = {}) {
  let consecutive = 1; // the current block
  for (let i = (priorSignatures || []).length - 1; i >= 0; i--) {
    if (priorSignatures[i] === currentSignature) consecutive += 1;
    else break;
  }
  return { ineffective: consecutive >= threshold, consecutive, threshold };
}

// resolutionIneffectiveSummary(record, verdict) — the admin-visible payload when
// the loop breaker fires: the FULL finding list inline (not a count), a plain
// statement that the offered resolutions have not worked, and the requirement for
// a free-text or admin resolution. A deadlock must present AS a deadlock.
export function resolutionIneffectiveSummary(record = {}, verdict = {}) {
  const findings = collectFindings(record);
  return {
    state: 'resolution-ineffective',
    reason: `The same ${findings.length} finding${findings.length === 1 ? '' : 's'} have survived ${verdict.consecutive || 2} consecutive resolution attempts — the offered resolutions are not working. This is a deadlock, not progress.`,
    findings: findings.map((f) => `[${f.class || 'unknown'}:${f.kind}] ${f.file || ''}${f.function ? `#${f.function}` : ''} — ${f.message}`),
    requires: 'A free-text resolution describing what will actually change, or an explicit admin override, is required before another automatic resume. Repeating the same option is disabled.',
  };
}
