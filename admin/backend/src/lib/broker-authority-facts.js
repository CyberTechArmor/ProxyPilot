// Explicit metadata projection. This reader never selects user credentials,
// guide text, vault references, broker bearers, or arbitrary receipt content.
export function readLocalFacts(db) {
  const read=()=>({
    users:db.prepare('SELECT id,role,locked_until,updated_at FROM users ORDER BY id').all(),
    projects:db.prepare('SELECT id,owner_user_id,revision,archived_at FROM ops_projects ORDER BY id').all().map(p=>({
      ...p,members:db.prepare('SELECT user_id,role FROM ops_project_grants WHERE project_id=? ORDER BY user_id').all(p.id),
      // Withdrawal of the newest approved version does not revive an older one.
      current_guide:db.prepare(`SELECT v.id,v.content_hash,v.version_number FROM ops_guide_versions v
        WHERE v.project_id=? AND v.version_number=(SELECT MAX(version_number) FROM ops_guide_versions WHERE project_id=v.project_id)
        AND NOT EXISTS(SELECT 1 FROM ops_version_withdrawals w WHERE w.version_id=v.id AND w.project_id=v.project_id)`).get(p.id)??null,
    })),
    agents:db.prepare('SELECT id,project_id,revision,created_by,workflow_type,work_json,controls_json FROM ops_agent_configurations ORDER BY id').all().map(({work_json,controls_json,...a})=>{
      const work=JSON.parse(work_json),controls=JSON.parse(controls_json);
      return {...a,work:{guide_ref:work.guide_ref??null,environment_ref:work.environment_ref??null},controls:{operations:controls.operations,resources:controls.resources,max_actions:controls.max_actions,max_seconds:controls.max_seconds,approval_policy:controls.approval_policy,output_ref:controls.output_ref??null}};
    }),
    tasks:db.prepare('SELECT id,user_id,project_id,agent_id,configuration_revision,attempt,fence,request_digest,state FROM ops_broker_tasks ORDER BY id').all(),
  });
  // A consistent snapshot prevents mixing guide/configuration changes. The
  // daemon opens SQLite read-only; no schema or policy writes occur here.
  if(db.inTransaction)return read();
  db.exec('BEGIN');try{const facts=read();db.exec('COMMIT');return facts;}catch(e){db.exec('ROLLBACK');throw e;}
}
