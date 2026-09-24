// Setup engine — the PURE layer of the guest configuration jobs (platform
// ledger A-17.8, group 3): which kinds exist, what each accepts, the FIXED
// host command each step renders, how a step's result is read back from the
// guest / the firewall, and what prior state a job records so a change can
// be reversed without exposing anything.
//
// No I/O of its own (the device policy is read once from the same JSON the
// MCP surface enforces). The runner validates a claimed job with
// validateConfigParams before it renders anything, and every argv comes from
// the renderers here: a job carries names, allowlisted keys and values,
// ports, a device's properties — never a command, an argv or an option
// string, and never a value that looks like a secret.
//
//   config_set       incus config set <name> <key> <value>  (per allowlisted key)
//                    [+ incus config device override <name> root size=<n>, fallback device set]
//   device_add       incus config device add <name> <dev> disk|proxy k=v…
//   device_remove    incus config device remove <name> <dev>
//   network_pin      incus config device override <name> eth0 ipv4.address=<ip>
//                    (fallback: incus config device set <name> eth0 ipv4.address <ip>)
//   forward_apply    incus config device add <name> ppl4-<id> proxy listen= connect=
//                    proxypilot --json firewall add-service-l4 --id service-l4-<id> …
//                    the reserved-ports drop-in refresh (below)
//   forward_remove   the mirror of forward_apply
//   egress_set       proxypilot --json firewall egress allow|deny <guest> <service> [--reason r]
//
// Every kind is IDEMPOTENT: each step checks its own read-back before it
// issues anything and again afterwards, so a resumed or retried job
// converges on the requested state without replaying a command whose
// effect already holds. The reserved-ports refresh is the one step that
// needs a file written on the host; it is a fixed script under `sh -c`
// whose only arguments are the base64 of a body rendered HERE from
// validated port ranges and the drop-in's constant path — no caller text
// reaches it.

import { readFileSync } from 'node:fs';
import { CONTAINER_NAME_RE, redact } from './logic.js';
import { SNAPSHOT_NAME_RE, SIZE_RE, instanceIdentity } from './lifecycle-logic.js';
import { IPV4_RE } from './setup-logic.js';
import { buildReservedPortsValue, reservedPortsBody, RESERVED_PORTS_PATH } from '../l4-reserved-ports.js';

export const CONFIG_JOB_KINDS = Object.freeze(['config_set', 'device_add', 'device_remove', 'network_pin', 'forward_apply', 'forward_remove', 'egress_set']);
// The kinds that write the host firewall's state (one file, one ruleset):
// serialized through the shared lease, taken after the guest's.
export const FIREWALL_KINDS = Object.freeze(['forward_apply', 'forward_remove', 'egress_set']);
export const HOST_FIREWALL_LOCK = '@host/firewall';
// The kinds a pre-mutation snapshot applies to (the guest's own config and devices).
export const SNAPSHOT_KINDS = Object.freeze(['config_set', 'device_add', 'device_remove', 'network_pin']);
export const PROXYPILOT_BIN = process.env.PROXYPILOT_BIN || '/usr/local/bin/proxypilot';

// The config keys a job may set, each with its value shape. The MCP allowlist
// (lib/mcp-policy/lxc-config-allowlist.json) names the same four keys; this
// is the runner's own copy so a row that arrived any other way is held to
// the same rule. Memory accepts the shapes the MCP validator always did.
export const CONFIG_KEY_ALLOWLIST = Object.freeze({
  'security.nesting': /^(true|false)$/,
  'limits.cpu': /^[1-9][0-9]{0,2}$/,
  'limits.memory': /^[1-9][0-9]{0,6}(\.[0-9]{1,3})?(MB|MiB|GB|GiB)$/i,
  'boot.autostart': /^(true|false)$/,
});
export const RISK_ACKNOWLEDGED_KEYS = Object.freeze({});

