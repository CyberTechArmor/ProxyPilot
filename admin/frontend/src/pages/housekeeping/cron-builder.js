// Friendly cron-expression builder + parser.
//
// The schedule dialog speaks in operator language ('Daily at 3:00
// AM') but the backend stores raw cron expressions.  This module
// translates between the two so the dialog can offer a picker UI
// for the common cases plus a Custom-cron escape hatch for the
// edge cases the picker can't express.
//
// Round-trip: if a saved schedule's cron_expr matches one of our
// known patterns, parseCron() infers the picker mode + values so
// the Edit dialog opens with the friendly UI selected.  If it
// doesn't match, the dialog falls back to Custom mode.
//
// Pure JS — no DOM access, no React, easy to unit-test if we want
// later.

export const SCHEDULE_MODES = Object.freeze({
  daily: 'Daily',
  weekly: 'Weekly',
  monthly: 'Monthly',
  hourly: 'Hourly',
  custom: 'Custom cron',
});

export const DAYS_OF_WEEK = Object.freeze([
  { value: 0, label: 'Sunday' },
  { value: 1, label: 'Monday' },
  { value: 2, label: 'Tuesday' },
  { value: 3, label: 'Wednesday' },
  { value: 4, label: 'Thursday' },
  { value: 5, label: 'Friday' },
  { value: 6, label: 'Saturday' },
]);

// buildCron({ mode, hour, minute, dow, dom }) → cron expr string.
// Out-of-range / missing fields are clamped + defaulted so the
// dialog can call this with a partial form without throwing.
export function buildCron({ mode, hour = 3, minute = 0, dow = 0, dom = 1 } = {}) {
  const m = clamp(minute, 0, 59);
  const h = clamp(hour, 0, 23);
  const d = clamp(dom, 1, 31);
  const w = clamp(dow, 0, 6);
  switch (mode) {
    case 'hourly':  return `${m} * * * *`;
    case 'daily':   return `${m} ${h} * * *`;
    case 'weekly':  return `${m} ${h} * * ${w}`;
    case 'monthly': return `${m} ${h} ${d} * *`;
    default:        return `${m} ${h} * * *`; // sane fallback
  }
}

// parseCron(expr) → { mode, hour, minute, dow, dom } when the
// expression matches one of our patterns; { mode: 'custom' } when
// it doesn't.  The dialog uses this on Edit so a schedule saved
// from the picker round-trips back to the picker.
export function parseCron(expr) {
  if (typeof expr !== 'string') return { mode: 'custom' };
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return { mode: 'custom' };
  const [m, h, dom, mon, dow] = parts;
  const minute = toInt(m);
  const hour = toInt(h);
  const day = toInt(dom);
  const week = toInt(dow);

  // Hourly: M * * * *  (minute fixed, everything else *).
  if (Number.isInteger(minute) && h === '*' && dom === '*' && mon === '*' && dow === '*') {
    return { mode: 'hourly', minute, hour: 0, dom: 1, dow: 0 };
  }
  // Daily: M H * * *
  if (Number.isInteger(minute) && Number.isInteger(hour) && dom === '*' && mon === '*' && dow === '*') {
    return { mode: 'daily', minute, hour, dom: 1, dow: 0 };
  }
  // Weekly: M H * * D
  if (Number.isInteger(minute) && Number.isInteger(hour) && dom === '*' && mon === '*' && Number.isInteger(week)) {
    return { mode: 'weekly', minute, hour, dom: 1, dow: week === 7 ? 0 : week };
  }
  // Monthly: M H D * *
  if (Number.isInteger(minute) && Number.isInteger(hour) && Number.isInteger(day) && mon === '*' && dow === '*') {
    return { mode: 'monthly', minute, hour, dom: day, dow: 0 };
  }
  return { mode: 'custom', minute: 0, hour: 0, dom: 1, dow: 0 };
}

// describeCron({ mode, hour, minute, dow, dom }) → human string
// like 'Daily at 03:00' or 'Weekly on Sunday at 02:30'.  The
// dialog renders this under the picker so the operator sees
// exactly when the next run will fire.
export function describeCron({ mode, hour = 0, minute = 0, dow = 0, dom = 1 } = {}) {
  const t = `${pad(hour)}:${pad(minute)}`;
  switch (mode) {
    case 'hourly':  return `Hourly at minute ${pad(minute)}`;
    case 'daily':   return `Daily at ${t}`;
    case 'weekly':  return `Weekly on ${DAYS_OF_WEEK[clamp(dow, 0, 6)].label} at ${t}`;
    case 'monthly': return `Monthly on day ${clamp(dom, 1, 31)} at ${t}`;
    default:        return null;
  }
}

function clamp(n, lo, hi) {
  const v = Number(n);
  if (!Number.isFinite(v)) return lo;
  return Math.min(Math.max(Math.round(v), lo), hi);
}

function toInt(s) {
  if (typeof s !== 'string') return null;
  if (!/^\d+$/.test(s)) return null;
  return parseInt(s, 10);
}

function pad(n) {
  return String(n).padStart(2, '0');
}
