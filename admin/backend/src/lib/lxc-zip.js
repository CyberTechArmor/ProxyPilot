// LXC zip-drop helpers — everything the "upload a zip into a
// container" flow needs beyond lib/zip-extract.js:
//
//   - a mode-preserving ustar builder that turns validated zip
//     entries into a tar stream `incus exec … tar -x` can consume
//     (backup-pack.js's tarPack is close, but hardcodes 0644 and
//     we need the exec bit to survive for startup scripts);
//   - POSIX-sh script builders for the in-container steps
//     (existence check, staged apply with .old renames, startup
//     script registration as a systemd unit);
//   - a capture-style host exec wrapper on top of lib/host-exec's
//     spawnHost (argv-based; per shell-quote.js guidance all
//     embedded literals go through shellSingleQuote).
//
// Every script builder is a pure string function so tests can
// assert on the generated shell without an Incus daemon; the only
// impure export is runHostCapture.

import { open } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { spawnHost } from './host-exec.js';
import { shellSingleQuote } from './shell-quote.js';
import { extractEntryData, ZipError, ZIP_LIMITS } from './zip-extract.js';

// One well-known unit per container; re-registering replaces it.
export const STARTUP_UNIT_NAME = 'proxypilot-startup.service';
export const STARTUP_UNIT_PATH = `/etc/systemd/system/${STARTUP_UNIT_NAME}`;

const q = shellSingleQuote;

// ── Mode-preserving ustar writer ────────────────────────────────────

function octal(n, width) {
  const s = n.toString(8);
  if (s.length > width - 1) throw new Error(`octal value ${n} too large for width ${width}`);
  return s.padStart(width - 1, '0') + '\0';
}

function asciiPad(s, width) {
  const buf = Buffer.alloc(width, 0);
  Buffer.from(s, 'utf-8').copy(buf, 0, 0, Math.min(width, Buffer.byteLength(s)));
  return buf;
}

// Same prefix/name split rules as backup-pack.js's writer: name must
// fit 100 bytes, prefix 155, reconstructed as prefix+'/'+name.
function splitTarPath(fullName) {
  const bytes = Buffer.byteLength(fullName);
  if (bytes <= 100) return { prefix: '', name: fullName };
  if (bytes > 100 + 1 + 155) {
    throw new ZipError('PATH_VIOLATION', `Entry path too long for tar transfer: ${fullName}`);
  }
  for (let i = fullName.length - 1; i >= 0; i -= 1) {
    if (fullName.charCodeAt(i) !== 0x2f) continue; // '/'
    const right = fullName.slice(i + 1);
    const left = fullName.slice(0, i);
    if (Buffer.byteLength(right) <= 100 && Buffer.byteLength(left) <= 155) {
      return { prefix: left, name: right };
    }
  }
  throw new ZipError('PATH_VIOLATION', `Entry path cannot be split for tar transfer: ${fullName}`);
}

export function makeTarHeader(fullName, size, mode, { typeflag = 0x30, mtimeMs = 0 } = {}) {
  const { prefix, name } = splitTarPath(fullName);
  const h = Buffer.alloc(512, 0);
  asciiPad(typeflag === 0x35 ? `${name}/` : name, 100).copy(h, 0);
  Buffer.from(octal(mode & 0o7777, 8), 'ascii').copy(h, 100);
  Buffer.from(octal(0, 8), 'ascii').copy(h, 108); // uid root
  Buffer.from(octal(0, 8), 'ascii').copy(h, 116); // gid root
  Buffer.from(octal(size, 12), 'ascii').copy(h, 124);
  Buffer.from(octal(Math.floor(mtimeMs / 1000), 12), 'ascii').copy(h, 136);
  Buffer.from('        ', 'ascii').copy(h, 148);
  h[156] = typeflag;
  Buffer.from('ustar\0', 'ascii').copy(h, 257);
  Buffer.from('00', 'ascii').copy(h, 263);
  if (prefix) asciiPad(prefix, 155).copy(h, 345);
  let sum = 0;
  for (let i = 0; i < 512; i += 1) sum += h[i];
  Buffer.from(sum.toString(8).padStart(6, '0'), 'ascii').copy(h, 148);
  h[154] = 0;
  h[155] = 0x20;
  return h;
}

