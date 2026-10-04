// Actual Operations route, scripted UI responses; backend suite proves custody.
import assert from 'node:assert/strict';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {createServer} from 'vite';
import {pathToFileURL} from 'node:url';
import {chromium} from '../../backend/node_modules/playwright-core/index.mjs';
const vite=await createServer({root:new URL('..',import.meta.url).pathname,server:{host:'127.0.0.1',port:0},logLevel:'error'});await vite.listen();
const origin=`http://127.0.0.1:${vite.httpServer.address().port}`,browser=await chromium.launch({executablePath:process.env.BROWSER_EXE||'/tmp/chromium',args:['--no-sandbox',...(process.env.LIGHTHOUSE_DIR?['--remote-debugging-port=9257']:[])]}),page=await browser.newPage();page.setDefaultTimeout(30000);
const errors=[],calls=[],widths=[360,375,390,768,1280,1920];page.on('pageerror',e=>errors.push(e.message));
const user={id:'11111111-1111-4111-8111-111111111111',username:'Synthetic administrator',role:'admin',hasPasskey:false},toggles=[{name:'operations',label:'Operations',description:'Private projects',requires:[],stored:false,effective:false,blocked_by:[],last_change:null}];
let storage={managed:true,state:'not_configured',can_setup:true,quota_bytes:268435456},elevated=false,refusal=false,unavailableResponse=false;
await page.context().addCookies([{name:'pp_csrf',value:'source-memory-fixture',url:origin}]);
await page.route('**/api/**',async route=>{const req=route.request(),path=new URL(req.url()).pathname,method=req.method();calls.push({path,method});const answer=(json,status=200)=>route.fulfill({status,json});
 if(path==='/api/auth/verify'||path==='/api/user/profile')return answer({user});
 if(path==='/api/auth/sudo'){elevated=true;return answer({success:true});}
 if(path==='/api/operational-projects/capabilities')return answer({enabled:false,ui_available:false,agents_metadata_enabled:false,can_manage_settings:true});
 if(path==='/api/operations-settings')return answer({toggles,source_memory:storage});
 if(path==='/api/operations-settings/source-memory'){assert.equal(method,'POST');assert(elevated);assert.equal(req.headers()['x-csrf-token'],'source-memory-fixture');assert.deepEqual(req.postDataJSON(),{});if(refusal)return answer({error:'Private storage custody changed. Owner review required.'},409);storage=unavailableResponse?{...storage,state:'unavailable',can_setup:false,message:'Private storage is unavailable. Owner review required.'}:{...storage,state:'reload_required',can_setup:false};return answer({toggles,source_memory:storage});}
 return answer({notifications:[],unread_count:0,settings:{},canReauthenticate:false,status:'ok'});
});
const artifacts=process.env.BROWSER_ARTIFACTS;if(artifacts)mkdirSync(artifacts,{recursive:true});const report={synthetic:true,widths,layout:[],axe:[],lighthouse:[],checks:[]};
const setup=()=>page.getByRole('button',{name:'Review and enable local Source Memory',exact:true}),panel=()=>page.getByRole('region',{name:'Source Memory setup',exact:true}),writes=()=>calls.filter(c=>c.path.endsWith('/source-memory'));
async function lighthouse(name){
 if(!process.env.LIGHTHOUSE_DIR)return;
 const directory=process.env.LIGHTHOUSE_DIR,{startFlow}=await import(pathToFileURL(`${directory}/node_modules/lighthouse/core/index.js`)),{default:puppeteer}=await import(pathToFileURL(`${directory}/node_modules/puppeteer-core/lib/esm/puppeteer/puppeteer-core.js`));
 await page.setViewportSize({width:375,height:900});const connection=await puppeteer.connect({browserURL:'http://127.0.0.1:9257',defaultViewport:null});
 try{const tab=(await connection.pages()).find(tab=>tab.url()===page.url()),flow=await startFlow(tab,{name,config:{extends:'lighthouse:default',settings:{onlyCategories:['accessibility'],formFactor:'mobile',screenEmulation:{disabled:true}}}});await flow.snapshot({name});const lhr=(await flow.createFlowResult()).steps.at(-1).lhr,score=Math.round(lhr.categories.accessibility.score*100);assert(score>=90);report.lighthouse.push({name,score});if(artifacts)writeFileSync(`${artifacts}/${name}.lhr.json`,JSON.stringify(lhr,null,2));}finally{connection.disconnect();}
}
async function sudo(){const d=page.getByRole('dialog');await d.getByLabel('Password',{exact:true}).fill('disposable-password');await d.getByLabel('Authenticator Code').fill('123456');await d.locator('button[type=submit]').click();await d.waitFor({state:'hidden'});}
try{
 await page.goto(origin+'/operational-projects');await page.locator('summary').filter({hasText:'Operations settings'}).click();await setup().waitFor();
 for(const width of widths){await page.setViewportSize({width,height:width<640?900:1080});await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));await page.addStyleTag({content:'html,body{overflow-x:visible!important}'});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth),width);const box=await setup().boundingBox();assert(box.height>=44&&box.width>=44,JSON.stringify({width,box}));await page.evaluate(readFileSync(new URL('../../backend/node_modules/axe-core/axe.min.js',import.meta.url),'utf8'));const axe=await page.evaluate(()=>window.axe.run(document.querySelector('main'),{runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21aa']}}));assert.deepEqual(axe.violations.map(v=>v.id),[]);report.axe.push({width,violations:0});report.layout.push({width,state:'explicit-review',height:box.height});if(artifacts)await panel().screenshot({path:`${artifacts}/source-memory-review-${width}.png`});}
 await lighthouse('source-memory-review');
 assert.equal(writes().length,0);await setup().click();await page.getByRole('dialog').waitFor();assert.equal(writes().length,0);await page.keyboard.press('Escape');await page.getByRole('dialog').waitFor({state:'hidden'});assert.equal(writes().length,0);
 await setup().click();await sudo();await panel().getByText('Verified · owner backend restart required before Source Memory is available.',{exact:true}).waitFor();assert.equal(await setup().count(),0);assert.equal(writes().length,1);
 for(const width of widths){await page.setViewportSize({width,height:width<640?900:1080});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth),width);if(artifacts)await panel().screenshot({path:`${artifacts}/source-memory-pending-${width}.png`});}
 await lighthouse('source-memory-pending');
 report.checks.push('Cancel before fresh sudo writes nothing; explicit empty CSRF write occurs once; verified storage stays pending owner reload');
 storage={managed:true,state:'not_configured',can_setup:true,quota_bytes:268435456};refusal=true;await page.reload();await page.locator('summary').filter({hasText:'Operations settings'}).click();await setup().click();await sudo();await page.getByRole('alert').filter({hasText:'custody changed'}).waitFor();assert.equal(writes().length,2);assert.equal(await panel().getByText('Available · private storage is active.',{exact:true}).count(),0);
 storage={managed:true,state:'not_configured',can_setup:true,quota_bytes:268435456};refusal=false;unavailableResponse=true;await page.reload();await page.locator('summary').filter({hasText:'Operations settings'}).click();await setup().click();await sudo();await panel().getByText('Private storage is unavailable. Owner review required.',{exact:true}).waitFor();assert.equal(writes().length,3);assert.equal(await page.getByRole('status').filter({hasText:'Private storage verified'}).count(),0);
 assert(!calls.some(c=>/consent|agent-runs|browser-runtime|version\/update/.test(c.path)));assert.deepEqual(errors,[]);report.checks.push('Custody refusal has no replay, consent, run, update or restart request');if(artifacts)writeFileSync(`${artifacts}/report.json`,JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{await browser.close();await vite.close();}
