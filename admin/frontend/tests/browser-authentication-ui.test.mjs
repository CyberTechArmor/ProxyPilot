import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {AUTHENTICATION_CONFIRMATION,authenticationInventory,authenticationPayload} from '../src/components/operational-projects/browser-authentication-ui.js';

const sha='a'.repeat(64),run={id:'run',attempt_id:'attempt',fence:3};
const request={request_ref:'req-1',binding_sha256:sha,body_sha256:sha,body_bytes:4,role:'authentication',transport_complete:true};
const inventory={revision:6,inventory:{...run,run_id:run.id,inventory_sha256:sha,requests:[request,{...request,request_ref:'req-2'}]}};
test('authentication selection preserves exact inventory and selected bindings without bulk acknowledgement',()=>{
  assert.equal(authenticationInventory(inventory,run),inventory);
  assert.deepEqual(authenticationPayload(inventory,['req-2'],true),{revision:6,inventory_sha256:sha,
    request_refs:[{request_ref:'req-2',binding_sha256:sha}],reviewed_statement:AUTHENTICATION_CONFIRMATION});
  for(const selection of [[],['unknown'],['req-1','req-1']])assert.throws(()=>authenticationPayload(inventory,selection,true));
  assert.throws(()=>authenticationPayload(inventory,['req-1'],false));
});
test('authentication evidence rejects another fence, missing proof and duplicate request references',()=>{
  for(const modified of [{...inventory,revision:0},{...inventory,inventory:{...inventory.inventory,fence:2}},
    {...inventory,inventory:{...inventory.inventory,requests:[request,request]}},
    {...inventory,inventory:{...inventory.inventory,requests:[{...request,role:'navigation'}]}},
    {...inventory,inventory:{...inventory.inventory,requests:[{...request,transport_complete:false}]}},
    {...inventory,inventory:{...inventory.inventory,requests:[{...request,body_bytes:-1}]}}])assert.throws(()=>authenticationInventory(modified,run));
});
test('frontend authentication statement matches the authoritative server contract and private review is ephemeral',()=>{
  const contract=readFileSync(new URL('../../backend/src/lib/operational-selected-browser-auth-contract.js',import.meta.url),'utf8');
  const statement=contract.match(/SELECTED_BROWSER_AUTH_STATEMENT = '([^']+)'/)[1];
  assert.equal(AUTHENTICATION_CONFIRMATION,statement);
  const ui=readFileSync(new URL('../src/components/operational-projects/BrowserAuthenticationReadback.jsx',import.meta.url),'utf8');
  assert.doesNotMatch(ui,/(?:localStorage|sessionStorage)|dangerouslySetInnerHTML|navigator\.clipboard/);
  assert.match(ui,/generation!==epoch\.current/);assert.match(ui,/inventory\.revision!==run\.revision/);
});
