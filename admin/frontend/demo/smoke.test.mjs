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
