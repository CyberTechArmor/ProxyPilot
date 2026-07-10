// Mock2 model connectors — data access + the network test-connection (Phase M5,
// ADR-003 / survey §7). Clones the backup-destinations subsystem wholesale
// (routes/backups.js + lib/s3.js): an encrypted key at rest, a publicShape that
// exposes secret_decryptable (never the secret), and a cached test verdict on
// the row (test_status / test_at). Tables: mock2_model_connectors +
// mock2_model_slots + mock2_model_prices (migration 503).
//
// The PURE decisions (capability enforcement, provider metadata, the egress
// host, the test PLAN, publicConnectorShape) live in connector-logic.js so they
// unit-test without better-sqlite3 or the network (stub-first, risk R9). This
// module is the thin native/IO half: better-sqlite3 via getMock2Db, encryption
// via lib/secrets, and the actual test HTTP call (which goes out through the
// agent proxy like every other outbound request).
//
// Terminology (risk R7): the runner-driving slot is `build_runner`; nothing
// here is named "agent".

import { getMock2Db } from './db.js';
import { encryptSecret, decryptSecret } from '../lib/secrets.js';
import {
  publicConnectorShape,
  connectorTestPlan,
  interpretTestResponse,
  connectorEgressHosts,
} from './connector-logic.js';

const nowIso = () => new Date().toISOString();

// ---- reads ----

export function listConnectors() {
  return getMock2Db().prepare(`SELECT * FROM mock2_model_connectors ORDER BY name`).all();
}

export function getConnector(id) {
  return getMock2Db().prepare(`SELECT * FROM mock2_model_connectors WHERE id = ?`).get(Number(id));
}

export function getConnectorByName(name) {
  return getMock2Db().prepare(`SELECT * FROM mock2_model_connectors WHERE name = ?`).get(name);
}

// Probe whether a row's stored key decrypts under the current TOTP_ENCRYPTION_KEY
// WITHOUT returning the plaintext — the exact secret_decryptable signal the
// backup-destinations publicShape uses (a GCM auth failure throws).
export function isSecretDecryptable(row) {
  if (!row?.api_key_enc) return false;
  try { decryptSecret(row.api_key_enc); return true; } catch { return false; }
}

// Client-safe view. Never returns api_key_enc or the decrypted key.
export function shapeConnector(row) {
  return publicConnectorShape(row, { secretDecryptable: isSecretDecryptable(row) });
}

// The plaintext key for a row, or null. Internal only — used by the test call
// and (later, M6) the runner; never returned to a client.
export function decryptConnectorKey(row) {
  if (!row?.api_key_enc) return null;
  try { return decryptSecret(row.api_key_enc); } catch { return null; }
}

// ---- writes ----

