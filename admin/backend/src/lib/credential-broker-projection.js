import {z} from 'zod';
const uuid=z.string().uuid(), n=z.number().int().nonnegative(), text=z.string().max(200);
const operations=z.array(z.enum(['item.read','item.set_state'])).max(2);
const limits=z.object({max_actions:n,max_seconds:n});
const grant=z.object({id:uuid,connection_id:uuid.optional(),user_id:uuid.optional(),project_id:uuid.optional(),agent_id:uuid.optional(),revision:n,revoked:z.boolean(),operations:operations.optional(),resources:z.array(uuid).max(32).optional(),limits:limits.optional(),expires_at:n.optional(),authorizing_event:uuid.optional()});
const session=z.object({id:uuid,user_id:uuid,agent_id:uuid,task_id:uuid,grant_id:uuid,connection_id:uuid,expires_at:n,revoked:z.boolean(),connection_revision:n});
const connection=z.object({id:uuid,name:text,owner_id:uuid,project_id:uuid.nullable(),adapter_id:z.literal('synthetic-ledger-v1'),revision:n,policy_revision:n,credential_version:n,status:z.enum(['saved','active','revoked']),operations,resources:z.array(uuid).max(32),limits,rights:z.array(z.enum(['view','use','assign','manage'])).max(4),readiness:z.object({state:z.enum(['ready','blocked']),code:z.enum(['SYNTHETIC_ONLY','CONNECTION_REVOKED','CONNECTION_UNVERIFIED','POLICY_REVALIDATION_REQUIRED'])}),assignments:z.array(grant).max(1000),sessions:z.array(session).max(1000)});
const event=z.object({id:uuid,type:z.enum(['enrolled','enrollment_reserved','enrollment_reconciled','enrollment_reconcile_required','operation_reconciled','rotation_reserved','rotated','tested','assigned','permission_changed','policy_revalidated','session_issued','approved','operation_reserved','operation_completed','operation_uncertain','revoked','unassigned','renamed','reconciled']),connection_id:uuid,revision:n,actor_id:uuid,at:n});
// Dashboard activity is metadata-only. Even the adapter-defined operation result
// is deliberately omitted here; upstream content belongs to the consumer API.
const operationState=z.enum(['reserved','sending','succeeded','failed','uncertain']);
const operationReceipt=z.object({id:uuid,type:z.literal('operation'),connection_id:uuid,
 operation:z.enum(['item.read','item.set_state']),state:operationState,status:operationState,
 code:z.enum(['BROKER_UNAVAILABLE','UPSTREAM_REJECTED','OPERATION_UNCERTAIN']).nullable(),
 created_at:n,completed_at:n.nullable(),recovery_of:uuid.nullable(),at:n,actor_id:uuid,revision:n,
 cost:z.object({state:z.literal('not_applicable'),amount:z.null()})
}).refine(v=>v.status===v.state);
export function projectBrokerResponse(action,value) {
 const intent=z.object({id:uuid,state:z.enum(['reserved','submitting','committed','reconcile_required']),intake_url:z.string().url().max(2048),expires_at:n,connection_id:uuid.nullable().optional(),revision:n.optional(),credential_version:n.optional(),code:z.literal('ENROLLMENT_RECONCILE_REQUIRED').optional()});
 const schema=['enroll','rotate','intent'].includes(action)?z.object({intent}):action==='list'?z.object({connections:z.array(connection).max(1000),next_cursor:z.null()}):
 action==='assignments'?z.object({assignments:z.array(grant).max(1000)}):action==='sessions'?z.object({sessions:z.array(session).max(1000)}):
 action==='activity'?z.object({events:z.array(z.union([event,operationReceipt])).max(1000)}):['assign','unassign'].includes(action)?z.object({assignment:grant}):z.object({connection});
 return schema.parse(value);
}
