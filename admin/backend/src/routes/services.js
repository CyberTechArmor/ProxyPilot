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
//
// Phase 2b D.4: SSL flags now live on routes. This endpoint flips
// `ssl_enabled=1, force_https=1` on every child `service_http_routes` row
// owned by this service AND the legacy services columns in lockstep,
// collects every distinct domain across those routes (plus the legacy
// `services.domain` fallback for the dual-source transitional state),
// regenerates the merged Caddy config once per affected domain, and
// validates + reloads. Before the flip is committed to the DB, the handler
// calls `assertSiblingsMatchStance` per affected domain to catch any
// sibling route (not owned by this service) that would disagree with the
// target stance. On any downstream failure (config gen / adapt / reload),
// both tables AND every affected merged file are rolled back to the
// pre-POST state.
servicesRouter.post('/:id/obtain-certificate', async (req, res) => {
  try {
    const db = getDb();
    const serviceId = req.params.id;
    const service = db
      .prepare('SELECT * FROM services WHERE id = ?')
      .get(serviceId);

    if (!service) {
      return res.status(404).json({ error: 'Service not found' });
    }

    // Snapshot pre-flip state so the rollback closure can revert every
    // route row to its exact previous value.
    const preRoutes = db
      .prepare(
        `SELECT id, domain, ssl_enabled, force_https
           FROM service_http_routes WHERE service_id = ?`
      )
      .all(serviceId);

    // Phase 2b D.14: route rows are the sole source of truth for SSL
    // stance. Collect every affected domain from the routes table.
    const affectedDomains = new Set();
    for (const r of preRoutes) affectedDomains.add(r.domain);

    // (1) Validate SSL stance against EXTERNAL sibling routes on every
    // affected domain BEFORE any mutation. `assertSiblingsMatchStance`
    // excludes every row owned by this service across both sources so
    // the pre-flip state of our own routes does not false-conflict
    // against the target.
    for (const domain of affectedDomains) {
      try {
        assertSiblingsMatchStance(db, domain, serviceId, true, true);
      } catch (e) {
        if (e.code === 'ROUTE_SSL_CONFLICT') {
          return res.status(400).json({ error: e.message });
        }
        throw e;
      }
    }

    // (2) Flip every child route row. The legacy ssl_enabled / force_https
    // columns on services were dropped by D.14 — SSL stance lives only on
    // service_http_routes now. Bump services.updated_at so the row still
    // reflects the change in GET list / detail responses.
    db.prepare(
      `UPDATE services SET updated_at = CURRENT_TIMESTAMP WHERE id = ?`
    ).run(serviceId);
    db.prepare(
      `UPDATE service_http_routes SET ssl_enabled = 1, force_https = 1
         WHERE service_id = ?`
    ).run(serviceId);

    // (3) Backup the merged file for every affected domain so the rollback
    // closure can restore each one byte-for-byte.
    await ensureCaddyStructure();
    const backups = {}; // domain -> { existed, content, path }
    for (const domain of affectedDomains) {
      const configPath = caddyFilePath(domain);
      let content = null;
      let existed = false;
      if (existsSync(configPath)) {
        try {
          content = await readFile(configPath, 'utf-8');
          existed = true;
        } catch (e) {
          // Continue without a backup; rollback will unlink on failure.
        }
      }
      backups[domain] = { existed, content, path: configPath };
    }

    const rollback = async () => {
      for (const pr of preRoutes) {
        try {
          db.prepare(
            `UPDATE service_http_routes SET ssl_enabled = ?, force_https = ?
               WHERE id = ?`
          ).run(pr.ssl_enabled, pr.force_https, pr.id);
        } catch (e) {
          console.error('Rollback: failed to revert route row', e);
        }
      }
      for (const [domain, b] of Object.entries(backups)) {
        try {
          if (b.existed && b.content !== null) {
            await writeCaddyConfig(b.path, b.content);
          } else {
            await unlink(b.path).catch(() => {});
          }
        } catch (e) {
          console.error(
            `Rollback: failed to restore merged file for ${domain}`,
            e
          );
        }
      }
    };

    // (4) Regenerate the merged Caddy config for every affected domain.
    try {
      for (const domain of affectedDomains) {
        await regenerateDomainCaddyConfig(db, domain);
      }
    } catch (genErr) {
      await rollback();
      return res.status(400).json({
        error: 'Failed to generate merged Caddy config: ' + genErr.message,
      });
    }

    // (5) Validate via caddy adapt before reloading.
    try {
      await execOnHost(
        `caddy adapt --config ${CADDY_CONFIG_FILE} > /dev/null 2>&1`
      );
    } catch (testError) {
      await rollback();
      return res.status(400).json({
        error: 'Caddy config validation failed - reverted to previous config',
        details: testError.stderr || testError.message,
      });
    }

    // (6) Reload Caddy. It will pick up the new auto-TLS site addresses
    // and start obtaining certificates via ACME.
    const reloadResult = await reloadCaddy();
    if (!reloadResult.success) {
      await rollback();
      await reloadCaddy().catch(() => {});
      return res.status(400).json({
        error: 'Caddy reload failed - reverted to previous config',
        details: reloadResult.error,
      });
    }

    logAudit(
      req.user.id,
      'SSL_ENABLED',
      'service',
      serviceId,
      { service_id: serviceId, domains: [...affectedDomains] },
      req.ip
    );

    res.json({
      success: true,
      message: 'SSL enabled - Caddy will automatically obtain certificates',
      domains: [...affectedDomains],
      caddyReloaded: reloadResult.success,
      caddyError: reloadResult.error,
    });
  } catch (error) {
    console.error('Error enabling SSL:', error);
    res.status(500).json({ error: 'Failed to enable SSL: ' + error.message });
  }
});

