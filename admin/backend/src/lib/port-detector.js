// Port detection for LXC-hosted services.
//
// Phase 2c moves port discovery from a one-shot diagnostic (only
// surfaced when an existing route's TCP probe fails) into a
// first-class always-visible signal on the service detail panel:
// the operator wants to see every port the workload is actually
// listening on so they can choose to expose it as an HTTP route or
// an L4 forward without opening a host shell.
//
// Three things change vs the existing lxc.js helper:
//
//   1. UDP is now in scope. /proc/net/udp{,6} is read alongside
//      /proc/net/tcp{,6}; UDP sockets don't have a LISTEN state so
//      we treat every non-loopback bind as exposed. This is
//      mandatory for the MEET workload (10000-port WebRTC range).
//
//   2. Contiguous runs collapse into a single "range" chip when
//      they reach a configurable threshold (default 8). Without
//      this the UI renders 10001 chips for the WebRTC range, which
//      is unusable. The threshold is intentionally generous so a
//      handful of adjacent service ports doesn't accidentally
//      collapse — only the obvious bulk allocations do.
//
//   3. Docker-in-LXC stacks need a health gate. Compose stacks
//      (LiveKit, Postgres, anything with a startup ordering) often
//      take 30s+ to become reachable; reading /proc/net/{tcp,udp}
//      before the containers are up returns an empty list and the
//      operator sees an empty chip row. The detector now probes
//      for a compose file and, if one is present, polls
//      `docker compose ps --format json` until every service is
//      `running` (+ `healthy` if a healthcheck is defined) or the
//      timeout expires, then surfaces the table either way so a
//      stuck container is visible instead of hidden.
//
// The module exports pure helpers for unit testing plus a single
// orchestrator (`detectServicePorts`) the route layer uses.

const DEFAULT_RANGE_THRESHOLD = 8;
const DEFAULT_COMPOSE_HEALTH_TIMEOUT_MS = 60_000;
const DEFAULT_COMPOSE_HEALTH_INTERVAL_MS = 2_000;

/**
 * Parse one /proc/net/{tcp,udp}{,6} body and return the set of ports
 * the kernel reports as bound. Caller decides which file (tcp vs udp)
 * the body came from; this function is pure parsing.
 *
 * For TCP: only state '0A' (TCP_LISTEN) counts. For UDP: there is no
 * LISTEN state — UDP sockets are either bound or not, so every row
 * with a non-zero local port counts.
 *
 * Returns { anyHost: Set<number>, loopbackOnly: Set<number> }.
 * loopbackOnly excludes ports also seen on a non-loopback bind (a
 * service bound to both 0.0.0.0 and 127.0.0.1 reads as anyHost).
 */
export function parseProcNet(body, { proto }) {
  const anyHost = new Set();
  const loopbackOnly = new Set();
  if (typeof body !== 'string' || body.length === 0) {
    return { anyHost, loopbackOnly };
  }
  const wantState = proto === 'tcp' ? '0A' : null; // null = accept any state
  const lines = body.split('\n');
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('sl')) continue;
    const cols = line.split(/\s+/);
    if (cols.length < 4) continue;
    const local = cols[1];
    const state = cols[3];
    if (wantState && state !== wantState) continue;
    const colonIdx = local.lastIndexOf(':');
    if (colonIdx < 0) continue;
    const ipHex = local.slice(0, colonIdx);
    const portHex = local.slice(colonIdx + 1);
    const port = parseInt(portHex, 16);
    if (!port) continue;

    let isLoopback = false;
    let isAnyAddr = false;
    if (ipHex.length === 8) {
      // IPv4: little-endian per byte. 0100007F → 7F.00.00.01 → 127.0.0.1
      const b3 = parseInt(ipHex.slice(6, 8), 16);
      const b2 = parseInt(ipHex.slice(4, 6), 16);
      const b1 = parseInt(ipHex.slice(2, 4), 16);
      const b0 = parseInt(ipHex.slice(0, 2), 16);
      const ipStr = `${b3}.${b2}.${b1}.${b0}`;
      if (ipStr === '0.0.0.0') isAnyAddr = true;
      else if (b3 === 127) isLoopback = true;
    } else if (ipHex.length === 32) {
      const upper = ipHex.toUpperCase();
      if (upper === '00000000000000000000000000000000') {
        isAnyAddr = true;
      } else if (upper === '00000000000000000000000001000000') {
        isLoopback = true;
      } else if (upper.slice(16, 24) === '0000FFFF') {
        const v4hex = upper.slice(24, 32);
        const b0 = parseInt(v4hex.slice(0, 2), 16);
        const b3 = parseInt(v4hex.slice(6, 8), 16);
        if (b0 === 0 && b3 === 0) isAnyAddr = true;
        else if (b3 === 127) isLoopback = true;
      }
      // Other v6 binds (link-local, ULA, GUA) → treat as reachable.
    }
    if (isAnyAddr) anyHost.add(port);
    else if (isLoopback) loopbackOnly.add(port);
    else anyHost.add(port);
  }
  for (const p of anyHost) loopbackOnly.delete(p);
  return { anyHost, loopbackOnly };
}

