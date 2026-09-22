// Setup engine — the PURE layer of the post-launch / post-start guest setup
// (platform ledger A-17.7): which phases exist, what the `guest_setup` and
// `configure_routes` jobs accept, the FIXED host commands the NAT phase
// renders, the guest scripts the DNS and init phases run (and how their
// output is read), which address of a guest the host can reach, and how the
// records are read back into the dashboard's create-status answer.
//
// No I/O. Nothing here is ever interpolated into a shell from a request: the
// NAT argv are constants plus a bridge name the host itself reported (and
// that is validated again before it becomes an argv element); the guest
// scripts embed only validated resolvers, a job id and a base64 body whose
// sha256 the plan carries.
//
//   network_nat     host: ip_forward on, ipv4.nat on every managed bridge,
//                   the DOCKER-USER accepts and the MASQUERADE fallback —
//                   idempotent, under the host-wide lease `@host/network`
//   await_address   host: `incus list` until the guest holds a host-reachable
//                   IPv4 (eth0 / the Incus NIC; never a docker0 / br-* / veth
//                   address inside the guest) or the bound wait elapses
//   dns             guest: /etc/resolv.conf carries the public resolvers
//   init_script     guest: the operator's script, bound to the guest identity
//                   and to the script's sha256, issued once; its exit code
//                   and its OUTPUT stay in the guest (0600 files) — the
//                   record carries the exit code and the log's reference
//   routes          backend (`configure_routes`): the route rows and the Caddy
//                   render for the services the operator named, under
//                   `@host/routes` and the guest's lease
//
// Interruption: every phase but the init script is idempotent, so an owner
// dying before the script was issued RESUMES the job. After the issue the
// resumed job READS what the guest recorded (`/var/log/pp-init-<job>.rc`) and
// never runs the script again; with nothing recorded the record ends
// `init_uncertain`, the guest's lease is HELD (an unknown writer may still be
// changing the guest) until an operator establishes the writer stopped and
// acknowledges, and it says how to look.

import { CONTAINER_NAME_RE, redact } from './logic.js';
import { CONTAINMENT_RUN_DIR } from './guest-probes.js';

export const SETUP_JOB_KINDS = Object.freeze(['guest_setup']);
// Executed by the backend whatever the executor policy (ProxyPilot's own rows and its Caddy render).
export const BACKEND_STEP_KINDS = Object.freeze(['configure_openbao_route', 'configure_infisical_route', 'configure_pomerium_routes', 'configure_routes', 'configure_keycloak_route', 'verify_sso', 'configure_recovery_route']);
export const SETUP_PHASES = Object.freeze(['network_nat', 'await_address', 'dns', 'init_script', 'routes']);
export const FIXUP_PHASES = Object.freeze(['network_nat', 'dns']);
export const GUEST_PHASES = Object.freeze(['dns', 'init_script']);
export const HOST_NETWORK_LOCK = '@host/network';
export const HOST_ROUTES_LOCK = '@host/routes';
export const DEFAULT_RESOLVERS = Object.freeze(['9.9.9.9', '1.1.1.1']);
export const DEFAULT_ADDRESS_TIMEOUT_MS = 30_000;
export const MAX_ADDRESS_TIMEOUT_MS = 5 * 60_000;
export const DEFAULT_INIT_TIMEOUT_MS = 5 * 60_000;
export const MAX_INIT_TIMEOUT_MS = 30 * 60_000;
export const INIT_LOG_DIR = '/var/log';
export const INIT_TMP_DIR = '/tmp';
export const INIT_LOG_MAX_BYTES = 64 * 1024 * 1024;
export const INPUT_REF_RE = /^[A-Za-z0-9-]{1,64}$/;
export const SHA256_RE = /^[0-9a-f]{64}$/;
export const IPV4_RE = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
export const BRIDGE_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]{0,14}$/;
export const SERVICE_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9-]{0,62}$/;
export const DOMAIN_RE = /^(?=.{1,253}$)(?!-)[A-Za-z0-9-]{1,63}(?<!-)(\.(?!-)[A-Za-z0-9-]{1,63}(?<!-))+$/;
export const HEALTH_PATH_RE = /^\/[A-Za-z0-9._~\-/?=&%]*$/;
export const HEALTH_PATH_MAX = 256;
export const MAX_SERVICES = 32;

// The state every phase records on the job. `pending` is a phase delegated
// to another job (routes → configure_routes); `not_run` is a phase the plan
// required that an earlier failure prevented; nothing is ever left blank.
export const PHASE_STATES = Object.freeze(['done', 'skipped', 'failed', 'refused', 'timed_out', 'uncertain', 'pending', 'not_run']);

const isBool = (v) => v == null || typeof v === 'boolean';
const isPlainObject = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const isInt = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;

