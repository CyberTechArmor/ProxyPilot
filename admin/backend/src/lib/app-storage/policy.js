// Per-application retention policies: the document, its validation, the
// defaults (new targets / existing targets / Nodus's preserved settings), the
// effective release and snapshot retention the existing mechanisms read, and
// two pure views over a check result: what each rule would do now
// (policyEffects) and what an automatic run would select (policySelection).
//
// A stored policy is authoritative: a rule turned off runs nothing. The
// static JSON files (mcp-policy/application-release-retention.json and
// snapshot-retention.json) only seed Nodus's defaults; they apply on their own
// only when no stored policy exists for that target, or when mock2.db cannot
// be read (fail-safe: then the old fixed settings hold). A proposed rule (an
// existing target's default) never appears in effective retention.
//
// Defaults: a registered application always starts with proposals — however
// recently it was registered, registering adopts an application that already
// has data. Only a Dev Studio project that ProxyPilot created after this
// feature was installed starts with every rule on. Nodus keeps its settings.

import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { createStorageStore, readInstalledAt } from './store.js';
import { listTargets, AppStorageError } from './targets.js';
import { applicationGuestName } from '../setup-engine/application-deploy-logic.js';
import { formatBytes } from './accounting.js';

export const POLICY_VERSION = 1;
export const RULE_KEYS = Object.freeze(['releases', 'snapshots', 'workspaces', 'caches', 'tempFiles', 'testArtifacts', 'logs', 'history']);
export const RULES = Object.freeze({
  releases: { categories: ['releases'], label: 'Old releases', description: 'Keep the running release and the newest older ones; remove the rest after each validation.' },
  snapshots: { categories: ['snapshots'], label: 'Snapshots', description: 'Keep the newest snapshots (restore points) of this container and delete older ones.' },
  workspaces: { categories: ['workspaces', 'archives'], label: 'Build workspaces', description: 'Remove build workspaces and transfer archives left behind by builds that have ended.' },
  caches: { categories: ['caches'], label: 'Caches', description: 'Remove downloaded caches that have not changed for a while; they are fetched again when needed.' },
  tempFiles: { categories: ['temp'], label: 'Temporary files', description: 'Remove temporary files nothing is using that have not changed for a while.' },
  testArtifacts: { categories: ['test_reports'], label: 'Test reports', description: 'Remove old test output that is not part of the source.' },
  logs: { categories: ['logs'], label: 'Logs', description: 'Remove old rotated logs and keep the system journal within its limit.' },
  history: { categories: ['history'], label: 'Execution history', description: 'Remove old copies of settings files and database dumps taken before changes, keeping the newest.' },
});
export const POLICY_SOURCES = Object.freeze(['defaults-new', 'defaults-existing', 'preserved', 'edited']);

/** What `trimBeforeSeal` may name: generated output only, relative to the release. */
export const TRIM_BEFORE_SEAL_ALLOWED = Object.freeze(['.cache', 'node_modules/.cache', 'test-results', 'playwright-report', 'coverage', '.nyc_output']);
export const NEW_TRIM_BEFORE_SEAL = TRIM_BEFORE_SEAL_ALLOWED;
export const DEFAULT_WARN_BYTES = 20e9;
export const PRESERVED_WARN_BYTES = 10e9;
export const DEFAULT_GROWTH_BYTES = 2e9;

function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); for (const v of Object.values(o)) deepFreeze(v); }
  return o;
}
const clone = (o) => JSON.parse(JSON.stringify(o));

