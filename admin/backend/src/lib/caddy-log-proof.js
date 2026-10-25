// The active-config probe emits a deliberately small public proof. Never return
// its raw stdout/stderr (which are privileged process output), even on failure.
const SCOPE = 'active-global-and-domain';
const MAX_OUTPUT = 65536;
// Import under a non-main name: an older script may ignore CLI flags and run
// its mutating main. Require the explicit read-only entry point instead.
const ACTIVE_PROOF_BOOTSTRAP = "import runpy,sys; namespace=runpy.run_path(sys.argv[1],run_name='__caddy_readonly_probe__'); probe=namespace.get('active_proof_cli'); sys.exit(probe([sys.argv[2]]) if callable(probe) else 1)";
const VERSION = /^v?\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/;
const LOGGER = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;

function validProofDomain(value) {
  return typeof value === 'string' && value.length <= 253
    && value === value.toLowerCase() && value.includes('.')
    && value.split('.').every((label) => label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label));
}

function safeSourceDir(value) {
  return typeof value === 'string' && value.length <= 1024
    && /^\/(?:[A-Za-z0-9_-][A-Za-z0-9_.-]*\/)*[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(value);
}

function safeSection(value) {
  if (!value || value.present !== true || value.credentialRedaction !== true
    || !Array.isArray(value.loggerNames) || !value.loggerNames.length || value.loggerNames.length > 128
    || !value.loggerNames.every((name) => typeof name === 'string' && LOGGER.test(name))) return null;
  return { present: true, credentialRedaction: true, loggerNames: [...new Set(value.loggerNames)] };
}

export async function readCaddyLogProof({ domain, selfUpdateInstalled, runHostCapture }) {
  const failed = { schema: 1, scope: SCOPE, domain: validProofDomain(domain) ? domain : null, verified: false, code: 'verification_failed' };
  if (!validProofDomain(domain)) return failed;
  try {
    const installed = await selfUpdateInstalled({ force: false });
    if (installed?.configured !== true || !safeSourceDir(installed.source_dir)) return failed;
    const probe = await runHostCapture('python3', ['-c', ACTIVE_PROOF_BOOTSTRAP, `${installed.source_dir}/scripts/secure-mcp-caddy-logs.py`, domain], { timeoutMs: 30000, maxCapture: MAX_OUTPUT });
    if (probe?.status !== 0 || typeof probe.stdout !== 'string' || Buffer.byteLength(probe.stdout, 'utf8') > MAX_OUTPUT) return failed;
    const value = JSON.parse(probe.stdout);
    if (!value || value.schema !== 1 || value.scope !== SCOPE || value.domain !== domain || value.verified !== true
      || typeof value.activeConfigSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.activeConfigSha256)
      || typeof value.caddyVersion !== 'string' || value.caddyVersion.length > 64 || !VERSION.test(value.caddyVersion)) return failed;
    const global = safeSection(value.global);
    const service = safeSection(value.service);
    if (!global || !service) return failed;
    return { schema: 1, scope: SCOPE, domain, verified: true, activeConfigSha256: value.activeConfigSha256, caddyVersion: value.caddyVersion, global, service };
  } catch {
    return failed;
  }
}
