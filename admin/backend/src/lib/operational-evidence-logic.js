import { createHash } from 'node:crypto';
import { z } from 'zod';
import { fail } from './operational-projects-logic.js';

const id = z.string().uuid();
const text = n => z.string().max(n);
const required = n => z.string().trim().min(1).max(n);
const rectangle = z.object({ x:z.number().finite().min(0).max(1), y:z.number().finite().min(0).max(1),
  width:z.number().finite().positive().max(1), height:z.number().finite().positive().max(1) }).strict()
  .refine(r => r.x+r.width<=1 && r.y+r.height<=1);
export const evidenceSchemas = {
  create:z.object({title:required(200),purpose:text(2000).default(''),context_version_id:id.nullable().default(null),idempotency_key:id}).strict(),
  update:z.object({title:required(200),purpose:text(2000)}).strict(),
  annotation:z.object({object_id:id,predecessor_id:id.nullable().default(null),label:required(200),text:required(2000),
    rectangle:rectangle.nullable().default(null),idempotency_key:id}).strict(),
  share:z.object({summary:text(2000),annotation_ids:z.array(id).min(1).max(50),privacy_reviewed:z.literal(true),idempotency_key:id}).strict()
    .refine(v=>new Set(v.annotation_ids).size===v.annotation_ids.length),
  disposition:z.object({object_id:id.optional(),revision_id:id.optional(),action:z.enum(['restrict','delete_requested']),
    reason:z.enum(['privacy','incorrect','retention','other'])}).strict().refine(v=>!!v.object_id!==!!v.revision_id),
  hold:z.object({object_id:id,held:z.boolean(),reason:z.enum(['privacy','incorrect','retention','other'])}).strict(),
  list:z.object({after:id.optional(),limit:z.number().int().min(1).max(100).default(25)}).strict(),
};
export const evidenceHash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function evidencePermission(role, actor, demo, action, archived) {
  if (archived) fail(409,'Operational record is archived');
  if (role==='viewer' || (action==='hold' && role!=='owner')) fail(403,'Insufficient evidence access');
  if (demo && demo.created_by!==actor.id && !(role==='owner' && ['restrict','archive','hold'].includes(action))) {
    fail(403,'Only the original author may change evidence');
  }
  if (demo?.archived_at && !['restrict','hold'].includes(action)) fail(409,'Demonstration is archived');
}
