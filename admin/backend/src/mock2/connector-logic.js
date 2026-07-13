// Mock2 model-connector PURE decision layer (Phase M5, ADR-003 / survey §7).
//
// Everything about connectors that can be decided without better-sqlite3, the
// network, or lib/secrets is here so it is unit-testable at the module boundary
// (stub-first, risk R9) — the same split M4 used for network-logic.js. This file
// imports NOTHING native and NOTHING that opens a DB; connectors.js (the thin
// data layer) imports its helpers from here.
//
// Contents:
//   * the 7 model slots + the capability each slot requires
//   * provider metadata: cloud vs local, default model ids, capability defaults
//   * capability enforcement on slot assignment (build_runner refuses chat-only)
//   * the egress host a connector implies (wired into the M4 allowlist)
//   * BAA-acknowledgement gating (Q7 — cloud providers only)
//   * publicConnectorShape (never returns the decrypted key; exposes
//     secret_decryptable as a boolean the caller computes)
//
// Terminology (risk R7): the AI build component is the runner. The slot that
// drives it is `build_runner`; nothing here is named "agent".

// The 7 slots (migration 503 CHECK). One connector+model is pinned per slot.
export const MODEL_SLOTS = Object.freeze([
  'concept_chat',
  'mockup',
  'audit',
  'classifier',
  'build_runner',
  'summary',
  'remediation',
]);

// The capability vocabulary stored on a connector row (capabilities JSON).
export const CAPABILITIES = Object.freeze(['chat', 'agentic_build', 'summarize', 'classify']);

export const PROVIDERS = Object.freeze([
  'anthropic',
  'openai',
  'gemini',
  'ollama',
  'openai_compatible',
]);

// Cloud providers hit a hosted API over the internet — they are the ones the
// BAA acknowledgement (Q7) applies to and the ones whose fixed API host must be
// on a project's egress allowlist. ollama / openai_compatible point at an
// operator-supplied base_url (often on-host), so they carry neither.
const CLOUD_PROVIDERS = Object.freeze(['anthropic', 'openai', 'gemini']);

export function isCloudProvider(provider) {
  return CLOUD_PROVIDERS.includes(provider);
}

// Which capability a slot needs a connector to advertise before it may be
// assigned to that slot. build_runner + remediation drive the agentic runner
// (M6), so they demand 'agentic_build' — this is the constraint that makes the
// "be honest in the UI" rule real: a chat-only model cannot be the build_runner.
export const SLOT_REQUIRED_CAPABILITY = Object.freeze({
  concept_chat: 'chat',
  mockup: 'chat',
  audit: 'chat',
  classifier: 'classify',
  build_runner: 'agentic_build',
  summary: 'summarize',
  remediation: 'agentic_build',
});

export function isValidSlot(slot) {
  return MODEL_SLOTS.includes(slot);
}

export function requiredCapabilityForSlot(slot) {
  return SLOT_REQUIRED_CAPABILITY[slot] || null;
}

// Does a connector's capability set cover what `slot` requires? `capabilities`
// is the parsed array (from parseCapabilities). Missing capability ⇒ false.
export function connectorCoversSlot(capabilities, slot) {
  const need = requiredCapabilityForSlot(slot);
  if (!need) return false;
  return Array.isArray(capabilities) && capabilities.includes(need);
}

// The 400 message for a rejected slot assignment, or null when it's allowed.
// The routes layer turns a non-null return into a 400 { error }.
export function slotAssignmentError(capabilities, slot) {
  if (!isValidSlot(slot)) return `Unknown slot "${slot}"`;
  if (connectorCoversSlot(capabilities, slot)) return null;
  const need = requiredCapabilityForSlot(slot);
  return `This model does not advertise the "${need}" capability required by the ${slot} slot`;
}

// Sensible default capability set when the admin doesn't specify one. Cloud
// frontier models cover everything; a local/OpenAI-compatible endpoint defaults
// to the safe subset (the admin opts a local model into agentic_build
// explicitly, since not every local model can drive the runner).
export function defaultCapabilitiesForProvider(provider) {
  if (isCloudProvider(provider)) return ['chat', 'agentic_build', 'summarize', 'classify'];
  return ['chat', 'summarize', 'classify'];
}

// Validate / normalize an admin-supplied capability list: keep only known
// capabilities, dedupe, drop everything else. An empty result is invalid (a
// connector with no capabilities can fill no slot).
export function normalizeCapabilities(input) {
  if (!Array.isArray(input)) return [];
  const out = [];
  for (const c of input) {
    const v = String(c || '').trim();
    if (CAPABILITIES.includes(v) && !out.includes(v)) out.push(v);
  }
  return out;
}

