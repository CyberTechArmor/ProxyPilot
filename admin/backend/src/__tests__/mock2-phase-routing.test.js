// Per-phase model routing (phase-routing@1) — the pure decision layer.
//
// Stub-first (risk R9): imports ONLY phase-routing-logic.js (native-free).
// Covers the acceptance criteria that are decidable without a live cycle:
//   #1–3  the three provider scenarios + the neither-configured failure
//   #5    the touches carve-out (asserted per listed value)
//   #6    a change record whose ledger did not come from phase 3 fails close-out
//   #7/CB the Tier-2 dispatch requires the full diff and carries the file:line line
//   #8    gating: no marker / toggle off → the single-model path

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PROJECT_PROVIDER_PREFS,
  normalizeProviderPreference,
  applyProviderPreference,
  PHASE_POSTURES,
  PHASE_POSTURE_FLAG,
  normalizePhasePosture,
  phasePosture,
  applyPhasePosture,
  PHASE_ROUTING_MARKER,
  PHASE_ROUTING_FLAG,
  phaseRoutingMode,
  frameworkSupportsPhaseRouting,
  phaseRoutingApplies,
  BUILD_PHASES,
  PHASE_TIER,
  JUDGEMENT_PHASES,
  PRO_TIER_MODELS,
  NO_PROVIDER_ERROR,
  detectPhaseProviders,
  resolvePhaseModelMap,
  IMPLEMENT_TOUCHES,
  normalizeTouches,
  implementLaneForTask,
  MECHANICAL_TIER1_FAILURE_LIMIT,
  mechanicalEscalation,
  reconBriefPath,
  LEDGER_SOURCE_IMPLEMENT,
  LEDGER_MD_MARKER,
  LEDGER_TEMPLATE_SECTION,
  parseAssumptionLedger,
  closeOutLedgerVerdict,
  REVIEW_DIFF_INSTRUCTION,
  buildReviewDispatchInputs,
  phaseMapRecordLine,
} from '../mock2/phase-routing-logic.js';

// ---- the toggle (default ON) and the framework-version gate ----

test('phaseRoutingMode defaults ON; only an explicit off/0/false disables', () => {
  assert.equal(phaseRoutingMode({}), 'on');
  assert.equal(phaseRoutingMode({ [PHASE_ROUTING_FLAG]: '' }), 'on');
  assert.equal(phaseRoutingMode({ [PHASE_ROUTING_FLAG]: 'on' }), 'on');
  assert.equal(phaseRoutingMode({ [PHASE_ROUTING_FLAG]: 'junk' }), 'on');
  assert.equal(phaseRoutingMode({ [PHASE_ROUTING_FLAG]: 'off' }), 'off');
  assert.equal(phaseRoutingMode({ [PHASE_ROUTING_FLAG]: '0' }), 'off');
  assert.equal(phaseRoutingMode({ [PHASE_ROUTING_FLAG]: 'false' }), 'off');
});

const MARKED_SKILLS = JSON.stringify([{ name: 'build', body: `stuff ${PHASE_ROUTING_MARKER} stuff` }]);
const UNMARKED_SKILLS = JSON.stringify([{ name: 'build', body: 'the old single-model build skill' }]);

test('frameworkSupportsPhaseRouting: only a bundle carrying the marker (acceptance #8)', () => {
  assert.equal(frameworkSupportsPhaseRouting(MARKED_SKILLS), true);
  assert.equal(frameworkSupportsPhaseRouting(JSON.parse(MARKED_SKILLS)), true);
  assert.equal(frameworkSupportsPhaseRouting(UNMARKED_SKILLS), false);
  assert.equal(frameworkSupportsPhaseRouting(null), false);
  assert.equal(frameworkSupportsPhaseRouting('not json but has phase-routing@1'), true);
});

test('the shipped framework seed carries the marker in the build skill', async () => {
  const { readFile } = await import('node:fs/promises');
  const seed = await readFile(new URL('../mock2/framework-seed/skills.json', import.meta.url), 'utf8');
  assert.equal(frameworkSupportsPhaseRouting(seed), true);
  // Correction B rides the seed's review skill verbatim.
  const skills = JSON.parse(seed);
  const review = skills.find((s) => s.name === 'review');
  assert.ok(review.body.includes(REVIEW_DIFF_INSTRUCTION));
});

