// The project preview iframe + its empty-state placeholder.
//
// Extracted from ProjectDetail so both the pre-approval design layout and the
// post-approval build layout render the same live preview (the mockup before
// approval, the working app after). The mockup is served same-origin by the
// dashboard's /mockup-preview API route (CSP-sandboxed to an opaque origin),
// so it embeds cleanly regardless of the project app's own state or headers.
//
// MOBILE_FIRST: full-width, the Desktop/Mobile toggle labels collapse to icons.

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { RefreshCw, ExternalLink, Monitor, Smartphone, Loader2, Sparkles, CheckCircle2, Maximize2, Minimize2 } from 'lucide-react';

export function PreviewPanel({ src, title, approved, reloadKey = 0, fullHeight = false, onToggleFullHeight = null }) {
  const [width, setWidth] = useState('desktop'); // 'desktop' | 'mobile'
  const [reloadNonce, setReloadNonce] = useState(0); // bump to remount (reload) the iframe
  return (
    <div className="flex flex-col h-full min-h-0 rounded-lg border overflow-hidden bg-muted/20">
      <div className="flex items-center justify-between gap-2 border-b bg-background/60 px-3 py-2 shrink-0">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="hidden sm:flex items-center gap-1.5 shrink-0">
            <span className="h-2.5 w-2.5 rounded-full bg-muted-foreground/25" />
            <span className="h-2.5 w-2.5 rounded-full bg-muted-foreground/25" />
            <span className="h-2.5 w-2.5 rounded-full bg-muted-foreground/25" />
          </span>
          <span className="truncate text-xs font-mono text-muted-foreground">{src}</span>
          <Button
            variant="ghost" size="icon" className="h-7 w-7 shrink-0"
            onClick={() => setReloadNonce((n) => n + 1)}
            aria-label="Reload preview" title="Reload preview"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </Button>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <div className="flex rounded-md border p-0.5">
            <button
              type="button" aria-pressed={width === 'desktop'} onClick={() => setWidth('desktop')}
              className={`inline-flex items-center gap-1 rounded px-2 py-1 text-xs ${width === 'desktop' ? 'bg-muted text-foreground' : 'text-muted-foreground'}`}
            >
              <Monitor className="h-3.5 w-3.5" /><span className="hidden sm:inline">Desktop</span>
            </button>
            <button
              type="button" aria-pressed={width === 'mobile'} onClick={() => setWidth('mobile')}
              className={`inline-flex items-center gap-1 rounded px-2 py-1 text-xs ${width === 'mobile' ? 'bg-muted text-foreground' : 'text-muted-foreground'}`}
            >
              <Smartphone className="h-3.5 w-3.5" /><span className="hidden sm:inline">Mobile</span>
            </button>
          </div>
          <Button asChild variant="outline" size="sm" className="h-9 shrink-0">
            <a href={src} target="_blank" rel="noreferrer" aria-label="Open the app in a new tab">
              <ExternalLink className="h-4 w-4 mr-1" /> Open App
            </a>
          </Button>
          {onToggleFullHeight ? (
            <Button
              variant="outline" size="sm" className="h-9 shrink-0"
              onClick={onToggleFullHeight}
              aria-label={fullHeight ? 'Restore terminal' : 'Expand preview to full height'}
              title={fullHeight ? 'Restore the terminal below' : 'Full height (use the terminal’s space too)'}
            >
              {fullHeight ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
              <span className="ml-1 hidden sm:inline">{fullHeight ? 'Restore' : 'Full height'}</span>
            </Button>
          ) : null}
        </div>
      </div>
      <div className="flex flex-1 min-h-0 justify-center overflow-auto bg-white">
        <iframe
          key={`${reloadKey}-${reloadNonce}`}
          title={`${title || 'Project'} preview`}
          src={src}
          className="h-full border-0 bg-white"
          style={{ width: width === 'mobile' ? 390 : '100%', maxWidth: '100%' }}
          sandbox="allow-scripts allow-forms allow-popups allow-same-origin allow-modals"
        />
      </div>
      {!approved ? (
        <p className="border-t px-3 py-1.5 text-[11px] text-muted-foreground shrink-0">
          Non-functional mockup preview — approve the design in the chat to build the working app.
        </p>
      ) : null}
    </div>
  );
}

// LiveAppBar — the build-mode stand-in for the preview iframe. The BUILT app
// sets its own frame-ancestors policy (constitution §5) and refuses to be
// embedded, so an iframe just shows "refused to connect". Instead we show a
// compact bar with the live URL and an open-in-new-tab button — the running app
// opens in a real tab where its own security headers apply.
//
// The button is LIVENESS-AWARE: it polls the app-live probe (does the REAL app
// answer its port?) and stays disabled, pulsing "Updating…", through the
// deploy window — where a click used to serve the placeholder, then a
// connection error, then finally the app. Solid "Open app" only when live.
export function LiveAppBar({ url, projectId, probeKey = '' }) {
  const [live, setLive] = useState(null); // null = unknown (first probe pending)
  useEffect(() => {
    if (!projectId || !url) return undefined;
    let stopped = false;
    let timer = null;
    const probe = async () => {
      let isLive = false;
      try { isLive = !!(await api.mock2AppLive(projectId)).live; } catch { isLive = false; }
      if (stopped) return;
      setLive(isLive);
      // Fast poll while updating (flip to solid the moment it serves); gentle
      // heartbeat once live so a later crash flips the button back honestly.
      timer = setTimeout(probe, isLive ? 12000 : 3000);
    };
    probe();
    return () => { stopped = true; if (timer) clearTimeout(timer); };
    // probeKey re-probes IMMEDIATELY on build/deploy transitions (cycle status,
    // deploy sub-state, base-app deploy) — the button updates the moment a
    // deploy lands instead of waiting out the poll interval or a page refresh.
  }, [projectId, url, probeKey]);

  const ready = live === true;
  return (
    <div className="rounded-lg border bg-muted/20 overflow-hidden shrink-0">
      <div className="flex items-center justify-between gap-2 border-b bg-background/60 px-3 py-2">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="hidden sm:flex items-center gap-1.5 shrink-0">
            <span className="h-2.5 w-2.5 rounded-full bg-muted-foreground/25" />
            <span className="h-2.5 w-2.5 rounded-full bg-muted-foreground/25" />
            <span className="h-2.5 w-2.5 rounded-full bg-muted-foreground/25" />
          </span>
          {url && ready ? (
            <a href={url} target="_blank" rel="noreferrer" className="truncate text-xs font-mono text-primary hover:underline">{url}</a>
          ) : url ? (
            <span className="truncate text-xs font-mono text-muted-foreground">{url}</span>
          ) : (
            <span className="truncate text-xs font-mono text-muted-foreground">No live URL yet</span>
          )}
        </div>
        {url ? (
          ready ? (
            <Button asChild variant="outline" size="sm" className="h-9 shrink-0">
              <a href={url} target="_blank" rel="noreferrer" aria-label="Open the app in a new tab">
                <ExternalLink className="h-4 w-4 mr-1" /> Open app
              </a>
            </Button>
          ) : (
            <Button
              variant="outline" size="sm" className="h-9 shrink-0 animate-pulse" disabled
              title="The app is deploying or restarting — this goes solid the moment it answers"
            >
              <Loader2 className="h-4 w-4 mr-1 animate-spin" /> Updating…
            </Button>
          )
        ) : null}
      </div>
      <p className="px-3 py-2.5 text-[11px] text-muted-foreground">
        {ready
          ? 'The running app opens in a new tab — it sets a frame policy that blocks being embedded here.'
          : 'The app is deploying or restarting — the button goes solid and clickable the moment the real app answers.'}
      </p>
    </div>
  );
}

// SetupProgress — the live provisioning step list, streamed into the Chat tab
// while the project is coming online. The most recent entry is "the current
// step" (highlighted with a spinner); earlier entries read as done. Failures in
// a step's message are tinted red. Fed from provStatus.progress.log
// ([{ phase, message }]).
export function SetupProgress({ log = [] }) {
  const steps = Array.isArray(log) ? log : [];
  const lastIdx = steps.length - 1;
  return (
    <ol className="mt-3 w-full max-w-md space-y-1.5 text-left">
      {steps.map((entry, i) => {
        const current = i === lastIdx;
        const failed = /failed|error|not found|unreachable/i.test(entry.message || '');
        return (
          <li key={i} className="flex items-start gap-2 text-xs">
            <span className="mt-0.5 shrink-0">
              {current
                ? <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-500" />
                : <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />}
            </span>
            <span className={`min-w-0 break-words ${current ? 'font-medium text-foreground' : failed ? 'text-red-500' : 'text-muted-foreground'}`}>
              {entry.phase ? <span className="font-mono text-muted-foreground/70">[{entry.phase}] </span> : null}
              {entry.message}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

// Shown when there is no preview yet (no mockup, or the project is still
// provisioning). Keeps the chat as the focus while explaining what will appear.
// While provisioning, streams the live setup step log (SetupProgress).
export function PreviewPlaceholder({ project, provLog = null, provMessage = null }) {
  const building = project.lifecycle === 'provisioning';
  const hasLog = building && Array.isArray(provLog) && provLog.length > 0;
  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-dashed bg-muted/10 px-6 py-10 text-center">
      {building
        ? <Loader2 className="mb-3 h-6 w-6 animate-spin text-muted-foreground" />
        : <Sparkles className="mb-3 h-6 w-6 text-muted-foreground" />}
      <p className="text-sm font-medium">
        {building ? (provMessage || 'Setting up your project…') : 'Your live preview will appear here'}
      </p>
      <p className="mt-1 max-w-sm text-xs text-muted-foreground">
        {building
          ? 'The container, repository, and URL are being provisioned.'
          : 'Describe your app in the chat below. As soon as a mockup is generated it shows up here — and once you approve the design and build, the working app replaces it.'}
      </p>
      {hasLog ? <SetupProgress log={provLog} /> : null}
    </div>
  );
}
