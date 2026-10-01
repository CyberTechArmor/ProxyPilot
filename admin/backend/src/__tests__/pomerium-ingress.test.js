import test from 'node:test';
import assert from 'node:assert/strict';
import { render } from '../../../../cli/src/core/firewall/render.js';
import { ingressSnapshot, ingressCounterPackets, readIngressGuest, readIngressPeer } from '../lib/setup-engine/pomerium-ingress.js';
import { protectIngress, ensureIngressBootGate, bootCheckIngress, removeIngress } from '../../../../cli/src/core/firewall/ingress.js';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const route = { id:'98d674e8-d11e-4d01-a786-77fd18fbc0c6', lxc_container_name:'nodus',
  target_ip:'10.185.17.240', target_port:3001 };
const instance = { name:'pp-nodus',type:'container',status:'Running',
  config:{'volatile.uuid':'1b30ed7e-55a6-40a1-8677-86df37c561e6','volatile.eth0.hwaddr':'00:16:3e:aa:bb:cc'},
  expanded_devices:{eth0:{type:'nic',network:'incusbr0'}} };
const runtime = { network:{eth0:{addresses:[
  {family:'inet',address:'10.185.17.240',scope:'global'},
  {family:'inet6',address:'fd42:53c1:d5e6:16b0:1266:6aff:fe92:72ae',scope:'global'},
]}}};

test('host fence binds the exact managed guest identity and both address families', () => {
  const entry = ingressSnapshot(instance,runtime,route);
  assert.equal(entry.mac,'00:16:3e:aa:bb:cc');
  const state = {base:[],discovered:[],container_egress:[],protected_upstreams:[entry]};
  const nft = render(state);
  assert.match(nft,/table bridge proxypilot_ingress/);
  assert.match(nft,/hook forward priority -20/);
  assert.match(nft,/hook output priority -20/);
  assert.match(nft,/ether daddr 00:16:3e:aa:bb:cc meta l4proto tcp tcp dport 3001 counter drop/);
  assert.match(nft,/ip daddr 10\.185\.17\.240 tcp dport 3001 counter drop/);
  assert.match(nft,/ip6 daddr fd42:53c1:d5e6:16b0:1266:6aff:fe92:72ae tcp dport 3001 counter drop/);
  assert.match(nft,/meta mark & 0x40000000 == 0 counter drop/);
  assert.match(nft,/type filter hook output priority -20/);
  assert.doesNotMatch(nft,/tcp dport 3000 counter drop/);
});

test('fence review fails closed on guest, address, MAC and IPv6 drift', () => {
  assert.throws(() => ingressSnapshot({...instance,name:'pp-other'},runtime,route),/managed LXC identity/);
  assert.throws(() => ingressSnapshot(instance,{network:{eth0:{addresses:[runtime.network.eth0.addresses[1]]}}},route),/address set changed/);
  assert.throws(() => ingressSnapshot({...instance,config:{'volatile.uuid':instance.config['volatile.uuid']}},runtime,route),/stable MAC/);
  assert.throws(() => ingressSnapshot(instance,{network:{eth0:{addresses:[runtime.network.eth0.addresses[0]]}}},route),/address set changed/);
});

test('Incus CLI raw JSON and HTTP metadata envelopes bind the same guest and distinct peer', async () => {
  const peer = { ...instance, name: 'pp-fractionate-demo' };
  for (const wrap of [value => value, value => ({ metadata: value })]) {
    const run = async (bin, args) => {
      assert.equal(bin, 'incus'); assert.equal(args[0], 'query');
      const value = args[1].endsWith('/state') ? runtime : args[1].endsWith('/pp-nodus') ? instance : peer;
      return { status: 0, stdout: JSON.stringify(wrap(value)) };
    };
    const entry = await readIngressGuest(route, run);
    assert.deepEqual(entry, ingressSnapshot(instance, runtime, route));
    assert.equal((await readIngressPeer(entry, 'fractionate-demo', run)).name, peer.name);
    await assert.rejects(readIngressPeer(entry, 'nodus', run), /distinct managed peer/);
    for (const changed of [{ ...peer, name: 'pp-wrong' }, { ...peer, status: 'Stopped' },
      { ...peer, expanded_devices: { eth0: { type: 'nic', network: 'otherbr0' } } }]) {
      await assert.rejects(readIngressPeer(entry, 'fractionate-demo', async () =>
        ({ status: 0, stdout: JSON.stringify(wrap(changed)) })), /not a running peer/);
    }
  }
  await assert.rejects(readIngressGuest(route, async () => ({ status: 0, stdout: 'null' })), /not running/);
});

test('malformed fence state cannot be rendered into host nftables', () => {
  const entry = ingressSnapshot(instance,runtime,route);
  assert.throws(() => render({base:[],discovered:[],protected_upstreams:[{...entry,bridge:'incusbr0"; flush ruleset'}]}),/invalid protected upstream/);
  assert.throws(() => render({base:[],discovered:[],protected_upstreams:[{...entry,ipv6:'not-ipv6'}]}),/invalid protected upstream/);
});

