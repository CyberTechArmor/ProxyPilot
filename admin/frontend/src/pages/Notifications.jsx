// Notifications settings (admin).
//
// Configure the out-of-band "standard connections" that fan build-complete (and
// future) alerts beyond the in-app bell: an SMTP email channel and a
// provider-agnostic SMS-over-HTTP channel. Plus a per-browser toggle for OS
// notifications (the always-available, free channel).
//
// Secrets are write-only: the API never echoes a stored password/token, so the
// field shows "stored" and only a fresh value replaces it. Every save clears the
// cached test verdict — re-test to confirm.
//
// MOBILE_FIRST: single column, stacked fields, full-width controls, 44px
// targets; renders clean at 360px.

import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useToast } from '@/hooks/use-toast';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import PushNotifications from '@/components/PushNotifications';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  Bell, Mail, MessageSquare, Loader2, CheckCircle2, XCircle, Send, Trash2, Monitor,
} from 'lucide-react';
import {
  notifySupported, notifyPermission, ensureNotifyPermission, notifyBrowser,
} from '@/lib/browser-notify';

function TestBadge({ status, error }) {
  if (!status) return null;
  return (
    <span className={`inline-flex items-center gap-1 text-xs ${status === 'ok' ? 'text-green-600' : 'text-red-500'}`} title={error || ''}>
      {status === 'ok' ? <CheckCircle2 className="h-3.5 w-3.5" /> : <XCircle className="h-3.5 w-3.5" />}
      {status === 'ok' ? 'Last test passed' : `Last test failed${error ? `: ${error}` : ''}`}
    </span>
  );
}

// A single channel editor (SMTP or SMS). `fields` renders the kind-specific
// config inputs; the shared frame handles enable/save/test/delete + the secret.
function ChannelCard({
  kind, title, icon: Icon, description, channel, onReload,
  buildConfig, renderFields, secretLabel, secretPlaceholder,
}) {
  const { toast } = useToast();
  const [enabled, setEnabled] = useState(false);
  const [config, setConfig] = useState({});
  const [secret, setSecret] = useState(''); // '' = keep stored
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    setEnabled(!!channel?.enabled);
    setConfig(channel?.config || {});
    setSecret('');
  }, [channel]);

  const save = async () => {
    setBusy(true);
    try {
      const cfg = buildConfig(config);
      // Only send `secret` when the admin typed a new one (blank keeps the stored value).
      const payload = { enabled, config: cfg };
      if (secret.length > 0) payload.secret = secret;
      const r = await api.notificationChannelSave(kind, payload);
      toast({ title: 'Saved', description: `${title} settings updated.` });
      setSecret('');
      onReload(r.channel);
    } catch (err) {
      toast({ variant: 'destructive', title: 'Could not save', description: err.message });
    } finally { setBusy(false); }
  };

  const sendTest = async () => {
    setTesting(true);
    try {
      const r = await api.notificationChannelTest(kind);
      if (r.ok) toast({ title: 'Test sent', description: `A test ${title} notification was delivered.` });
      else toast({ variant: 'destructive', title: 'Test failed', description: r.error || 'Delivery failed.' });
      onReload(r.channel);
    } catch (err) {
      toast({ variant: 'destructive', title: 'Test failed', description: err.message });
    } finally { setTesting(false); }
  };

  const remove = async () => {
    setBusy(true);
    try {
      const r = await api.notificationChannelDelete(kind);
      toast({ title: 'Cleared', description: `${title} connection removed.` });
      onReload(r.channel);
    } catch (err) {
      toast({ variant: 'destructive', title: 'Could not clear', description: err.message });
    } finally { setBusy(false); }
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <CardTitle className="text-base flex items-center gap-2"><Icon className="h-4 w-4" /> {title}</CardTitle>
            <CardDescription>{description}</CardDescription>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Label htmlFor={`${kind}-enabled`} className="text-xs text-muted-foreground">Enabled</Label>
            <Switch id={`${kind}-enabled`} checked={enabled} onCheckedChange={setEnabled} />
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {renderFields(config, (patch) => setConfig((c) => ({ ...c, ...patch })))}

        <div className="space-y-1.5">
          <Label htmlFor={`${kind}-secret`}>{secretLabel}</Label>
          <Input
            id={`${kind}-secret`} type="password"
            placeholder={channel?.has_secret ? '•••••••• (stored — leave blank to keep)' : secretPlaceholder}
            value={secret} onChange={(e) => setSecret(e.target.value)}
            autoComplete="new-password" autoCapitalize="none" autoCorrect="off" spellCheck={false}
          />
        </div>

        <div className="flex flex-wrap items-center gap-2 pt-1">
          <Button className="h-11 sm:h-10" disabled={busy} onClick={save}>
            {busy ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : null}Save
          </Button>
          <Button variant="outline" className="h-11 sm:h-10" disabled={testing || !channel?.configured} onClick={sendTest}>
            {testing ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Send className="h-4 w-4 mr-1" />}Send test
          </Button>
          {channel?.configured ? (
            <Button variant="ghost" className="h-11 sm:h-10 text-red-500" disabled={busy} onClick={remove}>
              <Trash2 className="h-4 w-4 mr-1" />Clear
            </Button>
          ) : null}
          <span className="ml-auto"><TestBadge status={channel?.test_status} error={channel?.test_error} /></span>
        </div>
      </CardContent>
    </Card>
  );
}