export const DEFAULT_POLICY = deepFreeze({
  version: POLICY_VERSION,
  rules: {
    releases: { enabled: true, keepReleases: 2, trimBeforeSeal: ['.cache'] },
    snapshots: { enabled: true, keep: 3 },
    workspaces: { enabled: true, abandonedAfterHours: 1 },
    caches: { enabled: true, maxAgeDays: 14 },
    tempFiles: { enabled: true, maxAgeDays: 2 },
    testArtifacts: { enabled: true, maxAgeDays: 14 },
    logs: { enabled: true, rotatedMaxAgeDays: 14, journalMaxMB: 256 },
    history: { enabled: true, keepNewest: 2, maxAgeDays: 30 },
  },
  alerts: { enabled: true, warnBytes: DEFAULT_WARN_BYTES, growthBytes: DEFAULT_GROWTH_BYTES, growthWindowHours: 24 },
});

const int = (min, max) => z.number().int().min(min).max(max);
const rule = (shape) => z.object({ enabled: z.boolean(), ...shape }).strict();
const PolicySchema = z.object({
  version: z.literal(POLICY_VERSION),
  rules: z.object({
    releases: rule({ keepReleases: int(2, 20), trimBeforeSeal: z.array(z.enum(TRIM_BEFORE_SEAL_ALLOWED)).max(TRIM_BEFORE_SEAL_ALLOWED.length).refine((a) => new Set(a).size === a.length, 'trimBeforeSeal lists an entry twice') }),
    snapshots: rule({ keep: int(1, 1000) }),
    workspaces: rule({ abandonedAfterHours: int(1, 720) }),
    caches: rule({ maxAgeDays: int(1, 3650) }),
    tempFiles: rule({ maxAgeDays: int(1, 3650) }),
    testArtifacts: rule({ maxAgeDays: int(1, 3650) }),
    logs: rule({ rotatedMaxAgeDays: int(1, 3650), journalMaxMB: int(16, 65536) }),
    history: rule({ keepNewest: int(1, 100), maxAgeDays: int(1, 3650) }),
  }).strict(),
  alerts: z.object({ enabled: z.boolean(), warnBytes: int(1e8, 1e15), growthBytes: int(1e7, 1e15), growthWindowHours: int(1, 720) }).strict(),
}).strict();

/** A complete, valid policy document (normalized copy) or an INVALID_POLICY error naming the fields. */
export function validatePolicy(input) {
  const r = PolicySchema.safeParse(input);
  if (!r.success) {
    const issues = r.error.issues.slice(0, 10).map((i) => ({ path: i.path.join('.'), message: i.message }));
    throw new AppStorageError('INVALID_POLICY', `The retention policy is not valid: ${issues.map((i) => `${i.path || 'policy'} ${i.message}`).join('; ')}.`, 400, { issues });
  }
  return clone(r.data);
}

function readJson(file, key) {
  try { return Object.freeze({ ...(JSON.parse(readFileSync(new URL(`../mcp-policy/${file}`, import.meta.url), 'utf8'))?.[key] || {}) }); } catch { return Object.freeze({}); }
}
/** The static release retention, keyed by application targetId ({ nodus: { keepReleases, trimBuildCache } }). */
export const STATIC_RELEASE_RETENTION = readJson('application-release-retention.json', 'targets');
/** The static snapshot retention, keyed by guest name ({ 'pp-nodus': 3 }). */
export const STATIC_SNAPSHOT_RETENTION = readJson('snapshot-retention.json', 'guests');

/** A static release entry in policy terms. */
export function staticReleaseRule(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const keep = Number(entry.keepReleases);
  const trim = Array.isArray(entry.trimBeforeSeal) ? entry.trimBeforeSeal.filter((x) => TRIM_BEFORE_SEAL_ALLOWED.includes(x)) : entry.trimBuildCache ? ['.cache'] : [];
  return { keepReleases: Number.isInteger(keep) && keep >= 2 && keep <= 20 ? keep : DEFAULT_POLICY.rules.releases.keepReleases, trimBeforeSeal: trim };
}

function timeOf(value) {
  if (value == null || value === '') return null;
  const s = String(value);
  const t = Date.parse(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(\.\d+)?$/.test(s) ? `${s.replace(' ', 'T')}Z` : s);
  return Number.isFinite(t) ? t : null;
}

