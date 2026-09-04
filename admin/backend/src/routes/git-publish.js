// Publish static sites and LXC application directories to an external git
// remote, using the git connectors that already back AI-dev projects.
//
// Why a separate router
// ---------------------
// The two sources live in different subsystems (static sites are `services`
// rows with a docroot; LXC guests are Incus instances) and the connectors live
// in the Mock2 database. Bolting half of this onto routes/services.js and the
// other half onto routes/lxc.js — both already very large — would scatter one
// feature across three files and duplicate the connector lookup twice. One
// router owns the whole surface.
//
// Safety posture
// --------------
//   - Admin + sudo. A publish is a bulk egress of file content to an external
//     host; it belongs behind the same gate as a destination change.
//   - Secrets are held back by default (lib/git-publish-logic.js) and every
//     excluded path is named in the response. `include_secrets` exists, is
//     off by default, and is recorded in the audit entry when used.
//   - `dry_run` reports exactly what would be sent without contacting the
//     remote — the right first call for any new publish target.
//   - LXC publishes are scoped to the container's REGISTERED STARTUP WORKING
//     DIRECTORY. A container's filesystem holds credentials, keys and system
//     state that must never be pushed anywhere; the startup working dir is the
//     application directory ProxyPilot already tracks, and it is the only path
//     this router will read without an explicit operator override.

import { Router } from 'express';
import { z } from 'zod';

import { requireAdmin, requireSudo } from '../middleware/auth.js';
import { getDb, logAudit } from '../db.js';
import { publishDirToGit, stageLxcDir, cleanupStagedDir } from '../lib/git-publish.js';
import { readContainerStartup } from '../lib/lxc-zip.js';

export const gitPublishRouter = Router();
const router = gitPublishRouter;

// Matches routes/lxc.js and routes/mcp.js, which both hardcode this. Reading
// an env var here that nothing else honours would let the three disagree.
const LXC_PREFIX = 'pp-';
const LXC_NAME_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9-]*$/;

// Loaded lazily: the Mock2 database is initialised after the core one, and a
// top-level import would bind before it exists on a cold boot.
async function connectors() {
  return import('../mock2/git-connectors.js');
}

const publishSchema = z.object({
  connector_id: z.union([z.number().int(), z.string()]),
  remote_repo: z.string().min(1),
  branch: z.string().optional(),
  subdir: z.string().optional(),
  message: z.string().max(500).optional(),
  include_secrets: z.boolean().optional(),
  exclude: z.array(z.string().max(200)).max(100).optional(),
  dry_run: z.boolean().optional(),
});

// Resolve a connector id to { connector, token } or an error string.
async function resolveConnector(connectorId) {
  const { getGitConnector, decryptGitCredential } = await connectors();
  const connector = getGitConnector(connectorId);
  if (!connector) return { error: 'No such git connector' };
  if (connector.auth_kind !== 'token') {
    return { error: `Connector "${connector.name}" uses ${connector.auth_kind}; publishing supports token connectors only` };
  }
  const token = decryptGitCredential(connector);
  if (!token) {
    return { error: `The credential for "${connector.name}" could not be decrypted — re-enter it in Projects → Connectors` };
  }
  return { connector, token };
}

// Shared tail: run the publish and shape the response. `source` is the
// absolute host path; `label` is what goes in the commit subject.
async function runPublish({ req, res, sourceDir, label, audit }) {
  const parsed = publishSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message || 'invalid request' });
  }
  const d = parsed.data;
  const resolved = await resolveConnector(d.connector_id);
  if (resolved.error) return res.status(400).json({ error: resolved.error });

  const result = await publishDirToGit({
    sourceDir,
    connector: resolved.connector,
    token: resolved.token,
    remoteRepo: d.remote_repo,
    branch: d.branch || 'main',
    subdir: d.subdir || '',
    message: d.message || '',
    sourceLabel: label,
    extraExcludes: d.exclude || [],
    includeSecrets: !!d.include_secrets,
    dryRun: !!d.dry_run,
  });

  if (!d.dry_run) {
    logAudit(req.user?.id || null, audit.action, audit.type, audit.id, {
      connector: resolved.connector.name,
      remote_repo: d.remote_repo,
      branch: d.branch || 'main',
      ok: !!result.ok,
      files: result.file_count ?? null,
      excluded: Array.isArray(result.excluded) ? result.excluded.length : null,
      // Recorded explicitly: publishing with the filter off is the one choice
      // here that can disclose credentials, and it should be visible later.
      include_secrets: !!d.include_secrets,
    }, req.ip);
  }

  if (!result.ok) return res.status(502).json(result);
  return res.json(result);
}

