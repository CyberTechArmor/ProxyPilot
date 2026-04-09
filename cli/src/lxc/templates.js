import { publishImage, listImages, deleteImage, getImageByAlias } from '../incus/client.js';
import { getDb } from '../db/index.js';
import { getConfig } from '../config.js';
import { success, error, info, table } from '../output.js';

export async function templateCreate(name, fromContainer, description) {
  const db = getDb();
  const config = getConfig();
  const prefix = config.incus.instance_prefix;

  const container = db.prepare('SELECT * FROM containers WHERE name = ?').get(fromContainer);
  if (!container) throw new Error(`Container '${fromContainer}' not found`);

  // Check template name doesn't already exist
  const existing = db.prepare('SELECT id FROM templates WHERE name = ?').get(name);
  if (existing) throw new Error(`Template '${name}' already exists`);

  info(`Publishing container '${fromContainer}' as template '${name}'...`);
  info('This may take a moment depending on container size...');

  const alias = `proxypilot-template-${name}`;

  await publishImage(container.incus_name, [{ name: alias, description: description || `ProxyPilot template: ${name}` }]);

  db.prepare(`
    INSERT INTO templates (name, description, incus_alias, base_image, init_script, default_profile)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(name, description || '', alias, container.image, container.init_script, container.profile);

  success(`Template '${name}' created from container '${fromContainer}'`);
}

export function templateList(jsonOutput) {
  const db = getDb();
  const templates = db.prepare('SELECT * FROM templates ORDER BY created_at DESC').all();

  if (jsonOutput) {
    console.log(JSON.stringify(templates, null, 2));
    return;
  }

  if (templates.length === 0) {
    info('No templates found. Create one with: proxypilot lxc templates create <name> --from <container>');
    return;
  }

  const headers = ['Name', 'Base Image', 'Profile', 'Description', 'Created'];
  const rows = templates.map(t => [
    t.name,
    t.base_image || '-',
    t.default_profile,
    (t.description || '-').substring(0, 40),
    t.created_at,
  ]);
  table(headers, rows);
}

export async function templateDelete(name) {
  const db = getDb();
  const template = db.prepare('SELECT * FROM templates WHERE name = ?').get(name);
  if (!template) throw new Error(`Template '${name}' not found`);

  info(`Deleting template '${name}'...`);

  // Delete the Incus image
  try {
    const imageInfo = await getImageByAlias(template.incus_alias);
    if (imageInfo && imageInfo.metadata) {
      const fingerprint = imageInfo.metadata.target;
      await deleteImage(fingerprint);
    }
  } catch (e) {
    // Image may already be gone
  }

  db.prepare('DELETE FROM templates WHERE id = ?').run(template.id);

  success(`Template '${name}' deleted`);
}

export function getTemplate(name) {
  const db = getDb();
  return db.prepare('SELECT * FROM templates WHERE name = ?').get(name);
}