export const DEVICE_NAME_RE = /^[a-z][a-z0-9-]{0,30}$/;
export const DEVICE_REF_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,40}$/;
export const MANAGED_DEVICE_RE = /^(root|eth0|ppl4-|ppcert-|reporepo)/;
export const GUEST_PATH_RE = /^\/[A-Za-z0-9._@+\/-]{1,254}$/;
export const FORWARD_ID_RE = /^[A-Za-z0-9-]{1,64}$/;
export const SERVICE_TAG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const EGRESS_SERVICE_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
export const TEXT_RE = /^[^\0-\x08\x0b\x0c\x0e-\x1f\x7f]*$/;
export const DESCRIPTION_MAX = 255;
export const REASON_MAX = 200;
export const MAX_RESERVED_RANGES = 200;
// The device properties a job may set, per type, in the order they are rendered.
export const DEVICE_PROPS = Object.freeze({ disk: ['source', 'path', 'readonly', 'shift'], proxy: ['listen', 'connect'] });
// The properties of an existing device a job records as `previous`
// (references and addresses only — a device may carry anything else).
export const RECORDED_DEVICE_PROPS = Object.freeze(['type', 'source', 'path', 'readonly', 'shift', 'listen', 'connect', 'bind', 'nat', 'pool', 'size', 'network', 'nictype', 'parent', 'ipv4.address']);

let devicePolicy = null;
export function loadDevicePolicy() {
  if (devicePolicy) return devicePolicy;
  try {
    const p = JSON.parse(readFileSync(new URL('../mcp-policy/mcp-extended-policy.json', import.meta.url), 'utf8'));
    devicePolicy = p.lxc_devices || {};
  } catch { devicePolicy = {}; }
  devicePolicy = {
    disk_source_roots: Array.isArray(devicePolicy.disk_source_roots) && devicePolicy.disk_source_roots.length ? devicePolicy.disk_source_roots : ['/var/lib/proxypilot/shares'],
    proxy_listen_ports: { min: Number(devicePolicy.proxy_listen_ports?.min) || 1024, max: Number(devicePolicy.proxy_listen_ports?.max) || 65535 },
    reserved_listen_ports: Array.isArray(devicePolicy.reserved_listen_ports) ? devicePolicy.reserved_listen_ports.map(Number) : [],
  };
  return devicePolicy;
}

export function isConfigKind(kind) { return CONFIG_JOB_KINDS.includes(kind); }
const isPlainObject = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const isBool = (v) => v == null || typeof v === 'boolean';
const isPort = (v) => Number.isInteger(v) && v >= 1 && v <= 65535;
const text = (v, max) => typeof v === 'string' && v.length <= max && TEXT_RE.test(v) && !v.startsWith('-');

// shortGuestName(container) → the name the firewall CLI keys its entries by
// (the guest without the dashboard's `pp-` prefix).
export function shortGuestName(container) { return String(container).replace(/^pp-/, ''); }

function validateExpect(expect) {
  if (expect == null) return null;
  if (!isPlainObject(expect)) return 'expect must be an identity record';
  for (const k of Object.keys(expect)) if (!['uuid', 'created_at', 'status'].includes(k)) return `expect.${k} is not an identity field`;
  if (expect.uuid != null && !/^[0-9a-fA-F-]{8,64}$/.test(String(expect.uuid))) return 'expect.uuid must be an Incus volatile uuid';
  if (expect.created_at != null && !Number.isFinite(Date.parse(String(expect.created_at)))) return 'expect.created_at must be a timestamp';
  return null;
}

function validateProxyEndpoint(v, { host, portMin = 1, portMax = 65535, reserved = [] }) {
  const m = /^(tcp|udp):([0-9.]+):([0-9]{1,5})$/.exec(String(v || ''));
  if (!m) return `${v} is not a proto:address:port endpoint`;
  if (m[2] !== host) return `the address must be ${host}`;
  const port = Number(m[3]);
  if (!isPort(port) || port < portMin || port > portMax) return `port ${m[3]} is outside ${portMin}–${portMax}`;
  if (reserved.includes(port)) return `port ${port} is reserved on this host`;
  return null;
}

