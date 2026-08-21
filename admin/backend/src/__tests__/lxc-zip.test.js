// Unit tests for lib/lxc-zip.js — the container half of the zip
// upload flow: mode-preserving tar building, the in-container shell
// script builders, and the startup-script orchestration.
//
// Native-free by construction: incus is never called — every
// orchestrator takes an injectable `run` seam (same approach the
// cert-mount-reconciler suite uses for execHost) and the tests
// inject recorders/stubs.

import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseZip } from '../lib/zip-extract.js';
import {
  STARTUP_UNIT_PATH, STARTUP_UNIT_NAME,
  makeTarHeader, writeTarFromZip,
  buildExistenceCheckScript, parseExistenceCheckOutput,
  buildApplyScript, buildStartupUnit, buildStartupRegisterScript,
  buildPreviousStartupOldifyScript, buildReadStartupUnitScript, parseStartupUnit,
  checkContainerConflicts, readContainerStartup, applyTarToContainer, setupStartupScript,
} from '../lib/lxc-zip.js';

// Minimal zip builder (same shape as zip-extract.test.js's).
function makeZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const f of files) {
    const nameBuf = Buffer.from(f.name, 'utf-8');
    const data = Buffer.from(f.data || '', 'utf-8');
    const method = f.dir ? 0 : 8;
    const comp = method === 8 ? zlib.deflateRawSync(data) : data;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const localChunk = Buffer.concat([local, nameBuf, comp]);
    locals.push(localChunk);
    const mode = f.mode ?? (f.dir ? 0o755 : 0o644);
    const typeBits = f.dir ? 0o040000 : 0o100000;
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(comp.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(((typeBits | mode) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([central, nameBuf]));
    offset += localChunk.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

const LAX = { maxZipBytes: 64 * 1024 * 1024, maxExtractedBytes: 64 * 1024 * 1024, maxEntries: 1000 };

// Tiny ustar reader for round-trip assertions.
function readTar(buf) {
  const out = [];
  let off = 0;
  while (off + 512 <= buf.length) {
    const block = buf.slice(off, off + 512);
    if (block.every((b) => b === 0)) break;
    const name = block.slice(0, 100).toString('utf-8').replace(/\0.*$/, '');
    const prefix = block.slice(345, 500).toString('utf-8').replace(/\0.*$/, '');
    const mode = parseInt(block.slice(100, 108).toString('utf-8').replace(/\0.*$/, ''), 8);
    const size = parseInt(block.slice(124, 136).toString('utf-8').replace(/\0.*$/, ''), 8);
    const typeflag = block[156];
    const data = buf.slice(off + 512, off + 512 + size);
    out.push({ path: prefix ? `${prefix}/${name}` : name, mode, size, typeflag, data: data.toString('utf-8') });
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}

// ── tar building ────────────────────────────────────────────────────

test('writeTarFromZip: modes (incl. exec bit), dirs and nesting survive', async () => {
  const zip = makeZip([
    { name: 'startup.sh', data: '#!/bin/sh\necho up\n', mode: 0o755 },
    { name: 'conf/', dir: true },
    { name: 'conf/app.json', data: '{"a":1}' },
  ]);
  const { entries } = parseZip(zip, LAX);
  const tarPath = join(mkdtempSync(join(tmpdir(), 'pp-tar-')), 'out.tar');
  await writeTarFromZip(zip, entries, tarPath, LAX);
  const records = readTar(readFileSync(tarPath));
  const byPath = Object.fromEntries(records.map((r) => [r.path.replace(/\/$/, ''), r]));

  assert.equal(byPath['startup.sh'].mode & 0o755, 0o755);
  assert.equal(byPath['startup.sh'].data, '#!/bin/sh\necho up\n');
  assert.equal(byPath['conf'].typeflag, 0x35);
  assert.equal(byPath['conf/app.json'].data, '{"a":1}');
  assert.equal(byPath['conf/app.json'].mode & 0o644, 0o644);
});

test('makeTarHeader: long paths use the ustar prefix split', () => {
  const long = `${'a'.repeat(90)}/${'b'.repeat(90)}/file.txt`;
  const h = makeTarHeader(long, 0, 0o644);
  const name = h.slice(0, 100).toString('utf-8').replace(/\0.*$/, '');
  const prefix = h.slice(345, 500).toString('utf-8').replace(/\0.*$/, '');
  assert.equal(`${prefix}/${name}`, long);
});

// ── script builders ─────────────────────────────────────────────────

test('buildApplyScript: staged extract, .old renames for conflicts, merge, marker', () => {
  const script = buildApplyScript({
    targetDir: '/opt/app',
    stageName: '.pp-zip-stage-x',
    conflicts: ['index.html', "weird 'name'.txt"],
  });
  assert.match(script, /^set -e/m);
  assert.match(script, /STAGE='\/opt\/app\/\.pp-zip-stage-x'/);
  assert.match(script, /tar -C "\$STAGE" -xpf -/);
  assert.match(script, /rm -rf '\/opt\/app\/index\.html\.old'; mv '\/opt\/app\/index\.html' '\/opt\/app\/index\.html\.old'/);
  // Single-quote escaping for hostile names.
  assert.ok(script.includes("weird '\\''name'\\''.txt"));
  assert.match(script, /cp -a "\$STAGE"\/\. "\$TARGET"\//);
  assert.match(script, /echo PP_APPLY_OK/);
  // Stage dir is always cleaned up, success or failure.
  assert.match(script, /trap 'rm -rf "\$STAGE"' EXIT/);
});

test('existence check: script shape + output parse round-trip', () => {
  const script = buildExistenceCheckScript('/srv/site');
  assert.match(script, /TARGET='\/srv\/site'/);
  assert.match(script, /while IFS= read -r p/);
  const parsed = parseExistenceCheckOutput('F index.html\nD assets\nF a b.txt\n\n');
  assert.deepEqual(parsed, { files: ['index.html', 'a b.txt'], dirs: ['assets'] });
});

test('startup unit builds and parses back', () => {
  const unit = buildStartupUnit({ scriptPath: '/opt/app/startup.sh', workingDir: '/opt/app' });
  assert.match(unit, /WantedBy=multi-user\.target/);
  const parsed = parseStartupUnit(unit);
  assert.deepEqual(parsed, {
    scriptPath: '/opt/app/startup.sh',
    workingDir: '/opt/app',
    isProxyPilot: true,
  });
  assert.equal(parseStartupUnit(''), null);
});

test('register script: chmod, unit heredoc, enable, markers', () => {
  const script = buildStartupRegisterScript({ scriptPath: '/opt/app/startup.sh', workingDir: '/opt/app' });
  assert.match(script, /chmod \+x '\/opt\/app\/startup\.sh'/);
  assert.match(script, /\[ ! -d \/run\/systemd\/system \]/);
  assert.ok(script.includes(`cat > '${STARTUP_UNIT_PATH}' <<'PP_UNIT_EOF'`));
  assert.match(script, /systemctl daemon-reload/);
  assert.ok(script.includes(`systemctl enable '${STARTUP_UNIT_NAME}'`));
  assert.match(script, /echo PP_REGISTERED/);
});

test('previous-startup oldify script renames with .old replacement', () => {
  const script = buildPreviousStartupOldifyScript('/opt/old/boot.sh');
  assert.match(script, /rm -rf '\/opt\/old\/boot\.sh\.old'; mv '\/opt\/old\/boot\.sh' '\/opt\/old\/boot\.sh\.old'/);
});

// ── orchestration with a mocked exec seam ───────────────────────────

function recorder(responses) {
  const calls = [];
  const run = async (incusName, script, opts = {}) => {
    calls.push({ incusName, script, opts });
    const r = responses[calls.length - 1] || {};
    return { status: 0, stdout: '', stderr: '', timedOut: false, error: null, ...r };
  };
  return { calls, run };
}

test('checkContainerConflicts feeds paths on stdin and parses the reply', async () => {
  const { calls, run } = recorder([{ stdout: 'F index.html\nD assets\n' }]);
  const out = await checkContainerConflicts('pp-web', '/opt/app', ['index.html', 'assets', 'new.txt'], { run });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].incusName, 'pp-web');
  assert.equal(calls[0].opts.input, 'index.html\nassets\nnew.txt\n');
  assert.deepEqual(out, { files: ['index.html'], dirs: ['assets'] });
});

test('checkContainerConflicts surfaces exec failure (stopped container)', async () => {
  const { run } = recorder([{ status: 1, stderr: 'Error: instance is not running' }]);
  await assert.rejects(
    () => checkContainerConflicts('pp-web', '/opt/app', ['a'], { run }),
    /instance is not running/,
  );
});

test('applyTarToContainer requires exit 0 + PP_APPLY_OK', async () => {
  const ok = recorder([{ stdout: 'PP_APPLY_OK\n' }]);
  await applyTarToContainer('pp-web', {
    targetDir: '/opt/app', stageName: '.s', conflicts: [], tarPath: null, tarInput: Buffer.alloc(1024),
  }, { run: ok.run });
  assert.match(ok.calls[0].script, /tar -C/);

  const bad = recorder([{ status: 1, stderr: 'tar: broken' }]);
  await assert.rejects(
    () => applyTarToContainer('pp-web', {
      targetDir: '/opt/app', stageName: '.s', conflicts: [], tarPath: null, tarInput: Buffer.alloc(0),
    }, { run: bad.run }),
    /tar: broken/,
  );
});

test('readContainerStartup: none registered → null; registered → parsed', async () => {
  const none = recorder([{ stdout: '' }]);
  assert.equal(await readContainerStartup('pp-web', { run: none.run }), null);

  const unit = buildStartupUnit({ scriptPath: '/opt/app/startup.sh', workingDir: '/opt/app' });
  const some = recorder([{ stdout: unit }]);
  const parsed = await readContainerStartup('pp-web', { run: some.run });
  assert.equal(parsed.scriptPath, '/opt/app/startup.sh');
  assert.ok(some.calls[0].script.includes(STARTUP_UNIT_PATH));
});

test('setupStartupScript: oldifies the previous script, registers, runs, reports output', async () => {
  const { calls, run } = recorder([
    { stdout: 'PP_OLDIFY_OK\n' },
    { stdout: 'PP_REGISTERED\n' },
    { status: 3, stdout: 'starting…\n', stderr: 'port already bound\n' },
  ]);
  const result = await setupStartupScript('pp-web', {
    scriptPath: '/opt/app/startup.sh',
    workingDir: '/opt/app',
    previousScriptPath: '/opt/app/old-boot.sh',
    runNow: true,
  }, { run });

  assert.equal(calls.length, 3);
  assert.match(calls[0].script, /mv '\/opt\/app\/old-boot\.sh' '\/opt\/app\/old-boot\.sh\.old'/);
  assert.match(calls[1].script, /systemctl enable/);
  assert.match(calls[2].script, /cd '\/opt\/app' && exec '\/opt\/app\/startup\.sh'/);
  assert.deepEqual(result, {
    registered: true,
    noSystemd: false,
    previousBackedUp: true,
    run: { exitCode: 3, timedOut: false, stdout: 'starting…\n', stderr: 'port already bound\n' },
  });
});

test('setupStartupScript: same script path skips the oldify; runNow=false skips the run', async () => {
  const { calls, run } = recorder([{ stdout: 'PP_REGISTERED\n' }]);
  const result = await setupStartupScript('pp-web', {
    scriptPath: '/opt/app/startup.sh',
    workingDir: '/opt/app',
    previousScriptPath: '/opt/app/startup.sh', // replaced via the normal file-conflict flow
    runNow: false,
  }, { run });
  assert.equal(calls.length, 1);
  assert.equal(result.previousBackedUp, false);
  assert.equal(result.run, null);
});

test('setupStartupScript: non-systemd image degrades to a warning, not a failure', async () => {
  const { run } = recorder([{ stdout: 'PP_NO_SYSTEMD\n' }, { status: 0, stdout: 'ok\n' }]);
  const result = await setupStartupScript('pp-web', {
    scriptPath: '/opt/app/startup.sh', workingDir: '/opt/app', runNow: true,
  }, { run });
  assert.equal(result.registered, false);
  assert.equal(result.noSystemd, true);
  assert.equal(result.run.exitCode, 0);
});

test('setupStartupScript: failed registration throws with stderr', async () => {
  const { run } = recorder([{ status: 1, stderr: 'systemctl: not found' }]);
  await assert.rejects(
    () => setupStartupScript('pp-web', { scriptPath: '/a/s.sh', workingDir: '/a', runNow: false }, { run }),
    /systemctl: not found/,
  );
});

// ---- runHostCapture: the transport that silently ate 40 KB ----
//
// This wrapper is what every file read in the MCP server goes through. It used
// to concatenate `chunk.toString('utf-8')` until 256 KB and then quietly stop,
// while the tools built on it advertised a 512 KB read. A ~300 KB file
// therefore came back cut at whatever chunk boundary crossed the cap — the
// caller could not tell, and edit_project_file wrote the stump back over the
// real file. Five files were corrupted that way before anyone noticed.

import { runHostCapture, CAPTURE_CAP } from '../lib/lxc-zip.js';

// `sh` is the binary under every incus exec in this file; using it directly
// keeps the test honest about real pipe behaviour without an Incus daemon.
const bigOutput = (bytes) => ['-c', `head -c ${bytes} /dev/zero | tr "\\0" a`];

test('runHostCapture reports the cap instead of hiding it', async () => {
  const r = await runHostCapture('sh', bigOutput(CAPTURE_CAP + 80_000));
  assert.equal(r.status, 0);
  assert.equal(r.stdoutBytes, CAPTURE_CAP);
  assert.equal(r.stdoutTruncated, true, 'a capped capture MUST announce itself');
  // Exactly the cap, not "the cap plus whatever the last chunk carried" — the
  // ragged cut points (~267 KB, ~299 KB, ~327 KB) were that overshoot.
  assert.equal(r.stdout.length, CAPTURE_CAP);
});

test('runHostCapture returns the whole stream when the budget covers it', async () => {
  const want = CAPTURE_CAP + 80_000;
  const r = await runHostCapture('sh', bigOutput(want), { maxCapture: want + 4096 });
  assert.equal(r.stdoutBytes, want);
  assert.equal(r.stdoutTruncated, false);
  assert.equal(r.stdoutComplete, true);
  assert.equal(r.stdout.length, want);
});

test('runHostCapture decodes UTF-8 across chunk boundaries', async () => {
  // Multi-byte characters spread through 300 KB: decoding per chunk turns any
  // that straddle a boundary into U+FFFD, which is silent corruption in a
  // read-modify-write.
  const unit = `${'x'.repeat(511)}é`;
  const reps = 600;
  const r = await runHostCapture(
    'sh', ['-c', `i=0; while [ $i -lt ${reps} ]; do printf '%s' '${unit}'; i=$((i+1)); done`],
    { maxCapture: 1024 * 1024 },
  );
  assert.equal(r.status, 0);
  assert.equal(r.stdoutTruncated, false);
  assert.equal(r.stdout.includes('�'), false, 'no replacement characters');
  assert.equal(r.stdout, unit.repeat(reps));
});

test('runHostCapture still surfaces exit status and stderr', async () => {
  const r = await runHostCapture('sh', ['-c', 'printf oops >&2; exit 3']);
  assert.equal(r.status, 3);
  assert.equal(r.stderr, 'oops');
  assert.equal(r.timedOut, false);
});

test('runHostCapture waits for stdout to flush after the child exits', async () => {
  // A last write immediately before exit: settling on 'exit' alone can drop it.
  for (let i = 0; i < 20; i += 1) {
    const r = await runHostCapture('sh', ['-c', 'printf "%s" tail-marker']);
    assert.equal(r.stdout, 'tail-marker', `iteration ${i} lost the tail`);
    assert.equal(r.stdoutComplete, true);
  }
});
