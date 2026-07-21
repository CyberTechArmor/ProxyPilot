// Targeted mockup tweaks — the escalation ladder's pure half: whitespace-
// tolerant edit matching, screen localization of failed edits, and the
// corrective-retry message. Native-free (concept-logic is pure).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  locateEditTarget,
  applyMockupEdits,
  screenForEditTargets,
  buildTweakRetryMessage,
  buildMockupEditSystemPrompt,
  buildConceptChatSystemPrompt,
} from '../mock2/concept-logic.js';

const DOC = `<!doctype html><html><head><style>
.card { color: var(--text-1); }
</style></head><body>
<section data-screen="Dashboard">
  <h1>Riverside Clinic</h1>
  <p>Queue length: 4</p>
</section>
<section data-screen="Settings">
  <h2>Preferences</h2>
  <p>Theme: light</p>
</section>
<script>let x = 1;</script>
</body></html>`;

test('locateEditTarget: exact match wins; ambiguity fails even when exact', () => {
  const loc = locateEditTarget(DOC, '<h1>Riverside Clinic</h1>');
  assert.ok(loc.ok);
  assert.equal(DOC.slice(loc.start, loc.end), '<h1>Riverside Clinic</h1>');
  const twice = 'a b a b';
  assert.deepEqual(locateEditTarget(twice, 'a b'), { ok: false, reason: 'ambiguous' });
  assert.deepEqual(locateEditTarget(DOC, 'nope-not-here'), { ok: false, reason: 'not found' });
});

test('locateEditTarget: whitespace-tolerant second chance, still unique-only', () => {
  // Retyped indentation: single spaces where the file has a newline + indent.
  const loc = locateEditTarget(DOC, '<h1>Riverside Clinic</h1> <p>Queue length: 4</p>');
  assert.ok(loc.ok, 'whitespace-normalized match should locate');
  assert.ok(DOC.slice(loc.start, loc.end).includes('Queue length'));
  // Fuzzy must not rescue an ambiguous target.
  const doc2 = '<p>x</p>\n<p>x</p>';
  assert.deepEqual(locateEditTarget(doc2, '<p>x</p>'), { ok: false, reason: 'ambiguous' });
});

test('applyMockupEdits: applies through whitespace drift; reports the failing block', () => {
  const applied = applyMockupEdits(DOC, [
    { search: '<h1>Riverside Clinic</h1>', replace: '<h1>Lakeside Clinic</h1>' },
    { search: '<h2>Preferences</h2> <p>Theme: light</p>', replace: '<h2>Preferences</h2>\n  <p>Theme: dark</p>' },
  ]);
  assert.ok(applied.ok);
  assert.ok(applied.html.includes('Lakeside Clinic'));
  assert.ok(applied.html.includes('Theme: dark'));
  const failed = applyMockupEdits(DOC, [
    { search: '<h1>Riverside Clinic</h1>', replace: 'x' },
    { search: 'absent text', replace: 'y' },
  ]);
  assert.equal(failed.ok, false);
  assert.match(failed.error, /edit 2: search text not found/);
});

test('screenForEditTargets: localizes to one screen, refuses cross-screen and shared CSS', () => {
  assert.equal(screenForEditTargets(DOC, [
    { search: '<h1>Riverside Clinic</h1>' },
    { search: '<p>Queue length: 4</p>' },
  ]), 'Dashboard');
  // Whitespace-drifted target still localizes.
  assert.equal(screenForEditTargets(DOC, [
    { search: '<h2>Preferences</h2> <p>Theme: light</p>' },
  ]), 'Settings');
  // Targets across two screens → not screen-local.
  assert.equal(screenForEditTargets(DOC, [
    { search: '<h1>Riverside Clinic</h1>' },
    { search: '<h2>Preferences</h2>' },
  ]), null);
  // Shared <style> edit lives outside every section → not screen-local.
  assert.equal(screenForEditTargets(DOC, [{ search: '.card { color: var(--text-1); }' }]), null);
  // Unlocatable target → null, and no sections → null.
  assert.equal(screenForEditTargets(DOC, [{ search: 'ghost' }]), null);
  assert.equal(screenForEditTargets('<html><body><p>a</p></body></html>', [{ search: '<p>a</p>' }]), null);
});

test('buildTweakRetryMessage names the failure and demands the complete set', () => {
  const msg = buildTweakRetryMessage('edit 2: search text not found');
  assert.ok(msg.includes('edit 2: search text not found'));
  assert.ok(/COMPLETE/.test(msg));
  assert.ok(/character-for-character/.test(msg));
});

test('prompts bias against needless full renders', () => {
  const edit = buildMockupEditSystemPrompt();
  assert.ok(/FULL_RERENDER is a LAST resort/.test(edit));
  assert.ok(/several small blocks/.test(edit));
  const chat = buildConceptChatSystemPrompt({ designSystem: 'ds', projectName: 'p', hasMockup: true, mode: 'design' });
  assert.ok(/BIAS SMALL/.test(chat));
  assert.ok(/pick\s+"tweak"/.test(chat));
});
