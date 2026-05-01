import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { onSudoOpen, resolveSudo, rejectSudo } from '@/lib/sudo';
import { sudoWithPasskey, isPasskeySupported } from '@/lib/passkey';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ShieldCheck, Loader2, Fingerprint } from 'lucide-react';

// Singleton sudo prompt. Mounted once at the app root via SudoProvider;
// any api call that hits a sudo gate (401 + sudo_required) opens this
// modal automatically through requestSudo() in lib/sudo.js.
//
// When the user has a registered passkey (read once on each open from
// /user/profile.hasPasskey), the modal opens with a primary "Verify
// with passkey" button. A secondary "Use TOTP instead" link reveals
// the original password+TOTP form. Either path resolves the same
// requestSudo() promise.
//
// On success the modal calls resolveSudo() which the api.request()
// retry path is already awaiting; the original destructive request
// goes through with a fresh sudo_until on the session row. On cancel
// rejectSudo() bubbles a "Sudo cancelled" 401 back to the caller so
// it can show a normal toast.
export default function SudoProvider({ children }) {
  const [open, setOpen] = useState(false);
  const [hasPasskey, setHasPasskey] = useState(false);
  const [usePasskey, setUsePasskey] = useState(false);
  const [password, setPassword] = useState('');
  const [totpCode, setTotpCode] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [verifyingPasskey, setVerifyingPasskey] = useState(false);
  const [error, setError] = useState('');
  const [lockedUntil, setLockedUntil] = useState(null);

  useEffect(() => {
    return onSudoOpen(async () => {
      setPassword('');
      setTotpCode('');
      setError('');
      setLockedUntil(null);
      // Fetch a fresh hasPasskey from the server every time we open.
      // localStorage cache would lie if the user revoked their last
      // passkey from another tab — we'd offer a button that 400's.
      let detected = false;
      try {
        const { user } = await api.getProfile();
        detected = !!(user?.hasPasskey && isPasskeySupported());
      } catch { /* fall through to TOTP-only modal */ }
      setHasPasskey(detected);
      setUsePasskey(detected);
      setOpen(true);
    });
  }, []);

  const handlePasskey = async () => {
    if (verifyingPasskey) return;
    setVerifyingPasskey(true);
    setError('');
    try {
      const result = await sudoWithPasskey();
      if (!result.ok) {
        if (result.code === 'CANCELLED') {
          setError('');
          return;
        }
        setError(result.message);
        return;
      }
      setOpen(false);
      resolveSudo();
    } finally {
      setVerifyingPasskey(false);
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError('');
    try {
      await api.sudo({ password, totpCode });
      setOpen(false);
      resolveSudo();
    } catch (err) {
      // 429 lockout takes precedence over plain 401
      if (err.lockedUntil || err.retryAfterSec) {
        setLockedUntil(err.lockedUntil || new Date(Date.now() + (err.retryAfterSec || 0) * 1000).toISOString());
      }
      setError(err.message || 'Re-authentication failed');
    } finally {
      setSubmitting(false);
    }
  };

  const handleCancel = () => {
    setOpen(false);
    rejectSudo();
  };

  return (
    <>
      {children}
      <Dialog open={open} onOpenChange={(v) => { if (!v) handleCancel(); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ShieldCheck className="h-5 w-5 text-cyan-500" />
              {usePasskey ? 'Confirm with passkey' : 'Confirm with password + TOTP'}
            </DialogTitle>
            <DialogDescription>
              This action requires fresh authentication. Sudo stays
              active for 4 hours of activity, then prompts again.
            </DialogDescription>
          </DialogHeader>

          {usePasskey ? (
            <div className="space-y-3">
              <Button
                type="button"
                className="w-full"
                onClick={handlePasskey}
                disabled={verifyingPasskey}
              >
                {verifyingPasskey ? (
                  <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Verifying…</>
                ) : (
                  <><Fingerprint className="h-4 w-4 mr-2" /> Verify with passkey</>
                )}
              </Button>
              <button
                type="button"
                className="text-xs text-muted-foreground underline w-full text-center"
                onClick={() => { setUsePasskey(false); setError(''); }}
                disabled={verifyingPasskey}
              >
                Use TOTP instead
              </button>
              {error && (
                <div className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-200">
                  {error}
                </div>
              )}
              <DialogFooter className="gap-2">
                <Button type="button" variant="outline" onClick={handleCancel} disabled={verifyingPasskey}>
                  Cancel
                </Button>
              </DialogFooter>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="sudo-password">Password</Label>
                <Input
                  id="sudo-password"
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  disabled={submitting || !!lockedUntil}
                  required
                  autoFocus
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="sudo-totp">Authenticator Code</Label>
                <Input
                  id="sudo-totp"
                  type="text"
                  inputMode="numeric"
                  pattern="\d{6}"
                  maxLength={6}
                  placeholder="123456"
                  value={totpCode}
                  onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  disabled={submitting || !!lockedUntil}
                  required
                />
              </div>

              {hasPasskey && (
                <button
                  type="button"
                  className="text-xs text-muted-foreground underline w-full text-center"
                  onClick={() => { setUsePasskey(true); setError(''); }}
                  disabled={submitting}
                >
                  Verify with passkey instead
                </button>
              )}

              {error && (
                <div className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-200">
                  {error}
                  {lockedUntil && (
                    <div className="mt-1 text-xs opacity-90">
                      Try again at {new Date(lockedUntil).toLocaleTimeString()}.
                    </div>
                  )}
                </div>
              )}

              <DialogFooter className="gap-2">
                <Button type="button" variant="outline" onClick={handleCancel} disabled={submitting}>
                  Cancel
                </Button>
                <Button type="submit" disabled={submitting || !!lockedUntil || password.length === 0 || totpCode.length !== 6}>
                  {submitting ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Verifying…</> : 'Confirm'}
                </Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
