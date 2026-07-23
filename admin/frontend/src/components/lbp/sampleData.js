// Lean BEAF Pro — in-memory sample workspace for the redesigned Dashboard,
// Meetings and List views. The business metrics come from data sources that
// are not connected yet (see Admin → Connections), so everything here is
// illustrative sample data — deliberately shaped to demo the whole UI:
// five active projects, two archived, a live threshold breach, a since-meeting
// digest, and a weekly-focus state. Deterministic (no clocks/randomness).
//
// BEAF = Better / Easier / Automated / Faster. Levers = the four goal
// categories every project is tagged against; they are the connective tissue
// between "which number moved" (metrics) and "what we're doing about it"
// (projects).

// ---- levers (goal categories) ----

export const LEVERS = {
  volume: {
    key: 'volume', label: 'Volume', blurb: 'More patients in the door — referrals, access, booking',
    dot: 'bg-blue-500', text: 'text-blue-600 dark:text-blue-400', chip: 'bg-blue-500/10 text-blue-600 dark:text-blue-400',
    underline: 'bg-blue-500', ring: 'ring-blue-500', border: 'border-blue-500', soft: 'bg-blue-500/5',
  },
  charge: {
    key: 'charge', label: 'Charge', blurb: 'Complete procedures & capture charge — stock, uptime, awareness',
    dot: 'bg-orange-500', text: 'text-orange-600 dark:text-orange-400', chip: 'bg-orange-500/10 text-orange-600 dark:text-orange-400',
    underline: 'bg-orange-500', ring: 'ring-orange-500', border: 'border-orange-500', soft: 'bg-orange-500/5',
  },
  efficiency: {
    key: 'efficiency', label: 'Efficiency', blurb: 'Save time & cost — a new item, process, or automation',
    dot: 'bg-emerald-500', text: 'text-emerald-600 dark:text-emerald-400', chip: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
    underline: 'bg-emerald-500', ring: 'ring-emerald-500', border: 'border-emerald-500', soft: 'bg-emerald-500/5',
  },
  experience: {
    key: 'experience', label: 'Experience', blurb: 'Patients show up, and are seen when they should be',
    dot: 'bg-amber-400', text: 'text-amber-600 dark:text-amber-400', chip: 'bg-amber-400/10 text-amber-600 dark:text-amber-400',
    underline: 'bg-amber-400', ring: 'ring-amber-400', border: 'border-amber-400', soft: 'bg-amber-400/5',
  },
};

export const LEVER_ORDER = ['volume', 'charge', 'efficiency', 'experience'];

export const STAGES = ['Idea', 'MVP', 'Testing', 'Site', 'POD', 'Region', 'All'];

// ---- projects (active) ----
// status: { kind: 'moved' | 'blocked' | 'idle', days? }
// key_metric: { value, label, unit, delta, dir: 'up'|'down', good: 'up'|'down' } | null
// trend: number[] (latest last) | []

