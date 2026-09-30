import { z } from 'zod';
import { assertEligible } from './operational-projects-logic.js';
import { createOperationalCredentialStore, CREDENTIAL_ORIGIN } from './operational-credential-bindings.js';

// Host-operator enrollment only. No HTTP/MCP route imports this module.
const uuid = z.string().uuid();
const bindingSchema = z.object({ binding_id: uuid, project_id: uuid, profile_id: uuid,
  origin: z.literal(CREDENTIAL_ORIGIN), username: z.string(), revision: z.literal(1), state: z.literal('active'),
  vault: z.object({ mount: z.string(), path: z.string(), version: z.number().int().positive() }).strict() }).strict();
const fail = code => { const error = new Error(code); error.code = code; throw error; };

export function importPilotBinding(db, actorId, expected, binding) {
  const parsed = bindingSchema.safeParse(binding);
  if (!parsed.success || !expected || parsed.data.project_id !== expected.project_id ||
      parsed.data.profile_id !== expected.profile_id || parsed.data.binding_id !== expected.binding_id) fail('BINDING_MISMATCH');
  function authorized() {
    const actor = db.prepare('SELECT id,role FROM users WHERE id=?').get(actorId);
    assertEligible(actor, actor);
    const project = db.prepare('SELECT owner_user_id,archived_at,site_origin FROM ops_projects WHERE id=?').get(expected.project_id);
    if (!project || project.owner_user_id !== actorId || project.archived_at || project.site_origin !== CREDENTIAL_ORIGIN)
      fail('FORBIDDEN');
    if (!db.prepare("SELECT 1 FROM ops_agent_profiles WHERE id=? AND project_id=? AND deleted_at IS NULL AND workflow_type='synthetic_sign_in'").get(expected.profile_id, expected.project_id))
      fail('PROFILE_NOT_ELIGIBLE');
    if (db.prepare("SELECT 1 FROM ops_agent_runs WHERE profile_id=? AND state IN ('prepared','starting','running','cancelling')").get(expected.profile_id))
      fail('RUN_ACTIVE');
    return actor;
  }
  const actor = authorized();
  const noPrior = () => {
    if (db.prepare("SELECT 1 FROM ops_agent_credential_bindings WHERE profile_id=? AND state='active'").get(binding.profile_id))
      fail('BINDING_EXISTS');
  };
  const store = createOperationalCredentialStore(db, undefined, { authorizeBind: () => { authorized(); noPrior(); } });
  const prior = store.get(binding.binding_id);
  const metadata = { binding_id: binding.binding_id, project_id: binding.project_id, profile_id: binding.profile_id,
    username: binding.username, vault_mount: binding.vault.mount, vault_path: binding.vault.path, vault_version: binding.vault.version };
  if (prior) {
    if (prior.state !== 'active' || prior.revision !== 1 || prior.project_id !== binding.project_id ||
        prior.profile_id !== binding.profile_id || prior.username !== binding.username ||
        JSON.stringify(prior.vault) !== JSON.stringify(binding.vault)) fail('BINDING_MISMATCH');
    return { changed: false, binding_id: prior.binding_id, revision: prior.revision };
  }
  const created = store.bind(actor, metadata);
  return { changed: true, binding_id: created.binding_id, revision: created.revision };
}
