import { z } from 'zod';
import { assertRevision, fail, parse, validId } from './operational-projects-logic.js';
import { BROWSER_DRAFT_CONTRACT, browserDraftHash, validateBrowserDraftImport } from './operational-browser-agent-proposal.js';

// Independent draft metadata only. No worker, model, vault, filesystem or network.
export function operationalBrowserDraftMigration1117(db) {
  db.exec(`
    CREATE TABLE ops_browser_agent_configurations (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES ops_projects(id),
      revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
      lifecycle TEXT NOT NULL DEFAULT 'draft' CHECK(lifecycle = 'draft'),
      execution_enabled INTEGER NOT NULL DEFAULT 0 CHECK(execution_enabled = 0),
      workflow_type TEXT NOT NULL DEFAULT 'selected_browser_v1' CHECK(workflow_type = 'selected_browser_v1'),
      configuration_json TEXT NOT NULL CHECK(json_valid(configuration_json) AND length(configuration_json) <= 200000),
      configuration_sha256 TEXT NOT NULL CHECK(length(configuration_sha256) = 64),
      source_text TEXT NOT NULL,
      source_sha256 TEXT NOT NULL CHECK(length(source_sha256) = 64),
      created_by TEXT NOT NULL, created_at TEXT NOT NULL,
      updated_by TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(project_id, id)
    );
    CREATE INDEX ops_browser_configurations_project ON ops_browser_agent_configurations(project_id, id);
    CREATE TRIGGER ops_browser_configuration_identity BEFORE UPDATE ON ops_browser_agent_configurations
      WHEN NEW.id IS NOT OLD.id OR NEW.project_id IS NOT OLD.project_id
        OR NEW.created_by IS NOT OLD.created_by OR NEW.created_at IS NOT OLD.created_at
      BEGIN SELECT RAISE(ABORT, 'Browser configuration identity is immutable'); END;
    CREATE TABLE ops_browser_agent_configuration_versions (
      configuration_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK(revision > 0),
      configuration_json TEXT NOT NULL CHECK(json_valid(configuration_json) AND length(configuration_json) <= 200000),
      configuration_sha256 TEXT NOT NULL CHECK(length(configuration_sha256) = 64),
      source_text TEXT NOT NULL,
      source_sha256 TEXT NOT NULL CHECK(length(source_sha256) = 64),
      saved_by TEXT NOT NULL, saved_at TEXT NOT NULL,
      PRIMARY KEY(configuration_id, revision),
      FOREIGN KEY(project_id, configuration_id) REFERENCES ops_browser_agent_configurations(project_id, id)
    );
    CREATE TRIGGER ops_browser_configuration_version_no_update BEFORE UPDATE ON ops_browser_agent_configuration_versions
      BEGIN SELECT RAISE(ABORT, 'Browser configuration version is immutable'); END;
    CREATE TRIGGER ops_browser_configuration_version_no_delete BEFORE DELETE ON ops_browser_agent_configuration_versions
      BEGIN SELECT RAISE(ABORT, 'Browser configuration version is immutable'); END;
  `);
}
const listSchema = z.object({ after: z.string().uuid().optional(),
  limit: z.string().regex(/^\d{1,2}$/).transform(Number).refine(n => n >= 1 && n <= 50).default('25') }).strict();

