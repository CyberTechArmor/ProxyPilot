// Owned platform containers — what every service adapter shares (3a, 3b).
//
//   LOG_ARGS                 docker create flags: log driver `local`, 10 MB x 3,
//                            whatever the daemon default is (the Fractionate
//                            host's default could not be read back)
//   logConfigCurrent(h)      does an inspected HostConfig carry exactly that?
//   classifyDockerError(txt) → image_pull | port_bind | mount_permission | null
//   dockerFailure(...)       the adapter-safe error for a failed docker call:
//                            the reason code plus one redacted line of the
//                            daemon's own message — a local cause is never
//                            reported as "upstream details withheld"
//   startOwnedContainer(...) start by inspected ID, wait for running and then
//                            healthy (image HEALTHCHECK when present), bounded;
//                            on failure record the reason code, State.Error
//                            and the last redacted log lines in the job events
//   readContainerLogs(...)   the last N redacted lines of one container, with
//                            the journald fallback and a stated reason when
//                            the driver cannot be read
//
// `run(argv)` is a host command runner returning { code, stdout, stderr }
// (the host runner's exec.host); `runHostCapture` results ({ status }) are
// accepted too.

import { redactText } from './logic.js';

export const LOG_DRIVER = 'local';
export const LOG_OPTS = Object.freeze({ 'max-size': '10m', 'max-file': '3' });
export const LOG_ARGS = Object.freeze(['--log-driver', LOG_DRIVER, ...Object.entries(LOG_OPTS).flatMap(([k, v]) => ['--log-opt', `${k}=${v}`])]);
export const REASON_CODES = Object.freeze(['image_pull', 'port_bind', 'mount_permission', 'start_timeout', 'health_timeout', 'exited', 'upstream_not_listening', 'dns_mismatch']);

export function logConfigCurrent(hostConfig) {
  const l = hostConfig?.LogConfig;
  return l?.Type === LOG_DRIVER && Object.entries(LOG_OPTS).every(([k, v]) => l.Config?.[k] === v);
}

const norm = (r) => ({ code: r?.code ?? r?.status ?? -1, stdout: String(r?.stdout || ''), stderr: String(r?.stderr || '') });

export function classifyDockerError(text) {
  const t = String(text || '');
  if (/pull access denied|manifest (?:for .* )?unknown|repository does not exist|no such image|failed to resolve reference|toomanyrequests|error pulling image|unable to find image/i.test(t)) return 'image_pull';
  if (/port is already allocated|address already in use|bind: |failed to bind|ports are not available/i.test(t)) return 'port_bind';
  if (/permission denied|operation not permitted|error mounting|invalid mount|mount .*(?:denied|failed)|no such file or directory.*mount|bind source path does not exist/i.test(t)) return 'mount_permission';
  return null;
}

