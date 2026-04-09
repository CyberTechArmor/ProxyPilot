import { spawnSync } from 'node:child_process';

/**
 * Execute a command inside an Incus instance using the `incus exec` CLI.
 *
 * We shell out to the `incus` binary rather than using the REST API because
 * the exec endpoint requires WebSocket, which is far more complex to manage
 * from a CLI tool.
 *
 * @param {string} instanceName - Name of the Incus instance
 * @param {string[]} command - Command and arguments to execute
 * @param {boolean} [interactive=false] - Whether to run interactively (attach TTY)
 * @returns {number} Exit code of the executed command
 */
export function execInContainer(instanceName, command, interactive = false) {
  const args = ['exec', instanceName];
  if (interactive) args.push('--force-interactive');
  args.push('--', ...command);

  const result = spawnSync('incus', args, { stdio: 'inherit' });
  return result.status ?? 1;
}

/**
 * Open an interactive shell inside an Incus instance.
 * Tries /bin/bash first; falls back to /bin/sh if bash is not available.
 *
 * @param {string} instanceName - Name of the Incus instance
 * @returns {number} Exit code of the shell session
 */
export function shellInContainer(instanceName) {
  const bashResult = spawnSync(
    'incus',
    ['exec', instanceName, '--force-interactive', '--', '/bin/bash'],
    { stdio: 'inherit' },
  );

  if (bashResult.status !== 0) {
    const shResult = spawnSync(
      'incus',
      ['exec', instanceName, '--force-interactive', '--', '/bin/sh'],
      { stdio: 'inherit' },
    );
    return shResult.status ?? 1;
  }

  return bashResult.status ?? 0;
}