// writeTarFromZip(zipBuf, entries, tarPath) — inflate each validated
// zip entry and append it to a tar file on disk. Streaming to disk
// (instead of Buffer.concat) keeps peak memory at one entry, not the
// whole archive; the extracted-size cap is enforced as we go.
//
// Directory entries become '5' records so empty directories survive
// the trip; regular files keep their permission bits (default 0644,
// always at least owner-rw) so the exec bit on startup scripts
// arrives intact.
export async function writeTarFromZip(zipBuf, entries, tarPath, limits = ZIP_LIMITS) {
  const fh = await open(tarPath, 'w');
  let written = 0;
  try {
    for (const e of entries) {
      if (e.isDirectory) {
        const mode = (e.mode & 0o777) || 0o755;
        await fh.write(makeTarHeader(e.path, 0, mode | 0o700, { typeflag: 0x35 }));
        continue;
      }
      const data = extractEntryData(zipBuf, e, limits);
      written += data.length;
      if (written > limits.maxExtractedBytes) {
        throw new ZipError('TOO_LARGE', 'Zip exceeds the extracted-size limit');
      }
      const mode = ((e.mode & 0o777) || 0o644) | 0o600;
      await fh.write(makeTarHeader(e.path, data.length, mode));
      await fh.write(data);
      const pad = (512 - (data.length % 512)) % 512;
      if (pad > 0) await fh.write(Buffer.alloc(pad, 0));
    }
    await fh.write(Buffer.alloc(1024, 0));
  } finally {
    await fh.close();
  }
  return { bytesWritten: written };
}

// ── In-container script builders (pure) ─────────────────────────────

// Existence check: relative paths arrive on stdin (newline-delimited;
// entry names were validated upstream to contain no control chars),
// and each existing path is echoed back prefixed `F ` (file/other) or
// `D ` (directory). Absolute or empty lines are ignored as defense
// in depth.
export function buildExistenceCheckScript(targetDir) {
  return [
    `TARGET=${q(targetDir)}`,
    'while IFS= read -r p; do',
    '  case "$p" in ""|/*) continue;; esac',
    '  if [ -d "$TARGET/$p" ] && [ ! -L "$TARGET/$p" ]; then printf \'D %s\\n\' "$p"',
    '  elif [ -e "$TARGET/$p" ] || [ -L "$TARGET/$p" ]; then printf \'F %s\\n\' "$p"',
    '  fi',
    'done',
  ].join('\n');
}

export function parseExistenceCheckOutput(stdout) {
  const files = [];
  const dirs = [];
  for (const line of String(stdout || '').split('\n')) {
    if (line.startsWith('F ')) files.push(line.slice(2));
    else if (line.startsWith('D ')) dirs.push(line.slice(2));
  }
  return { files, dirs };
}

// Staged apply: tar bytes arrive on stdin. Extract into a hidden
// stage dir inside the target (same filesystem, so the final copy is
// cheap), rename each confirmed conflict to `<path>.old` (replacing
// any stale .old backup), then merge the stage into the target and
// remove it. `set -e` + the EXIT trap mean a failure mid-extract
// leaves the target untouched apart from an empty removed stage dir.
export function buildApplyScript({ targetDir, stageName, conflicts = [] }) {
  const lines = [
    'set -e',
    `TARGET=${q(targetDir)}`,
    `STAGE=${q(`${targetDir}/${stageName}`)}`,
    'mkdir -p "$TARGET"',
    'mkdir "$STAGE"',
    `trap 'rm -rf "$STAGE"' EXIT`,
    'tar -C "$STAGE" -xpf -',
  ];
  for (const p of conflicts) {
    const live = q(`${targetDir}/${p}`);
    const old = q(`${targetDir}/${p}.old`);
    lines.push(
      `if [ -e ${live} ] || [ -L ${live} ]; then rm -rf ${old}; mv ${live} ${old}; fi`,
    );
  }
  lines.push('cp -a "$STAGE"/. "$TARGET"/');
  lines.push('echo PP_APPLY_OK');
  return lines.join('\n');
}

// Startup-script systemd unit. Type=oneshot + RemainAfterExit is the
// rc.local shape: the script runs once at boot; anything long-running
// should background itself (nohup/setsid) or install its own unit.
export function buildStartupUnit({ scriptPath, workingDir }) {
  return `[Unit]
Description=ProxyPilot zip-upload startup script
After=network-online.target network.target

[Service]
Type=oneshot
RemainAfterExit=yes
TimeoutStartSec=300
WorkingDirectory=${workingDir}
ExecStart=${scriptPath}

[Install]
WantedBy=multi-user.target
`;
}

