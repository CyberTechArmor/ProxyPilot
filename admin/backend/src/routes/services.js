import { Router } from 'express';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { exec } from 'child_process';
import { promisify } from 'util';
import { writeFile, unlink, readdir, readFile, mkdir, rm, stat } from 'fs/promises';
import { existsSync } from 'fs';
import { join, basename, resolve } from 'path';
import os from 'os';
import * as OTPAuth from 'otpauth';
import { getDb, logAudit } from '../db.js';
import { requireAdmin } from '../middleware/auth.js';

const execAsync = promisify(exec);

export const servicesRouter = Router();

const CADDY_SITES_DIR = process.env.CADDY_SITES_DIR || '/etc/caddy/sites';
const CADDY_CONFIG_FILE = process.env.CADDY_CONFIG_FILE || '/etc/caddy/Caddyfile';
const SERVICES_DATA_DIR = process.env.SERVICES_DATA_DIR || '/data/services';
// CADDY_STATIC_ROOT is the host path that Caddy uses to serve static files
// This may differ from SERVICES_DATA_DIR when running in Docker
const CADDY_STATIC_ROOT = process.env.CADDY_STATIC_ROOT || SERVICES_DATA_DIR;

// Check if running in Docker container
const isInDocker = existsSync('/.dockerenv') || process.env.DOCKER_CONTAINER === 'true';

// Execute command on host (uses nsenter when in Docker, direct exec otherwise)
async function execOnHost(command, options = {}) {
  const timeout = options.timeout || 30000;

  if (isInDocker) {
    // Use nsenter to execute on the host's namespace
    // This requires the container to have appropriate privileges
    const hostCommand = `nsenter -t 1 -m -u -n -i sh -c ${JSON.stringify(command)}`;
    return execAsync(hostCommand, { timeout });
  } else {
    // Not in Docker, execute directly
    return execAsync(command, { timeout });
  }
}

// Write Caddy site config file
// Note: Since /etc/caddy/sites is a mounted volume in Docker,
// regular writeFile works. Only shell commands (caddy reload, etc.) need execOnHost.
async function writeCaddyConfig(configPath, content) {
  await writeFile(configPath, content);
}

// Read Caddy site config file
async function readCaddyConfig(configPath) {
  return readFile(configPath, 'utf-8');
}

// Ensure the main Caddyfile and sites directory exist
async function ensureCaddyStructure() {
  // Ensure sites directory exists
  await mkdir(CADDY_SITES_DIR, { recursive: true }).catch(() => {});

  // Ensure main Caddyfile exists with global options and import directive
  if (!existsSync(CADDY_CONFIG_FILE)) {
    const acmeEmail = process.env.ACME_EMAIL || '';
    const emailLine = acmeEmail ? `\n    email ${acmeEmail}` : '';
    const mainConfig = `{
    admin localhost:2019${emailLine}
}

import ${CADDY_SITES_DIR}/*
`;
    await writeFile(CADDY_CONFIG_FILE, mainConfig);
  }
}

// Cache for docker compose command detection
let dockerComposeCmd = null;

// Detect and cache the correct docker compose command
async function getDockerComposeCmd() {
  if (dockerComposeCmd) return dockerComposeCmd;

  // Try docker compose (v2 plugin) first
  try {
    await execOnHost('docker compose version 2>/dev/null');
    dockerComposeCmd = 'docker compose';
    return dockerComposeCmd;
  } catch (e) {
    // Fall back to docker-compose (v1 standalone)
    try {
      await execOnHost('docker-compose version 2>/dev/null');
      dockerComposeCmd = 'docker-compose';
      return dockerComposeCmd;
    } catch (e2) {
      // Default to docker compose and let it fail with a clear error
      dockerComposeCmd = 'docker compose';
      return dockerComposeCmd;
    }
  }
}

// Helper to create safe directory name from service name
function toSafeDirectoryName(name) {
  return name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
}

// Safely resolve a file path within a base directory (prevents path traversal)
function safePath(baseDir, userPath) {
  const resolved = resolve(baseDir, userPath);
  if (!resolved.startsWith(resolve(baseDir) + '/') && resolved !== resolve(baseDir)) {
    return null;
  }
  return resolved;
}

// Escape HTML special characters to prevent XSS
function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

// Domain accepts either a plain hostname (example.com) or a wildcard
// (`*.example.com` — matches any single subdomain level). Bare `*` is rejected.
const DOMAIN_REGEX = /^(\*\.)?[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?$/;

// Path prefix must begin with `/` and contain only URL-safe characters.
// `/` means "match all paths on the domain" (legacy behavior).
const PATH_PREFIX_REGEX = /^\/(?:[a-zA-Z0-9._~\-]+(?:\/[a-zA-Z0-9._~\-]+)*\/?)?$/;

// Normalize a path prefix so lookups and Caddy generation stay consistent:
//   undefined/empty → '/'
//   trailing slash (except for root) is stripped: '/api/' → '/api'
function normalizePathPrefix(value) {
  if (value === undefined || value === null || value === '') return '/';
  let p = String(value).trim();
  if (!p.startsWith('/')) p = '/' + p;
  if (p.length > 1 && p.endsWith('/')) p = p.replace(/\/+$/, '');
  return p || '/';
}

// Convert domain (which may contain a wildcard `*`) into a filesystem-safe
// name for Caddy site config files. Wildcards become `_wildcard_` so
// `*.example.com` → `_wildcard_.example.com`.
function caddyFileName(domain) {
  return String(domain).replace(/\*/g, '_wildcard_');
}

function caddyFilePath(domain) {
  return `${CADDY_SITES_DIR}/${caddyFileName(domain)}`;
}

// Validation schemas
const createServiceSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  domain: z.string().regex(DOMAIN_REGEX, 'Invalid domain (use example.com or *.example.com)'),
  pathPrefix: z.string().regex(PATH_PREFIX_REGEX, 'Path prefix must start with / and contain only URL-safe characters').default('/'),
  type: z.enum(['static', 'docker']),
  target: z.string().optional(),
  port: z.union([z.number().int().min(1).max(65535), z.string(), z.null()]).optional().transform(val => {
    if (val === null || val === undefined || val === '') return undefined;
    const num = typeof val === 'string' ? parseInt(val, 10) : val;
    return isNaN(num) ? undefined : num;
  }),
  rootDir: z.string().optional(),
  containerName: z.string().optional(),
  sslEnabled: z.boolean().default(true),
  forceHttps: z.boolean().default(true),
  websocketEnabled: z.boolean().default(false),
  maxUploadSize: z.string().regex(/^[1-9][0-9]*[MG]$/i).default('1G'),
  obtainCertificate: z.boolean().default(true),
});

const deleteServiceSchema = z.object({
  totpCode: z.string().length(6, 'TOTP code must be 6 digits'),
});

const fileSchema = z.object({
  filename: z.string().min(1).max(255).regex(/^[a-zA-Z0-9._-]+$/, 'Invalid filename'),
  content: z.string().max(10 * 1024 * 1024), // 10MB max
});

// Helper function to reload or start Caddy (executes on host)
async function reloadCaddy() {
  try {
    // Ensure Caddy config structure exists
    await ensureCaddyStructure();

    // Validate Caddy configuration first (on host)
    const testResult = await execOnHost(`caddy adapt --config ${CADDY_CONFIG_FILE} > /dev/null 2>&1`);
    console.log('Caddy validate output:', testResult.stdout, testResult.stderr);

    // Check if Caddy is running
    let caddyRunning = false;
    try {
      await execOnHost('systemctl is-active --quiet caddy 2>/dev/null');
      caddyRunning = true;
    } catch (e) {
      // Try pgrep as fallback
      try {
        const pgrepResult = await execOnHost('pgrep -o caddy 2>/dev/null');
        if (pgrepResult.stdout.trim()) {
          caddyRunning = true;
        }
      } catch (e2) {
        caddyRunning = false;
      }
    }

    if (caddyRunning) {
      // Reload Caddy - it validates before applying, rejects invalid configs
      console.log('Caddy is running, reloading...');
      try {
        // Use --force to avoid hanging if admin API is unresponsive
        await execOnHost(`caddy reload --config ${CADDY_CONFIG_FILE} --force 2>&1`);
        console.log('Caddy reloaded successfully');
      } catch (reloadErr) {
        // Try systemctl as fallback
        await execOnHost('systemctl restart caddy 2>&1');
        console.log('Caddy restarted via systemctl');
      }
    } else {
      // Caddy not running - start it
      console.log('Caddy not running, starting...');
      try {
        await execOnHost('systemctl start caddy 2>&1');
        console.log('Caddy started via systemctl');
      } catch (startErr) {
        // Systemctl failed, try direct start
        await execOnHost(`caddy start --config ${CADDY_CONFIG_FILE} 2>&1`);
        console.log('Caddy started directly');
      }
    }

    return { success: true };
  } catch (error) {
    // Extract the actual error message from stderr or stdout
    const errorOutput = error.stderr || error.stdout || error.message;
    console.error('Caddy reload/start failed:', errorOutput);
    return { success: false, error: errorOutput };
  }
}

// Check if Caddy is installed (on host)
async function isCaddyInstalled() {
  try {
    await execOnHost('which caddy 2>/dev/null || command -v caddy 2>/dev/null');
    return true;
  } catch (e) {
    return false;
  }
}

