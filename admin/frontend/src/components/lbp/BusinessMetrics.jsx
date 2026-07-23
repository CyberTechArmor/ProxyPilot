// Lean BEAF Pro — dashboard business-metrics band (from the redesign concept).
//
// A leadership-facing strip: four "levers" (Volume / Charge / Efficiency /
// Experience) that frame the portfolio, then four metric cards — Volume &
// capacity (per-day bullet chart), Charge per visit (sparkline), Attributed
// lives (recency stack), and Per appointment cost (Primary / Specialty /
// Diagnostic segmented control).
//
// The numbers are DUMMY sample data (no source is connected yet); the payload
// is flagged `sample` and the band says so, linking admins to Connections.
// Mobile-first per MOBILE_FIRST.md: everything collapses to one column.

import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '@/lib/api';
import { useAuth } from '@/context/AuthContext';
import { Loader2, TrendingUp, TrendingDown, Plug, ChevronRight } from 'lucide-react';

// ---- formatters ----

const fmtInt = (n) => Number(n || 0).toLocaleString();
const fmtUsd = (n) => `$${Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function Delta({ pct, invert = false }) {
  const v = Number(pct || 0);
  if (v === 0) return <span className="text-[11px] font-semibold text-muted-foreground">±0%</span>;
  // For cost metrics (invert), down is good. For the rest, up is good.
  const good = invert ? v < 0 : v > 0;
  const Icon = v > 0 ? TrendingUp : TrendingDown;
  return (
    <span className={`inline-flex items-center gap-0.5 text-[11px] font-semibold ${good ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
      <Icon className="h-3 w-3" /> {v > 0 ? '+' : ''}{v}%
    </span>
  );
}

const LEVER_DOT = {
  blue: 'bg-blue-500', green: 'bg-green-500', amber: 'bg-amber-500', purple: 'bg-purple-500',
};
const LEVER_STATUS = {
  on_track: { label: 'On track', cls: 'bg-green-500/10 text-green-600 dark:text-green-400' },
  watch: { label: 'Watch', cls: 'bg-amber-500/10 text-amber-600 dark:text-amber-400' },
  off_track: { label: 'Off track', cls: 'bg-red-500/10 text-red-600 dark:text-red-400' },
};

function leverValue(l) {
  if (l.unit === 'USD') return fmtUsd(l.current);
  if (l.unit === '/5') return `${l.current}/5`;
  return `${fmtInt(l.current)} ${l.unit || ''}`.trim();
}
function leverTarget(l) {
  if (l.unit === 'USD') return fmtUsd(l.target);
  if (l.unit === '/5') return `${l.target}/5`;
  return `${fmtInt(l.target)}`;
}

// ---- tiny charts ----

// Booked-vs-capacity horizontal bullet bars by weekday.
function BulletChart({ perDay = [] }) {
  return (
    <div className="mt-2 space-y-1.5">
      {perDay.map((d) => {
        const pct = Math.min(100, Math.round((d.booked / (d.capacity || 1)) * 100));
        return (
          <div key={d.day} className="flex items-center gap-2">
            <span className="w-8 shrink-0 text-[10px] font-semibold text-muted-foreground">{d.day}</span>
            <span className="relative h-2.5 flex-1 overflow-hidden rounded-full bg-muted">
              <span
                className={`absolute inset-y-0 left-0 rounded-full ${pct >= 90 ? 'bg-amber-500' : 'bg-primary'}`}
                style={{ width: `${pct}%` }}
              />
            </span>
            <span className="w-9 shrink-0 text-right text-[10px] tabular-nums text-muted-foreground">{pct}%</span>
          </div>
        );
      })}
    </div>
  );
}

