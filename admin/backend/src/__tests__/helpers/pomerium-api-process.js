// Isolated HTTP process fixture. Never opens a production database or host runner.
import express from 'express';
import { resolve } from 'node:path';
import { makeDb,apiFixture } from './pomerium-fixture.js';
import { getJob,jobView } from '../../lib/setup-engine/store.js';
const db=makeDb(process.argv[2]);
const fixture=await apiFixture(db);
const {authenticateToken}=await import('../../middleware/auth.js');
fixture.app.get('/api/auth/verify',authenticateToken,(req,res)=>res.json({user:{id:req.user.id,username:req.user.username,role:req.user.role}}));
fixture.app.get('/api/setup/overview',authenticateToken,(_req,res)=>res.json({jobs:db.prepare('SELECT id FROM setup_jobs ORDER BY created_at DESC').all().map(r=>jobView(getJob(db,r.id))),locks:[],runners:[]}));
fixture.app.get('/api/setup/jobs/:id',authenticateToken,(req,res)=>res.json({job:jobView(getJob(db,req.params.id))}));
fixture.app.get('/api/notifications',(_req,res)=>res.json({notifications:[],unread_count:0}));
fixture.app.get('/api/*',(_req,res)=>res.json({}));
const dist=resolve(import.meta.dirname,'../../../../frontend/dist');
fixture.app.use(express.static(dist));fixture.app.get('*',(_req,res)=>res.sendFile(resolve(dist,'index.html')));
process.send({url:fixture.url,tokens:fixture.tokens});
process.on('message',async msg=>{if(msg==='close'){await fixture.close();db.close();process.exit(0);}});
