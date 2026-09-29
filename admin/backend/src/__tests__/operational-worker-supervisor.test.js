import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { operationsFixture } from './helpers/operations-fixture.js';
import { WORKER_TARGET, createOperationalWorkerStore, createWorkerLauncher,
  workerInstallResources } from '../lib/operational-worker-boundary.js';
import { createSupervisorClient, createTeardownVerifier } from '../lib/operational-worker-supervisor.js';

const hash = 'a'.repeat(64);
const VM = '49592202-a8b0-45af-9ac6-5439761d73e4';
const BOOT = 'b08210f9-fe81-4e86-9362-926f5ee21e59';
const repo = resolve(fileURLToPath(new URL('../../../../', import.meta.url)));
const spec = () => ({run_id:randomUUID(),attempt_id:randomUUID(),workspace_id:randomUUID(),fence:1,
  policy_digest:hash,project_limits_revision:1,origin:'https://demo.fractionate.ai',target:WORKER_TARGET,
  limits:{},install:workerInstallResources({})});

function fakeSupervisor(handler) {
  const dir = mkdtempSync(join(tmpdir(), 'pp-a3-sock-'));
  const path = join(dir, 'supervisor.sock');
  const seen = [];
  const server = net.createServer(socket => {
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', chunk => {
      buffer += chunk;
      const end = buffer.indexOf('\n');
      if (end < 0) return;
      const request = JSON.parse(buffer.slice(0, end));
      seen.push(request);
      const reply = handler(request);
      if (reply === null) socket.end();
      else socket.end(`${typeof reply === 'string' ? reply : JSON.stringify(reply)}\n`);
    });
  });
  return new Promise(ready => server.listen(path, () => ready({path, seen,
    close: () => new Promise(done => server.close(() => { rmSync(dir, {recursive:true,force:true}); done(); }))})));
}

function signer() {
  const {privateKey, publicKey} = generateKeyPairSync('ed25519');
  const pem = publicKey.export({type:'spki',format:'pem'});
  const keyId = createHash('sha256').update(publicKey.export({type:'spki',format:'der'})).digest('hex');
  const receipt = (fields) => {
    const payload = {v:1,kind:'a3-teardown',vm_uuid:VM,bound_boot_id:BOOT,key_id:keyId,
      descendants_gone:true,workspace_removed:true,reason:'cancelled',evidence:{},...fields};
    const body = Buffer.from(JSON.stringify(payload));
    return {run_id:payload.run_id,attempt_id:payload.attempt_id,fence:payload.fence,descendants_gone:true,
      workspace_removed:true,attestation:`a3r1.${body.toString('base64url')}.${sign(null, body, privateKey).toString('base64url')}`};
  };
  return {pem, receipt};
}

test('supervisor client speaks one typed line per call and maps refusals to codes', async () => {
  const fake = await fakeSupervisor(request => request.method === 'status' ? {ok:true,result:{accepting_launch:true}}
    : request.method === 'renew' ? 'not json' : request.method === 'stop' ? null
      : {ok:false,error:'ACTIVE_ATTEMPT',detail:'x'});
  try {
    const client = createSupervisorClient(fake.path, {timeoutMs:5000});
    assert.deepEqual(await client.request('status', {}), {accepting_launch:true});
    await assert.rejects(client.request('launch', spec()), {code:'ACTIVE_ATTEMPT'});
    await assert.rejects(client.request('renew', {}), {code:'SUPERVISOR_PROTOCOL'});
    await assert.rejects(client.request('stop', {}), {code:'SUPERVISOR_PROTOCOL'});
    // A7: the dashboard takeover is a backend method; operator input and the
    // live relay (a stream, never a one-line request) are not.
    await assert.rejects(client.request('takeover', {}), {code:'ACTIVE_ATTEMPT'});
    await assert.rejects(client.request('input', {}), {code:'METHOD_NOT_ALLOWED'});
    await assert.rejects(client.request('live', {}), {code:'METHOD_NOT_ALLOWED'});
    await assert.rejects(client.stream('launch', {}), {code:'METHOD_NOT_ALLOWED'});
    assert.deepEqual(fake.seen.map(r => r.method), ['status','launch','renew','stop','takeover']);
  } finally { await fake.close(); }
  await assert.rejects(createSupervisorClient('/nonexistent/a3.sock').request('status', {}),
    {code:'SUPERVISOR_UNREACHABLE'});
  assert.throws(() => createSupervisorClient('relative.sock'), {code:'BOUNDARY_UNVERIFIED'});
});

