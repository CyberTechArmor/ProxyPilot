import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
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
