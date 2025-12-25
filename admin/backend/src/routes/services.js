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
});

const deleteServiceSchema = z.object({
  totpCode: z.string().length(6, 'TOTP code must be 6 digits'),
});

const fileSchema = z.object({
  filename: z.string().min(1).max(255).regex(/^[a-zA-Z0-9._-]+$/, 'Invalid filename'),
  content: z.string().max(10 * 1024 * 1024), // 10MB max
});

// Helper function to reload NGINX
async function reloadNginx() {
  try {
    // Test NGINX configuration first
    const testResult = await execAsync('nginx -t 2>&1');
    console.log('NGINX test output:', testResult.stdout, testResult.stderr);

    // Reload NGINX
    const reloadResult = await execAsync('systemctl reload nginx 2>&1 || nginx -s reload 2>&1');
    console.log('NGINX reload output:', reloadResult.stdout, reloadResult.stderr);

    return { success: true };
  } catch (error) {
    // Extract the actual error message from stderr or stdout
    const errorOutput = error.stderr || error.stdout || error.message;
    console.error('NGINX reload failed:', errorOutput);
    return { success: false, error: errorOutput };
  }
}

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

    // Convert integer booleans to actual booleans
    const formattedServices = services.map(s => ({
      ...s,
      sslEnabled: !!s.sslEnabled,
      forceHttps: !!s.forceHttps,
      websocketEnabled: !!s.websocketEnabled,
      isAdmin: !!s.isAdmin,
      isFavorite: !!s.isFavorite,
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

    // Reload NGINX
    await execAsync('systemctl reload nginx || nginx -s reload').catch(() => {});

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

    res.status(201).json({
      success: true,
      service: { id, ...data, dataDir },
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

// Generate NGINX config based on service type
function generateNginxConfig(service) {
  const { domain, type, target, port, rootDir, websocketEnabled, forceHttps, maxUploadSize, sslEnabled } = service;

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
    root ${rootDir};
    index index.html index.htm;`;
      locationBlock = `
    location / {
        try_files $uri $uri/ /index.html;
    }`;
      break;
  }

  const httpBlock = forceHttps
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

  const httpsBlock = sslEnabled ? `

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

  return `# ProxyPilot Managed Configuration
# Domain: ${domain}
# Type: ${type}
# Generated: ${new Date().toISOString()}
${httpBlock}${httpsBlock}
`;
}