// validateSetupParams(params) → { ok } | { ok: false, reason }. Strict shape:
// names, flags, bounded numbers, an identity and a script REFERENCE (ref +
// sha256 + bytes; the script itself is an input file, never in the plan).
export function validateSetupParams(p = {}) {
  if (!isPlainObject(p)) return { ok: false, reason: 'params must be an object' };
  if (!CONTAINER_NAME_RE.test(String(p.container || ''))) return { ok: false, reason: 'container must be an Incus guest name' };
  if (p.command != null || p.script != null || p.argv != null || p.args != null || p.options != null || p.initScriptText != null) return { ok: false, reason: 'a setup job never carries a command, arguments, options or the script text' };
  if (!Array.isArray(p.phases) || !p.phases.length) return { ok: false, reason: 'phases must name at least one setup phase' };
  for (const ph of p.phases) if (!SETUP_PHASES.includes(ph)) return { ok: false, reason: `'${ph}' is not a setup phase (${SETUP_PHASES.join(', ')})` };
  if (new Set(p.phases).size !== p.phases.length) return { ok: false, reason: 'a phase is named twice' };
  const order = p.phases.map((ph) => SETUP_PHASES.indexOf(ph));
  if (order.some((n, i) => i > 0 && n < order[i - 1])) return { ok: false, reason: `phases must be in their fixed order (${SETUP_PHASES.join(' → ')})` };
  if (p.expect != null) {
    if (!isPlainObject(p.expect)) return { ok: false, reason: 'expect must be an identity record' };
    for (const k of Object.keys(p.expect)) if (!['uuid', 'created_at', 'status'].includes(k)) return { ok: false, reason: `expect.${k} is not an identity field` };
    if (p.expect.uuid != null && !/^[0-9a-fA-F-]{8,64}$/.test(String(p.expect.uuid))) return { ok: false, reason: 'expect.uuid must be an Incus volatile uuid' };
    if (p.expect.created_at != null && !Number.isFinite(Date.parse(String(p.expect.created_at)))) return { ok: false, reason: 'expect.created_at must be a timestamp' };
  }
  if (p.addressTimeoutMs != null && !isInt(p.addressTimeoutMs, 1000, MAX_ADDRESS_TIMEOUT_MS)) return { ok: false, reason: `addressTimeoutMs must be 1000…${MAX_ADDRESS_TIMEOUT_MS}` };
  if (p.initTimeoutMs != null && !isInt(p.initTimeoutMs, 1000, MAX_INIT_TIMEOUT_MS)) return { ok: false, reason: `initTimeoutMs must be 1000…${MAX_INIT_TIMEOUT_MS}` };
  if (p.resolvers != null) {
    if (!Array.isArray(p.resolvers) || !p.resolvers.length || p.resolvers.length > 4 || p.resolvers.some((r) => !IPV4_RE.test(String(r)))) return { ok: false, reason: 'resolvers must be one to four IPv4 addresses' };
  }
  if (p.phases.includes('init_script')) {
    const s = p.initScript;
    if (!isPlainObject(s)) return { ok: false, reason: 'an init_script phase needs initScript { ref, sha256, bytes }' };
    for (const k of Object.keys(s)) if (!['ref', 'sha256', 'bytes'].includes(k)) return { ok: false, reason: `initScript.${k} is not a script reference field` };
    if (!INPUT_REF_RE.test(String(s.ref || ''))) return { ok: false, reason: 'initScript.ref must be an input reference' };
    if (!SHA256_RE.test(String(s.sha256 || ''))) return { ok: false, reason: 'initScript.sha256 must be a hex digest' };
    if (!isInt(s.bytes, 1, 1 << 20)) return { ok: false, reason: 'initScript.bytes must be the script size (1 byte to 1 MiB)' };
  } else if (p.initScript != null) {
    return { ok: false, reason: 'initScript applies to the init_script phase only' };
  }
  if (p.phases.includes('routes')) {
    const v = validateServices(p.services);
    if (!v.ok) return v;
    if (!SERVICE_NAME_RE.test(String(p.serviceName || ''))) return { ok: false, reason: 'serviceName must be the guest\'s service name' };
  } else if (p.services != null || p.serviceName != null) {
    return { ok: false, reason: 'services apply to the routes phase only' };
  }
  if (p.origin != null) {
    if (!isPlainObject(p.origin)) return { ok: false, reason: 'origin must name the job this setup follows' };
    if (p.origin.jobId != null && !INPUT_REF_RE.test(String(p.origin.jobId))) return { ok: false, reason: 'origin.jobId must be a job id' };
    if (p.origin.kind != null && !/^[a-z_]{1,32}$/.test(String(p.origin.kind))) return { ok: false, reason: 'origin.kind must be a job kind' };
  }
  if (p.retryOf != null && !INPUT_REF_RE.test(String(p.retryOf))) return { ok: false, reason: 'retryOf must be a job id' };
  if (JSON.stringify(p) !== JSON.stringify(redact(p))) return { ok: false, reason: 'the plan carries a value that looks like a secret; plans carry references only' };
  return { ok: true };
}

