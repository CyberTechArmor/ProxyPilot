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

// ---- integration_gate_mode operator switch (PURE) ----
//
// The operator-facing relief valve for the block → approve → code → same-block
// loop. It mirrors the egress_mode allowlist/allow-all pattern in settings.js:
// a small, auditable dial the admin controls, NOT a silent bypass. The default
// is 'enforce' — a blocking integration-truthfulness decision halts the cycle
// (awaiting an admin), exactly as before. The relaxed modes let an operator get
// a build to COMPLETE and deploy (so the live app can be tested) without gutting
// the gate for everyone:
//   'enforce' — block (unchanged; the safe default).
//   'pending' — a would-be block routes to pending-operator-verification instead:
//               the build deploys and the outstanding LIVE checks are recorded,
//               so the honesty guarantee moves to a named human's live check —
//               it is downgraded, never dropped. (Same end state as clicking
//               "accept as pending" on every block, but automatic.)
//   'monitor' — a would-be block is recorded but never blocks or pends; the cycle
//               proceeds to its normal terminal. Loosest — for "I just need to
//               see it run" — the findings stay on the record, nothing is hidden.
//   'off'     — monitor, PLUS the live-verification hand-off is disabled: the
//               harness never routes a build to pending-operator-verification.
//               Any live-check checklist the gate derives is recorded as skipped
//               (skipped_checklist on the gate record — auditable, never hidden)
//               and the cycle completes as succeeded. For operators who do not
//               want credential-gated live checks in their build loop at all.
export const GATE_MODE_ENFORCE = 'enforce';
export const GATE_MODE_PENDING = 'pending';
export const GATE_MODE_MONITOR = 'monitor';
export const GATE_MODE_OFF = 'off';
export const INTEGRATION_GATE_MODES = Object.freeze([GATE_MODE_ENFORCE, GATE_MODE_PENDING, GATE_MODE_MONITOR, GATE_MODE_OFF]);

// Normalize any stored/env value to a known mode; anything unrecognized (or
// empty/undefined) falls back to the safe default 'enforce'.
export function normalizeGateMode(raw) {
  const v = String(raw ?? '').trim().toLowerCase();
  return INTEGRATION_GATE_MODES.includes(v) ? v : GATE_MODE_ENFORCE;
}

// applyIntegrationGateMode({ decision, mode, subsystems }) → { decision, downgraded,
// mode, wouldBlockReasons }. PURE (no DB/container).
//
// A non-blocking decision, or 'enforce' mode, is returned untouched
// (downgraded:false). In a relaxed mode a BLOCKING decision is converted to a
// non-blocking one, preserving the original block reasons on the returned record
// (would_block_reasons / relaxed_mode) so the gate record and the event log show
// exactly WHAT was relaxed:
//   pending → outcome 'pending-operator-verification' + a synthesized live-check
//             checklist (reusing buildAcceptPendingChecklist), so the runner's
//             existing pending path deploys it and opens the checklist.
//   monitor → outcome 'monitor-recorded', no forced checklist (the cycle then
//             succeeds unless the decision already carried real live checks).
export function applyIntegrationGateMode({ decision, mode, subsystems = [] } = {}) {
  const m = normalizeGateMode(mode);
  if (!decision || !decision.blocking || m === GATE_MODE_ENFORCE) {
    return { decision, downgraded: false, mode: m, wouldBlockReasons: [] };
  }
  const wouldBlockReasons = Array.isArray(decision.reasons) ? decision.reasons.slice() : [];
  const next = {
    ...decision,
    blocking: false,
    relaxed_from_block: true,
    relaxed_mode: m,
    would_block_reasons: wouldBlockReasons,
  };
  if (m === GATE_MODE_PENDING) {
    next.outcome = 'pending-operator-verification';
    next.checklist = buildAcceptPendingChecklist({
      gateDecision: decision,
      subsystems: subsystems.length ? subsystems : (decision.touched_subsystems || []),
    });
  } else {
    // 'monitor' and 'off' both convert the block to a recorded, non-blocking
    // outcome. Leave checklist as whatever the decision already had (empty for
    // a pure block) — neither mode manufactures a pending check; 'off'
    // additionally strips any existing checklist via applyLiveCheckMode below.
    next.outcome = 'monitor-recorded';
  }
  return { decision: next, downgraded: true, mode: m, wouldBlockReasons };
}

// applyLiveCheckMode({ decision, mode }) → { decision, skipped }. PURE.
//
// The 'off' half of GATE_MODE_OFF: with any other mode the decision passes
// through untouched. In 'off' mode a NON-BLOCKING decision that would route the
// cycle to pending-operator-verification (a live-check checklist derived from
// credential-gated integrations, or a pending outcome the builder declared) is
// converted to a plain completion: the checklist moves to skipped_checklist on
// the gate record (recorded and auditable — never silently dropped; nothing
// under `checklist` means downstream code derives no pending items from it) and
// a pending outcome becomes 'succeeded'. A BLOCKING decision is not this
// function's business — run applyIntegrationGateMode first.
export function applyLiveCheckMode({ decision, mode } = {}) {
  const m = normalizeGateMode(mode);
  if (!decision || decision.blocking || m !== GATE_MODE_OFF) {
    return { decision, skipped: [] };
  }
  const skipped = Array.isArray(decision.checklist) ? decision.checklist : [];
  if (!skipped.length && decision.outcome !== 'pending-operator-verification') {
    return { decision, skipped: [] };
  }
  const next = {
    ...decision,
    checklist: [],
    skipped_checklist: [...(Array.isArray(decision.skipped_checklist) ? decision.skipped_checklist : []), ...skipped],
    live_checks_disabled: true,
    outcome: decision.outcome === 'pending-operator-verification' ? 'succeeded' : decision.outcome,
  };
  return { decision: next, skipped };
}
