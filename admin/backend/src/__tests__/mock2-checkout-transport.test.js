import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, mkdtempSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { withCheckoutOperationLease, captureCheckoutShell, captureCheckoutHost } from '../mock2/checkout-operation.js';

function reservations() {
  const rows = new Map(); let next = 0;
  const methods = {
    acquire(projectId, kind) { if (rows.has(projectId)) return { ok: false, reason: 'held by another writer' }; const token = `test-${++next}`; rows.set(projectId, { token, kind, state: 'active' }); return { ok: true, token }; },
    settle(projectId, token) { if (rows.get(projectId)?.token !== token) return false; return rows.delete(projectId); },
    markUncertain(projectId, token) { if (rows.get(projectId)?.token !== token) return false; rows.get(projectId).state = 'uncertain'; return true; },
  };
  return { rows, methods, options: (projectId, kind = 'mcp-write') => ({ projectId, kind, ...methods }) };
}
function shell(body) {
  const r = spawnSync('sh', ['-c', body], { encoding: 'utf8', timeout: 5000 });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

test('FD0130 acknowledged shell failure is a completed outcome and stdout remains byte-identical', async () => {
  const w = reservations();
  const result = await withCheckoutOperationLease(w.options(1), () => captureCheckoutShell("printf '%s' \"a'b\"; exit 66", shell));
  assert.equal(result.code, 66); assert.equal(result.stdout, "a'b"); assert.equal(w.rows.size, 0);
});

test('FD0130 missing, timed-out, or incomplete acknowledgment retains an uncertain operation', async () => {
  for (const fault of ['missing','timeout','incomplete','exception']) {
    const w = reservations();
    await assert.rejects(withCheckoutOperationLease(w.options(1), () => captureCheckoutShell('printf done', body => {
      if (fault === 'exception') throw new Error('transport reply lost');
      const result = shell(body);
      if (fault === 'missing') result.stdout = 'done';
      if (fault === 'timeout') result.timedOut = true;
      if (fault === 'incomplete') result.stdoutComplete = false;
      return result;
    })));
    assert.equal(w.rows.get(1).state, 'uncertain');
    assert.equal(w.methods.acquire(1, 'restore').ok, false);
  }
});

test('FD0130 incus acknowledgment preserves argv, stdin, and captured byte accounting without injection', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'checkout-argv-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const victim = join(directory, 'must-not-exist'), value = `literal '; touch ${victim}; #`, input = 'payload\n';
  const args = ['exec','synthetic','--','sh','-c','printf "%s" "$1"; cat; exit 7','sh',value], options = { input };
  const w = reservations();
  const result = await withCheckoutOperationLease(w.options(2), () => captureCheckoutHost(async (bin, argv, supplied) => {
    assert.equal(bin, 'incus'); assert.equal(supplied, options);
    const at = argv.indexOf('--'), r = spawnSync(argv[at + 1], argv.slice(at + 2), { input: supplied.input, encoding: 'utf8', timeout: 5000 });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr, stdoutBytes: Buffer.byteLength(r.stdout), stdoutComplete: true };
  }, 'incus', args, options));
  assert.equal(result.status, 7); assert.equal(result.stdout, value + input);
  assert.equal(result.stdoutBytes, Buffer.byteLength(value + input));
  assert.equal(existsSync(victim), false); assert.equal(w.rows.size, 0);
  let unchanged;
  await captureCheckoutHost((_bin, untouched, supplied) => { unchanged = [untouched, supplied]; return { status: 0 }; }, 'incus', args, options);
  assert.equal(unchanged[0], args); assert.equal(unchanged[1], options, 'read-only/outside-context calls gain no wrapper');
});

