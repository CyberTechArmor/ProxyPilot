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

// Validation schemas
const createServiceSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  domain: z.string().regex(/^[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?$/, 'Invalid domain'),
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
    const testResult = await execOnHost(`caddy validate --config ${CADDY_CONFIG_FILE} 2>&1`);
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

    // Regenerate Caddy config with SSL enabled
    const serviceConfig = {
      domain: service.domain,
      type: service.type,
      target: service.target,
      port: service.port,
      rootDir: service.root_dir,
      websocketEnabled: !!service.websocket_enabled,
      forceHttps: true,
      maxUploadSize: service.max_upload_size,
      sslEnabled: true,
    };

    const caddyConfig = generateCaddyConfig(serviceConfig);
    const configPath = `${CADDY_SITES_DIR}/${service.domain}`;
    await writeCaddyConfig(configPath, caddyConfig);

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

    // Regenerate Caddy config without HTTPS
    const serviceConfig = {
      domain: service.domain,
      type: service.type,
      target: service.target,
      port: service.port,
      rootDir: service.root_dir,
      websocketEnabled: !!service.websocket_enabled,
      forceHttps: false,
      maxUploadSize: service.max_upload_size,
      sslEnabled: false,
    };

    const caddyConfig = generateCaddyConfig(serviceConfig);
    const configPath = `${CADDY_SITES_DIR}/${service.domain}`;
    await writeCaddyConfig(configPath, caddyConfig);

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

    // Build service config object
    const serviceConfig = {
      domain: service.domain,
      type: service.type,
      target: service.target,
      port: service.port,
      rootDir: service.root_dir,
      websocketEnabled: !!service.websocket_enabled,
      forceHttps: !!service.force_https,
      maxUploadSize: service.max_upload_size,
      sslEnabled: !!service.ssl_enabled,
    };

    // Generate and write new Caddy config
    const caddyConfig = generateCaddyConfig(serviceConfig);
    const configPath = `${CADDY_SITES_DIR}/${service.domain}`;
    await writeCaddyConfig(configPath, caddyConfig);

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
        const configPath = `${CADDY_SITES_DIR}/${service.domain}`;

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
      await execOnHost(`caddy validate --config ${CADDY_CONFIG_FILE} 2>&1`);
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
      SELECT id, name, domain, type, target, port, root_dir as rootDir,
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
      SELECT id, name, domain, type, target, port, root_dir as rootDir,
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
    const configPath = `${CADDY_SITES_DIR}/${data.domain}`;
    await writeCaddyConfig(configPath, caddyConfig);

    // Validate Caddy config
    try {
      await execOnHost(`caddy validate --config ${CADDY_CONFIG_FILE} 2>&1`);
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
        id, name, domain, type, target, port, root_dir, container_name,
        ssl_enabled, force_https, websocket_enabled, max_upload_size, data_dir, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')
    `).run(
      id, data.name, data.domain, data.type, data.target || null,
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
      await unlink(`${CADDY_SITES_DIR}/${service.domain}`).catch(() => {});
    }

    // Backup existing Caddy config before changes
    const configPath = `${CADDY_SITES_DIR}/${updatedData.domain}`;
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
      await execOnHost(`caddy validate --config ${CADDY_CONFIG_FILE} 2>&1`);
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
        name = ?, domain = ?, type = ?, target = ?, port = ?,
        root_dir = ?, data_dir = ?, container_name = ?, ssl_enabled = ?,
        force_https = ?, websocket_enabled = ?, max_upload_size = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      updatedData.name, updatedData.domain, updatedData.type,
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
    const configPath = `${CADDY_SITES_DIR}/${config.domain}`;
    await writeCaddyConfig(configPath, caddyConfig);

    // Validate and reload Caddy
    await execOnHost(`caddy validate --config ${CADDY_CONFIG_FILE} 2>&1`);
    await reloadCaddy();

    // Update database
    db.prepare(`
      UPDATE services SET
        name = ?, domain = ?, type = ?, target = ?, port = ?,
        root_dir = ?, container_name = ?, ssl_enabled = ?,
        force_https = ?, websocket_enabled = ?, max_upload_size = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      config.name, config.domain, config.type,
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

    const configPath = `${CADDY_SITES_DIR}/${service.domain}`;

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

    const configPath = `${CADDY_SITES_DIR}/${service.domain}`;

    // Read and backup current config
    let backupConfig = null;
    if (existsSync(configPath)) {
      backupConfig = await readFile(configPath, 'utf-8');
    }

    // Write new config
    await writeCaddyConfig(configPath, config);

    // Validate Caddy config
    try {
      await execOnHost(`caddy validate --config ${CADDY_CONFIG_FILE} 2>&1`);
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
      await unlink(`${CADDY_SITES_DIR}/${service.domain}`).catch(() => {});
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
          await unlink(`${CADDY_SITES_DIR}/${serviceData.domain}`).catch(() => {});
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

        // Generate Caddy config
        const configData = { ...serviceData, rootDir };
        const caddyConfig = generateCaddyConfig(configData);
        const configPath = `${CADDY_SITES_DIR}/${serviceData.domain}`;
        await writeCaddyConfig(configPath, caddyConfig);

        // Insert into database
        db.prepare(`
          INSERT INTO services (
            id, name, domain, type, target, port, root_dir, container_name,
            ssl_enabled, force_https, websocket_enabled, max_upload_size, data_dir, status
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')
        `).run(
          id, serviceData.name, serviceData.domain, serviceData.type,
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

    // Insert into database - for imported static sites, data_dir = root_dir (the original path)
    db.prepare(`
      INSERT INTO services (
        id, name, domain, type, target, port, root_dir, container_name,
        ssl_enabled, force_https, websocket_enabled, max_upload_size, data_dir, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')
    `).run(
      id, name, domain, type, target || null, port || null,
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
      const configPath = `${CADDY_SITES_DIR}/${domain}`;
      await writeCaddyConfig(configPath, caddyConfig);

      // Validate and reload Caddy
      await execOnHost(`caddy validate --config ${CADDY_CONFIG_FILE} 2>&1`);
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

// Generate Caddy site config based on service type
function generateCaddyConfig(service) {
  const { domain, type, target, port, rootDir, websocketEnabled, forceHttps, maxUploadSize, sslEnabled } = service;

  // Convert container path to host path for Caddy
  // If rootDir starts with SERVICES_DATA_DIR, replace with CADDY_STATIC_ROOT
  let caddyRootDir = rootDir;
  if (rootDir && rootDir.startsWith(SERVICES_DATA_DIR)) {
    caddyRootDir = rootDir.replace(SERVICES_DATA_DIR, CADDY_STATIC_ROOT);
  }

  // Caddy auto-handles TLS when domain is used without http:// prefix
  // Use http:// prefix to disable automatic HTTPS
  const siteAddress = sslEnabled ? domain : `http://${domain}`;

  let lines = [];
  lines.push(`# ProxyPilot Managed Configuration`);
  lines.push(`# Domain: ${domain}`);
  lines.push(`# Type: ${type}`);
  lines.push(`# Generated: ${new Date().toISOString()}`);
  lines.push(``);
  lines.push(`${siteAddress} {`);

  // Request body size limit
  if (maxUploadSize) {
    lines.push(`    request_body {`);
    lines.push(`        max_size ${toCaddySize(maxUploadSize)}`);
    lines.push(`    }`);
    lines.push(``);
  }

  switch (type) {
    case 'docker':
    case 'proxy':
      // Caddy automatically handles Host, X-Real-IP, X-Forwarded-For, X-Forwarded-Proto, and WebSocket
      lines.push(`    reverse_proxy ${target || '127.0.0.1'}:${port}`);
      break;

    case 'static':
      lines.push(`    root * ${caddyRootDir}`);
      lines.push(`    file_server`);
      lines.push(`    try_files {path} {path}/ /index.html`);
      break;
  }

  // Security headers
  lines.push(``);
  lines.push(`    header {`);
  lines.push(`        X-Frame-Options "SAMEORIGIN"`);
  lines.push(`        X-Content-Type-Options "nosniff"`);
  lines.push(`        X-XSS-Protection "1; mode=block"`);
  lines.push(`        Referrer-Policy "strict-origin-when-cross-origin"`);
  lines.push(`    }`);

  // Logging
  lines.push(``);
  lines.push(`    log {`);
  lines.push(`        output file /var/log/caddy/${domain}.log`);
  lines.push(`    }`);

  lines.push(`}`);
  lines.push(``);

  return lines.join('\n');
}