test('phaseRoutingApplies: the toggle governs every build — framework marker no longer gates', () => {
  assert.equal(phaseRoutingApplies({ skillsJson: MARKED_SKILLS, env: {} }), true);
  assert.equal(phaseRoutingApplies({ skillsJson: MARKED_SKILLS, env: { [PHASE_ROUTING_FLAG]: 'off' } }), false);
  // Pre-marker framework versions phase-route too ("use the 5 phase for everything").
  assert.equal(phaseRoutingApplies({ skillsJson: UNMARKED_SKILLS, env: {} }), true);
  assert.equal(phaseRoutingApplies({}), true);
  assert.equal(phaseRoutingApplies({ env: { [PHASE_ROUTING_FLAG]: 'off' } }), false);
});

// ---- provider detection (reuses the connector rows — one credential store) ----

test('detectPhaseProviders: enabled + usable key, routable providers only', () => {
  assert.deepEqual(detectPhaseProviders([
    { provider: 'anthropic', enabled: true, keyUsable: true },
    { provider: 'openai', enabled: true, keyUsable: true },
    { provider: 'gemini', enabled: true, keyUsable: true },   // not routable
    { provider: 'ollama', enabled: true, keyUsable: true },   // not routable
  ]), ['anthropic', 'openai']);
  // Disabled or undecryptable connectors do NOT count as configured.
  assert.deepEqual(detectPhaseProviders([
    { provider: 'anthropic', enabled: false, keyUsable: true },
    { provider: 'openai', enabled: true, keyUsable: false },
  ]), []);
  assert.deepEqual(detectPhaseProviders([]), []);
});

// ---- the model map (acceptance #1–3) ----

test('both providers → the mixed map (cheap/mid on OpenAI, top on Anthropic)', () => {
  const r = resolvePhaseModelMap({ providers: ['anthropic', 'openai'] });
  assert.equal(r.ok, true);
  assert.equal(r.scenario, 'both');
  assert.equal(r.map.recon.model, 'gpt-5.6-luna');
  assert.equal(r.map.plan.model, 'claude-opus-5');
  assert.equal(r.map.implement_mechanical.model, 'gpt-5.6-luna');
  assert.equal(r.map.implement_complex.model, 'gpt-5.6-terra');
  assert.equal(r.map.summarize.model, 'gpt-5.6-luna');
  assert.equal(r.map.review.model, 'claude-opus-5');
});

test('Anthropic only → the Anthropic single-vendor column, same pipeline shape', () => {
  const r = resolvePhaseModelMap({ providers: ['anthropic'] });
  assert.equal(r.ok, true);
  assert.equal(r.scenario, 'anthropic');
  assert.equal(r.map.recon.model, 'claude-haiku-4-5');
  assert.equal(r.map.plan.model, 'claude-opus-5');
  assert.equal(r.map.implement_mechanical.model, 'claude-haiku-4-5');
  assert.equal(r.map.implement_complex.model, 'claude-sonnet-5');
  assert.equal(r.map.summarize.model, 'claude-haiku-4-5');
  assert.equal(r.map.review.model, 'claude-opus-5');
  // Identical phase set in every scenario — only the ids change.
  assert.deepEqual(Object.keys(r.map), [...BUILD_PHASES]);
});

test('OpenAI only → the OpenAI single-vendor column (top tier on sol)', () => {
  const r = resolvePhaseModelMap({ providers: ['openai'] });
  assert.equal(r.ok, true);
  assert.equal(r.scenario, 'openai');
  assert.equal(r.map.recon.model, 'gpt-5.6-luna');
  assert.equal(r.map.plan.model, 'gpt-5.6-sol');
  assert.equal(r.map.implement_complex.model, 'gpt-5.6-terra');
  assert.equal(r.map.review.model, 'gpt-5.6-sol');
});

