// Pure saved-reference contract, shared by API and independent runner.
export const APPLICATION_JOB_KINDS = Object.freeze(['application_validate', 'application_deploy', 'application_verify', 'application_rollback']);
export const applicationGuestName = target => `${process.env.LXC_PREFIX ?? 'pp-'}${target}`;
const SHA = /^[a-f0-9]{40}$/;
const DIGEST = /^[a-f0-9]{64}$/;
export function validateApplicationJob(job, params) {
  const p = params || {};
  return APPLICATION_JOB_KINDS.includes(job.kind) && Number.isSafeInteger(p.applicationId) && p.applicationId > 0 &&
    Number.isSafeInteger(p.profileRevision) && p.profileRevision > 0 && DIGEST.test(p.profileDigest || '') && SHA.test(p.sha || '') && SHA.test(p.treeSha || '') &&
    (p.recoveryOf === undefined || /^[a-zA-Z0-9-]{1,64}$/.test(p.recoveryOf)) &&
    Object.keys(p).every(k => ['applicationId', 'profileRevision', 'profileDigest', 'sha', 'treeSha', 'recoveryOf'].includes(k))
    ? { ok: true } : { ok: false, reason: 'application release jobs carry only immutable profile and exact candidate references' };
}
