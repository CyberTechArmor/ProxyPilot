import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parseDraft,wrappedSourceText,hasEditableDraftShape,readyForStart,startPayload,approvalPayload,safeBrowserCitation,browserLiveEndpoint,budgetFields,filePayload,verifyPrivateBlob} from '../src/components/operational-projects/browser-agent-ui.js';
const draft=JSON.parse(readFileSync(new URL('../src/components/operational-projects/browser-agent-example.json',import.meta.url)));
const sha='a'.repeat(64), guide={id:'guide-1',content_hash:sha};
const saved={revision:3,configuration_sha256:sha,configuration:{...draft,work:{...draft.work,guide_ref:{id:guide.id,sha256:sha}}}};
const project={revision:8,own_role:'owner',current_version:guide};
const ready={contract_version:'selected-browser.v1',can_start:true,pins:{project_revision:8,configuration_revision:3,configuration_sha256:sha}};
test('paste accepts selected-browser JSON and refuses old demo or malformed/oversized text',()=>{
  assert.deepEqual(parseDraft(JSON.stringify(draft)),draft);assert.deepEqual(parseDraft(JSON.stringify({configuration:draft})),draft);
  assert.equal(wrappedSourceText(JSON.stringify({configuration:draft,source_text:'  Original source — preserved.\n  '})),'  Original source — preserved.\n  ');
  assert.equal(wrappedSourceText(JSON.stringify(draft)),null);
  for(const input of ['{','null','[]',JSON.stringify({workflow:'synthetic_sign_in'}),'x'.repeat(200001)])assert.throws(()=>parseDraft(input));
});
test('partially edited nested JSON remains available without mounting unsafe setting controls',()=>{
  assert.equal(hasEditableDraftShape(draft),true);
  for(const value of [{...draft,artifacts:{upload_asset_refs:[null]}},{...draft,work:{...draft.work,success_criteria:null}},{...draft,destinations:{...draft.destinations,allowed_origins:[null]}},{...draft,budgets:[]}])assert.equal(hasEditableDraftShape(value),false);
});
test('Start requires current server readiness, saved revision/hash, current guide and project authority',()=>{
  assert.equal(readyForStart(ready,saved,project),true);
  for(const r of [{...ready,can_start:false},{...ready,pins:{...ready.pins,project_revision:7}},{...ready,pins:{...ready.pins,configuration_revision:2}},{...ready,pins:{...ready.pins,configuration_sha256:'b'.repeat(64)}}])assert.equal(readyForStart(r,saved,project),false);
  for(const p of [{...project,own_role:'viewer'},{...project,archived_at:'now'},{...project,current_version:{...guide,content_hash:'b'.repeat(64)}}])assert.equal(readyForStart(ready,saved,p),false);
  assert.deepEqual(startPayload(saved,project,'one-key'),{project_revision:8,configuration_revision:3,configuration_sha256:sha,idempotency_key:'one-key'});
});
test('approvals carry the exact action pin and cannot implicitly enlarge policy',()=>{
  const approval={id:'approval-1',state:'pending',action_sha256:sha};
  assert.deepEqual(approvalPayload(approval,{revision:8},'approve'),{decision:'approve',action_sha256:sha});
  for(const decision of ['all','preauthorize','always'])assert.throws(()=>approvalPayload(approval,{},decision));
  assert.throws(()=>approvalPayload({...approval,state:'approved'},{},'approve'));
  assert.throws(()=>approvalPayload({...approval,action_sha256:null},{},'approve'));
});
test('citation links cannot expose credentials or launch executable schemes',()=>{
  assert.equal(safeBrowserCitation('https://example.com/report'),'https://example.com/report');
  for(const url of ['javascript:alert(1)','data:text/html,hello','https://user:secret@example.com/','file:///etc/passwd'])assert.equal(safeBrowserCitation(url),null);
});
test('selected browser live URL cannot use another workflow or arbitrary path',()=>{
  const id='11111111-1111-4111-8111-111111111111',location={protocol:'https:',host:'dashboard.example'};
  assert.equal(browserLiveEndpoint(`/${id}`,id,location),`wss://dashboard.example/api/operational-projects/${id}/browser-agent-runs/${id}/live`);
  assert.throws(()=>browserLiveEndpoint('/../connections',id,location));
});
test('all proposed numeric ceilings match the authoritative schema bounds',()=>{
  const schema=JSON.parse(readFileSync(new URL('../../backend/src/lib/operational-browser-agent-proposal.schema.json',import.meta.url)));
  for(const [key,,min,max]of budgetFields){const field=schema.properties.budgets.properties[key];assert.equal(max,field.maximum,key);assert.ok(min>=(field.minimum??field.exclusiveMinimum),key);}
});
test('file staging validates bounds and hashes bytes without trusting the file name',async()=>{
  const payload=await filePayload(new File(['private fixture'],'secret.txt',{type:'text/plain'}),'key');
  assert.equal(payload.byte_count,15);assert.equal(payload.mime_type,'text/plain');assert.equal(payload.bytes_base64,btoa('private fixture'));assert.match(payload.sha256,/^[a-f0-9]{64}$/);assert.equal('name'in payload,false);
  await assert.rejects(()=>filePayload(null,'key'));await assert.rejects(()=>filePayload({size:16777217},'key'));
});
test('private preview refuses bytes or hashes that do not match the exact artifact pin',async()=>{
  const blob=new Blob(['private fixture']),payload=await filePayload(new File([blob],'fixture.txt',{type:'text/plain'}),'key');
  assert.equal(await verifyPrivateBlob(blob,payload),blob);
  await assert.rejects(()=>verifyPrivateBlob(blob,{...payload,sha256:'b'.repeat(64)}));
  await assert.rejects(()=>verifyPrivateBlob(blob,{...payload,byte_count:1}));
});
test('effect mutations use noReplay and private UI does not persist content in browser storage',()=>{
  const api=readFileSync(new URL('../src/lib/api.js',import.meta.url),'utf8').split('export const browserAgentsApi =')[1].split('// Administrators')[0];
  assert.match(api,/noReplay: true/);
  const ui=readFileSync(new URL('../src/components/operational-projects/BrowserAgents.jsx',import.meta.url),'utf8');
  assert.doesNotMatch(ui,/(?:localStorage|sessionStorage)\.(?:setItem|getItem)|navigator\.clipboard|dangerouslySetInnerHTML/);
  assert.match(ui,/pending_approvals/);assert.match(ui,/Pause execution/);assert.match(ui,/Resume execution/);
});
