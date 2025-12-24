import { Router } from 'express';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { exec } from 'child_process';
import { promisify } from 'util';
import { writeFile, unlink, readdir } from 'fs/promises';
import { existsSync } from 'fs';
import * as OTPAuth from 'otpauth';
import { getDb, logAudit } from '../db.js';

const execAsync = promisify(exec);

export const servicesRouter = Router();

const NGINX_SITES_AVAILABLE = process.env.NGINX_SITES_AVAILABLE || '/etc/nginx/sites-available';
const NGINX_SITES_ENABLED = process.env.NGINX_SITES_ENABLED || '/etc/nginx/sites-enabled';

// Validation schemas
const createServiceSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  domain: z.string().regex(/^[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?$/, 'Invalid domain'),
  type: z.enum(['proxy', 'static', 'docker']),
  target: z.string().optional(),
  port: z.number().int().min(1).max(65535).optional(),
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

// Get all services
servicesRouter.get('/', (req, res) => {
  try {
    const db = getDb();
    const services = db.prepare(`
      SELECT id, name, domain, type, target, port, root_dir as rootDir,
             container_name as containerName, ssl_enabled as sslEnabled,
             force_https as forceHttps, websocket_enabled as websocketEnabled,
             max_upload_size as maxUploadSize, status, is_admin as isAdmin,
             created_at as createdAt, updated_at as updatedAt
      FROM services
      ORDER BY created_at DESC
    `).all();

    // Convert integer booleans to actual booleans
    const formattedServices = services.map(s => ({
      ...s,
      sslEnabled: !!s.sslEnabled,
      forceHttps: !!s.forceHttps,
      websocketEnabled: !!s.websocketEnabled,
      isAdmin: !!s.isAdmin,
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
      },
    });
  } catch (error) {
    console.error('Error fetching service:', error);
    res.status(500).json({ error: 'Failed to fetch service' });
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
    if (data.type === 'proxy' && (!data.target || !data.port)) {
      return res.status(400).json({ error: 'Proxy type requires target and port' });
    }
    if (data.type === 'static' && !data.rootDir) {
      return res.status(400).json({ error: 'Static type requires rootDir' });
    }
    if (data.type === 'docker' && !data.containerName) {
      return res.status(400).json({ error: 'Docker type requires containerName' });
    }

    const id = uuidv4();

    // Generate NGINX config
    const nginxConfig = generateNginxConfig(data);

    // Write NGINX config file
    const configPath = `${NGINX_SITES_AVAILABLE}/${data.domain}`;
    await writeFile(configPath, nginxConfig);

    // Enable the site
    const enabledPath = `${NGINX_SITES_ENABLED}/${data.domain}`;
    await execAsync(`ln -sf "${configPath}" "${enabledPath}"`);

    // Test NGINX config
    const { stderr } = await execAsync('nginx -t');
    if (stderr && !stderr.includes('successful')) {
      // Rollback
      await unlink(enabledPath).catch(() => {});
      await unlink(configPath).catch(() => {});
      return res.status(400).json({ error: 'Invalid NGINX configuration generated' });
    }

    // Reload NGINX
    await execAsync('systemctl reload nginx');

    // Insert into database
    db.prepare(`
      INSERT INTO services (
        id, name, domain, type, target, port, root_dir, container_name,
        ssl_enabled, force_https, websocket_enabled, max_upload_size, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')
    `).run(
      id, data.name, data.domain, data.type, data.target || null,
      data.port || null, data.rootDir || null, data.containerName || null,
      data.sslEnabled ? 1 : 0, data.forceHttps ? 1 : 0,
      data.websocketEnabled ? 1 : 0, data.maxUploadSize
    );

    logAudit(req.user.id, 'SERVICE_CREATED', 'service', id, data, req.ip);

    res.status(201).json({
      success: true,
      service: { id, ...data },
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
    await execAsync('systemctl reload nginx');

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
    await execAsync('systemctl reload nginx');

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
    const { stdout } = await execAsync('docker ps --format "{{.ID}}|{{.Names}}|{{.Ports}}|{{.Status}}"');
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

// Generate NGINX config based on service type
function generateNginxConfig(service) {
  const { domain, type, target, port, rootDir, websocketEnabled, forceHttps, maxUploadSize, sslEnabled } = service;

  let locationBlock = '';
  let rootBlock = '';

  switch (type) {
    case 'proxy':
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
