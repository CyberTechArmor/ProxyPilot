// LXC workspace — the pure decision layer (lib/lxc-workspace-logic.js): the
// absolute-root guard, the root+relative join every workspace endpoint funnels
// through, and the default-root pick. Stub-first: imports only native-free logic.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validAbsDir, joinWorkspacePath, pickDefaultRoot, buildRootProbeScript, parseRootProbeOutput,
  DEFAULT_ROOT_CANDIDATES, FALLBACK_ROOT,
} from '../lib/lxc-workspace-logic.js';

test('validAbsDir: absolute dirs only; trailing slashes stripped; traversal/control chars refused', () => {
  assert.equal(validAbsDir('/opt/app'), '/opt/app');
  assert.equal(validAbsDir('/opt/app/'), '/opt/app');
  assert.equal(validAbsDir('/'), '/');
  assert.equal(validAbsDir('///'), '/');
  assert.equal(validAbsDir('/var/www/my site'), '/var/www/my site'); // spaces ride argv, fine
  assert.equal(validAbsDir('opt/app'), null);
  assert.equal(validAbsDir('/opt/../etc'), null);
  assert.equal(validAbsDir('/opt/a\np'), null);
  assert.equal(validAbsDir('/opt/a\0b'), null);
  assert.equal(validAbsDir(''), null);
  assert.equal(validAbsDir(null), null);
  // A directory whose NAME contains two dots is not traversal.
  assert.equal(validAbsDir('/opt/app..old'), '/opt/app..old');
});

test('joinWorkspacePath: root + safe relative → absolute; unsafe parts → null', () => {
  assert.equal(joinWorkspacePath('/opt/app', 'src/index.js'), '/opt/app/src/index.js');
  assert.equal(joinWorkspacePath('/opt/app/', './src//index.js'), '/opt/app/src/index.js');
  assert.equal(joinWorkspacePath('/', 'etc/hosts'), '/etc/hosts');
  // Escaping the root is refused however it is spelled.
  assert.equal(joinWorkspacePath('/opt/app', '../etc/passwd'), null);
  assert.equal(joinWorkspacePath('/opt/app', 'src/../../x'), null);
  assert.equal(joinWorkspacePath('/opt/app', '/etc/passwd'), null);
  assert.equal(joinWorkspacePath('opt/app', 'x'), null);
  // The root itself only when asked for (tree), never for file endpoints.
  assert.equal(joinWorkspacePath('/opt/app', '.'), null);
  assert.equal(joinWorkspacePath('/opt/app', ''), null);
  assert.equal(joinWorkspacePath('/opt/app', '.', { allowRoot: true }), '/opt/app');
});

test('pickDefaultRoot: startup working dir wins; else first existing candidate; else /root', () => {
  assert.equal(pickDefaultRoot({ startupWorkingDir: '/srv/myapp', existing: ['/opt/app'] }), '/srv/myapp');
  assert.equal(pickDefaultRoot({ startupWorkingDir: 'relative', existing: ['/srv/app'] }), '/srv/app');
  assert.equal(pickDefaultRoot({ existing: ['/root', '/var/www', '/srv/app'] }), '/srv/app');
  assert.equal(pickDefaultRoot({ existing: ['/root'] }), '/root');
  assert.equal(pickDefaultRoot({}), FALLBACK_ROOT);
  assert.equal(pickDefaultRoot({ existing: ['/opt/app/'] }), '/opt/app');
  assert.equal(DEFAULT_ROOT_CANDIDATES[0], '/opt/app');
});

test('root probe: script names every candidate; output parses to existing dirs only', () => {
  const script = buildRootProbeScript();
  for (const c of DEFAULT_ROOT_CANDIDATES) assert.ok(script.includes(`[ -d '${c}' ]`));
  assert.ok(script.endsWith('; true'), 'a missing candidate must not fail the probe');
  assert.deepEqual(parseRootProbeOutput('/opt/app\n/root\n'), ['/opt/app', '/root']);
  assert.deepEqual(parseRootProbeOutput('garbage\n\n'), []);
  assert.deepEqual(parseRootProbeOutput(''), []);
});
