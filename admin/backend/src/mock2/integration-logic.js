// Mock2 integration TRUTHFULNESS — pure decision layer (B.2 manifest + B.4 gate).
// Native-free, unit-tested stub-first (risk R9): imports nothing that opens a DB,
// hits the network, or touches Incus. This is the module the AUDIT identified as
// entirely missing — the harness had no provenance rule class and no gate class
// for external-integration truthfulness, so a fully simulated backend went green.
//
// Two responsibilities:
//   1. parse/validate/hash the versioned integration manifest (state/integrations.json).
//   2. analyze source for the integration-truthfulness invariant, FAIL CLOSED:
//      when provenance cannot be established the analyzer emits an actionable
//      "provenance not established" finding rather than inferring success.
//
// Detection is capability/transport/provenance based — NEVER tied to ADP names,
// sampleRoster, specific function names, or the example's vocabulary. It documents
// its supported languages, transport patterns, and known limits (r.limits).
//
// Terminology (risk R7): nothing here is named "agent".

import { createHash } from 'crypto';

export const INTEGRATION_MANIFEST_PATH = 'state/integrations.json';
export const MANIFEST_SCHEMA_VERSION = 1;
export const INTEGRATION_GATE_SCHEMA_VERSION = 1;

// The languages this analyzer understands. A declared subsystem whose source is
// in another language is FAIL-CLOSED (provenance_not_established), never inferred
// clean — analysis failure must never read as "no stubs found".
const SUPPORTED_LANGUAGES = Object.freeze(['typescript', 'javascript']);
const SUPPORTED_EXT = /\.(ts|tsx|js|jsx|mjs|cjs)$/i;

// Transport call shapes the analyzer recognizes as "a real outbound invocation".
// Capability-based: any of these in reachable code counts as an attempted transport.
const TRANSPORT_PATTERNS = Object.freeze([
  'fetch(', 'axios', 'http.request', 'https.request', 'http.get', 'https.get',
  'undici', 'got(', 'node-fetch', 'XMLHttpRequest', '.createClient(', 'net.connect',
  'tls.connect', 'new WebSocket', 'pg.connect', 'ldap', 'grpc', 'soap',
]);

const KNOWN_LIMITS = Object.freeze([
  'Static single-file analysis: cross-module dataflow is approximated by import + call-graph within the provided file set; a transport reached only through a dynamically-resolved indirection may be under-detected (conservative — such cases fail closed).',
  'Reflection / eval / runtime-assembled call targets are not followed.',
  'Only TypeScript/JavaScript sources are analyzed; other languages fail closed as provenance_not_established.',
  'Provenance is established structurally (response identifier flows into the returned/persisted value); an obfuscated laundering of a literal through many assignments may exceed the conservative depth and fail closed rather than pass.',
]);

function analyzerLimits() {
  return {
    supported_languages: [...SUPPORTED_LANGUAGES],
    transport_patterns: [...TRANSPORT_PATTERNS],
    known_limits: [...KNOWN_LIMITS],
  };
}

// ---- B.2 manifest ----

function validateEntry(e, i) {
  if (!e || typeof e !== 'object') return `entry ${i} is not an object`;
  if (!e.id || typeof e.id !== 'string') return `entry ${i} needs a string id`;
  if (!e.subsystem || typeof e.subsystem !== 'string') return `entry ${i} (${e.id || '?'}) needs a subsystem`;
  if (!Array.isArray(e.actions) || e.actions.length === 0) return `entry ${e.id} needs at least one action`;
  for (const a of e.actions) {
    if (!a || !a.name || !a.operation) return `entry ${e.id} has an action missing name/operation`;
  }
  if (!e.destination || !e.destination.source || !e.destination.key) return `entry ${e.id} needs destination.source + destination.key`;
  if (!e.transport) return `entry ${e.id} needs a transport`;
  if (!e.provenance || !e.provenance.response_to_output) return `entry ${e.id} needs provenance.response_to_output`;
  if (!e.live_verification || typeof e.live_verification.required !== 'boolean') return `entry ${e.id} needs live_verification.required (boolean)`;
  if (!e.egress || !e.egress.classification) return `entry ${e.id} needs egress.classification`;
  return null;
}

