// Mock2 singleton settings (mock2_settings key/value, in mock2.db). Native
// (better-sqlite3) via getMock2Db — reached only on an enabled host through the
// gated router. M3 uses it for the idle-stop window; later phases add the lock
// idle timeout (ADR-004) and quota buffer through the same table.
//
// The pure decision logic (isIdleStale) lives in project-logic.js so it stays
// unit-testable without this module.
//
// Terminology (risk R7): nothing here is named "agent".

import { getMock2Db } from './db.js';
import { GATE_MODE_ENFORCE, normalizeGateMode } from './accept-pending-logic.js';
import { COMPONENT_AUTO_APPLY_ON, normalizeComponentAutoApply } from './component-logic.js';
import { normalizeLaneTuning, normalizeTuningEntry, normalizeGlobalThinking } from './lane-tuning-logic.js';
import { normalizeStallMinutes, stallThresholdMinutes, restartStallMinutes } from './cycle-logic.js';

const nowIso = () => new Date().toISOString();

export const IDLE_STOP_DAYS_KEY = 'idle_stop_days';
// Default idle window when the operator has not set one. 0 = DISABLED: M3 ships
// idle-stop as opt-in groundwork, so an enabled host does not start stopping
// containers until the operator sets a positive window (M9 adds the timer-driven
// enforcement + derived-status polish). Overridable at deploy time via env.
const DEFAULT_IDLE_STOP_DAYS = 0;

export function getMock2Setting(key, fallback = null) {
  const row = getMock2Db().prepare(`SELECT value FROM mock2_settings WHERE key = ?`).get(key);
  return row ? row.value : fallback;
}

