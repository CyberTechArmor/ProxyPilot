import { Router } from 'express';
import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import { writeFile, readdir, readFile, unlink, mkdir, stat } from 'fs/promises';
import { createReadStream, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import http from 'http';
import multer from 'multer';
import { randomUUID } from 'crypto';
import { requireAdmin, requireSudo } from '../middleware/auth.js';
import { getDb } from '../db.js';
import { v4 as uuidv4 } from 'uuid';
import { ensureCaddyStructure } from './services.js';

const execAsync = promisify(exec);

// Container backups can be tens to hundreds of GB on disk-heavy LXCs
// (Docker-in-LXC, databases, large media). The previous memoryStorage
// multer config buffered the entire upload into RAM and capped at 2GB,
// which both bottlenecked the import and crashed the backend on
// realistic backups. Switch to disk-backed multer with a far larger
// cap and stream the temp file into `incus import -` stdin from the
// disk handler.
//
// Cap is generous (50 GiB) but bounded so a single bad upload can't
// fill the host disk indefinitely — operators with bigger backups can
// raise LXC_IMPORT_LIMIT_BYTES via the environment.
const LXC_IMPORT_TMP_DIR = process.env.LXC_IMPORT_TMP_DIR || join(tmpdir(), 'proxypilot-imports');
const LXC_IMPORT_LIMIT_BYTES = parseInt(process.env.LXC_IMPORT_LIMIT_BYTES || String(50 * 1024 * 1024 * 1024), 10);
try { await mkdir(LXC_IMPORT_TMP_DIR, { recursive: true }); } catch {}
const importStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, LXC_IMPORT_TMP_DIR),
  filename: (_req, _file, cb) => cb(null, `import-${Date.now()}-${randomUUID()}.tar.gz`),
});
const upload = multer({ storage: importStorage, limits: { fileSize: LXC_IMPORT_LIMIT_BYTES } });

export const lxcRouter = Router();

const INSTANCE_PREFIX = 'pp-';
const CADDY_SITES_DIR = process.env.CADDY_SITES_DIR || '/etc/caddy/sites';
const NAME_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9-]*$/;

// In-memory tracking of active container creation jobs
const activeCreations = new Map();

// Check if running in Docker container
const isInDocker = existsSync('/.dockerenv') || process.env.DOCKER_CONTAINER === 'true';

// Execute command on host (uses nsenter when in Docker, direct exec otherwise)
async function execOnHost(command, options = {}) {
  const timeout = options.timeout || 30000;

  if (isInDocker) {
    const hostCommand = `nsenter -t 1 -m -u -n -i sh -c ${JSON.stringify(command)}`;
    return execAsync(hostCommand, { timeout });
  } else {
    return execAsync(command, { timeout });
  }
}

// Spawn a command on host without timeout (for long-running operations)
function spawnOnHost(command) {
  if (isInDocker) {
    return spawn('nsenter', ['-t', '1', '-m', '-u', '-n', '-i', 'sh', '-c', command], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } else {
    return spawn('sh', ['-c', command], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }
}

// Ensure container has public DNS configured
async function ensureDns(incusName) {
  try {
    await execOnHost(
      `incus exec ${incusName} -- sh -c 'if ! grep -q "9.9.9.9" /etc/resolv.conf 2>/dev/null; then rm -f /etc/resolv.conf; printf "nameserver 9.9.9.9\\nnameserver 1.1.1.1\\n" > /etc/resolv.conf; fi'`,
      { timeout: 10000 }
    );
  } catch {}
}

// Ensure NAT and IP forwarding are enabled so containers have internet
async function ensureNetworkNat() {
  // Step 1: Enable IP forwarding on the host
  try {
    await execOnHost('sysctl -w net.ipv4.ip_forward=1', { timeout: 5000 });
    console.log('[LXC] IP forwarding enabled');
  } catch (err) {
    console.error('[LXC] Failed to enable IP forwarding:', err.message);
  }

  // Step 2: Enable NAT on all managed Incus bridge networks
  try {
    const result = await execOnHost('incus network list --format json', { timeout: 10000 });
    const networks = JSON.parse(result.stdout || '[]');
    for (const net of networks) {
      if (net.type === 'bridge' && net.managed) {
        try {
          await execOnHost(`incus network set ${net.name} ipv4.nat true`, { timeout: 10000 });
          console.log(`[LXC] Enabled ipv4.nat on bridge '${net.name}'`);
        } catch {}

        // Step 3: Allow Incus bridge traffic through Docker's FORWARD chain
        // Docker sets FORWARD policy to DROP, blocking Incus container traffic
        try {
          await execOnHost(
            `iptables -C DOCKER-USER -i ${net.name} -j ACCEPT 2>/dev/null || iptables -I DOCKER-USER -i ${net.name} -j ACCEPT`,
            { timeout: 10000 }
          );
          await execOnHost(
            `iptables -C DOCKER-USER -o ${net.name} -j ACCEPT 2>/dev/null || iptables -I DOCKER-USER -o ${net.name} -j ACCEPT`,
            { timeout: 10000 }
          );
          console.log(`[LXC] Docker FORWARD rules added for bridge '${net.name}'`);
        } catch {}
      }
    }
  } catch (err) {
    console.error('[LXC] incus network NAT setup failed:', err.message);
  }

  // Step 4: Fallback — add iptables MASQUERADE directly for container subnets
  try {
    await execOnHost(
      'iptables -t nat -C POSTROUTING -s 10.0.0.0/8 ! -d 10.0.0.0/8 -j MASQUERADE 2>/dev/null || iptables -t nat -A POSTROUTING -s 10.0.0.0/8 ! -d 10.0.0.0/8 -j MASQUERADE',
      { timeout: 10000 }
    );
    console.log('[LXC] iptables MASQUERADE rule ensured');
  } catch (err) {
    console.error('[LXC] iptables MASQUERADE failed:', err.message);
  }
}

// Validate instance name to prevent command injection
function validateName(name) {
  if (!name || typeof name !== 'string') {
    return false;
  }
  return NAME_REGEX.test(name);
}

// Interfaces created by Docker / container runtimes inside the LXC.
// These are bridges and veth peers that only exist within the LXC's
// network namespace — their addresses (172.17.0.1, 172.18.0.1, etc.)
// are unreachable from the host so Caddy reverse-proxying to them
// returns 502. Filter them out when picking the LXC's externally
// reachable IP.
const DOCKER_IFACE_PATTERNS = [
  /^docker\d+$/,        // docker0, docker1
  /^docker_gwbridge$/,  // swarm overlay
  /^br-[0-9a-f]+$/,     // compose-style user-defined networks
  /^veth/,              // veth peers attached to docker bridges
  /^cni\d*$/,           // CNI plugins
];

function isContainerRuntimeIface(name) {
  return DOCKER_IFACE_PATTERNS.some((re) => re.test(name));
}

// Pick a non-loopback, non-docker, non-link-scope IPv4 address from the
// Incus state. Tries the conventional `eth0` first so the LXC's primary
// interface wins even if Object.entries iteration order ever surprises
// us; falls back to any other interface that isn't a docker/veth bridge.
function pickIp(container, family) {
  if (!container.state?.network) return null;
  const ifaces = Object.entries(container.state.network);
  const matches = (name, addr) => {
    if (addr.family !== family) return false;
    if (addr.scope && addr.scope !== 'global') return false;
    if (family === 'inet' && addr.address.startsWith('127.')) return false;
    if (family === 'inet6' && (addr.address.startsWith('::1') || addr.address.startsWith('fe80'))) return false;
    return true;
  };
  for (const [name, iface] of ifaces) {
    if (name !== 'eth0') continue;
    for (const addr of iface.addresses || []) {
      if (matches(name, addr)) return addr.address;
    }
  }
  for (const [name, iface] of ifaces) {
    if (name === 'lo' || isContainerRuntimeIface(name)) continue;
    for (const addr of iface.addresses || []) {
      if (matches(name, addr)) return addr.address;
    }
  }
  return null;
}

// Extract IPv4 address from container state
function extractIPv4(container) {
  return pickIp(container, 'inet');
}

// Phase 2b E.1: extract the first non-loopback IPv6 address from container
// state, mirroring the `extractIPv4` helper. Returns null when no IPv6
// address is bound (common for default Incus profiles).
function extractIPv6(container) {
  return pickIp(container, 'inet6');
}

// Helper to sleep for polling
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Apply requireAdmin to all routes in this router
lxcRouter.use(requireAdmin);

// GET /status - Check if Incus is available on the host
lxcRouter.get('/status', async (req, res) => {
  try {
    const { stdout } = await execOnHost('incus version 2>/dev/null');
    const version = stdout.trim();

    // Check if Incus has been initialized (has a storage pool)
    let initialized = true;
    let initWarning = null;
    try {
      const { stdout: poolsJson } = await execOnHost('incus storage list --format json 2>/dev/null');
      const pools = JSON.parse(poolsJson || '[]');
      if (pools.length === 0) {
        initialized = false;
        initWarning = 'Incus has no storage pools configured. Run: incus admin init --minimal';
      }
    } catch {
      initialized = false;
      initWarning = 'Could not query Incus storage pools. Run: incus admin init --minimal';
    }

    res.json({ success: true, available: true, version, initialized, initWarning });
  } catch {
    res.json({ success: true, available: false });
  }
});

// GET /containers - List all pp-* containers with their state
lxcRouter.get('/containers', async (req, res) => {
  try {
    const result = await execOnHost('incus list --format json');
    const all = JSON.parse(result.stdout || '[]');
    const containers = all
      .filter(c => c.name.startsWith(INSTANCE_PREFIX))
      .map(c => ({
        name: c.name.replace(new RegExp(`^${INSTANCE_PREFIX}`), ''),
        incusName: c.name,
        status: c.status.toLowerCase(),
        type: c.type,
        architecture: c.architecture,
        created_at: c.created_at,
        image: c.config?.['image.description'] || c.config?.['image.os'] || '',
        ipv4: extractIPv4(c),
        profiles: c.profiles,
        config: {
          cpu: c.config?.['limits.cpu'] || 'unlimited',
          memory: c.config?.['limits.memory'] || 'unlimited',
        },
      }));
    res.json({ success: true, containers });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to list containers',
      details: error.stderr || error.message,
    });
  }
});

// Phase 2b E.1: GET /containers/with-ip — compact listing used by the
// Add Service wizard's LXC dropdown. Returns `{containers: [{name,
// status, ipv4, ipv6}]}` with the `pp-` instance prefix stripped so the
// caller sees the operator-facing name directly. Reuses the same
// `incus list --format json` call + extract helpers as GET /containers.
lxcRouter.get('/containers/with-ip', async (req, res) => {
  try {
    const result = await execOnHost('incus list --format json');
    const all = JSON.parse(result.stdout || '[]');
    const containers = all
      .filter((c) => c.name.startsWith(INSTANCE_PREFIX))
      .map((c) => ({
        name: c.name.replace(new RegExp(`^${INSTANCE_PREFIX}`), ''),
        status: c.status.toLowerCase(),
        ipv4: extractIPv4(c),
        ipv6: extractIPv6(c),
      }));
    res.json({ containers });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to list containers',
      details: error.stderr || error.message,
    });
  }
});

// GET /images - List available images
lxcRouter.get('/images', async (req, res) => {
  try {
    const result = await execOnHost('incus image list --format json 2>/dev/null');
    const images = JSON.parse(result.stdout);
    res.json({ success: true, images });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to list images',
      details: error.stderr || error.message,
    });
  }
});

// GET /containers/:name - Get detailed info for a container
lxcRouter.get('/containers/:name', async (req, res) => {
  const { name } = req.params;

  if (!validateName(name)) {
    return res.status(400).json({
      success: false,
      error: 'Invalid container name. Only alphanumeric characters and hyphens are allowed.',
    });
  }

  try {
    const incusName = `${INSTANCE_PREFIX}${name}`;
    const result = await execOnHost(`incus info ${incusName} --format json 2>/dev/null`);
    const info = JSON.parse(result.stdout);
    res.json({ success: true, container: info });
  } catch (error) {
    res.status(404).json({
      success: false,
      error: `Container '${name}' not found`,
      details: error.stderr || error.message,
    });
  }
});