// Disable SSL for a service (requires TOTP)
//
// Phase 2b D.5: mirror of D.4 — flips `ssl_enabled=0, force_https=0` on
// both the legacy `services` columns AND every child `service_http_routes`
// row owned by this service, in lockstep. Collects every affected domain
// from both sources, validates that no sibling route disagrees with the
// off stance via `assertSiblingsMatchStance` before any mutation,
// regenerates the merged Caddy config for every affected domain, and
// rolls back both tables + every affected merged file on any downstream
// failure. TOTP check remains as the destructive-action guard.
servicesRouter.delete('/:id/certificate', async (req, res) => {
  try {
    const { totpCode } = deleteServiceSchema.parse(req.body);
    const db = getDb();
    const serviceId = req.params.id;

    const service = db
      .prepare('SELECT * FROM services WHERE id = ?')
      .get(serviceId);
    if (!service) {
      return res.status(404).json({ error: 'Service not found' });
    }

    // Verify TOTP
    const user = db
      .prepare('SELECT totp_secret FROM users WHERE id = ?')
      .get(req.user.id);
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

    // Snapshot pre-flip state so rollback reverts row-by-row.
    const preRoutes = db
      .prepare(
        `SELECT id, domain, ssl_enabled, force_https
           FROM service_http_routes WHERE service_id = ?`
      )
      .all(serviceId);

    // Phase 2b D.14: SSL stance lives only on service_http_routes now.
    const affectedDomains = new Set();
    for (const r of preRoutes) affectedDomains.add(r.domain);

    // (1) Pre-mutation stance check: every external sibling must already
    // be (ssl=0, force=0) for the flip to be valid. `assertSiblingsMatchStance`
    // excludes every row owned by this service so the pre-flip state of our
    // own routes doesn't false-conflict against the target.
    for (const domain of affectedDomains) {
      try {
        assertSiblingsMatchStance(db, domain, serviceId, false, false);
      } catch (e) {
        if (e.code === 'ROUTE_SSL_CONFLICT') {
          return res.status(400).json({ error: e.message });
        }
        throw e;
      }
    }

    // (2) Flip every child route row. Services row keeps only its
    // updated_at bump.
    db.prepare(
      `UPDATE services SET updated_at = CURRENT_TIMESTAMP WHERE id = ?`
    ).run(serviceId);
    db.prepare(
      `UPDATE service_http_routes SET ssl_enabled = 0, force_https = 0
         WHERE service_id = ?`
    ).run(serviceId);

    // (3) Backup every affected merged file.
    await ensureCaddyStructure();
    const backups = {};
    for (const domain of affectedDomains) {
      const configPath = caddyFilePath(domain);
      let content = null;
      let existed = false;
      if (existsSync(configPath)) {
        try {
          content = await readFile(configPath, 'utf-8');
          existed = true;
        } catch (e) {
          // Continue without backup; rollback will unlink on failure.
        }
      }
      backups[domain] = { existed, content, path: configPath };
    }

    const rollback = async () => {
      for (const pr of preRoutes) {
        try {
          db.prepare(
            `UPDATE service_http_routes SET ssl_enabled = ?, force_https = ?
               WHERE id = ?`
          ).run(pr.ssl_enabled, pr.force_https, pr.id);
        } catch (e) {
          console.error('Rollback: failed to revert route row', e);
        }
      }
      for (const [domain, b] of Object.entries(backups)) {
        try {
          if (b.existed && b.content !== null) {
            await writeCaddyConfig(b.path, b.content);
          } else {
            await unlink(b.path).catch(() => {});
          }
        } catch (e) {
          console.error(
            `Rollback: failed to restore merged file for ${domain}`,
            e
          );
        }
      }
    };

    // (4) Regenerate every affected merged file.
    try {
      for (const domain of affectedDomains) {
        await regenerateDomainCaddyConfig(db, domain);
      }
    } catch (genErr) {
      await rollback();
      return res.status(400).json({
        error: 'Failed to generate merged Caddy config: ' + genErr.message,
      });
    }

    // (5) Validate via caddy adapt.
    try {
      await execOnHost(
        `caddy adapt --config ${CADDY_CONFIG_FILE} > /dev/null 2>&1`
      );
    } catch (testError) {
      await rollback();
      return res.status(400).json({
        error: 'Caddy config validation failed - reverted to previous config',
        details: testError.stderr || testError.message,
      });
    }

    // (6) Reload Caddy.
    const reloadResult = await reloadCaddy();
    if (!reloadResult.success) {
      await rollback();
      await reloadCaddy().catch(() => {});
      return res.status(400).json({
        error: 'Caddy reload failed - reverted to previous config',
        details: reloadResult.error,
      });
    }

    logAudit(
      req.user.id,
      'SSL_DISABLED',
      'service',
      serviceId,
      { service_id: serviceId, domains: [...affectedDomains] },
      req.ip
    );

    res.json({
      success: true,
      message: 'SSL disabled and Caddy reconfigured',
      domains: [...affectedDomains],
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
//
// Phase 2b D.14: reads from `service_http_routes` since `services.domain`
// and `services.ssl_enabled` are gone after the legacy column drop. Any
// route on the domain is considered authoritative — if one exists with
// ssl_enabled=1, the domain is SSL-enabled.
servicesRouter.get('/ssl-status/:domain', async (req, res) => {
  try {
    const domain = req.params.domain;
    const db = getDb();
    const route = db
      .prepare(
        `SELECT ssl_enabled FROM service_http_routes WHERE domain = ? LIMIT 1`
      )
      .get(domain);
    const caddyInstalled = await isCaddyInstalled();

    res.json({
      domain,
      certificateExists: !!route?.ssl_enabled,
      autoManaged: true,
      caddyInstalled,
      message: route?.ssl_enabled
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
// Regenerate Caddy config for a single service.
//
// Phase 2b D.6: a service with N routes can span up to N distinct domains,
// so the handler now collects `SELECT DISTINCT domain FROM service_http_routes
// WHERE service_id = ?` UNION'd with the legacy `services.domain` fallback
// (transitional dual-source state) and calls `regenerateDomainCaddyConfig`
// once per distinct domain. Caddy is reloaded exactly once at the end so
// N domain rewrites share a single reload.
servicesRouter.post('/:id/regenerate-config', async (req, res) => {
  try {
    const db = getDb();
    const serviceId = req.params.id;
    const service = db
      .prepare('SELECT * FROM services WHERE id = ?')
      .get(serviceId);

    if (!service) {
      return res.status(404).json({ error: 'Service not found' });
    }

    // Collect every distinct domain this service touches — routes side
    // + legacy fallback so both the pre-D.14 transitional state and any
    // post-D.14 state work without edits.
    const routeDomains = db
      .prepare(
        `SELECT DISTINCT domain FROM service_http_routes WHERE service_id = ?`
      )
      .all(serviceId)
      .map((r) => r.domain);
    const affectedDomains = new Set(routeDomains);
    if (service.domain) affectedDomains.add(service.domain);

    const regenerated = [];
    const failed = [];
    for (const domain of affectedDomains) {
      try {
        await regenerateDomainCaddyConfig(db, domain);
        regenerated.push(domain);
      } catch (genErr) {
        console.error(
          `Failed to regenerate merged config for ${domain}:`,
          genErr
        );
        failed.push({ domain, error: genErr.message });
      }
    }

    // Reload Caddy once at the end so N domain rewrites share a single
    // reload — keeps the stub-caddy integration tests deterministic too.
    const reloadResult = await reloadCaddy();

    logAudit(
      req.user.id,
      'CONFIG_REGENERATED',
      'service',
      serviceId,
      { service_id: serviceId, domains: regenerated },
      req.ip
    );

    // Phase 2b D.14: derive sslCertificateExists from the primary route
    // since services.ssl_enabled is gone.
    const primaryForSsl = db
      .prepare(
        `SELECT ssl_enabled FROM service_http_routes WHERE service_id = ? ORDER BY created_at ASC, id ASC LIMIT 1`
      )
      .get(serviceId);

    res.json({
      success: failed.length === 0,
      message:
        failed.length === 0
          ? reloadResult.success
            ? 'Configuration regenerated and Caddy reloaded'
            : 'Configuration regenerated but Caddy reload failed'
          : `Some domains failed to regenerate: ${failed.map((f) => f.domain).join(', ')}`,
      sslCertificateExists: !!primaryForSsl?.ssl_enabled,
      domains: regenerated,
      failed,
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

    // Phase 2b D.7: rebuild the unique-domain set from the JOIN of
    // service_http_routes to services (routes-side, the post-D.14 source
    // of truth) UNION'd with the legacy services.domain column (transitional
    // fallback). Admin service domains are skipped outright so the
    // installer-owned Caddyfile never gets clobbered. The legacy query is
    // wrapped in a try/catch so post-D.14 (legacy column dropped) the
    // helper collapses to a routes-only scan without further edits.
    const uniqueDomainsSet = new Set();
    try {
      const routeDomainRows = db
        .prepare(
          `SELECT DISTINCT r.domain AS domain
             FROM service_http_routes r
             INNER JOIN services s ON s.id = r.service_id
            WHERE s.is_admin = 0`
        )
        .all();
      for (const row of routeDomainRows) {
        if (row.domain) uniqueDomainsSet.add(row.domain);
      }
    } catch (e) {
      console.error('Failed to read routes-side domain set', e);
    }
    try {
      const legacyDomainRows = db
        .prepare(
          `SELECT DISTINCT domain
             FROM services
            WHERE is_admin = 0 AND domain IS NOT NULL`
        )
        .all();
      for (const row of legacyDomainRows) {
        if (row.domain) uniqueDomainsSet.add(row.domain);
      }
    } catch (e) {
      // Post-D.14 — legacy `domain` column dropped. Routes-side scan is
      // the only source now; nothing to merge.
    }
    const uniqueDomains = [...uniqueDomainsSet];

    // Admin domains are sourced from the legacy services row, which the
    // installer still populates via a fixed is_admin=1 entry. After D.14
    // this becomes routes-table-only too, but admin services never have
    // route rows so the legacy fallback is effectively required.
    const adminDomains = services
      .filter((s) => s.is_admin)
      .map((s) => s.domain)
      .filter(Boolean);
    for (const adminDomain of new Set(adminDomains)) {
      console.log(`Skipping admin domain: ${adminDomain}`);
      results.success.push(`${adminDomain} (skipped - admin)`);
    }

    for (const domain of uniqueDomains) {
      try {
        await regenerateDomainCaddyConfig(db, domain);
        results.success.push(domain);
      } catch (err) {
        console.error(`Failed to regenerate merged config for ${domain}:`, err);
        results.failed.push({ domain, error: err.message });
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
// Phase 2b D.12: the list endpoint now nests a `routes` array under each
// service. It also exposes the Phase 2b service-level fields (`kind`,
// `runtime`, `targetIp`, `lxcContainerName`) and retains the legacy
// top-level route-owned fields (`domain`, `pathPrefix`, `port`,
// `sslEnabled`, `forceHttps`, `websocketEnabled`, `maxUploadSize`) for
// backward compatibility with the pre-Section-H frontend. Pre-D.14 the
// legacy fields are read from the services row directly; post-D.14 they
// are synthesized from the primary route (earliest-created). Using
// `SELECT *` + optional-chaining lets a single code path handle both
// states without additional branching.
servicesRouter.get('/', (req, res) => {
  try {
    const db = getDb();

    // Phase 2b-safe fetch: SELECT * so dropped columns simply become
    // undefined on the row object post-D.14.
    const servicesRows = db
      .prepare(
        `SELECT * FROM services ORDER BY is_favorite DESC, created_at DESC`
      )
      .all();

    // Fetch all routes in one query and group by service_id. Order by
    // created_at so routes[0] is always the "primary" (earliest-created)
    // — this matches D.1's syncPrimaryRouteFromLegacy semantics.
    const allRoutes = db
      .prepare(
        `SELECT id, service_id, domain, path_prefix, target_port,
                websocket_enabled, ssl_enabled, force_https,
                max_upload_size, created_at
           FROM service_http_routes
          ORDER BY created_at ASC, id ASC`
      )
      .all();

    const routesByService = new Map();
    for (const r of allRoutes) {
      if (!routesByService.has(r.service_id)) {
        routesByService.set(r.service_id, []);
      }
      routesByService.get(r.service_id).push({
        id: r.id,
        serviceId: r.service_id,
        domain: r.domain,
        pathPrefix: r.path_prefix,
        targetPort: r.target_port,
        websocketEnabled: !!r.websocket_enabled,
        sslEnabled: !!r.ssl_enabled,
        forceHttps: !!r.force_https,
        maxUploadSize: r.max_upload_size,
        createdAt: r.created_at,
      });
    }

    const formattedServices = servicesRows.map((s) => {
      const routes = routesByService.get(s.id) || [];
      const primary = routes[0];

      // Legacy top-level fields: prefer the stored legacy columns when
      // present (pre-D.14), fall back to the primary route (post-D.14).
      // Fresh-install tables still have the legacy columns, so during
      // the D.4-D.13 transition both sources agree.
      const topDomain = s.domain ?? primary?.domain ?? null;
      const topPathPrefix = s.path_prefix ?? primary?.pathPrefix ?? '/';
      const topPort = s.port ?? primary?.targetPort ?? null;
      const topSsl = s.ssl_enabled ?? (primary ? (primary.sslEnabled ? 1 : 0) : 0);
      const topForce = s.force_https ?? (primary ? (primary.forceHttps ? 1 : 0) : 0);
      const topWs = s.websocket_enabled ?? (primary ? (primary.websocketEnabled ? 1 : 0) : 0);
      const topMax = s.max_upload_size ?? primary?.maxUploadSize ?? '1G';

      return {
        id: s.id,
        name: s.name,
        // Phase 2b service-level fields
        kind: s.kind,
        runtime: s.runtime,
        targetIp: s.target_ip ?? null,
        lxcContainerName: s.lxc_container_name ?? null,
        // Legacy service-level fields that are NOT route-owned
        type: s.type,
        target: s.target,
        rootDir: s.root_dir,
        containerName: s.container_name,
        dataDir: s.data_dir,
        status: s.status,
        isAdmin: !!s.is_admin,
        isFavorite: !!s.is_favorite,
        createdAt: s.created_at,
        updatedAt: s.updated_at,
        // Legacy top-level route-owned fields (backward compat — Section
        // H will update the frontend to read from the nested routes array)
        domain: topDomain,
        pathPrefix: topPathPrefix,
        port: topPort,
        sslEnabled: !!topSsl,
        forceHttps: !!topForce,
        websocketEnabled: !!topWs,
        maxUploadSize: topMax,
        sslCertificateExists: !!topSsl,
        // Phase 2b nested routes
        routes,
      };
    });

    res.json({ services: formattedServices });
  } catch (error) {
    console.error('Error fetching services:', error);
    res.status(500).json({ error: 'Failed to fetch services' });
  }
});

// Get single service
// Phase 2b D.13: same shape as D.12's list endpoint — the single service
// object carries a nested `routes` array in primary-first order, exposes
// Phase 2b service-level fields, and retains legacy top-level route-owned
// fields for backward compatibility with the pre-Section-H frontend.
servicesRouter.get('/:id', (req, res) => {
  try {
    const db = getDb();
    const s = db
      .prepare('SELECT * FROM services WHERE id = ?')
      .get(req.params.id);

    if (!s) {
      return res.status(404).json({ error: 'Service not found' });
    }

    const routeRows = db
      .prepare(
        `SELECT id, service_id, domain, path_prefix, target_port,
                websocket_enabled, ssl_enabled, force_https,
                max_upload_size, created_at
           FROM service_http_routes
          WHERE service_id = ?
          ORDER BY created_at ASC, id ASC`
      )
      .all(s.id);

    const routes = routeRows.map((r) => ({
      id: r.id,
      serviceId: r.service_id,
      domain: r.domain,
      pathPrefix: r.path_prefix,
      targetPort: r.target_port,
      websocketEnabled: !!r.websocket_enabled,
      sslEnabled: !!r.ssl_enabled,
      forceHttps: !!r.force_https,
      maxUploadSize: r.max_upload_size,
      createdAt: r.created_at,
    }));

    const primary = routes[0];
    const topDomain = s.domain ?? primary?.domain ?? null;
    const topPathPrefix = s.path_prefix ?? primary?.pathPrefix ?? '/';
    const topPort = s.port ?? primary?.targetPort ?? null;
    const topSsl = s.ssl_enabled ?? (primary ? (primary.sslEnabled ? 1 : 0) : 0);
    const topForce = s.force_https ?? (primary ? (primary.forceHttps ? 1 : 0) : 0);
    const topWs = s.websocket_enabled ?? (primary ? (primary.websocketEnabled ? 1 : 0) : 0);
    const topMax = s.max_upload_size ?? primary?.maxUploadSize ?? '1G';

    res.json({
      service: {
        id: s.id,
        name: s.name,
        kind: s.kind,
        runtime: s.runtime,
        targetIp: s.target_ip ?? null,
        lxcContainerName: s.lxc_container_name ?? null,
        type: s.type,
        target: s.target,
        rootDir: s.root_dir,
        containerName: s.container_name,
        dataDir: s.data_dir,
        status: s.status,
        isAdmin: !!s.is_admin,
        isFavorite: !!s.is_favorite,
        createdAt: s.created_at,
        updatedAt: s.updated_at,
        // Legacy top-level backcompat fields
        domain: topDomain,
        pathPrefix: topPathPrefix,
        port: topPort,
        sslEnabled: !!topSsl,
        forceHttps: !!topForce,
        websocketEnabled: !!topWs,
        maxUploadSize: topMax,
        sslCertificateExists: !!topSsl,
        // Phase 2b nested routes
        routes,
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

    // Phase 2b D.14: uniqueness and SSL stance checks read from
    // service_http_routes since the legacy services.(domain, path_prefix,
    // ssl flags) columns were dropped.
    const existingRoute = db
      .prepare(
        `SELECT id FROM service_http_routes WHERE domain = ? AND path_prefix = ?`
      )
      .get(data.domain, data.pathPrefix);
    if (existingRoute) {
      return res
        .status(400)
        .json({ error: 'Domain + path prefix combination already exists' });
    }

    // SSL stance consistency: every existing sibling route on the same
    // domain must agree with the candidate's sslEnabled + forceHttps.
    // Reuses the dual-source assertRoutesShareSslStance helper — post-D.14
    // its legacy-services branch returns empty via try/catch.
    try {
      assertRoutesShareSslStance(db, data.domain, {
        sslEnabled: data.sslEnabled,
        forceHttps: data.forceHttps,
      });
    } catch (e) {
      if (e.code === 'ROUTE_SSL_CONFLICT') {
        return res.status(400).json({ error: e.message });
      }
      throw e;
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

    // Phase 2: with merged per-domain configs, the new service must be in
    // the DB before we regenerate the merged file for the domain — otherwise
    // the file would be rewritten without the new row. Flow:
    //   1. Backup the current merged file for the domain (may not exist).
    //   2. Insert the row into the DB.
    //   3. Call regenerateDomainCaddyConfig to write the merged file.
    //   4. caddy adapt + reload; on any failure, roll back both the DB row
    //      and the on-disk file to the pre-create state.
    await ensureCaddyStructure();
    const configPath = caddyFilePath(data.domain);
    let backupMergedConfig = null;
    let backupExisted = false;
    try {
      if (existsSync(configPath)) {
        backupMergedConfig = await readFile(configPath, 'utf-8');
        backupExisted = true;
      }
    } catch (e) {
      // If reading the backup fails, continue without one — the rollback
      // will just unlink the file.
    }

    // Phase 2b D.14: Insert only the Phase 2b service-level columns — the
    // legacy route-owned columns (domain, path_prefix, port, ssl flags,
    // max_upload_size) were dropped. All route-owned values go into
    // service_http_routes via `syncPrimaryRouteFromLegacy` below.
    //
    // `kind` derives from `type`: static_site for static type, otherwise
    // container_service. `runtime` derives from type='docker' only; proxy
    // and static leave it NULL (operator can set runtime='lxc' later via
    // Section H's wizard).
    const inferredKind = data.type === 'static' ? 'static_site' : 'container_service';
    const inferredRuntime = data.type === 'docker' ? 'docker' : null;

    db.prepare(`
      INSERT INTO services (
        id, name, kind, runtime, type, target, target_ip,
        root_dir, container_name, data_dir, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')
    `).run(
      id, data.name, inferredKind, inferredRuntime, data.type,
      data.target || null,
      data.type !== 'static' ? (data.target || null) : null,
      data.rootDir || null, data.containerName || null, dataDir
    );

    // Phase 2b D.2: dual-write the primary route row so Section H's
    // routes-sourced UI sees every newly-created service immediately,
    // and D.14 can eventually drop the legacy columns without data loss.
    try {
      syncPrimaryRouteFromLegacy(db, id, {
        domain: data.domain,
        pathPrefix: data.pathPrefix,
        targetPort: data.port,
        sslEnabled: data.sslEnabled,
        forceHttps: data.forceHttps,
        websocketEnabled: data.websocketEnabled,
        maxUploadSize: data.maxUploadSize,
      });
    } catch (routeErr) {
      // If the dual-write fails, roll back the services insert and
      // abort the whole create — a half-committed state would be worse
      // than no service at all.
      db.prepare('DELETE FROM services WHERE id = ?').run(id);
      return res.status(400).json({
        error: 'Failed to create primary route: ' + routeErr.message,
      });
    }

    // Helper to undo the create on a downstream failure. Also deletes
    // any route rows owned by this service via the ON DELETE CASCADE FK.
    const rollbackCreate = async () => {
      try {
        db.prepare('DELETE FROM services WHERE id = ?').run(id);
      } catch (e) {
        console.error('Rollback: failed to delete service row', e);
      }
      try {
        if (backupExisted && backupMergedConfig !== null) {
          await writeCaddyConfig(configPath, backupMergedConfig);
        } else {
          await unlink(configPath).catch(() => {});
        }
      } catch (e) {
        console.error('Rollback: failed to restore Caddy config', e);
      }
    };

    // Write the merged Caddy config for the whole domain (now including the
    // newly inserted row).
    try {
      await regenerateDomainCaddyConfig(db, data.domain);
    } catch (genErr) {
      await rollbackCreate();
      return res.status(400).json({
        error: 'Failed to generate merged Caddy config: ' + genErr.message,
      });
    }

    // Validate Caddy config
    try {
      await execOnHost(`caddy adapt --config ${CADDY_CONFIG_FILE} > /dev/null 2>&1`);
    } catch (testErr) {
      await rollbackCreate();
      return res.status(400).json({ error: 'Invalid Caddy configuration generated: ' + (testErr.stderr || testErr.message) });
    }

    // Reload Caddy
    const caddyResult = await reloadCaddy();
    if (!caddyResult.success) {
      await rollbackCreate();
      // Best-effort reload to bring Caddy back to the pre-create state.
      await reloadCaddy().catch(() => {});
      return res.status(400).json({
        error: 'Caddy reload failed - create rolled back',
        details: caddyResult.error,
      });
    }

    // Phase 2b F.1: audit payload nests a snapshot of the service-level
    // fields AND the primary route that was just created via
    // syncPrimaryRouteFromLegacy. The legacy flat `data` object is kept
    // under `legacy` for backward compatibility with replay tools.
    const createdRoute = db
      .prepare(
        `SELECT id, domain, path_prefix, target_port
           FROM service_http_routes WHERE service_id = ? ORDER BY created_at ASC, id ASC LIMIT 1`
      )
      .get(id);
    logAudit(
      req.user.id,
      'SERVICE_CREATED',
      'service',
      id,
      {
        service: {
          id,
          name: data.name,
          kind: inferredKind,
          runtime: inferredRuntime,
          target_ip: data.type !== 'static' ? data.target || null : null,
          lxc_container_name: null,
        },
        routes: createdRoute
          ? [
              {
                id: createdRoute.id,
                domain: createdRoute.domain,
                pathPrefix: createdRoute.path_prefix,
                targetPort: createdRoute.target_port,
              },
            ]
          : [],
        legacy: data,
      },
      req.ip
    );

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

    // Phase 2b D.14: route-owned fields (domain, path_prefix, port, ssl
    // flags, max_upload_size) live only on service_http_routes now. The
    // "primary route" (earliest-created) is the source of truth for
    // pre-update values that the request didn't override.
    const primaryRoute = db
      .prepare(
        `SELECT id, domain, path_prefix, target_port, websocket_enabled,
                ssl_enabled, force_https, max_upload_size
           FROM service_http_routes
          WHERE service_id = ?
          ORDER BY created_at ASC, id ASC
          LIMIT 1`
      )
      .get(req.params.id);
    // If this services row has no route yet (edge case during mid-migration
    // or right after a failed create), fall back to empty defaults. The
    // subsequent syncPrimaryRouteFromLegacy call will insert a row.
    const preRoutePrefix = normalizePathPrefix(primaryRoute?.path_prefix);
    const preRouteDomain = primaryRoute?.domain || '';

    // Merge request data with the current primary route + services state.
    const updatedData = {
      name: data.name || service.name,
      domain: data.domain || preRouteDomain,
      pathPrefix: data.pathPrefix !== undefined ? normalizePathPrefix(data.pathPrefix) : preRoutePrefix,
      type: data.type || service.type,
      target: data.target !== undefined ? data.target : service.target,
      port: data.port !== undefined ? data.port : (primaryRoute?.target_port ?? null),
      rootDir: data.rootDir !== undefined ? data.rootDir : service.root_dir,
      dataDir: data.dataDir !== undefined ? data.dataDir : service.data_dir,
      containerName: data.containerName !== undefined ? data.containerName : service.container_name,
      sslEnabled: data.sslEnabled !== undefined ? data.sslEnabled : !!(primaryRoute?.ssl_enabled),
      forceHttps: data.forceHttps !== undefined ? data.forceHttps : !!(primaryRoute?.force_https),
      websocketEnabled: data.websocketEnabled !== undefined ? data.websocketEnabled : !!(primaryRoute?.websocket_enabled),
      maxUploadSize: data.maxUploadSize || primaryRoute?.max_upload_size || '1G',
    };

    // Phase 2b D.14: uniqueness check reads from service_http_routes. Only
    // re-check when the tuple actually changes, excluding the primary
    // route id so the check doesn't false-positive against itself.
    const domainChangedForCheck = updatedData.domain !== preRouteDomain;
    const prefixChangedForCheck = updatedData.pathPrefix !== preRoutePrefix;
    if (domainChangedForCheck || prefixChangedForCheck) {
      const existing = db
        .prepare(
          `SELECT id FROM service_http_routes
            WHERE domain = ? AND path_prefix = ? AND id != COALESCE(?, '')`
        )
        .get(updatedData.domain, updatedData.pathPrefix, primaryRoute?.id || null);
      if (existing) {
        return res.status(400).json({
          error: 'Domain + path prefix combination already exists',
        });
      }
    }

    // SSL stance check via the dual-source helper, excluding the primary
    // route id so an unchanged stance doesn't trigger a self-conflict.
    try {
      assertRoutesShareSslStance(
        db,
        updatedData.domain,
        {
          sslEnabled: updatedData.sslEnabled,
          forceHttps: updatedData.forceHttps,
        },
        primaryRoute?.id || null
      );
    } catch (e) {
      if (e.code === 'ROUTE_SSL_CONFLICT') {
        return res.status(400).json({ error: e.message });
      }
      throw e;
    }

    // Phase 2b D.14: route-owned state lives on service_http_routes. The
    // services UPDATE only touches service-level fields; route mutations
    // go through syncPrimaryRouteFromLegacy which rewrites the primary
    // route row. Caddy merge paths regenerate from DB state.
    await ensureCaddyStructure();
    const newConfigPath = caddyFilePath(updatedData.domain);
    const oldConfigPath = preRouteDomain ? caddyFilePath(preRouteDomain) : null;
    const domainChanged = data.domain && data.domain !== preRouteDomain;

    let backupNew = null;
    let backupNewExisted = false;
    try {
      if (existsSync(newConfigPath)) {
        backupNew = await readFile(newConfigPath, 'utf-8');
        backupNewExisted = true;
      }
    } catch (e) {
      // Continue without a backup — rollback will unlink instead.
    }

    let backupOld = null;
    let backupOldExisted = false;
    if (domainChanged && oldConfigPath) {
      try {
        if (existsSync(oldConfigPath)) {
          backupOld = await readFile(oldConfigPath, 'utf-8');
          backupOldExisted = true;
        }
      } catch (e) {
        // Continue without a backup.
      }
    }

    // Snapshot the current row + primary route for rollback.
    const preUpdateRow = { ...service };
    const preUpdateRoute = primaryRoute ? { ...primaryRoute } : null;

    // Phase 2b D.14: derive updated target_ip from the request's target
    // for non-static services. Static sites keep target_ip = NULL.
    const updatedTargetIp =
      updatedData.type === 'static' ? null : updatedData.target || null;

    // Update the services row — Phase 2b columns only. Route-owned
    // columns were dropped by D.14.
    db.prepare(`
      UPDATE services SET
        name = ?, type = ?, target = ?, target_ip = ?,
        root_dir = ?, data_dir = ?, container_name = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      updatedData.name, updatedData.type, updatedData.target, updatedTargetIp,
      updatedData.rootDir, updatedData.dataDir, updatedData.containerName,
      req.params.id
    );

    // Sync the primary route to the new (domain, pathPrefix, port, ssl…)
    // tuple. If the new tuple collides with another service's route, the
    // sync throws and we revert the services UPDATE.
    try {
      syncPrimaryRouteFromLegacy(db, req.params.id, {
        domain: updatedData.domain,
        pathPrefix: updatedData.pathPrefix,
        targetPort: updatedData.port,
        sslEnabled: updatedData.sslEnabled,
        forceHttps: updatedData.forceHttps,
        websocketEnabled: updatedData.websocketEnabled,
        maxUploadSize: updatedData.maxUploadSize,
      });
    } catch (routeErr) {
      db.prepare(`
        UPDATE services SET
          name = ?, type = ?, target = ?, target_ip = ?,
          root_dir = ?, data_dir = ?, container_name = ?,
          updated_at = ?
        WHERE id = ?
      `).run(
        preUpdateRow.name, preUpdateRow.type, preUpdateRow.target,
        preUpdateRow.target_ip, preUpdateRow.root_dir, preUpdateRow.data_dir,
        preUpdateRow.container_name, preUpdateRow.updated_at, req.params.id
      );
      return res
        .status(400)
        .json({ error: 'Failed to sync primary route: ' + routeErr.message });
    }

    const rollbackUpdate = async () => {
      try {
        db.prepare(`
          UPDATE services SET
            name = ?, type = ?, target = ?, target_ip = ?,
            root_dir = ?, data_dir = ?, container_name = ?,
            updated_at = ?
          WHERE id = ?
        `).run(
          preUpdateRow.name, preUpdateRow.type, preUpdateRow.target,
          preUpdateRow.target_ip, preUpdateRow.root_dir, preUpdateRow.data_dir,
          preUpdateRow.container_name, preUpdateRow.updated_at, req.params.id
        );
      } catch (e) {
        console.error('Rollback: failed to revert service row', e);
      }
      // Revert the primary route via the same helper so the routes table
      // stays consistent with the services row.
      if (preUpdateRoute) {
        try {
          syncPrimaryRouteFromLegacy(db, req.params.id, {
            domain: preUpdateRoute.domain,
            pathPrefix: preUpdateRoute.path_prefix,
            targetPort: preUpdateRoute.target_port,
            sslEnabled: !!preUpdateRoute.ssl_enabled,
            forceHttps: !!preUpdateRoute.force_https,
            websocketEnabled: !!preUpdateRoute.websocket_enabled,
            maxUploadSize: preUpdateRoute.max_upload_size,
          });
        } catch (e) {
          console.error('Rollback: failed to revert primary route', e);
        }
      }
      try {
        if (backupNewExisted && backupNew !== null) {
          await writeCaddyConfig(newConfigPath, backupNew);
        } else {
          await unlink(newConfigPath).catch(() => {});
        }
      } catch (e) {
        console.error('Rollback: failed to restore new-domain Caddy config', e);
      }
      if (domainChanged) {
        try {
          if (backupOldExisted && backupOld !== null) {
            await writeCaddyConfig(oldConfigPath, backupOld);
          } else {
            await unlink(oldConfigPath).catch(() => {});
          }
        } catch (e) {
          console.error('Rollback: failed to restore old-domain Caddy config', e);
        }
      }
    };

    // Regenerate merged configs. The new-domain config always needs a
    // rewrite; if the domain changed, the old-domain config also needs a
    // rewrite so it either shrinks (leaving remaining siblings) or unlinks
    // (if the moved service was the last one on the old domain).
    try {
      await regenerateDomainCaddyConfig(db, updatedData.domain);
      if (domainChanged && preRouteDomain) {
        await regenerateDomainCaddyConfig(db, preRouteDomain);
      }
    } catch (genErr) {
      await rollbackUpdate();
      return res.status(400).json({
        error: 'Failed to generate merged Caddy config: ' + genErr.message,
      });
    }

    // Validate Caddy config before reload
    try {
      await execOnHost(`caddy adapt --config ${CADDY_CONFIG_FILE} > /dev/null 2>&1`);
    } catch (testError) {
      await rollbackUpdate();
      return res.status(400).json({
        error: 'Caddy config validation failed - reverted to previous config',
        details: testError.stderr || testError.message,
      });
    }

    // Reload Caddy with failsafe
    try {
      await execOnHost(`caddy reload --config ${CADDY_CONFIG_FILE} --force 2>&1`);
    } catch (reloadError) {
      await rollbackUpdate();
      await execOnHost(`caddy reload --config ${CADDY_CONFIG_FILE} --force 2>&1`).catch(() => {});
      return res.status(400).json({
        error: 'Caddy reload failed - reverted to previous config',
        details: reloadError.stderr || reloadError.message,
      });
    }

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

    // Phase 2b F.1: audit payload nests the current service-level fields
    // AND every route the service touches (including the updated primary).
    // Legacy flat `updatedData` kept under `legacy` for backward compat.
    const updatedRoutes = db
      .prepare(
        `SELECT id, domain, path_prefix, target_port
           FROM service_http_routes WHERE service_id = ?
           ORDER BY created_at ASC, id ASC`
      )
      .all(req.params.id);
    logAudit(
      req.user.id,
      'SERVICE_UPDATED',
      'service',
      req.params.id,
      {
        service: {
          id: req.params.id,
          name: updatedData.name,
          kind: service.kind,
          runtime: service.runtime,
          target_ip: updatedTargetIp,
          lxc_container_name: service.lxc_container_name,
        },
        routes: updatedRoutes.map((r) => ({
          id: r.id,
          domain: r.domain,
          pathPrefix: r.path_prefix,
          targetPort: r.target_port,
        })),
        legacy: updatedData,
      },
      req.ip
    );

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
// Phase 2b D.8: revert a service to a saved config snapshot.
//
// The stored snapshot is still in the legacy flat shape (D.2/D.3 save the
// legacy fields into `service_config_versions.config_json`). The revert
// handler applies the legacy fields back to `services`, then calls
// `syncPrimaryRouteFromLegacy` so the primary route row mirrors the
// reverted state. If the reverted `(domain, pathPrefix)` collides with
// an existing row in either table, the services UPDATE is rolled back
// and the handler returns 400. If the domain changed, both the old and
// new domain's merged files are regenerated so the stale domain shrinks
// or unlinks and the reverted domain is rewritten.
servicesRouter.post('/:id/revert-config/:versionId', async (req, res) => {
  try {
    const db = getDb();
    const serviceId = req.params.id;

    const version = db.prepare(`
      SELECT * FROM service_config_versions
      WHERE id = ? AND service_id = ?
    `).get(req.params.versionId, serviceId);

    if (!version) {
      return res.status(404).json({ error: 'Config version not found' });
    }

    const config = JSON.parse(version.config_json);

    const service = db
      .prepare('SELECT * FROM services WHERE id = ?')
      .get(serviceId);
    if (!service) {
      return res.status(404).json({ error: 'Service not found' });
    }

    if (service.is_admin) {
      return res.status(403).json({ error: 'Cannot modify admin service' });
    }

    // Phase 2b D.14: snapshot the pre-revert services row + primary route
    // for rollback. Route-owned fields come from service_http_routes, not
    // the services row (those columns were dropped).
    const preRevertRow = { ...service };
    const preRevertPrimary = db
      .prepare(
        `SELECT id, domain, path_prefix, target_port, websocket_enabled,
                ssl_enabled, force_https, max_upload_size
           FROM service_http_routes
          WHERE service_id = ?
          ORDER BY created_at ASC, id ASC
          LIMIT 1`
      )
      .get(serviceId);
    const preRevertDomain = preRevertPrimary?.domain || null;

    // Apply the legacy fields from the saved snapshot. Older saved
    // versions may not include pathPrefix / target_ip — fall back to
    // sensible defaults.
    const revertedPathPrefix = normalizePathPrefix(config.pathPrefix);
    const revertedTargetIp =
      config.type === 'static' ? null : config.target || null;
    try {
      db.prepare(`
        UPDATE services SET
          name = ?, type = ?, target = ?, target_ip = ?,
          root_dir = ?, container_name = ?,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(
        config.name, config.type, config.target, revertedTargetIp,
        config.rootDir, config.containerName, serviceId
      );
    } catch (updateErr) {
      return res.status(400).json({
        error: 'Failed to revert services row: ' + updateErr.message,
      });
    }

    // Phase 2b D.8: propagate the revert into the primary route. On
    // UNIQUE violation revert the services UPDATE row-by-row to the
    // pre-revert snapshot and return 400.
    try {
      syncPrimaryRouteFromLegacy(db, serviceId, {
        domain: config.domain,
        pathPrefix: revertedPathPrefix,
        targetPort: config.port,
        sslEnabled: config.sslEnabled,
        forceHttps: config.forceHttps,
        websocketEnabled: config.websocketEnabled,
        maxUploadSize: config.maxUploadSize,
      });
    } catch (routeErr) {
      db.prepare(`
        UPDATE services SET
          name = ?, type = ?, target = ?, target_ip = ?,
          root_dir = ?, container_name = ?,
          updated_at = ?
        WHERE id = ?
      `).run(
        preRevertRow.name, preRevertRow.type, preRevertRow.target,
        preRevertRow.target_ip, preRevertRow.root_dir,
        preRevertRow.container_name, preRevertRow.updated_at, serviceId
      );
      return res.status(400).json({
        error: 'Failed to sync primary route: ' + routeErr.message,
      });
    }

    // Regenerate merged files for the reverted domain AND, if the domain
    // changed, the previous domain so its merged file shrinks or unlinks.
    const domainChanged =
      config.domain !== preRevertDomain && !!preRevertDomain;
    try {
      await regenerateDomainCaddyConfig(db, config.domain);
      if (domainChanged) {
        await regenerateDomainCaddyConfig(db, preRevertDomain);
      }
    } catch (genErr) {
      console.error('Revert: failed to regenerate merged Caddy config', genErr);
      // Continue — the legacy implementation swallowed gen errors too.
    }

    // Validate and reload Caddy
    try {
      await execOnHost(`caddy adapt --config ${CADDY_CONFIG_FILE} > /dev/null 2>&1`);
    } catch (e) {
      console.error('Revert: caddy adapt failed', e);
    }
    await reloadCaddy();

    // Save as new version
    const lastVersion = db.prepare(`
      SELECT MAX(version) as maxVersion FROM service_config_versions WHERE service_id = ?
    `).get(serviceId);

    db.prepare(`
      INSERT INTO service_config_versions (id, service_id, config_json, version, notes, created_by)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      uuidv4(),
      serviceId,
      JSON.stringify(config),
      (lastVersion?.maxVersion || 0) + 1,
      `Reverted to version ${version.version}`,
      req.user.id
    );

    logAudit(req.user.id, 'SERVICE_CONFIG_REVERTED', 'service', serviceId, {
      service_id: serviceId,
      revertedToVersion: version.version,
      domain: config.domain,
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
    // Phase 2b D.14: fetch the service's primary route domain.
    const service = db.prepare('SELECT id FROM services WHERE id = ?').get(req.params.id);
    if (!service) {
      return res.status(404).json({ error: 'Service not found' });
    }
    const primary = db
      .prepare(
        `SELECT domain FROM service_http_routes WHERE service_id = ? ORDER BY created_at ASC, id ASC LIMIT 1`
      )
      .get(req.params.id);
    if (!primary) {
      return res.status(404).json({ error: 'Service has no routes' });
    }
    const configPath = caddyFilePath(primary.domain);

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
    const service = db.prepare('SELECT id FROM services WHERE id = ?').get(req.params.id);

    if (!service) {
      return res.status(404).json({ error: 'Service not found' });
    }

    // Phase 2b D.14: fetch the service's primary route domain.
    const primary = db
      .prepare(
        `SELECT domain FROM service_http_routes WHERE service_id = ? ORDER BY created_at ASC, id ASC LIMIT 1`
      )
      .get(req.params.id);
    if (!primary) {
      return res.status(404).json({ error: 'Service has no routes' });
    }
    const configPath = caddyFilePath(primary.domain);

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

    logAudit(req.user.id, 'CADDY_CONFIG_EDITED', 'service', req.params.id, { domain: primary.domain }, req.ip);

    res.json({ success: true, message: 'Caddy config saved and reloaded' });
  } catch (error) {
    console.error('Error saving Caddy config:', error);
    res.status(500).json({ error: 'Failed to save Caddy config: ' + error.message });
  }
});

// ==================== PHASE 2b LXC IP REFRESH ====================
//
// Phase 2b E.2: re-queries Incus for a service's cached LXC container
// IP and — if the new IP differs — updates `services.target_ip`,
// regenerates the merged Caddy config for every domain the service's
// routes touch, and reloads Caddy. Audit-logged as `LXC_IP_REFRESHED`.
// No-op (returns 200 with `old_ip === new_ip`) when the IP is unchanged.
// On any downstream failure, reverts the DB + restores merged files.
servicesRouter.post('/:id/refresh-ip', async (req, res) => {
  try {
    const db = getDb();
    const serviceId = req.params.id;
    const service = db
      .prepare('SELECT * FROM services WHERE id = ?')
      .get(serviceId);
    if (!service) {
      return res.status(404).json({ error: 'Service not found' });
    }

    if (!service.lxc_container_name) {
      return res
        .status(400)
        .json({ error: 'Service has no associated LXC container' });
    }

    // Query Incus for the current IPv4. The container name is stored
    // without the `pp-` prefix in `services.lxc_container_name`; add it
    // back here so the `incus list` call matches the real instance.
    const incusName = `pp-${service.lxc_container_name}`;
    let newIp = null;
    try {
      const result = await execOnHost(
        `incus list ${JSON.stringify(incusName)} --format json 2>/dev/null`
      );
      const containers = JSON.parse(result.stdout || '[]');
      const target = containers.find((c) => c.name === incusName);
      if (target && target.state && target.state.network) {
        for (const [name, iface] of Object.entries(target.state.network)) {
          if (name === 'lo') continue;
          for (const addr of iface.addresses || []) {
            if (addr.family === 'inet' && !addr.address.startsWith('127.')) {
              newIp = addr.address;
              break;
            }
          }
          if (newIp) break;
        }
      }
    } catch (e) {
      return res.status(500).json({
        error: 'Failed to query Incus: ' + (e.stderr || e.message),
      });
    }

    const oldIp = service.target_ip;
    if (!newIp) {
      return res.status(400).json({
        error: `LXC container "${service.lxc_container_name}" has no IPv4 address (is it running?)`,
      });
    }

    // No-op path — just return the audit-friendly shape.
    if (newIp === oldIp) {
      logAudit(
        req.user.id,
        'LXC_IP_REFRESHED',
        'service',
        serviceId,
        {
          service_id: serviceId,
          lxc_container_name: service.lxc_container_name,
          old_ip: oldIp,
          new_ip: newIp,
        },
        req.ip
      );
      return res.json({
        success: true,
        changed: false,
        oldIp,
        newIp,
        message: 'IP unchanged — no regeneration needed',
      });
    }

    // Collect every domain the service's routes touch so we can
    // regenerate each merged file after the DB update.
    const routeDomains = db
      .prepare(
        `SELECT DISTINCT domain FROM service_http_routes WHERE service_id = ?`
      )
      .all(serviceId)
      .map((r) => r.domain);
    const affectedDomains = new Set(routeDomains);

    // Backup every affected merged file.
    await ensureCaddyStructure();
    const backups = {};
    for (const domain of affectedDomains) {
      const configPath = caddyFilePath(domain);
      let content = null;
      let existed = false;
      if (existsSync(configPath)) {
        try {
          content = await readFile(configPath, 'utf-8');
          existed = true;
        } catch (e) {
          // Continue without a backup.
        }
      }
      backups[domain] = { existed, content, path: configPath };
    }

    // Update the DB row with the new IP.
    db.prepare(
      `UPDATE services SET target_ip = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
    ).run(newIp, serviceId);

    const rollback = async () => {
      try {
        db.prepare(
          `UPDATE services SET target_ip = ? WHERE id = ?`
        ).run(oldIp, serviceId);
      } catch (e) {
        console.error('Rollback: failed to revert target_ip', e);
      }
      for (const [domain, b] of Object.entries(backups)) {
        try {
          if (b.existed && b.content !== null) {
            await writeCaddyConfig(b.path, b.content);
          } else {
            await unlink(b.path).catch(() => {});
          }
        } catch (e) {
          console.error(`Rollback: failed to restore ${domain}`, e);
        }
      }
    };

    // Regenerate merged Caddy config for every affected domain.
    try {
      for (const domain of affectedDomains) {
        await regenerateDomainCaddyConfig(db, domain);
      }
    } catch (genErr) {
      await rollback();
      return res.status(400).json({
        error: 'Failed to regenerate merged Caddy config: ' + genErr.message,
      });
    }

    // Validate + reload Caddy.
    try {
      await execOnHost(
        `caddy adapt --config ${CADDY_CONFIG_FILE} > /dev/null 2>&1`
      );
    } catch (testError) {
      await rollback();
      return res.status(400).json({
        error: 'Caddy config validation failed - reverted to previous IP',
        details: testError.stderr || testError.message,
      });
    }

    const reloadResult = await reloadCaddy();
    if (!reloadResult.success) {
      await rollback();
      await reloadCaddy().catch(() => {});
      return res.status(400).json({
        error: 'Caddy reload failed - reverted to previous IP',
        details: reloadResult.error,
      });
    }

    logAudit(
      req.user.id,
      'LXC_IP_REFRESHED',
      'service',
      serviceId,
      {
        service_id: serviceId,
        lxc_container_name: service.lxc_container_name,
        old_ip: oldIp,
        new_ip: newIp,
      },
      req.ip
    );

    res.json({
      success: true,
      changed: true,
      oldIp,
      newIp,
      domains: [...affectedDomains],
      caddyReloaded: reloadResult.success,
    });
  } catch (error) {
    console.error('Error refreshing LXC IP:', error);
    res.status(500).json({ error: 'Failed to refresh IP: ' + error.message });
  }
});

// ==================== PHASE 2b ROUTES CRUD ====================
//
// A Phase 2b service (one workload, typically an LXC or Docker container)
// can expose multiple HTTP routes at once. Each route is a row in the
// `service_http_routes` table carrying its own (domain, path_prefix,
// target_port, ssl_enabled, force_https, websocket_enabled,
// max_upload_size). The parent service contributes the target IP
// (services.target_ip), the kind (static_site vs container_service),
// and (for LXC) the container name.
//
// These endpoints are new in Phase 2b and live alongside the existing
// Phase 2 service endpoints. The Phase 2 endpoints continue to operate
// against legacy columns on `services` until Section D refactors them
// to read and write through this CRUD surface.

// Phase 2b D.1 dual-write helper — `syncPrimaryRouteFromLegacy`
//
// Mirrors the legacy (domain, path_prefix, port, ssl flags, ...) fields
// on a `services` row into a corresponding `service_http_routes` row so
// the legacy Phase 2 endpoints (POST /, PUT /:id, obtain-certificate,
// revert-config, import, discover/import) can keep accepting unchanged
// payloads while Section H updates the frontend. After every legacy
// write, the routes table has a matching entry — D.14 can safely drop
// the legacy columns once every endpoint calls this helper.
//
// The "primary route" for a service is defined as the earliest-created
// route owned by that service. On a post-A.3-backfilled install, every
// service has exactly one primary route (the one A.3 inserted), and
// later routes added via C.2 have later timestamps. For fresh installs,
// D.2 inserts the primary directly. For Phase 2 endpoints that run
// mid-phase, this helper updates whichever route is currently primary.
//
// Params:
//   - db: sqlite instance
//   - serviceId: the parent services row id
//   - legacy: { domain, pathPrefix, targetPort, sslEnabled, forceHttps,
//     websocketEnabled, maxUploadSize } — the target state
//
// Returns the id of the synced route row (either the existing primary
// that was updated, or the newly inserted route).
function syncPrimaryRouteFromLegacy(db, serviceId, legacy) {
  const normalizedPrefix = normalizePathPrefix(legacy.pathPrefix);

  // Find the earliest-created route owned by this service. If it exists
  // we update it in place; otherwise we insert a new primary. Secondary
  // routes added via C.2 have later timestamps and are left alone.
  const primary = db
    .prepare(
      `SELECT id FROM service_http_routes
        WHERE service_id = ?
     ORDER BY created_at ASC, id ASC
        LIMIT 1`
    )
    .get(serviceId);

  if (primary) {
    db.prepare(
      `UPDATE service_http_routes SET
         domain = ?,
         path_prefix = ?,
         target_port = ?,
         websocket_enabled = ?,
         ssl_enabled = ?,
         force_https = ?,
         max_upload_size = ?
       WHERE id = ?`
    ).run(
      legacy.domain,
      normalizedPrefix,
      legacy.targetPort || null,
      legacy.websocketEnabled ? 1 : 0,
      legacy.sslEnabled ? 1 : 0,
      legacy.forceHttps ? 1 : 0,
      legacy.maxUploadSize || '1G',
      primary.id
    );
    return primary.id;
  }

  const newId = uuidv4();
  db.prepare(
    `INSERT INTO service_http_routes (
       id, service_id, domain, path_prefix, target_port,
       websocket_enabled, ssl_enabled, force_https, max_upload_size
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    newId,
    serviceId,
    legacy.domain,
    normalizedPrefix,
    legacy.targetPort || null,
    legacy.websocketEnabled ? 1 : 0,
    legacy.sslEnabled ? 1 : 0,
    legacy.forceHttps ? 1 : 0,
    legacy.maxUploadSize || '1G'
  );
  return newId;
}

// Zod schema for the Phase 2b route CRUD endpoints. `maxUploadSize`
// matches the same regex the legacy createServiceSchema uses so the
// merged request_body max_size directive stays well-formed.
const createRouteSchema = z.object({
  domain: z
    .string()
    .regex(DOMAIN_REGEX, 'Invalid domain (use example.com or *.example.com)'),
  pathPrefix: z
    .string()
    .regex(
      PATH_PREFIX_REGEX,
      'Path prefix must start with / and contain only URL-safe characters'
    )
    .default('/'),
  targetPort: z
    .union([z.number().int().min(1).max(65535), z.string(), z.null()])
    .optional()
    .transform((val) => {
      if (val === null || val === undefined || val === '') return undefined;
      const num = typeof val === 'string' ? parseInt(val, 10) : val;
      return isNaN(num) ? undefined : num;
    }),
  websocketEnabled: z.boolean().default(false),
  sslEnabled: z.boolean().default(true),
  forceHttps: z.boolean().default(true),
  maxUploadSize: z
    .string()
    .regex(/^[1-9][0-9]*[MG]$/i)
    .default('1G'),
});

// List routes for a service.
// Returns `{routes: [...]}` ordered by length(path_prefix) DESC so the
// more-specific prefixes appear first (matching Caddy's source-order
// matching behavior). 404 when the parent service does not exist.
servicesRouter.get('/:id/routes', (req, res) => {
  try {
    const db = getDb();
    const service = db
      .prepare('SELECT id FROM services WHERE id = ?')
      .get(req.params.id);
    if (!service) {
      return res.status(404).json({ error: 'Service not found' });
    }

    const rows = db
      .prepare(
        `SELECT id, service_id, domain, path_prefix, target_port,
                websocket_enabled, ssl_enabled, force_https,
                max_upload_size, created_at
           FROM service_http_routes
          WHERE service_id = ?
          ORDER BY length(path_prefix) DESC, created_at ASC`
      )
      .all(req.params.id);

    const routes = rows.map((r) => ({
      id: r.id,
      serviceId: r.service_id,
      domain: r.domain,
      pathPrefix: r.path_prefix,
      targetPort: r.target_port,
      websocketEnabled: !!r.websocket_enabled,
      sslEnabled: !!r.ssl_enabled,
      forceHttps: !!r.force_https,
      maxUploadSize: r.max_upload_size,
      createdAt: r.created_at,
    }));

    res.json({ routes });
  } catch (error) {
    console.error('Error listing routes:', error);
    res.status(500).json({ error: 'Failed to list routes' });
  }
});

// Create a route for a service.
// Validates (domain, path_prefix) uniqueness across BOTH service_http_routes
// AND the legacy services table (dual-source during the Section D transition),
// validates SSL stance consistency against siblings on the same domain via
// assertRoutesShareSslStance, backs up the merged file for the affected
// domain, INSERTs the route, regenerates the merged config, runs caddy adapt,
// and reloads. On any downstream failure, rolls back both the DB row and
// the merged file to pre-POST state.
servicesRouter.post('/:id/routes', async (req, res) => {
  try {
    const db = getDb();
    const service = db
      .prepare('SELECT * FROM services WHERE id = ?')
      .get(req.params.id);
    if (!service) {
      return res.status(404).json({ error: 'Service not found' });
    }
    if (service.is_admin) {
      return res
        .status(403)
        .json({ error: 'Cannot add routes to admin service' });
    }

    const data = createRouteSchema.parse(req.body);
    data.pathPrefix = normalizePathPrefix(data.pathPrefix);

    // (1) Uniqueness check against service_http_routes. The DB UNIQUE
    // constraint is the primary guard; this query surfaces a better
    // error message before we hit it.
    const existingRoute = db
      .prepare(
        `SELECT id FROM service_http_routes WHERE domain = ? AND path_prefix = ?`
      )
      .get(data.domain, data.pathPrefix);
    if (existingRoute) {
      return res
        .status(400)
        .json({ error: 'Domain + path prefix combination already exists' });
    }

    // (2) Uniqueness check against legacy services rows on the same
    // (domain, path_prefix) tuple so Section D can ship incrementally
    // without risking double-registration.
    let legacyCollision = null;
    try {
      legacyCollision = db
        .prepare(
          `SELECT id FROM services WHERE domain = ? AND path_prefix = ? AND is_admin = 0`
        )
        .get(data.domain, data.pathPrefix);
    } catch (e) {
      // Post-D.14 — legacy columns dropped. Nothing to check.
      legacyCollision = null;
    }
    if (legacyCollision) {
      return res
        .status(400)
        .json({ error: 'Domain + path prefix combination already exists' });
    }

    // (3) SSL stance consistency against all siblings on the domain.
    try {
      assertRoutesShareSslStance(db, data.domain, {
        sslEnabled: data.sslEnabled,
        forceHttps: data.forceHttps,
      });
    } catch (e) {
      if (e.code === 'ROUTE_SSL_CONFLICT') {
        return res.status(400).json({ error: e.message });
      }
      throw e;
    }

    // (4) Backup the merged file for the affected domain so we can
    // restore it on any downstream failure.
    await ensureCaddyStructure();
    const configPath = caddyFilePath(data.domain);
    let backupMergedConfig = null;
    let backupExisted = false;
    try {
      if (existsSync(configPath)) {
        backupMergedConfig = await readFile(configPath, 'utf-8');
        backupExisted = true;
      }
    } catch (e) {
      // Continue without a backup; rollback will unlink on failure.
    }

    // (5) INSERT the route row.
    const routeId = uuidv4();
    db.prepare(
      `INSERT INTO service_http_routes (
         id, service_id, domain, path_prefix, target_port,
         websocket_enabled, ssl_enabled, force_https, max_upload_size
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      routeId,
      req.params.id,
      data.domain,
      data.pathPrefix,
      data.targetPort || null,
      data.websocketEnabled ? 1 : 0,
      data.sslEnabled ? 1 : 0,
      data.forceHttps ? 1 : 0,
      data.maxUploadSize
    );

    // Rollback helper: delete the inserted row + restore the merged file.
    const rollbackRouteCreate = async () => {
      try {
        db.prepare('DELETE FROM service_http_routes WHERE id = ?').run(
          routeId
        );
      } catch (e) {
        console.error('Rollback: failed to delete inserted route', e);
      }
      try {
        if (backupExisted && backupMergedConfig !== null) {
          await writeCaddyConfig(configPath, backupMergedConfig);
        } else {
          await unlink(configPath).catch(() => {});
        }
      } catch (e) {
        console.error('Rollback: failed to restore merged Caddy config', e);
      }
    };

    // (6) Regenerate the merged file for the affected domain.
    try {
      await regenerateDomainCaddyConfig(db, data.domain);
    } catch (genErr) {
      await rollbackRouteCreate();
      return res.status(400).json({
        error: 'Failed to generate merged Caddy config: ' + genErr.message,
      });
    }

    // (7) Validate Caddy config.
    try {
      await execOnHost(
        `caddy adapt --config ${CADDY_CONFIG_FILE} > /dev/null 2>&1`
      );
    } catch (testErr) {
      await rollbackRouteCreate();
      return res.status(400).json({
        error:
          'Invalid Caddy configuration generated: ' +
          (testErr.stderr || testErr.message),
      });
    }

    // (8) Reload Caddy.
    const caddyResult = await reloadCaddy();
    if (!caddyResult.success) {
      await rollbackRouteCreate();
      await reloadCaddy().catch(() => {});
      return res.status(400).json({
        error: 'Caddy reload failed - route create rolled back',
        details: caddyResult.error,
      });
    }

    logAudit(
      req.user.id,
      'ROUTE_CREATED',
      'route',
      routeId,
      {
        service_id: req.params.id,
        route: {
          id: routeId,
          domain: data.domain,
          pathPrefix: data.pathPrefix,
          targetPort: data.targetPort,
        },
      },
      req.ip
    );

    res.status(201).json({
      success: true,
      route: {
        id: routeId,
        serviceId: req.params.id,
        domain: data.domain,
        pathPrefix: data.pathPrefix,
        targetPort: data.targetPort,
        websocketEnabled: data.websocketEnabled,
        sslEnabled: data.sslEnabled,
        forceHttps: data.forceHttps,
        maxUploadSize: data.maxUploadSize,
      },
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: error.errors[0].message });
    }
    console.error('Error creating route:', error);
    res.status(500).json({ error: 'Failed to create route' });
  }
});

// Update a route. Handles:
//   - partial payloads (any subset of domain/pathPrefix/targetPort/
//     websocketEnabled/sslEnabled/forceHttps/maxUploadSize)
//   - domain change: regenerates merged files for BOTH the old and
//     the new domain so the old file shrinks/unlinks and the new
//     file picks up the moved route
//   - uniqueness + SSL consistency re-validation against the new tuple
//   - dual-layer rollback (DB row + both merged files) on any failure
servicesRouter.put('/:id/routes/:routeId', async (req, res) => {
  try {
    const db = getDb();
    const service = db
      .prepare('SELECT * FROM services WHERE id = ?')
      .get(req.params.id);
    if (!service) {
      return res.status(404).json({ error: 'Service not found' });
    }
    if (service.is_admin) {
      return res
        .status(403)
        .json({ error: 'Cannot modify routes on admin service' });
    }

    const route = db
      .prepare(
        `SELECT * FROM service_http_routes WHERE id = ? AND service_id = ?`
      )
      .get(req.params.routeId, req.params.id);
    if (!route) {
      return res.status(404).json({ error: 'Route not found' });
    }

    const data = createRouteSchema.partial().parse(req.body);
    if (data.pathPrefix !== undefined) {
      data.pathPrefix = normalizePathPrefix(data.pathPrefix);
    }

    // Merge partial payload onto the current row.
    const updated = {
      domain: data.domain !== undefined ? data.domain : route.domain,
      pathPrefix:
        data.pathPrefix !== undefined
          ? data.pathPrefix
          : normalizePathPrefix(route.path_prefix),
      targetPort:
        data.targetPort !== undefined ? data.targetPort : route.target_port,
      websocketEnabled:
        data.websocketEnabled !== undefined
          ? data.websocketEnabled
          : !!route.websocket_enabled,
      sslEnabled:
        data.sslEnabled !== undefined ? data.sslEnabled : !!route.ssl_enabled,
      forceHttps:
        data.forceHttps !== undefined
          ? data.forceHttps
          : !!route.force_https,
      maxUploadSize:
        data.maxUploadSize !== undefined
          ? data.maxUploadSize
          : route.max_upload_size,
    };

    const oldDomain = route.domain;
    const oldPathPrefix = normalizePathPrefix(route.path_prefix);
    const domainChanged = updated.domain !== oldDomain;
    const prefixChanged = updated.pathPrefix !== oldPathPrefix;

    // (1) Uniqueness check — only re-run when the tuple actually changed,
    // so an update that keeps (domain, path_prefix) the same does not
    // false-positive against its own row.
    if (domainChanged || prefixChanged) {
      const existingRoute = db
        .prepare(
          `SELECT id FROM service_http_routes WHERE domain = ? AND path_prefix = ? AND id != ?`
        )
        .get(updated.domain, updated.pathPrefix, req.params.routeId);
      if (existingRoute) {
        return res
          .status(400)
          .json({ error: 'Domain + path prefix combination already exists' });
      }
      let legacyCollision = null;
      try {
        legacyCollision = db
          .prepare(
            `SELECT id FROM services WHERE domain = ? AND path_prefix = ? AND is_admin = 0`
          )
          .get(updated.domain, updated.pathPrefix);
      } catch (e) {
        legacyCollision = null;
      }
      if (legacyCollision) {
        return res
          .status(400)
          .json({ error: 'Domain + path prefix combination already exists' });
      }
    }

    // (2) SSL stance consistency against siblings on the target domain.
    // excludeRouteId prevents the check from false-positiving against
    // the row we are updating in-place.
    try {
      assertRoutesShareSslStance(
        db,
        updated.domain,
        {
          sslEnabled: updated.sslEnabled,
          forceHttps: updated.forceHttps,
        },
        req.params.routeId
      );
    } catch (e) {
      if (e.code === 'ROUTE_SSL_CONFLICT') {
        return res.status(400).json({ error: e.message });
      }
      throw e;
    }

    // (3) Backup merged files for both the new and (if it changed) the
    // old domain so rollback can restore whichever failed.
    await ensureCaddyStructure();
    const newConfigPath = caddyFilePath(updated.domain);
    const oldConfigPath = caddyFilePath(oldDomain);

    let backupNew = null;
    let backupNewExisted = false;
    try {
      if (existsSync(newConfigPath)) {
        backupNew = await readFile(newConfigPath, 'utf-8');
        backupNewExisted = true;
      }
    } catch (e) {
      // Continue without a backup.
    }

    let backupOld = null;
    let backupOldExisted = false;
    if (domainChanged) {
      try {
        if (existsSync(oldConfigPath)) {
          backupOld = await readFile(oldConfigPath, 'utf-8');
          backupOldExisted = true;
        }
      } catch (e) {
        // Continue without a backup.
      }
    }

    // Snapshot the pre-update row for rollback.
    const preUpdateRow = { ...route };

    // (4) UPDATE the row.
    db.prepare(
      `UPDATE service_http_routes SET
         domain = ?,
         path_prefix = ?,
         target_port = ?,
         websocket_enabled = ?,
         ssl_enabled = ?,
         force_https = ?,
         max_upload_size = ?
       WHERE id = ?`
    ).run(
      updated.domain,
      updated.pathPrefix,
      updated.targetPort || null,
      updated.websocketEnabled ? 1 : 0,
      updated.sslEnabled ? 1 : 0,
      updated.forceHttps ? 1 : 0,
      updated.maxUploadSize,
      req.params.routeId
    );

    const rollbackRouteUpdate = async () => {
      try {
        db.prepare(
          `UPDATE service_http_routes SET
             domain = ?,
             path_prefix = ?,
             target_port = ?,
             websocket_enabled = ?,
             ssl_enabled = ?,
             force_https = ?,
             max_upload_size = ?
           WHERE id = ?`
        ).run(
          preUpdateRow.domain,
          preUpdateRow.path_prefix,
          preUpdateRow.target_port,
          preUpdateRow.websocket_enabled,
          preUpdateRow.ssl_enabled,
          preUpdateRow.force_https,
          preUpdateRow.max_upload_size,
          req.params.routeId
        );
      } catch (e) {
        console.error('Rollback: failed to revert route row', e);
      }
      try {
        if (backupNewExisted && backupNew !== null) {
          await writeCaddyConfig(newConfigPath, backupNew);
        } else {
          await unlink(newConfigPath).catch(() => {});
        }
      } catch (e) {
        console.error('Rollback: failed to restore new-domain merged file', e);
      }
      if (domainChanged) {
        try {
          if (backupOldExisted && backupOld !== null) {
            await writeCaddyConfig(oldConfigPath, backupOld);
          } else {
            await unlink(oldConfigPath).catch(() => {});
          }
        } catch (e) {
          console.error('Rollback: failed to restore old-domain merged file', e);
        }
      }
    };

    // (5) Regenerate merged files. New domain always needs a rewrite.
    // Old domain also needs a rewrite when the domain changed — its
    // merged file shrinks if siblings remain, or unlinks otherwise.
    try {
      await regenerateDomainCaddyConfig(db, updated.domain);
      if (domainChanged) {
        await regenerateDomainCaddyConfig(db, oldDomain);
      }
    } catch (genErr) {
      await rollbackRouteUpdate();
      return res.status(400).json({
        error: 'Failed to generate merged Caddy config: ' + genErr.message,
      });
    }

    // (6) Validate Caddy config.
    try {
      await execOnHost(
        `caddy adapt --config ${CADDY_CONFIG_FILE} > /dev/null 2>&1`
      );
    } catch (testErr) {
      await rollbackRouteUpdate();
      return res.status(400).json({
        error:
          'Invalid Caddy configuration generated: ' +
          (testErr.stderr || testErr.message),
      });
    }

    // (7) Reload Caddy.
    const caddyResult = await reloadCaddy();
    if (!caddyResult.success) {
      await rollbackRouteUpdate();
      await reloadCaddy().catch(() => {});
      return res.status(400).json({
        error: 'Caddy reload failed - route update rolled back',
        details: caddyResult.error,
      });
    }

    logAudit(
      req.user.id,
      'ROUTE_UPDATED',
      'route',
      req.params.routeId,
      {
        service_id: req.params.id,
        before: {
          domain: preUpdateRow.domain,
          pathPrefix: normalizePathPrefix(preUpdateRow.path_prefix),
          targetPort: preUpdateRow.target_port,
        },
        after: {
          domain: updated.domain,
          pathPrefix: updated.pathPrefix,
          targetPort: updated.targetPort,
        },
      },
      req.ip
    );

    res.json({
      success: true,
      route: {
        id: req.params.routeId,
        serviceId: req.params.id,
        domain: updated.domain,
        pathPrefix: updated.pathPrefix,
        targetPort: updated.targetPort,
        websocketEnabled: updated.websocketEnabled,
        sslEnabled: updated.sslEnabled,
        forceHttps: updated.forceHttps,
        maxUploadSize: updated.maxUploadSize,
      },
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: error.errors[0].message });
    }
    console.error('Error updating route:', error);
    res.status(500).json({ error: 'Failed to update route' });
  }
});

// Delete a single route.
// Snapshots the pre-delete row + the merged file for the affected domain,
// DELETEs the row, regenerates the merged file (which shrinks or unlinks
// depending on whether siblings remain), and on any downstream failure
// restores both the row and the file. Parent service is NOT touched —
// a service with zero routes is legal in Phase 2b; the operator can add
// routes back without recreating the service.
servicesRouter.delete('/:id/routes/:routeId', async (req, res) => {
  try {
    const db = getDb();
    const service = db
      .prepare('SELECT * FROM services WHERE id = ?')
      .get(req.params.id);
    if (!service) {
      return res.status(404).json({ error: 'Service not found' });
    }
    if (service.is_admin) {
      return res
        .status(403)
        .json({ error: 'Cannot delete routes from admin service' });
    }

    const route = db
      .prepare(
        `SELECT * FROM service_http_routes WHERE id = ? AND service_id = ?`
      )
      .get(req.params.routeId, req.params.id);
    if (!route) {
      return res.status(404).json({ error: 'Route not found' });
    }

    // Backup the merged file for the affected domain so rollback can
    // restore it. Also snapshot the row so rollback can re-insert it.
    await ensureCaddyStructure();
    const configPath = caddyFilePath(route.domain);
    let backupMergedConfig = null;
    let backupExisted = false;
    try {
      if (existsSync(configPath)) {
        backupMergedConfig = await readFile(configPath, 'utf-8');
        backupExisted = true;
      }
    } catch (e) {
      // Continue without a backup.
    }

    const preDeleteRow = { ...route };

    // DELETE the row.
    db.prepare(`DELETE FROM service_http_routes WHERE id = ?`).run(
      req.params.routeId
    );

    const rollbackRouteDelete = async () => {
      try {
        db.prepare(
          `INSERT INTO service_http_routes (
             id, service_id, domain, path_prefix, target_port,
             websocket_enabled, ssl_enabled, force_https, max_upload_size,
             created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          preDeleteRow.id,
          preDeleteRow.service_id,
          preDeleteRow.domain,
          preDeleteRow.path_prefix,
          preDeleteRow.target_port,
          preDeleteRow.websocket_enabled,
          preDeleteRow.ssl_enabled,
          preDeleteRow.force_https,
          preDeleteRow.max_upload_size,
          preDeleteRow.created_at
        );
      } catch (e) {
        console.error('Rollback: failed to re-insert deleted route', e);
      }
      try {
        if (backupExisted && backupMergedConfig !== null) {
          await writeCaddyConfig(configPath, backupMergedConfig);
        } else {
          await unlink(configPath).catch(() => {});
        }
      } catch (e) {
        console.error('Rollback: failed to restore merged file', e);
      }
    };

    try {
      await regenerateDomainCaddyConfig(db, route.domain);
    } catch (genErr) {
      await rollbackRouteDelete();
      return res.status(400).json({
        error: 'Failed to regenerate merged Caddy config: ' + genErr.message,
      });
    }

    try {
      await execOnHost(
        `caddy adapt --config ${CADDY_CONFIG_FILE} > /dev/null 2>&1`
      );
    } catch (testErr) {
      await rollbackRouteDelete();
      return res.status(400).json({
        error:
          'Invalid Caddy configuration after delete: ' +
          (testErr.stderr || testErr.message),
      });
    }

    const caddyResult = await reloadCaddy();
    if (!caddyResult.success) {
      await rollbackRouteDelete();
      await reloadCaddy().catch(() => {});
      return res.status(400).json({
        error: 'Caddy reload failed - route delete rolled back',
        details: caddyResult.error,
      });
    }

    logAudit(
      req.user.id,
      'ROUTE_DELETED',
      'route',
      req.params.routeId,
      {
        service_id: req.params.id,
        route: {
          id: preDeleteRow.id,
          domain: preDeleteRow.domain,
          pathPrefix: normalizePathPrefix(preDeleteRow.path_prefix),
          targetPort: preDeleteRow.target_port,
        },
      },
      req.ip
    );

    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting route:', error);
    res.status(500).json({ error: 'Failed to delete route' });
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

    // Phase 2b: a service can span multiple domains via its routes
    // (one service, many `service_http_routes` rows). Collect EVERY
    // domain the service touches BEFORE the delete so we can regenerate
    // each affected merged file afterwards. Sources:
    //   1. The legacy `services.domain` column (still populated during
    //      the Section D transition window)
    //   2. The distinct set of route domains owned by this service
    const routeRows = db
      .prepare(
        `SELECT id, domain, path_prefix, target_port FROM service_http_routes WHERE service_id = ?`
      )
      .all(req.params.id);
    const affectedDomains = new Set();
    if (service.domain) affectedDomains.add(service.domain);
    for (const r of routeRows) affectedDomains.add(r.domain);

    // Delete from database first so regenerateDomainCaddyConfig picks up
    // the remaining siblings (or an empty list if this was the last one).
    // The ON DELETE CASCADE FK on service_http_routes.service_id wipes
    // every child route row in the same statement — better-sqlite3 9.x
    // enforces foreign_keys=ON by default.
    db.prepare('DELETE FROM services WHERE id = ?').run(req.params.id);

    // Regenerate the merged Caddy config for every domain the service
    // touched. A domain whose last remaining entry was owned by this
    // service gets its merged file unlinked; a domain that still has
    // sibling entries gets its file rewritten without the deleted rows.
    for (const domain of affectedDomains) {
      try {
        await regenerateDomainCaddyConfig(db, domain);
      } catch (e) {
        console.error(
          `Error regenerating merged Caddy config for ${domain} after delete:`,
          e
        );
      }
    }

    // Reload Caddy once at the end so N domain rewrites share one reload.
    await reloadCaddy().catch((e) => {
      console.error('Error reloading Caddy after delete:', e);
    });

    // Optionally remove data directory (keep files by default for safety)
    // To enable: await rm(service.data_dir, { recursive: true, force: true }).catch(() => {});

    // Phase 2b F.1: audit payload nests the service-level snapshot AND
    // every route that was cascaded so a post-hoc audit can replay the
    // full delete without needing the routes table (which may have
    // shrunk by the time the audit is reviewed). Legacy `{domain,
    // pathPrefix}` tuple is synthesized from the first route (primary)
    // for backward compatibility with the pre-Phase-2b audit format.
    const primaryForAudit = routeRows[0] || null;
    logAudit(
      req.user.id,
      'SERVICE_DELETED',
      'service',
      req.params.id,
      {
        service: {
          id: req.params.id,
          name: service.name,
          kind: service.kind,
          runtime: service.runtime,
          target_ip: service.target_ip,
          lxc_container_name: service.lxc_container_name,
        },
        routes: routeRows.map((r) => ({
          id: r.id,
          domain: r.domain,
          pathPrefix: normalizePathPrefix(r.path_prefix),
          targetPort: r.target_port,
        })),
        // Legacy flat fields for backward compat with pre-Phase-2b audit format
        domain: primaryForAudit?.domain || null,
        pathPrefix: primaryForAudit ? normalizePathPrefix(primaryForAudit.path_prefix) : null,
      },
      req.ip
    );

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
// Phase 2b D.9: export now nests a `routes` array under each service
// and bumps `version` to '2.0'. The legacy top-level route-owned fields
// (`domain`, `pathPrefix`, `port`, `sslEnabled`, `forceHttps`,
// `websocketEnabled`, `maxUploadSize`) are retained for backward
// compatibility with Phase 2 importers, but new-shape importers should
// use the nested `routes` array as the source of truth. D.10 accepts
// both shapes.
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
      version: '2.0',
      exportedAt: new Date().toISOString(),
      services: [],
    };

    const routesStmt = db.prepare(
      `SELECT id, domain, path_prefix, target_port, websocket_enabled,
              ssl_enabled, force_https, max_upload_size, created_at
         FROM service_http_routes
        WHERE service_id = ?
        ORDER BY created_at ASC, id ASC`
    );

    for (const service of services) {
      const routeRows = routesStmt.all(service.id);
      const routes = routeRows.map((r) => ({
        id: r.id,
        domain: r.domain,
        pathPrefix: r.path_prefix,
        targetPort: r.target_port,
        websocketEnabled: !!r.websocket_enabled,
        sslEnabled: !!r.ssl_enabled,
        forceHttps: !!r.force_https,
        maxUploadSize: r.max_upload_size,
        createdAt: r.created_at,
      }));

      // Phase 2b D.14: synthesize legacy top-level fields from the
      // primary route since the services table no longer carries them.
      const primary = routes[0];
      const serviceExport = {
        // Phase 2b service-level fields
        name: service.name,
        kind: service.kind,
        runtime: service.runtime,
        targetIp: service.target_ip,
        lxcContainerName: service.lxc_container_name,
        // Legacy service-level fields that are NOT owned by routes
        type: service.type,
        target: service.target,
        rootDir: service.root_dir,
        containerName: service.container_name,
        dataDir: service.data_dir,
        // Phase 2b nested routes — the post-D.14 source of truth
        routes,
        // Legacy top-level route-owned fields — synthesized from the
        // primary route for backward compatibility with Phase 2 importers.
        // D.10 prefers `routes` when present.
        domain: primary?.domain || null,
        pathPrefix: primary?.pathPrefix || '/',
        port: primary?.targetPort || null,
        sslEnabled: primary ? primary.sslEnabled : false,
        forceHttps: primary ? primary.forceHttps : false,
        websocketEnabled: primary ? primary.websocketEnabled : false,
        maxUploadSize: primary?.maxUploadSize || '1G',
        files: [],
      };

      // Include files if requested
      if (includeFiles && service.data_dir && existsSync(service.data_dir)) {
        serviceExport.files = await exportFilesRecursive(service.data_dir, service.data_dir);
      }

      exportData.services.push(serviceExport);
    }

    logAudit(
      req.user.id,
      'SERVICES_EXPORTED',
      'system',
      null,
      { count: services.length, version: exportData.version },
      req.ip
    );

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
// Phase 2b D.10: import accepts BOTH the new nested-`routes` export shape
// (from D.9 `version=2.0`) AND the legacy Phase 2 flat shape (one route
// per service synthesized from the top-level `domain`/`pathPrefix`/`port`/
// ssl flags). For each entry:
//   1. Normalize to `{service fields, routes: [...]}` — if `routes` is
//      present use it directly, otherwise synthesize a single-element
//      array from the legacy top-level fields.
//   2. Derive Phase 2b service-level fields from legacy `type` when the
//      import didn't supply them (type='static' → kind='static_site',
//      type='docker' → kind='container_service' + runtime='docker',
//      type='proxy' → kind='container_service' + runtime=NULL).
//   3. Pre-check every route's (domain, path_prefix) tuple against both
//      `service_http_routes` and the legacy `services` table; on any
//      collision the entire entry is either skipped or — in overwrite
//      mode — the conflicting existing services are deleted (cascade
//      wipes their routes via FK).
//   4. INSERT the services row with legacy route-owned columns populated
//      from the PRIMARY route (first element of the routes array) so the
//      pre-D.14 dual-source state stays consistent.
//   5. Call `syncPrimaryRouteFromLegacy` to mirror the primary route into
//      `service_http_routes`, then INSERT each secondary route directly.
//   6. After the loop, regenerate every touched domain's merged file
//      once and reload Caddy.
servicesRouter.post('/import', async (req, res) => {
  try {
    const { services: importServices, overwrite } = req.body;

    if (!importServices || !Array.isArray(importServices)) {
      return res.status(400).json({ error: 'Invalid import data' });
    }

    const db = getDb();
    const results = { imported: [], skipped: [], errors: [] };
    const touchedDomains = new Set();

    // Infer (kind, runtime) from a legacy `type` value when the import
    // payload didn't supply the Phase 2b fields directly.
    const inferKind = (type) => (type === 'static' ? 'static_site' : 'container_service');
    const inferRuntime = (type) => (type === 'docker' ? 'docker' : null);

    for (const serviceData of importServices) {
      try {
        // (1) Normalize to {service fields, routes}. Nested shape takes
        // precedence; legacy flat shape synthesizes a single-element
        // array from the top-level fields.
        const hasNestedRoutes =
          Array.isArray(serviceData.routes) && serviceData.routes.length > 0;
        const routes = hasNestedRoutes
          ? serviceData.routes.map((r) => ({
              domain: r.domain,
              pathPrefix: normalizePathPrefix(r.pathPrefix),
              targetPort: r.targetPort ?? null,
              sslEnabled: !!r.sslEnabled,
              forceHttps: !!r.forceHttps,
              websocketEnabled: !!r.websocketEnabled,
              maxUploadSize: r.maxUploadSize || '1G',
            }))
          : [
              {
                domain: serviceData.domain,
                pathPrefix: normalizePathPrefix(serviceData.pathPrefix),
                targetPort: serviceData.port ?? null,
                sslEnabled: !!serviceData.sslEnabled,
                forceHttps: !!serviceData.forceHttps,
                websocketEnabled: !!serviceData.websocketEnabled,
                maxUploadSize: serviceData.maxUploadSize || '1G',
              },
            ];

        // Primary route (first element) supplies the legacy services
        // columns during the pre-D.14 dual-source transition.
        const primaryRoute = routes[0];

        // (2) Pre-check every route's (domain, path_prefix) against both
        // sources. Collect collisions so overwrite mode can wipe them
        // atomically before the INSERT.
        const collidingServiceIds = new Set();
        let collisionLabel = null;
        for (const r of routes) {
          // Routes-side collision via service_http_routes.
          const routeHit = db
            .prepare(
              `SELECT r.id, r.service_id
                 FROM service_http_routes r
                WHERE r.domain = ? AND r.path_prefix = ?`
            )
            .get(r.domain, r.pathPrefix);
          if (routeHit) {
            collidingServiceIds.add(routeHit.service_id);
            collisionLabel = `${r.domain}${r.pathPrefix}`;
          }
          // Legacy-side collision (try/catch for post-D.14).
          try {
            const legacyHit = db
              .prepare(
                `SELECT id FROM services WHERE domain = ? AND path_prefix = ?`
              )
              .get(r.domain, r.pathPrefix);
            if (legacyHit) {
              collidingServiceIds.add(legacyHit.id);
              collisionLabel = `${r.domain}${r.pathPrefix}`;
            }
          } catch (e) {
            // Post-D.14 — legacy columns gone.
          }
        }

        if (collidingServiceIds.size > 0 && !overwrite) {
          results.skipped.push({
            name: serviceData.name,
            reason: `Route collision at ${collisionLabel}`,
          });
          continue;
        }

        if (collidingServiceIds.size > 0 && overwrite) {
          // Collect every domain the soon-to-be-deleted services touch
          // so we can regenerate their merged files after the loop.
          for (const sid of collidingServiceIds) {
            try {
              const oldRouteDomains = db
                .prepare(
                  `SELECT DISTINCT domain FROM service_http_routes WHERE service_id = ?`
                )
                .all(sid)
                .map((row) => row.domain);
              for (const d of oldRouteDomains) touchedDomains.add(d);
            } catch (e) {
              // Ignore — best-effort cleanup.
            }
            try {
              const legacyRow = db
                .prepare('SELECT domain FROM services WHERE id = ?')
                .get(sid);
              if (legacyRow && legacyRow.domain) touchedDomains.add(legacyRow.domain);
            } catch (e) {
              // Ignore.
            }
            db.prepare('DELETE FROM services WHERE id = ?').run(sid);
          }
        }

        // (3) Derive Phase 2b service-level fields.
        const svcKind = serviceData.kind || inferKind(serviceData.type);
        const svcRuntime =
          serviceData.runtime !== undefined
            ? serviceData.runtime
            : inferRuntime(serviceData.type);
        const svcTargetIp =
          serviceData.targetIp !== undefined
            ? serviceData.targetIp
            : svcKind === 'static_site'
              ? null
              : serviceData.target || null;
        const svcLxcName = serviceData.lxcContainerName || null;

        // (4) Prepare data_dir + root_dir (existing static-site logic).
        const id = uuidv4();
        let dataDir;
        let rootDir = serviceData.rootDir;
        if (serviceData.type === 'static' && serviceData.rootDir && !serviceData.files?.length) {
          dataDir = serviceData.rootDir;
          rootDir = serviceData.rootDir;
          if (!existsSync(dataDir)) {
            await mkdir(dataDir, { recursive: true });
          }
        } else {
          const safeDir = toSafeDirectoryName(serviceData.name);
          dataDir = join(SERVICES_DATA_DIR, safeDir);
          await mkdir(dataDir, { recursive: true });
          if (serviceData.files && serviceData.files.length > 0) {
            for (const file of serviceData.files) {
              const filePath = join(dataDir, file.path);
              const fileDir = filePath.substring(0, filePath.lastIndexOf('/'));
              await mkdir(fileDir, { recursive: true });
              await writeFile(filePath, file.content);
            }
          }
          if (serviceData.type === 'static') {
            rootDir = dataDir;
          }
        }

        // (5) Phase 2b D.14: INSERT the services row with Phase 2b
        // service-level columns only. Route-owned columns were dropped;
        // all route state goes through syncPrimaryRouteFromLegacy below.
        db.prepare(`
          INSERT INTO services (
            id, name, kind, runtime, type, target, target_ip, lxc_container_name,
            root_dir, container_name, data_dir, status
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')
        `).run(
          id, serviceData.name, svcKind, svcRuntime,
          serviceData.type || null, serviceData.target || null,
          svcTargetIp, svcLxcName, rootDir || null,
          serviceData.containerName || null, dataDir
        );

        // (6) Mirror the primary route into service_http_routes.
        syncPrimaryRouteFromLegacy(db, id, primaryRoute);

        // (7) INSERT any secondary routes directly.
        for (let i = 1; i < routes.length; i++) {
          const r = routes[i];
          db.prepare(
            `INSERT INTO service_http_routes (
               id, service_id, domain, path_prefix, target_port,
               websocket_enabled, ssl_enabled, force_https, max_upload_size
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
          ).run(
            uuidv4(), id, r.domain, r.pathPrefix, r.targetPort,
            r.websocketEnabled ? 1 : 0,
            r.sslEnabled ? 1 : 0,
            r.forceHttps ? 1 : 0,
            r.maxUploadSize
          );
        }

        // Collect every domain this entry touched for the post-loop
        // merged-file regeneration.
        for (const r of routes) touchedDomains.add(r.domain);

        results.imported.push({
          name: serviceData.name,
          id,
          routeCount: routes.length,
        });
      } catch (err) {
        results.errors.push({ name: serviceData.name, error: err.message });
      }
    }

    // Regenerate merged configs for every domain the import touched. One
    // write per domain is enough even if the import contributed multiple
    // rows to that domain — regenerateDomainCaddyConfig reads all current
    // rows from the DB.
    for (const domain of touchedDomains) {
      try {
        await regenerateDomainCaddyConfig(db, domain);
      } catch (err) {
        console.error(`Failed to regenerate merged config for ${domain} during import:`, err);
        results.errors.push({ name: domain, error: err.message });
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
    // Phase 2b D.14: source existing domains from service_http_routes
    // (legacy services.domain column was dropped).
    const existingDomains = db
      .prepare('SELECT DISTINCT domain FROM service_http_routes')
      .all()
      .map((r) => r.domain);

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
// Phase 2b D.11: a discovered Caddy site becomes one new service with
// exactly one route at `path_prefix='/'`. In addition to writing the
// legacy services columns, the handler now (a) sets the Phase 2b
// service-level fields (`kind`, `runtime`, `target_ip`) by mapping the
// discovered `type` and (b) calls `syncPrimaryRouteFromLegacy` right
// after the INSERT so a matching `service_http_routes` row exists.
// Mirrors the D.2 POST /api/services dual-write strategy.
servicesRouter.post('/discover/import', async (req, res) => {
  try {
    const { domain, name, type, rootDir, target, port, sslEnabled, websocketEnabled } = req.body;

    if (!domain || !name) {
      return res.status(400).json({ error: 'Domain and name are required' });
    }

    const db = getDb();

    // Check if already exists — scan both sources so the pre-D.14
    // transitional state and post-D.14 state both surface the collision.
    let existing = null;
    try {
      existing = db.prepare('SELECT id FROM services WHERE domain = ?').get(domain);
    } catch (e) {
      // Post-D.14 — column gone.
    }
    if (!existing) {
      existing = db
        .prepare('SELECT service_id AS id FROM service_http_routes WHERE domain = ? LIMIT 1')
        .get(domain);
    }
    if (existing) {
      return res.status(400).json({ error: 'Service with this domain already exists' });
    }

    const id = uuidv4();
    let dataDir;
    let actualRootDir = rootDir;

    // For static sites with existing rootDir, use the original path directly
    // This allows file editing and terminal to work with the original location
    if (type === 'static' && rootDir) {
      dataDir = rootDir;
      actualRootDir = rootDir;
      if (!existsSync(rootDir)) {
        await mkdir(rootDir, { recursive: true });
      }
    } else if (type === 'static') {
      const safeDir = toSafeDirectoryName(name);
      dataDir = join(SERVICES_DATA_DIR, safeDir);
      actualRootDir = dataDir;
      await mkdir(dataDir, { recursive: true });
    } else if (type === 'docker') {
      const safeDir = toSafeDirectoryName(name);
      dataDir = join(SERVICES_DATA_DIR, safeDir);
      await mkdir(dataDir, { recursive: true });
    } else {
      const safeDir = toSafeDirectoryName(name);
      dataDir = join(SERVICES_DATA_DIR, safeDir);
    }

    // Phase 2b: infer service-level fields from the discovered `type`.
    const svcKind = type === 'static' ? 'static_site' : 'container_service';
    const svcRuntime = type === 'docker' ? 'docker' : null;
    const svcTargetIp = type === 'static' ? null : target || null;

    // Phase 2b D.14: INSERT Phase 2b service-level columns only. The
    // route-owned columns were dropped — all route state goes via
    // syncPrimaryRouteFromLegacy below.
    db.prepare(`
      INSERT INTO services (
        id, name, kind, runtime, type, target, target_ip,
        root_dir, container_name, data_dir, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')
    `).run(
      id, name, svcKind, svcRuntime, type || null, target || null,
      svcTargetIp, actualRootDir, null, dataDir
    );

    // Phase 2b D.11: mirror the discovered row into service_http_routes
    // as the primary route. If the sync fails (typically a UNIQUE
    // violation from a racing route on the same (domain, /)), delete
    // the services row and return 400.
    try {
      syncPrimaryRouteFromLegacy(db, id, {
        domain,
        pathPrefix: '/',
        targetPort: port || null,
        sslEnabled: !!sslEnabled,
        forceHttps: !!sslEnabled,
        websocketEnabled: !!websocketEnabled,
        maxUploadSize: '1G',
      });
    } catch (routeErr) {
      db.prepare('DELETE FROM services WHERE id = ?').run(id);
      return res.status(400).json({
        error: 'Failed to sync primary route: ' + routeErr.message,
      });
    }

    // Regenerate the merged Caddy config for the imported domain. The DB
    // row + route were inserted just above, so regenerateDomainCaddyConfig
    // reads them plus any sibling services on the same domain and writes
    // a single merged site block.
    try {
      await ensureCaddyStructure();
      await regenerateDomainCaddyConfig(db, domain);

      // Validate and reload Caddy
      await execOnHost(`caddy adapt --config ${CADDY_CONFIG_FILE} > /dev/null 2>&1`);
      await reloadCaddy();
    } catch (caddyError) {
      console.error('Error generating Caddy config for imported site:', caddyError);
      // Don't fail the import, but log the error
    }

    logAudit(
      req.user.id,
      'SERVICE_IMPORTED',
      'service',
      id,
      { service_id: id, domain, type, kind: svcKind, rootDir: actualRootDir },
      req.ip
    );

    res.json({
      success: true,
      service: { id, name, domain, type, kind: svcKind, rootDir: actualRootDir, dataDir },
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

// Emit the per-entry handler body (the `reverse_proxy` / `root` + `file_server`
// lines) without any wrapping site block, `handle_path`, or `handle`. The caller
// decides how to wrap these lines — single-service configs emit them bare inside
// the site block, multi-service (merged) configs wrap each entry's body in its
// own `handle_path ${prefix}*` or `handle` block.
//
// `indent` controls the leading whitespace so the caller can nest the body at the
// appropriate depth (e.g. '    ' for site-level, '        ' for inside a handle).
//
// Phase 2b accepts two input shapes so callers during the Section D transition
// can pass either:
//
//   Legacy (Phase 2) service row:
//     { type: 'static' | 'docker' | 'proxy',
//       target: '127.0.0.1', port: 3000,
//       root_dir or rootDir: '/data/services/foo' }
//
//   Phase 2b joined (service, route) entry:
//     { kind: 'static_site' | 'container_service',
//       target_ip or targetIp: '10.0.0.5',
//       target_port or targetPort: 8000,
//       root_dir or rootDir: '/data/services/foo',
//       type: retained for backward compatibility (optional) }
//
// The function normalizes both shapes into a canonical `{branch, target, port,
// caddyRootDir}` tuple before emitting. `kind` takes precedence over `type` when
// both are present — once D.14 drops the legacy columns, `type` will be gone
// and `kind` will be the only decider.
function generateServiceHandlerBody(entry, indent = '    ') {
  // Field name normalization: accept DB snake_case, JS camelCase, and both
  // Phase 2 legacy (`port`, `target`) and Phase 2b (`target_port`/`targetPort`,
  // `target_ip`/`targetIp`) names.
  const port =
    entry.targetPort !== undefined
      ? entry.targetPort
      : entry.target_port !== undefined
      ? entry.target_port
      : entry.port;
  const target =
    entry.targetIp !== undefined && entry.targetIp !== null
      ? entry.targetIp
      : entry.target_ip !== undefined && entry.target_ip !== null
      ? entry.target_ip
      : entry.target;
  const rootDir =
    entry.rootDir !== undefined ? entry.rootDir : entry.root_dir;

  // Convert container path to host path for Caddy. If rootDir starts with
  // SERVICES_DATA_DIR, rewrite to CADDY_STATIC_ROOT (same translation the
  // single-service path has always done).
  let caddyRootDir = rootDir;
  if (rootDir && rootDir.startsWith(SERVICES_DATA_DIR)) {
    caddyRootDir = rootDir.replace(SERVICES_DATA_DIR, CADDY_STATIC_ROOT);
  }

  // Branch selection: Phase 2b `kind` wins when present; otherwise fall back
  // to legacy `type`. Map `type='static'` to the static-site branch and
  // `type='docker'`/`type='proxy'` to the reverse-proxy branch.
  let branch;
  if (entry.kind === 'static_site') {
    branch = 'static';
  } else if (entry.kind === 'container_service') {
    branch = 'proxy';
  } else if (entry.type === 'static') {
    branch = 'static';
  } else if (entry.type === 'docker' || entry.type === 'proxy') {
    branch = 'proxy';
  } else {
    // Unknown input: emit nothing rather than crash. The caller's outer
    // validation should catch this before we get here.
    branch = 'unknown';
  }

  const lines = [];
  switch (branch) {
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
// Throws when two entries in the list share the same normalized path_prefix
// — defense-in-depth against a UNIQUE-constraint bypass.
//
// Phase 2b: accepts both the legacy Phase 2 service-row shape (where domain/
// path_prefix/port/ssl_* live on the services row) AND the Phase 2b joined
// `(service, route)` entry shape (where those fields live on the route row
// and target_ip lives on the service). The normalize step below reads from
// either field convention. See `generateServiceHandlerBody` for the same
// dual-shape handling at the body-line level.
function buildDomainCaddyConfig(entriesList, domain) {
  if (!entriesList || entriesList.length === 0) return null;

  // Normalize each entry into a consistent shape. Handles:
  //   - DB rows using snake_case (root_dir, max_upload_size, ssl_enabled,
  //     path_prefix, target_ip, target_port)
  //   - JS objects using camelCase (rootDir, maxUploadSize, sslEnabled,
  //     pathPrefix, targetIp, targetPort)
  //   - Legacy Phase 2 rows where target/port live on the service directly
  //     and kind is absent (inferred from type)
  //   - Phase 2b joined rows where target/port come from target_ip/
  //     target_port and kind comes from the service side of the join
  const normalized = entriesList.map((s) => ({
    // Branch selector for generateServiceHandlerBody. kind wins over type
    // when both are set (the A.3 backfill state: legacy rows carry both).
    kind: s.kind,
    type: s.type,
    // Reverse-proxy target: Phase 2b target_ip / targetIp first, then the
    // legacy target field.
    target:
      s.targetIp !== undefined && s.targetIp !== null
        ? s.targetIp
        : s.target_ip !== undefined && s.target_ip !== null
        ? s.target_ip
        : s.target,
    // Reverse-proxy port: Phase 2b target_port / targetPort first, then the
    // legacy port field.
    port:
      s.targetPort !== undefined && s.targetPort !== null
        ? s.targetPort
        : s.target_port !== undefined && s.target_port !== null
        ? s.target_port
        : s.port,
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

  // Friendly label for the header comment. Phase 2b entries carry `kind`
  // (static_site/container_service); legacy Phase 2 entries carry `type`
  // (static/docker/proxy). Prefer the Phase 2b label when available so
  // the comment stays informative once legacy `type` is gone (D.14).
  const entryLabel = (s) => s.kind || s.type || 'unknown';

  const lines = [];
  lines.push(`# ProxyPilot Managed Configuration`);
  lines.push(`# Domain: ${domain}`);
  lines.push(
    `# Services: ${normalized
      .map((s) => `${s.pathPrefix} (${entryLabel(s)})`)
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

// Read every entry for a domain from the DB, build the merged Caddy site
// config, and write it to disk (or unlink the file when no entries remain).
// Callers use this after they have already mutated the DB — the helper is a
// reconciliation step that makes the on-disk Caddy config match DB state.
//
// Admin services are skipped (their config is owned by the installer) so
// running this on the admin domain never clobbers the Caddyfile the operator
// maintains by hand.
//
// Phase 2b dual-source read: walks BOTH the legacy `services` table AND the
// new `service_http_routes` JOIN for this domain, then dedupes by
// `(service_id, path_prefix)` preferring the routes row when both sources
// carry the same tuple.
//
// Why dual-source: during the Section D transition window, some endpoints
// have been refactored to write to `service_http_routes` and others still
// write to the legacy services columns only. Reading from just one source
// would miss data the other source owns. The dedupe rule ensures the
// A.3 backfill state (where every non-admin service has a matching route
// row AND still carries its legacy columns) does not produce duplicated
// handlers in the merged Caddyfile — the routes row wins because it is
// the post-D.14 source of truth.
//
// Post-D.14 the legacy query will return zero rows (columns dropped), so
// this helper collapses cleanly to a single routes-only read path at that
// point without any further code change.
async function regenerateDomainCaddyConfig(db, domain) {
  // (1) Phase 2b routes path — join service_http_routes to services so the
  // emitted entries carry both the route-owned fields (path_prefix,
  // target_port, ssl_enabled, force_https, websocket_enabled, max_upload_size)
  // and the service-owned fields (kind, runtime, type, target_ip, root_dir).
  const routeRows = db
    .prepare(
      `SELECT r.id           AS route_id,
              r.service_id   AS service_id,
              r.domain       AS domain,
              r.path_prefix  AS path_prefix,
              r.target_port  AS target_port,
              r.websocket_enabled,
              r.ssl_enabled,
              r.force_https,
              r.max_upload_size,
              s.name         AS name,
              s.kind         AS kind,
              s.runtime      AS runtime,
              s.type         AS type,
              s.target_ip    AS target_ip,
              s.root_dir     AS root_dir,
              s.container_name,
              s.data_dir,
              s.is_admin
         FROM service_http_routes r
         INNER JOIN services s ON s.id = r.service_id
        WHERE r.domain = ? AND s.is_admin = 0`
    )
    .all(domain);

  // (2) Legacy Phase 2 services path — unchanged from pre-B.3. We wrap the
  // query in a try/catch so the helper survives post-D.14 installs where
  // the legacy columns no longer exist (the SELECT would throw
  // `no such column` and we want to fall through cleanly).
  let legacyRows = [];
  try {
    legacyRows = db
      .prepare(
        `SELECT id           AS service_id,
                name,
                domain,
                type,
                target,
                port,
                root_dir,
                container_name,
                ssl_enabled,
                force_https,
                websocket_enabled,
                max_upload_size,
                data_dir,
                is_admin,
                path_prefix,
                kind,
                target_ip
           FROM services
          WHERE domain = ? AND is_admin = 0`
      )
      .all(domain);
  } catch (e) {
    // Post-D.14: legacy columns dropped → routes-only path.
    legacyRows = [];
  }

  // (3) Dedupe: if `(service_id, path_prefix)` already exists in routeRows,
  // drop the matching legacy row. Routes are the post-D.14 source of truth,
  // so they win in the mixed A.3-backfill state where both sources describe
  // the same tuple.
  const routeTuples = new Set(
    routeRows.map((r) => `${r.service_id}|${normalizePathPrefix(r.path_prefix)}`)
  );
  const legacyOnly = legacyRows.filter((l) => {
    const tuple = `${l.service_id}|${normalizePathPrefix(l.path_prefix)}`;
    return !routeTuples.has(tuple);
  });

  const allRows = [...routeRows, ...legacyOnly];

  const configPath = caddyFilePath(domain);

  // No managed entries left on this domain — remove the merged file so
  // Caddy stops serving it. Swallow ENOENT; nothing to clean up is fine.
  if (!allRows || allRows.length === 0) {
    await unlink(configPath).catch(() => {});
    return;
  }

  // buildDomainCaddyConfig accepts both legacy and Phase 2b shapes (B.2),
  // so the mixed array flows through its normalize step without any
  // per-row branching here.
  const merged = buildDomainCaddyConfig(allRows, domain);
  if (merged === null) {
    await unlink(configPath).catch(() => {});
    return;
  }

  await ensureCaddyStructure();
  await writeCaddyConfig(configPath, merged);
}

// Phase 2b SSL-consistency guard.
//
// Throws when any existing sibling row on the same domain disagrees with
// the candidate's `ssl_enabled` or `force_https` stance. The merged Caddy
// site block has one site address (https vs http://) and one force-https
// stance per domain, so every entry on the domain has to agree.
//
// Scans BOTH sources during the Section D transition window:
//   1. `service_http_routes` JOIN `services` for Phase 2b routes on the
//      same domain (the post-D.14 source of truth)
//   2. The legacy `services` table directly, skipping anything whose
//      `(id, path_prefix)` tuple is already present in the routes query
//      so the A.3 backfill state doesn't trigger a false self-conflict
//
// Admin services are skipped so the installer-managed admin domain can
// keep whatever stance it was configured with without polluting user
// route checks.
//
// Params:
//   - db: sqlite instance
//   - domain: the target domain to check
//   - candidateRoute: { sslEnabled, forceHttps } for the row being
//     inserted/updated
//   - excludeRouteId: optional — the route id being updated, so the
//     update flow does not compare the row against itself. Pass null
//     for create-flow callers.
//
// Throws an `Error` whose `.code === 'ROUTE_SSL_CONFLICT'` and whose
// `.message` names the conflicting sibling's service name + path prefix
// so the caller can surface a helpful error to the operator. Returns
// undefined on success.
export function assertRoutesShareSslStance(
  db,
  domain,
  candidateRoute,
  excludeRouteId = null
) {
  const wantSsl = !!candidateRoute.sslEnabled;
  const wantForce = !!candidateRoute.forceHttps;

  const conflict = (siblingLabel, siblingSsl, siblingForce) => {
    const err = new Error(
      `SSL settings on domain ${domain} must match all sibling routes. ` +
        `Sibling ${siblingLabel} has sslEnabled=${!!siblingSsl}, ` +
        `forceHttps=${!!siblingForce}; candidate has ` +
        `sslEnabled=${wantSsl}, forceHttps=${wantForce}.`
    );
    err.code = 'ROUTE_SSL_CONFLICT';
    return err;
  };

  // (1) Phase 2b siblings from service_http_routes joined to services.
  const routeSiblings = db
    .prepare(
      `SELECT r.id           AS route_id,
              r.service_id   AS service_id,
              r.path_prefix  AS path_prefix,
              r.ssl_enabled  AS ssl_enabled,
              r.force_https  AS force_https,
              s.name         AS service_name
         FROM service_http_routes r
         INNER JOIN services s ON s.id = r.service_id
        WHERE r.domain = ? AND s.is_admin = 0 AND r.id != COALESCE(?, '')`
    )
    .all(domain, excludeRouteId);

  for (const sib of routeSiblings) {
    if (!!sib.ssl_enabled !== wantSsl || !!sib.force_https !== wantForce) {
      throw conflict(
        `"${sib.service_name}" route ${sib.path_prefix}`,
        sib.ssl_enabled,
        sib.force_https
      );
    }
  }

  // (2) Legacy siblings from services table. Skip anything the routes
  // query already covered via (service_id, path_prefix) tuple.
  const coveredTuples = new Set(
    routeSiblings.map(
      (s) => `${s.service_id}|${normalizePathPrefix(s.path_prefix)}`
    )
  );

  let legacySiblings = [];
  try {
    legacySiblings = db
      .prepare(
        `SELECT id AS service_id,
                name AS service_name,
                path_prefix,
                ssl_enabled,
                force_https
           FROM services
          WHERE domain = ? AND is_admin = 0`
      )
      .all(domain);
  } catch (e) {
    // Post-D.14 — legacy columns dropped → routes-only path.
    legacySiblings = [];
  }

  for (const sib of legacySiblings) {
    const tuple = `${sib.service_id}|${normalizePathPrefix(sib.path_prefix)}`;
    if (coveredTuples.has(tuple)) continue;
    if (!!sib.ssl_enabled !== wantSsl || !!sib.force_https !== wantForce) {
      throw conflict(
        `"${sib.service_name}" (legacy path ${sib.path_prefix})`,
        sib.ssl_enabled,
        sib.force_https
      );
    }
  }
}

// Phase 2b D.4/D.5 helper: `assertSiblingsMatchStance(db, domain, serviceId,
// targetSsl, targetForce)`
//
// When an entire service's routes flip SSL on or off at once (the
// obtain-certificate and delete-certificate endpoints), every sibling route
// on the affected domain NOT owned by this service must already match the
// target stance. Unlike `assertRoutesShareSslStance` which excludes a
// single route id, this helper excludes every row owned by `serviceId`
// across both the routes table AND the legacy services table so the
// pre-flip state of the service's own rows never false-conflicts against
// the target. The dual-source scan + (service_id, path_prefix) dedupe
// mirrors `assertRoutesShareSslStance` so post-D.14 (legacy columns gone)
// the legacy query throws and the helper collapses to a routes-only scan.
export function assertSiblingsMatchStance(
  db,
  domain,
  serviceId,
  targetSsl,
  targetForce
) {
  const wantSsl = !!targetSsl;
  const wantForce = !!targetForce;

  const conflict = (siblingLabel, siblingSsl, siblingForce) => {
    const err = new Error(
      `SSL settings on domain ${domain} must match all sibling routes. ` +
        `Sibling ${siblingLabel} has sslEnabled=${!!siblingSsl}, ` +
        `forceHttps=${!!siblingForce}; target is sslEnabled=${wantSsl}, ` +
        `forceHttps=${wantForce}.`
    );
    err.code = 'ROUTE_SSL_CONFLICT';
    return err;
  };

  // (1) Phase 2b sibling routes owned by OTHER services on this domain.
  const routeSiblings = db
    .prepare(
      `SELECT r.id           AS route_id,
              r.service_id   AS service_id,
              r.path_prefix  AS path_prefix,
              r.ssl_enabled  AS ssl_enabled,
              r.force_https  AS force_https,
              s.name         AS service_name
         FROM service_http_routes r
         INNER JOIN services s ON s.id = r.service_id
        WHERE r.domain = ? AND s.is_admin = 0 AND r.service_id != ?`
    )
    .all(domain, serviceId);

  for (const sib of routeSiblings) {
    if (!!sib.ssl_enabled !== wantSsl || !!sib.force_https !== wantForce) {
      throw conflict(
        `"${sib.service_name}" route ${sib.path_prefix}`,
        sib.ssl_enabled,
        sib.force_https
      );
    }
  }

  // (2) Legacy siblings from services table, dedupe against routes-side
  // entries by (service_id, path_prefix) and exclude our own row by id.
  const coveredTuples = new Set(
    routeSiblings.map(
      (s) => `${s.service_id}|${normalizePathPrefix(s.path_prefix)}`
    )
  );

  let legacySiblings = [];
  try {
    legacySiblings = db
      .prepare(
        `SELECT id            AS service_id,
                name          AS service_name,
                path_prefix,
                ssl_enabled,
                force_https
           FROM services
          WHERE domain = ? AND is_admin = 0 AND id != ?`
      )
      .all(domain, serviceId);
  } catch (e) {
    // Post-D.14 — legacy columns dropped → routes-only path.
    legacySiblings = [];
  }

  for (const sib of legacySiblings) {
    const tuple = `${sib.service_id}|${normalizePathPrefix(sib.path_prefix)}`;
    if (coveredTuples.has(tuple)) continue;
    if (!!sib.ssl_enabled !== wantSsl || !!sib.force_https !== wantForce) {
      throw conflict(
        `"${sib.service_name}" (legacy path ${sib.path_prefix})`,
        sib.ssl_enabled,
        sib.force_https
      );
    }
  }
}

// Phase 2 note: the single-service `generateCaddyConfig` function was
// retired — all nine previous call sites now use `regenerateDomainCaddyConfig`
// (DB reconciliation) or `buildDomainCaddyConfig` (pure in-memory builder).
// A single domain can host multiple services on distinct path prefixes, so
// every Caddy write now goes through the merged-config path.

// Named exports for the Phase 2 Caddy helpers. These are kept internal to
// this module at the call-site level but exported so integration tests and
// the Phase 2 verification pass can invoke them directly without spinning
// up the full HTTP router.
export { buildDomainCaddyConfig, regenerateDomainCaddyConfig, generateServiceHandlerBody, syncPrimaryRouteFromLegacy };
