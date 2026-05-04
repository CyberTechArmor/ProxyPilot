import { readState, writeState } from './state.js';
import { audit } from '../../db/audit.js';

const VALID_SCOPES = ['public', 'lan-only', 'vpn-only', 'localhost-only'];
// Tight regex for the optional service tag — matches the peer-side
// validation in cli/src/core/vpn/peer.js so a tag operators bind to a
// peer's scope_services_json must satisfy the same shape as the rule
// it joins against. Keep them in lockstep.
const SERVICE_TAG_RE = /^[A-Za-z0-9_.-]{1,64}$/;

/**
 * Validate the optional service tag and apply it to the rule. Returns
 * a `warnings` array so the CLI surface can warn (not error) when the
 * tag is set on a non-vpn-only rule — the spec says the tag is only
 * meaningful on vpn-only but allowing it elsewhere keeps the schema
 * uniform and lets the operator preset a tag before flipping the
 * scope.
 */
function applyServiceTag(rule, service) {
  if (service === undefined || service === null) return [];
  if (service === '') {
    // Explicit empty-string clears the tag.
    delete rule.service;
    return [];
  }
  if (!SERVICE_TAG_RE.test(service)) {
    throw new Error(`invalid service tag "${service}": must match ${SERVICE_TAG_RE}`);
  }
  rule.service = service;
  if (rule.scope !== 'vpn-only') {
    return [
      `service tag "${service}" set on rule ${rule.id} which has scope=${rule.scope}; ` +
      `tag is only consulted when the rule's scope is vpn-only`,
    ];
  }
  return [];
}

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
  // The mutator can return a list of human-readable warnings (e.g.
  // "service tag set on a non-vpn-only rule"). They surface to the
  // operator via the CLI but are not persisted to firewall.json, so
  // we attach them as a non-enumerable property — JSON.stringify
  // skips them, the CLI reads them directly.
  const warnings = fn(before, state) ?? [];
  writeState(state);
  audit({
    subsystem: 'firewall',
    action,
    resource: id,
    actor,
    before: beforeSnapshot,
    after: findRule(state, id),
  });
  const result = findRule(state, id);
  Object.defineProperty(result, '_warnings', { value: warnings, enumerable: false });
  return result;
}

export function enable({ id, scope, sourceCidrs, service, actor }) {
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
      return applyServiceTag(rule, service);
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

export function setScope({ id, scope, sourceCidrs, service, actor }) {
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
      return applyServiceTag(rule, service);
    },
  });
}

/**
 * Operator-curated entry for a listener that can't be auto-discovered
 * (e.g. an outbound SMTP relay that only binds when triggered). Lives
 * in the same `discovered` array as scanned entries but with
 * source: 'manual'.
 */
export function addManual({ port, portEnd, proto, scope, reason, sourceCidrs, service, actor }) {
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
  const warnings = applyServiceTag(rule, service);
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
  Object.defineProperty(rule, '_warnings', { value: warnings, enumerable: false });
  return rule;
}

/**
 * Add a machine-managed L4 forward firewall rule. Functionally
 * identical to addManual() except:
 *   - source = 'service-l4' (so cleanup can target by source rather
 *     than by guessing from the id pattern)
 *   - id is operator-supplied (the admin reconciler computes
 *     `service-l4-<forward_id>` so add and remove are both
 *     deterministic without an extra round trip)
 *   - id is required to start with `service-l4-` so this entry point
 *     can't be used to overwrite arbitrary rule rows
 *   - default scope when none is given is 'public' — L4 forwards on
 *     the host edge are by definition publicly reachable; the
 *     reconciler can still set 'vpn-only' / 'lan-only' explicitly
 *     to restrict reach
 *
 * The reason field stays required for audit-trail symmetry with
 * addManual.
 */
export function addServiceL4({ id, port, portEnd, proto, scope, reason, sourceCidrs, service, actor }) {
  if (typeof id !== 'string' || !id.startsWith('service-l4-')) {
    throw new Error(`addServiceL4: id must start with 'service-l4-' (got ${id})`);
  }
  const effScope = scope ?? 'public';
  if (!VALID_SCOPES.includes(effScope)) throw new Error(`invalid scope: ${effScope}`);
  if (proto !== 'tcp' && proto !== 'udp') throw new Error(`invalid proto: ${proto}`);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`invalid port: ${port}`);
  }
  if (portEnd != null) {
    if (!Number.isInteger(portEnd) || portEnd < port || portEnd > 65535) {
      throw new Error(`invalid port range: ${port}-${portEnd}`);
    }
  }
  if (!reason) throw new Error('--reason is required for service-l4 rules');

  const state = readState();
  panicGuard(state, 'add-service-l4');
  if (findRule(state, id)) {
    throw new Error(`a rule with id ${id} already exists`);
  }
  const ts = nowIso();
  const rule = {
    id,
    source: 'service-l4',
    container: null,
    process: null,
    port_start: port,
    port_end: portEnd ?? null,
    proto,
    scope: effScope,
    enabled: true,
    reason,
    first_seen: ts,
    last_seen: ts,
    enabled_at: ts,
    enabled_by: actor ?? null,
  };
  if (sourceCidrs && sourceCidrs.length > 0) rule.source_cidrs = sourceCidrs;
  const warnings = applyServiceTag(rule, service);
  state.discovered.push(rule);
  state.discovered.sort((a, b) => a.id.localeCompare(b.id));
  writeState(state);
  audit({
    subsystem: 'firewall',
    action: 'add-service-l4',
    resource: id,
    actor,
    after: rule,
  });
  Object.defineProperty(rule, '_warnings', { value: warnings, enumerable: false });
  return rule;
}

/**
 * Remove an L4-forward firewall rule. Symmetric with removeManual
 * but only accepts rows with source='service-l4', so an operator
 * can't accidentally drop a hand-curated `manual` rule through this
 * entry point.
 *
 * Idempotent at the API surface: missing rows raise a NOT_FOUND
 * error so the admin reconciler can treat it as "already gone" and
 * keep going.
 */
export function removeServiceL4({ id, actor }) {
  const state = readState();
  const idx = state.discovered.findIndex(r => r.id === id);
  if (idx === -1) {
    const err = new Error(`no rule with id ${id}`);
    err.code = 'NOT_FOUND';
    throw err;
  }
  const rule = state.discovered[idx];
  if (rule.source !== 'service-l4') {
    throw new Error(`refusing to remove non-service-l4 rule ${id} (source=${rule.source}); use disable instead`);
  }
  state.discovered.splice(idx, 1);
  writeState(state);
  audit({
    subsystem: 'firewall',
    action: 'remove-service-l4',
    resource: id,
    actor,
    before: rule,
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
