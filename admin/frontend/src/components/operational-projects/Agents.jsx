import { useEffect, useId, useState } from 'react';
import { operationsApi as api } from '@/lib/api';
import { Action, Choice, Field, Panel } from './shared';

const blank = { display_name:'', workflow_type:'synthetic_sign_in', proposed_actions:['navigate','click','type','read','logout'],
  proposed_origins:[] };
const actions=['navigate','click','type','read','download','logout'];

export function AgentConfiguration({base,project,onChanged,runsEnabled=false}) {
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
    proposed_actions:p.proposed_actions,proposed_origins:p.proposed_origins});setOrigins(p.proposed_origins.join('\n'));setError('');}
  function payload() {return {...form,proposed_origins:origins.split(/\r?\n/).map(s=>s.trim()).filter(Boolean)};}
  return <Panel title="Agent profiles">
    {runsEnabled?<p>Saving a profile or assigning a guide starts no run. Runs start only from Agent runs, where each profile shows whether it can start and why not.</p>
      :<p>Configuration only. Every profile is disabled for execution; saving or assigning a guide starts no run.</p>}
    <p>Run limits belong to the project. The owner can set them in Project discovery and site; unset limits are unbounded.</p>
    {error&&<p role="alert" className="text-destructive break-words">{error}</p>}
    <p role="status" aria-live="polite">{busy?'Working…':message}</p>
    <ul className="space-y-3">{profiles.map(p=><li key={p.id} className="rounded-md border p-3 space-y-2 min-w-0">
      <h3 className="font-medium break-words">{p.display_name}</h3>
      <p className="text-sm break-all">Profile {p.id} · Revision {p.revision}{runsEnabled?'':' · Disabled'}</p>
      <p className="text-sm break-all">Guide: {p.guide_version_id?`v${p.guide_version_number??'?'} · ${p.guide_version_id} · SHA-256 ${p.guide_hash}`:'Unassigned'}</p>
      <p className="text-sm break-words">Scope: {p.proposed_actions.join(', ')||'No actions'} · {p.proposed_origins.join(', ')||'No origins'}</p>
      {!runsEnabled&&<p className="text-sm break-words">{p.disabled_reasons.join('; ')}</p>}
      {runsEnabled&&<><ModelConsent base={base} project={project} profile={p} busy={busy} submit={submit}/><SummaryConsent base={base} project={project} profile={p} busy={busy} submit={submit}/><EnforcedRules base={base} profile={p}/></>}
      {editable&&<><div className="flex flex-wrap gap-2"><Action variant="outline" disabled={busy} onClick={()=>choose(p)}>Edit profile</Action>
        <Action variant="outline" aria-describedby={`${p.id}-assign`} disabled={busy||!project.current_version||p.guide_version_id===project.current_version.id&&p.assigned_site_revision===project.site_revision} onClick={()=>submit(()=>api.write(`${base}/agent-profiles/${p.id}/guide`,{guide_version_id:project.current_version.id},p.revision,'PUT'),'Current guide assigned.')}>Assign current approved guide</Action>
        <Action variant="outline" disabled={busy||!p.guide_version_id} onClick={()=>submit(()=>api.write(`${base}/agent-profiles/${p.id}/guide`,{guide_version_id:null},p.revision,'PUT'),'Guide unassigned.')}>Unassign</Action>
        <Action variant="outline" disabled={busy} onClick={()=>submit(()=>api.write(`${base}/agent-profiles/${p.id}`,{},p.revision,'DELETE'),'Profile deleted.')}>Delete profile</Action></div>
        <p id={`${p.id}-assign`} className="text-sm text-muted-foreground">{!project.current_version?'There is no current approved guide to assign.':p.guide_version_id===project.current_version.id&&p.assigned_site_revision===project.site_revision?'The current approved guide is assigned.':'A newer approved guide or site change is waiting to be assigned.'}</p></>}
    </li>)}</ul>
    {!profiles.length&&<p>No profiles in this project.</p>}
    {editable&&<form className="space-y-4 border-t pt-4" onSubmit={e=>{e.preventDefault();const data=payload();submit(async()=>{
      await api.write(selected?`${base}/agent-profiles/${selected.id}`:`${base}/agent-profiles`,data,selected?.revision??project.revision,selected?'PATCH':'POST');
      setSelected(null);setForm(blank);setOrigins('');},selected?'Profile updated.':runsEnabled?'Profile created.':'Disabled profile created.');}}>
      <h3 className="font-semibold">{selected?'Edit profile':runsEnabled?'Create profile':'Create disabled profile'}</h3>
      <Field label="Profile display name" required maxLength={200} value={form.display_name} onChange={e=>setForm({...form,display_name:e.target.value})}/>
      <Choice label="Workflow type" value={form.workflow_type} onChange={e=>setForm({...form,workflow_type:e.target.value})}><option value="synthetic_sign_in">Synthetic sign-in</option></Choice>
      <fieldset className="space-y-2"><legend className="text-sm font-medium">Proposed actions</legend><div className="grid grid-cols-1 sm:grid-cols-2 gap-2">{actions.map(a=><label key={a} className="flex min-h-11 items-center gap-3"><input type="checkbox" checked={form.proposed_actions.includes(a)} onChange={e=>setForm({...form,proposed_actions:e.target.checked?[...form.proposed_actions,a]:form.proposed_actions.filter(x=>x!==a)})}/>{a}</label>)}</div></fieldset>
      <Field label="Proposed HTTPS origins, one per line" textarea rows={3} value={origins} onChange={e=>setOrigins(e.target.value)}/>
      <div className="flex flex-wrap gap-2"><Action type="submit" disabled={busy}>Save profile</Action>{selected&&<Action type="button" variant="outline" onClick={()=>{setSelected(null);setForm(blank);setOrigins('');}}>Cancel editing</Action>}</div>
    </form>}
  </Panel>;
}

