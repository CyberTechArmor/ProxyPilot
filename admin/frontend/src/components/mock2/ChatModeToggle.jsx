// ChatModeToggle — the Plan / Design / Build conversation-mode pill.
//
// One control, present in BOTH chats, so the whole journey reads as one
// conversation with three registers: Plan (talk the idea through, nothing is
// rendered), Design (generate and iterate the mockup), Build (change the
// running app). Build stays greyed out until the project unlocks it — the
// mockup is accepted, the MVP is built, or the mockup is skipped — and once
// unlocked it stays available for the life of the project, so the user can
// step back into Plan or Design and always find the way back to Build.
//
// MOBILE_FIRST: ≥44px touch targets on phones (relaxes to the compact pill on
// sm+, matching the import-source toggle), wraps nowhere, fits at 360px.

import { ClipboardList, Sparkles, Hammer } from 'lucide-react';

export default function ChatModeToggle({ mode, onMode, buildUnlocked = false, className = '' }) {
  const btn = (value, Icon, label, { disabled = false, title }) => (
    <button
      type="button"
      role="tab"
      aria-selected={mode === value}
      disabled={disabled}
      title={title}
      onClick={() => { if (!disabled && mode !== value) onMode(value); }}
      className={`inline-flex items-center gap-1 rounded px-2.5 py-1.5 text-xs font-medium min-h-[44px] sm:min-h-0 ${
        mode === value ? 'bg-muted text-foreground' : 'text-muted-foreground'
      } ${disabled ? 'opacity-40 cursor-not-allowed' : ''}`}
    >
      <Icon className="h-3.5 w-3.5" /> {label}
    </button>
  );

  return (
    <div className={`inline-flex self-start rounded-md border p-0.5 shrink-0 ${className}`} role="tablist" aria-label="Conversation mode">
      {btn('plan', ClipboardList, 'Plan', {
        title: 'Plan — think through the idea without changing the mockup',
      })}
      {btn('design', Sparkles, 'Design', {
        title: 'Design — generate and iterate the mockup',
      })}
      {btn('build', Hammer, 'Build', {
        disabled: !buildUnlocked,
        title: buildUnlocked
          ? 'Build — change the running app'
          : 'Build unlocks once the mockup is accepted, the MVP is built, or the mockup is skipped',
      })}
    </div>
  );
}
