// Application foundation panel — the pure rules behind ProjectFoundation.jsx.
//
// No React, no I/O: the words, the readings of the API shapes, the request
// bodies and the "what is the next step" decisions live here so they can be
// tested with node --test (tests/foundation-panel-logic.test.mjs).
//
// The backend contract is admin/backend/src/mock2/foundation-contract.js. It
// imports node:crypto, so the browser bundle cannot import it; the two values
// the dashboard shows from it (the local-embeddings warning and the dependent
// capabilities) are mirrored here, and the logic test pins the mirror to the
// contract byte for byte. The API's own `warnings` / `dependents` win whenever
// they are present.
//
// The readers are deliberately tolerant: the routes are built in parallel with
// this panel, so a field that is missing reads as "not reported", never as a
// crash or as "ready".

export const LOCAL_EMBEDDINGS_WARNING =
  'Local embeddings (bge-small, 384 dimensions) are for development and small data sets. '
  + 'Switch to OpenAI or another embedding provider for production-quality search.';

export const DEPENDENT_CAPABILITIES = Object.freeze({
  storage: Object.freeze(['File uploads and downloads', 'Attachments and exports kept in object storage']),
  embeddings: Object.freeze(['Semantic search', 'Similar-item suggestions', 'AI retrieval over the app\'s content']),
});

export const LOCAL_MODEL = 'BAAI/bge-small-en-v1.5';
export const LOCAL_DIMENSIONS = 384;
export const OPENAI_DEFAULT_MODEL = 'text-embedding-3-small';
export const OPENAI_DEFAULT_DIMENSIONS = 1536;
export const DEFAULT_REGION = 'us-east-1';
export const EXCEPTION_MIN = 10;
export const EXCEPTION_MAX = 2000;

export const LEGACY_TEXT = 'This project predates the application foundation.';

// ---------------------------------------------------------------------------
// Legacy projects
// ---------------------------------------------------------------------------

// The project row says so when the API exposes the column; otherwise the
// foundation read decides (null version, or the route answers 404).
export function projectSaysLegacy(project) {
  return !!project && Object.prototype.hasOwnProperty.call(project, 'foundation_version') && !project.foundation_version;
}

export function isLegacy(project, data) {
  if (projectSaysLegacy(project)) return true;
  if (data && typeof data === 'object' && !data.foundation_version) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

const HEALTH = Object.freeze({
  ready: { label: 'Ready', tone: 'ok' },
  off: { label: 'Off', tone: 'muted' },
  starting: { label: 'Starting', tone: 'info' },
  degraded: { label: 'Degraded', tone: 'warn' },
  unavailable: { label: 'Unavailable', tone: 'bad' },
  missing_credentials: { label: 'Needs credentials', tone: 'warn' },
});

export function detailText(detail) {
  if (detail == null) return null;
  if (typeof detail === 'string') return detail.trim() || null;
  if (typeof detail !== 'object') return String(detail);
  for (const k of ['message', 'error', 'reason', 'summary']) {
    if (typeof detail[k] === 'string' && detail[k].trim()) return detail[k].trim();
  }
  return null;
}

export function healthView(feature) {
  const h = feature?.health || {};
  let status = typeof h.status === 'string' ? h.status : null;
  if (!status && feature?.state === 'off') status = 'off';
  const meta = HEALTH[status] || { label: 'Not checked', tone: 'muted' };
  return { status: status || 'unknown', label: meta.label, tone: meta.tone, detail: detailText(h.detail), checkedAt: h.checked_at || null };
}

export function checkedAgo(iso, now = Date.now()) {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 45) return 'Checked just now';
  const m = Math.round(s / 60);
  if (m < 60) return `Checked ${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `Checked ${h} h ago`;
  return `Checked ${new Date(t).toISOString().slice(0, 10)}`;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export function formatCount(n) {
  const v = Number(n);
  return Number.isFinite(v) ? Math.round(v).toLocaleString('en-US') : null;
}

export function formatBytes(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 0) return null;
  if (v < 1024) return `${v} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let x = v / 1024; let i = 0;
  while (x >= 1024 && i < units.length - 1) { x /= 1024; i += 1; }
  return `${x >= 100 ? Math.round(x) : x.toFixed(1)} ${units[i]}`;
}

