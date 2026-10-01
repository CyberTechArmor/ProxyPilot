/** Disposable synthetic composition. Never imported by production bootstrap.
 * Default vault/upstream are memory fixtures: this is NOT a real OpenBao proof.
 * Inject vault/upstream to reuse isolated real fixtures. All capabilities live
 * in this process; no keys, proofs or credential values are logged or persisted.
 */
import express from 'express';
import https from 'node:https';
import {randomBytes,randomUUID} from 'node:crypto';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {operationsFixture} from './operations-fixture.js';
import {createOperationsRouter} from '../../routes/operational-projects.js';
import {createConnectionsRouter} from '../../routes/connections.js';
import {createSyntheticBrokerBridge} from '../../lib/credential-broker-bridge.js';
import {csrfProtection} from '../../middleware/csrf.js';
import {createBroker} from '../../../../../services/credential-broker/broker.mjs';
import {createIntakeHandler} from '../../../../../services/credential-broker/intake.mjs';
import {createAgentServer} from '../../../../../services/credential-broker/server.mjs';
const cookies=req=>Object.fromEntries((req.headers.cookie||'').split(';').map(s=>s.trim().split('=')).filter(p=>p.length===2));
const listen=server=>new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>resolve(server));});
const stop=server=>server?new Promise(resolve=>{server.closeAllConnections();server.close(()=>resolve());}):Promise.resolve();
export async function createBrokerDashboardHarness({vault:providedVault,upstream:providedUpstream,dependenciesFactory=null}={}) {
 const directory=mkdtempSync(join(tmpdir(),'broker-dashboard-harness-')),fixture=operationsFixture();
 const {store}=fixture,users={owner:fixture.addUser(),other:fixture.addUser(),admin:fixture.addUser('admin')};
 const project=store.create(users.owner,{name:'Synthetic broker project',description:'Disposable browser proof'});
 let dependencies;
 try {dependencies=dependenciesFactory?await dependenciesFactory({owner:users.owner.id,project:project.id}):null;}
 catch(error){fixture.close();rmSync(directory,{recursive:true,force:true});throw error;}
 const credential=dependencies?.credential??randomBytes(32).toString('base64url'),resource=dependencies?.resource??randomUUID(),csrf=randomBytes(32).toString('base64url');
 const proofs=new Map(Object.values(users).map(u=>[u.id,randomBytes(32).toString('base64url')]));
 const sessions=new Map(Object.values(users).map(u=>[randomBytes(32).toString('base64url'),u.id]));
 const ownerOfProof=proof=>[...proofs].find(([,p])=>p===proof)?.[0];
 const proofForUser=user=>proofs.get(typeof user==='string'?user:user.id);
 const eligibleUser=id=>{try{store.assertActor({id});return true;}catch{return false;}};
 const authenticate=async proof=>{const user_id=ownerOfProof(proof);return eligibleUser(user_id)?{user_id,fresh_until:Date.now()+300000}:null;};
 const sessionConfigurationPins=new Map();
 const withinControls=(scope,controls)=>Array.isArray(scope.operations)&&Array.isArray(scope.resources)&&
   scope.operations.every(operation=>controls.operations.includes(operation))&&
   scope.resources.every(resource=>controls.resources.includes(resource))&&
   Number.isInteger(scope.limits?.max_actions)&&Number.isInteger(scope.limits?.max_seconds)&&
   scope.limits.max_actions<=controls.max_actions&&scope.limits.max_seconds<=controls.max_seconds;
 const canAssign=async(person,grant)=>{try {
   if(!eligibleUser(person.user_id)||!eligibleUser(grant.user_id))return false;
   const p=store.get({id:person.user_id},grant.project_id);
   if(p.archived_at||!['owner','editor'].includes(p.own_role))return false;
   const {agent}=store.configuration({id:grant.user_id},grant.project_id,grant.agent_id);
   // Picker checks identity only. Existing grant IDs are checked for removal:
   // narrowing Controls must never prevent the person from removing a grant.
   return grant.id||!grant.operations?true:withinControls(grant,agent.controls);
 }catch{return false;}};
 const eligible=async session=>{try {
   if(!eligibleUser(session.user_id))return false;
   const p=store.get({id:session.user_id},session.project_id);
   const {agent}=store.configuration({id:session.user_id},session.project_id,session.agent_id);
   if(p.archived_at||!withinControls(session,agent.controls))return false;
   // Broker calls eligible at issuance before returning the bearer, then again
   // on every use. Any edit invalidates already-issued synthetic sessions,
   // even a later restoration of identical Controls cannot revive one.
   if(!sessionConfigurationPins.has(session.id))sessionConfigurationPins.set(session.id,agent.revision);
   return sessionConfigurationPins.get(session.id)===agent.revision;
 }catch{return false;}};
 const values=new Map();
 const vault=dependencies?.vault??providedVault??{
  async write(path,value,{cas,intent}){const entries=values.get(path)??[];if(entries.length!==cas)throw Error('CAS mismatch');entries.push({value,intent,version:cas+1});values.set(path,entries);return {version:cas+1};},
  async read(path,version){const result=values.get(path)?.[version-1];if(!result)throw Error('Missing fixture version');return {...result};}
 };
 let state='open',broker,intake,intakeServer,agentServer;
 const upstream=dependencies?.upstream??providedUpstream??{async execute(operation,input,value){if(value!==credential||input.resource_id!==resource)throw Error('Fixture refusal');if(operation==='item.set_state')state=input.state;return {resource_id:resource,state,...(operation==='item.set_state'?{applied:true}:{})};}};
 try {
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=localhost','-addext','subjectAltName=IP:127.0.0.1,DNS:localhost','-keyout',join(directory,'key.pem'),'-out',join(directory,'cert.pem')],{stdio:'ignore'});
  const tls={key:readFileSync(join(directory,'key.pem')),cert:readFileSync(join(directory,'cert.pem'))};
  broker=createBroker({mode:'synthetic',dbPath:join(directory,'broker.db'),vault,upstream,authority:{authenticate,eligible,canAssign}});
  intakeServer=https.createServer(tls,(req,res)=>intake?intake(req,res):res.writeHead(503).end());await listen(intakeServer);
  const intakeOrigin=`https://127.0.0.1:${intakeServer.address().port}`;
  intake=createIntakeHandler({mode:'synthetic',broker,origin:intakeOrigin,statePath:join(directory,'intake.json'),authenticateProof:authenticate,
    authenticateRequest:async req=>({proof:req.headers['x-fixture-broker-proof']??cookies(req).broker_fixture_proof,csrf_token:csrf})});
  agentServer=createAgentServer({broker,...tls});await listen(agentServer);
  const bridge=createSyntheticBrokerBridge({broker,intake,intakeOrigin,fixtureScope:{operations:['item.read','item.set_state'],resources:[resource],limits:{max_actions:20,max_seconds:300}},isolatedFixture:true,resolveProof:async id=>proofForUser(id)});
  const app=express();app.use(express.json({limit:'16kb'}));
  app.use((req,res,next)=>{res.set('Cache-Control','no-store');req.cookies=cookies(req);const id=sessions.get(req.cookies.pp_fixture_session);if(!id||!eligibleUser(id))return res.status(401).json({error:'Authentication required'});req.user={id,role:Object.values(users).find(u=>u.id===id).role};next();});
  app.use(csrfProtection);
  app.get('/auth/me',(req,res)=>res.json({user:{...req.user,username:'Synthetic fixture person'}}));
  app.use('/operational-projects',createOperationsRouter({Router:express.Router,store,enabled:true,agentsEnabled:true,configurationConnections:actor=>bridge.request({action:'list',actor,query:{}}),lookupLimiter:(_q,_r,next)=>next()}));
  const requireFresh=(req,res,next)=>req.cookies.pp_fixture_fresh===proofForUser(req.user.id)?next():res.status(401).json({sudo_required:true,error:'sudo_required'});
  app.use('/connections',createConnectionsRouter({Router:express.Router,store,bridge,requireSudo:requireFresh}));
  let closed=false;
  return {app,store,users,project,broker,intake,intakeOrigin,resource,proofForUser,credential,
   dependencies,agentOrigin:`https://127.0.0.1:${agentServer.address().port}`,csrf,tlsCertificate:tls.cert,
   // Caller installs these with its browser context; each random value is fixture authority.
   dashboardCookies:user=>{const id=typeof user==='string'?user:user.id;return {pp_fixture_session:[...sessions].find(([,u])=>u===id)?.[0],pp_fixture_fresh:proofForUser(id),pp_csrf:csrf};},
   intakeCookies:user=>({broker_fixture_proof:proofForUser(user)}),
   close:async()=>{if(closed)return;closed=true;await Promise.all([stop(agentServer),stop(intakeServer)]);intake.close();broker.close();await dependencies?.close?.();fixture.close();values.clear();sessionConfigurationPins.clear();proofs.clear();sessions.clear();rmSync(directory,{recursive:true,force:true});}};
 }catch(error){await Promise.all([stop(agentServer),stop(intakeServer)]);intake?.close();broker?.close();await dependencies?.close?.();fixture.close();rmSync(directory,{recursive:true,force:true});throw error;}
}
