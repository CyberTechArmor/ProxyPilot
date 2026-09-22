import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export default function PomeriumSetup({revision,dirty,mode,connections,origin}) {
  const [data,setData]=useState(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[message,setMessage]=useState('');
  const [connectionId,setConnection]=useState(''),[clientId,setClient]=useState('proxypilot-pomerium'),[secret,setSecret]=useState(''),[container,setContainer]=useState('');
  const [routeId,setRoute]=useState(''),[subjects,setSubjects]=useState([]),[review,setReview]=useState(null),[action,setAction]=useState('protect');
  const state=data?.state;
  async function refresh(){const value=await api.getPomeriumSetup();setData(value);return value;}
  useEffect(()=>{let active=true;const poll=async()=>{try{const value=await api.getPomeriumSetup();if(active)setData(value);}catch{if(active)setError('Gateway status could not be refreshed. Reopen this page before applying.');}};poll();const timer=setInterval(poll,5000);return()=>{active=false;clearInterval(timer);};},[]);
  useEffect(()=>setReview(null),[revision,dirty,mode,state?.revision,routeId,subjects,action]);
  async function run(fn){setBusy(true);setError('');setMessage('');try{await fn();await refresh();}catch(e){setError(e.message);}finally{setBusy(false);}}
  const canConfigure=!dirty && revision>0 && mode!=='skip';
  return <Card id="pomerium-setup">
    <CardHeader><CardTitle>Set up Pomerium</CardTitle><CardDescription>Protect selected applications through Caddy → Pomerium → app. ProxyPilot and recovery keep their independent sign-in.</CardDescription></CardHeader>
    <CardContent className="space-y-5 min-w-0">
      {mode==='skip' && <p className="text-sm">Pomerium is skipped in this plan. Skipping does not uninstall a saved gateway or remove existing protection.</p>}
      {(dirty || !revision) && <p className="text-sm">Save the reviewed platform plan before configuring the gateway.</p>}
      {error && <p role="alert" className="text-destructive break-words">{error}</p>}
      {message && <p role="status" className="border rounded-lg p-3 break-words">{message}</p>}
      {!state && canConfigure && <form className="space-y-4" onSubmit={e=>{e.preventDefault();const value=secret;setSecret('');run(async()=>{await api.savePomeriumSetup({expectedPlanRevision:revision,expectedRevision:0,connectionId,clientId,clientSecret:value,...(mode==='connect'?{externalContainer:container}:{}),reviewed:true});setMessage('Gateway settings saved. Credentials are protected. Review and apply to start verification.');});}}>
        <div className="rounded-lg bg-muted p-4 text-sm space-y-2 break-words">
          <p className="font-medium">Create a separate Keycloak client</p>
          <p>In the verified realm, enable client authentication and Standard flow. Disable implicit flow, direct access grants and service accounts. Keep G3’s client and passkey policy unchanged.</p>
          <p className="break-all">Exact redirect URI: {origin}/oauth2/callback</p><p className="break-all">Web origin: {origin}</p>
          <p>Require S256 PKCE. Use openid, profile and email scopes with RS256 signed ID tokens. Do not assign realm-admin. The guide reuses G3’s read-only observer to check this client.</p>
        </div>
        <div><Label htmlFor="pm-identity">Verified Keycloak connection</Label><select id="pm-identity" className="w-full h-11 rounded-md border bg-background px-3" value={connectionId} onChange={e=>setConnection(e.target.value)} required><option value="">Select a verified realm</option>{connections.filter(c=>c.verification).map(c=><option key={c.id} value={c.id}>{c.origin} · {c.realm}</option>)}</select></div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4"><div><Label htmlFor="pm-client">Pomerium client ID</Label><Input id="pm-client" value={clientId} onChange={e=>setClient(e.target.value)} required /></div><div><Label htmlFor="pm-secret">Client secret (saved once)</Label><Input id="pm-secret" type="password" autoComplete="new-password" value={secret} onChange={e=>setSecret(e.target.value)} required /></div></div>
        {mode==='connect' && <><div><Label htmlFor="pm-container">Existing Core container on this host</Label><Input id="pm-container" value={container} onChange={e=>setContainer(e.target.value)} required /></div><p className="text-sm">Existing Core uses a guided local configuration handoff. ProxyPilot verifies its read-only configuration and owned routes. It does not modify or restart that container. Remote, split-service and Enterprise management are unavailable in G4.</p></>}
        <Button className="min-h-11 w-full sm:w-auto" disabled={busy}>Save reviewed gateway settings</Button>
      </form>}
      {state && <>
        <section className="rounded-lg border p-4 space-y-2 text-sm min-w-0" aria-label="Pomerium saved settings">
          <p className="font-semibold break-all">{state.config.origin}</p><p>Core {data.image} · {state.config.mode==='install'?'Managed installation':'Existing connection'} · revision {state.revision}</p>
          <p className="break-all">Keycloak: {state.config.issuer} · Client: {state.config.clientId}</p>
          <p>Caddy keeps public ports and certificates. The gateway has private listeners and a separate lifecycle. Retrying reuses its credentials and route records.</p>
          <p>Job: {state.job?.status||'Not submitted'} · Phase: {(state.job?.phase||'Not started').replaceAll('_',' ')}</p>
          {state.job?.reason && <p className="break-words">{state.job.reason}</p>}
          <p>{state.verification?'Gateway configuration and unauthenticated checks verified. Complete the browser checks below.':'Gateway is not verified. A running container alone does not establish protection.'}</p>
          <p className="break-all">Protected configuration handoff: {data.handoff?.configRef}. The runner prepares this file during apply after checking identity settings; retrieve it only through the host console.</p>
          {state.config.mode==='connect' && <p>Verify the listed global settings and merge only the named ProxyPilot routes from the protected file into your existing Core JSON. Existing shared, cookie and signing credentials are preserved. Preserve unrelated routes, mount it read-only at /pomerium/config.json, and start Core after saving. Retry here for read-only verification.</p>}
          <Button className="min-h-11 w-full sm:w-auto" variant="outline" disabled={busy||!canConfigure} onClick={()=>run(async()=>{const r=await api.applyPomeriumSetup({expectedRevision:state.revision,reviewed:true});setMessage(`Job ${r.job.id}: ${r.job.status}. Progress is saved; closing the browser is safe.`);})}>Apply / retry reviewed gateway</Button>
        </section>
        <section className="space-y-4" aria-label="Application route protection">
          <h3 className="font-semibold">Select an application route</h3>
          <p className="text-sm">G4 supports a single HTTPS hostname at /, a verified native host-loopback upstream, and plain HTTP behavior. Existing IP restrictions, response headers and upload limits are retained. Unsupported combinations are refused.</p>
          <div><Label htmlFor="pm-route">Application route</Label><select id="pm-route" className="w-full h-11 rounded-md border bg-background px-3" value={routeId} onChange={e=>{setRoute(e.target.value);setAction('protect');}}><option value="">Select a supported route</option>{data.routes.filter(r=>r.supported).map(r=><option key={r.id} value={r.id}>{r.domain}</option>)}</select></div>
          {routeId && <p className="text-sm break-all">Upstream: {data.routes.find(r=>r.id===routeId)?.upstream}</p>}
          <fieldset className="space-y-2"><legend className="text-sm font-medium">Allow these verified identities; deny everyone else</legend>{!data.identities.length && <p className="text-sm">No verified identities for this realm yet. Link an account through G3 before protecting a route.</p>}{data.identities.map(i=><label key={i.subject} className="flex items-center gap-3 min-h-11 text-sm break-all"><input type="checkbox" checked={subjects.includes(i.subject)} onChange={e=>setSubjects(old=>e.target.checked?[...old,i.subject]:old.filter(x=>x!==i.subject))}/><span>{i.username} · {i.subject}</span></label>)}</fieldset>
          <Button className="min-h-11 w-full sm:w-auto" disabled={busy||!routeId||!subjects.length||!canConfigure} onClick={()=>run(async()=>{setAction('protect');setReview((await api.reviewPomeriumRoute({expectedRevision:state.revision,routeId,subjects,action:'protect'})).review);})}>Review route protection</Button>
          {data.routes.some(r=>!r.supported) && <details><summary className="min-h-11 cursor-pointer flex items-center">Routes unavailable for protection</summary><ul className="space-y-2 text-sm">{data.routes.filter(r=>!r.supported).map(r=><li key={r.id} className="break-words"><strong>{r.domain}</strong>: {r.reason}</li>)}</ul></details>}
          {state.intents.map(i=><div key={i.routeId} className="border rounded-lg p-3 space-y-2 text-sm"><p className="font-medium break-all">{i.domain} · {i.state}</p><p className="break-all">{i.upstream}</p>{i.state!=='removed' && <Button className="min-h-11" variant="outline" disabled={busy||!canConfigure} onClick={()=>run(async()=>{setRoute(i.routeId);setSubjects([]);setAction('remove');const result=await api.reviewPomeriumRoute({expectedRevision:state.revision,routeId:i.routeId,subjects:[],action:'remove'});setReview(result.review);})}>Review removal of protection</Button>}</div>)}
          {review && <section aria-label="Reviewed gateway route change" className="rounded-lg border-2 border-primary p-4 space-y-3 text-sm">
            <h4 className="font-semibold">{review.action==='remove'?'Remove gateway protection':'Enable gateway protection'}</h4><p className="break-all">{review.domain} → {review.upstream}</p><p className="break-all">Allowed subjects: {review.subjects.join(', ')||'Existing application access rules after removal'}</p><p>{review.warning}</p>
            <Button className="min-h-11 w-full sm:w-auto" disabled={busy||!canConfigure} onClick={()=>run(async()=>{await api.applyPomeriumRoute({expectedRevision:state.revision,routeId:review.routeId,subjects:review.subjects,action:review.action,reviewToken:review.reviewToken,reviewed:true});setReview(null);setMessage('Reviewed route change queued. Protection status remains pending until verification.');})}>{review.action==='remove'?'Confirm removal and restore direct route':'Apply reviewed protection'}</Button>
          </section>}
        </section>
        <details><summary className="min-h-11 cursor-pointer flex items-center">Browser checks, sessions and recovery</summary><div className="space-y-2 text-sm">
          <p>Open a selected app in a separate browser: confirm the Keycloak redirect, allowed-user access and denial for a different signed-in user. Check the identity display in the G4 test app. These browser checks are separate from the runner’s probes.</p>
          <p>Pomerium sessions last up to one hour and refresh through Keycloak. Revocation follows token refresh and session expiry; G3’s 60-second rule does not apply. An identity outage can leave already valid sessions usable until refresh or expiry. Gateway outage denies application access. In-memory gateway sessions are lost on service restart.</p>
          <p>ProxyPilot dashboard, native SSO, local recovery, MCP, delegated editing, provisioning, migration, terminal and health keep their existing authentication. Use the local recovery route and existing root recovery command if identity is unavailable.</p>
          <p>Back up ProxyPilot’s database and encryption key through the existing backup mechanism, plus a companion encrypted file pack of the protected Pomerium directory, as described in the operator guide. The ordinary configuration backup does not include that directory. Keep the configuration and encrypted credential reference together; restore instead of regenerating credentials.</p>
        </div></details>
      </>}
    </CardContent>
  </Card>;
}