export function validateServices(services) {
  if (!Array.isArray(services) || !services.length) return { ok: false, reason: 'services must list at least one { domain, port }' };
  if (services.length > MAX_SERVICES) return { ok: false, reason: `at most ${MAX_SERVICES} services` };
  const seen = new Set();
  for (const s of services) {
    if (!isPlainObject(s)) return { ok: false, reason: 'every service is { domain, port, obtainCert?, healthPath? }' };
    for (const k of Object.keys(s)) if (!['domain', 'port', 'obtainCert', 'healthPath'].includes(k)) return { ok: false, reason: `service.${k} is not a service field` };
    if (!DOMAIN_RE.test(String(s.domain || ''))) return { ok: false, reason: `'${String(s.domain || '').slice(0, 60)}' is not a domain name` };
    const d = String(s.domain).toLowerCase();
    if (seen.has(d)) return { ok: false, reason: `${d} is listed twice` };
    seen.add(d);
    if (!isInt(s.port, 1, 65535)) return { ok: false, reason: `service ${d}: port must be 1…65535` };
    if (!isBool(s.obtainCert)) return { ok: false, reason: `service ${d}: obtainCert must be a boolean` };
    if (s.healthPath != null && (typeof s.healthPath !== 'string' || s.healthPath.length > HEALTH_PATH_MAX || !HEALTH_PATH_RE.test(s.healthPath))) return { ok: false, reason: `service ${d}: healthPath must start with / and contain only URL-safe characters` };
  }
  return { ok: true };
}

// validateRoutesParams(params) — the backend-executed `configure_routes` job.
export function validateRoutesParams(p = {}) {
  if (!isPlainObject(p)) return { ok: false, reason: 'params must be an object' };
  if (!CONTAINER_NAME_RE.test(String(p.container || ''))) return { ok: false, reason: 'container must be an Incus guest name' };
  if (!SERVICE_NAME_RE.test(String(p.serviceName || ''))) return { ok: false, reason: 'serviceName must be the guest\'s service name' };
  if (!IPV4_RE.test(String(p.ip || ''))) return { ok: false, reason: 'ip must be the guest\'s IPv4 address' };
  const v = validateServices(p.services);
  if (!v.ok) return v;
  if (p.command != null || p.script != null || p.argv != null) return { ok: false, reason: 'a routes job never carries a command' };
  if (JSON.stringify(p) !== JSON.stringify(redact(p))) return { ok: false, reason: 'the plan carries a value that looks like a secret' };
  return { ok: true };
}

// normalizeServices(raw) → the validated list a caller hands the plan, or
// { error }. Drops nothing silently: a bad entry is the caller's 400.
export function normalizeServices(raw) {
  if (!Array.isArray(raw)) return { services: [] };
  const out = [];
  for (const s of raw) {
    if (!s || typeof s !== 'object') return { error: 'every service is an object' };
    const domain = String(s.domain || '').trim().toLowerCase();
    if (!domain) continue;
    const port = Number.parseInt(s.port, 10);
    const entry = { domain, port: Number.isFinite(port) ? port : 80, obtainCert: s.obtainCert !== false };
    if (s.healthPath != null && s.healthPath !== '') entry.healthPath = String(s.healthPath);
    out.push(entry);
  }
  if (!out.length) return { services: [] };
  const v = validateServices(out);
  return v.ok ? { services: out } : { error: v.reason };
}

// ── the NAT phase: fixed host commands ──────────────────────────────────

export function ipForwardArgv() { return ['sysctl', '-w', 'net.ipv4.ip_forward=1']; }
export function networkListArgv() { return ['incus', 'network', 'list', '--format', 'json']; }
export function bridgeNatArgv(bridge) { return ['incus', 'network', 'set', bridgeName(bridge), 'ipv4.nat', 'true']; }
// DOCKER-USER: Docker sets FORWARD to DROP; the accept rules let bridge traffic through. Checked (-C) before inserted (-I).
export function dockerUserCheckArgv(bridge, dir) { return ['iptables', '-C', 'DOCKER-USER', dirFlag(dir), bridgeName(bridge), '-j', 'ACCEPT']; }
export function dockerUserInsertArgv(bridge, dir) { return ['iptables', '-I', 'DOCKER-USER', dirFlag(dir), bridgeName(bridge), '-j', 'ACCEPT']; }
export const MASQUERADE_RULE = Object.freeze(['-s', '10.0.0.0/8', '!', '-d', '10.0.0.0/8', '-j', 'MASQUERADE']);
export function masqueradeCheckArgv() { return ['iptables', '-t', 'nat', '-C', 'POSTROUTING', ...MASQUERADE_RULE]; }
export function masqueradeAppendArgv() { return ['iptables', '-t', 'nat', '-A', 'POSTROUTING', ...MASQUERADE_RULE]; }
function dirFlag(dir) { if (dir !== 'in' && dir !== 'out') throw new Error('direction is in or out'); return dir === 'in' ? '-i' : '-o'; }
function bridgeName(b) { const s = String(b); if (!BRIDGE_NAME_RE.test(s)) throw new Error(`'${s.slice(0, 20)}' is not a bridge name`); return s; }