// Registration script: mark the script executable, then (when the
// container runs systemd) install + enable the unit so the script
// runs again on every container boot. Non-systemd images get the
// chmod and a PP_NO_SYSTEMD marker so the route can surface a
// warning instead of a hard failure.
export function buildStartupRegisterScript({ scriptPath, workingDir }) {
  const unit = buildStartupUnit({ scriptPath, workingDir });
  return [
    'set -e',
    `chmod +x ${q(scriptPath)}`,
    'if [ ! -d /run/systemd/system ]; then echo PP_NO_SYSTEMD; exit 0; fi',
    'mkdir -p /etc/systemd/system',
    `cat > ${q(STARTUP_UNIT_PATH)} <<'PP_UNIT_EOF'`,
    unit.trimEnd(),
    'PP_UNIT_EOF',
    'systemctl daemon-reload',
    `systemctl enable ${q(STARTUP_UNIT_NAME)} >/dev/null 2>&1`,
    'echo PP_REGISTERED',
  ].join('\n');
}

// .old treatment for a previously registered startup script (the
// ask-first confirmation happens in the route/UI; this is just the
// rename). Skipped by callers when the new script lands on the same
// path — the normal file-conflict flow already backs that up.
export function buildPreviousStartupOldifyScript(previousScriptPath) {
  const live = q(previousScriptPath);
  const old = q(`${previousScriptPath}.old`);
  return [
    'set -e',
    `if [ -e ${live} ] || [ -L ${live} ]; then rm -rf ${old}; mv ${live} ${old}; fi`,
    'echo PP_OLDIFY_OK',
  ].join('\n');
}

// Read the currently registered unit (empty output = none).
export function buildReadStartupUnitScript() {
  return `cat ${q(STARTUP_UNIT_PATH)} 2>/dev/null || true`;
}

// Pull ExecStart / WorkingDirectory back out of a unit we wrote.
// Returns null when the text isn't a ProxyPilot startup unit.
export function parseStartupUnit(text) {
  const s = String(text || '');
  const exec = s.match(/^ExecStart=(.+)$/m);
  if (!exec) return null;
  const wd = s.match(/^WorkingDirectory=(.+)$/m);
  return {
    scriptPath: exec[1].trim(),
    workingDir: wd ? wd[1].trim() : null,
    isProxyPilot: /ProxyPilot zip-upload startup script/.test(s),
  };
}

// ── Host exec with capture ──────────────────────────────────────────
//
// Promise wrapper over spawnHost for the zip flow's incus calls:
// argv-based (no shell string for the outer command), optional stdin
// from a Buffer/string or a file path (tar streams), bounded capture,
// wall-clock timeout with kill. Resolves on 'exit' (not 'close') for
// the same reason mock2/host.js does — Incus can hold pipes open.
const CAPTURE_CAP = 256 * 1024;

