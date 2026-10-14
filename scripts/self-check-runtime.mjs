// Candidate checks run inside the existing Alpine dashboard image, before a
// new image can be built. Repair only these two known runtime omissions there;
// do not pivot to the host, run apk upgrade, or invoke a general installer.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

export function ensureSelfCheckRuntime({ run = spawnSync, exists = existsSync, uid = process.getuid?.(), log = console.log } = {}) {
  const python = () => run('/usr/bin/python3', ['-c', 'from cryptography.hazmat.primitives.serialization import load_pem_private_key'], { stdio: 'ignore', timeout: 10000 }).status === 0;
  const pdf = () => run('/usr/bin/pdftotext', ['-v'], { stdio: 'ignore', timeout: 10000 }).status === 0;
  const missing = [...(!python() ? ['py3-cryptography'] : []), ...(!pdf() ? ['poppler-utils'] : [])];
  if (!missing.length) return { installed: [] };
  if (uid !== 0 || !exists('/etc/alpine-release') || !exists('/sbin/apk')) throw new Error(`SELF_CHECK_RUNTIME_MISSING: ${missing.join(', ')}; install the declared dashboard runtime dependencies`);
  log(`Installing missing dashboard check dependencies: ${missing.join(', ')}`);
  const result = run('/sbin/apk', ['add', '--no-cache', ...missing], { stdio: 'inherit', timeout: 180000 });
  if (result.status !== 0 || !python() || !pdf()) throw new Error('SELF_CHECK_RUNTIME_REPAIR_FAILED');
  return { installed: missing };
}
