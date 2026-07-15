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
  'Fabrication findings require POSITIVE canned-data evidence (a reachable hardcoded record set or bundled fixture data): a declared subsystem\'s ordinary local persistence (session tokens, audit rows, settings, cache bookkeeping) is app code, not integration output. Programmatically generated fake data with no literal/bundled source is out of this analyzer\'s reach (the no-simulation test guard and disclosure screen cover that).',
  'Class and object-literal methods are extracted alongside top-level functions; property-assigned arrow methods (`foo: () => {}`) are not followed.',
  'Transport through a known client LIBRARY (ldapts, ldapjs, axios, got, undici, pg, …) is recognized via the file\'s imports + instance I/O-verb calls (.bind/.search/.unbind/.request/.post/.query/…); a library not on the known list may under-detect as no-transport (conservative — such a check fails closed as execution_without_transport, never passes silently).',
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

// The exact entry shape, appended to every validation error so a builder (or an
// operator) can self-correct in one step instead of guessing field names —
// entries keyed `key`/`name`/`destinations`/`code` were a real five-cycle loop.
export const MANIFEST_ENTRY_SHAPE_HINT =
  'required entry shape (exact keys): {"id":"<slug>","subsystem":"<src/<subsystem>/ folder>","actions":[{"name":"…","operation":"…"}],"destination":{"source":"env|config","key":"<ENV_OR_CONFIG_KEY>"},"transport":"https|https-mtls|ldaps|…","provenance":{"response_to_output":"required"},"live_verification":{"required":true|false},"egress":{"classification":"public|private"},"contract_test":"tests/contract/….test.ts"?} — keys like `key`, `name`, `destinations`, or `code` do NOT validate';

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
    if (err) return { ok: false, error: `${err} — ${MANIFEST_ENTRY_SHAPE_HINT}` };
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

// ---- near-miss entry normalization (schema migration for wrong-shape entries) ----

// A build (or a human) that declared its integrations in the WRONG field names
// — `key`/`name` instead of `id`, `destinations` instead of `destination`,
// `code`/`paths` file lists instead of `subsystem`, string actions — wrote real
// information in an invalid shape. Dropping those entries on repair would turn
// a manifest-invalid block into an undeclared block: the same loop, one class
// over. This migrates a near-miss entry into the canonical shape, CONSERVATIVELY:
// it only ever renames/derives from what the entry actually says, defaults the
// safety-relevant fields to their strict values (live_verification.required
// true; egress private), and reports every inference so the operator sees what
// was assumed. The result still passes validateManifestEntry — and declaring is
// not trusting: the gate re-checks the declared subsystem's code for real
// provenance either way.
function slugId(v) {
  return String(v || '').trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
}

// Parse one destination-ish value into { source, key }: an object with
// source/key; "env:LDAPS_URL" / "config:adpTokenUrl"; a bare env-var-looking
// name; or any other string (kept as a config key).
function coerceDestination(v) {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const source = String(v.source || v.type || '').trim();
    const key = String(v.key || v.name || v.env || v.url || '').trim();
    if (key) return { source: source || (/^[A-Z0-9_]+$/.test(key) ? 'env' : 'config'), key };
    return null;
  }
  const s = String(v || '').trim();
  if (!s) return null;
  const m = s.match(/^(env|config|secret|settings?)\s*[:=]\s*(.+)$/i);
  if (m) return { source: m[1].toLowerCase(), key: m[2].trim() };
  return { source: /^[A-Z0-9_]+$/.test(s) ? 'env' : 'config', key: s };
}