const CONSENT_STATEMENT = "Send this profile's approved guide to the model provider";

// A5 consent, owner only: whether a run may send this profile's approved guide
// to the model provider when the rules leave the model a choice. Enabling needs
// the reviewed statement; either change bumps the profile revision, so a run
// pinned before it refuses its next use.
function ModelConsent({base,project,profile,busy,submit}) {
  const [reviewed,setReviewed]=useState(false),hint=useId();
  const owner=project.own_role==='owner'&&!project.archived_at;
  useEffect(()=>setReviewed(false),[profile.revision]);
  return <div className="space-y-2 border-t pt-2">
    <p className="text-sm font-medium">Model provider consent: {profile.model_guide_consent?'given':'not given'}</p>
    <p id={hint} className="text-sm text-muted-foreground">{owner?'When the rules leave a choice, the model (gpt-6-luna) receives this approved guide and typed claims, never page text or a credential.':'Only the owner can change this.'}</p>
    {owner&&(profile.model_guide_consent
      ?<Action variant="outline" disabled={busy} aria-describedby={hint} onClick={()=>submit(()=>api.write(`${base}/agent-profiles/${profile.id}/model-guide-consent`,{model_guide_consent:false},profile.revision,'PUT'),'Consent withdrawn.')}>Withdraw consent</Action>
      :<><label className="flex min-h-11 items-center gap-3"><input type="checkbox" checked={reviewed} onChange={e=>setReviewed(e.target.checked)}/><span>I reviewed: {CONSENT_STATEMENT}.</span></label>
        <Action disabled={busy||!reviewed} aria-describedby={hint} onClick={()=>submit(()=>api.write(`${base}/agent-profiles/${profile.id}/model-guide-consent`,{model_guide_consent:true,reviewed_statement:CONSENT_STATEMENT},profile.revision,'PUT'),'Consent given.')}>Give consent</Action>
        {!reviewed&&<p className="text-sm">Tick the reviewed statement to enable consent.</p>}</>)}
  </div>;
}

const SUMMARY_STATEMENT = "Send this profile's finished runs, as typed facts, to the model provider for a summary";

