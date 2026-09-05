// The Mock2 standards (mock2-core v0.2.0) + CPR v1.1 rendering in the framework
// seed and the scaffold — pure, native-free (risk R9). These pin the CONTRACT the
// standards site and the platform now share, so a seed edit that drops rule 0,
// the CPR section, the check scripts or the per-repo files is caught before
// upgradeFrameworkFromSeed publishes it to every project.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { buildSeedFiles, mock2StandardsSeedFiles } from '../mock2/template.js';
import { CHECK_SCRIPTS, buildScaffoldFiles } from '../mock2/scaffold.js';
import { parseGateScripts, gateStatusFromOutput } from '../mock2/cycle-logic.js';
import { parseComponentImport } from '../mock2/component-logic.js';
import { SEED_DOCS } from '../mock2/component-seed-docs.js';
import { MCP_SERVER_INSTRUCTIONS } from '../lib/mcp-logic.js';

const seed = (name) => readFile(new URL(`../mock2/framework-seed/${name}`, import.meta.url), 'utf8');

test('constitution v2 carries rule 0, the Check stage, CPR §13 and the change-record format', async () => {
  const c = await seed('constitution.md');
  assert.match(c, /Rule 0 — nothing here blocks building or testing/);
  for (const cls of ['implementation\n  requirement', 'configurable capability', 'production checklist item', 'recommendation']) {
    assert.ok(c.includes(cls), `rule 0 must name the classification "${cls}"`);
  }
  assert.match(c, /4\. \*\*Check\*\*/);
  assert.match(c, /5\. \*\*Run\*\*/);
  assert.match(c, /## 13\. Continuous Production Readiness \(CPR v1\.1\)/);
  assert.match(c, /feature\.manifest\.json/);
  assert.match(c, /expand → migrate → contract/);
  assert.match(c, /state\/decisions\.md/);
  assert.match(c, /## 14\. Change records and the production checklist/);
  assert.match(c, /\[draft\]/);
  // The hardened v1 sections survive — the update is additive.
  for (const s of ['## 7a. No silent simulation', '## 9. Deviations', '## 12. Acceptance & anti-Goodhart']) {
    assert.ok(c.includes(s), `constitution lost "${s}"`);
  }
});

test('skills: build keeps going on a red check, reviewer never blocks, runner contracts intact', async () => {
  const raw = await seed('skills.json');
  const skills = JSON.parse(raw);
  const by = Object.fromEntries(skills.map((s) => [s.name, s]));
  assert.deepEqual(Object.keys(by).sort(), ['build', 'concept', 'define', 'review']);
  assert.match(by.build.body, /Rule 0 \(mock2-core v0\.2\.0; CPR v1\.1 §3\.1\)/);
  assert.match(by.build.body, /A failing check is information, not a stop/);
  assert.match(by.build.body, /cpr-host component/);
  assert.match(by.define.body, /\[draft\]/);
  assert.match(by.review.body, /do not tell the Builder they may not proceed/);
  assert.match(by.review.body, /state\/production-checklist\.md/);
  // Contracts the runner and its tests key off.
  assert.ok(raw.includes('phase-routing@1'));
  assert.ok(raw.includes('cite file:line from the diff'));
});

test('gates.json: the battery parses; a dependency-audit finding is a WARNING, a committed secret still fails', async () => {
  const gates = parseGateScripts(await seed('gates.json'));
  assert.deepEqual(gates.map((g) => g.name), [
    'typecheck', 'constitution-lint', 'rule-coverage', 'security-scan', 'test', 'ui-interaction', 'acceptance', 'component-reuse',
  ]);
  const sec = gates.find((g) => g.name === 'security-scan').script;
  assert.match(sec, /npm audit --audit-level=high/);
  assert.doesNotMatch(sec, /npm audit --audit-level=high \|\| fail=1/, 'the audit must not red the check');
  assert.match(sec, /security-scan: WARNING - npm audit/);
  assert.match(sec, /security-scan: FAIL - committed private key material/);
  // A WARNING run still ends with the OK verdict and exit 0 → 'passed', never 'skipped'.
  const out = 'security-scan: WARNING - npm audit reports high/critical advisories (production-checklist item check:audit; recorded, not blocking)\nsecurity-scan: OK\n';
  assert.equal(gateStatusFromOutput(0, out), 'passed');
  assert.equal(gateStatusFromOutput(1, 'security-scan: FAIL - AWS access key id in x'), 'failed');
});

test('scaffold package.json ships the standards check scripts next to the existing ones', () => {
  const files = buildScaffoldFiles({ name: 'Demo App', id: 1 });
  const pkg = JSON.parse(files.find((f) => f.path === 'package.json').content);
  for (const k of ['check', 'check:lint', 'check:types', 'check:test', 'check:audit', 'check:secrets']) {
    assert.equal(pkg.scripts[k], CHECK_SCRIPTS[k], `missing ${k}`);
  }
  // Existing contracts untouched.
  assert.equal(pkg.scripts.test, 'vitest run');
  assert.equal(pkg.scripts.migrate, 'node scripts/migrate.mjs');
  // `check` chains with `;` — a red item never stops the next one (rule 0).
  assert.ok(CHECK_SCRIPTS.check.includes(';'));
  assert.doesNotMatch(CHECK_SCRIPTS.check, /&&/);
});

test('every project is seeded with the standards repo files, named for the project', () => {
  const files = buildSeedFiles({ name: 'Demo App' });
  const paths = files.map((f) => f.path);
  for (const p of [
    'CLAUDE.md', '.github/copilot-instructions.md', 'state/rules.md', 'state/production-checklist.md',
    'state/decisions.md', 'state/change-records/README.md', '.mock2/README.md',
  ]) assert.ok(paths.includes(p), `seed is missing ${p}`);
  assert.equal(new Set(paths).size, paths.length, 'duplicate seed paths');
  const claude = files.find((f) => f.path === 'CLAUDE.md').content;
  assert.match(claude, /^# Demo App — repository constitution/);
  assert.match(claude, /mock2\.fractionate\.ai/);
  assert.match(claude, /Nothing in it blocks building or testing/);
  assert.match(files.find((f) => f.path === 'state/rules.md').content, /\[draft\]`, `\[confirmed\]`, `\[observed\]/);
  assert.match(files.find((f) => f.path === 'state/decisions.md').content, /DEC-001/);
  // Pure helper: no project name → still valid.
  assert.match(mock2StandardsSeedFiles(null)[0].content, /^# Project — repository constitution/);
});

test('the CPR Host component document is bundled, valid, and seeded without the auth wiring test', async () => {
  const cpr = SEED_DOCS.find((d) => d.file.endsWith('cpr-host.component.json'));
  assert.ok(cpr, 'cpr-host.component.json must be in SEED_DOCS');
  assert.equal(cpr.wires, false);
  assert.equal(SEED_DOCS.find((d) => d.file.endsWith('proxypilot-auth.component.json')).wires, true);
  const doc = JSON.parse(await readFile(cpr.file, 'utf8'));
  const check = parseComponentImport(doc);
  assert.equal(check.ok, true, check.error);
  assert.equal(check.data.key, 'cpr-host');
  const paths = check.data.files.map((f) => f.path);
  for (const p of ['src/cpr/host-contract.ts', 'src/cpr/host-sdk.ts', 'src/cpr/manifest-schema.ts', 'src/cpr/host/index.ts', 'src/cpr/host/unbound.ts', 'migrations/cpr_platform.sql']) {
    assert.ok(paths.includes(p), `component missing ${p}`);
  }
  // The host SDK re-exports the sibling contract, not the npm package, so a
  // project carries ONE copy of the contract.
  const sdk = check.data.files.find((f) => f.path === 'src/cpr/host-sdk.ts').content;
  assert.match(sdk, /from '\.\/host-contract\.js'/);
  assert.doesNotMatch(sdk, /@cpr\/host-contract'/);
  assert.match(check.data.usage_md, /do not\ninvent gates|do not invent gates/i);
});

test('the CPR standard is vendored and the MCP instructions point clients at the standards', async () => {
  const cprMd = await seed('cpr/CPR-v1.1.md');
  assert.match(cprMd, /^# Continuous Production Readiness \(CPR\) — v1\.1/);
  assert.match(cprMd, /## 3\.1 Development Freedom and No Invented Gates/);
  assert.match(cprMd, /# B\. Appendix B — Feature Manifest Minimum Schema/);
  assert.match(MCP_SERVER_INSTRUCTIONS, /mock2\.fractionate\.ai/);
  assert.match(MCP_SERVER_INSTRUCTIONS, /never invent a gate/);
  // The working-order sentences stay first (mcp-logic.test.js pins their order).
  assert.ok(MCP_SERVER_INSTRUCTIONS.indexOf('apply_project_patch') < MCP_SERVER_INSTRUCTIONS.indexOf('STANDARDS:'));
});

test('standards-version.json records the site version the seed renders, and the README points at it', async () => {
  const sv = JSON.parse(await seed('standards-version.json'));
  assert.match(sv.version, /^\d+\.\d+\.\d+$/);
  assert.equal(sv.manifest, 'https://mock2.fractionate.ai/manifest.json');
  assert.equal(sv.source, 'https://git.fractionate.ai/mock2/mock2-core');
  assert.match(sv.synced, /^\d{4}-\d{2}-\d{2}$/);
  const readme = await seed('README.md');
  assert.ok(readme.includes(`**${sv.version}**`), `README's Mock2 standards row must carry ${sv.version}`);
  assert.match(readme, /standards-version\.json/);
});