// validateConfigParams(kind, params) → { ok } | { ok: false, reason }.
// Shape only, and strict: nothing here is ever interpolated into a shell.
export function validateConfigParams(kind, p = {}) {
  if (!isConfigKind(kind)) return { ok: false, reason: `kind '${kind}' is not a guest configuration job` };
  if (!isPlainObject(p)) return { ok: false, reason: 'params must be an object' };
  if (!CONTAINER_NAME_RE.test(String(p.container || ''))) return { ok: false, reason: 'container must be an Incus guest name' };
  if (p.command != null || p.script != null || p.argv != null || p.args != null || p.options != null) return { ok: false, reason: 'a configuration job never carries a command, arguments or options' };
  const e = validateExpect(p.expect);
  if (e) return { ok: false, reason: e };
  if (p.snapshot != null) {
    if (!SNAPSHOT_KINDS.includes(kind)) return { ok: false, reason: `a ${kind} job carries no snapshot` };
    if (!isPlainObject(p.snapshot) || !SNAPSHOT_NAME_RE.test(String(p.snapshot.name || ''))) return { ok: false, reason: 'snapshot.name must be a snapshot name' };
    for (const k of Object.keys(p.snapshot)) if (k !== 'name') return { ok: false, reason: `snapshot.${k} is not a plan field (the job records the snapshot's identity itself)` };
  }
  if (!isBool(p.acknowledgeRisk)) return { ok: false, reason: 'acknowledgeRisk must be a boolean' };
  if (p.retryOf != null && !/^[A-Za-z0-9-]{1,64}$/.test(String(p.retryOf))) return { ok: false, reason: 'retryOf must be a job id' };
  const only = (allowed) => { for (const k of Object.keys(p)) if (k !== 'retryOf' && !allowed.includes(k)) return `a ${kind} job carries no ${k}`; return null; };
  const policy = loadDevicePolicy();
  switch (kind) {
    case 'config_set': {
      const bad = only(['container', 'expect', 'snapshot', 'acknowledgeRisk', 'changes', 'rootSize']); if (bad) return { ok: false, reason: bad };
      const changes = Array.isArray(p.changes) ? p.changes : null;
      if (!changes && p.rootSize == null) return { ok: false, reason: 'changes must be a list of { key, value }, or rootSize must be given' };
      if (changes) {
        if (changes.length > Object.keys(CONFIG_KEY_ALLOWLIST).length) return { ok: false, reason: 'too many changes' };
        const seen = new Set();
        for (const c of changes) {
          if (!isPlainObject(c) || typeof c.key !== 'string' || typeof c.value !== 'string') return { ok: false, reason: 'every change is { key, value } of strings' };
          if (c.key === 'security.privileged') return { ok: false, reason: 'Changing container privilege in place is disabled; provision a VM and migrate data with correct ownership' };
          const re = CONFIG_KEY_ALLOWLIST[c.key];
          if (!re) return { ok: false, reason: `config key '${c.key}' is not on the configuration allowlist (${Object.keys(CONFIG_KEY_ALLOWLIST).join(', ')})` };
          if (!re.test(c.value)) return { ok: false, reason: `config ${c.key}=${c.value.slice(0, 40)} is not an accepted value` };
          if (seen.has(c.key)) return { ok: false, reason: `config key '${c.key}' is given twice` };
          seen.add(c.key);
          if (RISK_ACKNOWLEDGED_KEYS[c.key] === c.value && p.acknowledgeRisk !== true) return { ok: false, reason: `${c.key}=${c.value} requires acknowledgeRisk: true (container root becomes host root)` };
        }
      }
      if (p.rootSize != null && !SIZE_RE.test(String(p.rootSize))) return { ok: false, reason: 'rootSize must be a size like 20GiB' };
      break;
    }
    case 'device_add': {
      const bad = only(['container', 'expect', 'snapshot', 'acknowledgeRisk', 'device', 'deviceType', 'props']); if (bad) return { ok: false, reason: bad };
      if (!DEVICE_NAME_RE.test(String(p.device || ''))) return { ok: false, reason: 'device must be a short lowercase name (a-z, 0-9, -)' };
      if (MANAGED_DEVICE_RE.test(String(p.device))) return { ok: false, reason: `device ${p.device} is managed by ProxyPilot (root, eth0, ppl4-*, ppcert-*, reporepo)` };
      if (!['disk', 'proxy'].includes(p.deviceType)) return { ok: false, reason: "deviceType must be 'disk' or 'proxy'" };
      if (!isPlainObject(p.props)) return { ok: false, reason: 'props must be the device properties' };
      for (const k of Object.keys(p.props)) if (!DEVICE_PROPS[p.deviceType].includes(k)) return { ok: false, reason: `props.${k} is not a ${p.deviceType} property a job may set` };
      for (const [k, v] of Object.entries(p.props)) if (typeof v !== 'string') return { ok: false, reason: `props.${k} must be a string` };
      if (p.deviceType === 'disk') {
        const source = String(p.props.source || '');
        const roots = policy.disk_source_roots;
        if (!source.startsWith('/') || source.includes('..') || !/^[A-Za-z0-9._@+\/-]{1,255}$/.test(source) || !roots.some((r) => source === r || source.startsWith(`${r}/`))) return { ok: false, reason: `props.source must be an absolute host path under one of: ${roots.join(', ')}` };
        const path = String(p.props.path || '');
        if (!GUEST_PATH_RE.test(path) || path === '/' || path.includes('..')) return { ok: false, reason: 'props.path must be an absolute mount point inside the guest' };
        for (const k of ['readonly', 'shift']) if (p.props[k] != null && p.props[k] !== 'true') return { ok: false, reason: `props.${k} is 'true' or absent` };
      } else {
        const l = validateProxyEndpoint(p.props.listen, { host: '0.0.0.0', portMin: policy.proxy_listen_ports.min, portMax: policy.proxy_listen_ports.max, reserved: policy.reserved_listen_ports });
        if (l) return { ok: false, reason: `props.listen: ${l}` };
        const c = validateProxyEndpoint(p.props.connect, { host: '127.0.0.1' });
        if (c) return { ok: false, reason: `props.connect: ${c}` };
        if (String(p.props.listen).split(':')[0] !== String(p.props.connect).split(':')[0]) return { ok: false, reason: 'listen and connect must use the same protocol' };
      }
      break;
    }
    case 'device_remove': {
      const bad = only(['container', 'expect', 'snapshot', 'acknowledgeRisk', 'device']); if (bad) return { ok: false, reason: bad };
      if (!DEVICE_REF_RE.test(String(p.device || ''))) return { ok: false, reason: 'device is required' };
      if (MANAGED_DEVICE_RE.test(String(p.device))) return { ok: false, reason: `device ${p.device} is managed by ProxyPilot (root, eth0, ppl4-*, ppcert-*, reporepo) — use the matching tool` };
      break;
    }
    case 'network_pin': {
      const bad = only(['container', 'expect', 'snapshot', 'acknowledgeRisk', 'ip', 'previous']); if (bad) return { ok: false, reason: bad };
      if (!IPV4_RE.test(String(p.ip || ''))) return { ok: false, reason: 'ip must be a plain IPv4 address' };
      if (p.previous != null && !IPV4_RE.test(String(p.previous))) return { ok: false, reason: 'previous must be a plain IPv4 address' };
      break;
    }
    case 'forward_apply': case 'forward_remove': {
      if (p.reserved != null) return { ok: false, reason: 'a forward job carries no reservation aggregate: the runner recomputes the reserved UDP ranges from the authoritative rows under the firewall lease' };
      const bad = only(['container', 'expect', 'acknowledgeRisk', 'forward', 'bridgeIp', 'serviceTag', 'serviceId']); if (bad) return { ok: false, reason: bad };
      const f = p.forward;
      if (!isPlainObject(f)) return { ok: false, reason: 'forward must be the forward row\'s fields' };
      for (const k of Object.keys(f)) if (!['id', 'proto', 'listen', 'listenEnd', 'connect', 'connectEnd', 'description'].includes(k)) return { ok: false, reason: `forward.${k} is not a forward field` };
      if (!FORWARD_ID_RE.test(String(f.id || ''))) return { ok: false, reason: 'forward.id must be the row id' };
      if (!['tcp', 'udp'].includes(f.proto)) return { ok: false, reason: "forward.proto must be 'tcp' or 'udp'" };
      if (!isPort(f.listen) || !isPort(f.connect)) return { ok: false, reason: 'forward.listen and forward.connect must be ports' };
      if (f.listenEnd != null && (!isPort(f.listenEnd) || f.listenEnd < f.listen)) return { ok: false, reason: 'forward.listenEnd must be a port at or above listen' };
      if (f.connectEnd != null && (!isPort(f.connectEnd) || f.connectEnd < f.connect)) return { ok: false, reason: 'forward.connectEnd must be a port at or above connect' };
      if ((f.listenEnd != null) !== (f.connectEnd != null) || (f.listenEnd != null && (f.listenEnd - f.listen) !== (f.connectEnd - f.connect))) return { ok: false, reason: 'listen and connect port ranges must be the same width' };
      if (f.description != null && !text(f.description, DESCRIPTION_MAX)) return { ok: false, reason: `forward.description must be text of at most ${DESCRIPTION_MAX} characters` };
      if (kind === 'forward_apply') {
        if (!IPV4_RE.test(String(p.bridgeIp || ''))) return { ok: false, reason: 'bridgeIp must be the guest\'s IPv4 address' };
        if (!FORWARD_ID_RE.test(String(p.serviceId || ''))) return { ok: false, reason: 'serviceId must be the services row the forward belongs to' };
      } else {
        if (p.bridgeIp != null) return { ok: false, reason: 'a forward_remove job carries no bridgeIp' };
        if (p.serviceId != null) return { ok: false, reason: 'a forward_remove job carries no serviceId (the row names it)' };
      }
      if (p.serviceTag != null && !SERVICE_TAG_RE.test(String(p.serviceTag))) return { ok: false, reason: 'serviceTag must be a service name' };
      break;
    }
    case 'egress_set': {
      const bad = only(['container', 'acknowledgeRisk', 'action', 'service', 'reason']); if (bad) return { ok: false, reason: bad };
      if (!['allow', 'deny'].includes(p.action)) return { ok: false, reason: "action must be 'allow' or 'deny'" };
      if (!EGRESS_SERVICE_RE.test(String(p.service || ''))) return { ok: false, reason: 'service must be a named service (dns, http, smtp, …) or proto:port' };
      if (p.reason != null && !text(p.reason, REASON_MAX)) return { ok: false, reason: `reason must be text of at most ${REASON_MAX} characters` };
      break;
    }
    default: return { ok: false, reason: `no rules for ${kind}` };
  }
  if (JSON.stringify(p) !== JSON.stringify(redact(p))) return { ok: false, reason: 'the plan carries a value that looks like a secret; plans carry references only' };
  return { ok: true };
}

