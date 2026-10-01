import {test} from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,copyFileSync,writeFileSync,readFileSync,symlinkSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join,dirname} from 'node:path';import {createRequire} from 'node:module';import {execFileSync} from 'node:child_process';
test('configured worker client loads in Docker backend-only layout without standalone services',()=>{
 const dir=mkdtempSync(join(tmpdir(),'broker-docker-layout-'));
 try{
 const backend=join(dir,'app/backend'),lib=join(backend,'src/lib');mkdirSync(lib,{recursive:true});writeFileSync(join(backend,'package.json'),'{"type":"module"}');
 for(const name of ['credential-broker-remote.js','credential-broker-runner-client.js'])copyFileSync(new URL('../lib/'+name,import.meta.url),join(lib,name));
 const require=createRequire(import.meta.url),zodDir=dirname(require.resolve('zod/package.json'));mkdirSync(join(backend,'node_modules'));symlinkSync(zodDir,join(backend,'node_modules/zod'),'dir');
 const key=join(dir,'client.key'),cert=join(dir,'client.cert');execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=fixture','-keyout',key,'-out',cert],{stdio:'ignore'});
 const config=join(dir,'worker.json');writeFileSync(config,JSON.stringify({version:1,origin:'https://worker.example',ca_file:cert,cert_file:cert,key_file:key}),{mode:0o600});
 const script=join(backend,'smoke.mjs');writeFileSync(script,`import assert from 'node:assert/strict';import {configuredBrokerWorker} from './src/lib/credential-broker-remote.js';const worker=await configuredBrokerWorker({FRACTIONATE_BROKER_WORKER_CONFIG_FILE:process.argv[2]});assert.ok(worker);for(const key of ['startTask','checkTask','status','cancelTask','continueTask'])assert.equal(typeof worker[key],'function');`);
 execFileSync(process.execPath,[script,config],{stdio:'pipe'});assert.equal(existsSync(join(dir,'services')),false);assert.equal(existsSync(join(dir,'app/services')),false);
 const docker=readFileSync(new URL('../../../Dockerfile',import.meta.url),'utf8');assert.match(docker,/COPY admin\/backend\/src \.\/backend\/src/);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
