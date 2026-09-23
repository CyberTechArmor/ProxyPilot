// Full Platform over MCP — the read model and the gates the MCP tools share
// (routes/mcp-tools/platform.js). Everything here reads through the same
// stores the dashboard routes use (full-platform-store, the per-service
// stores, lifecycleReview, the setup job store); nothing here writes. The
// writes stay in saveFullPlatform / applyFullPlatform / applyService /
// queueLifecycle / queueReset, called by the tools exactly as the dashboard
// routes call them.
//
// What this adds is the part a human reads off the page: which step is
// done, what failed and why, and the ordered `next_actions` — each one says
// what is needed, whether an MCP client can do it, and for a human step the
// dashboard location and the control name. Every output is curated (no
// protected references, no state_json dump) and passes through the setup
// engine's redact() on the way out.

import { createHash } from 'node:crypto';
import { SERVICES } from './platform-catalog.js';
import { fullPlatformState, readFullPlatform, installedTargets, reviewFullPlatform, digest, fail } from './full-platform-store.js';
import { lifecycleReview } from './full-platform-lifecycle.js';
import { serviceReaders } from './full-platform-services.js';
import { readPlatformPlan } from './platform-plan.js';
import { getJob, jobView, listEvents } from './store.js';
import { redact, redactText, parseJson, REDACTED } from './logic.js';
import { decryptSecret, isEncrypted } from '../secrets.js';
import { redactText as redactLogText } from './owned-runtime.js';
import { KEYCLOAK_IMAGE, KEYCLOAK_DB_IMAGE, KEYCLOAK_PORT, KEYCLOAK_APP, resourceNames } from './keycloak-logic.js';
import { POMERIUM_IMAGE, POMERIUM_APP, POMERIUM_PORT, POMERIUM_GRPC_PORT, POMERIUM_METRICS_PORT } from './pomerium-logic.js';
import { INFISICAL_IMAGE, INFISICAL_DB_IMAGE, INFISICAL_REDIS_IMAGE, AGENT_PROXY_IMAGE, INFISICAL_APP, INFISICAL_PORT, TEST_PORT } from './infisical-logic.js';
import { namesFor as infisicalNames } from './infisical-runtime.js';
import { OPENBAO_IMAGE, OPENBAO_APP, OPENBAO_PORT, namesFor as baoNames } from './openbao-logic.js';
import { VAULTWARDEN_IMAGE, VAULTWARDEN_APP, VAULTWARDEN_PORT, namesFor as vaultNames, digest as vaultDigest } from './vaultwarden-logic.js';

export const FULL_PLATFORM_APP = 'pp-full-platform';
export const SSO_APP = 'proxypilot-sso';
export const NETWORKS_APP = 'pp-platform-networks';
export const PLATFORM_APPS = Object.freeze([FULL_PLATFORM_APP, KEYCLOAK_APP, POMERIUM_APP, INFISICAL_APP, OPENBAO_APP, VAULTWARDEN_APP, SSO_APP, NETWORKS_APP]);
export const SERVICE_IDS = Object.freeze(SERVICES.map((s) => s.id));
const APP_OF = { keycloak: KEYCLOAK_APP, pomerium: POMERIUM_APP, infisical: INFISICAL_APP, openbao: OPENBAO_APP, vaultwarden: VAULTWARDEN_APP };

// Where a human does what an MCP key never can. `page` is the sidebar entry,
// `path` the route, `step`/`section` the card, `control` the button or field
// label as the dashboard renders it.
export const HUMAN = Object.freeze({
  save: { page: 'Platform Setup', path: '/platform-setup', step: '1. Domains and realm → 2. Review', control: 'Save reviewed plan' },
  administrator: { page: 'Platform Setup', path: '/platform-setup', step: '4. Administrator and recovery', section: 'Permanent Keycloak administrator', control: 'Create or resume permanent administrator' },
  passkey: { page: 'Platform Setup', path: '/platform-setup', step: '4. Administrator and recovery', control: 'Open Keycloak passkey enrollment' },
  accessChecks: { page: 'Platform Setup', path: '/platform-setup', step: '5. Verify and activate', control: 'Continue to access checks (SSO login, step-up and local recovery tests)' },
  retire: { page: 'Platform Setup', path: '/platform-setup', step: '4. Administrator and recovery', section: 'Permanent Keycloak administrator', control: 'Verify administration and retire bootstrap' },
  activate: { page: 'Platform Setup', path: '/platform-setup', step: '5. Verify and activate', section: '5. Explicitly activate SSO', control: 'Activate SSO' },
  reveal: { page: 'Platform Setup', path: '/platform-setup', step: '4. Administrator and recovery', control: 'Reveal initial Keycloak password' },
  infisical: { page: 'Platform Setup', path: '/platform-setup', step: '4. Administrator and recovery', section: 'Infisical administrator', control: 'Create or resume Infisical administration' },
  openbao: { page: 'Platform Setup', path: '/platform-setup', step: '4. Administrator and recovery', section: 'OpenBao recovery custody and manual unseal', control: 'the recipient keys, custody acknowledgement, unseal share and bootstrap token forms' },
  vaultwarden: { page: 'Platform Setup', path: '/platform-setup', step: '5. Verify and activate', section: 'Vaultwarden sign-in and unlock checks', control: 'Record operator-observed checks' },
  custom: { page: 'Platform Setup', path: '/platform-setup', step: 'Custom / Advanced', control: 'the individual service adapter' },
  disableSso: { page: 'Platform Setup', path: '/platform-setup', step: 'Custom / Advanced → Single sign-on', control: 'Disable SSO (from local recovery)' },
  host: { page: 'the host (shell)', path: null, step: 'host network configuration', control: 'assign a private address to the runner host' },
});

