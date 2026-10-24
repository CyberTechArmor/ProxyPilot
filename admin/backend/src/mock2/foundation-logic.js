// Mock2 application foundation — the HOST CONTROL PLANE's pure decisions
// (docs/features/app-foundation.md § "Feature switches and their rules").
//
// What lives here, with no I/O:
//   * the per-deployment switch state machine for storage and embeddings —
//     every rule of the design doc, as plans the service executes or as
//     refusals ({ code, message, options }) the routes answer with 409;
//   * validation of provider configuration (S3 endpoint/bucket/region/prefix,
//     embedding model/dimensions against vectorColumnPlan) and of the
//     write-only credentials;
//   * the API projections — which can NEVER carry a secret value: secrets
//     appear only as has_secret flags (a ratchet test pins this);
//   * the SQL the host sends to the app database (the store runs it through
//     foundationPsql, on stdin): literal escaping, the features/secrets sync,
//     the job rows, the index promotion;
//   * the component-secret mint rule for foundation deployments.
//
// foundation-store.js (mock2.db + the app DB) and foundation-service.js
// (orchestration) import this; the tests import it directly.
//
// Terminology (risk R7): nothing here is named "agent".

import {
  FEATURES, STORAGE_PROVIDERS, EMBEDDING_PROVIDERS, STORAGE_SWITCH_MODES, VECTOR_METRICS, HEALTH_STATUSES,
  STACK, FOUNDATION_DATABASE_URL, LOCAL_EMBEDDINGS_WARNING, DEPENDENT_CAPABILITIES, SECRET_NAMES, HOST_ONLY_SECRETS,
  FOUNDATION_NOTIFY_CHANNEL, VECTOR_INDEX_ID_RE, defaultFeatures, isValidSecretName, componentSecretName,
  pendingSecretName, vectorColumnPlan, vectorTableName,
} from './foundation-contract.js';

export const AUDIT_PREFIX = 'MOCK2_FOUNDATION_';

// Refusal codes (409 unless noted). The routes answer { code, message, options }.
export const CODES = Object.freeze({
  NOT_A_FOUNDATION_PROJECT: 'NOT_A_FOUNDATION_PROJECT',
  PROJECT_NOT_FOUND: 'PROJECT_NOT_FOUND',             // 404
  FOUNDATION_BUSY: 'FOUNDATION_BUSY',
  INVALID_REQUEST: 'INVALID_REQUEST',                 // 400
  INVALID_CONFIG: 'INVALID_CONFIG',                   // 400
  STORAGE_HAS_OBJECTS: 'STORAGE_HAS_OBJECTS',
  STORAGE_OBJECTS_UNKNOWN: 'STORAGE_OBJECTS_UNKNOWN',
  SWITCH_MODE_REQUIRED: 'SWITCH_MODE_REQUIRED',
  ACKNOWLEDGE_REQUIRED: 'ACKNOWLEDGE_REQUIRED',
  MISSING_CREDENTIALS: 'MISSING_CREDENTIALS',
  FOUNDATION_JOB_RUNNING: 'FOUNDATION_JOB_RUNNING',
  PROVIDER_TEST_FAILED: 'PROVIDER_TEST_FAILED',
  FOUNDATION_UNAVAILABLE: 'FOUNDATION_UNAVAILABLE',
  JOB_NOT_FOUND: 'JOB_NOT_FOUND',                     // 404
  JOB_NOT_ACTIVE: 'JOB_NOT_ACTIVE',
});

// The bundled S3's `app` identity is part of the stack's configuration and
// must stay stable while another provider is active (switching back to bundled
// needs it). Host-only in the contract: never synced, never projected.
export const BUNDLED_APP_IDENTITY = Object.freeze({
  accessKeyId: SECRET_NAMES.storageBundledAccessKeyId,
  secretAccessKey: SECRET_NAMES.storageBundledSecretAccessKey,
});
const RETAINED_HOST_NAMES = Object.freeze(Object.values(BUNDLED_APP_IDENTITY));

// A name the HOST store accepts: the contract's names plus the retained slot.
export function isStorableSecretName(name) {
  return isValidSecretName(name) || RETAINED_HOST_NAMES.includes(String(name || ''));
}
// Never synced into the app database.
export function isHostOnlySecret(name) {
  return HOST_ONLY_SECRETS.includes(name) || RETAINED_HOST_NAMES.includes(name);
}
// The names that ARE synced, sealed, into mock2_foundation.secrets.
export function appSecretNames(names = []) {
  return [...new Set(names)].filter((n) => isValidSecretName(n) && !isHostOnlySecret(n)).sort();
}

const STORAGE_CRED = Object.freeze({ access_key_id: SECRET_NAMES.storageAccessKeyId, secret_access_key: SECRET_NAMES.storageSecretAccessKey });
const EMBED_CRED = Object.freeze({ api_key: SECRET_NAMES.embeddingsApiKey });
export const CREDENTIAL_FIELDS = Object.freeze({ storage: STORAGE_CRED, embeddings: EMBED_CRED });
export function credentialSecretNames(feature, { pending = false } = {}) {
  const names = Object.values(CREDENTIAL_FIELDS[feature] || {});
  return pending ? names.map(pendingSecretName) : names;
}

// OpenAI's embedding models: native dimensions, and whether a smaller
// `dimensions` may be requested (the text-embedding-3 family can shorten).
export const OPENAI_DEFAULT_BASE_URL = 'https://api.openai.com/v1';
export const OPENAI_DEFAULT_MODEL = 'text-embedding-3-small';
export const OPENAI_MODELS = Object.freeze({
  'text-embedding-3-small': Object.freeze({ dimensions: 1536, shortenable: true }),
  'text-embedding-3-large': Object.freeze({ dimensions: 3072, shortenable: true }),
  'text-embedding-ada-002': Object.freeze({ dimensions: 1536, shortenable: false }),
});

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

export function refusal(code, message, options = [], status = 409) {
  return { ok: false, status, code, message, options };
}
const invalid = (message, field = null) => ({ ok: false, status: 400, code: CODES.INVALID_CONFIG, message, field, options: [] });
const plain = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const sameJson = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

export function parseJsonObject(text, fallback = null) {
  if (text == null || text === '') return fallback;
  try { const v = JSON.parse(text); return plain(v) ? v : fallback; } catch { return fallback; }
}

// ---------------------------------------------------------------------------
// validation — provider configuration
// ---------------------------------------------------------------------------

