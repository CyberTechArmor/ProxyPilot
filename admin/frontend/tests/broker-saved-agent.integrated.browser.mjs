// Historical saved API configuration through actual authenticated Operations routes.
// The retired sample has no product creation/assignment/execution controls.
// Dashboard session/fresh authentication is an explicit test fixture, not a production-auth proof.
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdirSync,writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {createServer} from 'vite';
import express from '../../backend/node_modules/express/index.js';
import {createOperationsRouter} from '../../backend/src/routes/operational-projects.js';
import {createConnectionsRouter} from '../../backend/src/routes/connections.js';
import {csrfProtection} from '../../backend/src/middleware/csrf.js';
import {withSavedAgentFixture} from '../../../services/credential-broker/fixtures/saved-agent.mjs';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'../../backend/node_modules/playwright-core/index.mjs');
const report={source_commit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),generated_at:new Date().toISOString(),journeys:[],limitation:'Disposable synthetic identity/upstream. Dashboard session and fresh authentication fixtures only; local backend authority trusts backend DB/root. No production deployment or external Keycloak compatibility claim.'};
await withSavedAgentFixture({diagnostic:message=>console.log(message)},async h=>{
 const app=express(),session=randomBytes(32).toString('hex'),csrf=randomBytes(32).toString('hex');let fresh=false,vite,browser;
 app.use(express.json({limit:'16kb'}));
 app.use((req,res,next)=>{req.cookies=Object.fromEntries((req.headers.cookie||'').split(';').map(v=>v.trim().split('=')));if(req.cookies.pp_fixture_session!==session)return res.status(401).json({error:'Fixture session required'});req.user=h.owner;next();});
 app.use(csrfProtection);
 app.get('/auth/verify',(_req,res)=>res.json({user:{...h.owner,username:'Disposable owner',permissions:[]}}));
 app.post('/auth/sudo',(_req,res)=>{fresh=true;res.json({success:true});});
 const requireSudo=(_req,res,next)=>{if(!fresh)return res.status(401).json({sudo_required:true});fresh=false;next();};
 const bridge={capabilities:async()=>h.ok(await h.req(h.human+'/v1/capabilities',h.idp.cert)),request:async({action,id,body,expected,query})=>h.call(action,id,body,expected,query)};
 app.use('/operational-projects',createOperationsRouter({Router:express.Router,store:h.ops.store,enabled:true,agentsEnabled:true,brokerTasks:h.dispatch,brokerTaskProposals:h.proposals,configurationConnections:()=>h.call('list',null,null,null,{project_id:h.project.id}),requireSudo,lookupLimiter:(_req,_res,next)=>next()}));
 app.use('/connections',createConnectionsRouter({Router:express.Router,store:h.ops.store,bridge,requireSudo}));
 app.use((_req,res)=>res.json({notifications:[],unread_count:0}));
 try{
  vite=await createServer({root:fileURLToPath(new URL('..',import.meta.url)),server:{host:'127.0.0.1',port:0},plugins:[{name:'actual-saved-agent-routes',configureServer(server){server.middlewares.use('/api',app);}}]});await vite.listen();
  const origin=`http://127.0.0.1:${vite.httpServer.address().port}`;
  browser=await chromium.launch({executablePath:process.env.BROWSER_EXE||'/usr/bin/chromium',args:['--no-sandbox']});
  const context=await browser.newContext({viewport:{width:1280,height:1000}});await context.addCookies([{name:'pp_fixture_session',value:session,url:origin},{name:'pp_csrf',value:csrf,url:origin}]);
  const page=await context.newPage();page.on('response',async r=>{if(r.url().includes('/api/')&&r.status()>=400)console.error('API refusal',new URL(r.url()).pathname,r.status(),await r.text());});page.setDefaultTimeout(20000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`${origin}/operational-projects/${h.project.id}?section=Agents`);
  const history=page.getByText(/Historical API configurations/);await history.click();
  await page.getByRole('button',{name:'Inspect recorded configuration',exact:true}).click();
  const panel=page.getByRole('region',{name:'Historical API configuration'});await panel.waitFor();
  await panel.getByText(h.saved.id,{exact:false}).waitFor();
  assert.equal(await panel.getByText('Current connection checks',{exact:true}).count(),1);
  assert.equal(await page.getByRole('button',{name:/Add an agent|Edit configuration|Start reviewed task|Review action readiness/}).count(),0);
  assert.equal(await page.getByRole('region',{name:'Broker tasks'}).count(),0);
  assert.equal(h.dispatch.list(h.owner,h.project.id,h.saved.id).tasks.length,0);assert.equal(h.getEffects(),0);
  assert.equal(h.ops.store.configuration(h.owner,h.project.id,h.saved.id).agent.id,h.saved.id);
  report.journeys.push('Actual saved API record and current connection checks remain readable through authenticated routes');
  report.journeys.push('Retired sample creation, assignment and execution controls are absent; visiting history starts no task or upstream effect');
  assert.deepEqual(errors,[]);
  if(process.env.BROWSER_ARTIFACTS){mkdirSync(process.env.BROWSER_ARTIFACTS,{recursive:true});await panel.scrollIntoViewIfNeeded();await page.screenshot({path:process.env.BROWSER_ARTIFACTS+'/saved-agent-history.png',fullPage:true});writeFileSync(process.env.BROWSER_ARTIFACTS+'/saved-agent-integration-report.json',JSON.stringify(report,null,2));}
  console.log('PASS '+report.journeys.join('; '));
 }finally{await browser?.close();await vite?.close();}
});
