import { useEffect, useId, useRef, useState } from 'react';
import { ChevronDown, Database, LockKeyhole, Plus, RefreshCw } from 'lucide-react';
import { useAuth } from '@/context/AuthContext';
import BrokerIdentity from '@/components/BrokerIdentity';
import { requestSudo } from '@/lib/sudo';
import { connectionsApi as api } from '@/lib/api';
import { Action, Panel, Field } from './shared';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { connectionAssignmentState, connectionStatus, operationLabel } from './connection-ui-logic';

export function BrokerStatus({ capabilities, compact=false }) {
  const message=!capabilities?'Checking broker availability.':capabilities.mode==='configured'&&capabilities.compatible!==true?'Incompatible broker. Verify its contract and deployment.':capabilities.execution_enabled?'Broker available for the synthetic ledger API.':capabilities.intake_enabled?'Credential intake available. Check agent readiness before execution.':'Credential use unavailable. Configure or verify the broker.';
  if(compact)return <div role="status" className="operations-card rounded-md border border-input bg-accent px-3 text-xs text-foreground"><details className="group"><summary className="min-h-11 sm:min-h-9 flex cursor-pointer items-center gap-2"><LockKeyhole className="h-4 w-4 shrink-0" aria-hidden="true"/><span>{capabilities?.mode==='synthetic'&&'Development only · '}{message}</span><ChevronDown className="ml-auto h-3.5 w-3.5 shrink-0 group-open:rotate-180" aria-hidden="true"/></summary><p className="pb-3">Credentials are entered on trusted broker intake. Saving a draft grants no access and starts no run.</p></details></div>;
  return <div role="status" className="operations-card rounded-md border border-input bg-accent p-3 text-sm text-foreground flex items-start gap-2">
    <LockKeyhole className="h-4 w-4 mt-0.5 shrink-0" aria-hidden="true"/><div className="space-y-1">
    {capabilities?.mode === 'synthetic' && <strong className="block">Isolated synthetic development</strong>}
    <p>{message}</p>
    {!compact&&<p>Draft saving starts no run. Browser sign-in and OAuth are unavailable.</p>}</div>
  </div>;
}

