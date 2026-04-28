import * as pty from 'node-pty';

// Mirror the constants the lxc router uses. Kept inline (rather than
// imported from routes/lxc.js) so this helper has zero coupling to
// the HTTP layer — the WebSocket handler and the request-response
// /exec endpoint share the same instance naming scheme but are
// otherwise independent.
const INSTANCE_PREFIX = 'pp-';
const NAME_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9-]*$/;

function isInsideDockerContainer() {
  // Set by the admin/Dockerfile in production. When unset the helper
  // is running directly on the host (dev or bare-metal install) and
  // the nsenter wrapper that would otherwise jump to PID 1's
  // namespaces is unnecessary.
  return !!process.env.DOCKER_CONTAINER;
}

const NSENTER_ARGS = ['-t', '1', '-m', '-u', '-n', '-i'];

// Spawn an interactive PTY for a streaming-terminal session.
//
//   spawnTerminalPty({ kind: 'lxc', target: 'my-container' })
//   spawnTerminalPty({ kind: 'host' })
//
// Returns a node-pty IPty handle. Caller wires onData / onExit and
// calls .write / .resize / .kill. Throws synchronously on bad input.
export function spawnTerminalPty({ kind, target, cols = 80, rows = 24 } = {}) {
  if (kind !== 'lxc' && kind !== 'host') {
    throw new Error(`spawnTerminalPty: unknown kind '${kind}'`);
  }

  let command;
  let args;

  if (kind === 'lxc') {
    if (!target || !NAME_REGEX.test(target)) {
      throw new Error('spawnTerminalPty: invalid lxc target name');
    }
    const incusName = `${INSTANCE_PREFIX}${target}`;
    if (isInsideDockerContainer()) {
      // nsenter into PID 1's mount/utc/net/ipc namespaces so the
      // incus client talks to the host's incus daemon, not the
      // (non-existent) one inside the admin container. CAP_SYS_ADMIN
      // + CAP_SYS_PTRACE granted in B1 are what let this work.
      command = 'nsenter';
      args = [...NSENTER_ARGS, 'incus', 'exec', '-t', incusName, '--', 'bash'];
    } else {
      command = 'incus';
      args = ['exec', '-t', incusName, '--', 'bash'];
    }
  } else {
    // host shell — admin-only at the route layer (B.5)
    if (isInsideDockerContainer()) {
      command = 'nsenter';
      args = [...NSENTER_ARGS, 'bash', '-l'];
    } else {
      command = 'bash';
      args = ['-l'];
    }
  }

  const env = { ...process.env, TERM: 'xterm-256color' };

  return pty.spawn(command, args, {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: process.env.HOME || '/root',
    env,
  });
}
