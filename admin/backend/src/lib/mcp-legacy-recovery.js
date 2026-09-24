import {randomUUID} from 'node:crypto';
import {parseTokenScope} from './mcp-ext/logic.js';
import {mcpKeyRefusal} from './mcp-key-authority.js';

function timestamp(value) {
  const text=String(value || '');
  return Date.parse(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(text) ? text.replace(' ','T')+'Z' : text);
}

// Migration 1014 paused every pre-existing key. Dashboard roots have known
// provenance in the audit log; resume those without changing their authority,
// lifetime or secret. Unknown/ambiguous and MCP-created keys still need review.
export function resumeAuditedMcpRoots(db, now=Date.now()) {
  const resumed=[];
  const candidates=db.prepare('SELECT * FROM mcp_tokens WHERE review_required=1 AND parent_id IS NULL AND revoked_at IS NULL').all();
  for(const row of candidates) {
    if(mcpKeyRefusal(db,{...row,review_required:0},now)) continue;
    if(db.prepare("SELECT 1 FROM mcp_ledger WHERE tool='create_scoped_key' AND subject_type='mcp_token' AND subject_id=? LIMIT 1").get(String(row.id))) continue;
    const created=timestamp(row.created_at);
    if(!Number.isFinite(created)) continue;
    const audits=db.prepare("SELECT * FROM audit_log WHERE action='MCP_TOKEN_CREATED' AND resource_type='mcp_token' AND user_id=?").all(row.created_by);
    const matching=audits.filter(a=>{
      const delta=timestamp(a.created_at)-created;
      if(!Number.isFinite(delta) || delta < -1000 || delta > 5000) return false;
      let details;try{details=JSON.parse(a.details);}catch{return false;}
      if(!details || typeof details!=='object') return false;
      if((details.expires_at??null)!==(row.expires_at??null)) return false;
      // Current records name the stable token id and include the reviewed scope.
      if(Object.hasOwn(details,'scope')) return a.resource_id===String(row.id) &&
        JSON.stringify(parseTokenScope(details.scope))===JSON.stringify(parseTokenScope(row.scope_json));
      // Older dashboard records used the token NAME, so accept only a unique
      // name/owner pair and a unique matching audit record. No historical
      // scoped key is inferred to be a dashboard root.
      return row.scope_json===null && a.resource_id===row.name && details.never_expires===(row.expires_at==null) &&
        db.prepare('SELECT COUNT(*) n FROM mcp_tokens WHERE name=? AND created_by=?').get(row.name,row.created_by).n===1;
    });
    if(matching.length!==1) continue;
    db.prepare('UPDATE mcp_tokens SET review_required=0 WHERE id=? AND review_required=1').run(row.id);
    db.prepare('INSERT INTO audit_log(id,user_id,action,resource_type,resource_id,details,created_at) VALUES(?,?,?,?,?,?,?)')
      .run(randomUUID(),row.created_by,'MCP_TOKEN_RESUMED','mcp_token',String(row.id),JSON.stringify({reason:'audited_dashboard_root',source_audit_id:matching[0].id}),new Date(now).toISOString());
    resumed.push(row.id);
  }
  return resumed;
}