test('FD0130 operation context holds through delayed RPC and isolates concurrent projects', async () => {
  const w = reservations(); let finish;
  const wait = new Promise(resolve => { finish = resolve; });
  const pending = withCheckoutOperationLease(w.options(1), () => captureCheckoutShell('printf first', async body => { await wait; return shell(body); }));
  assert.equal(w.methods.acquire(1, 'task-continuity').ok, false);
  const separate = await withCheckoutOperationLease(w.options(2), () => captureCheckoutShell('printf second', shell));
  assert.equal(separate.stdout, 'second'); assert.equal(w.rows.has(2), false); assert.equal(w.rows.has(1), true);
  finish(); assert.equal((await pending).stdout, 'first'); assert.equal(w.rows.size, 0);
  await assert.rejects(withCheckoutOperationLease(w.options(3), async () => { throw new Error('invalid before dispatch'); }));
  assert.equal(w.rows.has(3), false, 'validation before RPC can release its own reservation');
});

test('FD0130 actual MCP central wrapper admits its own operation and blocks competing project writes', async () => {
  const source = readFileSync(new URL('../routes/mcp.js', import.meta.url), 'utf8');
  let factorySource = source.slice(source.indexOf('function checkoutMutationHandler('), source.indexOf('const TOOL_HANDLERS = {'));
  assert.ok(factorySource.includes("await import('../mock2/locks.js')"));
  factorySource = factorySource.replace("await import('../mock2/locks.js')", 'leaseDeps');
  const w = reservations(), leaseDeps = { acquireCheckoutOperationLease: w.methods.acquire, settleCheckoutOperationLease: w.methods.settle, markCheckoutOperationLeaseUncertain: w.methods.markUncertain };
  const factory = new Function('mock2Modules','requireActiveProject','leaseDeps','withCheckoutOperationLease','toolResult', `${factorySource};return checkoutMutationHandler;`)(
    async () => ({}), () => ({ project: { id: 1, lifecycle: 'active' } }), leaseDeps, withCheckoutOperationLease, (value, extra) => ({ value, ...extra }));
  let entered = 0;
  const handler = factory(async () => { entered += 1; assert.equal(w.rows.get(1).state, 'active'); return { written: true, isError: false }; });
  assert.deepEqual(await handler({ project_id: 1 }, {}, null), { written: true, isError: false });
  assert.equal(entered, 1); assert.equal(w.rows.size, 0);
  w.methods.acquire(1, 'task-continuity');
  assert.equal((await handler({ project_id: 1 }, {}, null)).isError, true); assert.equal(entered, 1);
  for (const name of ['write_project_file','edit_project_file','append_project_file','insert_project_file_at_line','apply_project_patch','delete_project_file','move_project_file','run_project_command','append_change_record','redeploy_project']) {
    assert.match(source, new RegExp(`  ${name}: checkoutMutationHandler\\(`));
  }
  assert.match(source, /  read_project_file: toolReadProjectFile,/);
});

test('FD0130 restore response waits for checkout settlement and never sends success for an uncertain write', async () => {
  const source = readFileSync(new URL('../mock2/routes.js', import.meta.url), 'utf8');
  const factorySource = source.slice(source.indexOf('function checkoutRestoreRoute('), source.indexOf("import { listChangeRecords"));
  const w = reservations(), factory = new Function('projectCheckoutOperation', `${factorySource};return checkoutRestoreRoute;`)(
    (projectId, kind, action) => withCheckoutOperationLease(w.options(projectId, kind), action));
  const response = () => ({ statusCode: 200, sent: [], status(code) { this.statusCode = code; return this; }, json(body) { this.sent.push(body); return this; } });
  const req = { mock2Project: { id: 1 } }, success = response();
  await factory(async (_req, pending) => {
    assert.equal(w.rows.get(1).kind, 'restore');
    pending.json({ restored: true }); assert.equal(success.sent.length, 0);
    await captureCheckoutShell('printf done', shell);
  })(req, success);
  assert.equal(w.rows.has(1), false); assert.deepEqual(success.sent, [{ restored: true }]);
  const unknown = response();
  await factory(async (_req, pending) => {
    await captureCheckoutShell('printf done', async () => ({ code: 0, stdout: 'lost marker' }));
    pending.json({ restored: true });
  })(req, unknown);
  assert.equal(unknown.statusCode, 409); assert.equal(unknown.sent[0].restored, undefined);
  assert.equal(w.rows.get(1).state, 'uncertain');
  const competing = response(); await factory(async () => { assert.fail('must not run'); })(req, competing);
  assert.equal(competing.statusCode, 409);
});
