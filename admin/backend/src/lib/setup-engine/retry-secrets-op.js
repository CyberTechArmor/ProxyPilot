// Setup engine — the retry path's secret mint as ONE operation (A-15): the
// same mint the deploy runs (deploy-op mintComponentSecrets: markers, the
// data guard, never overwrite, defer and say why), under the app's lease,
// in the job's cgroup, recording key NAMES only. A retry reuses what the
// previous attempt minted by construction (a key already in the file is
// never replaced) and says which recorded keys it found in place.

import { mintComponentSecrets } from './deploy-op.js';
import { containedGuest, noopJob } from './op-kit.js';
import { CONTAINMENT_RUN_DIR } from './guest-probes.js';
import { sanitizeReason } from './logic.js';

export async function runRetrySecretsOperation({ params, exec, job = noopJob(), reuse = [], log = () => {} }) {
  const container = String(params.container || '');
  const appDir = String(params.appDir || '/srv/app');
  const environmentFile = String(params.environmentFile || '/etc/environment');
  const configs = Array.isArray(params.secrets?.configs) ? params.secrets.configs : [];
  const { guest } = containedGuest({ exec, container, job, runDir: String(params.runDir || CONTAINMENT_RUN_DIR) });
  const g = (phase, script, timeoutMs) => guest(phase, script, timeoutMs);
  try { job.checkpoint('minting', { app_stopped: false, resumable: true, container, environmentFile }, 'minting missing component secrets (never overwriting an existing key)'); } catch { /* */ }
  const priorKeys = reuse.filter((r) => r.kind === 'secret' && r.where === environmentFile).map((r) => r.name);
  const m = await mintComponentSecrets({ guest: g, appDir, environmentFile, configs, newlyProvisioned: false, writersStopped: false, job });
  if (!m.ok) return { ok: false, step: 'mint', error: sanitizeReason(m.error || 'mint failed'), minted: [], deferred: m.deferred || [], required: m.required || [] };
  // Which keys a previous attempt recorded are now in place (by name only).
  let reused = [];
  if (priorKeys.length) {
    const r = await g('env_keys', `sed -n 's/^\\(export \\)\\{0,1\\}\\([A-Za-z_][A-Za-z0-9_]*\\)=.*/\\2/p' '${environmentFile}' 2>/dev/null\n`, 15_000);
    const present = new Set(String(r.stdout || '').split('\n').map((l) => l.trim()).filter(Boolean));
    reused = priorKeys.filter((k) => present.has(k) && !m.minted.includes(k));
  }
  log('retry_secrets', `${container}: minted ${m.minted.length}, deferred ${m.deferred.length}, reused ${reused.length}`);
  return {
    ok: true, step: 'minted', minted: m.minted, deferred: m.deferred, required: m.required, reused,
    verification: { state: 'not_applicable', outcome: 'not_applicable', label: `not applicable: the deploy that follows verifies the application; ${m.minted.length} key(s) minted, ${m.deferred.length} deferred, ${reused.length} reused` },
    followUp: null,
  };
}