export function AddConnection({ open, onOpenChange, projectId, onSaved, capabilities, returnFocus }) {
  const [name, setName] = useState(''), [scope, setScope] = useState('private');
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [intent, setIntent] = useState(null);
  useEffect(() => { if (open) { setName(''); setError(''); setIntent(null); setScope('private'); } }, [open]);
  async function save(event) {
    event.preventDefault(); if (busy) return; setBusy(true); setError('');
    try {
      const result = await api.write('/enrollment-intents', { name, project_id: scope === 'project' ? projectId : null, adapter_id: 'synthetic-ledger-v1' });
      setIntent(result.intent); onSaved?.();
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  const intakeUrl = trustedIntakeUrl(intent?.intake_url, capabilities);
  async function refreshIntent() {
    setBusy(true);setError('');
    try {const result=await api.get(`/enrollment-intents/${encodeURIComponent(intent.id)}`);setIntent(result.intent);if(result.intent.state==='committed')onSaved?.();}
    catch(e){setError(e.message);}finally{setBusy(false);}
  }
  return <Dialog open={open} onOpenChange={value => { if (!busy) onOpenChange(value); }}>
    <DialogContent onCloseAutoFocus={e=>{if(returnFocus?.current){e.preventDefault();returnFocus.current.focus();}}} className="operations-dialog broker-colors max-w-full h-full rounded-none p-4 sm:p-6 sm:max-w-[600px] sm:h-auto sm:rounded-md [&>button]:min-h-11 [&>button]:min-w-11">
      <div className="pr-11 space-y-1"><DialogTitle className="text-[28px] leading-tight font-semibold tracking-tight">Add connection</DialogTitle>
      <DialogDescription>Save setup details for a reusable connection. Assignment is a separate step.</DialogDescription></div>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-b text-sm" aria-label="Enrollment options"><span className="border-b-2 border-primary pb-3 font-medium text-primary">New credential</span><span className="pb-3 text-muted-foreground">Link existing secret · unavailable</span></div>
      <form onSubmit={save} className="space-y-4 min-w-0">
        <ConnectionFormRow label="Connection name">{id=><input id={id} className={connectionControl} required maxLength={200} value={name} onChange={e => setName(e.target.value)} />}</ConnectionFormRow>
        <ConnectionFormRow label="Credential type">{id=><div id={id} className="flex flex-wrap gap-2 text-xs" aria-label="Credential types"><span className="border border-primary bg-primary text-primary-foreground rounded-md px-2 py-2">API token</span><span className="rounded-md border px-2 py-2 text-muted-foreground">Browser · unavailable</span><span className="rounded-md border px-2 py-2 text-muted-foreground">OAuth · unavailable</span></div>}</ConnectionFormRow>
        <ConnectionFormRow label="Service" hint="Permitted ledger items only: read or update state.">{id=><div id={id} className="rounded-md border bg-muted/20 px-3 py-2 text-sm">Synthetic ledger <span className="text-muted-foreground">(development only)</span></div>}</ConnectionFormRow>
        <ConnectionFormRow label="Availability" hint="Assigning to an agent requires an explicit assignment grant.">{id=><select id={id} className={connectionControl} value={scope} onChange={e=>setScope(e.target.value)}><option value="private">Private to me</option>{projectId&&<option value="project">Selected project</option>}</select>}</ConnectionFormRow>
        <div className="rounded-lg border p-3 space-y-1"><p className="font-medium">{capabilities?.intake_enabled ? 'Credential intake on the broker' : 'Credential intake unavailable'}</p><p className="text-sm text-muted-foreground">{capabilities?.intake_enabled ? 'Enter the credential only on trusted broker intake.' : 'Broker intake and a verified deployment are required.'}</p></div>
        <details className="operations-card rounded-md border px-4"><summary className="min-h-11 sm:min-h-10 cursor-pointer flex items-center font-medium">Advanced connection settings</summary><p className="text-sm text-muted-foreground pb-4">The broker controls the service address and allowed operations for the synthetic-ledger-v1 adapter. Browser passwords, OAuth and arbitrary destinations are unavailable.</p></details>
        <p className="flex items-start gap-2 rounded-md bg-accent p-3 text-sm"><LockKeyhole className="h-4 w-4 shrink-0 mt-0.5" aria-hidden="true"/>Credentials stay on the broker. Saving setup details grants no agent access.</p>
        {error && <div><p role="alert" className="text-destructive break-words">{error}</p><Action type="button" variant="outline" onClick={async()=>{try{await requestSudo({localOnly:true});setError('Access verified. Submit again explicitly.');}catch{setError('Verification cancelled. Nothing was resubmitted.');}}}>Verify access</Action></div>}
        {intent && <div className="space-y-3"><p role="status">{intent.state==='committed' ? 'Connection enrolled. Refresh the picker to select and explicitly assign it.' : `Setup request saved (${intent.state || intent.status}). No assignment has been created.`}</p>{intakeUrl && intent.state==='reserved' && <a href={intakeUrl} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center underline">Open trusted broker intake</a>}{intent.state==='reconcile_required' && <p>Enrollment needs reconciliation. Check status; do not submit the credential again.</p>}{capabilities?.intake_enabled && <Action type="button" variant="outline" disabled={busy} onClick={refreshIntent}>Check enrollment status</Action>}</div>}
        <div className="border-t pt-4 flex flex-col sm:flex-row gap-3 sm:justify-between"><Action type="button" variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>Close</Action><Action type="submit" disabled={busy || !!intent}>Save setup details</Action></div>
      </form>
    </DialogContent>
  </Dialog>;
}

const connectionControl='min-h-11 sm:min-h-10 w-full min-w-0 rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';
function ConnectionFormRow({label,hint,children}) {
  const id=useId();
  return <div className="grid grid-cols-1 sm:grid-cols-[8rem_minmax(0,1fr)] gap-2 sm:gap-4 sm:items-start"><label htmlFor={id} className="text-sm font-medium sm:pt-2.5">{label}</label><div className="space-y-1.5 min-w-0">{children(id)}{hint&&<p className="text-xs text-muted-foreground">{hint}</p>}</div></div>;
}

export function ConnectionCatalogue({ projectId, agentId, onSelect, selectedIds = [], renderSelected, onCatalogueChange }) {
  const opener=useRef(null);
  const { user }=useAuth();
  const [rows, setRows] = useState([]), [caps, setCaps] = useState(null), [error, setError] = useState('');
  const [notice,setNotice]=useState(''),[rotating,setRotating]=useState(null);
  const [loading, setLoading] = useState(true), [open, setOpen] = useState(false), [detail, setDetail] = useState(null), [busy, setBusy] = useState(false);
  const query = new URLSearchParams({ ...(projectId ? { project_id: projectId } : {}), ...(agentId ? { assignable_to_agent_id: agentId } : {}) }).toString();
  async function load(signal) {
    setLoading(true); setError(''); setDetail(null);
    try {
      const capabilities=await api.get('/capabilities',signal); if(!signal?.aborted)setCaps(capabilities);
      // Keep visible, permission-filtered states alongside the broker's exact-agent
      // assignment decision. Generic catalogue rights cannot replace that decision.
      const [list,assignable]=await Promise.all([api.get(projectId?`?project_id=${encodeURIComponent(projectId)}`:'',signal),agentId?api.get(`?${query}`,signal):Promise.resolve(null)]);
      const connections=assignable?list.connections.map(connection=>({...connection,assignable_to_agent:assignable.connections.some(candidate=>candidate.id===connection.id)})):list.connections;
      if(!signal?.aborted){setRows(connections);onCatalogueChange?.(connections);}
    }
    catch (e) { if (!signal?.aborted) { setRows([]); setDetail(null); onCatalogueChange?.([]);setError(e.message); } }
    finally { if (!signal?.aborted) setLoading(false); }
  }
  useEffect(() => { const controller = new AbortController(); setDetail(null); load(controller.signal); return () => controller.abort(); }, [query]);
  async function inspect(connection) {
    setBusy(true); setError(''); setDetail(null);
    try { const [a, s, e] = await Promise.all(['assignments', 'sessions', 'activity'].map(path => api.get(`/${connection.id}/${path}`))); setDetail({ connection, assignments: a.assignments, sessions: s.sessions, events: e.events }); }
    catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  async function mutate(path, revision, message) {
    setBusy(true); setError('');
    try { await api.write(path, {}, revision); setNotice(path.endsWith('/test') ? 'Connection test passed for the configured adapter and permitted read scope.' : 'Access change saved. Already accepted upstream work cannot be undone.'); setDetail(null); await load(); }
    catch (e) { setError(`${message}: ${e.message}`); } finally { setBusy(false); }
  }
  return <div className="operations-ui broker-colors space-y-4 min-w-0">
    <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3"><div><h2 className={onSelect?'text-lg font-semibold':'operations-heading'}>{onSelect ? 'Application access' : 'Connection catalogue'}</h2>{!onSelect&&<p className="text-sm text-muted-foreground">{projectId?'Connections available in this project.':'Your permitted connections across projects.'} Private access requires an explicit grant.</p>}</div><Action variant={onSelect?'outline':'default'} className="shrink-0 self-start" onClick={e => {opener.current=e.currentTarget;setOpen(true);}}><Plus className="h-4 w-4 mr-2 shrink-0" aria-hidden="true"/>Add connection</Action></div>
    {!onSelect&&<BrokerStatus capabilities={caps} />}
    {caps?.mode==='configured' && <BrokerIdentity capabilities={caps} currentUserId={user?.id} onChange={()=>load()} />}
    {error && <div><p role="alert" className="text-destructive break-words">{error}</p><Action type="button" variant="outline" onClick={async()=>{try{await requestSudo({localOnly:true});setError('Access verified. Submit again explicitly.');}catch{setError('Verification cancelled. Nothing was resubmitted.');}}}>Verify access</Action></div>}
    {notice && <p role="status">{notice}</p>}
    {loading ? <p role="status">Loading connections…</p> : <>
      {!rows.length && <p>No permitted connections to show. Save setup details or ask the connection owner for an explicit assignment grant.</p>}
      <ul className="space-y-2">{rows.map(connection => {
        const selected=selectedIds.includes(connection.id),assignment=connectionAssignmentState(connection),status=connectionStatus(connection);
        return <li key={connection.id} className={`operations-card rounded-md border overflow-hidden min-w-0 ${selected ? 'border-primary bg-accent text-accent-foreground' : 'bg-card'}`}>
          <div className="flex flex-col sm:flex-row sm:items-center gap-3 p-3 sm:py-2"><div className="flex items-start sm:items-center gap-3 min-w-0 flex-1">
            {onSelect&&<button type="button" aria-label={selected?'Remove selection':'Select connection'} aria-pressed={selected} disabled={(!selected&&!assignment.selectable)||loading||busy} onClick={()=>onSelect(connection)} className="inline-flex h-11 w-11 sm:h-9 sm:w-9 -m-1.5 shrink-0 items-center justify-center rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"><span aria-hidden="true" className={`flex h-4 w-4 items-center justify-center rounded border ${selected?'border-primary bg-primary text-primary-foreground':'border-input bg-background'}`}>{selected&&'✓'}</span></button>}
            <Database className="h-6 w-6 shrink-0 mt-0.5 sm:mt-0 text-foreground" aria-hidden="true"/><div className="min-w-0 flex-1"><h3 className="font-medium text-sm break-words">{connection.name}</h3><p className="text-xs text-muted-foreground break-words">{connection.adapter_id==='synthetic-ledger-v1'?(onSelect?'API token':'Synthetic ledger · API token'):connection.adapter_id} · {connection.credential_version?`credential v${connection.credential_version}`:'not enrolled'}</p></div></div>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 sm:justify-end pl-9 sm:pl-0"><span className="inline-flex items-center gap-1.5 text-xs whitespace-nowrap"><span aria-hidden="true" className={`h-2 w-2 rounded-full ${status.tone==='ready'?'bg-emerald-600':'bg-muted-foreground'}`}/>{status.label}</span>{onSelect?<span className="text-xs text-muted-foreground">{assignment.label}</span>:<Action className="text-xs px-3" variant="outline" disabled={busy} onClick={()=>inspect(connection)}>Details and access</Action>}</div>
          </div>
          {(selected||!onSelect||!assignment.selectable)&&<div className="border-t mx-3 py-2 space-y-2">{(!selected||status.tone!=='ready'||!assignment.selectable)&&<p className="text-xs break-words">{!assignment.selectable&&onSelect?assignment.reason:readinessLabel(connection.readiness?.code)}</p>}{!selected&&<p className="text-xs break-words">Allowed use: {connection.operations.map(operationLabel).join(', ') || 'None'} · {connection.resources.length} resource(s)</p>}{selected&&renderSelected?.(connection)}</div>}
        </li>;
      })}</ul>
    </>}
    <Action variant="outline" disabled={busy || loading} onClick={() => load()}><RefreshCw className="h-4 w-4 mr-2" aria-hidden="true"/>Refresh connections</Action>
    {onSelect&&<BrokerStatus capabilities={caps} compact/>}
    {detail && <Panel title={detail.connection.name}>
      <p className="text-sm break-words">Your permissions: {detail.connection.rights.join(', ')}. Revoking the connection affects every assignment. Removing one assignment preserves other agents’ access.</p>
      {detail.connection.rights.includes('manage') && <div className="space-y-4"><RenameConnection connection={detail.connection} onChanged={() => { setDetail(null); load(); }} /><div className="flex flex-wrap gap-3"><Action disabled={busy || !(caps?.mode==='synthetic'||(caps?.mode==='configured'&&caps.compatible===true&&caps.reason==='READY')) || detail.connection.readiness?.code==='POLICY_REVALIDATION_REQUIRED'} onClick={() => mutate(`/${detail.connection.id}/test`, detail.connection.revision, 'Test failed')}>Test (read only)</Action><Action variant="outline" disabled={busy || !caps?.intake_enabled || detail.connection.readiness?.code==='POLICY_REVALIDATION_REQUIRED'} onClick={()=>setRotating(detail.connection)}>Rotate credential</Action></div><ConfirmRevoke label="Revoke connection" explanation="All assignments and future sessions for this connection will stop. An upstream request already accepted cannot be undone." busy={busy} onConfirm={() => mutate(`/${detail.connection.id}/revoke`, detail.connection.revision, 'Revocation failed')} /></div>}
      <h3 className="font-semibold">Assignments</h3>{!detail.assignments.length && <p>No visible assignments.</p>}{detail.assignments.map(a => <div className="rounded-lg border p-3 space-y-2 break-words" key={a.id}><p>Agent {a.agent_id} · {a.revoked?'Revoked':a.status || 'Active'}</p>{detail.connection.rights.includes('assign') && <ConfirmRevoke label="Remove from agent" explanation="Only this assignment and its sessions will be revoked. The shared connection remains available to other agents." busy={busy} onConfirm={() => mutate(`/assignments/${a.id}/revoke`, a.revision, 'Removal failed')} />}</div>)}
      <h3 className="font-semibold">Sessions</h3>{!detail.sessions.length && <p>No visible sessions.</p>}{detail.sessions.map(s => <p key={s.id} className="text-sm break-words">{s.revoked?'Revoked':s.connection_revision!==undefined&&s.connection_revision!==detail.connection.revision?'Stale':s.status || 'Active'} · expires {formatTime(s.expires_at)}</p>)}
      <h3 className="font-semibold">Activity</h3>{!detail.events.length && <p>No visible activity.</p>}{detail.events.map((e, i) => <p key={e.id || i} className="text-sm break-words">{operationLabel(e.operation || e.action || e.type)}{e.status?` · ${e.status}`:''} · {formatTime(e.created_at ?? e.at)}</p>)}
    </Panel>}
    <RotateConnection connection={rotating} capabilities={caps} onClose={()=>setRotating(null)} onChanged={()=>{setDetail(null);load();}}/>
    <AddConnection open={open} onOpenChange={setOpen} projectId={projectId} capabilities={caps} returnFocus={opener} onSaved={() => load()} />
  </div>;
}
function ConfirmRevoke({ label, explanation, onConfirm, busy }) {
  const [confirm, setConfirm] = useState(false);
  return <div className="space-y-2">{confirm ? <><p>{explanation}</p><div className="flex flex-wrap gap-2"><Action disabled={busy} onClick={onConfirm}>Confirm {label.toLowerCase()}</Action><Action disabled={busy} variant="outline" onClick={() => setConfirm(false)}>Cancel</Action></div></> : <Action disabled={busy} variant="outline" onClick={() => setConfirm(true)}>{label}</Action>}</div>;
}
function RenameConnection({ connection, onChanged }) {
  const [name, setName] = useState(connection.name), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  return <form className="space-y-3" onSubmit={async e => { e.preventDefault(); setBusy(true); setError(''); try { await api.write(`/${connection.id}`, { name }, connection.revision, 'PATCH'); onChanged(); } catch (e) { setError(e.message); } finally { setBusy(false); } }}><Field label="Connection name" value={name} maxLength={200} required onChange={e => setName(e.target.value)} />{error && <p role="alert">{error}</p>}<Action variant="outline" disabled={busy || name === connection.name}>Update name</Action></form>;
}

// The URL is capability data from a configured broker, never an arbitrary form field.
export function trustedIntakeUrl(value, capabilities) {
  if (!['synthetic','configured'].includes(capabilities?.mode) || (capabilities.mode==='configured'&&capabilities.compatible!==true) || !capabilities.intake_enabled || !capabilities.intake_origin || !value) return null;
  try { const url=new URL(value), origin=new URL(capabilities.intake_origin);
    if(url.origin!==origin.origin || url.username || url.password || url.hash || url.search || !/^\/intake\/[a-zA-Z0-9-]+$/.test(url.pathname))return null;
    if(url.protocol!=='https:' && !(url.protocol==='http:' && ['127.0.0.1','localhost','[::1]'].includes(url.hostname)))return null;
    return url.href;
  } catch {return null;}
}

function formatTime(value) {const date=new Date(value);return Number.isNaN(date.valueOf())?'Unknown expiry':date.toLocaleString();}
function RotateConnection({connection,capabilities,onClose,onChanged}) {
  const [intent,setIntent]=useState(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  useEffect(()=>{setIntent(null);setError('');},[connection?.id]);
  async function reserve(){
    if(busy)return;setBusy(true);setError('');
    try{const result=await api.write(`/${connection.id}/rotation-intents`,{},connection.revision);setIntent(result.intent);}
    catch(e){setError(e.message);}finally{setBusy(false);}
  }
  async function check(){
    setBusy(true);setError('');
    try{const result=await api.get(`/enrollment-intents/${encodeURIComponent(intent.id)}`);setIntent(result.intent);if(result.intent.state==='committed')onChanged();}
    catch(e){setError(e.message);}finally{setBusy(false);}
  }
  const url=trustedIntakeUrl(intent?.intake_url,capabilities);
  return <Dialog open={!!connection} onOpenChange={value=>{if(!value&&!busy)onClose();}}><DialogContent className="operations-dialog broker-colors max-w-full h-full rounded-none sm:max-w-xl sm:h-auto sm:rounded-md [&>button]:min-h-11 [&>button]:min-w-11"><DialogTitle>Rotate credential</DialogTitle><DialogDescription>Rotation changes {connection?.name}. After the broker commits the new version, old sessions and approvals become stale. Already accepted upstream work cannot be undone.</DialogDescription>
    <p className="text-sm">Enter the replacement only on the verified broker-owned intake surface. No credential value passes through this dashboard form.</p>
    {error&&<div><p role="alert">{error}</p><Action variant="outline" onClick={async()=>{try{await requestSudo({localOnly:true});setError('Access verified. Submit again explicitly.');}catch{setError('Verification cancelled.');}}}>Verify access</Action></div>}
    {intent&&<div className="space-y-3"><p role="status">{intent.state==='committed'?'Credential rotated. Old sessions and approvals are no longer usable.':intent.state==='reconcile_required'?'Rotation needs reconciliation. Check status and do not submit the credential again.':'Rotation request reserved. Complete it on the broker.'}</p>{url&&intent.state==='reserved'&&<a href={url} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center underline">Open trusted broker intake</a>}<Action variant="outline" disabled={busy} onClick={check}>Check rotation status</Action></div>}
    <div className="flex flex-col sm:flex-row gap-3 sm:justify-end"><Action variant="outline" disabled={busy} onClick={onClose}>Close</Action>{!intent&&<Action disabled={busy||!capabilities?.intake_enabled} onClick={reserve}>Prepare rotation</Action>}</div>
  </DialogContent></Dialog>;
}

function readinessLabel(code) {return ({SYNTHETIC_ONLY:'Verified for isolated development only',VERIFIED:'Verified for the permitted operations',READY:'Ready for the permitted operations',CONNECTION_REVOKED:'Access revoked',CONNECTION_UNVERIFIED:'Connection check needed',POLICY_REVALIDATION_REQUIRED:'Blocked: restored policy requires independent revalidation before use, testing or rotation'})[code] || 'Readiness has not been verified';}
