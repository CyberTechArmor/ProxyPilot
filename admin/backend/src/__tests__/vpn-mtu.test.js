// Tests for the MTU = 1280 default that ships in every ProxyPilot-
// generated WireGuard config (server-side wg0.conf and client-side
// peer config), plus the env-var override path and the bash patch
// helper used by install/update.sh to retro-fit MTU into pre-1280
// wg0.conf files.
//
// Imports the CLI render module directly. The CLI's `getDb()` is
// lazy, so importing peer.js / server.js does not open SQLite —
// only the actual mutation helpers do, and we don't call those
// here.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  renderWg0Conf,
  resolveMtu,
  WG_DEFAULT_MTU,
} from '../../../../cli/src/core/vpn/server.js';
import { renderClientConfig } from '../../../../cli/src/core/vpn/peer.js';

const PATCH_SCRIPT = path.resolve(
  process.cwd(),
  '../../scripts/patch-wg-mtu.sh',
);

const FAKE_PRIVATE = 'aGVsbG8td2l0aGYta2V5LWZvci10ZXN0aW5nLW9ubHkxMjM0NQ==';
const FAKE_PUBLIC = 'cHViLWtleS1mb3ItdGVzdGluZy1vbmx5LWZpeGVkLWxlbmd0aA==';

function withEnv(name, value, fn) {
  const prev = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env[name];
    else process.env[name] = prev;
  }
}

test('resolveMtu: returns 1280 by default with no env / arg', () => {
  withEnv('PROXYPILOT_VPN_MTU', undefined, () => {
    assert.equal(resolveMtu(), WG_DEFAULT_MTU);
    assert.equal(resolveMtu(), 1280);
  });
});

test('resolveMtu: honors PROXYPILOT_VPN_MTU when valid', () => {
  withEnv('PROXYPILOT_VPN_MTU', '1500', () => {
    assert.equal(resolveMtu(), 1500);
  });
});

test('resolveMtu: explicit override beats env', () => {
  withEnv('PROXYPILOT_VPN_MTU', '1500', () => {
    assert.equal(resolveMtu(1400), 1400);
  });
});

test('resolveMtu: silently falls back to default on garbage env', () => {
  // Stale shell vars shouldn't be able to brick wg0 on `vpn enable`.
  // The shell-level patch script does the same fallback.
  for (const bad of ['', 'not-a-number', '0', '-5', '99999', '1280.5']) {
    withEnv('PROXYPILOT_VPN_MTU', bad, () => {
      assert.equal(resolveMtu(), WG_DEFAULT_MTU, `expected fallback for "${bad}"`);
    });
  }
});

test('renderWg0Conf: emits MTU = 1280 in the [Interface] block by default', () => {
  withEnv('PROXYPILOT_VPN_MTU', undefined, () => {
    const body = renderWg0Conf({
      privateKey: FAKE_PRIVATE,
      listenPort: 49000,
      serverIp: '10.100.0.1/24',
      peers: [],
    });
    assert.match(body, /^\[Interface\]$/m);
    assert.match(body, /^MTU = 1280$/m);
    // MTU must land inside [Interface] (i.e. before the first [Peer]
    // header — but with zero peers we just verify it appears at all).
    const interfaceIdx = body.indexOf('[Interface]');
    const mtuIdx = body.indexOf('MTU = 1280');
    assert.ok(mtuIdx > interfaceIdx, 'MTU line must follow the [Interface] header');
  });
});

test('renderWg0Conf: PROXYPILOT_VPN_MTU=1500 round-trips into the rendered config', () => {
  withEnv('PROXYPILOT_VPN_MTU', '1500', () => {
    const body = renderWg0Conf({
      privateKey: FAKE_PRIVATE,
      listenPort: 49000,
      serverIp: '10.100.0.1/24',
      peers: [],
    });
    assert.match(body, /^MTU = 1500$/m);
    assert.doesNotMatch(body, /^MTU = 1280$/m);
  });
});