// Minimal inline sparkline (SVG polyline), theme-aware via currentColor.
function Sparkline({ points = [] }) {
  if (points.length < 2) return null;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1;
  const W = 100;
  const H = 28;
  const coords = points.map((p, i) => {
    const x = (i / (points.length - 1)) * W;
    const y = H - ((p - min) / span) * (H - 4) - 2;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="mt-2 h-8 w-full text-primary">
      <polyline points={coords} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// Attributed-lives recency stack: one segmented bar + a legend.
const RECENCY_COLORS = ['bg-primary', 'bg-primary/60', 'bg-primary/30'];
function RecencyStack({ recency = [] }) {
  const total = recency.reduce((s, r) => s + r.value, 0) || 1;
  return (
    <div className="mt-2">
      <span className="flex h-2.5 w-full overflow-hidden rounded-full bg-muted">
        {recency.map((r, i) => (
          <span key={r.label} className={RECENCY_COLORS[i] || 'bg-primary/30'} style={{ width: `${(r.value / total) * 100}%` }} />
        ))}
      </span>
      <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5">
        {recency.map((r, i) => (
          <span key={r.label} className="inline-flex items-center gap-1 text-[10px] text-muted-foreground">
            <i className={`h-2 w-2 rounded-full ${RECENCY_COLORS[i] || 'bg-primary/30'}`} /> {r.label} · {fmtInt(r.value)}
          </span>
        ))}
      </div>
    </div>
  );
}

// ---- card shell ----

function MetricCard({ label, children }) {
  return (
    <div className="flex flex-col rounded-xl border bg-card p-4">
      <span className="text-[11px] font-bold uppercase tracking-wide text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}

// ---- the band ----

export default function BusinessMetrics() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [metrics, setMetrics] = useState(null);
  const [err, setErr] = useState('');
  const [seg, setSeg] = useState('primary');

  useEffect(() => {
    api.lbpDashboardMetrics().then((d) => setMetrics(d.metrics)).catch((e) => setErr(e.message));
  }, []);

  if (err) return null; // metrics are supplementary — never block the dashboard
  if (!metrics) {
    return (
      <div className="flex items-center justify-center rounded-xl border bg-card py-10">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const { band, levers } = metrics;
  const cost = band.per_appointment_cost;
  const selected = cost.segments.find((s) => s.key === seg) || cost.segments[0];

  return (
    <section className="space-y-3">
      {/* header + sample-data flag + admin link to Connections */}
      <div className="flex flex-wrap items-center gap-2">
        <b className="text-sm">Business metrics</b>
        {metrics.sample && (
          <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] font-semibold text-amber-600 dark:text-amber-400" title={metrics.note}>
            Sample data · not connected
          </span>
        )}
        <button
          type="button"
          onClick={() => navigate('/lean-beaf/connections')}
          className="ml-auto inline-flex items-center gap-1 text-xs font-semibold text-primary"
          title={user?.role === 'admin' ? 'Connect a data source' : 'View data-source connections'}
        >
          <Plug className="h-3.5 w-3.5" /> Connections <ChevronRight className="h-3 w-3" />
        </button>
      </div>

      {/* four levers */}
      <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
        {levers.map((l) => {
          const status = LEVER_STATUS[l.status] || LEVER_STATUS.watch;
          return (
            <div key={l.key} className="rounded-xl border bg-card p-3">
              <div className="flex items-center gap-1.5">
                <i className={`h-2.5 w-2.5 rounded-full ${LEVER_DOT[l.dot] || 'bg-primary'}`} />
                <span className="text-xs font-bold">{l.label}</span>
                <span className={`ml-auto rounded-full px-1.5 py-0.5 text-[9px] font-semibold ${status.cls}`}>{status.label}</span>
              </div>
              <b className="mt-1.5 block text-lg font-extrabold leading-tight">{leverValue(l)}</b>
              <span className="block text-[10px] text-muted-foreground">target {leverTarget(l)}</span>
              <p className="mt-1 line-clamp-2 text-[11px] leading-snug text-muted-foreground">{l.summary}</p>
            </div>
          );
        })}
      </div>

      {/* four metric cards */}
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-4">
        {/* Volume & capacity */}
        <MetricCard label={band.volume.label}>
          <div className="mt-1 flex items-baseline gap-2">
            <b className="text-2xl font-extrabold">{fmtInt(band.volume.total)}</b>
            <span className="text-[11px] text-muted-foreground">{band.volume.unit}</span>
            <span className="ml-auto"><Delta pct={band.volume.delta_pct} /></span>
          </div>
          <span className="text-[11px] text-muted-foreground">{band.volume.period} · {band.volume.capacity_pct}% capacity</span>
          <BulletChart perDay={band.volume.per_day} />
        </MetricCard>

        {/* Charge per visit */}
        <MetricCard label={band.charge_per_visit.label}>
          <div className="mt-1 flex items-baseline gap-2">
            <b className="text-2xl font-extrabold">{fmtUsd(band.charge_per_visit.value)}</b>
            <span className="ml-auto"><Delta pct={band.charge_per_visit.delta_pct} /></span>
          </div>
          <span className="text-[11px] text-muted-foreground">per visit · 6-period trend</span>
          <Sparkline points={band.charge_per_visit.spark} />
        </MetricCard>

        {/* Attributed lives */}
        <MetricCard label={band.attributed_lives.label}>
          <div className="mt-1 flex items-baseline gap-2">
            <b className="text-2xl font-extrabold">{fmtInt(band.attributed_lives.value)}</b>
            <span className="ml-auto"><Delta pct={band.attributed_lives.delta_pct} /></span>
          </div>
          <span className="text-[11px] text-muted-foreground">by attribution recency</span>
          <RecencyStack recency={band.attributed_lives.recency} />
        </MetricCard>

        {/* Per appointment cost — segmented */}
        <MetricCard label={cost.label}>
          <div className="mt-1.5 flex gap-0.5 rounded-lg border bg-muted/40 p-0.5">
            {cost.segments.map((s) => (
              <button
                key={s.key}
                type="button"
                onClick={() => setSeg(s.key)}
                className={`min-w-0 flex-1 truncate rounded-md px-0.5 py-1 text-[10px] font-semibold transition-colors ${
                  seg === s.key ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground'
                }`}
                title={s.label}
              >
                {s.label}
              </button>
            ))}
          </div>
          <div className="mt-2 flex items-baseline gap-2">
            <b className="text-2xl font-extrabold">{fmtUsd(selected.value)}</b>
            {/* cost: down is good → invert */}
            <span className="ml-auto"><Delta pct={selected.delta_pct} invert /></span>
          </div>
          <span className="text-[11px] text-muted-foreground">{selected.label.toLowerCase()} · allocated cost / appt</span>
        </MetricCard>
      </div>
    </section>
  );
}
