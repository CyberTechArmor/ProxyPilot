import { SUBMIT } from './operational-run-policy.js';
import { FIXTURE_MODES } from './operational-recovery-schema.js';

// A7 practice and recovery: what a person must decide after a run, and the
// rule-based critique. Everything here reads durable typed state only (steps,
// claims, model calls, approvals, events, results, reconciliations, takeovers):
// never a page, a prompt, a value, a frame or model text.

// The two browser actions whose effect is outside the browser (a sign-in POST
// and a sign-out POST). An uncertain one gates the profile's next Start until a
// person has said whether it happened (user decision 3, 2026-09-29).
export const WRITE_ACTIONS = Object.freeze(['submit_bound_fixture', 'sign_out']);
export const DECISIONS = Object.freeze(['happened', 'did_not_happen', 'unknown']);
// Result classes whose help request a person closes with "acknowledged" when no
// uncertain step or model call is attached to them.
export const ACKNOWLEDGE_CLASSES = Object.freeze(['challenge_required', 'interrupted', 'taken_over',
  'uncertain_step', 'model_uncertain', 'timeout']);
// Practice: the result each demo fixture mode should produce.
export const EXPECTED_RESULT = Object.freeze({
  normal: 'verified_account', expired: 'credential_rejected', locked: 'rate_limited',
  challenge: 'challenge_required', redirect: 'unexpected_origin', slow: 'timeout',
});
export { FIXTURE_MODES };

// The subjects of a run that a person may have to decide: every uncertain step
// (a write or a read), every uncertain model call, and a submit that timed out
// (the site may have signed in even though the browser saw no answer, user
// decision 6). A needs-human result with none of these is one `run` subject.
export function uncertainSubjects({ steps, model_calls: calls, result }) {
  const out = [];
  for (const s of steps) {
    const timedOut = s.action === SUBMIT && s.state === 'done' && s.claims?.outcome === 'timeout';
    if (s.state !== 'uncertain' && !timedOut) continue;
    out.push({ subject: `step:${s.ordinal}`, kind: WRITE_ACTIONS.includes(s.action) ? 'write' : 'read',
      action: s.action, ordinal: s.ordinal, reason: timedOut ? 'timeout' : (s.error_code ?? 'uncertain') });
  }
  for (const c of calls) if (c.state === 'uncertain')
    out.push({ subject: `call:${c.call_id}`, kind: 'model_call', call_id: c.call_id, reason: c.refusal_code ?? 'uncertain' });
  if (!out.length && result?.needs_human && ACKNOWLEDGE_CLASSES.includes(result.result_class))
    out.push({ subject: 'run', kind: 'run', reason: result.result_class });
  return out;
}

// Each subject with its latest decision. A write is open until someone says it
// happened or did not; "unknown" keeps it open (and the profile gated).
export function reconciliationState(subjects, decisions) {
  const latest = new Map();
  for (const d of decisions) {
    const prev = latest.get(d.subject);
    if (!prev || String(d.decided_at) >= String(prev.decided_at)) latest.set(d.subject, d);
  }
  const items = subjects.map(s => {
    const d = latest.get(s.subject) ?? null;
    const decided = !!d && d.decision !== 'unknown';
    return { ...s, decision: d ? { decision: d.decision, decided_by: d.decided_by, decided_at: d.decided_at } : null,
      open: !decided, gates: s.kind === 'write' && !decided };
  });
  return { items, open: items.some(i => i.open), gating: items.filter(i => i.gates) };
}

// Durable reads, shared by the coordinator (the Start gate) and the service.
export function runSubjects(db, runId) {
  const steps = db.prepare(`SELECT ordinal,action,state,claims_json,error_code FROM ops_agent_run_steps
    WHERE run_id=? ORDER BY ordinal`).all(runId).map(({ claims_json, ...s }) => ({ ...s, claims: JSON.parse(claims_json) }));
  const calls = db.prepare(`SELECT call_id,state,refusal_code FROM ops_agent_model_calls WHERE run_id=?
    ORDER BY created_at,call_id`).all(runId);
  const r = db.prepare('SELECT result_class,needs_human FROM ops_agent_run_results WHERE run_id=?').get(runId);
  const result = r ? { result_class: r.result_class, needs_human: r.needs_human === 1 } : null;
  const decisions = db.prepare(`SELECT subject,decision,decided_by,decided_at FROM ops_agent_reconciliations
    WHERE run_id=? ORDER BY decided_at,id`).all(runId);
  return reconciliationState(uncertainSubjects({ steps, model_calls: calls, result }), decisions);
}

