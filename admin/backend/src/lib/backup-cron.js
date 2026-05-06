// Pure cron-expression helpers for the Backups feature.
//
// Lives in a standalone file (rather than inline in backup-
// scheduler.js) so callers and tests that don't need node-cron
// can pull these in without the package — keeps the unit-test
// surface small and the matcher reachable from environments
// where the SDK isn't installed.
//
// Supports the standard 5-field form (m h dom mon dow) plus the
// optional 6-field (with a leading seconds field that we drop —
// our scheduling resolution is one minute).  Each field accepts:
//   *           — every value in range
//   N           — literal integer
//   N,M,...     — comma-separated list
//   N-M         — inclusive range
//   N-M/STEP    — range with step
//   */STEP      — every STEP from the lower bound

export function cronMatches(expr, dt) {
  if (typeof expr !== 'string') return false;
  const parts = expr.trim().split(/\s+/);
  if (parts.length < 5 || parts.length > 6) return false;
  const fields = parts.length === 5 ? parts : parts.slice(1);
  const [mField, hField, domField, monField, dowField] = fields;
  return (
    matchField(mField, dt.getMinutes(), 0, 59)
    && matchField(hField, dt.getHours(), 0, 23)
    && matchField(domField, dt.getDate(), 1, 31)
    && matchField(monField, dt.getMonth() + 1, 1, 12)
    && matchField(dowField, dt.getDay(), 0, 7) // 0 + 7 both = Sunday
  );
}

export function matchField(field, value, lo, hi) {
  if (field === '*') return true;
  for (const piece of field.split(',')) {
    let step = 1;
    let body = piece;
    if (body.includes('/')) {
      const [b, s] = body.split('/');
      body = b || '*';
      step = parseInt(s, 10) || 1;
    }
    let from = lo;
    let to = hi;
    if (body !== '*') {
      if (body.includes('-')) {
        const [a, b] = body.split('-').map((n) => parseInt(n, 10));
        from = a; to = b;
      } else {
        const n = parseInt(body, 10);
        if (Number.isNaN(n)) continue;
        from = n; to = n;
      }
    }
    for (let v = from; v <= to; v += step) {
      // Day-of-week: '7' equals Sunday (== 0).
      if (lo === 0 && hi === 7 && v === 7) {
        if (value === 0) return true;
        continue;
      }
      if (v === value) return true;
    }
  }
  return false;
}

// Compute the next firing time of a cron expression in milliseconds
// since epoch.  Walks 366 days at 1-minute resolution looking for
// the next match.  ~525k iters/year — runs in <50ms in Node and
// only fires on schedule mutation, so the cost is fine.
//
// Returns null if no firing happens within the next year (which
// indicates an expression that's syntactically valid-looking but
// doesn't match any real time).
export function computeNextRunMs(expr, fromMs = Date.now()) {
  if (typeof expr !== 'string' || expr.length === 0) return null;
  // Quick syntax shape check.  Without it, garbage like 'banana'
  // walks 525k iterations and returns null — works but slow.
  const parts = expr.trim().split(/\s+/);
  if (parts.length < 5 || parts.length > 6) return null;
  const start = new Date(fromMs + 60_000); // skip the current minute
  start.setSeconds(0, 0);
  for (let i = 0; i < 366 * 24 * 60; i += 1) {
    const t = new Date(start.getTime() + i * 60_000);
    if (cronMatches(expr, t)) return t.getTime();
  }
  return null;
}

// Lightweight syntactic validity check.  We don't pull in
// node-cron's validate() here because that would re-tie this
// module to the package we're trying to keep optional.  The
// shape check below is what backup-scheduler.js uses to gate
// register(); a fully-permissive expression that survives this
// will still fail closed when matchField returns false for every
// minute, leading to a null nextRun + a logged skip.
export function isValidCronExpr(expr) {
  if (typeof expr !== 'string' || expr.length === 0) return false;
  const parts = expr.trim().split(/\s+/);
  if (parts.length < 5 || parts.length > 6) return false;
  const fields = parts.length === 5 ? parts : parts.slice(1);
  // Each field must non-empty + only the characters we support
  // (digits, hyphens, slashes, asterisks, commas).
  for (const f of fields) {
    if (!f) return false;
    if (!/^[0-9*,\-/]+$/.test(f)) return false;
  }
  return true;
}
