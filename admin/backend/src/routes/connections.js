import { projectBrokerResponse } from '../lib/credential-broker-projection.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
const uuid=z.string().uuid();
const limits=z.object({max_actions:z.number().int().min(1).max(20),max_seconds:z.number().int().min(1).max(300)}).strict();
const schemas={enroll:z.object({name:z.string().trim().min(1).max(200),project_id:uuid.nullable(),adapter_id:z.literal('synthetic-ledger-v1')}).strict(),
  update:z.object({name:z.string().trim().min(1).max(200)}).strict(),
  assign:z.object({user_id:uuid,project_id:uuid,agent_id:uuid,operations:z.array(z.enum(['item.read','item.set_state'])).min(1).max(2),resources:z.array(uuid).min(1).max(32),limits,expires_at:z.string().datetime()}).strict(),
  list:z.object({project_id:uuid.optional(),assignable_to_agent_id:uuid.optional()}).strict(),empty:z.object({}).strict()};
const statuses={INVALID_REQUEST:400,AUTH_REQUIRED:401,FRESH_PROOF_REQUIRED:401,NOT_FOUND:404,NOT_PERMITTED:403,SCOPE_EXCEEDED:403,REVISION_MISMATCH:409,REVISION_REQUIRED:428,BROKER_UNAVAILABLE:503};
// No host transport or bootstrap authority here. A bridge must independently
// verify the person and enforce protected broker policy; a backend signature
// alone is not sufficient. Production has no configured bridge in this slice.
export function createConnectionsRouter({Router,store,bridge=null,requireSudo=null}) {
  const router=Router();
  const error=(res,code,id)=>res.status(statuses[code]??503).json({contract_version:'broker.v1',error:{code,message:code.replaceAll('_',' '),request_id:id,retryable:false,next_action:null}});
  router.use((req,res,next)=>{res.set('Cache-Control','no-store');req.brokerRequestId=randomUUID();try {store.assertActor(req.user);next();}catch {error(res,'AUTH_REQUIRED',req.brokerRequestId);}});
  router.get('/capabilities',async(_req,res)=>{
    try {
      const caps=await bridge?.capabilities?.();
      if(caps?.mode==='configured')return res.json(caps);
      const active=caps?.mode==='synthetic'&&caps?.intake_enabled===true&&typeof caps?.intake_origin==='string';
      let origin=null;try{if(active){const u=new URL(caps.intake_origin);if(u.origin===caps.intake_origin&&u.protocol==='https:')origin=u.origin;}}catch{}
      return res.json({contract_version:'broker.v1',mode:caps?.mode==='synthetic'?'synthetic':'disabled',intake_enabled:!!origin,execution_enabled:false,intake_origin:origin,
        adapters:[{id:'synthetic-ledger-v1',type:'static_api_token',supported:true}],reason:origin?'SYNTHETIC_ONLY':caps?.reason??'BROKER_NOT_ACTIVATED'});
    }catch{return error(res,'BROKER_UNAVAILABLE',_req.brokerRequestId);}
  });
  const fresh=(req,res,next)=>requireSudo?requireSudo(req,res,next):error(res,'FRESH_PROOF_REQUIRED',req.brokerRequestId);
  const handle=(action,schema=schemas.empty,mutation=false)=>async(req,res)=>{
    const id=req.brokerRequestId;
    const value=schema.safeParse(action==='list'?req.query:req.body??{});
    if(!value.success || (req.params.id && !uuid.safeParse(req.params.id).success)) return error(res,'INVALID_REQUEST',id);
    let expected;
    if(mutation && !['enroll'].includes(action)) {
      const header=req.get('If-Match');if(!header)return error(res,'REVISION_REQUIRED',id);
      if(!/^"[1-9]\d{0,14}"$/.test(header))return error(res,'INVALID_REQUEST',id);
      expected=Number(header.slice(1,-1));
    }
    try {
      if(value.data.project_id) store.get(req.user,value.data.project_id);
      if(action==='list'&&value.data.assignable_to_agent_id){if(!value.data.project_id)throw Error();store.configuration(req.user,value.data.project_id,value.data.assignable_to_agent_id);}
      if(action==='assign') store.configuration(req.user,value.data.project_id,value.data.agent_id);
    } catch {return error(res,'NOT_FOUND',id);}
    if(!bridge) {
      if(action==='list')return res.json({connections:[],next_cursor:null,contract_version:'broker.v1'});
      return error(res,mutation?'BROKER_UNAVAILABLE':'NOT_FOUND',id);
    }
    try {
      // Pass only identity, never cookie/JWT/session proof or arbitrary headers.
      const result=await bridge.request({action,actor:{id:req.user.id},id:req.params.id,body:value.data,query:action==='list'?value.data:undefined,expected,delegation:req.get('X-Broker-Delegation')});
      const projected=projectBrokerResponse(action,result);
      if(projected.intent) {
        const origin=(await bridge.capabilities?.()).intake_origin;
        if(new URL(projected.intent.intake_url).origin!==origin)throw Error();
      }
      return res.json({...projected,contract_version:'broker.v1'});
    }catch(e){return error(res,Object.hasOwn(statuses,e.code)?e.code:'BROKER_UNAVAILABLE',id);}
  };
  router.get('/',handle('list',schemas.list));
  router.get('/enrollment-intents/:id',handle('intent'));
  router.post('/enrollment-intents',fresh,handle('enroll',schemas.enroll,true));
  router.post('/assignments/:id/revoke',fresh,handle('unassign',schemas.empty,true));
  router.get('/:id',handle('get'));
  for(const part of ['assignments','sessions','activity'])router.get(`/:id/${part}`,handle(part));
  router.patch('/:id',fresh,handle('update',schemas.update,true));
  for(const [path,action] of [['test','test'],['revoke','revoke'],['rotation-intents','rotate']])router.post(`/:id/${path}`,fresh,handle(action,schemas.empty,true));
  router.post('/:id/assignments',fresh,handle('assign',schemas.assign,true));
  return router;
}
