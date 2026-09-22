import pg from 'pg';
import { checkServerIdentity } from 'node:tls';
import { fail,namesFor } from './openbao-logic.js';
import { ok } from './openbao-api.js';
export function postgresClient(r,user,password,{Client=pg.Client}={}){return new Client({host:r.config.database.host,port:r.config.database.port,database:r.config.database.name,user,password,ssl:{rejectUnauthorized:true,checkServerIdentity:(_host,cert)=>checkServerIdentity(r.config.database.host,cert)},connectionTimeoutMillis:7000,query_timeout:7000,statement_timeout:5000,application_name:'proxypilot-g6-disposable-proof'});}
export async function verifyDatabase(r,password,{makeClient=postgresClient}={}){const c=makeClient(r,r.config.database.username,password);try{await c.connect();const d=(await c.query("SELECT current_database() AS db, current_user AS usr, rolsuper, rolcreaterole FROM pg_roles WHERE rolname=current_user")).rows[0];
  if(d.db!==r.config.database.name||d.usr!==r.config.database.username||d.rolsuper||!d.rolcreaterole)throw fail('Select a dedicated non-superuser PostgreSQL role with CREATEROLE for the reviewed disposable database.');
  await c.query('SELECT marker FROM public.g6_probe LIMIT 1');
  const privileges=(await c.query("SELECT EXISTS(SELECT 1 FROM pg_database d CROSS JOIN LATERAL aclexplode(COALESCE(d.datacl,acldefault('d',d.datdba))) a WHERE d.datname=current_database() AND a.grantee=0 AND a.privilege_type='CREATE') AS db_create, EXISTS(SELECT 1 FROM pg_namespace n CROSS JOIN LATERAL aclexplode(COALESCE(n.nspacl,acldefault('n',n.nspowner))) a WHERE n.nspname='public' AND a.grantee=0 AND a.privilege_type='CREATE') AS schema_create")).rows[0];
  if(privileges.db_create||privileges.schema_create)throw fail('Revoke PUBLIC CREATE privileges in the selected disposable database before testing.');
 }catch(e){if(e.openbaoSafe)throw e;throw fail('Selected disposable PostgreSQL preflight failed (TLS, connection or probe-table permissions). Raw database details withheld.');}finally{await c.end().catch(()=>{});}}
export async function credentialFlow(r,token,api,{job,makeClient=postgresClient}={}){const n=namesFor(r);let credential=null,consumer=null,revoked=false;
  try{job.fence();const response=ok(await api(`/v1/${n.database}/creds/reader`,{token}),'Limited credential issue');credential=response?.data;
    if(!credential?.username||!credential?.password||!response.lease_id?.startsWith(n.database+'/creds/reader/')||response.lease_duration>120||response.lease_duration<=0)throw fail('OpenBao did not issue the reviewed limited database credential.');
    consumer=makeClient(r,credential.username,credential.password);await consumer.connect();job.fence();
    await consumer.query('SELECT marker FROM public.g6_probe LIMIT 1');
    const role=(await consumer.query('SELECT rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0];
    if(!role||Object.values(role).some(Boolean))throw fail('Dynamic database role has excess privileges.');
    // Read-only privilege checks plus a rolled-back attempted write prove denial.
    await consumer.query('BEGIN');let denied=false;try{await consumer.query("INSERT INTO public.g6_probe(marker) VALUES ('g6-denied-proof')");}catch(e){denied=e.code==='42501';}finally{await consumer.query('ROLLBACK');}
    if(!denied)throw fail('Dynamic credential unexpectedly allowed a write to the disposable probe table.');
    await consumer.end();consumer=null;
    // A service token owns its leases. Revoke only this disposable token and its
    // descendants, never a prefix or another identity's credential.
    ok(await api('/v1/auth/token/revoke-self',{method:'POST',token}),'Test credential revocation');revoked=true;
    const after=makeClient(r,credential.username,credential.password);let blocked=false;try{await after.connect();await after.query('SELECT marker FROM public.g6_probe LIMIT 1');}catch(e){blocked=['28P01','28000','42501'].includes(e.code);}finally{await after.end().catch(()=>{});}
    if(!blocked)throw fail('Revoked credential still authenticates, or denial was not an authentication/permission failure.');
    job.fence();return {issued:true,read:true,writeDenied:true,revoked:true,newConnectionDenied:true,engine:'postgresql',resource:'selected_disposable_database'};
  }catch(e){if(e.openbaoSafe||['FENCED','CANCELLED'].includes(e.code))throw e;throw fail('Disposable database credential proof failed. Raw credentials and database output withheld.');}
  finally{if(consumer)await consumer.end().catch(()=>{});if(!revoked)await api('/v1/auth/token/revoke-self',{method:'POST',token}).catch(()=>{});credential=null;}
}