// ── the fixed commands ────────────────────────────────────────────────────

export function configSetArgv(name, key, value) { return ['incus', 'config', 'set', String(name), String(key), String(value)]; }
export function rootSizeOverrideArgv(name, size) { return ['incus', 'config', 'device', 'override', String(name), 'root', `size=${size}`]; }
export function rootSizeSetArgv(name, size) { return ['incus', 'config', 'device', 'set', String(name), 'root', 'size', String(size)]; }
export function deviceAddArgv(name, dev, type, props) {
  const argv = ['incus', 'config', 'device', 'add', String(name), String(dev), String(type)];
  for (const k of DEVICE_PROPS[type] || []) if (props[k] != null) argv.push(`${k}=${props[k]}`);
  return argv;
}
export function deviceRemoveArgv(name, dev) { return ['incus', 'config', 'device', 'remove', String(name), String(dev)]; }
export function networkPinOverrideArgv(name, ip) { return ['incus', 'config', 'device', 'override', String(name), 'eth0', `ipv4.address=${ip}`]; }
export function networkPinSetArgv(name, ip) { return ['incus', 'config', 'device', 'set', String(name), 'eth0', 'ipv4.address', String(ip)]; }
export function forwardDeviceName(id) { return `ppl4-${id}`; }
export function forwardRuleId(id) { return `service-l4-${id}`; }
export function forwardEndpoint({ proto, start, end, address }) { return `${proto}:${address}:${end && end !== start ? `${start}-${end}` : start}`; }
export function forwardListen(f) { return forwardEndpoint({ proto: f.proto, start: f.listen, end: f.listenEnd, address: '0.0.0.0' }); }
export function forwardConnect(f, bridgeIp) { return forwardEndpoint({ proto: f.proto, start: f.connect, end: f.connectEnd, address: bridgeIp }); }
export function forwardDeviceAddArgv(name, f, bridgeIp) { return ['incus', 'config', 'device', 'add', String(name), forwardDeviceName(f.id), 'proxy', `listen=${forwardListen(f)}`, `connect=${forwardConnect(f, bridgeIp)}`]; }
export function forwardDeviceRemoveArgv(name, id) { return ['incus', 'config', 'device', 'remove', String(name), forwardDeviceName(id)]; }
export function forwardPortRange(f) { return f.listenEnd && f.listenEnd !== f.listen ? `${f.listen}-${f.listenEnd}` : String(f.listen); }
export function firewallAddArgv(f, serviceTag = null) {
  const argv = [PROXYPILOT_BIN, '--json', 'firewall', 'add-service-l4', '--id', forwardRuleId(f.id), '--port', String(f.listen), '--proto', f.proto, '--reason', f.description || `service-l4 ${f.proto}/${forwardPortRange(f)}`];
  if (f.listenEnd) argv.push('--port-end', String(f.listenEnd));
  if (serviceTag) argv.push('--service', String(serviceTag));
  return argv;
}
export function firewallRemoveArgv(id) { return [PROXYPILOT_BIN, '--json', 'firewall', 'remove-service-l4', forwardRuleId(id)]; }
export function firewallListArgv() { return [PROXYPILOT_BIN, '--json', 'firewall', 'list']; }
// The APPLIED policy's evidence (never the saved configuration): the last
// recorded reconcile (`status`) against the desired ruleset's checksum
// (`reconcile --dry-run`), and the reconcile itself when they differ.
export function firewallStatusArgv() { return [PROXYPILOT_BIN, '--json', 'firewall', 'status']; }
export function firewallDryRunArgv() { return [PROXYPILOT_BIN, '--json', 'firewall', 'reconcile', '--dry-run']; }
export function firewallReconcileArgv() { return [PROXYPILOT_BIN, '--json', 'firewall', 'reconcile']; }
export function egressArgv(container, action, service, reason = null) {
  const argv = [PROXYPILOT_BIN, '--json', 'firewall', 'egress', action, shortGuestName(container), String(service)];
  if (action === 'allow' && reason) argv.push('--reason', String(reason));
  return argv;
}
export function egressListArgv() { return [PROXYPILOT_BIN, '--json', 'firewall', 'egress', 'list']; }