/**
 * Collapse contiguous runs of ports into ranges. Returns a list of
 * { port, port_end? } shapes ready to persist as service_detected_ports
 * rows. Single ports get just `port`; ranges get both `port` (the
 * start) and `port_end` (inclusive end).
 *
 * The threshold is the smallest run that becomes a range. With the
 * default of 8 a run of 7 contiguous ports renders as 7 individual
 * chips (still legible), while a run of 10000 collapses into one chip
 * that obviously can't be reverse-proxied — the UI uses the
 * range-vs-single distinction to disable the "Add as HTTP route"
 * button (Caddy can't route a port range).
 */
export function collapseRanges(ports, threshold = DEFAULT_RANGE_THRESHOLD) {
  const sorted = [...new Set(ports)].sort((a, b) => a - b);
  const out = [];
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
    const runLen = j - i + 1;
    if (runLen >= threshold) {
      out.push({ port: sorted[i], port_end: sorted[j] });
    } else {
      for (let k = i; k <= j; k++) out.push({ port: sorted[k] });
    }
    i = j + 1;
  }
  return out;
}

/**
 * Read /proc/net/{tcp,udp}{,6} from inside an LXC and return a
 * normalized port set. `execHost` is injected so the route layer can
 * pass its own execOnHost (Docker-in-pod or bare-metal both work);
 * tests pass a stub that returns canned bodies.
 *
 * Returns:
 *   { tcp: { anyHost: number[], loopbackOnly: number[] },
 *     udp: { anyHost: number[], loopbackOnly: number[] },
 *     error: string | null }
 *
 * On any /proc read failure the matching slice is empty and `error`
 * is the stderr text — the caller renders that string in the UI
 * instead of silently showing zero ports.
 */
export async function readListeningPorts(incusName, { execHost, timeoutMs = 5000 } = {}) {
  if (typeof execHost !== 'function') {
    throw new Error('readListeningPorts: execHost function is required');
  }
  // Two parallel exec calls (one for TCP, one for UDP) so the
  // parser sees clean per-protocol bodies — alternative would be a
  // single concat read with an in-band separator, which is fragile
  // when the LXC is missing one of the procfs files.
  const tcpCmd = `incus exec ${incusName} -- sh -c ${JSON.stringify('cat /proc/net/tcp /proc/net/tcp6 2>/dev/null')}`;
  const udpCmd = `incus exec ${incusName} -- sh -c ${JSON.stringify('cat /proc/net/udp /proc/net/udp6 2>/dev/null')}`;
  let tcpBody = '';
  let udpBody = '';
  let errMsg = null;
  try {
    const [tcpRes, udpRes] = await Promise.all([
      execHost(tcpCmd, { timeout: timeoutMs }),
      execHost(udpCmd, { timeout: timeoutMs }),
    ]);
    tcpBody = (tcpRes.stdout || '').toString();
    udpBody = (udpRes.stdout || '').toString();
    const stderrJoined = `${tcpRes.stderr || ''}${udpRes.stderr || ''}`.trim();
    if (!tcpBody && !udpBody && stderrJoined) errMsg = stderrJoined;
  } catch (e) {
    errMsg = ((e && (e.stderr || e.message)) || 'introspect failed').toString().trim();
  }

  const tcp = parseProcNet(tcpBody, { proto: 'tcp' });
  const udp = parseProcNet(udpBody, { proto: 'udp' });
  return {
    tcp: {
      anyHost: [...tcp.anyHost].sort((a, b) => a - b),
      loopbackOnly: [...tcp.loopbackOnly].sort((a, b) => a - b),
    },
    udp: {
      anyHost: [...udp.anyHost].sort((a, b) => a - b),
      loopbackOnly: [...udp.loopbackOnly].sort((a, b) => a - b),
    },
    error: errMsg,
  };
}