export function createBrowserConfigurationsStore({ one, all, run, tx, access, event, now, uuid, workflow }) {
  function row(projectId, configurationId) {
    const r = validId(configurationId) && one('SELECT * FROM ops_browser_agent_configurations WHERE project_id=? AND id=?', projectId, configurationId);
    if (!r) fail(404, 'Operational record not found');
    return r;
  }
  const projection = r => {
    if (browserDraftHash(r.configuration_json) !== r.configuration_sha256 || browserDraftHash(r.source_text) !== r.source_sha256)
      fail(409, 'Browser draft failed integrity validation');
    return { id: r.id, project_id: r.project_id, revision: r.revision, lifecycle: 'draft',
      execution_enabled: false, workflow_type: r.workflow_type, configuration: JSON.parse(r.configuration_json),
      configuration_sha256: r.configuration_sha256, source_text: r.source_text, source_sha256: r.source_sha256,
      created_by: r.created_by, created_at: r.created_at, updated_by: r.updated_by, updated_at: r.updated_at };
  };
  function readiness(p, c, revision = null) {
    const current = workflow.current(p.id), ref = c.work.guide_ref;
    const approved = ref && current?.id === ref.id && current.content_hash === ref.sha256;
    const check = (kind, state, code) => ({ kind, state, code });
    return { contract_version: BROWSER_DRAFT_CONTRACT, state: 'blocked', can_start: false, execution_enabled: false,
      pins: { project_revision: p.revision, configuration_revision: revision, guide_ref: ref }, checks: [
        check('network_scope', 'ready', 'EXPLICIT_DESTINATIONS_SELECTED'),
        check('external_change_approval', 'ready', 'PER_ACTION_APPROVAL_SELECTED'),
        check('off_list_approval', 'ready', 'EXACT_DESTINATION_PURPOSE_APPROVAL_SELECTED'),
        check('reachability', 'unverified', 'RUNNER_REACHABILITY_UNVERIFIED'),
        check('network_policy', 'unverified', 'EXACT_TARGET_NETWORK_POLICY_UNVERIFIED'),
        check('guide', approved ? 'ready' : ref ? 'stale' : 'unfinished', approved ? 'GUIDE_CURRENT' : ref ? 'GUIDE_STALE' : 'GUIDE_REQUIRED'),
        check('site_policy', 'unverified', 'SELECTED_SITE_POLICY_UNVERIFIED'),
        check('inputs', c.work.source_inputs.length || c.artifacts.upload_asset_refs.length ? 'unverified' : 'ready',
          c.work.source_inputs.length || c.artifacts.upload_asset_refs.length ? 'ASSET_RESOLUTION_UNAVAILABLE' : 'NO_ASSET_INPUTS'),
        check('model_consent', 'unfinished', 'OWNER_MODEL_CONSENT_REQUIRED'),
        check('runtime', 'unavailable', 'SELECTED_BROWSER_RUNTIME_NOT_IMPLEMENTED'),
        check('project', p.archived_at ? 'unavailable' : 'ready', p.archived_at ? 'PROJECT_ARCHIVED' : 'PROJECT_ACTIVE'),
      ] };
  }
  function response(p, r) {
    const configuration = projection(r);
    return { contract_version: BROWSER_DRAFT_CONTRACT, configuration,
      readiness: readiness(p, configuration.configuration, r.revision) };
  }
  function validate(projectId, input) {
    const v = validateBrowserDraftImport(input);
    const ref = v.configuration.work.guide_ref;
    const current = workflow.current(projectId);
    if (ref && (current?.id !== ref.id || current.content_hash !== ref.sha256))
      fail(409, 'The selected guide is not current');
    return v;
  }
  function snapshot(r) {
    run(`INSERT INTO ops_browser_agent_configuration_versions(configuration_id,project_id,revision,
      configuration_json,configuration_sha256,source_text,source_sha256,saved_by,saved_at) VALUES(?,?,?,?,?,?,?,?,?)`,
      r.id, r.project_id, r.revision, r.configuration_json, r.configuration_sha256, r.source_text, r.source_sha256, r.updated_by, r.updated_at);
  }
  return {
    browserConfigurations(actor, projectId, query = {}) {
      access(actor, projectId);
      const q = parse(listSchema, query);
      const rows = all('SELECT * FROM ops_browser_agent_configurations WHERE project_id=? AND id>? ORDER BY id LIMIT ?', projectId, q.after || '', q.limit + 1);
      return { contract_version: BROWSER_DRAFT_CONTRACT, configurations: rows.slice(0, q.limit).map(r => ({
        id: r.id, project_id: r.project_id, revision: r.revision, name: JSON.parse(r.configuration_json).name,
        lifecycle: 'draft', execution_enabled: false, workflow_type: r.workflow_type,
        configuration_sha256: r.configuration_sha256, updated_at: r.updated_at,
      })), next_cursor: rows.length > q.limit ? rows[q.limit - 1].id : null };
    },
    browserConfiguration(actor, projectId, configurationId) {
      const { p } = access(actor, projectId);
      return response(p, row(projectId, configurationId));
    },
    validateBrowserConfiguration(actor, projectId, input) {
      const { p } = access(actor, projectId, 'edit');
      const v = validate(projectId, input);
      return { contract_version: BROWSER_DRAFT_CONTRACT, valid: true, persisted: false,
        configuration: v.configuration, configuration_sha256: v.configuration_sha256,
        readiness: readiness(p, v.configuration) };
    },
    createBrowserConfiguration(actor, projectId, expected, input) {
      return tx(() => {
        const { p } = access(actor, projectId, 'edit'); assertRevision(expected, p.revision);
        const v = validate(projectId, input), id = uuid(), at = now();
        const source_text = v.source_text ?? v.configuration.work.instructions;
        run(`INSERT INTO ops_browser_agent_configurations(id,project_id,configuration_json,configuration_sha256,
          source_text,source_sha256,created_by,created_at,updated_by,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)`,
          id, projectId, v.configuration_json, v.configuration_sha256, source_text, browserDraftHash(source_text), actor.id, at, actor.id, at);
        const saved = row(projectId, id); snapshot(saved);
        event(actor, projectId, 'browser_configuration_created', id, { revision: 1, configuration_sha256: saved.configuration_sha256, source_sha256: saved.source_sha256 });
        return response(p, saved);
      });
    },
    updateBrowserConfiguration(actor, projectId, configurationId, expected, input) {
      return tx(() => {
        const { p } = access(actor, projectId, 'edit'), old = row(projectId, configurationId);
        assertRevision(expected, old.revision);
        const v = validate(projectId, input), source_text = v.source_text ?? old.source_text, at = now();
        run(`UPDATE ops_browser_agent_configurations SET configuration_json=?,configuration_sha256=?,source_text=?,
          source_sha256=?,revision=revision+1,updated_by=?,updated_at=? WHERE project_id=? AND id=?`,
          v.configuration_json, v.configuration_sha256, source_text, browserDraftHash(source_text), actor.id, at, projectId, configurationId);
        const saved = row(projectId, configurationId); snapshot(saved);
        event(actor, projectId, 'browser_configuration_updated', configurationId, { revision: saved.revision,
          configuration_sha256: saved.configuration_sha256, source_sha256: saved.source_sha256 });
        return response(p, saved);
      });
    },
  };
}
