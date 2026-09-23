import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

// Quick LDAP Link: connect an LDAP / Active Directory directory to the managed
// Keycloak realm (read-only user federation). Backend: routes/full-platform.js
// (/ldap, /ldap/remove) → lib/setup-engine/keycloak-ldap.js. Passwords live in
// component state only until submit. Doc: docs/features/keycloak-ldap.md.
const DEFAULTS = {
  ad: { usernameAttribute: 'sAMAccountName', rdnAttribute: 'cn', uuidAttribute: 'objectGUID', userObjectClasses: 'person, organizationalPerson, user' },
  other: { usernameAttribute: 'uid', rdnAttribute: 'uid', uuidAttribute: 'entryUUID', userObjectClasses: 'inetOrgPerson, organizationalPerson' },
};
const PHASES = { ldap_admin_login: 'Signing in to Keycloak as the administrator', ldap_test_connection: 'Testing the connection to the directory', ldap_test_authentication: 'Testing the service account', ldap_save_provider: 'Saving the directory link', ldap_group_mapper: 'Setting up the group mapping', ldap_sync: 'Importing users', ldap_remove: 'Removing the directory link' };
const EMPTY = { vendor: 'ad', connectionUrl: '', startTls: false, bindDn: '', usersDn: '', usernameAttribute: '', rdnAttribute: '', uuidAttribute: '', userObjectClasses: '', userFilter: '', groupsDn: '', groupName: '', displayName: 'Directory' };
const fromConfig = c => c ? Object.fromEntries(Object.keys(EMPTY).map(key => [key, c[key] ?? EMPTY[key]])) : EMPTY;

function Field({ id, label, help, className = '', ...props }) {
  return <div className={`space-y-1 min-w-0 ${className}`}><Label htmlFor={id}>{label}</Label><Input id={id} className="h-11" {...props} />{help && <p className="text-xs text-muted-foreground break-words">{help}</p>}</div>;
}

function AdminProof({ administrator, secrets, setSecrets }) {
  return <fieldset className="space-y-3 min-w-0 rounded-lg border p-3"><legend className="px-1 text-sm font-medium">Confirm with your Keycloak administrator sign-in</legend>
    <p className="text-xs text-muted-foreground">ProxyPilot keeps no Keycloak write access. It signs in once as <strong className="break-all">{administrator || 'your permanent administrator'}</strong> for this change, then signs out and forgets the password.</p>
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
      <Field id="pp-ldap-admin-password" label="Keycloak administrator password" type="password" autoComplete="current-password" value={secrets.adminPassword} onChange={e => setSecrets(s => ({ ...s, adminPassword: e.target.value }))} />
      <div className="space-y-1 min-w-0"><Label htmlFor="pp-ldap-otp">One-time code (only if you use one)</Label><Input id="pp-ldap-otp" inputMode="numeric" autoComplete="one-time-code" maxLength={8} className="h-12 text-center tracking-[0.5em] text-lg" value={secrets.otp} onChange={e => setSecrets(s => ({ ...s, otp: e.target.value.replace(/\D/g, '') }))} /></div>
    </div>
  </fieldset>;
}

