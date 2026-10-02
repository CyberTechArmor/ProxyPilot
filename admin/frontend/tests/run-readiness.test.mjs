import test from 'node:test';
import assert from 'node:assert/strict';
import { matchesPinnedGuide, operationSectionUrl, readinessNextStep }
  from '../src/components/operational-projects/run-readiness.js';

test('pilot scope refusal gives an actual site route without implying research is runnable', () => {
  const next = readinessNextStep('Only https://demo.fractionate.ai is supported in this pilot.');
  assert.equal(next.section, 'Access');
  assert.match(next.text, /research task on another site cannot run/);
  assert.equal(operationSectionUrl('project/one', next.section), '/operational-projects/project%2Fone?section=Access');
});

test('missing guide directs saving and assignment; credential binding remains operator managed', () => {
  const guide = readinessNextStep('No guide is assigned.');
  assert.equal(guide.section, 'Guide');
  assert.match(guide.text, /assign its current version in Agents/);
  const binding = readinessNextStep('No active credential binding: the host operator binds the synthetic account first.');
  assert.match(binding.text, /host operator/);
  assert.equal(binding.section, undefined, 'there is no synthetic browser binding enrollment route');
  assert.equal(readinessNextStep('A run is already active for this profile.'), null, 'the actual active-run control handles this reason');
  assert.equal(readinessNextStep('A new backend refusal.'), null, 'unrecognized refusal must stay visible without invented advice');
});

test('a historical guide is accepted only with the exact run version and content hash', () => {
  const run = { guide_version_id: 'historical-v1', guide_hash: 'hash-v1' };
  assert.equal(matchesPinnedGuide({ id: 'historical-v1', content_hash: 'hash-v1', withdrawn_at: '2026-10-02' }, run), true,
    'a withdrawn historical version can still explain the immutable run');
  assert.equal(matchesPinnedGuide({ id: 'current-v2', content_hash: 'hash-v2' }, run), false);
  assert.equal(matchesPinnedGuide({ id: 'historical-v1', content_hash: 'changed-hash' }, run), false);
  assert.equal(matchesPinnedGuide(null, run), false);
});
