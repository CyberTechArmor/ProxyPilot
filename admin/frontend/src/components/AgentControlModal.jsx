import { useEffect, useId, useState } from 'react';
import { Fingerprint, Loader2, ShieldCheck } from 'lucide-react';
import { api } from '@/lib/api';
import { onAgentControlOpen, rejectAgentControl, resolveAgentControl } from '@/lib/agent-control';
import { agentControlWithPasskey, isPasskeySupported } from '@/lib/passkey';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

// A7: the agent-control prompt, mounted once at the app root. Any request that
// meets the agent-control gate (401 + control_verification_required: taking
// over an agent run, deciding one) opens it through requestAgentControl(). It
// asks for this account's own factors, a passkey or password + authenticator
// code, and records a grant for this session only. It is not sudo: it never
// opens the sudo window and never grants anything on the host.
export default function AgentControlProvider({ children }) {
  const [open, setOpen] = useState(false), [hasPasskey, setHasPasskey] = useState(false);
  const [usePasskey, setUsePasskey] = useState(false), [password, setPassword] = useState(''), [code, setCode] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [lockedUntil, setLockedUntil] = useState(null);
  const describe = useId();

  useEffect(() => onAgentControlOpen(async () => {
    setPassword(''); setCode(''); setError(''); setLockedUntil(null);
    let detected = false;
    try { const { user } = await api.getProfile(); detected = !!(user?.hasPasskey && isPasskeySupported()); } catch { /* TOTP form */ }
    setHasPasskey(detected); setUsePasskey(detected); setOpen(true);
  }), []);

  const done = () => { setOpen(false); resolveAgentControl(); };
  const cancel = () => { setOpen(false); rejectAgentControl(); };
  async function passkey() {
    if (busy) return;
    setBusy(true); setError('');
    try {
      const result = await agentControlWithPasskey();
      if (result.ok) done();
      else if (result.code !== 'CANCELLED') setError(result.message);
    } finally { setBusy(false); }
  }
  async function submit(event) {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setError('');
    try { await api.agentControl({ password, totpCode: code }); done(); }
    catch (err) {
      if (err.lockedUntil || err.retryAfterSec) setLockedUntil(err.lockedUntil || new Date(Date.now() + (err.retryAfterSec || 0) * 1000).toISOString());
      setError(err.message || 'Verification failed');
    } finally { setBusy(false); }
  }

  return <>
    {children}
    <Dialog open={open} onOpenChange={value => { if (!value) cancel(); }}>
      <DialogContent aria-describedby={describe} className="max-w-full h-full rounded-none sm:max-w-md sm:h-auto sm:rounded-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><ShieldCheck aria-hidden="true" className="h-5 w-5 text-cyan-500"/>Confirm it is you</DialogTitle>
          <DialogDescription id={describe}>
            Taking over or deciding agent runs needs your own confirmation once in this session. This is not sudo: it
            unlocks nothing else, and it ends when you sign out.
          </DialogDescription>
        </DialogHeader>
        {usePasskey ? <div className="space-y-3">
          <Button type="button" className="w-full min-h-11" onClick={passkey} disabled={busy}>
            {busy ? <><Loader2 aria-hidden="true" className="h-4 w-4 mr-2 animate-spin"/>Verifying…</>
              : <><Fingerprint aria-hidden="true" className="h-4 w-4 mr-2"/>Verify with passkey</>}</Button>
          <button type="button" className="min-h-11 w-full text-sm text-muted-foreground underline" disabled={busy}
            onClick={() => { setUsePasskey(false); setError(''); }}>Use password and authenticator code instead</button>
          {error && <p role="alert" className="rounded-md border border-destructive/60 px-3 py-2 text-sm text-destructive break-words">{error}</p>}
          <DialogFooter><Button className="min-h-11" type="button" variant="outline" onClick={cancel} disabled={busy}>Cancel</Button></DialogFooter>
        </div> : <form onSubmit={submit} className="space-y-3">
          <div className="space-y-1.5"><Label htmlFor="agent-control-password">Password</Label>
            <Input id="agent-control-password" type="password" autoComplete="current-password" value={password} required autoFocus
              className="min-h-11" disabled={busy || !!lockedUntil} onChange={e => setPassword(e.target.value)}/></div>
          <div className="space-y-1.5"><Label htmlFor="agent-control-code">Authenticator code</Label>
            <Input id="agent-control-code" inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6} required
              className="min-h-11" placeholder="123456" value={code} disabled={busy || !!lockedUntil}
              onChange={e => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}/></div>
          {hasPasskey && <button type="button" className="min-h-11 w-full text-sm text-muted-foreground underline" disabled={busy}
            onClick={() => { setUsePasskey(true); setError(''); }}>Verify with passkey instead</button>}
          {error && <p role="alert" className="rounded-md border border-destructive/60 px-3 py-2 text-sm text-destructive break-words">{error}
            {lockedUntil && <span className="block text-xs">Try again at {new Date(lockedUntil).toLocaleTimeString()}.</span>}</p>}
          <DialogFooter className="gap-2">
            <Button className="min-h-11" type="button" variant="outline" onClick={cancel} disabled={busy}>Cancel</Button>
            <Button className="min-h-11" type="submit" disabled={busy || !!lockedUntil || !password || code.length !== 6}>
              {busy ? <><Loader2 aria-hidden="true" className="h-4 w-4 mr-2 animate-spin"/>Verifying…</> : 'Confirm'}</Button>
          </DialogFooter>
        </form>}
      </DialogContent>
    </Dialog>
  </>;
}
