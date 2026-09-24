import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

test('selected Caddy agent outage never executes a direct-host fallback',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'pp-agent-outage-'));
 const previous={flag:process.env.PROXYPILOT_USE_AGENT_FOR_CADDY,socket:process.env.PROXYPILOT_AGENT_SOCKET};
 const original=childProcess.exec;let commands=0;
 childProcess.exec=(...args)=>{commands++;args.at(-1)(new Error('forbidden host execution'));};syncBuiltinESMExports();
 process.env.PROXYPILOT_USE_AGENT_FOR_CADDY='true';process.env.PROXYPILOT_AGENT_SOCKET=join(directory,'missing.sock');
 try{
  const configPath=join(directory,'Caddyfile');await writeFile(configPath,':80 { respond "fixture" }');
  const {caddyAdapt,caddyReload}=await import('../lib/caddy-driver.js?security-outage');
  await assert.rejects(caddyAdapt({configPath,timeoutMs:100}),/caddy adapt/);
  await assert.rejects(caddyReload({configPath,timeoutMs:100}),/caddy reload/);
  assert.equal(commands,0,'agent failure reached a direct host-command sink');
 }finally{
  childProcess.exec=original;syncBuiltinESMExports();
  for(const [key,value] of [['PROXYPILOT_USE_AGENT_FOR_CADDY',previous.flag],['PROXYPILOT_AGENT_SOCKET',previous.socket]]){if(value===undefined)delete process.env[key];else process.env[key]=value;}
  await rm(directory,{recursive:true,force:true});
 }
});
