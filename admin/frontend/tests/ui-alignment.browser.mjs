// Frozen UI responses validate presentation and client journeys; backend suites
// separately prove guide authorization, atomic publication, fencing and grants.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from '../../backend/node_modules/playwright-core/index.mjs';

const vite = await createServer({root:fileURLToPath(new URL('..',import.meta.url)),server:{host:'127.0.0.1',port:0}});
await vite.listen();
const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
const browser = await chromium.launch({executablePath:process.env.BROWSER_EXE || '/usr/bin/chromium',args:['--no-sandbox']});
const artifacts = process.env.BROWSER_ARTIFACTS;
if (artifacts) mkdirSync(artifacts,{recursive:true});
const owner={id:'00000000-0000-4000-8000-000000000001',username:'Finance owner',role:'user',permissions:[]};
const guide={id:'00000000-0000-4000-8000-000000000011',title:'Invoice reconciliation',instructions:'Match invoices to purchase orders and record discrepancies.',content_hash:'a'.repeat(64),version_number:3,approved_by:owner.id,approved_at:'2026-10-02T10:00:00Z'};
const project={id:'00000000-0000-4000-8000-000000000002',name:'Reconcile invoices',description:'Match supplier invoices to purchase orders and flag exceptions for review.',owner_name:owner.username,own_role:'owner',revision:1,current_version:guide,site_origin:'https://demo.fractionate.ai',site_revision:1,visibility:'private'};
const projects=[project,{...project,id:'00000000-0000-4000-8000-000000000012',name:'Weekly reporting',current_version:null},{...project,id:'00000000-0000-4000-8000-000000000013',name:'Supplier setup'},{...project,id:'00000000-0000-4000-8000-000000000014',name:'Employee onboarding',current_version:null}];
const connection={id:'00000000-0000-4000-8000-000000000003',name:'Finance ledger',adapter_id:'synthetic-ledger-v1',rights:['view','use','assign','manage'],operations:['item.read'],resources:['00000000-0000-4000-8000-000000000004'],limits:{max_actions:20,max_seconds:300},revision:1,status:'active',credential_version:1,readiness:{code:'VERIFIED'}};
const pending={id:'00000000-0000-4000-8000-000000000021',title:'Summarize',instructions:'Summarize the website',content_hash:'b'.repeat(64),submitted_by:owner.id,submitted_at:'2026-10-01T09:35:10Z',contributors:[owner.id],contributors_json:JSON.stringify([owner.id]),revision:1,state:'pending'};
let role='owner',draftState='published',stale=false,denied=false,connectionState='normal',evidenceEnabled=false,draftRevision=1,serverText=guide.instructions;
let evidenceReferences=[];
const retainedReference={demonstration_id:'00000000-0000-4000-8000-000000000041',revision_id:'00000000-0000-4000-8000-000000000042',item_position:0,object_id:'00000000-0000-4000-8000-000000000043',annotation_id:'00000000-0000-4000-8000-000000000044',available:false};
const draft=()=>({title:draftState==='pending'?pending.title:guide.title,instructions:draftState==='pending'?pending.instructions:serverText,revision:draftRevision,status:draftState,pending_submission:draftState==='pending'?pending:null,contributors:[owner.id],evidence:{references:evidenceReferences}});
const requests=[],errors=[],agents=[];
const report={synthetic:true,source_commit:process.env.SOURCE_COMMIT || execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),generated_at:new Date().toISOString(),journeys:[],layout:[],screenshots:[],geometry:[],reference_fit:{}};
const context=await browser.newContext({viewport:{width:1536,height:1024}});
await context.addInitScript(()=>{localStorage.setItem('pp-theme','office');});
const page=await context.newPage();page.setDefaultTimeout(30000);page.setDefaultNavigationTimeout(90000);page.on('pageerror',e=>errors.push(e.message));
await page.route('**/api/**',async route=>{
 const request=route.request(),path=new URL(request.url()).pathname,method=request.method(),body=request.postData()?request.postDataJSON():null;
 requests.push({path,method,body,ifMatch:request.headers()['if-match']});
 const answer=(data,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(data)});
 if(path==='/api/auth/verify')return answer({user:owner});
 if(path==='/api/branding')return answer({name:'Fractionate',logo:null});
 if(path==='/api/operational-projects/capabilities')return answer({enabled:true,ui_available:true,agents_metadata_enabled:true,evidence_enabled:evidenceEnabled,agent_runs_enabled:false,can_manage_settings:false});
 if(path==='/api/connections/capabilities')return answer({mode:'disabled',intake_enabled:false,execution_enabled:false,adapters:[],reason:'BROKER_NOT_ACTIVATED'});
 if(path==='/api/connections')return answer({connections:connectionState==='empty'?[]:connectionState==='restricted'?[{...connection,status:'revoked',rights:['view','use'] }]:[connection]});
 if(path.endsWith('/enrollment-intents'))return answer({intent:{id:'metadata-only',status:'awaiting_activation'},intake_enabled:false});
 if(path==='/api/operational-projects/directory')return answer({projects:[],next_cursor:null});
 if(path==='/api/operational-projects'){
  if(method==='POST')return answer({project:{...project,id:'00000000-0000-4000-8000-000000000030',name:body.name,description:body.description,current_version:null}},201);
  return answer({projects:projects.map(p=>({...p,own_role:role})),next_cursor:null});
 }
 const prefix='/api/operational-projects/';
 if(path.startsWith(prefix)){
  if(denied)return answer({error:'Project access was revoked'},403);
  if(path.endsWith('/demonstrations'))return answer({demonstrations:[],next_cursor:null});
  if(path.endsWith('/draft/evidence')&&method==='PUT'){
   if(request.headers()['if-match']!==`"${draftRevision}"`)return answer({error:'Draft revision changed'},412);
   evidenceReferences=body.references;draftRevision+=1;return answer({revision:draftRevision});
  }
  if(path.endsWith('/agent-configurations')&&method==='POST'){const agent={...body,id:'agent-fixture',revision:1,lifecycle:'draft',execution_enabled:false};agents.push(agent);return answer({agent,readiness:{state:'blocked',can_start:false,checks:[{kind:'broker',state:'unavailable',code:'BROKER_NOT_ACTIVATED',next_action:'review_deployment'}]}},201);}
  if(path.endsWith('/agent-configurations'))return answer({agents});
  if(path.endsWith('/agent-profiles'))return answer({profiles:[]});
  if(path.endsWith('/draft')&&method==='PATCH'){
   if(stale||(evidenceEnabled&&request.headers()['if-match']!==`"${draftRevision}"`))return answer({error:'The guide changed. Reload before saving.'},412);
   draftState='published';return answer({revision:2,status:'published',version:{...guide,title:body.title,instructions:body.instructions,version_number:4}});
  }
  if(path.endsWith('/draft'))return answer({draft:draft()});
  if(path.endsWith('/approve')&&method==='POST'){draftState='published';return answer({revision:2,version:{...guide,title:pending.title,instructions:pending.instructions,version_number:4}});}
  if(path.endsWith('/versions'))return answer({versions:[guide],next_cursor:null});
  if(path.endsWith('/runs'))return answer({runs:[],next_cursor:null});
  if(path.endsWith('/events'))return answer({events:[{id:'event-1',action:'guide_approved',created_at:'2026-10-02T10:00:00Z'}],next_cursor:null});
  if(path.endsWith('/access'))return answer({owner:{user_id:owner.id,username:owner.username},members:[],events:[]});
  if(path.includes('/access/candidate'))return answer({user_id:'00000000-0000-4000-8000-000000000031',username:'Finance reviewer'});
  const id=path.slice(prefix.length);return answer({project:{...(projects.find(p=>p.id===id)||project),own_role:role,current_version:draftState==='pending'||draftState==='draft'?null:guide}});
 }
 return answer({notifications:[],unread_count:0,settings:{},status:'ok'});
});
const detail=section=>`${origin}/operational-projects/${project.id}?section=${encodeURIComponent(section)}`;
async function shot(name){if(!artifacts)return;await page.evaluate(()=>{window.scrollTo(0,0);document.querySelectorAll('main, main>div').forEach(e=>e.scrollTop=0);});await page.screenshot({path:`${artifacts}/${name}.png`,animations:'disabled',fullPage:true});report.screenshots.push(`${name}.png`);}
async function journey(name,fn){await fn();report.journeys.push({name,passed:true});console.log(`ok - ${name}`);}
async function loaded(section='Overview'){await page.goto(detail(section));await page.locator('[data-selected-project]').waitFor();await page.getByRole('heading',{name:project.name,exact:true}).waitFor();}
async function audit(width,state){await page.addStyleTag({content:'html,body{overflow-x:visible!important}'});const sizes=await page.evaluate(()=>({width:document.documentElement.clientWidth,scroll:document.documentElement.scrollWidth}));assert(sizes.scroll<=sizes.width,`overflow ${state} at ${width}: ${JSON.stringify(sizes)}`);report.layout.push({width,state,...sizes});}
try{
 await journey('short private creation with cancel/reopen and no raw account IDs',async()=>{
  await page.goto(`${origin}/operational-projects`);await page.getByRole('button',{name:'New project',exact:true}).click();
  let dialog=page.getByRole('dialog');await dialog.waitFor();assert.equal(await dialog.getByLabel(/account ID/i).count(),0);
  await dialog.getByLabel('Name',{exact:true}).fill('Cancelled project');await page.keyboard.press('Escape');await dialog.waitFor({state:'hidden'});
  await page.getByRole('button',{name:'New project',exact:true}).click();dialog=page.getByRole('dialog');assert.equal(await dialog.getByLabel('Name',{exact:true}).inputValue(),'');
  await shot('new-project-office-1536');await dialog.getByLabel('Name',{exact:true}).fill('Private fixture');await dialog.getByLabel('Purpose (optional)',{exact:true}).fill('Review invoices');await dialog.getByRole('button',{name:'Create project',exact:true}).click();
  await page.waitForURL(/operational-projects\/00000000-0000-4000-8000-000000000030/);
  const created=requests.filter(r=>r.path==='/api/operational-projects'&&r.method==='POST');assert.equal(created.length,1);assert.deepEqual(created[0].body.members||[],[]);
 });
 await journey('overview summary hierarchy and separate Details actions',async()=>{
  await loaded();for(const title of ['Guide & material','Version & readiness','Agents','Recent activity','Access & connections'])await page.getByRole('heading',{name:title,exact:true}).waitFor();
  assert.equal(await page.getByLabel('Archive reason').count(),0);assert.equal(await page.getByLabel('Purpose (optional)',{exact:true}).count(),0);
  await shot('overview-office-1536');
  const fit=await page.evaluate(()=>{
   const list=document.querySelector('[data-project-browser]').getBoundingClientRect(),detail=document.querySelector('[data-selected-project]').getBoundingClientRect();
   const access=[...document.querySelectorAll('h2')].find(h=>h.textContent==='Access & connections').closest('section').getBoundingClientRect();
   return {width:innerWidth,height:innerHeight,list_width:list.width,detail_width:detail.width,list_fraction:list.width/(list.width+detail.width),access_bottom:access.bottom};
  });report.reference_fit.overview=fit;
  assert(fit.list_fraction>=0.38&&fit.list_fraction<=0.42,`Reference project-list proportion: ${JSON.stringify(fit)}`);
  assert(fit.access_bottom<=fit.height,`Overview Access card should fit the first reference-size viewport: ${JSON.stringify(fit)}`);
  await page.getByRole('navigation',{name:'Operation sections'}).getByRole('button',{name:'Details',exact:true}).click();await page.getByLabel('Purpose (optional)',{exact:true}).waitFor();
 });
 await journey('pending guide has explicit save-to-approved action with no reviewer blocker',async()=>{
  draftState='pending';await loaded('Guide');const save=page.getByRole('button',{name:'Save and approve',exact:true});assert(await save.isEnabled());assert.equal(await page.getByText(/submitter or contributor cannot approve/i).count(),0);await shot('guide-pending-office-1536');await save.click();await page.getByText(/Guide saved and approved|Guide approved/i).first().waitFor();assert(requests.some(r=>r.path.endsWith(`/submissions/${pending.id}/approve`)&&r.method==='POST'));assert(!requests.some(r=>r.method==='POST'&&r.path.endsWith('/agent-runs')));
 });
 await journey('stale guide save retains entered text and makes no run request',async()=>{
  draftState='draft';stale=true;await loaded('Guide');await page.getByLabel('Guide title',{exact:true}).fill('Retain this title');await page.getByRole('button',{name:'Save and approve',exact:true}).click();await page.getByRole('alert').waitFor();assert.equal(await page.getByLabel('Guide title',{exact:true}).inputValue(),'Retain this title');stale=false;
 });
 await journey('viewer sees guide without publishing controls',async()=>{
  role='viewer';draftState='pending';await loaded('Guide');assert.equal(await page.getByRole('button',{name:'Save and approve',exact:true}).count(),0);role='owner';draftState='published';
 });
 await journey('evidence save after remount never rebases stale local guide text',async()=>{
  evidenceEnabled=true;draftState='draft';draftRevision=1;evidenceReferences=[retainedReference];serverText=guide.instructions;await loaded('Guide');
  await page.getByLabel('Guide title',{exact:true}).fill('Retain my local title');await page.getByLabel('Instructions',{exact:true}).fill('Retain my local instructions');
  draftRevision=2;serverText='A different approved guide was loaded by another editor.';
  await page.getByRole('button',{name:'Refresh',exact:true}).click();await page.getByText('Server state refreshed; unsaved forms retained.',{exact:true}).waitFor();
  const tabs=page.getByRole('navigation',{name:'Operation sections'});await tabs.getByRole('button',{name:'Overview',exact:true}).click();await tabs.getByRole('button',{name:'Guide',exact:true}).click();
  await page.getByRole('button',{name:'Detach selection 1',exact:true}).click();await page.getByRole('button',{name:'Save evidence selection',exact:true}).click();await page.getByText('Exact evidence selection saved; entered guide text retained.',{exact:true}).waitFor();
  const before=requests.length;await page.getByRole('button',{name:'Save and approve',exact:true}).click();await page.getByRole('alert').waitFor();
  assert.equal(requests.slice(before).find(r=>r.path.endsWith('/draft')&&r.method==='PATCH')?.ifMatch,'"1"');assert.equal(await page.getByLabel('Guide title',{exact:true}).inputValue(),'Retain my local title');assert.equal(await page.getByLabel('Instructions',{exact:true}).inputValue(),'Retain my local instructions');
  evidenceEnabled=false;evidenceReferences=[];draftRevision=1;serverText=guide.instructions;draftState='published';
 });
 await journey('same frozen project state has identical theme geometry',async()=>{
  let baseline;for(const theme of ['office','latte','midnight']){await page.evaluate(t=>localStorage.setItem('pp-theme',t),theme);await loaded();for(const title of ['Guide & material','Version & readiness','Agents','Recent activity','Access & connections'])await page.getByRole('heading',{name:title,exact:true}).waitFor();const geometry=await page.evaluate(()=>[...document.querySelectorAll('[data-project-workspace], [data-project-browser], [data-selected-project], main h1, main h2')].map(e=>({tag:e.tagName,text:e.tagName==='H1'||e.tagName==='H2'?e.textContent:null,font:getComputedStyle(e).fontFamily,size:getComputedStyle(e).fontSize,rect:[e.getBoundingClientRect().x,e.getBoundingClientRect().y,e.getBoundingClientRect().width,e.getBoundingClientRect().height]})));if(baseline)assert.deepEqual(geometry,baseline);else baseline=geometry;report.geometry.push({theme,geometry});await shot(`overview-${theme}-1536`);}
 });
 await journey('setup geometry, draft save separation and unsupported capability',async()=>{
  await page.evaluate(()=>localStorage.setItem('pp-theme','office'));await loaded('Agents');await page.getByRole('button',{name:'Add an agent',exact:true}).click();await page.getByLabel('Agent name',{exact:true}).fill('Invoice assistant');await shot('setup-work-office-1536');await page.getByRole('button',{name:'Next: Connections',exact:true}).click();await page.getByRole('button',{name:'Select connection',exact:true}).waitFor();await page.getByRole('button',{name:'Select connection',exact:true}).click();await shot('setup-connections-office-1536');
  const controls=await page.getByRole('button',{name:'Next: Controls',exact:true}).boundingBox();
  const selected=await page.getByRole('button',{name:'Remove selection',exact:true}).evaluate(button=>{const box=button.closest('li').getBoundingClientRect();return {top:box.top,bottom:box.bottom,height:box.height};});
  report.reference_fit.connections={viewport:{width:1536,height:1024},selected_card:selected,footer_action:controls};
  assert(selected.height<=112,`Selected connection should follow the reference card rhythm: ${JSON.stringify(selected)}`);
  assert(controls.y+controls.height<=1024,`Setup continuation should fit the first reference-size viewport: ${JSON.stringify(controls)}`);
  await page.getByRole('button',{name:'Add connection',exact:true}).click();await page.getByRole('dialog').waitFor();assert.equal(await page.getByRole('dialog').locator('input[type=password]').count(),0);await shot('add-connection-office-1536');await page.keyboard.press('Escape');await page.getByRole('dialog').waitFor({state:'hidden'});await page.getByRole('button',{name:'Next: Controls',exact:true}).click();await shot('setup-controls-office-1536');await page.getByRole('button',{name:'Next: Review',exact:true}).click();await shot('setup-review-office-1536');const before=requests.length;await page.getByRole('button',{name:'Save draft',exact:true}).click();await page.getByRole('heading',{name:'Readiness checklist',exact:true}).waitFor();assert(!requests.slice(before).some(r=>r.method==='POST'&&(/assignments|agent-runs|tasks/.test(r.path))));assert.equal(agents.at(-1).execution_enabled,false);
 });
 for(const width of [360,375,390,768,1280,1536,1920]){
  await page.setViewportSize({width,height:width<640?812:1024});await loaded();await audit(width,'overview');if([375,768,1920].includes(width))await shot(`overview-office-${width}`);
  await page.getByRole('button',{name:'New project',exact:true}).click();await page.getByRole('dialog').waitFor();await audit(width,'new-project');if(width===375)await shot('new-project-office-375');await page.keyboard.press('Escape');
  await loaded('Agents');await page.getByRole('button',{name:'Add an agent',exact:true}).click();await page.getByRole('button',{name:'Next: Connections',exact:true}).click();await page.getByRole('button',{name:'Select connection',exact:true}).waitFor();await audit(width,'setup-connections');if([375,768,1920].includes(width))await shot(`setup-connections-office-${width}`);await page.getByRole('button',{name:'Add connection',exact:true}).click();await page.getByRole('dialog').waitFor();await audit(width,'add-connection');if([375,768,1920].includes(width))await shot(`add-connection-office-${width}`);await page.keyboard.press('Escape');
 }
 assert.deepEqual(errors,[]);console.log('PASS UI alignment fixture journeys and seven-width overflow audit');
}catch(error){if(artifacts){await shot('failure');writeFileSync(`${artifacts}/failure.html`,await page.content());}throw error;}
finally{if(artifacts)writeFileSync(`${artifacts}/ui-alignment-report.json`,JSON.stringify({...report,errors},null,2));await browser.close();await vite.close();}