export default function Notifications() {
  const { toast } = useToast();
  const [channels, setChannels] = useState({}); // { smtp, sms }
  const [loading, setLoading] = useState(true);
  const [perm, setPerm] = useState(notifyPermission());

  const load = useCallback(async () => {
    try {
      const r = await api.notificationChannelsList();
      const byKind = {};
      (r.channels || []).forEach((c) => { byKind[c.kind] = c; });
      setChannels(byKind);
    } catch (err) {
      toast({ variant: 'destructive', title: 'Could not load notification settings', description: err.message });
    } finally { setLoading(false); }
  }, [toast]);

  useEffect(() => { load(); }, [load]);

  const setChannel = (c) => setChannels((prev) => ({ ...prev, [c.kind]: c }));

  const enableBrowser = async () => {
    const p = await ensureNotifyPermission();
    setPerm(p);
    if (p === 'granted') {
      notifyBrowser('ProxyPilot notifications enabled', 'You’ll get a browser alert when a build finishes.');
      toast({ title: 'Browser notifications enabled' });
    } else if (p === 'denied') {
      toast({ variant: 'destructive', title: 'Browser notifications blocked', description: 'Allow notifications for this site in your browser settings.' });
    }
  };

  if (loading) {
    return <div className="flex items-center justify-center py-16"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>;
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-semibold"><Bell className="h-6 w-6" /> Notifications</h1>
        <p className="text-sm text-muted-foreground mt-1">
          How you get told when a build finishes. The in-app bell always fires. Push notifications reach this device
          even with ProxyPilot closed; email and SMS are install-wide connections.
        </p>
      </div>

      {/* Browser (per-device) */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2"><Monitor className="h-4 w-4" /> Browser notifications</CardTitle>
          <CardDescription>
            An OS notification while ProxyPilot is OPEN in a tab — including a background tab. Set per browser.
            For notifications when it is closed, use Push notifications below.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-3">
          {!notifySupported() ? (
            <p className="text-sm text-muted-foreground">This browser doesn’t support notifications.</p>
          ) : perm === 'granted' ? (
            <span className="inline-flex items-center gap-1 text-sm text-green-600"><CheckCircle2 className="h-4 w-4" /> Enabled on this browser</span>
          ) : perm === 'denied' ? (
            <span className="inline-flex items-center gap-1 text-sm text-red-500"><XCircle className="h-4 w-4" /> Blocked — allow notifications for this site in your browser settings</span>
          ) : (
            <Button className="h-11 sm:h-10" onClick={enableBrowser}>Enable browser notifications</Button>
          )}
        </CardContent>
      </Card>

      {/* Web Push (per-device, and the only one that works with the app shut) */}
      <PushNotifications />

      {/* SMTP */}
      <ChannelCard
        kind="smtp"
        title="Email (SMTP)"
        icon={Mail}
        description="Send build alerts by email through your SMTP server."
        channel={channels.smtp}
        onReload={setChannel}
        secretLabel="SMTP password"
        secretPlaceholder="Your SMTP password / app password"
        buildConfig={(c) => ({
          host: c.host || '', port: Number(c.port) || 587, secure: !!c.secure,
          user: c.user || '', from: c.from || '', to: c.to || '',
        })}
        renderFields={(c, patch) => (
          <>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="sm:col-span-2 space-y-1.5">
                <Label htmlFor="smtp-host">SMTP host</Label>
                <Input id="smtp-host" placeholder="smtp.example.com" value={c.host || ''} onChange={(e) => patch({ host: e.target.value })} autoCapitalize="none" autoCorrect="off" spellCheck={false} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="smtp-port">Port</Label>
                <Input id="smtp-port" type="number" placeholder="587" value={c.port ?? ''} onChange={(e) => patch({ port: e.target.value })} />
              </div>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={!!c.secure} onChange={(e) => patch({ secure: e.target.checked })} />
              Use TLS (implicit, usually port 465)
            </label>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="smtp-user">Username</Label>
                <Input id="smtp-user" placeholder="username (optional)" value={c.user || ''} onChange={(e) => patch({ user: e.target.value })} autoCapitalize="none" autoCorrect="off" spellCheck={false} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="smtp-from">From address</Label>
                <Input id="smtp-from" placeholder="proxypilot@example.com" value={c.from || ''} onChange={(e) => patch({ from: e.target.value })} autoCapitalize="none" autoCorrect="off" spellCheck={false} />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="smtp-to">Recipients</Label>
              <Input id="smtp-to" placeholder="you@example.com, ops@example.com" value={c.to || ''} onChange={(e) => patch({ to: e.target.value })} autoCapitalize="none" autoCorrect="off" spellCheck={false} />
              <p className="text-[11px] text-muted-foreground">Comma-separated.</p>
            </div>
          </>
        )}
      />

      {/* SMS */}
      <ChannelCard
        kind="sms"
        title="SMS (HTTP gateway)"
        icon={MessageSquare}
        description="Send build alerts as SMS by POSTing to any SMS gateway's webhook — provider-agnostic."
        channel={channels.sms}
        onReload={setChannel}
        secretLabel="Auth token (optional)"
        secretPlaceholder="Bearer token for the gateway"
        buildConfig={(c) => ({
          url: c.url || '', method: c.method || 'POST', to: c.to || '',
          auth_scheme: c.auth_scheme || 'bearer',
          body_template: c.body_template || '{"to":"{{to}}","message":"{{text}}"}',
        })}
        renderFields={(c, patch) => (
          <>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="sm:col-span-2 space-y-1.5">
                <Label htmlFor="sms-url">Gateway URL</Label>
                <Input id="sms-url" placeholder="https://sms.example.com/send" value={c.url || ''} onChange={(e) => patch({ url: e.target.value })} autoCapitalize="none" autoCorrect="off" spellCheck={false} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="sms-method">Method</Label>
                <Select value={c.method || 'POST'} onValueChange={(v) => patch({ method: v })}>
                  <SelectTrigger id="sms-method" className="h-11 sm:h-10"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="POST">POST</SelectItem>
                    <SelectItem value="PUT">PUT</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="sms-to">Recipients</Label>
              <Input id="sms-to" placeholder="+15551234567, +15557654321" value={c.to || ''} onChange={(e) => patch({ to: e.target.value })} autoCapitalize="none" autoCorrect="off" spellCheck={false} />
              <p className="text-[11px] text-muted-foreground">Comma-separated phone numbers.</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="sms-auth">Auth</Label>
              <Select value={c.auth_scheme || 'bearer'} onValueChange={(v) => patch({ auth_scheme: v })}>
                <SelectTrigger id="sms-auth" className="h-11 sm:h-10"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="bearer">Bearer token (Authorization header)</SelectItem>
                  <SelectItem value="none">None (token only in body)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="sms-body">Request body template</Label>
              <textarea
                id="sms-body"
                className="flex min-h-[64px] w-full rounded-md border border-input bg-transparent px-3 py-2 font-mono text-xs shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                value={c.body_template || ''}
                onChange={(e) => patch({ body_template: e.target.value })}
                spellCheck={false}
              />
              <p className="text-[11px] text-muted-foreground">Placeholders: <code>{'{{to}}'}</code>, <code>{'{{text}}'}</code>, <code>{'{{token}}'}</code>.</p>
            </div>
          </>
        )}
      />
    </div>
  );
}
