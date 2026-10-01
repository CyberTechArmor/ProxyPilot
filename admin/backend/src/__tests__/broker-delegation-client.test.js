import {test} from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
import {acceptBrokerDelegation,brokerDelegationStatus,clearBrokerDelegation,connectionsApi,brokerTasksApi,api} from '../../../frontend/src/lib/api.js';
test('delegation is transient scoped to broker endpoints, exact user and never retried for task mutation',async()=>{
 const oldFetch=globalThis.fetch,oldDocument=globalThis.document,realNow=Date.now;const user_id=randomUUID(),delegation='x'.repeat(43);let captured=[],status=200;
 globalThis.document={cookie:'pp_csrf=fixture'};globalThis.fetch=async(url,options)=>{captured.push({url,options});return {ok:status===200,status,text:async()=>JSON.stringify(status===200?{}:{error:{code:'AUTH_REQUIRED',message:'Authentication required'}})};};
 try {
 assert.throws(()=>acceptBrokerDelegation({user_id,delegation,expires_at:Date.now()+1000},randomUUID()));
 assert.throws(()=>acceptBrokerDelegation({user_id,delegation,expires_at:Date.now()+310000},user_id));
 const expiry=Date.now()+60000;acceptBrokerDelegation({user_id,delegation,expires_at:expiry},user_id);
 assert.deepEqual(brokerDelegationStatus(),{user_id,expires_at:expiry});
 await connectionsApi.get('/capabilities');assert.equal(captured.at(-1).options.headers['X-Broker-Delegation'],delegation);
 status=401;await assert.rejects(()=>brokerTasksApi.write(randomUUID(),randomUUID(),'',{}));assert.equal(captured.length,2);
 status=200;await api.logout();assert.equal(captured.at(-1).options.headers['X-Broker-Delegation'],undefined);assert.equal(brokerDelegationStatus(),null);
 acceptBrokerDelegation({user_id,delegation,expires_at:expiry},user_id);Date.now=()=>expiry+1;await connectionsApi.get();assert.equal(captured.at(-1).options.headers['X-Broker-Delegation'],undefined);
 }finally{clearBrokerDelegation();globalThis.fetch=oldFetch;globalThis.document=oldDocument;Date.now=realNow;}
});