/* ------------------------------ small helpers ---------------------------- */

const has = (db, table) => !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table);
const OPEN = ['queued', 'running'];
const FAILED = ['failed', 'refused', 'recovery_required', 'cancelled'];

function ssoRow(db) {
  if (!has(db, 'sso_config')) return null;
  const r = db.prepare('SELECT * FROM sso_config WHERE id=1').get();
  return r ? { ...r, config: parseJson(r.config_json) || {} } : null;
}

/** A job as the MCP surface shows it: identity, state, phase, reason. Never plan params or config refs. */
export function jobSummary(row) {
  const j = row && (row.plan !== undefined ? row : jobView(row));
  if (!j) return null;
  const v = j.verification || null;
  return redact({
    id: j.id, kind: j.kind, app: j.app, status: j.status, phase: j.phase || null, outcome: j.outcome || null,
    reason: j.reason ? redactText(j.reason) : null, requested_by: j.requested_by || null, via: j.via || null, retry_of: j.retry_of || null,
    created_at: j.created_at, started_at: j.started_at || null, finished_at: j.finished_at || null, updated_at: j.updated_at,
    operation: j.plan?.params?.operation || null,
    verification: v ? { state: v.state || null, label: v.label ? redactText(v.label) : null, failed_at: v.failedAt || null, complete: v.complete ?? null } : null,
  });
}

/** The read-only G3 observer the Vaultwarden/OpenBao adapters require for their provider. */
export function observerStatus(db, connectionId = null) {
  const sso = ssoRow(db);
  if (!sso) {
    return { present: false, matches_provider: false, reader_client_id: null, verified: false, active: false,
      created_by: 'The Full Platform coordinator, in its connect_managed_identity step: it creates the pp-<keycloak>-observer client with only view-realm/view-clients/view-users, then saves the ProxyPilot SSO record that names it. That step runs before any selected service job is queued.' };
  }
  return { present: true, connection_id: sso.config.connectionId || null, matches_provider: connectionId ? sso.config.connectionId === connectionId : null,
    reader_client_id: sso.config.readerClientId || null, verified: !!sso.verified_at, active: !!sso.active };
}

/* --------------------------- failure classification ---------------------- */

// Known failure texts from the coordinator and the service adapters, mapped to
// a reason code and the remedy. The texts are the adapters' own safe messages
// (they are the only text a failed platform job carries).
function classify(db, reason, { service = null, phase = null } = {}) {
  const text = String(reason || '');
  const keycloak = installedTargets(db).keycloak;
  if (/read-only Keycloak observer/.test(text)) {
    const obs = observerStatus(db, serviceReaders[service]?.(db)?.config?.connectionId || keycloak?.row?.id || null);
    const full = readFullPlatform(db);
    if (keycloak?.mode !== 'install') {
      return { code: 'observer_missing', by: 'human', need: `${service || 'The service'} needs the read-only Keycloak observer for its provider. The provider is external, so its owner connects the observer through Custom setup.`, where: { ...HUMAN.custom, control: 'Single sign-on (G3) → reader client' } };
    }
    if (obs.present && obs.matches_provider === false) {
      return { code: 'observer_provider_mismatch', by: 'human', need: 'ProxyPilot SSO names a different Keycloak connection than this service. Replacing it is a separately reviewed identity change.', where: HUMAN.custom };
    }
    if (!obs.present) {
      const planDrift = full?.plan_revision && readPlatformPlan(db).revision !== full.plan_revision;
      return { code: 'observer_missing', by: 'mcp', tool: planDrift ? 'resync_platform_plan' : 'continue_platform_setup',
        need: `The observer is created by the Full Platform coordinator (connect_managed_identity), not by the ${service || 'service'} adapter; it does not exist yet, so the service was applied before the coordinator reached that step.${planDrift ? ' The coordinator cannot reach it while the shared plan differs from the one it saved (see shared_plan_changed).' : ' Continue the saved setup to let the coordinator create it, then retry the service.'}` };
    }
    return { code: 'observer_unverified', by: 'mcp', tool: 'continue_platform_setup', need: 'The observer exists but is not verified yet; continuing lets the coordinator re-run its SSO checks before retrying the service.' };
  }
  if (/Custom setup changed the shared service plan/.test(text)) {
    return { code: 'shared_plan_changed', by: 'mcp', tool: 'resync_platform_plan',
      need: 'The shared service plan was saved from Custom / Advanced after this Full Platform revision recorded it. Resync it (resync_platform_plan, or Platform overview → Resync shared plan): that creates a new Full Platform revision from the saved values, and the next continue writes the shared plan again. No reset is needed.' };
  }
  if (/No private runner address/.test(text)) return { code: 'agent_proxy_address', by: 'human', need: text, where: HUMAN.host };
  if (/confirm the existing Pomerium|external owner must complete|External Keycloak|explicit Custom connection/.test(text)) return { code: 'external_connection', by: 'human', need: text, where: HUMAN.custom };
  if (/one-time administrator input expired|Enter the permanent administrator credential again/.test(text)) return { code: 'administrator_input', by: 'human', need: text, where: HUMAN.administrator };
  if (/Infisical administrator|personal credential|personal password/.test(text)) return { code: 'infisical_personal', by: 'human', need: text, where: HUMAN.infisical };
  if (/explicitly removed/.test(text)) return { code: 'runtime_removed', by: 'mcp', tool: 'manage_platform_service', need: text };
  if (/superseded/i.test(text)) return { code: 'superseded', by: 'mcp', tool: 'get_platform_setup', need: 'A newer operation replaced this one; read the current state.' };
  return { code: phase || 'failed', by: 'mcp', tool: 'get_platform_job', need: 'Read the job and its redacted event log, correct the reported cause, then continue the saved setup.' };
}