export default function KeycloakLdapLink() {
  const [data, setData] = useState(null), [mode, setMode] = useState('view'), [form, setForm] = useState(EMPTY), [busy, setBusy] = useState(false), [error, setError] = useState(''), [loadError, setLoadError] = useState('');
  const [secrets, setSecrets] = useState({ bindPassword: '', adminPassword: '', otp: '' });
  const active = useRef(true);
  async function refresh() { try { const value = await api.getKeycloakLdap(); if (active.current) { setData(value); setLoadError(''); } return value; } catch (e) { if (active.current) setLoadError(e.message || 'The directory link status could not be loaded.'); return null; } }
  useEffect(() => { active.current = true; refresh(); return () => { active.current = false; }; }, []);
  const pending = data?.state === 'pending';
  useEffect(() => { if (!pending) return; const timer = setInterval(refresh, 4000); return () => clearInterval(timer); }, [pending]);
  const set = key => e => setForm(f => ({ ...f, [key]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));
  const d = DEFAULTS[form.vendor];
  const plainLdap = /^ldap:\/\//i.test(form.connectionUrl.trim());

  async function submit(kind) {
    const proof = { revision: data.revision, adminPassword: secrets.adminPassword, ...(secrets.otp ? { otp: secrets.otp } : {}), reviewed: true };
    const body = kind === 'remove' ? proof : { ...proof, ...form, bindPassword: secrets.bindPassword };
    setSecrets({ bindPassword: '', adminPassword: '', otp: '' });
    setBusy(true); setError('');
    try { await (kind === 'remove' ? api.removeKeycloakLdap(body) : api.linkKeycloakLdap(body)); setMode('view'); await refresh(); }
    catch (e) { setError(e.message || 'The request was refused.'); }
    finally { setBusy(false); }
  }

  if (!data) return loadError ? <p role="alert" className="text-sm text-destructive break-words">{loadError}</p> : <p role="status" className="text-sm">Loading the directory link…</p>;
  if (!data.ready) return <p className="text-sm break-words">{data.readyReason}</p>;
  const job = data.lastJob, sync = data.sync, users = sync?.users;
  return <div className="space-y-4 min-w-0">
    <p className="text-sm">Let people sign in with the company accounts they already have (Active Directory or another LDAP directory). Keycloak only <strong>reads</strong> the directory, it never changes it. Everything that signs in through Keycloak (ProxyPilot SSO, sites protected by Pomerium, Vaultwarden, OpenBao) then accepts directory users. Being able to sign in does not grant access by itself: each service's own rules and groups still decide.</p>
    <div role="status" aria-live="polite" className="rounded-lg border p-3 text-sm space-y-1 min-w-0 break-words">
      {data.state === 'not_configured' && <p>No directory is connected.</p>}
      {data.linked && data.config && <p><strong>Connected (read-only):</strong> <span className="break-all">{data.config.displayName} · {data.config.connectionUrl}</span></p>}
      {data.linked && data.config && <p className="text-muted-foreground break-all">Users from {data.config.usersDn}{data.groupMapped ? ` · group “${data.config.groupName}” mapped to the Keycloak group of the same name` : ''}</p>}
      {data.linked && sync && <p>Last import: {users ? `${users.added} added, ${users.updated} updated, ${users.failed} failed` : sync.note}{sync.groups ? ` · groups: ${sync.groups.added} added, ${sync.groups.updated} updated` : ''}{sync.groupNote ? ` · ${sync.groupNote}` : ''}</p>}
      {pending && <p>Working: {PHASES[job?.phase] || 'Waiting for the platform runner to pick up the request'}…</p>}
      {data.state === 'failed' && job?.reason && <p role="alert" className="text-destructive">{job.operation === 'remove' ? 'Removing' : 'Connecting'} did not finish: {job.reason}</p>}
    </div>
    {mode === 'view' && <div className="flex flex-col sm:flex-row gap-2">
      <Button className="min-h-11 w-full sm:w-auto" disabled={pending || busy} onClick={() => { setForm(fromConfig(data.config)); setError(''); setMode('edit'); }}>{data.linked ? 'Change directory settings' : 'Connect a directory'}</Button>
      {data.linked && <Button variant="outline" className="min-h-11 w-full sm:w-auto" disabled={pending || busy} onClick={() => { setError(''); setMode('remove'); }}>Remove directory link</Button>}
    </div>}
    {mode === 'edit' && <form className="space-y-4 min-w-0" onSubmit={e => { e.preventDefault(); submit('link'); }}>
      <fieldset className="space-y-3 min-w-0"><legend className="text-sm font-medium">1. Which directory</legend>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="space-y-1 min-w-0"><Label htmlFor="pp-ldap-vendor">Directory type</Label><select id="pp-ldap-vendor" className="w-full min-h-11 rounded-md border bg-background px-3 text-sm" value={form.vendor} onChange={set('vendor')} disabled={data.linked}><option value="ad">Microsoft Active Directory</option><option value="other">OpenLDAP or another LDAP directory</option></select>{data.linked && <p className="text-xs text-muted-foreground">To change the type, remove the link and connect again.</p>}</div>
          <Field id="pp-ldap-url" label="Directory address" required value={form.connectionUrl} onChange={set('connectionUrl')} placeholder="ldaps://dc1.corp.example.com:636" help="Use ldaps:// (encrypted, port 636). ldap:// is allowed only with StartTLS below." autoComplete="off" spellCheck={false} />
        </div>
        <label className="flex items-center gap-3 min-h-11 text-sm"><input type="checkbox" className="h-5 w-5 shrink-0" checked={form.startTls} onChange={set('startTls')} /><span>Use StartTLS (only for an ldap:// address)</span></label>
        {plainLdap && !form.startTls && <p className="text-xs text-destructive">A plain ldap:// address would send the password unencrypted. Turn on StartTLS or use ldaps://.</p>}
      </fieldset>
      <fieldset className="space-y-3 min-w-0"><legend className="text-sm font-medium">2. The account Keycloak reads with</legend>
        <p className="text-xs text-muted-foreground">A service account that may read users (no write rights needed). Its password is handed to Keycloak and not kept by ProxyPilot.</p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field id="pp-ldap-bind-dn" label="Service account (bind DN)" required value={form.bindDn} onChange={set('bindDn')} placeholder="CN=svc-keycloak,OU=Service Accounts,DC=corp,DC=example,DC=com" autoComplete="off" spellCheck={false} />
          <Field id="pp-ldap-bind-password" label="Service account password" type="password" required autoComplete="new-password" value={secrets.bindPassword} onChange={e => setSecrets(s => ({ ...s, bindPassword: e.target.value }))} help={data.linked ? 'Enter it again to save changes.' : undefined} />
        </div>
      </fieldset>
      <fieldset className="space-y-3 min-w-0"><legend className="text-sm font-medium">3. Where the users are</legend>
        <Field id="pp-ldap-users-dn" label="Users location (DN)" required value={form.usersDn} onChange={set('usersDn')} placeholder="OU=Staff,DC=corp,DC=example,DC=com" help="Users in this folder and the folders below it can sign in." autoComplete="off" spellCheck={false} />
      </fieldset>
      <fieldset className="space-y-3 min-w-0"><legend className="text-sm font-medium">4. Optional: bring one directory group across</legend>
        <p className="text-xs text-muted-foreground">Members of this directory group are put into a Keycloak group with the same name. Use that Keycloak group in the platform's access rules (for example who may open a protected site).</p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field id="pp-ldap-groups-dn" label="Groups location (DN)" value={form.groupsDn} onChange={set('groupsDn')} placeholder="OU=Groups,DC=corp,DC=example,DC=com" autoComplete="off" spellCheck={false} />
          <Field id="pp-ldap-group-name" label="Group name" value={form.groupName} onChange={set('groupName')} placeholder="Platform Users" autoComplete="off" />
        </div>
      </fieldset>
      <details className="rounded-lg border p-3 min-w-0"><summary className="min-h-11 cursor-pointer flex items-center text-sm font-medium">Advanced (the defaults fit most directories)</summary>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-3">
          <Field id="pp-ldap-username-attr" label="Username attribute" value={form.usernameAttribute} onChange={set('usernameAttribute')} placeholder={d.usernameAttribute} help="What people type as their username." disabled={data.linked} />
          <Field id="pp-ldap-rdn-attr" label="RDN attribute" value={form.rdnAttribute} onChange={set('rdnAttribute')} placeholder={d.rdnAttribute} help="The first part of a user's DN." disabled={data.linked} />
          <Field id="pp-ldap-uuid-attr" label="Unique ID attribute" value={form.uuidAttribute} onChange={set('uuidAttribute')} placeholder={d.uuidAttribute} help="Never changes, even when a user is renamed." disabled={data.linked} />
          <Field id="pp-ldap-classes" label="User object classes" value={form.userObjectClasses} onChange={set('userObjectClasses')} placeholder={d.userObjectClasses} />
          <Field id="pp-ldap-filter" label="Extra user filter (optional)" value={form.userFilter} onChange={set('userFilter')} placeholder="(memberOf=CN=Platform Users,OU=Groups,DC=corp,DC=example,DC=com)" help="Only users matching this LDAP filter can sign in. Starts with ( and ends with )." spellCheck={false} />
          <Field id="pp-ldap-name" label="Name shown in Keycloak" value={form.displayName} onChange={set('displayName')} placeholder="Directory" />
        </div>
      </details>
      <AdminProof administrator={data.administrator} secrets={secrets} setSecrets={setSecrets} />
      <p className="text-xs text-muted-foreground">Keycloak first tests the connection and the service account. Nothing is saved if either test fails. Keycloak must trust the directory's certificate (its CA) for ldaps:// and StartTLS.</p>
      {error && <p role="alert" className="text-sm text-destructive break-words">{error}</p>}
      <div className="flex flex-col sm:flex-row gap-2">
        <Button type="submit" className="min-h-11 w-full sm:w-auto" disabled={busy || !form.connectionUrl || !form.bindDn || !form.usersDn || !secrets.bindPassword || !secrets.adminPassword}>{busy ? 'Sending…' : 'Test and connect'}</Button>
        <Button type="button" variant="outline" className="min-h-11 w-full sm:w-auto" disabled={busy} onClick={() => { setSecrets({ bindPassword: '', adminPassword: '', otp: '' }); setError(''); setMode('view'); }}>Cancel</Button>
      </div>
    </form>}
    {mode === 'remove' && <form className="space-y-4 min-w-0 rounded-lg border-2 border-destructive p-4" onSubmit={e => { e.preventDefault(); submit('remove'); }}>
      <h4 className="font-semibold">Remove the directory link?</h4>
      <ul className="list-disc pl-5 text-sm space-y-1 break-words">
        <li>Keycloak deletes the link <strong>and every user it imported from the directory</strong>. Those people can no longer sign in to the platform services.</li>
        <li>The directory itself is not changed. Keycloak accounts created by hand, and other directory links, are not touched.</li>
        <li>A Keycloak group created from the directory may remain, without its directory members.</li>
      </ul>
      <AdminProof administrator={data.administrator} secrets={secrets} setSecrets={setSecrets} />
      {error && <p role="alert" className="text-sm text-destructive break-words">{error}</p>}
      <div className="flex flex-col sm:flex-row gap-2">
        <Button type="submit" variant="destructive" className="min-h-11 w-full sm:w-auto" disabled={busy || !secrets.adminPassword}>{busy ? 'Sending…' : 'Confirm: remove directory link'}</Button>
        <Button type="button" variant="outline" className="min-h-11 w-full sm:w-auto" disabled={busy} onClick={() => { setSecrets({ bindPassword: '', adminPassword: '', otp: '' }); setError(''); setMode('view'); }}>Cancel</Button>
      </div>
    </form>}
  </div>;
}
