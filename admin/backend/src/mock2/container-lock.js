// One exclusive lock per container, shared by every platform operation that
// changes what a guest runs or stores: the deploy (which stops the app, mints
// its secrets and swaps its unit), the project database restore, the container
// snapshot restore, and the secret mint the retry path runs before a deploy.
// The operation that does the work holds the lock for its whole lifetime; the
// request that asked for it does not. The check is server-side, so it covers
// the dashboard, the CLI and MCP alike.
//
// Two ways in. withContainerLock(name, holder, fn) QUEUES behind the current
// holder — a deploy is idempotent, so a queued deploy simply runs after the
// one in flight. { wait: false } REFUSES with ContainerBusyError when the lock
// is held: a destructive restore must not start minutes later, under a state
// its operator never looked at, so it is rejected before making any change.
//
// In-process only: the map lives in this backend's memory and does not
// survive a restart. The restart-safe lock, and the recovery of an app a
// restart left stopped, belong to the setup engine
// (docs/core/setup-engine-requirements.md).

const locks = new Map(); // container → { chain, holder, since, waiting }

export class ContainerBusyError extends Error {
  constructor(container, holder) {
    super(`${holder} is in progress for container ${container}`);
    this.name = 'ContainerBusyError';
    this.code = 'CONTAINER_BUSY';
    this.container = container;
    this.holder = holder;
  }
}

// containerLockHolder(name) → { holder, since, waiting } | null
export function containerLockHolder(name) {
  const l = locks.get(String(name || ''));
  return l ? { holder: l.holder, since: l.since, waiting: l.waiting } : null;
}

// withContainerLock(name, holder, fn, { wait }) → fn's result. `holder` is a
// short label for the operation ('deploy', 'restore_project_db', …) that a
// refused caller is told about.
export async function withContainerLock(name, holder, fn, { wait = true } = {}) {
  const key = String(name || '');
  const label = String(holder || 'operation');
  const current = locks.get(key);
  if (current && !wait) throw new ContainerBusyError(key, current.holder);
  const entry = current || { chain: Promise.resolve(), holder: label, since: Date.now(), waiting: 0 };
  if (current) entry.waiting += 1;
  const run = entry.chain.catch(() => {}).then(async () => {
    if (current) entry.waiting -= 1;
    entry.holder = label;
    entry.since = Date.now();
    return fn();
  });
  entry.chain = run;
  locks.set(key, entry);
  try {
    return await run;
  } finally {
    if (locks.get(key) === entry && entry.chain === run) locks.delete(key);
  }
}