export const SAMPLE_PROJECTS = [
  {
    id: 'p-selfsched', name: 'Online self-scheduling', beaf: ['Easier', 'Automated'],
    levers: ['volume', 'experience'], stage: 'Testing', owner: 'DK',
    started: '2026-05-12', in_stage_days: 1, status: { kind: 'moved' },
    key_metric: { value: 31, label: 'Appointments self-booked', unit: '%', delta: 27, dir: 'up', good: 'up' },
    trend: [4, 9, 12, 18, 22, 27, 31],
    description: 'Let patients book, move, and cancel their own appointments from the reminder text link instead of calling the front desk. Connects the scheduler to the PMS so slots stay in sync.',
    scope: { testing: 'Front desk + 20 pilot patients @ Springfield', site: 'Springfield', pods: ['Central'], region: null },
    metrics: [
      { name: 'Appointments self-booked', source: 'Scheduler DB · weekly export', target: null, unit: '%', value: 31, delta: 27, dir: 'up', good: 'up', since: 'since start', trend: [4, 9, 12, 18, 22, 27, 31] },
      { name: 'No-show rate', source: 'PMS monthly report', target: '8%', unit: '%', value: 9.1, delta: 3.3, dir: 'down', good: 'down', since: 'since start', trend: [12.4, 11.8, 11, 10.2, 9.6, 9.3, 9.1] },
    ],
    learnings: [
      { date: '7/14', tag: 'During', author: 'Marcus', body: 'Patients 65+ dropped off at the insurance step. Added a “skip this — we’ll confirm by phone” path; completion went from 61% to 84%.' },
      { date: '6/20', tag: 'During', author: 'Dana', body: 'PMS sync must be one-directional (scheduler → PMS) for the pilot. Two-way sync doubled the build; not worth it yet.' },
    ],
  },
  {
    id: 'p-eligibility', name: 'Insurance eligibility auto-check', beaf: ['Automated', 'Faster'],
    levers: ['efficiency', 'charge'], stage: 'MVP', owner: 'DK',
    started: '2026-06-30', in_stage_days: 23,
    status: { kind: 'blocked', days: 3, reason: 'clearinghouse API credentials' },
    key_metric: { value: 33, label: 'Manual eligibility checks / day', unit: '', delta: 3, dir: 'down', good: 'down' },
    trend: [41, 38, 44, 36, 39, 34, 33],
    description: 'Automatically verify insurance eligibility before the visit so the front desk stops running manual checks and denials drop.',
    scope: { testing: 'Billing team (2 users)', site: null, pods: [], region: null },
    metrics: [
      { name: 'Manual eligibility checks / day', source: 'Front-desk log', target: '10', unit: '', value: 33, delta: 3, dir: 'down', good: 'down', since: 'since start', trend: [41, 38, 44, 36, 39, 34, 33] },
      { name: 'Eligibility-related denials', source: 'Billing export', target: null, unit: '%', value: 6.2, delta: 1.1, dir: 'down', good: 'down', since: 'since start', trend: [8.1, 7.6, 7.9, 7.0, 6.8, 6.4, 6.2] },
    ],
    learnings: [
      { date: '7/18', tag: 'During', author: 'Dana', body: 'Clearinghouse sandbox credentials take ~2 weeks to provision. Start the vendor paperwork the day the idea is greenlit, not at MVP.' },
    ],
  },
  {
    id: 'p-labels', name: 'Intake label printers', beaf: ['Faster', 'Better'],
    levers: ['efficiency'], stage: 'POD', owner: 'MR',
    started: '2026-03-02', in_stage_days: 11, status: { kind: 'moved' },
    key_metric: { value: 3.1, label: 'Check-in processing time', unit: 'min', delta: 2.7, dir: 'down', good: 'down' },
    trend: [7.2, 6.4, 5.8, 4.9, 4.1, 3.5, 3.1],
    description: 'Print intake labels at check-in so demographics and specimen labels stop being hand-written — fewer errors, faster rooming.',
    scope: { testing: 'Central POD staff', site: 'Springfield', pods: ['Central', 'North', 'West'], region: null },
    metrics: [
      { name: 'Check-in processing time', source: 'Time study', target: '3 min', unit: 'min', value: 3.1, delta: 2.7, dir: 'down', good: 'down', since: 'since start', trend: [7.2, 6.4, 5.8, 4.9, 4.1, 3.5, 3.1] },
      { name: 'Label transcription errors', source: 'QA audit', target: null, unit: '/wk', value: 1, delta: 6, dir: 'down', good: 'down', since: 'since start', trend: [7, 6, 5, 4, 3, 2, 1] },
    ],
    learnings: [
      { date: '5/02', tag: 'During', author: 'Marcus', body: 'Equipment wins are about error-reduction, not speed — the time saved is small, but the mislabeled-specimen rate going to near-zero is the real story.' },
    ],
  },
  {
    id: 'p-turnover', name: 'Room turnover checklist app', beaf: ['Better', 'Easier'],
    levers: ['efficiency', 'volume'], stage: 'Site', owner: 'MR',
    started: '2026-04-21', in_stage_days: 19, status: { kind: 'idle', days: 8 },
    key_metric: { value: 11, label: 'Avg room turnover', unit: 'min', delta: 3.2, dir: 'down', good: 'down' },
    trend: [16, 15, 14.5, 13, 12.2, 11.4, 11],
    description: 'A shared checklist on a wall tablet so rooms are turned over consistently and fast, freeing exam-room capacity.',
    scope: { testing: 'Springfield nursing pods', site: 'Springfield', pods: ['Central', 'North'], region: null },
    metrics: [
      { name: 'Avg room turnover', source: 'Tablet app log', target: '10 min', unit: 'min', value: 11, delta: 3.2, dir: 'down', good: 'down', since: 'since start', trend: [16, 15, 14.5, 13, 12.2, 11.4, 11] },
    ],
    learnings: [
      { date: '6/30', tag: 'During', author: 'Tara', body: 'Adoption stalls without a per-shift owner — the checklist only works when a lead is accountable for it each shift.' },
    ],
  },
  {
    id: 'p-referralfax', name: 'Referral fax → shared inbox', beaf: ['Easier', 'Automated'],
    levers: ['volume'], stage: 'Idea', owner: 'TW',
    started: '2026-07-11', in_stage_days: 12, status: { kind: 'idle', days: 12 },
    key_metric: null, trend: [],
    description: 'Route inbound referral faxes into a shared, triageable inbox so referrals stop getting lost on a single desk.',
    scope: { testing: null, site: null, pods: [], region: null },
    metrics: [],
    learnings: [],
  },
];

// ---- projects (archived) ----

