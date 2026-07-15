// Pure design-template layer: building/parsing the portable design document
// (mockup + original brief, never code), the import seed message, and the
// initial-build instruction that quotes an imported design's original prompt.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DESIGN_TEMPLATE_FORMAT, DESIGN_TEMPLATE_VERSION, MAX_TEMPLATE_HTML_CHARS,
  projectHasDesign, originalPromptFromMessages, designConversation,
  buildDesignTemplate, parseDesignTemplate, mockupIdForImport,
  buildImportSeedMessage, designImportRecord, parseDesignImport,
  buildInitialBuildInstruction,
} from '../mock2/design-template-logic.js';

const HTML = '<!doctype html><html><body><main>Inventory app mockup</main></body></html>';

const MESSAGES = [
  { kind: 'system', body: 'Project created.', created_at: '2026-07-01T00:00:00Z' },
  { kind: 'user', body: 'Build me an inventory tracker for a small warehouse.', created_at: '2026-07-01T00:01:00Z' },
  { kind: 'assistant', body: 'Great — here is a first mockup.', created_at: '2026-07-01T00:02:00Z' },
  { kind: 'user', body: 'Add a low-stock alert screen.', created_at: '2026-07-01T00:03:00Z' },
  { kind: 'assistant', body: 'Done — take a look.', created_at: '2026-07-02T00:00:00Z' },
];

// ---- projectHasDesign ----

test('projectHasDesign: live mockup, archived mockup, or neither', () => {
  assert.equal(projectHasDesign({ current_mockup_id: 'mk-3' }), true);
  assert.equal(projectHasDesign({ current_mockup_id: null, mockup_archived_id: 'mk-3' }), true);
  assert.equal(projectHasDesign({ current_mockup_id: null, mockup_archived_id: null }), false);
  assert.equal(projectHasDesign(null), false);
});

// ---- original prompt + conversation ----

test('originalPromptFromMessages: first user turn, skipping system notes', () => {
  assert.equal(originalPromptFromMessages(MESSAGES), 'Build me an inventory tracker for a small warehouse.');
  assert.equal(originalPromptFromMessages([]), '');
  assert.equal(originalPromptFromMessages([{ kind: 'assistant', body: 'hi' }]), '');
});

test('designConversation: human/model turns only, cut at approval, capped', () => {
  const full = designConversation(MESSAGES);
  assert.match(full, /^Builder: Build me an inventory tracker/);
  assert.match(full, /Design partner: Done — take a look\./);
  assert.doesNotMatch(full, /Project created/);

  // Approval timestamp cuts the post-approval turns (lexical ISO compare).
  const cut = designConversation(MESSAGES, { approvedAt: '2026-07-01T12:00:00Z' });
  assert.match(cut, /low-stock alert/);
  assert.doesNotMatch(cut, /Done — take a look/);

  // The char cap keeps the EARLIEST turns (they carry the intent).
  const capped = designConversation(MESSAGES, { maxChars: 70 });
  assert.match(capped, /^Builder: Build me an inventory tracker/);
  assert.doesNotMatch(capped, /low-stock/);
});

// ---- build + parse round-trip ----

test('buildDesignTemplate → parseDesignTemplate round-trips', () => {
  const doc = buildDesignTemplate({
    project: { name: 'Warehouse', description: 'stock app', design_approved_at: null },
    mockupHtml: HTML,
    designTokens: { colors: { primary: '#4f46e5' } },
    messages: MESSAGES,
    exportedAt: '2026-07-15T00:00:00Z',
  });
  assert.equal(doc.format, DESIGN_TEMPLATE_FORMAT);
  assert.equal(doc.version, DESIGN_TEMPLATE_VERSION);
  assert.equal(doc.project.name, 'Warehouse');
  assert.equal(doc.original_prompt, 'Build me an inventory tracker for a small warehouse.');
  assert.equal(doc.mockup_html, HTML);
  assert.deepEqual(doc.design_tokens, { colors: { primary: '#4f46e5' } });

  const parsed = parseDesignTemplate(doc);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.template.name, 'Warehouse');
  assert.equal(parsed.template.mockup_html, HTML);
  assert.equal(parsed.template.original_prompt, doc.original_prompt);
  assert.deepEqual(parsed.template.design_tokens, doc.design_tokens);
});