function parseHttpUrl(raw, field, { httpsOnly = false } = {}) {
  const s = String(raw ?? '').trim();
  if (!s) return { ok: false, error: invalid(`${field} is required`, field) };
  if (s.length > 512 || /[\s\x22\x27\\<>\x60]/.test(s)) return { ok: false, error: invalid(`${field} is not a valid URL`, field) };
  let u;
  try { u = new URL(s); } catch { return { ok: false, error: invalid(`${field} is not a valid URL`, field) }; }
  if (!['http:', 'https:'].includes(u.protocol)) return { ok: false, error: invalid(`${field} must be an http(s) URL`, field) };
  if (httpsOnly && u.protocol !== 'https:') return { ok: false, error: invalid(`${field} must use https`, field) };
  if (u.username || u.password) return { ok: false, error: invalid(`${field} must not carry credentials — they are entered separately and stored encrypted`, field) };
  if (u.search || u.hash) return { ok: false, error: invalid(`${field} must not carry a query or fragment`, field) };
  const path = u.pathname.replace(/\/+$/, '');
  return { ok: true, url: `${u.protocol}//${u.host}${path}` };
}

// S3 bucket naming (AWS general-purpose rules; R2/B2/MinIO accept a subset).
export function isValidBucketName(name) {
  const b = String(name ?? '');
  if (b.length < 3 || b.length > 63) return false;
  if (!/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(b)) return false;
  if (b.includes('..') || b.includes('.-') || b.includes('-.')) return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(b)) return false;
  if (/^(xn--|sthree-|amzn-s3-demo-)/.test(b)) return false;
  if (/(-s3alias|--ol-s3|\.mrap|--x-s3)$/.test(b)) return false;
  return true;
}

// validateStorageConfig(config) → { ok, config } (normalized) | refusal(400).
export function validateStorageConfig(config) {
  if (!plain(config)) return invalid('config is required for an external S3 provider', 'config');
  const allowed = new Set(['endpoint', 'bucket', 'region', 'prefix', 'force_path_style']);
  const extra = Object.keys(config).filter((k) => !allowed.has(k));
  if (extra.length) return invalid(`unknown storage config field(s): ${extra.join(', ')} — credentials go in "credentials"`, extra[0]);
  const ep = parseHttpUrl(config.endpoint, 'endpoint');
  if (!ep.ok) return ep.error;
  const bucket = String(config.bucket ?? '').trim();
  if (!isValidBucketName(bucket)) return invalid('bucket must be a valid S3 bucket name (3–63 lower-case letters, digits, dots and hyphens, starting and ending with a letter or digit)', 'bucket');
  const region = config.region == null || config.region === '' ? STACK.storage.region : String(config.region).trim();
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(region)) return invalid('region must be a region name such as us-east-1 or auto', 'region');
  let prefix = config.prefix == null ? '' : String(config.prefix);
  if (prefix.length > 256) return invalid('prefix is at most 256 characters', 'prefix');
  if (prefix && !/^[A-Za-z0-9!_.*\x27()\/-]+$/.test(prefix)) return invalid('prefix may contain letters, digits and ! _ . * \' ( ) / - only', 'prefix');
  if (prefix.startsWith('/') || prefix.includes('//') || prefix.split('/').some((seg) => seg === '.' || seg === '..')) {
    return invalid('prefix must be a relative key prefix (no leading slash, no empty, "." or ".." segments)', 'prefix');
  }
  if (prefix && !prefix.endsWith('/')) prefix = `${prefix}/`;
  if (config.force_path_style != null && typeof config.force_path_style !== 'boolean') return invalid('force_path_style must be true or false', 'force_path_style');
  return { ok: true, config: { endpoint: ep.url, region, bucket, prefix, force_path_style: config.force_path_style == null ? true : config.force_path_style } };
}

// validateEmbeddingsConfig(provider, config) → { ok, config, warnings } | refusal(400).
export function validateEmbeddingsConfig(provider, config = {}) {
  if (!EMBEDDING_PROVIDERS.includes(provider)) return invalid(`provider must be one of ${EMBEDDING_PROVIDERS.join(', ')}`, 'provider');
  const c = config == null ? {} : config;
  if (!plain(c)) return invalid('config must be an object', 'config');
  const allowed = new Set(['model', 'dimensions', 'base_url', 'metric']);
  const extra = Object.keys(c).filter((k) => !allowed.has(k));
  if (extra.length) return invalid(`unknown embeddings config field(s): ${extra.join(', ')} — an API key goes in "credentials"`, extra[0]);
  const metric = c.metric == null ? 'cosine' : String(c.metric);
  if (!VECTOR_METRICS.includes(metric)) return invalid(`metric must be one of ${VECTOR_METRICS.join(', ')}`, 'metric');
  const local = defaultFeatures().embeddings.config;
  let out;
  if (provider === 'local') {
    // The bundled server serves exactly one model.
    if (c.model != null && c.model !== local.model) return invalid(`the local embedding server serves ${local.model} only`, 'model');
    if (c.dimensions != null && Number(c.dimensions) !== local.dimensions) return invalid(`the local model has ${local.dimensions} dimensions`, 'dimensions');
    if (c.base_url != null && c.base_url !== local.base_url) return invalid('the local embedding server address is fixed', 'base_url');
    out = { base_url: local.base_url, model: local.model, dimensions: local.dimensions, metric };
  } else if (provider === 'openai') {
    const model = c.model == null || c.model === '' ? OPENAI_DEFAULT_MODEL : String(c.model);
    const known = OPENAI_MODELS[model];
    if (!known) return invalid(`model must be one of ${Object.keys(OPENAI_MODELS).join(', ')} (use openai_compatible for another model)`, 'model');
    const dimensions = c.dimensions == null || c.dimensions === '' ? known.dimensions : Number(c.dimensions);
    if (!Number.isInteger(dimensions) || dimensions < 1) return invalid('dimensions must be a positive whole number', 'dimensions');
    if (dimensions > known.dimensions || (!known.shortenable && dimensions !== known.dimensions)) {
      return invalid(known.shortenable ? `${model} has at most ${known.dimensions} dimensions` : `${model} has exactly ${known.dimensions} dimensions`, 'dimensions');
    }
    let base = OPENAI_DEFAULT_BASE_URL;
    if (c.base_url != null && c.base_url !== '') {
      const u = parseHttpUrl(c.base_url, 'base_url', { httpsOnly: true });
      if (!u.ok) return u.error;
      base = u.url;
    }
    out = { base_url: base, model, dimensions, metric };
  } else {
    const u = parseHttpUrl(c.base_url, 'base_url');
    if (!u.ok) return u.error;
    const model = String(c.model ?? '').trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._:\/@+-]{0,127}$/.test(model)) return invalid('model is required (letters, digits and . _ : / @ + -)', 'model');
    const dimensions = Number(c.dimensions);
    if (c.dimensions == null || !Number.isInteger(dimensions)) return invalid('dimensions is required for an OpenAI-compatible provider', 'dimensions');
    out = { base_url: u.url, model, dimensions, metric };
  }
  let plan;
  try { plan = vectorColumnPlan(out.dimensions); } catch (e) { return invalid(e.message, 'dimensions'); }
  const warnings = plan.ann === 'none'
    ? [`${out.dimensions} dimensions is above pgvector's index limit (4000): search runs as an exact scan, which is slow on large data`]
    : [];
  return { ok: true, config: out, warnings };
}

