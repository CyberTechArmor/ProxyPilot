#!/usr/bin/env node

import { Command } from 'commander';

const program = new Command();

program
  .name('proxypilot')
  .description('ProxyPilot CLI - LXC container and infrastructure management')
  .version('1.0.0')
  .option('--json', 'Output in JSON format for machine-readable output');

// ── init command ────────────────────────────────────────────────────────────
import { initCommand } from '../src/commands/init.js';

program
  .command('init')
  .description('Initialize ProxyPilot configuration and database')
  .action(async (opts, cmd) => {
    const globalOpts = cmd.optsWithGlobals();
    await initCommand(globalOpts);
  });

// ── lxc command group ───────────────────────────────────────────────────────
import { lxcCommands } from '../src/commands/lxc.js';

const lxc = program
  .command('lxc')
  .description('LXC container management');

lxc
  .command('create')
  .description('Create a new LXC container')
  .requiredOption('--name <name>', 'Container name')
  .option('--image <image>', 'Base image')
  .option('--template <template>', 'Template to use')
  .option('--profile <profile>', 'Resource profile (small, medium, large)')
  .option('--domain <domain>', 'Domain name for routing')
  .option('--port <port>', 'Application port inside the container', parseInt)
  .option('--path <path>', 'URL path prefix')
  .option('--init-script <script>', 'Path to initialization script')
  .option('--cpu <cores>', 'CPU core limit', parseInt)
  .option('--memory <mb>', 'Memory limit in MB', parseInt)
  .option('--disk <mb>', 'Disk limit in MB', parseInt)
  .action(async (opts, cmd) => {
    const globalOpts = cmd.optsWithGlobals();
    await lxcCommands.create(opts, globalOpts);
  });

lxc
  .command('list')
  .description('List all LXC containers')
  .action(async (opts, cmd) => {
    const globalOpts = cmd.optsWithGlobals();
    await lxcCommands.list(globalOpts);
  });

lxc
  .command('start <name>')
  .description('Start an LXC container')
  .action(async (name, opts, cmd) => {
    const globalOpts = cmd.optsWithGlobals();
    await lxcCommands.start(name, globalOpts);
  });

lxc
  .command('stop <name>')
  .description('Stop an LXC container')
  .action(async (name, opts, cmd) => {
    const globalOpts = cmd.optsWithGlobals();
    await lxcCommands.stop(name, globalOpts);
  });

lxc
  .command('restart <name>')
  .description('Restart an LXC container')
  .action(async (name, opts, cmd) => {
    const globalOpts = cmd.optsWithGlobals();
    await lxcCommands.restart(name, globalOpts);
  });

lxc
  .command('destroy <name>')
  .description('Destroy an LXC container')
  .option('--force', 'Force destroy without confirmation')
  .action(async (name, opts, cmd) => {
    const globalOpts = cmd.optsWithGlobals();
    await lxcCommands.destroy(name, opts, globalOpts);
  });

lxc
  .command('shell <name>')
  .description('Open a shell in an LXC container')
  .action(async (name, opts, cmd) => {
    const globalOpts = cmd.optsWithGlobals();
    await lxcCommands.shell(name, globalOpts);
  });

lxc
  .command('exec <name> [command...]')
  .description('Execute a command in an LXC container')
  .action(async (name, command, opts, cmd) => {
    const globalOpts = cmd.optsWithGlobals();
    await lxcCommands.exec(name, command, globalOpts);
  });

lxc
  .command('resize <name>')
  .description('Resize container resource limits')
  .option('--cpu <cores>', 'CPU core limit', parseInt)
  .option('--memory <mb>', 'Memory limit in MB', parseInt)
  .option('--disk <mb>', 'Disk limit in MB', parseInt)
  .action(async (name, opts, cmd) => {
    const globalOpts = cmd.optsWithGlobals();
    await lxcCommands.resize(name, opts, globalOpts);
  });

lxc
  .command('info <name>')
  .description('Show detailed container information')
  .action(async (name, opts, cmd) => {
    const globalOpts = cmd.optsWithGlobals();
    await lxcCommands.info(name, globalOpts);
  });