/** Is the target newer than this feature (created after migration 560 ran)? Unknown → no. */
export function isNewTarget(target, installedAt) {
  const created = timeOf(target?.createdAt ?? target?.importedAt);
  const installed = timeOf(installedAt);
  return created != null && installed != null && created > installed;
}

/**
 * The defaults for a target: { policy, source }.
 * - listed in a static retention file → 'preserved' (today's behaviour kept,
 *   alerts around 10 GB);
 * - a Dev Studio project created after the feature was installed →
 *   'defaults-new', every rule on;
 * - otherwise, including EVERY registered application → 'defaults-existing',
 *   every destructive rule proposed (off).
 */
export function defaultPolicyFor(target, { installedAt = null, staticReleaseRetention = STATIC_RELEASE_RETENTION, staticSnapshotRetention = STATIC_SNAPSHOT_RETENTION, diskLimitBytes = null } = {}) {
  const policy = clone(DEFAULT_POLICY);
  const warn = Number.isFinite(diskLimitBytes) && diskLimitBytes > 0 ? Math.max(1e8, Math.round(diskLimitBytes * 0.8)) : DEFAULT_WARN_BYTES;
  policy.alerts.warnBytes = warn;
  const releaseEntry = target?.kind === 'application' && target.targetId && Object.hasOwn(staticReleaseRetention || {}, target.targetId) ? staticReleaseRule(staticReleaseRetention[target.targetId]) : null;
  const snapshotKeep = target?.guest && Object.hasOwn(staticSnapshotRetention || {}, target.guest) ? Number(staticSnapshotRetention[target.guest]) : null;
  if (releaseEntry || snapshotKeep != null) {
    for (const key of RULE_KEYS) policy.rules[key].enabled = false;
    if (releaseEntry) {
      policy.rules.releases = { enabled: true, ...releaseEntry };
      policy.rules.workspaces.enabled = true;
    }
    if (snapshotKeep != null && Number.isInteger(snapshotKeep) && snapshotKeep >= 1 && snapshotKeep <= 1000) policy.rules.snapshots = { enabled: true, keep: snapshotKeep };
    policy.alerts = { enabled: true, warnBytes: PRESERVED_WARN_BYTES, growthBytes: DEFAULT_GROWTH_BYTES, growthWindowHours: 24 };
    return { policy, source: 'preserved' };
  }
  if (target?.kind === 'project' && isNewTarget(target, installedAt)) {
    policy.rules.releases.trimBeforeSeal = [...NEW_TRIM_BEFORE_SEAL];
    return { policy, source: 'defaults-new' };
  }
  for (const key of RULE_KEYS) policy.rules[key].enabled = false;
  return { policy, source: 'defaults-existing' };
}

/**
 * The policy in force for a target: the stored row when there is a valid one,
 * else its defaults (not stored). → { policy, source, revision, stored,
 * defaults, updatedAt, updatedBy, invalidStored? }
 */
export function resolvePolicy(target, { store, installedAt = null, diskLimitBytes = null, staticReleaseRetention = STATIC_RELEASE_RETENTION, staticSnapshotRetention = STATIC_SNAPSHOT_RETENTION } = {}) {
  const defaults = defaultPolicyFor(target, { installedAt, staticReleaseRetention, staticSnapshotRetention, diskLimitBytes });
  let row = null;
  try { row = store ? store.getPolicy(target.key) : null; } catch { row = null; }
  if (row) {
    try {
      return { policy: validatePolicy(row.policy), source: row.source, revision: row.revision, stored: true, defaults, updatedAt: row.updatedAt, updatedBy: row.updatedBy, proposedRules: row.proposedRules ?? null };
    } catch {
      return { policy: defaults.policy, source: defaults.source, revision: row.revision, stored: true, invalidStored: true, defaults, updatedAt: row.updatedAt, updatedBy: row.updatedBy };
    }
  }
  return { policy: defaults.policy, source: defaults.source, revision: 0, stored: false, defaults, updatedAt: null, updatedBy: null };
}

