import React,{useEffect,useState} from 'react';
import {brokerTasksApi,connectionsApi} from '../lib/api';
import {requestSudo} from '../lib/sudo';
const taskErrors={REVISION_MISMATCH:'The saved configuration changed. Refresh the project and review the action again.',TASK_READINESS_UNAVAILABLE:'Current guide, worker, output and registered checks could not be verified. Ask the operator to check the registration, then review again.',TASK_NOT_READY:'This action is not ready. Review the current guide, worker, output and registered checks.',SOURCE_TASK_NOT_READY:'This action is not ready. Review the current guide, worker, output and registered checks.',IDEMPOTENCY_CONFLICT:'This proposal has already been used. Refresh task status before preparing another action.'};
const terminal=new Set(['completed','blocked','cancelled','interrupted','uncertain']);
const button='min-h-11 rounded-md border border-input px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50';
const field='mt-1 min-h-11 w-full rounded border border-input bg-background p-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

/** Saved configuration proposes one typed action; only explicit fresh-proof start authorizes execution. */
export default function BrokerTasks({projectId,agent,capabilities:providedCapabilities,assignmentRevision=0}) {
 const [capabilities,setCapabilities]=useState(providedCapabilities??null),[tasks,setTasks]=useState([]),[connections,setConnections]=useState([]);
 const [form,setForm]=useState({grant_id:'',operation:'item.read',resource_id:'',state:'closed'});
 const [review,setReview]=useState(null),[approval,setApproval]=useState({}),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const configured=capabilities?.mode==='configured'&&capabilities?.compatible===true;
 const enabled=configured&&capabilities.execution_enabled===true;
 useEffect(()=>{if(providedCapabilities)setCapabilities(providedCapabilities);else connectionsApi.get('/capabilities').then(setCapabilities).catch(()=>setCapabilities(null));},[providedCapabilities]);
 const load=async()=>{if(!configured)return;try{const r=await brokerTasksApi.get(projectId,agent.id);setTasks(r.tasks??[]);}catch{setError('Task status is unavailable. Refresh before taking another action.');}};
 useEffect(()=>{if(!configured)return;load();connectionsApi.get(`?project_id=${projectId}`).then(r=>setConnections(r.connections??[])).catch(()=>setConnections([]));},[projectId,agent.id,configured,assignmentRevision]);
 const assignments=connections.flatMap(c=>(c.assignments??[]).filter(g=>g.agent_id===agent.id&&g.project_id===projectId&&!g.revoked&&g.expires_at>Date.now()).map(g=>({connection:c,grant:g})));
 const selected=assignments.find(x=>x.grant.id===form.grant_id);
 const operations=(selected?.grant.operations??[]).filter(x=>agent.controls.operations.includes(x));
 const resources=(selected?.grant.resources??[]).filter(x=>agent.controls.resources.includes(x));
 useEffect(()=>{setReview(null);},[agent.id,agent.revision,assignmentRevision]);
 const change=(key,value)=>{setForm(f=>({...f,[key]:value}));setReview(null);};
 const action=async(fn)=>{setBusy(true);setError('');try{await fn();await load();}catch(e){setError(taskErrors[e.code]||e.message||'Task request was refused. Check status before submitting again.');}finally{setBusy(false);}};
 const verifiedAction=fn=>action(async()=>{await requestSudo();return fn();});
 const prepare=()=>action(async()=>{
  if(!selected||!operations.includes(form.operation)||!resources.includes(form.resource_id))throw new Error('Choose an assigned connection, allowed action and resource.');
  const request={configuration_revision:agent.revision,connection_id:selected.connection.id,grant_id:selected.grant.id,operation:form.operation,resource_id:form.resource_id,...(form.operation==='item.set_state'?{state:form.state}:{})};
  const r=await brokerTasksApi.propose(projectId,agent.id,request);
  if(!r.readiness?.ready||!r.proposal?.id||!Number.isFinite(r.proposal.expires_at)||!Number.isFinite(r.readiness.expires_at))throw new Error('Current guide, environment, output and registered checks must be verified before starting.');
  setReview({proposal:r.proposal,readiness:r.readiness,expires_at:Math.min(r.proposal.expires_at,r.readiness.expires_at),name:selected.connection.name});
 });
 if(!configured)return null;
 return <section aria-label="Broker tasks" className="space-y-3 rounded-xl border border-border bg-card p-4">
  <h3 className="font-semibold">Run one bounded action</h3>
  <p className="text-sm text-muted-foreground">Use this saved configuration for one bounded API action. The current approved guide, registered worker, output destination and required checks are rechecked before execution. Saving or checking readiness starts no task.</p>
  {!enabled&&<p role="status">Worker execution is unavailable. Tasks cannot start until verified configuration and authority are ready.</p>}
  <label className="block text-sm">Assigned connection<select className={field} value={form.grant_id} onChange={e=>change('grant_id',e.target.value)}><option value="">Choose a current assignment</option>{assignments.map(x=><option key={x.grant.id} value={x.grant.id}>{x.connection.name}</option>)}</select></label>
  <div className="grid gap-3 sm:grid-cols-2"><label className="block text-sm">Action<select className={field} value={form.operation} onChange={e=>change('operation',e.target.value)}><option value="">Choose an action</option>{operations.map(x=><option key={x} value={x}>{x==='item.read'?'Read item':'Change item state'}</option>)}</select></label><label className="block text-sm">Allowed resource<select className={field} value={form.resource_id} onChange={e=>change('resource_id',e.target.value)}><option value="">Choose a resource</option>{resources.map(x=><option key={x} value={x}>{x}</option>)}</select></label></div>
  {form.operation==='item.set_state'&&<label className="block text-sm">Requested state<select className={field} value={form.state} onChange={e=>change('state',e.target.value)}><option value="open">Open</option><option value="closed">Closed</option></select></label>}

  <button type="button" className={button} disabled={busy||!enabled} onClick={prepare}>Review action readiness</button>
  {review&&<div className="space-y-2 rounded-lg border border-border p-3"><p className="text-sm">{review.name}: one {review.proposal.operation==='item.read'?'read':'state change'} on resource {review.proposal.resource_id}{review.proposal.operation==='item.set_state'?` → ${review.proposal.state}`:''}.</p><p className="text-sm">Current readiness checked for configuration revision {review.proposal.configuration_revision}. A write still waits for separate human approval.</p><button type="button" className={button} disabled={busy||!enabled} onClick={()=>verifiedAction(async()=>{if(review.expires_at<=Date.now()||review.proposal.configuration_revision!==agent.revision)throw new Error('Action review expired or configuration changed. Check readiness again.');const proposal=review.proposal;setReview(null);await brokerTasksApi.start(projectId,agent.id,proposal.id);})}>Start reviewed task</button></div>}
  <button type="button" className={button} disabled={busy} onClick={()=>action(async()=>{for(const t of tasks)await brokerTasksApi.get(projectId,agent.id,t.id);})}>Refresh task status</button>
  {tasks.map(t=><article key={t.id} className="space-y-2 rounded-lg border border-border p-3"><p className="break-all text-sm">Task {t.id}</p><p role="status">{t.state}{t.receipt?.code?` — ${t.receipt.code}`:''}</p>
   {t.state==='uncertain'&&<p className="text-sm">The outcome is uncertain. Do not replay this task. Review its receipt and reconcile on the broker.</p>}
   {t.receipt?.pending_approval&&<><p className="text-sm">Review the exact pending request on the broker’s human approval surface.</p><a className="inline-flex min-h-11 items-center underline" href={capabilities.intake_origin+'/'} target="_blank" rel="noopener noreferrer">Open broker approval surface</a><pre className="overflow-auto rounded bg-muted p-2 text-xs">{JSON.stringify(t.receipt.pending_approval,null,2)}</pre><label className="block text-sm">Issued approval ID<input className={field} value={approval[t.id]??''} onChange={e=>setApproval({...approval,[t.id]:e.target.value})}/></label><button type="button" className={button} disabled={busy||!enabled||!approval[t.id]} onClick={()=>verifiedAction(()=>brokerTasksApi.write(projectId,agent.id,`/${t.id}/approval`,{approval_id:approval[t.id]}))}>Continue with issued approval</button></>}
   {!terminal.has(t.state)&&<button type="button" className={button} disabled={busy} onClick={()=>verifiedAction(()=>brokerTasksApi.write(projectId,agent.id,`/${t.id}/cancel`))}>Cancel task</button>}
  </article>)}
  {error&&<p role="alert" className="text-sm text-destructive">{error}</p>}
 </section>;
}