const PRINTABLE = /^[\x21-\x7e]+$/;
// validateCredentials(feature, provider, credentials) → { ok, values } (secret
// names → plaintext, in memory only) | refusal(400). null credentials → {}.
export function validateCredentials(feature, provider, credentials) {
  if (credentials == null) return { ok: true, values: {} };
  if (!plain(credentials)) return invalid('credentials must be an object', 'credentials');
  const fields = CREDENTIAL_FIELDS[feature];
  const extra = Object.keys(credentials).filter((k) => !(k in fields));
  if (extra.length) return invalid(`unknown credential field(s): ${extra.join(', ')}`, 'credentials');
  if ((feature === 'storage' && provider === 'bundled') || (feature === 'embeddings' && provider === 'local')) {
    if (Object.keys(credentials).length) return invalid(feature === 'storage' ? 'bundled storage uses its own platform identity; credentials are not accepted' : 'the local embedding server takes no API key', 'credentials');
    return { ok: true, values: {} };
  }
  const values = {};
  for (const [field, name] of Object.entries(fields)) {
    const v = credentials[field];
    if (v == null || v === '') continue;
    const s = String(v);
    const [min, max] = field === 'access_key_id' ? [3, 128] : [8, 1024];
    if (s.length < min || s.length > max || !PRINTABLE.test(s)) return invalid(`credentials.${field} must be ${min}–${max} printable characters with no spaces`, `credentials.${field}`);
    values[name] = s;
  }
  if (feature === 'storage') {
    const n = Object.keys(values).length;
    if (n === 1) return invalid('give both credentials.access_key_id and credentials.secret_access_key', 'credentials');
  }
  return { ok: true, values };
}

// ---------------------------------------------------------------------------
// the switch state machine
// ---------------------------------------------------------------------------
//
// current = { state, provider, config, pending, secretNames: Set|[], activeJob: {id,kind}|null }
// request = { action: 'on'|'off'|'switch', provider?, config?, credentials?, mode?, acknowledge? }
// facts   = { bundledObjectCount: number|null }        (storage only)
//
// → { ok: true, plan } | refusal. Plans:
//   { op: 'noop', reason }
//   { op: 'set_state', state, service: { name, action } | null }
//   { op: 'switch', pending: { provider, config, mode, acknowledge }, after: 'promote'|'copy_job'|'reembed',
//     credentials: 'supplied'|'reuse_active'|'bundled_identity'|'none', values: {name→plaintext} (pending names),
//     startService: name|null, warnings }

const jobRunning = (current) => refusal(CODES.FOUNDATION_JOB_RUNNING,
  `A ${current.activeJob.kind === 'reembed' ? 're-embedding' : 'storage copy'} job (${current.activeJob.id}) is still running for this deployment; wait for it to finish or cancel it first.`,
  [{ action: 'cancel_job', job_id: current.activeJob.id }]);

const has = (current, name) => (current.secretNames instanceof Set ? current.secretNames.has(name) : (current.secretNames || []).includes(name));

function storageSwitchOptions() {
  return [
    { action: 'switch', provider: 'external', mode: 'copy', description: 'Copy every object to an external S3 provider (verified size and sha256), then switch and stop the bundled storage.' },
    { action: 'switch', provider: 'external', mode: 'fresh', acknowledge: true, description: 'Switch to an external S3 provider now and start empty there; the existing objects stay in the preserved bundled volume and come back if bundled storage is turned on again.' },
  ];
}

export function planStorageAction({ current, request, facts = {} }) {
  const action = request?.action;
  if (!['on', 'off', 'switch'].includes(action)) return refusal(CODES.INVALID_REQUEST, "action must be 'on', 'off' or 'switch'", [], 400);
  if (current?.activeJob) return jobRunning(current);
  if (action === 'off') {
    if (current.state === 'off') return { ok: true, plan: { op: 'noop', reason: 'storage is already off' } };
    if (current.provider === 'external') {
      // Nothing on the external provider is touched; the bundled container
      // is not in use (already stopped).
      return { ok: true, plan: { op: 'set_state', state: 'off', service: null } };
    }
    const count = facts.bundledObjectCount;
    if (count === 0) return { ok: true, plan: { op: 'set_state', state: 'off', service: { name: 'storage', action: 'stop' } } };
    if (count == null) {
      return refusal(CODES.STORAGE_OBJECTS_UNKNOWN,
        'The bundled storage could not be checked for objects, so it cannot be turned off safely. Make sure the storage service is running and try again, or switch to an external S3 provider.',
        [{ action: 'off', description: 'Try again once the storage service answers.' }, ...storageSwitchOptions()]);
    }
    return refusal(CODES.STORAGE_HAS_OBJECTS,
      `The bundled storage still holds ${count} object(s), so it cannot be turned off. Choose an external S3 provider and either copy everything over or deliberately start fresh there.`,
      storageSwitchOptions());
  }
  if (action === 'on') {
    if (current.state === 'on') return { ok: true, plan: { op: 'noop', reason: 'storage is already on' } };
    // The same container on the same volume (bundled); nothing to start for external.
    return { ok: true, plan: { op: 'set_state', state: 'on', service: current.provider === 'bundled' ? { name: 'storage', action: 'start' } : null } };
  }
  // switch
  const provider = request.provider;
  if (!STORAGE_PROVIDERS.includes(provider)) return refusal(CODES.INVALID_REQUEST, `provider must be one of ${STORAGE_PROVIDERS.join(', ')}`, [], 400);
  if (request.mode != null && !STORAGE_SWITCH_MODES.includes(request.mode)) return refusal(CODES.INVALID_REQUEST, `mode must be one of ${STORAGE_SWITCH_MODES.join(', ')}`, [], 400);
  const creds = validateCredentials('storage', provider, request.credentials);
  if (!creds.ok) return creds;
  let config;
  if (provider === 'bundled') {
    if (current.provider === 'bundled') return refusal(CODES.INVALID_REQUEST, 'storage already uses the bundled provider; turn it on or off instead', [{ action: current.state === 'on' ? 'off' : 'on' }], 400);
    if (request.config != null && Object.keys(request.config).length) return refusal(CODES.INVALID_CONFIG, 'the bundled storage configuration is fixed', [], 400);
    config = defaultFeatures().storage.config;
  } else {
    const v = validateStorageConfig(request.config);
    if (!v.ok) return v;
    config = v.config;
    if (current.provider === 'external' && sameJson(current.config, config) && !Object.keys(creds.values).length) {
      return { ok: true, plan: { op: 'noop', reason: 'storage already uses this external provider' } };
    }
  }
  // Credentials for the pending provider.
  let credentials;
  const values = {};
  if (provider === 'bundled') {
    credentials = 'bundled_identity';
  } else if (Object.keys(creds.values).length) {
    credentials = 'supplied';
    for (const [name, v] of Object.entries(creds.values)) values[pendingSecretName(name)] = v;
  } else if (current.provider === 'external' && current.config?.endpoint === config.endpoint
    && has(current, STORAGE_CRED.access_key_id) && has(current, STORAGE_CRED.secret_access_key)) {
    // Same endpoint: the active credentials may be reused. A NEW endpoint never
    // receives the stored credentials of another one.
    credentials = 'reuse_active';
  } else {
    return refusal(CODES.MISSING_CREDENTIALS, 'An external S3 provider needs credentials.access_key_id and credentials.secret_access_key.',
      [{ action: 'switch', provider, field: 'credentials' }]);
  }
  // Does the CURRENT provider hold objects that would be left behind?
  const sourceEmpty = current.provider === 'bundled' && facts.bundledObjectCount === 0;
  let after = 'promote';
  if (!sourceEmpty) {
    if (!request.mode) {
      const where = current.provider === 'bundled'
        ? (facts.bundledObjectCount == null ? 'The bundled storage could not be checked for objects' : `The bundled storage holds ${facts.bundledObjectCount} object(s)`)
        : 'The current external provider may hold objects';
      return refusal(CODES.SWITCH_MODE_REQUIRED, `${where}. Choose mode "copy" to copy everything over (verified) or "fresh" (with acknowledge: true) to start empty on the new provider.`, [
        { action: 'switch', provider, mode: 'copy' },
        { action: 'switch', provider, mode: 'fresh', acknowledge: true },
      ]);
    }
    if (request.mode === 'fresh' && request.acknowledge !== true) {
      return refusal(CODES.ACKNOWLEDGE_REQUIRED,
        `Starting fresh leaves the existing objects on the ${current.provider} provider${current.provider === 'bundled' ? ' (kept in its preserved volume)' : ''}; the app will not see them. Send acknowledge: true to confirm.`,
        [{ action: 'switch', provider, mode: 'fresh', acknowledge: true }, { action: 'switch', provider, mode: 'copy' }]);
    }
    after = request.mode === 'copy' ? 'copy_job' : 'promote';
  }
  return {
    ok: true,
    plan: {
      op: 'switch',
      pending: { provider, config, mode: sourceEmpty ? null : request.mode, acknowledge: request.acknowledge === true },
      after, credentials, values,
      // The pending provider is tested from inside the guest: bundled must run.
      startService: provider === 'bundled' ? 'storage' : null,
      warnings: [],
    },
  };
}

