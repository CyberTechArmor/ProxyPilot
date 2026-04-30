import { readState, writeState } from './state.js';
import { audit } from '../../db/audit.js';

const VALID_SCOPES = ['public', 'lan-only', 'vpn-only', 'localhost-only'];

function nowIso() {
  return new Date().toISOString();
}

function findRule(state, id) {
  const all = [...state.base, ...state.discovered];
  return all.find(r => r.id === id);
}

/**
 * Apply a mutation to a rule by id, write state, and audit. Returns the
 * updated rule. Throws if the id doesn't exist or the mutation is
 * disallowed (e.g. trying to remove a base entry — base is allowlist-only).
 */
function panicGuard(state, action) {
  if (state.panic_close && (action === 'enable' || action === 'set-scope' || action === 'add-manual')) {
    throw new Error('firewall is in panic-close. Run `proxypilot firewall panic-open` first.');
  }
}

function mutate({ id, action, fn, actor }) {
  const state = readState();
  panicGuard(state, action);
  const before = findRule(state, id);
  if (!before) {
    const err = new Error(`no rule with id ${id}`);
    err.code = 'NOT_FOUND';
    throw err;
  }
  const beforeSnapshot = { ...before };
  fn(before, state);
  writeState(state);
  audit({
    subsystem: 'firewall',
    action,
    resource: id,
    actor,
    before: beforeSnapshot,
    after: findRule(state, id),
  });
  return findRule(state, id);
}

export function enable({ id, scope, sourceCidrs, actor }) {
  return mutate({
    id,
    action: 'enable',
    actor,
    fn: (rule) => {
      rule.enabled = true;
      rule.enabled_at = nowIso();
      rule.enabled_by = actor ?? null;
      if (scope) {
        if (!VALID_SCOPES.includes(scope)) {
          throw new Error(`invalid scope: ${scope}`);
        }
        rule.scope = scope;
      }
      if (sourceCidrs && sourceCidrs.length > 0) {
        rule.source_cidrs = sourceCidrs;
      }
    },
  });
}

export function disable({ id, actor }) {
  return mutate({
    id,
    action: 'disable',
    actor,
    fn: (rule) => {
      rule.enabled = false;
      rule.disabled_at = nowIso();
      rule.disabled_by = actor ?? null;
    },
  });
}

export function setScope({ id, scope, sourceCidrs, actor }) {
  if (!VALID_SCOPES.includes(scope)) {
    throw new Error(`invalid scope: ${scope}`);
  }
  return mutate({
    id,
    action: 'set-scope',
    actor,
    fn: (rule) => {
      rule.scope = scope;
      if (sourceCidrs && sourceCidrs.length > 0) {
        rule.source_cidrs = sourceCidrs;
      } else if (sourceCidrs && sourceCidrs.length === 0) {
        delete rule.source_cidrs;
      }
    },
  });
}

/**
 * Operator-curated entry for a listener that can't be auto-discovered
 * (e.g. an outbound SMTP relay that only binds when triggered). Lives
 * in the same `discovered` array as scanned entries but with
 * source: 'manual'.
 */
export function addManual({ port, portEnd, proto, scope, reason, sourceCidrs, actor }) {
  if (!VALID_SCOPES.includes(scope)) throw new Error(`invalid scope: ${scope}`);
  if (proto !== 'tcp' && proto !== 'udp') throw new Error(`invalid proto: ${proto}`);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`invalid port: ${port}`);
  }
  if (portEnd != null) {
    if (!Number.isInteger(portEnd) || portEnd < port || portEnd > 65535) {
      throw new Error(`invalid port range: ${port}-${portEnd}`);
    }
  }
  if (!reason) throw new Error('--reason is required for manual rules');

  const state = readState();
  panicGuard(state, 'add-manual');
  const range = portEnd && portEnd !== port ? `${port}-${portEnd}` : `${port}`;
  const id = `manual-host-operator-${range}-${proto}`;
  if (findRule(state, id)) {
    throw new Error(`a manual rule with id ${id} already exists`);
  }
  const ts = nowIso();
  const rule = {
    id,
    source: 'manual',
    container: null,
    process: null,
    port_start: port,
    port_end: portEnd ?? null,
    proto,
    scope,
    enabled: true,
    reason,
    first_seen: ts,
    last_seen: ts,
    enabled_at: ts,
    enabled_by: actor ?? null,
  };
  if (sourceCidrs && sourceCidrs.length > 0) rule.source_cidrs = sourceCidrs;
  state.discovered.push(rule);
  state.discovered.sort((a, b) => a.id.localeCompare(b.id));
  writeState(state);
  audit({
    subsystem: 'firewall',
    action: 'add-manual',
    resource: id,
    actor,
    after: rule,
  });
  return rule;
}

export function removeManual({ id, actor }) {
  const state = readState();
  const idx = state.discovered.findIndex(r => r.id === id);
  if (idx === -1) {
    const err = new Error(`no discovered rule with id ${id}`);
    err.code = 'NOT_FOUND';
    throw err;
  }
  const rule = state.discovered[idx];
  if (rule.source !== 'manual') {
    throw new Error(`refusing to remove non-manual rule ${id} (source=${rule.source}); use disable instead`);
  }
  state.discovered.splice(idx, 1);
  writeState(state);
  audit({
    subsystem: 'firewall',
    action: 'remove-manual',
    resource: id,
    actor,
    before: rule,
  });
  return rule;
}

/**
 * Filtered listing for the CLI / dashboard.
 *   filter: 'all' | 'enabled' | 'needs-review'
 */
export function list(filter = 'all') {
  const state = readState();
  const all = [
    ...state.base.map(r => ({ ...r, _section: 'base' })),
    ...state.discovered.map(r => ({ ...r, _section: r.source })),
  ];
  switch (filter) {
    case 'enabled':      return all.filter(r => r.enabled);
    case 'needs-review': return all.filter(r => !r.enabled && r.source !== 'base');
    case 'all':
    default:             return all;
  }
}