test('launcher fails closed without the supervisor and checks its readback when present', async () => {
  const s = spec();
  await assert.rejects(createWorkerLauncher().launch(s), {code:'BOUNDARY_UNVERIFIED'});
  await assert.rejects(createWorkerLauncher({client:{request:async()=>({})}}).launch(s), {code:'BOUNDARY_UNVERIFIED'});
  await assert.rejects(createWorkerLauncher().stop({run_id:s.run_id,attempt_id:s.attempt_id,fence:1}),
    {code:'BOUNDARY_UNVERIFIED'});
  const calls = [];
  const good = {run_id:s.run_id,attempt_id:s.attempt_id,fence:1,vm_uuid:VM,boot_id:BOOT,
    lease_expires_at:'2026-09-28T00:00:30Z',deadline_at:null,unit:'pp-a3-worker-x'};
  const client = {request: async (method, params) => {
    calls.push([method, params]);
    if (method === 'launch') return good;
    if (method === 'action') return {ordinal:1,result:{at:'landing'},untrusted:true};
    if (method === 'stop') return {receipt:{run_id:s.run_id,attempt_id:s.attempt_id,fence:1,descendants_gone:true,
      workspace_removed:true,attestation:'a3r1.x.y'}};
    return {};
  }};
  const launcher = createWorkerLauncher({client, vmUuid:VM});
  assert.deepEqual(await launcher.launch(s), {vm_uuid:VM,boot_id:BOOT,lease_expires_at:good.lease_expires_at,deadline_at:null});
  assert.deepEqual(calls[0], ['launch', s]);
  const ref = {run_id:s.run_id,attempt_id:s.attempt_id,fence:1};
  assert.equal((await launcher.action({...ref,action:'open_landing'})).untrusted, true);
  await assert.rejects(launcher.action({...ref,action:'open_landing',url:'https://x'}), {code:'INVALID_BROWSER_ACTION'});
  await assert.rejects(launcher.action({...ref,action:'run_shell'}), {code:'INVALID_BROWSER_ACTION'});
  // `taken_over` is a backend stop reason since A7 (dashboard takeover); `proof` stays operator-only.
  await assert.rejects(launcher.stop(ref, 'proof'), {code:'INVALID_STOP'});
  assert.equal((await launcher.stop(ref)).attestation, 'a3r1.x.y');
  assert.deepEqual(calls.at(-1), ['stop', {...ref,reason:'cancelled'}]);
  await assert.rejects(createWorkerLauncher({client:{request:async()=>({...good,vm_uuid:randomUUID()})},vmUuid:VM})
    .launch(s), {code:'SUPERVISOR_PROTOCOL'});
  await assert.rejects(createWorkerLauncher({client:{request:async()=>({...good,fence:2})},vmUuid:VM})
    .launch(s), {code:'SUPERVISOR_PROTOCOL'});
});

test('teardown verifier accepts only a host-signed receipt for the same attempt, VM and boot', () => {
  const {pem, receipt} = signer();
  const verifyTeardown = createTeardownVerifier({publicKeyPem:pem, vmUuid:VM});
  const run = randomUUID(), attempt = randomUUID(), workspace = randomUUID();
  const expected = {run_id:run,attempt_id:attempt,fence:3,workspace_id:workspace,vm_uuid:VM,boot_id:BOOT};
  const good = receipt({run_id:run,attempt_id:attempt,fence:3,workspace_id:workspace});
  assert.equal(verifyTeardown(good, expected), true);
  assert.equal(verifyTeardown(good, {...expected,boot_id:randomUUID()}), false);
  assert.equal(verifyTeardown(good, {...expected,fence:4}), false);
  assert.equal(verifyTeardown(good, {...expected,workspace_id:randomUUID()}), false);
  assert.equal(verifyTeardown({...good,attestation:good.attestation.slice(0,-3)+'AAA'}, expected), false);
  assert.equal(verifyTeardown(receipt({run_id:run,attempt_id:attempt,fence:3,workspace_id:workspace,
    vm_uuid:randomUUID()}), expected), false);
  assert.equal(verifyTeardown(receipt({run_id:run,attempt_id:attempt,fence:3,workspace_id:workspace,
    descendants_gone:false}), expected), false);
  assert.equal(verifyTeardown(signer().receipt({run_id:run,attempt_id:attempt,fence:3,workspace_id:workspace}),
    expected), false);
  // A supervisor that never started the attempt attests exactly that.
  assert.equal(verifyTeardown(receipt({run_id:run,attempt_id:attempt,fence:3,workspace_id:null,
    reason:'launch_refused',evidence:{launched:false}}), {...expected,vm_uuid:null,boot_id:null}), true);
  assert.equal(verifyTeardown(receipt({run_id:run,attempt_id:attempt,fence:3,workspace_id:null}),
    {...expected,vm_uuid:null,boot_id:null}), false);
  assert.throws(() => createTeardownVerifier({publicKeyPem:pem, vmUuid:'x'}), {code:'BOUNDARY_UNVERIFIED'});
});

