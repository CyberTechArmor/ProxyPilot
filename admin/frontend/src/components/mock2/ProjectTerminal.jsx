// Mock2 project terminal — a shell into the project's Incus container (m2-<id>)
// over the shared streaming-terminal WS route (/api/terminal/mock2/<id>). Gated
// to editors/admins on an online project by the backend authorizer; the caller
// (ProjectDetail) also only renders it in that case. The InteractiveTerminal is
// mounted LAZILY (only after "Open terminal") so viewing the page never opens a
// PTY session, and unmounted on close so the socket + node-pty are torn down.
//
// MOBILE_FIRST.md: single-column card, full-width terminal, ≥44px controls, a
// bounded height that fits a 360px screen. Nothing desktop-only.
import { useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { TerminalSquare, X } from 'lucide-react';
import InteractiveTerminal from '@/components/InteractiveTerminal';

export default function ProjectTerminal({ projectId, containerName }) {
  const [open, setOpen] = useState(false);

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
