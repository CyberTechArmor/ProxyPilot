import * as output from '../output.js';

export const healthCommands = {
  async list(globalOpts) {
    output.info('Listing health check status...');
    // TODO: implement health list
    output.warn('Health list is not yet implemented');
  },

  async check(domain, globalOpts) {
    const target = domain || 'all routes';
    output.info(`Running health check on ${target}...`);
    // TODO: implement health check
    output.warn('Health check is not yet implemented');
  },
};
