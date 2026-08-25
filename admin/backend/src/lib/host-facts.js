// Host-level facts the guests cannot see.
//
// Several field failures during the RustDesk provisioning session were host
// conditions that were invisible from inside a guest and expensive to reach
// indirectly: the kernel keyring quota that makes `docker compose up` fail
// with "disk quota exceeded", the Incus generation gap that turned
// `incus snapshot pp-Foo snap` into `unknown command`, and the managed-bridge
// subnet that decides which of a guest's IPv4 addresses the edge can reach.
//
// The parsers here are pure so they can be tested without a host; the
// collectors wrap them in the same nsenter pivot every other host shell-out
// uses (see lib/host-exec.js).

import { runHostCapture } from './lxc-zip.js';

// The kernel default for kernel.keys.maxkeys. Unprivileged Incus guests map
// container-root to a NON-root host uid, so they get this cap rather than
// root's kernel.keys.root_maxkeys — and ProxyPilot's guests share one idmap,
// which means they share one 200-key budget. runc calls
// keyctl_join_session_keyring() per container, so the budget runs out and the
// next `docker run` anywhere on the host fails with EDQUOT, whose errno string
// is "Disk quota exceeded" — naming disk space it has nothing to do with.
export const KERNEL_KEYS_DEFAULT_MAXKEYS = 200;

// Below this many free keys for a uid, a Docker-shaped guest is one container
// start away from the failure above.
export const KEYRING_FREE_KEYS_WARN = 50;

export const KEYRING_SYSCTL_REMEDY =
  'Raise it on the HOST: printf \'kernel.keys.maxkeys=20000\\nkernel.keys.maxbytes=2000000\\n\' '
  + '> /etc/sysctl.d/99-lxc-keyring.conf && sysctl --system';

/** Parse /proc/key-users:  `uid: usage nkeys/nikeys qnkeys/maxkeys qnbytes/maxbytes`. */
export function parseProcKeyUsers(text) {
  const rows = [];
  for (const line of String(text || '').split('\n')) {
    const m = line.match(/^\s*(\d+):\s+(\d+)\s+(\d+)\/(\d+)\s+(\d+)\/(\d+)\s+(\d+)\/(\d+)/);
    if (!m) continue;
    const [, uid, usage, nkeys, nikeys, qnkeys, maxkeys, qnbytes, maxbytes] = m.map(Number);
    rows.push({
      uid, usage, nkeys, nikeys, qnkeys, maxkeys, qnbytes, maxbytes,
      free_keys: Math.max(0, maxkeys - qnkeys),
    });
  }
  return rows;
}

/**
 * Is this host able to start another Docker container inside an unprivileged
 * guest? Returns { ok, warning, tightest } — `warning` is a complete sentence
 * naming the remedy, or null.
 */
export function keyringAssessment({ maxkeys = null, rows = [], threshold = KEYRING_FREE_KEYS_WARN } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const tightest = list.length
    ? list.reduce((a, b) => (a.free_keys <= b.free_keys ? a : b))
    : null;
  const exhausted = list.filter((r) => r.free_keys < threshold);

  if (exhausted.length) {
    const worst = exhausted.reduce((a, b) => (a.free_keys <= b.free_keys ? a : b));
    return {
      ok: false,
      tightest,
      warning: `Host kernel keyring is nearly exhausted: uid ${worst.uid} holds `
        + `${worst.qnkeys}/${worst.maxkeys} keys (${worst.free_keys} free). Docker inside an `
        + 'unprivileged guest will fail at container start with "unable to join session keyring: '
        + 'disk quota exceeded" — an EDQUOT, not a disk problem. ' + KEYRING_SYSCTL_REMEDY,
    };
  }
  if (Number.isFinite(Number(maxkeys)) && Number(maxkeys) <= KERNEL_KEYS_DEFAULT_MAXKEYS) {
    return {
      ok: false,
      tightest,
      warning: `Host kernel.keys.maxkeys is ${maxkeys} (the kernel default). Every unprivileged `
        + 'guest maps container-root to the same non-root host uid, so they all draw on that one '
        + 'budget and runc exhausts it after a few dozen containers — surfacing as "unable to join '
        + 'session keyring: disk quota exceeded". ' + KEYRING_SYSCTL_REMEDY,
    };
  }
  return { ok: true, tightest, warning: null };
}