test('neither provider → an operator-readable failure, never a hardcoded fallback (acceptance #3)', () => {
  const r = resolvePhaseModelMap({ providers: [] });
  assert.equal(r.ok, false);
  assert.equal(r.error, NO_PROVIDER_ERROR);
  assert.match(r.error, /neither is configured/i);
  assert.match(r.error, /no state was written/i);
  assert.equal(resolvePhaseModelMap({ providers: ['gemini'] }).ok, false);
});

test('no phase routes to a pro/frontier tier by default; plan-only opt-in override', () => {
  for (const providers of [['anthropic'], ['openai'], ['anthropic', 'openai']]) {
    const r = resolvePhaseModelMap({ providers });
    for (const phase of BUILD_PHASES) {
      assert.ok(
        !Object.values(PRO_TIER_MODELS).includes(r.map[phase].model),
        `${providers}/${phase} must not default to a pro tier (got ${r.map[phase].model})`,
      );
    }
  }
  // The opt-in touches the plan phase ONLY.
  const r = resolvePhaseModelMap({ providers: ['openai'], planModelOverride: PRO_TIER_MODELS.openai });
  assert.equal(r.map.plan.model, 'gpt-5.5-pro');
  assert.equal(r.map.plan.tier, 'override');
  for (const phase of BUILD_PHASES.filter((p) => p !== 'plan')) {
    assert.notEqual(r.map[phase].model, 'gpt-5.5-pro');
  }
});

// ---- the 3a/3b router and the touches carve-out (acceptance #5) ----

test('every listed touches value forces the 3b lane, even when sized mechanical', () => {
  assert.deepEqual(IMPLEMENT_TOUCHES, ['auth', 'rbac', 'crypto', 'migration', 'external-integration', 'money']);
  for (const touch of IMPLEMENT_TOUCHES) {
    const d = implementLaneForTask({ complexity: 'mechanical', touches: [touch] });
    assert.equal(d.lane, 'implement_complex', `touches:[${touch}] must never dispatch to 3a`);
    assert.match(d.reason, new RegExp(`touches:.*${touch}`));
  }
});

test('touches [none] / empty routes by complexity; unknowns route to the safe side', () => {
  assert.equal(implementLaneForTask({ complexity: 'mechanical', touches: ['none'] }).lane, 'implement_mechanical');
  assert.equal(implementLaneForTask({ complexity: 'mechanical', touches: [] }).lane, 'implement_mechanical');
  assert.equal(implementLaneForTask({ complexity: 'complex', touches: [] }).lane, 'implement_complex');
  // Unclassified → complex (safe default); an unknown non-empty surface still blocks 3a.
  assert.equal(implementLaneForTask({}).lane, 'implement_complex');
  assert.equal(implementLaneForTask({ complexity: 'mechanical', touches: ['pii'] }).lane, 'implement_complex');
  assert.deepEqual(normalizeTouches(['none', 'AUTH', 'auth', '', null]), ['auth']);
});

test('a mechanical task escalates to 3b after two Tier-1 failures — never a third cheap attempt', () => {
  assert.equal(MECHANICAL_TIER1_FAILURE_LIMIT, 2);
  assert.equal(mechanicalEscalation({ lane: 'implement_mechanical', tier1Failures: 1 }).escalate, false);
  const esc = mechanicalEscalation({ lane: 'implement_mechanical', tier1Failures: 2 });
  assert.equal(esc.escalate, true);
  assert.equal(esc.lane, 'implement_complex');
  assert.match(esc.record, /escalated/i);
  // 3b tasks have nowhere to escalate through this path.
  assert.equal(mechanicalEscalation({ lane: 'implement_complex', tier1Failures: 5 }).escalate, false);
});

// ---- recon briefs (phase 1, acceptance #4's path contract) ----

test('reconBriefPath: state/recon/NNN-<subsystem>.md, slug-safe', () => {
  assert.equal(reconBriefPath(7, 'src/auth'), 'state/recon/007-src-auth.md');
  assert.equal(reconBriefPath(123, 'apps/<frontend>'), 'state/recon/123-apps-frontend.md');
  assert.equal(reconBriefPath(0, ''), 'state/recon/000-subsystem.md');
});

// ---- Correction A: the assumption ledger (acceptance #6, both record formats) ----