/**
 * Rules on, and rules that are a proposal (off by default, nothing runs until
 * turned on). A stored policy carries its own list (`stored`): a proposal
 * stays one until that rule is turned on, whatever else is edited.
 */
export function ruleStates(policy, source, stored = null) {
  const enabledRules = RULE_KEYS.filter((k) => policy?.rules?.[k]?.enabled);
  const base = Array.isArray(stored) ? stored : ['defaults-existing', 'preserved'].includes(source) ? RULE_KEYS : [];
  const proposedRules = RULE_KEYS.filter((k) => base.includes(k) && !policy?.rules?.[k]?.enabled);
  return { enabledRules, proposedRules };
}

/** The proposals left after an edit: those still off (turning a rule on ends its proposal). */
export function proposedAfterEdit(previousProposed, nextPolicy) {
  return RULE_KEYS.filter((k) => (previousProposed || []).includes(k) && !nextPolicy?.rules?.[k]?.enabled);
}

/** Flattened changes for the audit: { 'rules.caches.enabled': [false, true], … }. */
export function policyDiff(before, after) {
  const out = {};
  const walk = (a, b, prefix) => {
    const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
    for (const k of keys) {
      const p = prefix ? `${prefix}.${k}` : k;
      const x = a?.[k]; const y = b?.[k];
      if (x && y && typeof x === 'object' && typeof y === 'object' && !Array.isArray(x) && !Array.isArray(y)) walk(x, y, p);
      else if (JSON.stringify(x) !== JSON.stringify(y)) out[p] = [x === undefined ? null : x, y === undefined ? null : y];
    }
  };
  walk(before, after, '');
  return out;
}

// The stored policy row of a target, or null when none exists. Throws when
// mock2.db cannot be read, so the callers below can fall back safely.
function storedPolicyOf(mock2Db, targetKey) {
  const row = createStorageStore(mock2Db).getPolicy(targetKey);
  if (!row) return null;
  try { return { ...row, policy: validatePolicy(row.policy) }; } catch { return { ...row, policy: null, invalid: true }; }
}

// The registered application with this targetId (null when there is none).
// Throws when mock2.db cannot be read.
function applicationTarget(mock2Db, targetId) {
  const row = mock2Db.prepare('SELECT id, target_id, created_at, imported_at FROM mock2_applications WHERE target_id = ?').get(String(targetId));
  if (!row) return null;
  return { key: `application:${row.id}`, kind: 'application', id: Number(row.id), targetId: row.target_id, guest: applicationGuestName(row.target_id), createdAt: row.created_at || null, importedAt: row.imported_at || null };
}

const releaseRetentionOf = (r, source) => ({ keepReleases: r.releases.keepReleases, trimBeforeSeal: [...r.releases.trimBeforeSeal], workspaces: { enabled: !!r.workspaces.enabled, abandonedAfterHours: r.workspaces.abandonedAfterHours }, source });

/**
 * Release retention for application_deploy-op (keyed by profile.targetId).
 * - A stored policy decides: its releases rule on → its numbers; off → null
 *   (nothing runs, whatever the static file says).
 * - No stored policy (or an unreadable one) → the static entry, which is
 *   what Nodus's defaults are seeded from; an unlisted target → null.
 * - mock2.db cannot be read → the static entry (fail-safe).
 * → { keepReleases, trimBeforeSeal, workspaces: { enabled, abandonedAfterHours }, source: 'policy'|'static' } | null
 */
