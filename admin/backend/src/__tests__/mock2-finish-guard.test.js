// FINISH-HANDSHAKE GUARD — request 141's failure, fixed at the layer it happened.
//
// THE BUILD THAT CAUSED THIS, from project 47 request 141's log: the model's
// finish tool call was malformed — the summary parameter literally contained
//
//   "…summary text</summary>\n<parameter name=\"acceptance\">[\"as admin, …\"]"
//
// so the harness never received an `acceptance` parameter, rejected with
// "finish requires `acceptance`…" five identical times ($4.75), never showed
// the model what WAS received, then rejected the model's (correct) harness-
// fault halt for lacking resolution options, and stranded a complete tree in
// awaiting_admin. Every fixture below is that log's shape.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FINISH_REJECTION_BUDGET, TOOL_SYNTAX_FRAGMENTS,
  malformedFinishInput, malformedRejectionMessage, receivedParamsEcho,
  initFinishGuard, recordFinishRejection, escalatedRetryDiagnostic, budgetNote,
  budgetExhaustedSummary, payloadSimilarity, isHarnessFaultHalt, harnessFaultHaltAccepted,
  FINISH_FILE_PATH, parseFinishFile, finishFileHint,
  cycleBaseRef, parseCycleBase, CYCLE_BASE_READ_COMMAND, isFoundationOwnedChange,
  buildFoundationChangeReadScript, parseFoundationChangeRead, platformFoundationHashes,
  foundationEditRefusals, buildFoundationRestoreScript, foundationEditRejectionMessage,
} from '../mock2/finish-guard-logic.js';
import { scaffoldFoundationFiles } from '../mock2/scaffold.js';
import { readFile, mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

// Request 141's payload shape: the whole rest of the call serialized into summary.
const REQUEST_141_PAYLOAD = {
  summary: 'Added the notes list with search and the admin settings link.</summary>\n'
    + '<parameter name="acceptance">["as admin, open the notes list, type in search — the list filters"]</parameter>\n'
    + '<parameter name="assumptions">{"verified":[],"assumed":[]}</parameter>',
};

/* ----------------------- malformed-call detection ------------------------ */

test('request 141 payload is detected as malformed, naming param and fragment', () => {
  const hit = malformedFinishInput(REQUEST_141_PAYLOAD);
  assert.equal(hit.malformed, true);
  assert.equal(hit.param, 'summary');
  assert.equal(hit.fragment, '</summary>');
  assert.ok(hit.where.includes('</summary>'));
});

test('each syntax fragment is detected on its own', () => {
  for (const frag of TOOL_SYNTAX_FRAGMENTS) {
    const hit = malformedFinishInput({ summary: `fine text ${frag} more` });
    assert.equal(hit.malformed, true, frag);
    assert.equal(hit.fragment, frag);
  }
});

test('fragments nested in acceptance[] and assumptions are found', () => {
  const inArray = malformedFinishInput({ summary: 'ok', acceptance: ['fine', 'bad </parameter> here'] });
  assert.equal(inArray.malformed, true);
  assert.equal(inArray.param, 'acceptance[1]');
  const inObj = malformedFinishInput({ summary: 'ok', assumptions: { verified: ['<parameter name="x">'], assumed: [] } });
  assert.equal(inObj.malformed, true);
});

test('a clean payload is not malformed — including XML-ish prose that is not tool syntax', () => {
  assert.equal(malformedFinishInput({
    summary: 'Rendered <section data-screen="Notes"> per the mockup; added a <select> for status.',
    acceptance: ['as admin, open /, expect the notes grid'],
    assumptions: { verified: ['src/app.ts mounts notesRoutes last'], assumed: [] },
  }).malformed, false);
});

test('the malformed rejection quotes the fragment, its location, and echoes received params', () => {
  const hit = malformedFinishInput(REQUEST_141_PAYLOAD);
  const msg = malformedRejectionMessage(hit, REQUEST_141_PAYLOAD);
  assert.ok(msg.includes('MALFORMED'));
  assert.ok(msg.includes('</summary>'));
  assert.ok(msg.includes('summary'));
  assert.ok(msg.includes('Parameters the harness received'));
  assert.ok(msg.includes('Missing or empty: acceptance, assumptions'));
});

/* -------------------------- received-params echo ------------------------- */

test('echo lists every received param with a ≤120-char snippet and names the missing ones', () => {
  const echo = receivedParamsEcho({ summary: 'x'.repeat(500), acceptance: [] });
  assert.ok(echo.includes('- summary: "'));
  assert.ok(/x{120}…/.test(echo)); // truncated at 120
  assert.ok(echo.includes('- acceptance: (empty)'));
  assert.ok(echo.includes('Missing or empty: acceptance, assumptions'));
});

test('echo on an empty call says so instead of listing nothing', () => {
  assert.ok(receivedParamsEcho({}).includes('none — the call carried no parameters at all'));
});

/* ------------------ identical-retry detection + budget ------------------- */

test('an identical retry is flagged and charged once, not twice', () => {
  let s = initFinishGuard();
  let r = recordFinishRejection(s, { validator: 'acceptance-present', input: REQUEST_141_PAYLOAD });
  assert.equal(r.identicalRepeat, false);
  assert.equal(r.count, 1);
  r = recordFinishRejection(r.state, { validator: 'acceptance-present', input: REQUEST_141_PAYLOAD });
  assert.equal(r.identicalRepeat, true);
  assert.equal(r.count, 1); // still one charged
});

test('a near-identical retry (light rewording) is also flagged', () => {
  const a = { summary: 'Added the notes list with search and admin settings link plus filtering behavior for the list view' };
  const b = { summary: 'Added the notes list with search and admin settings link plus filtering behavior for the list views' };
  assert.ok(payloadSimilarity(JSON.stringify(a), JSON.stringify(b)) >= 0.9);
  let r = recordFinishRejection(initFinishGuard(), { input: a });
  r = recordFinishRejection(r.state, { input: b });
  assert.equal(r.identicalRepeat, true);
});

test('a genuinely different payload is a fresh rejection', () => {
  let r = recordFinishRejection(initFinishGuard(), { validator: 'acceptance-present', input: { summary: 'first attempt at the notes list' } });
  r = recordFinishRejection(r.state, { validator: 'summary-overclaim', input: { summary: 'completely reworked payload', acceptance: ['as admin, do X, expect Y'], assumptions: { verified: [], assumed: [] } } });
  assert.equal(r.identicalRepeat, false);
  assert.equal(r.count, 2);
});

test('the budget is SHARED across validators and exhausts after N real rejections', () => {
  let r = recordFinishRejection(initFinishGuard(), { validator: 'acceptance-present', input: { summary: 'attempt one entirely' } });
  assert.equal(r.exhausted, false);
  r = recordFinishRejection(r.state, { validator: 'summary-overclaim', input: { summary: 'a second very different payload with other words' } });
  assert.equal(r.exhausted, false);
  r = recordFinishRejection(r.state, { validator: 'removal-claims', input: { summary: 'third try, again completely reworded from scratch' } });
  assert.equal(r.exhausted, false);
  assert.equal(r.count, FINISH_REJECTION_BUDGET);
  r = recordFinishRejection(r.state, { validator: 'action-parity', input: { summary: 'fourth distinct payload wording once more anew' } });
  assert.equal(r.exhausted, true);
});

test('three identical payloads exhaust regardless of the charged count (the 141 loop cannot run five times)', () => {
  let r = recordFinishRejection(initFinishGuard(), { input: REQUEST_141_PAYLOAD });
  r = recordFinishRejection(r.state, { input: REQUEST_141_PAYLOAD });
  assert.equal(r.exhausted, false); // escalated diagnostic goes out here
  r = recordFinishRejection(r.state, { input: REQUEST_141_PAYLOAD });
  assert.equal(r.exhausted, true);
});

test('the escalated diagnostic names the malformed-call cause for the 141 shape', () => {
  const msg = escalatedRetryDiagnostic({ validator: 'acceptance-present', input: REQUEST_141_PAYLOAD });
  assert.ok(msg.includes('IDENTICAL'));
  assert.ok(msg.includes('</summary>'));
  assert.ok(msg.includes('serialized wrong'));
  assert.ok(msg.includes('halt'));
});

test('budgetNote states the position against the budget', () => {
  assert.ok(budgetNote(2).includes(`2 of ${FINISH_REJECTION_BUDGET}`));
});

/* ---------------------- budget-exhaustion conclusion --------------------- */

test('the exhaustion summary names validators, identical retries, and the checkpoint', () => {
  const msg = budgetExhaustedSummary({
    history: [
      { validator: 'acceptance-present', identical: false },
      { validator: 'acceptance-present', identical: true },
      { validator: 'acceptance-present', identical: true },
    ],
    finishSummary: 'Added the notes list.',
    changedFiles: ['public/app.html', 'public/n7.js'],
  });
  assert.ok(msg.includes('rejection budget'));
  assert.ok(msg.includes('acceptance-present'));
  assert.ok(msg.includes('CHECKPOINTED'));
  assert.ok(msg.includes('public/app.html'));
  assert.ok(msg.includes('Deploy'));
});

/* ------------------------- harness-fault halts --------------------------- */

test('a halt asserting a harness fault after rejections is accepted', () => {
  const reason = 'The finish tool keeps rejecting my payload with "missing acceptance" although I am sending the acceptance parameter — I believe the harness parser is at fault. Payload and rejection quoted verbatim above.';
  assert.equal(isHarnessFaultHalt(reason), true);
  assert.equal(harnessFaultHaltAccepted({ reason, rejectionTotal: 5 }), true);
});

test('a harness-fault claim with NO rejection history is not auto-accepted', () => {
  assert.equal(harnessFaultHaltAccepted({ reason: 'the harness validator rejected me wrongly', rejectionTotal: 0 }), false);
});

test('an ordinary blocked halt is not a harness-fault halt', () => {
  assert.equal(isHarnessFaultHalt('blocked: the external ADP endpoint needs credentials I do not have'), false);
});

// ---- the file-based fallback (P47 cycle 587: emission flakiness) ----

test('parseFinishFile: a well-formed file yields every usable field', () => {
  const r = parseFinishFile(JSON.stringify({
    summary: 'Verified all findings already implemented — no code changes needed.',
    acceptance: ['as admin, open /admin at 390px — user rows render as stacked cards'],
    assumptions: { verified: ['public/admin.js — aria-labels present'], assumed: [] },
    acceptance_ids: ['notes-header-aligned'],
    removals: [{ what: 'the leaked helper copy', check_id: 'notes-header-aligned' }],
  }));
  assert.equal(r.ok, true);
  assert.equal(r.fields.acceptance.length, 1);
  assert.deepEqual(r.fields.assumptions.assumed, []);
  assert.deepEqual(r.fields.acceptance_ids, ['notes-header-aligned']);
});

test('parseFinishFile: malformed JSON, wrong shapes, and empty docs are named errors', () => {
  assert.equal(parseFinishFile('not json').ok, false);
  assert.equal(parseFinishFile('[1,2]').ok, false);
  const empty = parseFinishFile('{}');
  assert.equal(empty.ok, false);
  assert.match(empty.error, /no usable finish fields/);
  // A bad assumptions shape is simply not taken; other fields still are.
  const partial = parseFinishFile(JSON.stringify({ summary: 'x', assumptions: { verified: 'nope' } }));
  assert.equal(partial.ok, true);
  assert.equal(partial.fields.assumptions, undefined);
  assert.equal(partial.fields.summary, 'x');
});

test('the malformed rejection and the escalated diagnostic both teach the file fallback', () => {
  const hit = malformedFinishInput({ summary: 'done.</summary>\n<parameter name="acceptance">[…]' });
  assert.equal(hit.malformed, true);
  assert.match(malformedRejectionMessage(hit, { summary: 'x' }), new RegExp(FINISH_FILE_PATH.replace('/', '\\/')));
  assert.match(escalatedRetryDiagnostic({ validator: 'malformed-call', input: { summary: 'x' } }), /finish\.json/);
  assert.match(finishFileHint(), /reads that file as the call/);
});

/* -------------- foundation/ is platform-owned (app foundation) -------------- */

const HAVE_GIT = spawnSync('git', ['--version']).status === 0 && spawnSync('sh', ['-c', 'command -v sha256sum']).status === 0;
const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

test('cycleBaseRef / parseCycleBase: only a full object name is a base; anything else is HEAD', () => {
  const c = 'a'.repeat(40);
  assert.equal(cycleBaseRef(c), c);
  assert.equal(cycleBaseRef(c.toUpperCase()), c);
  for (const bad of [null, '', 'HEAD', 'main', 'a'.repeat(39), `${c}; rm -rf /`, "'$(id)'"]) assert.equal(cycleBaseRef(bad), 'HEAD', String(bad));
  assert.equal(parseCycleBase(`${c}\n`), c);
  assert.equal(parseCycleBase('fatal: not a git repository'), null);
  assert.equal(parseCycleBase(''), null);
  assert.equal(CYCLE_BASE_READ_COMMAND, 'git rev-parse -q --verify HEAD 2>/dev/null');
});

test('foundationEditRefusals: added, modified and deleted files under foundation/ are refused; the platform\'s own bytes are not', () => {
  const platform = platformFoundationHashes([
    { path: 'foundation/runtime/storage.mjs', content: 'export const v = 2;\n' },
    { path: 'foundation/README.md', content: '# Foundation\n' },
    { path: 'src/app.ts', content: 'not foundation' },
  ]);
  assert.deepEqual([...platform.keys()].sort(), ['foundation/README.md', 'foundation/runtime/storage.mjs']);
  const refusals = foundationEditRefusals({
    platformHashes: platform,
    changes: [
      { path: 'foundation/runtime/health.mjs', status: 'M', sha256: sha('patched') },
      { path: 'foundation/runtime/extra.mjs', status: 'A', sha256: sha('new') },
      { path: 'foundation/README.md', status: 'D', sha256: null },
      // exactly what the base-app upgrade writes today: exempt
      { path: 'foundation/runtime/storage.mjs', status: 'M', sha256: sha('export const v = 2;\n') },
      // the platform's bytes at a path the platform does not write: refused
      { path: 'foundation/runtime/copy.mjs', status: 'A', sha256: sha('export const v = 2;\n') },
      // unreadable content (a symlink, no sha256sum) is never exempt
      { path: 'foundation/bin/foundation.mjs', status: 'T', sha256: null },
      { path: 'foundation/runtime/health.mjs', status: 'M', sha256: sha('patched') },
      { path: 'src/app.ts', status: 'M', sha256: sha('x') },
      { path: 'foundationx/a.mjs', status: 'A', sha256: sha('x') },
      { path: 'foundation/../src/a.ts', status: 'A', sha256: sha('x') },
    ],
  });
  assert.deepEqual(refusals, [
    { path: 'foundation/runtime/health.mjs', change: 'modified' },
    { path: 'foundation/runtime/extra.mjs', change: 'added' },
    { path: 'foundation/README.md', change: 'deleted' },
    { path: 'foundation/runtime/copy.mjs', change: 'added' },
    { path: 'foundation/bin/foundation.mjs', change: 'modified' },
  ]);
  assert.equal(isFoundationOwnedChange('foundation/x'), true);
  assert.equal(isFoundationOwnedChange('src/foundation/x'), false);
  // A deletion is refused even if a hash somehow matched: the upgrade never deletes.
  assert.equal(foundationEditRefusals({ platformHashes: platform, changes: [{ path: 'foundation/README.md', status: 'D', sha256: sha('# Foundation\n') }] }).length, 1);
  // Junk lines in the container's answer are ignored.
  assert.deepEqual(parseFoundationChangeRead('noise\n@@ M nothex Zm9v\n@@ M - \n'), []);
});

test('the foundation/ rejection says platform-owned, names each file, says what was put back, and points at the adapters and the platform', () => {
  const msg = foundationEditRejectionMessage({
    restored: [{ path: 'foundation/runtime/health.mjs', change: 'modified' }, { path: 'foundation/runtime/extra.mjs', change: 'added' }],
    remaining: [{ path: "foundation/it's.mjs", change: 'deleted' }, { path: 'foundation/new.mjs', change: 'added' }],
  }, { base: 'b'.repeat(40) });
  assert.match(msg, /^Not finished — this build changed foundation\/, which is platform-owned \(constitution §2\)/);
  assert.match(msg, /base-app upgrade rewrites it, and the host trusts the health and job state it reports/);
  assert.match(msg, /The platform put these back as they were when this cycle started: foundation\/runtime\/health\.mjs \(modified\); foundation\/runtime\/extra\.mjs \(added\)\./);
  assert.ok(msg.includes(`Still changed — put them back yourself: foundation/it's.mjs (deleted); foundation/new.mjs (added) (git checkout ${'b'.repeat(40)} -- 'foundation/it'\\''s.mjs' && rm -f -- 'foundation/new.mjs')`), msg);
  assert.match(msg, /import \{ storage, embeddings, vector \} from '#foundation'/);
  assert.match(msg, /never edits, copies or forks foundation\//);
  assert.match(msg, /ask the platform to change it/);
  const onlyRestored = foundationEditRejectionMessage({ restored: [{ path: 'foundation/a.mjs', change: 'modified' }] });
  assert.doesNotMatch(onlyRestored, /Still changed/);
});

test('the foundation/ rejection uses the SHARED finish budget like every validator: exhaustion concludes, never succeeds', () => {
  let g = initFinishGuard();
  let r;
  for (let i = 0; i <= FINISH_REJECTION_BUDGET; i++) {
    r = recordFinishRejection(g, { validator: 'foundation-owned', input: { summary: `try ${i} ${'y'.repeat(i * 9)}`, acceptance: [`c${i}`] } });
    g = r.state;
  }
  assert.equal(r.exhausted, true);
});

test('against a real git checkout: the read script sees this cycle\'s foundation/ changes (a mid-cycle commit included), the upgrade\'s bytes pass, and the restore script puts the rest back', { skip: !HAVE_GIT }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'fdn-guard-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const git = (...args) => {
    const r = spawnSync('git', ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout;
  };
  const put = async (p, c) => { await mkdir(dirname(join(dir, p)), { recursive: true }); await writeFile(join(dir, p), c); };
  const read = (p) => readFile(join(dir, p), 'utf8');
  const sh = (s) => spawnSync('sh', ['-c', s], { encoding: 'utf8' });
  const platformFiles = scaffoldFoundationFiles();
  const platform = platformFoundationHashes(platformFiles);
  const bytes = new Map(platformFiles.map((f) => [f.path, f.content]));
  // The project as provisioned on an OLDER foundation version: storage.mjs differs from today's.
  git('init', '-q');
  for (const f of platformFiles) await put(f.path, f.path === 'foundation/runtime/storage.mjs' ? `${f.content}// older foundation\n` : f.content);
  await put('package.json', '{"name":"a","dependencies":{"pg":"8"}}\n');
  await put('src/app.ts', 'export const a = 1;\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'seed');
  const base = parseCycleBase(git('rev-parse', '-q', '--verify', 'HEAD'));
  assert.ok(base);

  // This cycle: the builder edits, adds, deletes — and commits one edit itself.
  await put('foundation/runtime/jobs.mjs', `${bytes.get('foundation/runtime/jobs.mjs')}\nexport const hacked = true;\n`);
  git('add', '-A');
  git('commit', '-q', '-m', 'builder commit');
  await put('foundation/runtime/health.mjs', 'export const health = () => ({ status: "ready" });\n');
  await put('foundation/runtime/extra.mjs', 'export {};\n');
  await rm(join(dir, 'foundation/README.md'));
  await rm(join(dir, 'foundation/bin/foundation.mjs'));
  await symlink('/etc/hostname', join(dir, 'foundation/bin/foundation.mjs'));
  // ...while today's upgrade bytes land uncommitted (an upgrade whose commit did not): exempt.
  await put('foundation/runtime/storage.mjs', bytes.get('foundation/runtime/storage.mjs'));
  await put('src/app.ts', 'export const a = 2;\n');

  const refusalsFor = (b) => foundationEditRefusals({ changes: parseFoundationChangeRead(sh(buildFoundationChangeReadScript({ appDir: dir, base: b })).stdout), platformHashes: platform });
  const want = [
    'foundation/README.md deleted', 'foundation/bin/foundation.mjs modified', 'foundation/runtime/extra.mjs added',
    'foundation/runtime/health.mjs modified', 'foundation/runtime/jobs.mjs modified',
  ];
  const got = refusalsFor(base);
  assert.deepEqual(got.map((r) => `${r.path} ${r.change}`).sort(), want);
  assert.ok(!refusalsFor(null).some((r) => r.path === 'foundation/runtime/jobs.mjs'), 'against HEAD the committed edit would hide — hence the cycle base');

  // Put it back: exactly the refused files, nothing else.
  const restored = sh(buildFoundationRestoreScript({ appDir: dir, base, refusals: got }));
  assert.equal(restored.status, 0, restored.stderr);
  assert.doesNotMatch(restored.stdout, /not restored|not removed/);
  assert.deepEqual(refusalsFor(base), []);
  assert.equal(await read('foundation/runtime/health.mjs'), bytes.get('foundation/runtime/health.mjs'));
  assert.equal(await read('foundation/runtime/jobs.mjs'), bytes.get('foundation/runtime/jobs.mjs'));
  assert.equal(await read('foundation/README.md'), bytes.get('foundation/README.md'));
  assert.equal(await read('foundation/bin/foundation.mjs'), bytes.get('foundation/bin/foundation.mjs'));
  await assert.rejects(read('foundation/runtime/extra.mjs'));
  assert.equal(await read('foundation/runtime/storage.mjs'), bytes.get('foundation/runtime/storage.mjs'), 'the upgrade\'s bytes stay');
  assert.equal(await read('src/app.ts'), 'export const a = 2;\n', 'application code is not touched');

  // A build that deleted the whole directory: every file comes back.
  await rm(join(dir, 'foundation'), { recursive: true, force: true });
  const all = refusalsFor(base);
  assert.ok(all.length >= platformFiles.length - 1 && all.every((r) => r.change === 'deleted'), JSON.stringify(all.slice(0, 3)));
  sh(buildFoundationRestoreScript({ appDir: dir, base, refusals: all }));
  assert.deepEqual(refusalsFor(base), []);
});

test('ratchet: both lanes refuse a foundation/ change at finish (foundation projects only), restore it, and no checkpoint commits one', async () => {
  const runner = await readFile(new URL('../mock2/runner.js', import.meta.url), 'utf8');
  const run = runner.slice(runner.indexOf('export async function runCycle('), runner.indexOf('async function executeTool('));
  assert.match(run, /const onFoundation = isFoundationProject\(project\);/);
  const engine = run.indexOf("validator: 'database-engine'");
  const fdn = run.indexOf("validator: 'foundation-owned'");
  assert.ok(engine > 0 && fdn > engine && fdn < run.indexOf("validator: 'acceptance-demonstrated'"), 'after the engine check, before the acceptance verdict');
  const block = run.slice(run.lastIndexOf('if (onFoundation) {', fdn), fdn);
  assert.match(block, /await restoreFoundationEdits\(\{ containerName, base: cycleBase \}\)/);
  assert.match(run.slice(fdn, fdn + 300), /foundationEditRejectionMessage\(foundationEdits, \{ base: cycleBase \}\)/);
  // The canonical bytes are the ones the base-app upgrade writes.
  assert.match(runner, /platformFoundationHashes\(scaffoldFoundationFiles\(\)\)/);
  const upgrade = await readFile(new URL('../mock2/base-app-upgrade.js', import.meta.url), 'utf8');
  assert.match(upgrade, /\.\.\.scaffoldFoundationFiles\(\),/);
  // Every checkpoint in a project on the foundation puts foundation/ back before it commits.
  const cp = runner.slice(runner.indexOf('export async function checkpointAndRecord('), runner.indexOf('export async function concludeCycle('));
  const restoreAt = cp.indexOf('restoreFoundationEdits(');
  assert.ok(restoreAt > 0 && restoreAt < cp.indexOf('buildCheckpointScript('));
  assert.match(cp.slice(0, restoreAt), /if \(isFoundationProject\(project\)\) \{\s*foundationRestore = await $/);
  // The SDK lane: same check, and its local checkout is resynced so the next push does not undo the restore.
  const sdk = await readFile(new URL('../mock2/runner-sdk.js', import.meta.url), 'utf8');
  const s = sdk.indexOf('const foundationEdits = await restoreFoundationEdits({ containerName, base: cycleBase });');
  assert.ok(s > sdk.indexOf('readIntroducedDatabaseEngines(') && s < sdk.indexOf('const verdict = acceptanceVerdict('));
  assert.ok(sdk.lastIndexOf('if (onFoundation) {', s) > sdk.indexOf('readIntroducedDatabaseEngines('));
  assert.ok(sdk.indexOf("pullSubtree(containerName, checkoutDir, 'foundation')", s) > s);
  assert.match(sdk, /const onFoundation = isFoundationProject\(project\);/);
});