// The reserved-ports drop-in (lib/l4-reserved-ports.js owns the body): read,
// write, remove, apply, read the kernel's value. The write is the one host
// script of this group: fixed text, positional arguments only.
export const RESERVED_WRITE_SCRIPT = [
  'set -e',
  'b="$1"; f="$2"; d=$(dirname -- "$f")',
  'mkdir -p -- "$d"',
  't=$(mktemp "$d/.proxypilot-reserved-XXXXXX")',
  'printf \'%s\' "$b" | base64 -d > "$t"',
  'chmod 0644 "$t"',
  'mv -f -- "$t" "$f"',
].join('\n');
export function reservedReadArgv(path = RESERVED_PORTS_PATH) { return ['cat', String(path)]; }
export function reservedWriteArgv(body, path = RESERVED_PORTS_PATH) { return ['sh', '-c', RESERVED_WRITE_SCRIPT, 'sh', Buffer.from(String(body), 'utf8').toString('base64'), String(path)]; }
export function reservedRemoveArgv(path = RESERVED_PORTS_PATH) { return ['rm', '-f', String(path)]; }
export function sysctlApplyArgv(path) { return ['sysctl', '-p', String(path)]; }
export function sysctlReadArgv() { return ['sysctl', '-n', 'net.ipv4.ip_local_reserved_ports']; }
// reservedPlan(reserved) → { value, body }: the kernel value and the drop-in
// body for the validated ranges (the same rendering the reconciler uses).
export function reservedPlan(reserved) {
  const value = buildReservedPortsValue((reserved || []).map(([s, e]) => ({ proto: 'udp', listen_port: s, listen_port_end: e, enabled: 1 })));
  return { value, body: reservedPortsBody(value) };
}