/* --------------------------------- the view ------------------------------ */

function stepStatus(s, full, services) {
  const sel = services.filter((x) => x.state !== 'skipped');
  const install = !full?.approved_revision ? 'pending'
    : sel.some((x) => x.state === 'failed') ? 'failed'
      : sel.some((x) => ['queued', 'running'].includes(x.state)) ? 'running'
        : sel.every((x) => x.state === 'verified') ? 'done' : 'in_progress';
  return [
    { step: 1, name: 'Domains and realm', status: full ? 'done' : 'pending' },
    { step: 2, name: 'Review', status: !full ? 'pending' : full.approved_revision === full.revision ? 'done' : 'pending' },
    { step: 3, name: 'Install and connect', status: install },
    { step: 4, name: 'Administrator and recovery', status: s.state?.administratorVerified ? 'done' : s.state?.administrator?.masterId ? 'in_progress' : 'pending' },
    { step: 5, name: 'Verify and activate', status: s.active ? 'done' : s.state?.administratorVerified ? 'in_progress' : 'pending' },
    { step: 6, name: 'Complete', status: s.complete ? 'done' : 'pending' },
  ];
}

export function platformSetupView(db) {
  const s = fullPlatformState(db), full = readFullPlatform(db);
  const review = full ? reviewFullPlatform(db) : null;
  const shared = readPlatformPlan(db);
  const operation = s.job ? jobSummary(s.job) : null;
  const opRunning = !!(operation && OPEN.includes(operation.status));
  const services = s.services.map((x) => ({
    id: x.id, name: x.name, selected: x.state !== 'skipped', mode: s.config.services[x.id].mode, url: x.url, ownership: x.ownership, state: x.state,
    job: x.job ? jobSummary(x.job) : null, action: x.action ? redactText(x.action) : null, removed: !!s.state?.removed?.[x.id],
  }));
  const failures = [];
  if (operation && FAILED.includes(operation.status)) failures.push({ scope: 'operation', job_id: operation.id, job: operation.kind, reason_code: operation.phase || operation.outcome, reason: operation.reason, ...pick(classify(db, operation.reason, { phase: operation.phase })) });
  for (const x of services) {
    if (x.state !== 'failed' || !x.job) continue;
    failures.push({ scope: x.id, job_id: x.job.id, job: x.job.kind, reason_code: x.job.phase || x.job.outcome, reason: x.job.reason, ...pick(classify(db, x.job.reason, { service: x.id, phase: x.job.phase })) });
  }
  const keycloak = installedTargets(db).keycloak;
  const view = {
    revision: s.revision, review_digest: review?.reviewToken || null, fingerprint: full ? digest(full.config) : null,
    approved_revision: s.approvedRevision, plan_revision: s.planRevision, shared_plan_revision: shared.revision || null,
    shared_plan_in_sync: !full?.plan_revision || shared.revision === full.plan_revision,
    saved: !!full, stage: s.stage, complete: s.complete, sso_active: s.active,
    domains: { proxypilot: s.config.publicOrigin, recovery: s.config.recoveryOrigin, ...Object.fromEntries(SERVICE_IDS.map((id) => [id, s.config.services[id].url || null])) },
    realm: s.config.realm, experience: s.config.experience,
    selected_services: Object.fromEntries(SERVICE_IDS.map((id) => [id, s.config.services[id].mode])),
    restricted_networks: s.config.recoveryNetworks,
    steps: stepStatus(s, full, services),
    operation, operation_running: opRunning,
    services, failures,
    observer: observerStatus(db, keycloak?.row?.id || null),
    administrator: { prepared: !!s.state?.administrator?.masterId, verified: !!s.state?.administratorVerified, recovery_verified: !!s.state?.recoveryVerified },
  };
  view.next_actions = nextActions(db, view, s, full);
  view.human_only = HUMAN_ONLY;
  return redact(view);
}

const pick = (c) => ({ reason_class: c.code, mcp_can_do: c.by === 'mcp', ...(c.tool ? { tool: c.tool } : {}), remedy: c.need, ...(c.where ? { where: c.where } : {}) });

export const HUMAN_ONLY = Object.freeze([
  { action: 'Reveal the initial Keycloak password', where: HUMAN.reveal },
  { action: 'Enter the permanent administrator password (and OTP)', where: HUMAN.administrator },
  { action: 'Fresh permanent master login to retire the bootstrap account', where: HUMAN.retire },
  { action: 'Activate SSO', where: HUMAN.activate },
  { action: 'Any secret input: client secrets, admin tokens, the Infisical personal password, OpenBao PGP keys, unseal shares, root/bootstrap token, vault master passwords', where: HUMAN.custom },
]);

