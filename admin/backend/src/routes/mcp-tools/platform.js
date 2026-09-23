// Platform Setup (Full Platform) over MCP. Thin over the same functions the
// dashboard routes (routes/full-platform.js) call — saveFullPlatform,
// applyFullPlatform, applyService, lifecycleReview/queueLifecycle,
// resetReview/queueReset — plus the read model in
// lib/setup-engine/full-platform-mcp.js. No validation, runner dispatch or
// store logic lives here: a plan saved or applied from a chat and one saved
// or applied from the page are the same row, refused by the same checks, with
// the same messages.
//
// Gates, in order: the mcp.platform flag (every tool); mcp.destructive for
// manage_platform_service and reset_platform_setup; mcp.platform.purge
// (default OFF) for reset with purge_data. Writes carry confirm: true (save is
// inert and takes dry_run instead); runtime actions and reset carry a one-time
// confirmation_token bound to the exact review digest they previewed.
//
// What this family never does: reveal the initial Keycloak password, accept
// the administrator/recovery password, retire the bootstrap account, activate
// SSO, or take any secret. Those are step-up-gated dashboard actions and have
// no tool here; get_platform_setup.next_actions points the human at them.
// Every job these tools queue records requested_by "mcp:<key id>", via "mcp";
// every call writes an mcp_ledger row, and every accepted write an audit entry.

import { lookup } from 'node:dns/promises';
import { saveSchema, saveFullPlatform, readFullPlatform, reviewFullPlatform, validateExisting, changes, defaults, applyFullPlatform, installedTargets } from '../../lib/setup-engine/full-platform-store.js';
import { applyService, serviceReaders } from '../../lib/setup-engine/full-platform-services.js';
import { lifecycleReview, queueLifecycle } from '../../lib/setup-engine/full-platform-lifecycle.js';
import { resetReview, queueReset } from '../../lib/setup-engine/full-platform-reset.js';
import {
  platformSetupView, platformServiceView, runtimeFacts, containerNames, listPlatformJobs, platformJobDetail, evaluatePreflight,
  applyRefusal, serviceRetryRefusal, jobSummary, scrubKnownSecrets, SERVICE_IDS, SERVICE_PORTS,
} from '../../lib/setup-engine/full-platform-mcp.js';
import { getJob } from '../../lib/setup-engine/store.js';
import { isEncrypted, decryptSecret } from '../../lib/secrets.js';
import { nowIso } from '../../lib/mcp-ext/logic.js';

export const PLATFORM_FLAG = 'mcp.platform';
export const PURGE_FLAG = 'mcp.platform.purge';

/** The dashboard route's error text for a store error (routes/full-platform.js `handle`). */
export function storeMessage(e) {
  if (e?.fullPlatformSafe || e?.ssoSafe || e?.openbaoSafe || e?.infisicalSafe || e?.vaultwardenSafe || e?.pomeriumSafe) return e.message;
  if (e?.name === 'ZodError') return e.issues.map((i) => i.message).join(' ');
  return 'Setup could not continue. Reopen the saved plan and check the current service step; private provider details are withheld.';
}

