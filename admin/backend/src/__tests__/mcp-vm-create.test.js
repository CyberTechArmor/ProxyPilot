import test from 'node:test';
import assert from 'node:assert/strict';
import { mcpGuestCreateOptions } from '../lib/mcp-logic.js';
import { lifecycleArgv } from '../lib/setup-engine/lifecycle-logic.js';

test('MCP VM plan reaches Incus as a VM without container privileges or guest API', () => {
  const options = mcpGuestCreateOptions({ vm: true, cpu: 1, memory_gb: 0.5,
    disk_gb: 4, autostart: false });
  assert.equal(options.error, undefined);
  const argv = lifecycleArgv('instance_create', { container: 'pp-a3-test',
    image: 'images:debian/12', profile: 'default', vm: options.isVm,
    config: options.config, rootSize: `${options.diskGb}GiB` });
  assert.deepEqual(argv, ['incus', 'launch', 'images:debian/12', 'pp-a3-test',
    '--profile', 'default', '--config', 'security.nesting=false',
    '--config', 'security.guestapi=false', '--config', 'limits.cpu=1',
    '--config', 'limits.memory=512MiB', '--config', 'boot.autostart=false', '--vm']);
  assert.equal(options.dockerReady, false);
  assert.match(mcpGuestCreateOptions({ vm: true, docker_ready: true }).error, /cannot be enabled/);
});
