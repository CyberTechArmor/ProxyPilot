// Fixture only. The test server serves no backend and blocks external requests.
// Run with BROWSER_TEST_TOOLS pointing to a temporary tools installation that
// contains playwright-core and @axe-core/playwright; no app dependency changes.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdirSync} from 'node:fs';
import {AUTHENTICATION_CONFIRMATION} from '../src/components/operational-projects/browser-authentication-ui.js';
const require=createRequire(`${process.env.BROWSER_TEST_TOOLS||'/tmp/proxypilot-browser-ui-verification'}/package.json`);
const {chromium}=require('playwright-core'),AxeBuilder=require('@axe-core/playwright').default;
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
const context=await browser.newContext(),page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
const fixture=`${process.env.BROWSER_FIXTURE_ORIGIN||'http://127.0.0.1:5177'}/tests/fixtures/browser-agents.html`;
const authEvidence=process.env.BROWSER_AUTH_ARTIFACTS;if(authEvidence)mkdirSync(authEvidence,{recursive:true});
try{
  await page.goto(fixture);
  await page.getByRole('button',{name:'Review settings'}).click();
  await page.getByRole('button',{name:'Check readiness',exact:true}).click();
  assert.equal(await page.getByRole('button',{name:'Start browser run',exact:true}).isDisabled(),true);
  await page.getByRole('button',{name:'Inspect browser run'}).click();
  await page.getByRole('heading',{name:'Human approvals'}).waitFor();
  assert.equal(await page.getByRole('button',{name:'Approve this request'}).isDisabled(),true);
  const widths=[360,375,768,1280,1920],results=[];
  for(const width of widths){await page.setViewportSize({width,height:900});await page.evaluate(()=>{document.documentElement.style.overflowX='visible';document.body.style.overflowX='visible';});
    const measure=await page.evaluate(()=>({width:document.documentElement.clientWidth,scroll:document.documentElement.scrollWidth}));assert.equal(measure.scroll,measure.width,`Overflow at ${width}`);
    const accessibility=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();assert.deepEqual(accessibility.violations.map(v=>({id:v.id,impact:v.impact,nodes:v.nodes.length})),[],`Accessibility at ${width}`);results.push({width,overflow:false,accessibility_violations:0});}
  await page.setViewportSize({width:375,height:900});
  await page.evaluate(()=>window.browserFixtureRejectNext={status:401,body:{error:'sudo_required',sudo_required:true,message:'Verify run authority, then submit explicitly.'}});
  const attemptsBefore=await page.evaluate(()=>window.browserFixtureRequests.filter(r=>r.path.endsWith('/validate')).length);
  await page.getByRole('button',{name:'Validate settings',exact:true}).click();await page.getByRole('alert').getByText(/ELEVATION_REQUIRED/).waitFor();
  assert.equal(await page.getByRole('textbox',{name:'Original instructions',exact:true}).inputValue(),await page.evaluate(()=>window.browserFixtureSource),'A verification challenge retains the local source');
  assert.equal(await page.evaluate(()=>window.browserFixtureRequests.filter(r=>r.path.endsWith('/validate')).length),attemptsBefore+1,'Verification must not replay the rejected mutation');
  await page.getByRole('textbox',{name:'Browser agent name',exact:true}).fill('Edited browser fixture');
  await page.getByRole('button',{name:'Validate settings',exact:true}).click();await page.getByText('Settings validated. Nothing saved or started.').waitFor();
  await page.getByRole('button',{name:'Save browser settings',exact:true}).click();await page.getByText('Settings saved. No run started; review readiness and owner consent.').waitFor();
  assert.equal(await page.evaluate(()=>window.browserFixtureRecord().source_text===window.browserFixtureSource),true);
  await page.getByRole('checkbox',{name:/I reviewed the exact destination, purpose/}).check();
  await page.getByRole('button',{name:'Approve this request'}).click();
  await page.getByText('approvals/').count();
  await page.getByRole('button',{name:'Resume execution',exact:true}).waitFor();
  const approval=await page.evaluate(()=>window.browserFixtureRequests.find(r=>r.path.includes('/decision')));assert.deepEqual(Object.keys(approval.body).sort(),['action_sha256','decision']);assert.equal(approval.body.decision,'approve');assert.equal(approval.headers['If-Match'],'"4"');
  assert.equal(await page.evaluate(()=>window.browserFixtureRequests.some(r=>r.path.endsWith('/start'))),false);
  await page.getByText('Cited private page evidence',{exact:true}).click();await page.getByRole('button',{name:'Check cited page evidence'}).click();await page.getByText(/captured bytes of 10000 original bytes · Truncated observation/).waitFor();await page.getByRole('button',{name:/Open exact cited page evidence/}).click();await page.getByText('Synthetic private review text.',{exact:true}).waitFor();await page.getByRole('button',{name:'Clear cited page preview'}).click();
  await page.getByText('Prepare a draft from instructions, images or files',{exact:true}).click();
  await page.getByRole('button',{name:'Check conversion readiness'}).click();
  await page.getByRole('checkbox',{name:/I reviewed: Send the original instructions/}).check();
  await page.getByRole('button',{name:'Suggest editable draft'}).click();await page.getByRole('button',{name:'Place suggestion in editor for review'}).waitFor();
  const writesBefore=await page.evaluate(()=>window.browserFixtureRequests.filter(r=>r.method!=='GET').length);await page.getByRole('button',{name:'Place suggestion in editor for review'}).click();
  assert.equal(await page.getByRole('textbox',{name:'Browser agent name',exact:true}).inputValue(),'Converted editable suggestion');
  assert.equal(await page.evaluate(()=>window.browserFixtureRequests.filter(r=>r.method!=='GET').length),writesBefore,'Apply must not persist or start');
  await page.evaluate(()=>window.browserFixtureRejectNext={status:403,body:{error:'Project membership revoked'}});
  await page.getByRole('button',{name:'Validate settings',exact:true}).click();await page.getByRole('alert').waitFor();
  assert.equal(await page.getByRole('textbox',{name:'Original instructions',exact:true}).count(),0,'Lost authorization removes private editors');
  assert.equal(await page.getByRole('textbox',{name:'Structured browser settings (JSON)',exact:true}).count(),0);
  await page.goto(`${fixture}?private=1`);await page.getByRole('button',{name:'Review settings'}).click();await page.getByText('Private image and file inputs',{exact:true}).click();await page.getByRole('button',{name:'List private inputs'}).click();
  assert.equal(await page.getByRole('button',{name:'Approve input',exact:true}).isDisabled(),true);
  await page.getByRole('button',{name:'Open exact private input for review'}).click();await page.getByText('Synthetic private review text.',{exact:true}).waitFor();await page.getByRole('checkbox',{name:'I reviewed this private file and approve its use as a browser upload or task input'}).check();await page.getByRole('button',{name:'Approve input',exact:true}).click();
  assert.equal(await page.getByRole('button',{name:'Approve exact input for model disclosure'}).isDisabled(),true,'Use approval cannot imply model disclosure');
  await page.getByRole('checkbox',{name:/I reviewed the exact file for private data/}).check();await page.getByRole('button',{name:'Approve exact input for model disclosure'}).click();await page.getByText('model input: approve · exact file SHA-256 reviewed',{exact:true}).waitFor();
  await page.goto(`${fixture}?approval=input`);await page.getByRole('button',{name:'Inspect browser run'}).click();await page.getByRole('checkbox',{name:/I reviewed the exact destination, purpose/}).check();assert.equal(await page.getByRole('button',{name:'Approve this request'}).isDisabled(),true);await page.getByRole('button',{name:'Open exact proposed text'}).click();await page.getByRole('textbox',{name:'Private proposed form text'}).waitFor();assert.equal(await page.getByRole('textbox',{name:'Private proposed form text'}).inputValue(),'Synthetic private review text.');await page.getByRole('button',{name:'Approve this request'}).click();await page.getByRole('button',{name:'Resume execution',exact:true}).waitFor();
  await page.goto(`${fixture}?transport=live`);await page.getByRole('button',{name:'Inspect browser run'}).click();await page.getByRole('button',{name:'Open live view'}).click();await page.locator('video').waitFor({state:'attached'});await page.evaluate(()=>window.fixtureVideo=document.querySelector('video'));for(let i=0;i<3;i++){await page.getByRole('button',{name:'Open fullscreen selected browser'}).click();await page.locator('[data-selected-browser-fullscreen="true"]').waitFor();await page.keyboard.press('Escape');await page.locator('[data-selected-browser-fullscreen="false"]').waitFor();assert.equal(await page.getByRole('button',{name:'Open fullscreen selected browser'}).evaluate(el=>el===document.activeElement),true);}
  assert.equal(await page.evaluate(()=>window.fixtureVideo===document.querySelector('video')&&window.fixtureLiveConnections===1),true);
  assert.match(await page.evaluate(()=>window.fixtureLiveUrl),/\/browser-agent-runs\/[a-f0-9-]+\/live$/);
  const authRegion=()=>page.getByRole('region',{name:'Authentication readback',exact:true});
  const loadAuth=()=>authRegion().getByRole('button',{name:'Load authentication request evidence',exact:true});
  const confirmAuth=()=>authRegion().getByRole('button',{name:'Confirm selected authentication requests',exact:true});
  const privatePaths=()=>page.getByText(/fixture-private-sign-in|fixture-private-mfa/);
  async function openAuth(query=''){
    await page.goto(`${fixture}?authentication=1${query}`);await page.getByRole('button',{name:'Inspect browser run',exact:true}).click();await authRegion().waitFor();
  }
  async function connectAuth(){await page.getByRole('button',{name:'Open live view',exact:true}).click();await page.getByText('Live viewing connected.',{exact:true}).waitFor();assert.equal(await loadAuth().isDisabled(),false);}
  async function inventoryAuth(){await loadAuth().click();await authRegion().getByText('2 completed authentication-destination requests available. The destination role alone does not prove their purpose.',{exact:true}).waitFor();}
  const authRequestCount=()=>page.evaluate(()=>window.browserFixtureRequests.filter(r=>r.path.endsWith('/authentication-readback')).length);
  const authChecks=[];
  await context.addCookies([{name:'pp_csrf',value:'authentication-fixture-csrf',url:fixture}]);
  await openAuth('&controller=other');assert.equal(await loadAuth().isDisabled(),true);assert.equal(await authRequestCount(),0);
  assert.equal(await page.getByRole('button',{name:'Open live view',exact:true}).isDisabled(),true);assert.equal(await privatePaths().count(),0);authChecks.push('another controller cannot load evidence');
  await openAuth();assert.equal(await loadAuth().isDisabled(),true);assert.equal(await authRequestCount(),0);
  await connectAuth();await inventoryAuth();assert.equal(await confirmAuth().isDisabled(),true);
  const requestChoices=authRegion().getByRole('checkbox',{name:'I reviewed this exact request and verified it was solely for sign-in or MFA.',exact:true});
  const confirmation=authRegion().getByRole('checkbox',{name:AUTHENTICATION_CONFIRMATION,exact:true});
  await requestChoices.nth(0).check();assert.equal(await confirmAuth().isDisabled(),true);await confirmation.check();assert.equal(await confirmAuth().isDisabled(),false);
  await requestChoices.nth(0).uncheck();await requestChoices.nth(1).check();assert.equal(await confirmation.isChecked(),false,'Changing request selection invalidates the confirmation');
  await confirmation.check();await confirmAuth().click();await page.getByText('Selected authentication confirmation recorded. Release and Resume remain explicit.',{exact:true}).waitFor();
  const submittedAuth=await page.evaluate(()=>window.browserFixtureRequests.find(r=>r.path.endsWith('/authentication-readback')&&r.method==='POST'));
  assert.deepEqual(submittedAuth.body,{revision:4,inventory_sha256:'b'.repeat(64),request_refs:[{request_ref:'auth-request-2',binding_sha256:'2'.repeat(64)}],reviewed_statement:AUTHENTICATION_CONFIRMATION});
  assert.equal(submittedAuth.headers['If-Match'],'"4"');assert.equal(submittedAuth.headers['X-CSRF-Token'],'authentication-fixture-csrf');
  assert.equal(await privatePaths().count(),0);assert.equal(await page.evaluate(()=>window.browserFixtureDetail().run.state==='human_control'&&window.browserFixtureDetail().run.manual_auth&&window.fixtureLiveConnections===1),true);
  assert.equal(await page.evaluate(()=>window.browserFixtureRequests.some(r=>r.method!=='GET'&&!r.path.endsWith('/authentication-readback'))),false,'Confirmation never releases, resumes, starts or repeats another effect');
  assert.equal(await page.getByRole('button',{name:'Release browser control',exact:true}).isDisabled(),true,'The other request remains unresolved');authChecks.push('one exact request and full confirmation submitted without release/resume');
  await openAuth();await connectAuth();await inventoryAuth();await page.evaluate(()=>window.browserFixtureChangeRun({revision:5}));
  const readsBeforeRevision=await authRequestCount();await page.getByRole('button',{name:'Refresh run',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('[aria-label="Authentication readback"]')?.textContent.includes('fixture-private-sign-in'));
  assert.equal(await privatePaths().count(),0);assert.equal(await authRequestCount(),readsBeforeRevision,'A revision change clears evidence without reloading privately');authChecks.push('revision change clears inventory and selection');
  await inventoryAuth();await page.evaluate(()=>window.browserFixtureChangeRun({controller_user_id:'99999999-9999-4999-8999-999999999999'},{can_confirm_authentication:false,can_live:false,live_available:false}));
  await page.getByRole('button',{name:'Refresh run',exact:true}).click();await page.waitForFunction(()=>document.querySelector('[aria-label="Authentication readback"] button')?.disabled);
  assert.equal(await privatePaths().count(),0);assert.equal(await loadAuth().isDisabled(),true);authChecks.push('revoked controller authority clears evidence');
  await openAuth();await connectAuth();await inventoryAuth();await page.evaluate(()=>window.browserFixtureLoseViewer());
  await page.waitForFunction(()=>document.querySelector('[aria-label="Authentication readback"] button')?.disabled);assert.equal(await privatePaths().count(),0);assert.equal(await confirmAuth().count(),0);authChecks.push('live viewer loss clears inventory');
  await openAuth('&inventory=stale');await connectAuth();await loadAuth().click();await page.getByRole('alert').filter({hasText:'The browser request evidence changed.'}).waitFor();
  assert.equal(await privatePaths().count(),0);assert.equal(await page.evaluate(()=>window.browserFixtureRequests.filter(r=>r.path.endsWith('/authentication-readback')&&r.method==='POST').length),0);authChecks.push('post-inventory current revision mismatch refuses stale evidence');
  await openAuth();await connectAuth();await page.evaluate(()=>window.fixtureAuthenticationReadbackDelay=true);await loadAuth().click();await page.waitForFunction(()=>!!window.browserFixtureResolveAuthentication);
  await page.evaluate(()=>{window.browserFixtureLoseViewer();window.browserFixtureResolveAuthentication();});
  await page.waitForFunction(()=>document.querySelector('[aria-label="Authentication readback"] button')?.disabled);await page.waitForTimeout(100);
  assert.equal(await privatePaths().count(),0);assert.equal(await confirmAuth().count(),0);authChecks.push('late inventory response after viewer loss remains private and cleared');
  await openAuth();await connectAuth();await inventoryAuth();await page.evaluate(()=>window.browserFixtureRejectAuthentication={status:403,body:{error:{code:'AUTHORIZATION_REVOKED',message:'The current authentication controller was revoked.'}}});
  await loadAuth().click();await page.getByRole('alert').filter({hasText:'AUTHORIZATION_REVOKED'}).waitFor();assert.equal(await authRegion().count(),0);assert.equal(await privatePaths().count(),0);authChecks.push('403 membership loss removes the entire private run editor');
  await openAuth();await connectAuth();await inventoryAuth();const authLayouts=[];
  for(const [width,height]of[[360,640],[375,667],[768,640],[1280,800],[1920,900]]){
    await page.setViewportSize({width,height});await page.evaluate(()=>{document.documentElement.style.overflowX='visible';document.body.style.overflowX='visible';});
    const measured=await page.evaluate(()=>({width:innerWidth,height:innerHeight,documentWidth:document.documentElement.scrollWidth}));assert.equal(measured.documentWidth,width,`Authentication horizontal overflow at ${width}×${height}`);
    await requestChoices.nth(1).scrollIntoViewIfNeeded();await requestChoices.nth(1).check();await confirmation.scrollIntoViewIfNeeded();await confirmation.check();
    await confirmAuth().scrollIntoViewIfNeeded();const box=await confirmAuth().boundingBox();assert.ok(box.y>=0&&box.y+box.height<=height,'Authentication confirmation reachable at the actual viewport height');
    const accessibility=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();assert.deepEqual(accessibility.violations.map(v=>({id:v.id,nodes:v.nodes.length})),[],`Authentication accessibility at ${width}×${height}`);
    authLayouts.push({...measured,horizontal_overflow:false,accessibility_violations:0});
    if(authEvidence)await page.screenshot({path:`${authEvidence}/authentication-${width}x${height}.png`});
  }
  assert.equal(await page.evaluate(()=>JSON.stringify(Object.entries(localStorage)).includes('fixture-private-sign-in')||JSON.stringify(Object.entries(sessionStorage)).includes('auth-request-')),false,'Authentication evidence is never browser-persisted');
  assert.equal(await page.evaluate(()=>window.browserFixtureRequests.filter(r=>r.method!=='GET').length),0,'Review and resizing cause no writes');
  assert.deepEqual(errors,[]);console.log(JSON.stringify({responsive:results,source_preserved:true,approval_exact:true,conversion_requires_review:true,no_implicit_start:true,verification_no_replay:true,authorization_loss_clears_private_ui:true,private_release_separate:true,exact_form_text_review:true,selected_fullscreen_preserves_viewer:true,authentication:{checks:authChecks,layouts:authLayouts,exact_single_request:true,fixed_confirmation:true,revision_and_if_match:true,csrf_echo:true,no_automatic_release_resume:true,private_evidence_not_persisted:true},page_errors:errors},null,2));
}finally{await browser.close();}