// managedBridges(stdout) → the managed bridge names `incus network list`
// reported, each validated before it can become an argv element; a name the
// host reports that does not look like one is left out and named.
export function managedBridges(stdout) {
  let list;
  try { list = JSON.parse(String(stdout || '[]')); } catch { return { error: 'incus network list returned something that is not JSON', bridges: [], rejected: [] }; }
  if (!Array.isArray(list)) return { error: 'incus network list returned something that is not a list', bridges: [], rejected: [] };
  const bridges = []; const rejected = [];
  for (const n of list) {
    if (!n || n.type !== 'bridge' || n.managed !== true) continue;
    if (BRIDGE_NAME_RE.test(String(n.name || ''))) bridges.push(String(n.name)); else rejected.push(String(n.name || '?').slice(0, 20));
  }
  return { bridges, rejected };
}

// ── the address ─────────────────────────────────────────────────────────

const GUEST_INTERNAL_IFACE = [/^docker\d+$/, /^docker_gwbridge$/, /^br-[0-9a-f]+$/, /^veth/, /^cni\d*$/, /^virbr\d+$/, /^flannel/, /^cali/, /^tun\d+$/, /^tap\d+$/];
export function isGuestInternalInterface(name) { return GUEST_INTERNAL_IFACE.some((re) => re.test(String(name))); }

// hostReachableIpv4(instance) → { address, interface } | null: a global-scope
// IPv4 on eth0 first, then on any NIC device Incus attached (the bridge
// side), then on any other interface that is not a container runtime's own
// (docker0, br-*, veth*, cni*), which the host cannot route to.
export function hostReachableIpv4(instance) {
  const nets = instance?.state?.network;
  if (!nets || typeof nets !== 'object') return null;
  const devs = instance?.expanded_devices || instance?.devices || {};
  const nics = Object.entries(devs).filter(([, d]) => d && d.type === 'nic').map(([k, d]) => String(d.name || k));
  const pick = (name) => {
    const iface = nets[name];
    for (const a of iface?.addresses || []) {
      if (a?.family !== 'inet') continue;
      if (a.scope && a.scope !== 'global') continue;
      if (!IPV4_RE.test(String(a.address || '')) || String(a.address).startsWith('127.')) continue;
      return { address: a.address, interface: name };
    }
    return null;
  };
  if (nets.eth0) { const r = pick('eth0'); if (r) return r; }
  for (const n of nics) { if (n !== 'eth0' && nets[n]) { const r = pick(n); if (r) return r; } }
  for (const name of Object.keys(nets)) {
    if (name === 'lo' || name === 'eth0' || nics.includes(name) || isGuestInternalInterface(name)) continue;
    const r = pick(name); if (r) return r;
  }
  return null;
}

// ── the DNS phase: a guest script ───────────────────────────────────────

export function dnsScript({ resolvers = DEFAULT_RESOLVERS, resolvPath = '/etc/resolv.conf' } = {}) {
  const rs = (resolvers && resolvers.length ? resolvers : DEFAULT_RESOLVERS).map((r) => { const s = String(r); if (!IPV4_RE.test(s)) throw new Error('resolvers are IPv4 addresses'); return s; });
  if (!/^\/[A-Za-z0-9._\/-]+$/.test(resolvPath)) throw new Error('resolvPath must be an absolute path');
  const body = rs.map((r) => `nameserver ${r}\\n`).join('');
  return [
    `F='${resolvPath}'`,
    // The first resolver is the marker: present → nothing to do. The file is
    // removed first because it is often a symlink (systemd-resolved).
    `if grep -q '${rs[0]}' "$F" 2>/dev/null; then echo PP_DNS:unchanged; exit 0; fi`,
    `rm -f "$F" 2>/dev/null; if printf '${body}' > "$F" 2>/dev/null; then echo PP_DNS:written; else echo PP_DNS:failed; exit 1; fi`,
    '',
  ].join('\n');
}

export function parseDns(stdout) {
  const m = String(stdout || '').match(/^PP_DNS:(unchanged|written|failed)/m);
  return m ? m[1] : null;
}

// ── the init phase: guest scripts ───────────────────────────────────────

function initPaths(jobId, { logDir = INIT_LOG_DIR, tmpDir = INIT_TMP_DIR } = {}) {
  const id = String(jobId || '');
  if (!INPUT_REF_RE.test(id)) throw new Error('job id must be a plain identifier');
  for (const p of [logDir, tmpDir]) if (!/^\/[A-Za-z0-9._\/-]+$/.test(p)) throw new Error('init paths must be absolute');
  return { id, log: `${logDir}/pp-init-${id}.log`, rc: `${logDir}/pp-init-${id}.rc`, pid: `${logDir}/pp-init-${id}.pid`, script: `${tmpDir}/pp-init-${id}.sh`, logDir, tmpDir };
}

