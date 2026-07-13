// The project preview iframe + its empty-state placeholder.
//
// Extracted from ProjectDetail so both the pre-approval design layout and the
// post-approval build layout render the same live preview (the mockup before
// approval, the working app after). The framed doc is the project's own HTTPS
// origin (the mock2 dev server sets no X-Frame-Options), so it embeds cleanly.
//
// MOBILE_FIRST: full-width, the Desktop/Mobile toggle labels collapse to icons.

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { RefreshCw, ExternalLink, Monitor, Smartphone, Loader2, Sparkles } from 'lucide-react';

export function PreviewPanel({ src, title, approved, reloadKey = 0 }) {
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
          <Button asChild variant="ghost" size="icon" className="h-9 w-9">
            <a href={src} target="_blank" rel="noreferrer" aria-label="Open preview in a new tab">
              <ExternalLink className="h-4 w-4" />
            </a>
          </Button>
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

// Shown when there is no preview yet (no mockup, or the project is still
// provisioning). Keeps the chat as the focus while explaining what will appear.
export function PreviewPlaceholder({ project }) {
  const building = project.lifecycle === 'provisioning';
  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-dashed bg-muted/10 px-6 py-10 text-center">
      {building
        ? <Loader2 className="mb-3 h-6 w-6 animate-spin text-muted-foreground" />
        : <Sparkles className="mb-3 h-6 w-6 text-muted-foreground" />}
      <p className="text-sm font-medium">
        {building ? 'Setting up your project…' : 'Your live preview will appear here'}
      </p>
      <p className="mt-1 max-w-sm text-xs text-muted-foreground">
        {building
          ? 'The container, repository, and URL are being provisioned.'
          : 'Describe your app in the chat below. As soon as a mockup is generated it shows up here — and once you approve the design and build, the working app replaces it.'}
      </p>
    </div>
  );
}
