import { readState, writeState } from './state.js';
import { NAMED_SERVICES } from './render.js';
import { audit } from '../../db/audit.js';

/**
 * Allow `container` to reach the named host-side `service`. If an
 * entry for the container already exists, the service is added to its
 * allow list (idempotent).
 */
export function allowEgress({ container, service, reason, containerIp, actor }) {
  if (!NAMED_SERVICES[service]) {
    throw new Error(`unknown service '${service}'. Known: ${Object.keys(NAMED_SERVICES).join(', ')}`);
  }
  const state = readState();
  state.container_egress = state.container_egress ?? [];
  let entry = state.container_egress.find(e => e.container === container);
  const before = entry ? { ...entry, allow: [...entry.allow] } : null;
  if (!entry) {
    entry = { container, allow: [], reason: reason ?? null };
    state.container_egress.push(entry);
  }
  if (!entry.allow.includes(service)) entry.allow.push(service);
  if (containerIp) entry.container_ip = containerIp;
  if (reason) entry.reason = reason;
  writeState(state);
  audit({
    subsystem: 'firewall',
    action: 'egress-allow',
    resource: `${container}/${service}`,
    actor,
    before,
    after: entry,
  });
  return entry;
}

/**
 * Remove `service` from `container`'s allow list. If the allow list
 * empties, remove the whole entry.
 */
export function denyEgress({ container, service, actor }) {
  const state = readState();
  const idx = (state.container_egress ?? []).findIndex(e => e.container === container);
  if (idx === -1) {
    return { ok: false, reason: 'no egress entry for container' };
  }
  const entry = state.container_egress[idx];
  const before = { ...entry, allow: [...entry.allow] };
  entry.allow = entry.allow.filter(s => s !== service);
  if (entry.allow.length === 0) {
    state.container_egress.splice(idx, 1);
  }
  writeState(state);
  audit({
    subsystem: 'firewall',
    action: 'egress-deny',
    resource: `${container}/${service}`,
    actor,
    before,
    after: entry.allow.length === 0 ? null : entry,
  });
  return { ok: true };
}

export function listEgress() {
  const state = readState();
  return state.container_egress ?? [];
}
