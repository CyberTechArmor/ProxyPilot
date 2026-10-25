// A stateful stand-in for the application-foundation API, built only from the
// documented shapes (docs/features/app-foundation.md, foundation-contract.js).
// Used by tests/foundation-panel.browser.mjs (through page.route) and
// tests/foundation-panel-lighthouse.mjs (through a vite middleware). No
// backend, guest, Docker or provider is involved; credentials sent to it are
// recorded as "present" only and never echoed back.
import * as contract from '../../backend/src/mock2/foundation-contract.js';

export const PROJECT_ID = 7;
const base = `/api/mock2/projects/${PROJECT_ID}`;
const T0 = '2026-10-24T10:00:00.000Z';

const health = (status, detail = {}) => ({ status, detail, checked_at: T0 });

function initial(caseName) {
  const f = contract.defaultFeatures();
  const s = {
    foundation_version: contract.FOUNDATION_VERSION,
    database: { state: 'on', provider: 'postgres', config: {}, pending: null, health: health('ready'), has_secret: {}, dependents: [] },
    storage: {
      ...f.storage, pending: null, health: health('ready'),
      has_secret: { access_key_id: true, secret_access_key: true },
      dependents: [...contract.DEPENDENT_CAPABILITIES.storage], object_count: 0,
    },
    embeddings: {
      ...f.embeddings, pending: null, health: health('ready'), has_secret: { api_key: false },
      dependents: [...contract.DEPENDENT_CAPABILITIES.embeddings],
      index: { id: 'local_v1', state: 'active', item_count: 318 },
    },
    jobs: [],
    warnings: [{ feature: 'embeddings', code: 'LOCAL_EMBEDDINGS', message: contract.LOCAL_EMBEDDINGS_WARNING }],
  };
  const r2 = { endpoint: 'https://4f1c9a7e2b.r2.cloudflarestorage.com', region: 'auto', bucket: 'invoices-prod', prefix: 'app/', force_path_style: true };
  switch (caseName) {
    case 'default':
      break;
    case 'has_objects':
      s.storage.object_count = 1204;
      break;
    case 'storage_off':
      s.storage.state = 'off';
      s.storage.health = health('off');
      s.storage.object_count = 1204;
      break;
    case 'external':
      Object.assign(s.storage, { provider: 'external', config: r2, object_count: 5310 });
      Object.assign(s.embeddings, {
        provider: 'openai', config: { model: 'text-embedding-3-small', dimensions: 1536, metric: 'cosine' },
        has_secret: { api_key: true }, index: { id: 'openai_v2', state: 'active', item_count: 5310 },
      });
      s.warnings = [];
      break;
    case 'missing_credentials':
      Object.assign(s.storage, {
        provider: 'external', config: r2, has_secret: { access_key_id: false, secret_access_key: false },
        health: health('missing_credentials', { message: 'No access keys are saved for the external storage.' }),
      });
      Object.assign(s.embeddings, {
        provider: 'openai', config: { model: 'text-embedding-3-small', dimensions: 1536, metric: 'cosine' },
        has_secret: { api_key: false }, index: { id: 'local_v1', state: 'active', item_count: 318 },
        health: health('missing_credentials', { message: 'OpenAI has no API key.' }),
      });
      s.warnings = [];
      break;
    case 'job_running':
      s.storage.object_count = 1204;
      s.storage.pending = { provider: 'external', config: r2 };
      s.embeddings.pending = { provider: 'openai', config: { model: 'text-embedding-3-small', dimensions: 1536 } };
      s.jobs = [
        { id: 'job_s1', kind: 'storage_migrate', state: 'running', progress: { objects_done: 482, objects_total: 1204, bytes_done: 734003200, bytes_total: 1932735283 }, error: null },
        { id: 'job_e1', kind: 'reembed', state: 'running', progress: { items_done: 120, items_total: 318 }, error: null },
      ];
      break;
    case 'starting':
      s.storage.health = health('starting');
      s.embeddings.health = health('degraded', { message: 'The embedding server answered slowly (4.1 s).' });
      break;
    case 'legacy':
      return { foundation_version: null };
    default:
      throw new Error(`unknown case ${caseName}`);
  }
  return s;
}