// GET /containers/:name/state - Get live resource state
lxcRouter.get('/containers/:name/state', async (req, res) => {
  const { name } = req.params;

  if (!validateName(name)) {
    return res.status(400).json({
      success: false,
      error: 'Invalid container name. Only alphanumeric characters and hyphens are allowed.',
    });
  }

  try {
    const incusName = `${INSTANCE_PREFIX}${name}`;
    const result = await execOnHost(`incus list ${incusName} --format json 2>/dev/null`);
    const containers = JSON.parse(result.stdout);

    if (!containers.length) {
      return res.status(404).json({
        success: false,
        error: `Container '${name}' not found`,
      });
    }

    const container = containers[0];
    res.json({
      success: true,
      state: {
        cpu: container.state?.cpu,
        memory: container.state?.memory,
        disk: container.state?.disk,
        network: container.state?.network,
        processes: container.state?.processes,
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to get container state',
      details: error.stderr || error.message,
    });
  }
});

// GET /containers/:name/snapshots - List snapshots for a container
lxcRouter.get('/containers/:name/snapshots', async (req, res) => {
  const { name } = req.params;

  if (!validateName(name)) {
    return res.status(400).json({
      success: false,
      error: 'Invalid container name. Only alphanumeric characters and hyphens are allowed.',
    });
  }

  try {
    const incusName = `${INSTANCE_PREFIX}${name}`;
    const result = await execOnHost(`incus snapshot list ${incusName} --format json 2>/dev/null`);
    const snapshots = JSON.parse(result.stdout || '[]');

    // Best-effort enrichment: pull per-snapshot disk usage from the
    // storage volume's /state endpoint. config.size is a configured
    // quota — almost never set; the actual usage lives in
    // .../volumes/<...>/snapshots/<snap>/state under usage.used.
    // We resolve the instance's pool once, then call the state
    // endpoint for each snapshot in parallel. Any failure (older
    // incus, backend without per-snapshot accounting, network
    // hiccup) leaves the size unset and the rest of the row usable.
    try {
      const infoResult = await execOnHost(`incus query /1.0/instances/${incusName}?recursion=1 2>/dev/null`, { timeout: 5000 });
      const instance = JSON.parse(infoResult.stdout || '{}');
      const pool = instance?.expanded_devices?.root?.pool || instance?.devices?.root?.pool;
      if (pool && snapshots.length) {
        await Promise.all(snapshots.map(async (snap) => {
          const used = await readVolumeUsedBytes(pool, `container/${incusName}/snapshots/${snap.name}`);
          if (used != null) snap.size = used;
        }));
      }
    } catch {
      // Couldn't even resolve the instance pool — skip enrichment.
    }

    res.json({ success: true, snapshots });
  } catch (error) {
    // If no snapshots exist, incus may return an error or empty
    if (error.stderr?.includes('No snapshots')) {
      return res.json({ success: true, snapshots: [] });
    }
    res.status(500).json({
      success: false,
      error: 'Failed to list snapshots',
      details: error.stderr || error.message,
    });
  }
});

// POST /containers - Start async container creation
lxcRouter.post('/containers', async (req, res) => {
  const { name, image, profile, domain, port, cpu, memory, initScript, dockerSupport, dockerPrivileged, services: rawServices } = req.body;

  // Normalize services: support both new multi-service array and legacy single domain/port.
  // healthPath is optional; bad input is dropped silently here (the create
  // flow runs async and can't return a 400 from this branch) — the
  // dedicated POST /services endpoint validates strictly.
  const services = Array.isArray(rawServices) && rawServices.length > 0
    ? rawServices.filter(s => s.domain && typeof s.domain === 'string' && s.domain.trim()).map(s => {
        const hp = validateHealthPath(s.healthPath);
        return {
          domain: s.domain.trim(),
          port: parseInt(s.port, 10) || 80,
          obtainCert: s.obtainCert !== false,
          healthPath: hp.ok ? hp.value : null,
        };
      })
    : (domain && port ? [{ domain, port: parseInt(port, 10), obtainCert: true, healthPath: null }] : []);

  if (!validateName(name)) {
    return res.status(400).json({
      success: false,
      error: 'Invalid container name. Only alphanumeric characters and hyphens are allowed, and it must start with an alphanumeric character.',
    });
  }

  if (!image) {
    return res.status(400).json({
      success: false,
      error: 'Image is required (e.g., "ubuntu:24.04", "images:debian/12").',
    });
  }

  const incusName = `${INSTANCE_PREFIX}${name}`;

  // Check if container already exists
  try {
    await execOnHost(`incus info ${incusName} 2>/dev/null`);
    return res.status(409).json({
      success: false,
      error: `Container '${name}' already exists.`,
    });
  } catch {
    // Container doesn't exist — good
  }

  // Check if a creation is already in progress for this name
  if (activeCreations.has(incusName)) {
    const existing = activeCreations.get(incusName);
    if (existing.phase !== 'ready' && existing.phase !== 'failed') {
      return res.status(409).json({
        success: false,
        error: `Container '${name}' creation is already in progress.`,
      });
    }
  }

  // Initialize creation tracking
  const creation = {
    phase: 'downloading',
    message: 'Downloading image...',
    startTime: Date.now(),
    name,
    incusName,
    image,
    services,
    domain: services.length > 0 ? services[0].domain : null,
    port: services.length > 0 ? services[0].port : null,
    cpu: cpu || null,
    memory: memory || null,
    error: null,
    ip: null,
    stderr: '',
  };
  activeCreations.set(incusName, creation);

  // Start the launch process asynchronously (no timeout — runs until done)
  const profileArg = profile ? `--profile ${profile}` : '--profile default';
  // Docker-in-LXC support. Without these flags `dockerd` can't mount
  // overlayfs (kernel denies overlay mounts inside an unprivileged
  // user namespace) and image pulls fail with `permission denied` on
  // /var/lib/containerd/io.containerd.snapshotter.v1.overlayfs/.
  //
  // The base set covers `docker pull` and most plain `docker run`:
  //   security.nesting=true              — allow nested containers
  //   syscalls.intercept.mknod=true      — let package post-installs mknod
  //   syscalls.intercept.setxattr=true   — overlay metadata
  //
  // The bpf intercepts cover BuildKit (the default `docker build`
  // backend in modern Docker) and packages with native postinstalls
  // (bcrypt, node-pty, sharp, etc.). Without them, npm's spawn() of
  // a postinstall hook from the overlay upper layer is denied by the
  // outer kernel's seccomp/user-ns policy:
  //   syscalls.intercept.bpf=true
  //   syscalls.intercept.bpf.devices=true
  //
  // dockerPrivileged is the "I need full Docker compatibility" escape
  // hatch: bundles three host-trust-loosening knobs that operators
  // hit one after another otherwise.
  //
  //   security.privileged=true
  //     Drops the LXC user-namespace map so containers run with host
  //     root capabilities. Required for some BuildKit syscalls
  //     (e.g. `spawn sh` with bcrypt-style native postinstalls).
  //
  //   raw.lxc='lxc.apparmor.profile=unconfined'
  //     Removes the AppArmor profile from the LXC. Without this,
  //     runc inside the LXC can't write /proc/sys/* values during
  //     container init — Docker images that touch sysctls (e.g. n8n
  //     setting net.ipv4.ip_unprivileged_port_start) fail with
  //     `open sysctl ... reopen fd N: permission denied`. Syscall
  //     intercepts and security.privileged are orthogonal to
  //     AppArmor and don't fix this on their own.
  //
  // We always pair these because operators who reach for "Privileged
  // Docker" universally also need the AppArmor knob — splitting them
  // into two checkboxes was a footgun that made every Docker image
  // touching sysctls fail until the operator manually edited the
  // LXC's raw.lxc.
  let dockerConfigArgs = '';
  if (dockerSupport === true) {
    dockerConfigArgs = ' --config security.nesting=true' +
      ' --config security.syscalls.intercept.mknod=true' +
      ' --config security.syscalls.intercept.setxattr=true' +
      ' --config security.syscalls.intercept.bpf=true' +
      ' --config security.syscalls.intercept.bpf.devices=true';
    if (dockerPrivileged === true) {
      dockerConfigArgs += ' --config security.privileged=true' +
        ` --config raw.lxc=${JSON.stringify('lxc.apparmor.profile=unconfined')}`;
    }
  }
  const launchCmd = `incus launch ${image} ${incusName} ${profileArg}${dockerConfigArgs}`;
  console.log(`[LXC] Starting async launch: ${launchCmd}`);

  const child = spawnOnHost(launchCmd);

  child.stderr.on('data', (data) => {
    creation.stderr += data.toString();
    const output = data.toString().toLowerCase();
    // Detect download progress from Incus output
    if (output.includes('retrieving') || output.includes('download') || output.includes('unpack')) {
      creation.phase = 'downloading';
      creation.message = 'Downloading image...';
    }
  });

  child.stdout.on('data', (data) => {
    console.log(`[LXC] Launch stdout: ${data.toString().trim()}`);
  });

  child.on('close', async (code) => {
    console.log(`[LXC] Launch process exited with code ${code}`);

    if (code !== 0) {
      creation.phase = 'failed';
      creation.error = creation.stderr.trim() || `Launch exited with code ${code}`;
      creation.message = creation.error;
      console.error(`[LXC] Launch failed: ${creation.error}`);
      // Clean up partial container
      try { await execOnHost(`incus delete ${incusName} --force 2>/dev/null || true`); } catch {}
      // Keep the creation record for 2 minutes so the frontend can read the error
      setTimeout(() => activeCreations.delete(incusName), 120000);
      return;
    }

    // Launch succeeded — configure the container
    try {
      creation.phase = 'configuring';
      creation.message = 'Configuring container...';

      // Ensure NAT is enabled on the bridge so containers have internet
      await ensureNetworkNat();

      // Set resource limits
      if (cpu) {
        await execOnHost(`incus config set ${incusName} limits.cpu=${cpu}`);
      }
      if (memory) {
        await execOnHost(`incus config set ${incusName} limits.memory=${memory}MB`);
      }

      // Wait for IP address
      creation.phase = 'network';
      creation.message = 'Waiting for network...';

      let ip = null;
      for (let i = 0; i < 30; i++) {
        await sleep(1000);
        try {
          const result = await execOnHost(`incus list ${incusName} --format json 2>/dev/null`, { timeout: 5000 });
          const containers = JSON.parse(result.stdout || '[]');
          if (containers.length > 0) {
            ip = extractIPv4(containers[0]);
            if (ip) break;
          }
        } catch {}
      }
      creation.ip = ip;

      // Configure DNS with public resolvers
      await ensureDns(incusName);

      // Run init script if provided. We don't fail the whole
      // creation on a non-zero exit — the operator can finish setup
      // by hand — but we capture the exit code + the tail of output
      // and surface it on `creation.initScriptWarning` so the UI can
      // show "container ready, init script exited 100" instead of
      // silently producing an empty container.
      if (initScript && typeof initScript === 'string' && initScript.trim()) {
        creation.phase = 'init-script';
        creation.message = 'Running init script...';
        try {
          const scriptContent = initScript.trim();
          // Encode as base64 before piping into the container. The
          // previous `printf '%s' ${JSON.stringify(...)}` round-trip
          // emitted JSON-style escapes — `\n` arrived as literal
          // backslash-n on the container side, so the entire script
          // collapsed to a single line that began with `#!/bin/sh\n…`
          // and bash treated the whole thing as one comment. The
          // script "ran" with exit code 0 and no packages were ever
          // installed. base64 is shell-safe (only [A-Za-z0-9+/=]),
          // and `base64 -d` is in coreutils on every distro we ship
          // images for.
          const b64 = Buffer.from(scriptContent, 'utf8').toString('base64');
          await execOnHost(
            `echo '${b64}' | base64 -d | incus exec ${incusName} -- tee /tmp/pp-init.sh > /dev/null`,
            { timeout: 15000 }
          );
          await execOnHost(`incus exec ${incusName} -- chmod +x /tmp/pp-init.sh`, { timeout: 5000 });
          const initChild = spawnOnHost(`incus exec ${incusName} -- sh /tmp/pp-init.sh`);
          let stdoutBuf = '';
          let stderrBuf = '';
          const TAIL_BYTES = 4096;
          initChild.stdout?.on('data', (d) => {
            stdoutBuf = (stdoutBuf + d.toString()).slice(-TAIL_BYTES);
          });
          initChild.stderr?.on('data', (d) => {
            stderrBuf = (stderrBuf + d.toString()).slice(-TAIL_BYTES);
          });
          const result = await new Promise((resolve) => {
            const timeout = setTimeout(() => {
              try { initChild.kill(); } catch {}
              resolve({ code: null, killed: true });
            }, 300000);
            initChild.on('close', (code) => { clearTimeout(timeout); resolve({ code, killed: false }); });
            initChild.on('error', (err) => { clearTimeout(timeout); resolve({ code: null, killed: false, err: err.message }); });
          });
          await execOnHost(`incus exec ${incusName} -- rm -f /tmp/pp-init.sh`, { timeout: 5000 }).catch(() => {});

          if (result.killed) {
            creation.initScriptWarning = 'Init script timed out after 5 minutes — finish setup manually inside the container.';
            console.error(`[LXC] Init script for ${incusName} timed out`);
          } else if (result.code !== 0) {
            const tail = stderrBuf || stdoutBuf || '(no output captured)';
            creation.initScriptWarning = `Init script exited with code ${result.code}. Last output:\n${tail}`;
            console.error(`[LXC] Init script for ${incusName} exited ${result.code}: ${tail}`);
          } else {
            console.log(`[LXC] Init script completed cleanly for ${incusName}`);
          }
        } catch (initErr) {
          creation.initScriptWarning = `Init script setup failed: ${initErr.message}`;
          console.error(`[LXC] Init script failed: ${initErr.message}`);
        }
      }

      // Configure Caddy reverse proxy for all services
      if (services.length > 0 && ip) {
        creation.phase = 'caddy';
        creation.message = `Configuring reverse proxy for ${services.length} service${services.length > 1 ? 's' : ''}...`;

        for (const svc of services) {
          const tlsDirective = svc.obtainCert ? '' : '\n    tls internal';
          const healthMarker = svc.healthPath ? `# proxypilot: healthpath=${svc.healthPath}\n` : '';
          const caddyConfig = `${healthMarker}${svc.domain} {${tlsDirective}\n    reverse_proxy ${ip}:${svc.port}\n    encode gzip zstd\n    log {\n        output file /var/log/caddy/${svc.domain}.log\n    }\n}\n`;
          const configPath = join(CADDY_SITES_DIR, svc.domain);
          await writeFile(configPath, caddyConfig);
          console.log(`[LXC] Wrote Caddy config for ${svc.domain} -> ${ip}:${svc.port} (cert: ${svc.obtainCert})`);
        }

        try {
          await execOnHost('caddy reload --config /etc/caddy/Caddyfile 2>&1');
        } catch (reloadError) {
          console.error('[LXC] Caddy reload failed:', reloadError.stderr || reloadError.message);
        }
      }

      creation.phase = 'ready';
      creation.message = 'Container is ready';
      console.log(`[LXC] Container ${incusName} is ready (IP: ${ip || 'none'})`);

    } catch (err) {
      creation.phase = 'failed';
      creation.error = err.stderr || err.message || 'Post-launch configuration failed';
      creation.message = creation.error;
      console.error(`[LXC] Post-launch config failed: ${creation.error}`);
    }

    // Clean up creation tracking after 2 minutes
    setTimeout(() => activeCreations.delete(incusName), 120000);
  });

  child.on('error', (err) => {
    creation.phase = 'failed';
    creation.error = err.message;
    creation.message = err.message;
    console.error(`[LXC] Launch spawn error: ${err.message}`);
    setTimeout(() => activeCreations.delete(incusName), 120000);
  });

  // Return immediately — frontend will poll for progress
  res.status(202).json({
    success: true,
    message: 'Container creation started',
    name,
    incusName,
  });
});

// GET /containers/:name/create-status - Poll creation progress
lxcRouter.get('/containers/:name/create-status', async (req, res) => {
  const { name } = req.params;

  if (!validateName(name)) {
    return res.status(400).json({ success: false, error: 'Invalid container name.' });
  }

  const incusName = `${INSTANCE_PREFIX}${name}`;
  const creation = activeCreations.get(incusName);

  // If we have an active creation record, use it
  if (creation) {
    return res.json({
      success: true,
      phase: creation.phase,
      message: creation.message,
      error: creation.error,
      ip: creation.ip,
      initScriptWarning: creation.initScriptWarning || null,
      elapsed: Math.round((Date.now() - creation.startTime) / 1000),
    });
  }

  // No active creation — check if container exists already (maybe from a previous creation)
  try {
    const result = await execOnHost(`incus list ${incusName} --format json 2>/dev/null`, { timeout: 5000 });
    const containers = JSON.parse(result.stdout || '[]');
    if (containers.length > 0) {
      const ip = extractIPv4(containers[0]);
      return res.json({
        success: true,
        phase: 'ready',
        message: 'Container is ready',
        ip,
        elapsed: 0,
      });
    }
  } catch {}

  // Check if Incus has an active operation (e.g. image download in progress)
  try {
    const opsResult = await execOnHost('incus operation list --format json 2>/dev/null', { timeout: 5000 });
    const ops = JSON.parse(opsResult.stdout || '[]');
    const relevantOp = ops.find(op =>
      op.status === 'Running' &&
      (op.description?.toLowerCase().includes('download') ||
       op.description?.toLowerCase().includes('creating') ||
       op.description?.toLowerCase().includes('image'))
    );
    if (relevantOp) {
      return res.json({
        success: true,
        phase: 'downloading',
        message: relevantOp.description || 'Downloading image...',
        elapsed: 0,
      });
    }
  } catch {}

  res.json({
    success: true,
    phase: 'unknown',
    message: 'No active creation found for this container.',
    elapsed: 0,
  });
});

// Probe a `<ip>:<port>` pair from the host's network namespace using
// bash's /dev/tcp magic file. Resolves to true on a successful TCP
// handshake within `timeoutMs`, false otherwise (connection refused,
// timeout, host unreachable). Used to give the operator a signal in
// the Services UI when Caddy is configured correctly but the upstream
// isn't actually listening — the most common 502 cause once IP
// detection is fixed.
// Format the JSON body for a failed `incus snapshot {create|restore|delete}`
// call. execAsync's behavior on timeout is the failure mode that bites
// here: it sends SIGTERM, returns an Error with `killed=true` and
// usually-empty stderr/stdout (incus may not have flushed anything
// before SIGTERM). The previous templating fell through stderr →
// stdout → message and surfaced Node's generic "Command failed:
// nsenter ..." string with no actionable signal. Detect timeout
// explicitly and explain so the operator knows whether to bump the
// budget or look at incus.
function formatSnapshotError(prefix, error, timeoutMs) {
  // execAsync timeout: error.killed=true, error.signal='SIGTERM'.
  // error.code is the spawn-side numeric on timeout; for an actual
  // non-zero exit it's the exit code (a number). The combination of
  // killed + signal is reliable.
  const isTimeout = error && (error.killed === true || error.signal === 'SIGTERM' || error.signal === 'SIGKILL');
  const stderr = (error.stderr || '').trim();
  const stdout = (error.stdout || '').trim();
  const incusOutput = stderr || stdout;
  let message;
  if (isTimeout && !incusOutput) {
    const seconds = Math.round((timeoutMs || 0) / 1000);
    message = `${prefix}: timed out after ${seconds}s. Snapshots of running Docker-in-LXC containers can take several minutes; check 'incus operation list' on the host to see if it's still in progress, or try again with the container stopped.`;
  } else if (incusOutput) {
    message = `${prefix}: ${incusOutput}`;
  } else {
    message = `${prefix}: ${error.message || 'unknown error'} (exit code: ${error.code ?? 'n/a'})`;
  }
  return {
    success: false,
    error: message,
    details: incusOutput || error.message,
    timedOut: !!isTimeout,
  };
}

// Read actual disk usage (bytes) for a storage volume. Used by the
// snapshot-list enrichment and the export-info endpoints. The
// /state endpoint is the only API that returns true used bytes
// across storage backends (ZFS, btrfs, LVM-thin, dir, ceph) — the
// volume-show config returns *quotas*, not usage.
//
// `volumePath` is everything after `/volumes/` — for example
// `container/pp-dev` for the live container or
// `container/pp-dev/snapshots/Test2` for a snapshot.
//
// Returns the used bytes as an integer or null when the lookup
// failed (older incus, backend without per-volume accounting, etc).
async function readVolumeUsedBytes(pool, volumePath) {
  if (!pool || !volumePath) return null;
  try {
    const r = await execOnHost(
      `incus query /1.0/storage-pools/${pool}/volumes/${volumePath}/state 2>/dev/null`,
      { timeout: 5000 }
    );
    const state = JSON.parse(r.stdout || '{}');
    const used = state?.usage?.used ?? state?.used ?? null;
    if (typeof used === 'number' && used > 0) return used;
    if (typeof used === 'string' && /^\d+$/.test(used)) return parseInt(used, 10);
    return null;
  } catch {
    return null;
  }
}

// Resolve the storage pool a container's root device lives on.
// Returns the pool name or null on any failure. Cached at the call
// site for the duration of a request.
async function resolveContainerPool(incusName) {
  try {
    const r = await execOnHost(`incus query /1.0/instances/${incusName}?recursion=1 2>/dev/null`, { timeout: 5000 });
    const instance = JSON.parse(r.stdout || '{}');
    return instance?.expanded_devices?.root?.pool || instance?.devices?.root?.pool || null;
  } catch {
    return null;
  }
}

async function probeTcp(ip, port, timeoutMs = 2000) {
  if (!ip || !port) return false;
  // Bash's /dev/tcp uses a non-blocking connect under the hood; wrap
  // in `timeout` so a black-holed host doesn't pin the request. exit
  // 0 on success, non-zero on any failure mode.
  const cmd = `timeout ${Math.max(1, Math.ceil(timeoutMs / 1000))} bash -c 'exec 3<>/dev/tcp/${ip}/${port}' 2>/dev/null && echo OK || echo FAIL`;
  try {
    const r = await execOnHost(cmd, { timeout: timeoutMs + 1000 });
    return (r.stdout || '').trim() === 'OK';
  } catch {
    return false;
  }
}

// healthPath validation: must start with `/`, length-capped, restricted
// to URL-safe path/query characters. Same set used by the schema check
// in POST/PUT and by the GET parser when it recovers the value from
// the persisted comment line.
const HEALTH_PATH_REGEX = /^\/[A-Za-z0-9._~\-/?=&%]*$/;
const HEALTH_PATH_MAX = 256;
function validateHealthPath(value) {
  if (value === undefined || value === null || value === '') return { ok: true, value: null };
  if (typeof value !== 'string') return { ok: false, error: 'healthPath must be a string.' };
  if (value.length > HEALTH_PATH_MAX) return { ok: false, error: `healthPath exceeds ${HEALTH_PATH_MAX} characters.` };
  if (!HEALTH_PATH_REGEX.test(value)) {
    return { ok: false, error: 'healthPath must start with / and contain only URL-safe characters.' };
  }
  return { ok: true, value };
}

// HTTP-level upstream health probe. Layered on top of the TCP probe so
// the UI can distinguish "TCP accepts but the app errors out" (the
// nginx-fronts-broken-Express case operators have hit) from "TCP
// refused / timed out" (kernel-level reachability failure).
//
// HEAD with explicit Host so name-based vhosts route correctly. Up to
// one redirect followed inside the timeout budget — past that we report
// the redirect status and let the operator fix the loop. Any 2xx is
// healthy. Implementation uses Node's built-in `http`; no extra deps
// per the PR scope.
function probeHttp(ip, port, host, path, timeoutMs = 2000) {
  return new Promise((resolve) => {
    if (!ip || !port || !path) {
      resolve({ healthy: false, status: null, error: 'missing target' });
      return;
    }
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const doRequest = (target, redirectsLeft) => {
      let parsed;
      try {
        parsed = new URL(target);
      } catch (e) {
        finish({ healthy: false, status: null, error: 'invalid url' });
        return;
      }
      const req = http.request({
        host: parsed.hostname,
        port: parsed.port || 80,
        method: 'HEAD',
        path: (parsed.pathname || '/') + (parsed.search || ''),
        headers: { Host: host, 'User-Agent': 'ProxyPilot-HealthCheck/1.0', Accept: '*/*' },
        timeout: timeoutMs,
      }, (resp) => {
        const status = resp.statusCode || 0;
        // Redirect: follow once, but only to plaintext http on the same
        // host:port — anything else is the operator's TLS/host setup,
        // not a health signal we can usefully chase.
        const isRedirect = [301, 302, 303, 307, 308].includes(status);
        if (isRedirect && redirectsLeft > 0 && resp.headers.location) {
          resp.resume();
          let next;
          try { next = new URL(resp.headers.location, target).toString(); }
          catch { return finish({ healthy: false, status, error: 'bad redirect target' }); }
          return doRequest(next, redirectsLeft - 1);
        }
        resp.resume();
        finish({
          healthy: status >= 200 && status < 300,
          status,
          error: null,
        });
      });
      req.on('error', (err) => finish({ healthy: false, status: null, error: err.code || err.message || 'request error' }));
      req.on('timeout', () => { req.destroy(); finish({ healthy: false, status: null, error: 'timeout' }); });
      req.end();
    };
    doRequest(`http://${ip}:${port}${path}`, 1);
  });
}

// Enumerate TCP ports that are actually in LISTEN state inside the
// container. Reads /proc/net/tcp{,6} directly rather than shelling
// out to `ss` — minimal LXC images sometimes lack iproute2, and the
// procfs entries are always present and have a stable format.
//
// /proc/net/tcp row:
//   sl  local_address rem_address   st  ...
//    0: 0100007F:1538 00000000:0000 0A  ...
//
// local_address is `<ip-hex>:<port-hex>`. The IPv4 hex is little-
// endian per byte (0100007F → 7F.00.00.01 → 127.0.0.1). The port
// hex is big-endian. State 0A = TCP_LISTEN.
async function listListeningPorts(incusName) {
  const inner = 'cat /proc/net/tcp /proc/net/tcp6 2>/dev/null';
  const cmd = `incus exec ${incusName} -- sh -c ${JSON.stringify(inner)}`;
  let stdout = '';
  let stderr = '';
  try {
    const r = await execOnHost(cmd, { timeout: 5000 });
    stdout = r.stdout || '';
    stderr = r.stderr || '';
  } catch (e) {
    return { reachable: [], loopbackOnly: [], error: (e.stderr || e.message || '').trim() || 'introspect failed' };
  }
  const anyHost = new Set();
  const loopbackOnly = new Set();
  const lines = stdout.split('\n');
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('sl')) continue;
    const cols = line.split(/\s+/);
    if (cols.length < 4) continue;
    const local = cols[1];
    const state = cols[3];
    if (state !== '0A') continue;
    const colonIdx = local.lastIndexOf(':');
    if (colonIdx < 0) continue;
    const ipHex = local.slice(0, colonIdx);
    const portHex = local.slice(colonIdx + 1);
    const port = parseInt(portHex, 16);
    if (!port) continue;

    let isLoopback = false;
    let isAnyAddr = false;
    if (ipHex.length === 8) {
      // IPv4: little-endian per byte.
      const b0 = parseInt(ipHex.slice(0, 2), 16);
      const b1 = parseInt(ipHex.slice(2, 4), 16);
      const b2 = parseInt(ipHex.slice(4, 6), 16);
      const b3 = parseInt(ipHex.slice(6, 8), 16);
      const ip = `${b3}.${b2}.${b1}.${b0}`;
      if (ip === '0.0.0.0') isAnyAddr = true;
      else if (b3 === 127) isLoopback = true;
    } else if (ipHex.length === 32) {
      // IPv6 in /proc/net/tcp6 is little-endian per 4-byte word.
      // Easiest reliable signals: all zeros = `::`, the `::1` pattern
      // when normalized, and IPv4-mapped (last 32 bits is the v4 address
      // and the preceding 16 bits are 0xFFFF).
      const upper = ipHex.toUpperCase();
      if (upper === '00000000000000000000000000000000') {
        isAnyAddr = true;
      } else if (upper === '00000000000000000000000001000000') {
        isLoopback = true;
      } else if (upper.slice(16, 24) === '0000FFFF') {
        // IPv4-mapped: last 8 hex chars are the v4 address (same
        // little-endian-per-byte encoding as the v4 table).
        const v4hex = upper.slice(24, 32);
        const b0 = parseInt(v4hex.slice(0, 2), 16);
        const b3 = parseInt(v4hex.slice(6, 8), 16);
        if (b0 === 0 && b3 === 0) isAnyAddr = true;
        else if (b3 === 127) isLoopback = true;
      }
      // Other v6 binds (link-local, ULA, GUA) — treat as reachable.
    }
    if (isLoopback) loopbackOnly.add(port);
    else anyHost.add(port); // 0.0.0.0/:: or any specific interface
  }
  for (const p of anyHost) loopbackOnly.delete(p);
  return {
    reachable: [...anyHost].sort((a, b) => a - b),
    loopbackOnly: [...loopbackOnly].sort((a, b) => a - b),
    error: stderr && !stdout ? stderr.trim() : null,
  };
}

