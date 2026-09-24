import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const dir=mkdtempSync(join(tmpdir(),'pp-mcp-upgrade-'));
process.env.DATABASE_PATH=join(dir,'test.db');process.env.TOTP_ENCRYPTION_KEY='a'.repeat(64);process.env.NODE_ENV='test';
const {initDatabase,getDb}=await import('../db.js');
test('unknown lineage is paused for review, hash preserved, repeated startup preserves reviewed grants',()=>{
 initDatabase();const db=getDb();db.exec(`DROP INDEX idx_mcp_parent;ALTER TABLE mcp_tokens DROP COLUMN parent_id;ALTER TABLE mcp_tokens DROP COLUMN review_required;DELETE FROM schema_migrations WHERE version=1014;
 INSERT INTO mcp_tokens(name,token_hash,created_by,created_at,scope_json) VALUES('old','preserved-hash',NULL,'2026-01-01','{"tools":[]}');`);
 initDatabase();const row=db.prepare("SELECT * FROM mcp_tokens WHERE name='old'").get();assert.equal(row.token_hash,'preserved-hash');assert.equal(row.review_required,1);assert.equal(row.parent_id,null);
 db.prepare('UPDATE mcp_tokens SET review_required=0 WHERE id=?').run(row.id);initDatabase();assert.equal(db.prepare('SELECT review_required FROM mcp_tokens WHERE id=?').get(row.id).review_required,0);
 db.close();rmSync(dir,{recursive:true,force:true});
});