export const CASES = ['default', 'has_objects', 'storage_off', 'external', 'missing_credentials', 'job_running', 'starting', 'legacy'];

// Moving a pre-foundation project onto the foundation (POST …/adopt/plan,
// POST/GET …/adopt, …/adopt/resume, …/adopt/rollback), built only from the
// documented shapes. The step names are this stand-in's own.
export const ADOPT_STEPS = Object.freeze([
  { name: 'snapshot', summary: 'Take a snapshot of the project so the move can be rolled back.' },
  { name: 'stop_app', summary: 'Stop the app.' },
  { name: 'install_stack', summary: 'Install the foundation stack in the container: PostgreSQL 18 + pgvector, file storage and local embeddings.' },
  { name: 'copy_database', summary: 'Copy the database into the foundation’s PostgreSQL and compare the row counts.' },
  { name: 'move_secrets', summary: 'Move the app’s secrets into encrypted storage.' },
  { name: 'start_app', summary: 'Start the app on the foundation and check its health.' },
]);
export const ADOPT_SECRETS = Object.freeze(['SESSION_SECRET', 'STRIPE_API_KEY', 'SMTP_PASSWORD']);
export const ADOPT_BLOCKERS = Object.freeze([
  { code: 'BUILD_RUNNING', message: 'A build is running on this project.' },
  { code: 'INSUFFICIENT_DISK', message: 'The host has 0.8 GB free; the move needs 1.9 GB.' },
]);
const STEP_DETAIL = {
  install_stack: 'Starting PostgreSQL, file storage and embeddings',
  copy_database: '120 MB of 412 MB copied',
  move_secrets: '3 secrets',
};
export const ADOPT_FAIL_DETAIL = 'Row counts differ in invoices (1,204 vs 1,203).';

