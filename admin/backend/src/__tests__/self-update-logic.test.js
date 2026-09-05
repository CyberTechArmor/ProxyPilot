// lib/self-update-logic.js — pure, native-free. Pins the version compare, the
// "update available" decision, the flag allowlist (mirrors the agent's and
// the runner's), the refusal reasons the Update button shows, state parsing
// and the phase list, which is checked against update.sh's own markers.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  UPDATE_FLAGS, UPDATE_PHASES, MCP_RUN_CONFIRM_MESSAGE,
  compareVersions, normalizeVersion, validateUpdateFlags, flagsFromOptions, sanitizeRequestedBy,
  mapAgentErrorToHttp, shapeInstalled, decideUpdate, updateStartRefusal, parseState, phaseList,
  buildProgress, buildVersionCheck, shouldRecordCompletedUpdate, stripAnsi, isUpdateId,
} from '../lib/self-update-logic.js';

const ID = '11111111-2222-4333-8444-555555555555';

test('compareVersions: numeric dotted compare, v prefix and missing parts tolerated', () => {
  const cases = [
    ['1.4.0', '1.4.0', 0], ['v1.4.0', '1.4.0', 0], ['1.4.10', '1.4.9', 1], ['1.4', '1.4.0', 0],
    ['1.5.0-rc1', '1.4.9', 1], ['2.0.0', '1.99.99', 1], ['1.4.0', '1.4.1', -1], ['', '', 0], [null, '1.0.0', -1],
  ];
  for (const [a, b, want] of cases) assert.equal(compareVersions(a, b), want, `${a} vs ${b}`);
  assert.equal(normalizeVersion(' v1.4.0 '), '1.4.0');
  assert.equal(normalizeVersion(42), '');
});

test('flags: only --rebuild and --enable-mock2, deduplicated; --discard-local is never allowed', () => {
  assert.deepEqual([...UPDATE_FLAGS], ['--rebuild', '--enable-mock2']);
  assert.deepEqual(validateUpdateFlags(undefined), { ok: true, flags: [] });
  assert.deepEqual(validateUpdateFlags(['--rebuild', '--rebuild', '--enable-mock2']), { ok: true, flags: ['--rebuild', '--enable-mock2'] });
  assert.equal(validateUpdateFlags(['--discard-local']).ok, false);
  assert.equal(validateUpdateFlags(['--rebuild; reboot']).ok, false);
  assert.equal(validateUpdateFlags('--rebuild').ok, false);
  assert.deepEqual(flagsFromOptions(), []);
  assert.deepEqual(flagsFromOptions({ rebuild: true }), ['--rebuild']);
  assert.deepEqual(flagsFromOptions({ rebuild: true, enableMock2: true }), ['--rebuild', '--enable-mock2']);
});

test('sanitizeRequestedBy squeezes into the runner-safe character class', () => {
  assert.equal(sanitizeRequestedBy('admin'), 'admin');
  assert.equal(sanitizeRequestedBy('Thomas van Dijk'), 'Thomas_van_Dijk');
  assert.equal(sanitizeRequestedBy('mcp:' + ID), 'mcp:' + ID);
  assert.equal(sanitizeRequestedBy('x'.repeat(200)).length, 80);
  assert.equal(sanitizeRequestedBy(''), 'admin');
  assert.equal(sanitizeRequestedBy(null, 'user'), 'user');
});

test('agent error codes map to 409 / 400 / 502', () => {
  assert.equal(mapAgentErrorToHttp('update_in_progress'), 409);
  assert.equal(mapAgentErrorToHttp('update_pending'), 409);
  assert.equal(mapAgentErrorToHttp('invalid_params'), 400);
  assert.equal(mapAgentErrorToHttp('agent_unreachable'), 502);
  assert.equal(mapAgentErrorToHttp(undefined), 502);
});

