// Real app, providers, API client and MCP page. Only HTTP responses are fixtures;
// actual grant enforcement and migrations run in security-mcp*.test.js.
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {createServer} from 'vite';
import {chromium} from '../../backend/node_modules/playwright-core/index.mjs';
import {MCP_TOOLS} from '../../backend/src/lib/mcp-logic.js';
const root=fileURLToPath(new URL('..',import.meta.url));
process.chdir(root);
const catalog=MCP_TOOLS.map(({name,description})=>({name,description}));
const user={id:'browser-admin',username:'admin',role:'admin',permissions:[]};
const now=new Date().toISOString();
let tokens=[{id:1,name:'Existing connection',scope_json:'{"tools":[]}',scope:{tools:[]},review_required:1,authority_status:'Key revoked or awaiting administrator review',created_at:now,expires_at:null}];
const writes=[];let failCatalog=false;
const server=await createServer({root,configFile:root+'/vite.config.js',server:{host:'127.0.0.1',port:0},plugins:[{
 name:'mcp-browser-fixture',configureServer(vite){vite.middlewares.use(async(req,res,next)=>{
  if(!req.url.startsWith('/api/'))return next();
  const url=new URL(req.url,'http://test');let value={},status=200;
  if(req.method==='POST'){
   let raw='';for await(const part of req)raw+=part;
   const body=JSON.parse(raw);writes.push({path:url.pathname,body,csrf:req.headers['x-csrf-token']});
   if(url.pathname==='/api/mcp-tokens')value={id:2,token:'mcp_test_secret',endpoint:'https://pilot.example.com/api/mcp',connector_url:'https://pilot.example.com/api/mcp/t/mcp_test_secret'};
   else if(url.pathname==='/api/mcp-tokens/1/review'){
    tokens=[{...tokens[0],scope_json:JSON.stringify(body.scope),scope:body.scope,review_required:0,authority_status:'active'}];value={reviewed:true,id:1};
   }else{status=404;value={error:'Unexpected test mutation'};}
  }else if(req.method==='DELETE'){tokens=[];value={revoked:true};}
  else if(url.pathname==='/api/auth/verify')value={user};
  else if(url.pathname==='/api/mcp-tokens/tools'){value=failCatalog?{error:'Catalog unavailable'}:{tools:catalog};status=failCatalog?503:200;}
  else if(url.pathname==='/api/mcp-tokens')value={tokens};
  else if(url.pathname==='/api/user/version')value={version:'browser-test'};
  else if(url.pathname==='/api/user/version/check')value={updateAvailable:false};
  else if(url.pathname==='/api/notifications')value={notifications:[],unread_count:0};
  else if(url.pathname==='/api/mock2/status'){status=404;value={error:'disabled'};}
  res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store','Set-Cookie':'pp_csrf=browser-csrf; Path=/'});res.end(JSON.stringify(value));
 });}
}]});
await server.listen();const origin=`http://127.0.0.1:${server.httpServer.address().port}`;
const executablePath=process.env.BROWSER_EXE;
const browser=await chromium.launch({executablePath,args:process.env.BROWSER_ARGS?JSON.parse(process.env.BROWSER_ARGS):[],headless:true});
const artifacts=process.env.BROWSER_ARTIFACTS;
if(artifacts)mkdirSync(artifacts,{recursive:true});
try{
 const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(({user})=>{localStorage.setItem('user',JSON.stringify(user));localStorage.setItem('lbp-assistant-open','0');localStorage.setItem('mock2HintDismissed','1');},{user});
 await page.goto(origin+'/mcp-access');await page.getByRole('heading',{name:'MCP Access',exact:true}).waitFor();
 const all=page.getByRole('checkbox',{name:'Allow all tools'});
 assert(await all.isChecked());assert(await page.locator('details').getAttribute('open')!==null);
 await page.getByRole('list',{name:'Available MCP tools'}).locator('li').last().waitFor();
 assert.equal(await page.getByRole('list',{name:'Available MCP tools'}).locator('li').count(),catalog.length);
 await page.getByLabel('Search available tools').fill('apply_self_patch');assert.equal(await page.getByRole('list',{name:'Available MCP tools'}).locator('li').count(),catalog.filter(t=>`${t.name} ${t.description}`.toLowerCase().includes('apply_self_patch')).length);
 await page.getByLabel('Search available tools').fill('');
 await page.addStyleTag({content:'html,body,main>div {overflow-x:visible !important}'});
 async function widthCheck(width,label){
  await page.setViewportSize({width,height:900});
  // Wait for the layout's padding transition before measuring.
  await page.locator('main').evaluate(e=>Promise.all(e.getAnimations().map(a=>a.finished)));
  const overflow=await page.locator('main').evaluate(e=>[document.documentElement,e,...e.querySelectorAll('div')].filter(n=>n.clientWidth && n.scrollWidth>n.clientWidth+1 && getComputedStyle(n).overflowX!=='hidden').map(n=>({tag:n.tagName,cls:n.className,width:n.clientWidth,scroll:n.scrollWidth})));
  assert.deepEqual(overflow,[],`${label} overflow at ${width}`);
  if(width<640){for(const button of await page.locator('main button').all()){if(!await button.isVisible())continue;const box=await button.boundingBox();assert(box.height>=44 && box.width>=44,`Small mobile action: ${await button.innerText()}`);}}
  if(artifacts)await page.screenshot({path:`${artifacts}/${label}-${width}.png`});
 }
 for(const width of [360,375,390,768,1280,1920])await widthCheck(width,'all-tools');
 await page.setViewportSize({width:375,height:812});
 await all.uncheck();await page.getByLabel('Custom tools and resources (JSON)').fill('{"tools":["get_settings"]}');
 await page.getByRole('button',{name:'Create token',exact:true}).click();await page.getByText('Token created — shown only once. Store it now.').waitFor();
 assert.deepEqual(writes.at(-1).body.scope,{tools:['get_settings']});assert.equal(writes.at(-1).body.full_access,false);assert.equal(writes.at(-1).csrf,'browser-csrf');
 await page.getByRole('button',{name:'Done — I stored it'}).click();
 // Re-checking all must override even an invalid custom draft.
 await all.uncheck();await page.getByLabel('Custom tools and resources (JSON)').fill('{ invalid');await all.check();
 await page.getByRole('button',{name:'Create token',exact:true}).click();await page.getByText('Token created — shown only once. Store it now.').waitFor();
 assert.deepEqual(writes.at(-1).body.scope,{self_edit:true});assert.equal(writes.at(-1).body.full_access,true);
 await widthCheck(375,'created');
 await page.getByRole('button',{name:'Done — I stored it'}).click();
 await page.getByRole('button',{name:'Restore connection'}).click();assert(!await all.isChecked());
 assert(await page.getByRole('textbox',{name:'Token name',exact:true}).isDisabled());
 await all.check();for(const width of [360,768,1280])await widthCheck(width,'restore');
 await page.getByRole('button',{name:'Save connection'}).click();await page.getByRole('button',{name:'Edit access'}).waitFor();
 assert.equal(writes.at(-1).path,'/api/mcp-tokens/1/review');assert.deepEqual(writes.at(-1).body.scope,{self_edit:true});assert.equal(writes.at(-1).body.review,true);assert.equal(writes.at(-1).body.expires_in_days,0);
 await page.getByRole('button',{name:'Edit access'}).click();assert(await all.isChecked());
 await page.getByRole('button',{name:'Cancel edit'}).click();assert.equal(await page.getByRole('textbox',{name:'Token name',exact:true}).inputValue(),'');
 await page.getByRole('button',{name:'Revoke Existing connection'}).click();await page.getByText('No connections yet. Create a token to connect your MCP client.').waitFor();
 failCatalog=true;await page.reload();await page.getByRole('alert').filter({hasText:'Catalog unavailable'}).waitFor();failCatalog=false;
 assert.deepEqual(errors,[]);
 console.log(`MCP browser regression passed: ${catalog.length} tools, checked defaults, real clicks/payloads, restore, errors and six viewport widths.`);
 if(process.env.LIGHTHOUSE_MODULE){
  const {default:lighthouse}=await import(process.env.LIGHTHOUSE_MODULE);
  // Puppeteer connects to this same browser; fixtures live in the local server.
  // Run against a separate locally launched Chromium via chrome-launcher, supplied by Lighthouse's installation.
  const launcher=await import(new URL('../../chrome-launcher/dist/index.js',process.env.LIGHTHOUSE_MODULE));
  const chrome=await launcher.launch({chromePath:executablePath,chromeFlags:['--headless','--no-sandbox','--disable-dev-shm-usage',...(process.env.BROWSER_ARGS?JSON.parse(process.env.BROWSER_ARGS):[])]});
  try{const result=await lighthouse(origin+'/mcp-access',{port:chrome.port,onlyCategories:['accessibility'],output:'json',logLevel:'error'});const score=result.lhr.categories.accessibility.score;console.log('Lighthouse mobile accessibility:',score);if(artifacts)writeFileSync(artifacts+'/lighthouse.json',result.report);assert(score>=0.90,JSON.stringify(result.lhr.audits));}finally{await chrome.kill();}
 }
}finally{await browser.close();await server.close();}
