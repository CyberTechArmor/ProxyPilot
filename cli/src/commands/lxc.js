import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import {
  createInstance,
  getInstance,
  getInstanceState,
  setInstanceState,
  deleteInstance,
  updateInstance,
  listInstances,
  listSnapshots as incusListSnapshots,
  deleteSnapshot as incusDeleteSnapshot,
} from '../incus/client.js';
import { execInContainer, shellInContainer } from '../incus/exec.js';
import { addRoute, removeRoute, enableRoute, disableRoute } from '../caddy/client.js';
import { getDb } from '../db/index.js';
import { getConfig } from '../config.js';
import * as output from '../output.js';
import { snapshotCreate, snapshotList, snapshotRestore, snapshotDelete } from '../lxc/snapshots.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Look up a container by name in SQLite. Throws if not found.
 */
function getContainer(db, name) {
  const container = db.prepare('SELECT * FROM containers WHERE name = ?').get(name);
  if (!container) {
    throw new Error(`Container '${name}' not found. Use 'proxypilot lxc list' to see available containers.`);
  }
  return container;
}

/**
 * Get the resource profile limits from the database.
 * Merges with any explicit CPU/memory/disk overrides.
 */
function getResourceLimits(db, profileName, overrides = {}) {
  const profile = db.prepare('SELECT * FROM profiles WHERE name = ?').get(profileName);
  if (!profile) {
    throw new Error(`Resource profile '${profileName}' not found. Available: small, medium, large`);
  }
  return {
    cpu_limit: overrides.cpu || profile.cpu_limit,
    memory_limit_mb: overrides.memory || profile.memory_limit_mb,
    disk_limit_mb: overrides.disk || profile.disk_limit_mb,
  };
}

/**
 * Allocate the next available bridge IP from the configured CIDR range.
 */
function allocateBridgeIp(db) {
  const config = getConfig();
  const startParts = config.network.dhcp_range_start.split('.').map(Number);
  const endParts = config.network.dhcp_range_end.split('.').map(Number);

  // Get all currently allocated IPs
  const allocated = db.prepare('SELECT bridge_ip FROM containers WHERE bridge_ip IS NOT NULL')
    .all()
    .map(row => row.bridge_ip);

  const prefix = startParts.slice(0, 3).join('.');
  for (let i = startParts[3]; i <= endParts[3]; i++) {
    const candidate = `${prefix}.${i}`;
    if (!allocated.includes(candidate)) {
      return candidate;
    }
  }
  throw new Error('No available IP addresses in the bridge range');
}

/**
 * Get associated routes for a container from the database.
 */
function getContainerRoutes(db, containerId) {
  return db.prepare(`
    SELECT r.* FROM routes r
    INNER JOIN container_routes cr ON cr.route_id = r.id
    WHERE cr.container_id = ?
  `).all(containerId);
}

/**
 * Format uptime from a timestamp or seconds.
 */