lxc
  .command('snapshot <name>')
  .description('Create a snapshot of a container')
  .option('--name <snapshotName>', 'Snapshot name')
  .action(async (name, opts, cmd) => {
    const globalOpts = cmd.optsWithGlobals();
    await lxcCommands.snapshot(name, opts, globalOpts);
  });

lxc
  .command('snapshots <name>')
  .description('List snapshots for a container')
  .action(async (name, opts, cmd) => {
    const globalOpts = cmd.optsWithGlobals();
    await lxcCommands.snapshots(name, globalOpts);
  });

lxc
  .command('restore <name>')
  .description('Restore a container from a snapshot')
  .requiredOption('--snapshot <snapshot>', 'Snapshot name to restore')
  .action(async (name, opts, cmd) => {
    const globalOpts = cmd.optsWithGlobals();
    await lxcCommands.restore(name, opts, globalOpts);
  });

lxc
  .command('snapshot-delete <name>')
  .description('Delete a snapshot')
  .requiredOption('--snapshot <snapshot>', 'Snapshot name to delete')
  .action(async (name, opts, cmd) => {
    const globalOpts = cmd.optsWithGlobals();
    await lxcCommands.snapshotDelete(name, opts, globalOpts);
  });

// ── lxc templates subgroup ──────────────────────────────────────────────────
const templates = lxc
  .command('templates')
  .description('Manage container templates');

templates
  .command('list')
  .description('List available templates')
  .action(async (opts, cmd) => {
    const globalOpts = cmd.optsWithGlobals();
    await lxcCommands.templatesList(globalOpts);
  });

templates
  .command('create <name>')
  .description('Create a new template')
  .option('--from <container>', 'Source container to create template from')
  .option('--description <text>', 'Template description')
  .action(async (name, opts, cmd) => {
    const globalOpts = cmd.optsWithGlobals();
    await lxcCommands.templatesCreate(name, opts, globalOpts);
  });

templates
  .command('delete <name>')
  .description('Delete a template')
  .action(async (name, opts, cmd) => {
    const globalOpts = cmd.optsWithGlobals();
    await lxcCommands.templatesDelete(name, globalOpts);
  });

// ── backup command group ────────────────────────────────────────────────────
import { backupCommands } from '../src/commands/backup.js';

const backup = program
  .command('backup')
  .description('Backup management');

backup
  .command('export <name>')
  .description('Export a container backup')
  .action(async (name, opts, cmd) => {
    const globalOpts = cmd.optsWithGlobals();
    await backupCommands.export(name, globalOpts);
  });

backup
  .command('list')
  .description('List all backups')
  .action(async (opts, cmd) => {
    const globalOpts = cmd.optsWithGlobals();
    await backupCommands.list(globalOpts);
  });

backup
  .command('restore <file>')
  .description('Restore from a backup file')
  .action(async (file, opts, cmd) => {
    const globalOpts = cmd.optsWithGlobals();
    await backupCommands.restore(file, globalOpts);
  });

backup
  .command('schedule')
  .description('Manage backup schedules')
  .action(async (opts, cmd) => {
    const globalOpts = cmd.optsWithGlobals();
    await backupCommands.schedule(globalOpts);
  });

// ── health command group ────────────────────────────────────────────────────
import { healthCommands } from '../src/commands/health.js';

const health = program
  .command('health')
  .description('Health checking');

health
  .command('list')
  .description('List health check status for all routes')
  .action(async (opts, cmd) => {
    const globalOpts = cmd.optsWithGlobals();
    await healthCommands.list(globalOpts);
  });

health
  .command('check [domain]')
  .description('Run a health check')
  .action(async (domain, opts, cmd) => {
    const globalOpts = cmd.optsWithGlobals();
    await healthCommands.check(domain, globalOpts);
  });

// ── status command ──────────────────────────────────────────────────────────
import { statusCommand } from '../src/commands/status.js';

program
  .command('status')
  .description('Show system status overview')
  .action(async (opts, cmd) => {
    const globalOpts = cmd.optsWithGlobals();
    await statusCommand(globalOpts);
  });