/** One redacted, bounded line of the daemon's own message. */
export function daemonLine(text) {
  const line = String(text || '').split('\n').map((l) => l.trim()).filter(Boolean).find((l) => !/^\[timeout/.test(l)) || '';
  return redactText(line.replace(/^Error response from daemon:\s*/i, '')).slice(0, 240);
}

/** A reason-coded, adapter-safe error for a failed docker command. */
export function dockerFailure(fail, label, result) {
  const r = norm(result);
  const code = classifyDockerError(r.stderr) || (r.code === 124 ? 'start_timeout' : null);
  // The daemon's own line is quoted only when it names a known local cause;
  // any other daemon text stays out of the record (it may echo arguments).
  const line = code && code !== 'start_timeout' ? daemonLine(r.stderr) : '';
  const e = fail(`${label} failed on this host (${code ? `reason code: ${code}` : `docker exit ${r.code}`})${line ? `: ${line}` : ''}. Data and credentials are retained; the owned resource can be inspected on the host.`);
  if (code) e.reasonCode = code;
  return e;
}

/** Pull the reason code back out of a recorded job reason (for the overview). */
export function reasonCodeOf(text) {
  const m = /reason code: (exited:-?\d+|[a-z_]+)/.exec(String(text || ''));
  return m ? m[1] : null;
}

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

async function inspectOne(run, ref) {
  const r = norm(await run(['docker', 'container', 'inspect', ref]));
  if (r.code !== 0) return null;
  try { const v = JSON.parse(r.stdout); return Array.isArray(v) ? v[0] || null : null; } catch { return null; }
}

/**
 * Start one owned container by its inspected immutable ID and wait until it
 * is running and (when the image defines a HEALTHCHECK) healthy.
 *   { run, name, fail, job?, label?, startTimeoutMs, healthTimeoutMs, pollMs, sleep, requireHealth }
 * Returns { id, already, health }. Already running and healthy → nothing is
 * started (a retry continues from there, nothing is recreated).
 */
export async function startOwnedContainer({ run, name, fail, job = null, label = name, startTimeoutMs = 60000, healthTimeoutMs = 180000, pollMs = 2000, sleep = sleepMs, requireHealth = true, now = () => Date.now() }) {
  const fence = () => job?.fence?.();
  fence();
  let a = await inspectOne(run, name);
  if (!a?.Id) throw fail(`${label}: the container could not be inspected before start. Data and credentials are retained.`);
  const id = a.Id;
  // Polls re-read by name (ownership was established on it) and refuse a
  // container whose immutable ID changed underneath the start.
  const current = async () => { const x = await inspectOne(run, name); if (x && x.Id !== id) throw fail(`${label}: the container was replaced during start (ID changed). Nothing further was started.`); return x || a; };
  const healthy = (x) => !x.State?.Health || x.State.Health.Status === 'healthy';
  if (a.State?.Running && healthy(a)) return { id, already: true, health: a.State?.Health?.Status || 'none' };
  const failWith = async (code, extra = '') => {
    const latest = (await inspectOne(run, name)) || a;
    const stateError = redactText(String(latest.State?.Error || '')).slice(0, 300);
    const logs = await readContainerLogs({ run, name, id, lines: 30, inspected: latest }).catch(() => null);
    try { job?.event?.('runtime_failure', `${label}: ${code}`, { reason_code: code, container: name, status: latest.State?.Status || null, exit_code: latest.State?.ExitCode ?? null, state_error: stateError || null, log_tail: logs?.lines?.slice(-30) || null, logs_unreadable: logs?.readable === false ? logs.reason : null }); } catch { /* the event log is best effort; the reason below is the record */ }
    const e = fail(`${label} did not come up (reason code: ${code})${stateError ? `: ${stateError}` : extra ? `: ${extra}` : ''}. The last log lines are in this job's events; data and credentials are retained.`);
    e.reasonCode = code; return e;
  };
  if (!a.State?.Running) {
    fence();
    const s = norm(await run(['docker', 'start', id]));
    fence();
    if (s.code !== 0) {
      const code = classifyDockerError(s.stderr);
      a = (await inspectOne(run, name)) || a;
      if (code) throw await failWith(code, daemonLine(s.stderr));
      if (['exited', 'dead'].includes(a.State?.Status) && a.State?.StartedAt && !a.State.StartedAt.startsWith('0001')) throw await failWith(`exited:${a.State.ExitCode ?? '?'}`);
      throw await failWith('start_timeout', `docker start exited ${s.code}`);
    }
  }
  const t0 = now();
  for (;;) {
    fence();
    a = await current();
    if (a.State?.Running) break;
    if (['exited', 'dead'].includes(a.State?.Status)) throw await failWith(`exited:${a.State.ExitCode ?? '?'}`);
    if (now() - t0 >= startTimeoutMs) throw await failWith('start_timeout');
    await sleep(pollMs);
  }
  if (!requireHealth || !a.State?.Health) return { id, already: false, health: a.State?.Health?.Status || 'none' };
  const t1 = now();
  for (;;) {
    fence();
    a = await current();
    if (!a.State?.Running) throw await failWith(`exited:${a.State?.ExitCode ?? '?'}`);
    if (a.State.Health?.Status === 'healthy') return { id, already: false, health: 'healthy' };
    if (now() - t1 >= healthTimeoutMs) throw await failWith('health_timeout', `health is ${a.State.Health?.Status || 'unknown'}`);
    await sleep(pollMs);
  }
}

/**
 * The last `lines` log lines of one container, redacted (and scrubbed of this
 * installation's known protected values by `scrub`, when given).
 * → { readable: true, driver, source, lines: [...] } | { readable: false, driver, reason }
 */
export async function readContainerLogs({ run, name, id = null, lines = 50, inspected = null, scrub = (s) => s }) {
  const n = Math.max(1, Math.min(1000, Number(lines) || 50));
  const a = inspected || (await inspectOne(run, id || name));
  if (!a) return { readable: false, driver: null, reason: `${name} is not present on this host.` };
  const driver = a.HostConfig?.LogConfig?.Type || null;
  const clean = (text) => String(text || '').split('\n').filter((l) => l.trim()).slice(-n).map((l) => scrub(redactText(l)).slice(0, 2000));
  if (driver === 'none') return { readable: false, driver, reason: `${name} was created with log driver "none", so Docker kept no logs. Run Repair (or Reinstall) — the adapter recreates it with the readable "local" driver, data retained.` };
  if (driver === 'journald') {
    const j = norm(await run(['journalctl', `CONTAINER_NAME=${name}`, '-n', String(n), '--no-pager', '-o', 'cat']));
    if (j.code !== 0) return { readable: false, driver, reason: `The journald driver is in use and journalctl could not read ${name}${daemonLine(j.stderr) ? `: ${daemonLine(j.stderr)}` : '.'}` };
    return { readable: true, driver, source: 'journalctl', lines: clean(j.stdout) };
  }
  const r = norm(await run(['docker', 'logs', '--tail', String(n), '--timestamps', a.Id || id || name]));
  if (r.code !== 0) return { readable: false, driver, reason: /does not support reading/i.test(r.stderr) ? `The "${driver}" log driver does not support reading. Repair recreates ${name} with the readable "local" driver.` : `docker logs failed${daemonLine(r.stderr) ? `: ${daemonLine(r.stderr)}` : '.'}` };
  // stdout and stderr arrive on separate pipes; merge them back by timestamp.
  const merged = [...r.stdout.split('\n'), ...r.stderr.split('\n')].filter((l) => l.trim()).sort().slice(-n).map((l) => l.replace(/^(\S+)\s/, (_, ts) => `${ts} `));
  return { readable: true, driver, source: 'docker logs', lines: clean(merged.join('\n')) };
}

/** Is anything listening on 127.0.0.1:<port>? (`ss -ltnH` on the host.) → true | false | null */
export async function portListening(run, port) {
  const r = norm(await run(['ss', '-ltnH']));
  if (r.code !== 0) return null;
  return listeningPorts(r.stdout).has(Number(port));
}

export function listeningPorts(ssOutput) {
  return new Set(String(ssOutput || '').split('\n').map((l) => l.trim().split(/\s+/)[3] || '').map((a) => Number(a.slice(a.lastIndexOf(':') + 1))).filter(Boolean));
}
