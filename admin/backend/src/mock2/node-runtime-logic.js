// node-runtime-logic.js — pure half of the Node 20 fix (run-taxonomy #2/A2).
// Debian 12's own `nodejs` apt package is 18, which Playwright refuses to run
// on, which is why the e2e gate has never executed anywhere in the fleet
// (deploy.js installE2eBrowser exists; the runtime under it was too old).
//
// Native-free by construction: the install script is a plain template string,
// and probe parsing is plain regex over captured stdout — no container, no DB.
// Shared by template.js (embedded at container bootstrap, best-effort, every
// install non-fatal) and component-install.js's ensureNodeRuntime (the repair
// pass for containers that were already provisioned before this landed — a
// container never re-runs its bootstrap script on its own, and
// MOCK2_BASE_IMAGE is read only at `incus launch`).

export const NODE_RUNTIME_MIN_MAJOR = 20;

// The guarded, idempotent install block. Checks the current runtime first (so
// re-running never re-fetches needlessly), tries nodesource, and falls back to
// the distro package if nodesource fails — every step non-fatal, mirroring
// every other install in the bootstrap script (a container must still boot
// without Node at all).
export function nodeRuntimeInstallScript({ minMajor = NODE_RUNTIME_MIN_MAJOR } = {}) {
  return `if ! (command -v node >/dev/null 2>&1 && [ "$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)" -ge ${minMajor} ]); then
  curl -fsSL https://deb.nodesource.com/setup_${minMajor}.x -o /tmp/nodesource_setup.sh 2>/dev/null \\
    && bash /tmp/nodesource_setup.sh >/dev/null 2>&1 \\
    && apt-get install -y --no-install-recommends nodejs \\
    || echo "[mock2] nodesource install failed; falling back to distro nodejs"
  rm -f /tmp/nodesource_setup.sh
fi
command -v node >/dev/null 2>&1 || apt-get install -y --no-install-recommends nodejs npm || echo "[mock2] nodejs/npm install skipped/failed (non-fatal; the app cannot deploy without it)"`;
}

// The repair-pass variant: same guard, but reports what happened via markers
// instead of just leaving Node on PATH — ensureNodeRuntime parses these rather
// than re-deriving install/skip state from exit codes.
export function nodeRuntimeProbeScript({ minMajor = NODE_RUNTIME_MIN_MAJOR } = {}) {
  return `
NEEDS_INSTALL=1
if command -v node >/dev/null 2>&1; then
  MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  if [ "$MAJOR" -ge ${minMajor} ] 2>/dev/null; then NEEDS_INSTALL=0; fi
fi
if [ "$NEEDS_INSTALL" = "1" ]; then
  curl -fsSL https://deb.nodesource.com/setup_${minMajor}.x -o /tmp/nodesource_setup.sh 2>/dev/null \\
    && bash /tmp/nodesource_setup.sh >/dev/null 2>&1 \\
    && apt-get install -y --no-install-recommends nodejs >/dev/null 2>&1
  rm -f /tmp/nodesource_setup.sh
  command -v node >/dev/null 2>&1 || apt-get install -y --no-install-recommends nodejs npm >/dev/null 2>&1 || true
fi
echo "__MOCK2_NODE_CHANGED__:$NEEDS_INSTALL"
echo "__MOCK2_NODE_VERSION__:$(node -v 2>/dev/null || echo unavailable)"
`.trim();
}

// Parse the two markers nodeRuntimeProbeScript prints. Never throws — an
// unparseable transcript (a crashed shell, a truncated stream) yields the
// "nothing confirmed" shape rather than a thrown error, matching every other
// containerSh consumer's contract of always resolving.
export function parseNodeRuntimeProbe(stdout = '') {
  const s = String(stdout || '');
  const changedMatch = s.match(/__MOCK2_NODE_CHANGED__:(\d)/);
  const versionMatch = s.match(/__MOCK2_NODE_VERSION__:(\S+)/);
  const changed = changedMatch ? changedMatch[1] === '1' : false;
  const version = versionMatch && versionMatch[1] !== 'unavailable' ? versionMatch[1] : null;
  return { changed, version };
}

// The human-readable outcome ensureNodeRuntime returns to its callers.
export function describeNodeRuntimeOutcome({ changed, version }, { stderrTail = '' } = {}) {
  if (version) return { ok: true, changed, version, detail: changed ? `installed Node ${version}` : `already Node ${version}` };
  return { ok: false, changed, version: null, detail: `node unavailable after repair attempt: ${stderrTail}`.trim() };
}