export function hostOf(url) {
  if (!url) return null;
  try { return new URL(String(url)).host || String(url); } catch { return String(url); }
}

const first = (...vals) => vals.find((v) => v !== undefined && v !== null);

// ---------------------------------------------------------------------------
// Secrets — write-only; the API answers has_secret flags, never a value.
// ---------------------------------------------------------------------------

export function hasSecret(featureName, feature, key) {
  const h = feature?.has_secret;
  // The API answers one flag per feature: true when every credential that
  // provider needs is stored.
  if (typeof h === 'boolean') return h;
  if (!h || typeof h !== 'object') return false;
  return !!first(h[key], h[`${featureName}.${key}`]);
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

export function objectCountOf(storage) {
  const d = storage?.health?.detail;
  const n = first(
    storage?.object_count, storage?.objects,
    d && typeof d === 'object' ? first(d.object_count, d.objects) : undefined,
  );
  const v = Number(n);
  return Number.isFinite(v) && v >= 0 ? v : null;
}

export const STORAGE_PROVIDER_LABEL = Object.freeze({ bundled: 'Bundled SeaweedFS', external: 'External S3' });

export function storageView(storage) {
  const s = storage || {};
  const cfg = s.config || {};
  const external = s.provider === 'external';
  const where = external
    ? [hostOf(cfg.endpoint), cfg.bucket ? `bucket ${cfg.bucket}` : null, cfg.prefix ? `folder ${cfg.prefix}` : null].filter(Boolean).join(' · ')
    : 'Inside this app\'s container';
  const objects = objectCountOf(s);
  const keysSaved = hasSecret('storage', s, 'access_key_id') && hasSecret('storage', s, 'secret_access_key');
  return {
    on: s.state === 'on',
    provider: s.provider || null,
    providerLabel: STORAGE_PROVIDER_LABEL[s.provider] || s.provider || 'Not reported',
    where: where || null,
    objects,
    objectsText: objects == null ? null : objects === 0 ? 'None yet' : formatCount(objects),
    keysSaved: external ? keysSaved : null,
    pending: pendingText('storage', s.pending),
  };
}

// ---------------------------------------------------------------------------
// Embeddings
// ---------------------------------------------------------------------------

export const EMBEDDING_PROVIDER_LABEL = Object.freeze({
  local: 'Local model', openai: 'OpenAI', openai_compatible: 'OpenAI-compatible',
});

export function indexOf(emb) {
  const d = emb?.health?.detail;
  const ix = first(emb?.index, emb?.active_index, d && typeof d === 'object' ? d.index : undefined);
  if (!ix || typeof ix !== 'object') return null;
  const items = Number(first(ix.item_count, ix.items, ix.count));
  return { state: ix.state || null, items: Number.isFinite(items) ? items : null, id: ix.id || null };
}

const INDEX_STATE = Object.freeze({
  active: 'In use', building: 'Building', ready: 'Built, not in use yet', retired: 'Retired', failed: 'Failed',
});

export function embeddingsView(emb) {
  const e = emb || {};
  const cfg = e.config || {};
  const ix = indexOf(e);
  const indexText = ix
    ? [INDEX_STATE[ix.state] || ix.state, ix.items == null ? null : `${formatCount(ix.items)} item${ix.items === 1 ? '' : 's'}`].filter(Boolean).join(' · ')
    : null;
  return {
    on: e.state === 'on',
    provider: e.provider || null,
    providerLabel: (EMBEDDING_PROVIDER_LABEL[e.provider] || e.provider || 'Not reported')
      + (e.provider === 'openai_compatible' && cfg.base_url ? ` · ${hostOf(cfg.base_url)}` : ''),
    model: cfg.model || null,
    dimensions: cfg.dimensions == null ? null : Number(cfg.dimensions),
    indexText,
    keySaved: e.provider === 'local' ? null : hasSecret('embeddings', e, 'api_key'),
    pending: pendingText('embeddings', e.pending),
  };
}

export function pendingText(featureName, pending) {
  if (!pending || typeof pending !== 'object') return null;
  if (featureName === 'storage') {
    const to = STORAGE_PROVIDER_LABEL[pending.provider] || pending.provider || 'new storage';
    return `Switching to ${to}. The current storage stays in use until the new one is checked.`;
  }
  const to = EMBEDDING_PROVIDER_LABEL[pending.provider] || pending.provider || 'a new provider';
  const model = pending.config?.model ? ` (${pending.config.model})` : '';
  return `Switching to ${to}${model}. Search keeps using the current index until the new one is checked.`;
}

// ---------------------------------------------------------------------------
// Warnings and dependents
// ---------------------------------------------------------------------------

function warningMessage(w) {
  if (typeof w === 'string') return w;
  if (w && typeof w === 'object') return w.message || w.text || null;
  return null;
}

function isLocalEmbeddingsWarning(w) {
  if (typeof w === 'string') return /local embeddings/i.test(w);
  if (!w || typeof w !== 'object') return false;
  return /LOCAL_EMBEDDINGS/i.test(String(w.code || '')) || (w.feature === 'embeddings' && /local/i.test(String(w.message || '')));
}

// The warning the embeddings card shows whenever the provider is local: the
// API's own text when it sends one, else the contract's.
export function localWarning(data) {
  if (data?.embeddings?.provider !== 'local') return null;
  const w = (Array.isArray(data?.warnings) ? data.warnings : []).find(isLocalEmbeddingsWarning);
  return warningMessage(w) || LOCAL_EMBEDDINGS_WARNING;
}

// Everything else in `warnings`, for the panel header (deduplicated).
export function otherWarnings(data) {
  const list = Array.isArray(data?.warnings) ? data.warnings : [];
  const shownLocal = data?.embeddings?.provider === 'local';
  const out = [];
  for (const w of list) {
    if (shownLocal && isLocalEmbeddingsWarning(w)) continue;
    const m = warningMessage(w);
    if (m && !out.includes(m)) out.push(m);
  }
  return out;
}

export function dependentsOf(data, featureName) {
  const d = data?.[featureName]?.dependents;
  if (Array.isArray(d) && d.length) return d.map((x) => (typeof x === 'string' ? x : x?.label || x?.name || String(x)));
  return [...(DEPENDENT_CAPABILITIES[featureName] || [])];
}

export function turnOffCopy(featureName, feature) {
  if (featureName === 'storage') {
    return feature?.provider === 'external'
      ? 'No data is deleted. Nothing on your external storage is touched; turning storage back on reconnects to it.'
      : 'No data is deleted. The storage container stops and keeps its files; turning it back on brings them back.';
  }
  return 'No data is deleted. Stored vectors stay in the database; search comes back when you turn embeddings on again.';
}

// ---------------------------------------------------------------------------
// Refusals (409 { code, message, options }) → the next step, never a dead end.
// ---------------------------------------------------------------------------

function sentence(id) {
  const s = String(id || '').replace(/[_-]+/g, ' ').trim();
  return s ? s[0].toUpperCase() + s.slice(1) : 'Check again';
}

export function normalizeOption(o) {
  if (typeof o === 'string') return { id: o, label: null, description: null };
  if (o && typeof o === 'object') {
    return {
      id: String(first(o.id, o.mode, o.action, o.value, o.code) ?? ''),
      label: o.label || o.title || null,
      description: o.description || o.hint || null,
    };
  }
  return { id: String(o ?? ''), label: null, description: null };
}

// Read whatever request() threw into one shape. ApiError copies the response
// body onto the error; an `error: { code, message, … }` body lands in details.
export function refusalOf(err) {
  if (!err) return null;
  const d = err.details && typeof err.details === 'object' ? err.details : {};
  const code = first(
    typeof err.code === 'string' ? err.code : undefined,
    typeof d.code === 'string' ? d.code : undefined,
    typeof err.error === 'string' && /^[A-Z][A-Z0-9_]+$/.test(err.error) ? err.error : undefined,
  ) || null;
  const rawOptions = first(Array.isArray(err.options) ? err.options : undefined, Array.isArray(d.options) ? d.options : undefined) || [];
  const jobId = first(err.job_id, err.job?.id, d.job_id, d.job?.id, typeof err.job === 'string' ? err.job : undefined) || null;
  const objects = Number(first(err.object_count, err.objects, d.object_count, d.objects));
  const cancelledSudo = err.status === 401 && /cancelled/i.test(String(err.message || ''));
  return {
    status: err.status ?? null,
    code,
    message: cancelledSudo
      ? 'Nothing was changed: the confirmation was cancelled.'
      : String(first(err.message, d.message) || 'The request was refused.'),
    options: rawOptions.map(normalizeOption).filter((o) => o.id),
    jobId: jobId == null ? null : String(jobId),
    objects: Number.isFinite(objects) && objects >= 0 ? objects : null,
  };
}

export const STORAGE_HAS_OBJECTS = 'STORAGE_HAS_OBJECTS';
export const FOUNDATION_JOB_RUNNING = 'FOUNDATION_JOB_RUNNING';

const MODE_LABEL = Object.freeze({ copy: 'Copy everything (verified)', fresh: 'Start fresh' });

export function optionAction(option, featureName = 'storage') {
  const o = normalizeOption(option);
  const id = o.id.toLowerCase();
  const label = (fallback) => o.label || fallback;
  if (id === 'copy' || id === 'fresh') return { kind: 'mode', mode: id, label: label(MODE_LABEL[id]), description: o.description };
  if (['cancel', 'cancel_job'].includes(id)) return { kind: 'cancel_job', label: label('Cancel the running job') };
  if (['wait', 'show_job', 'progress', 'watch'].includes(id)) return { kind: 'show_job', label: label('Show its progress') };
  if (['switch', 'choose_provider', 'external', 'provider'].includes(id)) {
    return { kind: 'switch', label: label(featureName === 'storage' ? 'Choose new storage' : 'Switch provider') };
  }
  if (['credentials', 'add_credentials', 'set_credentials', 'api_key'].includes(id)) {
    return { kind: 'credentials', label: label(featureName === 'storage' ? 'Add access keys' : 'Add API key') };
  }
  if (['retry', 'try_again'].includes(id)) return { kind: 'retry', label: label('Try again') };
  return { kind: 'refresh', label: label(sentence(id)) };
}

// The buttons a refusal offers. Known codes with no options still get theirs.
// With `fallback` (a card, where nothing else is on screen) every refusal ends
// with at least one way forward; inside a dialog the form's own submit button
// is that way, so a plain error adds no button.
export function nextSteps(refusal, featureName = 'storage', { fallback = true } = {}) {
  if (!refusal) return [];
  let options = refusal.options || [];
  if (!options.length && refusal.code === STORAGE_HAS_OBJECTS) options = [{ id: 'copy' }, { id: 'fresh' }];
  const steps = options.map((o) => optionAction(o, featureName));
  // A running job: watching it is the calm default; cancelling it stays a
  // deliberate second choice.
  if (refusal.code === FOUNDATION_JOB_RUNNING && !steps.some((s) => s.kind === 'show_job')) {
    steps.unshift(optionAction('show_job', featureName));
  }
  if (!steps.length && fallback) steps.push({ kind: 'refresh', label: 'Check again' });
  return steps;
}

// The storage refusal that means "choose copy or fresh first".
export function refusalNeedsMode(refusal) {
  if (!refusal) return false;
  if (refusal.code === STORAGE_HAS_OBJECTS) return true;
  return (refusal.options || []).some((o) => ['copy', 'fresh'].includes(String(o.id).toLowerCase()));
}

// ---------------------------------------------------------------------------
// Storage switch form → request body
// ---------------------------------------------------------------------------

export function storageFormDefaults(storage) {
  const s = storage || {};
  const external = s.provider === 'external';
  const cfg = external ? (s.config || {}) : {};
  return {
    provider: external ? 'bundled' : 'external',
    endpoint: cfg.endpoint || '',
    region: cfg.region || DEFAULT_REGION,
    bucket: cfg.bucket || '',
    prefix: cfg.prefix || '',
    force_path_style: external ? !!cfg.force_path_style : false,
    access_key_id: '',
    secret_access_key: '',
    mode: null,
    acknowledge: false,
  };
}

// Whether the copy/fresh choice must be made before sending: bundled storage
// that reports objects, or the server already refused for that reason.
export function storageNeedsMode({ storage, refusal, provider }) {
  if (refusalNeedsMode(refusal)) return true;
  const count = objectCountOf(storage);
  return storage?.provider === 'bundled' && provider !== 'bundled' && count != null && count > 0;
}

// Saved keys may be kept only when the switch stays on external storage.
export function storageCanKeepKeys(storage, provider) {
  return provider === 'external' && storage?.provider === 'external'
    && hasSecret('storage', storage, 'access_key_id') && hasSecret('storage', storage, 'secret_access_key');
}

const HTTP_URL = /^https?:\/\/[^\s/]+[^\s]*$/i;
const BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;

export function storageSwitchBody(form, { storage, needsMode }) {
  const errors = {};
  const f = form || {};
  const body = { action: 'switch', provider: f.provider };
  if (!['bundled', 'external'].includes(f.provider)) errors.provider = 'Choose where files should be kept.';
  if (f.provider === 'external') {
    const endpoint = String(f.endpoint || '').trim();
    const region = String(f.region || '').trim();
    const bucket = String(f.bucket || '').trim();
    const prefix = String(f.prefix || '').trim().replace(/^\/+/, '');
    if (!endpoint) errors.endpoint = 'Enter the S3 endpoint URL.';
    else if (!HTTP_URL.test(endpoint)) errors.endpoint = 'Use a full URL that starts with https:// (or http://).';
    if (!region) errors.region = 'Enter a region (R2 uses auto).';
    if (!bucket) errors.bucket = 'Enter the bucket name.';
    else if (!BUCKET.test(bucket)) errors.bucket = 'Bucket names use 3–63 lowercase letters, digits, dots or dashes.';
    if (prefix.length > 512) errors.prefix = 'Keep the folder under 512 characters.';
    body.config = { endpoint, region, bucket, prefix, force_path_style: !!f.force_path_style };
    const id = String(f.access_key_id || '').trim();
    const secret = String(f.secret_access_key || '');
    if (id || secret) {
      if (!id) errors.access_key_id = 'Enter the access key ID too.';
      if (!secret) errors.secret_access_key = 'Enter the secret access key too.';
      body.credentials = { access_key_id: id, secret_access_key: secret };
    } else if (!storageCanKeepKeys(storage, 'external')) {
      errors.access_key_id = 'Enter the access key ID.';
      errors.secret_access_key = 'Enter the secret access key.';
    }
  }
  if (needsMode) {
    if (!['copy', 'fresh'].includes(f.mode)) errors.mode = 'Choose what happens to the existing files.';
    if (!f.acknowledge) errors.acknowledge = 'Tick the box to confirm.';
    if (f.mode) body.mode = f.mode;
    if (f.acknowledge) body.acknowledge = true;
  }
  return { ok: Object.keys(errors).length === 0, errors, body };
}

export function ackText(fromProvider) {
  return fromProvider === 'external'
    ? 'Existing files stay on the external storage. Switching back to it brings them back.'
    : 'Existing files stay in the preserved bundled storage. Turning bundled storage back on brings them back.';
}

// ---------------------------------------------------------------------------
// Embeddings switch form → request body
// ---------------------------------------------------------------------------

export function embeddingsFormDefaults(emb, provider) {
  const e = emb || {};
  const cfg = e.config || {};
  // Opening the dialog from local suggests OpenAI; otherwise it edits the
  // provider in use (a new key, model or size).
  const p = provider || (e.provider && e.provider !== 'local' ? e.provider : 'openai');
  const same = p === e.provider;
  return {
    provider: p,
    base_url: p === 'openai_compatible' && same ? (cfg.base_url || '') : '',
    model: same && p !== 'local' ? (cfg.model || '') : p === 'openai' ? OPENAI_DEFAULT_MODEL : p === 'local' ? LOCAL_MODEL : '',
    dimensions: String(same && p !== 'local' && cfg.dimensions ? cfg.dimensions : p === 'openai' ? OPENAI_DEFAULT_DIMENSIONS : p === 'local' ? LOCAL_DIMENSIONS : ''),
    api_key: '',
  };
}

export function embeddingsCanKeepKey(emb, provider) {
  return provider !== 'local' && emb?.provider === provider && hasSecret('embeddings', emb, 'api_key');
}

export function embeddingsSwitchBody(form, { embeddings }) {
  const errors = {};
  const f = form || {};
  const e = embeddings || {};
  const p = f.provider;
  const body = { action: 'switch', provider: p };
  if (!['local', 'openai', 'openai_compatible'].includes(p)) {
    errors.provider = 'Choose a provider.';
    return { ok: false, errors, body };
  }
  if (p === 'local') {
    body.config = { model: LOCAL_MODEL, dimensions: LOCAL_DIMENSIONS };
  } else {
    const model = String(f.model || '').trim();
    const dims = Number(String(f.dimensions || '').trim());
    if (!model) errors.model = 'Enter the model name.';
    if (!Number.isInteger(dims) || dims < 1 || dims > 16000) errors.dimensions = 'Use a whole number from 1 to 16000.';
    body.config = { model, dimensions: Number.isInteger(dims) ? dims : null };
    if (p === 'openai_compatible') {
      const base = String(f.base_url || '').trim();
      if (!base) errors.base_url = 'Enter the base URL.';
      else if (!HTTP_URL.test(base)) errors.base_url = 'Use a full URL that starts with https:// (or http://).';
      body.config.base_url = base;
    }
    const key = String(f.api_key || '').trim();
    if (key) body.credentials = { api_key: key };
    else if (p === 'openai' && !embeddingsCanKeepKey(e, p)) errors.api_key = 'Enter the OpenAI API key.';
  }
  const cfg = e.config || {};
  const unchanged = p === e.provider
    && String(body.config?.model || '') === String(cfg.model || '')
    && Number(body.config?.dimensions) === Number(cfg.dimensions)
    && String(body.config?.base_url || '') === String(p === 'openai_compatible' ? cfg.base_url || '' : '')
    && !body.credentials;
  if (unchanged && !Object.keys(errors).length) errors.form = 'Nothing changed. Pick another provider, model or size, or enter a new key.';
  return { ok: Object.keys(errors).length === 0, errors, body };
}

export function reembedNeeded(emb, body) {
  const cfg = emb?.config || {};
  return body?.provider !== emb?.provider
    || Number(body?.config?.dimensions) !== Number(cfg.dimensions)
    || String(body?.config?.model || '') !== String(cfg.model || '');
}

// ---------------------------------------------------------------------------
// Database exception (the person's own explicit SQLite request)
// ---------------------------------------------------------------------------

export function exceptionBody(text, acknowledge) {
  const errors = {};
  const t = String(text || '').trim();
  if (t.length < EXCEPTION_MIN) errors.request_text = `Write at least ${EXCEPTION_MIN} characters.`;
  else if (t.length > EXCEPTION_MAX) errors.request_text = `Keep it under ${EXCEPTION_MAX} characters.`;
  if (!acknowledge) errors.acknowledge = 'Tick the box to confirm.';
  return { ok: Object.keys(errors).length === 0, errors, body: { engine: 'sqlite', request_text: t, acknowledge: true } };
}

// ---------------------------------------------------------------------------
// Jobs (storage_migrate, reembed)
// ---------------------------------------------------------------------------

export const ACTIVE_JOB_STATES = Object.freeze(['queued', 'running']);

export function jobFeature(job) {
  if (!job) return null;
  if (job.feature === 'storage' || job.feature === 'embeddings') return job.feature;
  if (job.kind === 'storage_migrate') return 'storage';
  if (job.kind === 'reembed') return 'embeddings';
  return null;
}

export function jobIdOf(job) {
  if (!job) return null;
  if (typeof job === 'string' || typeof job === 'number') return String(job);
  return job.id != null ? String(job.id) : (job.job_id != null ? String(job.job_id) : null);
}

export function activeJobs(data) {
  return (Array.isArray(data?.jobs) ? data.jobs : []).filter((j) => j && ACTIVE_JOB_STATES.includes(j.state));
}

const JOB_STATE_LABEL = Object.freeze({
  queued: 'Waiting to start', running: 'Running', succeeded: 'Finished', failed: 'Failed', cancelled: 'Cancelled',
});

export function jobView(job) {
  const j = job || {};
  const p = j.progress && typeof j.progress === 'object' ? j.progress : {};
  const feature = jobFeature(j);
  const storage = feature === 'storage';
  const done = Number(first(p.objects_done, p.items_done, p.verified, p.done, p.copied, p.embedded));
  const total = Number(first(p.objects_total, p.items_total, p.total, p.objects, p.items));
  const bytesDone = Number(first(p.bytes_done, p.bytes_copied, p.bytes_verified));
  const bytesTotal = Number(first(p.bytes_total, p.bytes));
  const hasCounts = Number.isFinite(done) && Number.isFinite(total) && total > 0;
  const percent = hasCounts ? Math.max(0, Math.min(100, Math.floor((done / total) * 100))) : null;
  const unit = storage ? 'files' : 'items';
  const parts = [];
  if (hasCounts) parts.push(`${formatCount(done)} of ${formatCount(total)} ${unit}`);
  else if (Number.isFinite(done)) parts.push(`${formatCount(done)} ${unit}`);
  if (Number.isFinite(bytesDone) && Number.isFinite(bytesTotal) && bytesTotal > 0) parts.push(`${formatBytes(bytesDone)} of ${formatBytes(bytesTotal)}`);
  const phase = typeof p.phase === 'string' ? p.phase : null;
  const phaseText = phase === 'validating' || phase === 'verifying'
    ? (storage ? 'Checking the copied files' : 'Checking the new index')
    : phase === 'promoting' ? 'Switching over' : null;
  const active = ACTIVE_JOB_STATES.includes(j.state);
  const title = storage ? 'Copying files to the new storage' : 'Re-embedding into a new index';
  let outcome = null;
  if (j.state === 'succeeded') outcome = storage ? 'All files copied and verified. The new storage is in use.' : 'The new index passed its checks and is in use.';
  else if (j.state === 'cancelled') outcome = 'Cancelled. Nothing was switched; the current one stays in use.';
  else if (j.state === 'failed') outcome = `Failed${j.error ? `: ${j.error}` : ''}. Nothing was switched; the current one stays in use.`;
  return {
    id: jobIdOf(j), feature, title, active,
    stateLabel: JOB_STATE_LABEL[j.state] || j.state || 'Unknown',
    percent, progressText: parts.join(' · ') || null, phaseText,
    cancellable: active && j.cancellable !== false,
    outcome, failed: j.state === 'failed',
  };
}