export const SAMPLE_ARCHIVE = [
  {
    id: 'a-reminders', name: 'Text appointment reminders', outcome: 'rolled_out',
    levers: ['experience'], final_stage: 'All', span: 'Nov 2025 → Feb 2026',
    outcome_text: 'No-shows dropped 22% within six weeks. The 24-hour text did almost all of the work — earlier or extra reminders added nothing measurable.',
    measured: 'No-show rate −22% · confirmations +31%',
  },
  {
    id: 'a-kiosk', name: 'Lobby wayfinding kiosk', outcome: 'abandoned',
    levers: ['experience', 'efficiency'], final_stage: 'Site', span: 'Jan 2026 → Apr 2026',
    outcome_text: 'Patients liked it, but per-site hardware and upkeep cost outweighed the small wayfinding benefit. Signage did 80% of the job for ~5% of the cost.',
    measured: 'Front-desk directions −14% at pilot · cost/site $2,400',
  },
];

// ---- dashboard business metrics (nightly from data sources) ----

export const SAMPLE_METRICS = {
  // Volume & capacity — hero utilization + 6-day booked/capacity bullet bars.
  volume: {
    lever: 'volume', source: 'Scheduler · live',
    hero_pct: 87, delta_pts: 3, delta_dir: 'up',
    slots_booked: 313, slots_total: 360,
    caption: 'today is running 13 pts behind its usual Thursday',
    // avg = that weekday's prior 4-week average (the notch)
    days: [
      { label: 'MON', date: 20, booked: 58, capacity: 64, avg: 60 },
      { label: 'TUE', date: 21, booked: 61, capacity: 64, avg: 59 },
      { label: 'WED', date: 22, booked: 52, capacity: 64, avg: 55 },
      { label: 'TODAY', date: 23, booked: 49, capacity: 64, avg: 62, today: true },
      { label: 'FRI', date: 24, booked: 60, capacity: 64, avg: 58 },
      { label: 'SAT', date: 25, booked: 33, capacity: 40, avg: 34 },
    ],
    projects: ['p-selfsched', 'p-turnover', 'p-referralfax'],
  },
  // Charge per visit — hero $ + sparkline + secondary rows. Live threshold breach.
  charge: {
    lever: 'charge', source: 'Billing export · nightly', prior: 174,
    hero: 186, unit: '$', delta: 12, delta_dir: 'up',
    spark: [176, 172, 178, 174, 181, 179, 186],
    secondary: [
      { label: 'Procedure completion', value: '78%', delta: '2 pts', dir: 'up' },
      { label: 'Stock-out cancellations', value: '3 this wk', delta: '1', dir: 'up', bad: true },
      { label: 'Equipment uptime', value: '99.2%', delta: null },
    ],
    projects: ['p-eligibility'],
  },
  // Attributed lives — hero count + recency stack + frequency/monetization.
  attributed: {
    lever: 'experience',
    hero: 4820, delta: 64, delta_dir: 'up', delta_note: 'vs last month',
    recency: [
      { label: 'seen <12 mo', pct: 71 },
      { label: '12–24', pct: 18 },
      { label: 'lapsed', pct: 11 },
    ],
    frequency: '2.4 visits / yr',
    monetization: '$438 avg / yr', monetization_delta: '$16', monetization_dir: 'up',
    projects: ['p-selfsched'],
  },
  // Per appointment — segmented Primary/Specialty/Diagnostic, 3 stats each.
  perAppointment: {
    lever: 'efficiency',
    segments: [
      {
        key: 'primary', label: 'Primary care',
        stats: [
          { label: 'Staff cost', value: '$48', delta: '$3', dir: 'down', good: 'down' },
          { label: 'All-in cost', value: '$92', delta: '$5', dir: 'down', good: 'down' },
          { label: 'Avg time', value: '22 min', delta: '2 min', dir: 'down', good: 'down' },
        ],
      },
      {
        key: 'specialty', label: 'Specialty',
        stats: [
          { label: 'Staff cost', value: '$71', delta: '$2', dir: 'up', good: 'down' },
          { label: 'All-in cost', value: '$143', delta: '$4', dir: 'up', good: 'down' },
          { label: 'Avg time', value: '34 min', delta: '1 min', dir: 'down', good: 'down' },
        ],
      },
      {
        key: 'diagnostic', label: 'Diagnostic',
        stats: [
          { label: 'Staff cost', value: '$63', delta: '$6', dir: 'down', good: 'down' },
          { label: 'All-in cost', value: '$208', delta: '$3', dir: 'down', good: 'down' },
          { label: 'Avg time', value: '18 min', delta: '0 min', dir: 'flat', good: 'down' },
        ],
      },
    ],
    projects: ['p-eligibility', 'p-labels', 'p-turnover'],
  },
};