// Enable SSL for a service (Caddy auto-obtains certificates via ACME)
servicesRouter.post('/:id/obtain-certificate', async (req, res) => {
  try {
    const db = getDb();
    const service = db.prepare('SELECT * FROM services WHERE id = ?').get(req.params.id);

    if (!service) {
      return res.status(404).json({ error: 'Service not found' });
    }

    // Enable SSL in database
    db.prepare('UPDATE services SET ssl_enabled = 1, force_https = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(req.params.id);

    // Regenerate the merged Caddy config for the whole domain so sibling
    // services on the same domain keep sharing a single site block.
    await regenerateDomainCaddyConfig(db, service.domain);

    // Reload Caddy - it will automatically obtain the certificate
    const reloadResult = await reloadCaddy();

    logAudit(req.user.id, 'SSL_ENABLED', 'service', req.params.id, { domain: service.domain }, req.ip);

    res.json({
      success: true,
      message: 'SSL enabled - Caddy will automatically obtain a certificate',
      caddyReloaded: reloadResult.success,
      caddyError: reloadResult.error,
    });
  } catch (error) {
    console.error('Error enabling SSL:', error);
    res.status(500).json({ error: 'Failed to enable SSL: ' + error.message });
  }
});

// Disable SSL for a service (requires TOTP)
servicesRouter.delete('/:id/certificate', async (req, res) => {
  try {
    const { totpCode } = deleteServiceSchema.parse(req.body);
    const db = getDb();

    const service = db.prepare('SELECT * FROM services WHERE id = ?').get(req.params.id);
    if (!service) {
      return res.status(404).json({ error: 'Service not found' });
    }

    // Verify TOTP
    const user = db.prepare('SELECT totp_secret FROM users WHERE id = ?').get(req.user.id);
    if (user && user.totp_secret) {
      const totp = new OTPAuth.TOTP({
        issuer: 'ProxyPilot',
        label: req.user.username,
        algorithm: 'SHA1',
        digits: 6,
        period: 30,
        secret: OTPAuth.Secret.fromBase32(user.totp_secret),
      });

      const delta = totp.validate({ token: totpCode, window: 1 });
      if (delta === null) {
        return res.status(401).json({ error: 'Invalid TOTP code' });
      }
    }

    // Disable SSL in database
    db.prepare('UPDATE services SET ssl_enabled = 0, force_https = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(req.params.id);

    // Regenerate the merged Caddy config for the whole domain so sibling
    // services on the same domain keep sharing a single site block.
    await regenerateDomainCaddyConfig(db, service.domain);

    // Reload Caddy
    const reloadResult = await reloadCaddy();

    logAudit(req.user.id, 'SSL_DISABLED', 'service', req.params.id, { domain: service.domain }, req.ip);

    res.json({
      success: true,
      message: 'SSL disabled and Caddy reconfigured',
      caddyReloaded: reloadResult.success,
      caddyError: reloadResult.error,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: error.errors[0].message });
    }
    console.error('Error disabling SSL:', error);
    res.status(500).json({ error: 'Failed to disable SSL: ' + error.message });
  }
});

// Check SSL certificate status for a domain
// Caddy auto-manages certificates - this endpoint reports whether SSL is enabled
servicesRouter.get('/ssl-status/:domain', async (req, res) => {
  try {
    const domain = req.params.domain;
    const db = getDb();
    const service = db.prepare('SELECT ssl_enabled FROM services WHERE domain = ?').get(domain);
    const caddyInstalled = await isCaddyInstalled();

    res.json({
      domain,
      certificateExists: !!service?.ssl_enabled,
      autoManaged: true,
      caddyInstalled,
      message: service?.ssl_enabled
        ? 'Caddy automatically manages TLS certificates for this domain'
        : 'SSL is disabled for this domain - enable it to auto-obtain a certificate',
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to check SSL status' });
  }
});

// Check system requirements (Caddy, etc.)
servicesRouter.get('/system-check', async (req, res) => {
  try {
    const caddyInstalled = await isCaddyInstalled();

    res.json({
      caddyInstalled,
      autoTls: true,
      message: caddyInstalled
        ? 'Caddy is installed and manages TLS certificates automatically'
        : 'Caddy is not installed',
      installInstructions: caddyInstalled ? null : {
        debian: 'sudo apt install caddy',
        manual: 'See https://caddyserver.com/docs/install',
      },
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to check system' });
  }
});

// Regenerate Caddy config for a service
servicesRouter.post('/:id/regenerate-config', async (req, res) => {
  try {
    const db = getDb();
    const service = db.prepare(`
      SELECT * FROM services WHERE id = ?
    `).get(req.params.id);

    if (!service) {
      return res.status(404).json({ error: 'Service not found' });
    }

    // Regenerate the merged Caddy config for the whole domain so sibling
    // services on the same domain are picked up too (not just this service).
    await regenerateDomainCaddyConfig(db, service.domain);

    // Reload Caddy
    const reloadResult = await reloadCaddy();

    logAudit(req.user.id, 'CONFIG_REGENERATED', 'service', req.params.id, { sslEnabled: !!service.ssl_enabled }, req.ip);

    res.json({
      success: true,
      message: reloadResult.success ? 'Configuration regenerated and Caddy reloaded' : 'Configuration regenerated but Caddy reload failed',
      sslCertificateExists: !!service.ssl_enabled,
      caddyReloaded: reloadResult.success,
      caddyError: reloadResult.error,
    });
  } catch (error) {
    console.error('Error regenerating config:', error);
    res.status(500).json({ error: 'Failed to regenerate config: ' + error.message });
  }
});

// Regenerate all Caddy configs with backup/revert capability
servicesRouter.post('/caddy/regenerate-all', async (req, res) => {
  try {
    const db = getDb();
    const services = db.prepare('SELECT * FROM services').all();

    const results = { success: [], failed: [] };
    const backups = {}; // Store backups of original configs

    // Ensure Caddy structure exists
    await ensureCaddyStructure();

    // First, backup ALL existing site configs
    try {
      let configFiles = [];
      if (existsSync(CADDY_SITES_DIR)) {
        configFiles = await readdir(CADDY_SITES_DIR);
      }

      for (const file of configFiles) {
        if (file === '.' || file === '..') continue;
        try {
          const configPath = `${CADDY_SITES_DIR}/${file}`;
          if (existsSync(configPath)) {
            backups[file] = await readFile(configPath, 'utf-8');
          }
        } catch (e) {
          console.log(`Could not backup config ${file}:`, e.message);
        }
      }
      console.log(`Backed up ${Object.keys(backups).length} Caddy site configs`);
    } catch (e) {
      console.error('Error backing up configs:', e);
    }

    // Generate and write new configs for services in database
    for (const service of services) {
      // Skip admin service - its config is managed by the installer
      if (service.is_admin) {
        console.log(`Skipping admin service: ${service.domain}`);
        results.success.push(`${service.domain} (skipped - admin)`);
        continue;
      }

      try {
        const serviceConfig = {
          domain: service.domain,
          pathPrefix: service.path_prefix,
          type: service.type,
          target: service.target,
          port: service.port,
          rootDir: service.root_dir,
          websocketEnabled: !!service.websocket_enabled,
          forceHttps: !!service.force_https,
          maxUploadSize: service.max_upload_size,
          sslEnabled: !!service.ssl_enabled,
        };

        const caddyConfig = generateCaddyConfig(serviceConfig);
        const configPath = caddyFilePath(service.domain);

        // Write config
        await writeCaddyConfig(configPath, caddyConfig);

        results.success.push(service.domain);
      } catch (err) {
        console.error(`Failed to regenerate config for ${service.domain}:`, err);
        results.failed.push({ domain: service.domain, error: err.message });
      }
    }

    // Validate Caddy config before reload
    let testPassed = false;
    try {
      await execOnHost(`caddy adapt --config ${CADDY_CONFIG_FILE} > /dev/null 2>&1`);
      testPassed = true;
    } catch (testError) {
      console.error('Caddy config validation failed:', testError.stderr || testError.message);
    }

    // Helper function to revert all configs from backup
    const revertAllConfigs = async () => {
      console.log('Reverting all configs from backup...');
      for (const [filename, content] of Object.entries(backups)) {
        const configPath = `${CADDY_SITES_DIR}/${filename}`;
        try {
          await writeCaddyConfig(configPath, content);
          console.log(`Reverted config: ${filename}`);
        } catch (e) {
          console.error(`Failed to revert config for ${filename}:`, e);
        }
      }
    };

    if (!testPassed) {
      await revertAllConfigs();

      logAudit(req.user.id, 'CADDY_CONFIGS_REGENERATE_FAILED', 'system', null, { reason: 'Config validation failed, reverted' }, req.ip);

      return res.status(400).json({
        success: false,
        error: 'Caddy config validation failed - all configs reverted to previous versions',
        results,
      });
    }

    // Validation passed, reload Caddy
    const reloadResult = await reloadCaddy();

    if (!reloadResult.success) {
      await revertAllConfigs();
      await reloadCaddy().catch(() => {});

      logAudit(req.user.id, 'CADDY_CONFIGS_REGENERATE_FAILED', 'system', null, { reason: 'Reload failed, reverted' }, req.ip);

      return res.status(400).json({
        success: false,
        error: 'Caddy reload failed - all configs reverted to previous versions',
        details: reloadResult.error,
        results,
      });
    }

    logAudit(req.user.id, 'CADDY_CONFIGS_REGENERATED', 'system', null, results, req.ip);

    res.json({
      success: true,
      results,
      caddyReloaded: reloadResult.success,
      caddyError: reloadResult.error,
    });
  } catch (error) {
    console.error('Error regenerating all configs:', error);
    res.status(500).json({ error: 'Failed to regenerate configs: ' + error.message });
  }
});

// Caddy reload endpoint
servicesRouter.post('/caddy/reload', async (req, res) => {
  try {
    const result = await reloadCaddy();
    if (result.success) {
      logAudit(req.user.id, 'CADDY_RELOADED', 'system', null, {}, req.ip);
      res.json({ success: true, message: 'Caddy reloaded successfully' });
    } else {
      let errorMessage = result.error || 'Unknown error';
      res.status(500).json({
        error: `Caddy reload failed: ${errorMessage}`,
        details: result.error
      });
    }
  } catch (error) {
    console.error('Error reloading Caddy:', error);
    res.status(500).json({ error: 'Failed to reload Caddy: ' + error.message });
  }
});

// Get all services
servicesRouter.get('/', (req, res) => {
  try {
    const db = getDb();
    const services = db.prepare(`
      SELECT id, name, domain, path_prefix as pathPrefix, type, target, port,
             root_dir as rootDir,
             container_name as containerName, ssl_enabled as sslEnabled,
             force_https as forceHttps, websocket_enabled as websocketEnabled,
             max_upload_size as maxUploadSize, status, is_admin as isAdmin,
             is_favorite as isFavorite, data_dir as dataDir,
             created_at as createdAt, updated_at as updatedAt
      FROM services
      ORDER BY is_favorite DESC, created_at DESC
    `).all();

    // Convert integer booleans to actual booleans
    // Caddy auto-manages certs, so sslCertificateExists matches sslEnabled
    const formattedServices = services.map(s => ({
      ...s,
      sslEnabled: !!s.sslEnabled,
      forceHttps: !!s.forceHttps,
      websocketEnabled: !!s.websocketEnabled,
      isAdmin: !!s.isAdmin,
      isFavorite: !!s.isFavorite,
      sslCertificateExists: !!s.sslEnabled,
    }));

    res.json({ services: formattedServices });
  } catch (error) {
    console.error('Error fetching services:', error);
    res.status(500).json({ error: 'Failed to fetch services' });
  }
});

// Get single service
servicesRouter.get('/:id', (req, res) => {
  try {
    const db = getDb();
    const service = db.prepare(`
      SELECT id, name, domain, path_prefix as pathPrefix, type, target, port,
             root_dir as rootDir,
             container_name as containerName, ssl_enabled as sslEnabled,
             force_https as forceHttps, websocket_enabled as websocketEnabled,
             max_upload_size as maxUploadSize, status, is_admin as isAdmin,
             is_favorite as isFavorite, data_dir as dataDir,
             created_at as createdAt, updated_at as updatedAt
      FROM services WHERE id = ?
    `).get(req.params.id);

    if (!service) {
      return res.status(404).json({ error: 'Service not found' });
    }

    res.json({
      service: {
        ...service,
        sslEnabled: !!service.sslEnabled,
        forceHttps: !!service.forceHttps,
        websocketEnabled: !!service.websocketEnabled,
        isAdmin: !!service.isAdmin,
        isFavorite: !!service.isFavorite,
      },
    });
  } catch (error) {
    console.error('Error fetching service:', error);
    res.status(500).json({ error: 'Failed to fetch service' });
  }
});

// Toggle favorite status
servicesRouter.post('/:id/favorite', (req, res) => {
  try {
    const db = getDb();
    const service = db.prepare('SELECT id, is_favorite FROM services WHERE id = ?').get(req.params.id);

    if (!service) {
      return res.status(404).json({ error: 'Service not found' });
    }

    const newValue = service.is_favorite ? 0 : 1;
    db.prepare('UPDATE services SET is_favorite = ? WHERE id = ?').run(newValue, req.params.id);

    res.json({ success: true, isFavorite: !!newValue });
  } catch (error) {
    console.error('Error toggling favorite:', error);
    res.status(500).json({ error: 'Failed to toggle favorite' });
  }
});

// Create new service
servicesRouter.post('/', async (req, res) => {
  try {
    const data = createServiceSchema.parse(req.body);
    // Normalize path prefix (strip trailing slashes, default to '/') so the
    // same canonical value is used across validation, Caddy config, and DB.
    data.pathPrefix = normalizePathPrefix(data.pathPrefix);
    const db = getDb();

    // Check if domain already exists
    const existing = db.prepare('SELECT id FROM services WHERE domain = ?').get(data.domain);
    if (existing) {
      return res.status(400).json({ error: 'Domain already exists' });
    }

    // Validate type-specific requirements
    if (data.type === 'static' && !data.rootDir) {
      // For static sites, we'll create a directory automatically
      const safeDir = toSafeDirectoryName(data.name);
      data.rootDir = join(SERVICES_DATA_DIR, safeDir);
    }
    if (data.type === 'docker' && !data.containerName) {
      return res.status(400).json({ error: 'Docker type requires containerName' });
    }
    if (data.type === 'docker' && !data.port) {
      return res.status(400).json({ error: 'Docker type requires port' });
    }

    const id = uuidv4();
    const safeDir = toSafeDirectoryName(data.name);
    const dataDir = join(SERVICES_DATA_DIR, safeDir);

    // Create service data directory
    await mkdir(dataDir, { recursive: true });

    // For static sites, create default index.html
    if (data.type === 'static') {
      const indexPath = join(dataDir, 'index.html');
      if (!existsSync(indexPath)) {
        const defaultHtml = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${escapeHtml(data.name)}</title>
    <style>
        body { font-family: system-ui, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: #f5f5f5; }
        .container { text-align: center; padding: 2rem; }
        h1 { color: #333; }
        p { color: #666; }
    </style>
</head>
<body>
    <div class="container">
        <h1>Welcome to ${escapeHtml(data.name)}</h1>
        <p>Your static site is ready. Edit the files using ProxyPilot dashboard.</p>
    </div>
</body>
</html>`;
        await writeFile(indexPath, defaultHtml);
      }
      // Set rootDir to the created directory
      data.rootDir = dataDir;
    }

    // For docker, create default docker-compose.yml
    if (data.type === 'docker') {
      const composePath = join(dataDir, 'docker-compose.yml');
      if (!existsSync(composePath)) {
        const defaultCompose = `version: '3.8'

services:
  ${data.containerName}:
    image: nginx:alpine
    container_name: ${data.containerName}
    restart: unless-stopped
    ports:
      - "127.0.0.1:${data.port}:80"
    volumes:
      - ./html:/usr/share/nginx/html:ro
`;
        await writeFile(composePath, defaultCompose);
        // Create html subdirectory
        await mkdir(join(dataDir, 'html'), { recursive: true });
        await writeFile(join(dataDir, 'html', 'index.html'), `<h1>${escapeHtml(data.name)}</h1>`);
      }
      // Set target to localhost
      data.target = data.target || '127.0.0.1';
    }

    // Generate Caddy config
    const caddyConfig = generateCaddyConfig(data);

    // Write Caddy site config file
    await ensureCaddyStructure();
    const configPath = caddyFilePath(data.domain);
    await writeCaddyConfig(configPath, caddyConfig);

    // Validate Caddy config
    try {
      await execOnHost(`caddy adapt --config ${CADDY_CONFIG_FILE} > /dev/null 2>&1`);
    } catch (testErr) {
      // Rollback
      await unlink(configPath).catch(() => {});
      return res.status(400).json({ error: 'Invalid Caddy configuration generated: ' + (testErr.stderr || testErr.message) });
    }

    // Reload Caddy
    const caddyResult = await reloadCaddy();

    // Insert into database
    db.prepare(`
      INSERT INTO services (
        id, name, domain, path_prefix, type, target, port, root_dir, container_name,
        ssl_enabled, force_https, websocket_enabled, max_upload_size, data_dir, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')
    `).run(
      id, data.name, data.domain, data.pathPrefix, data.type, data.target || null,
      data.port || null, data.rootDir || null, data.containerName || null,
      data.sslEnabled ? 1 : 0, data.forceHttps ? 1 : 0,
      data.websocketEnabled ? 1 : 0, data.maxUploadSize, dataDir
    );

    logAudit(req.user.id, 'SERVICE_CREATED', 'service', id, data, req.ip);

    // Save initial files as version 1 for version control
    if (data.type === 'static') {
      const indexPath = join(dataDir, 'index.html');
      try {
        const content = await readFile(indexPath, 'utf-8');
        db.prepare(`
          INSERT INTO file_versions (id, service_id, file_path, content, version, notes, created_by)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(uuidv4(), id, 'index.html', content, 1, 'Initial file created with service', req.user.id);
      } catch (e) {
        console.log('Could not save initial version for index.html');
      }
    } else if (data.type === 'docker') {
      // Save docker-compose.yml and index.html as version 1
      const composePath = join(dataDir, 'docker-compose.yml');
      const htmlIndexPath = join(dataDir, 'html', 'index.html');
      try {
        const composeContent = await readFile(composePath, 'utf-8');
        db.prepare(`
          INSERT INTO file_versions (id, service_id, file_path, content, version, notes, created_by)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(uuidv4(), id, 'docker-compose.yml', composeContent, 1, 'Initial file created with service', req.user.id);
      } catch (e) {
        console.log('Could not save initial version for docker-compose.yml');
      }
      try {
        const htmlContent = await readFile(htmlIndexPath, 'utf-8');
        db.prepare(`
          INSERT INTO file_versions (id, service_id, file_path, content, version, notes, created_by)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(uuidv4(), id, 'html/index.html', htmlContent, 1, 'Initial file created with service', req.user.id);
      } catch (e) {
        console.log('Could not save initial version for html/index.html');
      }
    }

    // Caddy auto-manages SSL certificates when SSL is enabled
    const sslCertificateExists = !!data.sslEnabled;
    const sslMessage = data.sslEnabled
      ? 'Caddy will automatically obtain and manage the SSL certificate'
      : null;

    res.status(201).json({
      success: true,
      service: { id, ...data, dataDir },
      sslCertificateExists,
      sslMessage,
      certObtained: !!data.sslEnabled,
      caddyReloaded: caddyResult.success,
      caddyError: caddyResult.error,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: error.errors[0].message });
    }
    console.error('Error creating service:', error);
    res.status(500).json({ error: 'Failed to create service' });
  }
});

// Update service
servicesRouter.put('/:id', async (req, res) => {
  try {
    const data = createServiceSchema.partial().parse(req.body);
    const db = getDb();

    const service = db.prepare('SELECT * FROM services WHERE id = ?').get(req.params.id);
    if (!service) {
      return res.status(404).json({ error: 'Service not found' });
    }

    if (service.is_admin) {
      return res.status(403).json({ error: 'Cannot modify admin service' });
    }

    // If domain changed, check for conflicts
    if (data.domain && data.domain !== service.domain) {
      const existing = db.prepare('SELECT id FROM services WHERE domain = ? AND id != ?')
        .get(data.domain, req.params.id);
      if (existing) {
        return res.status(400).json({ error: 'Domain already exists' });
      }
    }

    // Merge with existing data
    const updatedData = {
      name: data.name || service.name,
      domain: data.domain || service.domain,
      pathPrefix: data.pathPrefix !== undefined ? normalizePathPrefix(data.pathPrefix) : normalizePathPrefix(service.path_prefix),
      type: data.type || service.type,
      target: data.target !== undefined ? data.target : service.target,
      port: data.port !== undefined ? data.port : service.port,
      rootDir: data.rootDir !== undefined ? data.rootDir : service.root_dir,
      dataDir: data.dataDir !== undefined ? data.dataDir : service.data_dir,
      containerName: data.containerName !== undefined ? data.containerName : service.container_name,
      sslEnabled: data.sslEnabled !== undefined ? data.sslEnabled : !!service.ssl_enabled,
      forceHttps: data.forceHttps !== undefined ? data.forceHttps : !!service.force_https,
      websocketEnabled: data.websocketEnabled !== undefined ? data.websocketEnabled : !!service.websocket_enabled,
      maxUploadSize: data.maxUploadSize || service.max_upload_size,
    };

    // Remove old Caddy config if domain changed
    if (data.domain && data.domain !== service.domain) {
      await unlink(caddyFilePath(service.domain)).catch(() => {});
    }

    // Backup existing Caddy config before changes
    const configPath = caddyFilePath(updatedData.domain);
    let backupConfig = null;
    try {
      if (existsSync(configPath)) {
        backupConfig = await readFile(configPath, 'utf-8');
      }
    } catch (e) {
      // No backup available
    }

    // Generate and write new Caddy config
    const caddyConfig = generateCaddyConfig(updatedData);
    await writeCaddyConfig(configPath, caddyConfig);

    // Validate Caddy config before reload
    try {
      await execOnHost(`caddy adapt --config ${CADDY_CONFIG_FILE} > /dev/null 2>&1`);
    } catch (testError) {
      // Config validation failed - revert to backup
      if (backupConfig) {
        await writeCaddyConfig(configPath, backupConfig);
      }
      return res.status(400).json({
        error: 'Caddy config validation failed - reverted to previous config',
        details: testError.stderr || testError.message,
      });
    }

    // Reload Caddy with failsafe
    try {
      await execOnHost(`caddy reload --config ${CADDY_CONFIG_FILE} --force 2>&1`);
    } catch (reloadError) {
      // Reload failed - revert to backup
      if (backupConfig) {
        await writeCaddyConfig(configPath, backupConfig);
        await execOnHost(`caddy reload --config ${CADDY_CONFIG_FILE} --force 2>&1`).catch(() => {});
      }
      return res.status(400).json({
        error: 'Caddy reload failed - reverted to previous config',
        details: reloadError.stderr || reloadError.message,
      });
    }

    // Update database
    db.prepare(`
      UPDATE services SET
        name = ?, domain = ?, path_prefix = ?, type = ?, target = ?, port = ?,
        root_dir = ?, data_dir = ?, container_name = ?, ssl_enabled = ?,
        force_https = ?, websocket_enabled = ?, max_upload_size = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      updatedData.name, updatedData.domain, updatedData.pathPrefix, updatedData.type,
      updatedData.target, updatedData.port, updatedData.rootDir,
      updatedData.dataDir, updatedData.containerName, updatedData.sslEnabled ? 1 : 0,
      updatedData.forceHttps ? 1 : 0, updatedData.websocketEnabled ? 1 : 0,
      updatedData.maxUploadSize, req.params.id
    );

    // Save config version for history
    try {
      const lastVersion = db.prepare(`
        SELECT MAX(version) as maxVersion
        FROM service_config_versions
        WHERE service_id = ?
      `).get(req.params.id);

      const newVersion = (lastVersion?.maxVersion || 0) + 1;

      db.prepare(`
        INSERT INTO service_config_versions (id, service_id, config_json, version, notes, created_by)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        uuidv4(),
        req.params.id,
        JSON.stringify(updatedData),
        newVersion,
        'Configuration updated',
        req.user.id
      );
    } catch (e) {
      console.error('Error saving config version:', e);
      // Non-critical, don't fail the update
    }

    logAudit(req.user.id, 'SERVICE_UPDATED', 'service', req.params.id, updatedData, req.ip);

    res.json({ success: true, service: { id: req.params.id, ...updatedData } });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: error.errors[0].message });
    }
    console.error('Error updating service:', error);
    res.status(500).json({ error: 'Failed to update service' });
  }
});

// Get service config versions (for version control)
servicesRouter.get('/:id/config-versions', async (req, res) => {
  try {
    const db = getDb();

    const versions = db.prepare(`
      SELECT scv.*, u.username as created_by_name
      FROM service_config_versions scv
      LEFT JOIN users u ON scv.created_by = u.id
      WHERE scv.service_id = ?
      ORDER BY scv.version DESC
      LIMIT 50
    `).all(req.params.id);

    res.json({
      versions: versions.map(v => ({
        id: v.id,
        version: v.version,
        config: JSON.parse(v.config_json),
        notes: v.notes,
        createdBy: v.created_by_name || 'Unknown',
        createdAt: v.created_at,
      }))
    });
  } catch (error) {
    console.error('Error fetching config versions:', error);
    res.status(500).json({ error: 'Failed to fetch config versions' });
  }
});

// Revert service config to a previous version
servicesRouter.post('/:id/revert-config/:versionId', async (req, res) => {
  try {
    const db = getDb();

    const version = db.prepare(`
      SELECT * FROM service_config_versions
      WHERE id = ? AND service_id = ?
    `).get(req.params.versionId, req.params.id);

    if (!version) {
      return res.status(404).json({ error: 'Config version not found' });
    }

    const config = JSON.parse(version.config_json);

    // Apply the old config
    const service = db.prepare('SELECT * FROM services WHERE id = ?').get(req.params.id);
    if (!service) {
      return res.status(404).json({ error: 'Service not found' });
    }

    if (service.is_admin) {
      return res.status(403).json({ error: 'Cannot modify admin service' });
    }

    // Regenerate Caddy config with reverted settings
    const caddyConfig = generateCaddyConfig(config);
    const configPath = caddyFilePath(config.domain);
    await writeCaddyConfig(configPath, caddyConfig);

    // Validate and reload Caddy
    await execOnHost(`caddy adapt --config ${CADDY_CONFIG_FILE} > /dev/null 2>&1`);
    await reloadCaddy();

    // Update database. Older saved versions may not include pathPrefix —
    // fall back to the normalized default so reverts from pre-wildcard
    // history still succeed.
    db.prepare(`
      UPDATE services SET
        name = ?, domain = ?, path_prefix = ?, type = ?, target = ?, port = ?,
        root_dir = ?, container_name = ?, ssl_enabled = ?,
        force_https = ?, websocket_enabled = ?, max_upload_size = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      config.name, config.domain, normalizePathPrefix(config.pathPrefix), config.type,
      config.target, config.port, config.rootDir,
      config.containerName, config.sslEnabled ? 1 : 0,
      config.forceHttps ? 1 : 0, config.websocketEnabled ? 1 : 0,
      config.maxUploadSize, req.params.id
    );

    // Save as new version
    const lastVersion = db.prepare(`
      SELECT MAX(version) as maxVersion FROM service_config_versions WHERE service_id = ?
    `).get(req.params.id);

    db.prepare(`
      INSERT INTO service_config_versions (id, service_id, config_json, version, notes, created_by)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      uuidv4(),
      req.params.id,
      JSON.stringify(config),
      (lastVersion?.maxVersion || 0) + 1,
      `Reverted to version ${version.version}`,
      req.user.id
    );

    logAudit(req.user.id, 'SERVICE_CONFIG_REVERTED', 'service', req.params.id, {
      revertedToVersion: version.version,
    }, req.ip);

    res.json({ success: true, message: `Reverted to version ${version.version}` });
  } catch (error) {
    console.error('Error reverting config:', error);
    res.status(500).json({ error: 'Failed to revert config: ' + error.message });
  }
});

// Get Caddy config for advanced editing
servicesRouter.get('/:id/caddy-config', async (req, res) => {
  try {
    const db = getDb();
    const service = db.prepare('SELECT domain FROM services WHERE id = ?').get(req.params.id);

    if (!service) {
      return res.status(404).json({ error: 'Service not found' });
    }

    const configPath = caddyFilePath(service.domain);

    if (!existsSync(configPath)) {
      return res.status(404).json({ error: 'Caddy config not found' });
    }

    const config = await readFile(configPath, 'utf-8');
    res.json({ config });
  } catch (error) {
    console.error('Error reading Caddy config:', error);
    res.status(500).json({ error: 'Failed to read Caddy config' });
  }
});

// Save Caddy config with failsafe revert on reload failure
servicesRouter.put('/:id/caddy-config', async (req, res) => {
  try {
    const { config } = req.body;
    const db = getDb();
    const service = db.prepare('SELECT * FROM services WHERE id = ?').get(req.params.id);

    if (!service) {
      return res.status(404).json({ error: 'Service not found' });
    }

    const configPath = caddyFilePath(service.domain);

    // Read and backup current config
    let backupConfig = null;
    if (existsSync(configPath)) {
      backupConfig = await readFile(configPath, 'utf-8');
    }

    // Write new config
    await writeCaddyConfig(configPath, config);

    // Validate Caddy config
    try {
      await execOnHost(`caddy adapt --config ${CADDY_CONFIG_FILE} > /dev/null 2>&1`);
    } catch (testError) {
      // Config validation failed - revert to backup
      if (backupConfig) {
        await writeCaddyConfig(configPath, backupConfig);
      }
      return res.status(400).json({
        error: 'Caddy config validation failed - reverted to previous config',
        details: testError.stderr || testError.message,
      });
    }

    // Try to reload Caddy
    try {
      await execOnHost(`caddy reload --config ${CADDY_CONFIG_FILE} --force 2>&1`);
    } catch (reloadError) {
      // Reload failed - revert to backup
      if (backupConfig) {
        await writeCaddyConfig(configPath, backupConfig);
        await execOnHost(`caddy reload --config ${CADDY_CONFIG_FILE} --force 2>&1`).catch(() => {});
      }
      return res.status(400).json({
        error: 'Caddy reload failed - reverted to previous config',
        details: reloadError.stderr || reloadError.message,
      });
    }

    // Save version to history
    const versionId = uuidv4();
    const lastVersion = db.prepare(`
      SELECT MAX(version) as maxVersion FROM service_config_versions WHERE service_id = ?
    `).get(req.params.id);
    const newVersion = (lastVersion?.maxVersion || 0) + 1;

    db.prepare(`
      INSERT INTO service_config_versions (
        id, service_id, config_json, version, notes, created_by
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      versionId,
      req.params.id,
      JSON.stringify({ rawCaddyConfig: config }),
      newVersion,
      'Manual Caddy config edit',
      req.user.id
    );

    logAudit(req.user.id, 'CADDY_CONFIG_EDITED', 'service', req.params.id, { domain: service.domain }, req.ip);

    res.json({ success: true, message: 'Caddy config saved and reloaded' });
  } catch (error) {
    console.error('Error saving Caddy config:', error);
    res.status(500).json({ error: 'Failed to save Caddy config: ' + error.message });
  }
});

// Delete service (requires TOTP)
servicesRouter.delete('/:id', async (req, res) => {
  try {
    const { totpCode } = deleteServiceSchema.parse(req.body);
    const db = getDb();

    const service = db.prepare('SELECT * FROM services WHERE id = ?').get(req.params.id);
    if (!service) {
      return res.status(404).json({ error: 'Service not found' });
    }

    if (service.is_admin) {
      return res.status(403).json({ error: 'Cannot delete admin service' });
    }

    // Verify TOTP
    const user = db.prepare('SELECT totp_secret FROM users WHERE id = ?').get(req.user.id);
    if (user && user.totp_secret) {
      const totp = new OTPAuth.TOTP({
        issuer: 'ProxyPilot',
        label: req.user.username,
        algorithm: 'SHA1',
        digits: 6,
        period: 30,
        secret: OTPAuth.Secret.fromBase32(user.totp_secret),
      });

      const delta = totp.validate({ token: totpCode, window: 1 });
      if (delta === null) {
        return res.status(401).json({ error: 'Invalid TOTP code' });
      }
    }

    // Remove Caddy site config
    try {
      await unlink(caddyFilePath(service.domain)).catch(() => {});
    } catch (e) {
      console.error('Error removing Caddy config file:', e);
    }

    // Reload Caddy
    await reloadCaddy().catch((e) => {
      console.error('Error reloading Caddy after delete:', e);
    });

    // Optionally remove data directory (keep files by default for safety)
    // To enable: await rm(service.data_dir, { recursive: true, force: true }).catch(() => {});

    // Delete from database
    db.prepare('DELETE FROM services WHERE id = ?').run(req.params.id);

    logAudit(req.user.id, 'SERVICE_DELETED', 'service', req.params.id, { domain: service.domain }, req.ip);

    res.json({ success: true });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: error.errors[0].message });
    }
    console.error('Error deleting service:', error);
    res.status(500).json({ error: 'Failed to delete service' });
  }
});

// ==================== FILE MANAGEMENT ====================

// List files for a service
servicesRouter.get('/:id/files', async (req, res) => {
  try {
    const db = getDb();
    const service = db.prepare('SELECT data_dir FROM services WHERE id = ?').get(req.params.id);

    if (!service) {
      return res.status(404).json({ error: 'Service not found' });
    }

    if (!service.data_dir || !existsSync(service.data_dir)) {
      return res.json({ files: [] });
    }

    const files = await listFilesRecursive(service.data_dir, service.data_dir);
    res.json({ files, basePath: service.data_dir });
  } catch (error) {
    console.error('Error listing files:', error);
    res.status(500).json({ error: 'Failed to list files' });
  }
});

// Helper to list files recursively
async function listFilesRecursive(dir, baseDir, maxDepth = 3, currentDepth = 0) {
  if (currentDepth >= maxDepth) return [];

  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    const relativePath = fullPath.replace(baseDir + '/', '');

    if (entry.isDirectory()) {
      const subFiles = await listFilesRecursive(fullPath, baseDir, maxDepth, currentDepth + 1);
      files.push({
        name: entry.name,
        path: relativePath,
        type: 'directory',
        children: subFiles,
      });
    } else {
      const stats = await stat(fullPath);
      files.push({
        name: entry.name,
        path: relativePath,
        type: 'file',
        size: stats.size,
        modified: stats.mtime,
      });
    }
  }

  return files.sort((a, b) => {
    if (a.type === b.type) return a.name.localeCompare(b.name);
    return a.type === 'directory' ? -1 : 1;
  });
}

// Read a file
servicesRouter.get('/:id/files/*', async (req, res) => {
  try {
    const db = getDb();
    const service = db.prepare('SELECT data_dir FROM services WHERE id = ?').get(req.params.id);

    if (!service) {
      return res.status(404).json({ error: 'Service not found' });
    }

    const filePath = req.params[0];
    const fullPath = safePath(service.data_dir, filePath);

    // Security: ensure path is within data_dir
    if (!fullPath) {
      return res.status(403).json({ error: 'Access denied' });
    }

    if (!existsSync(fullPath)) {
      return res.status(404).json({ error: 'File not found' });
    }

    const stats = await stat(fullPath);
    if (stats.isDirectory()) {
      return res.status(400).json({ error: 'Cannot read directory' });
    }

    // Limit file size for reading
    if (stats.size > 5 * 1024 * 1024) { // 5MB
      return res.status(400).json({ error: 'File too large to read (max 5MB)' });
    }

    const content = await readFile(fullPath, 'utf-8');
    res.json({ content, path: filePath, size: stats.size });
  } catch (error) {
    console.error('Error reading file:', error);
    res.status(500).json({ error: 'Failed to read file' });
  }
});

// Create or update a file (with version control)
servicesRouter.put('/:id/files/*', async (req, res) => {
  try {
    const { content, notes } = req.body;
    if (typeof content !== 'string') {
      return res.status(400).json({ error: 'Content is required' });
    }

    const db = getDb();
    const service = db.prepare('SELECT data_dir, type FROM services WHERE id = ?').get(req.params.id);

    if (!service) {
      return res.status(404).json({ error: 'Service not found' });
    }

    const filePath = req.params[0];
    const fullPath = safePath(service.data_dir, filePath);

    // Security: ensure path is within data_dir
    if (!fullPath) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Validate filename
    const filename = basename(filePath);
    if (!/^[a-zA-Z0-9._-]+$/.test(filename)) {
      return res.status(400).json({ error: 'Invalid filename' });
    }

    // Save current version before overwriting (if file exists)
    if (existsSync(fullPath)) {
      try {
        const oldContent = await readFile(fullPath, 'utf-8');
        // Get the next version number
        const lastVersion = db.prepare(`
          SELECT MAX(version) as maxVersion FROM file_versions
          WHERE service_id = ? AND file_path = ?
        `).get(req.params.id, filePath);
        const nextVersion = (lastVersion?.maxVersion || 0) + 1;

        // Save old content as a version
        db.prepare(`
          INSERT INTO file_versions (id, service_id, file_path, content, version, notes, created_by)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(uuidv4(), req.params.id, filePath, oldContent, nextVersion, notes || null, req.user.id);

        // Keep only last 50 versions per file
        db.prepare(`
          DELETE FROM file_versions WHERE service_id = ? AND file_path = ? AND version NOT IN (
            SELECT version FROM file_versions WHERE service_id = ? AND file_path = ?
            ORDER BY version DESC LIMIT 50
          )
        `).run(req.params.id, filePath, req.params.id, filePath);
      } catch (e) {
        // File might be binary, skip versioning
      }
    }

    // Create directory if needed
    const dirPath = fullPath.substring(0, fullPath.lastIndexOf('/'));
    await mkdir(dirPath, { recursive: true });

    await writeFile(fullPath, content);

    logAudit(req.user.id, 'FILE_UPDATED', 'service', req.params.id, { path: filePath }, req.ip);

    // Auto-reload Caddy for static sites
    let caddyReloaded = false;
    if (service.type === 'static') {
      const reloadResult = await reloadCaddy();
      caddyReloaded = reloadResult.success;
    }

    res.json({ success: true, path: filePath, caddyReloaded });
  } catch (error) {
    console.error('Error writing file:', error);
    res.status(500).json({ error: 'Failed to write file' });
  }
});

// Delete a file
servicesRouter.delete('/:id/files/*', async (req, res) => {
  try {
    const db = getDb();
    const service = db.prepare('SELECT data_dir FROM services WHERE id = ?').get(req.params.id);

    if (!service) {
      return res.status(404).json({ error: 'Service not found' });
    }

    const filePath = req.params[0];
    const fullPath = safePath(service.data_dir, filePath);

    // Security: ensure path is within data_dir
    if (!fullPath) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Prevent deleting root directory
    if (fullPath === resolve(service.data_dir)) {
      return res.status(403).json({ error: 'Cannot delete root directory' });
    }

    if (!existsSync(fullPath)) {
      return res.status(404).json({ error: 'File not found' });
    }

    const stats = await stat(fullPath);
    if (stats.isDirectory()) {
      await rm(fullPath, { recursive: true });
    } else {
      await unlink(fullPath);
    }

    logAudit(req.user.id, 'FILE_DELETED', 'service', req.params.id, { path: filePath }, req.ip);

    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting file:', error);
    res.status(500).json({ error: 'Failed to delete file' });
  }
});

// ==================== FILE VERSION CONTROL ====================

// Get file versions
servicesRouter.get('/:id/versions/*', (req, res) => {
  try {
    const db = getDb();
    const service = db.prepare('SELECT id FROM services WHERE id = ?').get(req.params.id);

    if (!service) {
      return res.status(404).json({ error: 'Service not found' });
    }

    const filePath = req.params[0];
    const versions = db.prepare(`
      SELECT id, version, notes, created_at as createdAt, created_by as createdBy
      FROM file_versions
      WHERE service_id = ? AND file_path = ?
      ORDER BY version DESC
      LIMIT 50
    `).all(req.params.id, filePath);

    res.json({ versions, filePath });
  } catch (error) {
    console.error('Error fetching versions:', error);
    res.status(500).json({ error: 'Failed to fetch versions' });
  }
});

// Get specific version content
servicesRouter.get('/:id/version/:versionId', (req, res) => {
  try {
    const db = getDb();
    const version = db.prepare(`
      SELECT fv.*, s.data_dir
      FROM file_versions fv
      JOIN services s ON s.id = fv.service_id
      WHERE fv.id = ? AND fv.service_id = ?
    `).get(req.params.versionId, req.params.id);

    if (!version) {
      return res.status(404).json({ error: 'Version not found' });
    }

    res.json({
      content: version.content,
      version: version.version,
      filePath: version.file_path,
      createdAt: version.created_at,
    });
  } catch (error) {
    console.error('Error fetching version:', error);
    res.status(500).json({ error: 'Failed to fetch version' });
  }
});

// Revert to a specific version
servicesRouter.post('/:id/revert/:versionId', async (req, res) => {
  try {
    const db = getDb();
    const version = db.prepare(`
      SELECT fv.*, s.data_dir, s.type
      FROM file_versions fv
      JOIN services s ON s.id = fv.service_id
      WHERE fv.id = ? AND fv.service_id = ?
    `).get(req.params.versionId, req.params.id);

    if (!version) {
      return res.status(404).json({ error: 'Version not found' });
    }

    const fullPath = join(version.data_dir, version.file_path);

    // Save current as new version before reverting
    if (existsSync(fullPath)) {
      try {
        const currentContent = await readFile(fullPath, 'utf-8');
        const lastVersion = db.prepare(`
          SELECT MAX(version) as maxVersion FROM file_versions
          WHERE service_id = ? AND file_path = ?
        `).get(req.params.id, version.file_path);
        const nextVersion = (lastVersion?.maxVersion || 0) + 1;

        db.prepare(`
          INSERT INTO file_versions (id, service_id, file_path, content, version, created_by)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(uuidv4(), req.params.id, version.file_path, currentContent, nextVersion, req.user.id);
      } catch (e) {
        // Skip if can't read
      }
    }

    // Write the reverted content
    await writeFile(fullPath, version.content);

    logAudit(req.user.id, 'FILE_REVERTED', 'service', req.params.id, {
      path: version.file_path,
      toVersion: version.version,
    }, req.ip);

    // Reload Caddy for static sites
    let caddyReloaded = false;
    if (version.type === 'static') {
      const reloadResult = await reloadCaddy();
      caddyReloaded = reloadResult.success;
    }

    res.json({ success: true, revertedToVersion: version.version, caddyReloaded });
  } catch (error) {
    console.error('Error reverting file:', error);
    res.status(500).json({ error: 'Failed to revert file' });
  }
});

// Update version notes
servicesRouter.put('/:id/version/:versionId/notes', (req, res) => {
  try {
    const { notes } = req.body;
    const db = getDb();

    const version = db.prepare(`
      SELECT id FROM file_versions WHERE id = ? AND service_id = ?
    `).get(req.params.versionId, req.params.id);

    if (!version) {
      return res.status(404).json({ error: 'Version not found' });
    }

    db.prepare(`
      UPDATE file_versions SET notes = ? WHERE id = ?
    `).run(notes || null, req.params.versionId);

    logAudit(req.user.id, 'VERSION_NOTES_UPDATED', 'service', req.params.id, {
      versionId: req.params.versionId,
      notes,
    }, req.ip);

    res.json({ success: true });
  } catch (error) {
    console.error('Error updating version notes:', error);
    res.status(500).json({ error: 'Failed to update notes' });
  }
});

// ==================== FILE UPLOAD/DOWNLOAD ====================

// Upload file (for binary or large files)
servicesRouter.post('/:id/upload/*', async (req, res) => {
  try {
    const { content, encoding } = req.body; // content can be base64 encoded

    const db = getDb();
    const service = db.prepare('SELECT data_dir FROM services WHERE id = ?').get(req.params.id);

    if (!service) {
      return res.status(404).json({ error: 'Service not found' });
    }

    const filePath = req.params[0];
    const fullPath = safePath(service.data_dir, filePath);

    // Security check
    if (!fullPath) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Create directory if needed
    const dirPath = fullPath.substring(0, fullPath.lastIndexOf('/'));
    await mkdir(dirPath, { recursive: true });

    // Write file (handle base64 if specified)
    if (encoding === 'base64') {
      await writeFile(fullPath, Buffer.from(content, 'base64'));
    } else {
      await writeFile(fullPath, content);
    }

    logAudit(req.user.id, 'FILE_UPLOADED', 'service', req.params.id, { path: filePath }, req.ip);

    res.json({ success: true, path: filePath });
  } catch (error) {
    console.error('Error uploading file:', error);
    res.status(500).json({ error: 'Failed to upload file' });
  }
});

// Download file as base64
servicesRouter.get('/:id/download/*', async (req, res) => {
  try {
    const db = getDb();
    const service = db.prepare('SELECT data_dir FROM services WHERE id = ?').get(req.params.id);

    if (!service) {
      return res.status(404).json({ error: 'Service not found' });
    }

    const filePath = req.params[0];
    const fullPath = safePath(service.data_dir, filePath);

    // Security check
    if (!fullPath) {
      return res.status(403).json({ error: 'Access denied' });
    }

    if (!existsSync(fullPath)) {
      return res.status(404).json({ error: 'File not found' });
    }

    const stats = await stat(fullPath);
    if (stats.isDirectory()) {
      return res.status(400).json({ error: 'Cannot download directory' });
    }

    // Limit size
    if (stats.size > 50 * 1024 * 1024) { // 50MB
      return res.status(400).json({ error: 'File too large' });
    }

    const content = await readFile(fullPath);
    res.json({
      content: content.toString('base64'),
      encoding: 'base64',
      filename: basename(filePath),
      size: stats.size,
    });
  } catch (error) {
    console.error('Error downloading file:', error);
    res.status(500).json({ error: 'Failed to download file' });
  }
});

// Export service files as JSON
servicesRouter.get('/:id/export-files', async (req, res) => {
  try {
    const db = getDb();
    const service = db.prepare('SELECT * FROM services WHERE id = ?').get(req.params.id);

    if (!service) {
      return res.status(404).json({ error: 'Service not found' });
    }

    if (!service.data_dir || !existsSync(service.data_dir)) {
      return res.json({ files: [] });
    }

    const files = await exportFilesRecursive(service.data_dir, service.data_dir);

    res.json({
      serviceName: service.name,
      exportedAt: new Date().toISOString(),
      files,
    });
  } catch (error) {
    console.error('Error exporting files:', error);
    res.status(500).json({ error: 'Failed to export files' });
  }
});

// Import files to service
servicesRouter.post('/:id/import-files', async (req, res) => {
  try {
    const { files } = req.body;

    if (!files || !Array.isArray(files)) {
      return res.status(400).json({ error: 'Invalid files data' });
    }

    const db = getDb();
    const service = db.prepare('SELECT data_dir, type FROM services WHERE id = ?').get(req.params.id);

    if (!service) {
      return res.status(404).json({ error: 'Service not found' });
    }

    const results = { imported: [], errors: [] };

    for (const file of files) {
      try {
        const fullPath = safePath(service.data_dir, file.path);

        // Security check
        if (!fullPath) {
          results.errors.push({ path: file.path, error: 'Access denied' });
          continue;
        }

        // Create directory
        const dirPath = fullPath.substring(0, fullPath.lastIndexOf('/'));
        await mkdir(dirPath, { recursive: true });

        await writeFile(fullPath, file.content);
        results.imported.push(file.path);
      } catch (err) {
        results.errors.push({ path: file.path, error: err.message });
      }
    }

    logAudit(req.user.id, 'FILES_IMPORTED', 'service', req.params.id, results, req.ip);

    // Reload Caddy for static sites
    if (service.type === 'static' && results.imported.length > 0) {
      await reloadCaddy();
    }

    res.json({ success: true, results });
  } catch (error) {
    console.error('Error importing files:', error);
    res.status(500).json({ error: 'Failed to import files' });
  }
});

// ==================== EXPORT/IMPORT ====================

// Export services
servicesRouter.post('/export', async (req, res) => {
  try {
    const { serviceIds, includeFiles } = req.body;
    const db = getDb();

    let services;
    if (serviceIds && serviceIds.length > 0) {
      const placeholders = serviceIds.map(() => '?').join(',');
      services = db.prepare(`
        SELECT * FROM services WHERE id IN (${placeholders}) AND is_admin = 0
      `).all(...serviceIds);
    } else {
      services = db.prepare('SELECT * FROM services WHERE is_admin = 0').all();
    }

    const exportData = {
      version: '1.0',
      exportedAt: new Date().toISOString(),
      services: [],
    };

    for (const service of services) {
      const serviceExport = {
        name: service.name,
        domain: service.domain,
        pathPrefix: service.path_prefix || '/',
        type: service.type,
        target: service.target,
        port: service.port,
        rootDir: service.root_dir,
        containerName: service.container_name,
        sslEnabled: !!service.ssl_enabled,
        forceHttps: !!service.force_https,
        websocketEnabled: !!service.websocket_enabled,
        maxUploadSize: service.max_upload_size,
        files: [],
      };

      // Include files if requested
      if (includeFiles && service.data_dir && existsSync(service.data_dir)) {
        serviceExport.files = await exportFilesRecursive(service.data_dir, service.data_dir);
      }

      exportData.services.push(serviceExport);
    }

    logAudit(req.user.id, 'SERVICES_EXPORTED', 'system', null, { count: services.length }, req.ip);

    res.json(exportData);
  } catch (error) {
    console.error('Error exporting services:', error);
    res.status(500).json({ error: 'Failed to export services' });
  }
});

// Helper to export files recursively
async function exportFilesRecursive(dir, baseDir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    const relativePath = fullPath.replace(baseDir + '/', '');

    if (entry.isDirectory()) {
      const subFiles = await exportFilesRecursive(fullPath, baseDir);
      files.push(...subFiles);
    } else {
      const stats = await stat(fullPath);
      // Only export text files under 1MB
      if (stats.size < 1024 * 1024) {
        try {
          const content = await readFile(fullPath, 'utf-8');
          files.push({ path: relativePath, content });
        } catch (e) {
          // Skip binary files
        }
      }
    }
  }

  return files;
}

// Import services
servicesRouter.post('/import', async (req, res) => {
  try {
    const { services: importServices, overwrite } = req.body;

    if (!importServices || !Array.isArray(importServices)) {
      return res.status(400).json({ error: 'Invalid import data' });
    }

    const db = getDb();
    const results = { imported: [], skipped: [], errors: [] };

    for (const serviceData of importServices) {
      try {
        // Check if domain exists
        const existing = db.prepare('SELECT id FROM services WHERE domain = ?').get(serviceData.domain);

        if (existing && !overwrite) {
          results.skipped.push({ name: serviceData.name, reason: 'Domain already exists' });
          continue;
        }

        if (existing && overwrite) {
          // Delete existing service first
          await unlink(caddyFilePath(serviceData.domain)).catch(() => {});
          db.prepare('DELETE FROM services WHERE id = ?').run(existing.id);
        }

        // Create the service
        const id = uuidv4();
        let dataDir;
        let rootDir = serviceData.rootDir;

        // Determine dataDir based on service type and whether rootDir is provided
        if (serviceData.type === 'static' && serviceData.rootDir && !serviceData.files?.length) {
          // Static site with existing rootDir and no files to import - use original location
          dataDir = serviceData.rootDir;
          rootDir = serviceData.rootDir;
          // Ensure the directory exists
          if (!existsSync(dataDir)) {
            await mkdir(dataDir, { recursive: true });
          }
        } else {
          // Create a new data directory for this service
          const safeDir = toSafeDirectoryName(serviceData.name);
          dataDir = join(SERVICES_DATA_DIR, safeDir);
          await mkdir(dataDir, { recursive: true });

          // Import files if provided
          if (serviceData.files && serviceData.files.length > 0) {
            for (const file of serviceData.files) {
              const filePath = join(dataDir, file.path);
              const fileDir = filePath.substring(0, filePath.lastIndexOf('/'));
              await mkdir(fileDir, { recursive: true });
              await writeFile(filePath, file.content);
            }
          }

          // Set rootDir for static sites (when files are imported to dataDir)
          if (serviceData.type === 'static') {
            rootDir = dataDir;
          }
        }

        // Generate Caddy config. Exports created before wildcard routing
        // support have no pathPrefix — default to '/' to preserve behavior.
        const importPathPrefix = normalizePathPrefix(serviceData.pathPrefix);
        const configData = { ...serviceData, rootDir, pathPrefix: importPathPrefix };
        const caddyConfig = generateCaddyConfig(configData);
        const configPath = caddyFilePath(serviceData.domain);
        await writeCaddyConfig(configPath, caddyConfig);

        // Insert into database
        db.prepare(`
          INSERT INTO services (
            id, name, domain, path_prefix, type, target, port, root_dir, container_name,
            ssl_enabled, force_https, websocket_enabled, max_upload_size, data_dir, status
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')
        `).run(
          id, serviceData.name, serviceData.domain, importPathPrefix, serviceData.type,
          serviceData.target || null, serviceData.port || null,
          rootDir || null, serviceData.containerName || null,
          serviceData.sslEnabled ? 1 : 0, serviceData.forceHttps ? 1 : 0,
          serviceData.websocketEnabled ? 1 : 0, serviceData.maxUploadSize || '1G',
          dataDir
        );

        results.imported.push({ name: serviceData.name, id });
      } catch (err) {
        results.errors.push({ name: serviceData.name, error: err.message });
      }
    }

    // Reload Caddy
    await reloadCaddy().catch(() => {});

    logAudit(req.user.id, 'SERVICES_IMPORTED', 'system', null, results, req.ip);

    res.json({ success: true, results });
  } catch (error) {
    console.error('Error importing services:', error);
    res.status(500).json({ error: 'Failed to import services' });
  }
});

// Terminal/Command execution endpoint
const terminalSchema = z.object({
  command: z.string().min(1).max(10000),
  workingDir: z.string().optional(),
  timeout: z.number().min(1000).max(300000).optional().default(30000), // 30s default, 5min max
});

// Blocked commands for security
const BLOCKED_COMMANDS = [
  'rm -rf /',
  'mkfs',
  ':(){ :|:& };:',  // Fork bomb
  'dd if=/dev/zero of=/dev/',
  '> /dev/sda',
  'chmod -R 777 /',
];

function isCommandBlocked(command) {
  const normalizedCmd = command.toLowerCase().trim();
  return BLOCKED_COMMANDS.some(blocked =>
    normalizedCmd.includes(blocked.toLowerCase())
  );
}

// Execute command on host (Admin only)
servicesRouter.post('/terminal/execute', requireAdmin, async (req, res) => {
  try {
    let { command, workingDir, timeout } = terminalSchema.parse(req.body);

    // Check for blocked commands
    if (isCommandBlocked(command)) {
      return res.status(403).json({
        error: 'This command is blocked for security reasons',
        output: '',
        exitCode: 1,
      });
    }

    // Auto-replace 'docker compose' with the correct command (v1 or v2)
    if (command.includes('docker compose')) {
      const composeCmd = await getDockerComposeCmd();
      command = command.replace(/docker compose/g, composeCmd);
    }

    console.log(`Terminal execute: ${command}`);

    // Build the command with optional working directory
    let fullCommand = command;
    if (workingDir) {
      fullCommand = `cd ${JSON.stringify(workingDir)} && ${command}`;
    }

    // Execute on host
    const startTime = Date.now();
    try {
      const result = await execOnHost(fullCommand, { timeout });
      const duration = Date.now() - startTime;

      logAudit(req.user.id, 'TERMINAL_COMMAND', 'system', null, {
        command,
        workingDir,
        exitCode: 0,
        duration,
      }, req.ip);

      res.json({
        success: true,
        output: result.stdout + (result.stderr ? '\n' + result.stderr : ''),
        exitCode: 0,
        duration,
      });
    } catch (execError) {
      const duration = Date.now() - startTime;
      const output = (execError.stdout || '') + '\n' + (execError.stderr || execError.message || '');

      logAudit(req.user.id, 'TERMINAL_COMMAND', 'system', null, {
        command,
        workingDir,
        exitCode: execError.code || 1,
        duration,
        error: true,
      }, req.ip);

      res.json({
        success: false,
        output: output.trim(),
        exitCode: execError.code || 1,
        duration,
      });
    }
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: error.errors[0].message });
    }
    console.error('Terminal error:', error);
    res.status(500).json({ error: 'Failed to execute command: ' + error.message });
  }
});

// File write endpoint - bypasses terminal command size limits
const fileWriteSchema = z.object({
  filePath: z.string().min(1).max(4096),
  content: z.string().max(50 * 1024 * 1024), // 50MB max content
  createDirs: z.boolean().optional().default(true),
});

servicesRouter.post('/terminal/write-file', requireAdmin, async (req, res) => {
  try {
    const { filePath, content, createDirs } = fileWriteSchema.parse(req.body);

    // Security: resolve path and prevent writing to dangerous locations
    const resolvedPath = resolve(filePath);
    const dangerousPaths = ['/etc/passwd', '/etc/shadow', '/etc/sudoers', '/etc/sudoers.d'];
    const dangerousDirs = ['/proc', '/sys', '/dev'];
    const dangerousPatterns = ['.ssh/authorized_keys', '.ssh/id_'];
    if (
      dangerousPaths.some(p => resolvedPath === p) ||
      dangerousDirs.some(d => resolvedPath.startsWith(d + '/') || resolvedPath === d) ||
      dangerousPatterns.some(p => resolvedPath.includes(p))
    ) {
      return res.status(403).json({ error: 'Writing to this path is not allowed' });
    }

    // Create directory if needed
    if (createDirs) {
      const dirPath = filePath.substring(0, filePath.lastIndexOf('/'));
      if (dirPath) {
        if (isInDocker) {
          await execOnHost(`mkdir -p ${JSON.stringify(dirPath)}`);
        } else {
          await mkdir(dirPath, { recursive: true });
        }
      }
    }

    // Write file
    if (isInDocker) {
      // Use base64 to safely transfer content through nsenter
      const base64Content = Buffer.from(content).toString('base64');
      await execOnHost(`echo ${JSON.stringify(base64Content)} | base64 -d > ${JSON.stringify(filePath)}`, { timeout: 60000 });
    } else {
      await writeFile(filePath, content, 'utf8');
    }

    // Log the action
    logAudit(req.user.id, 'FILE_WRITE', 'system', null, {
      filePath,
      size: content.length,
    }, req.ip);

    res.json({
      success: true,
      message: `File written successfully: ${filePath}`,
      size: content.length,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: error.errors[0].message });
    }
    console.error('File write error:', error);
    res.status(500).json({ error: 'Failed to write file: ' + error.message });
  }
});

// Upload file to a directory (binary-safe via base64) - for terminal file browser
const terminalUploadSchema = z.object({
  directory: z.string().min(1).max(4096),
  filename: z.string().min(1).max(255),
  content: z.string().max(50 * 1024 * 1024), // 50MB max base64 content
  encoding: z.enum(['base64', 'text']).default('base64'),
});

servicesRouter.post('/terminal/upload-file', requireAdmin, async (req, res) => {
  try {
    const { directory, filename, content, encoding } = terminalUploadSchema.parse(req.body);

    // Validate filename - no path separators allowed
    if (filename.includes('/') || filename.includes('\\') || filename === '..' || filename === '.') {
      return res.status(400).json({ error: 'Invalid filename' });
    }

    const filePath = resolve(directory, filename);

    // Security: ensure resolved path stays within the target directory
    if (!filePath.startsWith(resolve(directory) + '/') && filePath !== resolve(directory)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Security: prevent writing to dangerous locations
    const dangerousDirs = ['/proc', '/sys', '/dev'];
    if (dangerousDirs.some(d => filePath.startsWith(d + '/') || filePath === d)) {
      return res.status(403).json({ error: 'Writing to this path is not allowed' });
    }

    // Ensure directory exists
    if (isInDocker) {
      await execOnHost(`mkdir -p ${JSON.stringify(directory)}`);
    } else {
      await mkdir(directory, { recursive: true });
    }

    // Write file
    const fileContent = encoding === 'base64' ? Buffer.from(content, 'base64') : content;

    if (isInDocker) {
      const base64Content = encoding === 'base64' ? content : Buffer.from(content).toString('base64');
      await execOnHost(`echo ${JSON.stringify(base64Content)} | base64 -d > ${JSON.stringify(filePath)}`, { timeout: 60000 });
    } else {
      await writeFile(filePath, fileContent);
    }

    logAudit(req.user.id, 'FILE_UPLOAD', 'system', null, {
      filePath,
      size: fileContent.length,
    }, req.ip);

    res.json({
      success: true,
      message: `File uploaded successfully: ${filename}`,
      filePath,
      size: fileContent.length,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: error.errors[0].message });
    }
    console.error('File upload error:', error);
    res.status(500).json({ error: 'Failed to upload file: ' + error.message });
  }
});

// Get system info
servicesRouter.get('/terminal/system-info', requireAdmin, async (req, res) => {
  try {
    const [hostname, uptime, memory, disk] = await Promise.all([
      execOnHost('hostname').then(r => r.stdout.trim()).catch(() => 'unknown'),
      execOnHost('uptime -p 2>/dev/null || uptime').then(r => r.stdout.trim()).catch(() => 'unknown'),
      execOnHost('free -h 2>/dev/null | head -2').then(r => r.stdout.trim()).catch(() => 'unknown'),
      execOnHost('df -h / 2>/dev/null | tail -1').then(r => r.stdout.trim()).catch(() => 'unknown'),
    ]);

    res.json({
      hostname,
      uptime,
      memory,
      disk,
      isDocker: isInDocker,
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to get system info' });
  }
});

// Docker management endpoints
servicesRouter.get('/docker/containers', async (req, res) => {
  try {
    const result = await execOnHost('docker ps -a --format "{{.ID}}\\t{{.Names}}\\t{{.Image}}\\t{{.Status}}\\t{{.Ports}}"');
    const containers = result.stdout.trim().split('\n').filter(Boolean).map(line => {
      const [id, name, image, status, ports] = line.split('\t');
      return { id, name, image, status, ports: ports || '' };
    });
    res.json({ containers });
  } catch (error) {
    res.status(500).json({ error: 'Failed to list containers', containers: [] });
  }
});

servicesRouter.post('/docker/container/:action', async (req, res) => {
  try {
    const { action } = req.params;
    const { containerId, containerName } = req.body;
    const target = containerId || containerName;

    if (!target) {
      return res.status(400).json({ error: 'Container ID or name required' });
    }

    // Validate container target (only alphanumeric, hyphens, underscores, dots, slashes)
    if (!/^[a-zA-Z0-9_.\-\/]+$/.test(target)) {
      return res.status(400).json({ error: 'Invalid container identifier' });
    }

    const validActions = ['start', 'stop', 'restart', 'pause', 'unpause'];
    if (!validActions.includes(action)) {
      return res.status(400).json({ error: 'Invalid action' });
    }

    const result = await execOnHost(`docker ${action} ${JSON.stringify(target)} 2>&1`);

    logAudit(req.user.id, 'DOCKER_ACTION', 'container', target, { action }, req.ip);

    res.json({
      success: true,
      message: `Container ${action} successful`,
      output: result.stdout.trim(),
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.stderr || error.message,
    });
  }
});

// Docker Compose operations
servicesRouter.post('/docker/compose', async (req, res) => {
  try {
    const { action, path, serviceName, options } = req.body;
    const validActions = ['up', 'down', 'restart', 'pull', 'logs', 'ps', 'stop', 'start', 'destroy'];

    if (!validActions.includes(action)) {
      return res.status(400).json({ error: 'Invalid action' });
    }

    if (!path) {
      return res.status(400).json({ error: 'Compose file path required' });
    }

    const composeCmd = await getDockerComposeCmd();
    let cmd = `${composeCmd} -f ${JSON.stringify(path)}`;

    switch (action) {
      case 'up':
      case 'start':
        cmd += ' up -d';
        break;
      case 'down':
        cmd += ' down';
        break;
      case 'stop':
        cmd += ' stop';
        break;
      case 'restart':
        cmd += ' restart';
        break;
      case 'pull':
        cmd += ' pull';
        break;
      case 'logs':
        cmd += ' logs --tail=100';
        break;
      case 'ps':
        cmd += ' ps';
        break;
      case 'destroy':
        // Destroy with optional volume/image/orphan removal
        cmd += ' down';
        if (options?.removeVolumes) cmd += ' -v';
        if (options?.removeImages) cmd += ' --rmi all';
        if (options?.removeOrphans) cmd += ' --remove-orphans';
        break;
    }

    if (serviceName && ['up', 'start', 'stop', 'restart', 'logs'].includes(action)) {
      cmd += ` ${serviceName}`;
    }

    cmd += ' 2>&1';

    const result = await execOnHost(cmd, { timeout: 120000 });

    logAudit(req.user.id, 'DOCKER_COMPOSE', 'compose', path, { action, serviceName, options }, req.ip);

    res.json({
      success: true,
      output: result.stdout + (result.stderr || ''),
    });
  } catch (error) {
    res.json({
      success: false,
      output: error.stdout + '\n' + (error.stderr || error.message),
    });
  }
});

// Docker Compose destroy with TOTP verification (for dangerous operations)
servicesRouter.post('/docker/compose/destroy', async (req, res) => {
  try {
    const { path, totpCode, options } = req.body;

    if (!path) {
      return res.status(400).json({ error: 'Compose file path required' });
    }

    if (!totpCode || totpCode.length !== 6) {
      return res.status(400).json({ error: 'TOTP code required for destroy operation' });
    }

    // Verify TOTP
    const db = getDb();
    const user = db.prepare('SELECT totp_secret FROM users WHERE id = ?').get(req.user.id);
    if (user && user.totp_secret) {
      const totp = new OTPAuth.TOTP({
        issuer: 'ProxyPilot',
        label: req.user.username,
        algorithm: 'SHA1',
        digits: 6,
        period: 30,
        secret: OTPAuth.Secret.fromBase32(user.totp_secret),
      });

      const delta = totp.validate({ token: totpCode, window: 1 });
      if (delta === null) {
        return res.status(401).json({ error: 'Invalid TOTP code' });
      }
    }

    // Check if compose file exists first
    try {
      await execOnHost(`test -f ${JSON.stringify(path)}`);
    } catch (e) {
      // File doesn't exist - try to stop containers by project name instead
      const projectName = path.split('/').slice(-2, -1)[0] || 'unknown';
      try {
        // Try to stop any containers with this project label
        const stopCmd = `docker ps -q --filter "label=com.docker.compose.project=${projectName}" | xargs -r docker stop 2>/dev/null || true`;
        await execOnHost(stopCmd);
        const rmCmd = `docker ps -aq --filter "label=com.docker.compose.project=${projectName}" | xargs -r docker rm -f 2>/dev/null || true`;
        await execOnHost(rmCmd);

        logAudit(req.user.id, 'DOCKER_COMPOSE_DESTROY', 'compose', path, { options, fallback: true }, req.ip);

        return res.json({
          success: true,
          output: `Compose file not found at ${path}. Stopped and removed containers with project "${projectName}" directly.`,
        });
      } catch (fallbackErr) {
        return res.json({
          success: false,
          output: `Compose file not found at ${path} and fallback cleanup failed: ${fallbackErr.message}`,
        });
      }
    }

    const composeCmd = await getDockerComposeCmd();
    let cmd = `${composeCmd} -f ${JSON.stringify(path)} down`;
    if (options?.removeVolumes) cmd += ' -v';
    if (options?.removeImages) cmd += ' --rmi all';
    if (options?.removeOrphans) cmd += ' --remove-orphans';
    cmd += ' 2>&1';

    const result = await execOnHost(cmd, { timeout: 120000 });

    // If prune requested, run docker system prune for this project
    let pruneOutput = '';
    if (options?.prune) {
      try {
        const pruneResult = await execOnHost('docker system prune -f 2>&1', { timeout: 60000 });
        pruneOutput = '\n--- Prune Output ---\n' + pruneResult.stdout;
      } catch (e) {
        pruneOutput = '\n--- Prune Failed ---\n' + e.message;
      }
    }

    logAudit(req.user.id, 'DOCKER_COMPOSE_DESTROY', 'compose', path, { options }, req.ip);

    res.json({
      success: true,
      output: result.stdout + (result.stderr || '') + pruneOutput,
    });
  } catch (error) {
    res.json({
      success: false,
      output: error.stdout + '\n' + (error.stderr || error.message),
    });
  }
});

// ==================== VOLUME MANAGEMENT ====================

// List Docker volumes
servicesRouter.get('/docker/volumes', async (req, res) => {
  try {
    const result = await execOnHost('docker volume ls --format "{{.Name}}\\t{{.Driver}}\\t{{.Mountpoint}}" 2>/dev/null');
    const volumes = result.stdout.trim().split('\n').filter(Boolean).map(line => {
      const [name, driver, mountpoint] = line.split('\t');
      return { name, driver, mountpoint };
    });

    // Get volume sizes
    for (const vol of volumes) {
      try {
        const sizeResult = await execOnHost(`docker run --rm -v ${vol.name}:/data alpine du -sh /data 2>/dev/null | cut -f1`);
        vol.size = sizeResult.stdout.trim() || 'Unknown';
      } catch (e) {
        vol.size = 'Unknown';
      }
    }

    res.json({ success: true, volumes });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Export a Docker volume to a tar.gz file
servicesRouter.post('/docker/volumes/export', async (req, res) => {
  try {
    const { volumeName } = req.body;

    if (!volumeName || !/^[a-zA-Z0-9_-]+$/.test(volumeName)) {
      return res.status(400).json({ error: 'Invalid volume name' });
    }

    const backupDir = '/data/volume-backups';
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupFile = `${volumeName}-${timestamp}.tar.gz`;
    const backupPath = `${backupDir}/${backupFile}`;

    // Create backup directory
    await execOnHost(`mkdir -p ${backupDir}`);

    // Export volume using ubuntu container
    const exportCmd = `docker run --rm -v ${volumeName}:/data -v ${backupDir}:/backup ubuntu tar -czf /backup/${backupFile} -C /data ./ 2>&1`;
    const result = await execOnHost(exportCmd, { timeout: 300000 }); // 5 min timeout

    logAudit(req.user.id, 'VOLUME_EXPORTED', 'volume', volumeName, { backupPath }, req.ip);

    res.json({
      success: true,
      message: `Volume "${volumeName}" exported successfully`,
      backupPath,
      backupFile,
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Import a Docker volume from a tar.gz file
servicesRouter.post('/docker/volumes/import', async (req, res) => {
  try {
    const { volumeName, backupFile } = req.body;

    if (!volumeName || !/^[a-zA-Z0-9_-]+$/.test(volumeName)) {
      return res.status(400).json({ error: 'Invalid volume name' });
    }

    if (!backupFile || !backupFile.endsWith('.tar.gz')) {
      return res.status(400).json({ error: 'Invalid backup file' });
    }

    const backupDir = '/data/volume-backups';
    const backupPath = `${backupDir}/${backupFile}`;

    // Check if backup file exists
    try {
      await execOnHost(`test -f ${backupPath}`);
    } catch (e) {
      return res.status(404).json({ error: 'Backup file not found' });
    }

    // Create the volume if it doesn't exist
    await execOnHost(`docker volume create ${volumeName} 2>/dev/null || true`);

    // Import volume using ubuntu container
    const importCmd = `docker run --rm -v ${volumeName}:/data -v ${backupDir}:/backup ubuntu tar -xzf /backup/${backupFile} -C /data 2>&1`;
    const result = await execOnHost(importCmd, { timeout: 300000 }); // 5 min timeout

    logAudit(req.user.id, 'VOLUME_IMPORTED', 'volume', volumeName, { backupPath }, req.ip);

    res.json({
      success: true,
      message: `Volume "${volumeName}" imported successfully from ${backupFile}`,
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// List available volume backups
servicesRouter.get('/docker/volumes/backups', async (req, res) => {
  try {
    const backupDir = '/data/volume-backups';
    await execOnHost(`mkdir -p ${backupDir}`);

    const result = await execOnHost(`ls -la ${backupDir}/*.tar.gz 2>/dev/null || echo ""`);
    const files = result.stdout.trim().split('\n').filter(Boolean).filter(l => !l.includes('total'));

    const backups = files.map(line => {
      const parts = line.split(/\s+/);
      const filename = parts[parts.length - 1].split('/').pop();
      const size = parts[4];
      const date = `${parts[5]} ${parts[6]} ${parts[7]}`;
      return { filename, size, date };
    });

    res.json({ success: true, backups });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get real-time system stats using Node.js os module - reliable inside containers
servicesRouter.get('/system/stats', async (req, res) => {
  try {
    // Use Node.js os module for reliable stats inside container
    const cpus = os.cpus();
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const loadAvg = os.loadavg();
    const uptimeSec = os.uptime();

    // Calculate CPU usage from all cores
    let totalIdle = 0;
    let totalTick = 0;
    for (const cpu of cpus) {
      for (const type in cpu.times) {
        totalTick += cpu.times[type];
      }
      totalIdle += cpu.times.idle;
    }
    const cpuUsage = totalTick > 0 ? ((totalTick - totalIdle) / totalTick) * 100 : 0;

    // Memory stats
    const memUsed = totalMem - freeMem;

    // Try to get disk stats (may fail in some container environments)
    let diskTotal = 0;
    let diskUsed = 0;
    let diskFree = 0;
    try {
      const diskResult = await execAsync("df -B1 / 2>/dev/null | awk 'NR==2 {print $2, $3, $4}'");
      const diskParts = diskResult.stdout.trim().split(/\s+/);
      diskTotal = parseInt(diskParts[0]) || 0;
      diskUsed = parseInt(diskParts[1]) || 0;
      diskFree = parseInt(diskParts[2]) || 0;
    } catch (e) {
      // Disk stats unavailable
    }

    const stats = {
      cpu: {
        usage: parseFloat(cpuUsage.toFixed(1)),
        cores: cpus.length,
      },
      memory: {
        total: totalMem,
        used: memUsed,
        free: freeMem,
        available: freeMem,
        usagePercent: totalMem > 0 ? ((memUsed / totalMem) * 100).toFixed(1) : '0',
      },
      disk: {
        total: diskTotal,
        used: diskUsed,
        free: diskFree,
        usagePercent: diskTotal > 0 ? ((diskUsed / diskTotal) * 100).toFixed(1) : '0',
      },
      load: {
        avg1: loadAvg[0],
        avg5: loadAvg[1],
        avg15: loadAvg[2],
      },
      uptime: uptimeSec,
    };

    res.json(stats);
  } catch (error) {
    console.error('Error getting system stats:', error);
    res.status(500).json({ error: 'Failed to get system stats' });
  }
});

// Kill switch - secure the ProxyPilot dashboard (requires TOTP)
servicesRouter.post('/system/secure', async (req, res) => {
  try {
    const { totpCode } = deleteServiceSchema.parse(req.body);
    const db = getDb();

    // Verify TOTP
    const user = db.prepare('SELECT totp_secret FROM users WHERE id = ?').get(req.user.id);
    if (user && user.totp_secret) {
      const totp = new OTPAuth.TOTP({
        issuer: 'ProxyPilot',
        label: req.user.username,
        algorithm: 'SHA1',
        digits: 6,
        period: 30,
        secret: OTPAuth.Secret.fromBase32(user.totp_secret),
      });

      const delta = totp.validate({ token: totpCode, window: 1 });
      if (delta === null) {
        return res.status(401).json({ error: 'Invalid TOTP code' });
      }
    }

    logAudit(req.user.id, 'SYSTEM_SECURED', 'system', null, { action: 'kill_switch' }, req.ip);

    // Send response before stopping (container will stop shortly)
    res.json({
      success: true,
      message: 'ProxyPilot is being secured. The dashboard will become unavailable.',
    });

    // Give time for response to be sent, then stop the container
    setTimeout(async () => {
      try {
        // Stop the proxypilot-admin container
        await execOnHost('docker stop proxypilot-admin 2>&1 || true');
      } catch (e) {
        console.error('Error stopping container:', e);
      }
    }, 500);

  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: error.errors[0].message });
    }
    console.error('Error securing system:', error);
    res.status(500).json({ error: 'Failed to secure system' });
  }
});

// ==================== DISCOVER EXISTING SITES ====================

// Discover existing Caddy sites from sites directory
servicesRouter.get('/discover/caddy-sites', async (req, res) => {
  try {
    const db = getDb();
    const existingDomains = db.prepare('SELECT domain FROM services').all().map(s => s.domain);

    const discoveredSites = [];

    const sitesDir = CADDY_SITES_DIR;

    // Get list of files in Caddy sites directory
    let files = [];
    try {
      if (isInDocker) {
        const result = await execOnHost(`ls -1 ${JSON.stringify(sitesDir)} 2>/dev/null || echo ""`);
        files = result.stdout.trim().split('\n').filter(Boolean);
      } else if (existsSync(sitesDir)) {
        files = await readdir(sitesDir);
      }
    } catch (e) {
      console.log('Could not read Caddy sites directory:', e.message);
    }

    console.log(`Caddy discovery found ${files.length} files in ${sitesDir}`);

    for (const file of files) {
      if (file === '.' || file === '..') continue;

      try {
        // Read config content
        let content = '';
        if (isInDocker) {
          const result = await execOnHost(`cat ${JSON.stringify(join(sitesDir, file))} 2>/dev/null || echo ""`);
          content = result.stdout;
        } else {
          const configPath = join(sitesDir, file);
          const stats = await stat(configPath);
          if (!stats.isFile()) continue;
          content = await readFile(configPath, 'utf-8');
        }

        if (!content.trim()) continue;

        // Extract domain from Caddyfile site block (first non-comment line with domain)
        const domainMatch = content.match(/^(?:https?:\/\/)?([a-zA-Z0-9][a-zA-Z0-9.-]*[a-zA-Z0-9])\s*\{/m);
        const domain = domainMatch ? domainMatch[1] : file;

        // Skip if already in database
        if (existingDomains.includes(domain)) continue;

        // Determine type based on config content
        let type = 'static';
        let rootDir = null;
        let port = null;
        let target = null;

        // Check for reverse_proxy (indicates docker/proxy type)
        const proxyMatch = content.match(/reverse_proxy\s+(?:https?:\/\/)?([^:\s\/]+):?(\d+)?/);
        if (proxyMatch) {
          type = 'docker';
          target = proxyMatch[1] || '127.0.0.1';
          port = proxyMatch[2] ? parseInt(proxyMatch[2], 10) : 80;
        }

        // Check for root directive (static site)
        const rootMatch = content.match(/root\s+\*?\s*([^\n]+)/);
        if (rootMatch && type === 'static') {
          rootDir = rootMatch[1].trim();
        }

        // Check for SSL (Caddy enables TLS by default unless http:// prefix is used)
        const sslEnabled = !content.includes('http://');

        // WebSocket support is automatic in Caddy
        const websocketEnabled = false;

        // Try to find index.html for static sites
        let hasIndexHtml = false;
        if (rootDir) {
          try {
            if (isInDocker) {
              const indexResult = await execOnHost(`test -f ${JSON.stringify(join(rootDir, 'index.html'))} && echo "exists" || echo ""`);
              hasIndexHtml = indexResult.stdout.trim() === 'exists';
            } else if (existsSync(rootDir)) {
              hasIndexHtml = existsSync(join(rootDir, 'index.html'));
            }
          } catch (e) {
            // Ignore
          }
        }

        discoveredSites.push({
          domain,
          name: domain.split('.')[0],
          type,
          rootDir,
          target,
          port,
          sslEnabled,
          websocketEnabled,
          hasIndexHtml,
          configFile: file,
        });
      } catch (e) {
        console.log(`Could not parse ${file}:`, e.message);
      }
    }

    console.log(`Returning ${discoveredSites.length} discovered Caddy sites`);
    res.json({ sites: discoveredSites });
  } catch (error) {
    console.error('Error discovering sites:', error);
    res.status(500).json({ error: 'Failed to discover sites: ' + error.message });
  }
});

// Import a discovered site
servicesRouter.post('/discover/import', async (req, res) => {
  try {
    const { domain, name, type, rootDir, target, port, sslEnabled, websocketEnabled } = req.body;

    if (!domain || !name) {
      return res.status(400).json({ error: 'Domain and name are required' });
    }

    const db = getDb();

    // Check if already exists
    const existing = db.prepare('SELECT id FROM services WHERE domain = ?').get(domain);
    if (existing) {
      return res.status(400).json({ error: 'Service with this domain already exists' });
    }

    const id = uuidv4();
    let dataDir;
    let actualRootDir = rootDir;

    // For static sites with existing rootDir, use the original path directly
    // This allows file editing and terminal to work with the original location
    if (type === 'static' && rootDir) {
      // Use the original rootDir as both root_dir and data_dir
      dataDir = rootDir;
      actualRootDir = rootDir;

      // Ensure the directory exists
      if (!existsSync(rootDir)) {
        await mkdir(rootDir, { recursive: true });
      }
    } else if (type === 'static') {
      // New static site without existing rootDir - create in default location
      const safeDir = toSafeDirectoryName(name);
      dataDir = join(SERVICES_DATA_DIR, safeDir);
      actualRootDir = dataDir;
      await mkdir(dataDir, { recursive: true });
    } else if (type === 'docker') {
      // For docker services, create a data directory for compose files etc.
      const safeDir = toSafeDirectoryName(name);
      dataDir = join(SERVICES_DATA_DIR, safeDir);
      await mkdir(dataDir, { recursive: true });
    } else {
      // Proxy or other types
      const safeDir = toSafeDirectoryName(name);
      dataDir = join(SERVICES_DATA_DIR, safeDir);
    }

    // Insert into database - for imported static sites, data_dir = root_dir (the original path).
    // Discovered sites always land on path_prefix '/' — if the original Caddyfile
    // used handle_path, the operator can refine it after import.
    db.prepare(`
      INSERT INTO services (
        id, name, domain, path_prefix, type, target, port, root_dir, container_name,
        ssl_enabled, force_https, websocket_enabled, max_upload_size, data_dir, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')
    `).run(
      id, name, domain, '/', type, target || null, port || null,
      actualRootDir, null, sslEnabled ? 1 : 0, sslEnabled ? 1 : 0,
      websocketEnabled ? 1 : 0, '1G', dataDir
    );

    // Generate Caddy config for the imported site
    try {
      const serviceConfig = {
        domain,
        type,
        target: target || '127.0.0.1',
        port: port || null,
        rootDir: actualRootDir,
        websocketEnabled: !!websocketEnabled,
        forceHttps: !!sslEnabled,
        maxUploadSize: '1G',
        sslEnabled: !!sslEnabled,
      };

      await ensureCaddyStructure();
      const caddyConfig = generateCaddyConfig(serviceConfig);
      const configPath = caddyFilePath(domain);
      await writeCaddyConfig(configPath, caddyConfig);

      // Validate and reload Caddy
      await execOnHost(`caddy adapt --config ${CADDY_CONFIG_FILE} > /dev/null 2>&1`);
      await reloadCaddy();
    } catch (caddyError) {
      console.error('Error generating Caddy config for imported site:', caddyError);
      // Don't fail the import, but log the error
    }

    logAudit(req.user.id, 'SERVICE_IMPORTED', 'service', id, { domain, type, rootDir: actualRootDir }, req.ip);

    res.json({
      success: true,
      service: { id, name, domain, type, rootDir: actualRootDir, dataDir },
    });
  } catch (error) {
    console.error('Error importing site:', error);
    res.status(500).json({ error: 'Failed to import site: ' + error.message });
  }
});

// ==================== DOCKER COMPOSE SERVICES ====================

// Discover docker compose projects and their services
servicesRouter.get('/discover/docker-compose', async (req, res) => {
  try {
    // Get all running containers with their compose project info
    const result = await execOnHost(`docker ps -a --format '{{.ID}}\\t{{.Names}}\\t{{.Image}}\\t{{.Status}}\\t{{.Ports}}\\t{{.Labels}}' 2>/dev/null || echo ""`);

    const composeProjects = {};
    const lines = result.stdout.trim().split('\n').filter(Boolean);

    for (const line of lines) {
      const [id, name, image, status, ports, labels] = line.split('\t');

      // Parse labels to find compose project
      const labelPairs = labels ? labels.split(',') : [];
      let projectName = null;
      let serviceName = null;
      let composeFile = null;

      for (const label of labelPairs) {
        if (label.startsWith('com.docker.compose.project=')) {
          projectName = label.split('=')[1];
        }
        if (label.startsWith('com.docker.compose.service=')) {
          serviceName = label.split('=')[1];
        }
        if (label.startsWith('com.docker.compose.project.config_files=')) {
          composeFile = label.split('=')[1];
        }
      }

      // Parse port mappings to get exposed port
      let exposedPort = null;
      if (ports) {
        const portMatch = ports.match(/:(\d+)->/);
        if (portMatch) {
          exposedPort = parseInt(portMatch[1], 10);
        }
      }

      // Skip proxypilot containers
      if (name && (name.includes('proxypilot') || name === 'proxypilot-admin')) continue;

      // Group by compose project, or use 'standalone' for non-compose containers
      const groupName = projectName || 'standalone';

      if (!composeProjects[groupName]) {
        composeProjects[groupName] = {
          projectName: groupName,
          composeFile,
          services: [],
        };
      }

      composeProjects[groupName].services.push({
        containerId: id,
        containerName: name,
        serviceName: serviceName || name,
        image,
        status,
        ports,
        exposedPort,
        isRunning: status.includes('Up'),
      });
    }

    res.json({ projects: Object.values(composeProjects) });
  } catch (error) {
    console.error('Error discovering docker compose:', error);
    res.status(500).json({ error: 'Failed to discover docker compose projects' });
  }
});

// Get all docker compose services (for display in services list)
servicesRouter.get('/docker-compose/services', async (req, res) => {
  try {
    // Get all containers (not just compose-labelled ones, in case labels are missing)
    const result = await execOnHost(`docker ps -a --format '{{.ID}}\\t{{.Names}}\\t{{.Image}}\\t{{.Status}}\\t{{.Ports}}\\t{{.Labels}}' 2>/dev/null || echo ""`);

    const services = [];
    const lines = result.stdout.trim().split('\n').filter(Boolean);

    console.log(`Docker compose discovery found ${lines.length} containers`);

    for (const line of lines) {
      const parts = line.split('\t');
      const [id, containerName, image, status, ports, labelsStr] = parts;

      // Skip proxypilot containers
      if (containerName && (containerName.includes('proxypilot') || containerName === 'proxypilot-admin')) continue;

      // Parse labels to find compose project info
      let projectName = null;
      let serviceName = null;

      if (labelsStr) {
        const labels = labelsStr.split(',');
        for (const label of labels) {
          const [key, value] = label.split('=');
          if (key === 'com.docker.compose.project') projectName = value;
          if (key === 'com.docker.compose.service') serviceName = value;
        }
      }

      // Parse port - handle various formats:
      // 0.0.0.0:7000->80/tcp, 127.0.0.1:7000->80/tcp, :::7000->80/tcp, 7000->80/tcp
      let exposedPort = null;
      let hostBinding = '0.0.0.0';
      if (ports) {
        // Match patterns like: 0.0.0.0:7000->80, 127.0.0.1:7000->80, :::7000->80, 7000->80
        const portMatches = ports.matchAll(/(?:(\d+\.\d+\.\d+\.\d+|:::?):)?(\d+)->(\d+)(?:\/\w+)?/g);
        for (const match of portMatches) {
          if (match[1]) hostBinding = match[1];
          exposedPort = parseInt(match[2], 10);
          break; // Take the first port mapping
        }
      }

      // Include all containers except proxypilot's own
      services.push({
        id,
        containerName,
        serviceName: serviceName || containerName,
        projectName: projectName || 'standalone',
        image,
        status,
        ports,
        exposedPort,
        hostBinding,
        isRunning: status && status.includes('Up'),
        type: projectName ? 'docker-compose' : 'docker',
      });
    }

    console.log(`Returning ${services.length} docker compose services`);
    res.json({ services });
  } catch (error) {
    console.error('Error getting docker compose services:', error);
    res.status(500).json({ error: 'Failed to get docker compose services: ' + error.message, services: [] });
  }
});

// Check if SSL certificate exists for a domain
// Convert upload size string to Caddy format (e.g. "1G" -> "1GB", "100M" -> "100MB")
function toCaddySize(size) {
  if (!size) return '1GB';
  return size.toUpperCase().replace(/^(\d+)G$/i, '$1GB').replace(/^(\d+)M$/i, '$1MB');
}

// Emit the per-service handler body (the `reverse_proxy` / `root` + `file_server`
// lines) without any wrapping site block, `handle_path`, or `handle`. The caller
// decides how to wrap these lines — single-service configs emit them bare inside
// the site block, multi-service (merged) configs wrap each service's body in its
// own `handle_path ${prefix}*` or `handle` block.
//
// `indent` controls the leading whitespace so the caller can nest the body at the
// appropriate depth (e.g. '    ' for site-level, '        ' for inside a handle).
function generateServiceHandlerBody(service, indent = '    ') {
  const { type, target, port, rootDir } = service;

  // Convert container path to host path for Caddy. If rootDir starts with
  // SERVICES_DATA_DIR, rewrite to CADDY_STATIC_ROOT (same translation the
  // single-service path has always done).
  let caddyRootDir = rootDir;
  if (rootDir && rootDir.startsWith(SERVICES_DATA_DIR)) {
    caddyRootDir = rootDir.replace(SERVICES_DATA_DIR, CADDY_STATIC_ROOT);
  }

  const lines = [];
  switch (type) {
    case 'docker':
    case 'proxy':
      // Caddy automatically handles Host, X-Real-IP, X-Forwarded-For,
      // X-Forwarded-Proto, and WebSocket upgrades.
      lines.push(`${indent}reverse_proxy ${target || '127.0.0.1'}:${port}`);
      break;

    case 'static':
      lines.push(`${indent}root * ${caddyRootDir}`);
      lines.push(`${indent}file_server`);
      lines.push(`${indent}try_files {path} {path}/ /index.html`);
      break;
  }
  return lines;
}

// Parse a max_upload_size string ("1G" / "500M") into an integer count of
// megabytes so we can take a max across all services on a domain. Returns 0
// for unknown formats so the comparison still works.
function parseUploadSizeMB(size) {
  if (!size) return 0;
  const m = String(size).trim().match(/^(\d+)([MG])$/i);
  if (!m) return 0;
  const n = parseInt(m[1], 10);
  if (isNaN(n)) return 0;
  return m[2].toUpperCase() === 'G' ? n * 1024 : n;
}

// Build the merged Caddy site config for every service on a single domain.
//
// `servicesList` must be the complete set of services that should live on
// the given domain *after* the pending mutation — the caller is responsible
// for adding/removing/replacing rows before handing them to this function.
// `domain` is the site address (may include a wildcard).
//
// Returns the full Caddy config string, or `null` when the services list is
// empty (caller should unlink the on-disk file in that case).
//
// Layout of the emitted config:
//   1. A single site block keyed on the domain.
//   2. Site-level `request_body max_size` taking the max of all services.
//   3. `handle_path ${prefix}*` blocks for prefixed services, emitted in
//      more-specific-first order (length DESC, tie-broken by lexical DESC).
//   4. A single bare handler body for the root-scoped (`/`) service, if any,
//      which Caddy treats as the fallthrough for requests that did not match
//      any handle_path block.
//   5. Site-level security headers and a single log file keyed on the domain.
//
// Per design decision, all services on a domain must share the same
// sslEnabled and forceHttps values — that's enforced upstream in the create
// and update endpoints. This function uses the first service's SSL flag to
// pick the site address (http:// fallback for wildcards or when SSL is off).
//
// Throws when two services in the list share the same normalized path_prefix
// — defense-in-depth against a UNIQUE-constraint bypass.
function buildDomainCaddyConfig(servicesList, domain) {
  if (!servicesList || servicesList.length === 0) return null;

  // Normalize each service into a consistent shape (handles DB rows that use
  // snake_case as well as JS objects that use camelCase).
  const normalized = servicesList.map((s) => ({
    type: s.type,
    target: s.target,
    port: s.port,
    rootDir: s.rootDir !== undefined ? s.rootDir : s.root_dir,
    maxUploadSize:
      s.maxUploadSize !== undefined ? s.maxUploadSize : s.max_upload_size,
    sslEnabled:
      s.sslEnabled !== undefined ? !!s.sslEnabled : !!s.ssl_enabled,
    pathPrefix: normalizePathPrefix(
      s.pathPrefix !== undefined ? s.pathPrefix : s.path_prefix
    ),
  }));

  // Defense-in-depth: reject duplicate tuples instead of silently emitting a
  // bad Caddyfile. The UNIQUE constraint on the DB is the primary defense;
  // this is a belt-and-braces check that also guards in-memory simulated
  // lists built by the create/update endpoints.
  const seen = new Set();
  for (const s of normalized) {
    if (seen.has(s.pathPrefix)) {
      throw new Error(
        `Duplicate (domain, path_prefix) tuple detected for ${domain} ${s.pathPrefix}`
      );
    }
    seen.add(s.pathPrefix);
  }

  // Sort more-specific paths first so Caddy's source-order matching routes
  // /api/v2/* to its own service before falling through to /api/*.
  normalized.sort((a, b) => {
    if (b.pathPrefix.length !== a.pathPrefix.length) {
      return b.pathPrefix.length - a.pathPrefix.length;
    }
    return b.pathPrefix.localeCompare(a.pathPrefix);
  });

  const prefixedServices = normalized.filter((s) => s.pathPrefix !== '/');
  const rootService = normalized.find((s) => s.pathPrefix === '/') || null;

  // Site address + SSL decision. All services on a domain share the same SSL
  // stance (enforced upstream), so the first normalized row is authoritative.
  const isWildcardDomain =
    typeof domain === 'string' && domain.startsWith('*.');
  const siteSslEnabled = normalized[0].sslEnabled;
  const siteAddress =
    !siteSslEnabled || isWildcardDomain ? `http://${domain}` : domain;

  // Merged request_body max_size: take the max across every service on the
  // domain so the most-permissive service's upload cap is honored for every
  // matching route (the setting is site-level in Caddy, so the cap can't be
  // per-service).
  let maxSizeMB = 0;
  let maxSizeString = null;
  for (const s of normalized) {
    const mb = parseUploadSizeMB(s.maxUploadSize);
    if (mb > maxSizeMB) {
      maxSizeMB = mb;
      maxSizeString = s.maxUploadSize;
    }
  }

  const lines = [];
  lines.push(`# ProxyPilot Managed Configuration`);
  lines.push(`# Domain: ${domain}`);
  lines.push(
    `# Services: ${normalized
      .map((s) => `${s.pathPrefix} (${s.type})`)
      .join(', ')}`
  );
  lines.push(`# Generated: ${new Date().toISOString()}`);
  lines.push(``);
  lines.push(`${siteAddress} {`);

  if (maxSizeString) {
    lines.push(`    request_body {`);
    lines.push(`        max_size ${toCaddySize(maxSizeString)}`);
    lines.push(`    }`);
    lines.push(``);
  }

  // Emit each prefixed service in its own handle_path block. The * suffix on
  // handle_path matches any path that starts with the prefix and Caddy strips
  // the prefix before invoking the body.
  for (const s of prefixedServices) {
    lines.push(`    handle_path ${s.pathPrefix}* {`);
    lines.push(...generateServiceHandlerBody(s, '        '));
    lines.push(`    }`);
    lines.push(``);
  }

  // Root handler (if any). Wrap it in a handle block so it is an explicit
  // fallthrough rather than site-level bare statements mixed in with the
  // handle_path blocks — this keeps Caddy's matching deterministic when
  // multiple services coexist.
  if (rootService) {
    lines.push(`    handle {`);
    lines.push(...generateServiceHandlerBody(rootService, '        '));
    lines.push(`    }`);
    lines.push(``);
  }

  // Site-level security headers (apply to 404s too).
  lines.push(`    header {`);
  lines.push(`        X-Frame-Options "SAMEORIGIN"`);
  lines.push(`        X-Content-Type-Options "nosniff"`);
  lines.push(`        X-XSS-Protection "1; mode=block"`);
  lines.push(`        Referrer-Policy "strict-origin-when-cross-origin"`);
  lines.push(`    }`);
  lines.push(``);

  // Single log file keyed on the sanitized domain so wildcard * does not
  // leak into the filename.
  lines.push(`    log {`);
  lines.push(`        output file /var/log/caddy/${caddyFileName(domain)}.log`);
  lines.push(`    }`);

  lines.push(`}`);
  lines.push(``);

  return lines.join('\n');
}

// Read every service for a domain from the DB, build the merged Caddy site
// config, and write it to disk (or unlink the file when no services remain).
// Callers use this after they have already mutated the DB — the helper is a
// reconciliation step that makes the on-disk Caddy config match DB state.
//
// Admin services are skipped (their config is owned by the installer) so
// running this on the admin domain never clobbers the Caddyfile the operator
// maintains by hand.
async function regenerateDomainCaddyConfig(db, domain) {
  const rows = db
    .prepare(
      `SELECT id, name, domain, type, target, port, root_dir, container_name,
              ssl_enabled, force_https, websocket_enabled, max_upload_size,
              data_dir, is_admin, path_prefix
         FROM services
        WHERE domain = ? AND is_admin = 0`
    )
    .all(domain);

  const configPath = caddyFilePath(domain);

  // No managed services left on this domain — remove the merged file so
  // Caddy stops serving it. Swallow ENOENT; nothing to clean up is fine.
  if (!rows || rows.length === 0) {
    await unlink(configPath).catch(() => {});
    return;
  }

  const merged = buildDomainCaddyConfig(rows, domain);
  if (merged === null) {
    await unlink(configPath).catch(() => {});
    return;
  }

  await ensureCaddyStructure();
  await writeCaddyConfig(configPath, merged);
}

// Generate Caddy site config based on service type
function generateCaddyConfig(service) {
  const { domain, type, maxUploadSize, sslEnabled } = service;
  const pathPrefix = normalizePathPrefix(service.pathPrefix || service.path_prefix);
  const hasPathPrefix = pathPrefix !== '/';
  const isWildcardDomain = typeof domain === 'string' && domain.startsWith('*.');

  // Caddy auto-handles TLS when domain is used without http:// prefix.
  // Wildcard domains require a wildcard certificate, which Caddy can obtain
  // only via a DNS-01 challenge (needs a DNS provider plugin). Fall back to
  // http:// for wildcards so the admin can still serve traffic without TLS
  // until a DNS-01 solver is configured. The operator can enable TLS for
  // wildcards manually by editing the Caddyfile for that domain.
  let siteAddress;
  if (!sslEnabled || isWildcardDomain) {
    siteAddress = `http://${domain}`;
  } else {
    siteAddress = domain;
  }

  let lines = [];
  lines.push(`# ProxyPilot Managed Configuration`);
  lines.push(`# Domain: ${domain}`);
  lines.push(`# Path prefix: ${pathPrefix}`);
  lines.push(`# Type: ${type}`);
  lines.push(`# Generated: ${new Date().toISOString()}`);
  lines.push(``);
  lines.push(`${siteAddress} {`);

  // Request body size limit (site-level — applies to all matchers below)
  if (maxUploadSize) {
    lines.push(`    request_body {`);
    lines.push(`        max_size ${toCaddySize(maxUploadSize)}`);
    lines.push(`    }`);
    lines.push(``);
  }

  // When a path prefix is set, all of this service's handling is wrapped in
  // a `handle_path` block so Caddy strips the prefix before proxying. Any
  // request that does not match the prefix falls through to Caddy's default
  // 404 — the operator can add more services on the same domain later.
  if (hasPathPrefix) {
    lines.push(`    handle_path ${pathPrefix}* {`);
    lines.push(...generateServiceHandlerBody(service, '        '));
    lines.push(`    }`);
  } else {
    lines.push(...generateServiceHandlerBody(service, '    '));
  }

  // Security headers (site-level so they apply even on 404s)
  lines.push(``);
  lines.push(`    header {`);
  lines.push(`        X-Frame-Options "SAMEORIGIN"`);
  lines.push(`        X-Content-Type-Options "nosniff"`);
  lines.push(`        X-XSS-Protection "1; mode=block"`);
  lines.push(`        Referrer-Policy "strict-origin-when-cross-origin"`);
  lines.push(`    }`);

  // Logging — sanitize the domain so wildcard `*` does not leak into the
  // log filename. Uses the same sanitizer as the Caddy site config filename.
  lines.push(``);
  lines.push(`    log {`);
  lines.push(`        output file /var/log/caddy/${caddyFileName(domain)}.log`);
  lines.push(`    }`);

  lines.push(`}`);
  lines.push(``);

  return lines.join('\n');
}

// Named exports for the Phase 2 Caddy helpers. These are kept internal to
// this module at the call-site level but exported so integration tests and
// the Phase 2 verification pass can invoke them directly without spinning
// up the full HTTP router.
export { buildDomainCaddyConfig, regenerateDomainCaddyConfig, generateServiceHandlerBody };
