// Delegated editing — the containment tests.
//
// The premise of the feature is that the key holder is hostile: the key has
// leaked, or their AI session has been talked into trying something. So these
// tests are written as attacks rather than as coverage. Each one asks "can a
// request that looks like this reach a container it was not issued for, or a
// path outside its docroot", and the answer has to be no with no cooperation
// from the client.
//
// Native-free by construction (docs/known-issues.md R9): lib/editor-keys-logic.js
// imports only node built-ins, so this suite runs in a fresh checkout where the
// better-sqlite3 suites cannot. The canonicalization script is exercised
// against a REAL directory tree with REAL symlinks through the system `sh` —
// the escapes it has to stop are filesystem behaviour, not string behaviour,
// and a mock of them would only prove the mock.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  EDITOR_TOKEN_PREFIX, EDITOR_TOKEN_DISPLAY_LEN,
  mintEditorToken, hashEditorToken, looksLikeEditorToken, editorTokenDisplayPrefix,
  editorTokenFromRequest,
  DEFAULT_DOCROOT, validDocroot, validDelegatedPath,
  pathInsideRoot, redactDocroot,
  canonicalizePathScript, CANON_ERRORS,
  keyStatus, authRejection,
  createRateLimiter, EDITOR_RATE, EDITOR_AUTH_FAIL_RATE,
  EDITOR_MCP_TOOLS, EDITOR_TOOL_MAP, EDITOR_MCP_INSTRUCTIONS,
} from '../lib/editor-keys-logic.js';
import { validateEntryName } from '../lib/zip-extract.js';

const readSrc = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

// ---- tokens ----

test('a minted key is a ppedit_ secret, and only its hash and a display prefix survive', () => {
  const token = mintEditorToken();
  assert.match(token, /^ppedit_[0-9a-f]{64}$/);
  assert.ok(looksLikeEditorToken(token));
  // A distinct prefix from the main server's, so a leaked secret is
  // identifiable on sight as delegated editing rather than host access.
  assert.equal(token.startsWith(EDITOR_TOKEN_PREFIX), true);
  assert.equal(looksLikeEditorToken(`ppmcp_${'a'.repeat(64)}`), false);

  const hash = hashEditorToken(token);
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.equal(hash, hashEditorToken(token), 'hashing is stable');
  assert.notEqual(hash, hashEditorToken(mintEditorToken()));
  // The stored display prefix must not be enough to reconstruct the secret.
  const prefix = editorTokenDisplayPrefix(token);
  assert.equal(prefix.length, EDITOR_TOKEN_DISPLAY_LEN);
  assert.equal(token.startsWith(prefix), true);
  assert.ok(token.length - prefix.length >= 57, 'the display prefix leaves the secret secret');
});

test('only a well-formed editor token is ever looked up', () => {
  const token = mintEditorToken();
  assert.equal(editorTokenFromRequest({ authorization: `Bearer ${token}` }), token);
  assert.equal(editorTokenFromRequest({ pathToken: token }), token);
  // A main-server token presented here is not an editor key and must not be
  // treated as one — the two catalogs are not interchangeable.
  assert.equal(editorTokenFromRequest({ authorization: `Bearer ppmcp_${'a'.repeat(64)}` }), null);
  for (const junk of ['', 'Bearer', 'Bearer ppedit_short', `Basic ${token}`, 'ppedit_' + 'z'.repeat(64)]) {
    assert.equal(editorTokenFromRequest({ authorization: junk, pathToken: junk }), null, `should refuse ${junk}`);
  }
});

// ---- the docroot ----

test('a docroot is absolute, at least one level deep, and never "/"', () => {
  assert.equal(validDocroot('/var/www/html'), '/var/www/html');
  assert.equal(validDocroot('/var/www/html/'), '/var/www/html', 'trailing slash normalized');
  assert.equal(validDocroot('//var//www//html'), '/var/www/html', 'doubled separators collapsed');
  assert.equal(validDocroot(DEFAULT_DOCROOT), DEFAULT_DOCROOT);
  // '/' is the one that matters: it would make every containment check below
  // trivially true and hand over the whole filesystem.
  assert.equal(validDocroot('/'), null);
  assert.equal(validDocroot('//'), null);
  for (const bad of ['', 'var/www', 'relative/path', '/var/../etc', '/var/www/..', '/var/w\u0000w', '/var\\www', null]) {
    assert.equal(validDocroot(bad), null, `should refuse ${JSON.stringify(bad)}`);
  }
});