// GET /containers/:name/services - List Caddy services for this container (by IP)
lxcRouter.get('/containers/:name/services', async (req, res) => {
  const { name } = req.params;
  if (!validateName(name)) {
    return res.status(400).json({ success: false, error: 'Invalid container name.' });
  }

  try {
    const incusName = `${INSTANCE_PREFIX}${name}`;
    // Get container IP
    const result = await execOnHost(`incus list ${incusName} --format json 2>/dev/null`, { timeout: 5000 });
    const containers = JSON.parse(result.stdout || '[]');
    if (containers.length === 0) {
      return res.status(404).json({ success: false, error: 'Container not found.' });
    }
    const ip = extractIPv4(containers[0]);
    if (!ip) {
      return res.json({ success: true, services: [], ip: null });
    }

    // Scan Caddy sites directory for configs referencing this IP. We
    // also pull out the IP the file currently references so the UI can
    // flag "stale IP" — when an LXC restart hands out a new address
    // the sites file still points at the old one and Caddy 502s.
    const services = [];
    try {
      const files = await readdir(CADDY_SITES_DIR);
      for (const file of files) {
        const filePath = join(CADDY_SITES_DIR, file);
        const content = await readFile(filePath, 'utf-8');
        if (content.includes(ip)) {
          const domainMatch = content.match(/^(\S+)\s*\{/m);
          const upstreamMatch = content.match(/reverse_proxy\s+([\d.]+):(\d+)/);
          const hasTlsInternal = content.includes('tls internal');
          // Recover the optional HEAD-probe path from the marker
          // comment lxc.js writes when the operator opts in. Caddy
          // ignores `#` lines, so this round-trips losslessly.
          const healthMatch = content.match(/^#\s*proxypilot:\s*healthpath=(\S+)/m);
          const healthPath = healthMatch
            ? (validateHealthPath(healthMatch[1]).ok ? healthMatch[1] : null)
            : null;
          if (domainMatch) {
            services.push({
              domain: domainMatch[1],
              port: upstreamMatch ? parseInt(upstreamMatch[2], 10) : null,
              upstreamIp: upstreamMatch ? upstreamMatch[1] : null,
              obtainCert: !hasTlsInternal,
              healthPath,
            });
          }
        }
      }
    } catch {
      // CADDY_SITES_DIR may not exist yet
    }

    // Probe each upstream in parallel so a slow/unreachable host doesn't
    // block the whole list. 2s is enough to distinguish "refused" from
    // "no route" for typical LXC deployments. When the operator
    // configured a healthPath, layer an HTTP HEAD probe on top so the
    // UI can flag "TCP up, app errors" — the case the d519580 TCP
    // probe is blind to.
    await Promise.all(
      services.map(async (svc) => {
        if (!svc.port) {
          svc.reachable = null;
          svc.httpHealthy = null;
          svc.httpStatus = null;
          svc.httpError = null;
          return;
        }
        svc.reachable = await probeTcp(ip, svc.port, 2000);
        svc.staleIp = svc.upstreamIp && svc.upstreamIp !== ip;
        if (svc.reachable && svc.healthPath) {
          const result = await probeHttp(ip, svc.port, svc.domain, svc.healthPath, 2000);
          svc.httpHealthy = result.healthy;
          svc.httpStatus = result.status;
          svc.httpError = result.error;
        } else {
          svc.httpHealthy = null;
          svc.httpStatus = null;
          svc.httpError = null;
        }
      }),
    );

    // If any service failed the probe, ask the container what is
    // actually listening so the UI can render an actionable tooltip
    // ("nothing on :3000 — these ports are open: 22, 80") instead of
    // a generic 502. One ss call per refresh is cheap; skip it when
    // every probe succeeded.
    const anyUnreachable = services.some((s) => s.reachable === false);
    let listening = null;
    if (anyUnreachable) {
      listening = await listListeningPorts(incusName);
      for (const svc of services) {
        if (svc.reachable !== false || !svc.port) continue;
        svc.boundLoopbackOnly = listening.loopbackOnly.includes(svc.port);
      }
    }

    res.json({ success: true, services, ip, listening });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: `Failed to get services: ${(error.stderr || error.message || '').trim()}`,
    });
  }
});