// initScriptWrapper({ jobId, b64 }) → the guest script that materialises
// the operator's script from base64, runs it under `sh` in its own session
// (so a timeout can kill the whole group), records its exit code in
// `<logDir>/pp-init-<job>.rc` and its output in `.log` — both survive the
// runner — and prints ONLY structured markers for the record:
// `PP_INIT_RC:<n>`, `PP_INIT_LOG:<path>`, `PP_INIT_LOG_BYTES:<n>`. The
// script's output is never printed back: a script may echo a credential,
// and nothing that leaves the guest lands in a job row, an event or an API
// answer. Every artifact (the script, the log, the exit code, the pid) is
// created under `umask 077` — owner-only from its first byte, whatever the
// guest's default umask — and the log is re-chmodded 0600 for good measure.
export function initScriptWrapper({ jobId, b64, logDir, tmpDir } = {}) {
  const P = initPaths(jobId, { logDir, tmpDir });
  if (typeof b64 !== 'string' || !/^[A-Za-z0-9+/=]+$/.test(b64)) throw new Error('the script body travels as base64');
  return [
    `umask 077`,
    `LOG='${P.log}'; RC='${P.rc}'; PIDF='${P.pid}'; S='${P.script}'`,
    `mkdir -p '${P.logDir}' '${P.tmpDir}' 2>/dev/null || true`,
    `rm -f "$RC" "$PIDF" "$S" "$LOG" 2>/dev/null`,
    `if ! printf '%s' '${b64}' | base64 -d > "$S" 2>/dev/null; then echo PP_INIT_WRITE_FAILED; rm -f "$S"; exit 96; fi`,
    `chmod 700 "$S" 2>/dev/null || true`,
    `if ! : > "$LOG" 2>/dev/null; then echo PP_INIT_WRITE_FAILED; rm -f "$S"; exit 96; fi`,
    `chmod 600 "$LOG" 2>/dev/null || true`,
    `if command -v setsid >/dev/null 2>&1; then setsid sh "$S" > "$LOG" 2>&1 < /dev/null & else sh "$S" > "$LOG" 2>&1 < /dev/null & fi`,
    `pid=$!; echo "$pid" > "$PIDF" 2>/dev/null; wait "$pid"; rc=$?`,
    `echo "$rc" > "$RC" 2>/dev/null; rm -f "$S" "$PIDF" 2>/dev/null`,
    `echo "PP_INIT_RC:$rc"`,
    `echo "PP_INIT_LOG:$LOG"`,
    `echo "PP_INIT_LOG_BYTES:$(wc -c < "$LOG" 2>/dev/null | tr -d ' ')"`,
    '',
  ].join('\n');
}

// initResultReadScript({ jobId }) → the script a RESUMED job runs instead of
// the wrapper: it reads what the guest recorded — the exit code, whether the
// recorded pid is still alive, the log's size — never the log's content, and
// never runs the script again.
export function initResultReadScript({ jobId, logDir, tmpDir } = {}) {
  const P = initPaths(jobId, { logDir, tmpDir });
  return [
    `umask 077`,
    `LOG='${P.log}'; RC='${P.rc}'; PIDF='${P.pid}'`,
    `if [ -f "$RC" ]; then echo "PP_INIT_RC:$(cat "$RC")"; else echo PP_INIT_RC:none; p=$(cat "$PIDF" 2>/dev/null); if [ -n "$p" ]; then if kill -0 "$p" 2>/dev/null; then echo "PP_INIT_RUNNING:$p"; else echo "PP_INIT_DEAD:$p"; fi; else echo PP_INIT_NOPID; fi; fi`,
    `echo "PP_INIT_LOG:$LOG"`,
    `[ -f "$LOG" ] && echo "PP_INIT_LOG_BYTES:$(wc -c < "$LOG" 2>/dev/null | tr -d ' ')"`,
    '',
  ].join('\n');
}

