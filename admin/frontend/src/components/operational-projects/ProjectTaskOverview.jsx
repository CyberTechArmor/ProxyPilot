import { useEffect, useRef, useState } from 'react';
import { Bot, CalendarClock, Play, Settings2 } from 'lucide-react';
import { operationsApi as api } from '@/lib/api';
import { requestAgentControl } from '@/lib/agent-control';
import { requestSudo } from '@/lib/sudo';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Action, Choice, Field } from './shared';
import { RecentBrowserRuns } from './BrowserRunSummary';

async function ensureControl(){const {authorization}=await api.get('/project-defaults');if(!authorization.control_verified)await requestAgentControl();if(!authorization.elevated)await requestSudo();}

const dialogClass='operations-dialog max-w-full h-full rounded-none sm:max-w-lg sm:h-auto sm:max-h-[90dvh] sm:rounded-md flex flex-col p-6 [&>button]:h-11 [&>button]:w-11';
const weekdays=['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
const limitFields=[['cpu','CPU'],['memory_mib','Memory (MB)'],['temporary_disk_mib','Temporary storage (MB)'],['max_seconds','Time limit (seconds)'],['max_actions','Action limit'],['max_tokens','Token limit'],['max_usd','Cost limit ($)']];
function when(value,timezone){return new Intl.DateTimeFormat(undefined,{timeZone:timezone,dateStyle:'medium',timeStyle:'short'}).format(new Date(value));}

const blockers={
  WEBSITES_REQUIRED:'Add at least one domain or website in Edit goal & settings.',
  BROWSER_EXECUTION_DISABLED:'Browser execution is disabled. Enable it in system settings.',
  INSTALLED_SELECTED_BROWSER_PROOF_REQUIRED:'The browser runtime is unavailable. Check browser runtime readiness in Agents.',
  PRIVATE_SOURCE_MEMORY_UNAVAILABLE:'Private result storage is unavailable. Check browser runtime readiness in Agents.',
  CURRENT_APPROVED_GUIDE_REQUIRED:'The guide changed. Accept the current goal and settings before running.',
  OWNER_MODEL_CONSENT_REQUIRED:'The owner needs to accept the current goal and settings.',
  PROJECT_LIMITS_REQUIRED:'The saved agent limits need review in Edit goal & settings.',
  PRIVATE_INPUT_PINS_UNRESOLVED:'A saved input is unavailable. Review inputs in Agents.',
  UNRESOLVED_EFFECT:'A previous run needs your review. Open its session and resolve the pending effect.',
  ATTEMPT_ALREADY_ACTIVE:'A browser run is already active. Open its session to continue or stop it.',
  MODEL_ROUTE_UNAVAILABLE:'The model connection is unavailable. Check its connection in Agents.',
};

export function ProjectTaskOverview({project,taskData,onChanged,onOpenRun,openSection,executionEnabled}) {
  const {task,schedules=[]}=taskData,base=`/${project.id}/task`,schedule=schedules[0];
  const config=task.configuration?.configuration,defaults=task.defaults,budgets=config?.budgets||{...defaults.budgets,...project.agent_limits};
  const owner=task.can_edit,canRun=executionEnabled&&['owner','editor','operator','reviewer'].includes(project.own_role)&&!project.archived_at;
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[message,setMessage]=useState(''),[modal,setModal]=useState(null);
  const [form,setForm]=useState(null),key=useRef(null),lock=useRef(false);
  const [readiness,setReadiness]=useState(null),[readinessError,setReadinessError]=useState(''),[checkTick,setCheckTick]=useState(0);
  useEffect(()=>{
    if(!canRun){setReadiness(null);return;}
    let active=true,pending=false;const controller=new AbortController();setReadiness(null);setReadinessError('');
    async function check(){if(pending)return;pending=true;try{const result=await api.get(`${base}/readiness`,controller.signal);if(active){setReadiness(result);setReadinessError('');}}catch(e){if(active&&!controller.signal.aborted){setReadiness(null);setReadinessError(e.message);}}finally{pending=false;}}
    check();const timer=setInterval(check,10000);window.addEventListener('focus',check);
    return()=>{active=false;controller.abort();clearInterval(timer);window.removeEventListener('focus',check);};
  },[base,canRun,task.revision,task.configuration?.revision,project.revision,checkTick]);
  const activeRun=readiness?.active_run,latestRun=readiness?.latest_run;
  const blocked=(readiness?.checks||[]).filter(c=>c.state==='blocked');
  function recheck(){setCheckTick(t=>t+1);}

  async function perform(fn,success='Saved.') {
    if(lock.current)return;lock.current=true;setBusy(true);setError('');setMessage('');
    try {await fn();await onChanged();setMessage(success);recheck();return true;}
    catch(e){setError(e.status===412?'This project changed. Your entries are retained. Refresh before saving again.':e.message);return false;}
    finally{lock.current=false;setBusy(false);}
  }
  const snapshot=()=>({task_revision:task.revision,project_revision:project.revision,configuration_revision:task.configuration?.revision??null});
  function edit(){setError('');setForm({...snapshot(),name:project.name,goal:project.description,websites:config?.destinations.entry_urls.join('\n')||'',limits:{...budgets}});setModal('edit');}
  function scheduling(){setError('');setForm(schedule?{weekday:1,date:new Date().toLocaleDateString('en-CA'),...snapshot(),schedule_revision:schedule.revision,...schedule.timing}:{...snapshot(),schedule_revision:null,frequency:'daily',time:'09:00',weekday:1,date:new Date().toLocaleDateString('en-CA'),timezone:Intl.DateTimeFormat().resolvedOptions().timeZone||'America/Detroit'});setModal('schedule');}
  return <div className="space-y-4" data-project-task>
    <div className="flex flex-wrap gap-2">
      <Action disabled={busy||!canRun||task.needs_website||!readiness?.can_start||!!activeRun} className="gap-2" onClick={()=>perform(async()=>{
        await ensureControl();key.current??=crypto.randomUUID();
        const result=await api.write(`${base}/start`,{idempotency_key:key.current,task_revision:task.revision});key.current=null;
        onOpenRun(result.run.id);
      },'Run started.')}><Play className="h-4 w-4" aria-hidden="true"/>{latestRun?'Run again':'Run now'}</Action>
      {activeRun&&<Action variant="outline" disabled={busy} onClick={()=>onOpenRun(activeRun.id)}>Open active run</Action>}
      <Action variant="outline" className="gap-2" disabled={busy||!owner||!executionEnabled||task.needs_website} onClick={scheduling}><CalendarClock className="h-4 w-4" aria-hidden="true"/>{schedule?'Edit schedule':'Schedule'}</Action>
      {owner&&<Action variant="outline" className="gap-2" disabled={busy} onClick={edit}><Settings2 className="h-4 w-4" aria-hidden="true"/>Edit goal &amp; settings</Action>}
    </div>
    {error&&<p role="alert" className="rounded-md border border-destructive p-3 text-destructive break-words">{error}</p>}
    {message&&<p role="status" className="text-sm">{message}</p>}
    {task.needs_website&&<p className="rounded-md border bg-muted/30 p-3 text-sm">Your project and defaults are saved. Add a domain or website in Websites using Edit goal &amp; settings before running.</p>}
    <section className="operations-card rounded-md border bg-card p-4 space-y-2" aria-label="Run status">
      <h3 className="font-semibold">{activeRun?'Run active':readiness?.can_start?'Ready to run':'Run readiness'}</h3>
      {activeRun?<p className="text-sm">Current run: {activeRun.state.replaceAll('_',' ')}. Open the active run to continue, approve a request, or stop it. After it finishes or stops, Run again starts a fresh run.</p>:!executionEnabled?<p className="text-sm">Browser execution is disabled. Enable it in system settings to run this project.</p>:!canRun?<p className="text-sm">Your project role does not allow starting runs.</p>:readinessError?<p role="alert" className="text-sm break-words">Readiness is unavailable: {readinessError}</p>:!readiness?<p role="status" className="text-sm">Checking saved setup and browser availability…</p>:readiness.can_start?<p className="text-sm">Name, websites, guide and defaults are saved. Click {latestRun?'Run again':'Run now'} to start{latestRun?' a fresh run':''}.</p>:<ul className="list-disc pl-5 text-sm space-y-1">{blocked.map(c=><li key={c.kind}>{blockers[c.code]||`Review ${c.kind.replaceAll('_',' ')} in Agents before running.`}</li>)}</ul>}
      {latestRun&&!activeRun&&<p className="text-sm">Last run: {latestRun.state.replaceAll('_',' ')}. <Action variant="ghost" onClick={()=>onOpenRun(latestRun.id)}>View last run</Action></p>}
      {canRun&&<div className="flex flex-wrap gap-2"><Action variant="ghost" disabled={busy} onClick={recheck}>Check readiness</Action>{blocked.length>0&&<Action variant="outline" onClick={()=>openSection('Agents')}>Review agent readiness</Action>}</div>}
    </section>
    <div className="grid grid-cols-1 xl:grid-cols-2 gap-4" data-overview-summary>
      <section className="operations-card rounded-md border bg-card p-4 space-y-4 min-w-0"><header><h3 className="text-lg font-semibold">Goal</h3><p className="mt-1 text-sm text-muted-foreground">Saved as approved guide v{project.current_version?.version_number}</p></header><p className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{project.description}</p><div className="space-y-1"><h4 className="font-semibold text-sm">Websites</h4><ul className="list-disc pl-5 text-sm break-words [overflow-wrap:anywhere]">{config?.destinations.entry_urls.map(url=><li key={url}>{url}</li>)}</ul></div><Action variant="outline" onClick={()=>openSection('Guide')}>View structured guide</Action><p className="text-xs text-muted-foreground">Saving prepares the project. Run now starts it immediately.</p></section>
      <section className="operations-card rounded-md border bg-card p-4 space-y-4 min-w-0"><header><h3 className="text-lg font-semibold flex items-center gap-2"><Bot className="h-5 w-5" aria-hidden="true"/>Agent &amp; defaults</h3></header><dl className="space-y-3 text-sm"><div><dt className="text-muted-foreground">Agent / model</dt><dd>Browser agent · {config?.model.name||defaults.model}</dd></div><div><dt className="text-muted-foreground">Resources</dt><dd>{budgets.cpu} CPU · {budgets.memory_mib} MB memory · {budgets.temporary_disk_mib} MB temporary storage</dd></div><div><dt className="text-muted-foreground">Limits per run</dt><dd>{budgets.max_seconds/60} minutes · {budgets.max_actions} actions · {budgets.max_tokens.toLocaleString()} tokens · ${budgets.max_usd}</dd></div><div><dt className="text-muted-foreground">Recording</dt><dd>{config?.artifacts.record_video?'On':'Off'} · Private results retained for {config?.artifacts.retention_days||defaults.retention_days} days</dd></div></dl><p className="text-xs text-muted-foreground">Website changes require approval. Sign in through live takeover when needed.</p>{executionEnabled&&<RecentBrowserRuns/>}</section>
    </div>
    {schedule&&<section className="operations-card rounded-md border bg-card p-4 space-y-3" aria-label="Project schedule"><div className="flex flex-wrap items-center justify-between gap-3"><div className="min-w-0"><h3 className="font-semibold">Schedule · {schedule.state==='paused'?'Paused':schedule.next_run_at?'Active':'Completed'}</h3><p className="text-sm text-muted-foreground break-words">{schedule.timing.frequency} at {schedule.timing.time} · {schedule.timing.timezone}</p>{schedule.next_run_at&&<p className="text-sm break-words">Next run: {when(schedule.next_run_at,schedule.timing.timezone)}</p>}</div>{owner&&<div className="flex flex-wrap gap-2"><Action variant="outline" disabled={busy} onClick={()=>perform(async()=>{
      if(schedule.state==='paused'){await ensureControl();await api.write(`${base}/schedule`,{timing:schedule.timing,authorize_unattended:true,task_revision:task.revision,project_revision:project.revision,configuration_revision:task.configuration.revision},schedule.revision,'PUT');}
      else await api.write(`${base}/schedule/${schedule.id}`,{state:'paused'},schedule.revision,'PATCH');
    },schedule.state==='paused'?'Schedule resumed.':'Schedule paused.')}>{schedule.state==='paused'?'Accept & resume':'Pause'}</Action><Action variant="outline" disabled={busy} onClick={()=>perform(()=>api.write(`${base}/schedule/${schedule.id}`,{state:'deleted'},schedule.revision,'PATCH'),'Schedule deleted.')}>Delete</Action></div>}</div>{schedule.last_occurrence&&<p className="text-sm break-words">Last occurrence: {schedule.last_occurrence.state.replaceAll('_',' ')}{schedule.last_occurrence.result_code&&` · ${schedule.last_occurrence.result_code.replaceAll('_',' ').toLowerCase()}`}{schedule.last_occurrence.run_id&&<Action variant="ghost" onClick={()=>onOpenRun(schedule.last_occurrence.run_id)}>View run</Action>}</p>}<p className="text-xs text-muted-foreground">Runs even when this page is closed. Missed runs and overlaps are skipped. Editing the goal or settings pauses the schedule.</p></section>}
    <Dialog open={!!modal} onOpenChange={open=>{if(!busy&&!open)setModal(null);}}><DialogContent className={dialogClass}><DialogHeader className="pr-8"><DialogTitle className="operations-heading">{modal==='edit'?'Edit goal & settings':'Schedule project'}</DialogTitle><DialogDescription>{modal==='edit'?'Accept once to update the guide, agent and limits together.':'Choose when this project should run.'}</DialogDescription></DialogHeader>
      {modal&&<form className="flex flex-col flex-1 gap-4 min-h-0" onSubmit={async event=>{event.preventDefault();const saved=await perform(async()=>{
        if(modal==='schedule'){await ensureControl();const timing={frequency:form.frequency,time:form.time,timezone:form.timezone,...(form.frequency==='once'?{date:form.date}:form.frequency==='weekly'?{weekday:Number(form.weekday)}:{})};await api.write(`${base}/schedule`,{timing,authorize_unattended:true,task_revision:form.task_revision,project_revision:form.project_revision,configuration_revision:form.configuration_revision},form.schedule_revision,'PUT');}
        else {const limits=Object.fromEntries(limitFields.map(([k])=>[k,Number(form.limits[k])]));await api.write(base,{name:form.name,goal:form.goal,websites:form.websites,limits,project_revision:form.project_revision,configuration_revision:form.configuration_revision,accepted_defaults:defaults.version},form.task_revision,'PATCH');}
      },modal==='edit'?'Goal and settings saved. Any schedule is paused.':'Schedule saved.');if(saved)setModal(null);}}>
      <div className="space-y-4 min-h-0 overflow-y-auto pr-1">
      {error&&<p role="alert" className="text-destructive break-words">{error}</p>}
      {modal==='edit'?<><Field label="Name" required maxLength={200} value={form.name} onChange={e=>setForm({...form,name:e.target.value})}/><div className="space-y-1"><Field label="Websites" required textarea rows={3} maxLength={66000} value={form.websites} onChange={e=>setForm({...form,websites:e.target.value})}/><p className="text-sm text-muted-foreground">One or more domains or full URLs, one per line or separated by commas. Domains use HTTPS.</p></div><Field label="Goal" required textarea rows={4} maxLength={20000} value={form.goal} onChange={e=>setForm({...form,goal:e.target.value})}/><p className="text-sm text-muted-foreground">Your plain-language goal is converted into the structured guide when you save. Name, websites and goal are all you need; the saved defaults handle the rest.</p><details><summary className="min-h-11 cursor-pointer py-3 font-medium">Advanced settings (optional)</summary><div className="space-y-3">{limitFields.map(([k,label])=><Field key={k} label={label} type="number" required min={k==='max_usd'?0.01:1} step={k==='max_usd'?0.01:1} value={form.limits[k]} onChange={e=>setForm({...form,limits:{...form.limits,[k]:e.target.value}})}/>)}<Action type="button" variant="ghost" onClick={()=>{setModal(null);openSection('Agents');}}>Other agent, model &amp; connection settings</Action></div></details><p className="text-sm text-muted-foreground">Accepting approves the revised guide and model disclosure for these settings. Any schedule pauses until accepted again.</p></>:<><Choice label="Repeat" value={form.frequency} onChange={e=>setForm({...form,frequency:e.target.value})}><option value="once">Once</option><option value="daily">Daily</option><option value="weekly">Weekly</option></Choice>{form.frequency==='once'&&<Field label="Date" type="date" required value={form.date||''} onChange={e=>setForm({...form,date:e.target.value})}/>} {form.frequency==='weekly'&&<label className="block text-sm">Weekday<select aria-label="Weekday" className="block min-h-11 w-full rounded-md border bg-background px-3" value={form.weekday} onChange={e=>setForm({...form,weekday:e.target.value})}>{weekdays.map((day,i)=><option key={day} value={i}>{day}</option>)}</select></label>}<Field label="Time" type="time" required value={form.time} onChange={e=>setForm({...form,time:e.target.value})}/><Field label="Timezone" required value={form.timezone} onChange={e=>setForm({...form,timezone:e.target.value})}/><p className="text-sm text-muted-foreground">Accepting authorizes unattended runs of the current goal and settings within the saved limits. Website changes still require approval. Runs awaiting your approval will wait for you.</p><p className="text-xs text-muted-foreground">Uses local time in this timezone. Missing daylight-saving times are skipped; repeated times run once. Runs more than five minutes late are skipped.</p></>}
      </div>
      <div className="flex shrink-0 flex-col sm:flex-row sm:justify-end gap-2"><Action type="button" variant="outline" disabled={busy} onClick={()=>setModal(null)}>Cancel</Action><Action type="submit" disabled={busy}>{busy?'Saving…':modal==='edit'?'Accept & save':'Accept & save schedule'}</Action></div></form>}
    </DialogContent></Dialog>
  </div>;
}