function act(id, need, by, extra = {}) { return { id, need, by, mcp_can_do: by === 'mcp', ...extra }; }

function nextActions(db, v, s, full) {
  const out = [];
  if (!full) {
    out.push(act('save_plan', 'Save the domains, realm, services and restricted administrator/VPN networks.', 'mcp', { tool: 'save_platform_setup', args: { if_revision: 0 }, human_alternative: HUMAN.save }));
    return out;
  }
  if (!s.config.recoveryNetworks.length) out.push(act('recovery_networks', 'Confirm at least one approved administrator/VPN recovery network; apply is refused without one.', 'mcp', { tool: 'save_platform_setup', args: { if_revision: v.revision } }));
  if (v.operation_running) {
    out.push(act('wait', `Operation ${v.operation.id} is ${v.operation.status}${v.operation.phase ? ` (${v.operation.phase})` : ''}. Wait for it; nothing else can be queued meanwhile.`, 'mcp', { tool: 'get_platform_job', args: { id: v.operation.id } }));
    return out;
  }
  if (v.approved_revision !== v.revision) {
    out.push(act('apply', `Apply saved revision ${v.revision}.`, 'mcp', { tool: 'apply_platform_setup', args: { revision: v.revision, review_digest: v.review_digest, confirm: true } }));
    return out;
  }
  for (const f of v.failures) {
    out.push(act(`fix_${f.scope}`, `${f.scope === 'operation' ? 'The setup operation' : f.scope} failed at ${f.reason_code}: ${f.reason} — ${f.remedy}`, f.mcp_can_do ? 'mcp' : 'human',
      { reason_code: f.reason_code, reason_class: f.reason_class, job_id: f.job_id, ...(f.tool ? { tool: f.tool } : {}), ...(f.where ? { where: f.where } : {}) }));
  }
  if (!v.shared_plan_in_sync && !v.failures.some((f) => f.reason_class === 'shared_plan_changed')) {
    const c = classify(db, 'Custom setup changed the shared service plan.');
    out.push(act('shared_plan_changed', `The shared service plan (revision ${v.shared_plan_revision}) differs from the one this Full Platform revision recorded (${v.plan_revision}); the coordinator will refuse to continue. ${c.need}`, 'mcp', { tool: c.tool, reason_class: c.code }));
  }
  for (const x of v.services) if (x.removed) out.push(act(`reinstall_${x.id}`, `${x.name} runtime was explicitly removed; ordinary continue will not undo that.`, 'mcp', { tool: 'manage_platform_service', args: { service: x.id, action: 'reinstall' } }));
  if (!v.failures.length && v.services.some((x) => x.selected && ['planned', 'installed'].includes(x.state))) {
    out.push(act('continue', 'Selected services are not connected yet; continue the saved setup.', 'mcp', { tool: 'continue_platform_setup', args: { revision: v.revision, review_digest: v.review_digest, confirm: true } }));
  }
  const st = s.state || {};
  if (st.identity?.bootstrapRef && !st.administratorVerified) {
    if (!st.administrator?.masterId) out.push(act('administrator', 'Create the permanent Keycloak administrator: names, email and a permanent password typed by the person.', 'human', { where: HUMAN.administrator }));
    else {
      out.push(act('passkey', 'Enroll the application identity\'s discoverable passkey in Keycloak Account Console and confirm its email.', 'human', { where: HUMAN.passkey }));
      out.push(act('access_checks', 'Prove the ProxyPilot account link, test SSO login and step-up, and separately test restricted local recovery.', 'human', { where: HUMAN.accessChecks }));
      out.push(act('retire_bootstrap', 'Supply a fresh permanent master login (and OTP) and retire the bootstrap account.', 'human', { where: HUMAN.retire }));
    }
  }
  const byId = Object.fromEntries(v.services.map((x) => [x.id, x]));
  if (byId.infisical?.selected && byId.infisical.state === 'awaiting_user_action' && /personal|administrator|password/i.test(byId.infisical.action || '')) out.push(act('infisical_personal', byId.infisical.action, 'human', { where: HUMAN.infisical }));
  if (byId.openbao?.selected && byId.openbao.state === 'awaiting_user_action') out.push(act('openbao_custody', byId.openbao.action || 'Recovery custody, manual unseal and the bootstrap token are human steps.', 'human', { where: HUMAN.openbao }));
  if (byId.vaultwarden?.selected && byId.vaultwarden.state === 'awaiting_user_action' && /web vault|Vaultwarden/i.test(byId.vaultwarden.action || '')) out.push(act('vaultwarden_checks', byId.vaultwarden.action, 'human', { where: HUMAN.vaultwarden }));
  if (st.administratorVerified && !v.sso_active) out.push(act('activate_sso', 'Activate SSO.', 'human', { where: HUMAN.activate }));
  if (v.complete) out.push(act('done', 'Full Platform setup is complete.', 'mcp', { tool: 'get_platform_setup' }));
  return out;
}

/* ------------------------------ apply / continue ------------------------- */

/**
 * The refusals apply/continue share before the store is called. Returns null
 * or { error, ... }. `kind` is 'apply' | 'continue'.
 */