test('JSON record: a phase-3 ledger passes close-out; a summarizer-authored one fails', () => {
  const good = {
    assumption_ledger: {
      source: LEDGER_SOURCE_IMPLEMENT,
      verified: [{ claim: 'roles are lowercase slugs', file: 'src/routes/profile.ts' }],
      assumed: [{ claim: 'the API paginates at 100', why: 'no live call available this cycle' }],
    },
  };
  assert.equal(closeOutLedgerVerdict({ record: good, phaseRoutingApplied: true }).ok, true);

  const summarized = { assumption_ledger: { source: 'summarize', verified: [], assumed: [] } };
  const v = closeOutLedgerVerdict({ record: summarized, phaseRoutingApplied: true });
  assert.equal(v.ok, false);
  assert.match(v.error, /implement/);

  const missing = closeOutLedgerVerdict({ record: { summary: 'no ledger here' }, phaseRoutingApplied: true });
  assert.equal(missing.ok, false);
  assert.match(missing.error, /invented/i);
});

test('markdown record: the template section parses as a phase-3 ledger; unmarked md fails', () => {
  const md = `# Change record 042\n\n## What changed\nstuff\n\n${LEDGER_TEMPLATE_SECTION}`;
  const parsed = parseAssumptionLedger(md);
  assert.equal(parsed.present, true);
  assert.equal(parsed.source, LEDGER_SOURCE_IMPLEMENT);
  assert.equal(closeOutLedgerVerdict({ record: md, phaseRoutingApplied: true }).ok, true);
  assert.ok(LEDGER_TEMPLATE_SECTION.includes(LEDGER_MD_MARKER));

  // Sections present but no provenance marker → not attributable to phase 3 → fail.
  const unmarked = '## Assumptions verified\n- x\n\n## Assumptions assumed\n- y\n';
  assert.equal(closeOutLedgerVerdict({ record: unmarked, phaseRoutingApplied: true }).ok, false);
});

test('legacy records pass close-out untouched when phase routing did not govern the cycle', () => {
  assert.equal(closeOutLedgerVerdict({ record: { summary: 'old-style record' }, phaseRoutingApplied: false }).ok, true);
  assert.equal(closeOutLedgerVerdict({ record: 'old md record', phaseRoutingApplied: false }).ok, true);
});

// ---- Correction B: the reviewer reads the diff (acceptance #7 ground rules) ----

test('Tier-2 dispatch refuses to run from the summary alone; the diff is ground truth', () => {
  const noDiff = buildReviewDispatchInputs({ changeRecord: 'a lovely summary', diff: '' });
  assert.equal(noDiff.ok, false);
  assert.match(noDiff.error, /full diff/);

  const ok = buildReviewDispatchInputs({
    changeRecord: 'record body', diff: 'diff --git a/x b/x\n+1', rules: 'R01: …', workFile: 'tasks…',
  });
  assert.equal(ok.ok, true);
  assert.ok(ok.prompt.includes(REVIEW_DIFF_INSTRUCTION));
  assert.ok(ok.prompt.includes('diff --git'));
  assert.ok(ok.prompt.indexOf('orientation aid') < ok.prompt.indexOf('# The diff (ground truth)'));
  assert.match(REVIEW_DIFF_INSTRUCTION, /file:line/);
});

// ---- the change-record echo (reproducibility) ----

test('phaseMapRecordLine renders the stamped map; null when the cycle was not phase-routed', () => {
  const resolved = resolvePhaseModelMap({ providers: ['anthropic'] });
  const stamped = { phase_scenario: resolved.scenario, phase_map: resolved.map };
  const line = phaseMapRecordLine(stamped);
  assert.match(line, /^Phase model map \[anthropic\]: /);
  assert.ok(line.includes('recon=claude-haiku-4-5'));
  assert.ok(line.includes('review=claude-opus-5'));
  assert.equal(phaseMapRecordLine({ task_kind: 'feature' }), null);
  assert.equal(phaseMapRecordLine(null), null);
});

test('every phase has a tier and every tier is one of cheap/mid/top', () => {
  for (const phase of BUILD_PHASES) {
    assert.ok(['cheap', 'mid', 'top'].includes(PHASE_TIER[phase]), `${phase} tier`);
  }
});

