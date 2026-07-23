// Lean BEAF Pro — presentational primitives for the redesigned views.
// Thin marks, tabular numbers in tables, single-hue ordinal ramps, and the
// "highlight one / gray the rest" emphasis pattern. Status colors are always
// paired with an icon + label; deltas are green when the direction is good,
// red when bad. Theme-aware via Tailwind tokens.

import { LEVERS } from './sampleData';
import { Flag, ArrowUp, ArrowDown, Target } from 'lucide-react';

// ---- levers ----

export function LeverDots({ levers = [], size = 'h-2.5 w-2.5' }) {
  return (
    <span className="inline-flex items-center gap-1">
      {levers.map((k) => (
        <i key={k} className={`${size} rounded-full ${LEVERS[k]?.dot || 'bg-muted'}`} title={LEVERS[k]?.label} />
      ))}
    </span>
  );
}

export function LeverChip({ leverKey, onClick, className = '' }) {
  const l = LEVERS[leverKey];
  if (!l) return null;
  const Cmp = onClick ? 'button' : 'span';
  return (
    <Cmp
      type={onClick ? 'button' : undefined}
      onClick={onClick}
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ${l.chip} ${onClick ? 'transition-opacity hover:opacity-80' : ''} ${className}`}
    >
      <i className={`h-2 w-2 rounded-full ${l.dot}`} /> {l.label}
    </Cmp>
  );
}

// ---- BEAF tags ----

export function BeafTags({ tags = [] }) {
  if (!tags.length) return null;
  return (
    <span className="text-[11px] text-muted-foreground">{tags.join(' · ')}</span>
  );
}

// ---- delta pill (loud: green good / red bad) ----

export function DeltaPill({ delta, dir, good = 'up', prefix = '', suffix = '', className = '' }) {
  if (delta == null || dir === 'flat') {
    return <span className={`inline-flex items-center gap-0.5 rounded-full bg-muted px-1.5 py-0.5 text-[11px] font-semibold text-muted-foreground ${className}`}>±0</span>;
  }
  const isGood = dir === good;
  const Icon = dir === 'up' ? ArrowUp : ArrowDown;
  const cls = isGood
    ? 'bg-green-500/12 text-green-700 dark:text-green-400'
    : 'bg-red-500/12 text-red-700 dark:text-red-400';
  return (
    <span className={`inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[11px] font-bold ${cls} ${className}`}>
      <Icon className="h-3 w-3" strokeWidth={2.5} /> {prefix}{delta}{suffix}
    </span>
  );
}

// ---- owner avatar ----

const AV_COLORS = ['bg-teal-500', 'bg-amber-500', 'bg-blue-500', 'bg-purple-500', 'bg-rose-500', 'bg-emerald-500'];
function avColor(s = '') { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) % AV_COLORS.length; return AV_COLORS[h]; }
export function OwnerAvatar({ initials }) {
  return (
    <span className={`inline-flex h-6 w-6 items-center justify-center rounded-full text-[10px] font-bold text-white ${avColor(initials)}`} title={initials}>
      {String(initials || '?').slice(0, 2).toUpperCase()}
    </span>
  );
}

// ---- status chip (Blocked ·Nd / Moved / Idle Nd) ----

export function StatusChip({ status }) {
  if (!status) return null;
  if (status.kind === 'blocked') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-red-500/10 px-2 py-0.5 text-[11px] font-semibold text-red-600 dark:text-red-400" title={status.reason}>
        <Flag className="h-3 w-3" /> Blocked{status.days != null ? ` · ${status.days}d` : ''}
      </span>
    );
  }
  if (status.kind === 'idle') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2 py-0.5 text-[11px] font-semibold text-amber-600 dark:text-amber-400">
        ◔ Idle {status.days}d
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-green-500/10 px-2 py-0.5 text-[11px] font-semibold text-green-600 dark:text-green-400">
      ● Moved
    </span>
  );
}

// ---- sparkline (2px line, end dot with surface ring) ----

export function Sparkline({ points = [], className = 'h-7 w-20', dir = 'up', good = 'up' }) {
  if (!points || points.length < 2) return <span className="text-muted-foreground">—</span>;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1;
  const W = 80; const H = 26;
  const xy = points.map((p, i) => [(i / (points.length - 1)) * W, H - ((p - min) / span) * (H - 6) - 3]);
  const d = xy.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const [ex, ey] = xy[xy.length - 1];
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className={`${className} overflow-visible text-blue-500 dark:text-blue-400`} preserveAspectRatio="none">
      <polyline points={d} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
      <circle cx={ex} cy={ey} r="3" fill="currentColor" stroke="var(--card, #fff)" strokeWidth="2" className="[stroke:hsl(var(--card))]" />
    </svg>
  );
}

// ---- volume & capacity bullet bars ----

// One vertical bar per day: gray capacity track, filled booked amount, a notch
// at that weekday's prior 4-week average. Today is emphasized (blue + outline).
export function VolumeBars({ days = [] }) {
  const maxCap = Math.max(...days.map((d) => d.capacity), 1);
  const H = 132; // px track height for the tallest capacity
  return (
    <div className="flex items-end justify-between gap-2">
      {days.map((d) => {
        const capPx = (d.capacity / maxCap) * H;
        const bookedPx = (d.booked / maxCap) * H;
        const avgPx = (d.avg / maxCap) * H;
        return (
          <div key={d.label} className="flex flex-1 flex-col items-center">
            <div className="relative w-full max-w-[44px]" style={{ height: `${H}px` }}>
              {/* capacity track */}
              <div
                className={`absolute bottom-0 w-full rounded-lg ${d.today ? 'bg-blue-500/10 ring-2 ring-blue-500' : 'bg-muted'}`}
                style={{ height: `${capPx}px` }}
              />
              {/* booked fill */}
              <div
                className={`absolute bottom-0 w-full rounded-lg ${d.today ? 'bg-blue-500' : 'bg-muted-foreground/25'}`}
                style={{ height: `${bookedPx}px` }}
              />
              {/* prior 4-wk avg notch */}
              <div
                className="absolute w-full border-t border-dashed border-foreground/40"
                style={{ bottom: `${avgPx}px` }}
                title={`prior 4-wk avg ${d.avg}`}
              />
            </div>
            <span className={`mt-2 text-[10px] font-bold tracking-wide ${d.today ? 'text-blue-600 dark:text-blue-400' : 'text-muted-foreground'}`}>
              {d.label} {d.date}
            </span>
            <span className={`text-[10px] tabular-nums ${d.today ? 'font-bold text-foreground' : 'text-muted-foreground'}`}>
              {d.booked}/{d.capacity}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ---- recency stack (single-hue ordinal blues) ----

const RAMP = ['bg-blue-600', 'bg-blue-400', 'bg-blue-200 dark:bg-blue-900'];
export function RecencyStack({ segments = [] }) {
  return (
    <div>
      <span className="flex h-2.5 w-full overflow-hidden rounded-full">
        {segments.map((s, i) => (
          <span key={s.label} className={RAMP[i] || 'bg-blue-200'} style={{ width: `${s.pct}%` }} />
        ))}
      </span>
      <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5">
        {segments.map((s, i) => (
          <span key={s.label} className="inline-flex items-center gap-1 text-[10px] text-muted-foreground">
            <i className={`h-2 w-2 rounded-sm ${RAMP[i] || 'bg-blue-200'}`} /> {s.label} · {s.pct}%
          </span>
        ))}
      </div>
    </div>
  );
}

// ---- focus toggle (◎ Focus) ----

export function FocusToggle({ active, onClick, label = 'Focus' }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] font-semibold transition-colors ${
        active ? 'border-foreground bg-foreground text-background' : 'border-border text-muted-foreground hover:text-foreground'
      }`}
      title="Focus this metric for the week"
    >
      {active ? '✓' : <Target className="h-3 w-3" />} {label}
    </button>
  );
}
