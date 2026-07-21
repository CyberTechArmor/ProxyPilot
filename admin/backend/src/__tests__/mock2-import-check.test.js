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

// Exported names of one module source (functions, consts, classes, and
// export-list entries, aliased names counted by their exported name).
function exportedNames(src) {
  const names = new Set();
  for (const m of src.matchAll(/export\s+(?:async\s+)?function\s+(\w+)/g)) names.add(m[1]);
  for (const m of src.matchAll(/export\s+(?:const|let|var|class)\s+(\w+)/g)) names.add(m[1]);
  for (const m of src.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const n = part.trim().split(/\s+as\s+/).pop().trim();
      if (n) names.add(n);
    }
  }
  return names;
}

// LEARNINGS #14: design-review.js shipped importing costCentsForUsage from
// './usage-logic.js', which never exported it — the module could not LOAD,
// so every dynamic import of it (annotate screenshot, polish pass) rejected
// at runtime; before the crash net that rejection killed the backend.
// Static named imports between mock2 modules must name real exports.
test('every same-dir named import resolves to a real export', () => {
  const files = readdirSync(MOCK2_DIR, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.js'))
    .map((e) => e.name);
  const exportsByFile = new Map();
  const getExports = (name) => {
    if (!exportsByFile.has(name)) {
      try { exportsByFile.set(name, exportedNames(readFileSync(path.join(MOCK2_DIR, name), 'utf8'))); }
      catch { exportsByFile.set(name, null); }
    }
    return exportsByFile.get(name);
  };
  // Template factories embed the GENERATED app's imports inside template
  // strings — those reference the scaffolded app's own modules, not ours.
  const TEMPLATE_FACTORIES = new Set(['scaffold.js', 'scaffold-auth.js', 'template.js', 'mockup-template.js']);
  const bad = [];
  for (const name of files) {
    if (TEMPLATE_FACTORIES.has(name)) continue;
    const src = readFileSync(path.join(MOCK2_DIR, name), 'utf8');
    // The name group forbids braces and quotes so one match can never span
    // two import statements (a from-elsewhere import followed by a same-dir
    // one used to blend into a single false match).
    for (const m of src.matchAll(/import\s*\{([^{}'"]*?)\}\s*from\s*['"]\.\/([\w.-]+\.js)['"]/g)) {
      const target = getExports(m[2]);
      if (!target) continue; // missing file is a different failure class
      for (const part of m[1].split(',')) {
        const source = part.trim().split(/\s+as\s+/)[0].trim();
        if (source && !target.has(source)) bad.push(`${name}: imports '${source}' from ./${m[2]} which does not export it`);
      }
    }
  }
  assert.deepEqual(bad, []);
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
