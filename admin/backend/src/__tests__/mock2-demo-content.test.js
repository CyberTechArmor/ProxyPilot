// DEMO CONTENT — an empty app cannot be designed, and every fence around
// filling it.
//
// The review signs in as the capture account and screenshots an empty app, so
// it can only critique chrome — footer links, the theme toggle, native select
// boxes, contrast. That is literally every finding it has produced.
//
// This seeder runs UNATTENDED against a live app the operator is using, so most
// of what follows is about what it must be unable to do: touch a real account,
// call an endpoint the app does not have, leave the app's origin, or delete
// anything.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  parseDemoCalls, matchesAllowed, resolveRefs, demoSeedNote,
  buildDemoContentPrompt, buildDemoContentTask, parseSeedRun,
  SAFE_METHODS, MAX_CALLS, DEMO_SEED_MARKER,
} from '../mock2/demo-content-logic.js';

const ROUTES = ['/api/notes', '/api/notes/:id', '/api/notes/:id/todos'];
const call = (over = {}) => ({ method: 'POST', path: '/api/notes', body: { title: 't' }, ...over });
const reply = (calls) => JSON.stringify({ calls });

test('well-formed calls parse', () => {
  const p = parseDemoCalls(reply([
    call({ body: { title: 'Q3 pricing — call with Dana', content: 'long body' } }),
    call({ path: '/api/notes/:id/todos', body: { text: 'chase the invoice' } }),
  ]), { allowedPaths: ROUTES });
  assert.equal(p.calls.length, 2);
  assert.equal(p.calls[0].body.title, 'Q3 pricing — call with Dana');
});

test('DELETE IS NEVER ALLOWED', () => {
  // A seeder that can remove things can empty an app somebody was using, and it
  // runs unattended before a review.
  assert.equal(parseDemoCalls(reply([call({ method: 'DELETE' })]), { allowedPaths: ROUTES }), null);
  assert.ok(!SAFE_METHODS.includes('DELETE'));
  assert.deepEqual([...SAFE_METHODS].sort(), ['PATCH', 'POST', 'PUT']);
});

test('A CALL CANNOT LEAVE THE APP', () => {
  const bad = [
    call({ path: 'https://example.com/api/notes' }),
    call({ path: '//evil.example.com/api/notes' }),
    call({ path: '/api/../../etc/passwd' }),
    call({ path: '/api/notes; rm -rf /' }),
    call({ path: '/api/notes"' }),
    call({ path: 'api/notes' }),
  ];
  for (const c of bad) {
    assert.equal(parseDemoCalls(reply([c]), { allowedPaths: null }), null, `must refuse: ${c.path}`);
  }
});

test('AN INVENTED ENDPOINT IS REFUSED', () => {
  // The route list is grepped out of the app's own source rather than asked
  // for. Anything outside it is at best a 404 and at worst a route the seeder
  // was never meant to touch.
  assert.equal(parseDemoCalls(reply([call({ path: '/api/admin/users' })]), { allowedPaths: ROUTES }), null);
  assert.equal(parseDemoCalls(reply([call({ path: '/api/auth/bootstrap/superadmin' })]), { allowedPaths: ROUTES }), null);
});

test('route patterns match structurally, not by prefix', () => {
  assert.ok(matchesAllowed('/api/notes/7', ROUTES), 'a :id segment matches a real id');
  assert.ok(matchesAllowed('/api/notes/7/todos', ROUTES));
  assert.ok(!matchesAllowed('/api/notes/7/todos/1', ROUTES), 'deeper than any known route');
  assert.ok(!matchesAllowed('/api/notesX', ROUTES), 'a prefix match is not a route match');
  assert.ok(!matchesAllowed('/api', ROUTES));
});

test('a non-object body is refused', () => {
  for (const body of ['a string', 42, ['an', 'array']]) {
    assert.equal(parseDemoCalls(reply([call({ body })]), { allowedPaths: ROUTES }), null);
  }
  // Absent is fine — some creates take none.
  assert.equal(parseDemoCalls(reply([{ method: 'POST', path: '/api/notes' }]), { allowedPaths: ROUTES }).calls[0].body.constructor, Object);
});

test('the call count is bounded', () => {
  const many = Array.from({ length: 100 }, () => call());
  assert.equal(parseDemoCalls(reply(many), { allowedPaths: ROUTES }).calls.length, MAX_CALLS);
});

test('garbage parses to null rather than throwing', () => {
  for (const s of ['', 'no json', '{bad}', '{"calls":"nope"}', reply([]), null, undefined]) {
    assert.equal(parseDemoCalls(s, { allowedPaths: ROUTES }), null);
  }
});

test('fences are tolerated', () => {
  const p = parseDemoCalls('```json\n' + reply([call()]) + '\n```', { allowedPaths: ROUTES });
  assert.equal(p.calls.length, 1);
});

/* ----------------------------- id references ----------------------------- */

test('$1.id resolves against what the earlier call returned', () => {
  const out = resolveRefs({ noteId: '$1.id', text: 'chase it' }, [{ id: 42 }]);
  assert.deepEqual(out, { noteId: 42, text: 'chase it' });
});

