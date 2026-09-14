// Terminal PTY argv (lib/pty-logic.js): the LXC shell applies its starting
// directory INSIDE the guest. Regression for the Workspace terminal opening
// with `chdir(2) failed: No such file or directory` — the guest path had been
// handed to node-pty as a HOST cwd.

import test from 'node:test';
import assert from 'node:assert/strict';
import { guestShellArgv } from '../lib/pty-logic.js';

test('no cwd → plain bash exec (unchanged behaviour)', () => {
  assert.deepEqual(guestShellArgv({ incusName: 'pp-web' }), ['exec', '-t', 'pp-web', '--', 'bash']);
  assert.deepEqual(guestShellArgv({ incusName: 'pp-web', cwd: '' }), ['exec', '-t', 'pp-web', '--', 'bash']);
});

test('cwd → cd inside the guest via a positional parameter, bash with sh fallback', () => {
  const argv = guestShellArgv({ incusName: 'pp-web', cwd: '/opt/app' });
  assert.equal(argv[0], 'exec');
  assert.equal(argv[2], 'pp-web');
  assert.equal(argv[4], 'sh');
  assert.equal(argv[5], '-c');
  assert.match(argv[6], /^cd "\$1" 2>\/dev\/null;/);
  assert.match(argv[6], /exec bash/);
  assert.match(argv[6], /exec sh/);
  assert.equal(argv[argv.length - 1], '/opt/app');
  // The path never lands in the script text — spaces and quotes are safe.
  const spaced = guestShellArgv({ incusName: 'pp-web', cwd: "/var/www/it's here" });
  assert.equal(spaced[spaced.length - 1], "/var/www/it's here");
  assert.ok(!spaced[6].includes('/var/www'));
});

test('relative or control-char cwd is ignored; console mode never takes a cwd', () => {
  assert.deepEqual(guestShellArgv({ incusName: 'pp-web', cwd: 'opt/app' }), ['exec', '-t', 'pp-web', '--', 'bash']);
  assert.deepEqual(guestShellArgv({ incusName: 'pp-web', cwd: '/opt\napp' }), ['exec', '-t', 'pp-web', '--', 'bash']);
  assert.deepEqual(guestShellArgv({ incusName: 'pp-vm', mode: 'console', cwd: '/opt/app' }), ['console', 'pp-vm']);
});
