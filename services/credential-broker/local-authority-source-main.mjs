#!/usr/bin/env node
import http from 'node:http';
import {chmodSync,lstatSync,unlinkSync,realpathSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {privateFile,readConfig} from './config.mjs';
import {exact,parseJson,fail,safeError,BrokerError} from './schema.mjs';
import {createLocalAuthoritySource,readBrokerFacts,openReadonlyDatabase} from './local-authority-source.mjs';
import {createKeycloakAuthorityReader} from './keycloak-authority-reader.mjs';
import {createAuthorityPublisher} from './authority-publisher.mjs';
import {readLocalFacts} from '../../admin/backend/src/lib/broker-authority-facts.js';

/** Unix socket is a trusted local backend control channel, NOT independent human proof. */
export async function startLocalAuthoritySource(config){
 exact(config,['trust_mode','proxypilot_db','broker_db','state_path','socket_path','policy_file','keycloak','publisher','poll_ms','lease_ms']);
 if(config.trust_mode!=='local_backend_authority'||!Number.isSafeInteger(config.poll_ms)||config.poll_ms<1000||config.poll_ms>10000||!Number.isSafeInteger(config.lease_ms)||config.lease_ms<config.poll_ms*2||config.lease_ms>30000)fail('INVALID_SOURCE_CONFIGURATION');
 exact(config.keycloak,['issuer','client_id','client_secret_file','ca_file']);exact(config.publisher,['origin','ca_file','cert_file','key_file','source_id','signing_key_file']);
 const socketPath=resolve(config.socket_path),parent=dirname(socketPath),st=lstatSync(parent);if(realpathSync(parent)!==parent||!st.isDirectory()||st.uid!==process.getuid()||(st.mode&0o077))fail('UNSAFE_SOURCE_SOCKET');
 try{lstatSync(socketPath);fail('SOURCE_SOCKET_EXISTS',409);}catch(e){if(e.code!=='ENOENT')throw e;}
 for(const path of [config.proxypilot_db,config.broker_db]){const st=lstatSync(path);if(!st.isFile()||st.isSymbolicLink()||realpathSync(path)!==resolve(path)||(st.mode&0o022))fail('UNSAFE_SOURCE_DATABASE');}
 let proxyDb,brokerDb,source,server,timer;try{
  proxyDb=openReadonlyDatabase(config.proxypilot_db);brokerDb=openReadonlyDatabase(config.broker_db);
  const keycloak=createKeycloakAuthorityReader({issuer:config.keycloak.issuer,client_id:config.keycloak.client_id,client_secret:privateFile(config.keycloak.client_secret_file).toString().trim(),ca:privateFile(config.keycloak.ca_file,{secret:false})});
  const p=config.publisher,publisher=createAuthorityPublisher({origin:p.origin,ca:privateFile(p.ca_file,{secret:false}),cert:privateFile(p.cert_file,{secret:false}),key:privateFile(p.key_file),source_id:p.source_id,private_key:privateFile(p.signing_key_file)});
  source=createLocalAuthoritySource({statePath:config.state_path,readFacts:()=>readLocalFacts(proxyDb),readBroker:()=>readBrokerFacts(brokerDb),readPolicy:()=>readConfig(config.policy_file),readKeycloak:keycloak,publisher,leaseMs:config.lease_ms});
  let refreshing=null;const refresh=()=>{if(!refreshing)refreshing=source.refresh().catch(()=>{}).finally(()=>{refreshing=null;});return refreshing;};await refresh();
  server=http.createServer({requestTimeout:6000,headersTimeout:3000,maxHeaderSize:8192},async(req,res)=>{
   const reply=(status,value)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
   try{
    const names=req.rawHeaders.filter((_,i)=>i%2===0).map(n=>n.toLowerCase());if(new Set(names).size!==names.length)fail('INVALID_REQUEST');
    const url=new URL(req.url,'http://local-source');
    if(req.method==='GET'&&url.pathname==='/v1/registrations'){if([...url.searchParams.keys()].some(k=>!['user_id','project_id'].includes(k))||url.searchParams.getAll('user_id').length!==1||url.searchParams.getAll('project_id').length!==1)fail('INVALID_REQUEST');return reply(200,await source.registrations(Object.fromEntries(url.searchParams)));}
    if(req.method==='GET'&&req.url==='/v1/health')return reply(200,source.health());
    if(req.method!=='POST'||!['/v1/task/preview','/v1/task/authorize'].includes(req.url)||req.headers['content-type']!=='application/json'||req.headers['content-encoding'])fail('NOT_FOUND',404);
    let n=0;const chunks=[];for await(const chunk of req){n+=chunk.length;if(n>32768)fail('LIMIT_EXCEEDED',429);chunks.push(chunk);}const r=parseJson(Buffer.concat(chunks));reply(200,await (req.url==='/v1/task/preview'?source.previewTask(r):source.authorizeTask(r)));
   }catch(e){reply(e instanceof BrokerError?e.status:503,safeError(e));}
  });server.maxConnections=16;await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(socketPath,resolve);});chmodSync(socketPath,0o600);timer=setInterval(refresh,config.poll_ms);timer.unref();
  return {health:source.health,async close(){clearInterval(timer);server.closeAllConnections();await new Promise(r=>server.close(r));await source.close();proxyDb.close();brokerDb.close();try{unlinkSync(socketPath);}catch(e){if(e.code!=='ENOENT')throw e;}}};
 }catch(e){clearInterval(timer);if(server)server.close();await source?.close();proxyDb?.close();brokerDb?.close();throw e;}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 try{if(process.argv.length!==3)throw Error();const service=await startLocalAuthoritySource(readConfig(process.argv[2]));for(const signal of ['SIGTERM','SIGINT'])process.once(signal,async()=>{await service.close();process.exit(0);});process.stdout.write('Local authority source running; trust mode local_backend_authority.\n');}catch{process.stderr.write('Local authority source failed; check private configuration and current sources.\n');process.exitCode=1;}
}
