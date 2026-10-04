// Presentation/transport fixture only; no live runner or external website proof.
import assert from 'node:assert/strict';
import {readFileSync,mkdirSync} from 'node:fs';
import {createServer} from 'vite';
import {chromium} from '../../backend/node_modules/playwright-core/index.mjs';
const vite=await createServer({root:new URL('..',import.meta.url).pathname,server:{host:'127.0.0.1',port:0}});await vite.listen();
const origin=`http://127.0.0.1:${vite.httpServer.address().port}`;
const browser=await chromium.launch({executablePath:process.env.BROWSER_EXE||'/tmp/chromium',args:['--no-sandbox']});
const page=await browser.newPage({viewport:{width:1536,height:1024}}),errors=[];
page.on('pageerror',e=>errors.push(e.message));
const rid='22222222-2222-4222-8222-222222222222',aid='33333333-3333-4333-8333-333333333333';
let state='running',imageRequests=0,starts=0,stops=0,cleanup=false,cleanupBlocked=false;
const data=()=>({run:{id:rid,execution_mode:'public_navigation',state,revision:1,attempt_id:aid,fence:1,usage:{requests:33,response_bytes:592617},budgets:{max_seconds:300,max_requests:100},started_at:'2026-10-04T10:00:00Z',ended_at:state==='cancelled'?'2026-10-04T10:01:00Z':null},controls:{can_cancel:state==='running',can_live:state==='running'},receipts:cleanup?[{closed:{browser:true,network:true,session:true,temporary_files:true}}]:[],uncertainties:cleanupBlocked?[{kind:'CLEANUP_UNVERIFIED',state:'unresolved'}]:[]});
await page.addInitScript(()=>{
 localStorage.setItem('pp-theme','office');
 // Deliberately stuck signalling exercises the real component fallback deadline.
 const RealWebSocket=window.WebSocket;window.__liveCalls=0;
 const mode=sessionStorage.getItem('live-fixture')||'stuck';
 window.WebSocket=class {constructor(url,protocols){if(!String(url).includes('/api/'))return new RealWebSocket(url,protocols);window.__liveCalls++;if(mode!=='stuck')setTimeout(()=>this.onmessage?.({data:JSON.stringify({type:'ready',viewer:'fixture-viewer',ice_servers:[]})}),10);}readyState=1;close(){this.readyState=3;}send(){}};
 if(mode!=='stuck')window.RTCPeerConnection=class {connectionState='new';constructor(){setTimeout(()=>{this.connectionState='connected';this.onconnectionstatechange?.();if(mode==='decoded'){const canvas=document.createElement('canvas');canvas.width=128;canvas.height=80;const draw=()=>{const ctx=canvas.getContext('2d');ctx.fillStyle='#284a62';ctx.fillRect(0,0,128,80);ctx.fillStyle='#ffffff';ctx.fillText(String(Date.now()),1,40);};draw();this.tick=setInterval(draw,50);this.stream=canvas.captureStream(20);this.ontrack?.({track:this.stream.getVideoTracks()[0],streams:[this.stream]});}},20);}close(){clearInterval(this.tick);this.stream?.getTracks().forEach(t=>t.stop());}};
});
await page.route('**/api/**',async route=>{
 const r=route.request(),u=new URL(r.url()),p=u.pathname;
 const answer=(body,status=200)=>route.fulfill({status,json:body});
 if(p.endsWith('/browser-agent-configurations'))return answer({configurations:[]});
 if(p.endsWith('/browser-agent-runs'))return answer({runs:[data().run]});
 if(p.endsWith('/public-browser')){starts++;return answer(data());}
 if(p.endsWith('/public-frame')){imageRequests++;return answer({attempt_id:aid,fence:1,width:1,height:1,captured_at:'2026-10-04T10:00:05Z',png_base64:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg=='});}
 if(p.endsWith('/cancel')){stops++;state='cancelled';cleanup=true;return answer(data());}
 if(p.endsWith('/'+rid))return answer(data());
 return answer({});
});
await page.route('**/flightdeck-test',async route=>route.fulfill({contentType:'text/html',body:await vite.transformIndexHtml('/flightdeck-test','<!doctype html><html lang="en"><head><title>Browser Flightdeck fixture</title></head><body><div id="root"></div><script type="module" src="/tests/browser-flightdeck-fixture.jsx"></script></body></html>')}));
const artifact=process.env.BROWSER_ARTIFACTS;if(artifact)mkdirSync(artifact,{recursive:true});
try{
 await page.goto(origin+'/flightdeck-test');const deck=page.getByRole('region',{name:'Browser Flightdeck',exact:true});await deck.waitFor();
 await page.getByRole('img',{name:'Current public website in the isolated browser',exact:true}).waitFor({timeout:25000});
 assert(imageRequests>0,'stuck signalling falls back to independent transient images');
 for(const [width,height]of[[360,640],[375,812],[768,1000],[1280,1000],[1920,1080]]){
  await page.setViewportSize({width,height});await page.addStyleTag({content:'html,body{overflow-x:visible!important}'});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth),width,`overflow ${width}`);
  const stop=deck.getByRole('button',{name:'Stop browser',exact:true}),bounds=await stop.boundingBox();if(width<640)assert(bounds.height>=44);
  const nav=deck.getByRole('navigation',{name:width<1024?'Browser panels':'Run information panels'});
  for(const label of ['Activity','Details','Review']){await nav.getByRole('button',{name:label,exact:true}).click();assert.equal(await nav.getByRole('button',{name:label,exact:true}).getAttribute('aria-pressed'),'true');}
  if(width<1024)await nav.getByRole('button',{name:'Browser',exact:true}).click();
  const full=deck.getByRole('button',{name:'Open fullscreen browser'});await full.click();await deck.getByRole('button',{name:'Exit fullscreen browser'}).waitFor();await page.keyboard.press('Escape');await full.waitFor();assert.equal(await full.evaluate(e=>e===document.activeElement),true,'Escape restores fullscreen opener');
  if(artifact)await page.screenshot({path:`${artifact}/flightdeck-${width}.png`,fullPage:true});
 }
 const axe=readFileSync(new URL('../../backend/node_modules/axe-core/axe.min.js',import.meta.url),'utf8');await page.evaluate(axe);
 const violations=await page.evaluate(()=>window.axe.run(document.querySelector('[data-browser-flightdeck]'),{runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21aa']}}));assert.deepEqual(violations.violations.map(v=>v.id),[]);
 const before=imageRequests;await deck.getByRole('button',{name:'Stop browser',exact:true}).click();await deck.getByRole('heading',{name:'Browser session ended'}).waitFor();assert.equal(stops,1);assert.equal(starts,0,'panel/view changes never start a run');assert.equal(await deck.getByRole('img').count(),0);
 await new Promise(r=>setTimeout(r,5500));assert.equal(imageRequests,before,'Stop physically unmounts image polling');
 await deck.getByRole('navigation',{name:'Run information panels'}).getByRole('button',{name:'Review',exact:true}).click();await deck.getByText('temporary files: closed',{exact:false}).waitFor();assert.deepEqual(errors,[]);
 cleanupBlocked=true;await deck.getByRole('button',{name:'Refresh run',exact:true}).click();await deck.getByText('1 review item needs your attention.',{exact:false}).waitFor();assert.equal(await deck.getByText(/request.*held for your review/).count(),0);await deck.getByRole('button',{name:'Retry verified cleanup',exact:true}).waitFor();
 state='running';cleanup=false;cleanupBlocked=false;
 await page.evaluate(()=>sessionStorage.setItem('live-fixture','connected'));await page.goto(origin+'/flightdeck-test');
 await page.getByRole('img',{name:'Current public website in the isolated browser',exact:true}).waitFor({timeout:25000});assert.equal(await page.evaluate(()=>window.__liveCalls),1,'connected peer without decoded video gets one bounded fallback');
 await page.evaluate(()=>sessionStorage.setItem('live-fixture','decoded'));await page.goto(origin+'/flightdeck-test');
 const video=page.locator('[data-testid="live-browser"][data-live-state="live"]');await video.waitFor();await new Promise(r=>setTimeout(r,21000));await video.waitFor();
 const decodedDeck=page.getByRole('region',{name:'Browser Flightdeck',exact:true});await decodedDeck.getByRole('navigation',{name:'Run information panels'}).getByRole('button',{name:'Details',exact:true}).click();await decodedDeck.getByRole('button',{name:'Open fullscreen browser'}).click();await page.keyboard.press('Escape');
 assert.equal(await page.evaluate(()=>window.__liveCalls),1,'decoded viewer survives panels and fullscreen past deadline');assert.equal(await page.getByRole('img',{name:'Current public website in the isolated browser',exact:true}).count(),0);await decodedDeck.getByRole('button',{name:'Stop browser',exact:true}).click();await decodedDeck.getByRole('heading',{name:'Browser session ended'}).waitFor();assert.equal(await page.locator('[data-testid="live-browser"]').count(),0);
 console.log(JSON.stringify({synthetic:true,viewports:[360,375,768,1280,1920],imageRequests,starts,stops,accessibility_violations:0,checks:['stuck-video fallback','mounted viewer panels/fullscreen','focus restore','finite metrics','readable signed cleanup','Stop polling cancellation']}));
}catch(error){console.error(JSON.stringify({errors,body:await page.locator('body').innerText()}));throw error;}finally{await browser.close();await vite.close();}
