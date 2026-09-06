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
// Plus the case that produced "I'm not getting prompted": the app is ALREADY
// installed on this device and the operator is in a normal browser tab.
// Chromium then fires no install event at all and its menu says "Open app",
// not "Install" — so the card asks the browser (getInstalledRelatedApps) and
// says exactly that, with the uninstall-to-reinstall path for a new icon.
// When neither a prompt nor an install can be found, a self-check lists the
// criteria the browser applies, so a failing one is named instead of silent.
//
// MOBILE_FIRST: single column, 44px targets, clean at 360.

import { useEffect, useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { useToast } from '@/hooks/use-toast';
import { useBranding } from '@/lib/branding';
import {
  canInstall, subscribeInstallPrompt, promptInstall, isStandalone, installHint,
  isInstalledHere, checkInstallability,
} from '@/lib/pwa';
import { Download, MonitorSmartphone, CheckCircle2, Loader2, XCircle, Info } from 'lucide-react';

export default function InstallApp() {
  const { toast } = useToast();
  const branding = useBranding();
  const appName = branding?.name || 'ProxyPilot';
  const [available, setAvailable] = useState(() => canInstall());
  const [installed, setInstalled] = useState(() => isStandalone());
  const [installedHere, setInstalledHere] = useState(false); // installed, but this is a browser tab
  const [checks, setChecks] = useState(null);                // installability self-check
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    // The prompt can arrive after mount (slow first load) or disappear
    // (appinstalled), so track it rather than reading it once.
    const unsubscribe = subscribeInstallPrompt((next) => {
      setAvailable(next);
      if (!next) setInstalled(isStandalone());
    });
    // The event may have landed between the first render and this effect.
    setAvailable(canInstall());
    let cancelled = false;
    isInstalledHere().then((v) => { if (!cancelled) setInstalledHere(v); });
    // Opening the freshly installed app is a new page load, but a display-mode
    // change can also happen in place on some desktops.
    const mq = window.matchMedia('(display-mode: standalone)');
    const onChange = () => setInstalled(isStandalone());
    if (mq.addEventListener) mq.addEventListener('change', onChange);
    else if (mq.addListener) mq.addListener(onChange);
    return () => {
      cancelled = true;
      unsubscribe();
      if (mq.removeEventListener) mq.removeEventListener('change', onChange);
      else if (mq.removeListener) mq.removeListener(onChange);
    };
  }, []);

  // No prompt, no install found: run the self-check once so the card can name
  // what the browser is objecting to. Skipped when there is a button to show.
  useEffect(() => {
    if (installed || installedHere || available || checks !== null) return undefined;
    let cancelled = false;
    checkInstallability().then((c) => { if (!cancelled) setChecks(c); });
    return () => { cancelled = true; };
  }, [installed, installedHere, available, checks]);

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
        ) : installedHere ? (
          <div className="rounded-md border p-3 text-sm">
            <p className="flex items-start gap-2">
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-green-500" />
              <span>
                {appName} is already installed on this device — open it from your Home Screen or app list.
                The browser will not offer to install it again while it is there.
              </span>
            </p>
            <p className="mt-2 text-muted-foreground">
              To pick up a new icon or name, remove the installed app first (long-press its icon →
              Uninstall / Remove), then reload this page and install again.
            </p>
          </div>
        ) : available ? (
          <div className="flex flex-wrap gap-2">
            <Button className="min-h-[44px]" disabled={busy} onClick={install}>
              {busy ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Download className="mr-1 h-4 w-4" />}
              Install {appName}
            </Button>
          </div>
        ) : (
          <div className="space-y-3">
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
            {hint.platform !== 'firefox-desktop' && hint.platform !== 'ios' ? (
              <p className="flex items-start gap-2 text-xs text-muted-foreground">
                <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>
                  If the menu says &quot;Open app&quot; instead of &quot;Install&quot;, {appName} is already
                  installed on this device — open it from there, or uninstall it first to install
                  again with the current icon.
                </span>
              </p>
            ) : null}
            {checks && checks.some((c) => !c.ok) ? (
              <div className="rounded-md border border-destructive/40 p-3 text-sm">
                <p className="mb-1 font-medium">The browser is withholding its install prompt because:</p>
                <ul className="space-y-1">
                  {checks.map((c) => (
                    <li key={c.label} className="flex items-start gap-2">
                      {c.ok
                        ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-green-500" />
                        : <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />}
                      <span className={c.ok ? 'text-muted-foreground' : ''}>{c.label}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
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
