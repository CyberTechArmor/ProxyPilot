// Per-project / per-user API key PURE decision layer.
//
// A project can carry provider API keys that override the global model
// connectors, so a team can bill their own account (or an individual can use a
// personal key) without touching the install-wide configuration. The connector
// still decides WHICH provider/model/base URL is used — these rows only replace
// the CREDENTIAL. That keeps the override minimal and impossible to misuse as a
// backdoor model switch.
//
// Precedence for a build that needs provider P on project X, acting as user U:
//   1. scope 'user'    (project X, user U, provider P) — U's private key
//   2. scope 'project' (project X, provider P)         — the project's key
//   3. the global connector's own key                  — today's behavior
//
// Native-free (no DB, no crypto): the store does the I/O, this decides. Pure so
// the precedence — the part that must never regress — is unit-testable.

export const KEY_SCOPES = Object.freeze(['project', 'user']);
export const KEY_PROVIDERS = Object.freeze(['anthropic', 'openai', 'gemini', 'ollama', 'openai_compatible']);

export function isKeyScope(s) { return KEY_SCOPES.includes(String(s || '')); }
export function isKeyProvider(p) { return KEY_PROVIDERS.includes(String(p || '')); }

// keyHint — the only part of a secret we ever store in cleartext or show back.
// Last 4 characters, so an operator can tell two keys apart without the key
// being recoverable from the UI or the audit log.
export function keyHint(apiKey) {
  const s = String(apiKey || '');
  if (s.length <= 4) return '••••';
  return `••••${s.slice(-4)}`;
}

// selectKeyRow(rows, { provider, userId }) → the row that wins, or null.
//
// `rows` are this project's key rows (any shape with { scope, user_id,
// provider }). A user-scoped row only ever matches its OWN user — a key someone
// uploaded for themselves must never be spent by anyone else, which is the whole
// point of the 'user' scope.
export function selectKeyRow(rows = [], { provider, userId = null } = {}) {
  if (!provider) return null;
  const forProvider = (rows || []).filter((r) => r && r.provider === provider);
  if (userId != null) {
    const mine = forProvider.find((r) => r.scope === 'user' && String(r.user_id) === String(userId));
    if (mine) return mine;
  }
  return forProvider.find((r) => r.scope === 'project') || null;
}

// resolveKeySource(rows, { provider, userId, globalKey }) → the full decision,
// including WHY, so the UI and the cycle log can say which credential paid.
//   { source: 'user' | 'project' | 'global' | 'none', apiKey, row, label }
export function resolveKeySource(rows = [], { provider, userId = null, globalKey = null } = {}) {
  const row = selectKeyRow(rows, { provider, userId });
  if (row && row.api_key) {
    return {
      source: row.scope, apiKey: row.api_key, row,
      label: row.scope === 'user' ? 'your personal key' : 'the project key',
    };
  }
  if (globalKey) return { source: 'global', apiKey: globalKey, row: null, label: 'the global connector key' };
  return { source: 'none', apiKey: null, row: null, label: 'no usable key' };
}

// canManageKey — who may create/delete a row.
//   project scope: changes what EVERY member's builds bill to → editors/admins
//   user scope:    only ever spent by its owner → the owner (any member), and
//                  an admin may remove one (cleanup), never read it
export function canManageKey({ scope, targetUserId = null }, { userId, role, isAdmin = false }) {
  if (!isKeyScope(scope)) return { ok: false, error: 'unknown key scope' };
  if (scope === 'project') {
    if (isAdmin || role === 'editor') return { ok: true };
    return { ok: false, error: 'Only a project editor or an admin can set the project-wide key' };
  }
  // scope === 'user'
  if (targetUserId != null && String(targetUserId) !== String(userId)) {
    if (isAdmin) return { ok: true, adminActingOnOther: true };
    return { ok: false, error: 'You can only manage your own personal key' };
  }
  if (!role && !isAdmin) return { ok: false, error: 'You are not a member of this project' };
  return { ok: true };
}

// visibleKeyRows — what a caller may SEE. Everyone with access sees that a
// project key exists (it bills their work), plus their own personal key. An
// admin additionally sees that other members have personal keys, but the shape
// never carries the secret for anyone.
export function visibleKeyRows(rows = [], { userId, isAdmin = false } = {}) {
  return (rows || []).filter((r) => {
    if (!r) return false;
    if (r.scope === 'project') return true;
    if (String(r.user_id) === String(userId)) return true;
    return !!isAdmin;
  });
}

// publicKeyShape — the ONLY shape that leaves the server. No secret, ever.
export function publicKeyShape(row, { userId = null } = {}) {
  if (!row) return null;
  return {
    id: row.id,
    scope: row.scope,
    provider: row.provider,
    label: row.label || null,
    key_hint: row.key_hint || null,
    base_url: row.base_url || null,
    user_id: row.scope === 'user' ? row.user_id : null,
    mine: row.scope === 'user' && String(row.user_id) === String(userId),
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
    last_used_at: row.last_used_at || null,
  };
}