// The first finished run of this profile that still has an undecided (or
// "unknown") uncertain write; null when the profile may start.
export function profileGate(db, profileId) {
  const runs = db.prepare(`SELECT r.id FROM ops_agent_runs r JOIN ops_agent_run_results res ON res.run_id=r.id
    WHERE r.profile_id=? ORDER BY r.started_at DESC, r.id DESC LIMIT 200`).all(profileId);
  for (const { id } of runs) {
    const state = runSubjects(db, id);
    if (state.gating.length) return { run_id: id, subjects: state.gating.map(i => i.subject) };
  }
  return null;
}

const seconds = (a, b) => (a && b ? Math.max(0, Math.round((Date.parse(b) - Date.parse(a)) / 100) / 10) : null);

// The basic critique (decision 5, rule-based): a short typed list of what went
// well, what went wrong and what a person should check. Codes and numbers
// only; the UI turns each code into words.
export function critique({ run, steps, model_calls: calls, approvals, result, origin = null, takeovers = [],
  reconciliation = null }) {
  const good = [], bad = [], check = [];
  const add = (list, code, extra = {}) => list.push({ code, ...extra });
  if (!result) return { final: false, good, bad, check: [{ code: 'still_running', state: run.state }] };
  if (result.verified_account) add(good, 'verified_account');
  else add(bad, 'result', { result_class: result.result_class, final_state: result.final_state });
  const byRule = steps.filter(s => s.decided_by === 'rule').length;
  if (steps.length) add(good, 'rule_steps', { rule_steps: byRule, steps: steps.length });
  const used = approvals.filter(a => a.state === 'consumed').length;
  if (used) add(good, 'approval_used', { count: used });
  for (const a of approvals.filter(x => ['stale', 'expired'].includes(x.state)))
    add(bad, a.state === 'expired' ? 'approval_expired' : 'approval_stale', { stale_reason: a.stale_reason ?? null });
  for (const s of steps.filter(x => x.state === 'failed'))
    add(bad, 'step_failed', { ordinal: s.ordinal, action: s.action, error_code: s.error_code ?? null });
  const uncertain = steps.filter(s => s.state === 'uncertain').length;
  if (uncertain) add(bad, 'uncertain_steps', { count: uncertain });
  else if (steps.length) add(good, 'no_uncertain_steps');
  for (const c of calls.filter(x => x.state === 'refused' || x.state === 'uncertain'))
    add(bad, c.state === 'uncertain' ? 'model_call_uncertain' : 'model_call_refused', { refusal_code: c.refusal_code ?? null });
  const slow = steps.filter(s => (seconds(s.created_at, s.finished_at) ?? 0) >= 8);
  for (const s of slow) add(check, 'slow_step', { ordinal: s.ordinal, action: s.action, seconds: seconds(s.created_at, s.finished_at) });
  if (calls.length) add(check, 'model_cost', { calls: calls.length,
    tokens: calls.reduce((n, c) => n + (c.prompt_tokens ?? 0) + (c.completion_tokens ?? 0), 0),
    usd: calls.map(c => c.settled_usd).filter(Boolean) });
  if (result.logout === 'done') add(good, 'signed_out');
  else if (result.logout === 'failed') add(bad, 'sign_out_failed');
  if (result.receipt?.verified) add(good, 'receipt_verified');
  for (const t of takeovers) add(check, 'takeover', { user: t.user ?? null, seconds: seconds(t.started_at, t.ended_at),
    inputs: t.inputs ?? {} });
  if (origin?.practice) {
    const expected = EXPECTED_RESULT[origin.fixture_mode] ?? null;
    add(expected === result.result_class ? good : bad, expected === result.result_class ? 'practice_matched' : 'practice_mismatch',
      { fixture_mode: origin.fixture_mode, expected, actual: result.result_class });
  }
  if (origin?.resumed_from_run_id) add(check, 'resumed_from', { run_id: origin.resumed_from_run_id });
  if (reconciliation?.gating?.length) add(check, 'reconcile_writes', { subjects: reconciliation.gating.map(i => i.subject) });
  else if (reconciliation?.open) add(check, 'reconcile_open', { subjects: reconciliation.items.filter(i => i.open).map(i => i.subject) });
  return { final: true, good, bad, check };
}
