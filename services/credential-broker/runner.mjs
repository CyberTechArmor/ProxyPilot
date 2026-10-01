import { openStore } from './store.mjs';
import { exact, uuid, limits, list, operation, input, subset, fail, id } from './schema.mjs';

// This worker executes a bounded typed action list. It has no shell, URL or run-control tool.
export function createRunner({ statePath, broker, clock = Date.now }) {
  const db = openStore(statePath);
  const tokens = new Map(), busy = new Set(), active = new Map();
  let closed = false;
  const terminal = new Set(['completed', 'cancelled', 'blocked', 'uncertain', 'interrupted']);
  for (const task of db.all('task')) {
    if (!terminal.has(task.state)) db.put('task', { ...task, state: task.sending ? 'uncertain' : 'interrupted', code: task.sending ? 'OPERATION_UNCERTAIN' : 'WORKER_RESTARTED', pending_approval: null });
  }
  const get = (taskId) => { uuid(taskId); const t = db.get('task', taskId); if (!t) fail('NOT_FOUND', 404); return t; };
  const publicTask = (t) => ({ id: t.id, user_id: t.user_id, project_id: t.project_id, agent_id: t.agent_id,
    configuration_revision: t.configuration_revision, attempt: t.attempt, fence: t.fence,
    state: t.state, code: t.code, session_id: t.session_id, step_index: t.step_index,
    pending_approval: t.pending_approval, receipts: t.receipts, end_confirmed: t.end_confirmed });
  const save = (t) => db.put('task', t);
  const end = async (t) => {
    tokens.delete(t.id);
    try { await broker.endTask({ task_id: t.id, attempt: t.attempt, fence: t.fence }); t.end_confirmed = true; }
    catch { t.end_confirmed = false; }
    save(t);
  };
  const validate = (r) => {
    exact(r, ['id','user_id','project_id','agent_id','grant_id','connection_id','attempt','fence','scope','steps','configuration_revision']);
    for (const k of ['id','user_id','project_id','agent_id','grant_id','connection_id','attempt','fence']) uuid(r[k]);
    if (!Number.isSafeInteger(r.configuration_revision) || r.configuration_revision < 1) fail('INVALID_REQUEST');
    exact(r.scope, ['operations','resources','limits','expires_at','audience']);
    list(r.scope.operations, operation); list(r.scope.resources, uuid); limits(r.scope.limits);
    if (r.scope.audience !== 'fractionate-broker' || !Number.isSafeInteger(r.scope.expires_at) || r.scope.expires_at <= clock() || r.scope.expires_at > clock()+r.scope.limits.max_seconds*1000) fail('INVALID_REQUEST');
    if (!Array.isArray(r.steps) || !r.steps.length || r.steps.length > r.scope.limits.max_actions) fail('INVALID_REQUEST');
    for (const s of r.steps) { exact(s,['operation','input']); input(s.operation,s.input); subset([s.operation],r.scope.operations); subset([s.input.resource_id],r.scope.resources); }
  };
  async function drive(t, approvalId) {
    if (busy.has(t.id)) fail('TASK_BUSY',409);
    busy.add(t.id); active.set(t.id,t);
    try {
      while (t.step_index < t.steps.length && !t.cancel_requested) {
        if (closed || clock() >= t.scope.expires_at) { t.state='blocked'; t.code='SESSION_EXPIRED'; break; }
        const step = t.steps[t.step_index];
        if (step.operation === 'item.set_state' && !approvalId) {
          t.state='awaiting_approval';
          t.pending_approval={ session_id:t.session_id, request:{connection_id:t.connection_id,...step} };
          save(t); return publicTask(t);
        }
        t.state='running'; t.pending_approval=null;
        const key = t.step_keys[t.step_index];
        // Persist the possible-send boundary before crossing the transport.
        t.sending=true; save(t);
        let receipt;
        try { receipt=await broker.execute(tokens.get(t.id),t.connection_id,step.operation,step.input,key,approvalId); }
        catch { t.state='uncertain'; t.code='OPERATION_UNCERTAIN'; t.sending=false; break; }
        t.sending=false; approvalId=undefined;
        // Only expose the broker's bounded receipt contract, never arbitrary transport data.
        if (!receipt || !['succeeded','failed','denied','uncertain'].includes(receipt.state)) { t.state='uncertain'; t.code='OPERATION_UNCERTAIN'; break; }
        try { t.receipts.push({id:uuid(receipt.id),state:receipt.state,operation:step.operation}); }
        catch { t.state='uncertain';t.code='OPERATION_UNCERTAIN';break; }
        t.step_index++;
        if (receipt.state !== 'succeeded') { t.state=receipt.state==='uncertain'?'uncertain':'blocked'; t.code=receipt.state==='uncertain'?'OPERATION_UNCERTAIN':'OPERATION_FAILED'; break; }
        save(t);
      }
      if (t.cancel_requested && t.state!=='uncertain') { t.state='cancelled'; t.code='TASK_CANCELLED'; }
      else if (t.state==='running' && t.step_index===t.steps.length) { t.state='completed'; t.code=null; }
      await end(t); return publicTask(t);
    } finally { busy.delete(t.id); active.delete(t.id); }
  }
  const checkTask = async (request) => {
    if(closed)fail('WORKER_UNAVAILABLE',503);validate(request);
    const r=structuredClone(request),ready=await broker.checkTask(r);
    exact(ready,['ready','task_id','user_id','project_id','agent_id','configuration_revision','attempt','fence','expires_at']);
    if(ready.ready!==true||ready.task_id!==r.id||!Number.isSafeInteger(ready.expires_at)||ready.expires_at<=clock()||ready.expires_at>clock()+60000)fail('TASK_NOT_READY',403);
    for(const k of ['user_id','project_id','agent_id','configuration_revision','attempt','fence'])if(ready[k]!==r[k])fail('TASK_NOT_READY',403);
    return ready;
  };
  return {
    checkTask,
    async startTask(request) {
      if(closed) fail('WORKER_UNAVAILABLE',503);
      validate(request); const r=structuredClone(request);
      if(db.get('task',r.id)) fail('TASK_EXISTS',409);
      if(db.all('task').length>=10000)fail('WORKER_UNAVAILABLE',503);
      await checkTask(r);
      if(db.get('task',r.id)) fail('TASK_EXISTS',409);
      const t={...r,state:'preparing',code:null,session_id:null,step_index:0,pending_approval:null,receipts:[],step_keys:r.steps.map(()=>id()),sending:false,cancel_requested:false,end_confirmed:false};
      save(t); busy.add(t.id); active.set(t.id,t);
      try {
        const issued=await broker.issueSession({grant_id:t.grant_id,task_id:t.id,attempt:t.attempt,fence:t.fence,configuration_revision:t.configuration_revision,...t.scope});
        if(!issued || typeof issued.bearer!=='string' || !/^[A-Za-z0-9_-]{43}$/.test(issued.bearer)) fail('INVALID_SESSION');
        const session=issued.session;
        for(const field of ['user_id','project_id','agent_id','grant_id','connection_id','attempt','fence']) if(session?.[field]!==t[field]) fail('SESSION_BINDING_MISMATCH');
        if(session.task_id!==t.id||session.expires_at!==t.scope.expires_at||session.revoked!==false) fail('SESSION_BINDING_MISMATCH');
        t.session_id=uuid(session.id); tokens.set(t.id,issued.bearer);
      } catch { t.state='blocked';t.code='SESSION_NOT_ISSUED';await end(t);return publicTask(t); }
      finally { busy.delete(t.id); active.delete(t.id); }
      save(t); return drive(t);
    },
    status(taskId) { return publicTask(get(taskId)); },
    async continueTask(taskId,request) {
      exact(request,['approval_id']);uuid(request.approval_id);
      const t=get(taskId);
      if(closed || t.state!=='awaiting_approval' || !tokens.has(t.id)) fail('TASK_NOT_CONTINUABLE',409);
      return drive(t,request.approval_id);
    },
    async cancelTask(taskId) {
      const t=active.get(taskId)||get(taskId);
      t.cancel_requested=true;
      if(!terminal.has(t.state)){t.state='cancelled';t.code='TASK_CANCELLED';t.pending_approval=null;}
      await end(t);return publicTask(t);
    },
    close() { if(busy.size) fail('TASK_BUSY',409);closed=true;tokens.clear();db.close(); },
  };
}
