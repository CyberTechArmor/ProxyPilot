// Mocked metadata fixtures exercise the real page and cookie-session API client.
// No host, model, website or live browser acceptance is claimed.
import assert from 'node:assert/strict';
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {createServer} from 'vite';
import {chromium} from '../../backend/node_modules/playwright-core/index.mjs';
const vite=await createServer({root:new URL('..',import.meta.url).pathname,server:{host:'127.0.0.1',port:0}});vite.middlewares.stack.unshift({route:'/api',handle:(_req,res)=>{res.statusCode=500;res.setHeader('Content-Type','application/json');res.end('{\"error\":\"Unintercepted fixture request\"}');}});await vite.listen();
const origin=`http://127.0.0.1:${vite.httpServer.address().port}`;
const browser=await chromium.launch({executablePath:process.env.BROWSER_EXE||'/tmp/chromium',args:['--no-sandbox','--remote-debugging-port=9240']});
const page=await browser.newPage(),errors=[],requests=[],widths=[360,375,390,768,1280,1920];
const projects=Array.from({length:7},(_,i)=>({id:`00000000-0000-4000-8000-${String(i+1).padStart(12,'0')}`,name:i===0?'Finance operations':i===1?'Purchasing':i===2?'E-commerce operations':`Project ${i+1}`,own_role:i===5?'viewer':'owner',archived_at:i===4?'2026-10-01':null}));
let mode='records',second=false,delayRuns=null;
const user={id:'99999999-9999-4999-8999-999999999999',role:'user'};
const runs=index=>mode==='empty'?[]:[{id:`10000000-0000-4000-8000-${String(index+1).padStart(12,'0')}`,state:['awaiting_approval','cancelled','running','paused','uncertain','completed','failed'][index],execution_mode:index%2?'public_navigation':'agent',configuration_name:index===5?'Read public documentation':undefined,started_at:`2026-10-04T10:0${index}:00Z`,uncertain:index===4,usage:{requests:12+index,actions:index},project_id:projects[index].id}];
await page.addInitScript(()=>localStorage.setItem('pp-theme','office'));
page.on('pageerror',e=>errors.push(e.message));
await page.route('**/api/**',async route=>{
  const answer=async(body,status=200)=>{try{await route.fulfill({status,json:body});}catch(e){if(!String(e.message).includes('Target closed')&&!String(e.message).includes('Request'))throw e;}};
  const request=route.request(),url=new URL(request.url());requests.push({path:url.pathname,search:url.search,method:request.method()});
  if(url.pathname.endsWith('/auth/verify'))return answer({user:second?{...user,id:'second-fixture'}:user});
 if(url.pathname.endsWith('/auth/login')){second=true;return answer({user:{...user,id:'second-fixture'}});}
 assert.equal(request.method(),'GET','overview never starts/effects anything');
  if(url.pathname.endsWith('/capabilities'))return route.fulfill({json:{enabled:mode!=='off',ui_available:true,agents_metadata_enabled:true,agent_runs_enabled:true,selected_browser_contract:'selected-browser.v1'}});
  if(url.pathname.endsWith('/operational-projects'))return route.fulfill({json:{projects:second?[]:url.searchParams.get('after')?projects.slice(6):projects.slice(0,6),next_cursor:second||url.searchParams.get('after')?null:'after6'}});
  const index=projects.findIndex(project=>url.pathname.includes(project.id));
  if(index>=0&&url.pathname.endsWith('/browser-agent-runs')){const reply=runs(index);if(delayRuns)await delayRuns;return answer(mode==='denied'&&index===0?{error:'Not permitted'}:{runs:reply},mode==='denied'&&index===0?403:200);}
  throw new Error(`Unexpected API path ${url.pathname}`);
});
await page.route('**/sessions-fixture',async route=>route.fulfill({contentType:'text/html',body:await vite.transformIndexHtml('/sessions-fixture','<!doctype html><html lang="en"><head><title>Agents overview fixture</title></head><body><div id="root"></div><script type="module" src="/tests/browser-sessions-fixture.jsx"></script></body></html>')}));
const artifact=process.env.BROWSER_ARTIFACTS;if(artifact)mkdirSync(artifact,{recursive:true});
const report={synthetic:true,widths,checks:[],accessibility:[]};
try {
  await page.goto(origin+'/sessions-fixture');await page.locator('[data-session-card]').nth(5).waitFor();await page.getByRole('heading',{name:'Read public documentation',exact:true}).waitFor();
  assert.equal(requests.filter(request=>request.path.endsWith('/browser-agent-runs')).length,6);
  assert.equal(requests.filter(request=>request.path.includes('/live')||request.path.includes('/public-frame')).length,0);
  for(const width of widths){
    await page.setViewportSize({width,height:width<640?812:1080});await page.addStyleTag({content:'html,body{overflow-x:visible!important}'});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth),width,`overflow at ${width}`);
    const cards=page.locator('[data-session-card]'),a=await cards.nth(0).boundingBox(),b=await cards.nth(1).boundingBox();
    assert.equal(Math.abs(a.y-b.y)<2,width>=1280,'two-column overview at desktop width');
    const start=page.getByRole('button',{name:'Start task',exact:true});assert((await start.boundingBox()).height>=44);
    await start.focus();assert.equal(await start.evaluate(element=>element===document.activeElement),true);await page.keyboard.press('Enter');
    const dialog=page.getByRole('dialog');await dialog.waitFor();await dialog.getByLabel('Project',{exact:true}).selectOption(projects[0].id);
    const options=await dialog.getByLabel('Project',{exact:true}).locator('option').allTextContents();assert(!options.includes(projects[4].name));assert(!options.includes(projects[5].name));
    await dialog.getByRole('link',{name:'Continue to task setup',exact:true}).waitFor();if(artifact&&width===375)await page.screenshot({path:`${artifact}/sessions-start-task-375.png`});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth),width);
    await page.keyboard.press('Escape');await dialog.waitFor({state:'hidden'});assert.equal(await start.evaluate(element=>element===document.activeElement),true);
    if(artifact)await page.screenshot({path:`${artifact}/sessions-${width}.png`});
    const axe=readFileSync(new URL('../../backend/node_modules/axe-core/axe.min.js',import.meta.url),'utf8');await page.evaluate(axe);
    const result=await page.evaluate(()=>window.axe.run(document.querySelector('main'),{runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21aa']}}));
    assert.deepEqual(result.violations.map(violation=>violation.id),[],`axe ${width}`);report.accessibility.push({width,violations:0});
  }
  if(process.env.LIGHTHOUSE_DIR){
    const {pathToFileURL}=await import('node:url');
    const root=process.env.LIGHTHOUSE_DIR;
    const {startFlow}=await import(pathToFileURL(`${root}/node_modules/lighthouse/core/index.js`));
    const {default:puppeteer}=await import(pathToFileURL(`${root}/node_modules/puppeteer-core/lib/esm/puppeteer/puppeteer-core.js`));
    const connection=await puppeteer.connect({browserURL:'http://127.0.0.1:9240'});
    try{
      await page.setViewportSize({width:375,height:812});
      const tabs=await connection.pages(),tab=tabs.find(tab=>tab.url()===page.url());assert(tab);
      const flow=await startFlow(tab,{name:'Agents overview metadata fixture',config:{extends:'lighthouse:default',settings:{onlyCategories:['accessibility'],formFactor:'mobile',screenEmulation:{disabled:true}}}});
      report.lighthouse=[];
      for(const name of ['overview','start-task']){
        if(name==='start-task')await page.getByRole('button',{name:'Start task',exact:true}).click();
        await flow.snapshot({name});
        const result=await flow.createFlowResult(),lhr=result.steps.at(-1).lhr,score=Math.round(lhr.categories.accessibility.score*100);
        report.lighthouse.push({name,score});assert(score>=90,`mobile Lighthouse ${name}: ${score}`);
        if(artifact)writeFileSync(`${artifact}/${name}.lhr.json`,JSON.stringify(lhr,null,2));
      }
      await page.keyboard.press('Escape');await page.getByRole('dialog').waitFor({state:'hidden'});
    }finally{connection.disconnect();}
  }
  const nav=page.getByRole('navigation',{name:'Filter agent sessions'});
  await nav.getByRole('button',{name:/^Needs help\s*2$/,exact:true}).click();assert.equal(await page.locator('[data-session-card]').count(),2);
  await nav.getByRole('button',{name:/^Paused\s*1$/,exact:true}).focus();await page.keyboard.press('Enter');assert.equal(await page.locator('[data-session-card]').count(),1);
  await nav.getByRole('button',{name:/^All\s*6$/,exact:true}).click();
  await page.getByRole('button',{name:'Load more projects and sessions',exact:true}).click();await page.locator('[data-session-card]').nth(6).waitFor();
  assert.equal(requests.filter(request=>request.path.endsWith('/browser-agent-runs')).length,7);
  assert.equal(await page.getByRole('button',{name:'Load more projects and sessions',exact:true}).count(),0);
  report.checks.push('Six-project explicit batching, no live transports/effects, scoped counts, filters and seven-record pagination');
  const href=await page.locator('[data-session-card]').first().getAttribute('href');assert(href.includes('browser_run='));assert(href.includes('section=Agents'));
  mode='denied';await page.getByRole('button',{name:'Refresh sessions',exact:true}).click();await page.getByText(/1 loaded project has unavailable run records/).waitFor();assert.equal(await page.getByRole('heading',{name:'Browser task',exact:true}).count(),2);
  mode='empty';await page.getByRole('button',{name:'Refresh sessions',exact:true}).click();await page.getByRole('heading',{name:'No browser sessions in loaded projects'}).waitFor();
  mode='off';await page.getByRole('button',{name:'Refresh sessions',exact:true}).click();await page.getByText(/Browser sessions are unavailable/).waitFor();assert.equal(await page.locator('[data-session-card]').count(),0);assert.equal(await page.getByRole('button',{name:'Start task',exact:true}).isDisabled(),true);
  report.checks.push('Permission refusal discards prior rows, truthful empty/disabled capabilities, Escape focus restoration');
  mode='records';await page.getByRole('button',{name:'Refresh sessions',exact:true}).click();await page.locator('[data-session-card]').nth(5).waitFor();
  let releaseRuns;delayRuns=new Promise(resolve=>releaseRuns=resolve);const started=page.waitForRequest(request=>request.url().includes('/browser-agent-runs'));
  await page.getByRole('button',{name:'Refresh sessions',exact:true}).click();await started;
  await page.getByRole('button',{name:'Fixture: switch account',exact:true}).evaluate(element=>element.click());await page.getByRole('heading',{name:'No browser sessions in loaded projects',exact:true}).waitFor();
  releaseRuns();delayRuns=null;await page.waitForTimeout(100);assert.equal(await page.locator('[data-session-card]').count(),0);assert.equal(await page.getByText('Finance operations',{exact:true}).count(),0);
  report.checks.push('Account and authority change aborts returning run batches and clears prior permitted project metadata');

  assert.deepEqual(errors,[]);
  if(artifact)writeFileSync(`${artifact}/report.json`,JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{await browser.close();await vite.close();}