// Normalize an entry into the canonical, hashable shape (stable key order).
function canonicalEntry(e) {
  return {
    id: String(e.id),
    subsystem: String(e.subsystem),
    actions: (e.actions || []).map((a) => ({ name: String(a.name), operation: String(a.operation) })),
    destination: { source: String(e.destination.source), key: String(e.destination.key) },
    transport: String(e.transport),
    provenance: { response_to_output: String(e.provenance.response_to_output) },
    live_verification: { required: !!e.live_verification.required },
    egress: { classification: String(e.egress.classification) },
    contract_test: e.contract_test ? String(e.contract_test) : null,
    fixtures: e.fixtures && typeof e.fixtures === 'object'
      ? { test_only_config: Array.isArray(e.fixtures.test_only_config) ? e.fixtures.test_only_config.map(String) : [] }
      : { test_only_config: [] },
  };
}

export function parseIntegrationManifest(text) {
  let doc;
  try { doc = JSON.parse(String(text || '')); } catch (e) {
    return { ok: false, error: `integrations.json is not valid JSON: ${e?.message || e}` };
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return { ok: false, error: 'integrations.json must be a JSON object' };
  if (Number(doc.schema_version) !== MANIFEST_SCHEMA_VERSION) {
    return { ok: false, error: `unsupported integration manifest schema_version ${doc.schema_version} (this host supports ${MANIFEST_SCHEMA_VERSION})` };
  }
  const entriesIn = Array.isArray(doc.entries) ? doc.entries : [];
  for (let i = 0; i < entriesIn.length; i++) {
    const err = validateEntry(entriesIn[i], i);
    if (err) return { ok: false, error: err };
  }
  return { ok: true, manifest: { schema_version: MANIFEST_SCHEMA_VERSION, entries: entriesIn.map(canonicalEntry) } };
}

// Content-addressed hash of a single manifest entry (B.5 supersession keys off
// this — a changed endpoint/transport changes the hash and reopens verification).
export function manifestEntryHash(entry) {
  return createHash('sha256').update(JSON.stringify(canonicalEntry(entry))).digest('hex');
}

// validateManifestEntry(entry) — validate one operator-confirmed manifest entry
// (PATCH B.1 backfill) against the SAME rules as a full manifest parse. Returns
// { ok, entry } (canonicalized) or { ok:false, error }.
export function validateManifestEntry(entry) {
  const err = validateEntry(entry, 0);
  if (err) return { ok: false, error: err };
  return { ok: true, entry: canonicalEntry(entry) };
}

// scaffoldManifestText(entries) — a fresh, valid state/integrations.json body
// (schema_version + entries[]). The self-healing target for an absent or
// malformed manifest.
export function scaffoldManifestText(entries = []) {
  return `${JSON.stringify({ schema_version: MANIFEST_SCHEMA_VERSION, entries }, null, 2)}\n`;
}

// Where a malformed manifest's original text is preserved when the repair path
// rewrites it — the broken content is archived, never silently destroyed.
export const INTEGRATION_MANIFEST_INVALID_PATH = 'state/integrations.invalid.json';

// repairManifestPlan(currentText) — the self-healing decision for a manifest
// that does not parse/validate (the manifest-invalid dead end). Pure. Returns:
//   { needed:false }                          — the manifest is already valid;
//   { needed:true, text, salvaged, dropped,   — rewrite with a valid scaffold,
//     archive }                                 salvaging every entry that
//                                               individually validates, dropping
//                                               (and reporting) the rest; the
//                                               original text goes to `archive`
//                                               (state/integrations.invalid.json)
//                                               so nothing is silently lost.
// An absent/blank manifest needs no repair (the gate already tolerates it).
export function repairManifestPlan(currentText) {
  const raw = String(currentText || '');
  if (!raw.trim()) return { needed: false, reason: 'no manifest present — nothing to repair (an absent manifest is valid)' };
  const parsed = parseIntegrationManifest(raw);
  if (parsed.ok) return { needed: false, reason: 'the manifest already parses and validates' };
  // Salvage: if the text is JSON with an entries array, keep every entry that
  // validates on its own; anything else (or unparseable JSON) salvages nothing.
  let salvaged = [];
  const dropped = [];
  try {
    const doc = JSON.parse(raw);
    const entriesIn = Array.isArray(doc?.entries) ? doc.entries : [];
    for (const e of entriesIn) {
      const v = validateManifestEntry(e);
      if (v.ok && !salvaged.some((s) => s.id === v.entry.id)) salvaged.push(v.entry);
      else dropped.push({ id: e?.id || '(no id)', error: v.ok ? 'duplicate id' : v.error });
    }
  } catch { salvaged = []; }
  return {
    needed: true,
    error: parsed.error,
    text: scaffoldManifestText(salvaged),
    salvaged,
    dropped,
    archive: INTEGRATION_MANIFEST_INVALID_PATH,
  };
}

// appendManifestEntry(manifestText, entry) — return the new integrations.json text
// with `entry` appended (PATCH B.1). Pure: takes the current file text (may be
// empty/absent), validates the entry, and rejects a duplicate id. { ok, text } or
// { ok:false, error }.
export function appendManifestEntry(manifestText, entry) {
  const v = validateManifestEntry(entry);
  if (!v.ok) return { ok: false, error: v.error };
  const parsed = parseIntegrationManifest(manifestText && String(manifestText).trim() ? manifestText : '{"schema_version":1,"entries":[]}');
  if (!parsed.ok) return { ok: false, error: `current ${INTEGRATION_MANIFEST_PATH} is invalid: ${parsed.error}` };
  if (parsed.manifest.entries.some((e) => e.id === v.entry.id)) {
    return { ok: false, error: `a manifest entry with id "${v.entry.id}" already exists` };
  }
  const next = { schema_version: MANIFEST_SCHEMA_VERSION, entries: [...parsed.manifest.entries, v.entry] };
  return { ok: true, text: `${JSON.stringify(next, null, 2)}\n`, entry: v.entry };
}

// ---- source model (tiny, dependency-free) ----

function langOf(path) {
  return SUPPORTED_EXT.test(String(path || '')) ? 'typescript' : null;
}

// Strip line/block comments so commented-out code is not treated as reachable.
function stripComments(src) {
  return String(src || '')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

// Extract top-level exported function/const-arrow bodies as { name, body }.
// Deliberately simple brace-matching — enough to reason about which function a
// transport call and a return statement live in.
function extractFunctions(src) {
  const code = stripComments(src);
  const out = [];
  const re = /(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*\(|(?:export\s+)?(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*(?:async\s*)?\(/g;
  let m;
  while ((m = re.exec(code)) !== null) {
    const name = m[1] || m[2];
    // The match ends just after the param-list's opening '('. Balance parens to
    // skip the parameter list (which may itself contain `{ … }` destructuring —
    // the reason a naive "first { after the name" is wrong), THEN take the body.
    let i = re.lastIndex - 1; // points at '('
    let pd = 0;
    for (; i < code.length; i++) {
      if (code[i] === '(') pd++;
      else if (code[i] === ')') { pd--; if (pd === 0) { i++; break; } }
    }
    const b = code.indexOf('{', i);
    if (b < 0) continue;
    let depth = 0;
    let j = b;
    for (; j < code.length; j++) {
      if (code[j] === '{') depth++;
      else if (code[j] === '}') { depth--; if (depth === 0) { j++; break; } }
    }
    out.push({ name, body: code.slice(b, j) });
    re.lastIndex = j; // continue scanning after this function
  }
  return out;
}

function hasTransportCall(text) {
  const t = String(text || '');
  return TRANSPORT_PATTERNS.some((p) => t.includes(p));
}

// Local identifiers a function body calls (bare `name(` call sites) — the edges
// of a within-subsystem call graph.
function calledIdentifiers(body) {
  const out = new Set();
  const re = /\b([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g;
  let m;
  while ((m = re.exec(String(body || ''))) !== null) out.add(m[1]);
  return out;
}

// buildTransportReachability(fns) → (name) => boolean. A function "reaches a
// transport" if its own body performs one OR it calls (transitively, within the
// provided function set) a function that does. This is what makes dead-code
// transport (E5) and helper-laundered literals (ADP2's starterRecords) decidable
// without name matching: an unreachable helper is simply never on a path.
function buildTransportReachability(fns) {
  const byName = new Map(fns.map((f) => [f.name, f]));
  const memo = new Map();
  const resolve = (name, seen) => {
    if (memo.has(name)) return memo.get(name);
    const fn = byName.get(name);
    if (!fn || seen.has(name)) return false;
    seen.add(name);
    let reaches = hasTransportCall(fn.body);
    if (!reaches) {
      for (const callee of calledIdentifiers(fn.body)) {
        if (callee !== name && resolve(callee, seen)) { reaches = true; break; }
      }
    }
    memo.set(name, reaches);
    return reaches;
  };
  return (name) => resolve(name, new Set());
}

// Does a function persist data (the "and persist" half of fetch-and-persist)?
function persistsData(body) {
  return /\.(insert|upsert|onConflict|save|create)\s*\(|\.values\s*\(/.test(String(body || ''));
}

// A hardcoded record set literal returned/persisted as data: an array of object
// literals, or `.values([...])` / `.values({...})` fed by a local literal.
function hasHardcodedRecordSet(body) {
  const t = String(body || '');
  // An array literal containing at least one object literal (record set). The
  // inner content is matched non-greedily across newlines; a trailing comma
  // after the last entry is tolerated.
  return /\[\s*\{[\s\S]*?\}[\s\S]*?\]/.test(t);
}

// Does the body import/require bundled data (JSON/fixture module) and persist it?
function usesBundledData(body, fileImports) {
  const t = String(body || '');
  const importsJson = (fileImports || []).some((imp) => /\.json['"]?$/.test(imp) || /seed|fixture|sample|roster|starter|canned|offline/i.test(imp));
  const persists = /\.(insert|values|upsert|onConflict|save|create)\b/.test(t) || /\breturn\b/.test(t);
  return importsJson && persists;
}

function extractImports(src) {
  const code = stripComments(src);
  const out = [];
  const re = /(?:import\s+[^'"]*from\s*|require\s*\(\s*)['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(code)) !== null) out.push(m[1]);
  return out;
}

// Is a returned success derived from a transport response? Heuristic but
// conservative: the response identifier captured from the transport call must
// appear in a subsequent return/persist. Fails closed (returns false) when we
// cannot establish the link.
function responseFlowsToOutput(body) {
  const t = String(body || '');
  // Capture `const X = await fetch(...)` / `= await httpsRequestJson(...)` etc.
  const assignRe = /(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*await\s+([A-Za-z0-9_$.]*)\(/g;
  let m;
  const transportVars = [];
  while ((m = assignRe.exec(t)) !== null) {
    const callee = m[2];
    if (hasTransportCall(`${callee}(`) || /request|fetch|get|json|client|query/i.test(callee)) {
      transportVars.push(m[1]);
    }
  }
  if (!transportVars.length) {
    // A bare `await fetch(url)` whose result is not captured cannot flow to output.
    return false;
  }
  // The captured response (or a value derived from it) must reach a return/persist.
  const tail = t.slice(t.indexOf(transportVars[0]) + transportVars[0].length);
  return transportVars.some((v) => {
    const usageRe = new RegExp(`\\b${v}\\b`, 'g');
    const uses = (tail.match(usageRe) || []).length;
    // At least one use beyond the assignment, AND a return/persist references
    // either the var or a variable transformed from it (.map/.parse/destructure).
    if (uses < 1) return false;
    const derived = new RegExp(`${v}\\s*\\.(map|parse|json|body|data|workers|items|records|rows|forEach)|=\\s*[^;]*\\b${v}\\b|\\{[^}]*\\}\\s*=\\s*${v}`);
    const returnsDerived = derived.test(tail) && /(return|insert|values|upsert|save|create)\b/.test(tail);
    return returnsDerived;
  });
}

// Does the body catch a transport error and convert it into a success result?
function convertsErrorToSuccess(body) {
  const t = String(body || '');
  const catchRe = /catch\s*\([^)]*\)\s*\{([\s\S]*?)\}/g;
  let m;
  while ((m = catchRe.exec(t)) !== null) {
    const block = m[1];
    if (/return\s*\{[^}]*\bok\s*:\s*true/.test(block) || /return\s*\{[^}]*\bstatus\s*:\s*['"]passed['"]/.test(block)) {
      return true;
    }
  }
  return false;
}

// A "connection/test/probe/check" action whose success is derived only from
// config-field presence (no transport in the reachable body).
function isPresenceOnlyCheck(body) {
  const t = String(body || '');
  if (hasTransportCall(t)) return false;
  const returnsSuccess = /return\s*\{[^}]*\bok\s*:\s*(true|steps\.length)/.test(t)
    || /status\s*:\s*['"]passed['"]/.test(t)
    || /return\s*\{\s*ok\s*,/.test(t);
  const readsConfigPresence = /cfg\??\.\w+|config\??\.\w+|\bEnc\b|Pem|clientId|clientSecret|privateKey|certPem/.test(t);
  return returnsSuccess && readsConfigPresence;
}

// Is a transport call present but only inside a function that nothing else in
// the file calls (dead/unreachable)? Conservative: a helper that is never
// referenced by name outside its own definition.
function transportOnlyInDeadCode(fns, fileText) {
  const withTransport = fns.filter((f) => hasTransportCall(f.body));
  if (!withTransport.length) return false;
  const actionFns = fns.filter((f) => /check|test|probe|sync|fetch|connect|pull|refresh|list/i.test(f.name));
  // If NO action function itself has a transport, but some non-action helper does,
  // check whether that helper is actually referenced from an action.
  const anyActionHasTransport = actionFns.some((f) => hasTransportCall(f.body));
  if (anyActionHasTransport) return false;
  const code = stripComments(fileText);
  return withTransport.every((f) => {
    const refs = (code.match(new RegExp(`\\b${f.name}\\b`, 'g')) || []).length;
    return refs <= 1; // only its own definition
  });
}

// A fixture/offline path reachable through production configuration (a non
// test-only env key selects canned data / bundled fixtures).
function fixtureReachableInProduction(body, testOnlyKeys) {
  const t = String(body || '');
  const branchRe = /if\s*\(\s*([^)]*?)\)\s*\{([\s\S]*?)\}/g;
  let m;
  while ((m = branchRe.exec(t)) !== null) {
    const cond = m[1];
    const block = m[2];
    const selectsCanned = hasHardcodedRecordSet(block) || /OFFLINE|SAMPLE|SEED|CANNED|FIXTURE/i.test(block) && !hasTransportCall(block);
    if (!selectsCanned) continue;
    // Which config key gates it?
    const keyMatch = cond.match(/(?:cfg|config|process\.env)\??\.?\[?['"]?([A-Za-z0-9_]+)/);
    const key = keyMatch ? keyMatch[1] : null;
    const isTestOnly = key && (testOnlyKeys || []).includes(key);
    // process.env keys named CONTRACT_/TEST_/FIXTURE_ are conventionally test-only.
    const conventionallyTestOnly = key && /^(CONTRACT|TEST|FIXTURE|E2E)_/.test(key);
    if (!isTestOnly && !conventionallyTestOnly) return { hit: true, key };
  }
  return { hit: false };
}

// ---- undeclared-integration discovery (source supplements the manifest) ----

// Subsystem of a scaffold path: src/<subsystem>/...
export function subsystemForPath(path) {
  const m = String(path || '').match(/^src\/([^/]+)\//);
  return m ? m[1] : null;
}

function discoverOutboundSubsystems(files) {
  const bySub = new Map();
  for (const f of files) {
    if (!langOf(f.path)) continue;
    if (isTestPath(f.path)) continue;
    const sub = subsystemForPath(f.path);
    if (!sub) continue;
    if (hasTransportCall(stripComments(f.content))) {
      if (!bySub.has(sub)) bySub.set(sub, []);
      bySub.get(sub).push(f.path);
    }
  }
  return bySub;
}

function isTestPath(path) {
  return /(^|\/)(tests?|__tests__)\//i.test(String(path)) || /\.(test|spec|contract)\.[a-z]+$/i.test(String(path));
}

// ---- B.4 analyzer ----

function finding(kind, { file = null, fn = null, message, severity = 'high' }) {
  return { kind, file, function: fn, message, severity, schema_version: INTEGRATION_GATE_SCHEMA_VERSION };
}

// analyzeIntegrations({ files, manifest }) → {
//   schema_version, verdict: 'pass'|'fail', findings: [...], limits
// }. Fails closed for every manifest-declared capability whose provenance cannot
// be established, and flags undeclared outbound integrations found in source.
export function analyzeIntegrations({ files = [], manifest = { entries: [] } } = {}) {
  const findings = [];
  const entries = manifest?.entries || [];
  const fileList = files || [];
  const declaredSubsystems = new Set(entries.map((e) => e.subsystem));

  // 1) Each manifest-declared capability must be honestly implemented.
  for (const entry of entries) {
    const subFiles = fileList.filter((f) => subsystemForPath(f.path) === entry.subsystem && !isTestPath(f.path));
    const analyzable = subFiles.filter((f) => langOf(f.path));
    const unanalyzable = subFiles.filter((f) => !langOf(f.path));

    if (analyzable.length === 0) {
      // Fail closed: declared but nothing we can analyze (missing artifact or
      // unsupported language). NEVER inferred as clean.
      const why = unanalyzable.length
        ? `source present but in an unsupported language (${unanalyzable.map((f) => f.path).join(', ')})`
        : 'no analyzable source found for the declared subsystem';
      findings.push(finding('provenance_not_established', {
        file: unanalyzable[0]?.path || `src/${entry.subsystem}/`,
        message: `Integration "${entry.id}" (${entry.subsystem}): provenance not established — ${why}. Supported languages: ${SUPPORTED_LANGUAGES.join(', ')}.`,
      }));
      continue;
    }

    // Contract test presence (negative-path coverage lives in the acceptance
    // gate's static check; here we require the declared file to exist).
    if (entry.contract_test && !fileList.some((f) => f.path === entry.contract_test)) {
      findings.push(finding('contract_test_missing', {
        file: entry.contract_test,
        message: `Integration "${entry.id}" declares contract_test ${entry.contract_test} but it is absent — the negative-path contract (TLS/DNS/refusal/timeout/auth/malformed) cannot run.`,
      }));
    }

    const testOnlyKeys = entry.fixtures?.test_only_config || [];
    // One call graph across ALL of the subsystem's analyzable files, so a
    // transport helper in transport.ts is reachable from an action in service.ts.
    const allFns = analyzable.flatMap((f) => extractFunctions(f.content).map((fn) => ({ ...fn, path: f.path })));
    const reachesTransport = buildTransportReachability(allFns);

    for (const f of analyzable) {
      const imports = extractImports(f.content);
      const fns = extractFunctions(f.content);

      for (const fn of fns) {
        // A "connection/test/probe/verify" action: it must actually perform the
        // operation it reports success for.
        const isCheckAction = /check|test|probe|connect|verify|handshake/i.test(fn.name);
        // A "fetch-and-persist" action: it persists, or its name says it pulls
        // external data. A pure DB read (listPeople → db.select) is the legitimate
        // "read stored copy" half and is NOT an integration call.
        const isFetchAction = persistsData(fn.body) || /sync|fetch|pull|refresh|import/i.test(fn.name);
        if (!isCheckAction && !isFetchAction) continue;

        // (4) Honest failure: transport error caught and converted to success.
        if (convertsErrorToSuccess(fn.body)) {
          findings.push(finding('error_converted_to_success', {
            file: f.path, fn: fn.name,
            message: `"${fn.name}" catches a transport/TLS/auth error and returns success — transport, TLS, authentication, and protocol failures must remain failures and be surfaced accurately.`,
          }));
          continue;
        }

        // (5) Fixture isolation: a canned/offline path selectable via production config.
        const fx = fixtureReachableInProduction(fn.body, testOnlyKeys);
        if (fx.hit) {
          findings.push(finding('fixture_reachable_in_production', {
            file: f.path, fn: fn.name,
            message: `"${fn.name}" can select bundled/canned data through production configuration${fx.key ? ` ("${fx.key}")` : ''}. Fixture mode must be reachable ONLY via explicit test-only configuration (${testOnlyKeys.join(', ') || 'declare fixtures.test_only_config'}); production defaults and failure fallbacks must never select it.`,
          }));
          continue;
        }

        // (2) Execution: a connection/test/probe whose success does not depend on
        // an actually-invoked transport (presence-only, or dead-code transport).
        if (isCheckAction && !reachesTransport(fn.name)) {
          findings.push(finding('execution_without_transport', {
            file: f.path, fn: fn.name,
            message: `"${fn.name}" reports success without invoking ${entry.transport} on a reachable path — configuration-field presence (or an unreachable/dead-code transport call) is never a successful connection, test, or probe. Perform the real handshake and surface its failures.`,
          }));
          continue;
        }

        // (3) Result provenance: persisted/returned data must derive from the
        // transport response — not a literal, bundled JSON, or an ignored response.
        if (isFetchAction) {
          const reaches = reachesTransport(fn.name);
          const bundled = usesBundledData(fn.body, imports);
          if (!reaches) {
            findings.push(finding('fabricated_output', {
              file: f.path, fn: fn.name,
              message: `"${fn.name}" persists/returns ${bundled ? 'bundled fixture data' : 'data that does not come from a transport'} without any reachable ${entry.transport} invocation. Persisted or returned data must derive from the ${entry.transport} response; it must fail loudly when the endpoint is unreachable, never fabricate rows.`,
            }));
            continue;
          }
          // Transport is reachable — but is the RESPONSE what flows to the output?
          // A canned record set / bundled data returned while the response does
          // not flow to the output means the response was ignored.
          if ((hasHardcodedRecordSet(fn.body) || bundled) && !responseFlowsToOutput(fn.body)) {
            findings.push(finding('fabricated_output', {
              file: f.path, fn: fn.name,
              message: `"${fn.name}" reaches ${entry.transport} but returns/persists canned data while the response does not flow to the output (the response is ignored). Output must derive from the received response.`,
            }));
            continue;
          }
        }
      }
    }
  }

  // 2) Undeclared outbound integrations discovered in source (omitting the
  //    manifest is not a bypass).
  const discovered = discoverOutboundSubsystems(fileList);
  for (const [sub, paths] of discovered) {
    if (declaredSubsystems.has(sub)) continue;
    findings.push(finding('undeclared_integration', {
      file: paths[0],
      message: `Outbound integration in "${sub}" (${paths.join(', ')}) has no entry in ${INTEGRATION_MANIFEST_PATH}. Every external capability must be declared; add a manifest entry (id, subsystem, actions, destination, transport, provenance, live_verification, egress).`,
    }));
  }

  return {
    schema_version: INTEGRATION_GATE_SCHEMA_VERSION,
    verdict: findings.length ? 'fail' : 'pass',
    findings,
    limits: analyzerLimits(),
  };
}

// bootstrapManifestFromDiscovery — propose manifest entries for undeclared
// integrations found by the analyzer (migration/reconciliation aid, B.2 "source
// discovery supplements the manifest"). The proposals are marked bootstrapped so
// an operator confirms them; they are never silently authoritative.
export function bootstrapManifestFromDiscovery(analysis) {
  const entries = [];
  for (const f of (analysis?.findings || [])) {
    if (f.kind !== 'undeclared_integration') continue;
    const sub = subsystemForPath(f.file) || 'unknown';
    entries.push({
      id: `${sub}-integration`,
      subsystem: sub,
      actions: [{ name: 'call', operation: 'http' }],
      destination: { source: 'unknown', key: `(discovered in ${f.file} — confirm)` },
      transport: 'https',
      provenance: { response_to_output: 'required' },
      live_verification: { required: true },
      egress: { classification: 'public' },
      bootstrapped: true,
      discovered_in: f.file,
    });
  }
  return { schema_version: MANIFEST_SCHEMA_VERSION, entries };
}