// needsReembed(active, pending) — a different vector space: provider, model,
// dimensions or metric changed. A key or address change alone does not.
export function needsReembed(active, pending) {
  const a = active || {}; const p = pending || {};
  return a.provider !== p.provider || a.config?.model !== p.config?.model
    || Number(a.config?.dimensions) !== Number(p.config?.dimensions) || (a.config?.metric || 'cosine') !== (p.config?.metric || 'cosine');
}

export function planEmbeddingsAction({ current, request }) {
  const action = request?.action;
  if (!['on', 'off', 'switch'].includes(action)) return refusal(CODES.INVALID_REQUEST, "action must be 'on', 'off' or 'switch'", [], 400);
  if (current?.activeJob) return jobRunning(current);
  if (action === 'off') {
    if (current.state === 'off') return { ok: true, plan: { op: 'noop', reason: 'embeddings are already off' } };
    // Vectors stay in Postgres; search answers EMBEDDINGS_OFF.
    return { ok: true, plan: { op: 'set_state', state: 'off', service: current.provider === 'local' ? { name: 'embeddings', action: 'stop' } : null } };
  }
  if (action === 'on') {
    if (current.state === 'on') return { ok: true, plan: { op: 'noop', reason: 'embeddings are already on' } };
    // Same provider, model and dimensions: search is available again at once.
    return { ok: true, plan: { op: 'set_state', state: 'on', service: current.provider === 'local' ? { name: 'embeddings', action: 'start' } : null } };
  }
  const provider = request.provider;
  if (!EMBEDDING_PROVIDERS.includes(provider)) return refusal(CODES.INVALID_REQUEST, `provider must be one of ${EMBEDDING_PROVIDERS.join(', ')}`, [], 400);
  const v = validateEmbeddingsConfig(provider, request.config);
  if (!v.ok) return v;
  const creds = validateCredentials('embeddings', provider, request.credentials);
  if (!creds.ok) return creds;
  const config = v.config;
  const pending = { provider, config };
  const reembed = needsReembed({ provider: current.provider, config: current.config }, pending);
  const supplied = Object.keys(creds.values).length > 0;
  if (!reembed && !supplied && current.config?.base_url === config.base_url) {
    return { ok: true, plan: { op: 'noop', reason: 'embeddings already use this provider, model and dimensions' } };
  }
  let credentials = 'none';
  const values = {};
  if (provider === 'local') credentials = 'none';
  else if (supplied) {
    credentials = 'supplied';
    for (const [name, val] of Object.entries(creds.values)) values[pendingSecretName(name)] = val;
  } else if (current.provider === provider && current.config?.base_url === config.base_url && has(current, EMBED_CRED.api_key)) {
    // Same provider at the same address: the active key may be reused. A new
    // address never receives the stored key of another one.
    credentials = 'reuse_active';
  } else if (provider === 'openai') {
    return refusal(CODES.MISSING_CREDENTIALS, 'OpenAI needs credentials.api_key.', [{ action: 'switch', provider, field: 'credentials' }]);
  }
  return {
    ok: true,
    plan: {
      op: 'switch',
      pending: { provider, config, mode: null, acknowledge: false },
      after: reembed ? 'reembed' : 'promote',
      credentials, values,
      startService: provider === 'local' ? 'embeddings' : null,
      warnings: v.warnings,
    },
  };
}

// The active provider still needs these after a promotion; a service stops
// when nothing uses it any more (its volume is always kept).
export function serviceStillUsed(feature, row) {
  if (!row || row.state === 'off') return false;
  return feature === 'storage' ? row.provider === 'bundled' : row.provider === 'local';
}

// ---------------------------------------------------------------------------
// test results from the app CLI (exit 0 ok · 1 error · 2 unavailable)
// ---------------------------------------------------------------------------

// Remove anything that could be a credential from text that reaches a record
// or a response: every known value (the ones just supplied), and common token
// shapes (an upstream error can echo part of a key).
export function redactSecrets(text, knownValues = []) {
  let s = String(text ?? '');
  for (const v of knownValues) {
    const val = String(v ?? '');
    if (val.length >= 4) s = s.split(val).join('[redacted]');
  }
  return s
    .replace(/\bbearer\s+[A-Za-z0-9._~+\/=-]{4,}/gi, 'Bearer [redacted]')
    .replace(/\bsk-[A-Za-z0-9_*-]{6,}/g, 'sk-[redacted]')
    .replace(/\b(AKIA|ASIA)[A-Z0-9]{12,}\b/g, '[redacted-access-key]')
    .replace(/(authorization|api[_-]?key|secret(?:[_-]?access[_-]?key)?|password|passwd|token|credentials?)([\x22\x27\s:=]+)([^\s\x22\x27,}]{4,})/gi, '$1$2[redacted]')
    .replace(/mfs1:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]*/g, '[sealed]');
}

