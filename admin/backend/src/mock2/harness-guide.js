// Harness guide — the operator-facing document that explains every step of
// the Mock2 pipeline (models, prompts, effort, classifiers, gates) from
// Concept through Build and post-build passes.
//
// The SHIPPED text lives next to this module (harness-guide.md) and updates
// with the code; an operator can edit the document on the Harness guide page,
// which stores the edited copy in mock2_settings and leaves the shipped file
// untouched. Clearing the edit falls straight back to the shipped text, so an
// upgrade always carries the current pipeline description unless the operator
// has deliberately taken over the document.
//
// Terminology (risk R7): nothing here is named "agent". This module is about
// the guide DOCUMENT only — the per-project engine choice lives in harness.js.

import { readFileSync } from 'node:fs';
import { getMock2Db } from './db.js';
import { setMock2Setting } from './settings.js';

export const HARNESS_GUIDE_KEY = 'harness_guide_md';

// The document can hold every prompt excerpt in the pipeline and still sit far
// below this; the cap only exists so a bad client cannot grow the settings row
// without bound.
export const HARNESS_GUIDE_MAX_LENGTH = 400_000;

let shippedCache = null;

export function getShippedHarnessGuide() {
  if (shippedCache == null) {
    shippedCache = readFileSync(new URL('./harness-guide.md', import.meta.url), 'utf8');
  }
  return shippedCache;
}

// The guide as the page shows it: the operator's stored edit when one exists,
// otherwise the shipped text. updated_at/updated_by only exist for an edit.
export function getHarnessGuide() {
  const row = getMock2Db()
    .prepare(`SELECT value, updated_at, updated_by FROM mock2_settings WHERE key = ?`)
    .get(HARNESS_GUIDE_KEY);
  if (row && String(row.value || '').trim() !== '') {
    return { content: row.value, edited: true, updated_at: row.updated_at || null };
  }
  return { content: getShippedHarnessGuide(), edited: false, updated_at: null };
}

// Store an operator edit; an empty/whitespace content clears the edit and the
// page falls back to the shipped document.
export function setHarnessGuide(content, updatedBy = null) {
  const text = String(content ?? '');
  if (text.trim() === '') {
    getMock2Db().prepare(`DELETE FROM mock2_settings WHERE key = ?`).run(HARNESS_GUIDE_KEY);
  } else {
    setMock2Setting(HARNESS_GUIDE_KEY, text, updatedBy);
  }
  return getHarnessGuide();
}
