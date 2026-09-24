import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import jwt from 'jsonwebtoken';
import { setup, fixture } from './helpers/sso-fixture.js';

const terminals = [];
globalThis.__terminalFixture = { spawn(options) {
  const term = { options, writes: [], killed: false, write(data) { this.writes.push(data); },
    resize() {}, pause() {}, resume() {}, kill() { this.killed = true; },
    onData(fn) { this.data = fn; return { dispose() {} }; }, onExit() { return { dispose() {} }; } };
  terminals.push(term); return term;
} };
registerHooks({ resolve(specifier, context, next) {
  if (specifier.endsWith('/lib/pty.js')) return { shortCircuit: true, url: 'data:text/javascript,export const spawnTerminalPty=globalThis.__terminalFixture.spawn;' };
  return next(specifier, context);
} });
const { attachTerminalServer, setMock2TerminalAuthorizer } = await import('../routes/terminal-ws.js');
const { requireGuestAccess } = await import('../middleware/terminal-access.js');
const { authenticateToken } = await import('../middleware/auth.js');
const f = await setup();
f.db.exec(`ALTER TABLE services ADD COLUMN lxc_container_name TEXT;
 ALTER TABLE services ADD COLUMN is_admin INTEGER DEFAULT 0;
 CREATE TABLE user_service_access(user_id TEXT,service_id TEXT,can_write INTEGER,can_view INTEGER);
 INSERT INTO services(id,name,lxc_container_name) VALUES('svc','Guest','allowed');
 INSERT INTO user_permissions VALUES('user','proxy');
 INSERT INTO user_service_access VALUES('user','svc',1,1);`);
f.app.post('/guest/:name/exec', authenticateToken, requireGuestAccess, (req,res) => res.json({ok:true}));
const wss = attachTerminalServer(f.server);
const sockets = [];
async function connect(session, path = 'lxc/allowed', extra = {}) {
  const headers = { host:'pilot.example.com', origin:'https://pilot.example.com', cookie:session?.cookie, ...extra };
  for (const key of Object.keys(headers)) if (headers[key] == null) delete headers[key];
  const ws = new WebSocket(f.url.replace('http:', 'ws:')+'/api/terminal/'+path, { headers });
  sockets.push(ws);
  return new Promise((resolve,reject) => {
    ws.once('open', () => resolve({ws,status:101}));
    ws.once('unexpected-response', (req,res) => { res.resume(); ws.terminate(); resolve({status:res.statusCode}); });
    ws.on('error', e => { if (ws.readyState !== ws.CLOSED) reject(e); });
  });
}
async function deniedInput(ws, mutate) {
  const term = terminals.at(-1), closed = once(ws,'close');
  mutate(); ws.send('must-not-execute'); await closed;
  assert.deepEqual(term.writes, []); assert.equal(term.killed,true);
}
test.after(async()=>{ for(const ws of sockets) ws.terminate(); wss.close(); await f.close(); delete globalThis.__terminalFixture; });

test('actual upgrades reject pending, ungranted targets, hostile and missing origins before PTY',async()=>{
  const user=f.local('user'); const before=terminals.length;
  assert.equal((await connect(f.local('pending'))).status,403);
  assert.equal((await connect(user,'lxc/other')).status,403);
  assert.equal((await connect(user,'host')).status,403);
  for(const origin of ['https://sibling.example.com','null',null]) assert.equal((await connect(user,'lxc/allowed',{origin})).status,403);
  f.db.exec("DELETE FROM user_permissions WHERE user_id='user'");
  assert.equal((await connect(user)).status,403);
  f.db.exec("INSERT INTO user_permissions VALUES('user','proxy')");
  assert.equal(terminals.length,before);
  const otherId = jwt.sign({...jwt.decode(user.token),id:'admin'},process.env.JWT_SECRET);
  assert.equal((await connect({cookie:`pp_token=${otherId}`})).status,401);
});
test('delegated guest succeeds with exact grants in both HTTP and WS; bearer policy is explicit',async()=>{
  const user=f.local('user');
  assert.equal((await f.request('/guest/allowed/exec',{cookie:user.cookie,body:{}})).status,200);
  assert.equal((await f.request('/guest/other/exec',{cookie:user.cookie,body:{}})).status,403);
  const {ws,status}=await connect(user); assert.equal(status,101);
  ws.send('allowed'); await new Promise(r=>setTimeout(r,15)); assert.deepEqual(terminals.at(-1).writes,['allowed']); ws.close();
  const bearer=await connect(user,'lxc/allowed',{cookie:null,origin:null,authorization:`Bearer ${user.token}`});
  assert.equal(bearer.status,101); bearer.ws.close();
});
test('open guest terminates on permission removal and session revocation before next input',async()=>{
  let user=f.local('user'), c=await connect(user);
  await deniedInput(c.ws,()=>f.db.exec("DELETE FROM user_service_access WHERE user_id='user'"));
  f.db.exec("INSERT INTO user_service_access VALUES('user','svc',1,1)");
  user=f.local('user'); c=await connect(user);
  await deniedInput(c.ws,()=>f.db.prepare('UPDATE sessions SET revoked_at=CURRENT_TIMESTAMP WHERE id=?').run(user.id));
});
test('host requires fresh proof; demotion kills an existing host PTY',async()=>{
  assert.equal((await connect(f.local('admin','pilot.example.com',false),'host')).status,403);
  const admin=f.local(), {ws,status}=await connect(admin,'host'); assert.equal(status,101);
  await deniedInput(ws,()=>f.db.exec("UPDATE users SET role='user' WHERE id='admin'"));
  f.db.exec("UPDATE users SET role='admin' WHERE id='admin'");
});
test('open project rechecks membership and resolved container identity',async()=>{
  let permitted=true;
  setMock2TerminalAuthorizer(({projectId})=>({ok:permitted && projectId==='7',containerName:'m2-7'}));
  const {ws,status}=await connect(f.local('user'),'mock2/7'); assert.equal(status,101);
  await deniedInput(ws,()=>{permitted=false;});
  setMock2TerminalAuthorizer(null);
});
test('SSO account disable and local revocation close quiet terminals within the polling bound',async()=>{
  const admin=f.local();
  assert.equal((await f.callback(await f.begin(admin),admin.cookie)).status,303);
  const signedIn=await f.callback(await f.begin(admin,'test-login'),admin.cookie);
  assert.equal(signedIn.status,303);
  const cookie=signedIn.headers.get('set-cookie').match(/pp_token=([^;]+)/)[0];
  const ctx=f.db.prepare("SELECT * FROM sso_session_context WHERE method='oidc' ORDER BY rowid DESC").get();
  const oidc=await connect({cookie}); assert.equal(oidc.status,101);
  let closed=once(oidc.ws,'close'); fixture.enabled=false;
  f.db.prepare('UPDATE sso_session_context SET checked_until=0 WHERE session_id=?').run(ctx.session_id);
  let started=Date.now(); await closed; assert(Date.now()-started<6000);
  assert(f.db.prepare('SELECT revoked_at FROM sessions WHERE id=?').get(ctx.session_id).revoked_at);
  fixture.enabled=true;
  const user=f.local('user'), {ws}=await connect(user); closed=once(ws,'close');
  f.db.prepare('UPDATE sessions SET revoked_at=CURRENT_TIMESTAMP WHERE id=?').run(user.id);
  started=Date.now(); await closed; assert(Date.now()-started<6000);
});