const SECRETISH_KEY = /secret|password|token|credential|api_?key|access_?key|authorization|sealed|master/i;
// A detail object for a projection: primitives only, secret-looking keys
// dropped, strings redacted and bounded. Depth 2.
export function sanitizeDetail(detail, knownValues = [], depth = 0) {
  if (detail == null) return {};
  if (typeof detail !== 'object') return { message: redactSecrets(String(detail), knownValues).slice(0, 300) };
  const out = {};
  for (const [k, v] of Object.entries(detail).slice(0, 20)) {
    if (SECRETISH_KEY.test(k)) continue;
    if (v == null || typeof v === 'number' || typeof v === 'boolean') out[k] = v;
    else if (typeof v === 'string') out[k] = redactSecrets(v, knownValues).slice(0, 300);
    else if (depth < 1 && typeof v === 'object' && !Array.isArray(v)) out[k] = sanitizeDetail(v, knownValues, depth + 1);
  }
  return out;
}

function lastJson(stdout) {
  const s = String(stdout || '').trim();
  if (!s) return null;
  try { return JSON.parse(s); } catch { /* look for the last JSON line */ }
  const lines = s.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('{') || l.startsWith('['));
  for (let i = lines.length - 1; i >= 0; i--) { try { return JSON.parse(lines[i]); } catch { /* next */ } }
  return null;
}

// interpretCliTest({ code, stdout, stderr }, knownValues) → { ok, status, detail }.
// ok only for exit 0 with no contrary status; exit 2 is unavailable or
// missing_credentials (reported, never ready).
export function interpretCliTest(result, knownValues = []) {
  const code = Number(result?.code);
  const parsed = lastJson(result?.stdout);
  const reported = plain(parsed) && HEALTH_STATUSES.includes(parsed.status) ? parsed.status : null;
  let status;
  if (code === 0) status = reported && reported !== 'ready' ? reported : 'ready';
  else if (code === 2) status = reported === 'missing_credentials' ? 'missing_credentials' : (reported && reported !== 'ready' ? reported : 'unavailable');
  else status = reported && reported !== 'ready' ? reported : 'degraded';
  const raw = plain(parsed) ? (parsed.detail ?? parsed.error ?? parsed.message ?? parsed) : (String(result?.stderr || result?.stdout || '').trim().slice(-400) || null);
  const detail = sanitizeDetail(plain(raw) ? raw : (raw == null ? {} : { message: String(raw) }), knownValues);
  return { ok: status === 'ready', status, detail };
}

// parseHealthOutput(stdout) → [{ component, status, detail }] from `health --json`.
export function parseHealthOutput(stdout) {
  const parsed = lastJson(stdout);
  const list = Array.isArray(parsed) ? parsed : (plain(parsed) && Array.isArray(parsed.components) ? parsed.components : []);
  return list.filter((r) => plain(r) && ['database', 'storage', 'embeddings'].includes(r.component))
    .map((r) => ({ component: r.component, status: HEALTH_STATUSES.includes(r.status) ? r.status : 'unavailable', detail: sanitizeDetail(r.detail), checked_at: r.checked_at || null }));
}

// ---------------------------------------------------------------------------
// projections — NEVER a secret value
// ---------------------------------------------------------------------------

// The non-secret config keys a projection may show, per feature.
const CONFIG_KEYS = Object.freeze({
  storage: ['endpoint', 'region', 'bucket', 'prefix', 'force_path_style'],
  embeddings: ['base_url', 'model', 'dimensions', 'metric'],
});
function pickConfig(feature, config) {
  const out = {};
  for (const k of CONFIG_KEYS[feature]) if (config && config[k] !== undefined) out[k] = config[k];
  return out;
}

// Storage always needs credentials (bundled: the platform's own `app`
// identity, written at provisioning); embeddings only for OpenAI (an
// OpenAI-compatible server may take none; the local one takes none).
export function credentialsRequired(feature, provider) {
  if (feature === 'storage') return true;
  return provider === 'openai';
}
function hasCredentials(feature, provider, names, { pending = false } = {}) {
  if (feature === 'storage' && provider === 'bundled') {
    // The platform identity (active: storage.*; pending: copied in on staging).
    return credentialSecretNames('storage', { pending }).every((n) => names.has(n));
  }
  if (feature === 'embeddings' && provider === 'local') return false;
  const want = credentialSecretNames(feature, { pending });
  return feature === 'storage' ? want.every((n) => names.has(n)) : want.some((n) => names.has(n));
}

// featureHealth — `ready` only from a real probe newer than the feature's
// last change; off and missing credentials override; no probe → unavailable.
export function featureHealth({ feature, row, names, probe }) {
  if (row.state === 'off') return { status: 'off', detail: {}, checked_at: probe?.checked_at || null };
  if (credentialsRequired(feature, row.provider) && !hasCredentials(feature, row.provider, names)) {
    const message = feature === 'embeddings' ? 'The embedding provider has no API key stored.'
      : row.provider === 'bundled' ? 'The bundled storage identity has not been provisioned yet.' : 'The external S3 provider has no credentials stored.';
    return { status: 'missing_credentials', detail: { message }, checked_at: probe?.checked_at || null };
  }
  if (!probe) return { status: 'unavailable', detail: { message: 'not probed yet' }, checked_at: null };
  const stale = probe.checked_at && row.updated_at && Date.parse(probe.checked_at) < Date.parse(row.updated_at);
  if (stale && probe.status === 'ready') return { status: 'unavailable', detail: { message: 'not probed since the last change' }, checked_at: probe.checked_at };
  return { status: HEALTH_STATUSES.includes(probe.status) ? probe.status : 'unavailable', detail: sanitizeDetail(probe.detail), checked_at: probe.checked_at || null };
}

function projectPending(feature, pending, names) {
  if (!plain(pending)) return null;
  return {
    provider: pending.provider ?? null,
    config: pickConfig(feature, pending.config),
    mode: pending.mode ?? null,
    acknowledge: pending.acknowledge === true,
    staged_at: pending.staged_at ?? null,
    test: plain(pending.test) ? { ok: pending.test.ok === true, status: HEALTH_STATUSES.includes(pending.test.status) ? pending.test.status : 'unavailable', detail: sanitizeDetail(pending.test.detail), at: pending.test.at ?? null } : null,
    job_id: pending.job_id ?? null,
    has_secret: hasCredentials(feature, pending.provider, names, { pending: true }),
  };
}

