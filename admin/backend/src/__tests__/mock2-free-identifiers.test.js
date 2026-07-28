// RATCHET: a constant used in one mock2 module and defined in another.
//
// `design-review.js` opened its browser contexts with
// `newContext({ ...AUTOMATION_CONTEXT, viewport: MOBILE })`. That constant is
// declared in `ui-checks.js` and was never exported, and design-review.js never
// imported it — so every capture threw `ReferenceError: AUTOMATION_CONTEXT is
// not defined` at its first `newContext`, was caught by the surrounding
// try/catch, and reported as `browser error: AUTOMATION_CONTEXT is not
// defined`.
//
// The design review had not run since. Nothing failed: it is deliberately never
// a gate, so a review that cannot run is logged and swallowed. The only sign was
// a line in the chat that reads like the app's fault.
//
// Nothing here was going to catch it. The module IMPORTS fine — a free variable
// is only a ReferenceError when the line executes, and that line needs a real
// browser and a real container. Every test that touches design-review.js tests
// the pure half.
//
// So this is static: for every SCREAMING_SNAKE constant declared at module scope
// in some mock2 module, no OTHER mock2 module may use that name without binding
// it. That is the exact shape of the defect — a constant copied from a sibling
// without its import — and the shape is common because these modules are
// written by looking at each other.
//
// Two things had to be right before it caught anything, and neither was obvious:
// `...SPREAD` looks like `obj.property` to a "not preceded by a dot" lookbehind,
// and an object LITERAL is written exactly like a destructuring pattern, so
// harvesting every `{…}` as a binding made the missing name look declared. The
// first two versions of this file reported the broken tree clean.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MOCK2_DIR = fileURLToPath(new URL('../mock2/', import.meta.url));

