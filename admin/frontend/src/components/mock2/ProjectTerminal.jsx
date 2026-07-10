// Mock2 project terminal — a shell into the project's Incus container (m2-<id>)
// over the shared streaming-terminal WS route (/api/terminal/mock2/<id>). Gated
// to editors/admins on an online project by the backend authorizer; the caller
// (ProjectDetail) also only renders it in that case. The InteractiveTerminal is
// mounted LAZILY (only after "Open terminal") so viewing the page never opens a
// PTY session, and unmounted on close so the socket + node-pty are torn down.
//
// Two layouts:
//   * default — a bounded card (used inline).
//   * fill    — fills its parent's height (used in the Terminal tab, which is a
//               flex column bounded to the viewport). The terminal grows to use
//               all available space instead of a fixed 24rem.
//
// MOBILE_FIRST.md: full-width terminal, ≥44px controls, renders on a 360px
// screen. Nothing desktop-only.
import { useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { TerminalSquare, X } from 'lucide-react';
import InteractiveTerminal from '@/components/InteractiveTerminal';

export default function ProjectTerminal({ projectId, containerName, defaultOpen = false, fill = false }) {
  const [open, setOpen] = useState(defaultOpen);

  const header = (
    <div className="flex items-center justify-between gap-2 flex-wrap">
      <div className="min-w-0">
        <div className="flex items-center gap-2 text-base font-semibold">
          <TerminalSquare className="h-4 w-4 shrink-0" /> Terminal
        </div>
        <p className="text-xs text-muted-foreground truncate">
          Shell into {containerName ? <span className="font-mono">{containerName}</span> : 'this container'}
          {' · '}starts in <span className="font-mono">/srv/app</span> · editors and admins
        </p>
      </div>
      {open ? (
        <Button variant="ghost" size="sm" className="h-10 shrink-0" onClick={() => setOpen(false)}>
          <X className="h-4 w-4 mr-1" /> Close
        </Button>
      ) : (
        <Button variant="outline" size="sm" className="h-10 shrink-0" onClick={() => setOpen(true)}>
          <TerminalSquare className="h-4 w-4 mr-1" /> Open terminal
        </Button>
      )}
    </div>
  );

  // Fill layout — the terminal grows to occupy all remaining height in a bounded
  // parent (the Terminal tab). No Card chrome, so the shell gets the whole space.
  if (fill) {
    return (
      <div className="flex h-full min-h-0 flex-col gap-3">
        <div className="shrink-0">{header}</div>
        {open ? (
          <div className="flex flex-1 min-h-0 flex-col rounded-lg border overflow-hidden">
            <InteractiveTerminal wsPath={`/api/terminal/mock2/${projectId}`} />
          </div>
        ) : (
          <div className="flex flex-1 min-h-0 items-center justify-center rounded-lg border border-dashed text-sm text-muted-foreground">
            The terminal is closed.
          </div>
        )}
      </div>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <CardTitle className="text-base flex items-center gap-2">
            <TerminalSquare className="h-4 w-4" /> Terminal
          </CardTitle>
          {open ? (
            <Button variant="ghost" size="sm" className="h-10" onClick={() => setOpen(false)}>
              <X className="h-4 w-4 mr-1" /> Close
            </Button>
          ) : (
            <Button variant="outline" size="sm" className="h-10" onClick={() => setOpen(true)}>
              <TerminalSquare className="h-4 w-4 mr-1" /> Open terminal
            </Button>
          )}
        </div>
        <CardDescription>
          A shell into this project&apos;s container
          {containerName ? <> (<span className="font-mono">{containerName}</span>)</> : null}
          . Starts in <span className="font-mono">/srv/app</span>. Editors and admins only.
        </CardDescription>
      </CardHeader>
      {open ? (
        <CardContent>
          {/* InteractiveTerminal is flex-1/min-h-0 — give it a bounded flex column. */}
          <div className="flex flex-col h-[24rem] rounded-lg border overflow-hidden">
            <InteractiveTerminal wsPath={`/api/terminal/mock2/${projectId}`} />
          </div>
        </CardContent>
      ) : null}
    </Card>
  );
}