test('shapeInstalled: agent facts → the dashboard shape; unreachable → empty + error', () => {
  const inst = shapeInstalled({
    configured: true, fresh: true, pending: false, source_dir: '/root/ProxyPilot', branch: 'main',
    head_sha: 'abcdef1234567890', head_short: 'abcdef1234', head_date: '2026-09-05T10:00:00Z', head_subject: 'x',
    remote_url: 'https://github.com/CyberTechArmor/ProxyPilot', dirty: true, dirty_count: 2, dirty_files: [' M a.js', '?? b'],
    installed_version: '1.4.0', checked_at: '2026-09-05T10:00:01Z', agent_version: 'abc',
  });
  assert.equal(inst.reachable, true);
  assert.equal(inst.sha, 'abcdef1234567890');
  assert.equal(inst.short_sha, 'abcdef1234');
  assert.equal(inst.dirty, true);
  assert.equal(inst.dirty_count, 2);
  assert.equal(inst.checkout_version, '1.4.0');
  assert.equal(inst.agent_version, 'abc');
  // short sha derived when the runner did not record one
  assert.equal(shapeInstalled({ configured: true, head_sha: 'abcdef1234567890' }).short_sha, 'abcdef1234');
  const down = shapeInstalled(null, { reachable: false, error: 'ECONNREFUSED' });
  assert.equal(down.reachable, false);
  assert.equal(down.configured, false);
  assert.equal(down.sha, null);
  assert.equal(down.error, 'ECONNREFUSED');
});

test('decideUpdate: release, commit, up to date, unknown; standards by version', () => {
  assert.deepEqual(decideUpdate({ installed: { version: '1.4.0', sha: 'a' }, latest: { version: '1.5.0', sha: 'b' } }).code, { available: true, reason: 'newer_release' });
  assert.deepEqual(decideUpdate({ installed: { version: '1.4.0', sha: 'a' }, latest: { version: '1.4.0', sha: 'b' } }).code, { available: true, reason: 'newer_commit' });
  assert.deepEqual(decideUpdate({ installed: { version: '1.4.0', sha: 'a' }, latest: { version: '1.4.0', sha: 'a' } }).code, { available: false, reason: 'up_to_date' });
  assert.deepEqual(decideUpdate({ installed: { version: '1.4.0' }, latest: { version: '1.4.0' } }).code, { available: false, reason: 'up_to_date' });
  assert.deepEqual(decideUpdate({ installed: { version: '1.4.0' }, latest: {} }).code, { available: false, reason: 'unknown' });
  // A newer local version than the release is not "behind".
  assert.equal(decideUpdate({ installed: { version: '1.5.0' }, latest: { version: '1.4.0' } }).updateAvailable, false);
  const st = decideUpdate({ standards: { seed_version: '0.3.0', site_version: '0.4.0' } }).standards;
  assert.deepEqual(st, { available: true, seed_version: '0.3.0', site_version: '0.4.0' });
  assert.equal(decideUpdate({ standards: { seed_version: '0.3.0', site_version: '0.3.0' } }).standards.available, false);
  assert.equal(decideUpdate({ standards: { seed_version: '0.3.0', site_version: null } }).standards.available, false);
});

test('updateStartRefusal names the one thing blocking the run, or nothing', () => {
  const ok = shapeInstalled({ configured: true, head_sha: 'a', dirty: false });
  assert.equal(updateStartRefusal({ installed: ok }), null);
  assert.match(updateStartRefusal({ installed: ok, policyEnabled: false }), /disabled on this host/);
  assert.match(updateStartRefusal({ installed: shapeInstalled(null, { reachable: false }) }), /agent .*unreachable/);
  assert.match(updateStartRefusal({ installed: shapeInstalled({ configured: false }) }), /No ProxyPilot git checkout/);
  assert.match(updateStartRefusal({ installed: shapeInstalled({ configured: false, error: 'custom reason' }) }), /custom reason/);
  const dirty = updateStartRefusal({ installed: shapeInstalled({ configured: true, dirty: true, dirty_count: 2, dirty_files: [' M update.sh', '?? notes.txt'] }) });
  assert.match(dirty, /2 uncommitted local changes/);
  assert.match(dirty, /M update\.sh/);
  assert.match(dirty, /refuses to run over local changes/);
  assert.match(updateStartRefusal({ installed: ok, progress: { status: 'success', pending: true } }), /already waiting/);
  assert.match(updateStartRefusal({ installed: ok, progress: { status: 'running', phase: 'Pulling latest code', live: true } }), /already running \(Pulling latest code\)/);
  // A run stuck "running" for over an hour no longer blocks.
  assert.equal(updateStartRefusal({ installed: ok, progress: { status: 'running', live: false } }), null);
  assert.equal(updateStartRefusal({ installed: ok, progress: { status: 'failed' } }), null);
});