// normalizeManifestEntry(raw) — best-effort migration of a near-miss entry into
// the canonical shape. Returns { ok, entry, inferred: [what was derived] } or
// { ok:false, error } when even migration can't produce a valid entry. An entry
// that ALREADY validates returns as-is with inferred: [].
export function normalizeManifestEntry(raw) {
  const direct = validateManifestEntry(raw);
  if (direct.ok) return { ok: true, entry: direct.entry, inferred: [] };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'entry is not an object' };
  const inferred = [];

  const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : slugId(raw.key ?? raw.name);
  if (!id) return { ok: false, error: 'no id/key/name to derive an id from' };
  if (raw.id !== id) inferred.push(`id "${id}" from ${raw.key != null ? '`key`' : '`name`'}`);

  // Subsystem: declared, or derived from the entry's own file lists (code/paths/
  // files/sources), or the id's leading word as a last resort.
  let subsystem = typeof raw.subsystem === 'string' && raw.subsystem.trim() ? raw.subsystem.trim() : null;
  if (!subsystem) {
    const fileLists = ['code', 'paths', 'files', 'sources'];
    for (const k of fileLists) {
      const arr = Array.isArray(raw[k]) ? raw[k] : [];
      for (const p of arr) {
        const sub = subsystemForPath(p);
        if (sub) { subsystem = sub; inferred.push(`subsystem "${sub}" from \`${k}\` path ${p}`); break; }
      }
      if (subsystem) break;
    }
  }
  if (!subsystem) { subsystem = id.split('-')[0]; inferred.push(`subsystem "${subsystem}" from the id`); }

  const transport = String(raw.transport || raw.protocol || '').trim() || 'https';
  if (!raw.transport) inferred.push(`transport "${transport}"${raw.protocol ? ' from `protocol`' : ' (default)'}`);

  // Actions: objects kept; strings become {name, operation}; none → one generic
  // action on the transport.
  const rawActions = Array.isArray(raw.actions) ? raw.actions : (Array.isArray(raw.operations) ? raw.operations : []);
  let actions = rawActions.map((a) => {
    if (a && typeof a === 'object' && a.name && a.operation) return { name: String(a.name), operation: String(a.operation) };
    if (a && typeof a === 'object' && (a.name || a.operation)) return { name: String(a.name || a.operation), operation: String(a.operation || a.name) };
    const s = String(a || '').trim();
    return s ? { name: s, operation: s } : null;
  }).filter(Boolean);
  if (!actions.length) { actions = [{ name: 'connect', operation: transport }]; inferred.push('a generic "connect" action (none declared)'); }
  else if (!Array.isArray(raw.actions) || rawActions.some((a) => !(a && a.name && a.operation))) inferred.push('actions normalized to {name, operation}');

  // Destination: the canonical object, the first of a `destinations` list, or an
  // endpoint/url-ish field.
  let destination = coerceDestination(raw.destination)
    || (Array.isArray(raw.destinations) ? raw.destinations.map(coerceDestination).find(Boolean) : null)
    || coerceDestination(raw.endpoint ?? raw.url ?? raw.host ?? null);
  if (!destination) return { ok: false, error: `entry "${id}" has no destination/destinations/endpoint to derive destination{source,key} from` };
  if (!(raw.destination && raw.destination.source && raw.destination.key)) inferred.push(`destination {source:"${destination.source}", key:"${destination.key}"}`);

  const provenance = raw.provenance?.response_to_output
    ? { response_to_output: String(raw.provenance.response_to_output) }
    : { response_to_output: 'required' };
  if (!raw.provenance?.response_to_output) inferred.push('provenance.response_to_output "required" (strict default)');

  const live = typeof raw.live_verification?.required === 'boolean'
    ? { required: raw.live_verification.required }
    : { required: true };
  if (typeof raw.live_verification?.required !== 'boolean') inferred.push('live_verification.required true (strict default — the operator confirms the live check)');

  const egress = raw.egress?.classification
    ? { classification: String(raw.egress.classification) }
    : { classification: typeof raw.egress === 'string' && raw.egress.trim() ? raw.egress.trim() : 'private' };
  if (!raw.egress?.classification) inferred.push(`egress.classification "${egress.classification}"${typeof raw.egress === 'string' ? ' from `egress`' : ' (strict default)'}`);

  const contractTest = [raw.contract_test, raw.contractTest, raw.contract].find((v) => typeof v === 'string' && v.trim());

  const candidate = {
    id, subsystem, actions, destination, transport, provenance,
    live_verification: live, egress,
    ...(contractTest ? { contract_test: contractTest.trim() } : {}),
  };
  const v = validateManifestEntry(candidate);
  if (!v.ok) return { ok: false, error: `could not migrate entry "${id}": ${v.error}` };
  return { ok: true, entry: v.entry, inferred };
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
//   { needed:true, text, salvaged, migrated,  — rewrite with a valid scaffold:
//     dropped, archive }                        entries that validate are kept;
//                                               NEAR-MISS entries (wrong field
//                                               names — key/name/destinations/
//                                               code) are MIGRATED into the
//                                               canonical shape (each with its
//                                               inference report); only entries
//                                               that can't be migrated are
//                                               dropped (reported). The original
//                                               text goes to `archive`
//                                               (state/integrations.invalid.json)
//                                               so nothing is silently lost.
// An absent/blank manifest needs no repair (the gate already tolerates it).
export function repairManifestPlan(currentText) {
  const raw = String(currentText || '');
  if (!raw.trim()) return { needed: false, reason: 'no manifest present — nothing to repair (an absent manifest is valid)' };
  const parsed = parseIntegrationManifest(raw);
  if (parsed.ok) return { needed: false, reason: 'the manifest already parses and validates' };
  const salvaged = [];
  const migrated = [];
  const dropped = [];
  try {
    const doc = JSON.parse(raw);
    // Wrong container keys happen too: entries may live under `integrations`.
    const entriesIn = Array.isArray(doc?.entries) ? doc.entries
      : Array.isArray(doc?.integrations) ? doc.integrations : [];
    for (const e of entriesIn) {
      const n = normalizeManifestEntry(e);
      if (!n.ok) { dropped.push({ id: e?.id || e?.key || e?.name || '(no id)', error: n.error }); continue; }
      if (salvaged.some((s) => s.id === n.entry.id)) { dropped.push({ id: n.entry.id, error: 'duplicate id' }); continue; }
      salvaged.push(n.entry);
      if (n.inferred.length) migrated.push({ id: n.entry.id, inferred: n.inferred });
    }
  } catch { /* unparseable JSON — nothing to salvage */ }
  return {
    needed: true,
    error: parsed.error,
    text: scaffoldManifestText(salvaged),
    salvaged,
    migrated,
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

// Balance the parameter list starting at the '(' at index i; returns the index
// just past the closing ')'.
function skipBalancedParens(code, i) {
  let pd = 0;
  for (; i < code.length; i++) {
    if (code[i] === '(') pd++;
    else if (code[i] === ')') { pd--; if (pd === 0) return i + 1; }
  }
  return i;
}

// Balance a `{ … }` body starting at the '{' at index b; returns the index just
// past the closing '}'.
function skipBalancedBraces(code, b) {
  let depth = 0;
  for (let j = b; j < code.length; j++) {
    if (code[j] === '{') depth++;
    else if (code[j] === '}') { depth--; if (depth === 0) return j + 1; }
  }
  return code.length;
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
    const i = skipBalancedParens(code, re.lastIndex - 1);
    const b = code.indexOf('{', i);
    if (b < 0) continue;
    const j = skipBalancedBraces(code, b);
    out.push({ name, body: code.slice(b, j) });
    re.lastIndex = j; // continue scanning after this function
  }
  return [...out, ...extractMethods(code)];
}

// Also extract CLASS and OBJECT-LITERAL METHODS (`async fetchWorkers(args) {`).
// Real transport code frequently lives on a client class; without this, every
// caller of a class method looked like "unreachable transport" and a whole
// subsystem of honest code mass-flagged. A method definition is a line-leading
// `name(params)` whose balanced param list is followed (after an optional TS
// return-type annotation) by `{` — a CALL statement is followed by `;`/`.`/
// operator instead, so calls never match.
const METHOD_NAME_KEYWORDS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'await',
  'constructor', 'super', 'new', 'else', 'do', 'typeof', 'delete', 'void', 'yield',
]);
function extractMethods(code) {
  const out = [];
  const re = /(?:^|\n)[ \t]*(?:(?:public|private|protected|static|readonly|override)\s+)*(?:async\s+)?(?:\*\s*)?([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g;
  let m;
  while ((m = re.exec(code)) !== null) {
    const name = m[1];
    if (METHOD_NAME_KEYWORDS.has(name)) continue;
    let i = skipBalancedParens(code, re.lastIndex - 1);
    while (i < code.length && /\s/.test(code[i])) i++;
    // Optional TS return type between `)` and `{` — accept only a simple
    // annotation on the same statement (no ';' or '=>' before the brace).
    if (code[i] === ':') {
      const brace = code.indexOf('{', i);
      const semi = code.indexOf(';', i);
      const arrow = code.indexOf('=>', i);
      if (brace < 0 || (semi >= 0 && semi < brace) || (arrow >= 0 && arrow < brace)) continue;
      i = brace;
    }
    if (code[i] !== '{') continue; // a call / non-method construct
    const j = skipBalancedBraces(code, i);
    out.push({ name, body: code.slice(i, j) });
    re.lastIndex = j;
  }
  return out;
}

function hasTransportCall(text) {
  const t = String(text || '');
  return TRANSPORT_PATTERNS.some((p) => t.includes(p));
}

// ---- library-aware transport detection ----
//
// Real transport very often goes through a client LIBRARY: `ldapts`' Client
// performs the actual LDAPS handshake in `client.bind()` / `client.search()` /
// `client.unbind()`; axios/got/undici carry HTTP(S) in `.get()`/`.post()`/
// `.request()`. Those methods are defined in node_modules — outside the
// analyzed file set — so the lexical patterns and the same-subsystem call graph
// never saw them, and every checker built on a library client mass-flagged as
// execution_without_transport (a real 4-finding case on genuine ldapts code).
//
// The rule: when a FILE imports a known transport-performing module (relative
// imports never count), an instance I/O-verb call in a function body counts as
// a transport invocation. A presence-only check still has neither the import
// nor the call, so it stays caught.
const TRANSPORT_MODULES_RE = new RegExp(
  '^(node:)?(https?|http2|tls|net|dgram)$'
  + '|^(ldapts|ldapjs|axios|got|undici|node-fetch|cross-fetch|ky|superagent|needle'
  + '|pg|postgres|mysql2?|ioredis|redis|mongodb|mongoose|amqplib|kafkajs|nats'
  + '|soap|ws|socket\\.io-client|nodemailer|ssh2|basic-ftp|net-snmp)(/|$)'
  + '|^@grpc/',
);

export function importsTransportModule(imports = []) {
  return (Array.isArray(imports) ? imports : []).some((m) => TRANSPORT_MODULES_RE.test(String(m || '').trim()));
}

// Instance I/O verbs a transport client exposes. Deliberately protocol-flavored
// (LDAP ops, HTTP verbs, DB/queue verbs) — and only consulted for functions in
// files that import a transport module, so `map.get(...)` in ordinary code
// never reads as transport.
const IO_VERB_CALL_RE = /\.(bind|unbind|search|starttls|exop|modify|modifyDN|request|fetch|get|post|put|patch|delete|head|send|sendMail|query|connect|publish|subscribe)\s*\(/;

// Does this function perform transport itself? Lexical fingerprints always
// count; library instance calls count when the function's FILE imports a
// transport module (fn.libTransport, stamped by the analyzer).
function fnPerformsTransport(fn) {
  if (hasTransportCall(fn?.body)) return true;
  return !!fn?.libTransport && IO_VERB_CALL_RE.test(String(fn?.body || ''));
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
// transport" if its own body performs one (lexical fingerprint, or a library
// instance I/O call in a transport-importing file) OR it calls (transitively,
// within the provided function set) a function that does. This is what makes
// dead-code transport (E5) and helper-laundered literals (ADP2's
// starterRecords) decidable without name matching: an unreachable helper is
// simply never on a path.
function buildTransportReachability(fns) {
  const byName = new Map(fns.map((f) => [f.name, f]));
  const memo = new Map();
  const resolve = (name, seen) => {
    if (memo.has(name)) return memo.get(name);
    const fn = byName.get(name);
    if (!fn || seen.has(name)) return false;
    seen.add(name);
    let reaches = fnPerformsTransport(fn);
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

// buildCannedReachability(fns) → (name) => boolean: does a function's body
// contain a hardcoded record set, or (transitively, within the subsystem's
// function set) call one that does? The canned-literal twin of transport
// reachability — it's what keeps "the literal moved into a helper" caught while
// ordinary local persistence (inserting runtime arguments) stays clean.
function buildCannedReachability(fns) {
  const byName = new Map(fns.map((f) => [f.name, f]));
  const memo = new Map();
  const resolve = (name, seen) => {
    if (memo.has(name)) return memo.get(name);
    const fn = byName.get(name);
    if (!fn || seen.has(name)) return false;
    seen.add(name);
    let canned = hasHardcodedRecordSet(fn.body);
    if (!canned) {
      for (const callee of calledIdentifiers(fn.body)) {
        if (callee !== name && resolve(callee, seen)) { canned = true; break; }
      }
    }
    memo.set(name, canned);
    return canned;
  };
  return (name) => resolve(name, new Set());
}

// A CONNECTIVITY check: the function's name says it exercises the link itself
// (connection test, probe, bind, handshake, health/heartbeat, reachability).
// Deliberately NOT any name containing verify/test/check — a declared auth
// subsystem legitimately holds verifyPassword/verifyTotp/verifyAccessToken
// (local crypto) and touchTested (bookkeeping); demanding those invoke the
// directory transport mass-flagged honest code. Accessor-style prefixes
// (setConnectionStatus, getConnectionInfo) are state access, not checks.
const CONNECTIVITY_NAME_RE = /(connect|handshake|probe|ping|reachab|bind|heartbeat|health|upstream|link)/i;
const ACCESSOR_PREFIX_RE = /^(get|set|read|load|store|save|update|write|clear|mark|touch|is|has|format|render|on)(?=[A-Z_])/;
function isConnectivityCheckName(name) {
  const n = String(name || '');
  return CONNECTIVITY_NAME_RE.test(n) && !ACCESSOR_PREFIX_RE.test(n);
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
    const code = stripComments(f.content);
    // Same library awareness as the reachability graph: a subsystem dialing out
    // through ldapts/axios/… is an outbound integration even when no lexical
    // fingerprint appears — omitting the manifest is not a bypass.
    const lib = importsTransportModule(extractImports(f.content));
    if (hasTransportCall(code) || (lib && IO_VERB_CALL_RE.test(code))) {
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
    // Each function is stamped with whether its FILE imports a transport module,
    // so library-client I/O calls (ldapts bind/search, axios post, …) count.
    const allFns = analyzable.flatMap((f) => {
      const libTransport = importsTransportModule(extractImports(f.content));
      return extractFunctions(f.content).map((fn) => ({ ...fn, path: f.path, libTransport }));
    });
    const reachesTransport = buildTransportReachability(allFns);
    const reachesCanned = buildCannedReachability(allFns);

    for (const f of analyzable) {
      const imports = extractImports(f.content);
      const fns = extractFunctions(f.content);

      for (const fn of fns) {
        // A CONNECTIVITY check action: it must actually perform the handshake it
        // reports success for. Scoped to connectivity-named functions — local
        // verification (verifyPassword/verifyTotp) and accessors are app code.
        const isCheckAction = isConnectivityCheckName(fn.name);
        // A "fetch-and-persist" action: it persists, or its name says it pulls
        // external data. A pure DB read (listPeople → db.select) is the legitimate
        // "read stored copy" half and is NOT an integration call.
        const isFetchAction = persistsData(fn.body) || /sync|fetch|pull|import/i.test(fn.name);
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
            // Fabrication needs POSITIVE canned-data evidence: a hardcoded
            // record set reachable from this function, or bundled fixture data.
            // A declared subsystem's ordinary local persistence (session tokens,
            // audit rows, admin-entered settings, cache bookkeeping over runtime
            // values) is app code, not integration output — flagging it forced
            // honest builds into an unfixable block (a real 20-finding case).
            if (!bundled && !reachesCanned(fn.name)) continue;
            findings.push(finding('fabricated_output', {
              file: f.path, fn: fn.name,
              message: `"${fn.name}" persists/returns ${bundled ? 'bundled fixture data' : 'hardcoded/canned records'} without any reachable ${entry.transport} invocation. Persisted or returned data must derive from the ${entry.transport} response; it must fail loudly when the endpoint is unreachable, never fabricate rows.`,
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
      message: `Outbound integration in "${sub}" (${paths.join(', ')}) has no entry in ${INTEGRATION_MANIFEST_PATH}. Every external capability must be declared; add a manifest entry — ${MANIFEST_ENTRY_SHAPE_HINT}.`,
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
