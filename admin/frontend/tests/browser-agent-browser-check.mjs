// Fixture only. The test server serves no backend and blocks external requests.
// Run with BROWSER_TEST_TOOLS pointing to a temporary tools installation that
// contains playwright-core and @axe-core/playwright; no app dependency changes.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(`${process.env.BROWSER_TEST_TOOLS||'/tmp/proxypilot-browser-ui-verification'}/package.json`);
const {chromium}=require('playwright-core'),AxeBuilder=require('@axe-core/playwright').default;
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
const context=await browser.newContext(),page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
const fixture=`${process.env.BROWSER_FIXTURE_ORIGIN||'http://127.0.0.1:5177'}/tests/fixtures/browser-agents.html`;
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
  assert.deepEqual(errors,[]);console.log(JSON.stringify({responsive:results,source_preserved:true,approval_exact:true,conversion_requires_review:true,no_implicit_start:true,verification_no_replay:true,authorization_loss_clears_private_ui:true,private_release_separate:true,exact_form_text_review:true,selected_fullscreen_preserves_viewer:true,page_errors:errors},null,2));
}finally{await browser.close();}
