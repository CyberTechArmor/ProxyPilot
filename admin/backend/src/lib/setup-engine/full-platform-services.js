import { randomBytes } from 'node:crypto';
import { assertStage } from './full-platform-store.js';
import { effectiveFor } from './platform-networks.js';
import { protectedValue } from './full-platform-keycloak.js';
import { readOpenBao, save as saveBao, review as reviewBao, apply as applyBao } from './openbao-store.js';
import { readVaultwarden, save as saveVault, review as reviewVault, apply as applyVault } from './vaultwarden-store.js';
import { readInfisical, saveInfisical, reviewInfisical, applyInfisical } from './infisical-store.js';
import { readPomerium, applyPomerium } from './pomerium-store.js';

export const clientCredential = (db, k, kind) => protectedValue(db, `keycloak-client-${k.id}-${kind}`, () => ({ secret: randomBytes(32).toString('base64url') })).secret;
export function prepareServiceConnections(db, full, plan, k) {
  // The effective allowlist: built-in VPN networks ∪ the additional addresses.
  const allowedIps = effectiveFor(db, full.config);
  const common = { expectedPlanRevision: plan.revision, expectedRevision: 0, connectionId: k.id, allowedIps, reviewed: true };
  for (const kind of ['openbao', 'vaultwarden', 'infisical']) {
    const old = serviceReaders[kind](db);
    if (old) continue;
    if (kind === 'openbao') saveBao(db, { ...common, basic: true, initialize: false, clientId: `pp-${k.id}-openbao`, clientSecret: clientCredential(db, k, kind), group: `/pp-${k.id}-openbao` });
    if (kind === 'vaultwarden') saveVault(db, { ...common, clientId: `pp-${k.id}-vaultwarden`, clientSecret: clientCredential(db, k, kind), accessRole: 'vault-access', matchExistingEmail: false });
    if (kind === 'infisical') saveInfisical(db, { expectedPlanRevision: plan.revision, expectedRevision: 0, basic: true, agentMode: plan.choices.infisical.agentProxyMode || 'install', testHost: new URL(plan.choices.infisical.agentProxyUrl).hostname, allowedIps, reviewed: true });
  }
}
export const serviceReaders = { openbao: readOpenBao, vaultwarden: readVaultwarden, infisical: readInfisical, pomerium: readPomerium };
export function applyService(db, kind, by) {
  assertStage(db, kind);
  if (kind === 'pomerium') return applyPomerium(db, readPomerium(db).revision, by);
  const review = { openbao: reviewBao, vaultwarden: reviewVault, infisical: reviewInfisical }[kind](db);
  return { openbao: applyBao, vaultwarden: applyVault, infisical: applyInfisical }[kind](db, { revision: review.revision, reviewToken: review.reviewToken, reviewed: true }, by);
}
