import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { randomBytes, createCipheriv } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeDb, inputFor, adminHtml } from './helpers/vaultwarden-fixture.js';
import { save, apply, review, readVaultwarden, secrets } from '../lib/setup-engine/vaultwarden-store.js';
test('G7.4 fresh production runner once/serve preserves the G6 installation key and Vaultwarden ciphertext', { timeout: 15000 }, async () => {
  const root=mkdtempSync(join(tmpdir(),'g7-fresh-'));mkdirSync(join(root,'data/db'),{recursive:true});const db=makeDb(join(root,'data/db/proxypilot.db'),{mode:'connect'});
  try{save(db,inputFor('connect'));const r=readVaultwarden(db),credentials=secrets(db,r),key=randomBytes(32).toString('hex'),iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',Buffer.from(key,'hex'),iv);
    const bytes=Buffer.concat([cipher.update(JSON.stringify(credentials)),cipher.final()]),encrypted=`enc:v1:${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${bytes.toString('hex')}`;
    db.prepare('UPDATE setup_vaultwarden_credentials SET value=?').run(encrypted);
    const envText=`DATABASE_PATH=/data/db/proxypilot.db\nTOTP_ENCRYPTION_KEY=${key}\n`;writeFileSync(join(root,'.env'),envText,{mode:0o600});
    for(const action of ['once','serve']){const id=apply(db,{revision:1,reviewToken:review(db).reviewToken,reviewed:true},'admin').job.id;
      const env={...process.env,NODE_ENV:'production'};delete env.TOTP_ENCRYPTION_KEY;delete env.NODE_OPTIONS;
      const result=await new Promise((resolve,reject)=>{const child=fork(new URL('./helpers/vaultwarden-runner-process.js',import.meta.url),[root,action],{env,execArgv:[],stdio:['ignore','pipe','pipe','ipc']});let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);child.on('error',reject);
        child.on('message',m=>{if(m.opened)return;const body=m.path==='/api/version'?'1.37.3':m.path==='/alive'?'fixture-date':adminHtml(r,credentials);child.send({id:m.id,result:{status:m.path==='/admin/'&&m.options.adminToken!==credentials.admin?401:200,body}});});child.on('exit',code=>resolve({code,output}));});
      assert.equal(result.code,0,result.output);const j=db.prepare('SELECT * FROM setup_jobs WHERE id=?').get(id);assert.equal(j.status,'succeeded',j.reason);
      assert.equal(readFileSync(join(root,'.env'),'utf8'),envText);assert.equal(db.prepare('SELECT value FROM setup_vaultwarden_credentials').get().value,encrypted);
      const evidence=result.output+JSON.stringify([j,db.prepare('SELECT * FROM setup_job_events').all()]);for(const v of [key,credentials.client,credentials.admin])assert(!evidence.includes(v));
    }
  }finally{db.close();rmSync(root,{recursive:true,force:true});}
});