export function insertConnector({ name, provider, baseUrl, apiKey, capabilities, enabled = 1, createdBy = null }) {
  const db = getMock2Db();
  const info = db
    .prepare(
      `INSERT INTO mock2_model_connectors
         (name, provider, base_url, api_key_enc, capabilities, enabled, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      name,
      provider,
      baseUrl || null,
      apiKey ? encryptSecret(apiKey) : null,
      JSON.stringify(capabilities || []),
      enabled ? 1 : 0,
      createdBy,
      nowIso(),
    );
  return getConnector(info.lastInsertRowid);
}

// Partial update. Only provided fields change. A provided apiKey is re-encrypted
// (an empty string clears it); an absent apiKey leaves the stored key untouched
// (so a non-credential edit doesn't force re-entry — the backups.js PUT rule).
// Any field edit nulls the cached verdict so the operator must re-test.
export function updateConnector(id, fields = {}) {
  const sets = [];
  const vals = [];
  const set = (col, v) => { sets.push(`${col} = ?`); vals.push(v); };

  if (fields.name !== undefined) set('name', fields.name);
  if (fields.base_url !== undefined) set('base_url', fields.base_url || null);
  if (fields.capabilities !== undefined) set('capabilities', JSON.stringify(fields.capabilities || []));
  if (fields.enabled !== undefined) set('enabled', fields.enabled ? 1 : 0);
  if (fields.apiKey !== undefined) set('api_key_enc', fields.apiKey ? encryptSecret(fields.apiKey) : null);
  if (fields.baa_ack_by !== undefined) set('baa_ack_by', fields.baa_ack_by);
  if (fields.baa_ack_at !== undefined) set('baa_ack_at', fields.baa_ack_at);

  // Invalidate the cached test verdict on any material change (but not when we
  // are ONLY writing the verdict itself — recordTestVerdict handles that).
  if (fields.__keepVerdict !== true && (fields.base_url !== undefined || fields.apiKey !== undefined || fields.capabilities !== undefined || fields.enabled !== undefined)) {
    set('test_status', null);
    set('test_at', null);
  }

  if (sets.length === 0) return getConnector(id);
  vals.push(Number(id));
  getMock2Db().prepare(`UPDATE mock2_model_connectors SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  return getConnector(id);
}

export function recordBaaAck(id, userId) {
  return updateConnector(id, { baa_ack_by: userId, baa_ack_at: nowIso(), __keepVerdict: true });
}

export function deleteConnector(id) {
  const db = getMock2Db();
  const tx = db.transaction(() => {
    // Clear any slot pinned to this connector so a slot never dangles.
    db.prepare(`DELETE FROM mock2_model_slots WHERE connector_id = ?`).run(Number(id));
    db.prepare(`DELETE FROM mock2_model_prices WHERE connector_id = ?`).run(Number(id));
    db.prepare(`DELETE FROM mock2_model_connectors WHERE id = ?`).run(Number(id));
  });
  tx();
}

function recordTestVerdict(id, verdict) {
  getMock2Db()
    .prepare(`UPDATE mock2_model_connectors SET test_status = ?, test_at = ? WHERE id = ?`)
    .run(JSON.stringify(verdict), nowIso(), Number(id));
}

// Run the connector's test plan (a lightweight "list models" GET that validates
// the key without spending generation tokens), cache the verdict on the row, and
// return it. Always resolves — never throws — like lib/s3.js testConnection.
export async function testConnector(row) {
  const key = decryptConnectorKey(row);
  const plan = connectorTestPlan({ provider: row.provider, base_url: row.base_url, __apiKey: key });
  if (!plan) {
    const verdict = { ok: false, detail: `no test available for provider ${row.provider}` };
    recordTestVerdict(row.id, verdict);
    return verdict;
  }
  const t0 = Date.now();
  let verdict;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    let res;
    try {
      res = await fetch(plan.url, { method: 'GET', headers: plan.headers, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
    const body = await res.text().catch(() => '');
    verdict = interpretTestResponse(res.status, body);
    verdict.latency_ms = Date.now() - t0;
  } catch (err) {
    verdict = { ok: false, detail: `unreachable: ${err?.message || String(err)}`, latency_ms: Date.now() - t0 };
  }
  recordTestVerdict(row.id, verdict);
  return verdict;
}

// ---- slots ----

export function listSlots() {
  return getMock2Db().prepare(`SELECT * FROM mock2_model_slots`).all();
}

export function getSlot(slot) {
  return getMock2Db().prepare(`SELECT * FROM mock2_model_slots WHERE slot = ?`).get(slot);
}

export function setSlot({ slot, connectorId, model, updatedBy = null }) {
  getMock2Db()
    .prepare(
      `INSERT INTO mock2_model_slots (slot, connector_id, model, updated_by, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(slot) DO UPDATE SET
         connector_id = excluded.connector_id, model = excluded.model,
         updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
    )
    .run(slot, Number(connectorId), model, updatedBy, nowIso());
  return getSlot(slot);
}

export function clearSlot(slot) {
  const r = getMock2Db().prepare(`DELETE FROM mock2_model_slots WHERE slot = ?`).run(slot);
  return { cleared: r.changes > 0 };
}

// ---- prices (per connector+model, effective-dated) ----

export function listPrices(connectorId) {
  return getMock2Db()
    .prepare(`SELECT * FROM mock2_model_prices WHERE connector_id = ? ORDER BY model, effective_at DESC`)
    .all(Number(connectorId));
}

export function upsertPrice({ connectorId, model, inputCentsPerMtok, outputCentsPerMtok, effectiveAt = null }) {
  const eff = effectiveAt || nowIso();
  getMock2Db()
    .prepare(
      `INSERT INTO mock2_model_prices
         (connector_id, model, input_cents_per_mtok, output_cents_per_mtok, effective_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(connector_id, model, effective_at) DO UPDATE SET
         input_cents_per_mtok = excluded.input_cents_per_mtok,
         output_cents_per_mtok = excluded.output_cents_per_mtok`,
    )
    .run(Number(connectorId), model, Math.round(inputCentsPerMtok), Math.round(outputCentsPerMtok), eff);
  return listPrices(connectorId);
}

export function deletePrice(id) {
  const r = getMock2Db().prepare(`DELETE FROM mock2_model_prices WHERE id = ?`).run(Number(id));
  return { deleted: r.changes > 0 };
}

// ---- egress seam (M4 ADR-010) ----
//
// The distinct set of API hosts implied by the ENABLED connectors — the
// model-API half of every project's egress allowlist, derived from what's
// configured (ADR-003) rather than the static M4 placeholder seed. egress.js
// unions this into each project's plan; the static default remains the fallback.
export function configuredConnectorEgressHosts() {
  return connectorEgressHosts(listConnectors());
}