// ---- per-project provider preference (multiple global providers) ----

test('multiple global providers: unset defaults to HYBRID (the global settings)', () => {
  const both = ['anthropic', 'openai'];
  // No preference set → follow the global configuration: all providers → the
  // mixed map. No per-project choice is required.
  const unset = applyProviderPreference({ providers: both, preference: null });
  assert.deepEqual(unset, { ok: true, providers: both });
  assert.equal(resolvePhaseModelMap({ providers: unset.providers }).scenario, 'both');
  // An explicit single-provider choice narrows the map to that vendor's column.
  const anth = applyProviderPreference({ providers: both, preference: 'anthropic' });
  assert.deepEqual(anth, { ok: true, providers: ['anthropic'] });
  assert.equal(resolvePhaseModelMap({ providers: anth.providers }).scenario, 'anthropic');
  const oai = applyProviderPreference({ providers: both, preference: 'openai' });
  assert.deepEqual(oai, { ok: true, providers: ['openai'] });
  // 'hybrid' (both providers selected) is the explicit spelling of the default.
  const hyb = applyProviderPreference({ providers: both, preference: 'hybrid' });
  assert.deepEqual(hyb.providers, both);
  assert.equal(resolvePhaseModelMap({ providers: hyb.providers }).scenario, 'both');
});

test('single global provider: nothing to choose — unset/hybrid never block', () => {
  // One provider, no preference → no choice required.
  assert.deepEqual(applyProviderPreference({ providers: ['anthropic'], preference: null }),
    { ok: true, providers: ['anthropic'] });
  // 'hybrid' with one provider is just that provider.
  assert.deepEqual(applyProviderPreference({ providers: ['openai'], preference: 'hybrid' }),
    { ok: true, providers: ['openai'] });
  // Zero providers passes through so resolvePhaseModelMap raises ITS refusal.
  assert.deepEqual(applyProviderPreference({ providers: [], preference: 'hybrid' }),
    { ok: true, providers: [] });
});

test('a chosen provider whose credential broke fails loudly — never silently flips', () => {
  // The project chose OpenAI; the OpenAI key later broke while Anthropic still
  // works. The choice binds: refuse and name the broken provider, don't run
  // the build on a provider the project didn't pick.
  const r = applyProviderPreference({ providers: ['anthropic'], preference: 'openai' });
  assert.equal(r.ok, false);
  assert.match(r.error, /openai/);
  assert.match(r.error, /credential/);
  // A junk/unroutable stored value behaves as unset → the global default.
  const r2 = applyProviderPreference({ providers: ['anthropic', 'openai'], preference: 'gemini' });
  assert.deepEqual(r2, { ok: true, providers: ['anthropic', 'openai'] });
  assert.deepEqual(PROJECT_PROVIDER_PREFS, ['anthropic', 'openai', 'hybrid']);
  assert.equal(normalizeProviderPreference('HYBRID'), 'hybrid');
  assert.equal(normalizeProviderPreference('gemini'), null);
});

// ---- cost postures (the five selectable presets) ----

test('the five postures exist; junk normalizes to default; env reader works', () => {
  assert.deepEqual(PHASE_POSTURES, ['default', 'suggested', 'ultra_cheap', 'balanced', 'max_quality']);
  assert.equal(normalizePhasePosture('ULTRA_CHEAP'), 'ultra_cheap');
  assert.equal(normalizePhasePosture('cheapest'), 'default');
  assert.equal(normalizePhasePosture(null), 'default');
  assert.equal(phasePosture({}), 'default');
  assert.equal(phasePosture({ [PHASE_POSTURE_FLAG]: 'balanced' }), 'balanced');
});

test('posture default: the manually set configuration passes through untouched', () => {
  const resolved = resolvePhaseModelMap({ providers: ['anthropic', 'openai'], planModelOverride: 'claude-fable-5' });
  const out = applyPhasePosture(resolved, 'default');
  assert.equal(out.posture, 'default');
  assert.deepEqual(out.map, resolved.map);
  assert.equal(out.map.plan.model, 'claude-fable-5'); // the manual override survives
});

