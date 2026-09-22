import test from 'node:test';
import assert from 'node:assert/strict';
import { rootCertificates } from 'node:tls';
import { credentialFlow,verifyDatabase,postgresClient } from '../lib/setup-engine/openbao-postgres.js';
import { inputFor } from './helpers/openbao-fixture.js';
import { namesFor,configSchema,databaseDetails,POSTGRES_CA_PATH } from '../lib/setup-engine/openbao-logic.js';
const r={credential_ref:'openbao-0123456789abcdef01234567',config:inputFor('connect')},job={fence(){}};
function fixture({denyCode='28P01',writeAllowed=false,preflightSuper=false}={}){let revoked=false;const calls=[];const api=async(path)=>{calls.push(path);if(path.endsWith('/revoke-self')){revoked=true;return {status:204};}return {status:200,body:{lease_duration:60,lease_id:namesFor(r).database+'/creds/reader/opaque',data:{username:'v-g6',password:'do-not-record-dynamic-password'}}};};
  const makeClient=(_r,user,password)=>({async connect(){assert(password);if(revoked)throw Object.assign(Error('raw credential details withheld'),{code:denyCode});},async query(sql){calls.push(sql);if(sql.includes('current_database() AS db'))return {rows:[{db:r.config.database.name,usr:r.config.database.username,rolsuper:preflightSuper,rolcreaterole:true}]};if(sql.includes('AS db_create'))return {rows:[{db_create:false,schema_create:false}]};if(sql.includes('FROM pg_roles'))return {rows:[{rolsuper:false,rolcreatedb:false,rolcreaterole:false,rolreplication:false,rolbypassrls:false}]};if(sql.startsWith('INSERT')&&!writeAllowed)throw Object.assign(Error('denied'),{code:'42501'});return {rows:[{marker:'fixture'}]};},async end(){}});return {api,makeClient,calls,get revoked(){return revoked;}};}
test('G6.4 production credential-flow adapter issues/uses, proves denied write, revokes its token and rejects a new connection (scripted PostgreSQL)',async()=>{const f=fixture();const result=await credentialFlow(r,'scoped-token',f.api,{job,makeClient:f.makeClient});assert(result.read&&result.writeDenied&&result.revoked&&result.newConnectionDenied);assert(!JSON.stringify(result).includes('password'));assert(f.calls.includes('ROLLBACK'));assert(f.revoked);});
test('G6.4 outage after revocation is not accepted as credential denial; excessive grants fail and cleanup revokes',async()=>{for(const settings of [{denyCode:'ECONNREFUSED'},{writeAllowed:true}]){const f=fixture(settings);await assert.rejects(credentialFlow(r,'scoped-token',f.api,{job,makeClient:f.makeClient}),/denial|unexpectedly/);assert(f.revoked);}});
test('G6.4 selected database preflight rejects superuser and accepts only the intended disposable target',async()=>{const f=fixture();await verifyDatabase(r,'test-password',{makeClient:f.makeClient});const broad=fixture({preflightSuper:true});await assert.rejects(verifyDatabase(r,'test-password',{makeClient:broad.makeClient}),/non-superuser/);});

test('G6.4 public CA selection is bounded and never accepts a private key; both consumers verify TLS',()=>{
  const input=inputFor('connect');input.database.caPem=rootCertificates[0];assert(configSchema.safeParse(input).success);
  const selected={...r,config:input},details=databaseDetails(selected);assert(details.connection_url.endsWith('&sslrootcert='+POSTGRES_CA_PATH));assert.equal(details.password_authentication,'scram-sha-256');
  let options;postgresClient(selected,'test-reader','test-only',{Client:class{constructor(v){options=v;}}});assert.equal(options.ssl.ca,input.database.caPem);assert.equal(options.ssl.rejectUnauthorized,true);assert(options.ssl.checkServerIdentity('',{subjectaltname:'IP Address:10.20.30.51'}));
  input.database.caPem+='\n-----BEGIN PRIVATE KEY-----\nforbidden\n-----END PRIVATE KEY-----';assert(!configSchema.safeParse(input).success);
});
