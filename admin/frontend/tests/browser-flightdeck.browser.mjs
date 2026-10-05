// Presentation/transport fixture only; no live runner or external website proof.
import assert from 'node:assert/strict';
import {readFileSync,mkdirSync} from 'node:fs';
import {createServer} from 'vite';
import {chromium} from '../../backend/node_modules/playwright-core/index.mjs';
const vite=await createServer({root:new URL('..',import.meta.url).pathname,server:{host:'127.0.0.1',port:0}});await vite.listen();
const origin=`http://127.0.0.1:${vite.httpServer.address().port}`;
const browser=await chromium.launch({executablePath:process.env.BROWSER_EXE||'/tmp/chromium',args:['--no-sandbox']});
const page=await browser.newPage({viewport:{width:1536,height:1024},hasTouch:true}),errors=[];
page.on('pageerror',e=>errors.push(e.message));
const rid='22222222-2222-4222-8222-222222222222',aid='33333333-3333-4333-8333-333333333333';
let state='running',mode='public_navigation',imageRequests=0,starts=0,stops=0,cleanup=false,cleanupBlocked=false,pending=[],decisions=[];
const data=()=>({authorization:{elevated:true,control_verified:true},run:{id:rid,execution_mode:mode,state,revision:1,attempt_id:aid,fence:1,usage:{requests:33,response_bytes:592617},budgets:{max_seconds:300,max_requests:100},started_at:'2026-10-04T10:00:00Z',ended_at:state==='cancelled'?'2026-10-04T10:01:00Z':null},controls:{can_cancel:['running','awaiting_approval'].includes(state),can_live:['running','awaiting_approval'].includes(state),can_approve:pending.length>0},receipts:cleanup?[{closed:{browser:true,network:true,session:true,temporary_files:true}}]:[],uncertainties:cleanupBlocked?[{kind:'CLEANUP_UNVERIFIED',state:'unresolved'}]:[],pending_approvals:pending,report:mode==='agent'?{summary:'Reviewed task result from the bounded fixture.',limitations:['Synthetic provider; no real task acceptance.'],citations:['https://example.com/report']}:null});
await page.addInitScript(()=>{
 localStorage.setItem('pp-theme','office');localStorage.setItem('user',JSON.stringify({id:1,username:'fixture-owner',role:'admin',permissions:[]}));
 // Deliberately stuck signalling exercises the real component fallback deadline.
 const RealWebSocket=window.WebSocket;window.__liveCalls=0;
 const mode=sessionStorage.getItem('live-fixture')||'stuck';
 window.WebSocket=class {constructor(url,protocols){if(!String(url).includes('/api/'))return new RealWebSocket(url,protocols);window.__liveCalls++;if(mode!=='stuck')setTimeout(()=>this.onmessage?.({data:JSON.stringify({type:'ready',viewer:'fixture-viewer',ice_servers:[]})}),10);}readyState=1;close(){this.readyState=3;}send(){}};
 if(mode!=='stuck')window.RTCPeerConnection=class {connectionState='new';constructor(){setTimeout(()=>{this.connectionState='connected';this.onconnectionstatechange?.();if(mode==='decoded'){const canvas=document.createElement('canvas');canvas.width=128;canvas.height=80;const draw=()=>{const ctx=canvas.getContext('2d');ctx.fillStyle='#284a62';ctx.fillRect(0,0,128,80);ctx.fillStyle='#ffffff';ctx.fillText(String(Date.now()),1,40);};draw();this.tick=setInterval(draw,50);this.stream=canvas.captureStream(20);this.ontrack?.({track:this.stream.getVideoTracks()[0],streams:[this.stream]});}},20);}close(){clearInterval(this.tick);this.stream?.getTracks().forEach(t=>t.stop());}};
});
await page.route('**/api/**',async route=>{
 const r=route.request(),u=new URL(r.url()),p=u.pathname;
 const answer=(body,status=200)=>route.fulfill({status,json:body});
 if(p==='/api/services')return answer([]);
 if(p==='/api/auth/verify')return answer({user:{id:1,username:'fixture-owner',role:'admin',permissions:[]}});
 if(p==='/api/operational-projects/capabilities')return answer({enabled:true,ui_available:true,agents_metadata_enabled:true,agent_runs_enabled:true,browser_draft_configuration_available:true,browser_draft_contract:'browser-agent-draft.v1',selected_browser_contract:'selected-browser.v1'});
 const project={id:'11111111-1111-4111-8111-111111111111',name:'Finance operations',description:'Truthful browser fixture',owner_name:'fixture-owner',own_role:'owner',owner_user_id:1,revision:1,visibility:'private',current_version:null};
 if(p==='/api/operational-projects')return answer({projects:[project],next_cursor:null});
 if(p==='/api/operational-projects/'+project.id)return answer({project});
 if(p.endsWith('/draft'))return answer({draft:{title:'Fixture guide',instructions:'Bounded fixture',revision:1,status:'draft',pending_submission:null}});
 if(p.endsWith('/versions'))return answer({versions:[],next_cursor:null});
 if(p.endsWith('/runs'))return answer({runs:[],next_cursor:null});
 if(p.endsWith('/events'))return answer({events:[],next_cursor:null});
 if(p.endsWith('/access'))return answer({members:[]});
 if(p.endsWith('/browser-agent-configurations'))return answer({configurations:[]});
 if(p.endsWith('/browser-agent-runs'))return answer({runs:[data().run]});
 if(p.endsWith('/public-browser')){starts++;return answer(data());}
 if(p.endsWith('/public-frame')){imageRequests++;return answer({attempt_id:aid,fence:1,width:1,height:1,captured_at:'2026-10-04T10:00:05Z',png_base64:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg=='});}
 if(p.endsWith('/decision')){decisions.push(r.postDataJSON());pending=[];state='running';return answer(data());}
 if(p.endsWith('/cancel')){stops++;state='cancelled';cleanup=true;return answer(data());}
 if(p.endsWith('/'+rid))return answer(data());
 return answer({});
});
await page.route('**/flightdeck-test*',async route=>route.fulfill({contentType:'text/html',body:await vite.transformIndexHtml('/flightdeck-test','<!doctype html><html lang="en"><head><title>Browser Flightdeck fixture</title></head><body><div id="root"></div><script type="module" src="/tests/browser-flightdeck-fixture.jsx"></script></body></html>')}));
const artifact=process.env.BROWSER_ARTIFACTS;if(artifact)mkdirSync(artifact,{recursive:true});
try{
 await page.goto(origin+'/flightdeck-test');const deck=page.getByRole('region',{name:'Browser Flightdeck',exact:true});await deck.waitFor();
 await page.getByRole('img',{name:'Current public website in the isolated browser',exact:true}).waitFor({timeout:25000});
 assert(imageRequests>0,'stuck signalling falls back to independent transient images');
 for(const [width,height]of[[360,640],[375,812],[390,844],[768,1000],[1280,1000],[1920,1080]]){
  await page.setViewportSize({width,height});await page.addStyleTag({content:'html,body{overflow-x:visible!important}'});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth),width,`overflow ${width}`);
  if(width>=1024){const columns=await deck.locator('[data-browser-deck-columns]').evaluate(e=>[...e.children].map(c=>c.getBoundingClientRect().width));assert(Math.abs(columns[0]/(columns[0]+columns[1])-0.64)<0.005,'reference 64/36 columns');assert.equal(await deck.locator('[data-browser-deck-title] h2').evaluate(e=>getComputedStyle(e).fontSize),'32px');}
  const stop=deck.getByRole('button',{name:'Stop browser',exact:true}),bounds=await stop.boundingBox();if(width<640)assert(bounds.height>=44);
  const nav=deck.getByRole('navigation',{name:width<1024?'Browser panels':'Run information panels'});
  for(const label of ['Activity','Details','Review']){await nav.getByRole('button',{name:label==='Review'&&pending.length?'Review ('+pending.length+')':label,exact:true}).click();assert.equal(await nav.getByRole('button',{name:label,exact:true}).getAttribute('aria-pressed'),'true');}
  if(width<1024)await nav.getByRole('button',{name:'Browser',exact:true}).click();
  const full=deck.getByRole('button',{name:'Open fullscreen browser'});await full.click();await deck.getByRole('button',{name:'Exit fullscreen browser'}).waitFor();await page.keyboard.press('Escape');await page.waitForFunction(()=>!document.fullscreenElement);await full.waitFor();assert.equal(await full.evaluate(e=>e===document.activeElement),true,'Escape restores fullscreen opener');
  if(artifact)await page.screenshot({path:`${artifact}/flightdeck-${width}.png`,fullPage:true});
 }
 const axe=readFileSync(new URL('../../backend/node_modules/axe-core/axe.min.js',import.meta.url),'utf8');await page.evaluate(axe);
 const violations=await page.evaluate(()=>window.axe.run(document.querySelector('[data-browser-flightdeck]'),{runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21aa']}}));assert.deepEqual(violations.violations.map(v=>v.id),[]);
 const before=imageRequests;await deck.getByRole('button',{name:'Stop browser',exact:true}).click();await deck.getByRole('heading',{name:'Browser session ended'}).waitFor();assert.equal(stops,1);assert.equal(starts,0,'panel/view changes never start a run');assert.equal(await deck.getByRole('img').count(),0);
 await new Promise(r=>setTimeout(r,5500));assert.equal(imageRequests,before,'Stop physically unmounts image polling');
 await deck.getByRole('navigation',{name:'Run information panels'}).getByRole('button',{name:'Review',exact:true}).click();await deck.getByText('temporary files: closed',{exact:false}).waitFor();assert.deepEqual(errors,[]);
 cleanupBlocked=true;await deck.getByRole('button',{name:'Refresh run',exact:true}).click();await deck.getByText('1 review item needs your attention.',{exact:true}).waitFor();assert.equal(await deck.getByText(/request.*held for your review/).count(),0);await deck.getByRole('button',{name:'Retry verified cleanup',exact:true}).waitFor();
 await page.evaluate(()=>sessionStorage.setItem('live-fixture','decoded'));mode='agent';state='awaiting_approval';cleanup=false;cleanupBlocked=false;pending=[{id:'approval-1',kind:'consequential_action',state:'pending',action_sha256:'a'.repeat(64),expires_at:new Date(Date.now()+600000).toISOString(),purpose:'Submit the reviewed form',packet:{operation:{kind:'submit',url:'https://example.com/form'}}}];
 await page.goto(origin+'/flightdeck-test');const selected=page.getByRole('region',{name:'Browser Flightdeck',exact:true});await selected.waitFor();
 await selected.locator('[data-testid="live-browser"][data-live-state="live"]').waitFor();assert.equal(await page.evaluate(()=>window.__liveCalls),1,'selected stream connects without a dropdown or view button');
 await selected.getByRole('button',{name:'Approve this request',exact:true}).waitFor();assert.equal(await selected.getByRole('button',{name:'Approve this request',exact:true}).isDisabled(),true);
 await selected.getByRole('checkbox',{name:/I reviewed the exact destination/}).check();await selected.getByRole('button',{name:'Approve this request',exact:true}).click();await selected.getByText('No requests are waiting for review.',{exact:false}).waitFor();assert.deepEqual(decisions,[{decision:'approve',action_sha256:'a'.repeat(64)}]);
 for(const width of [360,375,390,768,1280,1920]){await page.setViewportSize({width,height:width<640?812:1000});await page.addStyleTag({content:'html,body{overflow-x:visible!important}'});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth),width);const nav=selected.getByRole('navigation',{name:width<1024?'Browser panels':'Run information panels'});await nav.getByRole('button',{name:'Activity',exact:true}).click();await selected.getByText('Reviewed task result from the bounded fixture.',{exact:true}).waitFor();await nav.getByRole('button',{name:'Details',exact:true}).click();await selected.getByText('Run details and evidence',{exact:true}).waitFor();if(artifact)await page.screenshot({path:`${artifact}/selected-flightdeck-${width}.png`,fullPage:true});}
 await page.evaluate(axe);const selectedAxe=await page.evaluate(()=>window.axe.run(document.querySelector('[data-browser-flightdeck]'),{runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21aa']}}));assert.deepEqual(selectedAxe.violations.map(v=>v.id),[]);assert.deepEqual(errors,[]);assert.equal(starts,0);
 mode='public_navigation';state='running';cleanup=false;cleanupBlocked=false;
 await page.evaluate(()=>sessionStorage.setItem('live-fixture','connected'));await page.goto(origin+'/flightdeck-test');
 await page.getByRole('img',{name:'Current public website in the isolated browser',exact:true}).waitFor({timeout:25000});assert.equal(await page.evaluate(()=>window.__liveCalls),1,'connected peer without decoded video gets one bounded fallback');
 await page.evaluate(()=>sessionStorage.setItem('live-fixture','decoded'));await page.goto(origin+'/flightdeck-test');
 const video=page.locator('[data-testid="live-browser"][data-live-state="live"]');await video.waitFor();await new Promise(r=>setTimeout(r,21000));await video.waitFor();
 const decodedDeck=page.getByRole('region',{name:'Browser Flightdeck',exact:true});await decodedDeck.getByRole('navigation',{name:'Run information panels'}).getByRole('button',{name:'Details',exact:true}).click();await decodedDeck.getByRole('button',{name:'Open fullscreen browser'}).click();await page.keyboard.press('Escape');
 await page.evaluate(()=>{window.__originalFullscreen=Element.prototype.requestFullscreen;Element.prototype.requestFullscreen=()=>Promise.reject(new Error('Fixture API refusal'));window.__mountedVideo=document.querySelector('[data-testid="live-browser"] video');});
 await decodedDeck.getByRole('button',{name:'Open fullscreen browser'}).click();await page.locator('[data-browser-flightdeck][data-browser-fullscreen="true"]').waitFor();await page.keyboard.press('Escape');
 assert.equal(await page.evaluate(()=>window.__mountedVideo===document.querySelector('[data-testid="live-browser"] video')),true,'refused native fullscreen fallback retains video node');
 await page.evaluate(()=>{Element.prototype.requestFullscreen=window.__originalFullscreen;});
 assert.equal(await page.evaluate(()=>window.__liveCalls),1,'decoded viewer survives panels and fullscreen past deadline');assert.equal(await page.getByRole('img',{name:'Current public website in the isolated browser',exact:true}).count(),0);await decodedDeck.getByRole('button',{name:'Stop browser',exact:true}).click();await decodedDeck.getByRole('heading',{name:'Browser session ended'}).waitFor();assert.equal(await page.locator('[data-testid="live-browser"]').count(),0);
 state='running';cleanup=false;await page.goto(origin+'/flightdeck-test?integrated=1&section=Agents');
 const integratedDeck=page.getByRole('region',{name:'Browser Flightdeck',exact:true});await integratedDeck.waitFor();
 await page.locator('[data-active-browser-deck="true"]').waitFor();
 for(const width of [360,375,390,768,1280,1920]){
  await page.setViewportSize({width,height:width<640?844:1080});await page.waitForTimeout(200);await page.addStyleTag({content:'html,body{overflow-x:visible!important}'});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth),width,`full shell overflow ${width}`);
  assert.equal(await page.getByRole('navigation',{name:'Operation sections'}).isVisible(),false,'active deck removes project tabs');
  if(width>=1024){const bounds=await integratedDeck.boundingBox(),workspace=await page.locator('[data-project-workspace]').boundingBox();assert(Math.abs(bounds.width-workspace.width)<1,'active deck fills entire post-navigation work area');}
  if(artifact)await page.screenshot({path:`${artifact}/integrated-flightdeck-${width}.png`,fullPage:true});
 }
 // Physical touch events must scroll the surrounding workspace from the video,
 // and from review content, rather than requiring a swipe on the screen edge.
 mode='agent';state='awaiting_approval';pending=[{id:'network-1',kind:'network_effect',state:'pending',action_sha256:'a'.repeat(64),binding_sha256:'a'.repeat(64),body_sha256:'b'.repeat(64),method:'GET',body_bytes:0,no_contact:true,origin:'https://example.com',purpose:'Review this exact GET request',expires_at:new Date(Date.now()+600000).toISOString()}];
 pending.push({...pending[0],id:'network-2',purpose:'Review the second exact request'});await page.setViewportSize({width:390,height:640});await page.goto(origin+'/flightdeck-test?integrated=1');
 const mobileDeck=page.getByRole('region',{name:'Browser Flightdeck',exact:true}),liveBox=mobileDeck.locator('[data-testid="live-browser"][data-live-state="live"]');await liveBox.waitFor();
 assert.equal(await liveBox.evaluate(e=>getComputedStyle(e).touchAction),'pan-y');
 assert.equal(await mobileDeck.locator('[data-browser-information-scroll]').evaluate(e=>getComputedStyle(e).maxHeight),'none');
 assert.equal(await mobileDeck.getByRole('button',{name:'Approve this request',exact:true}).count(),2,'approvals are present below the default stream');
 const scroll=page.locator('[data-selected-project]');const touch=await page.context().newCDPSession(page);
 async function swipeContent(target){
  await target.scrollIntoViewIfNeeded();const bounds=await target.boundingBox(),x=195,y=Math.min(540,Math.max(280,bounds.y+bounds.height/2));
  const before=await scroll.evaluate(e=>e.scrollTop);
  await touch.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y}]});
  for(let i=1;i<=10;i++){await touch.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x,y:y-i*20}]});await page.waitForTimeout(20);}
  await touch.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await page.waitForTimeout(250);
  assert((await scroll.evaluate(e=>e.scrollTop))>before+40,'center content swipe scrolls the workspace');
 }
 await swipeContent(liveBox);
 await mobileDeck.getByRole('navigation',{name:'Browser panels'}).getByRole('button',{name:'Review (2)',exact:true}).click();
 const content=mobileDeck.locator('[data-browser-information-scroll]');
 // Enough real review content to exercise a swipe away from the outer edge.
 await swipeContent(content.locator('article').first().getByText('Destination: https://example.com',{exact:true}));
 await mobileDeck.getByRole('button',{name:'Back to project',exact:true}).waitFor();
 const technical=mobileDeck.getByText('Technical approval details',{exact:true}).first();assert.equal(await technical.locator('..').evaluate(e=>e.open),false,'technical hashes are collapsed after the decision buttons');
 await touch.detach();
 pending=[];mode='public_navigation';state='running';cleanup=false;await page.goto(origin+'/flightdeck-test?integrated=1&section=Agents');await integratedDeck.waitFor();
 assert.equal(await page.evaluate(()=>window.__liveCalls),1,'project workspace expansion preserves one mounted viewer');
 await integratedDeck.getByRole('button',{name:'Stop browser',exact:true}).click();await page.locator('[data-active-browser-deck="false"]').waitFor();
 assert.equal(await page.getByRole('navigation',{name:'Operation sections'}).isVisible(),true,'Stop restores project navigation');
 if(artifact)await page.screenshot({path:`${artifact}/ended-flightdeck.png`,fullPage:true});
 assert.equal(starts,0,'deep link only reads existing run');assert.deepEqual(errors,[]);
 mode='agent';state='running';cleanup=false;await page.evaluate(()=>sessionStorage.setItem('live-fixture','stuck'));await page.goto(origin+'/flightdeck-test');
 const reconnect=page.getByRole('button',{name:'Reconnect browser stream',exact:true});await reconnect.waitFor({timeout:25000});
 assert.equal(await page.evaluate(()=>window.__liveCalls),1);await reconnect.click();await page.waitForFunction(()=>window.__liveCalls===2);assert.equal(starts,0,'stream reconnect never launches or resumes');

 console.log(JSON.stringify({synthetic:true,viewports:[360,375,390,768,1280,1920],imageRequests,starts,stops,accessibility_violations:0,checks:['stuck-video fallback','mounted viewer panels/fullscreen','focus restore','finite metrics','readable signed cleanup','Stop polling cancellation','automatic selected stream','mobile center touch scrolling','frontloaded approval actions','selected stream reconnect without replay']}));
}catch(error){console.error(JSON.stringify({errors,body:await page.locator('body').innerText()}));throw error;}finally{await browser.close();await vite.close();}