test('posture suggested: the recommended tier map everywhere (manual overrides dropped)', () => {
  const resolved = resolvePhaseModelMap({ providers: ['anthropic', 'openai'], planModelOverride: 'gpt-5.5-pro' });
  const out = applyPhasePosture(resolved, 'suggested');
  assert.equal(out.posture, 'suggested');
  assert.equal(out.map.plan.model, 'claude-opus-5'); // back to the suggestion
  assert.equal(out.map.recon.model, 'gpt-5.6-luna');
  assert.equal(out.map.implement_complex.model, 'gpt-5.6-terra');
});

test('posture ultra_cheap: the lowest-cost available model for everything EXCEPT plan/review', () => {
  // Judgement phases (plan, review) are exempt from every downgrade posture —
  // see JUDGEMENT_PHASES / applyPhasePosture. They resolve to the SUGGESTED
  // top tier instead, same as under 'default'/'suggested'.
  const expect = { both: 'gpt-5.6-luna', openai: 'gpt-5.6-luna', anthropic: 'claude-haiku-4-5' };
  const expectTop = { both: 'claude-opus-5', openai: 'gpt-5.6-sol', anthropic: 'claude-opus-5' };
  for (const [scenario, providers] of [['both', ['anthropic', 'openai']], ['openai', ['openai']], ['anthropic', ['anthropic']]]) {
    const out = applyPhasePosture(resolvePhaseModelMap({ providers }), 'ultra_cheap');
    assert.equal(out.posture, 'ultra_cheap');
    for (const phase of BUILD_PHASES) {
      if (JUDGEMENT_PHASES.includes(phase)) {
        assert.equal(out.map[phase].model, expectTop[scenario], `${scenario}/${phase}`);
        assert.equal(out.map[phase].tier, 'top', `${scenario}/${phase} tier`);
      } else {
        assert.equal(out.map[phase].model, expect[scenario], `${scenario}/${phase}`);
      }
    }
  }
});

test('posture balanced: Terra / Sonnet level for everything EXCEPT plan/review', () => {
  const expect = { both: 'gpt-5.6-terra', openai: 'gpt-5.6-terra', anthropic: 'claude-sonnet-5' };
  const expectTop = { both: 'claude-opus-5', openai: 'gpt-5.6-sol', anthropic: 'claude-opus-5' };
  for (const [scenario, providers] of [['both', ['anthropic', 'openai']], ['openai', ['openai']], ['anthropic', ['anthropic']]]) {
    const out = applyPhasePosture(resolvePhaseModelMap({ providers }), 'balanced');
    for (const phase of BUILD_PHASES) {
      if (JUDGEMENT_PHASES.includes(phase)) {
        assert.equal(out.map[phase].model, expectTop[scenario], `${scenario}/${phase}`);
        assert.equal(out.map[phase].tier, 'top', `${scenario}/${phase} tier`);
      } else {
        assert.equal(out.map[phase].model, expect[scenario], `${scenario}/${phase}`);
      }
    }
  }
});

test('JUDGEMENT_PHASES is a subset of BUILD_PHASES and matches the top-tier phases (acceptance: 808/721)', () => {
  for (const phase of JUDGEMENT_PHASES) {
    assert.ok(BUILD_PHASES.includes(phase), `${phase} must be a real build phase`);
    assert.equal(PHASE_TIER[phase], 'top', `${phase} must be a top-tier phase`);
  }
  // And nothing top-tier is missing from the exemption — a future phase added
  // at tier 'top' should be reviewed for inclusion here, not silently downgraded.
  const topTierPhases = BUILD_PHASES.filter((p) => PHASE_TIER[p] === 'top');
  assert.deepEqual([...JUDGEMENT_PHASES].sort(), topTierPhases.sort());
});

test('the halt-report regression fixture: ultra_cheap review is never on the cheap tier', () => {
  // 808 cycle 721 is the fleet's only ultra_cheap run and its only failed
  // build; its review phase ran on the cheap tier. This assertion fails
  // against the pre-fix behavior (review.model === 'gpt-5.6-luna').
  const out = applyPhasePosture(resolvePhaseModelMap({ providers: ['anthropic', 'openai'] }), 'ultra_cheap');
  assert.notEqual(out.map.review.model, 'gpt-5.6-luna');
  assert.notEqual(out.map.plan.model, 'gpt-5.6-luna');
});