export function effectiveReleaseRetention(targetId, { mock2Db = null, staticRetention = STATIC_RELEASE_RETENTION } = {}) {
  const fallback = Object.hasOwn(staticRetention || {}, targetId) ? staticReleaseRule(staticRetention[targetId]) : null;
  const viaStatic = fallback ? { ...fallback, workspaces: { enabled: true, abandonedAfterHours: DEFAULT_POLICY.rules.workspaces.abandonedAfterHours }, source: 'static' } : null;
  if (!mock2Db) return viaStatic;
  let stored;
  try {
    const target = applicationTarget(mock2Db, targetId);
    stored = target ? storedPolicyOf(mock2Db, target.key) : null;
  } catch { return viaStatic; }
  if (!stored || stored.invalid) return viaStatic;
  return stored.policy.rules.releases.enabled ? releaseRetentionOf(stored.policy.rules, 'policy') : null;
}

/**
 * Snapshot limits for snapshot-retention.js: { <guest>: keep }.
 * - A target with a stored policy: its snapshots rule decides (off = no
 *   limit, so nothing is pruned for it).
 * - A target without one: its defaults (Nodus's preserved 3 from the static
 *   file; a new Dev Studio project's 3; an existing target's proposal = none).
 * - A static entry for a guest that is no target at all still applies.
 * - mock2.db cannot be read → the static file (fail-safe). Never throws.
 */
export function effectiveSnapshotLimits({ mock2Db = null, mainDb = null, staticLimits = STATIC_SNAPSHOT_RETENTION, installedAt = undefined } = {}) { // eslint-disable-line no-unused-vars
  const fallback = () => Object.freeze({ ...(staticLimits || {}) });
  if (!mock2Db) return fallback();
  const limits = {};
  const covered = new Set();
  try {
    const installed = installedAt === undefined ? readInstalledAt(mock2Db) : installedAt;
    for (const target of listTargets({ mock2Db })) {
      covered.add(target.guest);
      const stored = storedPolicyOf(mock2Db, target.key);
      const policy = stored && !stored.invalid ? stored.policy : defaultPolicyFor(target, { installedAt: installed, staticSnapshotRetention: staticLimits }).policy;
      if (policy.rules.snapshots.enabled) limits[target.guest] = policy.rules.snapshots.keep;
    }
  } catch { return fallback(); }
  for (const [guest, keep] of Object.entries(staticLimits || {})) if (!covered.has(guest)) limits[guest] = keep;
  return Object.freeze(limits);
}

/* ------------------------- views over a check ------------------------- */

const DAY = 86_400_000;
const HOUR = 3_600_000;
const SKIP_KINDS = new Set(['snapshot', 'export', 'release', 'pseudo']);

function nowOf(now) { return typeof now === 'function' ? now() : now == null ? Date.now() : Number(now); }

/** Does an eligible item meet `rule`'s own age criterion? (pure) */
function meetsRule(ruleKey, item, ruleCfg, nowMs) {
  const newest = Number(item.newestMtimeMs);
  const olderThan = (ms) => Number.isFinite(newest) && newest <= nowMs - ms;
  switch (ruleKey) {
    case 'workspaces': return olderThan(ruleCfg.abandonedAfterHours * HOUR);
    case 'caches': case 'tempFiles': case 'testArtifacts': return olderThan(ruleCfg.maxAgeDays * DAY);
    case 'logs': return item.kind === 'journal' ? true : olderThan(ruleCfg.rotatedMaxAgeDays * DAY);
    case 'history': return olderThan(ruleCfg.maxAgeDays * DAY) && (item.rank == null || item.rank >= ruleCfg.keepNewest);
    default: return false;
  }
}

function selectForRule(check, ruleKey, ruleCfg, nowMs) {
  const cats = RULES[ruleKey]?.categories || [];
  return (check?.items || []).filter((it) => it.status === 'eligible' && cats.includes(it.category) && !SKIP_KINDS.has(it.kind) && meetsRule(ruleKey, it, ruleCfg, nowMs));
}

const itemBytes = (it) => (it.kind === 'journal' ? Number(it.recoverableBytes || 0) : Number(it.allocatedBytes || 0));

