import { Router } from 'express';
import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import { writeFile, readdir, readFile, unlink } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import multer from 'multer';
import { requireAdmin } from '../middleware/auth.js';
import { getDb } from '../db.js';
import { v4 as uuidv4 } from 'uuid';

const execAsync = promisify(exec);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 * 1024 } }); // 2GB limit

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
      }
    }
  } catch (err) {
    console.error('[LXC] incus network NAT setup failed:', err.message);
  }

  // Step 3: Fallback — add iptables MASQUERADE directly for container subnets
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

// Extract IPv4 address from container state
function extractIPv4(container) {
  if (!container.state?.network) return null;
  for (const [name, iface] of Object.entries(container.state.network)) {
    if (name === 'lo') continue;
    for (const addr of iface.addresses || []) {
      if (addr.family === 'inet' && !addr.address.startsWith('127.')) {
        return addr.address;
      }
    }
  }
  return null;
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
    const snapshots = JSON.parse(result.stdout);
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
  const { name, image, profile, domain, port, cpu, memory } = req.body;

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
    domain: domain || null,
    port: port || null,
    cpu: cpu || null,
    memory: memory || null,
    error: null,
    ip: null,
    stderr: '',
  };
  activeCreations.set(incusName, creation);

  // Start the launch process asynchronously (no timeout — runs until done)
  const profileArg = profile ? `--profile ${profile}` : '--profile default';
  const launchCmd = `incus launch ${image} ${incusName} ${profileArg}`;
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

      // Configure Caddy reverse proxy
      if (domain && port && ip) {
        creation.phase = 'caddy';
        creation.message = 'Configuring reverse proxy...';

        const caddyConfig = `${domain} {\n    reverse_proxy ${ip}:${port}\n    encode gzip zstd\n    log {\n        output file /var/log/caddy/${domain}.log\n    }\n}\n`;
        const configPath = join(CADDY_SITES_DIR, domain);
        await writeFile(configPath, caddyConfig);
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
  const fullCmd = cwd ? `cd ${JSON.stringify(cwd)} 2>/dev/null; ${command}` : command;
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

// POST /containers/import - Import a container from a backup tarball
lxcRouter.post('/import', upload.single('backup'), async (req, res) => {
  const { name } = req.body;

  if (!name || !validateName(name)) {
    return res.status(400).json({ success: false, error: 'Valid container name is required.' });
  }

  if (!req.file) {
    return res.status(400).json({ success: false, error: 'Backup file is required.' });
  }

  const incusName = `${INSTANCE_PREFIX}${name}`;

  // Check if container already exists
  try {
    await execOnHost(`incus info ${incusName} 2>/dev/null`);
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
      child.stdin.write(req.file.buffer);
      child.stdin.end();
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
lxcRouter.delete('/containers/:name', async (req, res) => {
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

    // Remove associated Caddy config if the container had an IP
    if (containerIp) {
      try {
        const files = await readdir(CADDY_SITES_DIR);
        for (const file of files) {
          const filePath = join(CADDY_SITES_DIR, file);
          const content = await readFile(filePath, 'utf-8');
          if (content.includes(containerIp)) {
            await unlink(filePath);
            // Reload Caddy after removing config
            try {
              await execOnHost('caddy reload --config /etc/caddy/Caddyfile 2>&1');
            } catch {
              // Ignore reload errors
            }
            break;
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

    // Stop the container first if running (required for clean export)
    let wasRunning = false;
    try {
      const stateResult = await execOnHost(`incus list ${incusName} --format json 2>/dev/null`, { timeout: 5000 });
      const containers = JSON.parse(stateResult.stdout || '[]');
      wasRunning = containers[0]?.status === 'Running';
      if (wasRunning) {
        console.log(`[LXC] Stopping ${incusName} for export...`);
        await execOnHost(`incus stop ${incusName} --force`, { timeout: 30000 });
      }
    } catch {}

    // Use incus export which creates a tarball to stdout
    const exportCmd = `incus export ${incusName} -`;
    const child = spawnOnHost(exportCmd);

    child.stdout.pipe(res);

    child.stderr.on('data', (data) => {
      console.log(`[LXC] Export stderr: ${data.toString().trim()}`);
    });

    child.on('close', async (code) => {
      // Restart container if it was running before
      if (wasRunning) {
        try {
          await execOnHost(`incus start ${incusName}`, { timeout: 30000 });
          console.log(`[LXC] Restarted ${incusName} after export`);
        } catch (err) {
          console.error(`[LXC] Failed to restart after export:`, err.message);
        }
      }
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

  try {
    const incusName = `${INSTANCE_PREFIX}${name}`;
    await execOnHost(`incus snapshot create ${incusName} ${snapshotName} 2>&1`);
    // Set description if note provided
    if (note) {
      await execOnHost(`incus config set ${incusName}/snapshots/${snapshotName} user.note=${JSON.stringify(note)} 2>&1`).catch(() => {});
    }
    res.json({
      success: true,
      message: `Snapshot '${snapshotName}' created for container '${name}'.`,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: `Failed to create snapshot for container '${name}': ${(error.stderr || error.message || '').trim()}`,
      details: error.stderr || error.message,
    });
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

  try {
    const incusName = `${INSTANCE_PREFIX}${name}`;
    await execOnHost(`incus snapshot restore ${incusName} ${snapshotName} 2>&1`);
    res.json({
      success: true,
      message: `Snapshot '${snapshotName}' restored for container '${name}'.`,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: `Failed to restore snapshot for container '${name}': ${(error.stderr || error.message || '').trim()}`,
      details: error.stderr || error.message,
    });
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

  try {
    const incusName = `${INSTANCE_PREFIX}${name}`;
    await execOnHost(`incus snapshot delete ${incusName} ${snapshotName} 2>&1`);
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
    res.status(500).json({
      success: false,
      error: `Failed to delete snapshot from container '${name}': ${(error.stderr || error.message || '').trim()}`,
      details: error.stderr || error.message,
    });
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
    const result = await execOnHost(`incus profile show ${name} --format json`, { timeout: 10000 });
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
