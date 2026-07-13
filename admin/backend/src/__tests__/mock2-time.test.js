// Pure project time-tracking logic: timestamp parsing (ISO + SQLite UTC) and the
// derived time buckets (mockup / building / adjustments / admin-wait / typing).

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTs, computeTimeSummary } from '../mock2/time-logic.js';

test('parseTs handles ISO and SQLite-UTC, treating the bare form as UTC', () => {
  assert.equal(parseTs('2026-07-13T18:00:00.000Z'), Date.UTC(2026, 6, 13, 18, 0, 0));
  assert.equal(parseTs('2026-07-13 18:00:00'), Date.UTC(2026, 6, 13, 18, 0, 0)); // SQLite datetime('now')
  assert.equal(parseTs(''), null);
  assert.equal(parseTs(null), null);
  assert.equal(parseTs('not a date'), null);
});

test('computeTimeSummary: concept→mockup, first build→building, rest→adjustments', () => {
  const base = Date.UTC(2026, 6, 13, 18, 0, 0);
  const iso = (ms) => new Date(ms).toISOString();
  const cycles = [
    { stage: 'concept', created_at: iso(base), started_at: iso(base), finished_at: iso(base + 60_000) },      // 60s mockup
    { stage: 'concept', created_at: iso(base + 100_000), started_at: iso(base + 100_000), finished_at: iso(base + 130_000) }, // 30s mockup
    { stage: 'build', created_at: iso(base + 200_000), started_at: iso(base + 200_000), finished_at: iso(base + 320_000) },   // 120s building (first build)
    { stage: 'build', created_at: iso(base + 400_000), started_at: iso(base + 400_000), finished_at: iso(base + 445_000) },   // 45s adjustments
    { stage: 'remediation', created_at: iso(base + 500_000), started_at: iso(base + 500_000), finished_at: iso(base + 515_000) }, // 15s adjustments
  ];
  const deviations = [
    { raised_at: '2026-07-13 18:10:00', resolved_at: '2026-07-13 18:13:00' }, // 180s admin wait
  ];
  const project = { created_at: iso(base), chat_typing_seconds: 42 };
  const s = computeTimeSummary({ project, cycles, deviations, nowMs: base + 600_000 });

  assert.equal(s.ai.mockup_seconds, 90);        // 60 + 30
  assert.equal(s.ai.building_seconds, 120);     // first build only
  assert.equal(s.ai.adjustments_seconds, 60);   // 45 + 15
  assert.equal(s.ai.total_seconds, 270);
  assert.equal(s.admin_wait_seconds, 180);
  assert.equal(s.typing_seconds, 42);
  assert.equal(s.total_tracked_seconds, 42 + 270 + 180);
  assert.equal(s.project_start, iso(base));
  assert.equal(s.elapsed_seconds, 600);
});

test('computeTimeSummary: a running cycle and an open deviation count up to now', () => {
  const base = Date.UTC(2026, 6, 13, 12, 0, 0);
  const iso = (ms) => new Date(ms).toISOString();
  const now = base + 90_000;
  const cycles = [
    { stage: 'build', created_at: iso(base), started_at: iso(base), finished_at: null }, // running → 90s
  ];
  const deviations = [
    { raised_at: '2026-07-13 12:00:30', resolved_at: null }, // open → 60s
  ];
  const s = computeTimeSummary({ project: { created_at: iso(base), chat_typing_seconds: 0 }, cycles, deviations, nowMs: now });
  assert.equal(s.ai.building_seconds, 90);
  assert.equal(s.admin_wait_seconds, 60);
});

test('computeTimeSummary: empty inputs are all zero, no throw', () => {
  const s = computeTimeSummary({ project: {}, cycles: [], deviations: [], nowMs: Date.now() });
  assert.equal(s.ai.total_seconds, 0);
  assert.equal(s.admin_wait_seconds, 0);
  assert.equal(s.typing_seconds, 0);
  assert.equal(s.total_tracked_seconds, 0);
  assert.equal(s.project_start, null);
  assert.equal(s.elapsed_seconds, null);
});
