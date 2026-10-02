// Real dashboard routes -> broker-owned intake -> OpenBao 2.6.2 -> TLS consumer.
// All identity, credentials and upstream resources are disposable synthetic fixtures.
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import {createServer} from 'vite';
import {fileURLToPath} from 'node:url';
import {createBrokerDashboardHarness} from '../../backend/src/__tests__/helpers/broker-dashboard-harness.js';
import {createDisposableFixture} from '../../../services/credential-broker/fixtures/disposable.mjs';
import {createSyntheticConsumer} from '../../../services/credential-broker/consumer.mjs';
const {chromium}=await import('../../backend/node_modules/playwright-core/index.mjs');
const h=await createBrokerDashboardHarness({dependenciesFactory:({owner,project})=>createDisposableFixture({owner,project})});
let vite,browser;
try {
 vite=await createServer({root:fileURLToPath(new URL('..',import.meta.url)),server:{host:'127.0.0.1',port:0},plugins:[{name:'disposable-real-api',configureServer(server){server.middlewares.use('/api',(req,res,next)=>{
   // Authentication fixture is server-side; no browser request interception.
   if(req.url==='/auth/verify')req.url='/auth/me';
   if(!/^\/(auth\/me|connections|operational-projects)(\/|\?|$)/.test(req.url)){res.setHeader('Content-Type','application/json');return res.end(JSON.stringify({notifications:[],unread_count:0}));}
   h.app(req,res,next);
 });}}]});await vite.listen();
 const origin=`http://127.0.0.1:${vite.httpServer.address().port}`;
 browser=await chromium.launch({executablePath:process.env.BROWSER_EXE||'/usr/bin/chromium',args:['--no-sandbox']});
 const context=await browser.newContext({ignoreHTTPSErrors:true,viewport:{width:1280,height:1000}});
 await context.addCookies([...Object.entries(h.dashboardCookies(h.users.owner)).map(([name,value])=>({name,value,url:origin})),...Object.entries(h.intakeCookies(h.users.owner)).map(([name,value])=>({name,value,url:h.intakeOrigin,secure:true,httpOnly:true}))]);
 const page=await context.newPage();page.setDefaultTimeout(15000);
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 const proof=h.proofForUser(h.users.owner);
 await page.goto(`${origin}/connections`);await page.getByRole('button',{name:'Add connection',exact:true}).click();
 await page.getByLabel('Connection name').fill('Real fixture ledger');await page.getByRole('button',{name:'Save setup details'}).click();
 const link=page.getByRole('link',{name:'Open trusted broker intake'});await link.waitFor();
 const intake=await context.newPage();await intake.goto(await link.getAttribute('href'));
 await intake.getByLabel('API credential',{exact:true}).fill(h.credential);await intake.getByRole('button',{name:'Save once',exact:true}).click();await intake.getByRole('status').filter({hasText:'committed'}).waitFor();
 assert.equal(await intake.getByLabel('API credential',{exact:true}).inputValue(),'');await intake.close();
 await page.getByRole('button',{name:'Check enrollment status'}).click();await page.getByText('Connection enrolled.',{exact:false}).waitFor();await page.keyboard.press('Escape');
 await page.getByRole('button',{name:'Details and access'}).click();await page.getByRole('button',{name:'Test (read only)',exact:true}).click();
 await page.getByText('Verified for isolated development only',{exact:true}).waitFor();assert.equal((await h.broker.listConnections(proof))[0].status,'active');
 await page.goto(`${origin}/operational-projects/${h.project.id}?section=Agents`);await page.getByRole('button',{name:'Add an agent',exact:true}).click();
 await page.getByLabel('Agent name',{exact:true}).fill('Bounded reader');await page.getByLabel('Task',{exact:true}).fill('Read the synthetic item');
 await page.getByRole('button',{name:'Next: Connections'}).click();await page.getByRole('button',{name:'Select connection',exact:true}).click();
 await page.getByRole('button',{name:'Next: Controls'}).click();await page.getByLabel('Assignment expiry (your local time)').fill(new Date(Date.now()+3600000).toISOString().slice(0,16));
 await page.getByRole('button',{name:'Next: Review'}).click();await page.getByRole('button',{name:'Save draft',exact:true}).click();await page.getByRole('heading',{name:'Readiness checklist'}).waitFor();await page.getByRole('button',{name:'Confirm assignment',exact:true}).click();await page.getByText('Assignment saved. This does not start a run.').waitFor();
 const connections=await h.broker.listConnections(proof),connection=connections[0],detail=await h.broker.detail(proof,connection.id),grant=detail.assignments[0];assert(grant);
 const s=await h.broker.issueSession(proof,grant.id,{task_id:randomUUID(),attempt:randomUUID(),fence:randomUUID(),operations:['item.read'],resources:[h.resource],limits:{max_actions:2,max_seconds:60},expires_at:Date.now()+60000,audience:'fractionate-broker'});
 const url=new URL(h.agentOrigin),consumer=createSyntheticConsumer({origin:`https://localhost:${url.port}`,ca:h.tlsCertificate,bearer:s.bearer,connectionId:connection.id,fixture:{host:"localhost",port:Number(url.port),address:'127.0.0.1'}});
 assert.equal((await consumer.execute('item.read',{resource_id:h.resource},randomUUID())).state,'succeeded');
 await page.goto(`${origin}/connections`);await page.getByRole('button',{name:'Details and access'}).click();await page.getByText('Read permitted items · succeeded',{exact:false}).waitFor();
 assert(!(await page.content()).includes(h.credential));
 await page.getByRole('button',{name:'Rotate credential',exact:true}).click();await page.getByRole('button',{name:'Prepare rotation'}).click();
 const rotatedSecret=randomBytes(32).toString('base64url');h.dependencies.setCredential(rotatedSecret);
 const rotationPage=await context.newPage();await rotationPage.goto(await page.getByRole('link',{name:'Open trusted broker intake'}).getAttribute('href'));
 await rotationPage.getByLabel('API credential',{exact:true}).fill(rotatedSecret);await rotationPage.getByRole('button',{name:'Save once',exact:true}).click();await rotationPage.getByRole('status').filter({hasText:'committed'}).waitFor();await rotationPage.close();
 await page.getByRole('button',{name:'Check rotation status'}).click();await page.getByText('Credential rotated. Old sessions',{exact:false}).waitFor();await page.keyboard.press('Escape');
 await assert.rejects(()=>consumer.execute('item.read',{resource_id:h.resource},randomUUID()));
 await page.getByRole('button',{name:'Details and access'}).click();await page.getByRole('button',{name:'Test (read only)',exact:true}).click();await page.getByText('Verified for isolated development only',{exact:true}).waitFor();assert.equal((await h.broker.detail(proof,connection.id)).status,'active');
 const replacement=await h.broker.issueSession(proof,grant.id,{task_id:randomUUID(),attempt:randomUUID(),fence:randomUUID(),operations:['item.read'],resources:[h.resource],limits:{max_actions:2,max_seconds:60},expires_at:Date.now()+60000,audience:'fractionate-broker'});
 const replacementConsumer=createSyntheticConsumer({origin:`https://localhost:${url.port}`,ca:h.tlsCertificate,bearer:replacement.bearer,connectionId:connection.id,fixture:{host:"localhost",port:Number(url.port),address:'127.0.0.1'}});
 assert.equal((await replacementConsumer.execute('item.read',{resource_id:h.resource},randomUUID())).state,'succeeded');
 await page.getByRole('button',{name:'Details and access'}).click();
 await page.getByRole('button',{name:'Remove from agent',exact:true}).click();await page.getByRole('button',{name:'Confirm remove from agent'}).click();
 await page.getByRole('button',{name:'Details and access'}).waitFor();await assert.rejects(()=>replacementConsumer.execute('item.read',{resource_id:h.resource},randomUUID()));
 assert.equal((await h.broker.detail(proof,connection.id)).status,'active');
 await page.getByRole('button',{name:'Details and access'}).click();await page.getByRole('button',{name:'Revoke connection',exact:true}).click();await page.getByRole('button',{name:'Confirm revoke connection'}).click();await page.getByText('Access revoked',{exact:true}).waitFor();assert.equal((await h.broker.detail(proof,connection.id)).status,'revoked');assert.deepEqual(errors,[]);
 console.log('PASS real OpenBao browser enrollment, safe test, draft creation, assignment, TLS consumer, activity, rotation, unassignment and revocation');
}finally{await browser?.close();await vite?.close();await h.close();}
