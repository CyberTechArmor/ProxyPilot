import { parseTokenScope, scopeSubsetRefusal } from './mcp-ext/logic.js';
import { mcpTokenRefusal } from './mcp-logic.js';

// Every request follows the persisted chain. Restricting or revoking a parent
// cannot leave a descendant with authority the parent no longer holds.
export function mcpKeyRefusal(db, row, now = Date.now()) {
  const seen = new Set();
  let child = null;
  for (let current = row; current; ) {
    if (seen.has(current.id) || seen.size >= 16) return 'Invalid delegation lineage';
    seen.add(current.id);
    if (current.revoked_at || current.review_required !== 0) return 'Key revoked or awaiting administrator review';
    const scope = parseTokenScope(current.scope_json);
    if (scope.invalid) return 'Malformed key scope';
    const owner = db.prepare('SELECT id,role FROM users WHERE id=?').get(current.created_by);
    const invalid = mcpTokenRefusal({expiresAt:current.expires_at,ownerId:current.created_by,owner,now});
    if (invalid) return invalid;
    if (child) {
      if (child.created_by !== current.created_by) return 'Delegation owner mismatch';
      const wider = scopeSubsetRefusal(parseTokenScope(child.scope_json),scope);
      if (wider) return wider;
      if (current.expires_at && (!child.expires_at || Date.parse(child.expires_at)>Date.parse(current.expires_at))) return 'Child outlives parent';
    }
    if (current.parent_id == null) return null;
    child = current;
    current = db.prepare('SELECT * FROM mcp_tokens WHERE id=?').get(current.parent_id);
    if (!current) return 'Delegation parent missing';
  }
  return 'Key missing';
}

export {redactMcpSecrets} from './mcp-redaction.js';
