// Per-project / per-user API key STORE — the DB + encryption half.
//
// Pairs with the pure project-keys-logic.js (precedence, permissions, shapes).
// Secrets are encrypted at rest with the SAME helper the global connectors use
// (lib/secrets encryptSecret ← TOTP_ENCRYPTION_KEY), so a project key is exactly
// as protected as an install-wide one.
//
// Security (cid-security): the plaintext key is decrypted ORCHESTRATOR-SIDE only,
// at the moment a model call is made. It is never returned by any route, never
// logged, and never reaches the container or the browser — only key_hint (last
// 4 chars) is ever shown back.

import { getMock2Db } from './db.js';
import { encryptSecret, decryptSecret } from '../lib/secrets.js';
import { keyHint, selectKeyRow, resolveKeySource } from './project-keys-logic.js';

const nowIso = () => new Date().toISOString();

// ---- reads ----

// Raw rows for a project (INCLUDES the ciphertext — internal use only).
export function listKeyRows(projectId) {
  try {
    return getMock2Db()
      .prepare('SELECT * FROM mock2_project_api_keys WHERE project_id = ? ORDER BY scope, provider, id')
      .all(Number(projectId));
  } catch { return []; } // pre-migration
}

export function getKeyRow(id) {
  try {
    return getMock2Db().prepare('SELECT * FROM mock2_project_api_keys WHERE id = ?').get(Number(id)) || null;
  } catch { return null; }
}

// ---- writes ----

// upsertKey — one row per (project, provider) for the project scope and per
// (project, user, provider) for the user scope; re-adding replaces the secret in
// place so rotating a key never creates a duplicate the resolver could pick
// between. Returns the stored row.
export function upsertKey({
  projectId, scope, userId = null, provider, apiKey, label = null, baseUrl = null, createdBy = null,
}) {
  const db = getMock2Db();
  const enc = encryptSecret(String(apiKey));
  const hint = keyHint(apiKey);
  const ts = nowIso();
  const existing = scope === 'user'
    ? db.prepare('SELECT id FROM mock2_project_api_keys WHERE project_id = ? AND scope = \'user\' AND user_id = ? AND provider = ?')
      .get(Number(projectId), Number(userId), String(provider))
    : db.prepare('SELECT id FROM mock2_project_api_keys WHERE project_id = ? AND scope = \'project\' AND provider = ?')
      .get(Number(projectId), String(provider));
  if (existing) {
    db.prepare(`UPDATE mock2_project_api_keys
                SET api_key_enc = ?, key_hint = ?, label = ?, base_url = ?, updated_at = ?
                WHERE id = ?`)
      .run(enc, hint, label, baseUrl, ts, existing.id);
    return getKeyRow(existing.id);
  }
  const info = db.prepare(`
    INSERT INTO mock2_project_api_keys
      (project_id, scope, user_id, provider, label, api_key_enc, key_hint, base_url, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    Number(projectId), String(scope), scope === 'user' ? Number(userId) : null, String(provider),
    label, enc, hint, baseUrl, createdBy == null ? null : Number(createdBy), ts, ts,
  );
  return getKeyRow(Number(info.lastInsertRowid));
}

export function deleteKey(id) {
  try { getMock2Db().prepare('DELETE FROM mock2_project_api_keys WHERE id = ?').run(Number(id)); return true; }
  catch { return false; }
}

// Delete every key a project owns — called when the project is deleted so no
// encrypted secret outlives the thing it belonged to.
export function deleteKeysForProject(projectId) {
  try { getMock2Db().prepare('DELETE FROM mock2_project_api_keys WHERE project_id = ?').run(Number(projectId)); }
  catch { /* pre-migration */ }
}

function markUsed(id) {
  try { getMock2Db().prepare('UPDATE mock2_project_api_keys SET last_used_at = ? WHERE id = ?').run(nowIso(), Number(id)); }
  catch { /* non-critical */ }
}

// ---- the resolver the runtime uses ----

// resolveProjectKey({ projectId, provider, userId, globalKey }) →
//   { source: 'user'|'project'|'global'|'none', apiKey, label, baseUrl, keyId }
//
// This is the ONE place the layered precedence is applied at runtime. A row whose
// ciphertext will not decrypt (the encryption key changed) is SKIPPED rather than
// used as a null — so a broken project key degrades to the global connector
// instead of failing every build on the project.
export function resolveProjectKey({ projectId, provider, userId = null, globalKey = null } = {}) {
  if (!projectId || !provider) {
    return { source: globalKey ? 'global' : 'none', apiKey: globalKey || null, label: 'the global connector key', baseUrl: null, keyId: null };
  }
  const rows = listKeyRows(projectId).map((r) => {
    let plain = null;
    try { plain = r.api_key_enc ? decryptSecret(r.api_key_enc) : null; } catch { plain = null; }
    return { ...r, api_key: plain };
  }).filter((r) => r.api_key); // undecryptable ⇒ invisible to the resolver
  const picked = resolveKeySource(rows, { provider, userId, globalKey });
  if (picked.row) markUsed(picked.row.id);
  return {
    source: picked.source,
    apiKey: picked.apiKey,
    label: picked.label,
    baseUrl: picked.row?.base_url || null,
    keyId: picked.row?.id || null,
  };
}

// Which override WOULD apply, without decrypting or touching last_used_at —
// for the UI's "this project bills to …" line.
export function describeKeySource({ projectId, provider, userId = null }) {
  const row = selectKeyRow(listKeyRows(projectId), { provider, userId });
  if (!row) return { source: 'global', label: 'the global connector key' };
  return {
    source: row.scope,
    label: row.scope === 'user' ? 'your personal key' : 'the project key',
    key_hint: row.key_hint || null,
  };
}
