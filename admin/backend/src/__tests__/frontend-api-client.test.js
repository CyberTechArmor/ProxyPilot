// The frontend API client's ONE calling convention, as a machine check.
//
// `request(endpoint, options)` hands options straight to fetch(). fetch()
// coerces a non-BodyInit body with String(), so a bare object becomes the
// seven-word string "[object Object]" — which express.json() then rejects with
// a SyntaxError carrying status 400, which the backend's global handler reports
// as {"error":"Internal server error"}.
//
// That is exactly what the operator saw when they pressed "Free the first-admin
// slot": a 400 whose body said nothing about the cause, on a button whose whole
// job was to unlock them. Two hand-written methods had `body: {...}` instead of
// `body: JSON.stringify({...})`, and nothing in the repo could have caught it —
// the frontend has no test runner, so this rides in the backend's, which has
// precedent (web-push-logic.test.js).
//
// The rule is small enough to state exactly: inside a request(...) call, `body`
// must be a string expression.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const API_CLIENT = fileURLToPath(new URL('../../../frontend/src/lib/api.js', import.meta.url));

// Comments name body shapes constantly ("body: { item_id, reason }"), and every
// one of them would read as a violation. Blank them first — the same lesson as
// the mock2 import checker, which flagged three call sites that were prose.
function blankComments(src) {
  const out = [];
  let state = 'code';
  for (let i = 0; i < src.length; i++) {
    const c = src[i]; const next = src[i + 1];
    if (state === 'code') {
      if (c === '/' && next === '/') { state = 'line'; out.push(' '); continue; }
      if (c === '/' && next === '*') { state = 'block'; out.push(' '); continue; }
      out.push(c); continue;
    }
    if (state === 'line') { if (c === '\n') state = 'code'; out.push(c === '\n' ? '\n' : ' '); continue; }
    if (c === '*' && next === '/') { out.push(' ', ' '); i++; state = 'code'; continue; }
    out.push(c === '\n' ? '\n' : ' ');
  }
  return out.join('');
}

// A body value is acceptable when it is a string at the point of the call.
const STRINGY = /^(JSON\.stringify\b|`|'|")/;

// The expression after `body:`, with (), {} and [] balanced.
function readValue(rest) {
  const open = { '(': ')', '{': '}', '[': ']' };
  const close = new Set([')', '}', ']']);
  const stack = [];
  let outStr = '';
  for (const ch of rest) {
    if (!stack.length && (ch === ',' || ch === ';')) break;
    if (!stack.length && close.has(ch)) break;
    if (open[ch]) stack.push(open[ch]);
    else if (close.has(ch) && stack[stack.length - 1] === ch) stack.pop();
    outStr += ch;
  }
  return outStr.trim();
}

export function nonStringBodies(rawSrc) {
  const src = blankComments(rawSrc);
  const bad = [];
  const lines = src.split('\n');
  for (const [i, line] of lines.entries()) {
    // BOTH forms. The shorthand `{ method: 'POST', body }` is how the broken
    // method was first written, and a `body:`-only regex walks straight past it.
    const at = line.search(/\bbody\s*[:,}]/);
    if (at === -1) continue;
    const rest = line.slice(at).replace(/^body\s*/, '');
    const value = rest.startsWith(':') ? readValue(rest.slice(1).trim()) : 'body';
    if (STRINGY.test(value)) continue;
    // A raw fetch() may legitimately send a File / FormData / Blob — those are
    // BodyInit and need no serialising. Only request()'s own convention is
    // being enforced here, so scope to lines inside a request( … ) call.
    const window = lines.slice(Math.max(0, i - 4), i + 1).join('\n');
    if (!/\brequest\s*\(/.test(window)) continue;
    bad.push({ line: i + 1, value });
  }
  return bad;
}

test('the checker catches the shape that shipped', () => {
  const buggy = "  mock2FreeFirstAdminSlot: (id) => request(`/x/${id}`, { method: 'POST', body: {} }),\n";
  assert.deepEqual(nonStringBodies(buggy).map((b) => b.value), ['{}']);
  const passed = "  mock2CreateFirstAdmin: (id, body) => request(`/x/${id}`, { method: 'POST', body }),\n";
  assert.deepEqual(nonStringBodies(passed).map((b) => b.value), ['body']);
  const fixed = "  mock2CreateFirstAdmin: (id, body) => request(`/x/${id}`, { method: 'POST', body: JSON.stringify(body) }),\n";
  assert.deepEqual(nonStringBodies(fixed), []);
  // Prose describing a body shape is not a call site.
  assert.deepEqual(nonStringBodies('// body: { item_id, reason }.\n'), []);
});

test('every request() body in the API client is serialised', () => {
  const src = readFileSync(API_CLIENT, 'utf8');
  assert.ok(src.includes('async function request('), 'the API client looks wrong');
  const bad = nonStringBodies(src);
  assert.deepEqual(bad, [],
    bad.length
      ? `request() bodies must be strings — fetch() turns an object into "[object Object]" and the API 400s:\n`
        + bad.map((b) => `  api.js:${b.line} — body: ${b.value}`).join('\n')
      : '');
});
