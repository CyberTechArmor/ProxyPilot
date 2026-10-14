export const ACTIVE_JOB_STATES = new Set(['queued', 'running', 'pending', 'retrying']);
export function releaseSummary(application, selectedSha) {
  const candidates = application?.candidates ?? [];
  const latest = (field, time) => [...candidates].filter(c => c[field]?.[time]).sort((a, b) => String(b[field][time] ?? '').localeCompare(String(a[field][time] ?? '')))[0];
  const candidate = candidates.find(c => c.sha === selectedSha) ?? candidates[0] ?? null;
  const tested = [...candidates].filter(c => c.validation?.passed).sort((a, b) => String(b.validation.validatedAt ?? '').localeCompare(String(a.validation.validatedAt ?? '')))[0];
  const live = application?.live?.verifiedAt ? { sha: application.live.sha, live: application.live } : latest('live', 'verifiedAt');
  const published = latest('publication', 'verifiedAt');
  const currentProfile = candidate && candidate.profileRevision === application.profile.revision && candidate.profileDigest === application.profile.digest;
  const validated = Boolean(currentProfile && candidate.validation?.passed);
  return { candidate, tested, live, published, currentProfile, validated, mergeEligible: Boolean(validated && live?.sha === candidate?.sha) };
}
export function releaseBranchHead(application, publication) {
  if (!publication || !application?.profile?.remoteBranch) return '';
  if (publication?.branch === application?.profile?.remoteBranch) return publication.remoteSha ?? '';
  if (publication?.defaultBranch === application?.profile?.remoteBranch) return publication.defaultHeadSha ?? '';
  return '';
}
export function jobPresentation(job) {
  const recoveryRequired = job?.outcome === 'application_recovery_required';
  return { reason: job?.reason || (typeof job?.error === 'string' ? job.error : job?.error?.message) || '',
    outcome: String(job?.outcome ?? '').replaceAll('_', ' '), recoveryRequired,
    interruptedSha: recoveryRequired ? job?.plan?.params?.sha ?? null : null };
}
const lines = text => String(text ?? '').split('\n').map(s => s.trim()).filter(Boolean);
export function profileFromForm(form, targetId) {
  return {
    name: form.name.trim(), targetId, sourceDir: form.sourceDir.trim(), serviceName: form.serviceName.trim(),
    healthUrl: form.healthUrl.trim(), installScript: form.installScript.trim() || null, buildScript: form.buildScript.trim() || null,
    validationScripts: lines(form.validationScripts), preservePaths: lines(form.preservePaths), envFiles: lines(form.envFiles),
    connectorId: Number(form.connectorId), remoteRepo: form.remoteRepo.trim(), remoteBranch: form.remoteBranch.trim(), releaseRoot: form.releaseRoot.trim() || null,
  };
}
export function profileToForm(profile = {}) {
  return { name: profile.name ?? '', sourceDir: profile.sourceDir ?? '', serviceName: profile.serviceName ?? '', healthUrl: profile.healthUrl ?? '',
    installScript: profile.installScript ?? '', buildScript: profile.buildScript ?? '', validationScripts: (profile.validationScripts ?? []).join('\n'), preservePaths: (profile.preservePaths ?? []).join('\n'),
    envFiles: (profile.envFiles ?? []).join('\n'), connectorId: String(profile.connectorId ?? ''), remoteRepo: profile.remoteRepo ?? '', remoteBranch: profile.remoteBranch ?? 'main', releaseRoot: profile.releaseRoot ?? '' };
}
