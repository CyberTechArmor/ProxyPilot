// B.3 finish-time assumption screening — pure tiered lexical classifier.
// Written RED first: the current harness stores finish assumptions verbatim
// and nothing screens them (AUDIT.md A.1). Lexical screening is a safety net —
// B.4 is the primary source-level mechanism.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  screenDisclosureText, screeningVerdict, SCREENING_SCHEMA_VERSION,
} from '../mock2/screening-logic.js';

const fields = (obj) => Object.entries(obj).map(([source, text]) => ({ source, text }));

test('high-confidence disclosure: the verbatim ADP2 assumption is a blocking candidate', () => {
  const r = screenDisclosureText(fields({
    'finish.assumptions.assumed': 'the LDAPS/ADP connection tests are best-effort probes, and full ADP worker fetch is synthesized because no live ADP endpoint is reachable from the build container.',
  }));
  const v = screeningVerdict(r.findings);
  assert.equal(v.blocking, true);
  assert.ok(v.candidates.length >= 1);
  const c = v.candidates[0];
  assert.equal(c.tier, 'high');
  assert.equal(c.source, 'finish.assumptions.assumed');
  assert.ok(Array.isArray(c.span) && c.span.length === 2 && c.span[1] > c.span[0]);
  assert.ok(c.excerpt.length > 0);
  assert.ok(c.proposed_classification);
});

test('high-confidence phrases: canonical simulation-disclosure language', () => {
  for (const text of [
    'sync is synthesized because no live endpoint is reachable',
    'this is a best-effort probe of the directory',
    'a real fetch would replace this when credentials are present',
    'returns canned success until the upstream exists',
    'the backend response is currently faked',
    'connection test is simulated rather than performing I/O',
  ]) {
    const r = screenDisclosureText(fields({ 'finish.summary': text }));
    const v = screeningVerdict(r.findings);
    assert.equal(v.blocking, true, `expected blocking for: ${text}`);
    assert.ok(v.candidates.some((c) => c.tier === 'high'), `expected high tier for: ${text}`);
  }
});

test('ambiguous single terms: blocking candidate with span, excerpt, and proposed classification', () => {
  const r = screenDisclosureText(fields({
    'finish.summary': 'Added the employee list; loaded sample data for the demo screen.',
  }));
  const v = screeningVerdict(r.findings);
  assert.equal(v.blocking, true);
  const c = v.candidates.find((x) => x.tier === 'ambiguous');
  assert.ok(c, JSON.stringify(v.candidates));
  assert.match(c.term, /sample data/i);
  assert.ok(c.excerpt.includes('sample data'));
  assert.ok(c.proposed_classification);
});

test('negated/remediation statements are recorded, not blocking', () => {
  const r = screenDisclosureText(fields({
    'finish.summary': 'Removed sample data from the roster path; fixture isolation verified in the contract test.',
  }));
  const v = screeningVerdict(r.findings);
  assert.equal(v.blocking, false, JSON.stringify(v));
  assert.ok(v.recorded.length >= 1);
  assert.ok(v.recorded.every((f) => f.tier === 'negated'));
});

test('token-boundary awareness: substrings inside larger words do not match', () => {
  // "stubborn" contains "stub"; "resample datasets" is not "sample data".
  const r = screenDisclosureText(fields({
    'finish.summary': 'Fixed the stubborn cache bug; resample datasets nightly.',
  }));
  const v = screeningVerdict(r.findings);
  assert.equal(v.blocking, false, JSON.stringify(r.findings));
});

test('case-insensitive matching across all screened fields', () => {
  const r = screenDisclosureText(fields({
    'acceptance.task': 'BEST-EFFORT PROBE of the upstream directory',
  }));
  assert.ok(screeningVerdict(r.findings).blocking);
});

test('clean payloads produce no findings', () => {
  const r = screenDisclosureText(fields({
    'finish.summary': 'Added the low-stock alert screen with a Drizzle-backed threshold query.',
    'finish.assumptions.verified': 'src/routes/items.ts returns lowercase status slugs',
  }));
  assert.equal(r.findings.length, 0);
  assert.equal(screeningVerdict(r.findings).blocking, false);
});

test('findings are schema-versioned', () => {
  const r = screenDisclosureText(fields({ 'finish.summary': 'uses a stub for the mailer' }));
  assert.equal(SCREENING_SCHEMA_VERSION, 1);
  assert.ok(r.findings.every((f) => f.schema_version === 1));
});