test('a delegated path is relative, and a leading slash means the root — never the host root', () => {
  assert.equal(validDelegatedPath('index.php'), 'index.php');
  // The holder was told the docroot is '/', so '/index.php' is theirs to write
  // and must resolve inside the docroot, not at the filesystem root.
  assert.equal(validDelegatedPath('/index.php'), 'index.php');
  assert.equal(validDelegatedPath('/etc/passwd'), 'etc/passwd', 'an absolute-looking path is root-relative, not absolute');
  assert.equal(validDelegatedPath('a//b/./c.txt'), 'a/b/c.txt');
  assert.equal(validDelegatedPath(''), '');
  assert.equal(validDelegatedPath('/'), '');
  // Traversal in any position.
  for (const bad of ['..', '../x', 'a/../../x', 'a/..', '/../etc/passwd', 'a/b/../../../etc']) {
    assert.equal(validDelegatedPath(bad), null, `should refuse ${bad}`);
  }
  for (const bad of ['a\\b', 'a\u0000b', 'a\nb']) {
    assert.equal(validDelegatedPath(bad), null, `should refuse ${JSON.stringify(bad)}`);
  }
  // Tools that act on a file refuse the root itself.
  assert.equal(validDelegatedPath('', { allowRoot: false }), null);
  assert.equal(validDelegatedPath('/', { allowRoot: false }), null);
});

test('containment is a path check, not a string prefix', () => {
  // The classic bug: '/var/www' treated as a parent of '/var/www-backup'.
  assert.equal(pathInsideRoot('/var/www', '/var/www-backup/x'), false);
  assert.equal(pathInsideRoot('/var/www', '/var/wwwx'), false);
  assert.equal(pathInsideRoot('/var/www', '/var/www'), true);
  assert.equal(pathInsideRoot('/var/www', '/var/www/x/y'), true);
  assert.equal(pathInsideRoot('/var/www', '/etc/passwd'), false);
  assert.equal(pathInsideRoot('/var/www', 'relative'), false);
  // '/' is never a root here, so nothing is ever "inside" it.
  assert.equal(pathInsideRoot('/', '/etc/passwd'), false);
});

test('the docroot never leaves the server, not even in an error string', () => {
  const root = '/var/www/html';
  assert.equal(redactDocroot('/var/www/html/index.php', root), '/index.php');
  assert.equal(redactDocroot('Not a file: /var/www/html/x', root), 'Not a file: /x');
  assert.equal(redactDocroot('root is /var/www/html', root), 'root is /');
  // A docroot with regex metacharacters must be escaped, not interpreted.
  assert.equal(redactDocroot('/srv/a+b/site/x.txt', '/srv/a+b/site'), '/x.txt');
  assert.equal(redactDocroot('/srv/a+b/site/x.txt', '/srv/aab/site'), '/srv/a+b/site/x.txt');
  // Every occurrence, not just the first — a diff header carries two.
  assert.equal(
    redactDocroot('--- /var/www/html/a.old\n+++ /var/www/html/a', root),
    '--- /a.old\n+++ /a',
  );
});

// ---- canonicalization, against a real filesystem ----
//
// A tree that contains every escape worth trying: a symlinked file pointing
// out, a symlinked DIRECTORY pointing out (the one that defeats a leaf-only
// check), and an absolute symlink.

function buildTree() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'pp-editor-')));
  const root = join(base, 'root');
  const outside = join(base, 'outside');
  mkdirSync(join(root, 'sub'), { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(root, 'index.php'), '<?php\n');
  writeFileSync(join(outside, 'secret.txt'), 'secret\n');
  symlinkSync('../outside', join(root, 'escape'));              // dir → out
  symlinkSync('../outside/secret.txt', join(root, 'link.txt')); // file → out
  symlinkSync('/etc', join(root, 'abs'));                       // absolute
  symlinkSync('sub', join(root, 'inner'));                      // stays inside
  return { base, root, outside };
}

