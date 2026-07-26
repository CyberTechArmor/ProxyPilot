// MobilePanelBar — the bottom bar the two project workspaces share on a narrow
// screen: Flightdeck (build phase) and the mockup/design stage.
//
// On a phone the studio runs full-bleed — the dashboard's top bar, the project
// title row and the workspace's own top bar are all gone — so this row is the
// page's ONLY chrome. That is why it carries more than panel switches: the nav
// drawer and Details live here because nothing else is left to hold them. On a
// tablet the top bars are still there, so callers pass onOpenNav/onShowDetails
// as null and the bar is panels alone.
//
// MOBILE_FIRST: every item is a ≥44px tap target and the row is an even grid,
// so it stays thumb-reachable at 360px however many panels a stage has.

import { Info, Menu } from 'lucide-react';

// Spelled out so Tailwind's scanner sees them (a computed `grid-cols-${n}`
// would be purged out of the build).
const COLS = [
  'grid-cols-1', 'grid-cols-2', 'grid-cols-3', 'grid-cols-4',
  'grid-cols-5', 'grid-cols-6', 'grid-cols-7',
];

const itemCls = (active) =>
  `flex flex-col items-center justify-center gap-0.5 py-2 min-h-[44px] text-[11px] ${
    active ? 'text-primary' : 'text-muted-foreground'
  }`;

export default function MobilePanelBar({
  panels, current, onSelect, onOpenNav = null, onShowDetails = null,
}) {
  const count = panels.length + (onOpenNav ? 1 : 0) + (onShowDetails ? 1 : 0);
  const cols = COLS[Math.min(count, COLS.length) - 1];
  return (
    // pb-safe keeps the row clear of the iPhone home indicator; it resolves to
    // 0 on Android and on non-notched devices.
    <div className={`grid border-t shrink-0 pb-safe bg-background ${cols}`}>
      {onOpenNav ? (
        <button type="button" onClick={onOpenNav} aria-label="Open navigation menu" className={itemCls(false)}>
          <Menu className="h-4 w-4" />Menu
        </button>
      ) : null}
      {panels.map((p) => (
        <button
          key={p.key} type="button" onClick={() => onSelect(p.key)}
          aria-pressed={current === p.key}
          className={itemCls(current === p.key)}
        >
          <p.icon className="h-4 w-4" />{p.label}
        </button>
      ))}
      {onShowDetails ? (
        <button type="button" onClick={onShowDetails} aria-label="Project details" className={itemCls(false)}>
          <Info className="h-4 w-4" />Details
        </button>
      ) : null}
    </div>
  );
}