export function applyRefusal(db, { kind, revision, reviewToken }) {
  const full = readFullPlatform(db);
  if (!full) return { error: 'No Full Platform setup is saved. Call save_platform_setup first.' };
  if (revision !== full.revision) return { error: `The saved revision is ${full.revision}, not ${revision}. Re-read get_platform_setup and review the current plan.`, code: 'STALE_REVISION' };
  const review = reviewFullPlatform(db);
  if (reviewToken !== review.reviewToken) return { error: 'review_digest does not match the saved plan. Re-read get_platform_setup and review the current plan.', code: 'STALE_REVIEW' };
  const prior = full.last_job_id && getJob(db, full.last_job_id);
  if (prior && OPEN.includes(prior.status)) return { error: `Operation ${prior.id} is already ${prior.status}. Wait for it (get_platform_job).`, code: 'OPERATION_RUNNING', job: jobSummary(prior) };
  if (kind === 'apply' && full.approved_revision === full.revision) return { error: `Revision ${full.revision} is already applied. Use continue_platform_setup to resume it.`, code: 'ALREADY_APPLIED' };
  if (kind === 'continue' && full.approved_revision !== full.revision) return { error: `Revision ${full.revision} has not been applied yet. Use apply_platform_setup.`, code: 'NOT_APPLIED' };
  const view = platformSetupView(db);
  const first = view.next_actions.find((a) => a.id !== 'done');
  const mcpWork = view.next_actions.some((a) => a.mcp_can_do && ['apply', 'continue', 'recovery_networks'].includes(a.id) || /^fix_/.test(a.id) && a.mcp_can_do && a.tool === 'continue_platform_setup' || /^fix_/.test(a.id) && a.mcp_can_do && a.tool === 'get_platform_job');
  if (first?.id === 'recovery_networks') return { error: first.need, code: 'RECOVERY_NETWORK_REQUIRED', next_action: first };
  if (kind === 'continue' && first && !first.mcp_can_do && !mcpWork) return { error: `The next step needs a human: ${first.need}`, code: 'HUMAN_STEP_REQUIRED', next_action: first };
  if (kind === 'continue') {
    const resync = view.next_actions.find((a) => a.tool === 'resync_platform_plan');
    if (resync) return { error: `Continuing cannot succeed: ${resync.need}`, code: 'SHARED_PLAN_CHANGED', next_action: resync };
  }
  return null;
}

/** Retry one service's own adapter (applyService) — refusals first. */
export function serviceRetryRefusal(db, service) {
  const full = readFullPlatform(db);
  if (!full?.approved_revision || full.approved_revision !== full.revision) return { error: 'Apply the saved Full Platform revision before retrying a single service.' };
  if (!serviceReaders[service]) return { error: `${service} has no separate adapter job to retry; continue the saved setup instead.` };
  if (full.config.services[service]?.mode === 'skip') return { error: `${service} is skipped in the saved plan.` };
  const prior = full.last_job_id && getJob(db, full.last_job_id);
  if (prior && OPEN.includes(prior.status)) return { error: `Operation ${prior.id} is ${prior.status}. Wait for it.`, code: 'OPERATION_RUNNING' };
  const row = serviceReaders[service](db);
  if (!row) return { error: `${service} has no saved service record yet; continue the saved setup so the coordinator prepares it.` };
  const last = row.last_job_id && getJob(db, row.last_job_id);
  if (last && OPEN.includes(last.status)) return { error: `${service} job ${last.id} is already ${last.status}.`, code: 'OPERATION_RUNNING', job: jobSummary(last) };
  if (full.state?.removed?.[service]) return { error: `${service} runtime was explicitly removed; use manage_platform_service action "reinstall".` };
  if (['vaultwarden', 'openbao'].includes(service) && row.config.connectionId) {
    const obs = observerStatus(db, row.config.connectionId);
    if (!obs.present || !obs.matches_provider) {
      const c = classify(db, 'The existing read-only Keycloak observer for this provider is required.', { service });
      return { error: `Retrying ${service} would fail at dedicated_keycloak_handoff: the read-only Keycloak observer for its provider ${obs.present ? 'names a different provider' : 'does not exist'}. ${c.need}`, code: 'OBSERVER_REQUIRED', next_action: act('observer', c.need, c.by, { ...(c.tool ? { tool: c.tool } : {}), ...(c.where ? { where: c.where } : {}) }) };
    }
  }
  if (service === 'openbao' && row.config.mode === 'install' && row.init_attempted && !row.handoff_ack) return { error: 'OpenBao is waiting for recovery custody acknowledgement and manual unseal — a human step.', code: 'HUMAN_STEP_REQUIRED', next_action: act('openbao_custody', 'Recovery custody and manual unseal.', 'human', { where: HUMAN.openbao }) };
  return null;
}

/* --------------------------------- services ------------------------------ */

const PORTS = { keycloak: [KEYCLOAK_PORT], pomerium: [POMERIUM_PORT, POMERIUM_GRPC_PORT, POMERIUM_METRICS_PORT], infisical: [INFISICAL_PORT, TEST_PORT], openbao: [OPENBAO_PORT], vaultwarden: [VAULTWARDEN_PORT] };
const IMAGES = { keycloak: [KEYCLOAK_IMAGE, KEYCLOAK_DB_IMAGE], pomerium: [POMERIUM_IMAGE], infisical: [INFISICAL_IMAGE, INFISICAL_DB_IMAGE, INFISICAL_REDIS_IMAGE, AGENT_PROXY_IMAGE], openbao: [OPENBAO_IMAGE], vaultwarden: [VAULTWARDEN_IMAGE] };
export const SERVICE_PORTS = PORTS;