// ---- Connectors (read-only mirror, so this surface is usable standalone) ----

router.get('/connectors', requireAdmin, async (_req, res) => {
  try {
    const { listGitConnectors, shapeGitConnector } = await connectors();
    res.json({ connectors: listGitConnectors().map(shapeGitConnector) });
  } catch (e) {
    res.status(500).json({ error: `Could not read git connectors: ${e?.message || e}` });
  }
});

// ---- Static sites ----

router.post('/static-sites/:id/publish', requireAdmin, requireSudo, async (req, res) => {
  try {
    const site = getDb()
      // `type = 'static'` is what every other static-site lookup uses
      // (routes/mcp.js x4). Matching on `kind` instead would silently miss
      // rows on installs where only the legacy column is populated.
      .prepare(`SELECT id, name, data_dir, type FROM services WHERE id = ? AND type = 'static'`)
      .get(req.params.id);
    if (!site) return res.status(404).json({ error: 'Static site not found' });
    if (!site.data_dir) return res.status(400).json({ error: `"${site.name}" has no docroot on disk` });

    return await runPublish({
      req, res,
      sourceDir: site.data_dir,
      label: `static site "${site.name}"`,
      audit: { action: 'GIT_PUBLISH_STATIC_SITE', type: 'service', id: site.id },
    });
  } catch (e) {
    res.status(500).json({ error: `Publish failed: ${e?.message || e}` });
  }
});

// ---- LXC containers ----

router.post('/lxc/:name/publish', requireAdmin, requireSudo, async (req, res) => {
  const { name } = req.params;
  if (!LXC_NAME_REGEX.test(name)) {
    return res.status(400).json({ error: 'Invalid container name' });
  }
  const incusName = `${LXC_PREFIX}${name}`;

  // Scope. The default is the registered startup working directory — the
  // application directory ProxyPilot already tracks for this container. An
  // explicit `path` overrides it, but only with `confirm_path: true`, because
  // an arbitrary path inside a guest is exactly how a publish turns into a
  // credential disclosure.
  let sourcePath = null;
  const requested = typeof req.body?.path === 'string' ? req.body.path.trim() : '';
  if (requested) {
    if (req.body?.confirm_path !== true) {
      return res.status(400).json({
        error:
          'Publishing a path other than the container\'s registered startup working directory ' +
          'requires confirm_path: true. Check what is in that directory first — container ' +
          'filesystems hold credentials and system state.',
      });
    }
    if (!requested.startsWith('/') || requested.includes('..')) {
      return res.status(400).json({ error: 'path must be absolute and may not contain ".."' });
    }
    sourcePath = requested;
  } else {
    let startup = null;
    try {
      startup = await readContainerStartup(incusName);
    } catch { /* reported below */ }
    if (!startup?.workingDir) {
      return res.status(400).json({
        error:
          `No startup working directory is registered for "${name}", so there is no default ` +
          `application directory to publish. Register one (apply_lxc_zip with a startup script), ` +
          `or pass an explicit path with confirm_path: true.`,
      });
    }
    sourcePath = startup.workingDir;
  }

  let staged = null;
  try {
    // Copy the directory out of the guest first. The credential never enters
    // the container: the guest only ever produces a tar on stdout.
    const stage = await stageLxcDir(incusName, sourcePath);
    if (!stage.ok) return res.status(502).json({ error: stage.error });
    staged = stage.dir;

    return await runPublish({
      req, res,
      sourceDir: staged,
      label: `LXC ${name}:${sourcePath}`,
      audit: { action: 'GIT_PUBLISH_LXC', type: 'lxc_container', id: name },
    });
  } catch (e) {
    res.status(500).json({ error: `Publish failed: ${e?.message || e}` });
  } finally {
    if (staged) await cleanupStagedDir(staged);
  }
});
