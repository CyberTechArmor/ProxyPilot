import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parse, stringify } from 'yaml';

const CONFIG_DIR = path.join(os.homedir(), '.proxypilot');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.yaml');

const DEFAULTS = {
  caddy: {
    admin_api: 'http://localhost:2019',
  },
  incus: {
    socket: '/var/lib/incus/unix.socket',
    instance_prefix: 'pp-',
  },
  network: {
    bridge_name: 'pp-br0',
    cidr: '10.0.100.0/24',
    gateway: '10.0.100.1',
    dhcp_range_start: '10.0.100.10',
    dhcp_range_end: '10.0.100.254',
    dns_domain: 'lxc.internal',
  },
  storage: {
    pool_name: 'pp-default',
    driver: 'dir',
    source_path: '/var/lib/proxypilot/storage',
  },
  backup: {
    directory: '/var/lib/proxypilot/backups',
  },
  static_sites: {
    root_directory: '/var/lib/proxypilot/sites',
  },
  health: {
    check_interval_seconds: 60,
    timeout_seconds: 5,
  },
  database: {
    path: '~/.proxypilot/proxypilot.db',
  },
};

/**
 * Deep merge source into target. Source values override target values.
 */
function deepMerge(target, source) {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (
      source[key] !== null &&
      typeof source[key] === 'object' &&
      !Array.isArray(source[key]) &&
      typeof result[key] === 'object' &&
      result[key] !== null &&
      !Array.isArray(result[key])
    ) {
      result[key] = deepMerge(result[key], source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

/**
 * Load configuration from ~/.proxypilot/config.yaml merged with defaults.
 * Creates the config directory if it does not exist.
 */
export function getConfig() {
  // Ensure config directory exists
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }

  // If config file exists, merge with defaults
  if (fs.existsSync(CONFIG_FILE)) {
    const raw = fs.readFileSync(CONFIG_FILE, 'utf-8');
    const fileConfig = parse(raw) || {};
    return deepMerge(DEFAULTS, fileConfig);
  }

  return { ...DEFAULTS };
}

/**
 * Write configuration to ~/.proxypilot/config.yaml.
 */
export function saveConfig(config) {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }

  const yamlStr = stringify(config, { indent: 2 });
  fs.writeFileSync(CONFIG_FILE, yamlStr, 'utf-8');
}