/** The owned route id / service id each adapter writes (keycloak by installation id, the rest by credential ref). */
export function ownedRoute(service, row) {
  if (!row) return null;
  if (service === 'pomerium') return { route_id: 'pomerium-auth-route', service_id: 'pomerium-auth', port: POMERIUM_PORT };
  const ref = service === 'keycloak' ? row.id : row.credential_ref;
  return { route_id: `${service}-route-${ref}`, service_id: `${service}-${ref}`, port: PORTS[service][0] };
}

export function containerNames(service, row) {
  if (!row) return [];
  if (service === 'keycloak') { const n = resourceNames(row.id); return [n.server, n.database]; }
  if (service === 'pomerium') return [POMERIUM_APP];
  if (service === 'infisical') { const n = infisicalNames(row); return [n.proxy, n.server, n.redis, n.database]; }
  if (service === 'openbao') return [baoNames(row).server];
  return [vaultNames(row).server];
}

/** The owned Docker networks of one service, with what each is for (reset and drift use the same names). */
export function ownedNetworks(service, row) {
  if (!row) return [];
  if (service === 'keycloak') return [{ name: resourceNames(row.id).network, internal: false, members: containerNames(service, row), purpose: 'Keycloak and its database' }];
  if (service === 'infisical') {
    const n = infisicalNames(row);
    return [
      { name: n.network, internal: true, members: [n.database, n.redis, n.server], purpose: 'private data network (no route out)' },
      { name: n.edgeNetwork, internal: false, masquerade: false, members: [n.server], purpose: `published port 127.0.0.1:${INFISICAL_PORT} only — Docker publishes nothing for a container on internal networks alone` },
      { name: n.proxyNetwork, internal: false, members: [n.proxy], purpose: 'Agent Proxy' },
    ];
  }
  if (service === 'openbao') return [{ name: baoNames(row).network, internal: false, members: [baoNames(row).server], purpose: 'OpenBao server' }];
  if (service === 'vaultwarden') return [{ name: vaultNames(row).network, internal: false, members: [vaultNames(row).server], purpose: 'Vaultwarden server' }];
  return [];
}

/**
 * An expected container that is absent only because the step that creates it
 * has not run yet — reported as pending, not as missing/broken. Today: the
 * Infisical Agent Proxy, created after the Infisical bootstrap handoff.
 */
export function pendingContainer(service, row, name) {
  if (service !== 'infisical' || !row) return null;
  const n = infisicalNames(row);
  if (name === n.proxy && row.config?.agentMode !== 'skip' && !row.resources?.proxy?.container) return 'pending — created after bootstrap';
  return null;
}

export function rowFor(db, service) {
  const t = installedTargets(db)[service];
  return t ? { target: t, row: service === 'keycloak' ? t.row : serviceReaders[service](db) } : { target: null, row: null };
}

/**
 * The service detail minus live runtime facts; `runtime` (docker inspect
 * results keyed by name) is merged in by the caller when it could read the host.
 */
export function platformServiceView(db, service, { runtime = null, runtimeError = null } = {}) {
  if (!SERVICE_IDS.includes(service)) throw fail(`Unknown service ${service}. Known: ${SERVICE_IDS.join(', ')}.`);
  const s = fullPlatformState(db), entry = s.services.find((x) => x.id === service);
  const { target, row } = rowFor(db, service);
  const ownership = target ? (target.mode === 'install' ? 'owned' : 'external') : null;
  const names = ownership === 'owned' ? containerNames(service, row) : [];
  const route = ownedRoute(service, row);
  const routeRow = route && has(db, 'service_http_routes') ? db.prepare('SELECT id, service_id, domain, target_port, ip_allowlist_json FROM service_http_routes WHERE id=?').get(route.route_id) : null;
  const host = entry.url ? new URL(entry.url).hostname : null;
  const foreign = host && has(db, 'service_http_routes') ? db.prepare('SELECT id FROM service_http_routes WHERE domain=?').all(host).map((r) => r.id).filter((id) => id !== route?.route_id) : [];
  const verification = verificationView(db, service, row);
  let dependencies = null;
  if (ownership === 'owned') {
    try { dependencies = { remove: lifecycleReview(db, service, 'remove').blockers, reinstall: lifecycleReview(db, service, 'reinstall').blockers }; }
    catch (e) { dependencies = { error: e.fullPlatformSafe ? e.message : 'unavailable' }; }
  }
  const connectionId = service === 'keycloak' ? row?.id : row?.config?.connectionId;
  const out = {
    service, name: entry.name, selected: entry.state !== 'skipped', mode: s.config.services[service].mode, url: entry.url, state: entry.state,
    ownership, record: !!row, removed: !!s.state?.removed?.[service],
    images_expected: IMAGES[service], loopback_ports: PORTS[service],
    containers: names.map((n) => { const pending = runtime && !runtime[n] ? pendingContainer(service, row, n) : null; return { name: n, ...(runtime?.[n] || { present: runtime ? false : null }), ...(pending ? { pending: true, status: pending } : {}) }; }),
    networks: ownership === 'owned' ? ownedNetworks(service, row) : [],
    runtime_error: runtimeError,
    route: route ? { hostname: host, route_id: route.route_id, recorded: !!routeRow, upstream: `127.0.0.1:${route.port}`, restricted_networks: routeRow?.ip_allowlist_json ? parseJson(routeRow.ip_allowlist_json) : null, other_routes_on_hostname: foreign } : { hostname: host, recorded: false, other_routes_on_hostname: foreign },
    verification,
    observer: ['keycloak', 'vaultwarden', 'openbao', 'pomerium'].includes(service) && connectionId ? observerStatus(db, connectionId) : null,
    job: entry.job ? jobSummary(entry.job) : null, action: entry.action ? redactText(entry.action) : null,
    dependencies,
    actions_available: ownership === 'owned' ? ['repair', 'reinstall', 'remove'] : [],
    note: ownership === 'external' ? 'External connections never authorize repair, reinstallation, removal or reset of their runtime.' : null,
  };
  return redact(out);
}