/** `incus --version` prints a bare version string; be tolerant of banners. */
export function parseIncusVersion(stdout) {
  for (const line of String(stdout || '').split('\n')) {
    const m = line.trim().match(/(\d+\.\d+(?:\.\d+)?)/);
    if (m) return m[1];
  }
  return null;
}

/** ipv4.address out of `incus network show <bridge>` (YAML). Returns CIDR. */
export function parseNetworkIpv4Cidr(yaml) {
  const m = String(yaml || '').match(/^\s*ipv4\.address:\s*"?([0-9.]+\/\d{1,2})"?\s*$/m);
  return m ? m[1] : null;
}

/** `df -Pk <path>` → { filesystem, size_kb, used_kb, available_kb, mounted_on }. */
export function parseDfKb(text) {
  const lines = String(text || '').trim().split('\n');
  if (lines.length < 2) return null;
  const p = lines[lines.length - 1].trim().split(/\s+/);
  if (p.length < 6) return null;
  return {
    filesystem: p[0],
    size_kb: Number(p[1]),
    used_kb: Number(p[2]),
    available_kb: Number(p[3]),
    use_percent: p[4],
    mounted_on: p[5],
  };
}

// ---- collectors ----

async function capture(bin, args, timeoutMs = 10000) {
  try {
    return await runHostCapture(bin, args, { timeoutMs });
  } catch (err) {
    return { status: null, stdout: '', stderr: String(err?.message || err) };
  }
}

/** Version string of the host's incus client, or null when it can't be read. */
export async function hostIncusVersion() {
  const r = await capture('incus', ['--version']);
  return r.status === 0 ? parseIncusVersion(r.stdout) : null;
}

/** kernel.keys.* limits + /proc/key-users headroom, assessed. */
export async function hostKeyringFacts() {
  const [maxkeysR, maxbytesR, rootMaxR, usersR] = await Promise.all([
    capture('sysctl', ['-n', 'kernel.keys.maxkeys']),
    capture('sysctl', ['-n', 'kernel.keys.maxbytes']),
    capture('sysctl', ['-n', 'kernel.keys.root_maxkeys']),
    capture('cat', ['/proc/key-users']),
  ]);
  const num = (r) => {
    const n = Number(String(r.stdout || '').trim());
    return Number.isFinite(n) ? n : null;
  };
  const rows = usersR.status === 0 ? parseProcKeyUsers(usersR.stdout) : [];
  const maxkeys = num(maxkeysR);
  return {
    maxkeys,
    maxbytes: num(maxbytesR),
    root_maxkeys: num(rootMaxR),
    users: rows,
    assessment: keyringAssessment({ maxkeys, rows }),
  };
}

/** The managed bridge a guest's NIC hangs off, and its IPv4 subnet. */
export async function hostBridgeFacts(bridgeName = null) {
  let name = bridgeName;
  if (!name) {
    const r = await capture('incus', ['network', 'list', '--format', 'csv']);
    if (r.status === 0) {
      const row = r.stdout.split('\n')
        .map((l) => l.split(','))
        .find((c) => c[1] === 'bridge' && /YES|true/i.test(c[3] || ''));
      name = row?.[0] || null;
    }
  }
  if (!name) return { name: null, ipv4_cidr: null };
  const show = await capture('incus', ['network', 'show', name]);
  return { name, ipv4_cidr: show.status === 0 ? parseNetworkIpv4Cidr(show.stdout) : null };
}

/** Everything get_host_diagnostics reports, in one pass. */
export async function collectHostDiagnostics({ diskPath = '/var/lib/incus' } = {}) {
  const [incusVersion, kernel, keyring, bridge, df] = await Promise.all([
    hostIncusVersion(),
    capture('uname', ['-sr']),
    hostKeyringFacts(),
    hostBridgeFacts(),
    capture('df', ['-Pk', diskPath]),
  ]);
  return {
    incus_version: incusVersion,
    kernel: kernel.status === 0 ? kernel.stdout.trim() : null,
    keyring,
    bridge,
    disk: df.status === 0 ? { path: diskPath, ...(parseDfKb(df.stdout) || {}) } : null,
  };
}
