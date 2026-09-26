import { useEffect, useState } from 'react';
import { operationsApi as api } from '@/lib/api';
import { Action, Choice, Field, roleNames } from './shared';

const limitFields=[['cpu','CPU cores'],['memory_mib','Worker memory (MiB)'],['temporary_disk_mib','Temporary disk (MiB)'],['max_seconds','Run seconds'],['max_actions','Browser actions'],['max_tokens','Provider tokens'],['max_usd','Provider spending (USD)']];
const editLimits = values => Object.fromEntries(limitFields.map(([key])=>[key,values?.[key] == null?'':String(values[key])]));

export function AccessPolicy({base,project,onChanged}) {
  const [site,setSite]=useState(project.site_origin||''),[visibility,setVisibility]=useState(project.visibility||'hidden');
  const [limits,setLimits]=useState(()=>editLimits(project.agent_limits));
  const [reviewed,setReviewed]=useState(false),[requests,setRequests]=useState([]),[roles,setRoles]=useState({});
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[message,setMessage]=useState('');
  useEffect(()=>{setSite(project.site_origin||'');setVisibility(project.visibility||'hidden');setReviewed(false);},[project.site_origin,project.visibility]);
  useEffect(()=>setLimits(editLimits(project.agent_limits)),[project.agent_limits_revision]);
  useEffect(()=>{let live=true;api.get(`${base}/access-requests`).then(r=>{if(live)setRequests(r.requests);}).catch(e=>{if(live)setError(e.message);});return()=>{live=false;};},[base,project.revision]);
  async function save(fn,success) {
    if(busy)return;setBusy(true);setError('');setMessage('');
    try {await fn();await onChanged();setMessage(success);}
    catch(e){setError(e.status===412?`${e.message}. Review the current project before saving again.`:e.message);}
    finally{setBusy(false);}
  }
  return <div className="space-y-5 border-t pt-4">
    <h3 className="font-semibold">Project discovery and site</h3>
    {error&&<p role="alert" className="text-destructive break-words">{error}</p>}
    <p role="status" aria-live="polite">{busy?'Working…':message}</p>
    <p className="text-sm">Hidden projects are member only. Discoverable projects show eligible accounts a redacted name card and an owner-approved membership request. Discovery grants no project content or agent access.</p>
    <form className="space-y-3" onSubmit={e=>{e.preventDefault();save(()=>api.write(`${base}/visibility`,{visibility,...(project.visibility==='hidden'&&visibility!=='hidden'&&reviewed?{reviewed_visibility:'Expose redacted project card'}:{})},project.revision,'PUT'),'Discovery policy saved.');}}>
      <Choice label="Visibility preset" disabled={busy||!!project.archived_at} value={visibility} onChange={e=>{setVisibility(e.target.value);setReviewed(false);}}><option value="hidden">Hidden</option><option value="read-only">Read-only discovery</option><option value="collaborative">Collaborative discovery</option></Choice>
      {project.visibility==='hidden'&&visibility!=='hidden'&&<label className="flex min-h-11 items-center gap-3"><input type="checkbox" checked={reviewed} onChange={e=>setReviewed(e.target.checked)}/><span>I reviewed that the project name becomes visible to eligible accounts. Membership still requires my approval.</span></label>}
      <Action type="submit" disabled={busy||!!project.archived_at||visibility===project.visibility||project.visibility==='hidden'&&visibility!=='hidden'&&!reviewed}>Save visibility</Action>
    </form>
    <form className="space-y-3" onSubmit={e=>{e.preventDefault();save(()=>api.write(`${base}/site`,{site_origin:site.trim()||null},project.revision,'PUT'),'Project site saved; any site readiness must be checked again.');}}>
      <Field label="Project site HTTPS origin (optional)" type="url" placeholder="https://example.com" value={site} disabled={busy||!!project.archived_at} onChange={e=>setSite(e.target.value)}/>
      <p className="text-sm break-words">Current site: {project.site_origin||'None'} · Site revision {project.site_revision}. Saving this value changes metadata only.</p>
      <Action type="submit" disabled={busy||!!project.archived_at||site.trim()===(project.site_origin||'')}>Save site</Action>
    </form>
    <form className="space-y-3" onSubmit={e=>{e.preventDefault();const configured=Object.fromEntries(limitFields.filter(([key])=>limits[key]!==''&&limits[key]!=null).map(([key])=>[key,Number(limits[key])]));save(()=>api.write(`${base}/agent-limits`,{limits:configured},project.revision,'PUT'),'Project run limits saved.');}}>
      <h3 className="font-semibold">Agent run limits</h3>
      <p className="text-sm">Leave a field blank for no project limit. Changes are audited and invalidate a prepared run using an older policy. Agent execution remains disabled.</p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">{limitFields.map(([key,label])=><Field key={key} label={label} type="number" min={key==='max_usd'?'0.01':'1'} step={key==='max_usd'?'0.01':'1'} value={limits[key]} disabled={busy||!!project.archived_at} onChange={e=>setLimits({...limits,[key]:e.target.value})}/>)}</div>
      <Action type="submit" disabled={busy||!!project.archived_at}>Save project limits</Action>
    </form>
    <div className="space-y-3"><h3 className="font-semibold">Pending membership requests</h3>
      {!requests.length&&<p>No pending requests.</p>}
      <ul className="space-y-3">{requests.map(r=><li key={r.id} className="rounded-md border p-3 space-y-3 min-w-0"><p className="break-words">{r.username||'Deleted account'} requested access.</p>
        <Choice label={`Role for ${r.username||'requester'}`} value={project.visibility==='read-only'?'viewer':roles[r.id]||'viewer'} onChange={e=>setRoles({...roles,[r.id]:e.target.value})}>{(project.visibility==='read-only'?['viewer']:roleNames).map(role=><option key={role}>{role}</option>)}</Choice>
        <div className="flex flex-wrap gap-2"><Action disabled={busy||!!project.archived_at} onClick={()=>save(()=>api.write(`${base}/access-requests/${r.id}/decision`,{decision:'approve',role:project.visibility==='read-only'?'viewer':roles[r.id]||'viewer'},project.revision),'Membership approved.')}>Approve</Action>
          <Action variant="outline" disabled={busy||!!project.archived_at} onClick={()=>save(()=>api.write(`${base}/access-requests/${r.id}/decision`,{decision:'decline'},project.revision),'Request declined.')}>Decline</Action></div>
      </li>)}</ul>
    </div>
  </div>;
}
