import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Activity, ArrowRight, Bot, CheckCircle2, FileText, KeyRound, Settings2, Users } from 'lucide-react';
import { useAuth } from '@/context/AuthContext';
import { operationsApi as api } from '@/lib/api';
import { Action, Panel, Field, Choice, GuideText, roleNames } from '@/components/operational-projects/shared';

import { Demonstrations, EvidenceSet, evidenceDisclaimer } from '@/components/operational-projects/Evidence';
import { BrokerAgents } from '@/components/operational-projects/BrokerAgents';
import { ConnectionCatalogue } from '@/components/operational-projects/Connections';
import { AgentConfiguration } from '@/components/operational-projects/Agents';
import { AccessPolicy } from '@/components/operational-projects/AccessPolicy';
import { AgentRunsPanel } from '@/components/operational-projects/AgentRuns';
import { NewProjectButton, ProjectBrowser, ProjectPageHeader, ProjectStatus } from '@/components/operational-projects/ProjectSurface';

const blankRun={started_at:'',ended_at:'',outcome:'completed',notes:'',reason:''};
const localTime=iso=>{const d=new Date(iso);return new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,16);};

export default function OperationalProjectDetail() {
  const {id}=useParams(),{user}=useAuth();
  return <Operation key={`${id}:${user?.id}`} id={id}/>;
}
function Operation({id}) {
  const {user}=useAuth(),navigate=useNavigate(),base=`/${id}`;
  const [data,setData]=useState(null),[section,setSection]=useState(()=>{const value=new URLSearchParams(window.location.search).get('section');return ['Overview','Guide','Versions','Runs','Access','Agents','Agent runs','Details'].includes(value)?value:'Overview';}),[busy,setBusy]=useState(false);
  const [error,setError]=useState(''),[message,setMessage]=useState(''),[draft,setDraft]=useState(null),[meta,setMeta]=useState(null);
  const [reason,setReason]=useState(''),[identifier,setIdentifier]=useState(''),[candidate,setCandidate]=useState(null),[grantRole,setGrantRole]=useState('viewer');
  const [transfer,setTransfer]=useState(''),[discard,setDiscard]=useState(false),[selectedVersion,setSelectedVersion]=useState(null);
  const [runForm,setRunForm]=useState(blankRun),[runVersion,setRunVersion]=useState(null),[correcting,setCorrecting]=useState(null),[relatedRun,setRelatedRun]=useState(null);
  const [capability,setCapability]=useState(false),[evidenceTick,setEvidenceTick]=useState(0),[selectionDirty,setSelectionDirty]=useState(false);
  const [agentCapability,setAgentCapability]=useState(false),[runsCapability,setRunsCapability]=useState(false);
  const [execution,setExecution]=useState({available:false,message:''});
  const [params,setParams]=useSearchParams(),openRun=params.get('run');
  const [projectList,setProjectList]=useState([]),[brokerSetupActive,setBrokerSetupActive]=useState(false);
  useEffect(()=>{const c=new AbortController();api.get('',c.signal).then(r=>{if(!c.signal.aborted)setProjectList(r.projects);}).catch(()=>setProjectList([]));return()=>c.abort();},[user?.id]);
  useEffect(()=>{const target=params.get('section');if(['Overview','Guide','Versions','Runs','Access','Agents','Agent runs','Details'].includes(target))setSection(target);},[params]);
  const openSection=tab=>{setSection(tab);setError('');setParams({section:tab},{replace:true});};
  const requests=useRef(null),generation=useRef(0);
  const retry=useRef(null),alive=useRef(true),errorRef=useRef(null);
  const clearPrivate=()=>{setData(null);setDraft(null);setMeta(null);setRunForm(blankRun);setRunVersion(null);setCorrecting(null);setRelatedRun(null);setSelectedVersion(null);setCandidate(null);setReason('');setIdentifier('');retry.current=null;};
  async function refresh(replace=false) {
    const gen=++generation.current,signal=requests.current?.signal;
    const caps=await api.get('/capabilities',signal);
    const {project}=await api.get(base,signal);
    const [d,v,r,e,a]=await Promise.all([api.get(`${base}/draft`,signal),api.get(`${base}/versions`,signal),api.get(`${base}/runs`,signal),api.get(`${base}/events?order=desc`,signal),project.own_role==='owner'?api.get(`${base}/access`,signal):null]);
    if(!alive.current||gen!==generation.current)return;
    setCapability(caps.enabled&&caps.evidence_enabled);setAgentCapability(caps.enabled&&caps.agents_metadata_enabled);setRunsCapability(!!caps.agent_runs_enabled);setEvidenceTick(t=>t+1);
    setExecution({available:caps.agent_execution_available===true,message:caps.agent_execution_message||''});
    setData({p:project,d:d.draft,v,r,e,a});
    if(replace===true||replace==='draft')setDraft({title:d.draft.title,instructions:d.draft.instructions,revision:d.draft.revision});
    if(replace===true||replace==='meta')setMeta({name:project.name,description:project.description,revision:project.revision});
  }
  // An aborted request belongs to an unmounted pass (React StrictMode mounts twice in development); it is not an error.
  useEffect(()=>{alive.current=true;const controller=new AbortController();requests.current=controller;setBusy(true);refresh(true).catch(e=>{if(alive.current&&!controller.signal.aborted){clearPrivate();setError(e.message);}}).finally(()=>{if(alive.current)setBusy(false);});return()=>{alive.current=false;generation.current++;controller.abort();};},[id,user?.id]);
  useEffect(()=>{const check=()=>refresh(false).catch(e=>{if(alive.current){clearPrivate();setCapability(false);setError(e.message);}});const timer=setInterval(check,30000);window.addEventListener('focus',check);return()=>{clearInterval(timer);window.removeEventListener('focus',check);};},[id,user?.id]);
  useEffect(()=>{if(error)errorRef.current?.focus();},[error]);
  async function perform(fn,success='Saved.',replace=false) {
    if(busy)return;setBusy(true);setError('');setMessage('');
    try {await fn();if(!alive.current)return;await refresh(replace);setMessage(success);}
    catch(e){if(!alive.current)return;setError(e.status===412?`${e.message}. Your input is retained. Refresh to compare with the server before explicitly reloading the form.`:e.message);
      if([401,403,404].includes(e.status)){try{await refresh(false);}catch{clearPrivate();}}
    } finally {if(alive.current)setBusy(false);}
  }
  const write=(path,body,rev,method)=>api.write(`${base}${path}`,body,rev,method);
  // Pagination needs no full refresh, which would replace the accumulated pages.
  async function loadMore(kind) {
    setBusy(true);setError('');
    try {const field=kind==='v'?'versions':kind==='r'?'runs':'events';const page=await api.get(`${base}/${field}?after=${data[kind].next_cursor}${kind==='e'?'&order=desc':''}`);setData(old=>({...old,[kind]:{...page,[field]:[...old[kind][field],...page[field]]}}));}
    catch(e){setError(e.message);if([401,403,404].includes(e.status))clearPrivate();}finally{setBusy(false);}
  }
  if(!data)return <div className="operations-ui space-y-4"><Link className="underline inline-flex min-h-11 items-center" to="/operational-projects">Back to Operations</Link><h1 className="operations-title">Project</h1><p role={error?'alert':'status'}>{error||'Loading…'}</p><Action disabled={busy} onClick={()=>perform(()=>Promise.resolve(),'Reloaded.',true)}>Retry</Action></div>;
  const {p,d,v,r,e,a}=data,owner=p.own_role==='owner',editable=['owner','editor'].includes(p.own_role),reviewer=['owner','reviewer'].includes(p.own_role);
  const active=!p.archived_at,canRun=p.own_role!=='viewer',pending=d.pending_submission;
  const dirty=draft&&(draft.title!==d.title||draft.instructions!==d.instructions||draft.revision!==d.revision);
  const actorName=accountId=>accountId===user?.id?user.username:accountId===p.owner_user_id?p.owner_name:a?.members.find(member=>member.user_id===accountId)?.username||'Project member';
  async function record(event) {
    event.preventDefault();
    if(!runVersion)return;
    const payload={started_at:new Date(runForm.started_at).toISOString(),ended_at:new Date(runForm.ended_at).toISOString(),outcome:runForm.outcome,notes:runForm.notes,
      ...(correcting?{reason:runForm.reason}:{version_id:runVersion.id})};
    const signature=JSON.stringify({correcting:correcting?.id,payload});
    if(retry.current?.signature!==signature)retry.current={signature,key:crypto.randomUUID()};
    await perform(async()=>{await write(correcting?`/runs/${correcting.id}/corrections`:'/runs',{...payload,idempotency_key:retry.current.key});setRunForm(blankRun);setRunVersion(null);setCorrecting(null);retry.current=null;},'Manual record saved.');
  }
  async function chooseRun(version,old=null) {
    setRunVersion(version);setCorrecting(old);setRunForm(old?{...blankRun,started_at:localTime(old.started_at),ended_at:localTime(old.ended_at),notes:old.notes,outcome:old.outcome}:blankRun);openSection('Runs');retry.current=null;
  }
  const runsPanel=<AgentRunsPanel base={base} project={p} runId={openRun} onOpenRun={run=>setParams({section:'Agent runs',run})} onCloseRun={()=>setParams({section:'Agent runs'})}/>;
  // An open agent run is a deck of its own (RunDeck.jsx): a breadcrumb instead of the page header and sections, and the layout's own gutters.
  if(section==='Agent runs'&&runsCapability&&openRun)return <div className="operations-ui max-w-screen-2xl mx-auto w-full flex flex-col gap-3 min-w-0">
    <nav aria-label="Breadcrumb" className="hidden lg:block"><ol className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
      <li><Link className="hover:text-foreground hover:underline" to="/operational-projects">Operations</Link></li><li aria-hidden="true">›</li>
      <li className="min-w-0 [overflow-wrap:anywhere]"><Link className="hover:text-foreground hover:underline" to={`/operational-projects/${id}`} onClick={()=>setSection('Overview')}>{p.name}</Link></li><li aria-hidden="true">›</li>
      <li><Link className="hover:text-foreground hover:underline" to={`/operational-projects/${id}?section=${encodeURIComponent('Agent runs')}`}>Agent runs</Link></li></ol></nav>
    {error&&<div ref={errorRef} tabIndex={-1} role="alert" className="border border-destructive rounded-md p-3 text-destructive break-words">{error}</div>}
    {runsPanel}
  </div>;
  return <div className="operations-ui w-full max-w-screen-2xl mx-auto space-y-6 min-w-0">
    <ProjectPageHeader><NewProjectButton/></ProjectPageHeader>
    <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,0.4fr)_minmax(0,0.6fr)] gap-4 min-w-0" data-project-workspace>
    <ProjectBrowser projects={projectList.some(item=>item.id===p.id)?projectList.map(item=>item.id===p.id?p:item):[p,...projectList]} selectedId={id} section={section} collapsible/>
    <div className="operations-card space-y-4 min-w-0 rounded-md border bg-card p-4 sm:p-6" data-selected-project>
    <header className="space-y-3"><div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3"><div className="min-w-0"><p className="text-xs font-medium uppercase text-muted-foreground mb-2">Project</p><div className="flex flex-wrap items-center gap-3"><h2 className="operations-heading break-words [overflow-wrap:anywhere]">{p.name}</h2><ProjectStatus project={p}/></div><p className="text-sm text-muted-foreground mt-2 break-words">Owner: {p.owner_name} · {p.current_version?'Approved guide v'+p.current_version.version_number:'No saved guide'}</p></div><Action variant="ghost" disabled={busy} onClick={()=>perform(()=>Promise.resolve(),'Server state refreshed; unsaved forms retained.')}>Refresh</Action></div></header>
    {error&&<div ref={errorRef} tabIndex={-1} role="alert" className="border border-destructive rounded-md p-3 text-destructive break-words">{error}</div>}
    {(busy||message)&&<p role="status" aria-live="polite" className="text-sm">{busy?'Working…':message}</p>}
    <nav aria-label="Operation sections" className="operations-tabs">{['Overview','Guide','Versions','Runs',...(agentCapability?['Agents']:[]),...(runsCapability?['Agent runs']:[]),'Access','Details'].map(tab=><Action key={tab} aria-pressed={section===tab} variant="ghost" className={'shrink-0 rounded-none px-2 text-sm border-b-2 '+(section===tab?'border-primary text-primary font-semibold':'border-transparent text-muted-foreground')} onClick={()=>openSection(tab)}>{tab}</Action>)}</nav>
    {section==='Overview'&&<>
      <p className="whitespace-pre-wrap break-words text-muted-foreground">{p.description||'Add a purpose in Details to explain the work this project supports.'}</p>
      {p.archived_at&&<p className="rounded-md border bg-muted p-3 text-sm break-words">Archived: {p.archive_reason}</p>}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2 gap-4" data-overview-summary>
        <Panel title="Guide & material" icon={FileText} className="!space-y-2 sm:!p-4">
          <div className="flex items-start gap-3"><FileText className="h-5 w-5 shrink-0 text-muted-foreground" aria-hidden="true"/><div className="min-w-0"><p className="font-medium break-words">{p.current_version?.title||d.title||'No guide yet'}</p><p className="text-sm text-muted-foreground mt-1">{p.current_version?'Approved procedure · v'+p.current_version.version_number:pending?'Saved snapshot ready to approve':'Write instructions, then save an approved version.'}</p></div></div>
          <p className="text-xs text-muted-foreground">Saving a guide starts no run.{capability?' Evidence is in Guide.':''}</p>
          <Action variant="ghost" className="px-0 text-primary gap-2" onClick={()=>openSection('Guide')}>{editable?'Open guide':'Read guide'}<ArrowRight className="h-4 w-4" aria-hidden="true"/></Action>
        </Panel>
        <Panel title="Version & readiness" icon={CheckCircle2} className="!space-y-2 sm:!p-4">
          <ul className="space-y-2 text-sm"><li className="flex items-start gap-2"><span className={'mt-1 h-2 w-2 shrink-0 rounded-full '+(p.current_version?'bg-primary':'bg-muted-foreground')} aria-hidden="true"/><span>{p.current_version?'Approved guide v'+p.current_version.version_number:'Save a guide to create an approved version'}</span></li><li className="flex items-start gap-2"><span className="mt-1 h-2 w-2 shrink-0 rounded-full bg-muted-foreground" aria-hidden="true"/><span>{pending?'Pending snapshot requires Save and approve':d.status==='draft'?'Draft changes are separate from the current version':'Guide history is preserved'}</span></li><li className="text-muted-foreground">{r.runs.length} manual work record{r.runs.length===1?'':'s'}{r.next_cursor?' on this page':''}</li></ul>
          <Action variant="ghost" className="px-0 text-primary gap-2" onClick={()=>openSection('Versions')}>View versions<ArrowRight className="h-4 w-4" aria-hidden="true"/></Action>
        </Panel>
        {agentCapability&&<Panel title="Agents" icon={Bot} className="!space-y-2 sm:!p-4">
          <p className="text-sm text-muted-foreground">Runs need an approved guide, permitted connections and operator authority.</p>
          <p className="text-xs text-muted-foreground">Synthetic pilot: demo.fractionate.ai only.</p>
          <details><summary className="min-h-11 cursor-pointer py-3 text-sm">Execution requirements</summary><div className="space-y-2 pb-2"><p className="text-sm text-muted-foreground">A configured task describes intended work. Execution needs a supported workflow and runtime, permitted connections and limits. Check readiness in Agents before starting work.</p>{runsCapability&&!execution.available&&execution.message&&<p className="text-sm text-muted-foreground">{execution.message}</p>}</div></details>
          <Action variant="ghost" className="px-0 text-primary gap-2" onClick={()=>openSection('Agents')}>Open agents<ArrowRight className="h-4 w-4" aria-hidden="true"/></Action>
        </Panel>}
        <Panel title="Recent activity" icon={Activity} className="!space-y-2 sm:!p-4">
          {e.events.length?<ul className="divide-y">{e.events.slice(0,3).map(row=><li key={row.id} className="py-2 first:pt-0 last:pb-0 text-sm break-words"><p className="font-medium">{row.action.replaceAll('_',' ')}</p><time className="text-xs text-muted-foreground">{row.created_at}</time></li>)}</ul>:<p className="text-sm text-muted-foreground">No activity recorded yet.</p>}
          <div className="flex flex-wrap gap-2"><Action variant="ghost" className="px-0 text-primary gap-2" onClick={()=>openSection('Runs')}>View work records<ArrowRight className="h-4 w-4" aria-hidden="true"/></Action></div>
          {(e.events.length>3||e.next_cursor)&&<details className="border-t pt-2"><summary className="cursor-pointer min-h-11 py-3 text-sm">View activity history</summary><ul className="divide-y">{e.events.map(row=><li key={row.id} className="py-2 text-sm break-words"><p>{row.action.replaceAll('_',' ')}</p><time className="text-xs text-muted-foreground">{row.created_at}</time></li>)}</ul>{e.next_cursor&&<Action disabled={busy} variant="outline" onClick={()=>loadMore('e')}>Load older activity</Action>}</details>}
        </Panel>
      </div>
      <div data-overview-access><Panel title="Access & connections" icon={KeyRound} className="!space-y-2 sm:!p-4" actions={<Action variant="ghost" className="text-primary gap-2" onClick={()=>openSection('Access')}>Manage access<ArrowRight className="h-4 w-4" aria-hidden="true"/></Action>}>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4"><div className="flex items-start gap-3"><Users className="h-5 w-5 shrink-0 text-muted-foreground" aria-hidden="true"/><div><p className="font-medium">People</p><p className="text-sm text-muted-foreground">{a?1+a.members.length+' people with project access':'Your role: '+p.own_role}</p></div></div><div className="flex items-start gap-3"><KeyRound className="h-5 w-5 shrink-0 text-muted-foreground" aria-hidden="true"/><div><p className="font-medium">Connection permissions</p><p className="text-sm text-muted-foreground">Granted separately from project membership.</p></div></div></div>
      </Panel></div>
    </>}
    {section==='Details'&&<Panel title="Project details" icon={Settings2}>
      <p className="text-sm text-muted-foreground">Owner: {p.owner_name}. {p.archived_at?'Archived':'Active'} project.</p>
      {editable&&active&&meta?<form className="space-y-4" onSubmit={ev=>{ev.preventDefault();perform(()=>write('',{name:meta.name,description:meta.description},meta.revision,'PATCH'),'Details saved.','meta');}}>
        <Field label="Name" required maxLength={200} value={meta.name} onChange={ev=>setMeta({...meta,name:ev.target.value})}/><Field label="Purpose (optional)" textarea rows={3} maxLength={20000} value={meta.description} onChange={ev=>setMeta({...meta,description:ev.target.value})}/>
        <div className="flex flex-wrap gap-2"><Action disabled={busy} type="submit">Save details</Action><Action type="button" variant="outline" disabled={busy} onClick={()=>setMeta({name:p.name,description:p.description,revision:p.revision})}>Discard local detail edits</Action></div>
      </form>:<p className="whitespace-pre-wrap break-words">{p.description||'No purpose added.'}</p>}
      {owner&&<div className="border-t pt-4 space-y-3"><h3 className="font-semibold">{active?'Archive project':'Restore project'}</h3>{active?<form className="space-y-3" onSubmit={ev=>{ev.preventDefault();perform(()=>write('/archive',{reason},p.revision),'Project archived.');}}><Field label="Archive reason" required maxLength={2000} value={reason} onChange={ev=>setReason(ev.target.value)}/><Action variant="outline" disabled={busy}>Archive project</Action></form>:<><p className="text-sm break-words">{p.archive_reason}</p><Action disabled={busy} onClick={()=>perform(()=>write('/restore',{},p.revision),'Project restored.')}>Restore project</Action></>}</div>}
    </Panel>}
    {section==='Guide'&&<Panel title="Guide" icon={FileText}>
      <p className="text-sm text-muted-foreground">{d.status==='draft'?'Draft changes are ready to save as an approved version.':d.status==='pending'?'This saved snapshot needs an explicit Save and approve.':'Saved and approved. Start a revision to edit.'}</p>
      {d.latest_submission?.reason&&<p className="whitespace-pre-wrap break-words text-sm">Latest note: {d.latest_submission.reason}</p>}
      {editable&&active&&d.status==='draft'&&draft?<form className="space-y-4" onSubmit={ev=>{ev.preventDefault();perform(()=>write('/draft',{title:draft.title,instructions:draft.instructions},draft.revision,'PATCH'),'Guide saved and approved.','draft');}}>
        <Field label="Guide title" required maxLength={200} value={draft.title} onChange={ev=>setDraft({...draft,title:ev.target.value})}/><Field label="Instructions" required textarea rows={12} value={draft.instructions} onChange={ev=>setDraft({...draft,instructions:ev.target.value})}/>
        <p className="text-sm text-muted-foreground">Saving validates the guide and creates an immutable approved version. Maximum 100,000 UTF-8 bytes. Save any evidence selection first; your entered guide text is retained.</p>
        {selectionDirty&&<p className="text-sm text-muted-foreground" role="status">Save or discard the local evidence selection below before approving this guide.</p>}
        <div className="flex flex-wrap gap-2"><Action type="submit" disabled={busy||selectionDirty||!draft.title.trim()||!draft.instructions.trim()}>Save and approve</Action><Action type="button" variant="outline" disabled={busy} onClick={()=>setDraft({title:d.title,instructions:d.instructions,revision:d.revision})}>Discard local draft edits</Action></div>
        {dirty&&<details><summary className="cursor-pointer min-h-11 py-3">Compare saved server draft</summary><pre className="whitespace-pre-wrap break-words text-sm">{d.title}{'\n\n'}{d.instructions}</pre></details>}
      </form>:<div className="space-y-3"><h3 className="font-medium break-words">{d.title||'Untitled guide'}</h3><pre className="whitespace-pre-wrap break-words font-sans text-sm">{d.instructions||'No instructions yet.'}</pre>{editable&&active&&d.status==='published'&&p.current_version&&<><Action disabled={busy} onClick={()=>perform(()=>write('/draft/start-revision',{version_id:p.current_version.id,discard_draft:true},d.revision),'Revision started.','draft')}>Edit guide</Action><p className="text-xs text-muted-foreground">Starts a new draft from this version and clears evidence selection for the new iteration.</p></>}</div>}
      <EvidenceSet base={base} evidence={d.evidence} enabled={capability} refreshKey={evidenceTick}/>
      {capability&&<Demonstrations key={id+':'+user?.id+':'+p.own_role+':'+active} base={base} user={user} project={p} draft={d} guideDirty={dirty} busy={busy} onSelectionDirty={setSelectionDirty} onSelectionSaved={(revision,expectedRevision)=>{setDraft(old=>old&&old.revision===expectedRevision?{...old,revision}:old);}} onEvidenceChanged={async()=>{try{await refresh(false);}catch(e){clearPrivate();throw e;}}} refreshKey={evidenceTick}/>}
      {pending&&<div className="space-y-4 border-t pt-4"><h3 className="font-semibold">Saved snapshot awaiting approval</h3><GuideText version={pending}/><EvidenceSet base={base} evidence={pending.evidence} enabled={capability} refreshKey={evidenceTick}/><p className="text-xs text-muted-foreground break-words">Saved by {pending.submitted_by_name||actorName(pending.submitted_by)} · {pending.submitted_at}</p>
        {active&&editable&&<><Action disabled={busy} onClick={()=>perform(()=>write('/submissions/'+pending.id+'/approve',{},pending.revision),'Guide saved and approved.','draft')}>Save and approve</Action><p className="text-sm text-muted-foreground">Approves this exact saved snapshot and preserves its content, author and version history.</p><details><summary className="min-h-11 cursor-pointer py-3 text-sm">Cancel this pending snapshot</summary><div className="space-y-3"><Field label="Cancellation reason" textarea rows={2} maxLength={2000} value={reason} onChange={ev=>setReason(ev.target.value)}/><Action variant="outline" disabled={busy||!reason.trim()} onClick={()=>perform(()=>write('/submissions/'+pending.id+'/cancel',{reason},pending.revision),'Pending snapshot cancelled.','draft')}>Cancel pending snapshot</Action></div></details></>}
      </div>}
    </Panel>}
    {section==='Versions'&&<Panel title="Approved versions">
      {!v.versions.length&&<p>No approved versions yet.</p>}
      <ul className="space-y-3">{v.versions.map(version=><li key={version.id} className="rounded-md border p-3 space-y-2"><h3 className="font-medium">Version {version.version_number} · {version.withdrawn_at?'Withdrawn':version.id===p.current_version?.id?'Current':'Superseded'}</h3><p className="text-sm break-words">{version.title}</p><Action variant="outline" disabled={busy} onClick={()=>perform(async()=>setSelectedVersion((await api.get(`${base}/versions/${version.id}`)).version),'Exact version loaded.')}>Read version {version.version_number}</Action></li>)}</ul>
      {v.next_cursor&&<Action variant="outline" disabled={busy} onClick={()=>loadMore('v')}>Load more versions</Action>}
      {selectedVersion&&<div className="space-y-4 border-t pt-4"><h3 className="font-semibold">Version {selectedVersion.version_number}</h3><GuideText version={selectedVersion}/><VersionEvidence base={base} versionId={selectedVersion.id} enabled={capability} refreshKey={evidenceTick}/><p className="text-xs break-all">Approved by {selectedVersion.approved_by_name||actorName(selectedVersion.approved_by)} · {selectedVersion.approved_at}</p><p className="text-xs break-all">Submitted by {selectedVersion.submitted_by_name||actorName(selectedVersion.submitted_by)}; contributors: {(selectedVersion.contributor_names||selectedVersion.contributors.map(actorName)).join(', ')||'No changes since base version'}; base: {selectedVersion.base_version_id||'Original'}</p>
        {selectedVersion.withdrawn_at&&<p className="break-words">Withdrawn: {selectedVersion.withdrawal_reason}</p>}
        {editable&&active&&!pending&&<div className="space-y-3"><label className="flex min-h-11 items-center gap-3"><input type="checkbox" checked={discard} onChange={ev=>setDiscard(ev.target.checked)}/><span>Replace the current draft and local draft edits with this version. This clears evidence references for the new iteration.</span></label><Action disabled={busy||!discard} onClick={()=>perform(async()=>{await write('/draft/start-revision',{version_id:selectedVersion.id,discard_draft:true},d.revision);setDiscard(false);openSection('Guide');},'Revision started.','draft')}>Start revision from this version</Action></div>}
        {reviewer&&active&&!selectedVersion.withdrawn_at&&<form className="space-y-3" onSubmit={ev=>{ev.preventDefault();perform(async()=>{await write(`/versions/${selectedVersion.id}/withdraw`,{reason},p.revision);setSelectedVersion((await api.get(`${base}/versions/${selectedVersion.id}`)).version);},'Version withdrawn.');}}><Field label="Withdrawal reason" required maxLength={2000} value={reason} onChange={ev=>setReason(ev.target.value)}/><Action variant="outline" disabled={busy}>Withdraw version</Action></form>}
      </div>}
    </Panel>}
    {section==='Runs'&&<Panel title="Manual work records">
      <p className="text-sm text-muted-foreground">Record work you performed. Each record preserves the exact guide version used.</p>
      {canRun&&active&&p.current_version&&<Action disabled={busy} onClick={()=>chooseRun(p.current_version)}>Record manual run</Action>}
      {!p.current_version&&<p>No current approved guide. New records require an approved, non-withdrawn version.</p>}
      {runVersion&&active&&canRun&&<form onSubmit={record} className="space-y-4 border rounded-md p-3"><h3 className="font-semibold">{correcting?'Correct manual record':'Record manual run'} · Guide v{runVersion.version_number}</h3><GuideText version={runVersion}/><VersionEvidence base={base} versionId={runVersion.id} enabled={capability} refreshKey={evidenceTick}/>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4"><Field label="Started (your local time)" type="datetime-local" required value={runForm.started_at} onChange={ev=>setRunForm({...runForm,started_at:ev.target.value})}/><Field label="Ended (your local time)" type="datetime-local" required value={runForm.ended_at} onChange={ev=>setRunForm({...runForm,ended_at:ev.target.value})}/></div>
        <Choice label="Outcome" value={runForm.outcome} onChange={ev=>setRunForm({...runForm,outcome:ev.target.value})}><option value="completed">Completed</option><option value="blocked">Blocked</option><option value="aborted">Aborted</option></Choice><Field label="Notes" textarea rows={3} maxLength={10000} value={runForm.notes} onChange={ev=>setRunForm({...runForm,notes:ev.target.value})}/>
        {correcting&&<Field label="Correction reason" required maxLength={2000} value={runForm.reason} onChange={ev=>setRunForm({...runForm,reason:ev.target.value})}/>}
        <div className="flex flex-wrap gap-2"><Action type="submit" disabled={busy}>Save manual record</Action><Action type="button" variant="outline" disabled={busy} onClick={()=>{setRunVersion(null);setCorrecting(null);setRunForm(blankRun);}}>Cancel record</Action></div>
      </form>}
      <ul className="space-y-3">{(relatedRun&&!r.runs.some(x=>x.id===relatedRun.id)?[...r.runs,relatedRun]:r.runs).map(row=><li key={row.id} className="border rounded-md p-3 space-y-2 min-w-0"><h3 className="font-medium">{row.outcome} · {row.corrects_run_id?'Correction':'Original record'}{row.corrected_by?' · Corrected':''}</h3><p className="text-sm">{row.started_at} — {row.ended_at}</p><p className="whitespace-pre-wrap break-words">{row.notes}</p>{row.reason&&<p className="break-words">Reason: {row.reason}</p>}<p className="text-xs break-all">Record {row.id} · Recorder {actorName(row.recorder_id)}{row.corrects_run_id&&` · Corrects ${row.corrects_run_id}`}{row.corrected_by&&` · Corrected by ${row.corrected_by}`}</p>
        <div className="flex flex-wrap gap-2"><Action variant="outline" disabled={busy} onClick={()=>perform(async()=>{setSelectedVersion((await api.get(`${base}/versions/${row.version_id}`)).version);openSection('Versions');},'Pinned version loaded.')}>Read pinned guide</Action>
        {active&&canRun&&row.recorder_id===user?.id&&!row.corrected_by&&<Action variant="outline" disabled={busy} onClick={()=>perform(async()=>chooseRun((await api.get(`${base}/versions/${row.version_id}`)).version,row),'Correction form opened.')}>Correct this record</Action>}
        {(row.corrects_run_id||row.corrected_by)&&<Action variant="outline" disabled={busy} onClick={()=>perform(async()=>{const related=(await api.get(`${base}/runs/${row.corrected_by||row.corrects_run_id}`)).run;setRelatedRun(related);},'Related record loaded.')}>Follow correction chain</Action>}</div>
      </li>)}</ul>{!r.runs.length&&<p>No manual work recorded yet.</p>}{r.next_cursor&&<Action variant="outline" disabled={busy} onClick={()=>loadMore('r')}>Load more records</Action>}
    </Panel>}
    {section==='Access'&&<Panel title="Access">
      <p>Your role: {p.own_role}. Platform administration grants no automatic access.</p>{capability&&<p className="text-sm">Evidence archive, restriction, deletion requests and owner retention holds are in Guide → Demonstrations. A hold grants no private access. {evidenceDisclaimer}</p>}
      {agentCapability&&owner&&<AccessPolicy base={base} project={p} onChanged={()=>refresh(false)}/>}
      {owner&&a?<>
        <p className="text-sm break-words">Owner: {a.owner.username}</p>
        <ul className="space-y-3">{a.members.map(member=><Member key={member.user_id} member={member} busy={busy} active={active} save={role=>perform(()=>write(`/members/${member.user_id}`,{role},p.revision,'PUT'),'Member role updated.')} remove={()=>perform(()=>write(`/members/${member.user_id}`,{},p.revision,'DELETE'),'Access revoked.')}/>)}</ul>
        {active&&<><form className="space-y-3" onSubmit={ev=>{ev.preventDefault();perform(async()=>setCandidate(await api.get(`${base}/access/candidate?identifier=${encodeURIComponent(identifier)}`)),'Account found.');}}><Field label="Existing username" required value={identifier} onChange={ev=>{setIdentifier(ev.target.value);setCandidate(null);}}/><Action disabled={busy}>Find account</Action></form>
          {candidate&&<div className="space-y-3 border rounded-md p-3"><p className="break-words">{candidate.username}</p><Choice label="Member role" value={grantRole} onChange={ev=>setGrantRole(ev.target.value)}>{roleNames.map(role=><option key={role}>{role}</option>)}</Choice><Action disabled={busy} onClick={()=>perform(async()=>{await write(`/members/${candidate.user_id}`,{role:grantRole},p.revision,'PUT');setCandidate(null);setIdentifier('');},'Access granted.')}>Add member</Action></div>}
          <div className="space-y-3"><Choice label="Transfer ownership to" value={transfer} onChange={ev=>setTransfer(ev.target.value)}><option value="">Choose an existing member</option>{a.members.filter(m=>m.active).map(m=><option key={m.user_id} value={m.user_id}>{m.username}</option>)}</Choice><p className="text-sm text-muted-foreground">The recipient must accept within 24 hours. Any record change invalidates the offer. You become an editor after acceptance.</p><Action variant="outline" disabled={busy||!transfer} onClick={()=>perform(()=>write('/ownership-offers',{target_user_id:transfer},p.revision),'Ownership offer created.')}>Offer ownership</Action></div>
        </>}
      </>:<Action variant="outline" disabled={busy} onClick={()=>perform(async()=>{await write(`/members/${user.id}`,{},p.revision,'DELETE');navigate('/operational-projects');},'You left the operation.')}>Leave operation</Action>}
      {p.ownership_offer&&active&&<div className="space-y-3 border rounded-md p-3"><p>Ownership offer expires {p.ownership_offer.expires_at}.</p><div className="flex flex-wrap gap-2">{(owner?['cancel']:['accept','decline']).map(decision=><Action key={decision} disabled={busy} variant={decision==='accept'?'default':'outline'} onClick={()=>perform(()=>write(`/ownership-offers/${p.ownership_offer.id}/decision`,{decision},p.revision),`Ownership offer ${decision} completed.`)}>{decision==='accept'?'Accept ownership':decision==='decline'?'Decline ownership':'Cancel ownership offer'}</Action>)}</div></div>}
    </Panel>}
    {section==='Access'&&<Panel title="Access · Connections"><ConnectionCatalogue projectId={id}/></Panel>}
    {section==='Agents'&&agentCapability&&<>{!brokerSetupActive&&<div className="rounded-md border bg-muted/20 p-4 space-y-2"><h3 className="font-semibold">Execution capability</h3><p className="text-sm text-muted-foreground">A configured task describes intended work. Running it requires a supported workflow and runtime, an approved guide, permitted connections and limits.</p><p className="text-sm text-muted-foreground">The synthetic sign-in pilot supports only demo.fractionate.ai. Check the agent readiness before starting work.</p></div>}<BrokerAgents project={p} onEditingChange={setBrokerSetupActive}/><details open={!brokerSetupActive} className="rounded-lg border bg-muted/30 p-4"><summary className="min-h-11 cursor-pointer font-semibold">Existing synthetic sign-in agents</summary><p className="text-sm text-muted-foreground mb-4">Separate browser workflow. Its existing settings and live-run controls remain available here.</p><AgentConfiguration base={base} project={p} runsEnabled={runsCapability} onChanged={()=>refresh(false)}/></details></>}
    {section==='Agent runs'&&runsCapability&&runsPanel}
  </div></div></div>;
}