// A7 decision 5, owner only: whether a finished run of this profile gets one
// model summary, written from typed facts (codes, counts, states): never page
// text, the guide or a credential. It changes nothing a run is pinned to.
function SummaryConsent({base,project,profile,busy,submit}) {
  const [reviewed,setReviewed]=useState(false),hint=useId();
  const owner=project.own_role==='owner'&&!project.archived_at;
  useEffect(()=>setReviewed(false),[profile.revision,profile.model_summary_consent]);
  return <div className="space-y-2 border-t pt-2">
    <p className="text-sm font-medium">Model summaries of finished runs: {profile.model_summary_consent?'allowed':'not allowed'}</p>
    <p id={hint} className="text-sm text-muted-foreground">{owner?'When a run ends, the model (gpt-6-luna) writes a short summary from the run\'s typed facts only, charged to the run\'s budget. It is shown as the model\'s words, to check against the record.':'Only the owner can allow or stop summaries.'}</p>
    {owner&&(profile.model_summary_consent
      ?<Action variant="outline" disabled={busy} aria-describedby={hint} onClick={()=>submit(()=>api.write(`${base}/agent-profiles/${profile.id}/model-summary-consent`,{model_summary_consent:false},profile.revision,'PUT'),'Summaries turned off.')}>Stop summaries</Action>
      :<><label className="flex min-h-11 items-center gap-3"><input type="checkbox" checked={reviewed} onChange={e=>setReviewed(e.target.checked)}/><span>I reviewed: {SUMMARY_STATEMENT}.</span></label>
        <Action disabled={busy||!reviewed} aria-describedby={hint} onClick={()=>submit(()=>api.write(`${base}/agent-profiles/${profile.id}/model-summary-consent`,{model_summary_consent:true,reviewed_statement:SUMMARY_STATEMENT},profile.revision,'PUT'),'Summaries allowed.')}>Allow summaries</Action>
        {!reviewed&&<p className="text-sm">Tick the reviewed statement to allow summaries.</p>}</>)}
  </div>;
}

const RULE_ROWS=[['start','Start with'],['finish','Finish with'],['model_actions','The model may choose among'],['forbid','Never'],['approval_required','Needs a person\'s approval'],['stop_when','Stops when']];
// Read-only: the hard rules parsed from the assigned guide, exactly what code
// enforces. The guide is changed only through independent review.
function EnforcedRules({base,profile}) {
  const [state,setState]=useState(null),[open,setOpen]=useState(false);
  useEffect(()=>{if(!open)return undefined;let live=true;setState(null);api.get(`${base}/agent-profiles/${profile.id}/rules`).then(r=>{if(live)setState(r);}).catch(e=>{if(live)setState({error:e.message});});return()=>{live=false;};},[open,base,profile.id,profile.guide_hash]);
  return <details className="rounded-md border p-3" onToggle={e=>setOpen(e.currentTarget.open)}>
    <summary className="cursor-pointer min-h-11 py-2 font-medium">Hard rules enforced by code</summary>
    {!state?<p role="status" className="text-sm">Loading the rules…</p>:state.error?<p role="alert" className="text-sm text-destructive break-words">{state.error}</p>
      :!state.rules?<p className="text-sm break-words">No enforceable rules: {state.refusal_message||state.refusal}. A run of this profile cannot start.</p>
      :<dl className="grid grid-cols-1 sm:grid-cols-3 gap-x-4 gap-y-1 text-sm pt-2">
        {RULE_ROWS.map(([key,label])=><div key={key} className="contents"><dt className="text-muted-foreground">{label}</dt><dd className="sm:col-span-2 break-words">{state.rules[key].length?state.rules[key].join(', '):'—'}</dd></div>)}
        <dt className="text-muted-foreground">Limits</dt><dd className="sm:col-span-2">At most {state.rules.max_steps} steps and {state.rules.max_model_calls} model calls</dd>
        <dt className="text-muted-foreground">Model</dt><dd className="sm:col-span-2">{state.rules.model?`${state.rules.model.name}, at most ${state.rules.model.max_output_tokens} output tokens`:'None: every step is decided by a rule'}</dd>
        <dt className="text-muted-foreground">Guide</dt><dd className="sm:col-span-2 break-all font-mono text-xs">{state.guide_hash}</dd>
      </dl>}
  </details>;
}