// ── read-backs ────────────────────────────────────────────────────────────

const instanceDevices = (instance) => (instance && (instance.devices || {})) || {};
const expandedDevices = (instance) => (instance && (instance.expanded_devices || instance.devices || {})) || {};

// priorConfig(instance, keys) → { key: value | null } for the keys a job
// changes (only those: another key may hold anything).
export function priorConfig(instance, keys) {
  const cfg = (instance && instance.config) || {};
  return Object.fromEntries((keys || []).map((k) => [k, cfg[k] != null ? String(cfg[k]) : null]));
}
export function priorRootSize(instance) {
  const root = instanceDevices(instance).root || expandedDevices(instance).root || null;
  return root && root.size != null ? String(root.size) : null;
}
// recordedDevice(device) → the reference-only view of a device.
export function recordedDevice(device) {
  if (!device || typeof device !== 'object') return null;
  const out = {};
  for (const k of RECORDED_DEVICE_PROPS) if (device[k] != null) out[k] = String(device[k]);
  return out;
}
export function configKeyVerdict(instance, key, value) {
  const observed = instance && instance.config && instance.config[key] != null ? String(instance.config[key]) : null;
  return { key, expected: String(value), observed, ok: observed === String(value) };
}
export function rootSizeVerdict(instance, size) {
  const observed = priorRootSize(instance);
  return { expected: String(size), observed, ok: observed === String(size) };
}
export function deviceVerdict(instance, dev, { present, type = null, props = null } = {}) {
  const d = instanceDevices(instance)[dev] || null;
  if (!present) return { ok: !d, observed: d ? 'present' : 'absent', expected: 'absent', device: recordedDevice(d) };
  if (!d) return { ok: false, observed: 'absent', expected: 'present', device: null };
  const mismatched = [];
  if (type && String(d.type) !== type) mismatched.push(`type=${d.type}`);
  for (const [k, v] of Object.entries(props || {})) if (String(d[k] ?? '') !== String(v)) mismatched.push(`${k}=${d[k] ?? '(unset)'}`);
  return { ok: mismatched.length === 0, observed: mismatched.length ? `present with other properties (${mismatched.join(', ')})` : 'present', expected: 'present', device: recordedDevice(d), mismatched };
}
export function networkVerdict(instance, ip) {
  const eth0 = instanceDevices(instance).eth0 || null;
  const observed = eth0 && eth0['ipv4.address'] != null ? String(eth0['ipv4.address']) : null;
  return { expected: String(ip), observed, ok: observed === String(ip) };
}
export function priorPin(instance) {
  const eth0 = instanceDevices(instance).eth0 || null;
  return eth0 && eth0['ipv4.address'] != null ? String(eth0['ipv4.address']) : null;
}

