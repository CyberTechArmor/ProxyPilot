// Actual Operations routes -> local authority source -> mTLS worker -> OpenBao -> TLS ledger.
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
  const panel=()=>page.getByRole('region',{name:'Broker tasks'});
  const authenticate=async()=>{const dialog=page.getByRole('dialog');await dialog.getByLabel('Password',{exact:true}).fill('disposable-fixture-password');await dialog.getByLabel('Authenticator Code').fill('123456');await dialog.locator('button[type=submit]').click();await dialog.waitFor({state:'hidden'});};
  const choose=async operation=>{await panel().getByLabel('Assigned connection').selectOption(h.assignment.id);await panel().getByLabel('Action').selectOption(operation);await panel().getByLabel('Allowed resource').selectOption(h.resource);};
  const reviewStart=async()=>{await panel().getByRole('button',{name:'Review action readiness'}).click();await panel().getByRole('button',{name:'Start reviewed task'}).click();await authenticate();};
  await page.goto(`${origin}/operational-projects/${h.project.id}?section=Agents`);
  await page.getByRole('button',{name:'Edit configuration'}).click();
  await page.getByRole('option',{name:'Disposable worker',exact:true}).waitFor({state:'attached'});assert.equal(await page.getByLabel('Execution environment').inputValue(),h.saved.work.environment_ref);
  await page.getByRole('button',{name:'3. Controls'}).click();assert.equal(await page.getByLabel('Output destination').inputValue(),h.saved.controls.output_ref);
  await page.getByRole('button',{name:'Cancel setup'}).click();
  assert.equal(h.dispatch.list(h.owner,h.project.id,h.saved.id).tasks.length,0);assert.equal(h.getEffects(),0);
  report.journeys.push('Actual source catalogue resolves saved worker and output; visiting/editing setup starts nothing');
  await page.getByRole('button',{name:'View readiness'}).click();await choose('item.read');
  await panel().getByRole('button',{name:'Review action readiness'}).click();await panel().getByRole('button',{name:'Start reviewed task'}).waitFor();assert.equal(h.dispatch.list(h.owner,h.project.id,h.saved.id).tasks.length,0);
  await panel().getByRole('button',{name:'Start reviewed task'}).click();await authenticate();await panel().getByText('completed',{exact:true}).waitFor();
  let rows=h.dispatch.list(h.owner,h.project.id,h.saved.id).tasks;assert.equal(rows.length,1);assert.equal(rows[0].receipt.receipts[0].state,'succeeded');assert.equal(rows[0].receipt.receipts[0].operation,'item.read');assert.equal(h.getEffects(),0);
  report.journeys.push('Explicit saved-agent read traverses actual routes/source/mTLS worker/OpenBao/upstream and completes');
  await choose('item.set_state');await reviewStart();await panel().getByText('awaiting_approval',{exact:true}).waitFor();assert.equal(h.getEffects(),0);
  const pending=JSON.parse(await panel().locator('pre').textContent());
  const preview=h.ok(await h.req(h.human+'/v1/human/approval-preview',h.idp.cert,{method:'POST',headers:h.humanHeaders,data:pending})).preview;
  const approval=h.ok(await h.req(h.human+'/v1/human/approve',h.idp.cert,{method:'POST',headers:h.humanHeaders,data:{...pending,digest:preview.digest}})).approval;
  await panel().getByLabel('Issued approval ID').fill(approval.id);await panel().getByRole('button',{name:'Continue with issued approval'}).click();await authenticate();
  await page.waitForFunction(()=>Array.from(document.querySelectorAll('[role=status]')).filter(e=>e.textContent==='completed').length===2);assert.equal(h.getEffects(),1);
  report.journeys.push('Actual pending write requires exact independent human approval before browser continuation produces one effect');
  // Changing current configuration invalidates independently registered checks.
  h.ops.store.updateConfiguration(h.owner,h.project.id,h.saved.id,h.saved.revision,{controls:{...h.saved.controls,resources:[]}});
  await panel().getByRole('button',{name:'Review action readiness'}).click();await panel().getByRole('alert').filter({hasText:'saved configuration changed'}).waitFor();assert.equal(await panel().getByRole('button',{name:'Start reviewed task'}).count(),0);assert.equal(h.getEffects(),1);
  report.journeys.push('Stale saved revision fails closed without another upstream effect');
  assert.deepEqual(errors,[]);
  if(process.env.BROWSER_ARTIFACTS){mkdirSync(process.env.BROWSER_ARTIFACTS,{recursive:true});await panel().evaluate(el=>{el.scrollIntoView({block:'start'});for(let p=el.parentElement;p;p=p.parentElement)if(p.scrollTop)p.scrollTop=Math.max(0,p.scrollTop-72);});await page.screenshot({path:process.env.BROWSER_ARTIFACTS+'/saved-agent-real-worker.png',fullPage:true});writeFileSync(process.env.BROWSER_ARTIFACTS+'/saved-agent-integration-report.json',JSON.stringify(report,null,2));}
  console.log('PASS '+report.journeys.join('; '));
 }finally{await browser?.close();await vite?.close();}
});