// ── stats command ───────────────────────────────────────────────────────────
import { statsCommand } from '../src/commands/stats.js';

program
  .command('stats')
  .description('Show traffic statistics')
  .action(async (opts, cmd) => {
    const globalOpts = cmd.optsWithGlobals();
    await statsCommand(globalOpts);
  });

// ── certs command ───────────────────────────────────────────────────────────
import { certsCommand } from '../src/commands/certs.js';

program
  .command('certs')
  .description('Certificate management')
  .action(async (opts, cmd) => {
    const globalOpts = cmd.optsWithGlobals();
    await certsCommand(globalOpts);
  });

// ── firewall command group ──────────────────────────────────────────────────
import {
  reconcileCommand as firewallReconcileCommand,
  firewallStatusCommand,
  listCommand as firewallListCommand,
  scanCommand as firewallScanCommand,
  enableCommand as firewallEnableCommand,
  disableCommand as firewallDisableCommand,
  setScopeCommand as firewallSetScopeCommand,
  addManualCommand as firewallAddManualCommand,
  removeManualCommand as firewallRemoveManualCommand,
  panicCloseCommand as firewallPanicCloseCommand,
  panicOpenCommand as firewallPanicOpenCommand,
  egressAllowCommand as firewallEgressAllowCommand,
  egressDenyCommand as firewallEgressDenyCommand,
  egressListCommand as firewallEgressListCommand,
  detectBridgeCommand as firewallDetectBridgeCommand,
} from '../src/commands/firewall/index.js';

const firewall = program
  .command('firewall')
  .description('Host firewall management (nftables, default-deny)');

firewall
  .command('detect-bridge')
  .description('Auto-detect the host\'s managed Incus bridge and (with --apply) commit it to firewall.json')
  .option('--apply', 'Write detected values to state.network')
  .option('--force', 'Overwrite a different existing state.network value (with --apply)')
  .action(async (opts, cmd) => {
    const globalOpts = cmd.optsWithGlobals();
    await firewallDetectBridgeCommand(opts, globalOpts);
  });

firewall
  .command('reconcile')
  .description('Apply firewall.json to live nftables')
  .option('--dry-run', 'Render the ruleset without applying')
  .option('--force-lockout-ok', 'Apply even if the lockout-safety check fails')
  .action(async (opts, cmd) => {
    const globalOpts = cmd.optsWithGlobals();
    await firewallReconcileCommand(opts, globalOpts);
  });

firewall
  .command('status')
  .description('Show firewall backend, policy, rule counts, last reconcile')
  .action(async (opts, cmd) => {
    const globalOpts = cmd.optsWithGlobals();
    await firewallStatusCommand(opts, globalOpts);
  });

firewall
  .command('list')
  .description('List firewall rules')
  .option('--all', 'Show all rules')
  .option('--enabled', 'Show only enabled rules')
  .option('--needs-review', 'Show only newly discovered rules awaiting review')
  .action(async (opts, cmd) => {
    const globalOpts = cmd.optsWithGlobals();
    await firewallListCommand(opts, globalOpts);
  });

firewall
  .command('scan')
  .description('Discover host listeners and update firewall state')
  .action(async (opts, cmd) => {
    const globalOpts = cmd.optsWithGlobals();
    await firewallScanCommand(opts, globalOpts);
  });

firewall
  .command('enable <id>')
  .description('Enable a firewall rule and reconcile')
  .option('--scope <scope>', 'Scope: public | lan-only | vpn-only | localhost-only')
  .option('--source-cidr <cidr>', 'Restrict to source CIDR (repeatable)', (v, prev) => [...(prev ?? []), v])
  .option('--yes', 'Skip the public-internet confirmation prompt')
  .action(async (id, opts, cmd) => {
    const globalOpts = cmd.optsWithGlobals();
    await firewallEnableCommand(id, opts, globalOpts);
  });

firewall
  .command('disable <id>')
  .description('Disable a firewall rule and reconcile')
  .action(async (id, opts, cmd) => {
    const globalOpts = cmd.optsWithGlobals();
    await firewallDisableCommand(id, opts, globalOpts);
  });

