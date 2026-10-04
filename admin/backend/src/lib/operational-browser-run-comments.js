import { createHash } from 'node:crypto';
import { z } from 'zod';
import { fail, parse, validId } from './operational-projects-logic.js';

export const BROWSER_RUN_COMMENT_MAX_BYTES=4000;
const uuid=z.string().uuid();
export const browserRunCommentInputSchema=z.object({text:z.string().min(1).refine(v=>v.isWellFormed()&&!!v.trim()&&
  Buffer.byteLength(v,'utf8')<=BROWSER_RUN_COMMENT_MAX_BYTES&&!/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(v)),
  idempotency_key:uuid,supersedes_id:uuid.optional()}).strict();
const pageSchema=z.object({after:z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  limit:z.number().int().min(1).max(50).default(25)}).strict();
const hash=value=>createHash('sha256').update(JSON.stringify(value),'utf8').digest('hex');

// Additive local history only. Neither comments nor their corrections grant
// browser/model/action authority, select sources, or enter a retrieval index.
export function operationalBrowserRunCommentsMigration1125(db) {
  db.exec(`
    CREATE TABLE ops_browser_run_comments (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE, project_id TEXT NOT NULL REFERENCES ops_projects(id),
      run_id TEXT NOT NULL REFERENCES ops_selected_browser_runs(id),
      attempt_id TEXT NOT NULL, observed_fence INTEGER NOT NULL CHECK(observed_fence>0),
      author_id TEXT NOT NULL, text TEXT NOT NULL CHECK(length(CAST(text AS BLOB)) BETWEEN 1 AND 4000),
      sha256 TEXT NOT NULL CHECK(length(sha256)=64), created_at TEXT NOT NULL,
      idempotency_key TEXT NOT NULL, payload_sha256 TEXT NOT NULL CHECK(length(payload_sha256)=64),
      supersedes_id TEXT UNIQUE REFERENCES ops_browser_run_comments(id),
      UNIQUE(project_id,run_id,author_id,idempotency_key)
    );
    CREATE INDEX ops_browser_run_comments_scope ON ops_browser_run_comments(project_id,run_id,sequence);
    CREATE TRIGGER ops_browser_run_comment_scope BEFORE INSERT ON ops_browser_run_comments
      WHEN NOT EXISTS(SELECT 1 FROM ops_selected_browser_runs r WHERE r.id=NEW.run_id AND r.project_id=NEW.project_id
        AND r.attempt_id=NEW.attempt_id AND r.fence=NEW.observed_fence)
      BEGIN SELECT RAISE(ABORT,'Browser comment scope mismatch'); END;
    CREATE TRIGGER ops_browser_run_comment_correction BEFORE INSERT ON ops_browser_run_comments
      WHEN NEW.supersedes_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM ops_browser_run_comments c
        WHERE c.id=NEW.supersedes_id AND c.project_id=NEW.project_id AND c.run_id=NEW.run_id AND c.author_id=NEW.author_id)
      BEGIN SELECT RAISE(ABORT,'Browser comment correction scope mismatch'); END;
    CREATE TRIGGER ops_browser_run_comment_no_update BEFORE UPDATE ON ops_browser_run_comments
      BEGIN SELECT RAISE(ABORT,'Browser comment history is immutable'); END;
    CREATE TRIGGER ops_browser_run_comment_no_delete BEFORE DELETE ON ops_browser_run_comments
      BEGIN SELECT RAISE(ABORT,'Browser comment history is immutable'); END;
  `);
}

