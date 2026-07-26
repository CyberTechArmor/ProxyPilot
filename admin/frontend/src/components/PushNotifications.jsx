// PushNotifications — the per-device opt-in for Web Push.
//
// This is deliberately NOT shaped like the SMTP/SMS channel cards next to it.
// Those configure a shared account once for the whole install; push is per
// BROWSER. Your phone and your laptop each subscribe separately, and turning it
// on here only affects the device you are looking at. The copy says so, because
// the obvious wrong assumption is that this is an install-wide switch.
//
// Three independent things must be true for a notification to arrive, and they
// fail in different places, so each gets its own line instead of one opaque
// "push is off":
//   1. the browser can do it at all (on iPhone: only once installed),
//   2. the OS granted permission,
//   3. this browser has a subscription the server knows about.
//
// MOBILE_FIRST: single column, wrapping button row, 44px targets, clean at 360.

import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { useToast } from '@/hooks/use-toast';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { BellRing, BellOff, Send, Loader2, Smartphone, AlertTriangle } from 'lucide-react';
import {
  pushSupport, subscribeToPush, unsubscribeFromPush, getPushSubscription, isStandalone,
} from '@/lib/pwa';

export default function PushNotifications() {
  const { toast } = useToast();
  const [config, setConfig] = useState(null);      // { configured, reason, public_key, subscriptions }
  const [subscribed, setSubscribed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);

  const support = pushSupport();

  const load = useCallback(async () => {
    try {
      const [cfg, sub] = await Promise.all([
        api.pushConfig(),
        getPushSubscription().catch(() => null),
      ]);
      setConfig(cfg);
      setSubscribed(!!sub);
    } catch (err) {
      if (!(err instanceof ApiError)) console.error('push config load failed:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const enable = async () => {
    setBusy(true);
    try {
      const sub = await subscribeToPush(config?.public_key);
      await api.pushSubscribe(sub);
      setSubscribed(true);
      toast({ title: 'Notifications on for this device', description: 'Send a test to confirm it arrives.' });
      await load();
    } catch (err) {
      toast({ variant: 'destructive', title: 'Could not turn on notifications', description: err.message });
    } finally { setBusy(false); }
  };

  const disable = async () => {
    setBusy(true);
    try {
      const endpoint = await unsubscribeFromPush();
      // Tell the server even if the browser had already forgotten, or the row
      // lingers and every notification retries against a dead endpoint.
      if (endpoint) await api.pushUnsubscribe(endpoint);
      setSubscribed(false);
      toast({ title: 'Notifications off for this device' });
      await load();
    } catch (err) {
      toast({ variant: 'destructive', title: 'Could not turn off notifications', description: err.message });
    } finally { setBusy(false); }
  };

  const sendTest = async () => {
    setBusy(true);
    try {
      const sub = await getPushSubscription();
      await api.pushTest(sub?.endpoint);
      toast({ title: 'Test sent', description: 'It should appear on this device within a few seconds.' });
    } catch (err) {
      // A push service 410 means this browser's endpoint died; say what to do.
      const resubscribe = /resubscribe|expired/i.test(err.message || '');
      toast({
        variant: 'destructive',
        title: 'The test did not go through',
        description: resubscribe
          ? 'This device\'s subscription had expired — turn notifications off and on again.'
          : err.message,
      });
      await load();
    } finally { setBusy(false); }
  };

  const iosNeedsInstall = support.needsInstall;
  const blocked = support.supported && support.permission === 'denied';

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <BellRing className="h-4 w-4" /> Push notifications
        </CardTitle>
        <CardDescription>
          Build results and alerts delivered to this device even when ProxyPilot is closed.
          This is a <span className="font-medium">per-device</span> setting — turn it on separately
          on your phone and your computer.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {loading ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Checking…
          </p>
        ) : (
          <>
            {/* 1. Server side. */}
            {!config?.configured ? (
              <p className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
                <span>
                  The server cannot send push notifications yet: {config?.reason || 'VAPID keys are not configured'}.
                  Re-run <code className="text-xs">update.sh</code>, which generates the keys automatically.
                </span>
              </p>
            ) : null}

            {/* 2. Platform. The iPhone case is the one people hit. */}
            {iosNeedsInstall ? (
              <p className="flex items-start gap-2 rounded-md border p-3 text-sm">
                <Smartphone className="mt-0.5 h-4 w-4 shrink-0" />
                <span>
                  On iPhone and iPad, notifications only work once ProxyPilot is on your Home Screen.
                  Tap <span className="font-medium">Share</span> → <span className="font-medium">Add to Home Screen</span>,
                  open it from that icon, then come back here. (Requires iOS 16.4 or newer.)
                </span>
              </p>
            ) : !support.supported ? (
              <p className="text-sm text-muted-foreground">{support.reason}</p>
            ) : null}

            {/* 3. Permission. */}
            {blocked ? (
              <p className="text-sm text-muted-foreground">
                Notifications are blocked for this site. Allow them in your browser&apos;s site settings
                for this page, then reload.
              </p>
            ) : null}

            {config?.configured && support.supported && !blocked ? (
              <div className="flex flex-wrap gap-2">
                {subscribed ? (
                  <>
                    <Button variant="outline" className="min-h-[44px]" disabled={busy} onClick={disable}>
                      {busy ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <BellOff className="mr-1 h-4 w-4" />}
                      Turn off for this device
                    </Button>
                    <Button variant="outline" className="min-h-[44px]" disabled={busy} onClick={sendTest}>
                      <Send className="mr-1 h-4 w-4" /> Send a test
                    </Button>
                  </>
                ) : (
                  <Button className="min-h-[44px]" disabled={busy} onClick={enable}>
                    {busy ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <BellRing className="mr-1 h-4 w-4" />}
                    Turn on for this device
                  </Button>
                )}
              </div>
            ) : null}

            <p className="text-xs text-muted-foreground">
              {subscribed ? 'On for this device. ' : ''}
              {config?.configured
                ? `${config.subscriptions} device${config.subscriptions === 1 ? '' : 's'} subscribed in total.`
                : ''}
              {isStandalone() ? ' Running as an installed app.' : ''}
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
