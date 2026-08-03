// GATE AUTHORITY HARDENING (run-taxonomy fix #11/C3). Gates are pinned into
// the container at cycle start from the framework version stamped on the
// cycle (ADR-003) — a build's own diff cannot change what judges it. These
// tests prove that property at the source level (no live container/DB in this
// sandbox — risk R9, stub-first) and pin the ui-interaction gate's existing
// anti-gaming check. C3.2 adds a VISIBILITY measure (never a block) when a
// diff touches gate config — these tests cover the pure predicate that drives
// it; the record-summary line itself is native/DB-coupled and out of scope
// for a unit test (see docs/known-issues.md's native-boundary convention).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { buildGateBattery, gateConfigTouchedFiles, BUILD_MODE_QUICK } from '../mock2/cycle-logic.js';

const RUNNER_SRC = readFileSync(new URL('../mock2/runner.js', import.meta.url), 'utf8');
const CYCLE_LOGIC_SRC = readFileSync(new URL('../mock2/cycle-logic.js', import.meta.url), 'utf8');
const gatesSeed = JSON.parse(readFileSync(new URL('../mock2/framework-seed/gates.json', import.meta.url), 'utf8'));
const uiInteractionScript = (Array.isArray(gatesSeed) ? gatesSeed : gatesSeed.gates).find((g) => g.name === 'ui-interaction').script;

// ---- C3.1: prove the pinning ----

test('the executed battery comes from the pinned framework version, not the working tree', () => {
  const pinned = [{ name: 'typecheck', script: 'echo pinned-v1', order: 1 }];
  const result = buildGateBattery(pinned, BUILD_MODE_QUICK);
  const tc = result.gates.find((g) => g.name === 'typecheck');
  assert.equal(tc.script, 'echo pinned-v1');

  // buildGateBattery has no filesystem or ambient state to read a working-tree
  // "gates.json edit" from — calling it again with the SAME pinned reference
  // reproduces byte-identical output.
  const again = buildGateBattery(pinned, BUILD_MODE_QUICK);
  assert.deepEqual(again.gates.map((g) => g.script), result.gates.map((g) => g.script));

  // And at the source level: cycle-logic.js (where buildGateBattery lives)
  // never imports fs or a shell-exec primitive, so it CANNOT read the tree —
  // its only input is the frameworkGates argument, which the caller sources
  // from the pinned framework version's DB row (framework.js), never from an
  // in-container file.
  assert.doesNotMatch(CYCLE_LOGIC_SRC, /from ['"]node:fs['"]|from ['"]fs['"]|readFileSync|child_process/);
});

test('copyGatesIntoContainer writes only the scripts it was given', () => {
  const fnMatch = RUNNER_SRC.match(/export async function copyGatesIntoContainer\(containerName, gateScripts\) \{[\s\S]*?\n\}/);
  assert.ok(fnMatch, 'copyGatesIntoContainer must exist with this exact signature');
  const body = fnMatch[0];
  // Every script write is driven by iterating the gateScripts PARAMETER — not
  // a module-level import of gates.json, the framework registry, or any other
  // ambient gate list.
  assert.match(body, /gateScripts\.forEach/);
  assert.doesNotMatch(body, /framework-seed\/gates\.json/);
  assert.doesNotMatch(body, /getCurrentFrameworkVersion|getFrameworkVersion/);

  const filenameFn = RUNNER_SRC.match(/function gateFilename\(gate, i\) \{[\s\S]*?\n\}/);
  assert.ok(filenameFn, 'gateFilename must exist');
  // The filename is derived from the loop variable's own fields, not from a
  // second, independently-sourced list.
  assert.match(filenameFn[0], /gate\.name/);
});

test('the ui-interaction gate rejects coverage conjured by widening path globs', () => {
  assert.match(uiInteractionScript, /const globOnly = uiFiles\.filter/);
  assert.match(uiInteractionScript, /stepsChanged/);
  assert.match(
    uiInteractionScript,
    /coverage for these touched screen file\(s\) was conjured by extending an existing check\\?'s path globs, with no assertion added or changed:/,
  );
});

// ---- C3.2: visibility, not a block ----

test('a diff touching gates.json adds the gate-config notice to the record summary', () => {
  assert.deepEqual(gateConfigTouchedFiles(['framework-seed/gates.json']), ['framework-seed/gates.json']);
  assert.deepEqual(gateConfigTouchedFiles(['state/ui-checks.json']), ['state/ui-checks.json']);
  assert.deepEqual(
    gateConfigTouchedFiles(['src/routes/foo.js', 'state/ui-checks.json', 'public/app.html']),
    ['state/ui-checks.json'],
  );
  // Wired into the record summary, not silently computed and dropped.
  assert.match(RUNNER_SRC, /gateConfigTouchedFiles\(changedThisCycle\)/);
  assert.match(RUNNER_SRC, /Gate config touched this cycle: /);
  assert.match(RUNNER_SRC, /The battery that judged this cycle was the pinned one; this change affects later cycles\./);
});

test('a diff touching only product code adds no notice', () => {
  assert.deepEqual(gateConfigTouchedFiles(['src/routes/foo.js', 'public/app.html', 'src/db.js']), []);
  assert.deepEqual(gateConfigTouchedFiles([]), []);
  assert.deepEqual(gateConfigTouchedFiles(undefined), []);
});

// This measure never blocks — confirm the wiring only APPENDS to the summary
// string, with no gate/refusal/haltCycle call gated on gateConfigTouchedFiles.
test('the gate-config notice never blocks — no conditional gate/refusal keys off it', () => {
  const idx = RUNNER_SRC.indexOf('gateConfigTouchedFiles(changedThisCycle)');
  assert.ok(idx > -1);
  const nearby = RUNNER_SRC.slice(idx, idx + 400);
  assert.doesNotMatch(nearby, /haltCycle|status: 'refused'|status: 'failed'/);
});
