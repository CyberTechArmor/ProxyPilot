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
} from '../src/commands/firewall/index.js';

const firewall = program
  .command('firewall')
  .description('Host firewall management (nftables, default-deny)');

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
  .requiredOption('--port <p>', 'Port number', parseInt)
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

// ── parse and execute ───────────────────────────────────────────────────────
program.parseAsync(process.argv);
