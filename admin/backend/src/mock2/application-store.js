import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { digest, failApplicationRelease } from './application-profile.js';
const now = () => new Date().toISOString();
export function processStart(pid) {
  try {const stat=readFileSync(`/proc/${pid}/stat`,'utf8'),boot=readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim();return boot+':'+stat.slice(stat.lastIndexOf(')')+2).split(' ')[19];}
  catch(e){if(e.code==='ENOENT')return 'absent';throw e;}
}

export function createApplicationStore(db) {
  function profile(id, revision) {
    const row = db.prepare('SELECT * FROM mock2_application_profiles WHERE application_id=? AND revision=?').get(id, revision);
    return row ? {...JSON.parse(row.profile_json),revision:row.revision,digest:row.digest} : null;
  }
  function candidate(row) {
    return row ? {sha:row.sha,treeSha:row.tree_sha,profileRevision:row.profile_revision,profileDigest:row.profile_digest,checkpointAt:row.checkpoint_at,hygiene:JSON.parse(row.hygiene_json),validation:row.validation_json?JSON.parse(row.validation_json):null,publication:row.publication_json?JSON.parse(row.publication_json):null,live:row.live_json?JSON.parse(row.live_json):null} : null;
  }
  const candidates = (id, revision) => db.prepare('SELECT * FROM mock2_application_candidates WHERE application_id=? AND profile_revision=? ORDER BY checkpoint_at DESC,sha').all(id,revision).map(candidate);
  function get(id) {
    const row = db.prepare('SELECT * FROM mock2_applications WHERE id=?').get(Number(id));
    if (!row) failApplicationRelease('APPLICATION_NOT_FOUND','Application not found.',404);
    const op=db.prepare('SELECT token,kind,started_at,owner_pid,owner_start FROM mock2_application_operations WHERE application_id=?').get(row.id);
    return {id:row.id,name:row.name,targetId:row.target_id,repositoryPath:row.repository_path,importedAt:row.imported_at,profile:profile(row.id,row.profile_revision),candidates:candidates(row.id,row.profile_revision),live:row.live_json?JSON.parse(row.live_json):null,operation:op?{token:op.token,kind:op.kind,startedAt:op.started_at,ownerPid:op.owner_pid,ownerStart:op.owner_start}:null};
  }
  function create(p, root) {
    return db.transaction(() => {
      if (db.prepare('SELECT id FROM mock2_applications WHERE target_id=?').get(p.targetId)) failApplicationRelease('APPLICATION_EXISTS','This container already has an application profile.');
      const time=now(), result=db.prepare('INSERT INTO mock2_applications(target_id,name,repository_path,created_at) VALUES(?,?,?,?)').run(p.targetId,p.name,'pending',time),id=Number(result.lastInsertRowid);
      db.prepare('UPDATE mock2_applications SET repository_path=? WHERE id=?').run(`${root}/${id}/repo.git`,id);
      db.prepare('INSERT INTO mock2_application_profiles VALUES(?,?,?,?,?)').run(id,1,digest(p),JSON.stringify(p),time);
      return get(id);
    })();
  }
  function update(id,p,expectedRevision) {
    return db.transaction(() => {
      const current=get(id); if (current.profile.revision!==expectedRevision) failApplicationRelease('STALE_PROFILE','Profile changed; reload before updating.');
      if (current.targetId!==p.targetId || current.profile.sourceDir!==p.sourceDir) failApplicationRelease('PROFILE_IDENTITY_CHANGED','Container and source path are immutable; import another application explicitly.');
      if (digest(p)===current.profile.digest) return current;
      if(db.prepare('SELECT token FROM mock2_application_operations WHERE application_id=?').get(id)) failApplicationRelease('APPLICATION_BUSY','An application operation is in progress.');
      const revision=expectedRevision+1;
      db.prepare('INSERT INTO mock2_application_profiles VALUES(?,?,?,?,?)').run(id,revision,digest(p),JSON.stringify(p),now());
      db.prepare('UPDATE mock2_applications SET profile_revision=?,name=? WHERE id=? AND profile_revision=?').run(revision,p.name,id,expectedRevision);
      return get(id);
    })();
  }
  return {
    get,create,update,profile,
    list:()=>db.prepare('SELECT id FROM mock2_applications ORDER BY name,id').all().map(row=>get(row.id)),
    candidates:(id)=>get(id).candidates,
    candidate:(id,sha)=>{const p=get(id).profile;return candidate(db.prepare('SELECT * FROM mock2_application_candidates WHERE application_id=? AND sha=? AND profile_revision=?').get(id,sha,p.revision));},
    imported:(id)=>db.prepare('UPDATE mock2_applications SET imported_at=? WHERE id=?').run(now(),id),
    saveCandidate:(id,p,c)=>db.prepare('INSERT INTO mock2_application_candidates(application_id,sha,profile_revision,profile_digest,tree_sha,checkpoint_at,hygiene_json) VALUES(?,?,?,?,?,?,?) ON CONFLICT(application_id,sha,profile_revision) DO NOTHING').run(id,c.sha,p.revision,p.digest,c.treeSha,now(),JSON.stringify(c.hygiene)),
    record:(id,sha,field,value,expectedDigest)=>{
      if(!['validation','publication','live'].includes(field)) failApplicationRelease('INVALID_RECORD','Invalid release record.',400);
      return db.transaction(()=>{const app=get(id);if(app.profile.digest!==expectedDigest) failApplicationRelease('STALE_PROFILE','The pinned application profile changed.');
        const changed=db.prepare(`UPDATE mock2_application_candidates SET ${field}_json=? WHERE application_id=? AND sha=? AND profile_revision=? AND profile_digest=?`).run(JSON.stringify(value),id,sha,app.profile.revision,expectedDigest);
        if(changed.changes!==1) failApplicationRelease('STALE_CANDIDATE','Candidate no longer matches this profile.');return get(id);
      })();
    },
    recordObservedLive:(id,value,expectedDigest)=>db.transaction(()=>{const app=get(id);if(app.profile.digest!==expectedDigest)failApplicationRelease('STALE_PROFILE','The pinned application profile changed.');db.prepare('UPDATE mock2_applications SET live_json=? WHERE id=?').run(JSON.stringify(value),id);return get(id);})(),
    acquire:(id,kind)=>{get(id);const token=randomUUID();try{db.prepare('INSERT INTO mock2_application_operations VALUES(?,?,?,?,?,?)').run(id,token,kind,now(),process.pid,processStart(process.pid));}catch{failApplicationRelease('APPLICATION_BUSY','A previous application operation is running or needs recovery.');}return token;},
    release:(id,token)=>db.prepare('DELETE FROM mock2_application_operations WHERE application_id=? AND token=?').run(id,token),
  };
}