export function createPlatformHandlers(kit) {
  const { ctx, ok, err, mutation, confirmToken, confirmFlag, flagRefusal, writeLedger } = kit;
  const db = () => ctx.getDb();
  const requestedBy = (auth) => `mcp:${auth?.id ?? 'unknown'}`;
  // Last line of defence on every result: no protected value this install
  // holds may leave through this family, whatever a job event recorded.
  const scrub = (result) => {
    const text = result?.content?.[0]?.text;
    if (typeof text !== 'string') return result;
    const clean = scrubKnownSecrets(db(), text);
    return clean === text ? result : { ...result, content: [{ ...result.content[0], text: clean }, ...result.content.slice(1)] };
  };

  /** A read: flag-gated, ledgered (the MCP audit trail), never an audit_log row. */
  const read = (name, fn) => async (args, auth, req) => {
    const t0 = Date.now();
    let result;
    const gate = flagRefusal(PLATFORM_FLAG);
    if (gate) result = err(gate);
    else {
      try { result = await fn(args || {}, auth, req); } catch (e) { result = err(e?.fullPlatformSafe || e?.name === 'ZodError' ? storeMessage(e) : `Tool failed: ${e?.message || 'unknown error'}`); }
    }
    writeLedger({ ts: nowIso(), token_id: auth?.id ?? null, actor: auth?.created_by ?? null, tool: name, subject_type: 'platform', subject_id: args?.service || args?.id || 'platform',
      args: { ...(args?.service ? { service: args.service } : {}), ...(args?.id ? { id: args.id } : {}) }, outcome: result?.isError ? 'refused' : 'ok', dry_run: false, confirmation_used: false,
      summary: 'read', detail: { requested_by: requestedBy(auth) }, duration_ms: Date.now() - t0 });
    return scrub(result);
  };

  /** A write: kit.mutation (ledger + audit) behind mcp.platform, plus any extra flags. */
  const write = (name, { audit, extraFlags = [] }, fn) => mutation(name, { subjectType: 'platform', flag: PLATFORM_FLAG, audit, keepArgs: ['revision', 'service', 'action', 'purge_data', 'if_revision', 'dry_run', 'confirm'] }, async (args, auth, req, note) => {
    for (const f of extraFlags) { const g = flagRefusal(f); if (g) { note.refused = true; return err(g); } }
    note.detail = { requested_by: requestedBy(auth) };
    try { return scrub(await fn(args, auth, req, note)); }
    catch (e) { note.refused = true; return scrub(err(storeMessage(e), { code: e?.code || (e?.name === 'ZodError' ? 'FULL_PLATFORM_INPUT' : 'FULL_PLATFORM_REFUSED') })); }
  });

  /* -------------------------------- reads -------------------------------- */

  const get_platform_setup = read('get_platform_setup', async () => ok(platformSetupView(db())));

  const get_platform_service = read('get_platform_service', async (args) => {
    const service = String(args.service || '');
    if (!SERVICE_IDS.includes(service)) return err(`Unknown service "${service}". Known: ${SERVICE_IDS.join(', ')}.`);
    let runtime = null, runtimeError = null;
    const t = installedTargets(db())[service];
    const row = t ? (service === 'keycloak' ? t.row : serviceReaders[service](db())) : null;
    const names = t?.mode === 'install' ? containerNames(service, row) : [];
    if (args.runtime !== false && names.length) {
      try {
        const listed = await ctx.runHostCapture('docker', ['container', 'ls', '-a', '--format', '{{.Names}}'], { timeoutMs: 20000 });
        if (listed.status !== 0) throw new Error('docker is unavailable on the host');
        const present = names.filter((n) => listed.stdout.split('\n').includes(n));
        runtime = {};
        if (present.length) {
          const r = await ctx.runHostCapture('docker', ['container', 'inspect', ...present], { timeoutMs: 20000 });
          if (r.status !== 0) throw new Error('docker inspect failed');
          runtime = runtimeFacts(service, row, JSON.parse(r.stdout));
        }
      } catch (e) { runtime = null; runtimeError = String(e?.message || e).slice(0, 200); }
    }
    return ok(platformServiceView(db(), service, { runtime, runtimeError }));
  });

  const list_platform_jobs = read('list_platform_jobs', async (args) => {
    const jobs = listPlatformJobs(db(), { service: args.service ? String(args.service) : null, status: args.status ? String(args.status) : null, limit: args.limit });
    return ok({ count: jobs.length, jobs, next: 'get_platform_job({ id }) for one job and its redacted event log.' });
  });

  const get_platform_job = read('get_platform_job', async (args) => {
    const d = platformJobDetail(db(), String(args.id || ''), { tail: args.tail });
    if (!d) return err(`No platform job ${args.id} (list_platform_jobs).`);
    return ok(d);
  });

  const platform_preflight = read('platform_preflight', async () => {
    const d = db(), s = readFullPlatform(d)?.config || defaults(d);
    const origins = [s.publicOrigin, s.recoveryOrigin, ...SERVICE_IDS.filter((id) => s.services[id].mode !== 'skip').map((id) => s.services[id].url)].filter(Boolean);
    const resolveHost = ctx.resolveHost || (async (h) => (await lookup(h, { all: true })).map((a) => a.address));
    const resolve = {};
    for (const h of [...new Set(origins.map((u) => new URL(u).hostname))]) {
      try { resolve[h] = { addresses: await resolveHost(h) }; } catch (e) { resolve[h] = { addresses: [], error: e?.code || 'unresolved' }; }
    }
    const caddyAddresses = s.publicOrigin ? (resolve[new URL(s.publicOrigin).hostname]?.addresses || []) : [];
    let docker = null;
    try { const r = await ctx.runHostCapture('docker', ['version', '--format', '{{.Server.Version}}'], { timeoutMs: 15000 }); docker = r.status === 0 ? { ok: true, version: /^[\w.+-]{1,40}$/.test(r.stdout.trim()) ? r.stdout.trim() : 'unknown' } : { ok: false, error: 'docker version failed' }; }
    catch (e) { docker = { ok: false, error: String(e?.message || e).slice(0, 120) }; }
    let listening = null;
    try {
      const r = await ctx.runHostCapture('ss', ['-ltnH'], { timeoutMs: 15000 });
      if (r.status === 0) listening = new Set(r.stdout.split('\n').map((l) => l.trim().split(/\s+/)[3] || '').map((a) => Number(a.slice(a.lastIndexOf(':') + 1))).filter(Boolean));
    } catch { listening = null; }
    const configured = /^[0-9a-f]{64}$/i.test(process.env.TOTP_ENCRYPTION_KEY || '');
    let decrypts = null;
    for (const table of ['setup_vaultwarden_credentials', 'setup_full_credentials', 'setup_openbao_credentials']) {
      try { const v = d.prepare(`SELECT value FROM ${table} LIMIT 1`).get()?.value; if (v && isEncrypted(v)) { decryptSecret(v); decrypts = true; break; } } catch { decrypts = false; break; }
    }
    return ok({ ...evaluatePreflight(d, { resolve, caddyAddresses, docker, listening, key: { configured, decrypts } }), ports_expected: SERVICE_PORTS });
  });

  /* -------------------------------- writes ------------------------------- */

  const save_platform_setup = write('save_platform_setup', { audit: 'FULL_PLATFORM_PLAN_SAVED' }, async (args, auth, _req, note) => {
    note.subject_id = 'full-platform';
    if (!auth?.created_by) { note.refused = true; return err('This MCP key has no owning administrator; the saved plan must name the administrator who reviews it. Mint a key from an administrator account.'); }
    const d = db(), old = readFullPlatform(d), base = old?.config || defaults(d);
    const config = JSON.parse(JSON.stringify(base));
    const domains = args.domains || {};
    if (domains.proxypilot !== undefined) config.publicOrigin = String(domains.proxypilot);
    if (domains.recovery !== undefined) config.recoveryOrigin = String(domains.recovery);
    for (const id of SERVICE_IDS) {
      if (domains[id] !== undefined) config.services[id].url = String(domains[id]);
      if (args.services?.[id] !== undefined) config.services[id].mode = String(args.services[id]);
      if (config.services[id].mode === 'skip') config.services[id].url = '';
    }
    for (const k of Object.keys(domains)) if (!['proxypilot', 'recovery', ...SERVICE_IDS].includes(k)) { note.refused = true; return err(`Unknown domain key "${k}".`); }
    for (const k of Object.keys(args.services || {})) if (!SERVICE_IDS.includes(k)) { note.refused = true; return err(`Unknown service "${k}".`); }
    if (args.realm !== undefined) config.realm = String(args.realm);
    if (args.restricted_networks !== undefined) config.recoveryNetworks = Array.isArray(args.restricted_networks) ? args.restricted_networks.map(String) : args.restricted_networks;
    if (args.experience !== undefined) config.experience = String(args.experience);
    const input = { expectedRevision: Number(args.if_revision), config, reviewed: true };
    if (args.dry_run === true) {
      // The save's own checks, in its order, without its write.
      const p = saveSchema.parse(input);
      if ((old?.revision || 0) !== p.expectedRevision) { note.refused = true; return err('Setup changed in another session. Reopen the saved plan.', { code: 'PLAN_REVISION_CONFLICT', saved_revision: old?.revision || 0 }); }
      const prior = old?.last_job_id && getJob(d, old.last_job_id);
      if (prior && ['queued', 'running'].includes(prior.status)) { note.refused = true; return err('Wait for the current setup operation before editing this plan.'); }
      validateExisting(d, p.config);
      const review = reviewFullPlatform(d, p.config);
      return ok({ dry_run: true, would_save: !old || changes(old.config, p.config).length > 0, next_revision: old && !changes(old.config, p.config).length ? old.revision : (old?.revision || 0) + 1, changes: review.changes, dns: review.dns, dependencies: review.dependencies, human_steps: review.humanSteps, note: 'Nothing was saved. Re-call without dry_run to save; saving is inert.' });
    }
    const saved = saveFullPlatform(d, input, auth.created_by);
    const review = reviewFullPlatform(d);
    note.summary = `saved Full Platform revision ${saved.revision}`;
    note.detail = { ...note.detail, revision: saved.revision };
    return ok({ saved: true, revision: saved.revision, review_digest: review.reviewToken, changes: review.changes, dns: review.dns, next: `Review, then apply_platform_setup({ revision: ${saved.revision}, review_digest, confirm: true }). Saving queued nothing.` });
  });

  const queueApply = (kind) => write(`${kind}_platform_setup`, { audit: kind === 'apply' ? 'FULL_PLATFORM_APPLIED' : 'FULL_PLATFORM_CONTINUED' }, async (args, auth, _req, note) => {
    note.subject_id = args.service ? `full-platform:${args.service}` : 'full-platform';
    const d = db(), revision = Number(args.revision), reviewToken = String(args.review_digest || '');
    if (kind === 'continue' && args.service) {
      const full = readFullPlatform(d);
      if (!full || revision !== full.revision || reviewToken !== reviewFullPlatform(d).reviewToken) { note.refused = true; return err('The saved revision or review_digest is stale. Re-read get_platform_setup.', { code: 'STALE_REVISION' }); }
      const service = String(args.service);
      const refusal = serviceRetryRefusal(d, service);
      if (refusal) { note.refused = true; return err(refusal.error, refusal); }
      if (args.dry_run === true) return ok({ dry_run: true, would: `queue ${service}'s own adapter job again, reusing its stored encrypted inputs`, note: 'Nothing was queued.' });
      const gate = confirmFlag(args, note, `This re-queues ${service}'s adapter job on the host runner.`);
      if (gate) return gate;
      const r = applyService(d, service, requestedBy(auth));
      note.summary = `retried ${service} (${r.job.id})`; note.detail = { ...note.detail, job_id: r.job.id, created: r.created };
      return ok({ queued: r.created, job: jobSummary(r.job), reused_stored_inputs: true, next: `get_platform_job({ id: "${r.job.id}" })` });
    }
    const refusal = applyRefusal(d, { kind, revision, reviewToken });
    if (refusal) { note.refused = true; return err(refusal.error, refusal); }
    if (args.dry_run === true) return ok({ dry_run: true, would: kind === 'apply' ? `apply revision ${revision}: queue the Full Platform coordinator on the host runner` : `continue revision ${revision}: re-queue the coordinator, keeping completed work`, note: 'Nothing was queued.' });
    const gate = confirmFlag(args, note, kind === 'apply' ? 'Applying installs and connects the selected services on this host.' : 'Continuing re-queues the saved setup on the host runner.');
    if (gate) return gate;
    const r = applyFullPlatform(d, { revision, reviewToken, reviewed: true }, requestedBy(auth), { via: 'mcp' });
    note.summary = `${kind} Full Platform revision ${revision} (${r.job.id})`; note.detail = { ...note.detail, revision, job_id: r.job.id, created: r.created };
    return ok({ queued: r.created, operation: jobSummary(r.job), next: `get_platform_setup() / get_platform_job({ id: "${r.job.id}" }) to follow it.` });
  });

  const manage_platform_service = write('manage_platform_service', { audit: 'FULL_PLATFORM_RUNTIME_ACTION', extraFlags: ['mcp.destructive'] }, async (args, auth, _req, note) => {
    const d = db(), service = String(args.service || ''), action = String(args.action || '');
    note.subject_id = `${service}:${action}`;
    if (!SERVICE_IDS.includes(service) || !['repair', 'reinstall', 'remove'].includes(action)) { note.refused = true; return err('service must be a platform service and action one of repair, reinstall, remove.'); }
    const review = lifecycleReview(d, service, action);   // refuses external services with the dashboard's message
    const preview = { revision: review.revision, service, action, containers: review.containers, effects: review.effects, retain_data: true, unsupported: review.unsupported, blockers: review.blockers };
    if (review.blockers.length) { note.refused = true; return err(`Refused: ${review.blockers.join(' ')}`, { preview }); }
    const full = readFullPlatform(d), prior = full?.last_job_id && getJob(d, full.last_job_id);
    if (prior && ['queued', 'running'].includes(prior.status)) { note.refused = true; return err(`Operation ${prior.id} is ${prior.status}. Wait for it before requesting a runtime action.`); }
    if (args.dry_run === true) return ok({ dry_run: true, preview, note: 'Nothing was queued and no confirmation token was issued.' });
    const gate = confirmToken(args, auth, note, { tool: 'manage_platform_service', subject: `${service}:${action}:${review.reviewToken}`, action: `${action} ${service}`, preview: { preview } });
    if (gate) return gate;
    const r = queueLifecycle(d, { revision: review.revision, service, action, reviewToken: review.reviewToken, reviewed: true, retainData: true }, requestedBy(auth), { via: 'mcp' });
    note.summary = `${action} ${service} queued (${r.job.id})`; note.detail = { ...note.detail, service, action, retainData: true, job_id: r.job.id };
    return ok({ queued: true, job: jobSummary(r.job), preview, next: `get_platform_job({ id: "${r.job.id}" })` });
  });

  const reset_platform_setup = write('reset_platform_setup', { audit: 'FULL_PLATFORM_RESET_REQUESTED', extraFlags: ['mcp.destructive'] }, async (args, auth, _req, note) => {
    const d = db(), purgeData = args.purge_data === true;
    note.subject_id = purgeData ? 'full-platform:reset+purge' : 'full-platform:reset';
    if (purgeData) { const g = flagRefusal(PURGE_FLAG); if (g) { note.refused = true; return err(`${g} purge_data deletes owned data; it is off by default. Without purge_data the reset keeps every data directory, volume, key and credential.`); } }
    const review = resetReview(d, { purgeData });
    const preview = { revision: review.revision, purge_data: purgeData, remove: review.remove, retain: review.retain, backup: review.backup, external_left_untouched: review.external, effects: review.effects, blockers: review.blockers };
    if (review.blockers.length) { note.refused = true; return err(`Refused: ${review.blockers.join(' ')}`, { preview }); }
    if (args.dry_run === true) return ok({ dry_run: true, preview, note: 'Nothing was queued and no confirmation token was issued.' });
    const gate = confirmToken(args, auth, note, { tool: 'reset_platform_setup', subject: `${purgeData ? 'purge' : 'keep'}:${review.reviewToken}`, action: purgeData ? 'reset Full Platform and DELETE owned data (after a verified backup set)' : 'reset Full Platform (data kept)', preview: { preview } });
    if (gate) return gate;
    const r = queueReset(d, { revision: review.revision, reviewToken: review.reviewToken, purgeData, reviewed: true }, requestedBy(auth), { via: 'mcp' });
    note.summary = `reset${purgeData ? ' with purge' : ''} queued (${r.job.id})`; note.detail = { ...note.detail, purgeData, job_id: r.job.id };
    return ok({ queued: true, job: jobSummary(r.job), preview, next: `get_platform_job({ id: "${r.job.id}" }); when it succeeds get_platform_setup starts at step 1.` });
  });

  return {
    get_platform_setup, get_platform_service, list_platform_jobs, get_platform_job, platform_preflight,
    save_platform_setup, apply_platform_setup: queueApply('apply'), continue_platform_setup: queueApply('continue'),
    manage_platform_service, reset_platform_setup,
  };
}
