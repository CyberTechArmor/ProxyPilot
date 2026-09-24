import { useEffect, useState } from 'react';
import { ExternalLink, Copy } from 'lucide-react';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import PomeriumRouteProtection from '@/components/PomeriumRouteProtection';
import KeycloakLdapLink from '@/components/KeycloakLdapLink';
import PlatformAccess from '@/components/PlatformAccess';

// "Use your platform": where each installed service is and what it is for,
// kept visible after setup (the per-stage panels only show while a stage is current).
const PURPOSE = {
  keycloak: 'Your identity provider: accounts, passkeys, groups and single sign-on for everything else.',
  pomerium: 'The sign-in gate in front of sites. It has no page of its own; use "Require sign-in on a site" below.',
  infisical: 'Secrets for agents and apps, handed out per machine identity (Agent Proxy).',
  openbao: 'A vault for machine secrets and short-lived credentials (API keys, database logins, certificates) that apps fetch at runtime.',
  vaultwarden: 'Your password manager (Bitwarden-compatible apps and browser extension).',
};
const ORDER = ['keycloak', 'pomerium', 'infisical', 'openbao', 'vaultwarden'];

function Copyable({ value }) {
  const [done, setDone] = useState(false);
  return <span className="inline-flex items-center gap-1 min-w-0"><code className="break-all">{value}</code><Button type="button" variant="ghost" size="icon" className="h-11 w-11 shrink-0" aria-label={`Copy ${value}`} onClick={async () => { try { await navigator.clipboard.writeText(value); setDone(true); setTimeout(() => setDone(false), 1500); } catch { /* clipboard unavailable: the value is shown */ } }}><Copy className="h-4 w-4" aria-hidden="true" /></Button>{done && <span role="status" className="text-xs">Copied</span>}</span>;
}

export default function PlatformLinks({ services, realm }) {
  const [bao, setBao] = useState(null);
  const present = ORDER.map(id => services.find(s => s.id === id)).filter(s => s && ['verified', 'awaiting_user_action'].includes(s.state));
  const hasBao = present.some(s => s.id === 'openbao'), pomeriumReady = present.some(s => s.id === 'pomerium' && s.state === 'verified'), keycloakReady = present.some(s => s.id === 'keycloak' && s.state === 'verified');
  useEffect(() => { if (!hasBao) return; let active = true; api.getOpenBaoSetup().then(v => { if (active) setBao(v?.signIn || null); }).catch(() => {}); return () => { active = false; }; }, [hasBao]);
  if (!present.length) return null;
  const link = (href, text) => <a className="inline-flex items-center gap-1 min-h-11 underline break-all" href={href} target="_blank" rel="noreferrer">{text}<ExternalLink className="h-4 w-4 shrink-0" aria-hidden="true" /></a>;
  return <div className="space-y-6 min-w-0">
    <p className="text-sm text-muted-foreground">Recovery, OpenBao and Infisical answer only on your VPN or restricted networks; Vaultwarden, the Keycloak admin console and the dashboard follow the switches below.</p>
    <ul className="grid grid-cols-1 lg:grid-cols-2 gap-3">{present.map(s => <li key={s.id} className="rounded-lg border p-4 space-y-2 text-sm min-w-0">
      <p className="font-semibold">{s.name}</p>
      <p>{PURPOSE[s.id]}</p>
      {s.id === 'keycloak' && <>{link(`${s.url}/admin/master/console/`, 'Administration console')}<br />{realm && link(`${s.url}/realms/${encodeURIComponent(realm)}/account/`, `Your account in ${realm} (passkeys, sessions)`)}</>}
      {s.id === 'openbao' && <>{link(bao?.url || `${s.url}/ui/`, 'Open OpenBao')}
        {bao && <ol className="list-decimal pl-5 space-y-1"><li>Method <b>OIDC</b> → <b>More options</b> → Mount path: <Copyable value={bao.mountPath} /></li><li>Role: <code>{bao.role}</code> (or blank) → Sign in with Keycloak.</li>{bao.workspace && <li>To add a secret: Secrets engines → <code className="break-all">{bao.workspace.engine}</code> → Create secret → path <code>{bao.workspace.path}your-name</code>.</li>}</ol>}
        {bao?.scope && <p className="text-muted-foreground">{bao.scope}</p>}</>}
      {['infisical', 'vaultwarden'].includes(s.id) && link(s.url, `Open ${s.name}`)}
      {s.state !== 'verified' && <p className="text-muted-foreground">Setup still has a step to finish for this service (see its stage above).</p>}
    </li>)}</ul>
    <section aria-labelledby="pp-access" className="space-y-2"><h3 id="pp-access" className="font-semibold">Who can reach each service</h3><PlatformAccess /></section>
    {keycloakReady && <section aria-labelledby="pp-directory-link" className="space-y-2"><h3 id="pp-directory-link" className="font-semibold">Connect a directory (LDAP)</h3><KeycloakLdapLink /></section>}
    {pomeriumReady && <section aria-labelledby="pp-require-signin" className="space-y-2"><h3 id="pp-require-signin" className="font-semibold">Require sign-in on a site</h3><PomeriumRouteProtection /></section>}
  </div>;
}