test('independent proof reads the exact owned drop counter, never an unrelated rule', () => {
  const tag=`pp-ingress-${route.id}`;
  const sample={nftables:[{rule:{chain:'switched',comment:tag,expr:[{counter:{packets:3,bytes:180}},{drop:null}]}},
    {rule:{chain:'switched',comment:'other-route',expr:[{counter:{packets:900,bytes:9000}},{drop:null}]}}]};
  assert.equal(ingressCounterPackets(sample,'switched',tag),3);
  assert.throws(()=>ingressCounterPackets(sample,'protected_upstream_forward',tag),/counter.*missing/);
});

test('ingress installation binds a reviewed UUID/MAC and requires the boot gate before reconcile', async () => {
  const requests = { '/1.0/instances/pp-nodus':instance, '/1.0/instances/pp-nodus/state':runtime };
  const request = async (_verb,path) => ({ metadata: requests[path] });
  let written = null, gate = false, reconciled = false;
  const result = await protectIngress({routeId:route.id,container:'nodus',targetIp:route.target_ip,port:3001,
    expectedUuid:instance.config['volatile.uuid'],expectedMac:instance.config['volatile.eth0.hwaddr']},
  {request,read:()=>({base:[],discovered:[]}),write:s=>{written=s;},bootGate:()=>{gate=true;},auditRecord:()=>{},validate:()=>{},
    apply:async()=>{assert(gate);assert.equal(written.protected_upstreams.length,1);reconciled=true;return {ok:true,applied:true,checksum:'sha256:test'};}});
  assert(reconciled);
  assert.equal(result.entry.ipv6,runtime.network.eth0.addresses[1].address);
  await assert.rejects(protectIngress({routeId:route.id,container:'nodus',targetIp:route.target_ip,port:3001,
    expectedUuid:'ffffffff-ffff-ffff-ffff-ffffffffffff',expectedMac:instance.config['volatile.eth0.hwaddr']},
  {request,read:()=>({base:[],discovered:[]}),write:()=>{throw new Error('must not write');},
    apply:async()=>{throw new Error('must not apply');},auditRecord:()=>{},validate:()=>{},
    bootGate:()=>{throw new Error('must not gate');}}),/identity changed/);
  await assert.rejects(protectIngress({routeId:route.id,container:'nodus',targetIp:route.target_ip,port:3001,
    expectedUuid:instance.config['volatile.uuid'],expectedMac:instance.config['volatile.eth0.hwaddr']},
  {request,read:()=>({base:[],discovered:[]}),validate:()=>{throw new Error('nft syntax rejected');},
    write:()=>{throw new Error('must not write');},bootGate:()=>{throw new Error('must not gate');},
    apply:async()=>{throw new Error('must not apply');},auditRecord:()=>{}}),/nft syntax rejected/);
});

test('Incus boot gate refuses a different drop-in and never restarts a guest', () => {
  const dir=mkdtempSync(join(tmpdir(),'pp-ingress-gate-'));
  const file=join(dir,'proxypilot-ingress.conf');
  try {
    let reloads=0;
    ensureIngressBootGate({dir,file,reload:()=>{reloads++;return {status:0};}});
    assert.match(readFileSync(file,'utf8'),/Requires=proxypilot-firewall-reconcile.service/);
    assert.match(readFileSync(file,'utf8'),/ExecStartPre=.*firewall ingress boot-check/);
    assert.equal(reloads,1);
    writeFileSync(file,'[Unit]\nRequires=other.service\n');
    assert.throws(()=>ensureIngressBootGate({dir,file,reload:()=>{throw new Error('must not run');}}),/differs/);
  } finally { rmSync(dir,{recursive:true,force:true}); }
});

test('Incus boot check fails closed if state or either live table disappears', async () => {
  const entry=ingressSnapshot(instance,runtime,route);
  const read=()=>({protected_upstreams:[entry]});
  const nft=(family)=>({status:0,stdout:family==='bridge'?`ether daddr ${entry.mac} pp-ingress-${entry.route_id}`:
    `ip daddr ${entry.ipv4} ip6 daddr ${entry.ipv6} pp-ingress-${entry.route_id}`});
  assert.equal((await bootCheckIngress({read,nft})).protected_upstreams,1);
  await assert.rejects(bootCheckIngress({read:()=>({protected_upstreams:[]}),nft}),/no recorded/);
  await assert.rejects(bootCheckIngress({read,nft:()=>({status:1,stdout:''})}),/no live nftables/);
});

test('ordered rollback reconciles an exact fence before removing the boot gate', async () => {
  const entry=ingressSnapshot(instance,runtime,route);
  const order=[];
  const result=await removeIngress(route.id,{read:()=>({base:[],discovered:[],protected_upstreams:[entry]}),
    validate:()=>order.push('nft-check'),write:()=>order.push('state-write'),
    apply:async()=>{order.push('reconcile');return {ok:true,applied:true,checksum:'sha256:after'};},
    removeBootGate:()=>order.push('boot-gate-remove'),auditRecord:()=>order.push('audit')});
  assert.deepEqual(order,['nft-check','state-write','reconcile','boot-gate-remove','audit']);
  assert.equal(result.remaining,0);
  await assert.rejects(removeIngress('other-route',{read:()=>({protected_upstreams:[entry]}),
    write:()=>{throw new Error('must not write');},apply:async()=>{throw new Error('must not apply');},
    auditRecord:()=>{},validate:()=>{}}),/no recorded ingress fence/);
});
