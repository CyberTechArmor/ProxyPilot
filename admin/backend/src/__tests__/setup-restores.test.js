// A-13 / A-14 / A-15: the project database restore, the container snapshot
// restore and the retry-path secret mint as durable runner jobs. What is
// proved here, and how:
//   * the pure guarantees (restore-logic): recovery-set binding by record,
//     dump format, compatibility from the dump's own rows under real AES-GCM,
//     snapshot coverage, artifact revalidation;
//   * the operations through the real executor over scripted guest / host
//     executors (setup-engine store on node:sqlite): the order of steps, the
//     refusals before any disruption, protected copies, reuse on retry,
//     interruption before and after the disruptive step, conflicting
//     operations, runner-required, follow-up verification, no secret in any
//     row or event;
//   * the actual callers: the MCP tools (fake ctx, real store, real executor)
//     with the confirmation token bound to the exact plan, and the runner's
//     host channel with a real process.

import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { ensureSetupEngineSchema, getJob, listEvents, readLock, acquireLock, createJob, claimNextJob, checkpoint, runnerHeartbeat } from '../lib/setup-engine/store.js';
import { ownerIdentity, parseJson, validateRunnerJob, RUNNER_JOB_KINDS, EXCLUSIVE_JOB_KINDS } from '../lib/setup-engine/logic.js';
import { runOnce, reconcile } from '../lib/setup-engine/executor.js';
import { submitRunnerJob, resolveRetryOf, runSubmittedJob } from '../lib/setup-engine/orchestrator.js';
import {
  bindRecoverySet, dumpHeaderVerdict, serverCompatible, parseCopyRows, compatibilityVerdict, snapshotCoverage, snapshotPlanVerdict,
  artifactMatches, parseProtect, inspectScript, parseInspect, protectScript, restoreScript, verifyArtifactScript, DUMP_NAME_RE,
} from '../lib/setup-engine/restore-logic.js';
import { masterKeyFor } from '../mock2/auth-data-logic.js';
import { configureContainerLockStore } from '../mock2/container-lock.js';
import { restoreProjectDb, restoreSnapshot, retryProjectSecrets, planDigest, resolveRestoreDbPlan } from '../mock2/ops.js';
import { createExtendedHandlers } from '../routes/mcp-tools/index.js';
import { createConfirmationStore } from '../lib/mcp-ext/logic.js';
import { lxcContainerDetail, MCP_TOOLS } from '../lib/mcp-logic.js';
import { hostGuestExec } from '../../../../cli/src/commands/setup-runner.js';
import { scriptedGuest, unwrapContained, isContained, PARAMS, LOGIN, GUARD } from './helpers/scripted-guest.js';

const T0 = Date.parse('2026-09-22T09:00:00.000Z');
const RUNNER = ownerIdentity({ kind: 'runner', host: 'pp', pid: 300, instance: 'rrrr' });
const BACKEND = ownerIdentity({ kind: 'backend', host: 'pp', pid: 100, instance: 'aaaa' });
const DEAD = ownerIdentity({ kind: 'runner', host: 'pp', pid: 999, instance: 'dead' });
const KEY = 'master-key-value-3f9a1c';         // the current AUTH_MASTER_SECRET
const OLD_KEY = 'older-master-key-value-77b2';  // the key of a previous deploy
const OTHER_KEY = 'unrelated-key-value-e1d0';
const DUMPS = '/var/backups/proxypilot-db';

function db() { const d = new DatabaseSync(':memory:'); ensureSetupEngineSchema(d); return d; }
const sha = (s) => createHash('sha256').update(s).digest('hex');
const b64 = (s) => Buffer.from(String(s), 'utf8').toString('base64');

function encryptUnderMaster(plain, master) {
  const nonce = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', masterKeyFor(master), nonce);
  const data = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return { ciphertext: Buffer.concat([data, c.getAuthTag()]).toString('base64'), nonce: nonce.toString('base64') };
}
function dumpText({ rows = [], from = '16.3', table = 'auth_connections' } = {}) {
  const head = `--\n-- PostgreSQL database dump\n--\n\n-- Dumped from database version ${from}\n-- Dumped by pg_dump version ${from}\n\nSET statement_timeout = 0;\n`;
  const copy = rows.length || table
    ? `\nCOPY public.${table} (id, provider, secret_ciphertext, secret_nonce, name) FROM stdin;\n${rows.map((r, i) => `${i + 1}\tldaps\t${r.ciphertext}\t${r.nonce}\tdc-${i}`).join('\n')}${rows.length ? '\n' : ''}\\.\n`
    : '';
  return `${head}${copy}`;
}
const copyBlockOf = (text) => text.slice(text.indexOf('COPY public.'));