const python = spawnSync('python3', ['--version']).status === 0 && spawnSync('openssl', ['version']).status === 0;
test('a receipt produced by the host supervisor code verifies with the Node verifier', {skip: !python}, () => {
  const dir = mkdtempSync(join(tmpdir(), 'pp-a3-cross-'));
  try {
    const run = randomUUID(), attempt = randomUUID(), workspace = randomUUID();
    const script = `
import importlib.util, json, subprocess, sys, pathlib
from unittest.mock import patch
spec = importlib.util.spec_from_file_location('s', sys.argv[1]); s = importlib.util.module_from_spec(spec); spec.loader.exec_module(s)
d = pathlib.Path(sys.argv[2]); key, pub = d / 'key.pem', d / 'pub.pem'
subprocess.run(['openssl','genpkey','-algorithm','ed25519','-out',str(key)], check=True)
subprocess.run(['openssl','pkey','-in',str(key),'-pubout','-out',str(pub)], check=True)
with patch.object(s, 'KEY', key), patch.object(s, 'PUBLIC_KEY', pub), patch.object(s.installer, 'secure', lambda p: None):
    sup = s.Supervisor(host=s.Host(), journal=d / 'state.json', runner_source='#')
    attempt = {'run_id': sys.argv[3], 'attempt_id': sys.argv[4], 'fence': 2, 'workspace_id': sys.argv[5],
               'boot_id': '${BOOT}', 'unit': 'pp-a3-worker-' + sys.argv[4], 'actions': []}
    print(json.dumps(sup._receipt(attempt, 'cancelled', {'unit_members': []}, True, True)))
`;
    const out = execFileSync('python3', ['-c', script, join(repo, 'scripts/a3-worker-supervisor.py'), dir, run, attempt,
      workspace]).toString();
    const receipt = JSON.parse(out.trim().split('\n').at(-1));
    const verifyTeardown = createTeardownVerifier({publicKeyPem:readFileSync(join(dir, 'pub.pem'), 'utf8'), vmUuid:VM});
    const expected = {run_id:run,attempt_id:attempt,fence:2,workspace_id:workspace,vm_uuid:VM,boot_id:BOOT};
    assert.equal(verifyTeardown(receipt, expected), true);
    assert.equal(verifyTeardown(receipt, {...expected,attempt_id:randomUUID()}), false);
  } finally { rmSync(dir, {recursive:true,force:true}); }
});

