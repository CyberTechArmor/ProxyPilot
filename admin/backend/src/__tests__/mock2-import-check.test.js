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

// Blank out comments and quoted-string CONTENTS, keeping every offset and line
// break so the source still reads as code.
//
// Comments are prose, and this codebase's prose names functions constantly
// ("`ready` is buildRunnerReady()'s result", "the getChatMaxChars() floor").
// Both read as call sites to a regex.
//
// Done with a state scanner rather than two regexes, because the regex version
// was wrong in a way worth remembering: caddy.js contains the shell glob
// `"${dataDir}/certificates"/*/"${f}"` inside a template literal, and a
// /\*[\s\S]*?\*\// pass treated that `/*` as the start of a block comment and
// swallowed the file's import block whole — which then reported caddy.js for
// calling sh() without importing it, six lines under `import { sh }`.
//
// Template literals keep their contents (a call inside `${…}` is real code);
// only the quotes' contents are blanked, so `from './x.js'` still parses as an
// import statement.
function blankNonCode(input) {
  const src = String(input);
  const out = [];
  let state = 'code';
  for (let i = 0; i < src.length; i++) {
    const c = src[i], next = src[i + 1];
    const keep = () => out.push(c);
    const hide = () => out.push(c === '\n' ? '\n' : ' ');
    if (state === 'code') {
      if (c === '/' && next === '/') { state = 'line'; hide(); continue; }
      if (c === '/' && next === '*') { state = 'block'; hide(); continue; }
      if (c === "'" || c === '"') { state = c; keep(); continue; }
      if (c === '`') { state = 'tpl'; keep(); continue; }
      keep(); continue;
    }
    if (state === 'line') { if (c === '\n') state = 'code'; hide(); continue; }
    if (state === 'block') { if (c === '*' && next === '/') { out.push(' ', ' '); i++; state = 'code'; continue; } hide(); continue; }
    if (state === 'tpl') { if (c === '\\') { keep(); if (next !== undefined) { out.push(next); i++; } continue; } if (c === '`') state = 'code'; keep(); continue; }
    // inside '...' or "..."
    if (c === '\\') { hide(); if (next !== undefined) { out.push(' '); i++; } continue; }
    if (c === state) { state = 'code'; keep(); continue; }
    hide();
  }
  return out.join('');
}

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

function violations(raw) {
  const src = blankNonCode(raw);
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

/* ---------------------------------------------------------------------------
   The same check, with the hand-maintained list removed.

   WHY. smoke.js called withPlatformLogin() and never imported it. The check
   above would have caught it — if somebody had remembered to add
   'withPlatformLogin' to WIRED_HELPERS when the helper was written. Nobody
   did, and the defect shipped as `runner crashed: withPlatformLogin is not
   defined`, which killed a $6.58 build AFTER a successful deploy: the app was
   live and serving, and the cycle went red in the post-deploy smoke stage.

   A ratchet that only holds when someone remembers to tighten it is not a
   ratchet. The candidate list is now DERIVED: every name any sibling mock2
   module exports. No list to maintain and nothing new to remember.
   --------------------------------------------------------------------------- */

// Names bound locally, by any mechanism that puts an identifier in scope. Only
// consulted for names that a sibling module also exports, and only at call
// sites, so it can be generous without losing signal.
function locallyBound(src) {
  const names = new Set();
  for (const m of src.matchAll(/(?:^|[^.\w])(?:async\s+)?function\s*\*?\s*(\w+)/g)) names.add(m[1]);
  for (const m of src.matchAll(/(?:const|let|var|class)\s+(\w+)/g)) names.add(m[1]);
  // Destructuring and parameter lists: any bare identifier inside ( … ) or
  // { … } that is followed by = , ) or } and preceded by ( { , or whitespace.
  // Deliberately loose — a false "bound" only costs coverage of one name in
  // one file, a false "unbound" costs a broken test run.
  for (const m of src.matchAll(/[({,]\s*(\w+)\s*(?=[=,)}\]])/g)) names.add(m[1]);
  for (const m of src.matchAll(/\(\s*(\w+)\s*\)\s*=>/g)) names.add(m[1]);
  for (const m of src.matchAll(/catch\s*\(\s*(\w+)/g)) names.add(m[1]);
  return names;
}

test('a mock2 module never calls a sibling module\'s export without importing it', () => {
  const files = readdirSync(MOCK2_DIR, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.js'))
    .map((e) => e.name);
  assert.ok(files.length > 50, 'mock2 module listing looks wrong');

  const sources = new Map(files.map((n) => [n, blankNonCode(readFileSync(path.join(MOCK2_DIR, n), "utf8"))]));
  const exportsByFile = new Map([...sources].map(([n, src]) => [n, exportedNames(src)]));

  // Names exported by more than one module, or that read as ordinary words, are
  // not evidence of a wiring mistake — this check is about a helper that lives
  // in exactly one place.
  const owners = new Map();
  for (const [file, names] of exportsByFile) {
    for (const n of names) owners.set(n, (owners.get(n) || new Set()).add(file));
  }

  const bad = [];
  for (const [name, src] of sources) {
    const imports = importedNames(src);
    const bound = locallyBound(src);
    const mine = exportsByFile.get(name);
    for (const [helper, homes] of owners) {
      if (homes.size !== 1 || homes.has(name) || mine.has(helper)) continue;
      // A CALL of the bare name: excludes member calls (a.foo()), longer
      // identifiers, and mentions inside strings or template literals.
      if (!new RegExp(`(?<![.\\w'"\`])${helper}\\(`).test(src)) continue;
      if (imports.has(helper) || bound.has(helper)) continue;
      bad.push(`${name}: calls ${helper}() — exported by ./${[...homes][0]} — without importing it`);
    }
  }
  assert.deepEqual(bad, []);
});

test('the derived check would have caught the withPlatformLogin crash', () => {
  // The shape, reduced: a file that calls a helper it did not name in its
  // import list, where the import list from that same module is otherwise
  // correct — which is precisely how the real one read.
  const src = "import { parseUiChecks, withBaselineChecks } from './ui-check-logic.js';\n"
    + 'spec = withPlatformLogin(spec, reviewLogin);\n';
  const imports = importedNames(src);
  const bound = locallyBound(src);
  assert.ok(imports.has('withBaselineChecks'));
  assert.ok(!imports.has('withPlatformLogin'));
  assert.ok(!bound.has('withPlatformLogin'), 'must not read as locally declared');
  assert.match(src, /(?<![.\w'"`])withPlatformLogin\(/);
});