// The scripted guest for the restore and mint scripts; everything else is
// the shared scripted guest (probes, the application-owned check).
function restoreGuest(state) {
  const base = scriptedGuest(state);
  const calls = base.calls;
  state.envText = state.envText ?? `AUTH_JWT_SECRET=x\nAUTH_MASTER_SECRET=${KEY}\n`;
  return {
    calls,
    guest: async (container, raw) => {
      const s = unwrapContained(raw);
      const rec = (phase) => calls.push({ container, phase, raw, script: s, contained: isContained(raw) });
      if (/echo "DUMP:\$\(/.test(s)) {
        rec('inspect');
        const d = state.dumps?.[state.selected] || null;
        const out = [];
        if (!d) out.push('DUMP:none');
        else { out.push(`DUMP:${Buffer.byteLength(d.text)}:${sha(d.text)}`, `HEAD:${b64(d.text.slice(0, 600))}`); }
        out.push(`SERVER:${state.server ?? '16.3'}`, `UNIT_ACTIVE:${state.active === false ? 'inactive' : 'active'}`);
        if (d && /COPY:\$blk/.test(s)) { const i = d.text.indexOf('COPY public.'); out.push(i >= 0 ? `COPY:${b64(d.text.slice(i, d.text.indexOf('\\.', i) + 2))}` : 'COPY:none'); }
        if (/KEY_CURRENT/.test(s)) { const m = state.envText.match(/^AUTH_MASTER_SECRET=(.*)$/m); out.push(m ? `KEY_CURRENT:${b64(m[1])}` : 'KEY_CURRENT:none'); }
        if (/ENVCOPY:/.test(s)) { const c = state.envCopies?.[state.envCopySelected] || null; out.push(c ? 'ENVCOPY:present' : 'ENVCOPY:missing'); if (c && /KEY_COPY/.test(s)) { const m = c.match(/^AUTH_MASTER_SECRET=(.*)$/m); out.push(m ? `KEY_COPY:${b64(m[1])}` : 'KEY_COPY:none'); } }
        return { code: 0, stdout: `${out.join('\n')}\n` };
      }
      if (/PRE_DUMP:/.test(s)) {
        rec('protect');
        const id = (s.match(/app-pre-restore-([A-Za-z0-9-]+)\.sql/) || [])[1];
        if (state.protectFails) return { code: 0, stdout: 'PRE_DUMP:none:pg_dump failed or wrote no dump\nPRE_ENV:/etc/environment.pre-restore-' + id + '\n' };
        const text = `--\n-- PostgreSQL database dump\n--\n-- pre-restore ${id}\n`;
        state.artifacts = { ...(state.artifacts || {}), [`${DUMPS}/app-pre-restore-${id}.sql`]: { bytes: Buffer.byteLength(text), sha256: sha(text) } };
        return { code: 0, stdout: `PRE_DUMP:${DUMPS}/app-pre-restore-${id}.sql:${Buffer.byteLength(text)}:${sha(text)}\nPRE_ENV:/etc/environment.pre-restore-${id}\n` };
      }
      if (/ARTIFACT:/.test(s)) {
        rec('verify_artifact');
        const path = (s.match(/^p='([^']+)'/m) || [])[1];
        const a = state.artifacts?.[path];
        return { code: 0, stdout: a ? `ARTIFACT:${path}:${a.bytes}:${a.sha256}\n` : `ARTIFACT:${path}:missing\n` };
      }
      if (/RESTORE_RC:/.test(s)) { rec('restore'); state.restoredFrom = (s.match(/^F='([^']+)'/m) || [])[1]; return { code: 0, stdout: state.restoreOut ?? 'RESTORE_RC:0\nERRORS:2\nERR:psql:/tmp/pp-restore.sql:12: ERROR:  role "x" does not exist\nERR:ERROR:  relation "old" does not exist\n' }; }
      if (/ENV_SWAPPED/.test(s)) { rec('env_swap'); state.envSwappedFrom = (s.match(/cp -p '([^']+)'/) || [])[1]; state.envText = state.envCopies[state.envCopySelected]; return { code: 0, stdout: 'ENV_SWAPPED:yes\n' }; }
      if (/systemctl stop mock2-dev\.service/.test(s) && /STOPPED/.test(s)) { rec('stop'); if (state.stopFails) return { code: 0, stdout: 'failed\n' }; state.active = false; return { code: 0, stdout: 'STOPPED\n' }; }
      if (/\\2\/p'/.test(s)) { rec('env_keys'); return { code: 0, stdout: `${state.envText.split('\n').map((l) => (l.match(/^([A-Za-z_][A-Za-z0-9_]*)=/) || [])[1]).filter(Boolean).join('\n')}\n` }; }
      if (/^cat \/etc\/environment/m.test(s)) { rec('env_read'); return { code: 0, stdout: state.envText }; }
      if (/environment\.mock2-tmp/.test(s)) { rec('env_write'); const m = s.match(/printf '%s' '([A-Za-z0-9+/=]+)' \| base64 -d > \/etc\/environment\.mock2-tmp/); if (m) state.envText = Buffer.from(m[1], 'base64').toString('utf8'); return { code: 0, stdout: '' }; }
      return base.guest(container, raw);
    },
  };
}

// The scripted host: `incus …` as argv arrays over state.instance.
function scriptedHost(state) {
  const calls = [];
  return {
    calls,
    host: async (argv) => {
      calls.push(argv);
      assert.ok(Array.isArray(argv) && argv.every((a) => typeof a === 'string'), 'argv arrays only');
      const inst = state.instance;
      if (argv[0] !== 'incus') return { code: 127, stdout: '', stderr: 'not incus' };
      if (argv[1] === 'list') return { code: 0, stdout: JSON.stringify(inst ? [inst] : []), stderr: '' };
      if (argv[1] === 'snapshot' && argv[2] === 'create') {
        if (state.cliForm === 'legacy') return { code: 1, stdout: '', stderr: 'Error: unknown command "create" for "incus snapshot"' };
        inst.snapshots.push({ name: argv[4], created_at: `2026-09-22T09:0${inst.snapshots.length}:00Z` }); return { code: 0, stdout: '', stderr: '' };
      }
      if (argv[1] === 'snapshot' && argv.length === 4 && state.cliForm === 'legacy') { inst.snapshots.push({ name: argv[3], created_at: `2026-09-22T09:0${inst.snapshots.length}:00Z` }); return { code: 0, stdout: '', stderr: '' }; }
      if (argv[1] === 'snapshot' && argv[2] === 'restore') { if (state.restoreFails) return { code: 1, stdout: '', stderr: 'Error: restore failed: zfs busy' }; state.restoredTo = argv[4]; inst.status = state.restoreStops ? 'Stopped' : inst.status; return { code: 0, stdout: '', stderr: '' }; }
      if (argv[1] === 'start') { inst.status = 'Running'; state.started = (state.started || 0) + 1; return { code: 0, stdout: '', stderr: '' }; }
      return { code: 1, stdout: '', stderr: `unexpected ${argv.join(' ')}` };
    },
  };
}
const instanceOf = (over = {}) => ({ name: 'pp-x', status: 'Running', snapshots: [{ name: 'snap-1', created_at: '2026-09-20T10:00:00Z' }], expanded_devices: { root: { type: 'disk', path: '/', pool: 'default' }, eth0: { type: 'nic' } }, ...over });

function noValueIn(d, ids, values) {
  for (const id of ids) {
    const dump = JSON.stringify(getJob(d, id)) + JSON.stringify(listEvents(d, id));
    for (const v of values) assert.equal(dump.includes(v), false, `${v.slice(0, 12)}… leaked into job ${id}`);
  }
}
const exec = (g, h) => ({ guest: g.guest, ...(h ? { host: h.host } : {}) });
const runAll = (d, ex, nowMs, opts = {}) => runOnce({ db: d, owner: RUNNER, exec: ex, reviewLogin: async () => LOGIN, nowMs: () => nowMs }, { reconcileFirst: false, ...opts });
const recordedDeploy = (d, { id = 'deploy-1', app = 'pp-x', dump = `${DUMPS}/app-pre-deploy-deploy-1.sql`, dumpSha = null, envCopy = '/etc/environment.pre-deploy-1' } = {}) => {
  const j = createJob(d, { id, kind: 'deploy', app, plan: { params: PARAMS() }, configRefs: { guard: GUARD }, nowMs: T0 - 100_000 });
  const c = claimNextJob(d, { owner: DEAD, kinds: ['deploy'], nowMs: T0 - 99_000 });
  checkpoint(d, { id: j.id, owner: DEAD, epoch: c.epoch, phase: 'verified', checkpoint: { app_stopped: false, recovery: { protected: { dbDump: { path: dump, bytes: 100, sha256: dumpSha }, envCopy } } }, nowMs: T0 - 98_000 });
  d.prepare(`UPDATE setup_jobs SET status = 'succeeded', owner = NULL WHERE id = ?`).run(j.id);
  return getJob(d, j.id);
};

// ── 1. the pure guarantees ────────────────────────────────────────────────

test('recovery set binding: a file name binds nothing; a job record of THIS app that took the dump and the environment copy together does', () => {
  const d = db();
  const origin = recordedDeploy(d, { dumpSha: 'a'.repeat(64) });
  assert.equal(bindRecoverySet({ app: 'pp-x', dumpName: 'app-x.sql', envCopyName: null }).mode, 'current_configuration');
  assert.match(bindRecoverySet({ app: 'pp-x', dumpName: '../etc/passwd' }).reason, /dump name must match/);
  assert.match(bindRecoverySet({ app: 'pp-x', dumpName: 'app-pre-deploy-deploy-1.sql', envCopyName: 'environment.pre-deploy-1', originJob: null }).reason, /not a recovery set of this app/);
  assert.match(bindRecoverySet({ app: 'pp-y', dumpName: 'app-pre-deploy-deploy-1.sql', envCopyName: 'environment.pre-deploy-1', originJob: origin }).reason, /belongs to pp-x, not pp-y/);
  assert.match(bindRecoverySet({ app: 'pp-x', dumpName: 'app-pre-deploy-deploy-1.sql', envCopyName: 'environment.pre-deploy-2', originJob: origin }).reason, /did not record .* as one recovery set/);
  const ok = bindRecoverySet({ app: 'pp-x', dumpName: 'app-pre-deploy-deploy-1.sql', envCopyName: 'environment.pre-deploy-1', originJob: origin });
  assert.equal(ok.ok, true); assert.equal(ok.mode, 'recovery_set'); assert.equal(ok.expectedSha256, 'a'.repeat(64));
  assert.match(bindRecoverySet({ app: 'pp-x', dumpName: 'app-x.sql', envCopyName: '../../etc/shadow', originJob: origin }).reason, /environment copy name must match/);
});

test('dump format: plain pg_dump only; custom archives and unknown files are refused by name; an older server is refused', () => {
  assert.equal(dumpHeaderVerdict(dumpText()).ok, true);
  assert.equal(dumpHeaderVerdict(dumpText()).dumpedFrom, '16.3');
  assert.equal(dumpHeaderVerdict('PGDMP\x01\x0e').format, 'custom');
  assert.match(dumpHeaderVerdict('PGDMP\x01\x0e').reason, /custom-format/);
  assert.equal(dumpHeaderVerdict('CREATE TABLE x();').format, 'unknown');
  assert.equal(serverCompatible('16.3', '16.4').ok, true);
  assert.equal(serverCompatible('16.3', '17.1').ok, true);
  assert.match(serverCompatible('16.3', '15.6').reason, /does not restore into an older major/);
  assert.equal(serverCompatible(null, '16.3').ok, true);
});

test('compatibility from the dump\'s own rows under real AES-GCM: established under the key in force or a legacy default, NOT established otherwise, not applicable without a guard', () => {
  const rows = [encryptUnderMaster('bind-pw-1', KEY), encryptUnderMaster('bind-pw-2', KEY), encryptUnderMaster('bind-pw-3', GUARD.legacy_default)];
  const text = dumpText({ rows });
  const parsed = parseCopyRows(copyBlockOf(text), { secretColumn: GUARD.secret_column, nonceColumn: GUARD.nonce_column });
  assert.equal(parsed.found, true); assert.equal(parsed.rows.length, 3);
  const ok = compatibilityVerdict({ guard: GUARD, rows: parsed.rows, key: KEY, legacy: [GUARD.legacy_default] });
  assert.equal(ok.established, true); assert.deepEqual(ok.classification, { total: 3, current: 2, legacy: 1, unknown: 0 });
  const bad = compatibilityVerdict({ guard: GUARD, rows: parsed.rows, key: OTHER_KEY, legacy: [GUARD.legacy_default] });
  assert.equal(bad.established, false); assert.equal(bad.classification.unknown, 2); assert.match(bad.detail, /would be unusable/);
  assert.equal(compatibilityVerdict({ guard: GUARD, rows: parsed.rows, key: null }).established, false);
  assert.equal(compatibilityVerdict({ guard: null, rows: [] }).established, true);
  assert.equal(compatibilityVerdict({ guard: GUARD, rows: [] }).established, true);
  assert.equal(parseCopyRows('', { secretColumn: 'a', nonceColumn: 'b' }).found, false);
  assert.match(parseCopyRows('COPY public.t (id, x) FROM stdin;\n1\ty\n\\.\n', { secretColumn: 'a', nonceColumn: 'b' }).reason, /not in the COPY column list/);
});

test('snapshot coverage: the root disk is covered, attached custom volumes are not; refused unless a partial restore is accepted by name', () => {
  const inst = instanceOf({ expanded_devices: { root: { type: 'disk', path: '/', pool: 'default' }, data: { type: 'disk', path: '/srv/data', pool: 'tank', source: 'vol-data' }, eth0: { type: 'nic' } } });
  const cov = snapshotCoverage(inst);
  assert.equal(cov.root, 'root'); assert.deepEqual(cov.customVolumes, [{ device: 'data', pool: 'tank', source: 'vol-data', path: '/srv/data' }]);
  const refused = snapshotPlanVerdict({ instance: inst, snapshot: 'snap-1' });
  assert.equal(refused.ok, false); assert.match(refused.reason, /custom storage volume\(s\) attached .* NOT restore; refusing rather than claiming a complete restore/);
  const partial = snapshotPlanVerdict({ instance: inst, snapshot: 'snap-1', acceptPartial: true });
  assert.equal(partial.ok, true); assert.equal(partial.partial, true);
  assert.equal(snapshotPlanVerdict({ instance: instanceOf(), snapshot: 'snap-1' }).partial, false);
  assert.match(snapshotPlanVerdict({ instance: instanceOf(), snapshot: 'nope' }).reason, /does not exist/);
  assert.match(snapshotPlanVerdict({ instance: null, snapshot: 'x' }).reason, /does not exist/);
});

test('artifacts: a failed capture is reported as none, never as an artifact; revalidation is by identity, not existence', () => {
  assert.equal(parseProtect('PRE_DUMP:none:pg_dump failed or wrote no dump\nPRE_ENV:/etc/environment.pre-restore-1\n').dbDump, null);
  assert.equal(parseProtect('PRE_DUMP:/x/a.sql:garbage\nPRE_ENV:none:no environment file\n').dbDump, null);
  const good = parseProtect(`PRE_DUMP:${DUMPS}/app-pre-restore-1.sql:120:${'b'.repeat(64)}\nPRE_ENV:/etc/environment.pre-restore-1\n`);
  assert.deepEqual(good.dbDump, { path: `${DUMPS}/app-pre-restore-1.sql`, bytes: 120, sha256: 'b'.repeat(64) });
  const p = `${DUMPS}/app-pre-restore-1.sql`;
  assert.equal(artifactMatches(`ARTIFACT:${p}:120:${'b'.repeat(64)}\n`, { path: p, sha256: 'b'.repeat(64), bytes: 120 }).ok, true);
  assert.match(artifactMatches(`ARTIFACT:${p}:120:${'c'.repeat(64)}\n`, { path: p, sha256: 'b'.repeat(64) }).reason, /sha256 differs/);
  assert.match(artifactMatches(`ARTIFACT:${p}:missing\n`, { path: p, sha256: 'b'.repeat(64) }).reason, /is gone/);
  assert.match(artifactMatches(`ARTIFACT:/other:1:${'b'.repeat(64)}\n`, { path: p, sha256: 'b'.repeat(64) }).reason, /no artifact line/);
  // The protect script writes to a temp name and promotes only a verified capture.
  const ps = protectScript('j1');
  assert.match(ps, /> "\$f\.tmp" .* && \[ -s "\$f\.tmp" \] && head -c 64 "\$f\.tmp" \| grep -q 'PostgreSQL database dump'; then mv -f "\$f\.tmp" "\$f"/);
  assert.match(ps, /rm -f "\$f\.tmp"; echo "PRE_DUMP:none/);
  assert.throws(() => protectScript('../x'), /plain identifier/);
  assert.throws(() => restoreScript({ dumpName: '../x.sql' }), /dump name/);
  assert.throws(() => verifyArtifactScript('relative'), /absolute/);
  assert.throws(() => inspectScript({ dumpName: 'app-x.sql', guard: { ...GUARD, table: 'x; drop' }, guardKey: 'K' }), /plain identifiers/);
  // The inspect parser: keys are decoded from base64 for memory only.
  const parsed = parseInspect(`DUMP:10:${'a'.repeat(64)}\nHEAD:${b64('--\n-- PostgreSQL database dump\n')}\nSERVER:16.3\nUNIT_ACTIVE:active\nCOPY:none\nKEY_CURRENT:${b64(KEY)}\nENVCOPY:present\nKEY_COPY:${b64(OLD_KEY)}\n`);
  assert.equal(parsed.keyCurrent, KEY); assert.equal(parsed.keyCopy, OLD_KEY); assert.equal(parsed.copyPresent, false); assert.equal(parsed.dump.bytes, 10);
});

test('validation: the new kinds are runner jobs with reference-only parameters; a path, a value or a missing origin is refused', () => {
  assert.deepEqual([...RUNNER_JOB_KINDS].slice(4), ['restore_db', 'restore_snapshot', 'retry_secrets']);
  assert.deepEqual([...EXCLUSIVE_JOB_KINDS], ['restore_db', 'restore_snapshot']);
  const ok = (kind, params) => validateRunnerJob({ kind, app: 'pp-x', plan: { params: { container: 'pp-x', ...params } } });
  assert.equal(ok('restore_db', { dump: { name: 'app-x.sql' } }).ok, true);
  assert.match(ok('restore_db', { dump: { name: '../app-x.sql' } }).reason, /dump\.name/);
  assert.match(ok('restore_db', { dump: { name: 'app-x.sql' }, envCopy: { name: 'environment.pre-1' } }).reason, /originJobId/);
  assert.equal(ok('restore_db', { dump: { name: 'app-x.sql' }, envCopy: { name: 'environment.pre-1', originJobId: 'deploy-1' }, guardKey: 'AUTH_MASTER_SECRET', guard: GUARD }).ok, true);
  assert.match(ok('restore_db', { dump: { name: 'app-x.sql' }, envCopy: { name: '/etc/environment', originJobId: 'x' } }).reason, /envCopy\.name/);
  assert.match(ok('restore_db', { dump: { name: 'app-x.sql' }, script: 'rm -rf /' }).reason, /never carries a command/);
  assert.equal(ok('restore_snapshot', { snapshot: 'snap-1', acceptPartial: true }).ok, true);
  assert.match(ok('restore_snapshot', { snapshot: 'bad name' }).reason, /snapshot name/);
  assert.equal(ok('retry_secrets', { secrets: { configs: [{ key: 'NEW_KEY', secret: true, generate: true }] } }).ok, true);
  assert.match(ok('retry_secrets', { secrets: { configs: [{ key: 'NEW_KEY', value: 'v' }] } }).reason, /carries no value/);
  assert.match(ok('retry_secrets', {}).reason, /secrets\.configs/);
  assert.equal(validateRunnerJob({ kind: 'restore_project_db', app: 'pp-x', plan: { params: {} } }).ok, false, 'the pre-move kind is history');
});

// ── 2. restore_db through the executor ────────────────────────────────────

const restoreParams = (over = {}) => ({ container: 'pp-x', webPort: 3000, unit: 'mock2-dev.service', environmentFile: '/etc/environment', appDir: '/srv/app', dump: { name: 'app-mcp-1.sql' }, envCopy: null, guard: GUARD, guardKey: 'AUTH_MASTER_SECRET', ...over });

test('restore_db (current configuration): inspect and establish compatibility BEFORE the stop, protect, stop, restore, start, verify; the follow-up certifies the application; no key value in any row or event', async () => {
  const d = db();
  const rows = [encryptUnderMaster('bind-pw', KEY), encryptUnderMaster('bind-pw-2', GUARD.legacy_default)];
  const state = { dumps: { 'app-mcp-1.sql': { text: dumpText({ rows }) } }, selected: 'app-mcp-1.sql', ldaps: 'current' };
  const g = restoreGuest(state);
  const sub = submitRunnerJob(d, { kind: 'restore_db', app: 'pp-x', params: restoreParams(), configRefs: { guard: GUARD, webPort: 3000, unit: 'mock2-dev.service', environmentFile: '/etc/environment' }, requestedBy: 'alice', via: 'mcp', nowMs: T0 });
  assert.ok(sub.job, sub.error);
  const out = await runAll(d, exec(g), T0 + 1, { max: 1 });
  assert.equal(out.ran[0].status, 'succeeded', out.ran[0].outcome);
  assert.equal(out.ran[0].outcome, 'restored');
  const phases = g.calls.map((c) => c.phase);
  assert.deepEqual(phases.slice(0, 5), ['reap', 'inspect', 'protect', 'stop', 'restore'], 'read, protect, THEN stop');
  assert.ok(phases.indexOf('start_unit') > phases.indexOf('restore'));
  assert.ok(g.calls.filter((c) => c.phase !== 'reap').every((c) => isContained(c.raw)), 'every mutating script runs contained');
  const job = getJob(d, sub.job.id);
  const prog = parseJson(job.progress_json);
  assert.equal(prog.result.compatibility.mode, 'current_configuration');
  assert.deepEqual(prog.result.compatibility.rows, { total: 2, current: 1, legacy: 1, unknown: 0 });
  assert.equal(prog.result.protected.dbDump.path, `${DUMPS}/app-pre-restore-${sub.job.id}.sql`);
  assert.equal(prog.result.protected.envCopy, `/etc/environment.pre-restore-${sub.job.id}`);
  assert.equal(prog.result.errors, 2);
  assert.equal(prog.generated[0].kind, 'dump'); assert.equal(prog.generated[0].sha256.length, 64, 'the artifact record carries its identity');
  assert.equal(state.restoredFrom, `${DUMPS}/app-mcp-1.sql`);
  const cps = listEvents(d, job.id).filter((e) => e.kind === 'checkpoint').map((e) => e.phase);
  assert.ok(cps.indexOf('stopping_app') < cps.indexOf('restored'), 'the disruptive checkpoint precedes the restore');
  assert.ok(listEvents(d, job.id).some((e) => e.kind === 'compatibility' && /open under the key that will be in force/.test(e.message)));
  const v = parseJson(job.verification_json);
  assert.deepEqual(v.pending, ['credential_decryptable', 'credential_use_verified']);
  assert.match(job.reason, /database restored from .*app-mcp-1\.sql \(2 error line\(s\); current_configuration\); verification .* \(pending: credential_decryptable, credential_use_verified → job /);
  const followId = prog.verification_job_id;
  assert.equal(getJob(d, followId).status, 'queued');
  assert.equal(readLock(d, 'pp-x'), null, 'the lease is released after the restore');
  const f = await runAll(d, exec(g), T0 + 5, { kinds: ['verify_app'] });
  assert.equal(f.ran[0].status, 'succeeded');
  assert.equal(getJob(d, followId).outcome, 'credential_use_verified', 'the full ladder, application rung included');
  assert.equal(parseJson(getJob(d, job.id).verification_json).rungs.credential_use_verified.value, true, 'landed on the restore record');
  noValueIn(d, [job.id, followId], [KEY, OLD_KEY, LOGIN.password, rows[0].ciphertext]);
});

test('restore_db refuses BEFORE any disruption: compatibility not established, unsupported format, no COPY block, missing dump, older server, failed pre-restore capture — nothing stopped, lease released', async () => {
  const cases = [
    ['other key', { dumps: { 'app-mcp-1.sql': { text: dumpText({ rows: [encryptUnderMaster('pw', OTHER_KEY)] }) } } }, 'compatibility', /NOT established: 1 of 1 protected row\(s\)/],
    ['custom format', { dumps: { 'app-mcp-1.sql': { text: 'PGDMP\x01\x0e binary' } } }, 'inspect', /custom-format archive/],
    ['no COPY block', { dumps: { 'app-mcp-1.sql': { text: dumpText({ table: null }) } } }, 'inspect', /carries no COPY block for public\.auth_connections/],
    ['missing dump', { dumps: {} }, 'inspect', /no such dump/],
    ['older server', { dumps: { 'app-mcp-1.sql': { text: dumpText({ rows: [], from: '17.0' }) } }, server: '16.3' }, 'inspect', /older major/],
    ['capture failed', { dumps: { 'app-mcp-1.sql': { text: dumpText({ rows: [encryptUnderMaster('pw', KEY)] }) } }, protectFails: true }, 'protect', /refusing to restore without a pre-restore dump: pg_dump failed/],
  ];
  for (const [label, st, step, re] of cases) {
    const d = db();
    const state = { selected: 'app-mcp-1.sql', ...st };
    const g = restoreGuest(state);
    const sub = submitRunnerJob(d, { kind: 'restore_db', app: 'pp-x', params: restoreParams(), nowMs: T0 });
    const out = await runAll(d, exec(g), T0 + 1, { max: 1 });
    assert.equal(out.ran[0].status, 'failed', label);
    assert.equal(out.ran[0].outcome, `failed at ${step}`, label);
    assert.match(getJob(d, sub.job.id).reason, re, label);
    assert.equal(g.calls.some((c) => c.phase === 'stop' || c.phase === 'restore'), false, `${label}: nothing was stopped or restored`);
    assert.equal(parseJson(getJob(d, sub.job.id).progress_json).verification_job_id, null, `${label}: no post-failure verification, nothing changed`);
    assert.equal(readLock(d, 'pp-x'), null, label);
    noValueIn(d, [sub.job.id], [KEY, OTHER_KEY]);
  }
});

test('restore_db (recovery set): the dump and the environment copy must be what a job of THIS app recorded together, with the dump\'s recorded sha256; the copy\'s key decides compatibility and is then put in force', async () => {
  const d = db();
  const rows = [encryptUnderMaster('pw', OLD_KEY)];
  const text = dumpText({ rows });
  const origin = recordedDeploy(d, { dumpSha: sha(text) });
  const state = { dumps: { 'app-pre-deploy-deploy-1.sql': { text } }, selected: 'app-pre-deploy-deploy-1.sql', envCopies: { 'environment.pre-deploy-1': `AUTH_JWT_SECRET=y\nAUTH_MASTER_SECRET=${OLD_KEY}\n` }, envCopySelected: 'environment.pre-deploy-1', ldaps: 'current' };
  const g = restoreGuest(state);
  // Server-side resolution binds the pair through the record.
  const bad = resolveRestoreDbPlan(d, { containerName: 'pp-x', file: 'app-pre-deploy-deploy-1.sql', environmentCopy: 'environment.pre-deploy-2', guard: GUARD, guardKey: 'AUTH_MASTER_SECRET' });
  assert.match(bad.error, /did not record .* as one recovery set/);
  const plan = resolveRestoreDbPlan(d, { containerName: 'pp-x', file: 'app-pre-deploy-deploy-1.sql', environmentCopy: 'environment.pre-deploy-1', guard: GUARD, guardKey: 'AUTH_MASTER_SECRET' });
  assert.equal(plan.ok, true); assert.equal(plan.params.envCopy.originJobId, origin.id); assert.equal(plan.plan.mode, 'recovery_set');
  const sub = submitRunnerJob(d, { kind: 'restore_db', app: 'pp-x', params: plan.params, nowMs: T0 });
  const out = await runAll(d, exec(g), T0 + 1, { max: 1 });
  assert.equal(out.ran[0].status, 'succeeded', getJob(d, sub.job.id).reason);
  const prog = parseJson(getJob(d, sub.job.id).progress_json);
  assert.equal(prog.result.compatibility.mode, 'recovery_set');
  assert.equal(prog.result.restored.envCopy, '/etc/environment.pre-deploy-1');
  assert.equal(state.envSwappedFrom, '/etc/environment.pre-deploy-1', 'the recovery set\'s environment is in force');
  assert.ok(g.calls.map((c) => c.phase).indexOf('env_swap') > g.calls.map((c) => c.phase).indexOf('restore'));
  assert.match(state.envText, new RegExp(`AUTH_MASTER_SECRET=${OLD_KEY}`));
  // The same pair with a dump whose content is not what the record says: refused at bind.
  const d2 = db();
  recordedDeploy(d2, { dumpSha: 'f'.repeat(64) });
  const g2 = restoreGuest({ ...state, envText: undefined });
  const plan2 = resolveRestoreDbPlan(d2, { containerName: 'pp-x', file: 'app-pre-deploy-deploy-1.sql', environmentCopy: 'environment.pre-deploy-1', guard: GUARD, guardKey: 'AUTH_MASTER_SECRET' });
  const sub2 = submitRunnerJob(d2, { kind: 'restore_db', app: 'pp-x', params: plan2.params, nowMs: T0 });
  const out2 = await runAll(d2, exec(g2), T0 + 1, { max: 1 });
  assert.equal(out2.ran[0].outcome, 'failed at bind');
  assert.match(getJob(d2, sub2.job.id).reason, /sha256 differs.*recovery set is broken/);
  assert.equal(g2.calls.some((c) => c.phase === 'stop'), false);
  // Without the copy, the same dump under the CURRENT key is not compatible — refused, never assumed.
  const d3 = db();
  const g3 = restoreGuest({ dumps: { 'app-pre-deploy-deploy-1.sql': { text } }, selected: 'app-pre-deploy-deploy-1.sql' });
  const sub3 = submitRunnerJob(d3, { kind: 'restore_db', app: 'pp-x', params: restoreParams({ dump: { name: 'app-pre-deploy-deploy-1.sql' } }), nowMs: T0 });
  const out3 = await runAll(d3, exec(g3), T0 + 1, { max: 1 });
  assert.equal(out3.ran[0].outcome, 'failed at compatibility');
  assert.match(getJob(d3, sub3.job.id).reason, /with the current configuration is NOT established/);
  noValueIn(d, [sub.job.id], [KEY, OLD_KEY]); noValueIn(d3, [sub3.job.id], [KEY, OLD_KEY]);
});

test('restore_db retry: the pre-restore copies of the failed attempt are reused only when they revalidate by sha256; otherwise a new copy is taken; the retry origin is resolved server-side for THIS app and kind', async () => {
  const d = db();
  const rows = [encryptUnderMaster('pw', KEY)];
  const state = { dumps: { 'app-mcp-1.sql': { text: dumpText({ rows }) } }, selected: 'app-mcp-1.sql', stopFails: true, ldaps: 'current' };
  const g = restoreGuest(state);
  const first = submitRunnerJob(d, { kind: 'restore_db', app: 'pp-x', params: restoreParams(), nowMs: T0 });
  const out1 = await runAll(d, exec(g), T0 + 1, { max: 1 });
  assert.equal(out1.ran[0].outcome, 'failed at stop');
  const gen = parseJson(getJob(d, first.job.id).progress_json).generated;
  assert.equal(gen.length, 1); assert.equal(gen[0].kind, 'dump');
  assert.match(getJob(d, first.job.id).reason, /could not stop mock2-dev\.service/);
  // retry_of is resolved on the server: wrong app / wrong kind / open job are refused.
  assert.match(resolveRetryOf(d, { jobId: first.job.id, app: 'pp-y', kind: 'restore_db' }).error, /belongs to pp-x/);
  assert.match(resolveRetryOf(d, { jobId: first.job.id, app: 'pp-x', kind: 'restore_snapshot' }).error, /is a restore_db, not a restore_snapshot/);
  assert.match(resolveRetryOf(d, { jobId: 'nope', app: 'pp-x', kind: 'restore_db' }).error, /no such job/);
  // The retry: the artifact revalidates → reused, no second capture.
  state.stopFails = false;
  const retry = submitRunnerJob(d, { kind: 'restore_db', app: 'pp-x', params: restoreParams({ retryOf: first.job.id }), retryOf: first.job.id, nowMs: T0 + 10 });
  g.calls.length = 0;
  const out2 = await runAll(d, exec(g), T0 + 11, { max: 1 });
  assert.equal(out2.ran[0].status, 'succeeded', getJob(d, retry.job.id).reason);
  const phases = g.calls.map((c) => c.phase);
  assert.ok(phases.includes('verify_artifact'));
  assert.equal(phases.filter((p) => p === 'protect').length, 1, 'the environment copy is still taken; the dump is not re-captured');
  const prog = parseJson(getJob(d, retry.job.id).progress_json);
  assert.equal(prog.result.protected.reused, true);
  assert.equal(prog.result.protected.dbDump.path, gen[0].name);
  assert.ok(listEvents(d, retry.job.id).some((e) => e.kind === 'reuse' && /revalidated \(sha256 matches\) and reused/.test(e.message)));
  assert.equal((prog.generated || []).length, 0, 'nothing new recorded for a reused artifact');
  // A tampered artifact (sha differs) is NOT reused.
  const d2 = db();
  const state2 = { dumps: { 'app-mcp-1.sql': { text: dumpText({ rows }) } }, selected: 'app-mcp-1.sql', stopFails: true, ldaps: 'current' };
  const g2 = restoreGuest(state2);
  const f2 = submitRunnerJob(d2, { kind: 'restore_db', app: 'pp-x', params: restoreParams(), nowMs: T0 });
  await runAll(d2, exec(g2), T0 + 1, { max: 1 });
  const path2 = parseJson(getJob(d2, f2.job.id).progress_json).generated[0].name;
  state2.artifacts[path2] = { bytes: 5, sha256: 'e'.repeat(64) };
  state2.stopFails = false;
  const r2 = submitRunnerJob(d2, { kind: 'restore_db', app: 'pp-x', params: restoreParams(), retryOf: f2.job.id, nowMs: T0 + 10 });
  g2.calls.length = 0;
  const out3 = await runAll(d2, exec(g2), T0 + 11, { max: 1 });
  assert.equal(out3.ran[0].status, 'succeeded');
  assert.ok(listEvents(d2, r2.job.id).some((e) => e.kind === 'reuse' && /not reused: .*sha256 differs.*a new copy is taken/.test(e.message)));
  assert.equal(parseJson(getJob(d2, r2.job.id).progress_json).result.protected.reused, false);
  assert.notEqual(parseJson(getJob(d2, r2.job.id).progress_json).result.protected.dbDump.path, path2);
});

test('restore_db interrupted: before the stop it is resumed; after the stop it is recovery-required with the restore named, the lease kept stale, a recovery job queued and run, then the application check', async () => {
  // Before: a dead owner at 'inspecting' (resumable) → requeued → runs.
  const d = db();
  const rows = [encryptUnderMaster('pw', KEY)];
  const state = { dumps: { 'app-mcp-1.sql': { text: dumpText({ rows }) } }, selected: 'app-mcp-1.sql', ldaps: 'current' };
  const g = restoreGuest(state);
  const sub = submitRunnerJob(d, { kind: 'restore_db', app: 'pp-x', params: restoreParams(), nowMs: T0 });
  const claimed = claimNextJob(d, { owner: DEAD, kinds: ['restore_db'], leaseMs: 1000, nowMs: T0 + 1 });
  acquireLock(d, { app: 'pp-x', owner: DEAD, operation: 'restore_db', jobId: sub.job.id, leaseMs: 1000, nowMs: T0 + 1 });
  checkpoint(d, { id: sub.job.id, owner: DEAD, epoch: claimed.epoch, phase: 'inspecting', checkpoint: { app_stopped: false, resumable: true, container: 'pp-x' }, nowMs: T0 + 2 });
  const rec = reconcile({ db: d, owner: RUNNER, nowMs: T0 + 60_000 });
  assert.deepEqual(rec.requeued, [sub.job.id]);
  const out = await runAll(d, exec(g), T0 + 60_001, { max: 1 });
  assert.equal(out.ran[0].status, 'succeeded');
  // After: a dead owner at 'stopping_app' with the restore in flight.
  const d2 = db();
  const g2 = restoreGuest({ ...state, active: false });
  const sub2 = submitRunnerJob(d2, { kind: 'restore_db', app: 'pp-x', params: restoreParams(), configRefs: { guard: GUARD, webPort: 3000, unit: 'mock2-dev.service', environmentFile: '/etc/environment' }, nowMs: T0 });
  const c2 = claimNextJob(d2, { owner: DEAD, kinds: ['restore_db'], leaseMs: 1000, nowMs: T0 + 1 });
  acquireLock(d2, { app: 'pp-x', owner: DEAD, operation: 'restore_db', jobId: sub2.job.id, leaseMs: 1000, nowMs: T0 + 1 });
  const recovery = { container: 'pp-x', unit: 'mock2-dev.service', webPort: 3000, guard: GUARD, protected: { dbDump: { path: `${DUMPS}/app-pre-restore-${sub2.job.id}.sql`, bytes: 10, sha256: 'a'.repeat(64) }, envCopy: `/etc/environment.pre-restore-${sub2.job.id}` } };
  checkpoint(d2, { id: sub2.job.id, owner: DEAD, epoch: c2.epoch, phase: 'stopping_app', checkpoint: { app_stopped: true, disruptive: true, restore_in_progress: true, container: 'pp-x', unit: 'mock2-dev.service', webPort: 3000, recovery }, nowMs: T0 + 2 });
  const rec2 = reconcile({ db: d2, owner: RUNNER, nowMs: T0 + 60_000 });
  assert.equal(rec2.recoveryQueued.length, 1);
  const dead = getJob(d2, sub2.job.id);
  assert.equal(dead.status, 'recovery_required'); assert.equal(dead.outcome, 'interrupted_after_stop');
  assert.match(dead.reason, /A database restore was in flight: the database may be partially restored; the pre-restore dump .*app-pre-restore-.* is the protected copy/);
  assert.ok(readLock(d2, 'pp-x').stale_since, 'the lease is kept and flagged');
  assert.deepEqual(parseJson(dead.checkpoint_json).recovery.protected.envCopy, recovery.protected.envCopy, 'the recovery material stays on the record');
  const out2 = await runAll(d2, exec(g2), T0 + 60_001);
  const recJob = d2.prepare(`SELECT * FROM setup_jobs WHERE kind = 'recover_app'`).get();
  assert.equal(recJob.status, 'succeeded');
  assert.ok(g2.calls.some((c) => /START_RC/.test(c.script)), 'the recovery started the unit');
  assert.ok(out2.ran.some((r) => r.status === 'succeeded' && r.verification?.state === 'credential_use_verified') || getJob(d2, parseJson(recJob.progress_json).verification_job_id)?.outcome === 'verified', 'the application check followed the recovery');
  assert.equal(readLock(d2, 'pp-x'), null);
});

test('conflicting operations are refused before any mutation: at submission while a deploy is open or the lease is held/stale, and at claim time when the lease is held — never queued behind', async () => {
  const d = db();
  createJob(d, { kind: 'deploy', app: 'pp-x', plan: { params: PARAMS() }, nowMs: T0 });
  const s1 = submitRunnerJob(d, { kind: 'restore_db', app: 'pp-x', params: restoreParams(), nowMs: T0 + 1 });
  assert.equal(s1.code, 'CONTAINER_BUSY'); assert.match(s1.error, /deploy job .* is queued for pp-x — the restore was refused before any change/);
  assert.equal(d.prepare(`SELECT COUNT(*) AS n FROM setup_jobs WHERE kind = 'restore_db'`).get().n, 0, 'no job row for a refused submission');
  const d2 = db();
  acquireLock(d2, { app: 'pp-x', owner: BACKEND, operation: 'deploy', leaseMs: 60_000, nowMs: T0 });
  const s2 = submitRunnerJob(d2, { kind: 'restore_snapshot', app: 'pp-x', params: { snapshot: 'snap-1' }, nowMs: T0 + 1 });
  assert.equal(s2.code, 'CONTAINER_BUSY'); assert.match(s2.error, /deploy \(backend@/);
  const s3 = submitRunnerJob(d2, { kind: 'restore_db', app: 'pp-x', params: restoreParams(), nowMs: T0 + 120_000 });
  assert.equal(s3.code, 'CONTAINER_LOCK_STALE'); assert.match(s3.error, /did not finish .* recovery is required/);
  // A mint is not exclusive: it queues and is deferred at claim time (as before).
  const s4 = submitRunnerJob(d2, { kind: 'retry_secrets', app: 'pp-x', params: { secrets: { configs: [] } }, nowMs: T0 + 2 });
  assert.ok(s4.job);
  // Claim-time: a restore created while free, the lease then taken by a live holder → refused, no guest call.
  const d3 = db();
  const g3 = restoreGuest({ dumps: {}, selected: 'app-mcp-1.sql' });
  const s5 = submitRunnerJob(d3, { kind: 'restore_db', app: 'pp-x', params: restoreParams(), nowMs: T0 });
  acquireLock(d3, { app: 'pp-x', owner: BACKEND, operation: 'restore_snapshot', leaseMs: 60_000, nowMs: T0 + 1 });
  const out = await runAll(d3, exec(g3), T0 + 2, { max: 1 });
  assert.equal(out.ran[0].status, 'refused'); assert.equal(out.ran[0].outcome, 'lock_held');
  assert.match(getJob(d3, s5.job.id).reason, /refused before any change — submit it again/);
  assert.equal(g3.calls.length, 0);
});

test('runner-required: a restore is REFUSED (cancelled on the record, never left queued) with no live runner and nothing runs; with a live runner it is handed over; a mint is refused the same way', async (t) => {
  const d = db();
  const g = restoreGuest({ dumps: {}, selected: 'app-mcp-1.sql' });
  const h = scriptedHost({ instance: instanceOf() });
  configureContainerLockStore({ getDb: () => d, owner: BACKEND, env: { SETUP_EXECUTOR_POLICY: 'runner-required' }, guestExec: exec(g, h), hostExec: h.host, reviewLogin: async () => LOGIN });
  t.after(() => configureContainerLockStore(null));
  const out = await restoreProjectDb({ containerName: 'pp-x', file: 'app-mcp-1.sql', requestedBy: 'alice', via: 'mcp' });
  assert.equal(out.ok, false); assert.equal(out.step, 'runner_unavailable'); assert.equal(out.refused, true);
  const job = getJob(d, out.jobId);
  assert.equal(job.status, 'cancelled'); assert.equal(job.outcome, 'runner_unavailable');
  assert.match(job.reason, /not left queued to run later under a state nobody looked at/);
  assert.equal(g.calls.length, 0); assert.equal(h.calls.length, 0);
  const out2 = await restoreSnapshot({ containerName: 'pp-x', snapshot: 'snap-1', via: 'mcp' });
  assert.equal(out2.refused, true); assert.equal(getJob(d, out2.jobId).status, 'cancelled');
  const out3 = await retryProjectSecrets({ containerName: 'pp-x', via: 'system' });
  assert.equal(out3.refused, true); assert.equal(getJob(d, out3.jobId).outcome, 'runner_unavailable');
  assert.match(getJob(d, out3.jobId).reason, /the deploy that follows mints the same keys/);
  // A live runner: the job is submitted to it (detached), owned by the runner when it runs.
  runnerHeartbeat(d, { owner: RUNNER, host: 'pp', pid: 300, nowMs: Date.now() });
  const out4 = await restoreSnapshot({ containerName: 'pp-x', snapshot: 'snap-1', via: 'mcp', detach: true });
  assert.equal(out4.submitted, true); assert.equal(out4.executor, 'runner');
  const ran = await runAll(d, exec(g, h), Date.now(), { max: 1 });
  assert.equal(ran.ran[0].status, 'succeeded');
  assert.equal(getJob(d, out4.jobId).owner, RUNNER);
  assert.deepEqual(h.calls.find((a) => a[1] === 'snapshot' && a[2] === 'restore'), ['incus', 'snapshot', 'restore', 'pp-x', 'snap-1'], 'argv to incus, never a shell string');
});

// ── 3. restore_snapshot through the executor ──────────────────────────────

const snapParams = (over = {}) => ({ container: 'pp-x', snapshot: 'snap-1', acceptPartial: false, managed: true, webPort: 3000, unit: 'mock2-dev.service', environmentFile: '/etc/environment', guard: GUARD, ...over });

test('restore_snapshot: validated, pre-restore snapshot taken and identified by name+timestamp, restored with argv, restarted when it was running, verified by a follow-up; a non-managed guest gets an explicit not-applicable', async () => {
  const d = db();
  const st = { instance: instanceOf(), restoreStops: true };
  const h = scriptedHost(st); const g = restoreGuest({ ldaps: 'current' });
  const sub = submitRunnerJob(d, { kind: 'restore_snapshot', app: 'pp-x', params: snapParams(), configRefs: { guard: GUARD, webPort: 3000, unit: 'mock2-dev.service', environmentFile: '/etc/environment' }, nowMs: T0 });
  const out = await runAll(d, exec(g, h), T0 + 1, { max: 1 });
  assert.equal(out.ran[0].status, 'succeeded', getJob(d, sub.job.id).reason);
  const verbs = h.calls.map((a) => a.slice(1, 3).join(' '));
  assert.deepEqual(verbs, ['list pp-x', 'snapshot create', 'list pp-x', 'snapshot restore', 'list pp-x', 'start pp-x', 'list pp-x']);
  assert.deepEqual(h.calls[1].slice(0, 4), ['incus', 'snapshot', 'create', 'pp-x']);
  assert.match(h.calls[1][4], /^pp-pre-restore-[a-f0-9]{8}-[a-z0-9]+$/);
  assert.deepEqual(h.calls[3], ['incus', 'snapshot', 'restore', 'pp-x', 'snap-1']);
  assert.equal(st.started, 1, 'the guest was running before and is running after');
  const prog = parseJson(getJob(d, sub.job.id).progress_json);
  assert.equal(prog.generated[0].kind, 'snapshot'); assert.match(prog.generated[0].created_at, /^2026-/);
  assert.equal(prog.result.preRestore.name, h.calls[1][4]);
  assert.equal(prog.result.partial, false); assert.equal(prog.result.status, 'Running');
  assert.ok(listEvents(d, sub.job.id).filter((e) => e.kind === 'checkpoint').map((e) => e.phase).includes('restoring'), 'the disruptive checkpoint is on the record, outside the guest');
  assert.equal(g.calls.length, 0, 'no guest script runs for the restore itself');
  const followId = prog.verification_job_id;
  assert.equal(getJob(d, followId).kind, 'verify_app');
  const f = await runAll(d, exec(g, h), T0 + 5, { kinds: ['verify_app'] });
  assert.equal(f.ran[0].status, 'succeeded');
  assert.equal(parseJson(getJob(d, sub.job.id).verification_json).rungs.credential_use_verified.value, true);
  // A guest the registry does not know: restored, and said to be unverifiable as an application.
  const d2 = db(); const h2 = scriptedHost({ instance: instanceOf({ name: 'pp-plain' }) });
  const sub2 = submitRunnerJob(d2, { kind: 'restore_snapshot', app: 'pp-plain', params: { container: 'pp-plain', snapshot: 'snap-1', managed: false }, nowMs: T0 });
  const out2 = await runAll(d2, exec(restoreGuest({}), h2), T0 + 1, { max: 1 });
  assert.equal(out2.ran[0].status, 'succeeded');
  assert.equal(parseJson(getJob(d2, sub2.job.id).verification_json).state, 'not_applicable');
  assert.equal(parseJson(getJob(d2, sub2.job.id).progress_json).verification_job_id, null);
  assert.match(getJob(d2, sub2.job.id).reason, /verification not_applicable/);
});

test('restore_snapshot refusals and failures: custom volumes without accept_partial (nothing taken), accepted partial says complete: false, a failed incus restore keeps the pre-restore snapshot and queues a post-failure verification, no host channel refuses', async () => {
  const withVol = () => instanceOf({ expanded_devices: { root: { type: 'disk', path: '/', pool: 'default' }, data: { type: 'disk', path: '/srv/data', pool: 'tank', source: 'vol-data' } } });
  const d = db(); const h = scriptedHost({ instance: withVol() });
  const sub = submitRunnerJob(d, { kind: 'restore_snapshot', app: 'pp-x', params: snapParams(), nowMs: T0 });
  const out = await runAll(d, exec(restoreGuest({}), h), T0 + 1, { max: 1 });
  assert.equal(out.ran[0].outcome, 'failed at coverage');
  assert.match(getJob(d, sub.job.id).reason, /custom storage volume\(s\) attached .* refusing rather than claiming a complete restore/);
  assert.equal(h.calls.length, 1, 'only the read');
  const d2 = db(); const st2 = { instance: withVol() }; const h2 = scriptedHost(st2);
  const sub2 = submitRunnerJob(d2, { kind: 'restore_snapshot', app: 'pp-x', params: snapParams({ acceptPartial: true }), nowMs: T0 });
  const out2 = await runAll(d2, exec(restoreGuest({}), h2), T0 + 1, { max: 1 });
  assert.equal(out2.ran[0].status, 'succeeded');
  assert.equal(parseJson(getJob(d2, sub2.job.id).progress_json).result.partial, true);
  assert.match(getJob(d2, sub2.job.id).reason, /root disk only; custom volumes NOT restored/);
  const d3 = db(); const h3 = scriptedHost({ instance: instanceOf(), restoreFails: true });
  const sub3 = submitRunnerJob(d3, { kind: 'restore_snapshot', app: 'pp-x', params: snapParams(), nowMs: T0 });
  const out3 = await runAll(d3, exec(restoreGuest({}), h3), T0 + 1, { max: 1 });
  assert.equal(out3.ran[0].outcome, 'failed at restore');
  assert.match(getJob(d3, sub3.job.id).reason, /zfs busy \(pre-restore snapshot pp-pre-restore-.* exists\) \(post-failure verification queued: job /);
  assert.equal(parseJson(getJob(d3, sub3.job.id).progress_json).generated[0].kind, 'snapshot', 'the pre-restore snapshot stays on the record');
  const d4 = db();
  const sub4 = submitRunnerJob(d4, { kind: 'restore_snapshot', app: 'pp-x', params: snapParams(), nowMs: T0 });
  const out4 = await runAll(d4, exec(restoreGuest({})), T0 + 1, { max: 1 });
  assert.equal(out4.ran[0].outcome, 'failed at executor');
  assert.match(getJob(d4, sub4.job.id).reason, /no host command channel/);
});

test('restore_snapshot retry and CLI form: a recorded pre-restore snapshot is reused only with its recorded timestamp; the legacy `incus snapshot <name> <snap>` client is discovered and used', async () => {
  const d = db(); const st = { instance: instanceOf(), restoreFails: true }; const h = scriptedHost(st);
  const first = submitRunnerJob(d, { kind: 'restore_snapshot', app: 'pp-x', params: snapParams(), nowMs: T0 });
  await runAll(d, exec(restoreGuest({}), h), T0 + 1, { max: 1 });
  const pre = parseJson(getJob(d, first.job.id).progress_json).generated[0];
  st.restoreFails = false; h.calls.length = 0;
  const retry = submitRunnerJob(d, { kind: 'restore_snapshot', app: 'pp-x', params: snapParams(), retryOf: first.job.id, nowMs: T0 + 10 });
  const out = await runAll(d, exec(restoreGuest({ ldaps: 'current' }), h), T0 + 11, { max: 1, kinds: ['restore_snapshot'] });
  assert.equal(out.ran[0].status, 'succeeded');
  assert.equal(h.calls.some((a) => a[2] === 'create'), false, 'no second pre-restore snapshot');
  assert.equal(parseJson(getJob(d, retry.job.id).progress_json).result.preRestore.name, pre.name);
  assert.ok(listEvents(d, retry.job.id).some((e) => e.kind === 'reuse' && /still exists with its recorded timestamp and is reused/.test(e.message)));
  // Same name, different timestamp (re-created by hand): not the recorded artifact → a new one.
  const d2 = db(); const st2 = { instance: instanceOf(), restoreFails: true }; const h2 = scriptedHost(st2);
  const f2 = submitRunnerJob(d2, { kind: 'restore_snapshot', app: 'pp-x', params: snapParams(), nowMs: T0 });
  await runAll(d2, exec(restoreGuest({}), h2), T0 + 1, { max: 1 });
  const pre2 = parseJson(getJob(d2, f2.job.id).progress_json).generated[0];
  st2.instance.snapshots.find((s) => s.name === pre2.name).created_at = '2027-01-01T00:00:00Z';
  st2.restoreFails = false; h2.calls.length = 0;
  const r2 = submitRunnerJob(d2, { kind: 'restore_snapshot', app: 'pp-x', params: snapParams(), retryOf: f2.job.id, nowMs: T0 + 10 });
  await runAll(d2, exec(restoreGuest({ ldaps: 'current' }), h2), T0 + 11, { max: 1, kinds: ['restore_snapshot'] });
  assert.ok(h2.calls.some((a) => a[2] === 'create'), 'a new pre-restore snapshot');
  assert.ok(listEvents(d2, r2.job.id).some((e) => /has a different timestamp; a new one is taken/.test(e.message)));
  // Legacy CLI: the subcommand form is refused by the client, the legacy form succeeds, nothing else is retried.
  const d3 = db(); const h3 = scriptedHost({ instance: instanceOf(), cliForm: 'legacy' });
  const s3 = submitRunnerJob(d3, { kind: 'restore_snapshot', app: 'pp-x', params: snapParams(), nowMs: T0 });
  const out3 = await runAll(d3, exec(restoreGuest({ ldaps: 'current' }), h3), T0 + 1, { max: 1 });
  assert.equal(out3.ran[0].status, 'succeeded', getJob(d3, s3.job.id).reason);
  const creates = h3.calls.filter((a) => a[1] === 'snapshot' && a[2] !== 'restore');
  assert.equal(creates[0][2], 'create'); assert.equal(creates[1].length, 4, 'legacy: incus snapshot <name> <snap>');
});

// ── 4. retry_secrets through the executor ─────────────────────────────────

test('retry_secrets: mints the missing key with a real value in the guest and NAMES only on the record, defers by marker, reuses on retry without replacing, and needs no follow-up of its own', async () => {
  const d = db();
  const configs = [{ key: 'NEW_KEY', secret: true, generate: true }, { key: 'AUTH_MASTER_SECRET', secret: true, generate: true, protects: GUARD }];
  const state = { ldaps: 'current' };
  const g = restoreGuest(state);
  const sub = submitRunnerJob(d, { kind: 'retry_secrets', app: 'pp-x', params: { container: 'pp-x', appDir: '/srv/app', environmentFile: '/etc/environment', secrets: { configs }, guard: GUARD }, configRefs: { keys: ['NEW_KEY', 'AUTH_MASTER_SECRET'] }, nowMs: T0 });
  const out = await runAll(d, exec(g), T0 + 1, { max: 1 });
  assert.equal(out.ran[0].status, 'succeeded', getJob(d, sub.job.id).reason);
  const prog = parseJson(getJob(d, sub.job.id).progress_json);
  assert.deepEqual(prog.result.minted, ['NEW_KEY']);
  assert.deepEqual(prog.result.reused, []);
  const value = (state.envText.match(/^NEW_KEY=(.*)$/m) || [])[1];
  assert.ok(value && value.length >= 16, 'a real value was written into the guest');
  assert.match(state.envText, new RegExp(`^AUTH_MASTER_SECRET=${KEY}$`, 'm'), 'an existing key is never replaced');
  assert.deepEqual(prog.generated.map((x) => x.name), ['NEW_KEY']);
  assert.equal(parseJson(getJob(d, sub.job.id).verification_json).state, 'not_applicable');
  assert.equal(prog.verification_job_id, null, 'the deploy that follows verifies');
  assert.match(getJob(d, sub.job.id).reason, /1 secret\(s\) minted, 0 deferred, 0 reused; verification not_applicable/);
  noValueIn(d, [sub.job.id], [value, KEY]);
  // The retry: nothing to mint, the recorded key is found in place and reported as reused.
  const retry = submitRunnerJob(d, { kind: 'retry_secrets', app: 'pp-x', params: { container: 'pp-x', secrets: { configs } }, retryOf: sub.job.id, nowMs: T0 + 10 });
  const out2 = await runAll(d, exec(g), T0 + 11, { max: 1 });
  assert.equal(out2.ran[0].status, 'succeeded');
  const p2 = parseJson(getJob(d, retry.job.id).progress_json);
  assert.deepEqual(p2.result.minted, []); assert.deepEqual(p2.result.reused, ['NEW_KEY']);
  assert.equal((state.envText.match(/^NEW_KEY=(.*)$/m) || [])[1], value, 'the value is unchanged');
  noValueIn(d, [retry.job.id], [value, KEY]);
});

// ── 5. the actual callers: MCP tools over a real store and executor ───────

const POLICY = JSON.parse(readFileSync(new URL('../lib/mcp-policy/mcp-extended-policy.json', import.meta.url), 'utf8'));
const LXC_POLICY = JSON.parse(readFileSync(new URL('../lib/mcp-policy/lxc-command-allowlist.json', import.meta.url), 'utf8'));
const toolResult = (data, { isError = false } = {}) => ({ content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data) }], isError });
const parse = (r) => { try { return JSON.parse(r.content[0].text); } catch { return { error: r.content[0].text, isError: !!r.isError }; } };
const AUTH = { id: 7, created_by: 'admin-1', name: 'test key', scope_json: null };

function mcpCtx({ instance, dumpBytes = 100 }) {
  const ledger = [];
  const fdb = { prepare(sql) { return { run: (...a) => { if (/INSERT INTO mcp_ledger/.test(sql)) ledger.push(a); return { changes: 1 }; }, get: () => undefined, all: () => [] }; }, exec() {}, pragma() { return 1; } };
  const confirmations = createConfirmationStore();
  const ctx = {
    getDb: () => fdb, logAudit: () => {}, getSetting: () => null, setSetting: () => {}, toolResult, uuidv4: () => 'uuid', policy: POLICY, confirmations,
    runHostCapture: async (bin, args) => (args[0] === 'exec' && /test -f/.test(args[4] || '') ? { status: 0, stdout: `${dumpBytes}\n`, stderr: '' } : { status: 0, stdout: '', stderr: '' }),
    runInContainer: async () => ({ status: 0, stdout: '', stderr: '' }), readContainerStartup: async () => null, agentCall: async () => { throw new Error('no agent'); }, publicBaseUrl: () => 'https://pp.test',
    LXC_PREFIX: 'pp-', LXC_NAME_REGEX: /^[a-zA-Z0-9][a-zA-Z0-9-]*$/, LXC_CMD_POLICY: LXC_POLICY, LXC_LIST_CAPTURE_CAP: 1 << 24,
    validLxcFilePath: (p) => p, validTargetDir: (p) => p,
    takeLxcSnapshot: async (n, s) => ({ name: s }), fetchLxcInstance: async (n) => (instance && instance.name === n ? { instance } : { notFound: true }),
    lxcContainerDetail, lxcReachableAddress: () => null,
    defaultSnapshotName: (d, p = 'pp-mcp') => `${p}-x`, validSnapshotName: (s) => (/^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/.test(String(s || '')) ? String(s) : null), snapshotArgv: (v, i, s) => ['snapshot', v, i, s], resolveSnapshotCliForm: async () => 'subcommand',
    verifiedContainerWrite: async () => ({}), takeUploadTicket: async () => { throw new Error('no ticket'); },
    findOrCreateLxcService: () => ({ id: 's' }), syncLxcServiceUpstream: async () => ({}), regenerateDomainCaddyConfig: async () => {}, ensureCaddyStructure: async () => {},
    assertRoutesShareSslStance: () => {}, caddyAdapt: async () => {}, caddyReload: async () => {}, normalizePathPrefix: (v) => v || '/',
    validDomainName: (s) => s, normalizePort: (p) => Number(p) || null, validIpv4: (s) => s, ROUTE_SELECT: 'SELECT 1', routeView: (r) => r, certInfoForDomain: async () => ({}), recentErrorsForDomain: async () => null,
    caddyAccessLogPath: (d) => d, summarizeAccessLog: () => ({}), getStaticSite: () => null, staticSiteDomains: () => [], SERVICES_DATA_DIR: '/data/services', walkDocroot: async () => ({ files: [] }),
    mock2Enabled: () => true, mock2Modules: async () => ({}), projectContainerName: () => 'pp-x', requireActiveProject: () => ({ project: { id: 1, name: 'demo' } }),
    liveBuildGuard: () => null, commitProjectPaths: async () => ({}), readProjectText: async () => ({ error: 'x' }), M2_APP_DIR: '/srv/app', projectUrl: () => null, projectSummary: (p) => p,
    appendProjectChangeRecord: async () => ({ appended: true, seq: 1 }),
    selfUpdateInstalled: async () => ({ reachable: false }), selfUpdateStart: async () => { throw new Error('off'); }, selfUpdateStatus: async () => ({ status: 'idle' }), SELF_UPDATE_POLICY: { enabled: true },
    mintMcpToken: () => 'ppmcp_' + 'a'.repeat(64), hashMcpToken: (t) => `h:${t}`, MCP_TOOL_NAMES: () => MCP_TOOLS.map((t) => t.name), dbPath: '/tmp/pp.db', listBackupsRunning: null,
  };
  return { ctx, ledger, confirmations };
}

test('MCP restore_project_db: admin token + one-time confirmation bound to the EXACT plan (a token for one plan cannot confirm another), dry_run previews the plan, the restore runs through the executor and reports the job; busy is refused', async (t) => {
  const d = db();
  const rows = [encryptUnderMaster('pw', KEY)];
  const state = { dumps: { 'app-mcp-1.sql': { text: dumpText({ rows }) } }, selected: 'app-mcp-1.sql', ldaps: 'current' };
  const g = restoreGuest(state);
  configureContainerLockStore({ getDb: () => d, owner: BACKEND, env: { SETUP_EXECUTOR_POLICY: 'backend-allowed' }, guestExec: exec(g), reviewLogin: async () => LOGIN });
  t.after(() => configureContainerLockStore(null));
  const { ctx, ledger } = mcpCtx({ instance: instanceOf() });
  const tools = createExtendedHandlers(ctx).handlers;
  // dry run: the plan, nothing else.
  const dry = parse(await tools.restore_project_db({ project_id: 1, file: 'app-mcp-1.sql', dry_run: true }, AUTH));
  assert.equal(dry.dry_run, true); assert.equal(dry.would.mode, 'current_configuration'); assert.match(dry.would.compatibility, /decrypt under the CURRENT configuration/);
  assert.equal(g.calls.length, 0);
  // A bad name never reaches the engine.
  assert.match(parse(await tools.restore_project_db({ project_id: 1, file: '../x.sql' }, AUTH)).error, /file must be a dump name/);
  assert.match(parse(await tools.restore_project_db({ project_id: 1, file: 'app-mcp-1.sql', environment_copy: 'environment.pre-deploy-9' }, AUTH)).error, /not a recovery set of this app/);
  // First call: the token, bound to the plan digest.
  const first = parse(await tools.restore_project_db({ project_id: 1, file: 'app-mcp-1.sql' }, AUTH));
  assert.equal(first.needs_confirmation, true); assert.ok(first.confirmation_token);
  // The same token cannot confirm a DIFFERENT plan (an environment copy added).
  recordedDeploy(d, { dumpSha: sha(dumpText({ rows })) });
  state.dumps['app-pre-deploy-deploy-1.sql'] = { text: dumpText({ rows }) };
  const other = parse(await tools.restore_project_db({ project_id: 1, file: 'app-pre-deploy-deploy-1.sql', environment_copy: 'environment.pre-deploy-1', confirmation_token: first.confirmation_token }, AUTH));
  assert.match(other.error, /issued for a different target/);
  assert.equal(d.prepare(`SELECT COUNT(*) AS n FROM setup_jobs WHERE kind = 'restore_db'`).get().n, 0, 'nothing was submitted');
  // The right plan with its own token: runs through the executor in-process.
  const again = parse(await tools.restore_project_db({ project_id: 1, file: 'app-mcp-1.sql' }, AUTH));
  const done = parse(await tools.restore_project_db({ project_id: 1, file: 'app-mcp-1.sql', confirmation_token: again.confirmation_token }, AUTH));
  assert.equal(done.restored, true, JSON.stringify(done));
  assert.equal(done.mode, 'current_configuration'); assert.ok(done.job_id); assert.equal(done.errors, 2); assert.ok(done.verification.job_id);
  assert.match(done.pre_restore_dump, /app-pre-restore-/); assert.match(done.reverse_with, /restore_project_db\(\{ project_id: 1, file: "app-pre-restore-/);
  const job = getJob(d, done.job_id);
  assert.equal(job.status, 'succeeded'); assert.equal(job.owner, BACKEND); assert.equal(job.via, 'mcp');
  assert.ok(ledger.some((row) => row[3] === 'restore_project_db' && row[8] === 'ok'), 'the server wrote the ledger row');
  const follow = getJob(d, done.verification.job_id);
  assert.equal(follow.status, 'succeeded', 'the follow-up ran in the same drain');
  assert.equal(parseJson(follow.verification_json).state, 'app_healthy', 'no guard is resolvable in this harness (no registry): the credential rungs are deferred by name, never assumed');
  assert.match(parseJson(follow.verification_json).deferredReason || '', /guard|not applicable|no data guard/i);
  // Busy: a deploy job open → refused before any change.
  createJob(d, { kind: 'deploy', app: 'pp-x', plan: { params: PARAMS() }, nowMs: T0 });
  const t3 = parse(await tools.restore_project_db({ project_id: 1, file: 'app-mcp-1.sql' }, AUTH));
  const busy = parse(await tools.restore_project_db({ project_id: 1, file: 'app-mcp-1.sql', confirmation_token: t3.confirmation_token }, AUTH));
  assert.match(busy.error, /deploy job .* is queued for pp-x — the restore was refused before any change/);
  noValueIn(d, [done.job_id], [KEY, LOGIN.password]);
});

test('MCP restore_snapshot: the confirmation covers accept_partial and the snapshot; a guest with custom volumes is refused in the plan and restored root-only when accepted; the restore runs through the executor with argv to incus', async (t) => {
  const d = db();
  const inst = instanceOf({ expanded_devices: { root: { type: 'disk', path: '/', pool: 'default' }, data: { type: 'disk', path: '/srv/data', pool: 'tank', source: 'vol-data' } } });
  const st = { instance: inst }; const h = scriptedHost(st); const g = restoreGuest({ ldaps: 'current' });
  configureContainerLockStore({ getDb: () => d, owner: BACKEND, env: { SETUP_EXECUTOR_POLICY: 'backend-allowed' }, guestExec: exec(g, h), hostExec: h.host, reviewLogin: async () => LOGIN });
  t.after(() => configureContainerLockStore(null));
  const tools = createExtendedHandlers(mcpCtx({ instance: inst }).ctx).handlers;
  const dry = parse(await tools.restore_snapshot({ container: 'x', snapshot: 'snap-1', dry_run: true }, AUTH));
  assert.deepEqual(dry.would.coverage.custom_volumes_not_restored.map((v) => v.device), ['data']);
  assert.match(dry.would.refusal, /pass accept_partial: true/);
  assert.match(parse(await tools.restore_snapshot({ container: 'x', snapshot: 'nope' }, AUTH)).error, /does not exist/);
  const t1 = parse(await tools.restore_snapshot({ container: 'x', snapshot: 'snap-1' }, AUTH));
  // The token for the plan WITHOUT accept_partial cannot confirm the plan WITH it.
  const wrong = parse(await tools.restore_snapshot({ container: 'x', snapshot: 'snap-1', accept_partial: true, confirmation_token: t1.confirmation_token }, AUTH));
  assert.match(wrong.error, /different target/);
  const t2 = parse(await tools.restore_snapshot({ container: 'x', snapshot: 'snap-1' }, AUTH));
  const refused = parse(await tools.restore_snapshot({ container: 'x', snapshot: 'snap-1', confirmation_token: t2.confirmation_token }, AUTH));
  assert.match(refused.error, /custom storage volume\(s\) attached .* refusing rather than claiming a complete restore/);
  assert.equal(h.calls.filter((a) => a[1] === 'snapshot').length, 0, 'nothing was taken or restored');
  const t3 = parse(await tools.restore_snapshot({ container: 'x', snapshot: 'snap-1', accept_partial: true }, AUTH));
  assert.match(t3.action, /the attached custom volumes are NOT restored/);
  const done = parse(await tools.restore_snapshot({ container: 'x', snapshot: 'snap-1', accept_partial: true, confirmation_token: t3.confirmation_token }, AUTH));
  assert.equal(done.restored, true, JSON.stringify(done)); assert.equal(done.complete, false);
  assert.deepEqual(done.custom_volumes_not_restored.map((v) => v.device), ['data']);
  assert.match(done.pre_restore_snapshot, /^pp-pre-restore-/); assert.match(done.reverse_with, /accept_partial: true/);
  assert.deepEqual(h.calls.find((a) => a[2] === 'restore'), ['incus', 'snapshot', 'restore', 'pp-x', 'snap-1']);
  assert.equal(getJob(d, done.job_id).status, 'succeeded');
  assert.equal(st.restoredTo, 'snap-1');
});

// ── 6. the runner's host channel (real process) ───────────────────────────

test('the runner\'s host channel spawns one argv array directly — never a shell — and refuses anything else', async () => {
  const ex = hostGuestExec();
  const r = await ex.host(['sh', '-c', 'echo "a b"; echo err >&2; exit 3'], { timeoutMs: 5000 });
  assert.equal(r.code, 3); assert.equal(r.stdout, 'a b\n'); assert.equal(r.stderr, 'err\n');
  const meta = await ex.host(['printf', '%s', 'x; echo injected'], { timeoutMs: 5000 });
  assert.equal(meta.stdout, 'x; echo injected', 'an argument with shell metacharacters is one argument');
  assert.equal((await ex.host('incus snapshot restore x y')).code, -1);
  assert.equal((await ex.host(['incus', 5])).code, -1);
  assert.equal((await ex.host(['/nonexistent/binary'])).code, -1);
  const slow = await ex.host(['sleep', '5'], { timeoutMs: 200 });
  assert.equal(slow.code, 124);
});

test('planDigest is canonical: key order does not matter, any value does', () => {
  assert.equal(planDigest({ a: 1, b: { c: [1, 2] } }), planDigest({ b: { c: [1, 2] }, a: 1 }));
  assert.notEqual(planDigest({ a: 1, accept_partial: false }), planDigest({ a: 1, accept_partial: true }));
  assert.match(DUMP_NAME_RE.source, /app-/);
});