// initKillScript({ jobId, runDir }) → after a timeout: stops and inspects
// the COMPLETE writer group of this job's init attempt — the systemd scopes
// and raw cgroups its contained scripts recorded under `<runDir>/<job>.units`
// and `.cgroups` (guest-probes containedScript) — never the recorded pid
// alone. A `setsid()` descendant leaves the session group the wrapper
// started but never its cgroup, so the group is what is killed (TERM, then
// KILL, twice) and what is counted afterwards; zombies do not count. This
// script is issued UNCONTAINED (op-kit's contained guest would put it in the
// very group it kills), so `$$` is outside the group by construction.
// Verdicts, on one marker line, are the only thing the record carries:
//   PP_INIT_KILL:gone       every recorded group is empty; records removed
//   PP_INIT_KILL:alive <n>  n writers survived the kill
//   PP_INIT_KILL:norecord   no containment record: the writer group cannot be
//                           inspected (the recorded pid is killed best-effort)
//   PP_INIT_KILL:unknown    a group could not be inspected (no systemctl for
//                           a recorded scope, a cgroup tree no longer there)
// plus PP_INIT_GROUPS:<n>. Only `gone` releases the hold (setup-op).
// Signals are spelled `kill -s SIG` throughout: dash rejects `kill -KILL --
// -pgid` ("Illegal number"), which is how the pid-based predecessor of this
// script killed a leader and left its group behind.
export function initKillScript({ jobId, runDir = CONTAINMENT_RUN_DIR, logDir, tmpDir } = {}) {
  const P = initPaths(jobId, { logDir, tmpDir });
  if (!/^\/[A-Za-z0-9._\/-]+$/.test(runDir)) throw new Error('runDir must be an absolute path');
  return [
    `umask 077`,
    `RUN='${runDir}'; ID='${P.id}'; PIDF='${P.pid}'; S='${P.script}'; me=$$`,
    `UF="$RUN/$ID.units"; CF="$RUN/$ID.cgroups"`,
    // A killed process nobody has reaped yet is a zombie, not a writer.
    'alive() { st=$(sed -E "s/^[^)]*\\) //" /proc/$1/stat 2>/dev/null | cut -d" " -f1); [ -n "$st" ] && [ "$st" != "Z" ] && [ "$st" != "X" ]; }',
    'live_in() { c=0; for p in $(cat "$1" 2>/dev/null); do [ "$p" = "$me" ] && continue; alive "$p" && c=$((c + 1)); done; echo $c; }',
    `groups=0; [ -s "$UF" ] && groups=$((groups + $(grep -c . "$UF"))); [ -s "$CF" ] && groups=$((groups + $(grep -c . "$CF")))`,
    `p=$(cat "$PIDF" 2>/dev/null)`,
    // The wrapper bodies containment materialised for this job (a killed
    // wrapper never reached its own rm): the init script is in them.
    `for f in "$RUN/$ID".*; do case "$f" in *.units|*.cgroups) ;; *) rm -f "$f" 2>/dev/null;; esac; done`,
    // No record: the attempt's group cannot be inspected. The recorded pid's
    // session is killed on the way out, but that establishes nothing.
    `if [ "$groups" -eq 0 ]; then [ -n "$p" ] && { kill -s KILL -- "-$p" 2>/dev/null || kill -s KILL "$p" 2>/dev/null; sleep 1; }; rm -f "$S"; echo "PP_INIT_GROUPS:0"; echo PP_INIT_KILL:norecord; exit 0; fi`,
    'kill_groups() { for u in $(cat "$UF" 2>/dev/null); do systemctl kill --signal="$1" --kill-whom=all "$u" >/dev/null 2>&1 || true; done; for g in $(cat "$CF" 2>/dev/null); do [ -d "$g" ] || continue; if [ "$1" = KILL ] && [ -f "$g/cgroup.kill" ]; then echo 1 > "$g/cgroup.kill" 2>/dev/null || true; else for q in $(cat "$g/cgroup.procs" 2>/dev/null); do [ "$q" = "$me" ] || kill -s "$1" "$q" 2>/dev/null || true; done; fi; done; }',
    `kill_groups TERM; sleep 2; kill_groups KILL; sleep 1; kill_groups KILL`,
    `n=0; unknown=0`,
    // Each recorded scope: its live processes through its control group, or
    // the unit's own state; no systemctl at all is an inspection that failed.
    'for u in $(cat "$UF" 2>/dev/null); do if ! command -v systemctl >/dev/null 2>&1; then unknown=$((unknown + 1)); continue; fi; cg=$(systemctl show -p ControlGroup --value "$u" 2>/dev/null) || { unknown=$((unknown + 1)); continue; }; if [ -n "$cg" ] && [ -f "/sys/fs/cgroup$cg/cgroup.procs" ]; then n=$((n + $(live_in "/sys/fs/cgroup$cg/cgroup.procs"))); elif systemctl is-active --quiet "$u" 2>/dev/null; then n=$((n + 1)); fi; done',
    // Each recorded cgroup: its live processes; a group that is no longer
    // there is empty only while its tree still is.
    'for g in $(cat "$CF" 2>/dev/null); do if [ -d "$g" ]; then if [ -r "$g/cgroup.procs" ]; then l=$(live_in "$g/cgroup.procs"); n=$((n + l)); [ "$l" -eq 0 ] && rmdir "$g" 2>/dev/null; else unknown=$((unknown + 1)); fi; elif [ ! -f "$(dirname "$(dirname "$g")")/cgroup.procs" ]; then unknown=$((unknown + 1)); fi; done',
    `echo "PP_INIT_GROUPS:$groups"`,
    `if [ "$unknown" -gt 0 ]; then echo "PP_INIT_KILL:unknown $n"; elif [ "$n" -gt 0 ]; then echo "PP_INIT_KILL:alive $n"; else rm -f "$S" "$PIDF" "$UF" "$CF"; echo PP_INIT_KILL:gone; fi`,
    '',
  ].join('\n');
}

// parseInitResult(stdout) → { rc, recorded, running, dead, noPid, log,
// logBytes, writeFailed } from the markers alone. Anything else the guest
// printed is dropped here: the record carries structure, never output.
//   rc          the recorded exit code, or null
//   recorded    a PP_INIT_RC marker was seen (the wrapper / read-back ran)
//   running     the recorded pid that is still alive, or null
//   dead        the recorded pid is gone with no exit code (writer stopped, completion unknown)
//   noPid       nothing recorded at all
export function parseInitResult(stdout) {
  const s = String(stdout || '');
  const rcm = s.match(/^PP_INIT_RC:(\d+|none)/m);
  const run = s.match(/^PP_INIT_RUNNING:(\d+)/m);
  const dead = s.match(/^PP_INIT_DEAD:(\d+)/m);
  const log = s.match(/^PP_INIT_LOG:(\/[A-Za-z0-9._\/-]+)/m);
  const bytes = s.match(/^PP_INIT_LOG_BYTES:(\d+)/m);
  return {
    rc: rcm && rcm[1] !== 'none' ? Number(rcm[1]) : null, recorded: !!rcm,
    running: run ? Number(run[1]) : null, dead: dead ? Number(dead[1]) : null, noPid: /^PP_INIT_NOPID/m.test(s),
    log: log ? log[1] : null, logBytes: bytes ? Number(bytes[1]) : null,
    writeFailed: /^PP_INIT_WRITE_FAILED/m.test(s),
  };
}
export function initLogPath(jobId, { logDir } = {}) { return initPaths(jobId, { logDir }).log; }

