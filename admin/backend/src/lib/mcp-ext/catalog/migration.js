// The migration family: adopt a running web application from another
// server, VM or container onto a ProxyPilot guest. Six tools cover the whole
// arc — mint the command, read the inventory, approve the copy, work the
// cutover checklist, and cancel.

import { P, tool } from './shared.js';

const id = { type: 'number', description: 'Migration id (list_migrations).' };

export const MIGRATION_TOOLS = Object.freeze([
  tool('create_migration',
    'Start a migration and return the ONE-LINE command the operator pastes on the SOURCE host (as root). Two modes: "whole-machine" wraps the official incus-migrate to stream a physical host, a VM (any hypervisor, including Proxmox) or an LXC into Incus — a Proxmox LXC, where incus-migrate cannot run inside the guest, takes the rootfs-tar path automatically; "application" leaves the source running and streams the application directories into a fresh guest (tarballs through ProxyPilot and `incus exec`, so no sshd or key is added to the guest), dumping and restoring the database logically. Nothing is copied until the inventory arrives and approve_migration is called. The token is single-use, scoped to this migration, expiring, and the agent pins TLS to this ProxyPilot\'s certificate.',
    {
      mode: { type: 'string', enum: ['whole-machine', 'application'], description: 'whole-machine moves the machine; application adopts the app into a new guest.' },
      name: { type: 'string', description: 'Guest name without the pp- prefix.' },
      type: { type: 'string', enum: ['container', 'virtual-machine'], description: 'What to create in Incus (default container).' },
      transport: { type: 'string', enum: ['incus-migrate', 'rootfs-tar', 'file-sync'], description: 'Usually omitted: it is derived from the mode and the source kind.' },
      source_kind: { type: 'string', description: 'physical | vm | lxc | proxmox-lxc | docker, when you already know it (the agent reports it either way).' },
      source_label: { type: 'string', description: 'How the operator refers to this source, e.g. "old-web01 at Hetzner".' },
      cpu: { type: 'number', description: 'vCPUs for the new guest (default 2).' },
      memory_gb: { type: 'number', description: 'Memory for the new guest (default 4).' },
      disk_gb: { type: 'number', description: 'Disk for the new guest. Required for a virtual-machine.' },
      pool: { type: 'string', description: 'Incus storage pool (default: the profile\'s).' },
      network: { type: 'string', description: 'Incus network / bridge (default: the profile\'s).' },
      nested: { type: 'boolean', description: 'security.nesting — set it when the source runs docker/compose, so the stack keeps working inside the guest.' },
      image: { type: 'string', description: 'Application mode: the base image for the new guest (default images:debian/13).' },
      app_dirs: { type: 'array', items: { type: 'string' }, description: 'Application mode: absolute directories to copy. Omit and the agent proposes them from the inventory.' },
      excludes: { type: 'array', items: { type: 'string' }, description: 'Extra excludes on top of the default set (.git, node_modules, caches, logs …).' },
      database: { type: 'string', enum: ['none', 'postgres', 'mysql', 'sqlite'], description: 'Application mode: what to dump and restore into the guest.' },
      service_name: { type: 'string', description: 'The systemd unit that runs the app on the source (used by the freeze step).' },
      freeze: { type: 'string', enum: ['stop', 'read-only', 'none'], description: 'What the cutover does to the source service (default stop).' },
      auto_transfer: { type: 'boolean', description: 'Skip the inventory review and start copying as soon as the manifest lands. Default false, and false is the right answer for production.' },
      keep_agent: { type: 'boolean', description: 'Leave the agent binary on the source afterwards (default false — it removes itself).' },
      ttl_seconds: { type: 'number', description: 'Optional wall-clock lifetime for the token, 300–2592000. Omitted (the default) the token has NO clock: it lives until the migration ends or someone revokes it.' },
      dry_run: P.dry_run, confirm: P.confirm,
    }, ['mode', 'name', 'confirm']),

  tool('get_migration',
    'One migration in full: phase and status, bytes/rate/ETA (measured over the last minute, so a stall reads as a stall), the source inventory manifest — OS, disks and mounts, systemd units and their listening ports, web-server vhosts with upstreams, docker/compose, databases, cron, TLS material locations, .env files by path with KEY NAMES ONLY, and the outbound hosts observed — plus the derived route suggestions, the observed-egress decisions, the concerns, the cutover checklist and the agent event log.',
    { id, events: { type: 'number', description: 'How many recent event lines to include (default 50, max 500).' }, manifest: { type: 'boolean', description: 'false omits the full manifest and returns only the summary.' } }, ['id']),

  tool('list_migrations', 'Every migration, newest first: mode, transport, status, phase, target guest, transfer progress and checklist progress.',
    { status: { type: 'string', enum: ['created', 'running', 'awaiting_review', 'ready', 'completed', 'failed', 'cancelled'] }, limit: P.limit }),

  tool('migration_preflight',
    'Can this ProxyPilot take a migration, and which transports are available? Every check with its status and remedy: the cross-built agents and their hashes, the public URL a source will be told to call, the TLS certificate agents pin, and whether Incus listens on the network (which only incus-migrate needs — a container source goes through ProxyPilot). Read-only.', {}),

  tool('enable_incus_listener',
    'Make the Incus API listen on the network, which is what a whole-machine migration of a physical host or a VM needs: incus-migrate connects to Incus DIRECTLY from the source. The default address is the Incus bridge gateway — reachable by guests and by your LAN, not from the internet. A bind on every interface (":8443") is refused unless allow_public is set, because that is a public port on a public host.',
    { address: { type: 'string', description: 'host:port. Default: the bridge gateway on 8443.' }, allow_public: { type: 'boolean', description: 'Required to bind every interface.' }, dry_run: P.dry_run, confirm: P.confirm }, ['confirm']),

  tool('approve_migration',
    'Approve the transfer after a human has read the inventory. THIS is the gate that lets bytes leave the source. In application mode it also creates the target guest — stopped where it can be, with the default-deny egress fence up and no route. A blocking concern refuses the approval unless override_blocking is set.',
    { id, override_blocking: { type: 'boolean', description: 'Approve despite a blocking concern. Only after reading it.' }, dry_run: P.dry_run, confirm: P.confirm }, ['id', 'confirm']),

  tool('migration_cutover',
    'The post-import work, recorded with who and when. action "step" marks a checklist step done (or reopens it): snapshot_pre_cutover, inventory_reviewed, route_created, egress_reviewed, secrets_entered, health_check, final_delta_sync (application mode), dns_switched, source_frozen, verified, snapshot_post_cutover — the migration is complete when every required step is marked. action "egress" decides one observed outbound host: ProxyPilot\'s guest fence governs bridge → HOST services, so an approval writes a real allow when the destination is one of those and is otherwise recorded as reviewed (`applied: false`) rather than claiming a fence that does not cover the internet; deny records the refusal. The steps themselves are done with the ordinary tools (snapshot_lxc_container, set_route, set_lxc_egress, set_project_env, probe_lxc_port, set_dns_record, test_route); this tool records that they were.',
    {
      id,
      action: { type: 'string', enum: ['step', 'egress'], description: 'Default "step".' },
      step: { type: 'string', description: 'Checklist step id (action "step").' },
      done: { type: 'boolean', description: 'false reopens a step you marked by mistake.' },
      note: { type: 'string', description: 'What was actually done — it is stored with the step.' },
      host: { type: 'string', description: 'Outbound host (action "egress").' },
      port: { type: 'number', description: 'Outbound port (action "egress").' },
      decision: { type: 'string', enum: ['approve', 'deny'], description: 'action "egress": approve applies the allow to the guest.' },
      dry_run: P.dry_run,
    }, ['id']),

  tool('cancel_migration',
    'Stop a migration and kill its token immediately. A guest that was already created is left exactly as it is — cancelling never deletes data, and the Incus trust token minted for the transfer is revoked.',
    { id, reason: { type: 'string' }, dry_run: P.dry_run, confirm: P.confirm }, ['id', 'confirm']),

  tool('list_migration_tokens',
    'Every agent token and what it is doing — the answer to "what is still out there". One token per migration, for its whole life: `unclaimed` (minted, never used — the one still on somebody\'s clipboard), `active` (claimed by the agent run doing the migration), `spent` (the migration finished, so it is dead), `revoked`, `expired` (only when a ttl_seconds was asked for). Shows when it was claimed, from which address, and when it was last seen. Never returns a secret — only the token id.',
    { state: { type: 'string', enum: ['unclaimed', 'active', 'spent', 'revoked', 'expired'], description: 'Only tokens in this state.' }, limit: P.limit }),

  tool('revoke_migration_token',
    'Kill one migration\'s agent token now. Every later call presenting it is refused, whatever state the migration is in — this is the undo for a command that was pasted somewhere it should not have been. The migration itself is untouched: cancel_migration as well if the run should stop.',
    { id, dry_run: P.dry_run, confirm: P.confirm }, ['id', 'confirm']),

  tool('cleanup_migration',
    'Throw away what a FINISHED migration left behind: the guest it created (delete_guest), the migration record and its event log (remove_record), or both. Deliberately narrow — it refuses a migration that is still running (cancel it first), a guest that this migration did not create but adopted, and a guest that is serving a route (use delete_lxc_container, which unpublishes as it goes). A running guest is stopped cleanly first; force stops it hard. No export is taken unless export is set, because a migration guest that failed never ran. Nothing here can be undone.',
    {
      id,
      delete_guest: { type: 'boolean', description: 'Delete the Incus guest this migration created.' },
      remove_record: { type: 'boolean', description: 'Delete the migration row and its event log.' },
      export: { type: 'boolean', description: 'Export the guest to a tarball before deleting it.' },
      force: { type: 'boolean', description: 'Stop the guest hard if it will not stop cleanly.' },
      dry_run: P.dry_run, confirm: P.confirm,
    }, ['id', 'confirm']),
]);
