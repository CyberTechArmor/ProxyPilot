// Mock2 operator-verification LIFECYCLE — pure decision layer (B.5).
// Native-free, unit-tested stub-first (risk R9). The AUDIT proved there is no
// state between "gates green → succeeded" and "gate red → not succeeded", so the
// only success terminal demands the fake. This module adds the intermediate
// outcome pending-operator-verification and the evidence/supersession rules.
//
// Terminology (risk R7): nothing here is named "agent".

import { manifestEntryHash } from './integration-logic.js';

export const VERIFICATION_SCHEMA_VERSION = 1;

// The REPORTED cycle outcomes (structured status, distinct from the stored
// mock2_cycles.status). Documented, stable exit-style codes that do NOT collide
// with existing harness conventions (existing statuses have no numeric codes).
export const REPORTED_OUTCOMES = Object.freeze({
  'succeeded': 'all gates green, all in-scope live verifications confirmed (or none in scope)',
  'pending-operator-verification': 'all in-fence gates green; live external verification enumerated and outstanding',
  'blocked-deviation': 'a blocking simulation/intent deviation is unresolved',
  'gate-rejected': 'a deterministic gate (incl. the integration gate) is red',
  'migration-analysis-incomplete': 'legacy analysis could not conclude; findings recorded, non-blocking until touched/reconciled',
});

// Stable status codes for scripting/telemetry (deploy-pending is healthy — see
// deployPendingIsHealthy). Chosen to not collide: 0 = full success; 70+ for the
// new structured states (existing harness uses named statuses, not codes).
export const OUTCOME_CODES = Object.freeze({
  'succeeded': 0,
  'pending-operator-verification': 70,
  'blocked-deviation': 71,
  'gate-rejected': 72,
  'migration-analysis-incomplete': 73,
});

// Deployment while pending is ALLOWED (the operator needs the running app to
// verify) and counts as healthy — the pending state is retained visibly in UI
// and status endpoints; it does not read as generally-available.
export function deployPendingIsHealthy() {
  return true;
}

// reportedCycleOutcome(cycle) — map the stored cycle row to the structured
// outcome. Nonterminal (running/estimating/queued) → null.
export function reportedCycleOutcome(cycle = {}) {
  const status = cycle.status;
  if (status === 'succeeded') return 'succeeded';
  if (cycle.verification_state === 'pending') return 'pending-operator-verification';
  if (status === 'awaiting_admin' && cycle.halt_reason === 'simulation_disclosure') return 'blocked-deviation';
  if (status === 'awaiting_admin' && cycle.halt_reason === 'integration_gate') return 'gate-rejected';
  if (cycle.halt_reason === 'migration_analysis_incomplete') return 'migration-analysis-incomplete';
  if (status === 'failed') return 'gate-rejected';
  if (['awaiting_user', 'awaiting_admin', 'interrupted', 'abandoned', 'refused_quota'].includes(status)) {
    // Blocked/paused terminals that are not one of the specific new outcomes.
    return cycle.verification_state === 'pending' ? 'pending-operator-verification' : null;
  }
  return null; // running / estimating / queued
}

// deriveVerificationChecklist({ manifest, subsystems }) — one checklist item per
// live-verification-required action of each in-scope manifest entry. Each item
// carries the manifest id + content hash so a later manifest change supersedes it.
export function deriveVerificationChecklist({ manifest = { entries: [] }, subsystems = [] } = {}) {
  const items = [];
  for (const entry of manifest.entries || []) {
    if (!entry.live_verification?.required) continue;
    if (subsystems && subsystems.length && !subsystems.includes(entry.subsystem)) continue;
    const hash = manifestEntryHash(entry);
    for (const action of entry.actions || []) {
      items.push({
        schema_version: VERIFICATION_SCHEMA_VERSION,
        item_id: `${entry.id}:${action.name}`,
        manifest_id: entry.id,
        manifest_hash: hash,
        subsystem: entry.subsystem,
        action: action.name,
        operation: action.operation,
        endpoint_classification: entry.egress?.classification || 'unknown',
        description: `Verify against the live system: "${action.name}" (${action.operation}) reaches ${entry.destination?.key || 'the configured destination'} over ${entry.transport} and returns real data — record the observed result (status, sample volume), not a checkbox.`,
      });
    }
  }
  return items;
}

