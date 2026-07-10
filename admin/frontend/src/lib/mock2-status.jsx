// Mock2 derived-status → UI chip (Phase M2).
//
// The backend derives one status token per project (project-logic.deriveProject
// Status). This is the single frontend mapping from that token to a coloured
// chip, used by both the tile list (Projects.jsx) and the detail page
// (ProjectDetail.jsx) so the two never drift. The `flagged` overlay renders as
// a separate marker, exactly as the data model describes it (an overlay, not a
// status).

const STATUS_STYLES = {
  provisioning: { label: 'Provisioning', cls: 'bg-blue-500/10 text-blue-500', pulse: true },
  online: { label: 'Online', cls: 'bg-emerald-500/10 text-emerald-500' },
  idle: { label: 'Idle', cls: 'bg-amber-500/10 text-amber-500' },
  stopped: { label: 'Stopped', cls: 'bg-muted text-muted-foreground' },
  orphaned: { label: 'Orphaned', cls: 'bg-amber-500/10 text-amber-500' },
  // M6/M9 — the runner is working; a human holds the checkout lock (ADR-004).
  building: { label: 'Building', cls: 'bg-cyan-500/10 text-cyan-500', pulse: true },
  checked_out: { label: 'Checked out', cls: 'bg-indigo-500/10 text-indigo-500' },
  // M9 — budget exhausted (ledger vs budget); can't run a cycle until raised.
  quota_exhausted: { label: 'Quota exhausted', cls: 'bg-red-500/10 text-red-500' },
  // M8 audit gate (ADR-002) — awaiting an editor rule confirmation or an admin
  // deviation resolution; and framework drift (ADR-003, "update available").
  awaiting_user: { label: 'Awaiting you', cls: 'bg-violet-500/10 text-violet-500', pulse: true },
  awaiting_admin: { label: 'Awaiting admin', cls: 'bg-amber-500/10 text-amber-500', pulse: true },
  drift: { label: 'Update available', cls: 'bg-sky-500/10 text-sky-500' },
  failed: { label: 'Failed', cls: 'bg-red-500/10 text-red-500' },
  archived: { label: 'Archived', cls: 'bg-muted text-muted-foreground' },
  unknown: { label: 'Unknown', cls: 'bg-muted text-muted-foreground' },
};

export function statusChip(status, flagged = false) {
  const s = STATUS_STYLES[status] || STATUS_STYLES.unknown;
  return (
    <span className="inline-flex items-center gap-1 shrink-0">
      <span className={`text-[11px] px-2 py-0.5 rounded-full whitespace-nowrap ${s.cls}`}>
        {s.pulse ? <span className="inline-block h-1.5 w-1.5 rounded-full bg-current mr-1 animate-pulse" /> : null}
        {s.label}
      </span>
      {flagged ? (
        <span
          className="text-[11px] px-1.5 py-0.5 rounded-full bg-red-500/10 text-red-500"
          title="Flagged for admin attention"
        >
          !
        </span>
      ) : null}
    </span>
  );
}
