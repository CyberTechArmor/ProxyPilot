// The platform family: Platform Setup (Full Platform) over MCP. Reads the
// same saved plan, operations and service records as the dashboard, moves the
// setup forward through the same store functions, and manages the OWNED
// services — never an external one. What needs a person (passwords, the
// initial Keycloak password, bootstrap retirement, SSO activation, any
// secret) is not callable here; next_actions names where to do it.

import { P, tool } from './shared.js';

const service = { type: 'string', enum: ['keycloak', 'pomerium', 'infisical', 'openbao', 'vaultwarden'], description: 'Platform service id.' };
const revision = { type: 'number', description: 'The saved Full Platform revision you reviewed (get_platform_setup.revision).' };
const reviewDigest = { type: 'string', description: 'get_platform_setup.review_digest for that revision — binds the call to the exact saved plan you reviewed.' };

export const PLATFORM_TOOLS = Object.freeze([
  tool('get_platform_setup',
    'Platform Setup (Full Platform) as the dashboard sees it, plus what to do next. Returns the saved revision, its fingerprint and review_digest, domains, realm, selected services, restricted administrator/VPN networks, the status of steps 1–6, the current operation and every service job, and for anything failed the job, its reason_code (the phase it failed at) and plain reason. The read-only Keycloak observer the Vaultwarden/OpenBao adapters need is reported with what creates it. next_actions is ordered: each entry says what is needed, whether an MCP client can do it (mcp_can_do, with the tool and arguments) or it needs a human (where: page, step, control). human_only lists what is never callable over MCP. Never returns a secret, credential or protected reference. Read-only.',
    {}),

  tool('get_platform_service',
    'One platform service in detail: owned or external, container names with IDs, image, running state and health (read from the host with docker inspect — no environment is read), expected images/versions and loopback ports, the Caddy route and its upstream, the last verification with its time and whether it is current or only "previously verified", the observer status where one applies, the last job, and the dependencies that would block remove or reinstall (active Keycloak/Pomerium dependents). Read-only.',
    { service, runtime: { type: 'boolean', description: 'false skips the docker inspect on the host (default true).' } }, ['service']),

  tool('list_platform_jobs',
    'Platform operation history, newest first: the Full Platform coordinator, each service adapter, their Caddy route steps and the SSO checks. id, kind, status, phase, reason, who requested it and via which surface. Read-only; get_platform_job returns one job with its redacted event log.',
    { service: { ...service, description: 'Only this service\'s jobs.' }, status: { type: 'string', enum: ['queued', 'running', 'succeeded', 'failed', 'deferred', 'refused', 'recovery_required', 'cancelled'] }, limit: P.limit }),

  tool('get_platform_job',
    'One platform job and the tail of its event log, redacted exactly as the dashboard stores it (and redacted again on the way out): no upstream bodies, tokens, passwords or key material. Refuses a job that is not a platform job. Read-only.',
    { id: { type: 'string', description: 'Job id (get_platform_setup / list_platform_jobs).' }, tail: { type: 'number', description: 'How many of the latest events to include (default 50, max 500).' } }, ['id']),

  tool('platform_preflight',
    'Before apply: does each selected hostname resolve to the Caddy host (compared with what ProxyPilot\'s own administrator hostname resolves to), does another route already serve it, is Docker available on the host, which loopback port each owned service uses and whether something already listens there, and is the installation key present and able to open the saved protected credentials (reported as present/absent only). Read-only.',
    {}),

  tool('save_platform_setup',
    'Save the Full Platform plan — domains, realm, selected services and restricted administrator/VPN networks. Inert, exactly like the dashboard\'s "Save reviewed plan": nothing is installed and no job is queued. Only the fields you pass change; the rest keep their saved (or suggested) values. Refused when if_revision is not the saved revision (another session changed it), while an operation is running, and for input the dashboard refuses — with the dashboard\'s own messages (hostname/realm/ownership migrations, recovery-network changes after apply, a hostname that already serves a route, unrestricted networks). dry_run returns the changes and DNS work without saving. Next: apply_platform_setup with the returned revision and review_digest.',
    {
      if_revision: { type: 'number', description: 'The saved revision you read (0 when nothing is saved).' },
      domains: { type: 'object', description: 'Any of: proxypilot, recovery, keycloak, pomerium, infisical, openbao, vaultwarden — each an https origin (https://host.example.com). proxypilot must stay the current administrator hostname.', additionalProperties: { type: 'string' } },
      realm: { type: 'string', description: 'Keycloak realm name.' },
      services: { type: 'object', description: 'Per service: "install" | "connect" | "skip" (skip needs experience "custom").', additionalProperties: { type: 'string', enum: ['install', 'connect', 'skip'] } },
      restricted_networks: { type: 'array', items: { type: 'string' }, description: 'Approved administrator/VPN IPs or CIDRs for the recovery and service routes. /0 is refused.' },
      experience: { type: 'string', enum: ['full', 'custom'] },
      dry_run: P.dry_run,
    }, ['if_revision']),

  tool('apply_platform_setup',
    'Apply the saved plan: queue the existing host runner, which installs/connects Keycloak, the recovery/SSO checks and the selected services in dependency order, reusing existing managed installations. Refused when revision/review_digest are not the saved plan you reviewed, when the revision is already applied (use continue_platform_setup), while an operation is running, and when no restricted recovery network is saved. Returns the operation job id. Next: get_platform_setup / get_platform_job to follow it.',
    { revision, review_digest: reviewDigest, dry_run: P.dry_run, confirm: P.confirm }, ['revision', 'review_digest', 'confirm']),

  tool('continue_platform_setup',
    'Resume the applied plan after a failure or a finished handoff (the dashboard\'s "Continue saved setup"): re-queues the coordinator, which keeps completed connections and retries pending service work with the saved clients, data and protected credentials. With service set, retries only that service\'s own adapter job (for example the Vaultwarden apply), reusing its stored encrypted inputs — nothing is asked for or regenerated. Refused when revision/review_digest are stale, while an operation is running, when the next step needs a human (the refusal names it and where), and when a retry would fail at a known precondition (for Vaultwarden/OpenBao: the read-only Keycloak observer). Returns the job id.',
    { revision, review_digest: reviewDigest, service: { ...service, description: 'Retry only this service\'s adapter job.' }, dry_run: P.dry_run, confirm: P.confirm }, ['revision', 'review_digest', 'confirm']),

  tool('manage_platform_service',
    'Repair, reinstall or remove the runtime of one OWNED platform service, through the dashboard\'s own review: the first call returns the preview (containers affected, effects, what is retained) and a one-time confirmation_token bound to that exact review; the second call with the token queues it. Remove and reinstall stop/remove only the inspected owned container IDs; volumes, directories, databases, keys, credentials, networks and routes are kept (routes fail closed). External services are refused. Active Keycloak/Pomerium dependents refuse remove/reinstall, as in the dashboard. Behind mcp.destructive.',
    { service, action: { type: 'string', enum: ['repair', 'reinstall', 'remove'] }, dry_run: P.dry_run, confirmation_token: P.confirmation_token }, ['service', 'action']),

  tool('reset_platform_setup',
    'Start Platform Setup over. Default: stop and remove every OWNED container, remove the owned Caddy routes, and discard the saved plan, platform operations and owned service records so step 1 starts clean — data directories, volumes, networks, keys and protected credentials stay in place. purge_data: true also deletes the owned data (directories, volumes, networks, protected credential rows) AFTER writing a backup set into the exports directory and verifying it (tar listing + sha256 manifest); it needs the mcp.platform.purge flag, off by default. The first call returns the preview listing every container, route, DB row (and with purge every path, volume and network) and a one-time confirmation_token bound to that exact inventory; the second call with the token queues the reset on the host runner. Always refused: external services (left untouched), anything without this installation\'s ownership label, active SSO (disable it from local recovery first), active Pomerium application policies, and a running operation. Behind mcp.destructive.',
    { purge_data: { type: 'boolean', description: 'Also delete owned data after a verified backup set (needs mcp.platform.purge).' }, dry_run: P.dry_run, confirmation_token: P.confirmation_token }),
]);
