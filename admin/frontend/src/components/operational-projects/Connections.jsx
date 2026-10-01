import { useEffect, useRef, useState } from 'react';
import { KeyRound } from 'lucide-react';
import { useAuth } from '@/context/AuthContext';
import BrokerIdentity from '@/components/BrokerIdentity';
import { requestSudo } from '@/lib/sudo';
import { connectionsApi as api } from '@/lib/api';
import { Action, Panel, Field, Choice } from './shared';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';

export function BrokerStatus({ capabilities }) {
  return <div role="status" className="rounded-lg border border-input bg-accent p-4 text-sm text-foreground">
    {capabilities?.mode === 'synthetic' && <strong className="block">Isolated synthetic development</strong>}
    <p>{capabilities?.execution_enabled ? 'Broker available for the supported typed adapter.' : 'Credential use is unavailable. The broker has not been activated for this installation.'}</p>
    <p>API connections do not enable browser sign-in. Saving configuration starts no run.</p>
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
    <DialogContent onCloseAutoFocus={e=>{if(returnFocus?.current){e.preventDefault();returnFocus.current.focus();}}} className="broker-colors max-w-full h-full rounded-none sm:max-w-xl sm:h-auto sm:rounded-lg [&>button]:min-h-11 [&>button]:min-w-11">
      <DialogTitle className="text-2xl font-semibold">Add connection</DialogTitle>
      <DialogDescription>Save setup details for a reusable connection. Assignment is a separate step.</DialogDescription>
      <form onSubmit={save} className="space-y-5 min-w-0">
        <div className="flex flex-wrap gap-2" aria-label="Credential types"><span className="border border-primary bg-accent text-accent-foreground rounded-md p-3">API token</span><span className="rounded-md border p-3 text-muted-foreground">Browser · unavailable</span><span className="rounded-md border p-3 text-muted-foreground">OAuth · unavailable</span></div>
        <Field label="Connection name" required maxLength={200} value={name} onChange={e => setName(e.target.value)} />
        <Choice label="Service" value="synthetic-ledger-v1" onChange={() => {}}><option value="synthetic-ledger-v1">Synthetic ledger (development only)</option></Choice>
        <Choice label="Availability" value={scope} onChange={e => setScope(e.target.value)}><option value="private">Private to me</option>{projectId && <option value="project">Selected project (explicit grants still required)</option>}</Choice>
        <div className="rounded-lg border p-4 space-y-2"><p className="font-medium">{capabilities?.intake_enabled ? 'Credential intake on the broker' : 'Credential intake unavailable'}</p><p className="text-sm text-muted-foreground">{capabilities?.intake_enabled ? 'The credential broker owns credential entry. Save setup details, then open its verified intake surface. Credentials never enter this dashboard form.' : 'A reviewed broker-owned intake surface and verified deployment are required. Do not paste a token here. The dashboard stores setup metadata only.'}</p></div>
        <details className="rounded-lg border p-3"><summary className="min-h-11 cursor-pointer">Advanced settings</summary><p className="text-sm">Static API adapter only. Destination and allowed operations are managed by the broker. Browser and OAuth enrollment are not supported.</p></details>
        {error && <div><p role="alert" className="text-destructive break-words">{error}</p><Action type="button" variant="outline" onClick={async()=>{try{await requestSudo({localOnly:true});setError('Access verified. Submit again explicitly.');}catch{setError('Verification cancelled. Nothing was resubmitted.');}}}>Verify access</Action></div>}
        {intent && <div className="space-y-3"><p role="status">{intent.state==='committed' ? 'Connection enrolled. Refresh the picker to select and explicitly assign it.' : `Setup request saved (${intent.state || intent.status}). No assignment has been created.`}</p>{intakeUrl && intent.state==='reserved' && <a href={intakeUrl} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center underline">Open trusted broker intake</a>}{intent.state==='reconcile_required' && <p>Enrollment needs reconciliation. Check status; do not submit the credential again.</p>}{capabilities?.intake_enabled && <Action type="button" variant="outline" disabled={busy} onClick={refreshIntent}>Check enrollment status</Action>}</div>}
        <div className="border-t pt-4 flex flex-col sm:flex-row gap-3 sm:justify-end"><Action type="button" variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>Close</Action><Action type="submit" disabled={busy || !!intent}>Save setup details</Action></div>
      </form>
    </DialogContent>
  </Dialog>;
}

export function ConnectionCatalogue({ projectId, agentId, onSelect, selectedIds = [], renderSelected }) {
  const opener=useRef(null);
  const { user }=useAuth();
  const [rows, setRows] = useState([]), [caps, setCaps] = useState(null), [error, setError] = useState('');
  const [notice,setNotice]=useState(''),[rotating,setRotating]=useState(null);
  const [loading, setLoading] = useState(true), [open, setOpen] = useState(false), [detail, setDetail] = useState(null), [busy, setBusy] = useState(false);
  const query = new URLSearchParams({ ...(projectId ? { project_id: projectId } : {}), ...(agentId ? { assignable_to_agent_id: agentId } : {}) }).toString();
  async function load(signal) {
    setLoading(true); setError(''); setDetail(null);
    try { const capabilities=await api.get('/capabilities',signal); if(!signal?.aborted)setCaps(capabilities); const list=await api.get(query ? `?${query}` : '',signal); if(!signal?.aborted)setRows(list.connections); }
    catch (e) { if (!signal?.aborted) { setRows([]); setDetail(null); setError(e.message); } }
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
  return <div className="broker-colors space-y-4 min-w-0">
    <div className="flex flex-col sm:flex-row sm:justify-between gap-3"><div><h2 className="text-xl font-semibold">{onSelect ? 'Choose connections' : 'Connections'}</h2><p className="text-sm text-muted-foreground">{projectId ? 'Connections available in this project.' : 'Your permitted connections across projects.'} Private access is never implied by project membership.</p></div><Action className="shrink-0 self-start" onClick={e => {opener.current=e.currentTarget;setOpen(true);}}>Add connection</Action></div>
    <BrokerStatus capabilities={caps} />
    {caps?.mode==='configured' && <BrokerIdentity capabilities={caps} currentUserId={user?.id} onChange={()=>load()} />}
    {error && <div><p role="alert" className="text-destructive break-words">{error}</p><Action type="button" variant="outline" onClick={async()=>{try{await requestSudo({localOnly:true});setError('Access verified. Submit again explicitly.');}catch{setError('Verification cancelled. Nothing was resubmitted.');}}}>Verify access</Action></div>}
    {notice && <p role="status">{notice}</p>}
    {loading ? <p role="status">Loading connections…</p> : <>
      {!rows.length && <p>No permitted connections to show. Save setup details or ask the connection owner for an explicit assignment grant.</p>}
      <ul className="space-y-3">{rows.filter(c => !onSelect || c.rights.includes('assign')).map(connection => <li key={connection.id} className={`rounded-lg border overflow-hidden min-w-0 ${selectedIds.includes(connection.id) ? 'border-primary bg-accent text-accent-foreground' : 'bg-card'}`}>
        <div className="flex items-start gap-3 p-3"><span className="rounded-md border bg-background p-2 shrink-0"><KeyRound className="h-5 w-5" aria-hidden="true" /></span><div className="min-w-0 flex-1"><h3 className="font-semibold text-sm break-words">{connection.name}</h3><p className="text-xs text-muted-foreground break-words">{connection.adapter_id==='synthetic-ledger-v1'?'Synthetic ledger · API token':connection.adapter_id} · credential v{connection.credential_version ?? 'not enrolled'}</p><p className="mt-1 text-xs break-words">{readinessLabel(connection.readiness?.code)}</p></div>{onSelect ? <Action className="shrink-0 text-xs px-2" variant="outline" disabled={connection.readiness?.code==='POLICY_REVALIDATION_REQUIRED'||connection.status==='revoked'} onClick={() => onSelect(connection)}>{selectedIds.includes(connection.id) ? 'Remove selection' : 'Select connection'}</Action> : <Action className="shrink-0 text-xs px-2" variant="outline" disabled={busy} onClick={() => inspect(connection)}>Details and access</Action>}</div>
        <div className="border-t px-3 py-3 space-y-3"><p className="text-xs break-words">Allowed use: {connection.operations.map(operationLabel).join(', ') || 'None'} · {connection.resources.length} resource(s)</p>{selectedIds.includes(connection.id) && renderSelected?.(connection)}</div>
      </li>)}</ul>
    </>}
    <Action variant="outline" disabled={busy || loading} onClick={() => load()}>Refresh connections</Action>
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

function operationLabel(value) {return ({'item.read':'Read permitted items','item.set_state':'Update permitted item state',enrolled:'Credential enrolled',rotated:'Credential rotated',tested:'Connection tested',assigned:'Agent assigned',revoked:'Connection revoked',unassigned:'Agent access removed'})[value] || String(value || 'Activity').replaceAll('_',' ');}
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
  return <Dialog open={!!connection} onOpenChange={value=>{if(!value&&!busy)onClose();}}><DialogContent className="broker-colors max-w-full h-full rounded-none sm:max-w-xl sm:h-auto sm:rounded-lg [&>button]:min-h-11 [&>button]:min-w-11"><DialogTitle>Rotate credential</DialogTitle><DialogDescription>Rotation changes {connection?.name}. After the broker commits the new version, old sessions and approvals become stale. Already accepted upstream work cannot be undone.</DialogDescription>
    <p className="text-sm">Enter the replacement only on the verified broker-owned intake surface. No credential value passes through this dashboard form.</p>
    {error&&<div><p role="alert">{error}</p><Action variant="outline" onClick={async()=>{try{await requestSudo({localOnly:true});setError('Access verified. Submit again explicitly.');}catch{setError('Verification cancelled.');}}}>Verify access</Action></div>}
    {intent&&<div className="space-y-3"><p role="status">{intent.state==='committed'?'Credential rotated. Old sessions and approvals are no longer usable.':intent.state==='reconcile_required'?'Rotation needs reconciliation. Check status and do not submit the credential again.':'Rotation request reserved. Complete it on the broker.'}</p>{url&&intent.state==='reserved'&&<a href={url} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center underline">Open trusted broker intake</a>}<Action variant="outline" disabled={busy} onClick={check}>Check rotation status</Action></div>}
    <div className="flex flex-col sm:flex-row gap-3 sm:justify-end"><Action variant="outline" disabled={busy} onClick={onClose}>Close</Action>{!intent&&<Action disabled={busy||!capabilities?.intake_enabled} onClick={reserve}>Prepare rotation</Action>}</div>
  </DialogContent></Dialog>;
}

function readinessLabel(code) {return ({SYNTHETIC_ONLY:'Verified for isolated development only',VERIFIED:'Verified for the permitted operations',READY:'Ready for the permitted operations',CONNECTION_REVOKED:'Access revoked',CONNECTION_UNVERIFIED:'Connection check needed',POLICY_REVALIDATION_REQUIRED:'Blocked: restored policy requires independent revalidation before use, testing or rotation'})[code] || 'Readiness has not been verified';}