// POST /containers/:name/services - Add a new service/domain mapping
lxcRouter.post('/containers/:name/services', async (req, res) => {
  const { name } = req.params;
  const { domain, port, obtainCert, healthPath } = req.body;

  if (!validateName(name)) {
    return res.status(400).json({ success: false, error: 'Invalid container name.' });
  }
  if (!domain || typeof domain !== 'string' || !domain.trim()) {
    return res.status(400).json({ success: false, error: 'Domain is required.' });
  }

  const cleanDomain = domain.trim();
  const svcPort = parseInt(port, 10) || 80;
  const cert = obtainCert !== false;
  const hp = validateHealthPath(healthPath);
  if (!hp.ok) {
    return res.status(400).json({ success: false, error: hp.error });
  }
  const cleanHealthPath = hp.value;

  try {
    const incusName = `${INSTANCE_PREFIX}${name}`;
    const result = await execOnHost(`incus list ${incusName} --format json 2>/dev/null`, { timeout: 5000 });
    const containers = JSON.parse(result.stdout || '[]');
    if (containers.length === 0) {
      return res.status(404).json({ success: false, error: 'Container not found.' });
    }
    const ip = extractIPv4(containers[0]);
    if (!ip) {
      return res.status(400).json({ success: false, error: 'Container has no IP address. Is it running?' });
    }

    // Make sure the main Caddyfile exists with the `import sites/*`
    // line — otherwise the file we are about to write is invisible to
    // the running Caddy and the operator gets a "saved but doesn't
    // resolve" symptom with no signal.
    try { await ensureCaddyStructure(); } catch (e) {
      console.error('[LXC] ensureCaddyStructure failed:', e?.message || e);
    }

    // Check if domain config already exists
    const configPath = join(CADDY_SITES_DIR, cleanDomain);
    if (existsSync(configPath)) {
      return res.status(409).json({ success: false, error: `Domain '${cleanDomain}' already has a Caddy config.` });
    }

    // Same-domain conflict guard: this domain is already a route in the
    // DB-backed Service Settings surface. Last-writer-wins between the
    // two Caddy site-file owners would silently overwrite one set of
    // changes; fail loud instead.
    try {
      const db = getDb();
      const otherRoute = db
        .prepare('SELECT id FROM service_http_routes WHERE domain = ? LIMIT 1')
        .get(cleanDomain);
      if (otherRoute) {
        return res.status(409).json({
          success: false,
          error: `Domain '${cleanDomain}' is already managed in the Service Settings dialog. Remove it there first or edit it there instead.`,
        });
      }
    } catch (e) {
      // service_http_routes table missing / DB unavailable — fall through.
      console.warn('[LXC] conflict-guard DB check failed:', e?.message || e);
    }

    // Write Caddy config. Persist the optional healthPath as a leading
    // comment line so the GET parser can recover it on read; Caddy
    // ignores `#` lines so this is invisible at the proxy layer.
    const tlsDirective = cert ? '' : '\n    tls internal';
    const healthMarker = cleanHealthPath ? `# proxypilot: healthpath=${cleanHealthPath}\n` : '';
    const caddyConfig = `${healthMarker}${cleanDomain} {${tlsDirective}\n    reverse_proxy ${ip}:${svcPort}\n    encode gzip zstd\n    log {\n        output file /var/log/caddy/${cleanDomain}.log\n    }\n}\n`;
    await writeFile(configPath, caddyConfig);

    // Reload Caddy. Surface the underlying error to the operator via a
    // warning field — silently swallowing it leaves them staring at a
    // domain that "saved" but never routes.
    let reloadWarning = null;
    try {
      await execOnHost('caddy reload --config /etc/caddy/Caddyfile 2>&1');
    } catch (reloadError) {
      const detail = (reloadError.stderr || reloadError.stdout || reloadError.message || '').trim();
      console.error('[LXC] Caddy reload failed:', detail);
      reloadWarning = `Config saved but Caddy reload failed: ${detail || 'unknown error'}`;
    }

    console.log(`[LXC] Added service ${cleanDomain} -> ${ip}:${svcPort} for container ${name}`);
    res.json({
      success: true,
      service: { domain: cleanDomain, port: svcPort, obtainCert: cert, healthPath: cleanHealthPath },
      ...(reloadWarning && { warning: reloadWarning }),
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: `Failed to add service: ${(error.stderr || error.message || '').trim()}`,
    });
  }
});

