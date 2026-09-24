import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

// Stage D: create (or resume) the Infisical administrator. The free edition has
// no Keycloak sign-in, so the recommended path generates the password into
// OpenBao (backend: lib/setup-engine/infisical-admin-vault.js); the person reads
// it there after a passkey sign-in. Choosing a password stays available.
export default function InfisicalAdministrator({ data, administrator, locked, run, load, setNotice }) {
  const vault = data.infisicalPassword || {};
  const submit = (e, generate) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget), input = { revision: data.revision, email: f.get('email'), ...(generate ? { generate: true } : { password: f.get('password'), ...(f.get('keep') ? { keepInOpenBao: true } : {}) }), reviewed: true };
    if (!generate) e.currentTarget.elements.password.value = '';
    run('infisical-admin', async () => { await api.fullPlatformInfisicalAdministrator(input); await load(); setNotice(generate ? 'Queued. ProxyPilot generates the password into OpenBao, then creates the Infisical administrator with it.' : 'Personal Infisical handoff queued. The organization and machine connections are managed automatically.'); });
  };
  return <div className="pt-3 space-y-4 min-w-0">
    <p className="text-sm">Infisical’s free edition has no Keycloak sign-in, so its administrator signs in with an email and password.</p>
    {vault.generated && vault.location && <p className="text-sm rounded-lg border p-3 break-words">The Infisical password is kept in OpenBao: <code className="break-all">{vault.location.engine}</code> → <code className="break-all">{vault.location.path}</code>. See “Use your platform” below for how to open it.</p>}
    {vault.canGenerate
      ? <form className="space-y-3" onSubmit={e => submit(e, true)}>
          <p className="text-sm">Recommended: ProxyPilot generates a long password and stores it in OpenBao at <code className="break-all">{vault.location.engine}/{vault.location.path}</code>, keeping no copy. You read it there after signing in to OpenBao with your Keycloak passkey. Resumes read it back automatically.</p>
          <Label htmlFor="full-if-gen-email">Infisical administrator email</Label>
          <Input id="full-if-gen-email" className="min-h-11" name="email" type="email" required defaultValue={administrator.email} autoComplete="email" />
          <Button type="submit" className="min-h-11 w-full sm:w-auto" disabled={locked}>Generate password and create administrator</Button>
        </form>
      : <p className="text-sm text-muted-foreground">Finish OpenBao (automatic custody) to have ProxyPilot generate this password and keep it there.</p>}
    <details className="rounded-lg border p-3"><summary className="min-h-11 cursor-pointer flex items-center text-sm font-medium">Choose a password yourself</summary>
      <form className="pt-3 space-y-3" onSubmit={e => submit(e, false)}>
        <p className="text-sm">Choose it once; retries use the same account. ProxyPilot removes it from the protected handoff after use or expiry.</p>
        <Label htmlFor="full-if-email">Infisical administrator email</Label>
        <Input id="full-if-email" className="min-h-11" name="email" type="email" required defaultValue={administrator.email} autoComplete="email" />
        <Label htmlFor="full-if-password">Infisical personal password</Label>
        <Input id="full-if-password" className="min-h-11" name="password" type="password" required minLength={12} autoComplete="new-password" />
        {vault.canGenerate && <label className="flex items-start gap-3 min-h-11 text-sm"><input type="checkbox" name="keep" defaultChecked className="h-5 w-5 mt-0.5 shrink-0" /><span>Keep it in OpenBao at <code className="break-all">{vault.location.engine}/{vault.location.path}</code>, so you can read it there with your passkey and an interrupted setup reads it back by itself. It is stored only after Infisical accepts it (or before the account is created).</span></label>}
        {!vault.canGenerate && <p className="text-sm text-muted-foreground">Keep it in Vaultwarden yourself; ProxyPilot does not keep a copy.</p>}
        <Button type="submit" className="min-h-11 w-full sm:w-auto" variant="outline" disabled={locked}>Create or resume with this password</Button>
      </form>
    </details>
  </div>;
}
