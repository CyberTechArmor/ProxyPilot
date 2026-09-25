import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createEvidenceDecoder } from '../lib/operational-evidence-decoder.js';

const input = Buffer.from('image');
const script = body => (exe => spawn(exe, ['-e', body], { shell: false, env: {}, stdio: ['pipe', 'pipe', 'ignore'] }));

test('decoder refuses malformed worker output and recovers its slot after close', async () => {
  const decode = createEvidenceDecoder({ launch: script("process.stdin.resume();process.stdin.on('end',()=>process.stdout.end('bad\\nbytes'))") });
  await assert.rejects(decode(input), e => e.status === 400);
  await assert.rejects(decode(input), e => e.status === 400);
});

test('early worker exit and oversized stdout fail closed', async () => {
  let closed;
  const tracked = body => exe => { const child = script(body)(exe); closed = new Promise(resolve => child.once('close', resolve)); return child; };
  const early = createEvidenceDecoder({ launch: tracked('process.exit(3)') });
  await assert.rejects(early(input), e => e.status === 400);
  await closed;
  const oversized = createEvidenceDecoder({ launch: tracked("process.stdin.resume();process.stdin.on('end',()=>process.stdout.write(Buffer.alloc(8388865)))") });
  await assert.rejects(oversized(input), e => e.status === 400);
  await closed;
});

test('timeout rejects but retains the only slot until child close', async () => {
  let child;
  const decode = createEvidenceDecoder({ timeoutMs: 20, launch: () => {
    child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough();
    child.kill = () => { child.killed = true; return true; };
    return child;
  } });
  await assert.rejects(decode(input), e => e.status === 400);
  assert.equal(child.killed, true);
  await assert.rejects(decode(input), e => e.status === 429);
  child.emit('close', null);
  await assert.rejects(decode(input), e => e.status === 400);
  child.emit('close', null);
});

test('decoder limits caller bytes and deadline without launching', async () => {
  let launched = 0;
  const decode = createEvidenceDecoder({ launch: () => { launched++; throw Error('unexpected'); } });
  await assert.rejects(decode(Buffer.alloc(8388609)), e => e.status === 400);
  assert.equal(launched, 0);
  assert.throws(() => createEvidenceDecoder({ launch: script(''), timeoutMs: 10001 }), /deadline/);
});