function Member({member,busy,active,save,remove}) {
  const [role,setRole]=useState(member.role);
  useEffect(()=>setRole(member.role),[member.role]);
  return <li className="border rounded-md p-3 space-y-3"><p className="break-words">{member.username} · {member.active?'Active account':'Inactive account'}</p><Choice label={`Role for ${member.username}`} disabled={!active||busy} value={role} onChange={e=>setRole(e.target.value)}>{roleNames.map(r=><option key={r}>{r}</option>)}</Choice><div className="flex flex-wrap gap-2"><Action disabled={!active||busy||role===member.role} variant="outline" onClick={()=>save(role)}>Save role</Action><Action disabled={busy} variant="outline" onClick={remove}>Revoke access</Action></div></li>;
}

function VersionEvidence({base,versionId,enabled,refreshKey}) {
  const [evidence,setEvidence]=useState(null);
  useEffect(()=>{const c=new AbortController();setEvidence(null);api.get(`${base}/versions/${versionId}`,c.signal).then(r=>{if(!c.signal.aborted)setEvidence(r.version.evidence);}).catch(()=>{if(!c.signal.aborted)setEvidence({unavailable:true});});return()=>c.abort();},[base,versionId,enabled,refreshKey]);
  if(evidence?.unavailable)return <p role="status">Pinned evidence unavailable; reauthorize and refresh.</p>;
  return <EvidenceSet {...{base,evidence,enabled,refreshKey}}/>;
}
