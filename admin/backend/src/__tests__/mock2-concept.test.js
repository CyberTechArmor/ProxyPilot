// Mock2 Phase M7 tests — the Concept-stage pure decision layer (Stage 1: chat,
// mockup, design approval).
//
// Stub-first (risk R9): imports ONLY concept-logic.js (native-free — no db.js,
// no better-sqlite3, no Incus, no model API). The restricted tool policy, the
// design-system-injected prompts, the mockup-HTML extraction, the design
// inventory parse, the chat→transcript mapping, the stage indicator, and the
// cost envelope are all safety-relevant to Stage 1, so they're unit-tested here.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CONCEPT_CHAT_TOOLS, CONCEPT_CHAT_TOOL_NAMES,
  buildConceptChatSystemPrompt, buildMockupSystemPrompt, buildMockupTask,
  buildInventoryExtractionPrompt, buildInventoryExtractionTask,
  extractMockupHtml, isPlausibleMockup, parseInventory, inventoryCounts,
  classifyConceptTurn, buildConceptTranscript, conversationRecap,
  publicChatMessageShape, conceptStageInfo, mockupPreviewUrl,
  mockupFileName, mockupIdForCycle,
  estimateConceptTurnTokens, estimateInventoryTokens,
  STAGES, MOCKUP_PREVIEW_PATH, MOCKUP_CURRENT, INVENTORY_PATH,
} from '../mock2/concept-logic.js';

// ---- the RESTRICTED concept-stage tool policy ----

test('CONCEPT_CHAT_TOOLS: exactly one tool, generate_mockup — no write/exec', () => {
  assert.deepEqual(CONCEPT_CHAT_TOOL_NAMES, ['generate_mockup']);
  // structurally cannot write backend code or rules: no file/exec tools offered
  assert.ok(!CONCEPT_CHAT_TOOL_NAMES.includes('write_file'));
  assert.ok(!CONCEPT_CHAT_TOOL_NAMES.includes('exec_in_container'));
  const t = CONCEPT_CHAT_TOOLS[0];
  assert.equal(t.input_schema.type, 'object');
  assert.deepEqual(t.input_schema.required, ['brief']);
});

// ---- prompts inject the pinned design system (ADR-003) ----

