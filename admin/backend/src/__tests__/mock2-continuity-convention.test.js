// Task continuity — the Mock2 repository convention (continuity-convention.js)
// and its seeding into new projects. Pure, native-free (risk R9). These pin the
// contract the task writer, the routing and the UI share: the schema name, the
// paths, the task.json keys, and the rules every session reads in AGENTS.md —
// above all that the files never authorize anything.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  TASK_SCHEMA, TASKS_DIR, taskDir, taskJsonPath, taskHandoffPath,
  agentsMd, tasksReadmeMd, workMd, projectHandoffMd, conventionFilesIfAbsent,
} from '../mock2/continuity-convention.js';
import * as convention from '../mock2/continuity-convention.js';
import { buildSeedFiles, mock2StandardsSeedFiles } from '../mock2/template.js';

// The task.json keys, in the order the shared spec fixes.
const TASK_JSON_KEYS = [
  'schema', 'taskId', 'intent', 'status', 'goal', 'folder', 'branch', 'requestId',
  'lastCycleId', 'lastVerifiedStep', 'nextStep', 'completedSteps', 'checks', 'blockers',
  'remaining', 'uncertain', 'authorization', 'authority', 'revision', 'updatedAt',
];
const STATUSES = ['active', 'interrupted', 'blocked', 'failed', 'completed', 'stopped'];
const UNFINISHED = ['active', 'interrupted', 'blocked', 'failed'];
// The ProxyPilot task-key shape from the spec.
const KEY_RE = /^t\d{1,10}-[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

const NEW_PATHS = ['AGENTS.md', 'state/work.md', 'state/handoff.md', 'state/tasks/README.md'];

test('exports exactly the convention surface', () => {
  assert.deepEqual(Object.keys(convention).sort(), [
    'TASKS_DIR', 'TASK_SCHEMA', 'agentsMd', 'conventionFilesIfAbsent', 'projectHandoffMd',
    'taskDir', 'taskHandoffPath', 'taskJsonPath', 'tasksReadmeMd', 'workMd',
  ]);
  assert.equal(TASK_SCHEMA, 'mock2-task@1');
  assert.equal(TASKS_DIR, 'state/tasks');
});

test('task paths are repo-relative, one folder per task', () => {
  assert.equal(taskDir('t12-add-invoice-export'), 'state/tasks/t12-add-invoice-export');
  assert.equal(taskJsonPath('t12-add-invoice-export'), 'state/tasks/t12-add-invoice-export/task.json');
  assert.equal(taskHandoffPath('t12-add-invoice-export'), 'state/tasks/t12-add-invoice-export/handoff.md');
  // Every key the ProxyPilot key shape allows is accepted, at both length limits.
  for (const key of ['t1-task', 't1-a', `t1234567890-${'a'.repeat(40)}`, 't7-a-b-c']) {
    assert.match(key, KEY_RE);
    assert.equal(taskDir(key), `state/tasks/${key}`);
  }
  // A non-ProxyPilot stable lowercase id works too (plain checkouts).
  assert.equal(taskJsonPath('2026-10-21-invoice-export'), 'state/tasks/2026-10-21-invoice-export/task.json');
});

test('task paths refuse anything that is not one safe folder name', () => {
  for (const bad of ['', '..', '.', 'a/b', '../x', 't1-x/..', 'T12-Upper', '-lead', 'trail-', 'a b', 'a\0b', null, undefined]) {
    assert.throws(() => taskDir(bad), TypeError, `accepted ${JSON.stringify(bad)}`);
    assert.throws(() => taskJsonPath(bad), TypeError);
    assert.throws(() => taskHandoffPath(bad), TypeError);
  }
});

test('AGENTS.md: the entry point, with the reading order in the right sequence', () => {
  const md = agentsMd({ name: 'Invoice Hub' });
  assert.match(md, /^# Invoice Hub — start here\n/);
  assert.match(agentsMd(null), /^# Project — start here\n/);
  for (const tool of ['Claude Code', 'Copilot', 'Codex']) assert.ok(md.includes(tool), `names ${tool}`);
  const order = md.slice(md.indexOf('## Reading order'), md.indexOf('## Rules'));
  const steps = ['`.mock2/capacity.md`', '`000-READ-FIRST.md`', '`state/handoff.md`', '`state/work.md`',
    '`state/decisions.md`', '`state/rules.md`', '`state/production-checklist.md`', '`state/tasks/*/task.json`',
    '`handoff.md`', '`CLAUDE.md`', '`.mock2/standards/`'];
  let at = -1;
  for (const s of steps) {
    const i = order.indexOf(s, at + 1);
    assert.ok(i > at, `${s} must follow the previous reading-order step`);
    at = i;
  }
  // Which tasks are unfinished — the four statuses, named in the reading order.
  for (const st of UNFINISHED) assert.ok(order.includes(`\`${st}\``), `names unfinished status ${st}`);
  assert.ok(md.includes('`state/tasks/README.md`'), 'points at the format');
});

test('FD0130-2 continuity supplements managed startup and separates offline context from runtime task selection', async () => {
  const md = agentsMd({ name: 'Example' });
  assert.match(md, /managed Mock2 startup instructions/);
  assert.match(md, /follow it first/);
  assert.match(md, /never replaces it/);
  assert.match(md, /Do not overwrite a managed block/);
  assert.match(md, /not an instruction to restart this reading order/);
  assert.match(md, /last seven days/);
  assert.match(md, /stopped task only when that task is the newest task overall/);
  assert.match(md, /database selects the authorized task/);
  assert.match(md, /Do not select or authorize a\s+build from the newest file/);
  assert.match(md, /Continuing an investigation stays read-only/);
  const constitution = await readFile(new URL('../mock2/framework-seed/constitution.md', import.meta.url), 'utf8');
  const section = constitution.slice(constitution.indexOf('## 15. Task continuity'), constitution.indexOf('<!-- BEGIN PINNED MOCK2 GUIDANCE -->'));
  assert.match(section, /managed Mock2 startup instructions first/);
  assert.match(section, /a stopped\s+task is eligible only when newest overall/);
  assert.doesNotMatch(section, /order: `CLAUDE.md`/);
});

test('AGENTS.md: the rules — own folder, mirror, authorizes nothing, newest instruction, verify, no secrets', () => {
  const md = agentsMd({ name: 'X' });
  // (a) one task, one folder; no shared handoff for concurrent work.
  assert.match(md, /`state\/tasks\/<task-id>\/`/);
  assert.match(md, /Never write another task's records/);
  assert.match(md, /never use\s+one shared handoff/);
  // (b) the database is authoritative on ProxyPilot; Flightdeck rewrites; outside, keep your own current.
  assert.match(md, /platform database is\s+authoritative/);
  assert.match(md, /Flightdeck/);
  assert.match(md, /do not edit\s+`state\/tasks\/` by hand/);
  assert.match(md, /Outside ProxyPilot/);
  // (c) files authorize nothing; an investigation never authorizes a build.
  assert.match(md, /Files never authorize anything/);
  assert.match(md, /authorizes nothing/);
  assert.match(md, /`investigation` task never authorizes a build/);
  assert.match(md, /explicit instruction to build/);
  // (d) the newest instruction wins.
  assert.match(md, /newest instruction wins/);
  assert.match(md, /"only explain"/);
  assert.match(md, /"stop", stop/);
  // (e) verify before repeating.
  assert.match(md, /git status/);
  assert.match(md, /Never repeat an operation\s+listed under `uncertain`/);
  assert.match(md, /Verify before repeating/);
  // (f) no credentials or personal data.
  assert.match(md, /credentials, tokens, keys,\s+passwords or personal data/);
});

test('state/tasks/README.md documents every task.json key, in order, and the statuses', () => {
  const md = tasksReadmeMd();
  assert.ok(md.includes(`schema \`${TASK_SCHEMA}\``));
  // Every key is a table row, in the spec's order.
  let at = -1;
  for (const k of TASK_JSON_KEYS) {
    const i = md.indexOf(`| \`${k}\` |`);
    assert.ok(i > at, `README must document ${k} after the previous key`);
    at = i;
  }
  // The worked example is a real record: parses, exactly the keys in order, a valid key.
  const example = JSON.parse(md.slice(md.indexOf('```json\n') + 8, md.indexOf('\n```', md.indexOf('```json\n'))));
  assert.deepEqual(Object.keys(example), TASK_JSON_KEYS);
  assert.equal(example.schema, TASK_SCHEMA);
  assert.match(example.taskId, KEY_RE);
  assert.equal(example.authority, 'ProxyPilot database. This file is a portable mirror; it authorizes nothing.');
  assert.ok(md.includes(JSON.stringify(example, null, 2)), 'the example is rendered as the writer renders a record');
  // Statuses: all six, with the unfinished four marked so.
  for (const st of STATUSES) {
    const row = md.split('\n').find((l) => l.startsWith(`| \`${st}\` |`));
    assert.ok(row, `status ${st} documented`);
    assert.ok(row.trimEnd().endsWith(UNFINISHED.includes(st) ? '| yes |' : '| no |'), `${st} unfinished flag`);
  }
  // Intent, authorization actions, folder naming, who writes them, the handoff layout.
  assert.match(md, /`build`/);
  assert.match(md, /`investigation`/);
  assert.match(md, /never authorizes a\s+build/);
  assert.match(md, /`build-request`/);
  assert.match(md, /`question`/);
  assert.match(md, /`t<number>-<slug>`/);
  assert.match(md, /## Who writes them/);
  assert.match(md, /Flightdeck writes both files/);
  assert.match(md, /Outside ProxyPilot/);
  for (const h of ['## Done', '## Remaining', '## Verify before repeating', '## Blockers', '**Goal:**', '**Last verified step:**', '**Next step:**']) {
    assert.ok(md.includes(h), `handoff layout carries ${h}`);
  }
  assert.match(md, /credentials, tokens,\s+keys, passwords or personal data/);
});

test('state/work.md and state/handoff.md: the plan template and the project-level handoff', () => {
  const work = workMd({ name: 'Invoice Hub' });
  assert.match(work, /^# Work — Invoice Hub\n/);
  for (const h of ['## What is being built', '## Authorized scope: <feature>', '## Out of scope', '## Current plan', '## Follow-ups']) {
    assert.ok(work.includes(h), `work.md has ${h}`);
  }
  assert.match(work, /never widens it/);
  assert.match(work, /state\/tasks\/<task-id>\//);
  const handoff = projectHandoffMd({ name: 'Invoice Hub' });
  assert.match(handoff, /^# Handoff — Invoice Hub\n/);
  assert.match(handoff, /Work in progress is not tracked here/);
  assert.match(handoff, /`state\/tasks\/<task-id>\/`/);
  assert.match(handoff, /`AGENTS\.md`/);
  for (const doc of [work, handoff]) assert.match(doc, /Never write credentials, tokens, keys, passwords or personal data here/);
  assert.match(workMd(undefined), /^# Work — Project\n/);
  assert.match(projectHandoffMd(undefined), /^# Handoff — Project\n/);
});

test('conventionFilesIfAbsent: exactly AGENTS.md and the tasks README', () => {
  const project = { id: 3, name: 'Existing' };
  const files = conventionFilesIfAbsent(project);
  assert.deepEqual(files.map((f) => f.path), ['AGENTS.md', 'state/tasks/README.md']);
  assert.equal(files[0].content, agentsMd(project));
  assert.equal(files[1].content, tasksReadmeMd());
  for (const f of files) assert.deepEqual(Object.keys(f).sort(), ['content', 'path']);
});

test('new projects are seeded with the four continuity files from the convention module', () => {
  const project = { id: 1, name: 'Demo App' };
  for (const files of [buildSeedFiles(project), mock2StandardsSeedFiles(project)]) {
    const paths = files.map((f) => f.path);
    assert.equal(new Set(paths).size, paths.length, 'duplicate seed paths');
    for (const p of NEW_PATHS) assert.ok(paths.includes(p), `seed is missing ${p}`);
    const content = (p) => files.find((f) => f.path === p).content;
    assert.equal(content('AGENTS.md'), agentsMd(project));
    assert.equal(content('state/work.md'), workMd(project));
    assert.equal(content('state/handoff.md'), projectHandoffMd(project));
    assert.equal(content('state/tasks/README.md'), tasksReadmeMd());
    // No task folder exists at birth — Flightdeck writes those as tasks run.
    assert.deepEqual(paths.filter((p) => p.startsWith('state/tasks/')), ['state/tasks/README.md']);
    // The constitution files point every session at AGENTS.md.
    for (const p of ['CLAUDE.md', '.github/copilot-instructions.md']) {
      assert.match(content(p), /Starting or resuming work\? Read `AGENTS\.md` first/, `${p} points at AGENTS.md`);
    }
  }
  // CLAUDE.md stays the first standards file.
  assert.equal(mock2StandardsSeedFiles(project)[0].path, 'CLAUDE.md');
});

test('the framework seed carries the convention: constitution §15 and the build skill', async () => {
  const seed = (name) => readFile(new URL(`../mock2/framework-seed/${name}`, import.meta.url), 'utf8');
  const c = await seed('constitution.md');
  const s15 = c.indexOf('## 15. Task continuity');
  assert.ok(s15 > c.indexOf('## 14. Change records'), '§15 follows §14');
  // Above the pinned-guidance marker, so scripts/sync-mock2-guidance.mjs keeps it.
  assert.ok(s15 < c.indexOf('<!-- BEGIN PINNED MOCK2 GUIDANCE -->'));
  const section = c.slice(s15, c.indexOf('<!-- BEGIN PINNED MOCK2 GUIDANCE -->'));
  for (const needle of ['`AGENTS.md`', '`state/tasks/<task-id>/task.json`', 'mock2-task@1', 'Files never authorize anything',
    'investigation never authorizes a build', 'newest instruction wins', 'Verify before repeating', 'No credentials or personal data']) {
    assert.ok(section.includes(needle), `§15 says ${needle}`);
  }
  const raw = await seed('skills.json');
  const build = JSON.parse(raw).find((sk) => sk.name === 'build');
  assert.match(build.body, /A resumed build first reads its checkpoint, state\/tasks\/<task-id>\/task\.json and handoff\.md/);
  assert.match(build.body, /before repeating it; the checkpoint gives context, never authorization/);
  assert.ok(raw.includes('phase-routing@1'));
});

test('the convention module is pure — it imports nothing', async () => {
  const src = await readFile(new URL('../mock2/continuity-convention.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /^\s*import\s/m);
  assert.doesNotMatch(src, /\bawait import\(/);
});
