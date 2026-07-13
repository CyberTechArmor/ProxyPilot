// BuildTaskList — a Claude-Code-style live checklist for a running build cycle.
//
// Renders the fixed build skeleton (audit → write code → gates → checkpoint →
// deploy) with a live state per step so the user can see what's running and
// roughly how many steps are left. The gate phase expands into the individual
// gates going green. Derivation is pure (lib/build-tasks.js); this is just the
// view.
//
// MOBILE_FIRST: single column, wraps, no fixed widths; renders clean at 360px.

import { CheckCircle2, XCircle, Loader2, Circle, Clock } from 'lucide-react';
import { deriveBuildTasks } from '@/lib/build-tasks';

function StateIcon({ state, className = 'h-4 w-4' }) {
  if (state === 'done') return <CheckCircle2 className={`${className} text-green-500`} />;
  if (state === 'failed') return <XCircle className={`${className} text-red-500`} />;
  if (state === 'active') return <Loader2 className={`${className} animate-spin text-cyan-500`} />;
  if (state === 'blocked') return <Clock className={`${className} text-violet-500`} />;
  return <Circle className={`${className} text-muted-foreground/40`} />;
}

export default function BuildTaskList({ cycle, job }) {
  const { tasks, done, total, remaining, terminal, headline } = deriveBuildTasks(cycle, job);
  if (!tasks.length) return null;

  return (
    <div className="rounded-lg border bg-muted/20 p-3 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium flex items-center gap-2">
          {!terminal ? <Loader2 className="h-4 w-4 animate-spin text-cyan-500" /> : (
            terminal === 'succeeded'
              ? <CheckCircle2 className="h-4 w-4 text-green-500" />
              : <XCircle className="h-4 w-4 text-red-500" />
          )}
          {headline}
        </p>
        <span className="text-xs text-muted-foreground whitespace-nowrap">
          {terminal
            ? `${done}/${total} steps`
            : `Step ${Math.min(done + 1, total)} of ${total}${remaining ? ` · ~${remaining} left` : ''}`}
        </span>
      </div>

      {/* Thin progress bar — approximate, since exact timing is unknown. */}
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div
          className={`h-full rounded-full transition-all ${terminal === 'succeeded' ? 'bg-green-500' : terminal ? 'bg-red-500' : 'bg-cyan-500'}`}
          style={{ width: `${total ? Math.round((done / total) * 100) : 0}%` }}
        />
      </div>

      <ul className="space-y-1.5 pt-1">
        {tasks.map((t) => (
          <li key={t.key}>
            <div className="flex items-start gap-2 text-sm">
              <span className="mt-0.5 shrink-0"><StateIcon state={t.state} /></span>
              <span className="min-w-0">
                <span className={t.state === 'pending' ? 'text-muted-foreground' : 'text-foreground'}>{t.label}</span>
                {t.detail ? (
                  <span className="block text-xs text-muted-foreground break-words">{t.detail}</span>
                ) : null}
              </span>
            </div>
            {t.sub?.length ? (
              <ul className="mt-1 ml-6 space-y-1">
                {t.sub.map((g) => (
                  <li key={g.key} className="flex items-center gap-2 text-xs">
                    <span className="shrink-0"><StateIcon state={g.state} className="h-3.5 w-3.5" /></span>
                    <span className={`min-w-0 truncate ${g.state === 'pending' ? 'text-muted-foreground' : 'text-foreground/90'}`}>{g.label}</span>
                  </li>
                ))}
              </ul>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