export function parseCapabilities(json) {
  try {
    const v = JSON.parse(json || '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

// A base_url is required for the two operator-hosted providers (they have no
// fixed default endpoint); the three cloud providers use their own endpoint and
// ignore base_url. Returns an error string or null.
export function validateConnectorInput({ provider, base_url }) {
  if (!PROVIDERS.includes(provider)) return `Unknown provider "${provider}"`;
  if ((provider === 'ollama' || provider === 'openai_compatible') && !String(base_url || '').trim()) {
    return `A base URL is required for the ${provider} provider`;
  }
  if (base_url && !/^https?:\/\//i.test(String(base_url).trim())) {
    return 'base_url must be an http(s) URL';
  }
  return null;
}

// The default API host for each cloud provider — the value M5 folds into the
// per-project egress allowlist so a container using that connector can reach it
// (the M4 static seed is the fallback). Kept in sync with the connectorTestPlan
// endpoints below. Returns null for local providers (see hostFromBaseUrl).
const CLOUD_API_HOST = Object.freeze({
  anthropic: 'api.anthropic.com',
  openai: 'api.openai.com',
  gemini: 'generativelanguage.googleapis.com',
});

// Extract a bare hostname from a base_url. Returns null for loopback / on-host
// addresses (127.0.0.1, localhost, ::1) — those never leave the host, so they
// don't belong on the egress allowlist. Native-URL-free parse so it stays pure.
export function hostFromBaseUrl(base_url) {
  const raw = String(base_url || '').trim();
  const m = /^https?:\/\/([^/:?#]+)/i.exec(raw);
  if (!m) return null;
  const host = m[1].toLowerCase();
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]') return null;
  // A bare IP needs no DNS and reaches directly over the bridge NAT — skip it,
  // this helper only surfaces hostnames worth recording.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return null;
  return host;
}

// The egress host a connector implies, or null when it needs none (a local
// ollama on the host, an IP endpoint). Cloud providers → their fixed API host;
// operator-hosted providers → the base_url's hostname.
export function connectorEgressHost(connector) {
  if (!connector) return null;
  if (isCloudProvider(connector.provider)) return CLOUD_API_HOST[connector.provider] || null;
  return hostFromBaseUrl(connector.base_url);
}

// The distinct set of egress hosts implied by a set of ENABLED connectors — the
// model-API half of a project's allowlist, derived from what's configured
// (ADR-003) instead of the M4 static placeholder seed. Order-stable, deduped.
export function connectorEgressHosts(connectors = []) {
  const out = [];
  for (const c of connectors) {
    if (!c || !c.enabled) continue;
    const host = connectorEgressHost(c);
    if (host && !out.includes(host)) out.push(host);
  }
  return out;
}

// Does saving this connector require a one-time BAA acknowledgement (Q7)? Only
// cloud connectors, and only until one has been recorded. An ack, not a blocker
// — the route records who/when and proceeds either way.
export function requiresBaaAck(provider, existingAckAt = null) {
  return isCloudProvider(provider) && !existingAckAt;
}

// Client-safe view of a connector row. NEVER returns api_key_enc or the
// decrypted key; exposes secret_decryptable (a boolean the caller computes by
// attempting a decrypt — see connectors.js). test_status is stored as a small
// JSON verdict; parse it back for the UI.
export function publicConnectorShape(row, { secretDecryptable = false } = {}) {
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
    capabilities: parseCapabilities(row.capabilities),
    enabled: !!row.enabled,
    has_key: !!row.api_key_enc,
    secret_decryptable: !!secretDecryptable,
    test: test, // { ok, detail, models? } | null
    test_at: row.test_at || null,
    baa_ack_by: row.baa_ack_by || null,
    baa_ack_at: row.baa_ack_at || null,
    is_cloud: isCloudProvider(row.provider),
    egress_host: connectorEgressHost(row),
    created_by: row.created_by || null,
    created_at: row.created_at || null,
  };
}

// ---- test-connection plan (pure) ----
//
// The network call itself lives in connectors.js (it does I/O), but WHICH host,
// path, and headers to hit is a pure function of the connector — so it's here
// and unit-tested. A lightweight "list models" GET validates the key without
// spending generation tokens and without hardcoding a (stale) model id.
export function connectorTestPlan(connector) {
  const { provider, base_url } = connector;
  const key = connector.__apiKey || null; // injected by the data layer, never stored
  switch (provider) {
    case 'anthropic':
      return {
        url: 'https://api.anthropic.com/v1/models',
        headers: { 'x-api-key': key || '', 'anthropic-version': '2023-06-01' },
      };
    case 'openai':
      return {
        url: 'https://api.openai.com/v1/models',
        headers: key ? { authorization: `Bearer ${key}` } : {},
      };
    case 'gemini':
      return {
        url: `https://generativelanguage.googleapis.com/v1beta/models${key ? `?key=${encodeURIComponent(key)}` : ''}`,
        headers: {},
      };
    case 'ollama': {
      const b = String(base_url || '').replace(/\/+$/, '');
      return { url: `${b}/api/tags`, headers: {} };
    }
    case 'openai_compatible': {
      const b = String(base_url || '').replace(/\/+$/, '');
      return { url: `${b}/v1/models`, headers: key ? { authorization: `Bearer ${key}` } : {} };
    }
    default:
      return null;
  }
}

// Interpret a test HTTP response into the cached verdict shape.
export function interpretTestResponse(status, body) {
  if (status >= 200 && status < 300) {
    let models;
    try {
      const j = typeof body === 'string' ? JSON.parse(body) : body;
      const list = j?.data || j?.models || j?.models_list || null;
      if (Array.isArray(list)) models = list.length;
    } catch { /* non-JSON 2xx still counts as reachable */ }
    return { ok: true, detail: models != null ? `reachable — ${models} model(s)` : 'reachable', models };
  }
  if (status === 401 || status === 403) return { ok: false, detail: `auth rejected (HTTP ${status})` };
  if (status === 404) return { ok: false, detail: `endpoint not found (HTTP ${status})` };
  return { ok: false, detail: `HTTP ${status}` };
}
