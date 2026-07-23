// Lean BEAF Pro — business-metrics band + data-source connections.
//
// The redesign concept introduces a leadership-facing metrics band on the
// dashboard: Volume & capacity, Charge per visit, Attributed lives, and Per
// appointment cost, plus four "levers" (Volume / Charge / Efficiency /
// Experience) that frame every innovation project against the numbers it is
// meant to move.
//
// None of the real data sources are wired up yet. So until an operator
// connects one (Admin → Connections), this module returns DUMMY sample
// figures — clearly flagged `sample: true` so the UI can label them "sample
// data, not yet connected". When a real feed lands, the shape below is what it
// populates; the dashboard code does not change.
//
// Connections are a placeholder: each data source can be marked connected /
// disconnected with an endpoint + note, stored as one JSON blob in
// app_settings (`lbp_connections`). No live integration runs — this is the
// surface where those connections will be made.

import { getSetting, setSetting } from '../db.js';

const CONNECTIONS_KEY = 'lbp_connections';

// The data sources the metrics band will eventually draw from. Each names the
// band figures / lever it feeds so the Connections screen can explain what
// wiring it up unlocks. Static catalog — connection STATE lives separately.
export const LBP_DATA_SOURCES = Object.freeze([
  {
    key: 'ehr',
    label: 'EHR / Practice Management',
    category: 'Clinical',
    description: 'Encounters, charges and appointment records — the system of record for visit volume and charge per visit.',
    feeds: ['Volume & capacity', 'Charge per visit'],
  },
  {
    key: 'scheduling',
    label: 'Scheduling & templates',
    category: 'Operations',
    description: 'Provider templates and booked slots by day — the capacity denominator behind utilization.',
    feeds: ['Volume & capacity'],
  },
  {
    key: 'attribution',
    label: 'Payer attribution roster',
    category: 'Payer',
    description: 'Attributed / assigned lives by payer, with attribution dates — powers the attributed-lives recency stack.',
    feeds: ['Attributed lives'],
  },
  {
    key: 'cost_accounting',
    label: 'Cost accounting / GL',
    category: 'Finance',
    description: 'Allocated cost per appointment by service line (Primary / Specialty / Diagnostic).',
    feeds: ['Per appointment cost'],
  },
  {
    key: 'experience',
    label: 'Patient experience surveys',
    category: 'Experience',
    description: 'Post-visit survey scores and response rates — the Experience lever.',
    feeds: ['Experience lever'],
  },
]);

const VALID_SOURCE_KEYS = new Set(LBP_DATA_SOURCES.map((s) => s.key));

// ---- connections (placeholder state) ----

function readConnections() {
  const raw = getSetting(CONNECTIONS_KEY);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

// The full connections view: every catalog source merged with its saved
// placeholder state (defaulting to "not connected"). Never returns anything
// secret — this is a placeholder, endpoints/notes are plain config.
export function getConnections() {
  const saved = readConnections();
  return LBP_DATA_SOURCES.map((source) => {
    const state = saved[source.key] || {};
    return {
      ...source,
      status: state.status === 'connected' ? 'connected' : 'disconnected',
      endpoint: state.endpoint || null,
      notes: state.notes || null,
      updated_at: state.updated_at || null,
      updated_by: state.updated_by || null,
    };
  });
}

// Save the placeholder config for one source. Returns the merged view (same
// shape as getConnections). No live connection is attempted — this only
// records intent so the wiring can be built against it later.
export function saveConnection(key, { status, endpoint, notes, updatedBy = null, updatedAt } = {}) {
  if (!VALID_SOURCE_KEYS.has(key)) return null;
  const saved = readConnections();
  const prev = saved[key] || {};
  saved[key] = {
    status: status === 'connected' ? 'connected' : 'disconnected',
    endpoint: endpoint !== undefined ? (endpoint || null) : (prev.endpoint || null),
    notes: notes !== undefined ? (notes || null) : (prev.notes || null),
    updated_at: updatedAt || new Date().toISOString(),
    updated_by: updatedBy,
  };
  setSetting(CONNECTIONS_KEY, JSON.stringify(saved));
  return getConnections().find((c) => c.key === key) || null;
}

// ---- dummy dashboard metrics ----

// Every figure below is illustrative placeholder data. It is deterministic
// (no clocks / randomness) so screenshots and tests are stable, and it is
// tagged `sample: true` at the top level so the UI always labels it as not
// yet connected. Connecting a real source (above) is what will replace it.
export function sampleDashboardMetrics() {
  return {
    sample: true,
    note: 'Sample figures — no data source is connected yet. Connect one under Admin → Connections to see live numbers.',
    band: {
      volume: {
        label: 'Volume & capacity',
        period: 'Last 30 days',
        total: 1284,
        unit: 'visits',
        delta_pct: 6.4,
        capacity_pct: 78,
        // Booked vs available slots by weekday — the bullet chart.
        per_day: [
          { day: 'Mon', booked: 268, capacity: 300 },
          { day: 'Tue', booked: 291, capacity: 300 },
          { day: 'Wed', booked: 254, capacity: 300 },
          { day: 'Thu', booked: 279, capacity: 300 },
          { day: 'Fri', booked: 192, capacity: 260 },
        ],
      },
      charge_per_visit: {
        label: 'Charge per visit',
        unit: 'USD',
        value: 214.5,
        delta_pct: 2.1,
        // 6-point trend for a sparkline.
        spark: [198, 202, 205, 210, 208, 214.5],
      },
      attributed_lives: {
        label: 'Attributed lives',
        value: 8420,
        delta_pct: 1.2,
        // How fresh attribution is — the recency stack.
        recency: [
          { label: '≤30d', value: 5100 },
          { label: '31–90d', value: 2200 },
          { label: '>90d', value: 1120 },
        ],
      },
      per_appointment_cost: {
        label: 'Per appointment cost',
        unit: 'USD',
        // Segmented control: Primary / Specialty / Diagnostic.
        segments: [
          { key: 'primary', label: 'Primary', value: 86.2, delta_pct: -1.4 },
          { key: 'specialty', label: 'Specialty', value: 142.75, delta_pct: 0.8 },
          { key: 'diagnostic', label: 'Diagnostic', value: 208.4, delta_pct: -3.1 },
        ],
      },
    },
    // The four levers every project is framed against. `dot` is a color token;
    // `status` drives the badge (on_track / watch / off_track).
    levers: [
      {
        key: 'volume', label: 'Volume', dot: 'blue', status: 'on_track',
        current: 1284, target: 1350, unit: 'visits',
        summary: 'Booked visits trending up; Friday capacity is the soft spot.',
      },
      {
        key: 'charge', label: 'Charge', dot: 'green', status: 'on_track',
        current: 214.5, target: 220, unit: 'USD',
        summary: 'Charge per visit up 2.1% — coding accuracy work is paying off.',
      },
      {
        key: 'efficiency', label: 'Efficiency', dot: 'amber', status: 'watch',
        current: 142.75, target: 130, unit: 'USD',
        summary: 'Specialty cost per appointment above target — automation projects here.',
      },
      {
        key: 'experience', label: 'Experience', dot: 'purple', status: 'on_track',
        current: 4.6, target: 4.5, unit: '/5',
        summary: 'Survey scores holding at 4.6; response rate is the next push.',
      },
    ],
  };
}