test('store binds the attempt to the supervisor VM and boot and refuses a foreign receipt', () => {
  const f = operationsFixture();
  try {
    const owner = f.addUser(), reviewer = f.addUser();
    const p = f.store.create(owner, {name:'A3 binding'});
    f.store.grant(owner, p.id, reviewer.id, p.revision, {role:'reviewer'});
    f.store.site(owner, p.id, f.store.get(owner, p.id).revision, {site_origin:'https://demo.fractionate.ai'});
    const created = f.store.createProfile(owner, p.id, f.store.get(owner, p.id).revision,
      {display_name:'Synthetic',workflow_type:'synthetic_sign_in',proposed_actions:['navigate','read'],
        proposed_origins:['https://demo.fractionate.ai']}).profile;
    f.store.saveDraft(owner, p.id, 1, {title:'Guide',instructions:'Synthetic only'});
    const submitted = f.store.submit(owner, p.id, 2, {}).submission;
    const version = f.store.review(reviewer, p.id, submitted.id, 1, {decision:'approve'}).version;
    const profile = f.store.assignProfile(owner, p.id, created.id, created.revision, {guide_version_id:version.id}).profile;
    const project = f.store.get(owner, p.id);
    const {pem, receipt} = signer();
    const workers = createOperationalWorkerStore(f.db, () => new Date('2026-09-28T00:00:00Z'), randomUUID,
      createTeardownVerifier({publicKeyPem:pem, vmUuid:VM}));
    const r = workers.prepare({project_id:p.id,profile_id:profile.id,profile_revision:profile.revision,
      site_origin:'https://demo.fractionate.ai',site_revision:project.site_revision,guide_version_id:version.id,
      guide_hash:version.content_hash,policy_digest:hash});
    const a = workers.reserveAttempt(r.run_id);
    assert.throws(() => workers.markRunning(a, {vm_uuid:'x',boot_id:BOOT}), {code:'INVALID_BINDING'});
    workers.markRunning(a, {vm_uuid:VM,boot_id:BOOT});
    const row = f.db.prepare('SELECT vm_uuid,boot_id FROM ops_agent_worker_attempts WHERE id=?').get(a.attempt_id);
    assert.deepEqual({...row}, {vm_uuid:VM,boot_id:BOOT});
    workers.fence(r.run_id);
    const fields = {run_id:r.run_id,attempt_id:a.attempt_id,fence:a.fence,workspace_id:a.workspace_id};
    assert.throws(() => workers.finishStop(r.run_id, 'cancelled', receipt({...fields,bound_boot_id:randomUUID()})),
      {code:'TEARDOWN_UNVERIFIED'});
    workers.finishStop(r.run_id, 'cancelled', receipt(fields));
    assert.equal(f.db.prepare('SELECT state FROM ops_agent_runs WHERE id=?').get(r.run_id).state, 'cancelled');
    assert.throws(() => f.db.prepare("UPDATE ops_agent_worker_attempts SET boot_id='x' WHERE id=?").run(a.attempt_id));
  } finally { f.close(); }
});

test('A6 launcher view returns a bounded PNG frame and nothing else', async () => {
  const s = spec(), ref = {run_id:s.run_id,attempt_id:s.attempt_id,fence:1};
  const png = Buffer.concat([Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]), Buffer.from('frame')]).toString('base64');
  let reply = {png_base64:png,width:1280,height:800};
  const calls = [];
  const launcher = createWorkerLauncher({client:{request:async (method, params) => { calls.push([method, params]); return reply; }},
    vmUuid:VM});
  assert.deepEqual(await launcher.view(ref), {png_base64:png,width:1280,height:800});
  assert.deepEqual(calls, [['view', ref]]);
  await assert.rejects(launcher.view({...ref,url:'https://x'}), {code:'INVALID_VIEW'});
  await assert.rejects(launcher.view({...ref,fence:0}), {code:'INVALID_VIEW'});
  for (const bad of [{...reply,untrusted_page_url:'https://demo.fractionate.ai/'}, {png_base64:Buffer.from('GIF89a..').toString('base64'),width:1,height:1},
    {...reply,width:0}, {...reply,height:5000}, {...reply,png_base64:'not base64!'}, {...reply,png_base64:''},
    {...reply,png_base64:png + 'A'.repeat(3 * 1024 * 1024)}, null]) {
    reply = bad;
    await assert.rejects(launcher.view(ref), {code:'SUPERVISOR_PROTOCOL'});
  }
  await assert.rejects(createWorkerLauncher().view(ref), {code:'BOUNDARY_UNVERIFIED'});
  const fake = await fakeSupervisor(request => ({ok:false,error:request.method === 'view' ? 'VIEW_BUSY' : 'X'}));
  try {
    await assert.rejects(createSupervisorClient(fake.path, {timeoutMs:5000}).request('view', ref), {code:'VIEW_BUSY'});
    assert.deepEqual(fake.seen.map(r => r.method), ['view']);
  } finally { await fake.close(); }
});
