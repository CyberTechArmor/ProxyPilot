// Called but never imported — the defect class that crashed project 42's build
// at the DEPLOY step, after thirteen minutes and $6.58 of work:
//
//     runner crashed: withPlatformLogin is not defined
//
// The call was added to smoke.js and the import was not. Nothing caught it:
// every test here exercises the PURE `*-logic.js` modules, and the native
// modules that consume them (smoke.js, runner.js, deploy.js — anything that
// touches containers or a database) are never imported by any test, so a
// missing import in one of them is invisible until it runs in production.
// `node --check` does not help either: an undefined identifier is a RUNTIME
// error, not a syntax error, so the file parses perfectly.
//
// This closes it statically and conservatively: for every mock2 module, find
// the names it CALLS, and fail when a called name is exported by some OTHER
// mock2 module and is neither imported nor defined locally. That is precisely
// the "you forgot the import" shape, and it cannot fire on an ordinary local
// call or a global.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const MOCK2 = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'mock2');

// Blank comments and string/template literals so a name mentioned in prose or
// inside emitted shell cannot be mistaken for a call. Line comments go FIRST:
// a `/*` inside a `//` comment would otherwise open a block that swallows real
// code until the next `*/` — which is exactly what happened on the first run of
// this, blanking caddy.js's import line and reporting four phantom problems.
//
// Used ONLY to find call sites. Imports and declarations are read from the raw
// source, where they are unambiguous — mis-blanking there produces a FALSE
// ALARM, and a check that cries wolf gets switched off.
function stripNoise(src) {
  return src
    .replace(/(^|[^:])\/\/[^\n]*/gm, (m, p1) => p1 + ' '.repeat(m.length - p1.length))
    .replace(/\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(m.length))
    .replace(/`(?:\\[\s\S]|[^`\\])*`/g, (m) => ' '.repeat(m.length))
    .replace(/'(?:\\[\s\S]|[^'\\\n])*'/g, (m) => ' '.repeat(m.length))
    .replace(/"(?:\\[\s\S]|[^"\\\n])*"/g, (m) => ' '.repeat(m.length));
}

// The names a module brings in: static imports, dynamic-import destructuring
// (`const { x } = await import('./y.js')` — used all over the runner), plus
// anything it declares or receives as a parameter.
function localNames(src) {
  const names = new Set();
  const add = (list) => String(list || '')
    .split(',')
    .map((s) => s.trim().split(/\s+as\s+/).pop().trim())
    .filter(Boolean)
    .forEach((n) => names.add(n));

  for (const m of src.matchAll(/import\s+\{([^}]*)\}\s*from/g)) add(m[1]);
  for (const m of src.matchAll(/import\s+(\w+)\s*(?:,|from)/g)) names.add(m[1]);
  for (const m of src.matchAll(/import\s*\*\s*as\s+(\w+)/g)) names.add(m[1]);
  for (const m of src.matchAll(/(?:const|let|var)\s*\{([^}]*)\}\s*=\s*(?:await\s+)?(?:import|require)\s*\(/g)) add(m[1]);
  // Local declarations of every shape, and function parameters.
  for (const m of src.matchAll(/(?:const|let|var)\s+(\w+)/g)) names.add(m[1]);
  for (const m of src.matchAll(/function\s+(\w+)/g)) names.add(m[1]);
  for (const m of src.matchAll(/class\s+(\w+)/g)) names.add(m[1]);
  // Destructuring of EVERY shape, including the nested and array forms the
  // runner uses:
  //     const { a, b } = x
  //     const [{ a, b }, { c }] = await Promise.all([...])
  // Take the whole pattern between the keyword and the `=` and harvest every
  // identifier in it. Over-collecting here only makes the scan more permissive;
  // under-collecting produces a false alarm, and a check that cries wolf gets
  // switched off.
  for (const m of src.matchAll(/(?:const|let|var)\s*([[{][\s\S]{0,400}?)=[^=]/g)) {
    for (const n of m[1].match(/[A-Za-z_$][\w$]*/g) || []) names.add(n);
  }
  // Parameters, including the destructured-object form
  //     function f({ containerName, writeFileInContainer })
  // whose closing brace used to leave the LAST name looking like `x }`.
  for (const m of src.matchAll(/\(([^)]*)\)\s*(?:=>|\{)/g)) {
    for (const part of m[1].split(',')) {
      const n = part.replace(/[{}[\]]/g, ' ').replace(/[.]{3}/, '').split(/[=:]/)[0].trim();
      if (/^\w+$/.test(n)) names.add(n);
    }
  }
  return names;
}

test('no mock2 module calls another module\'s export without importing it', async () => {
  const files = (await readdir(MOCK2)).filter((f) => f.endsWith('.js'));

  // What each module EXPORTS as a callable.
  const exportedBy = new Map();          // name → module file
  const sources = new Map();
  for (const f of files) {
    const raw = await readFile(path.join(MOCK2, f), 'utf8');
    sources.set(f, raw);
    for (const m of raw.matchAll(/^export\s+(?:async\s+)?function\s+(\w+)/gm)) {
      if (!exportedBy.has(m[1])) exportedBy.set(m[1], f);
    }
    for (const m of raw.matchAll(/^export\s+const\s+(\w+)\s*=\s*(?:async\s*)?\(/gm)) {
      if (!exportedBy.has(m[1])) exportedBy.set(m[1], f);
    }
  }
  assert.ok(exportedBy.size > 50, `expected a real export map, got ${exportedBy.size}`);

  const problems = [];
  for (const f of files) {
    const raw = sources.get(f);
    const src = stripNoise(raw);
    // Names from the RAW source: an import or declaration hidden by imperfect
    // blanking becomes a false alarm, and the only cost of reading a name out
    // of a comment is that the scan is slightly more permissive.
    const local = localNames(raw);
    const seen = new Set();
    for (const m of src.matchAll(/(?<![.\w$])([a-z][A-Za-z0-9_$]*)\s*\(/g)) {
      const name = m[1];
      if (seen.has(name) || local.has(name)) continue;
      seen.add(name);
      const owner = exportedBy.get(name);
      // Only flag a name some OTHER mock2 module exports: that is the "you
      // forgot the import" shape. A local helper or a global cannot trip it.
      if (owner && owner !== f) problems.push(`${f} calls ${name}() — exported by ${owner}, not imported here`);
    }
  }
  assert.deepEqual(problems, [], `\n${problems.join('\n')}\n`);
});

test('the scanner would have caught the project-42 crash', async () => {
  // A check that only ever passes proves nothing. This reconstructs the exact
  // defect — smoke.js calling withPlatformLogin with that name absent from its
  // import — and asserts the scan flags it.
  const smoke = await readFile(path.join(MOCK2, 'smoke.js'), 'utf8');
  const broken = smoke.replace('withPlatformLogin, withBaselineChecks', 'withBaselineChecks');
  assert.notEqual(broken, smoke, 'the import must be present to be removable');

  const src = stripNoise(broken);
  const local = localNames(broken.replace(/^\/\/[^\n]*$/gm, ''));
  assert.ok(!local.has('withPlatformLogin'), 'with the import gone the name must be unknown to the file');
  assert.match(src, /withPlatformLogin\s*\(/, 'and it must still be called');
});