test('parseDesignTemplate: rejects non-templates', () => {
  assert.equal(parseDesignTemplate(null).ok, false);
  assert.equal(parseDesignTemplate([]).ok, false);
  assert.equal(parseDesignTemplate({ format: 'something-else', version: 1, mockup_html: HTML }).ok, false);
  assert.equal(parseDesignTemplate({ format: DESIGN_TEMPLATE_FORMAT, version: 99, mockup_html: HTML }).ok, false);
});

test('parseDesignTemplate: rejects a missing/implausible/oversized mockup', () => {
  const base = { format: DESIGN_TEMPLATE_FORMAT, version: 1 };
  assert.equal(parseDesignTemplate({ ...base }).ok, false);
  assert.equal(parseDesignTemplate({ ...base, mockup_html: 'just an apology, no HTML' }).ok, false);
  const huge = `<!doctype html><html><body>${'x'.repeat(MAX_TEMPLATE_HTML_CHARS)}</body></html>`;
  const r = parseDesignTemplate({ ...base, mockup_html: huge });
  assert.equal(r.ok, false);
  assert.match(r.error, /too large/);
});

test('parseDesignTemplate: non-object design_tokens become null, strings are bounded', () => {
  const r = parseDesignTemplate({
    format: DESIGN_TEMPLATE_FORMAT, version: 1, mockup_html: HTML,
    design_tokens: ['not', 'an', 'object'],
    original_prompt: 'p'.repeat(50000),
  });
  assert.equal(r.ok, true);
  assert.equal(r.template.design_tokens, null);
  assert.ok(r.template.original_prompt.length <= 8000);
});

// ---- import id + seed message ----

test('mockupIdForImport: path-safe and unique per timestamp', () => {
  const id = mockupIdForImport(1752537600000);
  assert.match(id, /^mk-import-[a-z0-9]+$/);
  assert.notEqual(mockupIdForImport(1), mockupIdForImport(2));
});

test('buildImportSeedMessage: brief + notes, brief only, nothing', () => {
  const both = buildImportSeedMessage({ originalPrompt: 'An inventory tracker.', notes: 'Make it French.', sourceName: 'Warehouse' });
  assert.match(both, /Imported design template — from "Warehouse"/);
  assert.match(both, /Original design brief[\s\S]*An inventory tracker\./);
  assert.match(both, /Changes\/context for this project:\nMake it French\./);

  const briefOnly = buildImportSeedMessage({ originalPrompt: 'An inventory tracker.' });
  assert.match(briefOnly, /Original design brief/);
  assert.doesNotMatch(briefOnly, /Changes\/context/);

  assert.equal(buildImportSeedMessage({}), '');
});

// ---- stored record + initial build instruction ----

test('designImportRecord ↔ parseDesignImport round-trips', () => {
  const record = designImportRecord({
    template: { name: 'Warehouse', original_prompt: 'An inventory tracker.' },
    notes: 'Dark theme.', source: 'project', sourceName: 'Warehouse',
    importedBy: 7, importedAt: '2026-07-15T00:00:00Z', mockupId: 'mk-import-abc',
  });
  assert.equal(record.source, 'project');
  assert.equal(record.original_prompt, 'An inventory tracker.');
  assert.equal(record.notes, 'Dark theme.');
  const back = parseDesignImport(JSON.stringify(record));
  assert.deepEqual(back, record);
  assert.equal(parseDesignImport(null), null);
  assert.equal(parseDesignImport('not json'), null);
});

test('buildInitialBuildInstruction: base verbatim without an import', () => {
  const base = 'Build the working application from the approved design inventory.';
  assert.equal(buildInitialBuildInstruction({ base }), base);
  assert.equal(buildInitialBuildInstruction({ base, designImport: null }), base);
  assert.equal(buildInitialBuildInstruction({ base, designImport: { original_prompt: '', notes: '' } }), base);
});

test('buildInitialBuildInstruction: quotes the imported brief and notes, bounded', () => {
  const base = 'Build the working application.';
  const out = buildInitialBuildInstruction({
    base,
    designImport: { original_prompt: 'An inventory tracker for a warehouse.', notes: 'Add barcode scanning.' },
  });
  assert.match(out, /^Build the working application\./);
  assert.match(out, /imported from a design template/);
  assert.match(out, /Original design brief[\s\S]*An inventory tracker for a warehouse\./);
  assert.match(out, /changes\/context for this build:\nAdd barcode scanning\./);

  // A runaway stored prompt cannot blow the instruction past the chat ceiling.
  const long = buildInitialBuildInstruction({
    base, designImport: { original_prompt: 'p'.repeat(100000), notes: 'n'.repeat(100000) },
  });
  assert.ok(long.length < 4000);
});
