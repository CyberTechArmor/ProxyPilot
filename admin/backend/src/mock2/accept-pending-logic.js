// Operator "accept as pending operator verification" valve — PURE decision layer.
//
// The completion pressure-relief valve for an app whose whole purpose is an
// external integration the sealed fence cannot verify live. When a cycle is
// blocked (the integration gate could not prove a live call, or the build halted
// because the fence can't reach the endpoint) but the operator ATTESTS the code is
// real and will be verified live against the production system, an admin converts
// the blocked cycle to pending-operator-verification and deploys it — WITHOUT
// another model round and WITHOUT ever claiming "succeeded". The outstanding live
// check is recorded, so the honesty guarantee is preserved: it moves from "the
// fence proves it" to "a named human verifies it live and records the observed
// result." Every use is audit-logged with the attestation (the native route half).
//
// This module is pure (no DB/container) so the decision + checklist shaping are
// unit-tested; runner.acceptPendingVerification is the thin lifecycle half.

// Blocked/halted states an operator may convert. A cycle that already succeeded or
// is already pending must not be re-accepted (that would be a no-op loop).
const ACCEPTABLE_STATUSES = Object.freeze(['awaiting_admin']);

// halt_reasons this valve is INTENDED for — a block rooted in the fence being
// unable to verify a live external integration. Other awaiting_admin reasons (a
// rule question, a one-time authorization request) are still allowed but flagged
// so the route/UI can warn: accepting those as "pending live verification" may not
// be the right resolution.
const INTEGRATION_HALT_REASONS = Object.freeze([
  'integration_gate', 'simulation_disclosure', 'model_halt', 'resolution_ineffective',
]);

// acceptPendingEligibility(cycle) → { ok, reason, warn }.
//   ok:   may this cycle be accepted as pending-operator-verification?
//   warn: eligible, but the block is not obviously an unverifiable-integration one.
export function acceptPendingEligibility(cycle) {
  if (!cycle) return { ok: false, reason: 'No cycle to accept.' };
  if (!ACCEPTABLE_STATUSES.includes(cycle.status)) {
    return { ok: false, reason: `This cycle is "${cycle.status}" — accept-pending only applies to a blocked (awaiting_admin) build.` };
  }
  if (cycle.verification_state === 'pending') {
    return { ok: false, reason: 'This cycle is already pending operator verification.' };
  }
  const hr = String(cycle.halt_reason || '');
  const warn = !INTEGRATION_HALT_REASONS.includes(hr)
    ? `This build is blocked for "${hr || 'an unspecified reason'}", not an unverifiable-integration reason — accept it as pending live verification only if you are attesting the code is real and you will verify it live.`
    : null;
  return { ok: true, reason: null, warn };
}

// buildAcceptPendingChecklist({ gateDecision, subsystems, transport }) → [items].
// Reuse the cycle's recorded integration-gate checklist / soft (unverifiable)
// findings when present; otherwise synthesize a live-verification item per touched
// subsystem so the operator is always handed a concrete check to run. Items match
// the verification checklist shape { item_id, subsystem, description }.
export function buildAcceptPendingChecklist({ gateDecision = null, subsystems = [], transport = 'the declared transport' } = {}) {
  const existing = Array.isArray(gateDecision?.checklist) ? gateDecision.checklist : [];
  if (existing.length) return existing;

  const soft = Array.isArray(gateDecision?.pending_findings) ? gateDecision.pending_findings : [];
  if (soft.length) {
    return soft.map((f, i) => ({
      item_id: `live-${(f.subsystem || f.function || 'integration')}-${i + 1}`,
      subsystem: f.subsystem || null,
      description: `Verify against the live system: ${f.function ? `"${f.function}" ` : ''}reaches the real endpoint over ${transport} and returns real data — record the observed result (status, sample volume), not a checkbox. (Operator-accepted: the fence could not prove this call.)`,
    }));
  }

  const subs = [...new Set((subsystems || []).filter(Boolean))];
  if (subs.length) {
    return subs.map((s, i) => ({
      item_id: `live-${s}-${i + 1}`,
      subsystem: s,
      description: `Verify the "${s}" external integration against the live system over ${transport} — perform the real connection/handshake and record the observed result, not a checkbox.`,
    }));
  }

  return [{
    item_id: 'live-integration-1',
    subsystem: null,
    description: `Verify the external integration against the live system — perform the real connection/handshake with production network and credentials, and record the observed result (status, sample volume), not a checkbox.`,
  }];
}

// Normalize a required operator attestation. Empty/blank is rejected — accepting a
// block as pending is a signed act, not a silent bypass.
export function normalizeAttestation(text) {
  const t = String(text || '').trim();
  if (!t) return { ok: false, error: 'An attestation is required — state that the integration code is real and that you will verify it live.' };
  if (t.length > 2000) return { ok: true, text: t.slice(0, 2000) };
  return { ok: true, text: t };
}

export const ACCEPT_PENDING_INTEGRATION_HALT_REASONS = INTEGRATION_HALT_REASONS;
