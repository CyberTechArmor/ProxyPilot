// Git remotes for projects, static sites and LXC containers — the PURE layer
// (git-logic.js additions) and the auto-push scheduler. Native-free (risk R9):
// the mirror script and the ensure-repo plan are strings/objects; the push
// itself is exercised against a stub.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MIRROR_TARGET_KINDS, PUSH_MODES, normalizePushMode, validateTargetRef, validateSourceDir,
  publicTargetRemoteShape, parseRemoteRepoRef, buildTokenPushUrl, remoteRepoWebUrl,
  gitEnsureRepoPlan, hostPathForDocroot, mirrorSnapshotScript, docrootExportCmd, lxcExportCmd,
  parseMirrorSnapshotOutput, shq, MIRROR_EXCLUDES,
} from '../mock2/git-logic.js';
import { scheduleAutoPush, shouldAutoPush, _resetAutoPush } from '../mock2/git-push-hooks.js';
import { emitContentChanged, onContentChanged, _resetContentListeners } from '../lib/change-events.js';
import { MCP_TOOLS, MCP_SERVER_INSTRUCTIONS } from '../lib/mcp-logic.js';

const gitea = { provider: 'gitea', base_url: 'https://git.fractionate.ai', auth_kind: 'token' };
const github = { provider: 'github', base_url: null, auth_kind: 'token' };

test('target refs: kinds, container names and site ids are validated; modes normalize', () => {
  assert.deepEqual([...MIRROR_TARGET_KINDS], ['static_site', 'lxc']);
  assert.deepEqual([...PUSH_MODES], ['manual', 'auto']);
  assert.equal(validateTargetRef('lxc', 'cpr-starter'), null);
  assert.equal(validateTargetRef('static_site', '4d10bffc-eb9d-4b29-846e-bece2b510860'), null);
  assert.match(validateTargetRef('project', '1'), /kind must be/);
  assert.match(validateTargetRef('lxc', '-bad'), /container name/);
  assert.match(validateTargetRef('lxc', ''), /required/);
  assert.equal(normalizePushMode('AUTO'), 'auto');
  assert.equal(normalizePushMode('whatever'), 'manual');
  assert.equal(validateSourceDir(''), null);
  assert.equal(validateSourceDir('/opt/app'), null);
  assert.match(validateSourceDir('opt/app'), /absolute/);
  assert.match(validateSourceDir('/'), /cannot be/);
  assert.match(validateSourceDir('/opt/../etc'), /cannot be/);
  assert.match(validateSourceDir('/opt/$(x)'), /not allowed/);
});

test('publicTargetRemoteShape never leaks more than the row\'s public columns', () => {
  const s = publicTargetRemoteShape({ kind: 'lxc', target_id: 'web', git_connector_id: 3, remote_repo: 'fractionate/web', push_mode: 'auto', source_dir: '/opt/app', last_push_at: 'x', last_push_error: null, last_pushed_commit: 'abc', created_by: 1, created_at: 'y', secret: 'no' });
  assert.deepEqual(Object.keys(s).sort(), ['git_connector_id', 'kind', 'last_push_at', 'last_push_error', 'last_pushed_commit', 'push_mode', 'remote_repo', 'source_dir', 'target_id']);
  assert.equal(publicTargetRemoteShape(null), null);
});

test('remote repo refs: owner/name, .git, full https and ssh URLs', () => {
  assert.deepEqual(parseRemoteRepoRef('fractionate/site'), { owner: 'fractionate', name: 'site' });
  assert.deepEqual(parseRemoteRepoRef('fractionate/site.git'), { owner: 'fractionate', name: 'site' });
  assert.deepEqual(parseRemoteRepoRef('https://git.fractionate.ai/mock2/mock2-core.git'), { owner: 'mock2', name: 'mock2-core' });
  assert.deepEqual(parseRemoteRepoRef('git@git.fractionate.ai:mock2/mock2-core.git'), { owner: 'mock2', name: 'mock2-core' });
  assert.equal(parseRemoteRepoRef('just-a-name'), null);
  assert.equal(parseRemoteRepoRef('a/b/c'), null);
});