/**
 * Probe an LXC for `docker compose` and a `docker-compose.yml` (or
 * `compose.yml`) at one of a few common workdirs. Returns the first
 * directory that has a compose file, or null when the LXC isn't a
 * compose stack (which is the most common case — a plain LXC running
 * a single binary doesn't need the health gate at all).
 *
 * The candidate list is intentionally short. Operators who deploy
 * compose stacks at unusual paths can pass `extraDirs` so the
 * detector picks them up without the LXC needing to advertise
 * anything.
 */
export async function detectComposeDir(
  incusName,
  { execHost, extraDirs = [], timeoutMs = 5000 } = {}
) {
  if (typeof execHost !== 'function') {
    throw new Error('detectComposeDir: execHost function is required');
  }
  // Probe `docker compose version` first — if the binary isn't
  // available the rest is moot and we save a few exec round trips.
  try {
    await execHost(`incus exec ${incusName} -- docker compose version`, {
      timeout: timeoutMs,
    });
  } catch {
    return null;
  }
  const candidates = [
    ...extraDirs,
    '/opt/meet',
    '/opt/stack',
    '/srv/compose',
    '/root/compose',
    '/root',
  ];
  for (const dir of candidates) {
    const inner = `for f in compose.yml compose.yaml docker-compose.yml docker-compose.yaml; do test -f ${shellEscape(dir)}/$f && echo $f && exit 0; done; exit 1`;
    try {
      const r = await execHost(
        `incus exec ${incusName} -- sh -c ${JSON.stringify(inner)}`,
        { timeout: timeoutMs }
      );
      if (r && (r.stdout || '').trim()) return dir;
    } catch {
      // try next dir
    }
  }
  return null;
}

/**
 * Wait for `docker compose ps` to report every service as `running`
 * (+ `healthy` if a healthcheck is configured) or until the timeout.
 *
 * Always returns the final ps table so the caller can render it in
 * the UI on both success and failure — the failure case is the one
 * we explicitly want surfaced (today's code returns empty and the
 * service detail panel looks blank).
 *
 * Returns: { ready: boolean, table: Array<{name,state,health}>, error?: string }
 */
export async function waitForComposeHealthy(
  incusName,
  composeDir,
  {
    execHost,
    timeoutMs = DEFAULT_COMPOSE_HEALTH_TIMEOUT_MS,
    intervalMs = DEFAULT_COMPOSE_HEALTH_INTERVAL_MS,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  } = {}
) {
  if (typeof execHost !== 'function') {
    throw new Error('waitForComposeHealthy: execHost function is required');
  }
  const cmd = `incus exec ${incusName} -- sh -c ${JSON.stringify(`cd ${shellEscape(composeDir)} && docker compose ps --format json`)}`;
  const deadline = Date.now() + timeoutMs;
  let lastTable = [];
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const r = await execHost(cmd, { timeout: 10_000 });
      const stdout = (r && r.stdout) || '';
      const table = parseComposePs(stdout);
      lastTable = table;
      const allReady = table.length > 0 && table.every((row) => isComposeRowReady(row));
      if (allReady) return { ready: true, table };
    } catch (e) {
      lastError = ((e && (e.stderr || e.message)) || '').toString().trim() || null;
    }
    if (Date.now() + intervalMs >= deadline) break;
    await sleep(intervalMs);
  }
  return { ready: false, table: lastTable, error: lastError };
}

/**
 * Parse `docker compose ps --format json` output. Modern Compose
 * (v2.20+) prints one JSON object per line; older versions print a
 * single JSON array. Handle both shapes so the detector works across
 * the compose versions Operators actually have installed.
 */
export function parseComposePs(stdout) {
  const trimmed = (stdout || '').trim();
  if (!trimmed) return [];
  // Array shape: `[ { ... }, { ... } ]`
  if (trimmed.startsWith('[')) {
    try {
      const arr = JSON.parse(trimmed);
      if (Array.isArray(arr)) return arr.map(normalizeComposeRow);
    } catch {
      return [];
    }
  }
  // Lines shape: one JSON object per line.
  const rows = [];
  for (const line of trimmed.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      rows.push(normalizeComposeRow(JSON.parse(t)));
    } catch {
      // skip malformed line; keep going
    }
  }
  return rows;
}

