import * as output from '../output.js';

export const lxcCommands = {
  async create(opts, globalOpts) {
    output.info(`Creating container "${opts.name}"...`);
    // TODO: implement container creation via Incus
    output.warn('LXC create is not yet implemented');
  },

  async list(globalOpts) {
    output.info('Listing containers...');
    // TODO: implement container listing
    output.warn('LXC list is not yet implemented');
  },

  async start(name, globalOpts) {
    output.info(`Starting container "${name}"...`);
    // TODO: implement container start
    output.warn('LXC start is not yet implemented');
  },

  async stop(name, globalOpts) {
    output.info(`Stopping container "${name}"...`);
    // TODO: implement container stop
    output.warn('LXC stop is not yet implemented');
  },

  async restart(name, globalOpts) {
    output.info(`Restarting container "${name}"...`);
    // TODO: implement container restart
    output.warn('LXC restart is not yet implemented');
  },

  async destroy(name, opts, globalOpts) {
    output.info(`Destroying container "${name}"...`);
    // TODO: implement container destroy
    output.warn('LXC destroy is not yet implemented');
  },

  async shell(name, globalOpts) {
    output.info(`Opening shell in container "${name}"...`);
    // TODO: implement shell access
    output.warn('LXC shell is not yet implemented');
  },

  async exec(name, command, globalOpts) {
    output.info(`Executing command in container "${name}"...`);
    // TODO: implement exec
    output.warn('LXC exec is not yet implemented');
  },

  async resize(name, opts, globalOpts) {
    output.info(`Resizing container "${name}"...`);
    // TODO: implement resize
    output.warn('LXC resize is not yet implemented');
  },

  async info(name, globalOpts) {
    output.info(`Fetching info for container "${name}"...`);
    // TODO: implement info
    output.warn('LXC info is not yet implemented');
  },

  async snapshot(name, opts, globalOpts) {
    output.info(`Creating snapshot of container "${name}"...`);
    // TODO: implement snapshot creation
    output.warn('LXC snapshot is not yet implemented');
  },

  async snapshots(name, globalOpts) {
    output.info(`Listing snapshots for container "${name}"...`);
    // TODO: implement snapshot listing
    output.warn('LXC snapshots is not yet implemented');
  },

  async restore(name, opts, globalOpts) {
    output.info(`Restoring container "${name}" from snapshot "${opts.snapshot}"...`);
    // TODO: implement snapshot restore
    output.warn('LXC restore is not yet implemented');
  },

  async snapshotDelete(name, opts, globalOpts) {
    output.info(`Deleting snapshot "${opts.snapshot}" from container "${name}"...`);
    // TODO: implement snapshot deletion
    output.warn('LXC snapshot-delete is not yet implemented');
  },

  async templatesList(globalOpts) {
    output.info('Listing templates...');
    // TODO: implement templates listing
    output.warn('LXC templates list is not yet implemented');
  },

  async templatesCreate(name, opts, globalOpts) {
    output.info(`Creating template "${name}"...`);
    // TODO: implement template creation
    output.warn('LXC templates create is not yet implemented');
  },

  async templatesDelete(name, globalOpts) {
    output.info(`Deleting template "${name}"...`);
    // TODO: implement template deletion
    output.warn('LXC templates delete is not yet implemented');
  },
};
