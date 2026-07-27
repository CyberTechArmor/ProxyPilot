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

test('precedence: the brief outranks the locked design system (theme-guardrail regression)', async () => {
  const { buildMockupSystemPrompt, buildMockupTask, buildConceptChatSystemPrompt } = await import('../mock2/concept-logic.js');
  // Operator review: an explicit token spec (teal palette, light theme, per-
  // stage hues) lost to the locked system — geometry obeyed, color ignored.
  const p = buildMockupSystemPrompt({ designSystem: 'DS' });
  assert.match(p, /# PRECEDENCE — the brief outranks the locked system/);
  assert.match(p, /a requested light theme must never\s+render dark/);
  assert.match(p, /Never resolve a conflict by\s+keeping the incumbent look/);
  // The precedence section reads BEFORE the (now default-labeled) system.
  assert.ok(p.indexOf('# PRECEDENCE') < p.indexOf('# Locked design system'));
  assert.match(p, /Locked design system \(defaults — applies where the brief is silent\)/);
  // Iteration turns: stability never protects styling the brief replaces.
  const iter = buildMockupTask({ brief: 'switch to the teal light theme', currentHtml: '<!doctype html><html></html>' });
  assert.match(iter, /restyle the ENTIRE document/);
  assert.match(iter, /palette must not survive/);
  // The design partner carries Builder token specs verbatim, at the top.
  const chat = buildConceptChatSystemPrompt({ designSystem: 'DS', mode: 'design' });
  assert.match(chat, /THE BUILDER OWNS THE LOOK/);
  assert.match(chat, /VERBATIM/);
  assert.match(chat, /prevent drift, not to veto the Builder/);
});

test('part 1 guardrail removal: no "obey EXACTLY", restyle strips inherited styles, screen renders honor the brief', async () => {
  const { buildMockupSystemPrompt, buildMockupTask, stripInheritedStyles, buildScreenRenderSystemPrompt, buildConceptChatSystemPrompt } = await import('../mock2/concept-logic.js');
  // The hard-requirements bullet that beat the PRECEDENCE section is gone:
  // tokens are resolved by precedence, the default system is a fallback.
  const p = buildMockupSystemPrompt({ designSystem: 'DS' });
  assert.doesNotMatch(p, /Obey the locked design system below EXACTLY/);
  assert.match(p, /resolved by precedence/);
  assert.match(p, /a fallback,\s+never a veto/);
  // Restyle iterations forward the prior markup WITHOUT its stylesheet — the
  // incumbent palette is not context.
  const cur = '<!doctype html><html><head><style>body{background:#070b11;color:#22c55e}</style></head><body><h1>App</h1></body></html>';
  const stripped = stripInheritedStyles(cur);
  assert.doesNotMatch(stripped, /#070b11|#22c55e/);
  assert.match(stripped, /inherited styling removed/);
  const task = buildMockupTask({ brief: 'teal light theme, tokens: --accent:#0F766E', currentHtml: cur, restyle: true });
  assert.doesNotMatch(task, /#070b11/);
  assert.match(task, /stylesheet REMOVED/);
  assert.match(task, /rebuild ALL styling from the brief's spec/);
  // Non-restyle iterations keep the full document (stability wording intact).
  assert.match(buildMockupTask({ brief: 'fix the header copy', currentHtml: cur }), /#070b11/);
  // Screen-scope re-renders: an explicit visual spec in the brief wins over
  // the document's incumbent styling too.
  const sp = buildScreenRenderSystemPrompt({ designSystem: 'DS' });
  assert.match(sp, /the brief WINS over/);
  assert.doesNotMatch(sp, /Stay consistent with the locked design system/);
  // The design partner's system label is a default, not a veto.
  const chat = buildConceptChatSystemPrompt({ designSystem: 'DS', mode: 'design' });
  assert.match(chat, /# Default design system \(the Builder's explicit spec above outranks it\)/);
});

test('part 2 wiring: the render prompt carries the base token stylesheet and the override line', async () => {
  const { buildMockupSystemPrompt } = await import('../mock2/concept-logic.js');
  const { MOCKUP_BASE_CSS } = await import('../mock2/mockup-template.js');
  const p = buildMockupSystemPrompt({ designSystem: 'DS' });
  assert.match(p, /# Base token stylesheet \(structural contract — include VERBATIM\)/);
  assert.match(p, /Ignore any pre-existing theme, brand colors, or prior mockup styling/);
  assert.match(p, /Light is the reference theme;\s*\n?render light first/);
  assert.ok(p.includes(MOCKUP_BASE_CSS), 'base stylesheet embedded verbatim');
  assert.match(p, /toggleTheme/);
  // Overrides re-value the properties — never bypass them.
  assert.match(p, /RE-VALUE the custom properties/);
  // Ordering: structural contract, then PRECEDENCE, then the default system.
  const precedenceHeading = '# PRECEDENCE — the brief outranks the locked system';
  assert.ok(p.indexOf('# Base token stylesheet') < p.indexOf(precedenceHeading));
  assert.ok(p.indexOf(precedenceHeading) < p.indexOf('# Locked design system'));
});

test('part 3 wiring: the render prompt carries the defect-class hardening rules', async () => {
  const { buildMockupSystemPrompt } = await import('../mock2/concept-logic.js');
  const p = buildMockupSystemPrompt({ designSystem: 'DS' });
  assert.match(p, /# Defect-class hardening/);
  assert.match(p, /canonical \.list-row 5-column grid/);
  assert.match(p, /never overlap at any\s+viewport ≥ 1280px/);
  assert.match(p, /ONE METRIC PER ROW\/CARD/);
  assert.match(p, /BARS CARRY DATA/);
  assert.match(p, /must not be rendered/);
  assert.match(p, /data-kind="detail"/);
  assert.match(p, /data-band="ladder"/);
  assert.match(p, /Promote to next level/);
  assert.match(p, /no stage may fall back to a\s+neutral\/default color/);
  assert.match(p, /exactly ONE lifecycle stage/);
  assert.match(p, /100% belongs only to a\s+completed\/maintenance stage/);
});

test('mockupRenderBudget: sized from the current document, floor 40k, ceiling 64k', async () => {
  const { mockupRenderBudget } = await import('../mock2/concept-logic.js');
  // First render / small docs get the floor.
  assert.equal(mockupRenderBudget(0), 40000);
  assert.equal(mockupRenderBudget(50000), 40000);
  // A large multi-screen document raises the budget so a full revision can
  // re-emit it (the flat 40k truncated these by construction).
  const big = mockupRenderBudget(120000);
  assert.ok(big > 40000 && big <= 64000, `budget ${big} for 120k chars`);
  // Ceiling: past 64k output the continuation path finishes the document.
  assert.equal(mockupRenderBudget(1000000), 64000);
  // Monotonic in document size up to the ceiling.
  assert.ok(mockupRenderBudget(150000) >= mockupRenderBudget(120000));
});

test('stitchContinuation: overlap removal, fence stripping, restart adoption (prefill-free continuation)', async () => {
  const { stitchContinuation, buildContinuationInstruction } = await import('../mock2/concept-logic.js');
  const doc = '<!doctype html><html><body><section data-screen="A"><div class="card"><p>alpha beta gamma delta';
  // Clean continuation appends verbatim.
  assert.equal(stitchContinuation(doc, ' epsilon</p></div></section></body></html>').html,
    doc + ' epsilon</p></div></section></body></html>');
  // The model repeated some tail context — the overlap is removed once.
  const overlapped = '<p>alpha beta gamma delta epsilon</p></div></section></body></html>';
  const s = stitchContinuation(doc, overlapped);
  assert.equal(s.html, doc + ' epsilon</p></div></section></body></html>');
  assert.equal((s.html.match(/alpha beta gamma delta/g) || []).length, 1);
  // Fences around the continuation are stripped before stitching.
  assert.equal(stitchContinuation(doc, '```html\n epsilon</p></body></html>\n```').html,
    doc + ' epsilon</p></body></html>');
  // A full restart (model re-emitted the document) REPLACES the partial.
  const fresh = '<!doctype html><html><body><main>v2</main></body></html>';
  const r = stitchContinuation(doc, fresh);
  assert.equal(r.restarted, true);
  assert.equal(r.html, fresh);
  // Tiny/no overlap just concatenates (no false positives under 12 chars).
  assert.equal(stitchContinuation('abc', 'def').html, 'abcdef');
  // The instruction anchors on the document tail and forbids repetition.
  const instr = buildContinuationInstruction(doc);
  assert.match(instr, /NO repetition/);
  assert.ok(instr.includes('alpha beta gamma delta'));
});

test('CRUD completion: implied edit/delete/status actions added; immutable respected; lint flags shapes', async () => {
  const { completeInventoryCrud, lintInventory } = await import('../mock2/concept-logic.js');
  // Project-32 shape: creates + navigation only, a display-only status field.
  const inv = {
    screens: [
      { name: 'Opportunities', purpose: '', fields: [{ name: 'Stage filter', type: 'select', required: false, notes: 'filter' }], actions: [{ label: 'New opportunity', effect: 'Opens create form' }, { label: 'Card click', effect: 'Navigates to detail' }], states: [] },
      { name: 'Opportunity Detail', purpose: '', fields: [{ name: 'Task status dot', type: 'radio', required: false, notes: '' }], actions: [{ label: 'Add task', effect: 'Adds a task' }, { label: 'Promote', effect: 'Promotes' }], states: [] },
    ],
    entities: [], notes: '',
  };
  const { inventory, added } = completeInventoryCrud(inv);
  const labels = inventory.screens.flatMap((s) => s.actions.map((a) => a.label));
  assert.ok(labels.some((l) => /^Edit opportunity/i.test(l)), 'edit added');
  assert.ok(labels.some((l) => /^Delete opportunity/i.test(l)), 'delete added');
  assert.ok(labels.some((l) => /^Change Task status/i.test(l)), 'status mutation added');
  // Added on the DETAIL screen (where mutations live), all marked inferred.
  const detail = inventory.screens[1];
  assert.ok(detail.actions.some((a) => a.inferred && /^Edit/.test(a.label)));
  assert.ok(added.length >= 3);
  // Original inventory untouched (pure).
  assert.equal(inv.screens[1].actions.length, 2);
  // "Add task" is a create too — task edit/delete also implied.
  assert.ok(labels.some((l) => /^Edit task/i.test(l)));
  // Immutable opt-out suppresses record completion.
  const frozen = completeInventoryCrud({ screens: [{ name: 'Log', fields: [], actions: [{ label: 'Add entry', effect: 'x' }], states: [] }], notes: 'entries are append-only and cannot be edited' });
  assert.ok(!frozen.inventory.screens[0].actions.some((a) => /^Edit/.test(a.label)));

  // Linter: the raw project-32 shape trips all three families.
  const warnings = lintInventory(inv);
  assert.ok(warnings.some((w) => /no edit action/.test(w)), 'create-without-edit flagged');
  assert.ok(warnings.some((w) => /filter/.test(w)), 'filter fields without actions flagged');
  assert.ok(warnings.some((w) => /display-only status/.test(w)), 'dead-end status flagged');
  // The COMPLETED inventory lints clean on those families.
  assert.equal(lintInventory(inventory).filter((w) => /no edit action|display-only/.test(w)).length, 0);
});

test('states vs defaults: default_state normalized, prompts carry the demo-state convention, lint flags its absence', async () => {
  const { parseInventory, buildInventoryExtractionPrompt, buildMockupSystemPrompt, lintInventory } = await import('../mock2/concept-logic.js');
  const r = parseInventory(JSON.stringify({ screens: [
    { name: 'List', states: ['default', 'chip active (filtered)'], default_state: 'all groups expanded, no filters applied' },
    { name: 'Bare', states: ['collapsed'] },
  ] }));
  assert.equal(r.ok, true);
  assert.equal(r.inventory.screens[0].default_state, 'all groups expanded, no filters applied');
  assert.equal(r.inventory.screens[1].default_state, '');
  // Extractor: demonstrated-vs-default semantics + the annotation channel.
  const ep = buildInventoryExtractionPrompt();
  assert.match(ep, /DEMONSTRATED ≠ DEFAULT/);
  assert.match(ep, /data-demo-state/);
  assert.match(ep, /default_state/);
  // Renderer: mockups must annotate demonstration states.
  assert.match(buildMockupSystemPrompt({ designSystem: 'DS' }), /DEMO-STATE ANNOTATION/);
  // Lint: states with no declared resting state is flagged.
  const warnings = lintInventory(r.inventory);
  assert.ok(warnings.some((w) => /"Bare".*no default_state/.test(w)));
  assert.ok(!warnings.some((w) => /"List".*no default_state/.test(w)));
});

test('variant screens fold into their base (project-33: theme/empty sections each burned a build)', async () => {
  const { mergeVariantScreens, buildMockupSystemPrompt } = await import('../mock2/concept-logic.js');
  const inv = { screens: [
    { name: 'Opportunities List (Light)', purpose: 'browse', fields: [{ name: 'Stage filter', type: 'select' }], actions: [{ label: 'New opportunity', effect: 'create' }], states: ['default'], default_state: 'all groups expanded' },
    { name: 'Opportunities List (Dark)', purpose: 'same grouped list, dark', fields: [{ name: 'Stage filter', type: 'select' }], actions: [{ label: 'New opportunity', effect: 'create' }, { label: 'Theme switch', effect: 'toggles' }], states: [] },
    { name: 'My Projects (Empty)', purpose: 'developer lens', fields: [], actions: [{ label: 'New opportunity', effect: 'create' }], states: [] },
    { name: 'Opportunity Detail', purpose: 'detail', fields: [], actions: [], states: [] },
  ] };
  const { inventory, merged } = mergeVariantScreens(inv);
  const names = inventory.screens.map((s) => s.name);
  // Light+Dark collapse to ONE base screen; Empty collapses to its base.
  assert.deepEqual(names, ['Opportunities List', 'My Projects', 'Opportunity Detail']);
  const list = inventory.screens[0];
  // Dark becomes a state (the toggle mechanism), not a screen; fields/actions union without dupes.
  assert.ok(list.states.some((st) => /dark theme/.test(st)));
  assert.equal(list.fields.filter((f) => f.name === 'Stage filter').length, 1);
  assert.ok(list.actions.some((a) => a.label === 'Theme switch'));
  assert.equal(list.default_state, 'all groups expanded');
  // Empty variant becomes the base screen carrying an 'empty' state.
  assert.ok(inventory.screens[1].states.includes('empty'));
  assert.equal(merged.length, 3); // Light renamed + Dark folded + Empty renamed
  // Non-variant parentheses survive untouched.
  const keep = mergeVariantScreens({ screens: [{ name: 'Reports (Admin)', states: [] }] });
  assert.equal(keep.inventory.screens[0].name, 'Reports (Admin)');
  // The renderer contract forbids variant sections at the source.
  assert.match(buildMockupSystemPrompt({ designSystem: 'DS' }), /never per variant/);
});

test('screen plan folds variants before planning (already-approved inventories protected)', async () => {
  const { screenPlanFromInventory, screenItemsFromInventory } = await import('../mock2/screen-plan-logic.js');
  const inv = { screens: [
    { name: 'List (Light)', purpose: 'p', fields: [], actions: [], states: [] },
    { name: 'List (Dark)', purpose: 'p', fields: [], actions: [], states: [] },
    { name: 'Detail', purpose: 'p', fields: [], actions: [], states: [] },
  ] };
  const plan = screenPlanFromInventory(inv);
  assert.deepEqual(plan.map((r) => r.name), ['List', 'Detail']);
  const items = screenItemsFromInventory(inv);
  assert.ok(items.every((i) => i.screen !== 'List (Dark)' && i.screen !== 'List (Light)'));
});

/* -------- the design partner knows what the Builder already supplied -------- */

test('the concept prompt states what is in the asset library, and what is not', async () => {
  const { buildConceptChatSystemPrompt } = await import('../mock2/concept-logic.js');
  const empty = buildConceptChatSystemPrompt({ assets: { total: 0, images: 0, content: 0 } });
  // An empty library must invite the logo ONCE and then get out of the way — a
  // mockup with sensible placeholders beats a question the Builder has to answer
  // before seeing anything.
  assert.match(empty, /ASSET LIBRARY: empty/);
  assert.match(empty, /Do not block on it/);

  const stocked = buildConceptChatSystemPrompt({ assets: { total: 3, images: 2, content: 1 } });
  assert.match(stocked, /2 images/);
  assert.match(stocked, /1 written note/);
  // The failure this prevents: asking the Builder to upload a logo they already
  // uploaded, because the design partner could not see the library.
  assert.match(stocked, /Never ask the Builder for something already in the library/);
});

test('the mockup task carries the assets, after the brief and before the output rule', async () => {
  const { buildMockupTask } = await import('../mock2/concept-logic.js');
  const section = '\n\nUse the supplied logo.';
  const task = buildMockupTask({ brief: 'a check-in screen', assetSection: section });
  assert.match(task, /Use the supplied logo\./);
  // Order is the point: material to build WITH, not a second brief that
  // displaces this turn's, and never after the "output HTML only" instruction.
  assert.ok(task.indexOf('a check-in screen') < task.indexOf('Use the supplied logo'));
  assert.ok(task.indexOf('Use the supplied logo') < task.indexOf('Output the full updated HTML'));
  // No library, no tokens.
  assert.doesNotMatch(buildMockupTask({ brief: 'x' }), /Use the supplied logo/);
});