// parseInitKill(stdout) → 'gone' | 'alive' | 'norecord' | 'unknown' | null;
// parseInitKillReport(stdout) adds the survivor and group counts.
export function parseInitKill(stdout) {
  const m = String(stdout || '').match(/^PP_INIT_KILL:(gone|alive|norecord|unknown)/m);
  return m ? m[1] : null;
}
export function parseInitKillReport(stdout) {
  const s = String(stdout || '');
  const m = s.match(/^PP_INIT_KILL:(gone|alive|norecord|unknown)(?: (\d+))?/m);
  const g = s.match(/^PP_INIT_GROUPS:(\d+)/m);
  return { verdict: m ? m[1] : null, survivors: m && m[2] != null ? Number(m[2]) : (m && m[1] === 'gone' ? 0 : null), groups: g ? Number(g[1]) : null };
}

// ── the record ──────────────────────────────────────────────────────────

// phaseTable(plan phases, recorded phases) → every REQUIRED phase with its
// state, `not_run` for the ones the record has nothing about.
export function phaseTable(required, recorded = {}) {
  const out = {};
  for (const ph of Array.isArray(required) ? required : []) out[ph] = recorded && recorded[ph] ? recorded[ph] : { state: 'not_run' };
  return out;
}

// setupOutcome(phases) → the reading of a phase table, the COMPLETION
// contract every surface shares (the job's outcome, the create-status
// answer, MCP's result, the future wizard):
//   { status: 'recovery_required', outcome: 'init_uncertain', completion: 'uncertain' }
//       the script's completion is unknown and not yet acknowledged: the
//       guest's lease is held until an operator establishes the writer stopped
//   { status: 'failed', outcome: 'setup_partial', completion: 'partial', failed: [...] }
//       a required phase failed, was refused, timed out, was skipped for
//       contention, or an acknowledged-uncertain / failed init a retry did not
//       repeat (its original result is kept, `notRepeated` recorded beside it)
//   { status: 'succeeded', outcome: 'setup_pending', completion: 'pending', pending: [...] }
//       nothing failed but a required phase is with another job (the routes)
//   { status: 'succeeded', outcome: 'setup_complete', completion: 'complete' }
// `status` is the job's EXECUTION status; `completion` is what the operator
// asked for. They are recorded separately and never conflated.
export function setupOutcome(phases) {
  const entries = Object.entries(phases || {});
  const uncertain = entries.filter(([, v]) => v.state === 'uncertain' && !v.acknowledged).map(([k]) => k);
  if (uncertain.length) return { status: 'recovery_required', outcome: 'init_uncertain', completion: 'uncertain', failed: entries.filter(([, v]) => v.state !== 'done' && v.state !== 'pending').map(([k]) => k), pending: [] };
  const failed = entries.filter(([, v]) => !['done', 'pending', 'skipped'].includes(v.state) || (v.state === 'skipped' && v.contended)).map(([k]) => k);
  if (failed.length) return { status: 'failed', outcome: 'setup_partial', completion: 'partial', failed, pending: entries.filter(([, v]) => v.state === 'pending').map(([k]) => k) };
  const pending = entries.filter(([, v]) => v.state === 'pending').map(([k]) => k);
  if (pending.length) return { status: 'succeeded', outcome: 'setup_pending', completion: 'pending', failed: [], pending };
  return { status: 'succeeded', outcome: 'setup_complete', completion: 'complete', failed: [], pending: [] };
}

// phaseSummary(phases) → one line naming every phase and its state, for
// reasons and labels; details are bounded and never carry script output.
export function phaseSummary(phases) {
  return Object.entries(phases || {}).map(([k, v]) => `${k}: ${v.state}${v.notRepeated ? ' (not repeated)' : ''}${v.state !== 'done' && v.detail ? ` (${String(v.detail).slice(0, 120)})` : ''}`).join('; ');
}

