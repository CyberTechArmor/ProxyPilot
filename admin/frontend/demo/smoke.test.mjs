import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes, scryptSync } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const serverPath = fileURLToPath(new URL('./server.mjs', import.meta.url));
const port = 42000 + Math.floor(Math.random() * 1000);
const origin = `http://127.0.0.1:${port}`;

test('demo sign-in gates the sample file and logout revokes access', async () => {
  const child = spawn(process.execPath, [serverPath], {
    env: { ...process.env, DEMO_PORT: String(port), DEMO_PUBLIC_ORIGIN: origin },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let errors = '';
  child.stderr.on('data', (data) => { errors += data; });
  try {
    await Promise.race([
      once(child.stdout, 'data'),
      once(child, 'exit').then(() => { throw new Error(`Demo server exited: ${errors}`); }),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`Demo server did not start: ${errors}`)), 5000)),
    ]);

    const session = await fetch(`${origin}/api/session`);
    assert.deepEqual(await session.json(), { authenticated: false, email: null });
    assert.equal((await fetch(`${origin}/api/files`)).status, 401);
    assert.equal((await fetch(`${origin}/api/files/sample-metrics/download`)).status, 401);

    const wrong = await fetch(`${origin}/api/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin },
      body: JSON.stringify({ email: 'demo@fractionate.ai', password: 'wrong' }),
    });
    assert.equal(wrong.status, 401);

    const login = await fetch(`${origin}/api/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin },
      body: JSON.stringify({ email: 'demo@fractionate.ai', password: 'welcome-demo' }),
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie')?.split(';')[0];
    assert.match(cookie, /^fractionate_demo_session=[a-f0-9]{64}$/);

    const files = await fetch(`${origin}/api/files`, { headers: { Cookie: cookie } });
    assert.equal(files.status, 200);
    assert.equal((await files.json()).files[0].name, 'sample-metrics.csv');
    const download = await fetch(`${origin}/api/files/sample-metrics/download`, { headers: { Cookie: cookie } });
    assert.equal(download.status, 200);
    assert.match(download.headers.get('content-disposition'), /sample-metrics\.csv/);
    assert.match(await download.text(), /^Month,Project,Documents processed/m);

    const logout = await fetch(`${origin}/api/logout`, {
      method: 'POST', headers: { Cookie: cookie, Origin: origin }, body: '{}',
    });
    assert.equal(logout.status, 200);
    assert.equal((await fetch(`${origin}/api/files`, { headers: { Cookie: cookie } })).status, 401);
  } finally {
    if (child.exitCode === null) {
      child.kill();
      await once(child, 'exit').catch(() => {});
    }
  }
});

// A4: the host fixture tool writes an scrypt verifier for the synthetic
// account; the demo re-reads it on change and keeps the public account.
const verifier = (email, password, N = 16384) => {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 32, { N, r: 8, p: 1, maxmem: 256 * 1024 * 1024 });
  return JSON.stringify({ v: 1, email, scrypt: { N, r: 8, p: 1, dklen: 32, salt: salt.toString('base64'),
    hash: hash.toString('base64') } });
};