function canonicalize(root, rel) {
  try {
    const out = execFileSync('sh', ['-c', canonicalizePathScript(), 'sh', root, rel], { encoding: 'utf8' });
    return { ok: true, path: out.trim() };
  } catch (err) {
    return { ok: false, status: err.status };
  }
}

test('canonicalization resolves what is inside the docroot', () => {
  const { root } = buildTree();
  assert.equal(canonicalize(root, '').path, root, 'the root itself');
  assert.equal(canonicalize(root, 'index.php').path, join(root, 'index.php'));
  assert.equal(canonicalize(root, 'sub').path, join(root, 'sub'));
  // A file that does not exist yet still resolves — write_file has to be able
  // to create one — as long as its parent directory is inside.
  assert.equal(canonicalize(root, 'sub/new.txt').path, join(root, 'sub', 'new.txt'));
  // A symlink that stays inside is followed, because there is nothing wrong
  // with it.
  assert.equal(canonicalize(root, 'inner/x.txt').path, join(root, 'sub', 'x.txt'));
});

test('canonicalization stops every escape out of the docroot', () => {
  const { root } = buildTree();
  // A symlinked FILE pointing outside.
  assert.deepEqual(canonicalize(root, 'link.txt'), { ok: false, status: 67 });
  // A symlinked DIRECTORY pointing outside — the one a leaf-only check misses,
  // both for reading through it and for creating a new file under it.
  assert.deepEqual(canonicalize(root, 'escape'), { ok: false, status: 67 });
  assert.deepEqual(canonicalize(root, 'escape/secret.txt'), { ok: false, status: 67 });
  assert.deepEqual(canonicalize(root, 'escape/planted.txt'), { ok: false, status: 67 });
  // An absolute symlink.
  assert.deepEqual(canonicalize(root, 'abs/passwd'), { ok: false, status: 67 });
  // Traversal, in case it ever gets past validDelegatedPath.
  assert.deepEqual(canonicalize(root, '../outside/secret.txt'), { ok: false, status: 67 });
  assert.deepEqual(canonicalize(root, 'sub/../../outside/secret.txt'), { ok: false, status: 67 });
  // ...while traversal that stays inside is fine.
  assert.equal(canonicalize(root, 'sub/../index.php').path, join(root, 'index.php'));
});

test('canonicalization distinguishes a missing docroot, a missing parent, and an escape', () => {
  const { base, root } = buildTree();
  assert.equal(canonicalize(join(base, 'no-such-root'), 'a').status, 65);
  assert.equal(canonicalize(root, 'no-such-dir/a.txt').status, 66);
  assert.equal(canonicalize(root, 'link.txt').status, 67);
  // '/' as a docroot is refused by the script too, not only by validDocroot —
  // two independent refusals of the one value that would void containment.
  assert.equal(canonicalize('/', 'etc/passwd').status, 65);
  for (const code of [65, 66, 67]) {
    assert.ok(CANON_ERRORS[code], `exit ${code} needs a message`);
  }
});

// ---- key status ----

test('key status: revocation outranks everything, suspension is the container toggle', () => {
  const live = { revoked_at: null };
  const dead = { revoked_at: '2026-01-01T00:00:00.000Z' };
  assert.equal(keyStatus(live, { activationActive: true, containerExists: true }), 'active');
  assert.equal(keyStatus(live, { activationActive: false, containerExists: true }), 'suspended');
  assert.equal(keyStatus(live, { activationActive: true, containerExists: false }), 'orphaned');
  // A revoked key reads as revoked whatever else is true — it is the one
  // state that is permanent, so it must not be masked by a reversible one.
  assert.equal(keyStatus(dead, { activationActive: true, containerExists: true }), 'revoked');
  assert.equal(keyStatus(dead, { activationActive: false, containerExists: false }), 'revoked');

  for (const s of ['revoked', 'suspended', 'orphaned']) {
    assert.ok(authRejection(s, 'unlimited-lighting'), `${s} needs a refusal message`);
  }
  assert.equal(authRejection('active', 'x'), null);
  assert.match(authRejection('orphaned', 'web1'), /web1/);
});

// ---- rate limiting ----

