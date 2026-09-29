import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as text from '../../../frontend/src/components/operational-projects/agent-run-text.js';

// A7 lesson: adding `review: 'Review'` to DECK_TEXT silently replaced the
// approval button's `review: 'Review and approve'` (a later key wins in an
// object literal), and only a browser journey noticed. Every exported words
// object is checked for a key written twice.
const SOURCE = fileURLToPath(new URL('../../../frontend/src/components/operational-projects/agent-run-text.js', import.meta.url));

export function duplicateKeys(source) {
  const found = {};
  for (const match of source.matchAll(/export const ([A-Z_]+) = \{\n([\s\S]*?)\n\};/g)) {
    const keys = [...match[2].matchAll(/^ {2}'?([A-Za-z0-9_:]+)'?\s*:/gm)].map(m => m[1]);
    const twice = [...new Set(keys.filter((key, i) => keys.indexOf(key) !== i))];
    if (twice.length) found[match[1]] = twice;
  }
  return found;
}

test('the checker finds a key written twice', () => {
  assert.deepEqual(duplicateKeys("export const DECK_TEXT = {\n  review: 'a',\n  pins: 'b',\n  review: 'c',\n};"), { DECK_TEXT: ['review'] });
  assert.deepEqual(duplicateKeys("export const X = {\n  a: 1,\n  b: { a: 2 },\n};"), {});
});

test('no words object in agent-run-text.js has a key written twice', () => {
  const source = readFileSync(SOURCE, 'utf8');
  assert.ok((source.match(/export const [A-Z_]+ = \{/g) ?? []).length >= 10, 'the words objects were found');
  assert.deepEqual(duplicateKeys(source), {});
  // The two that collided keep their own words.
  assert.equal(text.DECK_TEXT.review, 'Review and approve');
  assert.equal(text.DECK_TEXT.reviewTab, 'Review');
});