export function projectFeature({ feature, row, names, probe }) {
  const shaped = {
    state: row.state,
    provider: row.provider,
    config: pickConfig(feature, row.config),
    pending: projectPending(feature, row.pending, names),
    health: featureHealth({ feature, row, names, probe }),
    has_secret: hasCredentials(feature, row.provider, names),
    dependents: [...DEPENDENT_CAPABILITIES[feature]],
  };
  if (feature === 'embeddings' && row.provider === 'local') shaped.warning = LOCAL_EMBEDDINGS_WARNING;
  return shaped;
}

export function projectJob(row) {
  if (!row) return null;
  const params = parseJsonObject(row.params_json, {}) || {};
  const progress = parseJsonObject(row.progress_json, {}) || {};
  const pub = {};
  for (const [k, v] of Object.entries(progress)) {
    if (SECRETISH_KEY.test(k)) continue;
    if (v == null || typeof v === 'number' || typeof v === 'boolean') pub[k] = v;
    else if (typeof v === 'string') pub[k] = redactSecrets(v).slice(0, 300);
  }
  const side = (s) => (plain(s) ? { provider: s.provider ?? null, ...(s.model ? { model: s.model } : {}), ...(s.dimensions ? { dimensions: s.dimensions } : {}), ...(s.bucket ? { bucket: s.bucket } : {}) } : null);
  return {
    id: row.id,
    kind: row.kind,
    state: row.state,
    from: side(params.from),
    to: side(params.to),
    ...(params.target_index ? { target_index: params.target_index } : {}),
    progress: pub,
    error: row.error ? redactSecrets(row.error).slice(0, 500) : null,
    created_by: row.created_by ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    finished_at: row.finished_at ?? null,
  };
}

// projectFoundation — the GET /foundation shape.
//   project: the mock2_projects row; rows: { storage, embeddings } (parsed);
//   secretNames: the names held (never values); jobs: mock2_foundation_jobs rows;
//   health: [{ component, status, detail, checked_at }] | null (app DB unreachable).
export function projectFoundation({ project, rows, secretNames = [], jobs = [], health = null, healthError = null }) {
  if (!project?.foundation_version) {
    return { foundation_version: null, database: null, storage: null, embeddings: null, jobs: [], warnings: [] };
  }
  const names = new Set(secretNames);
  const probes = new Map((health || []).map((h) => [h.component, h]));
  const dbProbe = probes.get('database') || null;
  const database = {
    state: 'on',
    provider: 'postgres',
    config: { socket_dir: STACK.postgres.socketDir, database: STACK.postgres.database, role: STACK.postgres.role, url: FOUNDATION_DATABASE_URL, image: STACK.postgres.image },
    pending: null,
    health: dbProbe
      ? { status: HEALTH_STATUSES.includes(dbProbe.status) ? dbProbe.status : 'unavailable', detail: sanitizeDetail(dbProbe.detail), checked_at: dbProbe.checked_at || null }
      : { status: 'unavailable', detail: { message: healthError ? sanitizeDetail({ message: healthError }).message : 'not probed yet' }, checked_at: null },
    has_secret: false,
    dependents: [],
  };
  const storage = projectFeature({ feature: 'storage', row: rows.storage, names, probe: probes.get('storage') || null });
  const embeddings = projectFeature({ feature: 'embeddings', row: rows.embeddings, names, probe: probes.get('embeddings') || null });
  const warnings = [];
  if (rows.embeddings.provider === 'local' || rows.embeddings.pending?.provider === 'local') warnings.push({ code: 'LOCAL_EMBEDDINGS', message: LOCAL_EMBEDDINGS_WARNING });
  for (const r of [rows.embeddings.config, rows.embeddings.pending?.config]) {
    if (r?.dimensions) {
      try { if (vectorColumnPlan(r.dimensions).ann === 'none') warnings.push({ code: 'EXACT_SCAN_ONLY', message: `${r.dimensions} dimensions is above pgvector's index limit: search is an exact scan.` }); } catch { /* invalid stays invalid */ }
    }
  }
  if (rows.storage.state === 'on' && rows.storage.provider === 'external' && /^http:/.test(rows.storage.config?.endpoint || '')) {
    warnings.push({ code: 'PLAINTEXT_STORAGE_ENDPOINT', message: 'The external S3 endpoint uses http: requests and credentials signatures travel unencrypted.' });
  }
  return {
    foundation_version: project.foundation_version,
    database, storage, embeddings,
    jobs: jobs.map(projectJob),
    warnings,
  };
}

// Normalize stored mock2_foundation_features rows (or none) into the two features.
export function featureRowsFrom(dbRows = []) {
  const defaults = defaultFeatures();
  const out = {};
  for (const feature of FEATURES) {
    const r = dbRows.find((x) => x.feature === feature);
    out[feature] = r
      ? { state: r.state, provider: r.provider, config: parseJsonObject(r.config_json, {}) || {}, pending: parseJsonObject(r.pending_json, null), updated_at: r.updated_at, stored: true }
      : { ...defaults[feature], pending: null, updated_at: null, stored: false };
  }
  return out;
}

// ---------------------------------------------------------------------------
// SQL for the app database (run by the store through foundationPsql; the
// script travels on stdin, never argv). Literals are quote-doubled with
// standard_conforming_strings forced on, so a backslash is never an escape;
// a NUL byte is refused outright.
// ---------------------------------------------------------------------------

export function sqlLiteral(value) {
  if (value === null || value === undefined) return 'NULL';
  const s = String(value);
  if (s.includes('\u0000')) throw new Error('a NUL byte cannot be sent to the app database');
  return `'${s.replace(/\x27/g, "''")}'`;
}
const sqlJson = (obj) => (obj == null ? 'NULL' : `${sqlLiteral(JSON.stringify(obj))}::jsonb`);
const SQL_PREAMBLE = '\\set ON_ERROR_STOP on\nSET standard_conforming_strings = on;\n';
const GEN = `(SELECT (value #>> '{}')::bigint FROM mock2_foundation.meta WHERE key = 'generation')`;
const SEALED_RE = /^mfs1:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]*$/;
export const SQL_MARKERS = Object.freeze({ generation: 'MF_GENERATION:', json: 'MF_JSON:', ok: 'MF_OK:' });

// What the app database is told about a pending switch: provider + config
// (+ mode). Test results, timestamps and job ids stay host-side.
export function appPendingView(pending) {
  if (!plain(pending) || !pending.provider) return null;
  return { provider: pending.provider, config: pending.config || {}, ...(pending.mode ? { mode: pending.mode } : {}) };
}