export function verificationView(db, service, row) {
  if (!row) return { status: 'not_verified', label: 'No saved service record.' };
  const raw = service === 'keycloak' ? (row.verified_json ? parseJson(row.verified_json) : null) : (row.verified_json ? parseJson(row.verified_json) : null);
  if (!raw) return { status: 'not_verified', label: 'No configuration verification is recorded.' };
  const at = raw.verifiedAt || row.verified_at || null;
  const last = row.last_job_id && getJob(db, row.last_job_id);
  let current = last?.status === 'succeeded';
  if (service === 'vaultwarden') current = current && raw.fingerprint === vaultDigest(row.config);
  const ceremony = service === 'vaultwarden' && row.ceremony_json ? parseJson(row.ceremony_json) : null;
  return {
    status: current ? 'current' : 'previously_verified', state: raw.state || null, label: raw.label ? redactText(raw.label) : null, verified_at: at,
    note: current ? 'Verified by the latest succeeded adapter job for the saved configuration. Health alone is not a login or unlock proof.' : 'Previously verified; a later job or changed configuration means it is not a current proof. Reapply to check current settings.',
    ...(service === 'vaultwarden' ? { browser_checks: ceremony && ceremony.configurationFingerprint === raw.configurationFingerprint ? { recorded_at: ceremony.recordedAt, source: 'operator_observed' } : null } : {}),
  };
}