firewall
  .command('set-scope <id> <scope>')
  .description('Change a rule\'s scope and reconcile')
  .option('--source-cidr <cidr>', 'Pin to source CIDR (repeatable; clears existing if omitted)', (v, prev) => [...(prev ?? []), v])
  .action(async (id, scope, opts, cmd) => {
    const globalOpts = cmd.optsWithGlobals();
    await firewallSetScopeCommand(id, scope, opts, globalOpts);
  });

firewall
  .command('add-manual')
  .description('Add an operator-curated firewall rule for a non-discoverable listener')
  .requiredOption('--port <p>', 'Port number (or range start when --port-end is set)', parseInt)
  .option('--port-end <p>', 'End of port range (inclusive)', parseInt)
  .requiredOption('--proto <tcp|udp>', 'Protocol')
  .requiredOption('--scope <scope>', 'Scope: public | lan-only | vpn-only | localhost-only')
  .requiredOption('--reason <text>', 'Why this port is open')
  .option('--source-cidr <cidr>', 'Restrict to source CIDR (repeatable)', (v, prev) => [...(prev ?? []), v])
  .action(async (opts, cmd) => {
    const globalOpts = cmd.optsWithGlobals();
    await firewallAddManualCommand(opts, globalOpts);
  });

firewall
  .command('remove-manual <id>')
  .description('Remove an operator-curated firewall rule')
  .action(async (id, opts, cmd) => {
    const globalOpts = cmd.optsWithGlobals();
    await firewallRemoveManualCommand(id, opts, globalOpts);
  });

firewall
  .command('panic-close')
  .description('Drop all discovered rules, reduce base allowlist to SSH (+ WireGuard if on)')
  .option('--yes', 'Skip the confirmation prompt')
  .action(async (opts, cmd) => {
    const globalOpts = cmd.optsWithGlobals();
    await firewallPanicCloseCommand(opts, globalOpts);
  });

firewall
  .command('panic-open')
  .description('Clear the panic-close flag (does NOT auto-restore previously enabled rules)')
  .action(async (opts, cmd) => {
    const globalOpts = cmd.optsWithGlobals();
    await firewallPanicOpenCommand(opts, globalOpts);
  });

const egress = firewall
  .command('egress')
  .description('Per-container egress allow rules (LXC bridge → host services)');

egress
  .command('list')
  .description('List container-egress entries')
  .action(async (opts, cmd) => {
    const globalOpts = cmd.optsWithGlobals();
    await firewallEgressListCommand(opts, globalOpts);
  });

egress
  .command('allow <container> <service>')
  .description('Allow <container> to reach the named host-side <service> (e.g. pgbouncer)')
  .option('--reason <text>', 'Why the access is granted')
  .option('--container-ip <ip>', 'Pin the rule to this container IP (defaults to the whole bridge CIDR)')
  .action(async (container, service, opts, cmd) => {
    const globalOpts = cmd.optsWithGlobals();
    await firewallEgressAllowCommand(container, service, opts, globalOpts);
  });

egress
  .command('deny <container> <service>')
  .description('Revoke a previously granted egress allow rule')
  .action(async (container, service, opts, cmd) => {
    const globalOpts = cmd.optsWithGlobals();
    await firewallEgressDenyCommand(container, service, opts, globalOpts);
  });

// ── vpn command group ───────────────────────────────────────────────────────
import {
  enableCommand as vpnEnableCommand,
  disableCommand as vpnDisableCommand,
  peerAddCommand as vpnPeerAddCommand,
  peerRotateCommand as vpnPeerRotateCommand,
  peerEnableCommand as vpnPeerEnableCommand,
  peerDisableCommand as vpnPeerDisableCommand,
  peerRemoveCommand as vpnPeerRemoveCommand,
  peerSetScopeCommand as vpnPeerSetScopeCommand,
  peerListCommand as vpnPeerListCommand,
  peerShowCommand as vpnPeerShowCommand,
} from '../src/commands/vpn/index.js';

