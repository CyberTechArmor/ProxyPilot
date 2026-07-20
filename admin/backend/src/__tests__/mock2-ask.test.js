// ASK lane — PURE logic tests, stub-first (risk R9). Imports ONLY native-free
// modules (ask-logic.js): tool set, prompt polarity, the web-search gating, the
// command blocklist backstop. The orchestration half (ask.js) and the route are
// covered by the integration checklist, not here.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ASK_TOOLS, ASK_TOOL_NAMES, ASK_MAX_TURNS,
  buildAskSystemPrompt, buildAskTask, askCommandAllowed,
  webSearchServerTools, WEB_SEARCH_FLAG, RUNNER_WEB_SEARCH_FLAG,
} from '../mock2/ask-logic.js';

// ---- tool surface: read-and-run only, never edit ----

test('ASK_TOOLS: exec/read/get_component only — no write, no materialize, no gates', () => {
  assert.deepEqual([...ASK_TOOL_NAMES].sort(), ['exec_in_container', 'get_component', 'read_file']);
  for (const t of ASK_TOOLS) {
    assert.equal(typeof t.name, 'string');
    assert.equal(typeof t.description, 'string');
    assert.equal(t.input_schema.type, 'object');
  }
  assert.ok(ASK_MAX_TURNS > 0 && ASK_MAX_TURNS <= 30);
});

// ---- prompt polarity ----

test('buildAskSystemPrompt: states web-search availability truthfully, forbids code edits', () => {
  const withSearch = buildAskSystemPrompt({ projectName: 'ADP4', webSearch: true });
  assert.match(withSearch, /web_search tool/);
  assert.match(withSearch, /Do NOT modify the CODE/);
  // Operational actions (the user's "add a user to the database" case) are in
  // scope; bulk destruction is not.
  assert.match(withSearch, /OPERATIONAL actions/);
  assert.match(withSearch, /NEVER destroy data in bulk/);
  assert.match(withSearch, /run it\s+as a Quick update or build/i);
  const noSearch = buildAskSystemPrompt({ projectName: 'ADP4', webSearch: false });
  assert.match(noSearch, /NO internet\/web search access/);
  assert.doesNotMatch(noSearch, /You have a web_search tool/);
});

test('buildAskTask: trims and caps', () => {
  assert.equal(buildAskTask('  why does login 403?  '), 'why does login 403?');
  assert.equal(buildAskTask('x'.repeat(40000)).length, 32000);
  assert.equal(buildAskTask(null), '');
});

// ---- web-search gating (Anthropic server tool) ----

test('webSearchServerTools: anthropic-only, flag polarity per lane', () => {
  // Ask lane: default ON.
  const on = webSearchServerTools({ provider: 'anthropic', env: {}, defaultOn: true });
  assert.equal(on.length, 1);
  assert.equal(on[0].type, 'web_search_20250305');
  assert.equal(on[0].name, 'web_search');
  assert.ok(on[0].max_uses > 0);
  // Explicit off wins.
  assert.deepEqual(webSearchServerTools({ provider: 'anthropic', env: { [WEB_SEARCH_FLAG]: 'off' }, defaultOn: true }), []);
  // Runner lane: default OFF, explicit on enables.
  assert.deepEqual(webSearchServerTools({ provider: 'anthropic', env: {}, flag: RUNNER_WEB_SEARCH_FLAG, defaultOn: false }), []);
  assert.equal(webSearchServerTools({ provider: 'anthropic', env: { [RUNNER_WEB_SEARCH_FLAG]: 'on' }, flag: RUNNER_WEB_SEARCH_FLAG, defaultOn: false }).length, 1);
  // Never for non-Anthropic providers, whatever the flag says.
  assert.deepEqual(webSearchServerTools({ provider: 'openai', env: { [WEB_SEARCH_FLAG]: 'on' }, defaultOn: true }), []);
  assert.deepEqual(webSearchServerTools({ provider: 'gemini', env: {}, defaultOn: true }), []);
});

// ---- command blocklist backstop ----

test('askCommandAllowed: runs tests/curl/queries and operational actions, refuses code mutation + bulk destruction', () => {
  assert.equal(askCommandAllowed('npm test').ok, true);
  assert.equal(askCommandAllowed('curl -s http://localhost:3000/api/health').ok, true);
  assert.equal(askCommandAllowed('psql -c "select count(*) from users"').ok, true);
  assert.equal(askCommandAllowed('tail -50 /var/log/app.log').ok, true);
  // Operational actions the user asked for are in scope: data inserts/updates,
  // targeted row deletes, service restarts.
  assert.equal(askCommandAllowed(`psql -c "insert into users (email, role) values ('a@b.c', 'member')"`).ok, true);
  assert.equal(askCommandAllowed(`psql -c "update users set role = 'admin' where email = 'a@b.c'"`).ok, true);
  assert.equal(askCommandAllowed(`psql -c "delete from sessions where user_id = 42"`).ok, true);
  assert.equal(askCommandAllowed('systemctl restart mock2-dev').ok, true);

  assert.equal(askCommandAllowed('').ok, false);
  assert.equal(askCommandAllowed('rm -rf node_modules').ok, false);
  assert.equal(askCommandAllowed('git commit -am wip').ok, false);
  assert.equal(askCommandAllowed('git push origin main').ok, false);
  assert.equal(askCommandAllowed('npm install leftpad').ok, false);
  // Bulk destruction stays refused: WHERE-less DELETE, DROP, TRUNCATE.
  assert.equal(askCommandAllowed('psql -c "delete from users"').ok, false);
  assert.equal(askCommandAllowed('psql -c "DROP TABLE users"').ok, false);
  assert.equal(askCommandAllowed('psql -c "truncate table sessions"').ok, false);
});

test('ask context block: recent conversation rides the first turn; drafting rule present', async () => {
  const { buildAskContextBlock, buildAskSystemPrompt, ASK_CONTEXT_MAX_MESSAGES } = await import('../mock2/ask-logic.js');
  // The user report: "write the prompt for all of that" answered "there's no
  // prior request in our conversation" because every ask started blank.
  const block = buildAskContextBlock([
    { kind: 'user', body: 'what would round out the timesheet feature?' },
    { kind: 'assistant', body: '1. Multiple shifts per day 2. PTO 3. Export CSV' },
    { kind: 'rule_question', body: 'never included' },
    { kind: 'system', body: 'Build finished.' },
  ]);
  assert.match(block, /Recent build-chat conversation/);
  assert.match(block, /User: what would round out/);
  assert.match(block, /Assistant \(you\): 1\. Multiple shifts/);
  assert.match(block, /System: Build finished\./);
  assert.ok(!block.includes('never included'), 'non-conversation kinds excluded');
  // Empty history renders nothing (older projects pay zero tokens).
  assert.equal(buildAskContextBlock([]), '');
  assert.equal(buildAskContextBlock(null), '');
  // Bounded: a flood of messages keeps only the newest window.
  const many = buildAskContextBlock(Array.from({ length: 40 }, (_, i) => ({ kind: 'user', body: `msg ${i}` })));
  assert.ok(!many.includes('msg 0'));
  assert.ok(many.includes(`msg 39`));
  assert.ok(ASK_CONTEXT_MAX_MESSAGES >= 8);
  // The prompt now allows drafting prompts/specs (the refusal in the user's
  // screenshot) while still forbidding code changes.
  const sys = buildAskSystemPrompt({ projectName: 'x' });
  assert.match(sys, /DRAFTING TEXT IS ALWAYS FINE/);
  assert.match(sys, /Do NOT modify the CODE/);
});
