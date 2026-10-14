import { createHash } from 'node:crypto';
import path from 'node:path';

export class ApplicationReleaseError extends Error {
  constructor(code, message, status = 409) { super(message); this.name = 'ApplicationReleaseError'; this.code = code; this.status = status; }
}
export const failApplicationRelease = (code, message, status) => { throw new ApplicationReleaseError(code, message, status); };
export const digest = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
export const fullSha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
export function validateCandidateRef(ref) {
  if (typeof ref !== 'string' || ref.length > 200 || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(ref) || /\.\.|\/\.|\.lock(?:\/|$)|\/\/|\/$/.test(ref)) failApplicationRelease('INVALID_REF', 'Use a full commit SHA or an exact branch name.', 400);
  return ref;
}
function absolute(value, label) {
  if (typeof value !== 'string' || !/^\/[A-Za-z0-9_./-]+$/.test(value) || value === '/' || value.includes('/../') || value.endsWith('/..') || value.includes('/./') || path.posix.normalize(value) !== value) failApplicationRelease('INVALID_PROFILE', `${label} must be a normalized absolute path below the filesystem root.`, 400);
  return value;
}
function list(value, label, transform) {
  if (!Array.isArray(value) || value.length > 40) failApplicationRelease('INVALID_PROFILE', `${label} must be an array of at most 40 entries.`, 400);
  const out = value.map(transform); if (new Set(out).size !== out.length) failApplicationRelease('INVALID_PROFILE', `${label} contains duplicate entries.`, 400); return out;
}
function script(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9:_-]{0,79}$/.test(value) || /^(preinstall|install|postinstall|prepare)$/.test(value)) failApplicationRelease('INVALID_PROFILE', 'Specify a named npm script, not a command or install lifecycle hook.', 400);
  return value;
}
export function normalizeApplicationProfile(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) failApplicationRelease('INVALID_PROFILE', 'An application profile is required.', 400);
  const allowed = ['name','targetId','sourceDir','serviceName','healthUrl','installScript','buildScript','validationScripts','preservePaths','envFiles','connectorId','remoteRepo','remoteBranch','releaseRoot'];
  if (Object.keys(raw).some(k => !allowed.includes(k))) failApplicationRelease('INVALID_PROFILE', 'Unknown application profile field.', 400);
  const name = String(raw.name || '').trim(); if (!name || name.length > 100 || /[\x00-\x1f]/.test(name)) failApplicationRelease('INVALID_PROFILE', 'Application name is required (at most 100 characters).', 400);
  const targetId = String(raw.targetId || ''); if (!/^[A-Za-z][A-Za-z0-9-]{0,62}$/.test(targetId)) failApplicationRelease('INVALID_PROFILE', 'Select an existing container by its name.', 400);
  const serviceName = String(raw.serviceName || ''); if (!/^[A-Za-z0-9][A-Za-z0-9_.@-]{0,100}\.service$/.test(serviceName)) failApplicationRelease('INVALID_PROFILE', 'Use an exact existing .service unit.', 400);
  let url; try { url = new URL(raw.healthUrl); } catch { failApplicationRelease('INVALID_PROFILE', 'An HTTP loopback health URL is required.', 400); }
  if (url.protocol !== 'http:' || !['127.0.0.1','localhost','[::1]'].includes(url.hostname) || url.username || url.password || url.hash || url.search) failApplicationRelease('INVALID_PROFILE', 'Health checks must use HTTP loopback without credentials, query parameters or fragments.', 400);
  if (!Number.isSafeInteger(raw.connectorId) || raw.connectorId < 1) failApplicationRelease('INVALID_PROFILE', 'Select an existing Git connector.', 400);
  const remoteRepo = String(raw.remoteRepo || ''); if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(remoteRepo) || remoteRepo.split('/').some(x => x === '.' || x === '..')) failApplicationRelease('INVALID_PROFILE', 'Remote repository must be owner/name on the selected connector.', 400);
  const sourceDir = absolute(raw.sourceDir, 'sourceDir');
  const releaseRoot = raw.releaseRoot == null || raw.releaseRoot === '' ? null : absolute(raw.releaseRoot, 'releaseRoot');
  if (releaseRoot && (releaseRoot === sourceDir || releaseRoot.startsWith(sourceDir + '/'))) failApplicationRelease('INVALID_PROFILE', 'Release storage cannot be inside the live source path.', 400);
  return {
    name,targetId,sourceDir,serviceName,healthUrl:url.href,
    installScript:raw.installScript ? script(raw.installScript) : null,buildScript:raw.buildScript ? script(raw.buildScript) : null,
    validationScripts:list(raw.validationScripts ?? [], 'validationScripts', script),
    preservePaths:list(raw.preservePaths ?? [], 'preservePaths', x => absolute(x, 'preservePaths entry')),
    envFiles:list(raw.envFiles ?? [], 'envFiles', x => absolute(x, 'envFiles entry')),
    connectorId:raw.connectorId,remoteRepo,remoteBranch:validateCandidateRef(raw.remoteBranch || 'main'),releaseRoot,
  };
}

export const APPLICATION_RELEASE_SCHEMA = `
CREATE TABLE IF NOT EXISTS mock2_applications (
 id INTEGER PRIMARY KEY AUTOINCREMENT, target_id TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
 repository_path TEXT NOT NULL, profile_revision INTEGER NOT NULL DEFAULT 1,
 imported_at TEXT, created_at TEXT NOT NULL, live_json TEXT
);
CREATE TABLE IF NOT EXISTS mock2_application_profiles (
 application_id INTEGER NOT NULL, revision INTEGER NOT NULL, digest TEXT NOT NULL,
 profile_json TEXT NOT NULL, created_at TEXT NOT NULL,
 PRIMARY KEY(application_id, revision)
);
CREATE TABLE IF NOT EXISTS mock2_application_candidates (
 application_id INTEGER NOT NULL, sha TEXT NOT NULL, profile_revision INTEGER NOT NULL,
 profile_digest TEXT NOT NULL, tree_sha TEXT NOT NULL, checkpoint_at TEXT NOT NULL,
 hygiene_json TEXT NOT NULL, validation_json TEXT, publication_json TEXT, live_json TEXT,
 PRIMARY KEY(application_id, sha, profile_revision)
);
CREATE TABLE IF NOT EXISTS mock2_application_operations (
 application_id INTEGER PRIMARY KEY, token TEXT NOT NULL, kind TEXT NOT NULL, started_at TEXT NOT NULL, owner_pid INTEGER NOT NULL, owner_start TEXT NOT NULL
);`;