test('the token bucket allows a working burst, refuses beyond it, and refills', () => {
  let now = 1_000_000;
  const lim = createRateLimiter({ capacity: 3, refillPerMinute: 60 }, () => now);
  assert.equal(lim.take('k'), null);
  assert.equal(lim.take('k'), null);
  assert.equal(lim.take('k'), null);
  const wait = lim.take('k');
  assert.ok(wait >= 1, 'a refusal reports how long to wait');
  // Buckets are per key: one noisy session must not throttle another.
  assert.equal(lim.take('other'), null);
  // A pause buys capacity back, which is what an editing session looks like.
  now += 1000;
  assert.equal(lim.take('k'), null);
  // Full buckets are dropped, so a leaked key cannot grow the map forever.
  now += 60_000;
  lim.sweep();
  assert.equal(lim.size(), 0);
});

test('the shipped limits are generous for editing and tight for guessing', () => {
  assert.ok(EDITOR_RATE.capacity >= 60, 'an orienting model reads a lot at once');
  assert.ok(EDITOR_AUTH_FAIL_RATE.capacity <= 20, 'failed auth must be expensive');
  assert.ok(EDITOR_AUTH_FAIL_RATE.capacity < EDITOR_RATE.capacity);
});

// ---- the catalog: what a delegated session can even name ----

const FORBIDDEN_TOOLS = [
  'run_lxc_command', 'control_lxc_container', 'create_lxc_container', 'set_lxc_network',
  'set_lxc_config', 'snapshot_lxc_container', 'get_lxc_logs', 'probe_lxc_port',
  'get_lxc_startup', 'rerun_startup', 'list_lxc_containers', 'get_lxc_container',
  'create_upload_ticket', 'append_upload_chunk', 'finish_upload',
  'list_routes', 'set_route', 'test_route', 'get_route',
  'list_projects', 'get_project', 'create_project', 'clone_project', 'redeploy_project',
  'run_project_command', 'write_project_file', 'apply_project_patch',
  'list_static_sites', 'create_static_site', 'write_static_site_file',
];

test('the restricted catalog is the eight content tools and nothing else', () => {
  const names = EDITOR_MCP_TOOLS.map((t) => t.name);
  assert.deepEqual([...names].sort(), [
    'apply_zip', 'file_diff', 'inspect_zip', 'list_files',
    'read_file', 'restore_file', 'search_files', 'write_file',
  ]);
  assert.deepEqual([...names].sort(), Object.keys(EDITOR_TOOL_MAP).sort(),
    'every advertised tool maps to a handler, and nothing maps that is not advertised');
  for (const t of EDITOR_MCP_TOOLS) {
    assert.ok(t.description.length > 20, `${t.name} needs a real description`);
    assert.equal(t.inputSchema.type, 'object');
    assert.equal(t.inputSchema.additionalProperties, false, `${t.name} must refuse unknown parameters`);
  }
  // Not "denied" — absent. A name that is not a key of the map is not
  // registered on the endpoint at all.
  for (const f of FORBIDDEN_TOOLS) {
    assert.equal(Object.prototype.hasOwnProperty.call(EDITOR_TOOL_MAP, f), false, `${f} must not be delegable`);
    assert.equal(names.includes(f), false, `${f} must not be advertised`);
  }
});

test('no tool on this endpoint has a parameter that could widen its scope', () => {
  // The container comes off the key row. There is no parameter to send, which
  // is stronger than a parameter the server ignores: a manipulated client
  // cannot even express the request.
  for (const t of EDITOR_MCP_TOOLS) {
    const props = Object.keys(t.inputSchema.properties || {});
    for (const banned of ['container', 'container_name', 'instance', 'host', 'docroot', 'root']) {
      assert.equal(props.includes(banned), false, `${t.name} must not take ${banned}`);
    }
  }
  // apply_zip must not be able to register or run anything: a delegated file
  // drop is not a code-execution primitive.
  const apply = EDITOR_MCP_TOOLS.find((t) => t.name === 'apply_zip');
  for (const banned of ['startup_script', 'run_startup', 'target_dir']) {
    assert.equal(Object.keys(apply.inputSchema.properties).includes(banned), false,
      `apply_zip must not take ${banned}`);
  }
  // Paths are described as relative, so a client is not invited to send an
  // absolute one it would then be refused for.
  for (const name of ['read_file', 'write_file', 'file_diff', 'restore_file']) {
    const t = EDITOR_MCP_TOOLS.find((x) => x.name === name);
    assert.match(t.inputSchema.properties.path.description, /relative to the editable root/i);
  }
});

