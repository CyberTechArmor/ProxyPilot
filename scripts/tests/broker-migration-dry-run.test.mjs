import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dryRun } from '../broker-migration-dry-run.mjs';
const id='11111111-1111-4111-8111-111111111111';
const row=()=>({source_kind:'infisical',source_identity_id:id,source_credential_name:'SYNTHETIC_KEY',source_version:1,
  consumer_id:id,owner_id:id,ops_project_id:id,target_connection_id:id,target_credential_id:id,target_adapter:'synthetic-ledger-v1',
  operations:['item.read'],resources:[id],legacy_network_link:null,host_pattern:'fixture.invalid',surfaces:['header'],reviewed_mapping:true});
const manifest=(r=row())=>({version:1,credentials:[r]});
test('explicit synthetic metadata mapping grants no transfer authority',()=>{
 const out=dryRun(manifest());assert.equal(out.summary.mappable,1);assert.equal(out.source_accessed,false);assert.equal(out.target_accessed,false);assert.equal(out.transfer_authorized,false);
});
test('unsupported substitution cannot be silently broadened',()=>{
 for(const change of [{host_pattern:'*.example.com'},{surfaces:['body']},{reviewed_mapping:false},{resources:[]}])
  assert.equal(dryRun(manifest({...row(),...change})).rows[0].disposition,'unsupported');
});
test('missing identity and version remain explicit blockers',()=>{
 for(const [change,expected] of [[{owner_id:null},'owner_required'],[{consumer_id:null},'consumer_required'],[{source_version:null},'blocked']])
  assert.equal(dryRun(manifest({...row(),...change})).rows[0].disposition,expected);
});
test('unknown fields including values, token and hashes refused',()=>{
 for(const field of ['value','token','secret_value','source_hash','unexpected']) assert.throws(()=>dryRun(manifest({...row(),[field]:'canary-do-not-print'})));
 assert.throws(()=>dryRun(manifest({...row(),legacy_network_link:{container_uuid:id,ip:'127.0.0.1',value:'canary'}})));
 assert.throws(()=>dryRun({version:1,credentials:[row(),row()]}));
});
test('CLI refuses malformed/secret manifests without printing their contents',()=>{
 const canary='synthetic-value-not-for-output';
 for(const input of ['{'+canary,JSON.stringify(manifest({...row(),value:canary}))]) {
  const result=spawnSync(process.execPath,['scripts/broker-migration-dry-run.mjs'],{input,encoding:'utf8'});
  assert.equal(result.status,1);assert.equal(result.stdout,'');assert.ok(!result.stderr.includes(canary));
 }
});
