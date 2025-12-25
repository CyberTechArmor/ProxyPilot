import { Router } from 'express';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { exec } from 'child_process';
import { promisify } from 'util';
import { writeFile, unlink, readdir, readFile, mkdir, rm, stat } from 'fs/promises';
import { existsSync } from 'fs';
import { join, basename } from 'path';
import * as OTPAuth from 'otpauth';
import { getDb, logAudit } from '../db.js';

const execAsync = promisify(exec);

export const servicesRouter = Router();

const NGINX_SITES_AVAILABLE = process.env.NGINX_SITES_AVAILABLE || '/etc/nginx/sites-available';
const NGINX_SITES_ENABLED = process.env.NGINX_SITES_ENABLED || '/etc/nginx/sites-enabled';
const SERVICES_DATA_DIR = process.env.SERVICES_DATA_DIR || '/data/services';
// NGINX_STATIC_ROOT is the host path that NGINX uses to serve static files
// This may differ from SERVICES_DATA_DIR when running in Docker
const NGINX_STATIC_ROOT = process.env.NGINX_STATIC_ROOT || SERVICES_DATA_DIR;

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

// Helper to create safe directory name from service name
function toSafeDirectoryName(name) {
  return name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
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

// Helper function to reload or start NGINX (executes on host)
async function reloadNginx() {
  try {
    // Test NGINX configuration first (on host)
    const testResult = await execOnHost('nginx -t 2>&1');
    console.log('NGINX test output:', testResult.stdout, testResult.stderr);

    // Check if NGINX master process is running (more reliable than pgrep -x)
    let nginxRunning = false;
    let nginxPid = null;
    try {
      // Check for nginx.pid file first (most reliable)
      const pidResult = await execOnHost('cat /var/run/nginx.pid 2>/dev/null || cat /run/nginx.pid 2>/dev/null');
      nginxPid = pidResult.stdout.trim();
      if (nginxPid) {
        // Verify the process actually exists
        await execOnHost(`kill -0 ${nginxPid} 2>/dev/null`);
        nginxRunning = true;
      }
    } catch (e) {
      // PID file doesn't exist or process isn't running, try pgrep
      try {
        const pgrepResult = await execOnHost('pgrep -o nginx 2>/dev/null');
        if (pgrepResult.stdout.trim()) {
          nginxRunning = true;
        }
      } catch (e2) {
        nginxRunning = false;
      }
    }

    if (nginxRunning) {
      // Reload NGINX using the most reliable method
      console.log('NGINX is running, reloading...');
      try {
        await execOnHost('nginx -s reload 2>&1');
        console.log('NGINX reloaded via signal');
      } catch (reloadErr) {
        // Try systemctl as fallback
        await execOnHost('systemctl reload nginx 2>&1');
        console.log('NGINX reloaded via systemctl');
      }
    } else {
      // NGINX not running - clean up any stale processes/pid files before starting
      console.log('NGINX not running, cleaning up and starting...');

      // Kill any orphaned nginx processes that might be holding ports
      try {
        await execOnHost('pkill -9 nginx 2>/dev/null || true');
        // Small delay to ensure ports are released
        await new Promise(resolve => setTimeout(resolve, 500));
      } catch (e) {
        // Ignore - no processes to kill
      }

      // Remove stale PID files
      try {
        await execOnHost('rm -f /var/run/nginx.pid /run/nginx.pid 2>/dev/null || true');
      } catch (e) {
        // Ignore
      }

      // Start NGINX
      try {
        await execOnHost('systemctl start nginx 2>&1');
        console.log('NGINX started via systemctl');
      } catch (startErr) {
        // Systemctl failed, try direct start
        await execOnHost('nginx 2>&1');
        console.log('NGINX started directly');
      }
    }

    return { success: true };
  } catch (error) {
    // Extract the actual error message from stderr or stdout
    const errorOutput = error.stderr || error.stdout || error.message;
    console.error('NGINX reload/start failed:', errorOutput);
    return { success: false, error: errorOutput };
  }
}

// Check if certbot is installed (on host)
async function isCertbotInstalled() {
  try {
    await execOnHost('which certbot 2>/dev/null || command -v certbot 2>/dev/null');
    return true;
  } catch (e) {
    return false;
  }
}

// Helper function to obtain SSL certificate using certbot (on host)
async function obtainSslCertificate(domain) {
  try {
    // Check if certbot is installed on host
    const certbotAvailable = await isCertbotInstalled();
    if (!certbotAvailable) {
      return {
        success: false,
        error: 'Certbot is not installed on the host. Install it with: apt install certbot (Debian/Ubuntu) or yum install certbot (RHEL/CentOS)',
        certbotMissing: true,
      };
    }

    // Create letsencrypt webroot directory on host if it doesn't exist
    await execOnHost('mkdir -p /var/www/letsencrypt/.well-known/acme-challenge');

    // Run certbot on host in non-interactive mode
    const certbotCmd = `certbot certonly --webroot -w /var/www/letsencrypt -d ${domain} --non-interactive --agree-tos --register-unsafely-without-email 2>&1`;
    console.log('Running certbot on host:', certbotCmd);
    const result = await execOnHost(certbotCmd, { timeout: 120000 }); // 2 minute timeout
    console.log('Certbot output:', result.stdout, result.stderr);

    // Check if certificate was obtained
    if (sslCertExists(domain)) {
      return { success: true, message: 'SSL certificate obtained successfully' };
    } else {
      return { success: false, error: 'Certificate files not found after certbot' };
    }
  } catch (error) {
    const errorOutput = error.stderr || error.stdout || error.message;
    console.error('Certbot failed:', errorOutput);
    return { success: false, error: errorOutput };
  }
}

// Obtain SSL certificate for a service
servicesRouter.post('/:id/obtain-certificate', async (req, res) => {
  try {
    const db = getDb();
    const service = db.prepare('SELECT * FROM services WHERE id = ?').get(req.params.id);

    if (!service) {
      return res.status(404).json({ error: 'Service not found' });
    }

    // Check if certificate already exists
    if (sslCertExists(service.domain)) {
      return res.json({
        success: true,
        message: 'SSL certificate already exists',
        alreadyExists: true,
      });
    }

    // Obtain certificate
    const certResult = await obtainSslCertificate(service.domain);

    if (certResult.success) {
      // Regenerate NGINX config now that we have certificates
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

      const nginxConfig = generateNginxConfig(serviceConfig);
      const configPath = `${NGINX_SITES_AVAILABLE}/${service.domain}`;
      await writeFile(configPath, nginxConfig);

      // Reload NGINX
      const reloadResult = await reloadNginx();

      logAudit(req.user.id, 'SSL_CERTIFICATE_OBTAINED', 'service', req.params.id, { domain: service.domain }, req.ip);

      res.json({
        success: true,
        message: 'SSL certificate obtained and NGINX configured',
        nginxReloaded: reloadResult.success,
        nginxError: reloadResult.error,
      });
    } else {
      res.status(500).json({
        success: false,
        error: 'Failed to obtain certificate: ' + certResult.error,
      });
    }
  } catch (error) {
    console.error('Error obtaining certificate:', error);
    res.status(500).json({ error: 'Failed to obtain certificate: ' + error.message });
  }
});

// Remove SSL certificate for a service (requires TOTP)
servicesRouter.delete('/:id/certificate', async (req, res) => {
  try {
    const { totpCode } = deleteServiceSchema.parse(req.body);
    const db = getDb();

    const service = db.prepare('SELECT * FROM services WHERE id = ?').get(req.params.id);
    if (!service) {
      return res.status(404).json({ error: 'Service not found' });
    }

    // Check if certificate exists
    if (!sslCertExists(service.domain)) {
      return res.status(400).json({ error: 'No SSL certificate found for this domain' });
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

    // Remove certificate using certbot on host
    try {
      await execOnHost(`certbot delete --cert-name ${service.domain} --non-interactive 2>&1`);
    } catch (certbotError) {
      // If certbot delete fails, try manual removal on host
      const certDir = `/etc/letsencrypt/live/${service.domain}`;
      const renewalConf = `/etc/letsencrypt/renewal/${service.domain}.conf`;
      const archiveDir = `/etc/letsencrypt/archive/${service.domain}`;

      await execOnHost(`rm -rf ${certDir} 2>/dev/null || true`).catch(() => {});
      await execOnHost(`rm -f ${renewalConf} 2>/dev/null || true`).catch(() => {});
      await execOnHost(`rm -rf ${archiveDir} 2>/dev/null || true`).catch(() => {});
    }

    // Regenerate NGINX config without HTTPS
    const serviceConfig = {
      domain: service.domain,
      type: service.type,
      target: service.target,
      port: service.port,
      rootDir: service.root_dir,
      websocketEnabled: !!service.websocket_enabled,
      forceHttps: false, // Can't force HTTPS without cert
      maxUploadSize: service.max_upload_size,
      sslEnabled: false, // Disable SSL since cert is removed
    };

    const nginxConfig = generateNginxConfig(serviceConfig);
    const configPath = `${NGINX_SITES_AVAILABLE}/${service.domain}`;
    await writeFile(configPath, nginxConfig);

    // Reload NGINX
    const reloadResult = await reloadNginx();

    logAudit(req.user.id, 'SSL_CERTIFICATE_REMOVED', 'service', req.params.id, { domain: service.domain }, req.ip);

    res.json({
      success: true,
      message: 'SSL certificate removed and NGINX reconfigured',
      nginxReloaded: reloadResult.success,
      nginxError: reloadResult.error,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: error.errors[0].message });
    }
    console.error('Error removing certificate:', error);
    res.status(500).json({ error: 'Failed to remove certificate: ' + error.message });
  }
});

// Check SSL certificate status for a domain
servicesRouter.get('/ssl-status/:domain', async (req, res) => {
  try {
    const domain = req.params.domain;
    const exists = sslCertExists(domain);
    const certPath = `/etc/letsencrypt/live/${domain}/fullchain.pem`;
    const certbotInstalled = await isCertbotInstalled();

    res.json({
      domain,
      certificateExists: exists,
      certificatePath: certPath,
      certbotInstalled,
      command: exists ? null : `certbot certonly --webroot -w /var/www/letsencrypt -d ${domain}`,
      installCertbotCommand: certbotInstalled ? null : 'apt install certbot (Debian/Ubuntu) or yum install certbot (RHEL/CentOS)',
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to check SSL status' });
  }
});

// Check system requirements (certbot, etc.)
servicesRouter.get('/system-check', async (req, res) => {
  try {
    const certbotInstalled = await isCertbotInstalled();

    res.json({
      certbotInstalled,
      installInstructions: certbotInstalled ? null : {
        debian: 'sudo apt install certbot',
        rhel: 'sudo yum install certbot',
        alpine: 'sudo apk add certbot',
      },
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to check system' });
  }
});

// Regenerate NGINX config for a service (useful after obtaining SSL certificates)
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

    // Generate and write new NGINX config
    const nginxConfig = generateNginxConfig(serviceConfig);
    const configPath = `${NGINX_SITES_AVAILABLE}/${service.domain}`;
    await writeFile(configPath, nginxConfig);

    // Test and reload NGINX
    const reloadResult = await reloadNginx();

    const sslStatus = service.ssl_enabled && sslCertExists(service.domain);

    logAudit(req.user.id, 'CONFIG_REGENERATED', 'service', req.params.id, { sslStatus }, req.ip);

    res.json({
      success: true,
      message: reloadResult.success ? 'Configuration regenerated and NGINX reloaded' : 'Configuration regenerated but NGINX reload failed',
      sslCertificateExists: sslStatus,
      nginxReloaded: reloadResult.success,
      nginxError: reloadResult.error,
    });
  } catch (error) {
    console.error('Error regenerating config:', error);
    res.status(500).json({ error: 'Failed to regenerate config: ' + error.message });
  }
});

// Regenerate all NGINX configs
servicesRouter.post('/nginx/regenerate-all', async (req, res) => {
  try {
    const db = getDb();
    const services = db.prepare('SELECT * FROM services').all();

    const results = { success: [], failed: [] };

    for (const service of services) {
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

        const nginxConfig = generateNginxConfig(serviceConfig);
        const configPath = `${NGINX_SITES_AVAILABLE}/${service.domain}`;
        await writeFile(configPath, nginxConfig);

        // Ensure symlink exists
        const enabledPath = `${NGINX_SITES_ENABLED}/${service.domain}`;
        await execAsync(`ln -sf "${configPath}" "${enabledPath}"`).catch(() => {});

        results.success.push(service.domain);
      } catch (err) {
        results.failed.push({ domain: service.domain, error: err.message });
      }
    }

    // Reload NGINX
    const reloadResult = await reloadNginx();

    logAudit(req.user.id, 'NGINX_CONFIGS_REGENERATED', 'system', null, results, req.ip);

    res.json({
      success: true,
      results,
      nginxReloaded: reloadResult.success,
      nginxError: reloadResult.error,
    });
  } catch (error) {
    console.error('Error regenerating all configs:', error);
    res.status(500).json({ error: 'Failed to regenerate configs: ' + error.message });
  }
});

// NGINX reload endpoint
servicesRouter.post('/nginx/reload', async (req, res) => {
  try {
    const result = await reloadNginx();
    if (result.success) {
      logAudit(req.user.id, 'NGINX_RELOADED', 'system', null, {}, req.ip);
      res.json({ success: true, message: 'NGINX reloaded successfully' });
    } else {
      // Parse NGINX error output for more readable message
      let errorMessage = result.error || 'Unknown error';
      // Extract key error info if present
      const errorMatch = errorMessage.match(/nginx:.*error.*|emerg\].*|syntax error.*/i);
      if (errorMatch) {
        errorMessage = errorMatch[0];
      }
      res.status(500).json({
        error: `NGINX reload failed: ${errorMessage}`,
        details: result.error
      });
    }
  } catch (error) {
    console.error('Error reloading NGINX:', error);
    res.status(500).json({ error: 'Failed to reload NGINX: ' + error.message });
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

    // Convert integer booleans to actual booleans and check SSL cert status
    const formattedServices = services.map(s => ({
      ...s,
      sslEnabled: !!s.sslEnabled,
      forceHttps: !!s.forceHttps,
      websocketEnabled: !!s.websocketEnabled,
      isAdmin: !!s.isAdmin,
      isFavorite: !!s.isFavorite,
      sslCertificateExists: s.sslEnabled ? sslCertExists(s.domain) : null,
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
    <title>${data.name}</title>
    <style>
        body { font-family: system-ui, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: #f5f5f5; }
        .container { text-align: center; padding: 2rem; }
        h1 { color: #333; }
        p { color: #666; }
    </style>
</head>
<body>
    <div class="container">
        <h1>Welcome to ${data.name}</h1>
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
        await writeFile(join(dataDir, 'html', 'index.html'), `<h1>${data.name}</h1>`);
      }
      // Set target to localhost
      data.target = data.target || '127.0.0.1';
    }

    // Generate NGINX config
    const nginxConfig = generateNginxConfig(data);

    // Write NGINX config file
    const configPath = `${NGINX_SITES_AVAILABLE}/${data.domain}`;
    await writeFile(configPath, nginxConfig);

    // Enable the site
    const enabledPath = `${NGINX_SITES_ENABLED}/${data.domain}`;
    await execAsync(`ln -sf "${configPath}" "${enabledPath}"`);

    // Test NGINX config
    try {
      await execAsync('nginx -t 2>&1');
    } catch (testErr) {
      // Rollback
      await unlink(enabledPath).catch(() => {});
      await unlink(configPath).catch(() => {});
      return res.status(400).json({ error: 'Invalid NGINX configuration generated: ' + testErr.message });
    }

    // Reload/start NGINX
    const nginxResult = await reloadNginx();

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

    // Check if we should obtain SSL certificate
    let sslCertificateExists = data.sslEnabled && sslCertExists(data.domain);
    let sslMessage = null;
    let certObtained = false;

    if (data.sslEnabled && data.obtainCertificate && !sslCertificateExists) {
      // Try to obtain certificate
      const certResult = await obtainSslCertificate(data.domain);
      if (certResult.success) {
        certObtained = true;
        sslCertificateExists = true;

        // Regenerate NGINX config with SSL now that we have certificates
        const updatedNginxConfig = generateNginxConfig(data);
        await writeFile(configPath, updatedNginxConfig);
        await reloadNginx();

        sslMessage = 'SSL certificate obtained and configured successfully';
      } else {
        sslMessage = `Failed to obtain certificate: ${certResult.error}`;
      }
    } else if (data.sslEnabled && !sslCertificateExists) {
      sslMessage = `SSL enabled but certificate not found. Run: certbot certonly --webroot -w /var/www/letsencrypt -d ${data.domain}`;
    }

    res.status(201).json({
      success: true,
      service: { id, ...data, dataDir },
      sslCertificateExists,
      sslMessage,
      certObtained,
      nginxReloaded: nginxResult.success,
      nginxError: nginxResult.error,
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
      containerName: data.containerName !== undefined ? data.containerName : service.container_name,
      sslEnabled: data.sslEnabled !== undefined ? data.sslEnabled : !!service.ssl_enabled,
      forceHttps: data.forceHttps !== undefined ? data.forceHttps : !!service.force_https,
      websocketEnabled: data.websocketEnabled !== undefined ? data.websocketEnabled : !!service.websocket_enabled,
      maxUploadSize: data.maxUploadSize || service.max_upload_size,
    };

    // Remove old NGINX config if domain changed
    if (data.domain && data.domain !== service.domain) {
      await unlink(`${NGINX_SITES_ENABLED}/${service.domain}`).catch(() => {});
      await unlink(`${NGINX_SITES_AVAILABLE}/${service.domain}`).catch(() => {});
    }

    // Generate and write new NGINX config
    const nginxConfig = generateNginxConfig(updatedData);
    const configPath = `${NGINX_SITES_AVAILABLE}/${updatedData.domain}`;
    await writeFile(configPath, nginxConfig);

    const enabledPath = `${NGINX_SITES_ENABLED}/${updatedData.domain}`;
    await execAsync(`ln -sf "${configPath}" "${enabledPath}"`);

    // Test and reload NGINX
    await execAsync('nginx -t');
    await execAsync('systemctl reload nginx || nginx -s reload').catch(() => {});

    // Update database
    db.prepare(`
      UPDATE services SET
        name = ?, domain = ?, type = ?, target = ?, port = ?,
        root_dir = ?, container_name = ?, ssl_enabled = ?,
        force_https = ?, websocket_enabled = ?, max_upload_size = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      updatedData.name, updatedData.domain, updatedData.type,
      updatedData.target, updatedData.port, updatedData.rootDir,
      updatedData.containerName, updatedData.sslEnabled ? 1 : 0,
      updatedData.forceHttps ? 1 : 0, updatedData.websocketEnabled ? 1 : 0,
      updatedData.maxUploadSize, req.params.id
    );

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

    // Remove NGINX config
    await unlink(`${NGINX_SITES_ENABLED}/${service.domain}`).catch(() => {});
    await unlink(`${NGINX_SITES_AVAILABLE}/${service.domain}`).catch(() => {});

    // Reload NGINX
    await execAsync('systemctl reload nginx || nginx -s reload').catch(() => {});

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

// Get Docker containers
servicesRouter.get('/docker/containers', async (req, res) => {
  try {
    const { stdout } = await execAsync('docker ps -a --format "{{.ID}}|{{.Names}}|{{.Ports}}|{{.Status}}"');
    const containers = stdout.trim().split('\n').filter(Boolean).map(line => {
      const [id, name, ports, status] = line.split('|');
      return { id, name, ports, status };
    });
    res.json({ containers });
  } catch (error) {
    console.error('Error fetching containers:', error);
    res.json({ containers: [], error: 'Failed to fetch Docker containers' });
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
    const fullPath = join(service.data_dir, filePath);

    // Security: ensure path is within data_dir
    if (!fullPath.startsWith(service.data_dir)) {
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
    const fullPath = join(service.data_dir, filePath);

    // Security: ensure path is within data_dir
    if (!fullPath.startsWith(service.data_dir)) {
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

    // Auto-reload NGINX for static sites
    let nginxReloaded = false;
    if (service.type === 'static') {
      const reloadResult = await reloadNginx();
      nginxReloaded = reloadResult.success;
    }

    res.json({ success: true, path: filePath, nginxReloaded });
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
    const fullPath = join(service.data_dir, filePath);

    // Security: ensure path is within data_dir
    if (!fullPath.startsWith(service.data_dir)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Prevent deleting root directory
    if (fullPath === service.data_dir) {
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

    // Reload NGINX for static sites
    let nginxReloaded = false;
    if (version.type === 'static') {
      const reloadResult = await reloadNginx();
      nginxReloaded = reloadResult.success;
    }

    res.json({ success: true, revertedToVersion: version.version, nginxReloaded });
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
    const fullPath = join(service.data_dir, filePath);

    // Security check
    if (!fullPath.startsWith(service.data_dir)) {
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
    const fullPath = join(service.data_dir, filePath);

    // Security check
    if (!fullPath.startsWith(service.data_dir)) {
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
        const fullPath = join(service.data_dir, file.path);

        // Security check
        if (!fullPath.startsWith(service.data_dir)) {
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

    // Reload NGINX for static sites
    if (service.type === 'static' && results.imported.length > 0) {
      await reloadNginx();
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
          await unlink(`${NGINX_SITES_ENABLED}/${serviceData.domain}`).catch(() => {});
          await unlink(`${NGINX_SITES_AVAILABLE}/${serviceData.domain}`).catch(() => {});
          db.prepare('DELETE FROM services WHERE id = ?').run(existing.id);
        }

        // Create the service
        const id = uuidv4();
        const safeDir = toSafeDirectoryName(serviceData.name);
        const dataDir = join(SERVICES_DATA_DIR, safeDir);

        // Create directory
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

        // Set rootDir for static sites
        if (serviceData.type === 'static') {
          serviceData.rootDir = dataDir;
        }

        // Generate NGINX config
        const nginxConfig = generateNginxConfig(serviceData);
        const configPath = `${NGINX_SITES_AVAILABLE}/${serviceData.domain}`;
        await writeFile(configPath, nginxConfig);

        const enabledPath = `${NGINX_SITES_ENABLED}/${serviceData.domain}`;
        await execAsync(`ln -sf "${configPath}" "${enabledPath}"`);

        // Insert into database
        db.prepare(`
          INSERT INTO services (
            id, name, domain, type, target, port, root_dir, container_name,
            ssl_enabled, force_https, websocket_enabled, max_upload_size, data_dir, status
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')
        `).run(
          id, serviceData.name, serviceData.domain, serviceData.type,
          serviceData.target || null, serviceData.port || null,
          serviceData.rootDir || null, serviceData.containerName || null,
          serviceData.sslEnabled ? 1 : 0, serviceData.forceHttps ? 1 : 0,
          serviceData.websocketEnabled ? 1 : 0, serviceData.maxUploadSize || '1G',
          dataDir
        );

        results.imported.push({ name: serviceData.name, id });
      } catch (err) {
        results.errors.push({ name: serviceData.name, error: err.message });
      }
    }

    // Reload NGINX
    await execAsync('nginx -t && (systemctl reload nginx || nginx -s reload)').catch(() => {});

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

// Execute command on host (requires TOTP for destructive commands)
servicesRouter.post('/terminal/execute', async (req, res) => {
  try {
    const { command, workingDir, timeout } = terminalSchema.parse(req.body);

    // Check for blocked commands
    if (isCommandBlocked(command)) {
      return res.status(403).json({
        error: 'This command is blocked for security reasons',
        output: '',
        exitCode: 1,
      });
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

servicesRouter.post('/terminal/write-file', async (req, res) => {
  try {
    const { filePath, content, createDirs } = fileWriteSchema.parse(req.body);

    // Security: prevent writing to dangerous paths
    const dangerousPaths = ['/etc/passwd', '/etc/shadow', '/etc/sudoers', '/root/.ssh/authorized_keys'];
    if (dangerousPaths.some(p => filePath.includes(p))) {
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

// Get system info
servicesRouter.get('/terminal/system-info', async (req, res) => {
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

    const validActions = ['start', 'stop', 'restart', 'pause', 'unpause'];
    if (!validActions.includes(action)) {
      return res.status(400).json({ error: 'Invalid action' });
    }

    const result = await execOnHost(`docker ${action} ${target} 2>&1`);

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

    let cmd = `docker compose -f ${JSON.stringify(path)}`;

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

    let cmd = `docker compose -f ${JSON.stringify(path)} down`;
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

// Get real-time system stats (CPU, RAM, Network, Disk)
servicesRouter.get('/system/stats', async (req, res) => {
  try {
    // Execute multiple commands to gather system stats
    const commands = {
      // CPU usage - get overall CPU usage percentage
      cpu: `top -bn1 | grep "Cpu(s)" | awk '{print 100 - $8}' 2>/dev/null || echo "0"`,
      // Memory usage
      memory: `free -b | awk '/^Mem:/ {printf "%.0f %.0f %.0f %.0f", $2, $3, $4, $7}'`,
      // Disk usage
      disk: `df -B1 / | awk 'NR==2 {printf "%.0f %.0f %.0f", $2, $3, $4}'`,
      // Network stats (bytes in/out) - use first non-lo interface
      network: `cat /proc/net/dev | awk 'NR>2 && $1 !~ /lo:/ {gsub(":","",$1); rx+=$2; tx+=$10} END {printf "%.0f %.0f", rx, tx}'`,
      // Load average
      load: `cat /proc/loadavg | awk '{print $1, $2, $3}'`,
      // Uptime in seconds
      uptime: `cat /proc/uptime | awk '{print $1}'`,
    };

    const results = {};

    for (const [key, cmd] of Object.entries(commands)) {
      try {
        const result = await execOnHost(cmd);
        results[key] = result.stdout.trim();
      } catch (e) {
        results[key] = '';
      }
    }

    // Parse the results
    const [memTotal, memUsed, memFree, memAvailable] = results.memory.split(' ').map(Number);
    const [diskTotal, diskUsed, diskFree] = results.disk.split(' ').map(Number);
    const [netRx, netTx] = results.network.split(' ').map(Number);
    const [load1, load5, load15] = results.load.split(' ').map(Number);

    const stats = {
      cpu: {
        usage: parseFloat(results.cpu) || 0,
      },
      memory: {
        total: memTotal || 0,
        used: memUsed || 0,
        free: memFree || 0,
        available: memAvailable || 0,
        usagePercent: memTotal ? ((memUsed / memTotal) * 100).toFixed(1) : 0,
      },
      disk: {
        total: diskTotal || 0,
        used: diskUsed || 0,
        free: diskFree || 0,
        usagePercent: diskTotal ? ((diskUsed / diskTotal) * 100).toFixed(1) : 0,
      },
      network: {
        bytesReceived: netRx || 0,
        bytesSent: netTx || 0,
      },
      load: {
        avg1: load1 || 0,
        avg5: load5 || 0,
        avg15: load15 || 0,
      },
      uptime: parseFloat(results.uptime) || 0,
      timestamp: Date.now(),
    };

    res.json({ success: true, stats });
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

// Discover existing NGINX sites from sites-available
servicesRouter.get('/discover/nginx-sites', async (req, res) => {
  try {
    const db = getDb();
    const existingDomains = db.prepare('SELECT domain FROM services').all().map(s => s.domain);

    const discoveredSites = [];

    // Use execOnHost to read from host filesystem when running in Docker
    const sitesDir = NGINX_SITES_AVAILABLE;

    // Get list of files in sites-available
    let files = [];
    try {
      if (isInDocker) {
        const result = await execOnHost(`ls -1 ${JSON.stringify(sitesDir)} 2>/dev/null || echo ""`);
        files = result.stdout.trim().split('\n').filter(Boolean);
      } else if (existsSync(sitesDir)) {
        files = await readdir(sitesDir);
      }
    } catch (e) {
      console.log('Could not read sites-available directory:', e.message);
    }

    console.log(`NGINX discovery found ${files.length} files in ${sitesDir}`);

    for (const file of files) {
      if (file === 'default' || file === '.' || file === '..') continue; // Skip default site

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

        // Extract domain from server_name directive
        const serverNameMatch = content.match(/server_name\s+([^\s;]+)/);
        const domain = serverNameMatch ? serverNameMatch[1] : file;

        // Skip if already in database
        if (existingDomains.includes(domain)) continue;

        // Determine type based on config content
        let type = 'static';
        let rootDir = null;
        let port = null;
        let target = null;

        // Check for proxy_pass (indicates docker/proxy type)
        const proxyMatch = content.match(/proxy_pass\s+http:\/\/([^:\/]+):?(\d+)?/);
        if (proxyMatch) {
          type = 'docker';
          target = proxyMatch[1] || '127.0.0.1';
          port = proxyMatch[2] ? parseInt(proxyMatch[2], 10) : 80;
        }

        // Check for root directive (static site)
        const rootMatch = content.match(/root\s+([^;]+);/);
        if (rootMatch && type === 'static') {
          rootDir = rootMatch[1].trim();
        }

        // Check for SSL
        const sslEnabled = content.includes('ssl_certificate') || content.includes('listen 443');

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
          name: domain.split('.')[0], // Use first part of domain as name
          type,
          rootDir,
          target,
          port,
          sslEnabled,
          hasIndexHtml,
          configFile: file,
        });
      } catch (e) {
        console.log(`Could not parse ${file}:`, e.message);
      }
    }

    console.log(`Returning ${discoveredSites.length} discovered NGINX sites`);
    res.json({ sites: discoveredSites });
  } catch (error) {
    console.error('Error discovering sites:', error);
    res.status(500).json({ error: 'Failed to discover sites: ' + error.message });
  }
});

// Import a discovered NGINX site
servicesRouter.post('/discover/import', async (req, res) => {
  try {
    const { domain, name, type, rootDir, target, port, sslEnabled } = req.body;

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
    const safeDir = toSafeDirectoryName(name);
    let dataDir = join(SERVICES_DATA_DIR, safeDir);
    let actualRootDir = rootDir;

    // For static sites, copy files to our data directory if they exist elsewhere
    if (type === 'static' && rootDir && rootDir !== dataDir) {
      await mkdir(dataDir, { recursive: true });

      // Copy index.html if it exists
      const sourceIndex = join(rootDir, 'index.html');
      if (existsSync(sourceIndex)) {
        const content = await readFile(sourceIndex, 'utf-8');
        await writeFile(join(dataDir, 'index.html'), content);

        // Save as version 1
        db.prepare(`
          INSERT INTO file_versions (id, service_id, file_path, content, version, notes, created_by)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(uuidv4(), id, 'index.html', content, 1, 'Imported from existing site', req.user.id);
      }

      // Update root dir to our managed location
      actualRootDir = dataDir;

      // Regenerate NGINX config with new root
      const nginxConfig = generateNginxConfig({
        domain,
        type,
        rootDir: dataDir,
        target,
        port,
        sslEnabled,
        forceHttps: sslEnabled,
        websocketEnabled: false,
        maxUploadSize: '1G',
      });

      await writeFile(join(NGINX_SITES_AVAILABLE, domain), nginxConfig);
      await reloadNginx();
    } else if (type === 'static') {
      // Create data dir and link to existing root
      await mkdir(dataDir, { recursive: true });
      actualRootDir = rootDir || dataDir;
    }

    // Insert into database
    db.prepare(`
      INSERT INTO services (
        id, name, domain, type, target, port, root_dir, container_name,
        ssl_enabled, force_https, websocket_enabled, max_upload_size, data_dir, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')
    `).run(
      id, name, domain, type, target || null, port || null,
      actualRootDir, null, sslEnabled ? 1 : 0, sslEnabled ? 1 : 0,
      0, '1G', dataDir
    );

    logAudit(req.user.id, 'SERVICE_IMPORTED', 'service', id, { domain, type }, req.ip);

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

      if (projectName) {
        if (!composeProjects[projectName]) {
          composeProjects[projectName] = {
            projectName,
            composeFile,
            services: [],
          };
        }

        composeProjects[projectName].services.push({
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

      // Include container if it has compose labels OR has exposed ports
      if (projectName || exposedPort) {
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
    }

    console.log(`Returning ${services.length} docker compose services`);
    res.json({ services });
  } catch (error) {
    console.error('Error getting docker compose services:', error);
    res.status(500).json({ error: 'Failed to get docker compose services: ' + error.message, services: [] });
  }
});

// Check if SSL certificate exists for a domain
function sslCertExists(domain) {
  const certPath = `/etc/letsencrypt/live/${domain}/fullchain.pem`;
  const keyPath = `/etc/letsencrypt/live/${domain}/privkey.pem`;
  return existsSync(certPath) && existsSync(keyPath);
}

// Generate NGINX config based on service type
function generateNginxConfig(service) {
  const { domain, type, target, port, rootDir, websocketEnabled, forceHttps, maxUploadSize, sslEnabled } = service;

  // Check if SSL certificates actually exist
  const certsExist = sslEnabled && sslCertExists(domain);
  // Only force HTTPS redirect if SSL is enabled AND certificates exist
  const actualForceHttps = forceHttps && certsExist;

  // Convert container path to host path for NGINX
  // If rootDir starts with SERVICES_DATA_DIR, replace with NGINX_STATIC_ROOT
  let nginxRootDir = rootDir;
  if (rootDir && rootDir.startsWith(SERVICES_DATA_DIR)) {
    nginxRootDir = rootDir.replace(SERVICES_DATA_DIR, NGINX_STATIC_ROOT);
  }

  let locationBlock = '';
  let rootBlock = '';

  switch (type) {
    case 'docker':
      const wsConfig = websocketEnabled ? `
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";` : `
        proxy_http_version 1.1;`;

      locationBlock = `
    location / {${wsConfig}
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 300;
        proxy_connect_timeout 60;
        proxy_send_timeout 300;
        proxy_buffering off;
        proxy_pass http://${target || '127.0.0.1'}:${port};
    }`;
      break;

    case 'static':
      rootBlock = `
    root ${nginxRootDir};
    index index.html index.htm;`;
      locationBlock = `
    location / {
        try_files $uri $uri/ /index.html;
    }`;
      break;
  }

  const httpBlock = actualForceHttps
    ? `
server {
    listen 80;
    listen [::]:80;
    server_name ${domain};

    location ^~ /.well-known/acme-challenge/ {
        root /var/www/letsencrypt;
        default_type "text/plain";
    }

    location / {
        return 301 https://$host$request_uri;
    }
}`
    : `
server {
    listen 80;
    listen [::]:80;
    server_name ${domain};
    client_max_body_size ${maxUploadSize};${rootBlock}

    location ^~ /.well-known/acme-challenge/ {
        root /var/www/letsencrypt;
        default_type "text/plain";
    }
${locationBlock}
}`;

  // Only include HTTPS block if certificates exist
  const httpsBlock = certsExist ? `

server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name ${domain};
    client_max_body_size ${maxUploadSize};${rootBlock}

    ssl_certificate /etc/letsencrypt/live/${domain}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${domain}/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;

    # Security headers
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-XSS-Protection "1; mode=block" always;
${locationBlock}
}` : '';

  // Add comment about SSL status
  const sslComment = sslEnabled && !certsExist
    ? `# SSL: Enabled but certificates not found - run: certbot certonly --webroot -w /var/www/letsencrypt -d ${domain}\n`
    : '';

  return `# ProxyPilot Managed Configuration
# Domain: ${domain}
# Type: ${type}
# Generated: ${new Date().toISOString()}
${sslComment}${httpBlock}${httpsBlock}
`;
}