test('the endpoint instructions do not promise capabilities it does not have', () => {
  assert.match(EDITOR_MCP_INSTRUCTIONS, /cannot run commands/);
  assert.match(EDITOR_MCP_INSTRUCTIONS, /no other container/);
  assert.match(EDITOR_MCP_INSTRUCTIONS, /confirm_overwrite/);
});

// ---- source-level ratchets ----
//
// The dangerous regressions here are all shaped like "somebody spreads the
// caller's arguments" or "somebody adds a tool to the main server and it
// quietly becomes delegable". Neither shows up in a behavioural test that
// still passes, so they are pinned in the source.

test('the endpoint never spreads caller arguments into an underlying call', () => {
  const src = readSrc('../routes/mcp-editor.js');
  const build = src.slice(src.indexOf('async function buildDelegatedCall'), src.indexOf('async function callDelegatedTool'));
  assert.ok(build.length > 500, 'buildDelegatedCall not found');
  // `...args` anywhere in the builder would hand an unexpected parameter
  // straight to a handler that might honour it.
  assert.equal(/\.\.\.\s*args\b/.test(build), false,
    'arguments must be copied field by field, never spread');
  // The container is taken from the key row, once, at the top.
  assert.match(build, /const \{ container_name: container \} = ctx\.key;/);
  assert.equal(/args\.container/.test(src), false, 'the request must never supply a container');
  // Zip applies pin the two fields that would otherwise be execution.
  assert.match(build, /run_startup: false/);
  assert.match(build, /startup_script: null/);
});