test('parseState: statuses, terminal/live/stale, defaults', () => {
  const now = Date.parse('2026-09-05T12:00:00Z');
  const running = parseState({ id: ID, status: 'running', phase: 'Pulling latest code', phase_index: 2, started_at_unix: now / 1000 - 60, log: '/var/lib/proxypilot/update/x.log' }, { nowMs: now });
  assert.equal(running.terminal, false);
  assert.equal(running.live, true);
  assert.equal(running.stale, false);
  assert.equal(running.log_path, '/var/lib/proxypilot/update/x.log');
  const stale = parseState({ id: ID, status: 'running', started_at_unix: now / 1000 - 7200 }, { nowMs: now });
  assert.equal(stale.live, false);
  assert.equal(stale.stale, true);
  const done = parseState({ id: ID, status: 'success', exit_code: 0, up_to_date: true, finished_at: '2026-09-05T12:00:00Z' });
  assert.equal(done.terminal, true);
  assert.equal(done.up_to_date, true);
  assert.equal(done.exit_code, 0);
  assert.equal(parseState(null).status, 'idle');
  assert.equal(parseState({ status: 'refused', reason: 'stale: request is 500s old' }).reason, 'stale: request is 500s old');
});

test('phaseList follows the [n/7] index: done before, active at, pending after; failed marks the phase', () => {
  const running = phaseList(parseState({ status: 'running', phase_index: 3.5 }));
  assert.deepEqual(running.map((p) => p.state), ['done', 'done', 'done', 'done', 'active', 'pending', 'pending', 'pending', 'pending']);
  assert.ok(phaseList(parseState({ status: 'success', phase_index: 7 })).every((p) => p.state === 'done'));
  const failed = phaseList(parseState({ status: 'failed', phase_index: 6 }));
  assert.equal(failed.find((p) => p.index === 6).state, 'failed');
  assert.equal(failed.find((p) => p.index === 7).state, 'pending');
  assert.equal(failed.find((p) => p.index === 5).state, 'done');
});