// parseCliJson(stdout) → the JSON the proxypilot CLI printed, or null.
export function parseCliJson(stdout) {
  const s = String(stdout || '').trim();
  if (!s) return null;
  try { return JSON.parse(s); } catch { /* */ }
  const last = s.split('\n').filter((l) => l.trim()).pop();
  try { return JSON.parse(last); } catch { return null; }
}
// forwardRuleVerdict(list, forward, serviceTag, { present }) → the SAVED
// rule compared property by property with the plan: its id alone proves
// nothing (a rule under the expected id with another port is not this
// forward's).
export function forwardRuleVerdict(list, f, serviceTag, { present }) {
  if (!Array.isArray(list)) return { ok: false, observed: 'unreadable', expected: present ? 'present' : 'absent' };
  const id = forwardRuleId(f.id);
  const rule = list.find((r) => r && r.id === id) || null;
  if (!present) return { ok: !rule, observed: rule ? 'present' : 'absent', expected: 'absent' };
  if (!rule) return { ok: false, observed: 'absent', expected: 'present' };
  const want = { source: 'service-l4', proto: f.proto, port_start: Number(f.listen), port_end: f.listenEnd != null ? Number(f.listenEnd) : null, scope: 'public', service: serviceTag || null, enabled: true };
  const have = { source: rule.source ?? null, proto: rule.proto ?? null, port_start: rule.port_start != null ? Number(rule.port_start) : null, port_end: rule.port_end != null ? Number(rule.port_end) : null, scope: rule.scope ?? 'public', service: rule.service ?? null, enabled: rule.enabled !== false };
  const mismatched = Object.keys(want).filter((k) => want[k] !== have[k]).map((k) => `${k}=${have[k] === null ? '(unset)' : have[k]}`);
  return { ok: mismatched.length === 0, observed: mismatched.length ? `present with other properties (${mismatched.join(', ')})` : 'present', expected: 'present', mismatched };
}
// reconcileEvidence(statusJson, dryRunJson) → is the SAVED configuration the
// APPLIED policy? Only a recorded, applied reconcile whose checksum is the
// desired ruleset's checksum says so.
export function reconcileEvidence(status, dry) {
  const last = status && status.last_reconcile ? status.last_reconcile : null;
  const desired = dry && dry.ok !== false && dry.checksum ? String(dry.checksum) : null;
  if (!desired) return { ok: false, observed: dry && dry.rejection ? `the desired ruleset cannot be applied: ${dry.rejection.reason || dry.rejection}` : 'the desired ruleset\'s checksum is unreadable', desired: null, last };
  if (!last) return { ok: false, observed: 'no reconcile recorded', desired, last };
  const applied = Number(last.applied) === 1 && !last.rejection_reason;
  const same = String(last.ruleset_checksum || '') === desired;
  return { ok: applied && same, observed: applied && same ? `applied (${desired.slice(0, 12)})` : !applied ? `the last reconcile was rejected (${last.rejection_reason || 'not applied'})` : `the applied ruleset (${String(last.ruleset_checksum || '').slice(0, 12)}) is not the saved one (${desired.slice(0, 12)})`, desired, last };
}
// firewallCliResult(r) → what the CLI's JSON says about a write: the
// configuration SAVED (a rule or payload echoed) and the reconcile it ran.
export function firewallCliResult(r) {
  const j = parseCliJson(r?.stdout);
  const reconcile = j && j.reconcile ? { applied: j.reconcile.applied === true, checksum: j.reconcile.checksum ?? null, rejection: j.reconcile.rejection ? (j.reconcile.rejection.reason || String(j.reconcile.rejection)) : null } : null;
  const saved = !!j && (j.rule != null || j.payload != null || j.already_absent === true || (j.ok === true && !j.reconcile_error));
  return { json: j, reconcile, saved };
}
export function ruleVerdict(list, ruleId, { present }) {
  if (!Array.isArray(list)) return { ok: false, observed: 'unreadable', expected: present ? 'present' : 'absent' };
  const rule = list.find((r) => r && r.id === ruleId) || null;
  if (!present) return { ok: !rule, observed: rule ? 'present' : 'absent', expected: 'absent' };
  return { ok: !!rule && rule.enabled !== false, observed: rule ? (rule.enabled === false ? 'present but disabled' : 'present') : 'absent', expected: 'present' };
}
export function egressVerdict(listing, container, service, action) {
  const entries = listing && Array.isArray(listing.entries) ? listing.entries : null;
  if (!entries) return { ok: false, observed: 'unreadable', expected: action === 'allow' ? 'present' : 'absent' };
  const short = shortGuestName(container);
  const entry = entries.find((e) => e && (e.container === short || e.container === container)) || null;
  const has = !!entry && Array.isArray(entry.allow) && entry.allow.includes(service);
  return { ok: action === 'allow' ? has : !has, observed: has ? 'present' : entry ? 'absent' : 'no entry', expected: action === 'allow' ? 'present' : 'absent', allow: entry ? [...entry.allow] : [] };
}