export function runHostCapture(bin, args, { input = null, inputFile = null, timeoutMs = 120000 } = {}) {
  return new Promise((resolvePromise) => {
    const wantStdin = input !== null || inputFile !== null;
    const child = spawnHost(bin, args, {
      stdio: [wantStdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch {}
    }, timeoutMs);

    const finish = (status, error = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({ status, stdout, stderr, timedOut, error });
    };

    child.stdout.on('data', (d) => {
      if (stdout.length < CAPTURE_CAP) stdout += d.toString('utf-8');
    });
    child.stderr.on('data', (d) => {
      if (stderr.length < CAPTURE_CAP) stderr += d.toString('utf-8');
    });
    child.on('error', (err) => finish(null, err.message));
    child.on('exit', (code) => finish(code));

    if (wantStdin) {
      // EPIPE if the child dies before consuming stdin — swallow it,
      // the exit status tells the real story.
      child.stdin.on('error', () => {});
      if (inputFile) {
        createReadStream(inputFile).on('error', () => {
          try { child.stdin.end(); } catch {}
        }).pipe(child.stdin);
      } else {
        child.stdin.end(typeof input === 'string' ? Buffer.from(input, 'utf-8') : input);
      }
    }
  });
}

// Convenience: run a POSIX-sh script inside a container via
// `incus exec <name> -- sh -c <script>`, with optional stdin.
export function runInContainer(incusName, script, opts = {}) {
  return runHostCapture('incus', ['exec', incusName, '--', 'sh', '-c', script], opts);
}

// ── Orchestration (injectable exec seam for tests) ─────────────────
//
// The route handlers in routes/lxc.js stay thin by delegating to
// these. `run(incusName, script, opts)` defaults to runInContainer;
// tests inject a recorder/stub the same way the cert-mount and L4
// reconciler suites inject execHost.

// checkContainerConflicts — one exec: feed the candidate relative
// paths on stdin, get back what already exists under targetDir.
export async function checkContainerConflicts(incusName, targetDir, relPaths, { run = runInContainer } = {}) {
  if (relPaths.length === 0) return { files: [], dirs: [] };
  const r = await run(incusName, buildExistenceCheckScript(targetDir), {
    input: relPaths.join('\n') + '\n',
    timeoutMs: 60000,
  });
  if (r.status !== 0) {
    throw new Error(`Container check failed${r.stderr ? `: ${r.stderr.trim()}` : ''}${r.timedOut ? ' (timed out)' : ''}`);
  }
  return parseExistenceCheckOutput(r.stdout);
}

// readContainerStartup — the currently registered startup unit, or
// null when none is installed.
export async function readContainerStartup(incusName, { run = runInContainer } = {}) {
  const r = await run(incusName, buildReadStartupUnitScript(), { timeoutMs: 30000 });
  if (r.status !== 0 || !r.stdout.trim()) return null;
  return parseStartupUnit(r.stdout);
}

// applyTarToContainer — stream the tar into the staged-apply script.
export async function applyTarToContainer(incusName, { targetDir, stageName, conflicts, tarPath, tarInput = null }, { run = runInContainer, timeoutMs = 10 * 60 * 1000 } = {}) {
  const script = buildApplyScript({ targetDir, stageName, conflicts });
  const r = await run(incusName, script, tarInput !== null
    ? { input: tarInput, timeoutMs }
    : { inputFile: tarPath, timeoutMs });
  if (r.status !== 0 || !r.stdout.includes('PP_APPLY_OK')) {
    throw new Error(`Extraction inside container failed${r.stderr ? `: ${r.stderr.trim()}` : ''}${r.timedOut ? ' (timed out)' : ''}`);
  }
  return { ok: true };
}

// setupStartupScript — the post-extract startup sequence:
//   1. optional .old rename of a previously registered script (the
//      caller has already collected the user's confirmation);
//   2. chmod +x + systemd unit install/enable (PP_NO_SYSTEMD when
//      the image doesn't run systemd — surfaced as a warning);
//   3. optional run-now with captured output + exit status.
export async function setupStartupScript(incusName, {
  scriptPath, workingDir, previousScriptPath = null, runNow = true,
}, { run = runInContainer, runTimeoutMs = 120000 } = {}) {
  const result = { registered: false, noSystemd: false, previousBackedUp: false, run: null };

  if (previousScriptPath && previousScriptPath !== scriptPath) {
    const r = await run(incusName, buildPreviousStartupOldifyScript(previousScriptPath), { timeoutMs: 30000 });
    if (r.status !== 0) {
      throw new Error(`Failed to back up previous startup script${r.stderr ? `: ${r.stderr.trim()}` : ''}`);
    }
    result.previousBackedUp = true;
  }

  const reg = await run(incusName, buildStartupRegisterScript({ scriptPath, workingDir }), { timeoutMs: 60000 });
  if (reg.status !== 0) {
    throw new Error(`Failed to register startup script${reg.stderr ? `: ${reg.stderr.trim()}` : ''}`);
  }
  result.noSystemd = reg.stdout.includes('PP_NO_SYSTEMD');
  result.registered = reg.stdout.includes('PP_REGISTERED');

  if (runNow) {
    const cmd = `cd ${q(workingDir)} && exec ${q(scriptPath)}`;
    const r = await run(incusName, cmd, { timeoutMs: runTimeoutMs });
    result.run = {
      exitCode: r.status,
      timedOut: r.timedOut,
      stdout: r.stdout.slice(-16 * 1024),
      stderr: r.stderr.slice(-16 * 1024),
    };
  }
  return result;
}