// PUT /containers/:name/services/:domain - Update an existing service
lxcRouter.put('/containers/:name/services/:domain', async (req, res) => {
  const { name, domain: oldDomain } = req.params;
  const { domain: newDomain, port, obtainCert, healthPath } = req.body;

  if (!validateName(name)) {
    return res.status(400).json({ success: false, error: 'Invalid container name.' });
  }
  const hp = validateHealthPath(healthPath);
  if (!hp.ok) {
    return res.status(400).json({ success: false, error: hp.error });
  }
  const cleanHealthPath = hp.value;

  try {
    const incusName = `${INSTANCE_PREFIX}${name}`;
    const result = await execOnHost(`incus list ${incusName} --format json 2>/dev/null`, { timeout: 5000 });
    const containers = JSON.parse(result.stdout || '[]');
    if (containers.length === 0) {
      return res.status(404).json({ success: false, error: 'Container not found.' });
    }
    const ip = extractIPv4(containers[0]);
    if (!ip) {
      return res.status(400).json({ success: false, error: 'Container has no IP address.' });
    }

    try { await ensureCaddyStructure(); } catch (e) {
      console.error('[LXC] ensureCaddyStructure failed:', e?.message || e);
    }

    // Same-domain conflict guard: if the rename-target is already a
    // route in the Service Settings surface, refuse rather than letting
    // the two surfaces silently overwrite each other's site files.
    // Skip when the operator is keeping the same domain (no rename).
    const targetDomain = (newDomain || oldDomain).trim();
    if (targetDomain !== oldDomain) {
      try {
        const db = getDb();
        const otherRoute = db
          .prepare('SELECT id FROM service_http_routes WHERE domain = ? LIMIT 1')
          .get(targetDomain);
        if (otherRoute) {
          return res.status(409).json({
            success: false,
            error: `Domain '${targetDomain}' is already managed in the Service Settings dialog. Remove it there first or edit it there instead.`,
          });
        }
      } catch (e) {
        console.warn('[LXC] conflict-guard DB check failed:', e?.message || e);
      }
    }

    // Remove old config
    const oldConfigPath = join(CADDY_SITES_DIR, oldDomain);
    if (existsSync(oldConfigPath)) {
      await unlink(oldConfigPath);
    }

    // Write new config. healthPath persists as a leading comment line
    // (Caddy ignores it; the GET parser recovers it). Empty/missing
    // healthPath in the request → no marker line, TCP-only behavior.
    const cleanDomain = (newDomain || oldDomain).trim();
    const svcPort = parseInt(port, 10) || 80;
    const cert = obtainCert !== false;
    const tlsDirective = cert ? '' : '\n    tls internal';
    const healthMarker = cleanHealthPath ? `# proxypilot: healthpath=${cleanHealthPath}\n` : '';
    const caddyConfig = `${healthMarker}${cleanDomain} {${tlsDirective}\n    reverse_proxy ${ip}:${svcPort}\n    encode gzip zstd\n    log {\n        output file /var/log/caddy/${cleanDomain}.log\n    }\n}\n`;
    const newConfigPath = join(CADDY_SITES_DIR, cleanDomain);
    await writeFile(newConfigPath, caddyConfig);

    let reloadWarning = null;
    try {
      await execOnHost('caddy reload --config /etc/caddy/Caddyfile 2>&1');
    } catch (reloadError) {
      const detail = (reloadError.stderr || reloadError.stdout || reloadError.message || '').trim();
      console.error('[LXC] Caddy reload failed:', detail);
      reloadWarning = `Config saved but Caddy reload failed: ${detail || 'unknown error'}`;
    }

    console.log(`[LXC] Updated service ${oldDomain} -> ${cleanDomain}:${svcPort} for container ${name}`);
    res.json({
      success: true,
      service: { domain: cleanDomain, port: svcPort, obtainCert: cert, healthPath: cleanHealthPath },
      ...(reloadWarning && { warning: reloadWarning }),
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: `Failed to update service: ${(error.stderr || error.message || '').trim()}`,
    });
  }
});

// DELETE /containers/:name/services/:domain - Remove a service/domain mapping
lxcRouter.delete('/containers/:name/services/:domain', async (req, res) => {
  const { name, domain } = req.params;

  if (!validateName(name)) {
    return res.status(400).json({ success: false, error: 'Invalid container name.' });
  }

  try {
    const configPath = join(CADDY_SITES_DIR, domain);
    if (!existsSync(configPath)) {
      return res.status(404).json({ success: false, error: `No Caddy config found for '${domain}'.` });
    }

    await unlink(configPath);

    let reloadWarning = null;
    try {
      await execOnHost('caddy reload --config /etc/caddy/Caddyfile 2>&1');
    } catch (reloadError) {
      const detail = (reloadError.stderr || reloadError.stdout || reloadError.message || '').trim();
      console.error('[LXC] Caddy reload failed:', detail);
      reloadWarning = `Config removed but Caddy reload failed: ${detail || 'unknown error'}`;
    }

    console.log(`[LXC] Removed service ${domain} for container ${name}`);
    res.json({
      success: true,
      message: `Service '${domain}' removed.`,
      ...(reloadWarning && { warning: reloadWarning }),
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: `Failed to remove service: ${(error.stderr || error.message || '').trim()}`,
    });
  }
});

// POST /containers/:name/exec - Execute a command and return JSON result
lxcRouter.post('/containers/:name/exec', async (req, res) => {
  const { name } = req.params;
  const { command, cwd } = req.body;

  if (!validateName(name)) {
    return res.status(400).json({ success: false, error: 'Invalid container name.' });
  }

  if (!command || typeof command !== 'string') {
    return res.status(400).json({ success: false, error: 'Command is required.' });
  }

  const incusName = `${INSTANCE_PREFIX}${name}`;
  const envSetup = 'export TERM=xterm DEBIAN_FRONTEND=noninteractive;';
  const fullCmd = cwd ? `${envSetup} cd ${JSON.stringify(cwd)} 2>/dev/null; ${command}` : `${envSetup} ${command}`;
  const execCmd = `incus exec ${incusName} -- sh -c ${JSON.stringify(fullCmd)}`;

  // Timeout is required: incus exec hangs after command finishes.
  // 60s is enough for quick commands; use BG mode for longer operations.
  try {
    const result = await execOnHost(execCmd, { timeout: 60000 });
    res.json({ success: true, stdout: result.stdout || '', stderr: result.stderr || '', exitCode: 0 });
  } catch (error) {
    // exec throws on non-zero exit OR timeout - both return collected output
    if (res.headersSent) return;
    res.json({
      success: true,
      stdout: error.stdout || '',
      stderr: error.stderr || '',
      exitCode: error.killed ? 124 : (error.code || 1),
      timedOut: !!error.killed,
    });
  }
});

// POST /containers/:name/tab-complete - Tab completion for paths
lxcRouter.post('/containers/:name/tab-complete', async (req, res) => {
  const { name } = req.params;
  const { partial, cwd } = req.body;

  if (!validateName(name)) {
    return res.status(400).json({ success: false, error: 'Invalid container name.' });
  }

  try {
    const incusName = `${INSTANCE_PREFIX}${name}`;
    const dir = partial.includes('/') ? partial.substring(0, partial.lastIndexOf('/') + 1) : (cwd || '.');
    const prefix = partial.includes('/') ? partial.substring(partial.lastIndexOf('/') + 1) : partial;
    const lsCmd = `cd ${JSON.stringify(cwd || '/root')} 2>/dev/null; ls -1a ${JSON.stringify(dir)} 2>/dev/null`;
    const result = await execOnHost(`incus exec ${incusName} -- bash -c ${JSON.stringify(lsCmd)}`, { timeout: 5000 });
    const entries = (result.stdout || '').split('\n').filter(e => e && e !== '.' && e !== '..' && e.startsWith(prefix));
    res.json({ success: true, completions: entries });
  } catch {
    res.json({ success: true, completions: [] });
  }
});

// POST /containers/import - Import a container from a backup tarball.
//
// Multer writes the upload to LXC_IMPORT_TMP_DIR on disk (memoryStorage
// previously buffered the whole file in RAM, which OOMed the backend on
// realistic backups). We then stream the temp file into `incus import -`
// stdin and unlink it in a finally regardless of success/failure.
lxcRouter.post('/import', upload.single('backup'), async (req, res) => {
  const { name } = req.body;

  // Helper to clean up the temp upload regardless of outcome.
  const cleanupTempFile = async () => {
    if (req.file?.path) {
      try { await unlink(req.file.path); } catch {}
    }
  };

  if (!name || !validateName(name)) {
    await cleanupTempFile();
    return res.status(400).json({ success: false, error: 'Valid container name is required.' });
  }

  if (!req.file) {
    return res.status(400).json({ success: false, error: 'Backup file is required.' });
  }

  const incusName = `${INSTANCE_PREFIX}${name}`;

  // Check if container already exists
  try {
    await execOnHost(`incus info ${incusName} 2>/dev/null`);
    await cleanupTempFile();
    return res.status(409).json({ success: false, error: `Container '${name}' already exists.` });
  } catch {
    // Good — doesn't exist
  }

  try {
    const importCmd = `incus import - ${incusName}`;
    await new Promise((resolve, reject) => {
      const child = spawnOnHost(importCmd);
      let stderr = '';
      child.stderr.on('data', (d) => { stderr += d.toString(); });
      child.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(stderr.trim() || `Import exited with code ${code}`));
      });
      child.on('error', reject);
      // Stream the temp file into incus stdin instead of buffering the
      // whole tarball into memory. createReadStream uses a 64 KiB
      // highWaterMark by default, which is fine here — the bottleneck
      // is incus, not Node.
      const fileStream = createReadStream(req.file.path);
      fileStream.on('error', reject);
      fileStream.pipe(child.stdin);
    });

    // Start the container
    try {
      await execOnHost(`incus start ${incusName}`, { timeout: 30000 });
    } catch {}

    res.status(201).json({ success: true, message: `Container '${name}' imported successfully.` });
  } catch (error) {
    // Cleanup on failure
    try { await execOnHost(`incus delete ${incusName} --force 2>/dev/null || true`); } catch {}
    res.status(500).json({ success: false, error: `Import failed: ${error.message}` });
  } finally {
    await cleanupTempFile();
  }
});

// GET /containers/:name/files - List files in a directory
lxcRouter.get('/containers/:name/files', async (req, res) => {
  const { name } = req.params;
  const dirPath = req.query.path || '/root';

  if (!validateName(name)) {
    return res.status(400).json({ success: false, error: 'Invalid container name.' });
  }

  try {
    const incusName = `${INSTANCE_PREFIX}${name}`;
    // Use ls with machine-parseable output
    const cmd = `incus exec ${incusName} -- ls -la --time-style=long-iso ${JSON.stringify(dirPath)}`;
    const result = await execOnHost(cmd, { timeout: 10000 });
    const lines = result.stdout.split('\n').filter(l => l.trim() && !l.startsWith('total'));
    const files = lines.map(line => {
      const parts = line.split(/\s+/);
      if (parts.length < 8) return null;
      const permissions = parts[0];
      const isDir = permissions.startsWith('d');
      const isLink = permissions.startsWith('l');
      const owner = parts[2];
      const group = parts[3];
      const size = parseInt(parts[4], 10);
      const date = parts[5];
      const time = parts[6];
      const fileName = parts.slice(7).join(' ').replace(/ -> .*$/, ''); // Remove symlink target
      if (fileName === '.' || fileName === '..') return null;
      return {
        name: fileName,
        permissions,
        owner,
        group,
        size,
        modified: `${date} ${time}`,
        isDir,
        isLink,
        path: dirPath === '/' ? `/${fileName}` : `${dirPath}/${fileName}`,
      };
    }).filter(Boolean);
    res.json({ success: true, path: dirPath, files });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: `Failed to list files: ${(error.stderr || error.message || '').trim()}`,
    });
  }
});