export function createBrowserRunComments({one,all,run,tx,access,event,now,uuid:makeId},
  {maxRunComments=500,maxInstallationComments=50000}={}) {
  if (![maxRunComments,maxInstallationComments].every(n=>Number.isSafeInteger(n)&&n>0&&n<=50000)||
    maxRunComments>maxInstallationComments)throw new Error('Finite browser comment capacity required');
  function authorize(actor,projectId,runId,operation='read') {
    if (actor?.mcp===true||actor?.human===false)fail(403,'A current human session is required');
    access(actor,projectId,operation);
    const r=validId(runId)&&one('SELECT id,project_id,attempt_id,fence FROM ops_selected_browser_runs WHERE project_id=? AND id=?',projectId,runId);
    if(!r)fail(404,'Browser run not found');return r;
  }
  function contentHash(c) {return hash({format:1,project_id:c.project_id,run_id:c.run_id,attempt_id:c.attempt_id,
    observed_fence:c.observed_fence,author_id:c.author_id,text:c.text,created_at:c.created_at,supersedes_id:c.supersedes_id});}
  function projection(c) {
    if(c.sha256!==contentHash(c))fail(409,'Browser comment integrity failed');
    return {id:c.id,sequence:c.sequence,project_id:c.project_id,run_id:c.run_id,attempt_id:c.attempt_id,
      observed_fence:c.observed_fence,author_id:c.author_id,text:c.text,sha256:c.sha256,created_at:c.created_at,
      supersedes_id:c.supersedes_id,corrected_by:one('SELECT id FROM ops_browser_run_comments WHERE supersedes_id=?',c.id)?.id??null};
  }
  return {
    list(actor,projectId,runId,input={}) {
      authorize(actor,projectId,runId);const q=parse(pageSchema,input);
      const rows=all('SELECT * FROM ops_browser_run_comments WHERE project_id=? AND run_id=? AND sequence>? ORDER BY sequence LIMIT ?',
        projectId,runId,q.after??0,q.limit+1);
      return {comments:rows.slice(0,q.limit).map(projection),next_cursor:rows.length>q.limit?rows[q.limit-1].sequence:null,
        scope:{project_id:projectId,run_id:runId}};
    },
    append(actor,projectId,runId,input) {
      const v=parse(browserRunCommentInputSchema,input);
      return tx(()=>{
        const r=authorize(actor,projectId,runId,'run'),supersedes_id=v.supersedes_id??null;
        const payload_sha256=hash({text:v.text,supersedes_id});
        const prior=one('SELECT * FROM ops_browser_run_comments WHERE project_id=? AND run_id=? AND author_id=? AND idempotency_key=?',
          projectId,runId,actor.id,v.idempotency_key);
        if(prior){if(prior.payload_sha256!==payload_sha256)fail(409,'Browser comment idempotency conflict');return {comment:projection(prior),replayed:true};}
        if(supersedes_id){
          const old=one('SELECT * FROM ops_browser_run_comments WHERE project_id=? AND run_id=? AND id=?',projectId,runId,supersedes_id);
          if(!old)fail(404,'Browser comment not found');projection(old);
          if(old.author_id!==actor.id)fail(403,'Only the original author can correct this comment');
          if(one('SELECT 1 FROM ops_browser_run_comments WHERE supersedes_id=?',old.id))fail(409,'Correct the latest comment in this chain');
        }
        if(one('SELECT count(*) n FROM ops_browser_run_comments WHERE run_id=?',runId).n>=maxRunComments||
          one('SELECT count(*) n FROM ops_browser_run_comments').n>=maxInstallationComments)fail(429,'Browser comment capacity exhausted');
        const c={id:makeId(),project_id:projectId,run_id:runId,attempt_id:r.attempt_id,observed_fence:r.fence,
          author_id:actor.id,text:v.text,created_at:now(),supersedes_id},sha256=contentHash(c);
        run(`INSERT INTO ops_browser_run_comments(id,project_id,run_id,attempt_id,observed_fence,author_id,text,sha256,
          created_at,idempotency_key,payload_sha256,supersedes_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
          c.id,projectId,runId,c.attempt_id,c.observed_fence,c.author_id,c.text,sha256,c.created_at,v.idempotency_key,payload_sha256,supersedes_id);
        // Metadata-only event in the same transaction. Never duplicate human
        // text into logs, model input or event/search payloads.
        event(actor,projectId,supersedes_id?'browser_run_comment_corrected':'browser_run_comment_added',c.id,
          {run_id:runId,attempt_id:r.attempt_id,observed_fence:r.fence,sha256,supersedes_id});
        return {comment:projection(one('SELECT * FROM ops_browser_run_comments WHERE id=?',c.id)),replayed:false};
      });
    },
  };
}