/** Shape docker inspect JSON into the per-container runtime facts (id, image, health) — nothing from Env. */
export function runtimeFacts(service, row, inspected) {
  const label = `io.proxypilot.${service}`, ref = service === 'keycloak' ? row?.id : row?.credential_ref;
  const out = {};
  for (const c of inspected || []) {
    const name = String(c.Name || '').replace(/^\//, '');
    const driver = c.HostConfig?.LogConfig?.Type || null;
    out[name] = { present: true, id: String(c.Id || '').slice(0, 12), image: c.Config?.Image || null, running: !!c.State?.Running, status: c.State?.Status || null,
      health: c.State?.Health?.Status || (c.State?.Running ? 'running (no healthcheck)' : 'stopped'), started_at: c.State?.StartedAt || null, owned_label: c.Config?.Labels?.[label] === ref,
      ...(c.State?.Running ? {} : { exit_code: c.State?.ExitCode ?? null, error: c.State?.Error ? redactLogText(String(c.State.Error)).slice(0, 300) : null, finished_at: c.State?.FinishedAt || null }),
      networks: Object.keys(c.NetworkSettings?.Networks || {}),
      log_driver: driver, logs_readable: driver ? driver !== 'none' : null };
  }
  return out;
}

/* ----------------------------------- jobs -------------------------------- */

export function listPlatformJobs(db, { service = null, status = null, limit = 50 } = {}) {
  const apps = service ? [APP_OF[service]] : PLATFORM_APPS;
  if (service && !APP_OF[service]) throw fail(`Unknown service ${service}.`);
  const where = [`app IN (${apps.map(() => '?').join(',')})`], params = [...apps];
  if (status) { where.push('status = ?'); params.push(String(status)); }
  params.push(Math.max(1, Math.min(200, Number(limit) || 50)));
  return db.prepare(`SELECT * FROM setup_jobs WHERE ${where.join(' AND ')} ORDER BY created_at DESC, rowid DESC LIMIT ?`).all(...params).map(jobSummary);
}

export function platformJobDetail(db, id, { tail = 50 } = {}) {
  const row = getJob(db, String(id));
  if (!row || !PLATFORM_APPS.includes(row.app)) return null;
  const events = listEvents(db, row.id, { limit: 5000 });
  const n = Math.max(1, Math.min(500, Number(tail) || 50));
  return redact({
    job: jobSummary(row),
    events: events.slice(-n).map((e) => ({ id: e.id, at: e.at, kind: e.kind, phase: e.phase, message: e.message ? redactText(e.message) : null, data: e.data_json ? parseJson(e.data_json) : null })),
    events_total: events.length,
    note: 'Events are redacted on write by the setup engine and again here; upstream bodies and protected values are never recorded.',
  });
}

/* --------------------------------- preflight ----------------------------- */

/**
 * Pure evaluation of the host facts the MCP handler collected:
 *   resolve: { hostname: { addresses:[], error } }, caddyAddresses: [..] (what
 *   the ProxyPilot administrator hostname resolves to), docker: { ok, version, error },
 *   listening: Set of loopback ports in use, key: { configured, decrypts }.
 */
export function evaluatePreflight(db, { resolve = {}, caddyAddresses = [], docker = null, listening = null, key = null } = {}) {
  const s = fullPlatformState(db);
  const hosts = [['proxypilot', s.config.publicOrigin], ['recovery', s.config.recoveryOrigin], ...SERVICE_IDS.filter((id) => s.config.services[id].mode !== 'skip').map((id) => [id, s.config.services[id].url])].filter(([, u]) => u);
  const routes = has(db, 'service_http_routes') ? db.prepare('SELECT id, domain FROM service_http_routes').all() : [];
  const hostnames = hosts.map(([id, url]) => {
    const h = new URL(url).hostname, r = resolve[h] || {};
    const { row } = SERVICE_IDS.includes(id) ? rowFor(db, id) : { row: null };
    const own = SERVICE_IDS.includes(id) ? ownedRoute(id, row) : null;
    const onHost = routes.filter((x) => x.domain === h);
    const points = (r.addresses || []).length && caddyAddresses.length ? r.addresses.some((a) => caddyAddresses.includes(a)) : null;
    return { for: id, hostname: h, resolves: (r.addresses || []).length > 0, addresses: r.addresses || [], points_at_caddy_host: points, error: r.error || null,
      route: onHost.length ? (own && onHost.some((x) => x.id === own.route_id) ? 'owned' : id === 'proxypilot' ? 'administrator' : 'other') : 'none' };
  });
  const ports = SERVICE_IDS.filter((id) => s.config.services[id].mode === 'install').map((id) => ({ service: id, ports: PORTS[id].map((p) => ({ port: p, in_use: listening ? listening.has(p) : null })) }));
  const checks = [
    ...hostnames.map((h) => ({ id: `dns:${h.hostname}`, ok: h.resolves && h.points_at_caddy_host !== false, detail: h.resolves ? (h.points_at_caddy_host === false ? `resolves to ${h.addresses.join(', ')}, not the Caddy host (${caddyAddresses.join(', ') || 'unknown'})` : 'resolves to the Caddy host') : `does not resolve${h.error ? ` (${h.error})` : ''}`, remedy: 'Point this hostname directly at the Caddy host.' })),
    ...hostnames.filter((h) => h.route === 'other' && h.for !== 'recovery').map((h) => ({ id: `route:${h.hostname}`, ok: false, detail: 'another recorded route already serves this hostname', remedy: 'Select an unassigned hostname.' })),
    { id: 'docker', ok: !!docker?.ok, detail: docker?.ok ? `Docker ${docker.version || ''}`.trim() : `Docker unavailable${docker?.error ? `: ${docker.error}` : ''}`, remedy: 'Owned services run as standalone Docker containers on the host.' },
    { id: 'installation_key', ok: !!key?.configured && key?.decrypts !== false, detail: !key?.configured ? 'TOTP_ENCRYPTION_KEY is not configured' : key.decrypts === false ? 'the key does not open the saved protected credentials' : 'present', remedy: 'Restore the matching installation key; never generate a new one over saved credentials.' },
  ];
  return redact({ ready: checks.every((c) => c.ok), checks, hostnames, loopback_ports: ports, caddy_host_addresses: caddyAddresses });
}

/** sha256 of a string — used to bind confirmation subjects without echoing tokens. */
export const short = (v) => createHash('sha256').update(String(v)).digest('hex').slice(0, 16);

/* ------------------------------ secret scrub ----------------------------- */

const CREDENTIAL_TABLES = ['setup_full_credentials', 'setup_vaultwarden_credentials', 'setup_openbao_credentials', 'setup_infisical_credentials', 'setup_pomerium_credentials', 'sso_credentials'];
const NOT_SECRET_KEY = /^(id|installationId|owner|email|origin|ref|expiresAt|retired|organizationId|projectId|userId|bootstrapIdentityId|identityId|clientId)$|(_id|Id)$/;

/**
 * Every protected value this installation holds, decrypted in memory only to
 * be matched against an outgoing MCP result. Identifiers stored alongside a
 * secret (installation ids, emails, client ids) are not collected.
 */
export function knownSecretValues(db) {
  const out = new Set();
  const walk = (v, key = '') => {
    if (typeof v === 'string') { if (v.length >= 12 && !NOT_SECRET_KEY.test(key)) out.add(v); return; }
    if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, Array.isArray(v) ? key : k);
  };
  for (const table of CREDENTIAL_TABLES) {
    if (!has(db, table)) continue;
    for (const row of db.prepare(`SELECT value FROM ${table}`).all()) {
      if (!isEncrypted(row.value)) continue;
      let plain; try { plain = decryptSecret(row.value); } catch { continue; }
      let parsed; try { parsed = JSON.parse(plain); } catch { parsed = plain; }
      walk(parsed);
    }
  }
  return out;
}

/** Replace any known protected value (raw or JSON-escaped) in an outgoing text. */
export function scrubKnownSecrets(db, text) {
  let s = String(text ?? '');
  for (const secret of knownSecretValues(db)) {
    s = s.split(secret).join(REDACTED);
    const escaped = JSON.stringify(secret).slice(1, -1);
    if (escaped !== secret) s = s.split(escaped).join(REDACTED);
  }
  return s;
}