test('UPDATE_PHASES matches the [n/7] markers update.sh actually prints', () => {
  const sh = readFileSync(new URL('../../../../update.sh', import.meta.url), 'utf8');
  const markers = new Set();
  for (const m of sh.matchAll(/log "\$\{BLUE\}\[([0-9.]+)\/7\]/g)) markers.add(Number(m[1]));
  const listed = UPDATE_PHASES.map((p) => p.index);
  assert.deepEqual([...markers].sort((a, b) => a - b), listed, 'every phase update.sh logs is in the UI list, and nothing else');
});

test('buildProgress: agent payload → progress with stripped log tail and phases', () => {
  const p = buildProgress({
    agentStatus: { id: ID, status: 'running', phase: 'Building frontend', phase_index: 6, started_at_unix: Date.now() / 1000 - 30, log_tail: '\x1b[0;34m[6/7] Building frontend...\x1b[0m\nvite v5', log_truncated: true, log_total_bytes: 99999, pending: false, id_match: true, agent_version: 'abc' },
  });
  assert.equal(p.agent.reachable, true);
  assert.equal(p.agent.source, 'agent');
  assert.equal(p.agent.version, 'abc');
  assert.equal(p.log_tail, '[6/7] Building frontend...\nvite v5');
  assert.equal(p.log_truncated, true);
  assert.equal(p.id_match, true);
  assert.equal(p.phases.find((x) => x.index === 6).state, 'active');
  const file = buildProgress({ agentStatus: { id: ID, status: 'success' }, reachable: false, source: 'file', error: 'ECONNREFUSED' });
  assert.equal(file.agent.reachable, false);
  assert.equal(file.agent.source, 'file');
  assert.equal(file.agent.error, 'ECONNREFUSED');
  assert.equal(file.id_match, null);
  assert.equal(stripAnsi('a\x1b[1;32mb\x1b[0mc'), 'abc');
});

test('buildVersionCheck composes the /version/check payload', () => {
  const installed = shapeInstalled({ configured: true, branch: 'main', head_sha: 'aaaaaaaaaa1111', dirty: false, agent_version: 'v1' });
  const out = buildVersionCheck({
    currentVersion: '1.4.0', repo: 'CyberTechArmor/ProxyPilot',
    release: { version: '1.5.0', tag: 'v1.5.0', url: 'https://github.com/x/releases/v1.5.0', notes: 'notes', published_at: '2026-09-01T00:00:00Z' },
    mainCommit: { sha: 'bbbbbbbbbb2222', date: '2026-09-04T00:00:00Z', branch: 'main' }, commitsBehind: 3,
    installed, standards: { seed_version: '0.3.0', site_version: '0.4.0', changelog: [{ v: '0.4.0' }] },
    github: { error: null }, checkedAt: '2026-09-05T00:00:00Z', cached: true,
  });
  assert.equal(out.currentVersion, '1.4.0');
  assert.equal(out.latestVersion, '1.5.0');
  assert.equal(out.updateAvailable, true);
  assert.equal(out.updateReason, 'newer_release');
  assert.equal(out.releaseNotes, 'notes');
  assert.equal(out.latest_sha_short, 'bbbbbbbbbb');
  assert.equal(out.commits_behind, 3);
  assert.equal(out.installed.sha, 'aaaaaaaaaa1111');
  assert.deepEqual([out.standards.seed_version, out.standards.site_version, out.standards.update_available], ['0.3.0', '0.4.0', true]);
  assert.equal(out.standards.site, 'https://mock2.fractionate.ai');
  assert.deepEqual(out.agent, { reachable: true, version: 'v1' });
  assert.equal(out.canUpdate, true);
  assert.equal(out.cannotUpdateReason, null);
  assert.equal(out.cached, true);

  // No release → package.json fallback version; dirty → cannot update; GitHub error is a field.
  const dirty = shapeInstalled({ configured: true, head_sha: 'a', dirty: true, dirty_count: 1, dirty_files: [' M x'] });
  const out2 = buildVersionCheck({ currentVersion: '1.4.0', repo: 'o/r', installed: dirty, github: { error: 'releases: HTTP 500', fallbackVersion: '1.4.1' } });
  assert.equal(out2.latestVersion, '1.4.1');
  assert.equal(out2.updateAvailable, true);
  assert.equal(out2.canUpdate, false);
  assert.match(out2.cannotUpdateReason, /uncommitted local change/);
  assert.equal(out2.github.error, 'releases: HTTP 500');
  assert.equal(out2.releaseUrl, 'https://github.com/o/r');
  // Nothing known at all: not available, not an error.
  const out3 = buildVersionCheck({ currentVersion: '1.4.0', repo: null, installed: shapeInstalled(null, { reachable: false }) });
  assert.equal(out3.latestVersion, '1.4.0');
  assert.equal(out3.updateAvailable, false);
  assert.equal(out3.canUpdate, false);
  assert.match(out3.cannotUpdateReason, /unreachable/);
});

test('shouldRecordCompletedUpdate: success, within the window, not yet recorded', () => {
  const now = Date.parse('2026-09-05T12:00:00Z');
  const fresh = { id: ID, status: 'success', finished_at: '2026-09-05T11:50:00Z' };
  assert.equal(shouldRecordCompletedUpdate({ progress: fresh, lastRecordedId: null, nowMs: now }), true);
  assert.equal(shouldRecordCompletedUpdate({ progress: fresh, lastRecordedId: ID, nowMs: now }), false);
  assert.equal(shouldRecordCompletedUpdate({ progress: { ...fresh, finished_at: '2026-09-05T09:00:00Z' }, nowMs: now }), false);
  assert.equal(shouldRecordCompletedUpdate({ progress: { ...fresh, status: 'failed' }, nowMs: now }), false);
  assert.equal(shouldRecordCompletedUpdate({ progress: { ...fresh, id: 'unknown' }, nowMs: now }), false);
  assert.equal(shouldRecordCompletedUpdate({ progress: null, nowMs: now }), false);
  assert.equal(isUpdateId(ID), true);
  assert.equal(isUpdateId('../x'), false);
});

test('the MCP confirm message names the downtime and the exact re-call', () => {
  assert.match(MCP_RUN_CONFIRM_MESSAGE, /1–2 minutes/);
  assert.match(MCP_RUN_CONFIRM_MESSAGE, /confirm: true/);
  assert.match(MCP_RUN_CONFIRM_MESSAGE, /rebuild: true/);
});
