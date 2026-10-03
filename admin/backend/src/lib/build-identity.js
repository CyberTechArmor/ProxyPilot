// Read once from the image, never from the host's moving checkout or database.
import { readFileSync } from 'node:fs';

export function parseBuildIdentity(value) {
  const sha = typeof value?.sha === 'string' && /^[a-f0-9]{40}$/.test(value.sha) ? value.sha : null;
  const builtAt = typeof value?.built_at === 'string' && Number.isFinite(Date.parse(value.built_at)) ? value.built_at : null;
  return { sha, short_sha: sha?.slice(0, 10) || null, built_at: builtAt,
    dirty: typeof value?.dirty === 'boolean' ? value.dirty : null,
    status: sha && builtAt ? 'recorded' : 'unknown' };
}

export function readBuildIdentity(read = readFileSync) {
  try { return parseBuildIdentity(JSON.parse(read(new URL('../../build-info.json', import.meta.url), 'utf8'))); }
  catch { return parseBuildIdentity(null); }
}

export const RUNNING_BUILD = Object.freeze(readBuildIdentity());
