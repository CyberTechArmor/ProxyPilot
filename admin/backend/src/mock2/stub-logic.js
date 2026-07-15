// Mock2 STUB REGISTRY — pure severity semantics + work-file context (B.6).
// Native-free, unit-tested stub-first (risk R9). The registry tracks every
// APPROVED simulation/stub (an intentional, admin-approved, recorded, labeled
// production simulation — the only legitimate form per B.1). The AUDIT proved
// nothing indexed shipped stubs, so instruction-scoped cycles built on top of
// them blind; this module is the context that makes them visible to every cycle.
//
// Terminology (risk R7): nothing here is named "agent".

export const STUB_SCHEMA_VERSION = 1;

// Severity levels, highest first. Effects (task B.6):
//   critical — fabricated production data or security behavior: blocks succeeded
//              on any cycle touching the subsystem; global surfacing; UI banner.
//   high     — user-visible integration simulated: blocking on touched subsystems.
//   medium   — approved degraded fallback: surfaced on touched subsystems.
//   low      — non-production/administrative simulation: registry + status only.
export const STUB_SEVERITIES = Object.freeze(['critical', 'high', 'medium', 'low']);
const BLOCKING_SEVERITIES = new Set(['critical', 'high']);

export function validateStubEntry(entry) {
  if (!entry || typeof entry !== 'object') return { ok: false, error: 'stub entry must be an object' };
  if (!STUB_SEVERITIES.includes(entry.severity)) return { ok: false, error: `severity must be one of ${STUB_SEVERITIES.join(', ')}` };
  if (!entry.file || typeof entry.file !== 'string') return { ok: false, error: 'stub entry needs a file' };
  if (!entry.reason || !String(entry.reason).trim()) return { ok: false, error: 'stub entry needs a reason' };
  if (!entry.approval_ref || !String(entry.approval_ref).trim()) return { ok: false, error: 'stub entry needs an approval reference (deviation/queue id)' };
  if (!entry.subsystem || typeof entry.subsystem !== 'string') return { ok: false, error: 'stub entry needs a subsystem' };
  return { ok: true };
}

function isOpen(stub) {
  return !stub.status || stub.status === 'open';
}

// Does this stub block `succeeded` for a cycle touching these subsystems?
// Only OPEN critical/high stubs on a touched subsystem block.
export function stubBlocksSubsystems(stub, subsystems = []) {
  if (!isOpen(stub)) return false;
  if (!BLOCKING_SEVERITIES.has(stub.severity)) return false;
  return (subsystems || []).includes(stub.subsystem);
}

// The subsystem a scaffold path belongs to (src/<subsystem>/…), or null for
// non-subsystem paths (public/, migrations/, root files).
export function subsystemOfPath(path) {
  const m = String(path || '').match(/^src\/([^/]+)\//);
  return m ? m[1] : null;
}

// The distinct subsystems a set of changed files touches, order-stable.
export function touchedSubsystems(changedFiles = []) {
  const out = [];
  for (const f of changedFiles || []) {
    const s = subsystemOfPath(f);
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

// One concise line per open stub (global list injected into EVERY cycle's
// work-file). Deliberately omits the full record (no approval_ref / file detail).
function conciseLine(stub) {
  return `- [${stub.severity}] ${stub.subsystem}: ${String(stub.reason || '').slice(0, 120)}`;
}

// The full registry record block (injected only for cycles touching the affected
// subsystem) — names the file/function, the reason, and the remediation ask.
function fullRecordBlock(stub) {
  return [
    `### Unresolved production simulation in "${stub.subsystem}" [${stub.severity}]`,
    `- File: ${stub.file}${stub.function ? ` (${stub.function})` : ''}`,
    stub.manifest_id ? `- Integration: ${stub.manifest_id}` : null,
    `- Why it exists: ${stub.reason}`,
    `- Approval: ${stub.approval_ref}`,
    `- Remediation: replace this simulation with the real implementation for this subsystem, or an admin must re-approve it. A touched-subsystem cycle cannot report "succeeded" while a critical/high simulation here is unresolved.`,
  ].filter(Boolean).join('\n');
}

// stubContextForCycle({ stubs, subsystems }) — the two-tier work-file context
// (B.6): a concise GLOBAL list of every open production simulation, plus FULL
// registry records for stubs whose subsystem this cycle touches.
export function stubContextForCycle({ stubs = [], subsystems = [] } = {}) {
  const open = (stubs || []).filter(isOpen);
  const global = open.map(conciseLine).join('\n');
  const full = open.filter((s) => (subsystems || []).includes(s.subsystem));
  const block = full.map(fullRecordBlock).join('\n\n');
  return { global, full, block };
}

// stubRuntimeExposure(stubs) — the Run-stage exposure (UI badge / status
// endpoint): open production simulations, secrets-free. B.6 "the Run stage
// exposes open stubs".
export function stubRuntimeExposure(stubs = []) {
  const open = (stubs || []).filter(isOpen);
  const order = { critical: 0, high: 1, medium: 2, low: 3 };
  const maxSeverity = open.reduce((acc, s) => (order[s.severity] < order[acc] ? s.severity : acc), 'low');
  return {
    schema_version: STUB_SCHEMA_VERSION,
    open_count: open.length,
    max_severity: open.length ? maxSeverity : null,
    stubs: open.map((s) => ({
      subsystem: s.subsystem, severity: s.severity, file: s.file,
      function: s.function || null, reason: s.reason, manifest_id: s.manifest_id || null,
    })),
  };
}
