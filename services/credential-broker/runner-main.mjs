import { pathToFileURL } from 'node:url';
import { isAbsolute, resolve, join } from 'node:path';
import { lstatSync, realpathSync } from 'node:fs';
import net from 'node:net';
import { exact, fail } from './schema.mjs';
import { readConfig, privateFile } from './config.mjs';
import { acquireStateLease } from './recovery.mjs';
import { createRunner } from './runner.mjs';
import { createRunnerServer, createWorkloadBrokerClient } from './runner-server.mjs';

export async function startConfiguredRunner(raw) {
  exact(raw,['schema_version','state_dir','listener','broker','dashboard_fingerprints']);
  if(raw.schema_version!==1||typeof raw.state_dir!=='string'||!isAbsolute(raw.state_dir))fail('INVALID_CONFIG');
  const state=lstatSync(raw.state_dir);
  if(!state.isDirectory()||state.uid!==process.getuid()||(state.mode&0o077)||realpathSync(raw.state_dir)!==resolve(raw.state_dir))fail('INVALID_CONFIG');
  exact(raw.listener,['host','port','key_file','cert_file','ca_file']);
  if(!net.isIP(raw.listener.host)||!Number.isInteger(raw.listener.port)||raw.listener.port<1||raw.listener.port>65535)fail('INVALID_CONFIG');
  exact(raw.broker,['agent_origin','ca_file','cert_file','key_file']);
  const material=c=>({ca:privateFile(c.ca_file,{secret:false}),cert:privateFile(c.cert_file,{secret:false}),key:privateFile(c.key_file)});
  const broker=createWorkloadBrokerClient({origin:raw.broker.agent_origin,agentOrigin:raw.broker.agent_origin,...material(raw.broker)});
  let runner,server,timer,lease,closed=false;
  const heartbeat=async()=>{try{await broker.ready();}catch{/* Capability stays unavailable at broker. No task or session is started here. */}};
  const close=async()=>{if(closed)return;closed=true;clearInterval(timer);if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}runner?.close();lease?.close();};
  try {
    lease=acquireStateLease(raw.state_dir);
    runner=createRunner({statePath:join(raw.state_dir,'worker.db'),broker});
    server=createRunnerServer({runner,tls:material(raw.listener),dashboardFingerprints:raw.dashboard_fingerprints});
    await new Promise((res,rej)=>{server.once('error',rej);server.listen(raw.listener.port,raw.listener.host,res);});
    await heartbeat();timer=setInterval(heartbeat,10000);timer.unref();
    return {close,address:server.address()};
  }catch(e){await close();throw e;}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  let runtime;
  try{
    if(process.argv.length!==4||process.argv[2]!=='--config')fail('INVALID_ARGUMENTS');
    runtime=await startConfiguredRunner(readConfig(process.argv[3]));
    const stop=async()=>{try{await runtime.close();process.exit(0);}catch{process.exit(1);}};
    process.once('SIGTERM',stop);process.once('SIGINT',stop);
    process.stdout.write(JSON.stringify({event:'worker_started',contract_version:'runner.v1'})+'\n');
  }catch{process.stderr.write('WORKER_START_FAILED\n');process.exitCode=1;}
}
