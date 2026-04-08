import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { getConfig, saveConfig } from '../config.js';
import { getDb } from '../db/index.js';
import { initSchema } from '../db/schema.js';
import { checkConnection, createNetwork, listNetworks, createStoragePool, listStoragePools, createProfile, updateProfile, listProfiles } from '../incus/client.js';
import { checkCaddyConnection } from '../caddy/client.js';
import * as output from '../output.js';

const CONFIG_DIR = path.join(os.homedir(), '.proxypilot');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.yaml');
const BACKUP_DIR = '/var/lib/proxypilot/backups';
const SITES_DIR = '/var/lib/proxypilot/sites';

export async function initCommand(globalOpts) {
  output.info('Initializing ProxyPilot...\n');

  let stepsPassed = 0;
  let stepsSkipped = 0;
  let stepsFailed = 0;

  // ── Step 1: Check Incus is installed ──────────────────────────────────────
  try {
    const connected = await checkConnection();
    if (!connected) {
      output.error('Incus is not reachable. Install it with: apt install incus');
      stepsFailed++;
    } else {
      output.success('Incus is installed and reachable');
      stepsPassed++;
    }
  } catch {
    output.error('Incus is not installed. Install it with: apt install incus');
    stepsFailed++;
  }

  // ── Step 2: Create config directory and default config ────────────────────
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      output.success('Configuration file already exists (skipped)');
      stepsSkipped++;
    } else {
      const config = getConfig();
      saveConfig(config);
      output.success('Configuration file created at ' + CONFIG_FILE);
      stepsPassed++;
    }
  } catch (err) {
    output.error(`Failed to create configuration: ${err.message}`);
    stepsFailed++;
  }

  // ── Step 3: Initialize SQLite database ────────────────────────────────────
  try {
    const db = getDb();
    initSchema(db);
    output.success('Database initialized');
    stepsPassed++;
  } catch (err) {
    output.error(`Failed to initialize database: ${err.message}`);
    stepsFailed++;
  }

  // ── Step 4: Create Incus network bridge (pp-br0) ──────────────────────────
  try {
    const config = getConfig();
    const bridgeName = config.network.bridge_name;
    const networks = await listNetworks();
    const networkNames = networks.map(n => typeof n === 'string' ? n.split('/').pop() : n.name);

    if (networkNames.includes(bridgeName)) {
      output.success(`Network bridge '${bridgeName}' already exists (skipped)`);
      stepsSkipped++;
    } else {
      await createNetwork(bridgeName, {
        type: 'bridge',
        config: {
          'ipv4.address': config.network.gateway + '/24',
          'ipv4.nat': 'true',
          'ipv4.dhcp.ranges': `${config.network.dhcp_range_start}-${config.network.dhcp_range_end}`,
          'dns.domain': config.network.dns_domain,
        },
      });
      output.success(`Network bridge '${bridgeName}' created`);
      stepsPassed++;
    }
  } catch (err) {
    output.error(`Failed to create network bridge: ${err.message}`);
    stepsFailed++;
  }

  // ── Step 5: Create Incus storage pool (pp-default) ────────────────────────
  try {
    const config = getConfig();
    const poolName = config.storage.pool_name;
    const pools = await listStoragePools();
    const poolNames = pools.map(p => typeof p === 'string' ? p.split('/').pop() : p.name);

    if (poolNames.includes(poolName)) {
      output.success(`Storage pool '${poolName}' already exists (skipped)`);
      stepsSkipped++;
    } else {
      await createStoragePool(poolName, config.storage.driver, {
        source: config.storage.source_path,
      });
      output.success(`Storage pool '${poolName}' created`);
      stepsPassed++;
    }
  } catch (err) {
    output.error(`Failed to create storage pool: ${err.message}`);
    stepsFailed++;
  }

  // ── Step 6: Create Incus profile "proxypilot" ─────────────────────────────
  try {
    const config = getConfig();
    const profileName = 'proxypilot';
    const profileConfig = {
      description: 'ProxyPilot managed container defaults',
      config: {},
      devices: {
        root: {
          type: 'disk',
          path: '/',
          pool: config.storage.pool_name,
        },
        eth0: {
          type: 'nic',
          network: config.network.bridge_name,
          name: 'eth0',
        },
      },
    };

    const profiles = await listProfiles();
    const profileNames = profiles.map(p => typeof p === 'string' ? p.split('/').pop() : p.name);

    if (profileNames.includes(profileName)) {
      await updateProfile(profileName, profileConfig);
      output.success(`Incus profile '${profileName}' updated`);
      stepsSkipped++;
    } else {
      await createProfile(profileName, profileConfig);
      output.success(`Incus profile '${profileName}' created`);
      stepsPassed++;
    }
  } catch (err) {
    output.error(`Failed to create Incus profile: ${err.message}`);
    stepsFailed++;
  }

  // ── Step 7: Create backup directory ───────────────────────────────────────
  try {
    if (fs.existsSync(BACKUP_DIR)) {
      output.success(`Backup directory exists (skipped)`);
      stepsSkipped++;
    } else {
      fs.mkdirSync(BACKUP_DIR, { recursive: true });
      output.success(`Backup directory created at ${BACKUP_DIR}`);
      stepsPassed++;
    }
  } catch (err) {
    output.error(`Failed to create backup directory: ${err.message}`);
    stepsFailed++;
  }

  // ── Step 8: Create static sites directory ─────────────────────────────────
  try {
    if (fs.existsSync(SITES_DIR)) {
      output.success(`Static sites directory exists (skipped)`);
      stepsSkipped++;
    } else {
      fs.mkdirSync(SITES_DIR, { recursive: true });
      output.success(`Static sites directory created at ${SITES_DIR}`);
      stepsPassed++;
    }
  } catch (err) {
    output.error(`Failed to create static sites directory: ${err.message}`);
    stepsFailed++;
  }

  // ── Step 9: Check Caddy admin API ─────────────────────────────────────────
  try {
    const caddyOk = await checkCaddyConnection();
    if (caddyOk) {
      output.success('Caddy admin API is reachable');
      stepsPassed++;
    } else {
      output.warn('Caddy admin API is not reachable (Caddy may not be running)');
      stepsFailed++;
    }
  } catch {
    output.warn('Caddy admin API is not reachable (Caddy may not be running)');
    stepsFailed++;
  }

  // ── Step 10: Print summary ────────────────────────────────────────────────
  console.log('');
  output.info('Initialization summary:');
  if (stepsPassed > 0) output.success(`${stepsPassed} step(s) completed`);
  if (stepsSkipped > 0) output.info(`${stepsSkipped} step(s) skipped (already configured)`);
  if (stepsFailed > 0) output.error(`${stepsFailed} step(s) failed`);

  if (globalOpts.json) {
    output.json({
      status: stepsFailed === 0 ? 'initialized' : 'partial',
      steps_passed: stepsPassed,
      steps_skipped: stepsSkipped,
      steps_failed: stepsFailed,
    });
  }

  if (stepsFailed === 0) {
    console.log('');
    output.success('ProxyPilot is ready to use');
  } else {
    console.log('');
    output.warn('ProxyPilot initialized with warnings. Fix the issues above and run init again.');
  }
}
