// Run on the Linux host with sudo node. No firewall apply, daemon-reload,
// service control, guest mutation, or persistent configuration writes.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { render, checksum } from '../cli/src/core/firewall/render.js';
import { ingressGuestSnapshot, ensureIngressBootGate } from '../cli/src/core/firewall/ingress.js';

assert.equal(process.platform, 'linux', 'Run this preflight on the Linux host');
assert.equal(process.getuid(), 0, 'Use sudo for nft check and Incus observation');
const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const work = mkdtempSync(join(tmpdir(), 'pp-nodus-preflight-'));
let failures = 0;
function run(bin, args, options = {}) {
  const r = spawnSync(bin, args, { encoding: 'utf8', timeout: 60000, maxBuffer: 4 * 1024 * 1024, ...options });
  assert.ifError(r.error);
  if (r.status !== 0) throw new Error(`${bin} ${args.join(' ')}: exit ${r.status}\n${r.stdout}\n${r.stderr}`);
  return r.stdout;
}
function step(label, fn) {
  console.log(`\n=== ${label} ===`);
  try { fn(); console.log('PASS'); }
  catch (e) { failures++; console.error(e.stack || e); }
}
try {
  console.log(JSON.stringify({ at: new Date().toISOString(), repo, temporary_directory: work }));
  step('source revisions and host tools', () => {
    console.log('candidate', run('git', ['-C', repo, 'rev-parse', 'HEAD']).trim());
    console.log('candidate status', run('git', ['-C', repo, 'status', '--porcelain']).trim() || 'clean');
    console.log('live', run('git', ['-C', '/root/ProxyPilot', 'rev-parse', 'HEAD']).trim());
    console.log('live status', run('git', ['-C', '/root/ProxyPilot', 'status', '--porcelain']).trim() || 'clean');
    console.log(run('nft', ['--version']).trim());
    console.log(run('systemd-analyze', ['--version']).trim());
  });
  step('exact guest and proposed nftables transaction (check only)', () => {
    const instance = JSON.parse(run('incus', ['query', '/1.0/instances/pp-nodus']));
    const runtime = JSON.parse(run('incus', ['query', '/1.0/instances/pp-nodus/state']));
    console.log('incus query envelope', JSON.stringify({ instance_metadata: !!instance.metadata, runtime_metadata: !!runtime.metadata }));
    const entry = ingressGuestSnapshot(instance.metadata || instance, runtime.metadata || runtime,
      { container: 'nodus', routeId: '98d674e8-d11e-4d01-a786-77fd18fbc0c6', targetIp: '10.185.17.240', port: 3001 });
    console.log('observed guest', JSON.stringify(entry));
    const state = JSON.parse(readFileSync('/var/lib/proxypilot/firewall.json', 'utf8'));
    const prior = (state.protected_upstreams || []).find(e => e.route_id === entry.route_id);
    if (prior) assert.deepEqual(prior, entry, 'Existing recorded fence differs');
    else state.protected_upstreams = [...(state.protected_upstreams || []), entry];
    const rules = render(state), file = join(work, 'proposed.nft');
    writeFileSync(file, rules, { mode: 0o600 });
    console.log('proposed checksum', checksum(rules));
    console.log(run('nft', ['-c', '-f', file]));
  });
  step('current units and proposed Incus dependency (offline verification)', () => {
    for (const unit of ['incus.service', 'incus-startup.service', 'proxypilot-firewall-reconcile.service']) {
      console.log(run('systemctl', ['--no-pager', 'cat', unit]));
    }
    console.log(run('systemctl', ['--no-pager', 'show', 'incus.service', 'proxypilot-firewall-reconcile.service',
      '--property=Id,Requires,Wants,After,Before,DefaultDependencies,ActiveState,UnitFileState']));
    const unitFile = join(work, 'incus.service');
    writeFileSync(unitFile, run('systemctl', ['--no-pager', 'cat', 'incus.service']));
    const dir = join(work, 'incus.service.d');
    mkdirSync(dir);
    ensureIngressBootGate({ dir, file: join(dir, 'proxypilot-ingress.conf'), reload: () => ({ status: 0 }) });
    console.log('proposed drop-in', readFileSync(join(dir, 'proxypilot-ingress.conf'), 'utf8'));
    console.log(run('systemd-analyze', ['verify', '--man=no', unitFile],
      { env: { ...process.env, SYSTEMD_UNIT_PATH: `${work}:`, SYSTEMD_PAGER: 'cat' } }));
  });
} finally {
  rmSync(work, { recursive: true, force: true });
}
console.log(JSON.stringify({ preflight_passed: failures === 0, failed_steps: failures,
  applied: false, network_proof: false }));
process.exitCode = failures ? 1 : 0;
