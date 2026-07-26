// UpdateBanner — "a new version is ready, reload".
//
// The service worker serves navigations network-first, so any page LOAD after a
// deploy is already on the new build. This exists for the case that cannot
// cover: an admin console tab left open for days that is never reloaded. The
// worker update check (lib/pwa) notices the new build and this is how the
// operator hears about it.
//
// It ASKS rather than reloading on its own. This console drives live builds and
// carries half-typed instructions; reloading underneath someone loses that. The
// only automatic reload is the one after the operator accepts, driven by the
// worker's controllerchange.
//
// MOBILE_FIRST: fixed to the bottom above the safe-area inset, full width under
// sm, wraps at 360px, 44px targets.

import { useEffect, useState } from 'react';
import { RefreshCw, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { setUpdateHandler, applyUpdate } from '@/lib/pwa';

export default function UpdateBanner() {
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setUpdateHandler(() => setReady(true));
    return () => setUpdateHandler(null);
  }, []);

  if (!ready) return null;

  return (
    <div
      role="status"
      className="fixed inset-x-0 bottom-0 z-[60] pb-safe px-3 pb-3 pointer-events-none sm:left-auto sm:right-4 sm:max-w-sm"
    >
      <div className="pointer-events-auto rounded-lg border bg-background p-3 shadow-lg">
        <p className="text-sm font-medium">A new version of ProxyPilot is ready</p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Reload to pick it up. Anything a build is doing keeps running on the server.
        </p>
        <div className="mt-2 flex flex-wrap gap-2">
          <Button
            size="sm" className="min-h-[44px] flex-1"
            disabled={busy}
            onClick={() => { setBusy(true); applyUpdate(); }}
          >
            <RefreshCw className={`h-4 w-4 mr-1 ${busy ? 'animate-spin' : ''}`} />
            {busy ? 'Reloading…' : 'Reload now'}
          </Button>
          <Button
            variant="ghost" size="sm" className="min-h-[44px]"
            onClick={() => setReady(false)}
            aria-label="Dismiss the update notice"
          >
            <X className="h-4 w-4 mr-1" /> Later
          </Button>
        </div>
      </div>
    </div>
  );
}