// buildSyncSql({ features, sealed, statements }) — one transaction: bump the
// generation, upsert both feature rows, upsert every sealed app secret, delete
// the app-DB secrets that no longer exist, NOTIFY with the new generation.
//   features: { storage: { state, provider, config, pending }, embeddings: … }
//   sealed:   [{ name, sealed }] (already sealed under the master key)
//   statements: extra SQL run first inside the same transaction (index promotion)
export function buildSyncSql({ features, sealed = [], statements = [] }) {
  const lines = [SQL_PREAMBLE, 'BEGIN;'];
  lines.push(`INSERT INTO mock2_foundation.meta (key, value, updated_at) VALUES ('generation', to_jsonb(1::bigint), now())
  ON CONFLICT (key) DO UPDATE SET value = to_jsonb(COALESCE((mock2_foundation.meta.value #>> '{}')::bigint, 0) + 1), updated_at = now();`);
  for (const s of statements) lines.push(s);
  for (const feature of FEATURES) {
    const f = features[feature];
    if (!f) continue;
    if (!['on', 'off'].includes(f.state)) throw new Error(`invalid state for ${feature}`);
    lines.push(`INSERT INTO mock2_foundation.features (feature, state, provider, config, pending, generation, updated_at)
  VALUES (${sqlLiteral(feature)}, ${sqlLiteral(f.state)}, ${sqlLiteral(f.provider)}, ${sqlJson(f.config || {})}, ${sqlJson(appPendingView(f.pending))}, ${GEN}, now())
  ON CONFLICT (feature) DO UPDATE SET state = EXCLUDED.state, provider = EXCLUDED.provider, config = EXCLUDED.config, pending = EXCLUDED.pending, generation = EXCLUDED.generation, updated_at = now();`);
  }
  const names = [];
  for (const { name, sealed: value } of sealed) {
    if (!isValidSecretName(name) || isHostOnlySecret(name)) throw new Error(`refusing to sync secret ${name}`);
    if (!SEALED_RE.test(String(value || ''))) throw new Error(`secret ${name} is not sealed`);
    names.push(name);
    lines.push(`INSERT INTO mock2_foundation.secrets (name, sealed, generation, updated_at) VALUES (${sqlLiteral(name)}, ${sqlLiteral(value)}, ${GEN}, now())
  ON CONFLICT (name) DO UPDATE SET sealed = EXCLUDED.sealed, generation = EXCLUDED.generation, updated_at = now();`);
  }
  lines.push(names.length
    ? `DELETE FROM mock2_foundation.secrets WHERE name NOT IN (${names.map(sqlLiteral).join(', ')});`
    : 'DELETE FROM mock2_foundation.secrets;');
  lines.push(`SELECT pg_notify(${sqlLiteral(FOUNDATION_NOTIFY_CHANNEL)}, ${GEN}::text);`);
  lines.push('COMMIT;');
  lines.push(`SELECT ${sqlLiteral(SQL_MARKERS.generation)} || (value #>> '{}') FROM mock2_foundation.meta WHERE key = 'generation';`);
  return `${lines.join('\n')}\n`;
}

export function parseMarker(stdout, marker) {
  return String(stdout || '').split('\n').map((l) => l.trim()).filter((l) => l.startsWith(marker)).map((l) => l.slice(marker.length));
}
export function parseJsonRows(stdout) {
  const out = [];
  for (const raw of parseMarker(stdout, SQL_MARKERS.json)) { try { out.push(JSON.parse(raw)); } catch { /* skip */ } }
  return out;
}
export function parseGeneration(stdout) {
  const g = parseMarker(stdout, SQL_MARKERS.generation).pop();
  return g != null && /^\d+$/.test(g) ? Number(g) : null;
}

const JOB_ID_RE = /^fj_[a-z0-9]{8,32}$/;
export function isValidJobId(id) { return JOB_ID_RE.test(String(id || '')); }
export function newJobId(randomHex) { return `fj_${String(randomHex).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 24)}`; }
export function newIndexId(randomHex) { return `ix_${String(randomHex).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20)}`; }

// buildJobInsertSql({ job, index }) — the jobs row, and for a reembed the
// target index row in state 'building'.
export function buildJobInsertSql({ job, index = null }) {
  if (!isValidJobId(job.id)) throw new Error('invalid job id');
  if (!['storage_migrate', 'reembed'].includes(job.kind)) throw new Error('invalid job kind');
  const lines = [SQL_PREAMBLE, 'BEGIN;'];
  lines.push(`INSERT INTO mock2_foundation.jobs (id, kind, state, params, progress) VALUES (${sqlLiteral(job.id)}, ${sqlLiteral(job.kind)}, 'queued', ${sqlJson(job.params || {})}, '{}'::jsonb) ON CONFLICT (id) DO NOTHING;`);
  if (index) {
    if (!VECTOR_INDEX_ID_RE.test(index.id)) throw new Error('invalid index id');
    vectorColumnPlan(index.dimensions);
    if (!VECTOR_METRICS.includes(index.metric)) throw new Error('invalid metric');
    lines.push(`INSERT INTO mock2_foundation.vector_indexes (id, provider, model, dimensions, metric, state, table_name) VALUES (${sqlLiteral(index.id)}, ${sqlLiteral(index.provider)}, ${sqlLiteral(index.model)}, ${Number(index.dimensions)}, ${sqlLiteral(index.metric)}, 'building', ${sqlLiteral(vectorTableName(index.id))}) ON CONFLICT (id) DO NOTHING;`);
  }
  lines.push('COMMIT;');
  lines.push(`SELECT ${sqlLiteral(`${SQL_MARKERS.ok}inserted`)};`);
  return `${lines.join('\n')}\n`;
}

export function buildJobPollSql({ jobId, indexId = null }) {
  if (!isValidJobId(jobId)) throw new Error('invalid job id');
  const lines = [SQL_PREAMBLE];
  lines.push(`SELECT ${sqlLiteral(SQL_MARKERS.json)} || json_build_object('type', 'job', 'state', state, 'progress', progress, 'error', error, 'updated_at', updated_at, 'finished_at', finished_at)::text FROM mock2_foundation.jobs WHERE id = ${sqlLiteral(jobId)};`);
  if (indexId) {
    if (!VECTOR_INDEX_ID_RE.test(indexId)) throw new Error('invalid index id');
    lines.push(`SELECT ${sqlLiteral(SQL_MARKERS.json)} || json_build_object('type', 'index', 'id', id, 'state', state, 'item_count', item_count, 'dimensions', dimensions)::text FROM mock2_foundation.vector_indexes WHERE id = ${sqlLiteral(indexId)};`);
  }
  lines.push(`SELECT ${sqlLiteral(`${SQL_MARKERS.ok}polled`)};`);
  return `${lines.join('\n')}\n`;
}

export function buildActiveIndexSql() {
  return `${SQL_PREAMBLE}SELECT ${sqlLiteral(SQL_MARKERS.json)} || json_build_object('type', 'index', 'id', id, 'provider', provider, 'model', model, 'dimensions', dimensions, 'metric', metric, 'item_count', item_count)::text FROM mock2_foundation.vector_indexes WHERE state = 'active';
SELECT ${sqlLiteral(`${SQL_MARKERS.ok}read`)};
`;
}

