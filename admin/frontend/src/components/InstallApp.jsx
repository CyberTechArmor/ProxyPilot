// InstallApp — the "put ProxyPilot on this device" card on the Profile page.
//
// ProxyPilot is a PWA (manifest + service worker, see lib/pwa.js), so every
// modern browser can install it as a standalone app: its own window or
// Home-Screen icon, no browser chrome, and on iPhone it is the ONLY way to get
// push notifications. Browsers hide that behind an address-bar icon or a menu
// most people never open, so this card surfaces it.
//
// Per-device, like push: installing on your phone does nothing for your
// laptop. The copy says so.
//
// Three states, because the browsers genuinely differ:
//   1. already running as the installed app → say so, nothing to do;
//   2. Chrome/Edge captured the install prompt → one real Install button;
//   3. everything else (Safari, Firefox, a dismissed prompt) → the exact
//      steps for this browser, since no button can trigger it.
//
// MOBILE_FIRST: single column, 44px targets, clean at 360.

import { useEffect, useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { useToast } from '@/hooks/use-toast';
import { useBranding } from '@/lib/branding';
import { canInstall, subscribeInstallPrompt, promptInstall, isStandalone, installHint } from '@/lib/pwa';
import { Download, MonitorSmartphone, CheckCircle2, Loader2 } from 'lucide-react';

export default function InstallApp() {
  const { toast } = useToast();
  const branding = useBranding();
  const appName = branding?.name || 'ProxyPilot';
  const [available, setAvailable] = useState(() => canInstall());
  const [installed, setInstalled] = useState(() => isStandalone());
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    // The prompt can arrive after mount (slow first load) or disappear
    // (appinstalled), so track it rather than reading it once.
    const unsubscribe = subscribeInstallPrompt((next) => {
      setAvailable(next);
      if (!next) setInstalled(isStandalone());
    });
    // Opening the freshly installed app is a new page load, but a display-mode
    // change can also happen in place on some desktops.
    const mq = window.matchMedia('(display-mode: standalone)');
    const onChange = () => setInstalled(isStandalone());
    if (mq.addEventListener) mq.addEventListener('change', onChange);
    else if (mq.addListener) mq.addListener(onChange);
    return () => {
      unsubscribe();
      if (mq.removeEventListener) mq.removeEventListener('change', onChange);
      else if (mq.removeListener) mq.removeListener(onChange);
    };
  }, []);

  const install = async () => {
    setBusy(true);
    try {
      const result = await promptInstall();
      if (result.ok) {
        toast({ title: `${appName} installed`, description: 'Open it from your app list or Home Screen. This tab keeps working too.' });
      } else if (result.reason === 'not_available') {
        toast({ variant: 'destructive', title: 'Install prompt not available', description: 'Use the steps shown for this browser instead.' });
      }
      // A dismissed prompt is a decision, not an error — no toast.
    } finally { setBusy(false); }
  };

  const hint = installHint();

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <MonitorSmartphone className="h-5 w-5" />
          Install app
        </CardTitle>
        <CardDescription>
          Add {appName} to this device as an app: its own icon and window, no browser bars,
          and push notifications on iPhone and iPad. Install is per device — repeat it on each
          phone or computer you use.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {installed ? (
          <p className="flex items-start gap-2 rounded-md border p-3 text-sm">
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-green-500" />
            <span>
              You are running {appName} as an installed app on this device. Nothing more to do here.
            </span>
          </p>
        ) : available ? (
          <div className="flex flex-wrap gap-2">
            <Button className="min-h-[44px]" disabled={busy} onClick={install}>
              {busy ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Download className="mr-1 h-4 w-4" />}
              Install {appName}
            </Button>
          </div>
        ) : (
          <div className="rounded-md border p-3 text-sm">
            <p className="mb-2 font-medium">
              {hint.platform === 'firefox-desktop'
                ? 'This browser cannot install apps'
                : 'Install it from the browser itself:'}
            </p>
            <ol className="list-decimal space-y-1 pl-5 text-muted-foreground">
              {hint.steps.map((step) => <li key={step}>{step}</li>)}
            </ol>
          </div>
        )}
        <p className="text-xs text-muted-foreground">
          The installed app updates itself whenever {appName} is updated on the server, so it never
          falls behind this site.
        </p>
      </CardContent>
    </Card>
  );
}
