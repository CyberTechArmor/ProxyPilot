import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,writeFile,readFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { createApplicationGitTransport } from '../mock2/application-transport.js';

test('production Git transport parses independent refs and never places token in argv or result',async t=>{
 const root=await mkdtemp(join(tmpdir(),'pp-transport-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const token='synthetic-sensitive-token-123456789',sha='a'.repeat(40),argsFile=join(root,'args.json');
 await writeFile(join(root,'git'),`#!/usr/bin/env python3\nimport sys,json,os\njson.dump(sys.argv,open(${JSON.stringify(argsFile)},'w'))\nprint('ref: refs/heads/main\\tHEAD')\nprint('${sha}\\tHEAD')\nprint('${sha}\\trefs/heads/review')\n`,{mode:0o755});
 const host=(cmd,args,options)=>new Promise(resolve=>{const p=execFile(cmd,args,{env:{...process.env,PATH:root+':'+process.env.PATH}},(e,stdout,stderr)=>resolve({code:e?.code||0,stdout,stderr}));p.stdin.end(options.input);});
 const transport=createApplicationGitTransport({host,decryptCredential:()=>token});
 const input={conn:{auth_kind:'token',provider:'gitea',base_url:'https://git.example.test'},gitDir:root,remoteRepo:'team/app',branch:'review'};
 const result=await transport.read(input);assert.equal(result.sha,sha);assert.equal(result.defaultBranch,'main');assert.equal(result.defaultHeadSha,sha);
 assert.equal((await readFile(argsFile,'utf8')).includes(token),false);assert.equal(JSON.stringify(result).includes(token),false);
 await writeFile(join(root,'git'),`#!/usr/bin/env python3\nimport sys\nprint('${token}',file=sys.stderr)\nsys.exit(1)\n`,{mode:0o755});
 const failure=await transport.read(input);assert.equal(failure.ok,false);assert.equal(JSON.stringify(failure).includes(token),false);
});

test('unsupported auth and untrusted remote URL are refused before host execution',async()=>{
 let calls=0;const transport=createApplicationGitTransport({host:()=>{calls++;},decryptCredential:()=> 'synthetic'});
 assert.equal((await transport.read({conn:{auth_kind:'ssh_key'},remoteRepo:'team/app',branch:'main'})).ok,false);
 assert.equal((await transport.read({conn:{auth_kind:'token'},remoteRepo:'https://other.example/app',branch:'main'})).ok,false);
 assert.equal(calls,0);
});
