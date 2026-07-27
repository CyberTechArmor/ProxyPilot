// App access — the operator's first administrator.
//
// The first account in a built app belongs to the operator, and the build is
// forbidden to create it. Until this panel existed, the only way to act on that
// rule was to catch the app's sign-in page DURING a build and race to it:
// "there is limited time from seeing the create super admin first user, then
// when the app finishes I'm unable to log in".
//
// Nothing was expiring. But the door was only ever announced by the app's own
// sign-in screen, so it read as a window that closed. Here it is, on the
// operator's schedule, after the build has finished.
//
// The password is typed here and passes straight through to the app's own
// bootstrap endpoint. The platform does not generate it, does not store it, and
// cannot show it again — the panel says so, because an operator who assumes
// otherwise loses their account.
//
// MOBILE_FIRST: one column throughout, 44px targets, completes at 360px.

import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useToast } from '@/hooks/use-toast';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { DoorOpen, Loader2, ShieldCheck, AlertTriangle, RefreshCw } from 'lucide-react';

export default function ProjectAppAccess({ projectId, canEdit = false }) {
  const { toast } = useToast();
  const [state, setState] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try { setState(await api.mock2AppAccess(projectId)); }
    catch { setState(null); }
    finally { setLoading(false); }
  }, [projectId]);

  useEffect(() => { load(); }, [load]);

  const create = async (e) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const res = await api.mock2CreateFirstAdmin(projectId, { email, password });
      setState(res);
      setEmail('');
      setPassword('');
      toast({
        title: 'Administrator created',
        description: `Sign in at the app with ${res.email} and the password you chose — it was not stored.`,
      });
    } catch (err) {
      setError(String(err?.message || err));
    } finally {
      setBusy(false);
    }
  };

  const freeSlot = async () => {
    setError('');
    setBusy(true);
    try {
      const res = await api.mock2FreeFirstAdminSlot(projectId);
      setState(res);
      toast({
        title: 'First-admin slot freed',
        description: `Removed ${res.removed?.length || 0} platform test account(s). Create your administrator below.`,
      });
    } catch (err) {
      setError(String(err?.message || err));
    } finally {
      setBusy(false);
    }
  };

  const offline = state?.offline;
  const open = state?.canAttempt === true;
  // The app says its door is closed and the only accounts are the platform's
  // own fixtures — this app runs an auth component from before those stopped
  // counting as real users, so the platform's check took the operator's slot.
  const fixtureFilled = state?.fixtureFilled === true;
  const unreachable = state?.unreachable && !offline;
  const real = (state?.accounts || []).filter((a) => !a.fixture);
  const fixtures = (state?.accounts || []).filter((a) => a.fixture);

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
        <CardTitle className="flex items-center gap-2 text-base">
          <DoorOpen className="h-4 w-4" /> App access
        </CardTitle>
        <Button variant="ghost" size="sm" className="min-h-[44px]" onClick={load} disabled={loading}>
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          <span className="sr-only">Refresh</span>
        </Button>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        {loading && !state ? (
          <p className="text-muted-foreground">Checking who can sign in…</p>
        ) : (
          <>
            <p className={unreachable ? 'text-amber-500' : 'text-muted-foreground'}>
              {unreachable ? <AlertTriangle className="mr-1 inline h-4 w-4" /> : null}
              {state?.summary || 'The app has not been checked yet.'}
            </p>

            {real.length ? (
              <ul className="space-y-1">
                {real.map((a) => (
                  <li key={a.email} className="flex flex-wrap items-center gap-2 break-all">
                    <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
                    <span className="font-medium">{a.email}</span>
                    <span className="text-xs text-muted-foreground">{a.role}{a.active ? '' : ' · disabled'}</span>
                  </li>
                ))}
              </ul>
            ) : null}

            {/* Named, not hidden. Two accounts appearing in an app the operator
                has never signed into reads as "someone else got in" unless the
                panel says whose they are and that they do not count. */}
            {fixtures.length ? (
              <p className="text-xs text-muted-foreground">
                {fixtures.length} platform test account{fixtures.length === 1 ? '' : 's'} (
                {fixtures.map((a) => a.email).join(', ')}) — used by the automated checks, on the reserved
                {' '}<code>@fixture.invalid</code> domain. They do not count as users and never take your first-admin slot.
              </p>
            ) : null}

            {fixtureFilled && canEdit ? (
              <div className="space-y-3 border-t pt-4">
                <p className="text-muted-foreground">
                  Removing them undoes the platform's own side effect — the next build re-seeds whatever the
                  automated checks need, and nothing of yours is touched.
                </p>
                {error ? <p className="text-sm text-red-500">{error}</p> : null}
                <Button onClick={freeSlot} disabled={busy} className="min-h-[44px] w-full sm:w-auto">
                  {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                  Free the first-admin slot
                </Button>
              </div>
            ) : null}

            {open && canEdit ? (
              <form onSubmit={create} className="space-y-3 border-t pt-4">
                <p className="text-muted-foreground">
                  Create the administrator account. The build is not allowed to do this for you, and it does not
                  expire — it will still be here after the next build.
                </p>
                <div className="space-y-1">
                  <label className="text-xs font-medium" htmlFor="fa-email">Your email</label>
                  <Input
                    id="fa-email" type="email" value={email} autoComplete="username"
                    onChange={(ev) => setEmail(ev.target.value)}
                    placeholder="you@example.com" className="min-h-[44px]" required
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-medium" htmlFor="fa-password">Password (12+ characters)</label>
                  <Input
                    id="fa-password" type="password" value={password} autoComplete="new-password"
                    onChange={(ev) => setPassword(ev.target.value)}
                    minLength={12} className="min-h-[44px]" required
                  />
                  <p className="text-xs text-muted-foreground">
                    Typed here, sent straight to the app, and never stored — the platform cannot show it to you again.
                  </p>
                </div>
                {error ? <p className="text-sm text-red-500">{error}</p> : null}
                <Button type="submit" disabled={busy} className="min-h-[44px] w-full sm:w-auto">
                  {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                  Create administrator
                </Button>
              </form>
            ) : null}

            {open && !canEdit ? (
              <p className="text-xs text-muted-foreground">
                This app has no administrator yet. Ask a project editor to create it.
              </p>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}