test('the record line reports the TRUE model for an exempted phase, not the posture label', () => {
  // phaseMapRecordLine renders map[phase].model straight through — since the
  // exempted entries keep their real (top) tier rather than being relabeled
  // 'ultra_cheap', the change record stays honest about what actually ran.
  const out = applyPhasePosture(resolvePhaseModelMap({ providers: ['anthropic', 'openai'] }), 'ultra_cheap');
  const line = phaseMapRecordLine({ phase_scenario: out.scenario, phase_posture: out.posture, phase_map: out.map });
  assert.match(line, /review=claude-opus-5/);
  assert.match(line, /plan=claude-opus-5/);
  assert.match(line, /implement_mechanical=gpt-5.6-luna/);
});

test('posture max_quality: the best available flagship for everything — never gpt-5.5-pro', () => {
  const expect = { both: 'claude-fable-5', openai: 'gpt-5.6-sol', anthropic: 'claude-fable-5' };
  for (const [scenario, providers] of [['both', ['anthropic', 'openai']], ['openai', ['openai']], ['anthropic', ['anthropic']]]) {
    const out = applyPhasePosture(resolvePhaseModelMap({ providers }), 'max_quality');
    for (const phase of BUILD_PHASES) {
      assert.equal(out.map[phase].model, expect[scenario], `${scenario}/${phase}`);
      assert.notEqual(out.map[phase].model, 'gpt-5.5-pro'); // legacy/uncached stays excluded even here
    }
  }
});

test('a posture never rescues the no-provider refusal, and the record line names the posture', () => {
  const refused = applyPhasePosture(resolvePhaseModelMap({ providers: [] }), 'ultra_cheap');
  assert.equal(refused.ok, false);
  assert.equal(refused.error, NO_PROVIDER_ERROR);
  const out = applyPhasePosture(resolvePhaseModelMap({ providers: ['anthropic', 'openai'] }), 'ultra_cheap');
  const line = phaseMapRecordLine({ phase_scenario: out.scenario, phase_posture: out.posture, phase_map: out.map });
  assert.match(line, /^Phase model map \[both, posture: ultra_cheap\]: /);
  // The default posture keeps the record line unchanged from the pre-posture shape.
  const def = applyPhasePosture(resolvePhaseModelMap({ providers: ['anthropic', 'openai'] }), 'default');
  assert.match(
    phaseMapRecordLine({ phase_scenario: def.scenario, phase_posture: def.posture, phase_map: def.map }),
    /^Phase model map \[both\]: /,
  );
});

test('the only OpenAI models any phase map routes to are luna, terra, and sol', () => {
  // The UI's OpenAI model menu offers exactly this trio (frontend
  // model-options.js OPENAI_MODEL_OPTIONS) — the hybrid and single-vendor
  // maps must never route to an OpenAI id outside it (gpt-5.5-pro stays a
  // plan-phase opt-in only).
  const allowed = new Set(['gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-5.6-sol']);
  for (const providers of [['openai'], ['anthropic', 'openai']]) {
    const r = resolvePhaseModelMap({ providers });
    for (const phase of BUILD_PHASES) {
      const { model, provider } = r.map[phase];
      if (provider !== 'openai') continue;
      assert.ok(allowed.has(model), `${providers}/${phase} routes to unexpected OpenAI model ${model}`);
    }
  }
  // The hybrid map's OpenAI tiers specifically: cheap=luna, mid=terra.
  const both = resolvePhaseModelMap({ providers: ['anthropic', 'openai'] });
  assert.equal(both.map.recon.model, 'gpt-5.6-luna');
  assert.equal(both.map.implement_complex.model, 'gpt-5.6-terra');
  // And the OpenAI-only top tier is sol.
  assert.equal(resolvePhaseModelMap({ providers: ['openai'] }).map.plan.model, 'gpt-5.6-sol');
});