// GET /containers/:name/files/download - Download a file from the container
lxcRouter.get('/containers/:name/files/download', async (req, res) => {
  const { name } = req.params;
  const filePath = req.query.path;

  if (!validateName(name)) {
    return res.status(400).json({ success: false, error: 'Invalid container name.' });
  }

  if (!filePath) {
    return res.status(400).json({ success: false, error: 'File path is required.' });
  }

  try {
    const incusName = `${INSTANCE_PREFIX}${name}`;
    const fileName = filePath.split('/').pop();
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.setHeader('Content-Type', 'application/octet-stream');

    const pullCmd = `incus file pull ${incusName}${filePath} -`;
    const child = spawnOnHost(pullCmd);

    child.stdout.pipe(res);

    child.stderr.on('data', (data) => {
      console.error(`[LXC] File download stderr: ${data.toString()}`);
    });

    child.on('close', (code) => {
      if (code !== 0 && !res.headersSent) {
        res.status(500).json({ success: false, error: 'Failed to download file' });
      }
    });

    child.on('error', (err) => {
      if (!res.headersSent) {
        res.status(500).json({ success: false, error: err.message });
      }
    });
  } catch (error) {
    if (!res.headersSent) {
      res.status(500).json({ success: false, error: error.message });
    }
  }
});

// POST /containers/:name/files/upload - Upload a file to the container
lxcRouter.post('/containers/:name/files/upload', upload.single('file'), async (req, res) => {
  const { name } = req.params;
  const destPath = req.query.path || '/root/';

  if (!validateName(name)) {
    return res.status(400).json({ success: false, error: 'Invalid container name.' });
  }

  if (!req.file) {
    return res.status(400).json({ success: false, error: 'No file provided.' });
  }

  try {
    const incusName = `${INSTANCE_PREFIX}${name}`;
    const fullDest = destPath.endsWith('/') ? `${destPath}${req.file.originalname}` : destPath;
    const pushCmd = `incus file push - ${incusName}${fullDest}`;

    await new Promise((resolve, reject) => {
      const child = spawnOnHost(pushCmd);
      let stderr = '';

      child.stderr.on('data', (data) => { stderr += data.toString(); });

      child.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(stderr.trim() || `Push exited with code ${code}`));
      });

      child.on('error', reject);

      child.stdin.write(req.file.buffer);
      child.stdin.end();
    });

    res.json({
      success: true,
      message: `File uploaded to ${fullDest}`,
      path: fullDest,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: `Failed to upload file: ${error.message}`,
    });
  }
});

// POST /containers/:name/start - Start a container
lxcRouter.post('/containers/:name/start', async (req, res) => {
  const { name } = req.params;

  if (!validateName(name)) {
    return res.status(400).json({
      success: false,
      error: 'Invalid container name. Only alphanumeric characters and hyphens are allowed.',
    });
  }

  try {
    const incusName = `${INSTANCE_PREFIX}${name}`;
    await execOnHost(`incus start ${incusName} 2>&1`);
    // Ensure NAT and DNS after start (non-blocking)
    ensureNetworkNat().catch(() => {});
    ensureDns(incusName).catch(() => {});
    res.json({ success: true, message: `Container '${name}' started.` });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: `Failed to start container '${name}': ${(error.stderr || error.message || '').trim()}`,
      details: error.stderr || error.message,
    });
  }
});

// POST /containers/:name/stop - Stop a container
lxcRouter.post('/containers/:name/stop', async (req, res) => {
  const { name } = req.params;

  if (!validateName(name)) {
    return res.status(400).json({
      success: false,
      error: 'Invalid container name. Only alphanumeric characters and hyphens are allowed.',
    });
  }

  try {
    const incusName = `${INSTANCE_PREFIX}${name}`;
    await execOnHost(`incus stop ${incusName} --force 2>&1`);
    res.json({ success: true, message: `Container '${name}' stopped.` });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: `Failed to stop container '${name}': ${(error.stderr || error.message || '').trim()}`,
      details: error.stderr || error.message,
    });
  }
});

// POST /containers/:name/restart - Restart a container
lxcRouter.post('/containers/:name/restart', async (req, res) => {
  const { name } = req.params;

  if (!validateName(name)) {
    return res.status(400).json({
      success: false,
      error: 'Invalid container name. Only alphanumeric characters and hyphens are allowed.',
    });
  }

  try {
    const incusName = `${INSTANCE_PREFIX}${name}`;
    await execOnHost(`incus restart ${incusName} --force 2>&1`);
    // Ensure NAT and DNS after restart (non-blocking)
    ensureNetworkNat().catch(() => {});
    ensureDns(incusName).catch(() => {});
    res.json({ success: true, message: `Container '${name}' restarted.` });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: `Failed to restart container '${name}': ${(error.stderr || error.message || '').trim()}`,
      details: error.stderr || error.message,
    });
  }
});

// POST /containers/:name/resize - Resize container resource limits
lxcRouter.post('/containers/:name/resize', async (req, res) => {
  const { name } = req.params;
  const { cpu, memory } = req.body;

  if (!validateName(name)) {
    return res.status(400).json({
      success: false,
      error: 'Invalid container name. Only alphanumeric characters and hyphens are allowed.',
    });
  }

  if (!cpu && !memory) {
    return res.status(400).json({
      success: false,
      error: 'At least one of cpu or memory must be provided.',
    });
  }

  try {
    const incusName = `${INSTANCE_PREFIX}${name}`;

    if (cpu) {
      await execOnHost(`incus config set ${incusName} limits.cpu=${cpu}`);
    }
    if (memory) {
      await execOnHost(`incus config set ${incusName} limits.memory=${memory}MB`);
    }

    res.json({
      success: true,
      message: `Container '${name}' resource limits updated.`,
      config: {
        cpu: cpu || 'unchanged',
        memory: memory ? `${memory}MB` : 'unchanged',
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: `Failed to resize container '${name}': ${(error.stderr || error.message || '').trim()}`,
      details: error.stderr || error.message,
    });
  }
});

// DELETE /containers/:name - Delete a container
lxcRouter.delete('/containers/:name', requireSudo, async (req, res) => {
  const { name } = req.params;

  if (!validateName(name)) {
    return res.status(400).json({
      success: false,
      error: 'Invalid container name. Only alphanumeric characters and hyphens are allowed.',
    });
  }

  try {
    const incusName = `${INSTANCE_PREFIX}${name}`;

    // Get container IP before deletion for Caddy cleanup
    let containerIp = null;
    try {
      const listResult = await execOnHost(`incus list ${incusName} --format json 2>/dev/null`);
      const containers = JSON.parse(listResult.stdout);
      if (containers.length > 0) {
        containerIp = extractIPv4(containers[0]);
      }
    } catch {
      // Ignore - container may not exist or be stopped
    }

    // Stop container if running
    await execOnHost(`incus stop ${incusName} --force 2>/dev/null || true`);

    // Delete container
    await execOnHost(`incus delete ${incusName} --force 2>&1`);

    // Remove ALL associated Caddy configs if the container had an IP (supports multi-service)
    if (containerIp) {
      try {
        const files = await readdir(CADDY_SITES_DIR);
        let removedAny = false;
        for (const file of files) {
          const filePath = join(CADDY_SITES_DIR, file);
          const content = await readFile(filePath, 'utf-8');
          if (content.includes(containerIp)) {
            await unlink(filePath);
            console.log(`[LXC] Removed Caddy config: ${file} (contained IP ${containerIp})`);
            removedAny = true;
          }
        }
        if (removedAny) {
          try {
            await execOnHost('caddy reload --config /etc/caddy/Caddyfile 2>&1');
          } catch {
            // Ignore reload errors
          }
        }
      } catch {
        // Ignore Caddy cleanup errors
      }
    }

    res.json({ success: true, message: `Container '${name}' deleted.` });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: `Failed to delete container '${name}': ${(error.stderr || error.message || '').trim()}`,
      details: error.stderr || error.message,
    });
  }
});

// GET /containers/:name/export-info - Pre-flight estimate for an export.
//
// The frontend uses this to render a size-aware progress bar before
// kicking off the export proper. Estimate is the rootfs disk usage
// reported by the storage backend; the actual tarball will be smaller
// (gzip) but same order of magnitude. When the backend can't report
// usage (e.g. dir storage), bytes is null and the UI falls back to an
// indeterminate spinner.
lxcRouter.get('/containers/:name/export-info', async (req, res) => {
  const { name } = req.params;
  if (!validateName(name)) {
    return res.status(400).json({ success: false, error: 'Invalid container name.' });
  }
  const incusName = `${INSTANCE_PREFIX}${name}`;
  let estimatedBytes = null;
  let isRunning = false;
  try {
    const stateResult = await execOnHost(`incus list ${incusName} --format json 2>/dev/null`, { timeout: 5000 });
    const containers = JSON.parse(stateResult.stdout || '[]');
    if (containers.length === 0) {
      return res.status(404).json({ success: false, error: 'Container not found.' });
    }
    isRunning = containers[0]?.status === 'Running';
  } catch {}

  // Best-effort rootfs usage from the storage volume /state endpoint.
  // Wrapped — null on any failure and the UI degrades to an
  // indeterminate progress bar.
  const pool = await resolveContainerPool(incusName);
  if (pool) {
    estimatedBytes = await readVolumeUsedBytes(pool, `container/${incusName}`);
  }

  res.json({ success: true, estimatedBytes, isRunning });
});

// GET /containers/:name/export - Export container as tarball backup
lxcRouter.get('/containers/:name/export', async (req, res) => {
  const { name } = req.params;

  if (!validateName(name)) {
    return res.status(400).json({ success: false, error: 'Invalid container name.' });
  }

  try {
    const incusName = `${INSTANCE_PREFIX}${name}`;
    const fileName = `${name}-backup.tar.gz`;
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.setHeader('Content-Type', 'application/gzip');

    // Stream the export. The container can stay running — modern incus
    // takes a brief storage-level snapshot internally for a consistent
    // tarball without operator-visible downtime. The previous code
    // force-stopped the container, which yanked the bridge IP and made
    // the inline services list flicker to empty in the UI for the
    // duration of the export. Dropping that gives operators a true
    // online backup.
    const exportCmd = `incus export ${incusName} -`;
    const child = spawnOnHost(exportCmd);

    child.stdout.pipe(res);

    child.stderr.on('data', (data) => {
      console.log(`[LXC] Export stderr: ${data.toString().trim()}`);
    });

    child.on('close', async (code) => {
      if (code !== 0 && !res.headersSent) {
        res.status(500).json({ success: false, error: 'Export failed' });
      }
    });

    child.on('error', (err) => {
      if (!res.headersSent) {
        res.status(500).json({ success: false, error: err.message });
      }
    });
  } catch (error) {
    if (!res.headersSent) {
      res.status(500).json({ success: false, error: error.message });
    }
  }
});

// GET /containers/:name/snapshot/:snapshotName/export-info
//
// Pre-flight size estimate for downloading an existing snapshot.
// Mirrors /containers/:name/export-info but reads from the snapshot's
// storage volume instead of the live container's root volume.
lxcRouter.get('/containers/:name/snapshot/:snapshotName/export-info', async (req, res) => {
  const { name, snapshotName } = req.params;
  if (!validateName(name) || !validateName(snapshotName)) {
    return res.status(400).json({ success: false, error: 'Invalid name.' });
  }
  const incusName = `${INSTANCE_PREFIX}${name}`;
  let estimatedBytes = null;
  const pool = await resolveContainerPool(incusName);
  if (pool) {
    estimatedBytes = await readVolumeUsedBytes(pool, `container/${incusName}/snapshots/${snapshotName}`);
  }
  res.json({ success: true, estimatedBytes });
});

