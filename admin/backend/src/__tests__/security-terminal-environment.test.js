import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

// Exercise the real PTY factory; replace only the native process spawn.
const hook = registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'node-pty') return {
    shortCircuit: true,
    url: 'data:text/javascript,export function spawn(cmd,args,options){return {cmd,args,options};}',
  };
  return next(specifier, context);
} });
const { spawnTerminalPty } = await import('../lib/pty.js');
hook.deregister();

test('host PTY marks its shell and clears inherited runner state from native backend startup', (t) => {
  const keys = ['PROXYPILOT_UPDATE_RUNNER', 'PROXYPILOT_UPDATE_REEXEC', 'PROXYPILOT_TERMINAL_HANDOFF', 'PROXYPILOT_TERMINAL'];
  const original = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  t.after(() => {
    for (const key of keys) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
  });
  for (const key of keys) process.env[key] = '1';
  const host = spawnTerminalPty({ kind: 'host' });
  assert.equal(host.options.env.PROXYPILOT_TERMINAL, 'host');
  assert.equal(host.options.env.TERM, 'xterm-256color');
  const guest = spawnTerminalPty({ kind: 'lxc', target: 'example' });
  assert.equal(guest.options.env.PROXYPILOT_TERMINAL, undefined);
  for (const key of keys.filter(key => key !== 'PROXYPILOT_TERMINAL')) {
    assert.equal(host.options.env[key], undefined);
    assert.equal(guest.options.env[key], undefined);
  }
});
