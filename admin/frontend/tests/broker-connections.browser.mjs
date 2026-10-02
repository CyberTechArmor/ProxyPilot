// Browser UI fixtures exercise user journeys, not broker enforcement.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync } from 'node:fs';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || '../../backend/node_modules/playwright-core/index.mjs');
const vite = await createServer({root:fileURLToPath(new URL('..',import.meta.url)),server:{host:'127.0.0.1',port:0}});await vite.listen();
const origin=`http://127.0.0.1:${vite.httpServer.address().port}`;
const browser=await chromium.launch({executablePath:process.env.BROWSER_EXE||'/usr/bin/chromium',args:['--no-sandbox',...(process.env.LIGHTHOUSE_DIR?['--remote-debugging-port=9339']:[])]});
const user={id:'00000000-0000-4000-8000-000000000001',username:'Fixture owner',role:'user',permissions:[]};
const project={id:'00000000-0000-4000-8000-000000000002',name:'Fixture project',owner_name:user.username,own_role:'owner',revision:1,description:'Synthetic UI fixture',current_version:{id:'guide-1',content_hash:'a'.repeat(64),version_number:1}};
const connection={id:'00000000-0000-4000-8000-000000000003',name:'Fixture ledger',adapter_id:'synthetic-ledger-v1',rights:['view','use','assign','manage'],operations:['item.read'],resources:['00000000-0000-4000-8000-000000000004'],limits:{max_actions:20,max_seconds:300},revision:1,status:'active',credential_version:1,readiness:{code:'VERIFIED'}};
const readiness={state:'blocked',can_start:false,checks:[{kind:'broker',state:'unavailable',code:'BROKER_NOT_ACTIVATED',next_action:'review_deployment'}]};
let lighthouseBrowser=null,flow=null;
const requests=[],agents=[],errors=[],report={synthetic:true,source_commit:process.env.SOURCE_COMMIT||execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),generated_at:new Date().toISOString(),journeys:[],layout:[],screenshots:[]};let forbidden=false,failEnrollment=false,failAssignment=false,syntheticIntake=false,extraConnections=[],exactAgentAssignmentDenied=false;
const page=await browser.newPage({viewport:{width:1280,height:1000}});page.setDefaultNavigationTimeout(90000);page.on('pageerror',e=>errors.push(e.message));await page.addInitScript(()=>{if(!localStorage.getItem('pp-theme'))localStorage.setItem('pp-theme','office');});
await page.route('**/api/**',async route=>{
 const r=route.request(),path=new URL(r.url()).pathname,method=r.method(),body=r.postDataJSON();requests.push({path,method,body});
 const answer=(data,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(data)});
 if(path==='/api/auth/verify')return answer({user});
 if(path==='/api/operational-projects/capabilities')return answer({enabled:true,ui_available:true,agents_metadata_enabled:true,evidence_enabled:false,agent_runs_enabled:false});
 if(path==='/api/connections/capabilities')return answer({mode:syntheticIntake?'synthetic':'disabled',intake_enabled:syntheticIntake,intake_origin:syntheticIntake?origin:null,execution_enabled:false,adapters:[],reason:'BROKER_NOT_ACTIVATED'});
 if(path==='/api/connections')return answer({connections:forbidden||(exactAgentAssignmentDenied&&new URL(r.url()).searchParams.has('assignable_to_agent_id'))?[]:[connection,...extraConnections]});
 if(path.endsWith('/rotation-intents'))return answer({intent:{id:'rotation',state:'reserved',intake_url:`${origin}/intake/rotation`,expires_at:Date.now()+300000}});
 if(path.endsWith('/enrollment-intents/rotation'))return answer({intent:{id:'rotation',state:'committed',connection_id:connection.id}});
 if(path.endsWith('/enrollment-intents'))return failEnrollment?answer({sudo_required:true},401):answer({intent:syntheticIntake?{id:'intent',state:'reserved',intake_url:`${origin}/intake/intent`,expires_at:Date.now()+300000}:{id:'intent',status:'awaiting_activation'},intake_enabled:syntheticIntake});
 if(path.endsWith('/enrollment-intents/intent'))return answer({intent:{id:'intent',state:'committed',connection_id:connection.id}});
 if(path.endsWith('/assignments')&&method==='POST')return failAssignment?answer({error:{code:'REVISION_MISMATCH',message:'Connection changed. Refresh before assigning.'}},409):answer({assignment:{id:'assignment'}});
 if(path.endsWith('/assignments'))return answer({assignments:[{id:'assignment',agent_id:'fixture-agent',revision:1,status:'active'}]});
 if(path.endsWith('/sessions'))return answer({sessions:[{id:'session',status:'stale',expires_at:'2030-01-01T00:00:00Z'}]});
 if(path.endsWith('/activity'))return answer({events:[{id:'event',action:'item.read',status:'succeeded'}]});
 if(path.endsWith('/revoke')||(path===`/api/connections/${connection.id}`&&method==='PATCH'))return answer({connection});
 if(path.endsWith('/agent-configurations')&&method==='POST'){const agent={...body,id:'agent-created',revision:1,lifecycle:'draft',execution_enabled:false};agents.push(agent);return answer({agent,readiness},201);}
 if(path.endsWith('/agent-configurations/agent-created')&&method==='PATCH'){Object.assign(agents[0],body);return answer({agent:agents[0],readiness});}
 if(path.endsWith('/agent-profiles'))return answer({profiles:[]});
 if(path.endsWith('/agent-configurations'))return answer({agents});
 if(path.endsWith('/readiness'))return answer(readiness);
 if(path==='/api/operational-projects')return method==='POST'?answer({project}):answer({projects:[project],next_cursor:null});
 if(path===`/api/operational-projects/${project.id}`)return answer({project});
 if(path.endsWith('/draft'))return answer({draft:{title:'',instructions:'',revision:1,status:'draft'}});
 if(path.endsWith('/versions'))return answer({versions:[],next_cursor:null});
 if(path.endsWith('/runs'))return answer({runs:[],next_cursor:null});
 if(path.endsWith('/events'))return answer({events:[],next_cursor:null});
 if(path.endsWith('/access'))return answer({members:[],events:[]});
 if(path.endsWith('/directory'))return answer({projects:[]});
 return answer({notifications:[],unread_count:0});
});
async function accessibility(name){
 if(!process.env.LIGHTHOUSE_DIR)return;
 if(!flow){const {startFlow}=await import(`${process.env.LIGHTHOUSE_DIR}/node_modules/lighthouse/core/index.js`);const {default:puppeteer}=await import(`${process.env.LIGHTHOUSE_DIR}/node_modules/puppeteer-core/lib/esm/puppeteer/puppeteer-core.js`);lighthouseBrowser=await puppeteer.connect({browserURL:'http://127.0.0.1:9339'});const pages=await lighthouseBrowser.pages();flow=await startFlow(pages.find(p=>p.url()===page.url()),{config:{extends:'lighthouse:default',settings:{onlyCategories:['accessibility'],formFactor:'mobile',screenEmulation:{disabled:true}}}});}
 await flow.snapshot({name});const results=await flow.createFlowResult();const lhr=results.steps.at(-1).lhr;const score=Math.round(lhr.categories.accessibility.score*100);report.accessibility??=[];report.accessibility.push({name,score,failures:Object.values(lhr.audits).filter(a=>a.score===0).map(a=>a.id)});assert(score>=90,`${name} accessibility ${score}`);
}
async function functionalContrast(themeId) {
  await page.getByRole('dialog').getByLabel('Connection name').focus();
  const measurements=await page.evaluate(()=>{
    const canvas=document.createElement('canvas');canvas.width=canvas.height=1;const ctx=canvas.getContext('2d');
    function lum(color){ctx.clearRect(0,0,1,1);ctx.fillStyle=color;ctx.fillRect(0,0,1,1);return [...ctx.getImageData(0,0,1,1).data].slice(0,3).map(v=>{v/=255;return v<=0.04045?v/12.92:((v+0.055)/1.055)**2.4;}).reduce((sum,v,i)=>sum+v*[0.2126,0.7152,0.0722][i],0);}
    function ratio(a,b){a=lum(a);b=lum(b);return (Math.max(a,b)+0.05)/(Math.min(a,b)+0.05);}
    const dialog=document.querySelector('[role=dialog]'),surface=getComputedStyle(dialog),input=dialog.querySelector('input'),control=getComputedStyle(input),status=getComputedStyle(document.querySelector('div[role=status]'));
    const card=getComputedStyle(dialog.querySelector('div.rounded-lg.border'));
    return {focusVisible:input.matches(':focus-visible'),focusShadow:control.boxShadow!=='none',focus:ratio(control.getPropertyValue('--tw-ring-color'),surface.backgroundColor),inputBorder:ratio(control.borderTopColor,surface.backgroundColor),status:ratio(status.color,status.backgroundColor),decorativeCardBorder:ratio(card.borderTopColor,surface.backgroundColor)};
  });
  await page.getByRole('dialog').getByLabel('Connection name').fill('Contrast fixture');failEnrollment=true;
  await page.getByRole('dialog').getByRole('button',{name:'Save setup details'}).click();await page.getByRole('dialog').getByRole('alert').waitFor();
  measurements.error=await page.evaluate(()=>{const ctx=document.createElement('canvas').getContext('2d');function lum(color){ctx.fillStyle=color;ctx.fillRect(0,0,1,1);return [...ctx.getImageData(0,0,1,1).data].slice(0,3).map(v=>{v/=255;return v<=0.04045?v/12.92:((v+0.055)/1.055)**2.4;}).reduce((sum,v,i)=>sum+v*[0.2126,0.7152,0.0722][i],0);}const dialog=document.querySelector('[role=dialog]');const a=lum(getComputedStyle(dialog.querySelector('[role=alert]')).color),b=lum(getComputedStyle(dialog).backgroundColor);return (Math.max(a,b)+0.05)/(Math.min(a,b)+0.05);});
  failEnrollment=false;
  assert(measurements.focusVisible&&measurements.focusShadow,`${themeId} input focus not rendered`);
  assert(measurements.focus>=3,`${themeId} focus contrast ${measurements.focus}`);
  assert(measurements.status>=4.5,`${themeId} status contrast ${measurements.status}`);
  assert(measurements.inputBorder>=3,`${themeId} functional input border ${measurements.inputBorder}`);
  assert(measurements.error>=4.5,`${themeId} error text ${measurements.error}`);
  report.functionalContrast??=[];report.functionalContrast.push({theme:themeId,...measurements,limitations:[],roleScope:'New broker/setup controls; existing Midnight palette tokens unchanged',decorativeBorderNote:'Card grouping outlines are decorative; excluded from functional boundary threshold'});
}
async function capture(name) {
 if(!process.env.BROWSER_ARTIFACTS)return;
 mkdirSync(process.env.BROWSER_ARTIFACTS,{recursive:true});
 await page.evaluate(()=>{window.scrollTo(0,0);document.querySelectorAll('*').forEach(el=>{if(el.scrollTop)el.scrollTop=0;});});
 await page.screenshot({animations:'disabled',path:`${process.env.BROWSER_ARTIFACTS}/${name}.png`,fullPage:true});report.screenshots.push(`${name}.png`);
}
async function captureVisible(name, target) {
 if(!process.env.BROWSER_ARTIFACTS)return;
 await target.scrollIntoViewIfNeeded();
 await page.screenshot({animations:'disabled',path:`${process.env.BROWSER_ARTIFACTS}/${name}.png`,fullPage:true});report.screenshots.push(`${name}.png`);
}
async function journey(name,fn){await fn();report.journeys.push(name);console.log(`ok - ${name}`);}
try{
 await journey('project without guide or credentials',async()=>{
 await page.goto(`${origin}/operational-projects`);await page.getByRole('button',{name:'New project',exact:true}).click();await capture('new-project');await page.getByLabel('Name',{exact:true}).fill('Fixture project');await page.getByLabel('Purpose (optional)').fill('Synthetic UI fixture');await page.getByRole('button',{name:'Create project',exact:true}).click();await page.getByRole('navigation',{name:'Operation sections'}).getByRole('button',{name:'Agents',exact:true}).click();await page.getByRole('button',{name:'Add an agent',exact:true}).waitFor();await accessibility('Project Agents');await capture('project-agents');await page.getByRole('navigation',{name:'Operation sections'}).getByRole('button',{name:'Overview',exact:true}).click();await capture('project-overview');await page.getByRole('navigation',{name:'Operation sections'}).getByRole('button',{name:'Agents',exact:true}).click();assert.deepEqual(requests.find(r=>r.path==='/api/operational-projects'&&r.method==='POST').body.members,[]);
 });
 await journey('four sections guide reuse draft then explicit assignment and failure recovery',async()=>{
 await page.getByRole('button',{name:'Add an agent',exact:true}).click();await page.getByLabel('Agent name',{exact:true}).fill('Ledger reader');await page.getByLabel('Task',{exact:true}).fill('Read permitted item');await page.getByLabel('Approved guide').selectOption('guide-1');await capture('agent-work');await page.getByRole('button',{name:'Next: Connections'}).click();await page.getByRole('button',{name:'Select connection',exact:true}).click();await capture('agent-selected-scope');await page.getByText('Edit scope',{exact:true}).click();await capture('agent-edit-scope');await page.getByRole('button',{name:'Next: Controls'}).click();await page.getByLabel('Assignment expiry (your local time)').fill('2030-01-01T12:00');await capture('agent-controls');await page.getByRole('button',{name:'Next: Review'}).click();await capture('agent-review');await page.getByRole('button',{name:'Save draft',exact:true}).click();await page.getByRole('heading',{name:'Readiness checklist'}).waitFor();assert.equal(agents[0].work.guide_ref.id,'guide-1');assert(!requests.some(r=>r.path.endsWith('/assignments')&&r.method==='POST'));failAssignment=true;await page.getByRole('button',{name:'Confirm assignment',exact:true}).click();await page.getByRole('alert').filter({hasText:'Agent remains saved'}).waitFor();assert.equal(agents.length,1);failAssignment=false;await page.getByRole('button',{name:'Refresh assignment permissions'}).click();await page.getByText('Permissions refreshed.',{exact:false}).waitFor();await page.getByRole('button',{name:'Confirm assignment',exact:true}).click();await page.getByText('Assignment saved. This does not start a run.').waitFor();assert(!requests.some(r=>/start|practice/.test(r.path)));
 });
 await journey('saved draft can be edited',async()=>{
 await page.reload();await page.getByRole('button',{name:'Edit configuration'}).click();await page.getByLabel('Agent name',{exact:true}).fill('Edited reader');await page.getByRole('button',{name:'4. Review'}).click();await page.getByRole('button',{name:'Save draft'}).click();await page.getByRole('heading',{name:'Edited reader · Draft / disabled'}).waitFor();assert.equal(agents.length,1);
 });
 await journey('save draft on every setup section creates no assignment or execution',async()=>{
 for(let step=0;step<4;step++) {
   await page.goto(`${origin}/operational-projects/${project.id}?section=Agents`);await page.getByRole('button',{name:'Edit configuration',exact:true}).click();
   await page.getByRole('button',{name:`${step+1}. ${['Work','Connections','Controls','Review'][step]}`,exact:true}).click();
   if(step===0)await page.getByText('Supported execution: synthetic ledger API',{exact:true}).waitFor();
   if(step===1)await page.getByRole('button',{name:'Select connection',exact:true}).click();
   const before=requests.length;await page.getByRole('button',{name:'Save draft',exact:true}).click();await page.getByRole('heading',{name:'Readiness checklist',exact:true}).waitFor();
   const writes=requests.slice(before).filter(r=>r.method!=='GET');assert.equal(writes.length,1);assert(writes[0].path.includes('/agent-configurations/'));assert.equal(writes[0].method,'PATCH');assert(!writes.some(r=>/assignments|start|practice/.test(r.path)));assert.equal(agents.length,1);
 }
 });
 await journey('use-only revoked and quarantined connections stay visible without selection authority',async()=>{
 extraConnections=[{...connection,id:'use-only',name:'Use-only ledger',rights:['view','use']},{...connection,id:'revoked-ledger',name:'Revoked ledger',status:'revoked',readiness:{code:'CONNECTION_REVOKED'}},{...connection,id:'quarantined-ledger',name:'Quarantined ledger',readiness:{code:'POLICY_REVALIDATION_REQUIRED'}}];
 await page.goto(`${origin}/operational-projects/${project.id}?section=Agents`);await page.getByRole('button',{name:'Add an agent',exact:true}).click();await page.getByRole('button',{name:'Next: Connections'}).click();
 for(const name of ['Use-only ledger','Revoked ledger','Quarantined ledger']){const row=page.getByRole('listitem').filter({has:page.getByRole('heading',{name,exact:true})});await row.waitFor();assert(await row.getByRole('button',{name:'Select connection',exact:true}).isDisabled());}
 const active=page.getByRole('listitem').filter({has:page.getByRole('heading',{name:connection.name,exact:true})});await active.getByRole('button',{name:'Select connection',exact:true}).click();assert(await active.getByRole('button',{name:'Remove selection',exact:true}).isEnabled());
 forbidden=true;await page.getByRole('button',{name:'Refresh connections',exact:true}).click();await page.getByText('No permitted connections to show.',{exact:false}).waitFor();assert.equal(await page.getByText(connection.name,{exact:true}).count(),0);await page.getByText('No connections selected.',{exact:true}).waitFor();forbidden=false;extraConnections=[];
 });
 await journey('saved-agent catalogue preserves the exact-agent assignment decision',async()=>{
 exactAgentAssignmentDenied=true;await page.goto(`${origin}/operational-projects/${project.id}?section=Agents`);await page.getByRole('button',{name:'Edit configuration',exact:true}).click();await page.getByRole('button',{name:'Next: Connections',exact:true}).click();
 const row=page.getByRole('listitem').filter({has:page.getByRole('heading',{name:connection.name,exact:true})});await row.waitFor();await row.getByText('Assignment unavailable',{exact:true}).waitFor();assert(await row.getByRole('button',{name:'Select connection',exact:true}).isDisabled());assert.equal(await page.getByRole('button',{name:'Remove selection',exact:true}).count(),0);exactAgentAssignmentDenied=false;
 });
 await journey('no secret input or unsupported auth; no replay; keyboard focus',async()=>{
 await page.goto(`${origin}/connections`);await page.getByRole('button',{name:'Add connection',exact:true}).click();const dialog=page.getByRole('dialog');await dialog.waitFor();assert.equal(await dialog.locator('input[type=password]').count(),0);await dialog.getByLabel('Connection name').fill('Enrollment fixture');failEnrollment=true;const before=requests.filter(r=>r.path.endsWith('/enrollment-intents')).length;await dialog.getByRole('button',{name:'Save setup details'}).click();await dialog.getByRole('alert').waitFor();assert.equal(requests.filter(r=>r.path.endsWith('/enrollment-intents')).length,before+1);assert(!requests.some(r=>r.path==='/api/auth/sudo'));await page.keyboard.press('Escape');await page.getByRole('dialog').waitFor({state:'hidden'});assert(await page.getByRole('button',{name:'Add connection',exact:true}).evaluate(e=>e===document.activeElement));failEnrollment=false;
 });
 await journey('synthetic intake opens only trusted broker origin and status refresh does not resubmit',async()=>{
 syntheticIntake=true;await page.goto(`${origin}/connections`);await page.getByRole('button',{name:'Add connection',exact:true}).click();await page.getByRole('dialog').getByLabel('Connection name').fill('Synthetic intake');await page.getByRole('button',{name:'Save setup details'}).click();const link=page.getByRole('link',{name:'Open trusted broker intake'});await link.waitFor();assert.equal(await link.getAttribute('href'),`${origin}/intake/intent`);const before=requests.filter(r=>r.path.endsWith('/enrollment-intents')&&r.method==='POST').length;await page.getByRole('button',{name:'Check enrollment status'}).click();await page.getByText('Connection enrolled.',{exact:false}).waitFor();assert.equal(requests.filter(r=>r.path.endsWith('/enrollment-intents')&&r.method==='POST').length,before);await page.keyboard.press('Escape');syntheticIntake=false;await page.goto(`${origin}/connections`);
 });
 await journey('rotation uses broker intake and observes committed version',async()=>{
 syntheticIntake=true;await page.goto(`${origin}/connections`);await page.getByRole('button',{name:'Details and access'}).click();await page.getByRole('button',{name:'Rotate credential',exact:true}).click();await page.getByRole('button',{name:'Prepare rotation'}).click();const dialog=page.getByRole('dialog');assert.equal(await dialog.locator('input[type=password]').count(),0);await dialog.getByRole('link',{name:'Open trusted broker intake'}).waitFor();assert.equal(await dialog.getByRole('link',{name:'Open trusted broker intake'}).getAttribute('href'),`${origin}/intake/rotation`);await dialog.getByRole('button',{name:'Check rotation status'}).click();await dialog.getByText('Credential rotated.',{exact:false}).waitFor();await dialog.getByRole('button',{name:'Close',exact:true}).first().click();syntheticIntake=false;await page.goto(`${origin}/connections`);
 });
 await journey('unassign versus connection revoke and stale sessions',async()=>{
 await page.getByRole('button',{name:'Details and access'}).click();await page.getByText('stale · expires',{exact:false}).waitFor();await capture('catalogue-detail-lifecycle');await page.getByRole('button',{name:'Remove from agent',exact:true}).click();await page.getByRole('button',{name:'Confirm remove from agent'}).click();await page.getByRole('button',{name:'Details and access'}).click();await page.getByRole('button',{name:'Revoke connection',exact:true}).click();await page.getByRole('button',{name:'Confirm revoke connection'}).click();assert(requests.some(r=>r.path==='/api/connections/assignments/assignment/revoke'));assert(requests.some(r=>r.path===`/api/connections/${connection.id}/revoke`));
 });
 await journey('restored policy quarantine is explicit and blocks test and rotation',async()=>{
 syntheticIntake=true;connection.readiness.code='POLICY_REVALIDATION_REQUIRED';await page.goto(`${origin}/connections`);await page.getByText('Blocked: restored policy',{exact:false}).waitFor();await page.getByRole('button',{name:'Details and access'}).click();assert(await page.getByRole('button',{name:'Test (read only)'}).isDisabled());assert(await page.getByRole('button',{name:'Rotate credential',exact:true}).isDisabled());connection.readiness.code='SYNTHETIC_ONLY';syntheticIntake=false;
 });
 await journey('permission filtering clears hidden metadata',async()=>{forbidden=true;await page.getByRole('button',{name:'Refresh connections'}).click();await page.getByText('No permitted connections to show.',{exact:false}).waitFor();assert.equal(await page.getByText('Fixture ledger',{exact:true}).count(),0);forbidden=false;});
 await journey('three color-only themes preserve structure, persist choice and support keyboard selection',async()=>{
 await page.setViewportSize({width:1280,height:1000});
 const expectedCatalogue=structuredClone([connection]);
 async function loadCatalogue(navigate) {
   // Page chrome renders before the async catalogue. Compare each theme only
   // after the same fixture data has arrived and its card has rendered.
   const response=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/connections'&&r.request().method()==='GET');
   await navigate();
   const loaded=await response;
   assert.equal(loaded.status(),200);
   assert.deepEqual((await loaded.json()).connections,expectedCatalogue);
   await page.getByText(connection.name,{exact:true}).waitFor();
   await page.getByRole('button',{name:'Details and access',exact:true}).waitFor();
 }
 await loadCatalogue(()=>page.goto(`${origin}/connections`));await page.getByRole('button',{name:'Add connection',exact:true}).waitFor();
 const signature=()=>page.evaluate(()=>[...document.querySelectorAll('h1,main h2,main button')].map(e=>({text:e.textContent,font:getComputedStyle(e).fontFamily,size:getComputedStyle(e).fontSize,rect:[e.getBoundingClientRect().width,e.getBoundingClientRect().height]})));
 const baseline=await signature();const backgrounds=[];
 for(const [id,name] of [['midnight','Midnight'],['latte','Latte'],['office','Office']]){
   await page.getByRole('button',{name:/Color theme:/}).first().click();assert.equal(await page.getByRole('menuitemradio').count(),3);await page.getByRole('menuitemradio',{name,exact:true}).click();assert.equal(await page.evaluate(()=>document.documentElement.dataset.theme),id);assert.equal(await page.evaluate(()=>localStorage.getItem('pp-theme')),id);await loadCatalogue(()=>page.reload());await page.getByRole('button',{name:`Color theme: ${name}`}).first().waitFor();assert.equal(await page.evaluate(()=>document.documentElement.dataset.theme),id);assert.deepEqual(await signature(),baseline);backgrounds.push(await page.evaluate(()=>getComputedStyle(document.body).backgroundColor));
 }
 assert.equal(new Set(backgrounds).size,3);
 await page.getByRole('button',{name:'Color theme: Office'}).first().focus();await page.keyboard.press('Enter');await page.keyboard.press('Home');await page.waitForFunction(()=>document.activeElement?.textContent==='Midnight');await page.keyboard.press('ArrowDown');await page.waitForFunction(()=>document.activeElement?.textContent==='Latte');await page.keyboard.press('Enter');await page.waitForFunction(()=>document.documentElement.dataset.theme==='latte');
 });
 if(process.env.BROWSER_ARTIFACTS)for(const themeId of ['midnight','latte','office'])for(const width of [390,1536]) {
 await page.evaluate(v=>localStorage.setItem('pp-theme',v),themeId);await page.setViewportSize({width,height:1100});await page.goto(`${origin}/operational-projects/${project.id}?section=Agents`);await page.getByRole('button',{name:'Add an agent',exact:true}).click();await capture(`work-${themeId}-${width}`);await captureVisible(`work-footer-${themeId}-${width}`,page.getByRole('button',{name:'Next: Connections'}));await page.getByRole('button',{name:'Next: Connections'}).click();await page.getByRole('button',{name:'Select connection',exact:true}).click();await capture(`scope-summary-${themeId}-${width}`);await captureVisible(`scope-card-summary-${themeId}-${width}`,page.getByText('Edit scope',{exact:true}).locator('xpath=ancestor::li'));await page.getByText('Edit scope',{exact:true}).click();await capture(`scope-edit-${themeId}-${width}`);await captureVisible(`scope-card-edit-${themeId}-${width}`,page.getByText('Edit scope',{exact:true}).locator('xpath=ancestor::li'));await page.getByRole('button',{name:'Next: Controls'}).click();await capture(`controls-${themeId}-${width}`);await captureVisible(`controls-footer-${themeId}-${width}`,page.getByRole('button',{name:'Next: Review'}));await page.getByRole('button',{name:'Next: Review'}).click();await capture(`review-${themeId}-${width}`);await page.getByRole('button',{name:'Cancel setup'}).scrollIntoViewIfNeeded();await page.screenshot({animations:'disabled',path:`${process.env.BROWSER_ARTIFACTS}/setup-footer-${themeId}-${width}.png`,fullPage:true});
 syntheticIntake=true;await page.goto(`${origin}/connections`);await page.getByRole('button',{name:'Details and access'}).click();await capture(`catalogue-${themeId}-${width}`);await page.getByRole('heading',{name:'Sessions',exact:true}).scrollIntoViewIfNeeded();await page.screenshot({animations:'disabled',path:`${process.env.BROWSER_ARTIFACTS}/catalogue-lifecycle-${themeId}-${width}.png`,fullPage:true});await page.getByRole('button',{name:'Rotate credential',exact:true}).click();await capture(`rotation-${themeId}-${width}`);await page.keyboard.press('Escape');syntheticIntake=false;
 }
 for(const [themeId,themeName] of [['midnight','Midnight'],['latte','Latte'],['office','Office']])for(const width of [360,375,390,768,1280,1920]){
 await page.evaluate(value=>localStorage.setItem('pp-theme',value),themeId);
 await page.setViewportSize({width,height:1000});await page.goto(`${origin}/operational-projects/${project.id}?section=Agents`);await page.getByRole('button',{name:'Add an agent',exact:true}).click();await page.getByRole('button',{name:'Next: Connections'}).click();await page.getByRole('button',{name:'Add connection',exact:true}).click();await page.getByRole('dialog').waitFor();if(width===375)await accessibility(`${themeName} Add connection mobile dialog`);await page.addStyleTag({content:'html,body{overflow-x:visible!important}'});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth),`overflow ${themeId} ${width}`);if(width===375){const contrast=await page.evaluate(()=>{const c=document.createElement('canvas');c.width=c.height=1;const ctx=c.getContext('2d');function luminance(color){ctx.clearRect(0,0,1,1);ctx.fillStyle=color;ctx.fillRect(0,0,1,1);return [...ctx.getImageData(0,0,1,1).data].slice(0,3).map(v=>{v/=255;return v<=0.04045?v/12.92:((v+0.055)/1.055)**2.4;}).reduce((sum,v,i)=>sum+v*[0.2126,0.7152,0.0722][i],0);}function ratio(a,b){a=luminance(a);b=luminance(b);return (Math.max(a,b)+0.05)/(Math.min(a,b)+0.05);}const dialog=document.querySelector('[role=dialog]');const body=getComputedStyle(dialog);const helper=getComputedStyle(dialog.querySelector('[id$=description]')||dialog.querySelector('p'));const action=getComputedStyle([...dialog.querySelectorAll('button')].find(e=>e.textContent==='Save setup details'));return {body:ratio(body.color,body.backgroundColor),helper:ratio(helper.color,body.backgroundColor),action:ratio(action.color,action.backgroundColor)};});for(const [kind,value] of Object.entries(contrast))assert(value>=4.5,`${themeId} ${kind} contrast ${value}`);report.contrast??=[];report.contrast.push({theme:themeId,...contrast});await functionalContrast(themeId);}if(process.env.BROWSER_ARTIFACTS){mkdirSync(process.env.BROWSER_ARTIFACTS,{recursive:true});await capture(`broker-modal-${themeId}-${width}`);if(width<640){await page.getByRole('dialog').getByRole('button',{name:'Save setup details'}).scrollIntoViewIfNeeded();await page.screenshot({animations:'disabled',path:`${process.env.BROWSER_ARTIFACTS}/broker-modal-footer-${themeId}-${width}.png`});}}await page.getByRole('dialog').getByLabel('Connection name').fill(`Width ${width}`);await page.getByRole('dialog').getByRole('button',{name:'Save setup details'}).click();await page.getByText('Setup request saved',{exact:false}).waitFor();await page.getByRole('dialog').getByRole('button',{name:'Close',exact:true}).first().click();await page.getByRole('dialog').waitFor({state:'hidden'});await page.evaluate(()=>{window.scrollTo(0,0);document.querySelectorAll('*').forEach(el=>{if(el.scrollTop)el.scrollTop=0;});});report.layout.push({theme:themeId,width});if(process.env.BROWSER_ARTIFACTS){mkdirSync(process.env.BROWSER_ARTIFACTS,{recursive:true});await page.screenshot({animations:'disabled',path:`${process.env.BROWSER_ARTIFACTS}/broker-${themeId}-${width}.png`,fullPage:true});}
 }
 assert.deepEqual(errors,[]);if(process.env.BROWSER_ARTIFACTS){mkdirSync(process.env.BROWSER_ARTIFACTS,{recursive:true});writeFileSync(`${process.env.BROWSER_ARTIFACTS}/broker-ui-report.json`,JSON.stringify(report,null,2));}
}catch(e){writeFileSync('/tmp/broker-ui-failure.html',await page.content());await page.screenshot({animations:'disabled',path:'/tmp/broker-ui-failure.png',fullPage:true});console.error(errors);throw e;}finally{lighthouseBrowser?.disconnect();await browser.close();await vite.close();}
