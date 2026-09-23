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
    'Platform Setup (Full Platform) as the dashboard sees it, plus what to do next. One path: all five services installed and managed as one system, in stages A (domains, realm, networks → review), B (Keycloak, permanent administrator, passkey, account link, SSO/step-up/recovery checks, bootstrap retired), C (Pomerium), D (Infisical, OpenBao, Vaultwarden), E (verify everything → activate SSO). Returns the saved revision, its fingerprint and review_digest, domains, realm, vpn_networks (derived from the VPN configuration, not editable), additional_networks (the operator\'s extra addresses) and restricted_networks (their union, applied to recovery and every restricted route), current_stage and stages (each done / current / running / failed / locked with the reason; a failed stage names the failing service), the current operation and every service job, and for anything failed the job, its reason_code (the phase it failed at) and plain reason. The read-only Keycloak observer the Vaultwarden/OpenBao adapters need is reported with what creates it. next_actions lists ONLY the current stage, ordered: each entry says what is needed, whether an MCP client can do it (mcp_can_do, with the tool and arguments) or it needs a human (where: page, step, control). human_only lists what is never callable over MCP. Never returns a secret, credential or protected reference. Read-only.',
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
    'Before apply (optionally for one service): does each selected hostname resolve to the Caddy host — from this host\'s resolver AND from the public resolver 1.1.1.1, with any disagreement named and whether the zone is on the stored Cloudflare token (else the exact record to set at the external DNS host) — does another route already serve it, is Docker available on the host, which loopback port each owned service uses and whether something already listens there, and is the installation key present and able to open the saved protected credentials (reported as present/absent only). Read-only.',
    {}),

  tool('save_platform_setup',
    'Save the Full Platform plan (stage A) — domains, realm and additional administrator addresses. All five services are always installed; the VPN networks are included automatically. Inert, exactly like the dashboard\'s "Save reviewed plan": nothing is installed and no job is queued. Only the fields you pass change; the rest keep their saved (or suggested) values. Refused when if_revision is not the saved revision (another session changed it), while an operation is running, and for input the dashboard refuses — with the dashboard\'s own messages (hostname/realm/ownership migrations, additional-address changes after apply — use set_platform_restricted_networks, a hostname that already serves a route, unrestricted networks). dry_run returns the changes and DNS work without saving. Next: apply_platform_setup with the returned revision and review_digest.',
    {
      if_revision: { type: 'number', description: 'The saved revision you read (0 when nothing is saved).' },
      domains: { type: 'object', description: 'Any of: proxypilot, recovery, keycloak, pomerium, infisical, openbao, vaultwarden — each an https origin (https://host.example.com). proxypilot must stay the current administrator hostname.', additionalProperties: { type: 'string' } },
      realm: { type: 'string', description: 'Keycloak realm name.' },
      additional_networks: { type: 'array', items: { type: 'string' }, description: 'Extra administrator IPs or CIDRs, added to the built-in VPN networks for recovery and every restricted route. /0 is refused; may be empty when the VPN is enabled.' },
      dry_run: P.dry_run,
    }, ['if_revision']),

  tool('apply_platform_setup',
    'Apply the saved plan (completes stage A): queue the host runner for stage B ONLY — Keycloak, the managed identity, the SSO record and the recovery route, reusing an existing managed installation. Nothing else is installed until stage B is verified. Refused when revision/review_digest are not the saved plan you reviewed, when the revision is already applied (use continue_platform_setup), while an operation is running, and when no restricted network is available (VPN disabled and no additional address). Returns the operation job id. Next: get_platform_setup / get_platform_job to follow it.',
    { revision, review_digest: reviewDigest, dry_run: P.dry_run, confirm: P.confirm }, ['revision', 'review_digest', 'confirm']),

  tool('continue_platform_setup',
    'Advance the applied plan ONE stage at a time (the dashboard\'s "Continue" on the current stage card): re-queues the coordinator for the current stage only (C: Pomerium; D: Infisical, OpenBao, Vaultwarden), keeping completed connections and retrying pending work with the saved clients, data and protected credentials; when that stage is verified the job ends and the next continue starts the next stage. A later stage is never queued early. With service set, retries only that service\'s own adapter job (refused for a service in a later, locked stage) (for example the Vaultwarden apply), reusing its stored encrypted inputs — nothing is asked for or regenerated. Refused when revision/review_digest are stale, while an operation is running, when the next step needs a human (the refusal names it and where), in stage E (activating SSO is a human dashboard action), and when a retry would fail at a known precondition (for Vaultwarden/OpenBao: the read-only Keycloak observer). Returns the job id.',
    { revision, review_digest: reviewDigest, service: { ...service, description: 'Retry only this service\'s adapter job.' }, dry_run: P.dry_run, confirm: P.confirm }, ['revision', 'review_digest', 'confirm']),

  tool('manage_platform_service',
    'Repair, reinstall or remove the runtime of one OWNED platform service, through the dashboard\'s own review: the first call returns the preview (containers affected, effects, what is retained) and a one-time confirmation_token bound to that exact review; the second call with the token queues it. Remove and reinstall stop/remove only the inspected owned container IDs; volumes, directories, databases, keys, credentials, networks and routes are kept (routes fail closed). External services are refused. Active Keycloak/Pomerium dependents refuse remove/reinstall, as in the dashboard. Behind mcp.destructive.',
    { service, action: { type: 'string', enum: ['repair', 'reinstall', 'remove'] }, dry_run: P.dry_run, confirmation_token: P.confirmation_token }, ['service', 'action']),

  tool('control_platform_container',
    'Start, stop or restart ONE owned platform container (get_platform_service lists them), by its inspected immutable ID after its ownership label is checked. start waits until the container is running and, when its image has a HEALTHCHECK, healthy (bounded), and reports a reason code when it does not come up. The first call returns a short preview (the inspected container ID, what stops, the expected downtime) and a one-time confirmation_token bound to that container ID; the second call with the token acts. stop and restart are refused while that service has active dependents (Keycloak: ProxyPilot SSO/recovery and the services connected to it; Pomerium: saved application policies), while an operation is running, and for an external service. Behind mcp.destructive.',
    { service, container: { type: 'string', description: 'Container name exactly as get_platform_service lists it.' }, action: { type: 'string', enum: ['start', 'stop', 'restart'] }, dry_run: P.dry_run, confirmation_token: P.confirmation_token }, ['service', 'container', 'action']),

  tool('verify_platform_service',
    'Re-run verification only, without reapplying anything: inspect the owned containers (running, health, exit code, State.Error), check that the route\'s loopback upstream port is listening, check DNS from the host and from 1.1.1.1 against the Caddy host, and probe the route through this host\'s own Caddy with SNI/Host pinned to the service hostname (the adapter self-check path). Records the result and its time as the service\'s last live check. Changes no container, route or record of the service. Read-only as far as the service is concerned; not behind mcp.destructive.',
    { service }, ['service']),

  tool('get_platform_service_logs',
    'The last 50 (or 200) log lines of each owned container of one service, redacted (and scrubbed of this installation\'s protected values). Uses docker logs for the local driver and journalctl CONTAINER_NAME=… for journald; when a container\'s logs cannot be read (for example log driver "none" on a container created before the readable-log fix) it says why and that Repair recreates it with the readable driver. Read-only.',
    { service, lines: { type: 'number', enum: [50, 200], description: 'Lines per container (default 50).' }, container: { type: 'string', description: 'Only this container.' } }, ['service']),

  tool('set_platform_restricted_networks',
    'Change the ADDITIONAL administrator addresses at any time after apply, including after SSO is active — a reviewed change. The effective allowlist is the built-in VPN networks (derived from the VPN configuration, always present, not editable) plus these. The first call returns the preview: the VPN networks, additional before → after, every route whose allowlist changes and every record that carries the list, plus a one-time confirmation_token bound to it; the second call with the token queues the backend route step, which rewrites exactly those rows and re-renders the hostnames (live when it finishes; validated before Caddy reloads). SSO verification and activation are unaffected (the networks are not part of the SSO fingerprint). /0 and an empty effective list are refused. Refused while an operation is running. Behind mcp.destructive.',
    { additional_networks: { type: 'array', items: { type: 'string' }, description: 'The complete new list of additional administrator IPs or CIDRs (may be empty when the VPN is enabled).' }, dry_run: P.dry_run, confirmation_token: P.confirmation_token }, ['additional_networks']),

  tool('resync_platform_plan',
    'When the shared service plan changed after this Full Platform revision recorded it (reason code shared_plan_changed): create a new Full Platform revision from the saved values, so the next continue writes the shared plan again. Nothing else changes and nothing is queued. Refused when the shared plan is already in sync or an operation is running. dry_run previews. Behind mcp.destructive.',
    { revision, dry_run: P.dry_run, confirm: P.confirm }, ['revision']),

  tool('recover_keycloak_bootstrap',
    'Keycloak only: when connect_managed_identity recorded that the bootstrap administrator can no longer authenticate, recover it without a purge. Runs Keycloak 26\'s kc.sh bootstrap-admin inside the OWNED Keycloak server container to create a new temporary master-realm administrator; ProxyPilot generates the credential, stores it encrypted before use, passes it to the container only through a private env file removed right after, verifies it with a real token grant, and then continues the saved setup in the same job. No credential is accepted from or returned to the caller. The first call returns the preview and a one-time confirmation_token; the second queues it. Behind mcp.destructive.',
    { dry_run: P.dry_run, confirmation_token: P.confirmation_token }),

  tool('reset_platform_setup',
    'Start Platform Setup over. Default: stop and remove every OWNED container, remove the owned Caddy routes, and discard the saved plan, platform operations and owned service records so step 1 starts clean — data directories, volumes, networks, keys and protected credentials stay in place. purge_data: true also deletes the owned data (directories, volumes, networks, protected credential rows) AFTER writing a backup set into the exports directory and verifying it (tar listing + sha256 manifest); it needs the mcp.platform.purge flag, off by default. The first call returns the preview listing every container, route, DB row (and with purge every path, volume and network) and a one-time confirmation_token bound to that exact inventory; the second call with the token queues the reset on the host runner. Always refused: external services (left untouched), anything without this installation\'s ownership label, active SSO (disable it from local recovery first), active Pomerium application policies, and a running operation. Behind mcp.destructive.',
    { purge_data: { type: 'boolean', description: 'Also delete owned data after a verified backup set (needs mcp.platform.purge).' }, dry_run: P.dry_run, confirmation_token: P.confirmation_token }),
]);
