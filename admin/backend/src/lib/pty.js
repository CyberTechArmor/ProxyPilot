import * as pty from 'node-pty';
import { existsSync } from 'fs';

// Match the convention used by routes/lxc.js so we run incus on the host
// rather than inside the admin container's namespace.
const INSTANCE_PREFIX = 'pp-';
const isInDocker = existsSync('/.dockerenv') || process.env.DOCKER_CONTAINER === 'true';

// Reject anything that isn't a plain instance name. The user-supplied
// `target` flows straight into argv for nsenter/incus exec, so this is
// the trust boundary for the LXC kind.
function validInstanceName(name) {
  return typeof name === 'string' && /^[a-zA-Z0-9_-]+$/.test(name) && name.length > 0 && name.length <= 64;
}

// Translate a path from the admin-container's view to the host view.
// The compose mount is `${INSTALL_DIR}/data:/data`, so a container path
// like `/data/services/foo` corresponds to host path
// `${INSTALL_DIR}/data/services/foo`. Used when a host-kind PTY needs
// to start in a directory the admin container surfaced (file browser
// → "Open terminal here").
//
// CADDY_STATIC_ROOT is exported by the install-side wrapper as
// `${INSTALL_DIR}/data/services` and is the only mapping today. If
// the cwd doesn't start with SERVICES_DATA_DIR, return as-is.
export function translateContainerPathToHost(p) {
  if (typeof p !== 'string' || !p) return null;
  const servicesContainer = process.env.SERVICES_DATA_DIR || '/data/services';
  const servicesHost = process.env.CADDY_STATIC_ROOT || servicesContainer;
  if (servicesHost === servicesContainer) return p; // not running in Docker
  if (p === servicesContainer) return servicesHost;
  if (p.startsWith(servicesContainer + '/')) {
    return servicesHost + p.slice(servicesContainer.length);
  }
  return p;
}

// spawnTerminalPty({ kind, target, cols, rows, cwd }) — returns a node-pty
// IPty.
//
// kind='lxc'   : opens a PTY into `incus exec -t pp-<target> -- bash`. When
//                running inside the admin Docker container we pivot to the
//                host's mount/PID/UTS/net/IPC namespaces via nsenter (host
//                holds the incus binary + socket). The CAP_SYS_ADMIN +
//                CAP_SYS_PTRACE granted by hardening B1 is what makes the
//                nsenter step legal without running privileged.
//
// kind='host'  : opens a PTY into `bash -l` on the host (admin-only). Same
//                nsenter pivot when in Docker; falls through to a plain
//                `bash -l` on bare-metal / non-Docker installs.
//
// `cwd`        : optional starting directory. When kind='host' and cwd
//                points into the admin container's view of the services
//                volume (e.g. /data/services/foo), it is translated to the
//                host's path so nsenter'd bash actually finds the dir.
//
// Defaults: cols=80, rows=24, name='xterm-256color'. The TERM env var is
// forced to xterm-256color so colour and alt-screen apps work consistently.
export function spawnTerminalPty({ kind, target, cols = 80, rows = 24, cwd } = {}) {
  let cmd;
  let args;

  if (kind === 'lxc') {
    if (!validInstanceName(target)) {
      throw new Error('Invalid container target');
    }
    const incusName = `${INSTANCE_PREFIX}${target}`;
    if (isInDocker) {
      cmd = 'nsenter';
      args = ['-t', '1', '-m', '-u', '-n', '-i', 'incus', 'exec', '-t', incusName, '--', 'bash'];
    } else {
      cmd = 'incus';
      args = ['exec', '-t', incusName, '--', 'bash'];
    }
  } else if (kind === 'host') {
    if (isInDocker) {
      cmd = 'nsenter';
      args = ['-t', '1', '-m', '-u', '-n', '-i', 'bash', '-l'];
    } else {
      cmd = 'bash';
      args = ['-l'];
    }
  } else {
    throw new Error(`Unsupported PTY kind: ${kind}`);
  }

  // Resolve the starting cwd. Host-kind sessions can be handed a
  // container-view path (file browser → "Open terminal here") which
  // we translate to its host equivalent so nsenter'd bash finds it.
  // Empty / falsy cwd → fall back to HOME.
  let startCwd = process.env.HOME || '/';
  if (cwd && typeof cwd === 'string') {
    const translated = kind === 'host' ? translateContainerPathToHost(cwd) : cwd;
    if (translated) startCwd = translated;
  }

  return pty.spawn(cmd, args, {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: startCwd,
    env: { ...process.env, TERM: 'xterm-256color' },
  });
}