export function buildHealthReadSql() {
  return `${SQL_PREAMBLE}SELECT ${sqlLiteral(SQL_MARKERS.json)} || json_build_object('component', component, 'status', status, 'detail', detail, 'checked_at', checked_at)::text FROM mock2_foundation.health;
SELECT ${sqlLiteral(`${SQL_MARKERS.ok}read`)};
`;
}

// The index promotion, as statements for buildSyncSql (same transaction as
// the pending → active feature switch): retire the active index, activate the
// validated one, and fail the whole transaction if it was not `ready`.
export function promoteIndexStatements(indexId) {
  if (!VECTOR_INDEX_ID_RE.test(String(indexId || ''))) throw new Error('invalid index id');
  const id = sqlLiteral(indexId);
  return [
    `DO $mf$ BEGIN IF NOT EXISTS (SELECT 1 FROM mock2_foundation.vector_indexes WHERE id = ${id} AND state IN ('ready','active')) THEN RAISE EXCEPTION 'index % is not ready', ${id}; END IF; END $mf$;`,
    `UPDATE mock2_foundation.vector_indexes SET state = 'retired', retired_at = now() WHERE state = 'active' AND id <> ${id};`,
    `UPDATE mock2_foundation.vector_indexes SET state = 'active', activated_at = now() WHERE id = ${id} AND state = 'ready';`,
  ];
}

export function buildCancelJobSql({ jobId, indexId = null }) {
  if (!isValidJobId(jobId)) throw new Error('invalid job id');
  const lines = [SQL_PREAMBLE, 'BEGIN;'];
  lines.push(`UPDATE mock2_foundation.jobs SET state = 'cancelled', updated_at = now(), finished_at = now() WHERE id = ${sqlLiteral(jobId)} AND state IN ('queued','running');`);
  if (indexId) {
    if (!VECTOR_INDEX_ID_RE.test(indexId)) throw new Error('invalid index id');
    lines.push(`UPDATE mock2_foundation.vector_indexes SET state = 'failed' WHERE id = ${sqlLiteral(indexId)} AND state IN ('building','ready');`);
  }
  lines.push('COMMIT;');
  lines.push(`SELECT ${sqlLiteral(`${SQL_MARKERS.ok}cancelled`)};`);
  return `${lines.join('\n')}\n`;
}

// The data-guard probe of a component secret on a foundation deployment: does
// the protected table exist, and does it hold rows with a stored secret?
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
export function buildGuardProbeSql(guard) {
  const schema = guard?.schema || 'public';
  for (const v of [schema, guard?.table, guard?.secret_column]) if (!IDENT_RE.test(String(v || ''))) throw new Error('invalid data guard identifier');
  const q = (s) => `"${s}"`;
  const rel = `${q(schema)}.${q(guard.table)}`;
  return `${SQL_PREAMBLE}SELECT ${sqlLiteral(SQL_MARKERS.json)} || json_build_object('exists', to_regclass(${sqlLiteral(rel)}) IS NOT NULL)::text;
SELECT ${sqlLiteral(SQL_MARKERS.ok)} || 'probe';
`;
}
export function buildGuardRowsSql(guard) {
  const schema = guard?.schema || 'public';
  for (const v of [schema, guard?.table, guard?.secret_column]) if (!IDENT_RE.test(String(v || ''))) throw new Error('invalid data guard identifier');
  const q = (s) => `"${s}"`;
  return `${SQL_PREAMBLE}SELECT ${sqlLiteral(SQL_MARKERS.json)} || json_build_object('rows', EXISTS (SELECT 1 FROM ${q(schema)}.${q(guard.table)} WHERE ${q(guard.secret_column)} IS NOT NULL AND ${q(guard.secret_column)}::text <> ''))::text;
SELECT ${sqlLiteral(SQL_MARKERS.ok)} || 'rows';
`;
}

// ---------------------------------------------------------------------------
// component secrets on a foundation deployment
// ---------------------------------------------------------------------------
//
// The keys installed components own (contract config: secret + generate) are
// kept as component.<KEY> in mock2_foundation_secrets and delivered sealed
// through the app database — never in /etc/environment. The rule:
//   * a key already held is never overwritten;
//   * a key that guards nothing is minted;
//   * a key that guards stored data (protects / requires_marker) is minted
//     only on a newly provisioned deployment whose protected table is absent
//     or empty — there is no earlier data to lose or migrate. Otherwise it is
//     deferred and says why (the legacy deploy mints those after stopping
//     the app; a foundation deployment needs an operator to decide).
//   * a key that cannot be a foundation secret name is deferred.
// probes: { [KEY]: 'no_table' | 'empty' | 'rows' | 'unknown' }.
export function planFoundationComponentMint({ configs = [], heldNames = [], newlyProvisioned = false, probes = {} } = {}) {
  const held = new Set(heldNames);
  const out = { held: [], mint: [], deferred: [] };
  const seen = new Set();
  for (const c of configs || []) {
    if (!c || c.secret !== true || c.generate !== true) continue;
    const key = String(c.key || '');
    if (seen.has(key)) continue;
    seen.add(key);
    const name = componentSecretName(key);
    if (!isValidSecretName(name)) {
      out.deferred.push({ key, reason: `${key} cannot be kept as a foundation secret (component secret names are upper-case letters, digits and underscores, starting with a letter)` });
      continue;
    }
    if (held.has(name)) { out.held.push(key); continue; }
    const guarded = !!(c.protects?.table || c.requires_marker);
    if (!guarded) { out.mint.push(key); continue; }
    const probe = c.protects?.table ? (probes[key] || 'unknown') : 'no_table';
    if (newlyProvisioned && (probe === 'no_table' || probe === 'empty')) { out.mint.push(key); continue; }
    out.deferred.push({
      key,
      reason: newlyProvisioned
        ? `${key} protects stored data and the probe of ${c.protects?.table || 'its table'} reported ${probe}; it is not minted until that is understood`
        : `${key} protects stored data on an existing deployment; it is minted into the foundation secret store only on a newly provisioned deployment with nothing stored`,
    });
  }
  return { ...out, required: [...out.held, ...out.mint] };
}

// normalizeFoundationDeployRef(ref) — what a deploy plan may carry about the
// foundation: the version and secret NAMES (required / delivered), never a value.
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
export function normalizeFoundationDeployRef(ref) {
  if (!plain(ref)) return null;
  const keys = (list) => (Array.isArray(list) ? [...new Set(list.map(String).filter((k) => ENV_KEY_RE.test(k)))] : []);
  return {
    version: String(ref.version || ''),
    required: keys(ref.required),
    delivered: keys(ref.delivered),
    ...(ref.error ? { error: redactSecrets(String(ref.error)).slice(0, 300) } : {}),
  };
}