test('token push URL: gitea needs a base URL, github defaults, the token is URL-encoded and never in a persisted field', () => {
  assert.equal(buildTokenPushUrl(gitea, 'fractionate/site', 'tok/en'), 'https://tok%2Fen@git.fractionate.ai/fractionate/site.git');
  assert.equal(buildTokenPushUrl(github, 'org/repo', 't'), 'https://t@github.com/org/repo.git');
  assert.equal(buildTokenPushUrl({ provider: 'gitea', base_url: null }, 'o/r', 't'), null);
  assert.equal(buildTokenPushUrl(gitea, 'https://user@example.com/o/r.git', 't'), 'https://t@example.com/o/r.git');
  assert.equal(remoteRepoWebUrl(gitea, 'fractionate/site'), 'https://git.fractionate.ai/fractionate/site');
  assert.equal(remoteRepoWebUrl(github, 'o/r'), 'https://github.com/o/r');
  assert.equal(remoteRepoWebUrl({ provider: 'generic_https' }, 'o/r'), null);
});

test('ensure-repo plan: lookup + user/org create for gitea and github; none for ssh/generic', () => {
  const p = gitEnsureRepoPlan(gitea, 'fractionate/site', { token: 'T' });
  assert.equal(p.lookup.url, 'https://git.fractionate.ai/api/v1/repos/fractionate/site');
  assert.equal(p.whoami.url, 'https://git.fractionate.ai/api/v1/user');
  assert.equal(p.createAsUser.url, 'https://git.fractionate.ai/api/v1/user/repos');
  assert.equal(p.createInOrg.url, 'https://git.fractionate.ai/api/v1/orgs/fractionate/repos');
  assert.equal(p.lookup.headers.authorization, 'token T');
  assert.equal(JSON.parse(p.createInOrg.body).private, true);
  assert.equal(JSON.parse(p.createInOrg.body).default_branch, 'main');
  assert.equal(p.ownerIsUser, null);
  assert.equal(gitEnsureRepoPlan(gitea, 'fractionate/site', { token: 'T', tokenLogin: 'Fractionate' }).ownerIsUser, true);
  const g = gitEnsureRepoPlan(github, 'org/repo', { token: 'T', isPrivate: false });
  assert.equal(g.lookup.url, 'https://api.github.com/repos/org/repo');
  assert.equal(g.createInOrg.url, 'https://api.github.com/orgs/org/repos');
  assert.equal(JSON.parse(g.createAsUser.body).private, false);
  assert.equal(gitEnsureRepoPlan({ provider: 'generic_ssh', auth_kind: 'ssh_key' }, 'o/r', {}), null);
  assert.equal(gitEnsureRepoPlan({ provider: 'gitea', auth_kind: 'token', base_url: '' }, 'o/r', {}), null);
  assert.equal(gitEnsureRepoPlan(gitea, 'nope', { token: 'T' }), null);
});

test('docroot host-path mapping mirrors the Caddy renderer\'s translation', () => {
  assert.equal(hostPathForDocroot('/data/services/x', { servicesDataDir: '/data/services', caddyStaticRoot: '/opt/proxypilot/data/services' }), '/opt/proxypilot/data/services/x');
  assert.equal(hostPathForDocroot('/data/services/x', { servicesDataDir: '/data/services', caddyStaticRoot: null }), '/data/services/x');
  assert.equal(hostPathForDocroot('/var/www/other', { servicesDataDir: '/data/services', caddyStaticRoot: '/opt/x' }), '/var/www/other');
  assert.equal(hostPathForDocroot('', {}), null);
});

