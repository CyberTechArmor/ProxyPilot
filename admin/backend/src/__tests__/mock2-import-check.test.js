// Cross-module wiring import check (LEARNINGS #12). Origin: the budget
// removal wired modelMaxOutputTokens() into concept.js without importing it —
// node --check can't catch an undefined identifier, the module-not-found
// sandbox can't import concept.js (better-sqlite3), and the defect shipped as
// a runtime "modelMaxOutputTokens is not defined" that failed a paid design
// turn. This static scan is native-free: for every helper on the wiring list,
// a mock2 module that CALLS it must also import or declare it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const MOCK2_DIR = fileURLToPath(new URL('../mock2/', import.meta.url));

// Helpers that get wired across mock2 modules by hand. Extend this list when
// a new cross-module helper joins the pipeline.
const WIRED_HELPERS = [
  'modelMaxOutputTokens',
  'callModelTurn',
  'callStepTurn',
  'stepSystemPrompt',
  'resolveStepTuning',
  'getHarnessStepTuning',
  'screenForEditTargets',
  'buildTweakRetryMessage',
  'applyLaneTuning',
  'getLaneTuning',
  'insertLedgerEntry',
  'costCentsForUsage',
  'effectivePrice',
  'insertMessage',
  'stampDeployedCommit',
];

function importedNames(src) {
  const names = new Set();
  // Static named imports: import { a, b as c } from '...'
  for (const m of src.matchAll(/import\s*\{([\s\S]*?)\}\s*from\s*['"]/g)) {
    for (const part of m[1].split(',')) {
      const n = part.trim().split(/\s+as\s+/).pop().trim();
      if (n) names.add(n);
    }
  }
  // Dynamic destructured imports: const { a, b } = await import('...').
  // [^{}] keeps an enclosing block brace (try {, if {) from swallowing the
  // destructure group and garbling the captured names.
  for (const m of src.matchAll(/\{([^{}]*)\}\s*=\s*await import\(/g)) {
    for (const part of m[1].split(',')) {
      const n = part.trim().split(':').pop().trim();
      if (n) names.add(n);
    }
  }
  return names;
}

function violations(src) {
  const imports = importedNames(src);
  const out = [];
  for (const name of WIRED_HELPERS) {
    // A call: name( not preceded by ., word char, or quote (excludes member
    // calls, longer identifiers, and string mentions).
    const called = new RegExp(`(?<![.\\w'"\`])${name}\\(`).test(src);
    if (!called) continue;
    const declared = new RegExp(`function ${name}\\(|const ${name} =`).test(src);
    if (!declared && !imports.has(name)) out.push(name);
  }
  return out;
}

test('the checker catches the original defect shape', () => {
  const buggy = "import { callStepTurn } from './harness-steps.js';\nconst n = modelMaxOutputTokens(model);\n";
  assert.deepEqual(violations(buggy), ['modelMaxOutputTokens']);
  const fixed = "import { modelMaxOutputTokens } from './routing-logic.js';\nconst n = modelMaxOutputTokens(model);\n";
  assert.deepEqual(violations(fixed), []);
});

test('every mock2 module imports the wired helpers it calls', () => {
  const files = readdirSync(MOCK2_DIR, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.js'))
    .map((e) => e.name);
  assert.ok(files.length > 50, 'mock2 module listing looks wrong');
  const bad = [];
  for (const name of files) {
    const src = readFileSync(path.join(MOCK2_DIR, name), 'utf8');
    for (const helper of violations(src)) bad.push(`${name}: calls ${helper}() without importing it`);
  }
  assert.deepEqual(bad, []);
});
