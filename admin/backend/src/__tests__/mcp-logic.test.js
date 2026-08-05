// MCP server pure layer + project-clone decision logic.
// Native-free (no better-sqlite3): everything under test lives in
// lib/mcp-logic.js and mock2/clone-logic.js.

import test from 'node:test';
import assert from 'node:assert/strict';

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
} from '../lib/mcp-logic.js';
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
    'interrupt_project_build', 'cancel_queued_build',
    'list_project_files', 'read_project_file', 'write_project_file', 'redeploy_project',
    'run_project_command', 'edit_project_file', 'search_project_files',
    'delete_project_file', 'move_project_file',
  ]) {
    assert.ok(names.has(required), `missing tool ${required}`);
  }
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
    design_inventory_seq: 4, current_mockup_id: 99,
  });
  assert.deepEqual(patch, {
    description: 'a thing', design_preset: 'portal-blue', harness: 'claude',
    suggest_mode: 'ask', clarify_mode: 'on', design_approved_at: '2026-01-01T00:00:00Z',
    design_inventory_seq: 4,
  });
  assert.ok(!('slug' in patch) && !('container_name' in patch) && !('current_mockup_id' in patch));
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
