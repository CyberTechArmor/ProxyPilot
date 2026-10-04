// Real global page and metadata component, scripted authenticated API responses.
// No credential intake, sign-in, OAuth, broker or browser operation is present.
import assert from 'node:assert/strict';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {createServer} from 'vite';
import {chromium} from '../../backend/node_modules/playwright-core/index.mjs';
const root=new URL('..',import.meta.url).pathname;
const vite=await createServer({root,server:{host:'127.0.0.1',port:0},logLevel:'error'});
vite.middlewares.stack.unshift({route:'/api',handle:(_req,res)=>{res.statusCode=500;res.setHeader('Content-Type','application/json');res.end('{"error":"Unintercepted fixture request"}');}});
await vite.listen();const origin=`http://127.0.0.1:${vite.httpServer.address().port}`;
const browser=await chromium.launch({executablePath:process.env.BROWSER_EXE||'/tmp/chromium',args:['--no-sandbox','--remote-debugging-port=9241']});
const page=await browser.newPage(),errors=[],calls=[],widths=[360,375,390,768,1280,1920];page.on('pageerror',e=>errors.push(e.message));
const user={id:'11111111-1111-4111-8111-111111111111',role:'user'},projects=Array.from({length:7},(_,i)=>({id:`22222222-2222-4222-8222-${String(i+1).padStart(12,'0')}`,name:`Project ${i+1}`,own_role:'owner',revision:9,archived_at:null}));
let second=false,denyProject=false,denyPlan=false,delayProject=null,delayPlans=null,projectRevision=27;
const plan={id:'33333333-3333-4333-8333-333333333333',name:'Billing plan',origin:'https://billing.example',kind:'website-login',status:'draft',version:1,revision:1,account_hint:'Private account label',own_rights:['view_metadata','manage_metadata']};
await page.addInitScript(value=>{localStorage.setItem('user',JSON.stringify(value));localStorage.setItem('pp-theme','office');},user);
await page.context().addCookies([{name:'pp_csrf',value:'global-connection-fixture',url:origin}]);
await page.route('**/api/**',async route=>{
  const req=route.request(),url=new URL(req.url()),path=url.pathname,method=req.method();calls.push({path,method,search:url.search});
  const answer=async(body,status=200)=>{try{await route.fulfill({status,json:body});}catch(e){if(!String(e.message).includes('Target closed')&&!String(e.message).includes('Request'))throw e;}};
  if(path==='/api/auth/verify')return answer({user:second?{...user,id:'second-fixture'}:user});
  if(path==='/api/auth/login'){second=true;return answer({user:{...user,id:'second-fixture'}});}
  if(path==='/api/operational-projects/capabilities')return answer({enabled:true,ui_available:true,agents_metadata_enabled:true});
  if(path==='/api/operational-projects')return answer({projects:second?[]:url.searchParams.get('after')?projects.slice(6):projects.slice(0,6),next_cursor:second||url.searchParams.get('after')?null:'after6'});
  const project=projects.find(project=>path===`/api/operational-projects/${project.id}`);
  if(project){if(delayProject&&project.id===projects[0].id)await delayProject;if(denyProject&&project.id===projects[0].id)return answer({error:'Access denied'},403);return answer({project:{...project,revision:projectRevision}});}
  if(path.endsWith('/browser-connections/capabilities'))return answer({metadata_available:true,enrollment_available:false,execution_available:false,oauth_authorization_available:false});
  if(path.endsWith('/browser-connections')){
    if(method==='POST'){assert.equal(req.headers()['if-match'],'"27"','fresh project revision rather than list revision');assert.equal(req.headers()['x-csrf-token'],'global-connection-fixture');assert.deepEqual(Object.keys(req.postDataJSON()).sort(),['account_hint','kind','name','origin']);projectRevision++;return answer({connection:{...plan,...req.postDataJSON()}},201);}
    assert.equal(method,'GET');if(delayPlans)await delayPlans;
    return denyPlan?answer({error:'Access denied'},403):answer({connections:second?[]:[plan],next_cursor:null});
  }
  throw new Error(`Unexpected API operation ${method} ${path}`);
});
await page.route('**/global-connections-fixture',async route=>route.fulfill({contentType:'text/html',body:await vite.transformIndexHtml('/global-connections-fixture','<!doctype html><html lang="en"><head><title>Global connections fixture</title></head><body><div id="root"></div><script type="module" src="/tests/global-browser-connections-fixture.jsx"></script></body></html>')}));
const artifacts=process.env.BROWSER_ARTIFACTS;if(artifacts)mkdirSync(artifacts,{recursive:true});
const report={synthetic:true,widths,axe:[],checks:[],lighthouse:[]};
try{
  await page.goto(origin+'/global-connections-fixture');await page.getByLabel('Project',{exact:true}).locator('option').nth(6).waitFor({state:'attached'});
  assert.equal(calls.filter(call=>call.path.endsWith('/browser-connections')).length,0,'no project selection means no private catalogue');
  assert.equal(calls.find(call=>call.path==='/api/operational-projects').search,'?state=all&limit=6');
  await page.getByRole('button',{name:'Load more projects',exact:true}).click();await page.getByLabel('Project',{exact:true}).locator('option').nth(7).waitFor({state:'attached'});
  await page.getByLabel('Project',{exact:true}).selectOption(projects[0].id);await page.getByRole('heading',{name:plan.name,exact:true}).waitFor();
  for(const width of widths){
    await page.setViewportSize({width,height:width<640?812:1080});await page.addStyleTag({content:'html,body{overflow-x:visible!important}'});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth),width);
    const add=page.getByRole('button',{name:'Add connection',exact:true});await add.focus();await page.keyboard.press('Enter');const dialog=page.getByRole('dialog');await dialog.waitFor();
    await dialog.getByLabel('Connection name',{exact:true}).fill('Inert metadata plan');await dialog.getByLabel('Service address',{exact:true}).fill('https://billing.example');
    assert.equal(await dialog.getByLabel(/password|token|secret/i).count(),0);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth),width);
    await dialog.getByRole('button',{name:'Save connection plan',exact:true}).scrollIntoViewIfNeeded();if(artifacts)await page.screenshot({path:`${artifacts}/global-connection-dialog-${width}.png`});
    await page.keyboard.press('Escape');await dialog.waitFor({state:'hidden'});await page.waitForFunction(()=>document.activeElement?.textContent==='Add connection');
    const axe=readFileSync(new URL('../../backend/node_modules/axe-core/axe.min.js',import.meta.url),'utf8');await page.evaluate(axe);const result=await page.evaluate(()=>window.axe.run(document.querySelector('main'),{runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21aa']}}));assert.deepEqual(result.violations.map(v=>v.id),[]);report.axe.push({width,violations:0});
    if(artifacts)await page.screenshot({path:`${artifacts}/global-connections-${width}.png`});
  }
  if(process.env.LIGHTHOUSE_DIR){
    const {pathToFileURL}=await import('node:url'),tools=process.env.LIGHTHOUSE_DIR;
    const {startFlow}=await import(pathToFileURL(`${tools}/node_modules/lighthouse/core/index.js`));const {default:puppeteer}=await import(pathToFileURL(`${tools}/node_modules/puppeteer-core/lib/esm/puppeteer/puppeteer-core.js`));const connection=await puppeteer.connect({browserURL:'http://127.0.0.1:9241'});
    try{await page.setViewportSize({width:375,height:812});const tab=(await connection.pages()).find(tab=>tab.url()===page.url());const flow=await startFlow(tab,{name:'Global connection metadata fixture',config:{extends:'lighthouse:default',settings:{onlyCategories:['accessibility'],formFactor:'mobile',screenEmulation:{disabled:true}}}});await flow.snapshot({name:'global-connections'});const lhr=(await flow.createFlowResult()).steps.at(-1).lhr,score=Math.round(lhr.categories.accessibility.score*100);assert(score>=90);report.lighthouse.push({name:'global-connections',score});if(artifacts)writeFileSync(`${artifacts}/global-connections.lhr.json`,JSON.stringify(lhr,null,2));}finally{connection.disconnect();}
  }
  await page.getByRole('button',{name:'Add connection',exact:true}).click();const dialog=page.getByRole('dialog');await dialog.getByLabel('Connection name',{exact:true}).fill('New plan');await dialog.getByLabel('Service address',{exact:true}).fill('https://billing.example');await dialog.getByRole('button',{name:'Save connection plan',exact:true}).click();await dialog.waitFor({state:'hidden'});await page.getByRole('heading',{name:plan.name,exact:true}).waitFor();
  report.checks.push('Bounded membership project selection, fresh current revision before metadata save, no credential/enrollment/browser operation');
  denyPlan=true;await page.getByRole('button',{name:'Refresh plans',exact:true}).click();await page.getByText(/Private details have been cleared/).waitFor();assert.equal(await page.getByText(plan.account_hint,{exact:false}).count(),0);denyPlan=false;
  await page.getByLabel('Project',{exact:true}).selectOption(projects[1].id);await page.getByRole('heading',{name:plan.name,exact:true}).waitFor();denyProject=true;await page.getByLabel('Project',{exact:true}).selectOption(projects[0].id);await page.getByText(/Project access is no longer available/).waitFor();assert.equal(await page.getByRole('heading',{name:plan.name,exact:true}).count(),0);assert(!await page.getByLabel('Project',{exact:true}).locator('option').allTextContents().then(rows=>rows.includes(projects[0].name)));denyProject=false;
  await page.getByRole('button',{name:'Refresh projects',exact:true}).click();await page.getByLabel('Project',{exact:true}).locator('option').nth(6).waitFor({state:'attached'});
  let release;delayProject=new Promise(resolve=>release=resolve);await page.getByLabel('Project',{exact:true}).selectOption(projects[0].id);await page.getByLabel('Project',{exact:true}).selectOption(projects[1].id);await page.getByRole('heading',{name:projects[1].name,exact:true}).waitFor();release();delayProject=null;await page.waitForTimeout(100);assert.equal(await page.getByRole('heading',{name:projects[0].name,exact:true}).count(),0);
  let releasePlans;delayPlans=new Promise(resolve=>releasePlans=resolve);await page.getByRole('button',{name:'Refresh plans',exact:true}).click();await page.getByRole('button',{name:'Fixture: switch account',exact:true}).evaluate(element=>element.click());await page.getByText(/No permitted projects to show/).waitFor();releasePlans();delayPlans=null;await page.waitForTimeout(100);assert.equal(await page.getByRole('heading',{name:plan.name,exact:true}).count(),0);assert.equal(await page.getByText(plan.account_hint,{exact:false}).count(),0);assert.equal(await page.getByRole('dialog').count(),0);
  report.checks.push('Private plan denial clears records; project denial removes selection; aborted project response and account-switch catalogue response never restore stale private content');
  assert.deepEqual(errors,[]);assert(!calls.some(call=>call.path==='/api/connections'||call.path.includes('/directory')||call.path.includes('/agent-runs')||call.path.includes('/public-browser')));if(artifacts)writeFileSync(`${artifacts}/report.json`,JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{await browser.close();await vite.close();}