test('renderWg0Conf: explicit mtu arg overrides env', () => {
  withEnv('PROXYPILOT_VPN_MTU', '1500', () => {
    const body = renderWg0Conf({
      privateKey: FAKE_PRIVATE,
      listenPort: 49000,
      serverIp: '10.100.0.1/24',
      peers: [],
      mtu: 1400,
    });
    assert.match(body, /^MTU = 1400$/m);
  });
});

test('renderClientConfig: emits MTU = 1280 in the client [Interface] block by default', () => {
  withEnv('PROXYPILOT_VPN_MTU', undefined, () => {
    const body = renderClientConfig({
      peerPrivateKey: FAKE_PRIVATE,
      peerIp: '10.100.0.42',
      scope: 'admin',
      cfg: { server_public_key: FAKE_PUBLIC, endpoint: 'host.example:49000' },
    });
    assert.match(body, /^\[Interface\]$/m);
    assert.match(body, /^Address = 10\.100\.0\.42\/32$/m);
    assert.match(body, /^MTU = 1280$/m);
    // MTU goes between Address and the [Peer] block.
    const addressIdx = body.indexOf('Address =');
    const mtuIdx = body.indexOf('MTU =');
    const peerIdx = body.indexOf('[Peer]');
    assert.ok(addressIdx < mtuIdx && mtuIdx < peerIdx,
      'MTU must sit between Address and [Peer]');
  });
});

test('renderClientConfig: PROXYPILOT_VPN_MTU=1500 round-trips into the client config', () => {
  withEnv('PROXYPILOT_VPN_MTU', '1500', () => {
    const body = renderClientConfig({
      peerPrivateKey: FAKE_PRIVATE,
      peerIp: '10.100.0.42',
      scope: 'admin',
      cfg: { server_public_key: FAKE_PUBLIC, endpoint: 'host.example:49000' },
    });
    assert.match(body, /^MTU = 1500$/m);
    assert.doesNotMatch(body, /^MTU = 1280$/m);
  });
});

// ── patch-wg-mtu.sh: idempotency + ordering tests ──────────────────
//
// We exercise the bash helper end-to-end against a tmp wg0.conf so a
// regression in the sed expression or the idempotency guard fails
// the suite. --no-restart is critical: without it the script would
// try to bounce a real wg0 on the test host.

function runPatch(args, env = {}) {
  return spawnSync('bash', [PATCH_SCRIPT, ...args], {
    encoding: 'utf-8',
    env: { ...process.env, ...env },
  });
}

function mkTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wg-mtu-'));
}