// GET /containers/:name/snapshot/:snapshotName/export
//
// Download a previously-taken snapshot as a tarball.
//
// `incus export` accepts only an instance name — passing
// `<container>/<snapshot>` fails silently and produces an empty
// file. The reliable path is:
//   1. incus copy <container>/<snapshot> <temp-instance>
//      (cheap on COW backends; full filesystem copy on dir)
//   2. incus export <temp-instance> -   → stdout pipe
//   3. incus delete <temp-instance> --force
// We always delete the temp instance on every termination path —
// successful close, error, and client disconnect — so a cancelled
// download doesn't leak a stopped container.
lxcRouter.get('/containers/:name/snapshot/:snapshotName/export', async (req, res) => {
  const { name, snapshotName } = req.params;
  if (!validateName(name) || !validateName(snapshotName)) {
    return res.status(400).json({ success: false, error: 'Invalid name.' });
  }
  const incusName = `${INSTANCE_PREFIX}${name}`;
  // Temp instance name: prefixed so it's recognizable in `incus list`
  // if anything ever leaks, suffixed with timestamp + random so two
  // concurrent downloads of the same snapshot can't collide.
  const tempName = `pp-snap-export-${Date.now()}-${randomUUID().slice(0, 8)}`;

  // Confirm the snapshot exists before kicking off the copy so the
  // failure path returns JSON instead of an empty tarball.
  try {
    const r = await execOnHost(`incus snapshot list ${incusName} --format json 2>/dev/null`, { timeout: 5000 });
    const snaps = JSON.parse(r.stdout || '[]');
    if (!snaps.some((s) => s.name === snapshotName)) {
      return res.status(404).json({ success: false, error: `Snapshot '${snapshotName}' not found on '${name}'.` });
    }
  } catch (e) {
    return res.status(500).json({ success: false, error: `Failed to verify snapshot: ${(e.stderr || e.message || '').trim()}` });
  }

  // Idempotent cleanup. Called from every termination path.
  let cleanupRan = false;
  const cleanup = async () => {
    if (cleanupRan) return;
    cleanupRan = true;
    try {
      await execOnHost(`incus delete ${tempName} --force`, { timeout: 60000 });
    } catch (e) {
      console.error(`[LXC] Failed to delete temp export instance ${tempName}: ${(e.stderr || e.message || '').trim()}`);
    }
  };

  // Materialize the snapshot as a stopped temp instance. On COW
  // backends this is near-instant; on dir backends it's a full
  // filesystem copy and can take minutes. 30 min covers realistic
  // upper bound; raise if needed via a future env knob.
  try {
    await execOnHost(`incus copy ${incusName}/${snapshotName} ${tempName}`, { timeout: 30 * 60 * 1000 });
  } catch (e) {
    return res.status(500).json({
      success: false,
      error: `Failed to prepare snapshot for export: ${(e.stderr || e.stdout || e.message || '').trim()}`,
    });
  }

  const fileName = `${name}-${snapshotName}-backup.tar.gz`;
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
  res.setHeader('Content-Type', 'application/gzip');

  let child;
  try {
    child = spawnOnHost(`incus export ${tempName} -`);
  } catch (e) {
    await cleanup();
    if (!res.headersSent) {
      res.status(500).json({ success: false, error: e.message });
    }
    return;
  }

  child.stdout.pipe(res);

  let stderr = '';
  child.stderr.on('data', (d) => {
    stderr += d.toString();
    console.log(`[LXC] Snapshot export stderr: ${d.toString().trim()}`);
  });

  child.on('close', async (code) => {
    await cleanup();
    if (code !== 0 && !res.headersSent) {
      res.status(500).json({ success: false, error: `Export failed: ${stderr.trim() || `incus exited ${code}`}` });
    }
  });

  child.on('error', async (err) => {
    await cleanup();
    if (!res.headersSent) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // If the client (browser) cancels mid-download, kill the export
  // child and clean up the temp instance. Otherwise the temp
  // container leaks and `incus list` accumulates pp-snap-export-*
  // entries.
  req.on('close', async () => {
    if (child && !child.killed) {
      try { child.kill('SIGTERM'); } catch {}
    }
    await cleanup();
  });
});

// POST /containers/:name/snapshot - Create a snapshot
lxcRouter.post('/containers/:name/snapshot', async (req, res) => {
  const { name } = req.params;
  const { snapshotName, note } = req.body;

  if (!validateName(name)) {
    return res.status(400).json({
      success: false,
      error: 'Invalid container name. Only alphanumeric characters and hyphens are allowed.',
    });
  }

  if (!validateName(snapshotName)) {
    return res.status(400).json({
      success: false,
      error: 'Invalid snapshot name. Only alphanumeric characters and hyphens are allowed.',
    });
  }

  // Snapshot create copies the container's filesystem; on running
  // Docker-in-LXC instances with overlay layers this routinely runs
  // longer than execOnHost's 30s default. SIGTERM at 30s leaves stderr
  // empty and the operator stares at the bare nsenter wrapper command
  // with no signal as to what happened. 5 min covers realistic worst
  // cases without pinning the request indefinitely.
  const SNAPSHOT_TIMEOUT_MS = 5 * 60 * 1000;

  try {
    const incusName = `${INSTANCE_PREFIX}${name}`;
    await execOnHost(`incus snapshot create ${incusName} ${snapshotName}`, { timeout: SNAPSHOT_TIMEOUT_MS });
    // Set description if note provided
    if (note) {
      await execOnHost(`incus config set ${incusName}/snapshots/${snapshotName} user.note=${JSON.stringify(note)} 2>&1`).catch(() => {});
    }
    res.json({
      success: true,
      message: `Snapshot '${snapshotName}' created for container '${name}'.`,
    });
  } catch (error) {
    res.status(500).json(formatSnapshotError(`Failed to create snapshot for container '${name}'`, error, SNAPSHOT_TIMEOUT_MS));
  }
});

// POST /containers/:name/snapshot/:snapshotName/restore - Restore a snapshot
lxcRouter.post('/containers/:name/snapshot/:snapshotName/restore', async (req, res) => {
  const { name, snapshotName } = req.params;

  if (!validateName(name)) {
    return res.status(400).json({
      success: false,
      error: 'Invalid container name. Only alphanumeric characters and hyphens are allowed.',
    });
  }

  if (!validateName(snapshotName)) {
    return res.status(400).json({
      success: false,
      error: 'Invalid snapshot name. Only alphanumeric characters and hyphens are allowed.',
    });
  }

  // Restore touches the same storage as create; same timeout reasoning.
  const SNAPSHOT_TIMEOUT_MS = 5 * 60 * 1000;

  try {
    const incusName = `${INSTANCE_PREFIX}${name}`;
    await execOnHost(`incus snapshot restore ${incusName} ${snapshotName}`, { timeout: SNAPSHOT_TIMEOUT_MS });
    res.json({
      success: true,
      message: `Snapshot '${snapshotName}' restored for container '${name}'.`,
    });
  } catch (error) {
    res.status(500).json(formatSnapshotError(`Failed to restore snapshot for container '${name}'`, error, SNAPSHOT_TIMEOUT_MS));
  }
});

// DELETE /containers/:name/snapshot/:snapshotName - Delete a snapshot
lxcRouter.delete('/containers/:name/snapshot/:snapshotName', async (req, res) => {
  const { name, snapshotName } = req.params;

  if (!validateName(name)) {
    return res.status(400).json({
      success: false,
      error: 'Invalid container name. Only alphanumeric characters and hyphens are allowed.',
    });
  }

  if (!validateName(snapshotName)) {
    return res.status(400).json({
      success: false,
      error: 'Invalid snapshot name. Only alphanumeric characters and hyphens are allowed.',
    });
  }

  // Delete reclaims storage; on copy-on-write backends with many
  // overlapping snapshots this can take a while.
  const SNAPSHOT_TIMEOUT_MS = 2 * 60 * 1000;

  try {
    const incusName = `${INSTANCE_PREFIX}${name}`;
    await execOnHost(`incus snapshot delete ${incusName} ${snapshotName}`, { timeout: SNAPSHOT_TIMEOUT_MS });
    // Clean up notes for deleted snapshot
    try {
      const db = getDb();
      db.prepare('DELETE FROM snapshot_notes WHERE container_name = ? AND snapshot_name = ?').run(name, snapshotName);
    } catch {}
    res.json({
      success: true,
      message: `Snapshot '${snapshotName}' deleted from container '${name}'.`,
    });
  } catch (error) {
    res.status(500).json(formatSnapshotError(`Failed to delete snapshot from container '${name}'`, error, SNAPSHOT_TIMEOUT_MS));
  }
});

// GET /containers/:name/snapshot/:snapshotName/notes - Get notes for a snapshot
lxcRouter.get('/containers/:name/snapshot/:snapshotName/notes', (req, res) => {
  const { name, snapshotName } = req.params;

  if (!validateName(name) || !validateName(snapshotName)) {
    return res.status(400).json({ success: false, error: 'Invalid name.' });
  }

  try {
    const db = getDb();
    const notes = db.prepare(
      'SELECT id, note, created_at FROM snapshot_notes WHERE container_name = ? AND snapshot_name = ? ORDER BY created_at DESC'
    ).all(name, snapshotName);
    res.json({ success: true, notes });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to get notes.' });
  }
});

// POST /containers/:name/snapshot/:snapshotName/notes - Add a note to a snapshot
lxcRouter.post('/containers/:name/snapshot/:snapshotName/notes', (req, res) => {
  const { name, snapshotName } = req.params;
  const { note } = req.body;

  if (!validateName(name) || !validateName(snapshotName)) {
    return res.status(400).json({ success: false, error: 'Invalid name.' });
  }

  if (!note || typeof note !== 'string' || !note.trim()) {
    return res.status(400).json({ success: false, error: 'Note text is required.' });
  }

  try {
    const db = getDb();
    const id = uuidv4();
    db.prepare(
      'INSERT INTO snapshot_notes (id, container_name, snapshot_name, note) VALUES (?, ?, ?, ?)'
    ).run(id, name, snapshotName, note.trim());
    res.json({ success: true, id, message: 'Note added.' });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to add note.' });
  }
});

// DELETE /containers/:name/snapshot/:snapshotName/notes/:noteId - Delete a note
lxcRouter.delete('/containers/:name/snapshot/:snapshotName/notes/:noteId', (req, res) => {
  const { name, snapshotName, noteId } = req.params;

  if (!validateName(name) || !validateName(snapshotName)) {
    return res.status(400).json({ success: false, error: 'Invalid name.' });
  }

  try {
    const db = getDb();
    db.prepare('DELETE FROM snapshot_notes WHERE id = ? AND container_name = ? AND snapshot_name = ?').run(noteId, name, snapshotName);
    res.json({ success: true, message: 'Note deleted.' });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to delete note.' });
  }
});

// ─── Incus Infrastructure Management ─────────────────────────────────────────

// GET /networks - List all Incus networks
lxcRouter.get('/networks', async (req, res) => {
  try {
    const result = await execOnHost('incus network list --format json', { timeout: 10000 });
    const networks = JSON.parse(result.stdout || '[]');
    res.json({ success: true, networks });
  } catch (error) {
    res.status(500).json({ success: false, error: error.stderr || error.message });
  }
});

// GET /networks/:name - Get network details
lxcRouter.get('/networks/:name', async (req, res) => {
  const { name } = req.params;
  if (!validateName(name)) {
    return res.status(400).json({ success: false, error: 'Invalid network name.' });
  }
  try {
    const result = await execOnHost(`incus network show ${name} --format json`, { timeout: 10000 });
    const network = JSON.parse(result.stdout || '{}');
    res.json({ success: true, network });
  } catch (error) {
    res.status(500).json({ success: false, error: error.stderr || error.message });
  }
});

// PUT /networks/:name - Update network config
lxcRouter.put('/networks/:name', async (req, res) => {
  const { name } = req.params;
  const { config } = req.body;
  if (!validateName(name)) {
    return res.status(400).json({ success: false, error: 'Invalid network name.' });
  }
  if (!config || typeof config !== 'object') {
    return res.status(400).json({ success: false, error: 'Config object required.' });
  }
  try {
    for (const [key, value] of Object.entries(config)) {
      // Validate key format (only alphanumeric, dots, dashes)
      if (!/^[a-zA-Z0-9._-]+$/.test(key)) continue;
      const safeValue = String(value).replace(/['"\\]/g, '');
      await execOnHost(`incus network set ${name} ${key} ${safeValue}`, { timeout: 10000 });
    }
    res.json({ success: true, message: `Network '${name}' updated.` });
  } catch (error) {
    res.status(500).json({ success: false, error: error.stderr || error.message });
  }
});

// POST /networks/:name/unset - Unset a network config key
lxcRouter.post('/networks/:name/unset', async (req, res) => {
  const { name } = req.params;
  const { key } = req.body;
  if (!validateName(name)) {
    return res.status(400).json({ success: false, error: 'Invalid network name.' });
  }
  if (!key || !/^[a-zA-Z0-9._-]+$/.test(key)) {
    return res.status(400).json({ success: false, error: 'Invalid config key.' });
  }
  try {
    await execOnHost(`incus network unset ${name} ${key}`, { timeout: 10000 });
    res.json({ success: true, message: `Key '${key}' unset on network '${name}'.` });
  } catch (error) {
    res.status(500).json({ success: false, error: error.stderr || error.message });
  }
});

// GET /storage-pools - List storage pools
lxcRouter.get('/storage-pools', async (req, res) => {
  try {
    const result = await execOnHost('incus storage list --format json', { timeout: 10000 });
    const pools = JSON.parse(result.stdout || '[]');
    // Get usage info for each pool
    const poolsWithUsage = [];
    for (const pool of pools) {
      try {
        const infoResult = await execOnHost(`incus storage info ${pool.name} --format json`, { timeout: 10000 });
        const info = JSON.parse(infoResult.stdout || '{}');
        poolsWithUsage.push({ ...pool, info });
      } catch {
        poolsWithUsage.push(pool);
      }
    }
    res.json({ success: true, pools: poolsWithUsage });
  } catch (error) {
    res.status(500).json({ success: false, error: error.stderr || error.message });
  }
});

// GET /profiles - List profiles
lxcRouter.get('/profiles', async (req, res) => {
  try {
    const result = await execOnHost('incus profile list --format json', { timeout: 10000 });
    const profiles = JSON.parse(result.stdout || '[]');
    res.json({ success: true, profiles });
  } catch (error) {
    res.status(500).json({ success: false, error: error.stderr || error.message });
  }
});

// GET /profiles/:name - Get profile details
lxcRouter.get('/profiles/:name', async (req, res) => {
  const { name } = req.params;
  if (!validateName(name)) {
    return res.status(400).json({ success: false, error: 'Invalid profile name.' });
  }
  try {
    const result = await execOnHost(`incus query /1.0/profiles/${name}`, { timeout: 10000 });
    const profile = JSON.parse(result.stdout || '{}');
    res.json({ success: true, profile });
  } catch (error) {
    res.status(500).json({ success: false, error: error.stderr || error.message });
  }
});

// GET /cached-images - List locally cached images
lxcRouter.get('/cached-images', async (req, res) => {
  try {
    const result = await execOnHost('incus image list --format json', { timeout: 15000 });
    const images = JSON.parse(result.stdout || '[]');
    res.json({ success: true, images });
  } catch (error) {
    res.status(500).json({ success: false, error: error.stderr || error.message });
  }
});

// DELETE /cached-images/:fingerprint - Delete a cached image
lxcRouter.delete('/cached-images/:fingerprint', async (req, res) => {
  const { fingerprint } = req.params;
  if (!fingerprint || !/^[a-f0-9]+$/.test(fingerprint)) {
    return res.status(400).json({ success: false, error: 'Invalid image fingerprint.' });
  }
  try {
    await execOnHost(`incus image delete ${fingerprint}`, { timeout: 15000 });
    res.json({ success: true, message: 'Image deleted.' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.stderr || error.message });
  }
});

// ----------------------------------------------------------------------------
// Host Cleanup
// ----------------------------------------------------------------------------
//
// Surfaces three categories of safely-removable artifacts that
// accumulate on a ProxyPilot host over time. Two-step UX: GET
// /preview enumerates everything with sizes; POST /execute deletes
// only the categories the operator explicitly opts into.
//
// Excluded by design:
//   - The host's Docker daemon — ProxyPilot itself runs in Docker,
//     so a generic `docker system prune` from the dashboard could
//     wipe the dashboard. Per-LXC Docker prune is a separate
//     feature and belongs inside each container's own management
//     surface.
//   - LXC snapshots and storage volumes attached to instances —
//     operator data, never auto-prune.
//   - Caddy site files — already cleaned up by the container
//     delete handler.

const PP_SNAP_EXPORT_PREFIX = 'pp-snap-export-';
// Stale-cutoff for upload temp files. 24h is comfortably longer than
// any realistic import (50 GiB at 100 Mbit ≈ 70 min) so we never
// race a still-running upload, while still reclaiming disk from
// failed/cancelled uploads.
const IMPORT_TEMP_STALE_MS = 24 * 60 * 60 * 1000;

// GET /cleanup/preview - Enumerate cleanable artifacts.
lxcRouter.get('/cleanup/preview', async (req, res) => {
  const categories = [];

  // 1. Unused Incus images. `used_by` is empty when no instance is
  //    currently using the image. Auto-downloaded images
  //    accumulate every time an operator picks a different distro
  //    template — they're cheap to re-download and safe to remove.
  try {
    const r = await execOnHost('incus image list --format json 2>/dev/null', { timeout: 15000 });
    const images = JSON.parse(r.stdout || '[]');
    const unused = images.filter((img) => !Array.isArray(img.used_by) || img.used_by.length === 0);
    categories.push({
      key: 'images',
      label: 'Unused Incus images',
      description: 'Image cache entries not currently used by any container. Re-downloaded automatically when needed.',
      count: unused.length,
      bytes: unused.reduce((s, i) => s + (typeof i.size === 'number' ? i.size : 0), 0),
      items: unused.map((img) => ({
        id: img.fingerprint,
        label: (Array.isArray(img.aliases) && img.aliases[0]?.name) || (img.fingerprint || '').slice(0, 12),
        sublabel: img.update_source?.alias || img.properties?.description || null,
        size: typeof img.size === 'number' ? img.size : 0,
      })),
    });
  } catch (e) {
    categories.push({ key: 'images', label: 'Unused Incus images', count: 0, bytes: 0, items: [], error: (e.stderr || e.message || '').trim() });
  }

  // 2. Orphaned snapshot-export temp containers. The snapshot
  //    download endpoint creates pp-snap-export-<ts>-<rand> via
  //    `incus copy` and deletes it on every termination path,
  //    including client disconnect. If the backend itself crashes
  //    mid-export, the temp instance leaks — surface those here.
  try {
    const r = await execOnHost('incus list --format json 2>/dev/null', { timeout: 15000 });
    const containers = JSON.parse(r.stdout || '[]');
    const orphans = containers.filter((c) => typeof c.name === 'string' && c.name.startsWith(PP_SNAP_EXPORT_PREFIX));
    categories.push({
      key: 'exportTemps',
      label: 'Orphaned snapshot-export temp containers',
      description: 'Created by snapshot downloads; normally auto-cleaned on download finish or cancel. Leftovers usually mean the backend crashed mid-export.',
      count: orphans.length,
      bytes: 0,
      items: orphans.map((c) => ({
        id: c.name,
        label: c.name,
        sublabel: c.status || null,
        size: 0,
      })),
    });
  } catch (e) {
    categories.push({ key: 'exportTemps', label: 'Orphaned snapshot-export temp containers', count: 0, bytes: 0, items: [], error: (e.stderr || e.message || '').trim() });
  }

  // 3. Stale upload temp files. Multer disk-storage writes uploaded
  //    backups here before piping into incus import. The /import
  //    handler unlinks on every termination path, but a backend
  //    crash during the import phase leaves the tarball behind.
  try {
    let names = [];
    try { names = await readdir(LXC_IMPORT_TMP_DIR); } catch { names = []; }
    const cutoff = Date.now() - IMPORT_TEMP_STALE_MS;
    const stale = [];
    for (const name of names) {
      try {
        const s = await stat(join(LXC_IMPORT_TMP_DIR, name));
        if (s.isFile() && s.mtimeMs < cutoff) {
          stale.push({ id: name, label: name, sublabel: `modified ${new Date(s.mtimeMs).toISOString()}`, size: s.size });
        }
      } catch {}
    }
    categories.push({
      key: 'importTemps',
      label: 'Stale upload temp files (>24h)',
      description: `Buffered backup uploads in ${LXC_IMPORT_TMP_DIR}. Normally auto-deleted after import; older than 24h means a failed upload.`,
      count: stale.length,
      bytes: stale.reduce((s, i) => s + i.size, 0),
      items: stale,
    });
  } catch (e) {
    categories.push({ key: 'importTemps', label: 'Stale upload temp files (>24h)', count: 0, bytes: 0, items: [], error: e.message });
  }

  res.json({ success: true, categories });
});

// POST /cleanup/execute - Run the requested cleanup categories.
//
// Body: { categories: ['images', 'exportTemps', 'importTemps'] }
//
// Re-enumerates everything fresh (the preview snapshot may be stale
// by the time the operator clicks Clean Up — a download could have
// completed and reclaimed its temp instance, etc.) so we never
// delete something that just transitioned out of "orphaned" state.
// Each category is best-effort: a per-item failure is logged and
// reported but doesn't abort the rest of the run.
lxcRouter.post('/cleanup/execute', requireSudo, async (req, res) => {
  const { categories } = req.body || {};
  const allowed = new Set(['images', 'exportTemps', 'importTemps']);
  if (!Array.isArray(categories) || categories.length === 0 || categories.some((c) => !allowed.has(c))) {
    return res.status(400).json({ success: false, error: 'Invalid categories.' });
  }
  const selected = new Set(categories);
  const results = {};

  // 1. Unused Incus images.
  if (selected.has('images')) {
    const result = { removed: 0, freedBytes: 0, errors: [] };
    try {
      const r = await execOnHost('incus image list --format json 2>/dev/null', { timeout: 15000 });
      const images = JSON.parse(r.stdout || '[]');
      const unused = images.filter((img) => !Array.isArray(img.used_by) || img.used_by.length === 0);
      for (const img of unused) {
        try {
          await execOnHost(`incus image delete ${img.fingerprint}`, { timeout: 30000 });
          result.removed++;
          if (typeof img.size === 'number') result.freedBytes += img.size;
        } catch (e) {
          result.errors.push(`${img.fingerprint.slice(0, 12)}: ${(e.stderr || e.message || '').trim()}`);
        }
      }
    } catch (e) {
      result.errors.push(`enumerate failed: ${(e.stderr || e.message || '').trim()}`);
    }
    results.images = result;
  }

  // 2. Orphaned snapshot-export temp containers. Force-delete since
  //    they may be in a stopped/created state from a crashed export.
  if (selected.has('exportTemps')) {
    const result = { removed: 0, freedBytes: 0, errors: [] };
    try {
      const r = await execOnHost('incus list --format json 2>/dev/null', { timeout: 15000 });
      const containers = JSON.parse(r.stdout || '[]');
      const orphans = containers.filter((c) => typeof c.name === 'string' && c.name.startsWith(PP_SNAP_EXPORT_PREFIX));
      for (const c of orphans) {
        try {
          await execOnHost(`incus delete ${c.name} --force`, { timeout: 60000 });
          result.removed++;
        } catch (e) {
          result.errors.push(`${c.name}: ${(e.stderr || e.message || '').trim()}`);
        }
      }
    } catch (e) {
      result.errors.push(`enumerate failed: ${(e.stderr || e.message || '').trim()}`);
    }
    results.exportTemps = result;
  }

  // 3. Stale upload temp files. Re-stat each before unlink so a
  //    file that was just modified by an in-flight upload is left
  //    alone even if it was in the preview list.
  if (selected.has('importTemps')) {
    const result = { removed: 0, freedBytes: 0, errors: [] };
    try {
      let names = [];
      try { names = await readdir(LXC_IMPORT_TMP_DIR); } catch { names = []; }
      const cutoff = Date.now() - IMPORT_TEMP_STALE_MS;
      for (const name of names) {
        const path = join(LXC_IMPORT_TMP_DIR, name);
        try {
          const s = await stat(path);
          if (!s.isFile() || s.mtimeMs >= cutoff) continue;
          await unlink(path);
          result.removed++;
          result.freedBytes += s.size;
        } catch (e) {
          result.errors.push(`${name}: ${e.message}`);
        }
      }
    } catch (e) {
      result.errors.push(`enumerate failed: ${e.message}`);
    }
    results.importTemps = result;
  }

  res.json({ success: true, results });
});