export function setMock2Setting(key, value, updatedBy = null) {
  getMock2Db()
    .prepare(
      `INSERT INTO mock2_settings (key, value, updated_at, updated_by)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    )
    .run(key, String(value), nowIso(), updatedBy);
  return getMock2Setting(key);
}

// ---- Egress policy mode (M4/ADR-010 monitor mode) ----
export const EGRESS_MODE_KEY = 'egress_mode';
export const EGRESS_MODE_ALLOWLIST = 'allowlist';
export const EGRESS_MODE_ALLOW_ALL = 'allow-all';

// The egress policy mode:
//   'allowlist' (default) — each project container may reach ONLY its
//     per-project allowlisted hosts (the ADR-010 containment posture).
//   'allow-all' (monitor) — the proxy permits EVERY destination for the project
//     bridges, but egress is STILL funneled through squid (the bridge fence
//     blocks any bypass), so squid's access log records every host each container
//     reaches. Use it to discover what to allowlist, then switch back to enforce.
// Precedence: stored setting → MOCK2_EGRESS_MODE env → 'allowlist'.
export function getEgressMode() {
  const raw = String(getMock2Setting(EGRESS_MODE_KEY, process.env.MOCK2_EGRESS_MODE || EGRESS_MODE_ALLOWLIST)).trim();
  return raw === EGRESS_MODE_ALLOW_ALL ? EGRESS_MODE_ALLOW_ALL : EGRESS_MODE_ALLOWLIST;
}

// The configured idle-stop window in days. 0 (or an unparseable value) disables
// idle-stop entirely. Precedence: stored setting → MOCK2_IDLE_STOP_DAYS env →
// built-in default.
export function getIdleStopDays() {
  const raw = getMock2Setting(IDLE_STOP_DAYS_KEY, process.env.MOCK2_IDLE_STOP_DAYS || String(DEFAULT_IDLE_STOP_DAYS));
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_IDLE_STOP_DAYS;
  return n;
}

// ---- Concept chat message limit (max characters per chat message) ----
export const CHAT_MAX_CHARS_KEY = 'chat_max_chars';
// The selectable ceilings the operator may choose from. Extended past the old
// 32k bound: with 1M-token context windows a 128k-char message (~32k tokens)
// is comfortably within the concept model's input budget.
export const CHAT_MAX_CHARS_OPTIONS = [4000, 8000, 16000, 32000, 64000, 128000];
const DEFAULT_CHAT_MAX_CHARS = 32000;

// The configured per-message character ceiling for the concept chat composer.
// Only the discrete CHAT_MAX_CHARS_OPTIONS are honoured; any stored/env value
// outside that set falls back to the default. Precedence: stored setting →
// MOCK2_CHAT_MAX_CHARS env → built-in default.
export function getChatMaxChars() {
  const raw = getMock2Setting(CHAT_MAX_CHARS_KEY, process.env.MOCK2_CHAT_MAX_CHARS || String(DEFAULT_CHAT_MAX_CHARS));
  const n = Number(raw);
  return CHAT_MAX_CHARS_OPTIONS.includes(n) ? n : DEFAULT_CHAT_MAX_CHARS;
}

// ---- Integration-gate mode (the block/approve loop relief valve) ----
export const INTEGRATION_GATE_MODE_KEY = 'integration_gate_mode';

// The integration-truthfulness gate mode the runner consults at finish. The
// decision logic + mode meanings live in accept-pending-logic.js (pure); this is
// just the native reader. Precedence: stored setting → MOCK2_INTEGRATION_GATE_MODE
// env → 'enforce' (safe default). Any unknown value normalizes to 'enforce'.
export function getIntegrationGateMode() {
  const raw = getMock2Setting(INTEGRATION_GATE_MODE_KEY, process.env.MOCK2_INTEGRATION_GATE_MODE || GATE_MODE_ENFORCE);
  return normalizeGateMode(raw);
}

// ---- Component auto-apply (every published component, every build) ----
export const COMPONENT_AUTO_APPLY_KEY = 'component_auto_apply';

// Whether the platform confirms EVERY published standard component for every
// build (origin 'auto', installed by the deterministic zero-token pre-install)
// instead of only suggesting on a capability match and waiting for a per-project
// confirm. Returns a boolean. Precedence: stored setting →
// MOCK2_COMPONENT_AUTO_APPLY env → 'on' (reuse is the default — the component
// library exists to be used, not rebuilt from scratch).
export function getComponentAutoApply() {
  const raw = getMock2Setting(COMPONENT_AUTO_APPLY_KEY, process.env.MOCK2_COMPONENT_AUTO_APPLY || COMPONENT_AUTO_APPLY_ON);
  return normalizeComponentAutoApply(raw) === COMPONENT_AUTO_APPLY_ON;
}

// ---- Lane tuning (per-lane model / effort / thinking overrides) ----
export const LANE_TUNING_KEY = 'lane_tuning';

// ---- Fast code model (the speed default for quick/MVP + routine tasks) ----
export const FAST_MODEL_KEY = 'fast_code_model';

// '' → the platform default (routing-logic DEFAULT_FAST_MODEL, claude-sonnet-5);
// 'off' → NO fast-model override anywhere (quick/MVP/routine tasks run on the
// build_runner slot model — "I don't want sonnet building"); any other value →
// an explicit model id. Applied by overlaying MOCK2_FAST_MODEL onto the env the
// pure routing decisions read, so their logic stays env-driven and testable.
export function getFastCodeModelSetting() {
  return String(getMock2Setting(FAST_MODEL_KEY, '') || '').trim();
}

export function setFastCodeModelSetting(value, updatedBy = null) {
  setMock2Setting(FAST_MODEL_KEY, String(value || '').trim(), updatedBy);
  return getFastCodeModelSetting();
}

// ---- Quick-lane effort override (dashboard-stored MOCK2_QUICK_EFFORT) ----
// '' = the lane's built-in default (quickRoutingDecision: medium); a stored
// effort level wins over the env var.
export const QUICK_EFFORT_KEY = 'quick_effort';
const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];

export function getQuickEffortSetting() {
  const v = String(getMock2Setting(QUICK_EFFORT_KEY, '') || '').trim().toLowerCase();
  return EFFORT_LEVELS.includes(v) ? v : '';
}

export function setQuickEffortSetting(value, updatedBy = null) {
  const v = String(value || '').trim().toLowerCase();
  setMock2Setting(QUICK_EFFORT_KEY, EFFORT_LEVELS.includes(v) ? v : '', updatedBy);
  return getQuickEffortSetting();
}

// ---- Global escalation model (dashboard-stored MOCK2_ESCALATE_MODEL) ----
// The rung-1 model a failed/halted attempt (or a difficulty-5 task) steps up
// to when the task's routing rule names none. '' = no global escalation.
export const ESCALATE_MODEL_KEY = 'escalate_model';

export function getEscalateModelSetting() {
  return String(getMock2Setting(ESCALATE_MODEL_KEY, '') || '').trim();
}

export function setEscalateModelSetting(value, updatedBy = null) {
  setMock2Setting(ESCALATE_MODEL_KEY, String(value || '').trim(), updatedBy);
  return getEscalateModelSetting();
}

// The env the routing decisions should read: process.env with the stored
// choices overlaid (a stored setting wins over its env var).
export function routingEnv(env = process.env) {
  const out = { ...env };
  const fast = getFastCodeModelSetting();
  if (fast) out.MOCK2_FAST_MODEL = fast;
  const quick = getQuickEffortSetting();
  if (quick) out.MOCK2_QUICK_EFFORT = quick;
  const esc = getEscalateModelSetting();
  if (esc) out.MOCK2_ESCALATE_MODEL = esc;
  return out;
}

// ---- Cost saver (one switch for the cheap-first + escalate-on-failure posture) ----
//
// ON applies the recommended economy routing IN ONE MOVE: the fast code model
// back to its platform default (claude-sonnet-5 for quick/MVP/routine tasks),
// the quick lane at medium effort, and claude-opus-4-8 as the global
// escalation model so any failed cheap attempt automatically re-runs big.
// The operator's PREVIOUS values are snapshotted first, and OFF restores that
// snapshot exactly — "if I turn it off it goes to the last known state", never
// to a hardcoded default.
export const COST_SAVER_KEY = 'cost_saver';
export const COST_SAVER_SNAPSHOT_KEY = 'cost_saver_snapshot';
const COST_SAVER_APPLIED = Object.freeze({
  fast_code_model: '',        // '' = platform default (DEFAULT_FAST_MODEL, sonnet-5)
  quick_effort: 'medium',
  escalate_model: 'claude-opus-4-8',
});

export function getCostSaver() {
  const on = String(getMock2Setting(COST_SAVER_KEY, '') || '').trim().toLowerCase() === 'on';
  let snapshot = null;
  try { snapshot = JSON.parse(getMock2Setting(COST_SAVER_SNAPSHOT_KEY, 'null') || 'null'); } catch { snapshot = null; }
  return {
    setting: on ? 'on' : 'off',
    applies: COST_SAVER_APPLIED,
    snapshot,
    current: {
      fast_code_model: getFastCodeModelSetting(),
      quick_effort: getQuickEffortSetting(),
      escalate_model: getEscalateModelSetting(),
    },
  };
}

export function setCostSaver(value, updatedBy = null) {
  const on = String(value || '').trim().toLowerCase() === 'on';
  const state = getCostSaver();
  if (on && state.setting !== 'on') {
    // Snapshot the operator's values BEFORE applying, so off = last known state.
    setMock2Setting(COST_SAVER_SNAPSHOT_KEY, JSON.stringify(state.current), updatedBy);
    setFastCodeModelSetting(COST_SAVER_APPLIED.fast_code_model, updatedBy);
    setQuickEffortSetting(COST_SAVER_APPLIED.quick_effort, updatedBy);
    setEscalateModelSetting(COST_SAVER_APPLIED.escalate_model, updatedBy);
    setMock2Setting(COST_SAVER_KEY, 'on', updatedBy);
  } else if (!on && state.setting === 'on') {
    const snap = state.snapshot || {};
    setFastCodeModelSetting(snap.fast_code_model ?? '', updatedBy);
    setQuickEffortSetting(snap.quick_effort ?? '', updatedBy);
    setEscalateModelSetting(snap.escalate_model ?? '', updatedBy);
    setMock2Setting(COST_SAVER_SNAPSHOT_KEY, 'null', updatedBy);
    setMock2Setting(COST_SAVER_KEY, 'off', updatedBy);
  }
  return getCostSaver();
}

// ---- browser smoke connector toggle (dashboard-controlled) ----
// '' = follow the env/default (SMOKE_BROWSER_ENABLED, default on),
// 'on'/'off' = the operator's explicit dashboard choice, which WINS over env.
export const SMOKE_BROWSER_KEY = 'smoke_browser';

export function getSmokeBrowserSetting() {
  const v = String(getMock2Setting(SMOKE_BROWSER_KEY, '') || '').trim().toLowerCase();
  return v === 'on' || v === 'off' ? v : '';
}

export function setSmokeBrowserSetting(value, updatedBy = null) {
  const v = String(value || '').trim().toLowerCase();
  setMock2Setting(SMOKE_BROWSER_KEY, v === 'on' || v === 'off' ? v : '', updatedBy);
  return getSmokeBrowserSetting();
}

// The env the smoke gate should read: process.env with the dashboard's browser
// toggle overlaid (an explicit 'on'/'off' wins over SMOKE_BROWSER_ENABLED).
export function smokeEnv(env = process.env) {
  const v = getSmokeBrowserSetting();
  if (!v) return env;
  return { ...env, SMOKE_BROWSER_ENABLED: v === 'on' ? 'true' : '0' };
}

// ---- design review (the after-build "look at the screen" pass) toggle ----
// 'on' (default): every succeeded build request is followed by a screenshot +
// vision critique posted to the chat (findings only — never a gate, never an
// auto-build). 'off' turns the automatic pass off; the manual Polish pass
// button keeps working either way (it is an explicit operator action).
export const DESIGN_REVIEW_KEY = 'design_review';

export function getDesignReviewSetting() {
  const v = String(getMock2Setting(DESIGN_REVIEW_KEY, '') || '').trim().toLowerCase();
  return v === 'off' ? 'off' : 'on';
}

export function setDesignReviewSetting(value, updatedBy = null) {
  const v = String(value || '').trim().toLowerCase();
  setMock2Setting(DESIGN_REVIEW_KEY, v === 'off' ? 'off' : 'on', updatedBy);
  return getDesignReviewSetting();
}

// ---- first-run setup flow ----
//
// 'guided' (DEFAULT): a new project shows the six-step setup panel — your
// admin account, logo, the three "about this app" questions, the design
// prompt, approval. Every step is skippable and skipping all of them
// reproduces 'classic' exactly, so this is a default rather than a decision
// imposed on anyone.
//
// 'classic': the previous behaviour — a new project lands on the project page
// with no panel and no order. Kept because an operator who has done this
// twenty times does not need to be walked through it, and because a setting
// with no honest off-switch is not a setting.
export const SETUP_FLOW_KEY = 'setup_flow';
export const SETUP_FLOW_GUIDED = 'guided';
export const SETUP_FLOW_CLASSIC = 'classic';

export function getSetupFlowSetting() {
  const v = String(getMock2Setting(SETUP_FLOW_KEY, '') || '').trim().toLowerCase();
  return v === SETUP_FLOW_CLASSIC ? SETUP_FLOW_CLASSIC : SETUP_FLOW_GUIDED;
}

export function setSetupFlowSetting(value, updatedBy = null) {
  const v = String(value || '').trim().toLowerCase();
  setMock2Setting(SETUP_FLOW_KEY, v === SETUP_FLOW_CLASSIC ? SETUP_FLOW_CLASSIC : SETUP_FLOW_GUIDED, updatedBy);
  return getSetupFlowSetting();
}

// ---- Automatic framework adoption (ADR-003 amendment) ----
//
// 'on' (DEFAULT): when a new framework version is published, projects that are
// online, design-approved, idle, and have built before get the update cycle
// started automatically (one attempt per project per version) — no operator
// press required. 'off': the previous explicit-consent behaviour — the drift
// banner + manual "Start update cycle" button only.
// Precedence: stored setting → MOCK2_FRAMEWORK_AUTO_ADOPT env → 'on'.
export const FRAMEWORK_AUTO_ADOPT_KEY = 'framework_auto_adopt';

export function getFrameworkAutoAdopt() {
  const raw = String(getMock2Setting(FRAMEWORK_AUTO_ADOPT_KEY, process.env.MOCK2_FRAMEWORK_AUTO_ADOPT || 'on')).trim().toLowerCase();
  return !(raw === 'off' || raw === '0' || raw === 'false');
}

export function setFrameworkAutoAdopt(value, updatedBy = null) {
  const v = String(value || '').trim().toLowerCase();
  setMock2Setting(FRAMEWORK_AUTO_ADOPT_KEY, v === 'off' || v === '0' || v === 'false' ? 'off' : 'on', updatedBy);
  return getFrameworkAutoAdopt();
}

// ---- Stall watchdog thresholds (stuck-build recovery timing) ----
//
// Two dashboard-tunable minute values:
//   restart_minutes (default 10) — silence before the chat offers "Restart
//     build" and the restart route accepts a force-stop (manual recovery);
//   hard_minutes (default 30) — silence before the 60s sweep stops the build
//     on its own (unattended recovery).
// Precedence per value: stored setting → env (MOCK2_RESTART_STALL_MINUTES /
// MOCK2_STALL_MINUTES) → default. hard is clamped to >= restart at read time —
// the automatic kill must never fire before the human was even offered the
// button.
export const STALL_RESTART_MINUTES_KEY = 'stall_restart_minutes';
export const STALL_HARD_MINUTES_KEY = 'stall_hard_minutes';

export function getStallSettings(env = process.env) {
  const restart = normalizeStallMinutes(
    getMock2Setting(STALL_RESTART_MINUTES_KEY, null),
    { fallback: restartStallMinutes(env) },
  );
  let hard = normalizeStallMinutes(
    getMock2Setting(STALL_HARD_MINUTES_KEY, null),
    { fallback: stallThresholdMinutes(env) },
  );
  if (hard < restart) hard = restart;
  return { restart_minutes: restart, hard_minutes: hard };
}

export function setStallSettings({ restart_minutes = null, hard_minutes = null } = {}, updatedBy = null) {
  if (restart_minutes != null) {
    setMock2Setting(STALL_RESTART_MINUTES_KEY, String(normalizeStallMinutes(restart_minutes, { fallback: restartStallMinutes() })), updatedBy);
  }
  if (hard_minutes != null) {
    setMock2Setting(STALL_HARD_MINUTES_KEY, String(normalizeStallMinutes(hard_minutes, { fallback: stallThresholdMinutes() })), updatedBy);
  }
  return getStallSettings();
}

// ---- Global thinking switch (kill thinking everywhere at once) ----
export const GLOBAL_THINKING_KEY = 'global_thinking';

// 'off' disables thinking for EVERY lane, overriding per-lane tuning at read
// time (the stored per-lane doc is untouched, so flipping back restores it).
// Precedence: stored setting → MOCK2_THINKING env → 'default'.
export function getGlobalThinking() {
  return normalizeGlobalThinking(getMock2Setting(GLOBAL_THINKING_KEY, process.env.MOCK2_THINKING || 'default'));
}

export function setGlobalThinking(mode, updatedBy = null) {
  setMock2Setting(GLOBAL_THINKING_KEY, normalizeGlobalThinking(mode), updatedBy);
  return getGlobalThinking();
}

// The operator's thinking settings for one lane: {model, effort, thinking},
// fully normalized (see lane-tuning-logic.js). Applied as the LAST word over
// slots/routing at each lane's model call. The global thinking switch overlays
// the per-lane value, so every model call goes thinking-off when it is 'off'.
export function getLaneTuning(lane) {
  const doc = normalizeLaneTuning(getMock2Setting(LANE_TUNING_KEY, null));
  const entry = doc[lane] || normalizeTuningEntry(null);
  return getGlobalThinking() === 'off' ? { ...entry, thinking: 'off' } : entry;
}

export function getAllLaneTuning() {
  return normalizeLaneTuning(getMock2Setting(LANE_TUNING_KEY, null));
}

export function setLaneTuning(lane, patch, updatedBy = null) {
  const doc = getAllLaneTuning();
  doc[lane] = normalizeTuningEntry({ ...doc[lane], ...patch });
  setMock2Setting(LANE_TUNING_KEY, JSON.stringify(doc), updatedBy);
  return doc;
}
