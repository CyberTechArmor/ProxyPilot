// LDAPS connection management (admin-only). Backs the "LDAPS" tab on
// the Users page. Mutations are sudo-gated like the other user
// management endpoints; the bind password is write-only — list/read responses
// never include it, only a hasBindPassword flag.
import { Router } from 'express';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { getDb, logAudit } from '../db.js';
import { requireAdmin, requireSudo } from '../middleware/auth.js';
import { encryptSecret } from '../lib/secrets.js';
import { testLdapConnection, DEFAULT_USER_FILTER } from '../lib/ldap.js';

export const ldapRouter = Router();

ldapRouter.use(requireAdmin);

function toApiShape(row) {
  return {
    id: row.id,
    name: row.name,
    host: row.host,
    port: row.port,
    bindDn: row.bind_dn || '',
    hasBindPassword: !!row.bind_password_enc,
    baseDn: row.base_dn,
    userFilter: row.user_filter,
    tlsVerify: row.tls_verify !== 0,
    hasCaCert: !!row.ca_cert,
    enabled: row.enabled === 1,
    lastTestStatus: row.last_test_status,
    lastTestError: row.last_test_error,
    lastTestAt: row.last_test_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const connectionSchema = z.object({
  name: z.string().min(1, 'Name is required').max(100),
  host: z.string().min(1, 'Host is required').max(255),
  port: z.number().int().min(1).max(65535).default(636),
  bindDn: z.string().max(500).optional(),
  // Write-only. Omitted/empty on update = keep the stored password.
  bindPassword: z.string().max(500).optional(),
  baseDn: z.string().min(1, 'Base DN is required').max(500),
  userFilter: z.string().min(1).max(1000)
    .refine((f) => f.includes('{username}'), {
      message: 'User filter must contain the {username} placeholder',
    })
    .default(DEFAULT_USER_FILTER),
  tlsVerify: z.boolean().default(true),
  // Write-only like bindPassword, but clearable: empty string clears
  // the stored chain, undefined keeps it.
  caCert: z.string().max(20000).optional(),
  enabled: z.boolean().default(true),
});

// List connections
ldapRouter.get('/connections', (req, res) => {
  try {
    const db = getDb();
    const rows = db
      .prepare(`SELECT * FROM ldap_connections ORDER BY created_at ASC, name ASC`)
      .all();
    res.json({ connections: rows.map(toApiShape) });
  } catch (error) {
    console.error('Error listing LDAP connections:', error);
    res.status(500).json({ error: 'Failed to list LDAP connections' });
  }
});

// Create connection
ldapRouter.post('/connections', requireSudo, (req, res) => {
  try {
    const data = connectionSchema.parse(req.body);
    const db = getDb();

    const existing = db
      .prepare(`SELECT id FROM ldap_connections WHERE name = ?`)
      .get(data.name);
    if (existing) {
      return res.status(400).json({ error: 'A connection with this name already exists' });
    }

    const id = uuidv4();
    db.prepare(`
      INSERT INTO ldap_connections
        (id, name, host, port, bind_dn, bind_password_enc, base_dn,
         user_filter, tls_verify, ca_cert, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      data.name,
      data.host,
      data.port,
      data.bindDn || null,
      data.bindPassword ? encryptSecret(data.bindPassword) : null,
      data.baseDn,
      data.userFilter,
      data.tlsVerify ? 1 : 0,
      data.caCert || null,
      data.enabled ? 1 : 0,
    );

    logAudit(req.user.id, 'LDAP_CONNECTION_CREATED', 'ldap_connection', id,
      { name: data.name, host: data.host, port: data.port }, req.ip);

    const row = db.prepare(`SELECT * FROM ldap_connections WHERE id = ?`).get(id);
    res.json({ success: true, connection: toApiShape(row) });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: error.errors[0].message });
    }
    console.error('Error creating LDAP connection:', error);
    res.status(500).json({ error: 'Failed to create LDAP connection' });
  }
});

// Update connection
ldapRouter.put('/connections/:id', requireSudo, (req, res) => {
  try {
    const data = connectionSchema.parse(req.body);
    const db = getDb();

    const row = db
      .prepare(`SELECT * FROM ldap_connections WHERE id = ?`)
      .get(req.params.id);
    if (!row) {
      return res.status(404).json({ error: 'Connection not found' });
    }

    const nameClash = db
      .prepare(`SELECT id FROM ldap_connections WHERE name = ? AND id != ?`)
      .get(data.name, row.id);
    if (nameClash) {
      return res.status(400).json({ error: 'A connection with this name already exists' });
    }

    const bindPasswordEnc = data.bindPassword
      ? encryptSecret(data.bindPassword)
      : row.bind_password_enc;
    const caCert = data.caCert === undefined ? row.ca_cert : (data.caCert || null);

    db.prepare(`
      UPDATE ldap_connections
         SET name = ?, host = ?, port = ?, bind_dn = ?, bind_password_enc = ?,
             base_dn = ?, user_filter = ?, tls_verify = ?, ca_cert = ?,
             enabled = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?
    `).run(
      data.name,
      data.host,
      data.port,
      data.bindDn || null,
      bindPasswordEnc,
      data.baseDn,
      data.userFilter,
      data.tlsVerify ? 1 : 0,
      caCert,
      data.enabled ? 1 : 0,
      row.id,
    );

    logAudit(req.user.id, 'LDAP_CONNECTION_UPDATED', 'ldap_connection', row.id,
      { name: data.name, host: data.host, port: data.port, enabled: data.enabled }, req.ip);

    const updated = db.prepare(`SELECT * FROM ldap_connections WHERE id = ?`).get(row.id);
    res.json({ success: true, connection: toApiShape(updated) });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: error.errors[0].message });
    }
    console.error('Error updating LDAP connection:', error);
    res.status(500).json({ error: 'Failed to update LDAP connection' });
  }
});

// Delete connection. Users provisioned through it stay — deleting a
// connection only removes the sign-in path, not the accounts.
ldapRouter.delete('/connections/:id', requireSudo, (req, res) => {
  try {
    const db = getDb();
    const row = db
      .prepare(`SELECT id, name FROM ldap_connections WHERE id = ?`)
      .get(req.params.id);
    if (!row) {
      return res.status(404).json({ error: 'Connection not found' });
    }
    db.prepare(`DELETE FROM ldap_connections WHERE id = ?`).run(row.id);
    logAudit(req.user.id, 'LDAP_CONNECTION_DELETED', 'ldap_connection', row.id,
      { name: row.name }, req.ip);
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting LDAP connection:', error);
    res.status(500).json({ error: 'Failed to delete LDAP connection' });
  }
});

// Test a saved connection: service bind + base-DN read. Persists the
// verdict so the list view can show it without re-probing.
ldapRouter.post('/connections/:id/test', async (req, res) => {
  try {
    const db = getDb();
    const row = db
      .prepare(`SELECT * FROM ldap_connections WHERE id = ?`)
      .get(req.params.id);
    if (!row) {
      return res.status(404).json({ error: 'Connection not found' });
    }

    const result = await testLdapConnection(row);
    db.prepare(`
      UPDATE ldap_connections
         SET last_test_status = ?, last_test_error = ?, last_test_at = CURRENT_TIMESTAMP
       WHERE id = ?
    `).run(result.ok ? 'ok' : 'fail', result.ok ? null : result.error, row.id);

    logAudit(req.user.id, 'LDAP_CONNECTION_TESTED', 'ldap_connection', row.id,
      { ok: result.ok, error: result.ok ? undefined : result.error }, req.ip);

    res.json({ success: result.ok, error: result.ok ? null : result.error });
  } catch (error) {
    console.error('Error testing LDAP connection:', error);
    res.status(500).json({ error: 'Failed to test LDAP connection' });
  }
});
