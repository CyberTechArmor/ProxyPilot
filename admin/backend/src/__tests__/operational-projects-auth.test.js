import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { randomUUID } from 'node:crypto';
import { operationsFixture, fixtureRouter } from './helpers/operations-fixture.js';
import { createOperationsRouter } from '../routes/operational-projects.js';
import { csrfProtection } from '../middleware/csrf.js';

// Real auth middleware and SQLite session rows; JWT verification and remote SSO
// are explicit doubles. Never load the production DB or contact an identity provider.
const fixture = { tokens: new Map(), contexts: new Map(), db: null };
globalThis.__operationsAuthFixture = fixture;
const authUrl = new URL('../middleware/auth.js', import.meta.url).href;
const modules = {
  '../db.js': 'export const getDb=()=>globalThis.__operationsAuthFixture.db;',
  'jsonwebtoken': `export default {verify(token) {
    const value=globalThis.__operationsAuthFixture.tokens.get(token);
    if(!value) throw new Error('Invalid fixture token'); return value;
  }};`,
  'uuid': "export { randomUUID as v4 } from 'node:crypto';",
  '../lib/sso/sessions.js': `export const checkSessionContext=()=>({ok:true});
    export const refreshCentralCheck=async()=>{};
    export const requestOrigin=()=>null;
    export const sessionContext=(_db,id)=>globalThis.__operationsAuthFixture.contexts.get(id);`,
};
const hook = registerHooks({resolve(specifier,context,next) {
  if(context.parentURL===authUrl && Object.hasOwn(modules,specifier))
    return {url:'data:text/javascript,'+encodeURIComponent(modules[specifier]),shortCircuit:true};
  return next(specifier,context);
}});
const { authenticateToken, blockPendingRole } = await import(authUrl);
hook.deregister();

test('real session middleware denies anonymous, expired, revoked, mismatched, restricted and pending access', async () => {
  const f=operationsFixture(); fixture.db=f.adapter;
  try {
    const actor=f.addUser(), router=createOperationsRouter({Router:fixtureRouter,store:f.store,enabled:true,lookupLimiter:(_r,_s,n)=>n()});
    const session=(changes={},claims={})=>{
      const id=randomUUID(), token=randomUUID();
      const row={expires_at:new Date(Date.now()+3600000).toISOString(),revoked_at:null,last_used_at:new Date().toISOString(),auth_level:'full',...changes};
      f.db.prepare('INSERT INTO sessions VALUES(?,?,?,?,?,?)').run(id,actor.id,row.expires_at,row.revoked_at,row.last_used_at,row.auth_level);
      fixture.tokens.set(token,{id:actor.id,jti:id,role:'admin',...claims});
      return {id,token};
    };
    const request=(token,csrf='proof')=>router.dispatch({method:'POST',path:'/',originalUrl:'/api/operational-projects/',body:{name:'Private'},
      cookies:{pp_token:token,pp_csrf:'proof'},headers:csrf?{'x-csrf-token':csrf}:{}},[csrfProtection,authenticateToken,blockPendingRole]);
    assert.equal((await request(undefined)).statusCode,401);
    assert.equal((await request('invalid')).statusCode,403);
    for(const row of [{expires_at:new Date(0).toISOString()},{revoked_at:new Date().toISOString()},{last_used_at:new Date(0).toISOString()}])
      assert.equal((await request(session(row).token)).statusCode,401);
    assert.equal((await request(session({}, {id:randomUUID()}).token)).statusCode,401);
    assert.equal((await request(session({auth_level:'enrollment'}).token)).statusCode,403);
    const link=session(); fixture.contexts.set(link.id,{method:'link-only'});
    assert.equal((await request(link.token)).statusCode,403);
    const valid=session();
    assert.equal((await request(valid.token,null)).statusCode,403);
    assert.equal((await request(valid.token,'wrong')).statusCode,403);
    f.db.prepare("UPDATE users SET role='pending' WHERE id=?").run(actor.id);
    assert.equal((await request(valid.token)).statusCode,403);
    f.db.prepare("UPDATE users SET role='user' WHERE id=?").run(actor.id);
    assert.equal((await request(valid.token)).statusCode,201);
    assert.equal(f.store.list(actor).projects.length,1);
    f.db.prepare('DELETE FROM users WHERE id=?').run(actor.id);
    assert.equal((await request(valid.token)).statusCode,401);
  } finally { fixture.db=null; fixture.tokens.clear(); fixture.contexts.clear(); f.close(); }
});