// reservedRangesFromRows(rows) → [[start, end], …]: the UDP listen RANGES of
// the enabled forward rows (what the kernel reservation covers; single ports
// and TCP are never reserved — l4-reserved-ports.js says why).
export function reservedRangesFromRows(rows) {
  return (rows || []).filter((r) => r && r.enabled !== 0 && r.proto === 'udp' && r.listen_port_end && r.listen_port_end > r.listen_port).map((r) => [Number(r.listen_port), Number(r.listen_port_end)]);
}

export function configOutcomeStep(kind) {
  return { config_set: 'configured', device_add: 'device_added', device_remove: 'device_removed', network_pin: 'network_pinned', forward_apply: 'forward_applied', forward_remove: 'forward_removed', egress_set: 'egress_set' }[kind] || 'completed';
}

// snapshotCoverageNote(coverage) → what an instance snapshot does and does
// not restore, stated once for every record and result.
export function snapshotCoverageNote(coverage) {
  const vols = coverage && Array.isArray(coverage.customVolumes) && coverage.customVolumes.length ? ` — the attached custom volume(s) ${coverage.customVolumes.map((v) => v.device).join(', ')} are NOT covered` : '';
  return `an instance snapshot restores the guest's root disk and configuration only${vols}; it never restores ProxyPilot's own database rows (services, routes, forwards) or the host firewall state`;
}

// configVerification(kind, ok, { container, label, failedAt }) → the
// verification a configuration job records: the resource's state read back.
export function configVerification(kind, ok, { container, label, failedAt = null, next = null, facts = {} }) {
  return {
    state: ok ? 'not_applicable' : 'recovery_required',
    outcome: ok ? 'resource_state_verified' : 'resource_state_mismatch',
    label: ok ? `verified: ${label}; the application ladder does not apply to a configuration job` : label,
    failedAt: ok ? null : failedAt || 'resource_state',
    next: ok ? null : next || `read the guest ('incus list ${container} --format json') and the firewall ('proxypilot --json firewall list') and decide; retry the job to converge — every step re-reads before it issues`,
    facts: { resource: { kind, container }, ...facts },
  };
}

export { instanceIdentity };
