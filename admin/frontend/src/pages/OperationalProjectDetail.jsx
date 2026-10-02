import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useAuth } from '@/context/AuthContext';
import { operationsApi as api } from '@/lib/api';
import { Action, Panel, Field, Choice, GuideText, roleNames } from '@/components/operational-projects/shared';

import { Demonstrations, EvidenceSet, evidenceDisclaimer } from '@/components/operational-projects/Evidence';
import { BrokerAgents } from '@/components/operational-projects/BrokerAgents';
import { ConnectionCatalogue } from '@/components/operational-projects/Connections';
import { AgentConfiguration } from '@/components/operational-projects/Agents';
import { AccessPolicy } from '@/components/operational-projects/AccessPolicy';
import { AgentRunsPanel } from '@/components/operational-projects/AgentRuns';
import { WebsiteReviews } from '@/components/operational-projects/WebsiteReviews';

const blankRun={started_at:'',ended_at:'',outcome:'completed',notes:'',reason:''};
const localTime=iso=>{const d=new Date(iso);return new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,16);};

export default function OperationalProjectDetail() {
  const {id}=useParams(),{user}=useAuth();
  return <Operation key={`${id}:${user?.id}`} id={id}/>;
}
function Operation({id}) {
  const {user}=useAuth(),navigate=useNavigate(),base=`/${id}`;
  const [data,setData]=useState(null),[section,setSection]=useState(()=>{const value=new URLSearchParams(window.location.search).get('section');return ['Overview','Guide','Versions','Runs','Access','Agents','Agent runs','Website reviews'].includes(value)?value:'Overview';}),[busy,setBusy]=useState(false);
  const [error,setError]=useState(''),[message,setMessage]=useState(''),[draft,setDraft]=useState(null),[meta,setMeta]=useState(null);
  const [reason,setReason]=useState(''),[identifier,setIdentifier]=useState(''),[candidate,setCandidate]=useState(null),[grantRole,setGrantRole]=useState('viewer');
  const [transfer,setTransfer]=useState(''),[discard,setDiscard]=useState(false),[selectedVersion,setSelectedVersion]=useState(null);
  const [runForm,setRunForm]=useState(blankRun),[runVersion,setRunVersion]=useState(null),[correcting,setCorrecting]=useState(null),[relatedRun,setRelatedRun]=useState(null);
  const [capability,setCapability]=useState(false),[evidenceTick,setEvidenceTick]=useState(0),[selectionDirty,setSelectionDirty]=useState(false);
  const [agentCapability,setAgentCapability]=useState(false),[runsCapability,setRunsCapability]=useState(false),[websiteCapability,setWebsiteCapability]=useState(false);
  const [params,setParams]=useSearchParams(),openRun=params.get('run');
  const [projectList,setProjectList]=useState([]),[brokerSetupActive,setBrokerSetupActive]=useState(false);
  useEffect(()=>{const c=new AbortController();api.get('',c.signal).then(r=>{if(!c.signal.aborted)setProjectList(r.projects);}).catch(()=>setProjectList([]));return()=>c.abort();},[user?.id]);
  useEffect(()=>{const target=params.get('section');if(['Overview','Guide','Versions','Runs','Access','Agents','Agent runs','Website reviews'].includes(target))setSection(target);},[params]);
  const requests=useRef(null),generation=useRef(0);
  const retry=useRef(null),alive=useRef(true),errorRef=useRef(null);
  const clearPrivate=()=>{setData(null);setDraft(null);setMeta(null);setRunForm(blankRun);setRunVersion(null);setCorrecting(null);setRelatedRun(null);setSelectedVersion(null);setCandidate(null);setReason('');setIdentifier('');retry.current=null;};
  async function refresh(replace=false) {
    const gen=++generation.current,signal=requests.current?.signal;
    const caps=await api.get('/capabilities',signal);
    const {project}=await api.get(base,signal);
    const [d,v,r,e,a]=await Promise.all([api.get(`${base}/draft`,signal),api.get(`${base}/versions`,signal),api.get(`${base}/runs`,signal),api.get(`${base}/events`,signal),project.own_role==='owner'?api.get(`${base}/access`,signal):null]);
    if(!alive.current||gen!==generation.current)return;
    setCapability(caps.enabled&&caps.evidence_enabled);setAgentCapability(caps.enabled&&caps.agents_metadata_enabled);setRunsCapability(!!caps.agent_runs_enabled);setEvidenceTick(t=>t+1);
    setWebsiteCapability(caps.website_review_enabled===true&&caps.website_review_contract==='website-review.v1'&&caps.website_review_strategy==='http_extract_v1');
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
    try {const field=kind==='v'?'versions':kind==='r'?'runs':'events';const page=await api.get(`${base}/${field}?after=${data[kind].next_cursor}`);setData(old=>({...old,[kind]:{...page,[field]:[...old[kind][field],...page[field]]}}));}
    catch(e){setError(e.message);if([401,403,404].includes(e.status))clearPrivate();}finally{setBusy(false);}
  }
  if(!data)return <div className="p-4 sm:p-6 space-y-4"><Link className="underline inline-flex min-h-11 items-center" to="/operational-projects">Back to Operations</Link><h1 className="text-2xl font-bold">Operation</h1><p role={error?'alert':'status'}>{error||'Loading…'}</p><Action disabled={busy} onClick={()=>perform(()=>Promise.resolve(),'Reloaded.',true)}>Retry</Action></div>;
  const {p,d,v,r,e,a}=data,owner=p.own_role==='owner',editable=['owner','editor'].includes(p.own_role),reviewer=['owner','reviewer'].includes(p.own_role);
  const active=!p.archived_at,canRun=p.own_role!=='viewer',pending=d.pending_submission;
  const independent=pending&&pending.submitted_by!==user?.id&&!JSON.parse(pending.contributors_json).includes(user?.id);
  const pilotReview=pending?.pilot_self_review?.owner_id===user?.id;
  const dirty=draft&&(draft.title!==d.title||draft.instructions!==d.instructions||draft.revision!==d.revision);
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
    setRunVersion(version);setCorrecting(old);setRunForm(old?{...blankRun,started_at:localTime(old.started_at),ended_at:localTime(old.ended_at),notes:old.notes,outcome:old.outcome}:blankRun);setSection('Runs');retry.current=null;
  }
  const runsPanel=<AgentRunsPanel base={base} project={p} runId={openRun} onOpenRun={run=>setParams({section:'Agent runs',run})} onCloseRun={()=>setParams({section:'Agent runs'})}/>;
  // An open agent run is a deck of its own (RunDeck.jsx): a breadcrumb instead of the page header and sections, and the layout's own gutters.
  if(section==='Agent runs'&&runsCapability&&openRun)return <div className="max-w-5xl mx-auto w-full flex flex-col gap-3 min-w-0">
    <h1 className="sr-only">{p.name}</h1>
    <nav aria-label="Breadcrumb" className="hidden lg:block"><ol className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
      <li><Link className="hover:text-foreground hover:underline" to="/operational-projects">Operations</Link></li><li aria-hidden="true">›</li>
      <li className="min-w-0 [overflow-wrap:anywhere]"><Link className="hover:text-foreground hover:underline" to={`/operational-projects/${id}`} onClick={()=>setSection('Overview')}>{p.name}</Link></li><li aria-hidden="true">›</li>
      <li><Link className="hover:text-foreground hover:underline" to={`/operational-projects/${id}?section=${encodeURIComponent('Agent runs')}`}>Agent runs</Link></li></ol></nav>
    {error&&<div ref={errorRef} tabIndex={-1} role="alert" className="border border-destructive rounded-md p-3 text-destructive break-words">{error}</div>}
    {runsPanel}
  </div>;
  return <div className="w-full max-w-screen-2xl mx-auto space-y-5"><header className="flex flex-col sm:flex-row sm:items-center justify-between gap-3"><div><h1 className="text-2xl font-semibold">Projects &amp; SOPs</h1><p className="text-sm text-muted-foreground mt-1">Organize projects, approved guides and the agents that use them.</p></div><Link to="/operational-projects" className="inline-flex min-h-11 items-center justify-center self-start rounded-md bg-primary text-primary-foreground px-4 text-sm font-medium">New project</Link></header><div className="w-full grid grid-cols-1 xl:grid-cols-[minmax(0,0.35fr)_minmax(0,0.65fr)] gap-3 min-w-0" data-project-workspace>
    <ProjectBrowser projects={projectList} selectedId={id}/>
    <div className="space-y-4 min-w-0 rounded-lg border bg-card p-4 sm:p-5" data-selected-project>
    <header className="space-y-2"><div className="flex flex-wrap items-center justify-between gap-2"><Link className="underline inline-flex min-h-11 items-center text-sm" to="/operational-projects">Back to Operations</Link><Action className="text-xs" variant="ghost" disabled={busy} onClick={()=>perform(()=>Promise.resolve(),'Server state refreshed; unsaved forms retained.')}>Refresh server state</Action></div><h2 className="text-2xl font-semibold break-words [overflow-wrap:anywhere]">{p.name}</h2><p className="text-sm text-muted-foreground">Owner: {p.owner_name} · {p.archived_at?'Archived':'Active'} · {p.current_version?`Approved guide v${p.current_version.version_number}`:'No current approved guide'}</p></header>
    {error&&<div ref={errorRef} tabIndex={-1} role="alert" className="border border-destructive rounded-md p-3 text-destructive break-words">{error}</div>}
    {(busy||message)&&<p role="status" aria-live="polite" className="text-sm">{busy?'Working…':message}</p>}
    <nav aria-label="Operation sections" className="flex flex-wrap gap-1 border-b pb-1">{['Overview','Guide','Versions','Runs','Access',...(agentCapability?['Agents']:[]),...(runsCapability?['Agent runs']:[]),...(websiteCapability?['Website reviews']:[])].map(tab=><Action key={tab} aria-pressed={section===tab} variant="ghost" className={`shrink-0 rounded-none px-3 text-sm border-b-2 ${section===tab?'border-primary font-semibold':'border-transparent'}`} onClick={()=>{setSection(tab);setError('');setParams({section:tab},{replace:true});}}>{tab}</Action>)}</nav>
    {section==='Overview'&&<>
      <Panel title="Overview"><p className="whitespace-pre-wrap break-words">{p.description||'No description yet.'}</p><p className="text-sm break-words">Owner: {p.owner_name}</p>{agentCapability&&<p className="text-sm break-words">Project site: {p.site_origin||'Not set'} · Visibility: {p.visibility}</p>}{p.archived_at&&<p>Archived: {p.archive_reason}</p>}
        {editable&&active&&meta&&<form className="space-y-4" onSubmit={ev=>{ev.preventDefault();perform(()=>write('',{name:meta.name,description:meta.description},meta.revision,'PATCH'),'Details saved.','meta');}}>
          <Field label="Name" required maxLength={200} value={meta.name} onChange={ev=>setMeta({...meta,name:ev.target.value})}/><Field label="Description" textarea rows={3} maxLength={20000} value={meta.description} onChange={ev=>setMeta({...meta,description:ev.target.value})}/>
          <div className="flex flex-wrap gap-2"><Action disabled={busy} type="submit">Save details</Action><Action type="button" variant="outline" disabled={busy} onClick={()=>setMeta({name:p.name,description:p.description,revision:p.revision})}>Discard local detail edits</Action></div>
        </form>}
        {owner&&(active?<form className="space-y-3" onSubmit={ev=>{ev.preventDefault();perform(()=>write('/archive',{reason},p.revision),'Operation archived.');}}><Field label="Archive reason" required maxLength={2000} value={reason} onChange={ev=>setReason(ev.target.value)}/><Action variant="outline" disabled={busy}>Archive operation</Action></form>:<Action disabled={busy} onClick={()=>perform(()=>write('/restore',{},p.revision),'Operation restored.')}>Restore operation</Action>)}
      </Panel>
      <Panel title="Activity"><ul className="space-y-3">{e.events.map(row=><li key={row.id} className="text-sm break-words"><span className="font-medium">{row.action.replaceAll('_',' ')}</span> · <time>{row.created_at}</time></li>)}</ul>{e.next_cursor&&<Action disabled={busy} variant="outline" onClick={()=>loadMore('e')}>Load more activity</Action>}</Panel>
    </>}
    {section==='Guide'&&<Panel title="Guide">
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
      {pending&&<div className="space-y-4 border-t pt-4"><h3 className="font-semibold">Saved snapshot awaiting approval</h3><GuideText version={pending}/><EvidenceSet base={base} evidence={pending.evidence} enabled={capability} refreshKey={evidenceTick}/><p className="text-xs text-muted-foreground break-words">Saved by {pending.submitted_by_name||pending.submitted_by} · {pending.submitted_at}</p>
        {active&&editable&&<><Action disabled={busy} onClick={()=>perform(()=>write('/submissions/'+pending.id+'/approve',{},pending.revision),'Guide saved and approved.','draft')}>Save and approve</Action><p className="text-sm text-muted-foreground">Approves this exact saved snapshot and preserves its content, author and version history.</p><details><summary className="min-h-11 cursor-pointer py-3 text-sm">Cancel this pending snapshot</summary><div className="space-y-3"><Field label="Cancellation reason" textarea rows={2} maxLength={2000} value={reason} onChange={ev=>setReason(ev.target.value)}/><Action variant="outline" disabled={busy||!reason.trim()} onClick={()=>perform(()=>write('/submissions/'+pending.id+'/cancel',{reason},pending.revision),'Pending snapshot cancelled.','draft')}>Cancel pending snapshot</Action></div></details></>}
      </div>}
    </Panel>}
    {section==='Versions'&&<Panel title="Approved versions">
      {!v.versions.length&&<p>No approved versions yet.</p>}
      <ul className="space-y-3">{v.versions.map(version=><li key={version.id} className="rounded-md border p-3 space-y-2"><h3 className="font-medium">Version {version.version_number} · {version.withdrawn_at?'Withdrawn':version.id===p.current_version?.id?'Current':'Superseded'}</h3><p className="text-sm break-words">{version.title}</p><Action variant="outline" disabled={busy} onClick={()=>perform(async()=>setSelectedVersion((await api.get(`${base}/versions/${version.id}`)).version),'Exact version loaded.')}>Read version {version.version_number}</Action></li>)}</ul>
      {v.next_cursor&&<Action variant="outline" disabled={busy} onClick={()=>loadMore('v')}>Load more versions</Action>}
      {selectedVersion&&<div className="space-y-4 border-t pt-4"><h3 className="font-semibold">Version {selectedVersion.version_number}</h3><GuideText version={selectedVersion}/><VersionEvidence base={base} versionId={selectedVersion.id} enabled={capability} refreshKey={evidenceTick}/><p className="text-xs break-all">Approved by {selectedVersion.approved_by} · {selectedVersion.approved_at}</p><p className="text-xs break-all">Submitted by {selectedVersion.submitted_by}; contributors: {selectedVersion.contributors.join(', ')||'No changes since base version'}; base: {selectedVersion.base_version_id||'Original'}</p>
        {selectedVersion.withdrawn_at&&<p className="break-words">Withdrawn: {selectedVersion.withdrawal_reason}</p>}
        {editable&&active&&!pending&&<div className="space-y-3"><label className="flex min-h-11 items-center gap-3"><input type="checkbox" checked={discard} onChange={ev=>setDiscard(ev.target.checked)}/><span>Replace the current draft and local draft edits with this version. This clears evidence references for the new iteration.</span></label><Action disabled={busy||!discard} onClick={()=>perform(async()=>{await write('/draft/start-revision',{version_id:selectedVersion.id,discard_draft:true},d.revision);setDiscard(false);setSection('Guide');},'Revision started.','draft')}>Start revision from this version</Action></div>}
        {reviewer&&active&&!selectedVersion.withdrawn_at&&<form className="space-y-3" onSubmit={ev=>{ev.preventDefault();perform(async()=>{await write(`/versions/${selectedVersion.id}/withdraw`,{reason},p.revision);setSelectedVersion((await api.get(`${base}/versions/${selectedVersion.id}`)).version);},'Version withdrawn.');}}><Field label="Withdrawal reason" required maxLength={2000} value={reason} onChange={ev=>setReason(ev.target.value)}/><Action variant="outline" disabled={busy}>Withdraw version</Action></form>}
      </div>}
    </Panel>}
    {section==='Runs'&&<Panel title="Manual work records">
      <p className="text-sm text-muted-foreground">Record work you performed. Each record preserves the exact guide version used.</p>
      {canRun&&active&&p.current_version&&<Action disabled={busy} onClick={()=>chooseRun(p.current_version)}>Record manual run</Action>}
      {!p.current_version&&<p>No current approved guide. New records require a reviewed, non-withdrawn version.</p>}
      {runVersion&&active&&canRun&&<form onSubmit={record} className="space-y-4 border rounded-md p-3"><h3 className="font-semibold">{correcting?'Correct manual record':'Record manual run'} · Guide v{runVersion.version_number}</h3><GuideText version={runVersion}/><VersionEvidence base={base} versionId={runVersion.id} enabled={capability} refreshKey={evidenceTick}/>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4"><Field label="Started (your local time)" type="datetime-local" required value={runForm.started_at} onChange={ev=>setRunForm({...runForm,started_at:ev.target.value})}/><Field label="Ended (your local time)" type="datetime-local" required value={runForm.ended_at} onChange={ev=>setRunForm({...runForm,ended_at:ev.target.value})}/></div>
        <Choice label="Outcome" value={runForm.outcome} onChange={ev=>setRunForm({...runForm,outcome:ev.target.value})}><option value="completed">Completed</option><option value="blocked">Blocked</option><option value="aborted">Aborted</option></Choice><Field label="Notes" textarea rows={3} maxLength={10000} value={runForm.notes} onChange={ev=>setRunForm({...runForm,notes:ev.target.value})}/>
        {correcting&&<Field label="Correction reason" required maxLength={2000} value={runForm.reason} onChange={ev=>setRunForm({...runForm,reason:ev.target.value})}/>}
        <div className="flex flex-wrap gap-2"><Action type="submit" disabled={busy}>Save manual record</Action><Action type="button" variant="outline" disabled={busy} onClick={()=>{setRunVersion(null);setCorrecting(null);setRunForm(blankRun);}}>Cancel record</Action></div>
      </form>}
      <ul className="space-y-3">{(relatedRun&&!r.runs.some(x=>x.id===relatedRun.id)?[...r.runs,relatedRun]:r.runs).map(row=><li key={row.id} className="border rounded-md p-3 space-y-2 min-w-0"><h3 className="font-medium">{row.outcome} · {row.corrects_run_id?'Correction':'Original record'}{row.corrected_by?' · Corrected':''}</h3><p className="text-sm">{row.started_at} — {row.ended_at}</p><p className="whitespace-pre-wrap break-words">{row.notes}</p>{row.reason&&<p className="break-words">Reason: {row.reason}</p>}<p className="text-xs break-all">Record {row.id} · Recorder {row.recorder_id}{row.corrects_run_id&&` · Corrects ${row.corrects_run_id}`}{row.corrected_by&&` · Corrected by ${row.corrected_by}`}</p>
        <div className="flex flex-wrap gap-2"><Action variant="outline" disabled={busy} onClick={()=>perform(async()=>{setSelectedVersion((await api.get(`${base}/versions/${row.version_id}`)).version);setSection('Versions');},'Pinned version loaded.')}>Read pinned guide</Action>
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
        {active&&<><form className="space-y-3" onSubmit={ev=>{ev.preventDefault();perform(async()=>setCandidate(await api.get(`${base}/access/candidate?identifier=${encodeURIComponent(identifier)}`)),'Account found.');}}><Field label="Existing username or account ID" required value={identifier} onChange={ev=>{setIdentifier(ev.target.value);setCandidate(null);}}/><Action disabled={busy}>Find account</Action></form>
          {candidate&&<div className="space-y-3 border rounded-md p-3"><p className="break-words">{candidate.username}</p><Choice label="Member role" value={grantRole} onChange={ev=>setGrantRole(ev.target.value)}>{roleNames.map(role=><option key={role}>{role}</option>)}</Choice><Action disabled={busy} onClick={()=>perform(async()=>{await write(`/members/${candidate.user_id}`,{role:grantRole},p.revision,'PUT');setCandidate(null);setIdentifier('');},'Access granted.')}>Add member</Action></div>}
          <div className="space-y-3"><Choice label="Transfer ownership to" value={transfer} onChange={ev=>setTransfer(ev.target.value)}><option value="">Choose an existing member</option>{a.members.filter(m=>m.active).map(m=><option key={m.user_id} value={m.user_id}>{m.username}</option>)}</Choice><p className="text-sm text-muted-foreground">The recipient must accept within 24 hours. Any record change invalidates the offer. You become an editor after acceptance.</p><Action variant="outline" disabled={busy||!transfer} onClick={()=>perform(()=>write('/ownership-offers',{target_user_id:transfer},p.revision),'Ownership offer created.')}>Offer ownership</Action></div>
        </>}
      </>:<Action variant="outline" disabled={busy} onClick={()=>perform(async()=>{await write(`/members/${user.id}`,{},p.revision,'DELETE');navigate('/operational-projects');},'You left the operation.')}>Leave operation</Action>}
      {p.ownership_offer&&active&&<div className="space-y-3 border rounded-md p-3"><p>Ownership offer expires {p.ownership_offer.expires_at}.</p><div className="flex flex-wrap gap-2">{(owner?['cancel']:['accept','decline']).map(decision=><Action key={decision} disabled={busy} variant={decision==='accept'?'default':'outline'} onClick={()=>perform(()=>write(`/ownership-offers/${p.ownership_offer.id}/decision`,{decision},p.revision),`Ownership offer ${decision} completed.`)}>{decision==='accept'?'Accept ownership':decision==='decline'?'Decline ownership':'Cancel ownership offer'}</Action>)}</div></div>}
    </Panel>}
    {section==='Access'&&<Panel title="Access · Connections"><ConnectionCatalogue projectId={id}/></Panel>}
    {section==='Website reviews'&&(websiteCapability?<WebsiteReviews base={base} project={p} onChanged={()=>refresh(false)}/>:<Panel title="Website reviews"><p>Public website reviews are unavailable on this installation. This workflow requires the reviewed website review runtime.</p></Panel>)}
    {section==='Agents'&&agentCapability&&<>{websiteCapability&&<Panel title="Review a public website"><p className="text-sm">Use the separate public HTML/text workflow with your approved guide. It requires no website credential and does not use synthetic sign-in.</p><Action variant="outline" onClick={()=>{setSection('Website reviews');setParams({section:'Website reviews'},{replace:true});}}>Open website reviews</Action></Panel>}<BrokerAgents project={p} onEditingChange={setBrokerSetupActive}/><details open={!brokerSetupActive} className="rounded-lg border bg-muted/30 p-4"><summary className="min-h-11 cursor-pointer font-semibold">Existing synthetic sign-in agents</summary><p className="text-sm text-muted-foreground mb-4">Separate browser workflow. Its existing settings and live-run controls remain available here.</p><AgentConfiguration base={base} project={p} runsEnabled={runsCapability} onChanged={()=>refresh(false)}/></details></>}
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

function ProjectBrowser({projects,selectedId}) {
  const [search,setSearch]=useState('');
  const rows=projects.filter(project=>project.name.toLowerCase().includes(search.toLowerCase()));
  const list=<><Field label="Search projects" type="search" value={search} onChange={e=>setSearch(e.target.value)}/><nav aria-label="Projects" className="space-y-1">{rows.map(item=><Link key={item.id} aria-current={item.id===selectedId?'page':undefined} className={`block rounded-md border p-3 min-h-11 space-y-2 ${item.id===selectedId?'bg-accent border-primary text-accent-foreground':'border-transparent hover:bg-muted'}`} to={`/operational-projects/${item.id}?section=Agents`}><div className="flex flex-wrap items-center justify-between gap-2"><span className="font-medium break-words min-w-0">{item.name}</span><span className="text-xs rounded-full border px-2 py-1">{item.archived_at?'Archived':item.current_version?'Guide approved':'Draft guide'}</span></div><p className="text-xs text-muted-foreground">Your access: {item.own_role} · {item.current_version?`Guide v${item.current_version.version_number}`:'Guide review pending'}</p>{item.description&&<p className="text-sm text-muted-foreground line-clamp-2 break-words">{item.description}</p>}</Link>)}</nav>{!rows.length&&<p className="text-sm text-muted-foreground">No matching projects.</p>}<p className="text-xs text-muted-foreground border-t pt-3">{rows.length} permitted project{rows.length===1?'':'s'}</p></>;
  return <aside className="rounded-lg border bg-card p-4 space-y-3 self-start xl:sticky xl:top-4 min-w-0" data-project-browser><div className="flex items-center justify-between gap-2"><h2 className="text-lg font-semibold">Projects</h2><Link className="inline-flex min-h-11 items-center text-sm underline" to="/operational-projects">New project</Link></div><div className="hidden xl:block space-y-3">{list}</div><details className="xl:hidden"><summary className="min-h-11 cursor-pointer text-sm flex items-center">Browse or switch project</summary><div className="space-y-3 pt-2">{list}</div></details></aside>;
}