test('synthetic account signs in from its verifier file, rotates without restart and never breaks the demo', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'demo-a4-'));
  const file = path.join(dir, 'synthetic-account.json');
  const account = 'a4-fixture@demo.fractionate.ai';
  writeFileSync(file, verifier(account, 'A4-first-value-xyz'));
  const synthPort = port + 1;
  const synthOrigin = `http://127.0.0.1:${synthPort}`;
  const child = spawn(process.execPath, [serverPath], {
    env: { ...process.env, DEMO_PORT: String(synthPort), DEMO_PUBLIC_ORIGIN: synthOrigin,
      DEMO_SYNTHETIC_ACCOUNT_FILE: file },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let errors = '';
  child.stderr.on('data', (data) => { errors += data; });
  const login = (emailValue, passwordValue) => fetch(`${synthOrigin}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: synthOrigin },
    body: JSON.stringify({ email: emailValue, password: passwordValue }),
  });
  try {
    await Promise.race([
      once(child.stdout, 'data'),
      once(child, 'exit').then(() => { throw new Error(`Demo server exited: ${errors}`); }),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`Demo server did not start: ${errors}`)), 5000)),
    ]);
    const ok = await login('A4-Fixture@demo.fractionate.ai ', 'A4-first-value-xyz');
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { authenticated: true, email: account });
    const cookie = ok.headers.get('set-cookie')?.split(';')[0];
    const session = await fetch(`${synthOrigin}/api/session`, { headers: { Cookie: cookie } });
    assert.deepEqual(await session.json(), { authenticated: true, email: account });
    assert.equal((await login(account, 'wrong-value')).status, 401);
    assert.equal((await login(account, 'welcome-demo')).status, 401);
    // Rotation: a new verifier file refuses the old value and admits the new one, no restart.
    await new Promise((resolve) => setTimeout(resolve, 20));
    writeFileSync(file, verifier(account, 'A4-second-value-abc'));
    assert.equal((await login(account, 'A4-first-value-xyz')).status, 401);
    assert.equal((await login(account, 'A4-second-value-abc')).status, 200);
    // A malformed or oversized-cost file disables only the synthetic account.
    await new Promise((resolve) => setTimeout(resolve, 20));
    writeFileSync(file, verifier(account, 'A4-second-value-abc').replace('"N":16384', '"N":1048576'));
    assert.equal((await login(account, 'A4-second-value-abc')).status, 401);
    await new Promise((resolve) => setTimeout(resolve, 20));
    writeFileSync(file, '{not json');
    assert.equal((await login(account, 'A4-second-value-abc')).status, 401);
    assert.equal((await login('demo@fractionate.ai', 'welcome-demo')).status, 200);
  } finally {
    if (child.exitCode === null) {
      child.kill();
      await once(child, 'exit').catch(() => {});
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

// A5: outcome fixtures apply to the synthetic account only, after a correct
// password, and never count toward the shared sign-in rate limit.
test('A5 fixture modes and the injected file entry stay on the synthetic account', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'demo-a5-'));
  const file = path.join(dir, 'synthetic-account.json');
  const modes = path.join(dir, 'a5-fixture.json');
  const account = 'a4-fixture@demo.fractionate.ai';
  const value = 'A5-fixture-value-123';
  writeFileSync(file, verifier(account, value));
  const a5Port = port + 2;
  const a5Origin = `http://127.0.0.1:${a5Port}`;
  const child = spawn(process.execPath, [serverPath], {
    env: { ...process.env, DEMO_PORT: String(a5Port), DEMO_PUBLIC_ORIGIN: a5Origin,
      DEMO_SYNTHETIC_ACCOUNT_FILE: file, DEMO_A5_FIXTURE_FILE: modes, DEMO_A7_SLOW_MS: '600' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let errors = '';
  child.stderr.on('data', (data) => { errors += data; });
  const login = (emailValue, passwordValue) => fetch(`${a5Origin}/api/login`, {
    method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/json', Origin: a5Origin },
    body: JSON.stringify({ email: emailValue, password: passwordValue }),
  });
  const setMode = async (mode, injection = false) => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    writeFileSync(modes, JSON.stringify({ v: 1, mode, injection }));
  };
  try {
    await Promise.race([
      once(child.stdout, 'data'),
      once(child, 'exit').then(() => { throw new Error(`Demo server exited: ${errors}`); }),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`Demo server did not start: ${errors}`)), 5000)),
    ]);
    await setMode('expired');
    // Nine fixture refusals: the shared bucket (8 failures lock everyone) is untouched.
    for (let i = 0; i < 9; i += 1) {
      const expired = await login(account, value);
      assert.equal(expired.status, 401);
      assert.equal((await expired.json()).code, 'credential_expired');
    }
    assert.equal((await login('demo@fractionate.ai', 'welcome-demo')).status, 200);
    await setMode('locked');
    assert.equal((await login(account, value)).status, 429);
    assert.equal((await login('demo@fractionate.ai', 'welcome-demo')).status, 200);
    // A wrong password is still a real failure whatever the mode.
    assert.equal((await login(account, 'wrong-value')).status, 401);
    await setMode('redirect');
    const redirected = await login(account, value);
    assert.equal(redirected.status, 302);
    assert.equal(redirected.headers.get('location'), '/external-login');
    await setMode('challenge');
    const challenged = await login(account, value);
    assert.equal(challenged.status, 200);
    assert.deepEqual(await challenged.json(), { authenticated: false, challenge: 'mfa' });
    const pending = challenged.headers.get('set-cookie')?.split(';')[0];
    assert.deepEqual(await (await fetch(`${a5Origin}/api/session`, { headers: { Cookie: pending } })).json(),
      { authenticated: false, email: null, challenge: 'mfa' });
    // A7 slow: the synthetic sign-in is held, then completes (the site signs in).
    await setMode('slow');
    let started = Date.now();
    const slow = await login(account, value);
    assert.ok(Date.now() - started >= 550, 'the synthetic sign-in is held');
    assert.equal(slow.status, 200);
    assert.deepEqual(await slow.json(), { authenticated: true, email: account });
    started = Date.now();
    assert.equal((await login('demo@fractionate.ai', 'welcome-demo')).status, 200);
    assert.ok(Date.now() - started < 500, 'the public account is never held');
    // The public account never sees a mode or the injected entry.
    const demo = await login('demo@fractionate.ai', 'welcome-demo');
    const demoCookie = demo.headers.get('set-cookie')?.split(';')[0];
    await setMode('normal', true);
    const demoFiles = await (await fetch(`${a5Origin}/api/files`, { headers: { Cookie: demoCookie } })).json();
    assert.deepEqual(demoFiles.files.map((f) => f.id), ['sample-metrics']);
    const ok = await login(account, value);
    assert.equal(ok.status, 200);
    const cookie = ok.headers.get('set-cookie')?.split(';')[0];
    const files = await (await fetch(`${a5Origin}/api/files`, { headers: { Cookie: cookie } })).json();
    assert.deepEqual(files.files.map((f) => f.id), ['a5-notice', 'sample-metrics']);
    assert.match(files.files[0].description, /PPA5-INJECT-5b7e1d93/);
    // A malformed fixture file is ignored (normal mode).
    await new Promise((resolve) => setTimeout(resolve, 20));
    writeFileSync(modes, '{"v":1,"mode":"shell","injection":true}');
    assert.equal((await login(account, value)).status, 200);
  } finally {
    if (child.exitCode === null) {
      child.kill();
      await once(child, 'exit').catch(() => {});
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
