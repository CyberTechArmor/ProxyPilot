import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, linkSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { buildTaskRecordWriteScript, writeTaskRecordFile, assertTaskMirrorSettled } from '../mock2/task-record-write.js';

const key = 't1-proof';
const record = (revision = 1) => JSON.stringify({ schema: 'mock2-task@1', taskId: key, revision });
const path = `state/tasks/${key}/task.json`;
function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'pp-task-record-'));
  const root = join(base, "project ' $(touch INJECTED) ü");
  const outside = join(base, 'outside');
  mkdirSync(root);mkdirSync(outside);writeFileSync(join(outside, 'sentinel'), 'untouched');
  return { base, root, outside, close: () => rmSync(base, { recursive: true, force: true }) };
}
function run(f, entry, transform = x => x) {
  const script = transform(buildTaskRecordWriteScript(entry, { appDir: f.root }));
  const result = spawnSync('sh', ['-c', script], { encoding: 'utf8', timeout: 3000 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^PP_TASK_WRITE_RESULT /);
  return JSON.parse(result.stdout.trim().slice('PP_TASK_WRITE_RESULT '.length));
}

test('FD0130-2 real task writer atomically updates its own bounded record in quoted Unicode roots', () => {
  const f = fixture();
  try {
    assert.equal(run(f, { path, content: record() }).written, true);
    assert.equal(run(f, { path, content: record(2) }).ok, true);
    assert.equal(JSON.parse(readFileSync(join(f.root, path), 'utf8')).revision, 2);
    assert.equal(run(f, { path, content: record(1) }).ok, false, 'an old revision never replaces a newer mirror');
    assert.equal(JSON.parse(readFileSync(join(f.root, path), 'utf8')).revision, 2);
    assert.equal(existsSync(join(f.root, 'INJECTED')), false);
    assert.deepEqual(readdirSync(join(f.root, 'state/tasks', key)), ['task.json']);
    assert.throws(() => buildTaskRecordWriteScript({ path, content: 'x'.repeat(65537) }), /limit/);
  } finally { f.close(); }
});

test('FD0130-2 symlinked parents, final symlink, hardlink and nonregular files cannot modify an outside file', () => {
  for (const kind of ['state', 'tasks', 'task', 'symlink', 'hardlink', 'directory', 'fifo']) {
    const f = fixture();
    try {
      if (kind === 'state') symlinkSync(f.outside, join(f.root, 'state'));
      else if (kind === 'tasks') { mkdirSync(join(f.root, 'state'));symlinkSync(f.outside, join(f.root, 'state/tasks')); }
      else if (kind === 'task') { mkdirSync(join(f.root, 'state/tasks'), { recursive: true });symlinkSync(f.outside, join(f.root, 'state/tasks', key)); }
      else {
        mkdirSync(join(f.root, 'state/tasks', key), { recursive: true });
        const target = join(f.root, path), sentinel = join(f.outside, 'sentinel');
        if (kind === 'symlink') symlinkSync(sentinel, target);
        if (kind === 'hardlink') linkSync(sentinel, target);
        if (kind === 'directory') mkdirSync(target);
        if (kind === 'fifo') assert.equal(spawnSync('mkfifo', [target]).status, 0);
      }
      assert.equal(run(f, { path, content: record() }).ok, false, kind);
      assert.equal(readFileSync(join(f.outside, 'sentinel'), 'utf8'), 'untouched', kind);
      assert.deepEqual(readdirSync(f.outside), ['sentinel'], kind);
    } finally { f.close(); }
  }
});

test('FD0130-2 conventions are create-only, foreign task records and arbitrary paths are preserved', () => {
  const f = fixture();
  try {
    writeFileSync(join(f.root, 'AGENTS.md'), 'project-owned instructions');
    assert.deepEqual(run(f, { path: 'AGENTS.md', content: 'replacement', createOnly: true }), { ok: true, written: false, error: null });
    assert.equal(readFileSync(join(f.root, 'AGENTS.md'), 'utf8'), 'project-owned instructions');
    assert.equal(run(f, { path: 'state/tasks/README.md', content: 'format', createOnly: true }).written, true);
    for (const name of ['../outside/sentinel', '/etc/passwd', 'state/other.txt']) assert.equal(run(f, { path: name, content: record() }).ok, false);
    mkdirSync(join(f.root, 'state/tasks', key));writeFileSync(join(f.root, path), 'foreign data');
    assert.equal(run(f, { path, content: record() }).ok, false);
    assert.equal(readFileSync(join(f.root, path), 'utf8'), 'foreign data');
  } finally { f.close(); }
});

test('FD0130-2 parent replacement immediately before publication is detected and leaves outside content unchanged', () => {
  const f = fixture();
  try {
    const result = run(f, { path, content: record() }, script => script.replace('anchor();current=inspect(parent,name)', `os.rename(root+'/state',root+'/moved');os.symlink(${JSON.stringify(f.outside)},root+'/state');anchor();current=inspect(parent,name)`));
    assert.equal(result.ok, false);
    assert.equal(readFileSync(join(f.outside, 'sentinel'), 'utf8'), 'untouched');
    assert.deepEqual(readdirSync(f.outside), ['sentinel']);
    assert.deepEqual(readdirSync(join(f.root, 'moved/tasks', key)), []);
  } finally { f.close(); }
});

test('FD0130-2 concurrent task directory hold refuses publication and a settled holder permits retry', async () => {
  const f = fixture();let child;
  try {
    mkdirSync(join(f.root, 'state/tasks', key), { recursive: true });
    child = spawn('python3', ['-c', "import fcntl,os,sys;f=os.open(sys.argv[1],os.O_RDONLY);fcntl.flock(f,fcntl.LOCK_EX);print('held',flush=True);sys.stdin.read()", join(f.root, 'state/tasks', key)], { stdio: ['pipe', 'pipe', 'pipe'] });
    await once(child.stdout, 'data');
    assert.equal(run(f, { path, content: record() }).error, 'task_record_busy');
    child.stdin.end();await once(child, 'exit');child=null;
    assert.equal(run(f, { path, content: record() }).ok, true);
  } finally { child?.kill('SIGKILL');f.close(); }
});

test('FD0130-2 an unacknowledged transport outcome cannot release a checkout operation fence', async () => {
  for (const result of [{ code: 124, stdout: '', stderr: 'timeout' }, { code: 0, stdout: 'garbage', stderr: '' }]) {
    const answer = await writeTaskRecordFile(async () => result, 'fixture', path, record());
    assert.equal(answer.ok, false);assert.equal(answer.settled, false);
    assert.equal(answer.error, 'task_record_outcome_unknown');
  }
});

test('FD0130 an uncertain task write blocks the owning cycle; acknowledged refusal remains best-effort', () => {
  assert.doesNotThrow(() => assertTaskMirrorSettled({ result: { ok: false, settled: true, error: 'python3_required' } }));
  for (const args of [{ result: { uncertain: true } }, { lock: { holder_cycle_id: 9, holder_operation_id: 'real-token', holder_operation_state: 'uncertain' } }]) {
    assert.throws(() => assertTaskMirrorSettled(args), { code: 'MOCK2_TASK_FILES_UNCERTAIN' });
  }
});

test('FD0130 missing container Python is an acknowledged refusal and writes no record', () => {
  const f = fixture();
  try {
    const result = spawnSync('/bin/sh', ['-c', buildTaskRecordWriteScript({ path, content: record() }, { appDir: f.root })], { encoding: 'utf8', env: { PATH: '/definitely-no-container-python' } });
    assert.equal(result.status, 0);
    assert.deepEqual(JSON.parse(result.stdout.trim().slice('PP_TASK_WRITE_RESULT '.length)), { ok: false, written: false, error: 'python3_required' });
    assert.equal(existsSync(join(f.root, path)), false);
  } finally { f.close(); }
});

test('FD0130 fixed Python writer ignores project-controlled module search paths', () => {
  const f = fixture();
  try {
    const modules = join(f.base, 'modules'); mkdirSync(modules);
    writeFileSync(join(modules, 'base64.py'), `raise RuntimeError('project module executed')\n`);
    const result = spawnSync('/bin/sh', ['-c', buildTaskRecordWriteScript({ path, content: record() }, { appDir: f.root })], { encoding: 'utf8', env: { ...process.env, PYTHONPATH: modules } });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout.trim().slice('PP_TASK_WRITE_RESULT '.length)).ok, true);
    assert.equal(JSON.parse(readFileSync(join(f.root, path))).taskId, key);
  } finally { f.close(); }
});