function normalizeComposeRow(raw) {
  // Compose CLI keys are PascalCase; normalize so consumers don't
  // have to know which version produced the row.
  return {
    name: raw.Name || raw.name || '',
    service: raw.Service || raw.service || '',
    state: (raw.State || raw.state || '').toLowerCase(),
    health: (raw.Health || raw.health || '').toLowerCase() || null,
  };
}

function isComposeRowReady(row) {
  if (row.state !== 'running') return false;
  // No healthcheck configured → an empty/missing health field counts
  // as ready (the operator didn't ask for anything stronger). When a
  // healthcheck IS configured we wait for it to flip to 'healthy';
  // 'starting' and 'unhealthy' both block.
  if (!row.health) return true;
  return row.health === 'healthy';
}

/**
 * Persist a detection result into service_detected_ports. Replaces
 * every row for (service_id, source) atomically so a rescan can't
 * leave stale chips on the panel.
 *
 * `entries` is the post-collapse list of port descriptors:
 *   [ { proto, port, port_end? }, ... ]
 *
 * Returns the number of rows persisted.
 */
export function cacheDetectedPorts(db, serviceId, entries, { source = 'proc_net' } = {}) {
  if (!serviceId) throw new Error('cacheDetectedPorts: serviceId is required');
  const now = new Date().toISOString();
  const tx = db.transaction(() => {
    db.prepare(
      `DELETE FROM service_detected_ports WHERE service_id = ? AND source = ?`
    ).run(serviceId, source);
    const insert = db.prepare(
      `INSERT INTO service_detected_ports
         (service_id, proto, port, port_end, source, detected_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    for (const e of entries) {
      insert.run(serviceId, e.proto, e.port, e.port_end ?? null, source, now);
    }
  });
  tx();
  return entries.length;
}

/**
 * High-level orchestrator: optionally wait for a compose stack to be
 * healthy, then read /proc/net, collapse contiguous runs into ranges,
 * and (if `db` + `serviceId` are passed) persist the result.
 *
 * Returns a structured result the route layer can return verbatim:
 *
 *   { ports: [ { proto, port, port_end? }, ... ],
 *     loopbackOnly: { tcp: number[], udp: number[] },
 *     compose: { dir, ready, table, error } | null,
 *     scanError: string | null }
 *
 * The compose block is null when the LXC isn't a compose stack.
 */
export async function detectServicePorts({
  incusName,
  execHost,
  rangeThreshold = DEFAULT_RANGE_THRESHOLD,
  composeOpts = {},
  extraComposeDirs = [],
  db = null,
  serviceId = null,
}) {
  let composeBlock = null;
  const composeDir = await detectComposeDir(incusName, {
    execHost,
    extraDirs: extraComposeDirs,
  });
  if (composeDir) {
    const wait = await waitForComposeHealthy(incusName, composeDir, {
      execHost,
      ...composeOpts,
    });
    composeBlock = { dir: composeDir, ...wait };
  }

  const procResult = await readListeningPorts(incusName, { execHost });
  const tcpEntries = collapseRanges(procResult.tcp.anyHost, rangeThreshold).map(
    (e) => ({ proto: 'tcp', ...e })
  );
  const udpEntries = collapseRanges(procResult.udp.anyHost, rangeThreshold).map(
    (e) => ({ proto: 'udp', ...e })
  );
  const ports = [...tcpEntries, ...udpEntries];

  if (db && serviceId) {
    cacheDetectedPorts(db, serviceId, ports, { source: 'proc_net' });
  }

  return {
    ports,
    loopbackOnly: {
      tcp: procResult.tcp.loopbackOnly,
      udp: procResult.udp.loopbackOnly,
    },
    compose: composeBlock,
    scanError: procResult.error,
  };
}

// Minimal POSIX single-quote shell escape — duplicated from
// lib/shell-quote.js so this module has no internal deps. Kept tiny
// so it's obviously correct: every `'` becomes `'\''` and the whole
// string is wrapped in single quotes.
function shellEscape(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}