// Default thresholds per metric (blank = disabled). The charge card is set to
// breach (change beyond ±$10 while the +$12 delta exceeds it).
export const SAMPLE_THRESHOLDS = {
  volume: { low: null, high: null, change: null },
  charge: { low: null, high: null, change: 10 },
  attributed: { low: null, high: null, change: null },
};

// ---- meeting window + digest + history ----

export const SAMPLE_MEETING = {
  window_from: 'Tue Jul 22, 9:45 AM',
  window_to: 'now',
  next: 'Mon Jul 27, 9:00 AM',
  last_ago: '22h ago',
  moved: ['p-selfsched', 'p-labels'],
  blocked: ['p-eligibility'],
  no_movement: ['p-turnover', 'p-referralfax'],
  history: [
    { id: 'm1', ago: '22h ago', at: '7/22/2026, 9:45 AM', source: 'Auto' },
    { id: 'm2', ago: '3d ago', at: '7/20/2026, 9:00 AM', source: 'Auto' },
    { id: 'm3', ago: '10d ago', at: '7/13/2026, 9:00 AM', source: 'Manual' },
  ],
};

// ---- weekly focus (resets Monday) ----

export const SAMPLE_FOCUS = {
  category: 'volume',
  projects: ['p-selfsched', 'p-labels', 'p-referralfax'],
};

// ---- overall impact from Lean BEAF projects (by lever) ----
// Aggregated contribution of the portfolio across a chosen date range. Sample
// numbers per range until a data source is connected. `dir`/`good` drive the
// green/red pill just like the metric deltas.

export const IMPACT_RANGES = [
  { key: 'last_week', label: 'From last week' },
  { key: 'last_month', label: 'From last month' },
  { key: 'last_quarter', label: 'From last quarter' },
  { key: 'ytd', label: 'Year to date' },
];

export const SAMPLE_IMPACT = {
  last_week: {
    headline: '4 projects moved a metric', sub: '5 active · 2 rolled out',
    levers: [
      { key: 'volume', value: '+6%', note: 'appointments booked', dir: 'up', good: 'up' },
      { key: 'charge', value: '+$12', note: 'charge per visit', dir: 'up', good: 'up' },
      { key: 'efficiency', value: '−41 hrs', note: 'staff time / wk', dir: 'down', good: 'down' },
      { key: 'experience', value: '−1.4%', note: 'no-show rate', dir: 'down', good: 'down' },
    ],
  },
  last_month: {
    headline: '5 projects moved a metric', sub: '5 active · 2 rolled out',
    levers: [
      { key: 'volume', value: '+14%', note: 'appointments booked', dir: 'up', good: 'up' },
      { key: 'charge', value: '+$21', note: 'charge per visit', dir: 'up', good: 'up' },
      { key: 'efficiency', value: '−168 hrs', note: 'staff time / mo', dir: 'down', good: 'down' },
      { key: 'experience', value: '−5.2%', note: 'no-show rate', dir: 'down', good: 'down' },
    ],
  },
  last_quarter: {
    headline: '6 projects moved a metric', sub: '5 active · 2 rolled out',
    levers: [
      { key: 'volume', value: '+22%', note: 'appointments booked', dir: 'up', good: 'up' },
      { key: 'charge', value: '+$34', note: 'charge per visit', dir: 'up', good: 'up' },
      { key: 'efficiency', value: '−520 hrs', note: 'staff time / qtr', dir: 'down', good: 'down' },
      { key: 'experience', value: '−9.8%', note: 'no-show rate', dir: 'down', good: 'down' },
    ],
  },
  ytd: {
    headline: '8 projects moved a metric', sub: '5 active · 2 rolled out',
    levers: [
      { key: 'volume', value: '+31%', note: 'appointments booked', dir: 'up', good: 'up' },
      { key: 'charge', value: '+$47', note: 'charge per visit', dir: 'up', good: 'up' },
      { key: 'efficiency', value: '−1,940 hrs', note: 'staff time YTD', dir: 'down', good: 'down' },
      { key: 'experience', value: '−22%', note: 'no-show rate', dir: 'down', good: 'down' },
    ],
  },
};

// ---- derived helpers ----

export const projectById = (id) => SAMPLE_PROJECTS.find((p) => p.id === id) || SAMPLE_ARCHIVE.find((p) => p.id === id);

export function pipelineCounts() {
  const counts = Object.fromEntries(STAGES.map((s) => [s, 0]));
  for (const p of SAMPLE_PROJECTS) counts[p.stage] = (counts[p.stage] || 0) + 1;
  return STAGES.map((stage) => ({ stage, count: counts[stage] || 0 }));
}

export function leverCounts() {
  const counts = { volume: 0, charge: 0, efficiency: 0, experience: 0 };
  for (const p of SAMPLE_PROJECTS) for (const l of p.levers) counts[l] = (counts[l] || 0) + 1;
  return counts;
}