// validateConfirmation(record) — an operator confirmation (or admin waiver) is
// valid only with a real OBSERVED RESULT (never a bare checkbox), an identity, an
// environment, and an endpoint classification. Operators confirm; admins waive.
export function validateConfirmation(record = {}) {
  if (!record || typeof record !== 'object') return { ok: false, error: 'confirmation must be an object' };
  if (!record.item_id || !record.manifest_id || !record.manifest_hash) return { ok: false, error: 'confirmation needs item_id, manifest_id, manifest_hash' };
  if (record.operator_id == null) return { ok: false, error: 'confirmation needs an operator/admin identity' };
  if (!record.environment) return { ok: false, error: 'confirmation needs an environment' };
  if (!record.endpoint_classification) return { ok: false, error: 'confirmation needs an endpoint classification' };
  if (record.waived) {
    if (record.role !== 'admin') return { ok: false, error: 'only an admin may waive a verification item' };
    if (!record.waiver_reason || !String(record.waiver_reason).trim()) return { ok: false, error: 'a waiver needs a recorded reason' };
    return { ok: true, kind: 'waiver' };
  }
  const observed = String(record.observed_result || '').trim();
  if (!observed) return { ok: false, error: 'confirmation needs an observed result — a bare checkbox is invalid' };
  // A checkbox-shaped value ("true"/"ok"/"yes"/"done") is not an observation.
  if (/^(true|false|ok|yes|no|done|pass(ed)?|confirmed|checked?)$/i.test(observed)) {
    return { ok: false, error: 'record what you OBSERVED (status, sample volume, endpoint), not a checkbox-shaped value' };
  }
  return { ok: true, kind: 'confirmation' };
}

// The lifecycle state machine (B.5). verificationTransition({state,event,...}) →
// { ok, next, reason }.
const TRANSITIONS = {
  building: {
    gates_green_with_integrations: 'pending-operator-verification',
    gates_green_no_integrations: 'succeeded',
    simulation_disclosure: 'blocked-deviation',
    gate_red: 'rejected',
  },
  'pending-operator-verification': {
    all_items_confirmed: 'succeeded',
    live_check_failed: 'building',
  },
};

export function verificationTransition({ state, event, integrationGateVerdict = null } = {}) {
  const table = TRANSITIONS[state];
  if (!table || !(event in table)) {
    return { ok: false, reason: `no transition from "${state}" on "${event}"` };
  }
  // INVARIANT: pending-operator-verification is valid ONLY for an implemented
  // real integration that passed the B.4 gate. It must never legitimize a stub.
  if (event === 'gates_green_with_integrations' && integrationGateVerdict === 'fail') {
    return { ok: false, reason: 'the integration gate is red — this is a blocking deviation, not pending verification; pending-operator-verification never legitimizes a failed integration gate' };
  }
  return { ok: true, next: table[event] };
}

// supersessionNeeded({ record, currentManifestHash, now, requested }) — has a
// verified integration's facts changed such that a NEW reverification cycle must
// open and the runtime status downgrade to pending? Never mutates history.
export function supersessionNeeded({ record = {}, currentManifestHash = null, now = null, requested = false } = {}) {
  if (requested) return { needed: true, reason: 'operator-requested reverification' };
  if (currentManifestHash && record.manifest_hash && record.manifest_hash !== currentManifestHash) {
    return { needed: true, reason: 'integration manifest hash changed (endpoint/transport/credentials facts differ)' };
  }
  if (record.expires_at && now) {
    const exp = Date.parse(record.expires_at);
    const nowMs = Date.parse(now);
    if (Number.isFinite(exp) && Number.isFinite(nowMs) && nowMs >= exp) {
      return { needed: true, reason: 'verification expired' };
    }
  }
  return { needed: false, reason: null };
}
