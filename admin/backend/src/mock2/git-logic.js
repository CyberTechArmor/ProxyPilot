// Mock2 git-connector PURE decision layer (Phase M5, ADR-006). Native-free,
// unit-tested stub-first (risk R9). Git connectors are orchestrator-side push
// targets: credentials live encrypted in mock2.db and NEVER enter a container
// (ADR-006). This module holds the provider metadata, validation, the
// test-plan, and publicShape (never returns the decrypted credential).
//
// Terminology (risk R7): nothing here is named "agent".

export const GIT_PROVIDERS = Object.freeze(['github', 'gitea', 'generic_https', 'generic_ssh']);
export const GIT_AUTH_KINDS = Object.freeze(['token', 'ssh_key']);

export function validateGitConnectorInput({ provider, auth_kind, base_url }) {
  if (!GIT_PROVIDERS.includes(provider)) return `Unknown git provider "${provider}"`;
  if (!GIT_AUTH_KINDS.includes(auth_kind)) return `Unknown auth kind "${auth_kind}"`;
  if (provider === 'gitea' && !String(base_url || '').trim()) {
    return 'A base URL is required for a Gitea connector';
  }
  if ((provider === 'generic_https' || provider === 'generic_ssh') && !String(base_url || '').trim()) {
    return `A base URL is required for the ${provider} provider`;
  }
  if (provider === 'generic_ssh' && auth_kind !== 'ssh_key') {
    return 'generic_ssh requires ssh_key auth';
  }
  if (base_url && (provider === 'github' || provider === 'gitea' || provider === 'generic_https')) {
    if (!/^https?:\/\//i.test(String(base_url).trim())) return 'base_url must be an http(s) URL';
  }
  return null;
}

// The lightweight credential-validation plan (orchestrator-side, ADR-006): a
// "who am I" API call proving the token reaches the host. Returns null when the
// connector can't be tested without a concrete repo (generic/ssh) — the UI shows
// "verify by configuring a project remote". `token` is injected by the data
// layer and never stored on the connector shape.
export function gitTestPlan(connector) {
  const { provider, base_url } = connector;
  const token = connector.__token || null;
  if (connector.auth_kind !== 'token') return null; // ssh keys aren't API-testable here
  switch (provider) {
    case 'github':
      return {
        url: 'https://api.github.com/user',
        headers: { authorization: `Bearer ${token || ''}`, 'user-agent': 'proxypilot-mock2', accept: 'application/vnd.github+json' },
      };
    case 'gitea': {
      const b = String(base_url || '').replace(/\/+$/, '');
      return { url: `${b}/api/v1/user`, headers: { authorization: `token ${token || ''}` } };
    }
    default:
      return null; // generic_https: no standardized identity endpoint
  }
}

export function interpretGitTestResponse(status) {
  if (status >= 200 && status < 300) return { ok: true, detail: 'credentials accepted' };
  if (status === 401 || status === 403) return { ok: false, detail: `auth rejected (HTTP ${status})` };
  return { ok: false, detail: `HTTP ${status}` };
}

// Client-safe view. NEVER returns credential_enc or the decrypted credential;
// exposes secret_decryptable (a boolean the caller computes).
export function publicGitConnectorShape(row, { secretDecryptable = false } = {}) {
  if (!row) return null;
  let test = null;
  if (row.test_status) {
    try { test = JSON.parse(row.test_status); } catch { test = { ok: null, detail: String(row.test_status) }; }
  }
  return {
    id: row.id,
    name: row.name,
    provider: row.provider,
    base_url: row.base_url || null,
    auth_kind: row.auth_kind,
    has_credential: !!row.credential_enc,
    secret_decryptable: !!secretDecryptable,
    test,
    test_at: row.test_at || null,
    created_by: row.created_by || null,
    created_at: row.created_at || null,
  };
}

export function publicProjectRemoteShape(row) {
  if (!row) return null;
  return {
    project_id: row.project_id,
    git_connector_id: row.git_connector_id,
    remote_repo: row.remote_repo,
    push_on_checkpoint: !!row.push_on_checkpoint,
    last_push_at: row.last_push_at || null,
    last_push_error: row.last_push_error || null,
  };
}