// adopt (createWorld option):
//   {}                         a project that can move
//   blockedChecks: n           the first n checks answer blockers
//   stale: n                   the first n confirms answer 409 PLAN_STALE
//   failAt: 'step'             that step fails once (Resume continues it)
//   resumable: false           a failed move offers no Resume
//   initial: 'running' | 'failed' | 'succeeded'   a move already on record
//   advance: false             a running move stays where it is
//   perTick: n                 steps finished per read (default 2)
export function createWorld(caseName = 'default', { sudoOnce = false, advanceJobs = true, legacy404 = false, hideCount = false, hideJobs = false, adopt = null } = {}) {
  let state = initial(caseName);
  const jobs = new Map((state.jobs || []).map((j) => [j.id, structuredClone(j)]));
  let exception = null;
  let sudo = !sudoOnce;
  let seq = 0;
  const calls = [];

  // hideCount: the read does not report the object count, so only the server's
  // refusal can tell the panel that the copy/fresh choice is needed.
  const snapshot = () => {
    const out = { ...structuredClone(state), jobs: [...jobs.values()].map(publicJob) };
    if (hideCount && out.storage) delete out.storage.object_count;
    // hideJobs: a job the read does not list (e.g. started from elsewhere a
    // moment ago) — only the server's FOUNDATION_JOB_RUNNING refusal shows it.
    if (hideJobs) { out.jobs = []; out.storage.pending = null; out.embeddings.pending = null; }
    return out;
  };
  const active = () => [...jobs.values()].find((j) => ['queued', 'running'].includes(j.state));
  const refuse = (code, message, options = [], extra = {}) => ({ status: 409, body: { code, message, options, ...extra } });

  function promoteStorage(pending) {
    state.storage.provider = pending.provider;
    if (pending.provider === 'external') {
      state.storage.config = { ...pending.config };
      state.storage.has_secret = { access_key_id: true, secret_access_key: true };
    } else {
      state.storage.config = contract.defaultFeatures().storage.config;
    }
    state.storage.state = 'on';
    state.storage.pending = null;
    state.storage.health = health('ready');
  }
  function promoteEmbeddings(pending) {
    Object.assign(state.embeddings, { provider: pending.provider, config: { ...pending.config, metric: 'cosine' }, pending: null, state: 'on', health: health('ready') });
    if (pending.credentials) state.embeddings.has_secret = { api_key: true };
    state.embeddings.index = { id: `v${seq}`, state: 'active', item_count: state.embeddings.index?.item_count ?? 0 };
    state.warnings = pending.provider === 'local' ? [{ feature: 'embeddings', code: 'LOCAL_EMBEDDINGS', message: contract.LOCAL_EMBEDDINGS_WARNING }] : [];
  }

  function storage(body) {
    const s = state.storage;
    if (active()) return refuse('FOUNDATION_JOB_RUNNING', 'Another foundation job is running. Wait for it to finish, or cancel it.', ['cancel'], { job_id: active().id });
    if (body.action === 'on') { s.state = 'on'; s.health = health('ready'); return { status: 200, body: { ok: true } }; }
    if (body.action === 'off') {
      if (s.provider === 'bundled' && s.object_count > 0) {
        return refuse('STORAGE_HAS_OBJECTS', `Bundled storage still holds ${s.object_count.toLocaleString('en-US')} files. Choose an external S3 and copy them over, or start fresh.`, ['copy', 'fresh'], { object_count: s.object_count });
      }
      s.state = 'off'; s.health = health('off');
      return { status: 200, body: { ok: true } };
    }
    if (body.action !== 'switch') return { status: 400, body: { error: 'invalid action' } };
    if (body.provider === 'external' && (!body.config?.endpoint || !body.config?.bucket)) return { status: 400, body: { error: 'endpoint and bucket are required' } };
    const holds = s.object_count > 0;
    if (holds && !body.mode) {
      return refuse('STORAGE_HAS_OBJECTS', `This storage holds ${s.object_count.toLocaleString('en-US')} files. Choose to copy them (verified) or to start fresh.`, ['copy', 'fresh'], { object_count: s.object_count });
    }
    if (body.mode === 'fresh' && body.acknowledge !== true) return refuse('ACKNOWLEDGE_REQUIRED', 'Starting fresh needs the acknowledgement.', []);
    const pending = { provider: body.provider, config: body.config || null };
    if (body.mode === 'copy') {
      s.pending = pending;
      const id = `job_s${++seq}`;
      jobs.set(id, { id, kind: 'storage_migrate', state: 'running', progress: { objects_done: 0, objects_total: s.object_count, bytes_done: 0, bytes_total: s.object_count * 1605000 }, error: null, _pending: pending });
      return { status: 202, body: { ok: true, job: { id, kind: 'storage_migrate', state: 'running', progress: {} } } };
    }
    promoteStorage(pending);
    if (body.mode === 'fresh') s.object_count = 0;
    return { status: 200, body: { ok: true } };
  }

  function embeddings(body) {
    const e = state.embeddings;
    if (active()) return refuse('FOUNDATION_JOB_RUNNING', 'Another foundation job is running. Wait for it to finish, or cancel it.', ['cancel'], { job_id: active().id });
    if (body.action === 'on') { e.state = 'on'; e.health = health(e.provider !== 'local' && !e.has_secret?.api_key ? 'missing_credentials' : 'ready'); return { status: 200, body: { ok: true } }; }
    if (body.action === 'off') { e.state = 'off'; e.health = health('off'); return { status: 200, body: { ok: true } }; }
    if (body.action !== 'switch') return { status: 400, body: { error: 'invalid action' } };
    const pending = { provider: body.provider, config: body.config, credentials: !!body.credentials };
    e.pending = { provider: body.provider, config: body.config };
    const id = `job_e${++seq}`;
    jobs.set(id, { id, kind: 'reembed', state: 'running', progress: { items_done: 0, items_total: e.index?.item_count ?? 0 }, error: null, _pending: pending });
    return { status: 202, body: { ok: true, job: id } };
  }

  function advance(job) {
    if (!advanceJobs || job.state !== 'running') return;
    const p = job.progress;
    if (job.kind === 'storage_migrate') {
      p.objects_done = Math.min(p.objects_total, p.objects_done + Math.ceil(p.objects_total / 3));
      p.bytes_done = Math.min(p.bytes_total, p.bytes_done + Math.ceil(p.bytes_total / 3));
      if (p.objects_done >= p.objects_total) { job.state = 'succeeded'; promoteStorage(job._pending); }
    } else {
      p.items_done = Math.min(p.items_total, p.items_done + Math.ceil(Math.max(1, p.items_total) / 3));
      if (p.items_done >= p.items_total) { job.state = 'succeeded'; promoteEmbeddings(job._pending); }
    }
  }
  const publicJob = (j) => { const { _pending, ...rest } = j; return structuredClone(rest); };

  // ---- adoption ----
  const ad = { opts: { ...(adopt || {}) }, record: null, token: null, plans: 0, staleServed: 0, failedOnce: false, seq: 0, features: null };
  const nowIso = (offsetS = 0) => new Date(Date.now() + offsetS * 1000).toISOString();
  const failure = () => `Copying the database failed: ${ADOPT_FAIL_DETAIL[0].toLowerCase()}${ADOPT_FAIL_DETAIL.slice(1)}`;
  function newRecord() {
    return {
      id: `ad_${++ad.seq}`, state: 'running', step: ADOPT_STEPS[0].name,
      steps: ADOPT_STEPS.map((x, i) => ({ name: x.name, state: i === 0 ? 'running' : 'pending', detail: null, started_at: i === 0 ? nowIso() : null, finished_at: null })),
      error: null, created_at: nowIso(), finished_at: null, rollback_available: false,
    };
  }
  function seedRecord(kind) {
    const r = newRecord();
    r.created_at = nowIso(-95);
    const upTo = kind === 'succeeded' ? ADOPT_STEPS.length : kind === 'failed' ? 3 : 2;
    r.steps.forEach((x, i) => {
      if (i < upTo) Object.assign(x, { state: 'done', started_at: nowIso(-95 + i * 15), finished_at: nowIso(-80 + i * 15) });
      else Object.assign(x, { state: 'pending', started_at: null });
    });
    if (kind === 'running') {
      Object.assign(r.steps[2], { state: 'running', started_at: nowIso(-65), detail: STEP_DETAIL.install_stack });
      r.step = 'install_stack';
    } else if (kind === 'failed') {
      Object.assign(r.steps[3], { state: 'failed', started_at: nowIso(-50), finished_at: nowIso(-20), detail: ADOPT_FAIL_DETAIL });
      Object.assign(r, { state: 'failed', step: 'copy_database', error: failure(), finished_at: nowIso(-20), rollback_available: true, resume_available: ad.opts.resumable !== false });
      ad.failedOnce = true;
    } else if (kind === 'succeeded') {
      Object.assign(r, { state: 'succeeded', step: null, finished_at: nowIso(-5), rollback_available: true });
    }
    return r;
  }
  if (ad.opts.initial) ad.record = seedRecord(ad.opts.initial);

  function becomeFoundation() {
    state = initial('default');
    if (ad.features?.storage === 'off') Object.assign(state.storage, { state: 'off', health: health('off') });
    if (ad.features?.embeddings === 'off') Object.assign(state.embeddings, { state: 'off', health: health('off') });
  }
  function advanceAdoption() {
    const r = ad.record;
    if (!r || ad.opts.advance === false) return;
    if (r.state === 'rolling_back') {
      Object.assign(r, { state: 'rolled_back', finished_at: nowIso(), rollback_available: false });
      state = initial('legacy');
      return;
    }
    if (r.state !== 'running') return;
    for (let k = 0; k < (ad.opts.perTick || 2); k++) {
      const i = r.steps.findIndex((x) => x.state === 'running');
      if (i < 0) return;
      const step = r.steps[i];
      if (ad.opts.failAt === step.name && !ad.failedOnce) {
        ad.failedOnce = true;
        Object.assign(step, { state: 'failed', finished_at: nowIso(), detail: ADOPT_FAIL_DETAIL });
        Object.assign(r, { state: 'failed', error: failure(), finished_at: nowIso(), rollback_available: true, resume_available: ad.opts.resumable !== false });
        return;
      }
      Object.assign(step, { state: 'done', finished_at: nowIso(), detail: null });
      const next = r.steps[i + 1];
      if (!next) {
        Object.assign(r, { state: 'succeeded', step: null, finished_at: nowIso(), rollback_available: true });
        becomeFoundation();
        return;
      }
      Object.assign(next, { state: 'running', started_at: nowIso(), detail: STEP_DETAIL[next.name] || null });
      r.step = next.name;
    }
  }
  function adoptPlan() {
    ad.plans += 1;
    const blocked = (ad.opts.blockedChecks || 0) > 0;
    if (blocked) ad.opts.blockedChecks -= 1;
    ad.token = blocked ? null : `plan_${ad.plans}`;
    return {
      status: 200,
      body: {
        ok: true,
        plan: {
          steps: ADOPT_STEPS.map((x) => ({ ...x })),
          // Seconds; each stale refusal stands for a change that made it longer.
          downtime: 240 + ad.staleServed * 60,
          database: { size_bytes: 412 * 1024 ** 2, tables: 37 },
          disk: blocked ? { free_bytes: 0.8 * 1024 ** 3, needed_bytes: 1.9 * 1024 ** 3 } : { free_bytes: 18.4 * 1024 ** 3, needed_bytes: 1.9 * 1024 ** 3 },
          secrets_to_move: [...ADOPT_SECRETS],
          features: { storage: 'on', embeddings: 'on' },
          warnings: [{ code: 'NATIVE_POSTGRES_KEPT', message: 'The native PostgreSQL is stopped and kept, not removed.' }],
        },
        blockers: blocked ? ADOPT_BLOCKERS.map((b) => ({ ...b })) : [],
        plan_token: ad.token,
      },
    };
  }
  function adoptHandle(method, path, body) {
    const a = `${base}/foundation/adopt`;
    if (path === `${a}/plan` && method === 'POST') return adoptPlan();
    if (path === a && method === 'GET') { advanceAdoption(); return { status: 200, body: { adoption: ad.record ? structuredClone(ad.record) : null } }; }
    if (![a, `${a}/resume`, `${a}/rollback`].includes(path)) return null;
    if (method !== 'POST') return { status: 405, body: { error: 'method' } };
    if (!sudo) return { status: 401, body: { error: 'sudo_required', sudo_required: true } };
    const r = ad.record;
    if (path === a) {
      if (r && ['running', 'rolling_back'].includes(r.state)) return refuse('ADOPTION_RUNNING', 'A move is already running.');
      if (body?.acknowledge_downtime !== true) return { status: 400, body: { code: 'INVALID_REQUEST', message: 'acknowledge_downtime must be true.' } };
      if (!body?.plan_token || body.plan_token !== ad.token || (ad.opts.stale || 0) > 0) {
        if ((ad.opts.stale || 0) > 0) { ad.opts.stale -= 1; ad.staleServed += 1; }
        ad.token = null;
        return refuse('PLAN_STALE', 'The project changed after the check. Check it again.');
      }
      ad.features = body.features || null;
      ad.token = null;
      ad.failedOnce = false;
      ad.record = newRecord();
      return { status: 202, body: { ok: true, adoption: structuredClone(ad.record) } };
    }
    if (path.endsWith('/resume')) {
      if (!r || r.state !== 'failed' || r.resume_available === false) return refuse('RESUME_UNAVAILABLE', 'There is no stopped move to resume.');
      const step = r.steps.find((x) => x.state === 'failed');
      if (step) Object.assign(step, { state: 'running', started_at: nowIso(), finished_at: null, detail: STEP_DETAIL[step.name] || null });
      Object.assign(r, { state: 'running', step: step?.name || r.step, error: null, finished_at: null });
      delete r.resume_available;
      return { status: 200, body: { ok: true, adoption: structuredClone(r) } };
    }
    if (!r || !r.rollback_available) return refuse('ROLLBACK_UNAVAILABLE', 'There is nothing to roll back.');
    Object.assign(r, { state: 'rolling_back', rollback_available: false, error: null });
    delete r.resume_available;
    return { status: 200, body: { ok: true, adoption: structuredClone(r) } };
  }

  function handle(method, url, body) {
    const path = new URL(url, 'http://x').pathname;
    if (method !== 'GET') calls.push({ method, path, body: body ? structuredClone(body) : null });
    // The sudo bridge the real SudoModal talks to.
    if (path === '/api/auth/sudo' && method === 'POST') { sudo = true; return { status: 200, body: { ok: true } }; }
    if (path === '/api/user/profile') return { status: 200, body: { user: { id: 1, username: 'thomas', hasPasskey: false } } };
    if (path === '/api/auth/sso/session') return { status: 200, body: { canReauthenticate: false } };

    const adopted = adoptHandle(method, path, body);
    if (adopted) return adopted;
    if (path === `${base}/foundation` && method === 'GET') {
      if (legacy404) return { status: 404, body: { error: 'Not found' } };
      return { status: 200, body: state.foundation_version ? snapshot() : { foundation_version: null } };
    }
    if (path === `${base}/database-exception`) {
      if (method === 'GET') return { status: 200, body: { exception } };
      if (!sudo) return { status: 401, body: { error: 'sudo_required', sudo_required: true } };
      if (method === 'PUT') {
        const t = String(body?.request_text || '').trim();
        if (body?.engine !== 'sqlite' || body?.acknowledge !== true || t.length < 10 || t.length > 2000) return { status: 400, body: { error: 'invalid exception' } };
        exception = { engine: 'sqlite', request_text: t, recorded_by: 'thomas', created_at: '2026-10-24T10:30:00.000Z' };
        return { status: 200, body: { exception } };
      }
      if (method === 'DELETE') { exception = null; return { status: 200, body: { ok: true } }; }
    }
    const job = path.match(new RegExp(`^${base}/foundation/jobs/([^/]+)(/cancel)?$`));
    if (job) {
      const j = jobs.get(decodeURIComponent(job[1]));
      if (!j) return { status: 404, body: { error: 'no such job' } };
      if (job[2] && method === 'POST') {
        if (!sudo) return { status: 401, body: { error: 'sudo_required', sudo_required: true } };
        j.state = 'cancelled';
        if (j.kind === 'storage_migrate') state.storage.pending = null; else state.embeddings.pending = null;
        return { status: 200, body: { ok: true, job: publicJob(j) } };
      }
      advance(j);
      return { status: 200, body: { job: publicJob(j) } };
    }
    if (path === `${base}/foundation/health` && method === 'POST') {
      for (const f of ['database', 'storage', 'embeddings']) {
        const h = state[f].health;
        if (h.status === 'starting') state[f].health = health('ready');
        state[f].health.checked_at = new Date().toISOString();
      }
      return { status: 200, body: snapshot() };
    }
    if (path === `${base}/foundation/storage` || path === `${base}/foundation/embeddings`) {
      if (method !== 'POST') return { status: 405, body: { error: 'method' } };
      if (!sudo) return { status: 401, body: { error: 'sudo_required', sudo_required: true } };
      return path.endsWith('/storage') ? storage(body || {}) : embeddings(body || {});
    }
    return { status: 404, body: { error: `no fixture for ${method} ${path}` } };
  }

  return { handle, calls, get state() { return state; }, jobs, get exception() { return exception; }, get adoption() { return ad.record; } };
}