// initWarning(phase) → the sentence the dashboard shows for an init script
// that did not end cleanly, or null. It names the log inside the guest; it
// never carries the script's output.
export function initWarning(ph) {
  if (!ph || ph.state === 'done' || ph.state === 'not_run' || ph.state === 'pending') return null;
  const log = ph.log || `/var/log/pp-init-${ph.job || '<job>'}.log`;
  const again = ph.notRepeated ? ' (from the attempt this setup retried; not run again)' : '';
  if (ph.state === 'skipped') return ph.detail ? `Init script not run: ${ph.detail}` : null;
  if (ph.state === 'timed_out') return `Init script timed out after ${Math.round((ph.timeoutMs || DEFAULT_INIT_TIMEOUT_MS) / 60000)} minute(s) and was stopped${again} — its output is in ${log} inside the container; finish setup manually.`;
  if (ph.state === 'uncertain') return `Init script outcome unknown${ph.acknowledged ? ' (acknowledged)' : ''}: ${ph.detail || 'the runner died while it ran'} — read ${log} and ${log.replace(/\.log$/, '.rc')} inside the container${ph.acknowledged ? '' : '; the guest is held until the job is acknowledged'}.`;
  if (ph.state === 'failed' && ph.rc != null) return `Init script exited with code ${ph.rc}${again}; its output (${ph.logBytes != null ? `${ph.logBytes} bytes` : 'see the log'}) is in ${log} inside the container.`;
  return `Init script ${ph.state}: ${ph.detail || 'see the setup job'}`;
}

export function routesWarning(ph) {
  if (!ph || ['done', 'not_run', 'pending'].includes(ph.state)) return ph && ph.state === 'done' && ph.conflicts?.length ? `${ph.conflicts.map((c) => c.domain).join(', ')} already routed elsewhere and not added.` : null;
  if (ph.state === 'skipped') return ph.detail ? `Routes not configured: ${ph.detail}` : null;
  return `Routes ${ph.state}: ${ph.detail || 'see the setup job'}`;
}

// createStatusView({ create, setup, routes, nowMs }) → the create-status
// answer derived from the records alone (the shape the dashboard polls):
// { phase, message, error, ip, initScriptWarning, caddyWarning, elapsed,
//   jobId, setupJobId, routesJobId }. `create`, `setup`, `routes` are job
// rows through jobView (progress / checkpoint parsed) or null.
export function createStatusView({ create, setup = null, routes = null, nowMs = Date.now() }) {
  if (!create) return null;
  const base = { jobId: create.id, setupJobId: setup?.id || create.progress?.setup_job_id || null, routesJobId: routes?.id || setup?.progress?.routes_job_id || null, elapsed: Math.max(0, Math.round((nowMs - Date.parse(create.created_at || 0)) / 1000)), ip: null, initScriptWarning: null, caddyWarning: null, error: null };
  if (create.status === 'queued') return { ...base, phase: 'downloading', message: 'Waiting for the host runner…' };
  if (create.status === 'running') return { ...base, phase: 'downloading', message: create.phase === 'validated' || create.phase === 'query' ? 'Checking the name and the image…' : 'Downloading the image and launching…' };
  if (create.status !== 'succeeded') return { ...base, phase: 'failed', message: create.reason || `Launch ${create.status}`, error: create.reason || `Launch ${create.status}` };
  if (!base.setupJobId) return { ...base, phase: 'ready', message: 'Container is ready', ip: create.progress?.result?.address?.ip || null };
  if (!setup) return { ...base, phase: 'configuring', message: 'Configuring container…' };
  const phases = setup.progress?.phases || {};
  base.ip = setup.progress?.address?.ip || null;
  if (setup.status === 'queued') return { ...base, phase: 'configuring', message: 'Configuring container…' };
  if (setup.status === 'running') {
    const ph = setup.phase || '';
    if (/init_script/.test(ph)) return { ...base, phase: 'init-script', message: 'Running init script…' };
    if (/await_address|dns/.test(ph)) return { ...base, phase: 'network', message: 'Waiting for network…' };
    if (/routes/.test(ph)) return { ...base, phase: 'caddy', message: 'Configuring reverse proxy…' };
    return { ...base, phase: 'configuring', message: 'Configuring container…' };
  }
  // The setup job is terminal. Routes may still be with the backend.
  const routesPhase = phases.routes || null;
  const routesOpen = routesPhase && routesPhase.state === 'pending' && (!routes || ['queued', 'running'].includes(routes.status));
  if (routesOpen) return { ...base, phase: 'caddy', message: 'Configuring reverse proxy…', completion: 'pending' };
  let routesView = routesPhase;
  if (routesPhase && routesPhase.state === 'pending' && routes && !['queued', 'running'].includes(routes.status)) {
    // The routes job ended without annotating the setup record (its owner died): read its own row.
    routesView = routes.status === 'succeeded' ? { state: 'done', conflicts: routes.progress?.result?.conflicts || [] } : { state: routes.status === 'cancelled' ? 'skipped' : 'failed', detail: routes.reason || `routes ${routes.status}` };
  }
  const completion = setupOutcome({ ...phases, ...(routesView ? { routes: routesView } : {}) }).completion;
  const out = { ...base, phase: 'ready', message: 'Container is ready', completion, initScriptWarning: initWarning(phases.init_script), caddyWarning: routesWarning(routesView) };
  if (completion !== 'complete') out.message = completion === 'uncertain' ? 'Container is running; its init script has an unknown outcome and the container is held until the setup job is acknowledged' : `Container is running; setup ${completion}${setup.reason ? `: ${setup.reason}` : ''}`;
  return out;
}