test('patch-wg-mtu.sh: adds MTU = 1280 to a pre-existing wg0.conf', () => {
  if (!fs.existsSync(PATCH_SCRIPT)) {
    return assert.fail(`patch script missing at ${PATCH_SCRIPT}`);
  }
  const dir = mkTmpDir();
  const conf = path.join(dir, 'wg0.conf');
  fs.writeFileSync(conf,
    '[Interface]\n' +
    'Address = 10.100.0.1/24\n' +
    'ListenPort = 49000\n' +
    'PrivateKey = abc\n');
  const r = runPatch(['--config', conf, '--no-restart']);
  assert.equal(r.status, 0, `patch failed: ${r.stderr}`);
  const body = fs.readFileSync(conf, 'utf-8');
  // Exactly one MTU line, immediately under [Interface], with the
  // default 1280 value.
  const mtuLines = body.split('\n').filter(l => /^MTU\s*=/.test(l));
  assert.equal(mtuLines.length, 1, 'expected exactly one MTU line');
  assert.equal(mtuLines[0], 'MTU = 1280');
  assert.match(body, /^\[Interface\]\nMTU = 1280$/m);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('patch-wg-mtu.sh: idempotent — second run does not duplicate the MTU line', () => {
  const dir = mkTmpDir();
  const conf = path.join(dir, 'wg0.conf');
  fs.writeFileSync(conf,
    '[Interface]\n' +
    'Address = 10.100.0.1/24\n' +
    'ListenPort = 49000\n' +
    'PrivateKey = abc\n');
  const r1 = runPatch(['--config', conf, '--no-restart']);
  assert.equal(r1.status, 0);
  const after1 = fs.readFileSync(conf, 'utf-8');
  const r2 = runPatch(['--config', conf, '--no-restart']);
  assert.equal(r2.status, 0);
  const after2 = fs.readFileSync(conf, 'utf-8');
  assert.equal(after2, after1, 'second run must not modify the file');
  const mtuLines = after2.split('\n').filter(l => /^MTU\s*=/.test(l));
  assert.equal(mtuLines.length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('patch-wg-mtu.sh: PROXYPILOT_VPN_MTU=1500 propagates into the patched file', () => {
  const dir = mkTmpDir();
  const conf = path.join(dir, 'wg0.conf');
  fs.writeFileSync(conf,
    '[Interface]\n' +
    'Address = 10.100.0.1/24\n' +
    'ListenPort = 49000\n' +
    'PrivateKey = abc\n');
  const r = runPatch(['--config', conf, '--no-restart'], { PROXYPILOT_VPN_MTU: '1500' });
  assert.equal(r.status, 0);
  const body = fs.readFileSync(conf, 'utf-8');
  assert.match(body, /^MTU = 1500$/m);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('patch-wg-mtu.sh: --mtu flag wins over env var', () => {
  const dir = mkTmpDir();
  const conf = path.join(dir, 'wg0.conf');
  fs.writeFileSync(conf,
    '[Interface]\n' +
    'Address = 10.100.0.1/24\n' +
    'ListenPort = 49000\n' +
    'PrivateKey = abc\n');
  const r = runPatch(
    ['--config', conf, '--mtu', '1400', '--no-restart'],
    { PROXYPILOT_VPN_MTU: '1500' },
  );
  assert.equal(r.status, 0);
  const body = fs.readFileSync(conf, 'utf-8');
  assert.match(body, /^MTU = 1400$/m);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('patch-wg-mtu.sh: existing MTU line is treated as authoritative (no overwrite)', () => {
  const dir = mkTmpDir();
  const conf = path.join(dir, 'wg0.conf');
  // Operator set a custom MTU by hand. Patch must respect it.
  const original =
    '[Interface]\n' +
    'Address = 10.100.0.1/24\n' +
    'MTU = 1380\n' +
    'ListenPort = 49000\n' +
    'PrivateKey = abc\n';
  fs.writeFileSync(conf, original);
  const r = runPatch(['--config', conf, '--no-restart']);
  assert.equal(r.status, 0);
  assert.equal(fs.readFileSync(conf, 'utf-8'), original);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('patch-wg-mtu.sh: missing config file is a benign no-op', () => {
  const dir = mkTmpDir();
  const conf = path.join(dir, 'wg0.conf');
  // Note: file deliberately not created.
  const r = runPatch(['--config', conf, '--no-restart']);
  assert.equal(r.status, 0);
  assert.equal(fs.existsSync(conf), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('patch-wg-mtu.sh: garbage MTU env falls back to 1280', () => {
  const dir = mkTmpDir();
  const conf = path.join(dir, 'wg0.conf');
  fs.writeFileSync(conf,
    '[Interface]\n' +
    'Address = 10.100.0.1/24\n' +
    'ListenPort = 49000\n' +
    'PrivateKey = abc\n');
  const r = runPatch(['--config', conf, '--no-restart'], { PROXYPILOT_VPN_MTU: 'banana' });
  assert.equal(r.status, 0);
  const body = fs.readFileSync(conf, 'utf-8');
  assert.match(body, /^MTU = 1280$/m);
  fs.rmSync(dir, { recursive: true, force: true });
});