test('every delegated path goes through confinement before dispatch', () => {
  const src = readSrc('../routes/mcp-editor.js');
  const build = src.slice(src.indexOf('async function buildDelegatedCall'), src.indexOf('async function callDelegatedTool'));
  // One confinePath call per path-bearing tool: list, read, search, write,
  // diff (x2 — path and against), restore, inspect_zip's target dir.
  const calls = build.match(/await confinePath\(/g) || [];
  assert.ok(calls.length >= 8, `expected a confinement call per path, found ${calls.length}`);
  // apply_zip has no path of its own; it re-checks the staged target instead.
  const applyCase = build.slice(build.indexOf("case 'apply_zip'"));
  assert.match(applyCase, /pathInsideRoot\(docroot, String\(rec\.targetDir/);
});

test('the main server exposes exactly the eight delegable handlers, as a frozen list', () => {
  const src = readSrc('../routes/mcp.js');
  const block = src.slice(src.indexOf('const DELEGABLE_LXC_TOOLS'), src.indexOf('export const LXC_CONTAINER_PREFIX'));
  assert.match(block, /Object\.freeze/);
  for (const target of Object.values(EDITOR_TOOL_MAP)) {
    assert.ok(block.includes(`'${target}'`), `${target} must be delegable`);
  }
  for (const f of FORBIDDEN_TOOLS) {
    assert.equal(block.includes(`'${f}'`), false, `${f} must not be in the delegable list`);
  }
  // The adapter refuses anything outside the list rather than trusting its
  // one caller to have checked.
  assert.match(src, /if \(!DELEGABLE_LXC_TOOLS\.includes\(name\)\) \{/);
});

test('the plaintext key is returned once, at creation, and stored nowhere', () => {
  const routes = readSrc('../routes/mcp-editor.js');
  const store = readSrc('../lib/editor-keys.js');
  // Exactly one response carries the token: the create endpoint's.
  const returnsToken = routes.match(/^\s*token,$/gm) || [];
  assert.equal(returnsToken.length, 1, 'only the creation response may carry the plaintext key');
  assert.match(routes, /shown only once/);
  // The list shape is an explicit allowlist of columns — no token_hash, no
  // token — so a future column cannot leak by being included accidentally.
  const shape = routes.slice(routes.indexOf('function shapeKey'), routes.indexOf('export function createEditorAdminRouter'));
  assert.equal(/token_hash/.test(shape), false);
  assert.match(shape, /token_prefix: row\.token_prefix/);
  // The store writes a hash and a display prefix — the raw secret is never a
  // bound parameter. Checked on the INSERT's own bind list, which is the one
  // place it could be.
  const insert = store.slice(store.indexOf('INSERT INTO lxc_editor_keys'), store.indexOf('return { token'));
  assert.match(insert, /token_hash, token_prefix/);
  assert.equal(/^\s*token,\s*$/m.test(insert), false, 'the insert must not bind the raw token');
  assert.match(insert, /hashEditorToken\(token\)/);
  assert.match(insert, /editorTokenDisplayPrefix\(token\)/);
  // Nothing logs the secret.
  for (const src of [routes, store]) {
    assert.equal(/logAudit\([^)]*\btoken\b\s*[,)]/.test(src), false, 'the token must never reach the audit log');
  }
});

test('auth facts are read per request, so revocation takes effect on the next call', () => {
  const routes = readSrc('../routes/mcp-editor.js');
  const auth = routes.slice(routes.indexOf('function authenticate('), routes.indexOf('/* --------------------- path confinement'));
  // Straight to the store every time — no Map, no TTL, nothing that could
  // outlive a revocation.
  assert.match(auth, /findEditorKeyByToken\(token\)/);
  assert.match(auth, /getActivation\(key\.container_name\)/);
  assert.equal(/cache|ttl|expires/i.test(auth), false, 'authentication must not cache');
  // Container existence is checked on the call itself, not at connect time.
  assert.match(routes, /const exists = await lxcContainerExists\(ctx\.key\.container_name\);/);
});

// ---- zip entries ----
//
// The zip path is the one place a delegated caller supplies many paths at
// once. The guarantee is the shared parser's (lib/zip-extract.js, proven in
// zip-extract.test.js); this pins that the cases a delegated caller would try
// are among the ones it refuses, so the two suites cannot drift apart.

test('a malicious zip entry is refused by the shared parser the delegated flow uses', () => {
  for (const bad of ['../evil.php', 'a/../../evil.php', '/etc/passwd', 'a\\b.php', 'x\u0000y']) {
    assert.throws(() => validateEntryName(bad), `expected ${JSON.stringify(bad)} to be refused`);
  }
  assert.equal(validateEntryName('themes/child/style.css'), 'themes/child/style.css');
  // The delegated tools go through those same handlers, so they inherit it.
  assert.equal(EDITOR_TOOL_MAP.inspect_zip, 'inspect_lxc_zip');
  assert.equal(EDITOR_TOOL_MAP.apply_zip, 'apply_lxc_zip');
});

// ---- the main server is untouched ----

test('the rate limit is charged per tool call, so a batch cannot buy calls in bulk', () => {
  const src = readSrc('../routes/mcp-editor.js');
  // A JSON-RPC batch is an ARRAY of messages. Charging the HTTP request would
  // let one POST carrying two hundred calls through for the price of one.
  const rpc = src.slice(src.indexOf('async function handleEditorRpc'), src.indexOf('export function createEditorMcpRouter'));
  assert.match(rpc, /callLimiter\.take\(`key:\$\{ctx\.key\.id\}`\)/);
  const endpoint = src.slice(src.indexOf('export function createEditorMcpRouter'));
  assert.equal(/callLimiter\.take/.test(endpoint), false,
    'the charge belongs on the call, not on the request that may carry many');
  // ...and a batch is bounded on top of that.
  assert.match(endpoint, /body\.length > BATCH_MAX_MESSAGES/);
});

test('delegated editing adds to the main MCP server without changing it', async () => {
  const { MCP_TOOLS } = await import('../lib/mcp-logic.js');
  const main = new Set(MCP_TOOLS.map((t) => t.name));
  // The restricted names are the editor endpoint's alone — adding them to the
  // main catalog would be a different (and much wider) change.
  for (const n of Object.keys(EDITOR_TOOL_MAP)) {
    assert.equal(main.has(n), false, `${n} must not appear on the main server`);
  }
  // ...and the handlers it delegates to are still there, unchanged in name.
  for (const target of Object.values(EDITOR_TOOL_MAP)) {
    assert.equal(main.has(target), true, `${target} must still exist on the main server`);
  }
});