const vpn = program
  .command('vpn')
  .description('WireGuard VPN management (composes with firewall manager)');

vpn
  .command('enable')
  .description('Bring up wg0 and open 51820/udp via the firewall manager')
  .requiredOption('--endpoint <host:port>', 'Public endpoint peers will dial (e.g. vpn.example.com:51820)')
  .option('--port <p>', 'WireGuard listen port (default 51820)')
  .option('--dns <ip>', 'DNS pushed to peers (default 10.100.0.1)')
  .action(async (opts, cmd) => {
    const globalOpts = cmd.optsWithGlobals();
    await vpnEnableCommand(opts, globalOpts);
  });

vpn
  .command('disable')
  .description('Take wg0 down and close 51820/udp; peer records are preserved')
  .action(async (opts, cmd) => {
    const globalOpts = cmd.optsWithGlobals();
    await vpnDisableCommand(opts, globalOpts);
  });

const vpnPeer = vpn
  .command('peer')
  .description('Per-peer lifecycle: add, rotate, enable, disable, remove, list, show');

vpnPeer
  .command('add <name>')
  .description('Generate a fresh keypair, allocate a /32, render config + QR')
  .option('--scope <scope>', 'full | admin | services (default admin)')
  .option('--services <list>', 'Comma-separated service list (only with --scope services)')
  .action(async (name, opts, cmd) => {
    const globalOpts = cmd.optsWithGlobals();
    await vpnPeerAddCommand(name, opts, globalOpts);
  });

vpnPeer
  .command('rotate <name>')
  .description('Issue a new keypair for an existing peer (old key invalidated immediately)')
  .action(async (name, opts, cmd) => {
    const globalOpts = cmd.optsWithGlobals();
    await vpnPeerRotateCommand(name, opts, globalOpts);
  });

vpnPeer
  .command('enable <name>')
  .description('Re-add a previously-disabled peer (same key, same IP)')
  .action(async (name, opts, cmd) => {
    const globalOpts = cmd.optsWithGlobals();
    await vpnPeerEnableCommand(name, opts, globalOpts);
  });

vpnPeer
  .command('disable <name>')
  .description('Drop a peer from wg0 without losing its record')
  .option('--force', 'Override the only-enabled-peer lockout guard (typed confirmation required)')
  .action(async (name, opts, cmd) => {
    const globalOpts = cmd.optsWithGlobals();
    await vpnPeerDisableCommand(name, opts, globalOpts);
  });

vpnPeer
  .command('remove <name>')
  .description('Hard-delete a peer record and return its IP to the pool')
  .option('--force', 'Override the only-enabled-peer / recently-active guards (typed confirmation required)')
  .action(async (name, opts, cmd) => {
    const globalOpts = cmd.optsWithGlobals();
    await vpnPeerRemoveCommand(name, opts, globalOpts);
  });

vpnPeer
  .command('set-scope <name> <scope>')
  .description('Update peer scope (full | admin | services [--services <list>]) and reconcile the firewall')
  .option('--services <list>', 'Comma-separated service tags (only with scope=services)')
  .option('--force', 'Override the last-full|admin demote lockout guard (typed confirmation required)')
  .action(async (name, scope, opts, cmd) => {
    const globalOpts = cmd.optsWithGlobals();
    await vpnPeerSetScopeCommand(name, scope, opts, globalOpts);
  });

vpnPeer
  .command('list')
  .description('List all peers with live wg show data joined in')
  .action(async (opts, cmd) => {
    const globalOpts = cmd.optsWithGlobals();
    await vpnPeerListCommand(opts, globalOpts);
  });

vpnPeer
  .command('show <name>')
  .description('Show peer status (refuses to reprint config — pass --rotate-first to issue a new key)')
  .option('--rotate-first', 'Generate a new keypair and print the new client config + QR')
  .action(async (name, opts, cmd) => {
    const globalOpts = cmd.optsWithGlobals();
    await vpnPeerShowCommand(name, opts, globalOpts);
  });

// ── parse and execute ───────────────────────────────────────────────────────
program.parseAsync(process.argv);