function formatUptime(createdAt) {
  if (!createdAt) return '-';
  const created = new Date(createdAt);
  const now = new Date();
  const diffMs = now - created;
  const days = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  const hours = Math.floor((diffMs % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
  if (days > 0) return `${days}d ${hours}h`;
  const minutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

/**
 * Format bytes to human-readable string.
 */
function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

/**
 * Copy and execute an init script inside a container.
 */
function runInitScript(incusName, scriptPath) {
  const script = readFileSync(scriptPath, 'utf-8');
  execSync(
    `echo ${JSON.stringify(script)} | incus exec ${incusName} -- tee /tmp/init-script.sh > /dev/null`,
  );
  execSync(`incus exec ${incusName} -- chmod +x /tmp/init-script.sh`);
  execSync(`incus exec ${incusName} -- /bin/sh /tmp/init-script.sh`, {
    stdio: 'inherit',
  });
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function createCommand(opts, globalOpts) {
  const { name, image, template, profile: profileName, domain, port, path: pathPrefix, initScript, cpu, memory, disk, vpnOnly = false, service = null } = opts;

  // 1. Validate inputs
  if (!name) {
    output.error('Container name is required (--name)');
    process.exit(1);
  }
  if (!image && !template) {
    output.error('Either --image or --template is required');
    process.exit(1);
  }

  const config = getConfig();
  const instancePrefix = config.incus.instance_prefix;
  const incusName = `${instancePrefix}${name}`;
  const appPort = port || 80;

  output.info(`Creating container '${name}'...`);

  // 2. Get db connection
  const db = getDb();

  // 3. Check name doesn't already exist
  const existing = db.prepare('SELECT id FROM containers WHERE name = ?').get(name);
  if (existing) {
    output.error(`Container '${name}' already exists`);
    process.exit(1);
  }

  // 4. Get resource limits
  const resourceProfile = profileName || 'medium';
  const limits = getResourceLimits(db, resourceProfile, { cpu, memory, disk });

  // 5. Allocate bridge IP
  const bridgeIp = allocateBridgeIp(db);

  // 6. Determine the image source
  let sourceConfig;
  if (template) {
    const tmpl = db.prepare('SELECT * FROM templates WHERE name = ?').get(template);
    if (!tmpl) {
      output.error(`Template '${template}' not found`);
      process.exit(1);
    }
    sourceConfig = { type: 'image', alias: tmpl.incus_alias };
  } else {
    sourceConfig = { type: 'image', alias: image };
  }

  // 7. Build Incus instance config and create
  const instanceConfig = {
    name: incusName,
    source: sourceConfig,
    profiles: ['proxypilot'],
    config: {
      'limits.cpu': String(limits.cpu_limit),
      'limits.memory': `${limits.memory_limit_mb}MB`,
    },
    devices: {
      root: {
        type: 'disk',
        path: '/',
        pool: config.storage.pool_name,
        size: `${limits.disk_limit_mb}MB`,
      },
      eth0: {
        type: 'nic',
        network: config.network.bridge_name,
        'ipv4.address': bridgeIp,
        name: 'eth0',
      },
    },
  };

  let instanceCreated = false;
  let routeCreated = false;

  try {
    await createInstance(instanceConfig);
    instanceCreated = true;
    output.success(`Instance '${incusName}' created`);

    // 8. Start the instance
    await setInstanceState(incusName, 'start');
    output.success(`Instance '${incusName}' started`);

    // 9. If --domain provided, add Caddy route
    if (domain) {
      const upstream = `${bridgeIp}:${appPort}`;
      await addRoute(domain, upstream, {
        pathPrefix: pathPrefix || '/',
        tlsAuto: true,
        vpnOnly: !!vpnOnly,
        service: service || null,
      });
      routeCreated = true;
      output.success(`Route added: ${domain} -> ${upstream}${vpnOnly ? ' [vpn-only]' : ''}${service ? ` (service=${service})` : ''}`);
    }

    // 10. If --init-script provided, copy and execute
    if (initScript) {
      output.info('Running initialization script...');
      runInitScript(incusName, initScript);
      output.success('Initialization script completed');
    }

    // 11. Insert into SQLite using a transaction
    const insertAll = db.transaction(() => {
      const containerResult = db.prepare(`
        INSERT INTO containers (name, incus_name, image, profile, bridge_ip, port, status, cpu_limit, memory_limit_mb, disk_limit_mb, init_script, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, datetime('now'), datetime('now'))
      `).run(
        name,
        incusName,
        image || template,
        resourceProfile,
        bridgeIp,
        appPort,
        limits.cpu_limit,
        limits.memory_limit_mb,
        limits.disk_limit_mb,
        initScript || null,
      );

      if (domain) {
        const routeResult = db.prepare(`
          INSERT INTO routes (domain, upstream_type, upstream_address, path_prefix, tls_auto, enabled, vpn_only, service, created_at, updated_at)
          VALUES (?, 'lxc', ?, ?, 1, 1, ?, ?, datetime('now'), datetime('now'))
        `).run(domain, `${bridgeIp}:${appPort}`, pathPrefix || '/', vpnOnly ? 1 : 0, service || null);

        db.prepare(`
          INSERT INTO container_routes (container_id, route_id) VALUES (?, ?)
        `).run(containerResult.lastInsertRowid, routeResult.lastInsertRowid);
      }
    });
    insertAll();

    // 12. Print success
    console.log('');
    output.success(`Container '${name}' created successfully`);
    console.log('');
    output.info(`  Name:     ${name}`);
    output.info(`  Instance: ${incusName}`);
    output.info(`  Image:    ${image || template}`);
    output.info(`  Profile:  ${resourceProfile}`);
    output.info(`  IP:       ${bridgeIp}`);
    output.info(`  Port:     ${appPort}`);
    output.info(`  CPU:      ${limits.cpu_limit} core(s)`);
    output.info(`  Memory:   ${limits.memory_limit_mb} MB`);
    output.info(`  Disk:     ${limits.disk_limit_mb} MB`);
    if (domain) {
      output.info(`  Domain:   ${domain}`);
    }
  } catch (err) {
    output.error(`Failed to create container: ${err.message}`);

    // Cleanup on failure
    if (routeCreated && domain) {
      try {
        await removeRoute(domain);
      } catch { /* best effort */ }
    }
    if (instanceCreated) {
      try {
        await setInstanceState(incusName, 'stop', true);
      } catch { /* best effort */ }
      try {
        await deleteInstance(incusName);
      } catch { /* best effort */ }
    }
    process.exit(1);
  }
}

async function listCommand(globalOpts) {
  const db = getDb();
  const containers = db.prepare('SELECT * FROM containers ORDER BY name').all();

  if (containers.length === 0) {
    output.info('No containers found. Create one with: proxypilot lxc create --name <name> --image <image>');
    return;
  }

  const rows = [];
  for (const c of containers) {
    // Get associated domains
    const routes = getContainerRoutes(db, c.id);
    const domains = routes.map(r => r.domain).join(', ') || '-';

    // Try to get live state from Incus
    let cpuUsage = '-';
    let memUsage = '-';
    let uptime = '-';

    if (c.status === 'running') {
      try {
        const state = await getInstanceState(c.incus_name);
        if (state.memory && state.memory.usage) {
          memUsage = formatBytes(state.memory.usage);
        }
        if (state.cpu && state.cpu.usage !== undefined) {
          // CPU usage is in nanoseconds; show as percentage estimate
          cpuUsage = `${(state.cpu.usage / 1e9).toFixed(1)}s`;
        }
        uptime = formatUptime(c.created_at);
      } catch {
        // Instance may not be reachable
      }
    }

    rows.push([
      c.name,
      c.status,
      c.bridge_ip || '-',
      c.port || '-',
      domains,
      c.profile,
      cpuUsage,
      memUsage,
      uptime,
    ]);
  }

  if (globalOpts.json) {
    const jsonData = containers.map(c => {
      const routes = getContainerRoutes(db, c.id);
      return { ...c, domains: routes.map(r => r.domain) };
    });
    output.json(jsonData);
    return;
  }

  output.table(
    ['Name', 'Status', 'IP', 'Port', 'Domain(s)', 'Profile', 'CPU', 'Memory', 'Uptime'],
    rows,
  );
}

async function startCommand(name, globalOpts) {
  const db = getDb();
  const container = getContainer(db, name);

  output.info(`Starting container '${name}'...`);

  // Start via Incus
  await setInstanceState(container.incus_name, 'start');

  // Update status in SQLite
  db.prepare("UPDATE containers SET status = 'running', updated_at = datetime('now') WHERE id = ?").run(container.id);

  // Re-enable associated Caddy routes
  const routes = getContainerRoutes(db, container.id);
  for (const route of routes) {
    try {
      await enableRoute(route.domain);
      db.prepare("UPDATE routes SET enabled = 1, updated_at = datetime('now') WHERE id = ?").run(route.id);
    } catch (err) {
      output.warn(`Failed to enable route for ${route.domain}: ${err.message}`);
    }
  }

  output.success(`Container '${name}' started`);
}

async function stopCommand(name, globalOpts) {
  const db = getDb();
  const container = getContainer(db, name);

  output.info(`Stopping container '${name}'...`);

  // Disable associated Caddy routes first (so traffic stops)
  const routes = getContainerRoutes(db, container.id);
  for (const route of routes) {
    try {
      await disableRoute(route.domain);
      db.prepare("UPDATE routes SET enabled = 0, updated_at = datetime('now') WHERE id = ?").run(route.id);
    } catch (err) {
      output.warn(`Failed to disable route for ${route.domain}: ${err.message}`);
    }
  }

  // Stop via Incus
  await setInstanceState(container.incus_name, 'stop');

  // Update status in SQLite
  db.prepare("UPDATE containers SET status = 'stopped', updated_at = datetime('now') WHERE id = ?").run(container.id);

  output.success(`Container '${name}' stopped`);
}

async function restartCommand(name, globalOpts) {
  output.info(`Restarting container '${name}'...`);
  await stopCommand(name, globalOpts);
  await startCommand(name, globalOpts);
  output.success(`Container '${name}' restarted`);
}

async function destroyCommand(name, opts, globalOpts) {
  const db = getDb();
  const container = getContainer(db, name);

  // Prompt for confirmation unless --force
  if (!opts.force) {
    const confirmed = await output.confirm(
      `Are you sure you want to destroy container '${name}'? This cannot be undone.`,
    );
    if (!confirmed) {
      output.info('Aborted');
      return;
    }
  }

  output.info(`Destroying container '${name}'...`);

  // Stop if running
  if (container.status === 'running') {
    try {
      await setInstanceState(container.incus_name, 'stop', true);
      output.success(`Container '${name}' stopped`);
    } catch (err) {
      output.warn(`Failed to stop container (may already be stopped): ${err.message}`);
    }
  }

  // Remove all associated Caddy routes
  const routes = getContainerRoutes(db, container.id);
  for (const route of routes) {
    try {
      await removeRoute(route.domain);
      output.success(`Route for '${route.domain}' removed`);
    } catch (err) {
      output.warn(`Failed to remove route for ${route.domain}: ${err.message}`);
    }
  }

  // Delete all snapshots from Incus
  try {
    const snapshots = await incusListSnapshots(container.incus_name);
    if (snapshots && snapshots.length > 0) {
      for (const snap of snapshots) {
        const snapName = typeof snap === 'string' ? snap.split('/').pop() : snap.name;
        try {
          await incusDeleteSnapshot(container.incus_name, snapName);
        } catch { /* best effort */ }
      }
      output.success('Snapshots deleted');
    }
  } catch {
    // Instance may already be gone
  }

  // Delete instance from Incus
  try {
    await deleteInstance(container.incus_name);
    output.success(`Instance '${container.incus_name}' deleted from Incus`);
  } catch (err) {
    output.warn(`Failed to delete Incus instance: ${err.message}`);
  }

  // Delete from SQLite (cascade handles container_routes, snapshots)
  const deleteAll = db.transaction(() => {
    // Delete routes linked to this container
    const routeIds = routes.map(r => r.id);
    for (const routeId of routeIds) {
      db.prepare('DELETE FROM container_routes WHERE container_id = ? AND route_id = ?').run(container.id, routeId);
      db.prepare('DELETE FROM routes WHERE id = ?').run(routeId);
    }
    // Delete snapshots
    db.prepare('DELETE FROM snapshots WHERE container_id = ?').run(container.id);
    // Delete container
    db.prepare('DELETE FROM containers WHERE id = ?').run(container.id);
  });
  deleteAll();

  output.success(`Container '${name}' destroyed`);
}

async function shellCommand(name, globalOpts) {
  const db = getDb();
  const container = getContainer(db, name);

  if (container.status !== 'running') {
    output.error(`Container '${name}' is not running (status: ${container.status}). Start it first.`);
    process.exit(1);
  }

  shellInContainer(container.incus_name);
}

async function execCommand(name, command, globalOpts) {
  const db = getDb();
  const container = getContainer(db, name);

  if (container.status !== 'running') {
    output.error(`Container '${name}' is not running (status: ${container.status}). Start it first.`);
    process.exit(1);
  }

  if (!command || command.length === 0) {
    output.error('No command specified');
    process.exit(1);
  }

  const exitCode = execInContainer(container.incus_name, command);
  process.exit(exitCode);
}

async function resizeCommand(name, opts, globalOpts) {
  const db = getDb();
  const container = getContainer(db, name);

  const { cpu, memory, disk } = opts;

  if (!cpu && !memory && !disk) {
    output.error('Specify at least one of --cpu, --memory, or --disk');
    process.exit(1);
  }

  output.info(`Resizing container '${name}'...`);

  // Build patch config with only the changed limits
  const patchConfig = { config: {}, devices: {} };
  const dbUpdates = {};

  if (cpu) {
    patchConfig.config['limits.cpu'] = String(cpu);
    dbUpdates.cpu_limit = cpu;
  }
  if (memory) {
    patchConfig.config['limits.memory'] = `${memory}MB`;
    dbUpdates.memory_limit_mb = memory;
  }
  if (disk) {
    patchConfig.devices.root = {
      type: 'disk',
      path: '/',
      pool: getConfig().storage.pool_name,
      size: `${disk}MB`,
    };
    dbUpdates.disk_limit_mb = disk;
  }

  // Clean up empty objects
  if (Object.keys(patchConfig.config).length === 0) delete patchConfig.config;
  if (Object.keys(patchConfig.devices).length === 0) delete patchConfig.devices;

  // Apply via Incus PATCH (live, no restart needed for cpu/memory)
  await updateInstance(container.incus_name, patchConfig);

  // Update SQLite
  const setClauses = Object.keys(dbUpdates)
    .map(k => `${k} = ?`)
    .concat(["updated_at = datetime('now')"]);
  const values = Object.values(dbUpdates);
  values.push(container.id);

  db.prepare(`UPDATE containers SET ${setClauses.join(', ')} WHERE id = ?`).run(...values);

  output.success(`Container '${name}' resized`);
  if (cpu) output.info(`  CPU:    ${cpu} core(s)`);
  if (memory) output.info(`  Memory: ${memory} MB`);
  if (disk) output.info(`  Disk:   ${disk} MB`);
}

async function infoCommand(name, globalOpts) {
  const db = getDb();
  const container = getContainer(db, name);

  // Get live state from Incus
  let state = null;
  try {
    state = await getInstanceState(container.incus_name);
  } catch {
    // Instance may not be reachable
  }

  // Get associated routes
  const routes = getContainerRoutes(db, container.id);

  // Get snapshots
  const snapshots = db.prepare('SELECT * FROM snapshots WHERE container_id = ? ORDER BY created_at DESC').all(container.id);

  if (globalOpts.json) {
    output.json({
      container,
      state,
      routes,
      snapshots,
    });
    return;
  }

  // Print detailed view
  console.log('');
  output.info(`Container: ${container.name}`);
  console.log('');
  output.info('  General:');
  output.info(`    Incus Name:  ${container.incus_name}`);
  output.info(`    Image:       ${container.image}`);
  output.info(`    Profile:     ${container.profile}`);
  output.info(`    Status:      ${container.status}`);
  output.info(`    Created:     ${container.created_at}`);
  output.info(`    Updated:     ${container.updated_at}`);

  console.log('');
  output.info('  Network:');
  output.info(`    Bridge IP:   ${container.bridge_ip || '-'}`);
  output.info(`    Port:        ${container.port || '-'}`);

  console.log('');
  output.info('  Resources:');
  output.info(`    CPU Limit:   ${container.cpu_limit} core(s)`);
  output.info(`    Memory Limit:${container.memory_limit_mb} MB`);
  output.info(`    Disk Limit:  ${container.disk_limit_mb} MB`);

  if (state) {
    console.log('');
    output.info('  Live State:');
    if (state.memory) {
      output.info(`    Memory Usage: ${formatBytes(state.memory.usage)} / ${container.memory_limit_mb} MB`);
    }
    if (state.cpu) {
      output.info(`    CPU Time:     ${(state.cpu.usage / 1e9).toFixed(2)}s`);
    }
    if (state.network) {
      for (const [iface, net] of Object.entries(state.network)) {
        output.info(`    ${iface}: RX ${formatBytes(net.counters.bytes_received)} / TX ${formatBytes(net.counters.bytes_sent)}`);
      }
    }
  }

  if (routes.length > 0) {
    console.log('');
    output.info('  Routes:');
    for (const route of routes) {
      const status = route.enabled ? 'enabled' : 'disabled';
      output.info(`    ${route.domain} -> ${route.upstream_address} [${status}] (health: ${route.health_status})`);
    }
  }

  if (snapshots.length > 0) {
    console.log('');
    output.info('  Snapshots:');
    for (const snap of snapshots) {
      output.info(`    ${snap.name} (${snap.created_at})`);
    }
  }
}

// ---------------------------------------------------------------------------
// Export as the object shape expected by proxypilot.js
// ---------------------------------------------------------------------------

export const lxcCommands = {
  create: createCommand,
  list: listCommand,
  start: startCommand,
  stop: stopCommand,
  restart: restartCommand,
  destroy: destroyCommand,
  shell: shellCommand,
  exec: execCommand,
  resize: resizeCommand,
  info: infoCommand,

  // Snapshot commands delegate to lxc/snapshots.js
  async snapshot(name, opts, globalOpts) {
    const snapshotName = opts.name || `snap-${Date.now()}`;
    try {
      await snapshotCreate(name, snapshotName);
    } catch (err) {
      output.error(err.message);
      process.exit(1);
    }
  },

  async snapshots(name, globalOpts) {
    try {
      await snapshotList(name, globalOpts.json);
    } catch (err) {
      output.error(err.message);
      process.exit(1);
    }
  },

  async restore(name, opts, globalOpts) {
    try {
      await snapshotRestore(name, opts.snapshot);
    } catch (err) {
      output.error(err.message);
      process.exit(1);
    }
  },

  async snapshotDelete(name, opts, globalOpts) {
    try {
      await snapshotDelete(name, opts.snapshot);
    } catch (err) {
      output.error(err.message);
      process.exit(1);
    }
  },

  // Template commands
  async templatesList(globalOpts) {
    const db = getDb();
    const templates = db.prepare('SELECT * FROM templates ORDER BY name').all();

    if (templates.length === 0) {
      output.info('No templates found. Create one with: proxypilot lxc templates create <name>');
      return;
    }

    if (globalOpts.json) {
      output.json(templates);
      return;
    }

    output.table(
      ['Name', 'Description', 'Image Alias', 'Base Image', 'Profile', 'Created'],
      templates.map(t => [
        t.name,
        t.description || '-',
        t.incus_alias,
        t.base_image || '-',
        t.default_profile,
        t.created_at,
      ]),
    );
  },

  async templatesCreate(name, opts, globalOpts) {
    const db = getDb();

    if (!opts.from) {
      output.error('--from <container> is required to create a template');
      process.exit(1);
    }

    const container = getContainer(db, opts.from);
    const aliasName = `proxypilot-template-${name}`;

    output.info(`Creating template '${name}' from container '${container.name}'...`);

    // Publish the container as an image
    const { publishImage } = await import('../incus/client.js');
    await publishImage(container.incus_name, [aliasName]);

    db.prepare(`
      INSERT INTO templates (name, description, incus_alias, base_image, default_profile, created_at)
      VALUES (?, ?, ?, ?, ?, datetime('now'))
    `).run(name, opts.description || null, aliasName, container.image, container.profile);

    output.success(`Template '${name}' created from container '${container.name}'`);
  },

  async templatesDelete(name, globalOpts) {
    const db = getDb();
    const template = db.prepare('SELECT * FROM templates WHERE name = ?').get(name);
    if (!template) {
      output.error(`Template '${name}' not found`);
      process.exit(1);
    }

    output.info(`Deleting template '${name}'...`);

    // Try to delete the image from Incus
    try {
      const { getImageByAlias, deleteImage } = await import('../incus/client.js');
      const aliasData = await getImageByAlias(template.incus_alias);
      if (aliasData && aliasData.target) {
        await deleteImage(aliasData.target);
      }
    } catch {
      output.warn('Could not delete image from Incus (may already be removed)');
    }

    db.prepare('DELETE FROM templates WHERE id = ?').run(template.id);
    output.success(`Template '${name}' deleted`);
  },
};