/**
 * What an automatic run of the enabled periodic rules would clean up now:
 * eligible items of those rules' categories that also meet the rule's age.
 * Never snapshots, exports or releases (they have their own mechanisms).
 * → { items: [id], snapshots: [], exports: [], byRule: { rule: { items, bytes } }, count, bytes }
 */
export function policySelection(check, policy, now = Date.now()) {
  const nowMs = nowOf(now);
  const out = { items: [], snapshots: [], exports: [], byRule: {}, count: 0, bytes: 0 };
  if (!check || !policy?.rules) return out;
  const seen = new Set();
  for (const ruleKey of ['workspaces', 'caches', 'tempFiles', 'testArtifacts', 'logs', 'history']) {
    const cfg = policy.rules[ruleKey];
    if (!cfg?.enabled) continue;
    const picked = selectForRule(check, ruleKey, cfg, nowMs).filter((it) => !seen.has(it.id));
    if (!picked.length) continue;
    out.byRule[ruleKey] = { items: picked.map((it) => it.id), bytes: picked.reduce((n, it) => n + itemBytes(it), 0) };
    for (const it of picked) { seen.add(it.id); out.items.push(it.id); out.bytes += itemBytes(it); }
  }
  out.count = out.items.length;
  return out;
}

/** What each rule (on or proposed) would do now, for the policy page. */
export function policyEffects(check, policy, now = Date.now()) {
  const nowMs = nowOf(now);
  return RULE_KEYS.map((ruleKey) => {
    const cfg = policy?.rules?.[ruleKey] || {};
    const base = { rule: ruleKey, label: RULES[ruleKey].label, enabled: !!cfg.enabled, items: 0, bytes: 0, examples: [], note: '' };
    if (!check) return { ...base, note: 'Run a storage check to see what this rule would do.' };
    const items = check.items || [];
    if (ruleKey === 'snapshots') {
      const snaps = items.filter((it) => it.category === 'snapshots').slice().sort((a, b) => String(a.identity?.createdAt || '').localeCompare(String(b.identity?.createdAt || '')));
      const keep = Number(cfg.keep) || 0;
      const excess = Math.max(0, snaps.length - keep);
      const doomed = snaps.slice(0, excess);
      return { ...base, items: excess, bytes: doomed.reduce((n, it) => n + Number(it.allocatedBytes || 0), 0), examples: doomed.slice(0, 3).map((it) => it.label),
        note: excess ? `Would delete the oldest ${excess}, keeping the newest ${keep}.` : `Keeps the newest ${keep}; there is nothing to delete now.` };
    }
    if (ruleKey === 'releases') {
      const rel = items.filter((it) => it.category === 'releases' && it.kind === 'release');
      const counted = items.filter((it) => it.kind === 'release' && (it.sub === 'live' || it.sub === 'rollback')).length;
      const others = rel.filter((it) => it.sub === 'sealed').sort((a, b) => Number(b.identity?.mtimeMs || 0) - Number(a.identity?.mtimeMs || 0));
      const slots = Math.max(0, (Number(cfg.keepReleases) || 0) - counted);
      const doomed = others.slice(slots);
      return { ...base, items: doomed.length, bytes: doomed.reduce((n, it) => n + Number(it.allocatedBytes || 0), 0), examples: doomed.slice(0, 3).map((it) => it.label),
        note: `Keeps the live release, the rollback release and any waiting candidate; would remove ${doomed.length} older release${doomed.length === 1 ? '' : 's'}.` };
    }
    const picked = selectForRule(check, ruleKey, cfg, nowMs);
    const bytes = picked.reduce((n, it) => n + itemBytes(it), 0);
    return { ...base, items: picked.length, bytes, examples: picked.slice(0, 3).map((it) => it.label),
      note: picked.length ? `Would remove ${picked.length} item${picked.length === 1 ? '' : 's'}, about ${formatBytes(bytes)}, now.` : 'Nothing to remove now.' };
  });
}
