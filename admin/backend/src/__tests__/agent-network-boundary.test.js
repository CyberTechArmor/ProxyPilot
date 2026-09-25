import test from 'node:test';
import assert from 'node:assert/strict';
import { containerAddress, hostsScript, writeHosts, probe, probeScript } from '../lib/setup-engine/agent-network.js';

test('Incus identity and network names are checked before the privileged network read', () => {
  const calls=[];
  const run=(_bin,args)=>{
    calls.push(args);
    return {code:0,stdout:JSON.stringify([{name:'crawler',status:'Running',config:{'volatile.uuid':'u-1'},expanded_devices:{eth0:{network:'-bad','ipv4.address':'10.0.3.20'}}}])};
  };
  assert.throws(()=>containerAddress('crawler',{run}),/no fixed address/);
  assert.equal(calls.length,1);
  assert.throws(()=>containerAddress('-bad',{run}),/by its name/);
  assert.equal(calls.length,1);
});

test('hosts and probes reject shell fragments, overlong names and ports without running Incus', () => {
  const calls=[];const run=(...args)=>{calls.push(args);return {code:0};};
  assert.throws(()=>hostsScript("x'; touch /tmp/bad; '",'10.0.3.1'),/Invalid/);
  assert.throws(()=>hostsScript('a'.repeat(64)+'.example.com','10.0.3.1'),/Invalid/);
  assert.throws(()=>writeHosts('-bad','secure.example.com','10.0.3.1',{run}),/by its name/);
  assert.throws(()=>probeScript("x'; touch /tmp/bad; '",443),/Invalid/);
  assert.throws(()=>probeScript('secure.example.com',0),/Invalid/);
  assert.throws(()=>probe('crawler',[['Proxy','secure.example.com','443']],{run}),/Invalid/);
  assert.deepEqual(calls,[]);
});
