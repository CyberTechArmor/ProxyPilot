// scripts/install-storage.sh — the parts that decide whether the install can
// succeed at all, driven as real bash against fake apt trees.
//
// Regression: the first real run on a Debian 13 host died with
//   E: Package 'zfsutils-linux' has no installation candidate
// because Debian keeps ZFS in `contrib` and the installer does not enable it.
// CI never saw it: ubuntu-latest carries the package in a default component.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../../../../scripts/install-storage.sh', import.meta.url));

const DEB822 = `Types: deb
URIs: http://deb.debian.org/debian
Suites: trixie trixie-updates
Components: main non-free-firmware
Signed-By: /usr/share/keyrings/debian-archive-keyring.gpg

Types: deb
URIs: http://security.debian.org/debian-security
Suites: trixie-security
Components: main non-free-firmware
Signed-By: /usr/share/keyrings/debian-archive-keyring.gpg
`;

const ONELINE = `# an upgraded host keeps the old format
deb http://deb.debian.org/debian trixie main non-free-firmware
deb-src http://deb.debian.org/debian trixie main
`;

/** Run add_component, lifted verbatim out of the installer, against a fake /etc/apt. */
function runAddComponent(files, component) {
  const root = mkdtempSync(join(tmpdir(), 'pp-apt-'));
  mkdirSync(join(root, 'etc', 'apt', 'sources.list.d'), { recursive: true });
  for (const [rel, body] of Object.entries(files)) writeFileSync(join(root, rel), body);
  const script = `
set -uo pipefail
source <(sed -n '/^add_component()/,/^}/p' ${JSON.stringify(SCRIPT)} | sed "s#/etc/apt#${root}/etc/apt#g")
add_component ${component} && echo "CHANGED" || echo "UNCHANGED"
`;
  const r = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
  const read = (rel) => (existsSync(join(root, rel)) ? readFileSync(join(root, rel), 'utf8') : null);
  return { r, read, root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('Debian deb822: contrib is added to every stanza, with a backup, and re-running changes nothing', (t) => {
  const h = runAddComponent({ 'etc/apt/sources.list.d/debian.sources': DEB822 }, 'contrib');
  t.after(h.cleanup);
  assert.match(h.r.stdout, /CHANGED/);
  const after = h.read('etc/apt/sources.list.d/debian.sources');
  const components = after.split('\n').filter((l) => l.startsWith('Components:'));
  assert.equal(components.length, 2);
  for (const c of components) assert.match(c, /^Components: main non-free-firmware contrib$/);
  assert.equal(h.read('etc/apt/sources.list.d/debian.sources.proxypilot.bak'), DEB822, 'the original is kept');
  // URI and signing key are untouched: the component is added to the operator's
  // own stanza rather than a competing source with a guessed keyring
  assert.match(after, /URIs: http:\/\/deb\.debian\.org\/debian/);
  assert.match(after, /Signed-By: \/usr\/share\/keyrings\/debian-archive-keyring\.gpg/);

  const again = runAddComponent({ 'etc/apt/sources.list.d/debian.sources': after }, 'contrib');
  t.after(again.cleanup);
  assert.match(again.r.stdout, /UNCHANGED/, 'idempotent');
});

test('the older one-line format is handled, and deb-src lines are left alone', (t) => {
  const h = runAddComponent({ 'etc/apt/sources.list': ONELINE }, 'contrib');
  t.after(h.cleanup);
  assert.match(h.r.stdout, /CHANGED/);
  const lines = h.read('etc/apt/sources.list').split('\n');
  assert.equal(lines.find((l) => l.startsWith('deb ')), 'deb http://deb.debian.org/debian trixie main non-free-firmware contrib');
  assert.equal(lines.find((l) => l.startsWith('deb-src ')), 'deb-src http://deb.debian.org/debian trixie main', 'source lines are not touched');
});

test('Ubuntu asks for universe, and a tree with nothing to edit reports no change', (t) => {
  const u = runAddComponent({ 'etc/apt/sources.list.d/ubuntu.sources': 'Types: deb\nURIs: http://archive.ubuntu.com/ubuntu\nSuites: noble\nComponents: main restricted\n' }, 'universe');
  t.after(u.cleanup);
  assert.match(u.r.stdout, /CHANGED/);
  assert.match(u.read('etc/apt/sources.list.d/ubuntu.sources'), /^Components: main restricted universe$/m);

  const empty = runAddComponent({ 'etc/apt/sources.list': '# nothing here\n' }, 'contrib');
  t.after(empty.cleanup);
  assert.match(empty.r.stdout, /UNCHANGED/, 'nothing to edit is reported, not silently ignored');
});

test('the installer refuses clearly rather than half-installing, and says what it will install', () => {
  const src = readFileSync(SCRIPT, 'utf8');
  // every early exit names a distinct code so the dashboard can tell them apart
  assert.match(src, /exit 4/, 'no candidate / cannot enable the component');
  assert.match(src, /exit 5/, 'apt-get install failed');
  assert.match(src, /exit 3/, 'installed but the module is not loaded');
  // Debian needs the DKMS build and its headers; Ubuntu ships the module
  assert.match(src, /PKGS\+=\(zfs-dkms zfs-zed\)/);
  assert.match(src, /linux-headers-\$\{RUNNING_KERNEL\}/);
  // the candidate is verified BEFORE anything is installed
  const candidateAt = src.indexOf('apt_candidate zfsutils-linux');
  const installAt = src.indexOf('apt-get install -y "${PKGS[@]}"');
  assert.ok(candidateAt > 0 && installAt > 0 && candidateAt < installAt, 'the candidate check comes first');

  // Headers go in their OWN apt transaction, BEFORE the main install.
  // zfs-dkms's postinst skips the build when headers are not configured yet,
  // and apt does not order two unrelated packages, so a combined install can
  // silently produce no module at all.
  const headerInstallAt = src.indexOf('installing kernel headers first');
  assert.ok(headerInstallAt > 0 && headerInstallAt < installAt, 'headers are installed before the main transaction');

  // and the build is forced rather than trusted to postinst
  assert.match(src, /dkms autoinstall/);
  const dkmsAt = src.indexOf('dkms autoinstall');
  assert.ok(dkmsAt > installAt, 'the explicit build runs after the packages are in');

  // a module built for the wrong kernel must be reported as a reboot, not a
  // failed build: those need different instructions
  assert.match(src, /kernels_with_zfs/);
  assert.match(src, /A module IS built, for/);
  assert.match(src, /REBOOT into/);
  assert.match(src, /Secure Boot is ENABLED/);
  assert.match(src, /the DKMS build failed/);
  // and the module failure does not claim success
  assert.match(src, /NOT loaded/);
});