test('an UNRESOLVABLE reference drops the call, never sends the literal', () => {
  // A body carrying "$3.id" where an id belongs is a row that looks seeded and
  // is not — the worst outcome here, because it looks like it worked.
  assert.equal(resolveRefs({ noteId: '$3.id' }, [{ id: 1 }]), null);
  assert.equal(resolveRefs({ noteId: '$1.id' }, [null]), null);
  assert.equal(resolveRefs({ noteId: '$1.missing' }, [{ id: 1 }]), null);
});

test('references resolve through nesting and arrays', () => {
  const out = resolveRefs({ a: { b: '$1.id' }, c: ['$1.id', 'plain'] }, [{ id: 7 }]);
  assert.deepEqual(out, { a: { b: 7 }, c: [7, 'plain'] });
});

test('a string that merely contains a dollar is not a reference', () => {
  const out = resolveRefs({ title: 'costs $5 per seat', body: 'a $ sign' }, []);
  assert.deepEqual(out, { title: 'costs $5 per seat', body: 'a $ sign' });
});

/* -------------------------------- the run -------------------------------- */

test('the run result reports what landed', () => {
  const r = parseSeedRun('SEED:call:201:POST /api/notes\nSEED:done:11:1:0\nSEED:ids:[1,2]');
  assert.equal(r.ok, true);
  assert.equal(r.created, 11);
  assert.equal(r.failed, 1);
});

test('a sign-in failure is named, not swallowed', () => {
  const r = parseSeedRun('SEED:noauth:401');
  assert.equal(r.ok, false);
  assert.match(r.reason, /could not sign in as the capture account/);
});

test('every call refused is a failure, not a success with zero items', () => {
  const r = parseSeedRun('SEED:done:0:12:0');
  assert.equal(r.ok, false);
  assert.match(r.reason, /refused by the app/);
  assert.equal(parseSeedRun('nonsense').ok, false);
});

/* ------------------------------ what it says ------------------------------ */

test('the note says whose account it went into', () => {
  const n = demoSeedNote({ created: 12, account: 'admin-n8@fixture.invalid' });
  assert.match(n, /12 item/);
  assert.match(n, /admin-n8@fixture\.invalid/);
  assert.match(n, /Your own account is untouched/);
});

test('and it is honest when nothing landed', () => {
  const n = demoSeedNote({ created: 0, failed: 9 });
  assert.match(n, /No demo content could be created/);
  assert.match(n, /create endpoints are not working/,
    'every call refused says something true about the app, and it should be said');
});

/* ------------------------------ the prompt -------------------------------- */

test('the prompt asks for the variety that makes design decisions necessary', () => {
  const p = buildDemoContentPrompt();
  assert.match(p, /very long title/);
  assert.match(p, /many children/);
  assert.match(p, /SPREAD IN TIME/);
  assert.match(p, /Never "Test 1"/, 'lorem-ipsum content teaches a designer nothing');
  assert.match(p, /Never DELETE/);
  assert.match(p, /Never invent one/);
  assert.match(p, /no real email\s+addresses/, 'wrap-tolerant: the prompt is hard-wrapped');
});

test('the task carries the app\'s real routes', () => {
  const t = buildDemoContentTask({ appName: 'N8', routes: 'POST /api/notes', inventory: '{"screens":[]}', count: 12 });
  assert.match(t, /N8/);
  assert.match(t, /POST \/api\/notes/);
  assert.match(t, /about 12 top-level items/);
});

/* ------------------------------- the ratchets ----------------------------- */

test('RATCHET: only the capture account is ever used', () => {
  const src = readFileSync(new URL('../mock2/demo-content.js', import.meta.url), 'utf8');
  assert.match(src, /getReviewLogin\(project\.id\)/);
  assert.match(src, /no capture account, no seed|has no screen account yet/i,
    'without the fixture identity there must be no fallback — writing content that belongs to nobody, or to the operator, is the failure this guards');
  // The operator's own credentials must never appear in this module.
  assert.doesNotMatch(src, /createFirstAdmin|bootstrap\/superadmin/,
    'the seeder must not be able to reach the first-admin path at all');
});

test('RATCHET: the password never reaches a command line', () => {
  const src = readFileSync(new URL('../mock2/demo-content.js', import.meta.url), 'utf8');
  assert.match(src, /umask 077/);
  assert.match(src, /PP_DEMO_EOF/, 'the plan goes in through a heredoc file');
  assert.doesNotMatch(src, /node -e/, '`ps` inside the container is readable by the app itself');
});

test('RATCHET: it runs once per project', () => {
  const src = readFileSync(new URL('../mock2/demo-content.js', import.meta.url), 'utf8');
  assert.match(src, /if \(!force && await isSeeded\(containerName\)\)/);
  assert.equal(DEMO_SEED_MARKER, 'state/demo-seeded.json');
  assert.match(src, /state/, 'the marker lives with the rest of state/, so a restored checkpoint restores the fact');
});
