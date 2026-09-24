// Pure argv construction. No user input is ever parsed as shell source.
export function composeOperation(body, { allowDestroy = false } = {}) {
  const { action, path, serviceName, options = {} } = body || {};
  const actions = { up: ['up', '-d'], start: ['up', '-d'], down: ['down'],
    restart: ['restart'], pull: ['pull'], logs: ['logs', '--tail=100'],
    ps: ['ps'], stop: ['stop'], destroy: ['down'] };
  if (!Object.hasOwn(actions, action)) throw new Error('Invalid Compose action');
  if (action === 'destroy' && !allowDestroy) throw new Error('Use the confirmed Compose destroy endpoint');
  if (typeof path !== 'string' || !path.startsWith('/') || path.length > 4096 ||
      /[\x00-\x1f\x7f]/.test(path) || path.split('/').includes('..') ||
      !/\.(ya?ml)$/.test(path)) throw new Error('An absolute Compose YAML path is required');
  if (serviceName != null && (typeof serviceName !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(serviceName)))
    throw new Error('Invalid Compose service name');
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new Error('Invalid Compose options');
  const args = ['-f', path, ...actions[action]];
  if (action === 'destroy') {
    if (options.removeVolumes === true) args.push('-v');
    if (options.removeImages === true) args.push('--rmi', 'all');
    if (options.removeOrphans === true) args.push('--remove-orphans');
    if (options.prune) throw new Error('Host-wide prune is not a project destroy operation');
  }
  if (serviceName && ['up', 'start', 'stop', 'restart', 'logs'].includes(action)) args.push(serviceName);
  return args;
}