test('mirror snapshot script: bare mirror, fresh index, no-change detection, quoted paths, excludes', () => {
  const s = mirrorSnapshotScript({ gitDir: "/var/lib/proxypilot/mock2/git-mirrors/lxc/it's.git", exportCmd: 'tar -C /x -cf - .', message: 'ProxyPilot: zip applied' });
  assert.match(s, /git init -q --bare -b main '\/var\/lib\/proxypilot\/mock2\/git-mirrors\/lxc\/it'\\''s\.git'/);
  assert.match(s, /tar -C \/x -cf - \. \| tar -xf - -C "\$WT"/);
  assert.match(s, /rm -f "\$GIT_DIR\/index"/);
  assert.match(s, /PP_NOCHANGE:/);
  assert.match(s, /git commit -q -m 'ProxyPilot: zip applied'/);
  assert.match(s, /trap 'rm -rf "\$WT"' EXIT/);
  assert.equal(shq("a'b"), `'a'\\''b'`);
  const d = docrootExportCmd('/opt/proxypilot/data/services/site');
  assert.match(d, /^tar -C '\/opt\/proxypilot\/data\/services\/site' /);
  for (const ex of ['node_modules', '.git', '.env', '*.pem']) assert.ok(d.includes(`--exclude='${ex}'`), `missing exclude ${ex}`);
  assert.ok(MIRROR_EXCLUDES.includes('.pp-zip-stage-*'));
  const l = lxcExportCmd('pp-web', '/opt/app');
  assert.match(l, /^incus exec 'pp-web' -- tar -C '\/opt\/app' /);
  assert.match(l, /--warning=no-file-changed -cf - \.$/);
  assert.deepEqual(parseMirrorSnapshotOutput('noise\nPP_COMMIT:abcdef1234\n'), { commit: 'abcdef1234', changed: true });
  assert.deepEqual(parseMirrorSnapshotOutput('PP_NOCHANGE:abcdef1'), { commit: 'abcdef1', changed: false });
  assert.equal(parseMirrorSnapshotOutput('fatal: nope'), null);
});

test('auto-push: only auto-mode remotes schedule, bursts collapse into one push with joined reasons', async () => {
  _resetAutoPush();
  const pushes = [];
  const timers = [];
  const setTimer = (fn) => { timers.push(fn); return timers.length; };
  const clearTimer = () => { timers.length = 0; };
  const lookup = (kind, id) => (id === 'auto' ? { push_mode: 'auto' } : id === 'manual' ? { push_mode: 'manual' } : null);
  const push = async (kind, id, opts) => { pushes.push({ kind, id, ...opts }); return { ok: true }; };
  assert.equal(shouldAutoPush({ push_mode: 'auto' }), true);
  assert.equal(shouldAutoPush({ push_mode: 'manual' }), false);
  assert.equal(shouldAutoPush(null), false);
  assert.equal(scheduleAutoPush({ kind: 'lxc', id: 'manual', reason: 'x' }, { lookup, push, setTimer, clearTimer }), false);
  assert.equal(scheduleAutoPush({ kind: 'lxc', id: 'none', reason: 'x' }, { lookup, push, setTimer, clearTimer }), false);
  assert.equal(scheduleAutoPush({ kind: 'lxc', id: 'auto', reason: 'zip applied', actor: 'thomas' }, { lookup, push, setTimer, clearTimer }), true);
  assert.equal(scheduleAutoPush({ kind: 'lxc', id: 'auto', reason: 'file written' }, { lookup, push, setTimer, clearTimer }), true);
  assert.equal(timers.length, 1, 'the second event replaced the first timer');
  await timers[0]();
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0].reason, 'zip applied, file written');
  assert.equal(pushes[0].actor, 'thomas');
  _resetAutoPush();
});

test('the core change-event seam is best-effort and carries kind/id/reason', () => {
  _resetContentListeners();
  const seen = [];
  onContentChanged(() => { throw new Error('boom'); });
  onContentChanged((e) => seen.push(e));
  emitContentChanged({ kind: 'static_site', id: 'abc', reason: 'file saved', actor: 'u' });
  emitContentChanged({ kind: '', id: 'abc' }); // ignored
  assert.equal(seen.length, 1);
  assert.equal(seen[0].kind, 'static_site');
  assert.equal(seen[0].reason, 'file saved');
  assert.ok(seen[0].at);
  _resetContentListeners();
});

test('MCP exposes the three git-remote tools and the instructions point at them', () => {
  const byName = new Map(MCP_TOOLS.map((t) => [t.name, t]));
  for (const n of ['list_git_connectors', 'set_git_remote', 'push_git_remote']) assert.ok(byName.has(n), `missing tool ${n}`);
  assert.deepEqual(byName.get('set_git_remote').inputSchema.required, ['kind', 'target', 'remote_repo']);
  assert.deepEqual(byName.get('set_git_remote').inputSchema.properties.kind.enum, ['project', 'static_site', 'lxc']);
  assert.match(MCP_SERVER_INSTRUCTIONS, /set_git_remote/);
});
