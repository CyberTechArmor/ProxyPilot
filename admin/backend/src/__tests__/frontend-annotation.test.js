// The pin instruction — a pin LOCATES, it does not fence.
//
// Project 44, pin 1: the operator tapped the Saved/Delete row and wrote "look
// at ALL elements above the text field, there is so much unused space". The pin
// resolved to `div.title-row`; the instruction ended "Apply exactly these
// changes at the marked spots; change nothing else"; the build tightened three
// margins on that one row while the thing the operator was actually looking at
// — a nav bar wrapping onto two lines above it — sat outside the fence. They
// had to ask again, in words, in a second build.
//
// Read from the backend suite because that is where this repo's checks run
// (precedent: frontend-api-client.test.js).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const front = (rel) => readFileSync(path.join(here, '..', '..', '..', 'frontend', 'src', rel), 'utf8');

test('a pin is where the finger landed, not the boundary of the change', async () => {
  const { ANNOTATION_CLOSING } = await import(
    `file://${path.join(here, '..', '..', '..', 'frontend', 'src', 'lib', 'annotation.js')}`
  );
  // The sentence that caused the half-fix must be gone.
  assert.doesNotMatch(ANNOTATION_CLOSING, /change nothing else/i);
  assert.doesNotMatch(ANNOTATION_CLOSING, /Apply exactly these changes at the marked spots/i);

  // The note outranks the selector — that is the whole correction.
  assert.match(ANNOTATION_CLOSING, /WHERE THE OPERATOR WAS POINTING/);
  assert.match(ANNOTATION_CLOSING, /the NOTE wins/);

  // A layout complaint is about the REGION, and the failure mode is named so a
  // build cannot satisfy it by tightening the one node it was handed.
  assert.match(ANNOTATION_CLOSING.replace(/\s+/g, ' '), /SPACE, LAYOUT, DENSITY, ALIGNMENT or ORDER/);
  assert.match(ANNOTATION_CLOSING.replace(/\s+/g, ' '), /siblings, its container, and the things stacked above and below/);
  assert.match(ANNOTATION_CLOSING, /the appearance of one/);

  // The exact case that made the operator ask twice: the header is shell, and a
  // build that reads "never restyle the shell" refuses to fix a wrapping nav.
  // Whitespace-normalised: the constant is hand-wrapped, and a test that
  // depends on where a line breaks is testing the wrapping.
  const flat = ANNOTATION_CLOSING.replace(/\s+/g, ' ');
  assert.match(flat, /MAY override spacing on shell elements/);
  assert.match(flat, /Never edit the platform-owned files themselves/);

  // Scope still exists — it is just scoped to problems, not to DOM nodes.
  const flat2 = ANNOTATION_CLOSING.replace(/\s+/g, ' ');
  assert.match(flat2, /Do not add features/);
  assert.match(flat2, /screens no pin mentions/);
  assert.match(flat2, /not the individual DOM nodes/);
});

test('both pin composers use the SAME closing — one typed it twice before', () => {
  // The live preview and the screenshot annotator each had their own copy of
  // the fencing sentence. Fixing one would have left the other shipping the
  // half-fix, and nothing would have said so.
  for (const f of ['components/mock2/ProjectPreview.jsx', 'components/mock2/AnnotateApp.jsx']) {
    const src = front(f);
    assert.match(src, /import \{ ANNOTATION_CLOSING \} from '@\/lib\/annotation'/, `${f} must import the shared closing`);
    assert.match(src, /\$\{ANNOTATION_CLOSING\}/, `${f} must USE it`);
    assert.doesNotMatch(src, /change nothing else/i, `${f} must not keep its own copy`);
    // The header line changed too: "the exact spots" is the same claim in
    // miniature, and it is the one the operator reads first.
    assert.doesNotMatch(src, /pins mark the exact spots/i, `${f} still calls a pin an exact spot`);
    assert.match(src, /pins mark where the operator was pointing/, `${f} must say what a pin is`);
  }
});
