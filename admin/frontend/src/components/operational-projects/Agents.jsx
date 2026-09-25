import { useEffect, useState } from 'react';
import { operationsApi as api } from '@/lib/api';
import { Action, Choice, Field, Panel } from './shared';

const blank = { display_name:'', workflow_type:'synthetic_sign_in', proposed_actions:['navigate','click','type','read','logout'],
  proposed_origins:[], budgets:{max_seconds:300,max_actions:20,max_tokens:10000,max_usd:0.25} };
const actions=['navigate','click','type','read','download','logout'];

export function AgentConfiguration({base,project,onChanged}) {
  const [profiles,setProfiles]=useState([]),[form,setForm]=useState(blank),[selected,setSelected]=useState(null);
  const [origins,setOrigins]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(''),[message,setMessage]=useState('');
  const editable=['owner','editor'].includes(project.own_role)&&!project.archived_at;
  async function load() {const result=await api.get(`${base}/agent-profiles`);setProfiles(result.profiles);}
  useEffect(()=>{let live=true;api.get(`${base}/agent-profiles`).then(r=>{if(live)setProfiles(r.profiles);}).catch(e=>{if(live)setError(e.message);});return()=>{live=false;};},[base,project.revision]);
  async function submit(fn,success) {
    if(busy)return;setBusy(true);setError('');setMessage('');
    try {await fn();await load();await onChanged();setMessage(success);}
    catch(e){setError(e.status===412?`${e.message}. Your entered values remain; reload the profile before retrying.`:e.message);}
    finally{setBusy(false);}
  }
  function choose(p) {setSelected(p);setForm({display_name:p.display_name,workflow_type:p.workflow_type,
    proposed_actions:p.proposed_actions,proposed_origins:p.proposed_origins,budgets:p.budgets});setOrigins(p.proposed_origins.join('\n'));setError('');}
  function payload() {return {...form,proposed_origins:origins.split(/\r?\n/).map(s=>s.trim()).filter(Boolean),
    budgets:Object.fromEntries(Object.entries(form.budgets).map(([k,v])=>[k,Number(v)]))};}
  return <Panel title="Agent profiles">
    <p>Configuration only. Every profile is disabled for execution; saving or assigning a guide starts no run.</p>
    {error&&<p role="alert" className="text-destructive break-words">{error}</p>}
    <p role="status" aria-live="polite">{busy?'Working…':message}</p>
    <ul className="space-y-3">{profiles.map(p=><li key={p.id} className="rounded-md border p-3 space-y-2 min-w-0">
      <h3 className="font-medium break-words">{p.display_name}</h3>
      <p className="text-sm break-all">Profile {p.id} · Revision {p.revision} · Disabled</p>
      <p className="text-sm break-all">Guide: {p.guide_version_id?`v${p.guide_version_number??'?'} · ${p.guide_version_id} · SHA-256 ${p.guide_hash}`:'Unassigned'}</p>
      <p className="text-sm break-words">Scope: {p.proposed_actions.join(', ')||'No actions'} · {p.proposed_origins.join(', ')||'No origins'}</p>
      <p className="text-sm break-words">Limits: {p.budgets.max_seconds}s, {p.budgets.max_actions} actions, {p.budgets.max_tokens} tokens, ${p.budgets.max_usd}</p>
      <p className="text-sm break-words">{p.disabled_reasons.join('; ')}</p>
      {editable&&<div className="flex flex-wrap gap-2"><Action variant="outline" disabled={busy} onClick={()=>choose(p)}>Edit profile</Action>
        <Action variant="outline" disabled={busy||!project.current_version||p.guide_version_id===project.current_version.id&&p.assigned_site_revision===project.site_revision} onClick={()=>submit(()=>api.write(`${base}/agent-profiles/${p.id}/guide`,{guide_version_id:project.current_version.id},p.revision,'PUT'),'Current guide assigned.')}>Assign current approved guide</Action>
        <Action variant="outline" disabled={busy||!p.guide_version_id} onClick={()=>submit(()=>api.write(`${base}/agent-profiles/${p.id}/guide`,{guide_version_id:null},p.revision,'PUT'),'Guide unassigned.')}>Unassign</Action>
        <Action variant="outline" disabled={busy} onClick={()=>submit(()=>api.write(`${base}/agent-profiles/${p.id}`,{},p.revision,'DELETE'),'Profile deleted.')}>Delete profile</Action></div>}
    </li>)}</ul>
    {!profiles.length&&<p>No profiles in this project.</p>}
    {editable&&<form className="space-y-4 border-t pt-4" onSubmit={e=>{e.preventDefault();const data=payload();submit(async()=>{
      await api.write(selected?`${base}/agent-profiles/${selected.id}`:`${base}/agent-profiles`,data,selected?.revision??project.revision,selected?'PATCH':'POST');
      setSelected(null);setForm(blank);setOrigins('');},selected?'Profile updated.':'Disabled profile created.');}}>
      <h3 className="font-semibold">{selected?'Edit profile':'Create disabled profile'}</h3>
      <Field label="Profile display name" required maxLength={200} value={form.display_name} onChange={e=>setForm({...form,display_name:e.target.value})}/>
      <Choice label="Workflow type" value={form.workflow_type} onChange={e=>setForm({...form,workflow_type:e.target.value})}><option value="synthetic_sign_in">Synthetic sign-in</option></Choice>
      <fieldset className="space-y-2"><legend className="text-sm font-medium">Proposed actions</legend><div className="grid grid-cols-1 sm:grid-cols-2 gap-2">{actions.map(a=><label key={a} className="flex min-h-11 items-center gap-3"><input type="checkbox" checked={form.proposed_actions.includes(a)} onChange={e=>setForm({...form,proposed_actions:e.target.checked?[...form.proposed_actions,a]:form.proposed_actions.filter(x=>x!==a)})}/>{a}</label>)}</div></fieldset>
      <Field label="Proposed HTTPS origins, one per line" textarea rows={3} value={origins} onChange={e=>setOrigins(e.target.value)}/>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">{[['max_seconds','Seconds'],['max_actions','Browser actions'],['max_tokens','Tokens'],['max_usd','USD']].map(([key,label])=><Field key={key} label={`Maximum ${label}`} type="number" min={key==='max_usd'?'0.01':'1'} max={{max_seconds:300,max_actions:20,max_tokens:10000,max_usd:0.25}[key]} step={key==='max_usd'?'0.01':'1'} required value={form.budgets[key]} onChange={e=>setForm({...form,budgets:{...form.budgets,[key]:e.target.value}})}/>)}</div>
      <div className="flex flex-wrap gap-2"><Action type="submit" disabled={busy}>Save profile</Action>{selected&&<Action type="button" variant="outline" onClick={()=>{setSelected(null);setForm(blank);setOrigins('');}}>Cancel editing</Action>}</div>
    </form>}
  </Panel>;
}
