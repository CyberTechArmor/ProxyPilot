// DURABLE refusal timestamps for the pre-build guardrails (migration 556).
//
// The symptom-chase cap, the Define-stage rules gate and the duplicate-work
// check each refuse a build with the same promise: "press Build again to
// override". That promise was kept in a per-process Map, and its own comment
// said a restart "just resets the window, which is harmless". It is not
// harmless — it silently removes the escape hatch from a refusal the operator
// is still looking at, and the only symptom is Build refusing a second time
// with no way forward. Project 55 hit exactly that: refusal, press again,
// refused again, with the message still promising the override.
//
// Three ways the in-memory window failed the operator:
//   • a backend restart (update.sh, a PM2 restart, a crash) erased it;
//   • the ten-minute window ran against the clock the OPERATOR is on — the
//     refusal that prompted this was answered by composing a fifteen-line
//     instruction, which took longer than the window;
//   • any other caller could spend it (see refusal-override-logic.js).
//
// Now it is a row. It survives a restart, it is per (project, kind) so
// overriding one guardrail never overrides another, and it is cleared when
// spent — so an override is used once, by the press it was meant for.
//
// Terminology (risk R7): nothing here is named "agent".

import { getMock2Db } from './db.js';

export const REFUSAL_KINDS = Object.freeze(['symptom_cap', 'rule_gate', 'duplicate']);

const nowIso = () => new Date().toISOString();

// recordRefusal — arm the override for this project + guardrail. Best-effort:
// a store failure must never turn a refusal into a crash, and a lost row only
// costs the operator one extra press.
export function recordRefusal(projectId, kind) {
  try {
    getMock2Db().prepare(`
      INSERT INTO mock2_build_refusals (project_id, kind, refused_at)
      VALUES (?, ?, ?)
      ON CONFLICT (project_id, kind) DO UPDATE SET refused_at = excluded.refused_at
    `).run(Number(projectId), String(kind), nowIso());
  } catch (e) {
    console.warn('[mock2] refusal record failed:', e?.message);
  }
}

// refusalAt — epoch ms of the last refusal of this kind, or null. Null on any
// error: no record ⇒ no override ⇒ the guardrail simply holds, which is the
// safe direction.
export function refusalAt(projectId, kind) {
  try {
    const row = getMock2Db()
      .prepare(`SELECT refused_at FROM mock2_build_refusals WHERE project_id = ? AND kind = ?`)
      .get(Number(projectId), String(kind));
    if (!row?.refused_at) return null;
    const ms = Date.parse(row.refused_at);
    return Number.isFinite(ms) ? ms : null;
  } catch (e) {
    console.warn('[mock2] refusal read failed:', e?.message);
    return null;
  }
}

// clearRefusal — the override has been SPENT (or the condition resolved).
// Called on every consumption so one refusal buys exactly one override.
export function clearRefusal(projectId, kind) {
  try {
    getMock2Db()
      .prepare(`DELETE FROM mock2_build_refusals WHERE project_id = ? AND kind = ?`)
      .run(Number(projectId), String(kind));
  } catch (e) {
    console.warn('[mock2] refusal clear failed:', e?.message);
  }
}