// Blank everything that is not code: comments, strings, template literals
// (interpolations included — losing real code there costs a false negative, and
// a ratchet with false positives is a ratchet somebody deletes), regex literals.
// These modules are full of shell scripts and model prompts that name constants
// in prose, so this step is what makes the scan usable at all.
export function codeOnly(src) {
  const out = [];
  let i = 0;
  const n = src.length;
  let prev = '';
  while (i < n) {
    const c = src[i];
    const next = src[i + 1];
    if (c === '/' && next === '/') {
      while (i < n && src[i] !== '\n') { out.push(' '); i++; }
      continue;
    }
    if (c === '/' && next === '*') {
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { out.push(src[i] === '\n' ? '\n' : ' '); i++; }
      out.push(' ', ' '); i += 2;
      continue;
    }
    if (c === '"' || c === "'") {
      out.push(' '); i++;
      while (i < n && src[i] !== c) {
        if (src[i] === '\\') { out.push(' '); i++; }
        out.push(src[i] === '\n' ? '\n' : ' '); i++;
      }
      out.push(' '); i++; prev = 'x';
      continue;
    }
    if (c === '`') {
      out.push(' '); i++;
      let depth = 0;
      while (i < n) {
        if (src[i] === '\\') { out.push(' ', ' '); i += 2; continue; }
        if (src[i] === '`' && depth === 0) break;
        if (src[i] === '$' && src[i + 1] === '{') depth++;
        if (src[i] === '}' && depth > 0) depth--;
        out.push(src[i] === '\n' ? '\n' : ' '); i++;
      }
      out.push(' '); i++; prev = 'x';
      continue;
    }
    // A `/` where a value may begin is a regex literal, not division.
    if (c === '/' && /[(,=:[!&|?{};+\-*%^~<>]|^$/.test(prev)) {
      let j = i + 1;
      let cls = false;
      let closed = false;
      while (j < n && src[j] !== '\n') {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === '[') cls = true;
        else if (src[j] === ']') cls = false;
        else if (src[j] === '/' && !cls) { closed = true; break; }
        j++;
      }
      if (closed) {
        while (i <= j) { out.push(' '); i++; }
        while (i < n && /[a-z]/.test(src[i])) { out.push(' '); i++; }
        prev = 'x';
        continue;
      }
    }
    out.push(c);
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  return out.join('');
}

// `export { A } from './x.js'` re-exports without binding A locally and without
// evaluating it. Neither a use nor a definition — remove it, or every
// re-exporting module reports itself.
export function stripReExports(code) {
  return code.replace(/\bexport\s*\{[^{}]*\}\s*from\s*[^;\n]*/g, ' ');
}

// Every name a file binds. Each pattern is anchored on something that can ONLY
// appear in a binding position.
export function boundNames(code) {
  const own = new Set();
  const add = (s) => {
    for (const p of String(s).split(',')) {
      const nm = p.split(/\s+as\s+|:/).pop().trim();
      if (nm) own.add(nm);
    }
  };
  for (const m of code.matchAll(/\b(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/g)) own.add(m[1]);
  for (const m of code.matchAll(/\b(?:const|let|var)\s*\{([^{}]*)\}\s*=/g)) add(m[1]);
  // const [{ a }, { b }] = await Promise.all([…]) — two lazy modules at once.
  for (const m of code.matchAll(/\b(?:const|let|var)\s*\[([^\][]*)\]\s*=/g)) {
    for (const g of m[1].matchAll(/\{([^{}]*)\}/g)) add(g[1]);
  }
  for (const m of code.matchAll(/\bimport\s*\{([^{}]*)\}\s*from/g)) add(m[1]);
  for (const m of code.matchAll(/\bimport\s+[\w$]+\s*,\s*\{([^{}]*)\}\s*from/g)) add(m[1]);
  // A destructured PARAMETER needs its `function` or its `=>` to be told apart
  // from a call whose argument is an object literal — and `newContext({ … })`
  // is exactly that call.
  for (const m of code.matchAll(/\bfunction\s*[\w$]*\s*\(\s*\{([^{}]*)\}/g)) add(m[1]);
  for (const m of code.matchAll(/\(\s*\{([^{}]*)\}\s*(?:,[^()]*)?\)\s*=>/g)) add(m[1]);
  for (const m of code.matchAll(/\bimport\s+([A-Za-z_$][\w$]*)\s*(?:,|from)/g)) own.add(m[1]);
  for (const m of code.matchAll(/\*\s+as\s+([A-Za-z_$][\w$]*)/g)) own.add(m[1]);
  return own;
}

export function scanFreeIdentifiers(dir) {
  const files = readdirSync(dir).filter((f) => f.endsWith('.js'));
  const code = new Map();
  for (const f of files) {
    // `...` is spread, never property access — but it reads as one to the
    // lookbehind below, and BOTH uses of the constant that broke every design
    // review were `{ ...AUTOMATION_CONTEXT, … }`.
    code.set(f, stripReExports(codeOnly(readFileSync(join(dir, f), 'utf8'))).replace(/\.\.\./g, '   '));
  }

  const declared = new Map();
  for (const f of files) {
    for (const m of code.get(f).matchAll(/^(?:export\s+)?(?:const|let|var|function|class)\s+([A-Z][A-Z0-9_]{2,})\b/gm)) {
      if (!declared.has(m[1])) declared.set(m[1], []);
      if (!declared.get(m[1]).includes(f)) declared.get(m[1]).push(f);
    }
  }

  const offenders = [];
  for (const f of files) {
    const text = code.get(f);
    const own = boundNames(text);
    for (const [name, where] of declared) {
      if (own.has(name) || where.includes(f)) continue;
      const use = new RegExp(`(?<![.\\w$])${name}(?![\\w$])`);
      if (!use.test(text)) continue;
      const line = text.split('\n').findIndex((l) => use.test(l)) + 1;
      offenders.push(`${f}:${line} uses ${name}, declared in ${where.join(', ')} and never imported here`);
    }
  }
  return offenders;
}

test('RATCHET: no mock2 module uses a sibling\'s constant without importing it', () => {
  assert.deepEqual(
    scanFreeIdentifiers(MOCK2_DIR),
    [],
    'a free variable is a ReferenceError the moment that line runs — and the lines that run are the ones a test cannot reach',
  );
});

test('the scanner catches the exact defect it was written for', () => {
  // Executable proof, because two earlier versions of this file passed on a
  // tree that had the bug in it. The fixture is the real shape: declared and
  // NOT exported over here, spread into an options object over there.
  const files = {
    'ui-checks.js': 'const AUTOMATION_CONTEXT = Object.freeze({ serviceWorkers: "block" });\nexport function launchOptions() { return { headless: true }; }\n',
    'design-review.js': 'import { launchOptions } from "./ui-checks.js";\n'
      + 'export async function capture(browser) {\n'
      + '  const context = await browser.newContext({ ...AUTOMATION_CONTEXT, viewport: { width: 390, height: 780 } });\n'
      + '  return context;\n}\n',
  };
  const hits = scanFixture(files);
  assert.equal(hits.length, 1, `expected exactly one report, got ${JSON.stringify(hits)}`);
  assert.match(hits[0], /design-review\.js.*AUTOMATION_CONTEXT.*ui-checks\.js/);

  // And the same tree with the import present is clean — a ratchet that fires
  // on the fix is worse than no ratchet.
  const fixed = {
    ...files,
    'ui-checks.js': files['ui-checks.js'].replace('const AUTOMATION_CONTEXT', 'export const AUTOMATION_CONTEXT'),
    'design-review.js': files['design-review.js'].replace('{ launchOptions }', '{ launchOptions, AUTOMATION_CONTEXT }'),
  };
  assert.deepEqual(scanFixture(fixed), []);
});

test('prose, shell scripts and prompts do not count as uses', () => {
  // These modules emit shell and model prompts by the screenful, and those name
  // constants constantly. Before the string/comment stripping this scan
  // reported twenty files, nineteen of them fiction.
  const hits = scanFixture({
    'a.js': 'export const APP_DIR = "/srv/app";\n',
    'b.js': '// APP_DIR is where the app lives.\n'
      + 'const script = `cd "$APP_DIR" && echo APP_DIR`;\n'
      + 'const prompt = "Never write outside APP_DIR.";\n'
      + 'const re = /APP_DIR|OTHER/;\nexport { script, prompt, re };\n',
  });
  assert.deepEqual(hits, []);
});

test('a re-export is neither a definition nor a use', () => {
  assert.deepEqual(scanFixture({
    'logic.js': 'export const MIN_PASSWORD_LENGTH = 12;\n',
    'native.js': 'export { MIN_PASSWORD_LENGTH } from "./logic.js";\n',
  }), []);
});

// Run the scanner over an in-memory tree, so the proofs above need no temp dir.
function scanFixture(files) {
  const code = new Map();
  for (const [name, src] of Object.entries(files)) {
    code.set(name, stripReExports(codeOnly(src)).replace(/\.\.\./g, '   '));
  }
  const declared = new Map();
  for (const [f, text] of code) {
    for (const m of text.matchAll(/^(?:export\s+)?(?:const|let|var|function|class)\s+([A-Z][A-Z0-9_]{2,})\b/gm)) {
      if (!declared.has(m[1])) declared.set(m[1], []);
      if (!declared.get(m[1]).includes(f)) declared.get(m[1]).push(f);
    }
  }
  const out = [];
  for (const [f, text] of code) {
    const own = boundNames(text);
    for (const [name, where] of declared) {
      if (own.has(name) || where.includes(f)) continue;
      if (new RegExp(`(?<![.\\w$])${name}(?![\\w$])`).test(text)) {
        out.push(`${f} uses ${name}, declared in ${where.join(', ')} and never imported here`);
      }
    }
  }
  return out;
}
