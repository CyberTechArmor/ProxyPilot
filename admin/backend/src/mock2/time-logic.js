// Mock2 project time tracking — the PURE computation (stub-first testable).
//
// Turns the timestamps already on cycles + framework-deviation queue items into
// the time buckets the Details "Time tracking" card shows. Only ACTIVE-typing
// time needs a stored counter (the client measures it); everything else is
// derived here, so the buckets stay accurate without extra instrumentation.
//
// Buckets:
//   * project start          — project.created_at
//   * time with AI           — sum of cycle run-durations, split by stage:
//       - mockup build        (stage 'concept' cycles)
//       - building the app    (the FIRST app-build cycle)
//       - adjustments         (every later app-build cycle)
//   * time waiting for admin — sum of framework-deviation open→resolved spans
//   * time actively typing   — project.chat_typing_seconds (client-measured)
//
// Timestamps come in two shapes: cycle stamps are ISO (nowIso), queue stamps are
// SQLite datetime('now') ('YYYY-MM-DD HH:MM:SS', UTC). parseTs normalises both to
// epoch ms in UTC so the arithmetic is consistent.

export function parseTs(ts) {
  if (!ts) return null;
  const s = String(ts).trim();
  if (!s) return null;
  // ISO (has a 'T', and usually a 'Z') — parsed as UTC directly.
  if (s.includes('T')) {
    const d = Date.parse(s);
    return Number.isNaN(d) ? null : d;
  }
  // SQLite 'YYYY-MM-DD HH:MM:SS' is UTC — force a UTC parse (a bare space form is
  // otherwise treated as LOCAL time by V8).
  const d = Date.parse(`${s.replace(' ', 'T')}Z`);
  return Number.isNaN(d) ? null : d;
}

// A single cycle's run duration in ms: started_at → finished_at, falling back to
// created_at for the start and `now` for a still-running cycle. Never negative.
function cycleDurationMs(cycle, nowMs) {
  const start = parseTs(cycle.started_at) ?? parseTs(cycle.created_at);
  if (start == null) return 0;
  const end = parseTs(cycle.finished_at) ?? nowMs;
  if (end == null) return 0;
  return Math.max(0, end - start);
}

// computeTimeSummary({ project, cycles, deviations, nowMs }) → the buckets, all
// in whole seconds. `deviations` are the project's framework_deviation queue
// items (raised_at / resolved_at). Pure.
export function computeTimeSummary({ project = {}, cycles = [], deviations = [], nowMs = 0 } = {}) {
  const concept = cycles.filter((c) => c && c.stage === 'concept');
  const appBuilds = cycles
    .filter((c) => c && c.stage !== 'concept')
    .sort((a, b) => (parseTs(a.created_at) || 0) - (parseTs(b.created_at) || 0));

  let mockupMs = 0;
  for (const c of concept) mockupMs += cycleDurationMs(c, nowMs);

  let buildingMs = 0;
  let adjustmentsMs = 0;
  appBuilds.forEach((c, i) => {
    const d = cycleDurationMs(c, nowMs);
    if (i === 0) buildingMs += d;
    else adjustmentsMs += d;
  });

  let adminWaitMs = 0;
  for (const q of deviations) {
    if (!q) continue;
    const start = parseTs(q.raised_at);
    if (start == null) continue;
    const end = q.resolved_at ? parseTs(q.resolved_at) : nowMs;
    if (end != null) adminWaitMs += Math.max(0, end - start);
  }

  const sec = (ms) => Math.round(ms / 1000);
  const typingSeconds = Math.max(0, Math.floor(Number(project.chat_typing_seconds) || 0));
  const ai = {
    mockup_seconds: sec(mockupMs),
    building_seconds: sec(buildingMs),
    adjustments_seconds: sec(adjustmentsMs),
    total_seconds: sec(mockupMs + buildingMs + adjustmentsMs),
  };
  const adminWaitSeconds = sec(adminWaitMs);
  const startMs = parseTs(project.created_at);

  return {
    project_start: project.created_at || null,
    elapsed_seconds: startMs != null ? Math.max(0, sec(nowMs - startMs)) : null,
    typing_seconds: typingSeconds,
    ai,
    admin_wait_seconds: adminWaitSeconds,
    total_tracked_seconds: typingSeconds + ai.total_seconds + adminWaitSeconds,
  };
}

// computeUsageSummary({ cycles }) → the model spend (tokens + cost) a project has
// accrued across its cycles, broken out by the same stage buckets the time card
// uses (mockup / building / adjustments) plus a total. Costs are whole cents (as
// stored on the cycle); tokens are whole tokens. Pure — same stage classification
// as computeTimeSummary so the two cards agree on which cycle is "the first build".
export function computeUsageSummary({ cycles = [] } = {}) {
  const concept = cycles.filter((c) => c && c.stage === 'concept');
  const appBuilds = cycles
    .filter((c) => c && c.stage !== 'concept')
    .sort((a, b) => (parseTs(a.created_at) || 0) - (parseTs(b.created_at) || 0));

  const bucket = () => ({ tokens: 0, cost_cents: 0 });
  const mockup = bucket();
  const building = bucket();
  const adjustments = bucket();

  const add = (b, c) => {
    b.tokens += Math.max(0, Math.round(Number(c.used_tokens) || 0));
    // Cost stays fractional here (rounding per-cycle would re-introduce the
    // sub-cent floor); the client rounds the total for display.
    b.cost_cents += Math.max(0, Number(c.used_cost_cents) || 0);
  };

  for (const c of concept) add(mockup, c);
  appBuilds.forEach((c, i) => add(i === 0 ? building : adjustments, c));

  return {
    by_stage: { mockup, building, adjustments },
    total_tokens: mockup.tokens + building.tokens + adjustments.tokens,
    total_cost_cents: mockup.cost_cents + building.cost_cents + adjustments.cost_cents,
  };
}