test('buildConceptChatSystemPrompt: embeds the pinned design system + the cannot-build rule', () => {
  const p = buildConceptChatSystemPrompt({ designSystem: 'TOKENS: green #22c55e', projectName: 'ShiftSwap', hasMockup: false });
  assert.match(p, /TOKENS: green #22c55e/);
  assert.match(p, /ShiftSwap/);
  assert.match(p, /cannot write code/i);
  assert.match(p, /Concept/);
  // hasMockup toggles the "revise the current one" vs "no mockup yet" hint
  assert.match(buildConceptChatSystemPrompt({ hasMockup: true }), /already exists/i);
  assert.match(buildConceptChatSystemPrompt({ hasMockup: false }), /No mockup exists yet/i);
});

test('buildMockupSystemPrompt: embeds the design system + self-contained/mobile rules', () => {
  const p = buildMockupSystemPrompt({ designSystem: 'RULE: one palette' });
  assert.match(p, /RULE: one palette/);
  assert.match(p, /self-contained|inline/i);
  assert.match(p, /360/);
  assert.match(p, /<!doctype html>/i);
});

test('buildMockupTask: includes the brief and the current HTML when iterating', () => {
  const fresh = buildMockupTask({ brief: 'a login screen', projectName: 'App' });
  assert.match(fresh, /login screen/);
  assert.match(fresh, /no existing mockup/i);
  const iter = buildMockupTask({ brief: 'add a signup link', currentHtml: '<!doctype html><html></html>', projectName: 'App' });
  assert.match(iter, /CURRENT mockup/i);
  assert.match(iter, /signup link/);
});

// ---- mockup HTML extraction ----

test('extractMockupHtml: raw, fenced, and prose-prefixed', () => {
  const raw = '<!doctype html><html><body>hi</body></html>';
  assert.equal(extractMockupHtml(raw), raw);
  assert.equal(extractMockupHtml('```html\n' + raw + '\n```'), raw);
  assert.equal(extractMockupHtml('Here you go:\n' + raw), raw);
  assert.equal(extractMockupHtml(''), '');
});

test('isPlausibleMockup: needs real HTML structure', () => {
  assert.equal(isPlausibleMockup('<!doctype html><html><body><div>x</div></body></html>'), true);
  assert.equal(isPlausibleMockup('sorry, I cannot do that'), false);
  assert.equal(isPlausibleMockup(''), false);
  assert.equal(isPlausibleMockup('<html>'), false); // no closing tag
  // A document must CLOSE — a render truncated on the token budget keeps its
  // opening + early closing tags but loses </body></html> and renders black.
  assert.equal(isPlausibleMockup('<!doctype html><html><head><style>body{}</style></head><body><div>cut off here'), false);
  assert.equal(isPlausibleMockup('<!doctype html><html><body><main>ok</main></body>'), true); // </body> alone is enough
});

// ---- design inventory parse (the concept-stage exit artifact) ----

test('parseInventory: valid object → normalized screens/fields/actions/states', () => {
  const raw = JSON.stringify({
    screens: [
      { name: 'Home', purpose: 'landing', fields: [{ name: 'q', type: 'search' }], actions: [{ label: 'Go', effect: 'search' }], states: ['empty', 'results'] },
      { name: 'Detail' },
    ],
    entities: [{ name: 'Item', fields: ['id', 'title'] }],
    notes: 'n',
  });
  const r = parseInventory(raw);
  assert.equal(r.ok, true);
  assert.equal(r.inventory.screens.length, 2);
  assert.equal(r.inventory.screens[0].fields[0].type, 'search');
  assert.equal(r.inventory.screens[0].fields[0].required, false);
  assert.equal(r.inventory.screens[1].fields.length, 0); // normalized empties
  assert.equal(r.inventory.entities[0].name, 'Item');
  assert.equal(r.inventory.version, 1);
});

test('parseInventory: tolerates ```json fences and leading prose', () => {
  const r = parseInventory('Here it is:\n```json\n{"screens":[{"name":"A"}]}\n```');
  assert.equal(r.ok, true);
  assert.equal(r.inventory.screens[0].name, 'A');
});

test('parseInventory: rejects non-JSON, non-object, and screenless', () => {
  assert.equal(parseInventory('not json').ok, false);
  assert.equal(parseInventory('[1,2,3]').ok, false);
  assert.equal(parseInventory('{"screens":[]}').ok, false);
  assert.equal(parseInventory('').ok, false);
});

test('inventoryCounts: totals screens, fields, actions', () => {
  const c = inventoryCounts({ screens: [
    { fields: [{}, {}], actions: [{}] },
    { fields: [{}], actions: [] },
  ] });
  assert.deepEqual(c, { screens: 2, fields: 3, actions: 1 });
  assert.deepEqual(inventoryCounts(null), { screens: 0, fields: 0, actions: 0 });
});

// ---- chat → model transcript ----

test('classifyConceptTurn: detects generate_mockup + pulls the brief (scope defaults full)', () => {
  assert.deepEqual(classifyConceptTurn([{ name: 'generate_mockup', input: { brief: '  a form  ' } }]), { generateMockup: true, brief: 'a form', scope: 'full', screen: null });
  assert.deepEqual(classifyConceptTurn([]), { generateMockup: false, brief: null, scope: 'full', screen: null });
  assert.deepEqual(classifyConceptTurn([{ name: 'other' }]), { generateMockup: false, brief: null, scope: 'full', screen: null });
});

test('buildConceptTranscript: maps user/assistant, skips system, appends new user text', () => {
  const msgs = [
    { kind: 'user', body: 'hi' },
    { kind: 'assistant', body: 'hello' },
    { kind: 'system', body: 'mockup updated' }, // skipped — human-facing note, not model turn
  ];
  const t = buildConceptTranscript(msgs, 'add login');
  assert.deepEqual(t, [
    { role: 'user', text: 'hi' },
    { role: 'assistant', text: 'hello' },
    { role: 'user', text: 'add login' },
  ]);
  // no new text → just the mapped history
  assert.equal(buildConceptTranscript(msgs).length, 2);
});

test('conversationRecap: last N human/model turns as labelled lines', () => {
  const recap = conversationRecap([
    { kind: 'user', body: 'a' }, { kind: 'assistant', body: 'b' }, { kind: 'system', body: 'c' },
  ]);
  assert.match(recap, /Builder: a/);
  assert.match(recap, /Design partner: b/);
  assert.ok(!recap.includes('c')); // system skipped
});

// ---- response shape + stage indicator ----

test('publicChatMessageShape: client-safe, coerces acting_as_admin', () => {
  const s = publicChatMessageShape({ id: 1, kind: 'user', body: 'hey', author_user_id: 3, acting_as_admin: 1, cycle_id: 5, created_at: 't' });
  assert.equal(s.kind, 'user');
  assert.equal(s.acting_as_admin, true);
  assert.equal(s.cycle_id, 5);
  assert.equal(publicChatMessageShape(null), null);
});

test('conceptStageInfo: concept until approved, then build unlocked', () => {
  const pre = conceptStageInfo({ design_approved_at: null });
  assert.equal(pre.current, 'concept');
  assert.equal(pre.design_approved, false);
  assert.equal(pre.build_unlocked, false);
  const post = conceptStageInfo({ design_approved_at: '2026-07-10T00:00:00Z' });
  assert.equal(post.current, 'build');
  assert.equal(post.design_approved, true);
  assert.equal(post.build_unlocked, true);
  assert.deepEqual(pre.stages, STAGES);
  assert.deepEqual(STAGES, ['concept', 'define', 'build', 'run']);
});

test('mockupPreviewUrl: project URL + preview path, only when a mockup exists', () => {
  assert.equal(mockupPreviewUrl('https://p-abc.dev.example.com', true), `https://p-abc.dev.example.com${MOCKUP_PREVIEW_PATH}`);
  assert.equal(mockupPreviewUrl('https://p-abc.dev.example.com', false), null);
  assert.equal(mockupPreviewUrl(null, true), null);
});

// ---- paths + ids ----

test('mockup/inventory paths + id are stable and path-safe', () => {
  assert.equal(MOCKUP_CURRENT, 'state/mockups/current.html');
  assert.equal(INVENTORY_PATH, 'state/inventory.json');
  assert.equal(mockupIdForCycle(42), 'mk-42');
  assert.equal(mockupFileName('mk-42'), 'state/mockups/mk-42.html');
  // an id with hostile characters is sanitized: slashes are stripped, so the
  // result can never escape state/mockups/ (dots survive but are harmless with
  // no path separator).
  const hostile = mockupFileName('../../etc/passwd');
  assert.ok(hostile.startsWith('state/mockups/'));
  assert.ok(!hostile.slice('state/mockups/'.length).includes('/'));
});

// ---- cost envelope (R5) ----

test('estimateConceptTurnTokens / estimateInventoryTokens: positive envelopes', () => {
  const e = estimateConceptTurnTokens();
  assert.ok(e.chat.inputTokens > 0 && e.chat.outputTokens > 0);
  assert.ok(e.mockup.inputTokens > 0 && e.mockup.outputTokens > 0);
  const inv = estimateInventoryTokens();
  assert.ok(inv.inputTokens > 0 && inv.outputTokens > 0);
});

test('inventory extraction prompt asks for JSON-only, screen-complete output', () => {
  const p = buildInventoryExtractionPrompt();
  assert.match(p, /JSON/);
  assert.match(p, /screens/);
  assert.match(p, /fields/);
  const task = buildInventoryExtractionTask({ html: '<html></html>', projectName: 'X' });
  assert.match(task, /X/);
  assert.match(task, /<html>/);
});

test('mockup prompt: design-judgment craft bar (operator-validated language)', async () => {
  const { buildMockupSystemPrompt } = await import('../mock2/concept-logic.js');
  const p = buildMockupSystemPrompt({ designSystem: 'SYSTEM_TOKENS' });
  // The operator's hand-written prompt produced strikingly better renders;
  // its transferable structure is now the standing bar. Pin its load-bearing
  // phrases: earned defaults, operating conditions, rationale comment,
  // functional color, hard states, and the named anti-patterns.
  assert.match(p, /# Design craft/);
  assert.match(p, /treat EVERY default as a decision you\s+must earn/);
  assert.match(p, /REAL OPERATING CONDITIONS/);
  assert.match(p, /DESIGN RATIONALE as an HTML comment/);
  assert.match(p, /EVERY COLOR HAS A JOB/);
  assert.match(p, /NEVER expose internal steps, state names, or data-model language/);
  assert.match(p, /PROVE IT WITH THE HARD STATES/);
  assert.match(p, /NEVER use emoji as UI iconography/);
  assert.match(p, /inline SVG icons/i);
  assert.match(p, /ANTI-PATTERNS/);
  assert.match(p, /generic-dashboard look/);
  assert.match(p, /exactly four rows of\s+data/);
  // The craft section sits INSIDE the prompt, before the locked system.
  assert.ok(p.indexOf('# Design craft') < p.indexOf('# Locked design system'));
  assert.match(p, /SYSTEM_TOKENS/);
});

test('concept chat prompt: brief-enrichment — thorough passes through, simple gets domain-expert expansion', async () => {
  const { buildConceptChatSystemPrompt } = await import('../mock2/concept-logic.js');
  const p = buildConceptChatSystemPrompt({ designSystem: 'X', projectName: 'Clinic', mode: 'design' });
  assert.match(p, /THE BRIEF YOU WRITE IS THE DESIGN'S CEILING/);
  assert.match(p, /THOROUGH request .* passes through faithfully/s);
  assert.match(p, /SIMPLE request .* gets EXPANDED/s);
  assert.match(p, /Surfaces & audiences/);
  assert.match(p, /Hard states the mockup must PROVE/);
  assert.match(p, /as DIRECTIVES/);
  assert.match(p, /1–2 DIRECTION questions FIRST only when a genuine\s+fork/);
  assert.match(p, /NOTE the\s+defaults you chose/);
  // Plan mode keeps its own block — no enrichment directives there.
  const plan = buildConceptChatSystemPrompt({ designSystem: 'X', mode: 'plan' });
  assert.ok(!plan.includes("THE BRIEF YOU WRITE IS THE DESIGN'S CEILING"));
});

test('mockup tweak mode: scope classification, edit parse/apply, fallback signals', async () => {
  const { classifyConceptTurn, buildMockupEditSystemPrompt, parseMockupEdits, applyMockupEdits } = await import('../mock2/concept-logic.js');
  // Tool scope: tweak recognized; anything else (or absent) is a safe 'full'.
  assert.equal(classifyConceptTurn([{ name: 'generate_mockup', input: { brief: 'b', scope: 'tweak' } }]).scope, 'tweak');
  assert.equal(classifyConceptTurn([{ name: 'generate_mockup', input: { brief: 'b' } }]).scope, 'full');
  assert.equal(classifyConceptTurn([]).scope, 'full');
  assert.match(buildMockupEditSystemPrompt(), /FULL_RERENDER/);

  const doc = '<h1>Riverside Clinic</h1>\n<p>Welcome</p>\n<p>Welcome</p>';
  // Clean single-match edit applies.
  const one = parseMockupEdits('<<<<SEARCH\n<h1>Riverside Clinic</h1>\n====\n<h1>Lakeside Clinic</h1>\n>>>>');
  assert.equal(one.ok, true);
  const applied = applyMockupEdits(doc, one.edits);
  assert.equal(applied.ok, true);
  assert.match(applied.html, /Lakeside Clinic/);
  // Ambiguous search (two <p>Welcome</p>) refuses — half-applied mockups never ship.
  const ambig = applyMockupEdits(doc, [{ search: '<p>Welcome</p>', replace: '<p>Hi</p>' }]);
  assert.equal(ambig.ok, false);
  assert.match(ambig.error, /more than once/);
  // Missing search refuses; FULL_RERENDER is the model's structural escape.
  assert.equal(applyMockupEdits(doc, [{ search: 'nope', replace: 'x' }]).ok, false);
  assert.deepEqual(parseMockupEdits('FULL_RERENDER'), { ok: true, fullRerender: true, edits: [] });
  // Prose without blocks is unusable (falls back to the full renderer).
  assert.equal(parseMockupEdits('I changed the heading for you!').ok, false);
});

test('screen sections: contract in the prompt, find/replace/extract helpers', async () => {
  const { buildMockupSystemPrompt, listScreenSections, findScreenSection, replaceScreenSection, extractSectionHtml, buildScreenRenderSystemPrompt, classifyConceptTurn } = await import('../mock2/concept-logic.js');
  assert.match(buildMockupSystemPrompt({}), /SCREEN SECTIONS \(structural contract\)/);
  assert.match(buildScreenRenderSystemPrompt({ designSystem: 'DS' }), /ONLY the replacement <section>/);
  assert.match(buildScreenRenderSystemPrompt({}), /attributes EXACTLY/);

  const doc = '<!doctype html><html><body>'
    + '<section data-screen="Kiosk" class="scr on"><h1>Kiosk v1</h1></section>'
    + '<section data-screen="Staff Queue" class="scr"><h1>Staff v1</h1></section>'
    + '</body></html>';
  assert.deepEqual(listScreenSections(doc), ['Kiosk', 'Staff Queue']);
  const f = findScreenSection(doc, 'Staff Queue');
  assert.equal(f.ok, true);
  assert.match(f.section, /Staff v1/);
  assert.equal(findScreenSection(doc, 'Missing').ok, false);
  const swapped = replaceScreenSection(doc, 'Kiosk', '<section data-screen="Kiosk" class="scr on"><h1>Kiosk v2</h1></section>');
  assert.equal(swapped.ok, true);
  assert.match(swapped.html, /Kiosk v2/);
  assert.match(swapped.html, /Staff v1/); // other screens untouched
  // Reply extraction strips fences/prose; missing section → null (fallback).
  assert.match(extractSectionHtml('Here:\n```html\n<section data-screen="Kiosk">new</section>\n```', 'Kiosk'), /^<section data-screen="Kiosk">new<\/section>$/);
  assert.equal(extractSectionHtml('I could not do that.', 'Kiosk'), null);
  // Tool scope: 'screen' recognized with its screen name.
  const c = classifyConceptTurn([{ name: 'generate_mockup', input: { brief: 'b', scope: 'screen', screen: 'Kiosk' } }]);
  assert.equal(c.scope, 'screen');
  assert.equal(c.screen, 'Kiosk');
});
